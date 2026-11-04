/** App packages, `.pearapp` (`contracts/app-distribution.md`): packaging, checks, verification, and install. */
import { ByteReader, END_RECORD, FLAG_GZIP, bodyStream, frame, gzipped, readRecord, record, unframe } from '../src/container'
import { PEARAPP_MAGIC, Packager, readPackage, type PackageHeader } from '../src/pearapp'
import { expect, test } from './fixtures'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Just enough file system for the packager: a map of paths to bytes, and `null` for a symbolic link. */
function fakeFs(files: Record<string, string | null>) {
  const all = new Map(Object.entries(files).map(([p, c]) => [p, c === null ? null : enc.encode(c)]))
  const kids = (dir: string) => {
    const names = new Map<string, boolean>()
    const prefix = dir === '/' ? '/' : `${dir}/`
    for (const p of all.keys()) if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length)
      const i = rest.indexOf('/')
      names.set(i < 0 ? rest : rest.slice(0, i), i >= 0)
    }
    return names
  }
  const isDir = (p: string) => p === '/proj' || kids(p).size > 0
  return {
    stat: async (p: string) => (isDir(p) ? { kind: 'dir', size: 0 } : { kind: 'file', size: all.get(p)?.length ?? 0 }),
    lstat: async (p: string) => (isDir(p) ? { kind: 'dir', size: 0 } : all.get(p) === null ? { kind: 'symlink', size: 0 } : { kind: 'file', size: all.get(p)!.length }),
    readdir: async (p: string) => [...kids(p).keys()].map((name) => ({ name })),
    readFile: async (p: string) => all.get(p)!,
  } as never
}

const manifest = (o: object = {}) => JSON.stringify({ id: 'com.acme.notes', name: 'Notes', version: '1.2.0', entry: 'main.js', icon: 'Resources/icon.svg', permissions: ['clipboard'], ...o })
const project = (o: Record<string, string | null> = {}): Record<string, string | null> => ({
  '/proj/manifest.json': manifest(),
  '/proj/main.js': 'export default async () => {}',
  '/proj/Resources/icon.svg': '<svg/>',
  '/proj/Resources/ui/index.html': '<p>hi</p>',
  ...o,
})
const packager = (files: Record<string, string | null>) => new Packager(fakeFs(files), '1.0')

/** Take a package apart into header and records, change them, and put it back together with a valid checksum. */
async function remake(blob: Blob, change: (header: PackageHeader, records: Array<{ meta: Record<string, unknown>; content: Uint8Array }>) => void): Promise<Blob> {
  const { header, body, gzip } = await unframe(blob, { magic: PEARAPP_MAGIC, version: 1, minVersion: 1, what: 'package', noun: 'package' })
  const reader = new ByteReader(bodyStream(body, gzip))
  const records: Array<{ meta: Record<string, unknown>; content: Uint8Array }> = []
  for (let r = await readRecord<{ kind: string; size: number }>(reader); r; r = await readRecord(reader)) records.push({ meta: r.meta as never, content: r.content! })
  const h = header as PackageHeader
  change(h, records)
  const parts: BlobPart[] = records.flatMap((r) => record(r.meta, r.content))
  parts.push(END_RECORD as BlobPart)
  return frame(PEARAPP_MAGIC, 1, FLAG_GZIP, h, await gzipped(new Blob(parts)), 'application/vnd.pear.app')
}

test.describe('packaging', () => {
  test('a project becomes one package whose manifest carries the hash of every other file', async () => {
    const blob = await packager(project()).package('/proj')
    const { info, files } = await readPackage(blob)
    expect(info).toMatchObject({ ok: true, root: 'Notes.app', files: 4, unsigned: true, generator: 'pear/1.0' })
    expect(info.manifest).toMatchObject({ id: 'com.acme.notes', version: '1.2.0' })
    expect(info.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(files).sort()).toEqual(['Resources/icon.svg', 'Resources/ui/index.html', 'main.js', 'manifest.json'])
    const packed = JSON.parse(dec.decode(files['manifest.json']))
    expect(Object.keys(packed.hashes).sort()).toEqual(['Resources/icon.svg', 'Resources/ui/index.html', 'main.js'])
    expect(dec.decode(files['main.js'])).toBe('export default async () => {}')
    // the same project twice gives the same files and hashes
    expect((await readPackage(await packager(project()).package('/proj'))).files['manifest.json']).toEqual(files['manifest.json'])
  })

  test('the version and manifest can be overridden for the package only; junk folders stay out', async () => {
    const files = project({ '/proj/.git/config': 'x', '/proj/node_modules/a/index.js': 'x', '/proj/.DS_Store': 'x', '/proj/old.pearapp': 'x' })
    const blob = await packager(files).package('/proj', { version: '2.0.0', manifest: { name: 'Notes Pro' } })
    const { info, files: out } = await readPackage(blob)
    expect(info.manifest).toMatchObject({ version: '2.0.0', name: 'Notes Pro' })
    expect(info.root).toBe('Notes Pro.app')
    expect(Object.keys(out)).not.toContain('old.pearapp')
    expect(Object.keys(out).filter((p) => p.startsWith('.') || p.startsWith('node_modules'))).toEqual([])
  })

  test('a project that is wrong is refused with the reason; the check lists everything at once', async () => {
    const code = (files: Record<string, string | null>) => packager(files).package('/proj').then(() => 'packaged', (e) => `${e.code}: ${e.message}`)
    const noManifest = Object.fromEntries(Object.entries(project()).filter(([p]) => !p.endsWith('manifest.json')))
    expect(await code(noManifest)).toMatch(/^ENOENT: manifest.json is missing/)
    expect(await code(project({ '/proj/manifest.json': manifest({ id: 'nope' }) }))).toMatch(/^EINVAL: id must be reverse-DNS/)
    expect(await code(project({ '/proj/manifest.json': '{' }))).toMatch(/^EINVAL: manifest.json is not valid JSON/)
    expect(await code(project({ '/proj/manifest.json': manifest({ entry: 'gone.js' }) }))).toMatch(/^EINVAL: Entry gone.js is missing/)
    expect(await code(project({ '/proj/link': null }))).toMatch(/^EINVAL: 1 symbolic link/)

    const report = await packager(project({ '/proj/manifest.json': manifest({ icon: 'icon.svg' }), '/proj/icon.svg': '<svg/>' })).check('/proj')
    expect(report.ok).toBe(true) // a warning does not stop packaging
    expect(report.checks.find((c) => c.id === 'icon' && !c.ok)).toMatchObject({ severity: 'warning' })
    expect(report).toMatchObject({ files: 5, manifest: { id: 'com.acme.notes' } })
    expect(report.packageBytes).toBeGreaterThan(100)
    const broken = await packager(project({ '/proj/manifest.json': manifest({ entry: 'gone.js', id: 'x' }) })).check('/proj')
    expect(broken.ok).toBe(false)
    expect(broken.packageBytes).toBe(0)
  })

  test('nothing in the project is run: an entry that could not even be parsed is packaged as it is', async () => {
    const blob = await packager(project({ '/proj/main.js': 'this is ( not javascript {{' })).package('/proj')
    const { info, files } = await readPackage(blob)
    expect(info.ok).toBe(true)
    expect(dec.decode(files['main.js'])).toBe('this is ( not javascript {{')
  })
})

test.describe('reading a package refuses anything that does not add up', () => {
  const good = async () => packager(project()).package('/proj')
  const refuses = async (blob: Blob, reason: RegExp) => {
    const { info, files } = await readPackage(blob)
    expect(info.ok).toBe(false)
    expect(info.error).toMatch(reason)
    expect(files).toEqual({}) // nothing comes back from a refused package
  }

  test('a damaged byte, a cut-off file and a stranger are caught by the checksum, the trailer and the magic', async () => {
    const bytes = new Uint8Array(await (await good()).arrayBuffer())
    const flipped = bytes.slice()
    flipped[Math.floor(bytes.length / 2)]! ^= 0xff
    await refuses(new Blob([flipped]), /checksum/)
    await refuses(new Blob([bytes.slice(0, bytes.length - 20)]), /incomplete|damaged/)
    await refuses(new Blob([enc.encode('hello, this is not a package at all')]), /not a Pear app package/)
    await refuses(new Blob([]), /not a Pear app package/)
  })

  test('a disk image is not a package', async () => {
    const image = await frame('TINYIMG\0', 1, 0, {}, new Blob([]), 'application/x-tinyimg')
    await refuses(image, /not a Pear app package/)
  })

  test('a file that was changed (with the checksum made good again) fails its hash', async () => {
    const evil = await remake(await good(), (_h, recs) => {
      recs.find((r) => String(r.meta.path).endsWith('/main.js'))!.content = enc.encode('export default () => fetch("//evil")')
      recs.find((r) => String(r.meta.path).endsWith('/main.js'))!.meta.size = 36
    })
    await refuses(evil, /main\.js does not match its hash/)
  })

  test('files that are not in the list, or listed but missing, are refused', async () => {
    await refuses(await remake(await good(), (_h, recs) => void recs.push({ meta: { path: 'Notes.app/extra.js', kind: 'file', size: 1 }, content: enc.encode('x') })), /not in its file list/)
    await refuses(await remake(await good(), (_h, recs) => void recs.pop()), /listed but missing/)
    await refuses(await remake(await good(), (_h, recs) => void recs.push(recs[1]!)), /twice/)
  })

  test('zero or several .app roots, and paths that climb out, are refused', async () => {
    await refuses(await remake(await good(), (_h, recs) => void (recs[1]!.meta.path = 'Other.app/main.js')), /exactly one \.app root/)
    await refuses(await remake(await good(), (h) => void (h.root = 'Notes')), /one bundle, named like/)
    await refuses(await remake(await good(), (_h, recs) => void (recs[1]!.meta.path = 'Notes.app/../main.js')), /not a path inside a bundle/)
    await refuses(await remake(await good(), (_h, recs) => void (recs[1]!.meta.path = 'main.js')), /no bundle root/)
    await refuses(await remake(await good(), (_h, recs) => void (recs[1]!.meta.kind = 'dir')), /files only/)
    await refuses(await remake(await good(), (h) => void (h.files = [])), /between 1 and/)
  })

  test('a manifest in the header that is not the manifest in the package is refused', async () => {
    await refuses(await remake(await good(), (h) => void (h.app = { ...h.app, permissions: ['fs.all'] })), /manifest in the header/)
  })

  test('a record that claims more than the limit is refused before it is read', async () => {
    const huge = await remake(await good(), (_h, recs) => void (recs[1]!.meta.size = 2 ** 31))
    await refuses(huge, /larger than allowed|ends early/)
  })
})

test.describe('installing', () => {
  test.use({ system: true, helpers: true })

  test('verify, install, record where it came from, and remove the record on uninstall', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { kernel } = window
      await kernel.mkdir('/tmp/proj/Resources', { recursive: true })
      await kernel.writeFile('/tmp/proj/main.js', new TextEncoder().encode('export default async () => {}'))
      await kernel.writeFile('/tmp/proj/manifest.json', new TextEncoder().encode(JSON.stringify({ id: 'com.acme.notes', name: 'Notes', version: '1.2.0', entry: 'main.js', icon: 'Resources/icon.svg', permissions: ['clipboard'] })))
      await kernel.writeFile('/tmp/proj/Resources/icon.svg', new TextEncoder().encode('<svg/>'))
      const report = await kernel.bundleCheck('/tmp/proj')
      const pkg = await kernel.bundlePackage('/tmp/proj')
      const info = await kernel.bundleInspectArchive(pkg)
      const before = (await kernel.bundleList()).some((b) => b.id === 'com.acme.notes')
      const wrong = await kernel.bundleInstallArchive(pkg, { expectDigest: '0'.repeat(64) }).then(() => 'installed', (e: any) => e.code)
      const afterWrong = (await kernel.bundleList()).some((b) => b.id === 'com.acme.notes')
      const installed = await kernel.bundleInstallArchive(pkg, { expectDigest: info.digest, from: { kind: 'url', url: 'https://x.test/notes.pearapp' } })
      const verify = await kernel.bundleVerify(installed.path)
      const from = await kernel.bundleInstalledFrom('com.acme.notes')
      const again = await kernel.bundleInstallArchive(pkg).then(() => 'installed', (e: any) => e.code)
      await kernel.bundleUninstall('com.acme.notes')
      return { report, info, before, wrong, afterWrong, installed: [installed.id, installed.version, installed.path], verify, from, again, gone: await kernel.bundleInstalledFrom('com.acme.notes') }
    })
    expect(out.report).toMatchObject({ ok: true, files: 3 })
    expect(out.info).toMatchObject({ ok: true, root: 'Notes.app' })
    expect(out.before).toBe(false)
    expect(out.wrong).toBe('EINVAL')
    expect(out.afterWrong).toBe(false) // a refused package leaves nothing behind
    expect(out.installed).toEqual(['com.acme.notes', '1.2.0', '/Applications/Notes.app'])
    expect(out.verify).toMatchObject({ ok: true, checked: 2 })
    expect(out.from).toMatchObject({ kind: 'url', url: 'https://x.test/notes.pearapp', digest: out.info.digest, version: '1.2.0', unsigned: true })
    expect(out.again).toBe('EEXIST')
    expect(out.gone).toBeNull()
  })

  test('update replaces an installed app from a newer package and keeps its data', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { kernel } = window
      const make = async (version: string) => {
        await kernel.mkdir('/tmp/p2', { recursive: true })
        await kernel.writeFile('/tmp/p2/manifest.json', new TextEncoder().encode(JSON.stringify({ id: 'com.acme.up', name: 'Up', version })))
        await kernel.writeFile('/tmp/p2/main.js', new TextEncoder().encode(`export default () => '${version}'`))
        return kernel.bundlePackage('/tmp/p2')
      }
      const first = await kernel.bundleInstallArchive(await make('1.0.0'))
      await kernel.writeFile(`${first.supportDir}/keep.txt`, new TextEncoder().encode('data'))
      const plain = await kernel.bundleInstallArchive(await make('1.1.0')).then(() => 'installed', (e: any) => e.code)
      const updated = await kernel.bundleInstallArchive(await make('1.1.0'), { update: true })
      return { plain, version: updated.version, kept: new TextDecoder().decode(await kernel.readFile(`${first.supportDir}/keep.txt`)), from: await kernel.bundleInstalledFrom('com.acme.up') }
    })
    expect(out).toMatchObject({ plain: 'EEXIST', version: '1.1.0', kept: 'data', from: { kind: 'archive', version: '1.1.0' } })
  })

  test('an app packages a folder it can read, as itself: its own files yes, other people\'s no', async ({ page }) => {
    const out = await page.evaluate(() => window.runApp('com.test.packer', `export default async (tiny) => {
      const enc = new TextEncoder()
      await tiny.mkdir('proj', { recursive: true })
      await tiny.writeFile('proj/manifest.json', enc.encode(JSON.stringify({ id: 'com.test.inner', name: 'Inner', version: '1.0.0' })))
      await tiny.writeFile('proj/main.js', enc.encode('export default () => 1'))
      const report = await tiny.bundleCheck('proj')
      const bytes = await tiny.bundlePackage('proj')
      const denied = await tiny.bundlePackage('/Users/pear/Documents').then(() => 'packaged', (e) => e.code)
      const missing = await tiny.bundlePackage('nothing').then(() => 'packaged', (e) => e.code)
      await tiny.writeFile('/tmp/com.test.packer.out', enc.encode(JSON.stringify({ ok: report.ok, files: report.files, magic: new TextDecoder().decode(bytes.subarray(0, 7)), denied, missing })))
    }`))
    expect(out).toEqual({ ok: true, files: 2, magic: 'PEARAPP', denied: 'EACCES', missing: 'ENOENT' })
  })
})
