/** `tiny.sources`: app sources, search, and checked installs (`contracts/app-registry.md`). */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { Page, Route } from '@playwright/test'
import { compareVersions, normalizeSourceUrl, parseDiscovery, searchListings, type Listing } from '../src/sources'
import { expect, test } from './fixtures'

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' }

interface Mock {
  /** path -> body; a Buffer or string. Missing paths are 404. */
  files: Map<string, string | Buffer>
  hits: string[]
}

/** A bundle served as a directory: `manifest.hashes` pins `main.js`, and the listing pins the manifest. */
function bundle(id: string, version: string, permissions: string[] = []) {
  const main = `export default async () => { /* ${id} ${version} */ }`
  const manifest = JSON.stringify({ id, name: 'Notes', version, kind: 'app', entry: 'main.js', permissions, hashes: { 'main.js': sha(main) } })
  return { main, manifest }
}

function record(id: string, versions: Array<{ version: string; permissions?: string[]; yanked?: string; manifest?: string }>, base: string) {
  return {
    id, name: 'Notes', summary: 'Take notes', version: versions[0]!.version, publisher: { name: 'Acme' }, categories: ['productivity'], size: 10, updated: '2026-11-01',
    description: 'A notes app', screenshots: [],
    versions: versions.map((v) => ({
      version: v.version, created: '2026-11-01', ...(v.yanked && { yanked: { reason: v.yanked } }),
      artifact: { kind: 'directory', url: `${base}/apps/${id}/${v.version}`, sha256: sha(v.manifest ?? bundle(id, v.version, v.permissions).manifest), size: 100 },
      manifest: { permissions: v.permissions ?? [] },
    })),
  }
}

function serve(page: Page, host: string, mock: Mock) {
  return page.route(`https://${host}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    mock.hits.push(url.pathname)
    const body = mock.files.get(url.pathname)
    if (body === undefined) return route.fulfill({ status: 404, headers: CORS, body: 'not found' })
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'application/json' }, body })
  })
}

function registry(host: string, extra: Record<string, unknown> = {}): Mock {
  const base = `https://${host}`
  const v1 = bundle('com.acme.notes', '1.0.0')
  const files = new Map<string, string | Buffer>()
  files.set('/.well-known/pear-registry.json', JSON.stringify({ protocol: 1, id: 'org.acme.apps', name: 'Acme Apps', description: 'Apps by Acme', capabilities: ['index'], ...extra }))
  const rec = record('com.acme.notes', [{ version: '1.0.0' }], base)
  files.set('/index.json', JSON.stringify({ apps: [rec, { ...rec, id: 'com.acme.clock', name: 'Clock', summary: 'Tells time', categories: ['utilities'] }].map(({ versions: _v, ...l }) => l), featured: ['com.acme.notes'] }))
  files.set('/apps/com.acme.notes/app.json', JSON.stringify(rec))
  files.set('/apps/com.acme.notes/1.0.0/manifest.json', v1.manifest)
  files.set('/apps/com.acme.notes/1.0.0/main.js', v1.main)
  return { files, hits: [] }
}

test.describe('rules without a browser', () => {
  test('addresses: bare hosts get https, plain http is allowed only on localhost, credentials are refused', () => {
    expect(normalizeSourceUrl('apps.example.com')).toBe('https://apps.example.com')
    expect(normalizeSourceUrl(' https://apps.example.com/pear/?x=1#y ')).toBe('https://apps.example.com/pear')
    expect(normalizeSourceUrl('http://localhost:8080/r')).toBe('http://localhost:8080/r')
    expect(() => normalizeSourceUrl('http://apps.example.com')).toThrow(/https/)
    expect(() => normalizeSourceUrl('https://u:p@apps.example.com')).toThrow(/user name/)
    expect(() => normalizeSourceUrl('javascript:alert(1)')).toThrow()
    expect(() => normalizeSourceUrl('  ')).toThrow()
  })

  test('discovery: needs a protocol, an id, a name and index or search; a newer protocol is refused', () => {
    const ok = { protocol: 1, id: 'org.a.b', name: 'A', capabilities: ['index', 'bogus'] }
    expect(parseDiscovery(ok, 'https://a.test').capabilities).toEqual(['index'])
    expect(parseDiscovery(ok, 'https://a.test').api).toBe('https://a.test')
    expect(() => parseDiscovery({ ...ok, protocol: 2 }, 'https://a.test')).toThrow(/newer/)
    expect(() => parseDiscovery({ ...ok, capabilities: ['updates'] }, 'https://a.test')).toThrow(/index/)
    expect(() => parseDiscovery({ ...ok, id: 'nodots' }, 'https://a.test')).toThrow(/reverse-DNS/)
    expect(() => parseDiscovery({ ...ok, icon: 'javascript:alert(1)' }, 'https://a.test')).toThrow()
    expect(() => parseDiscovery({ ...ok, api: 'http://evil.test' }, 'https://a.test')).toThrow(/https/)
  })

  test('versions compare numerically and a prerelease sorts below its release', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(-1)
  })

  test('search ranks names above summaries and filters by category', () => {
    const l = (id: string, name: string, summary: string, categories: string[]): Listing => ({ id, name, summary, version: '1.0.0', publisher: { name: '' }, categories, size: 0, updated: '' })
    const items = [l('com.a.one', 'Photos', 'edit notes on pictures', []), l('com.a.two', 'Notes', 'write', ['productivity']), l('com.a.three', 'Clock', 'time', ['utilities'])]
    expect(searchListings(items, 'notes').map((i) => i.name)).toEqual(['Notes', 'Photos'])
    expect(searchListings(items, '', { category: 'utilities' }).map((i) => i.name)).toEqual(['Clock'])
    expect(searchListings(items, 'zzz')).toEqual([])
  })
})

test.describe('the service', () => {
  test.use({ system: true, helpers: true })

  test('only the system may use it', async ({ page }) => {
    const out = await page.evaluate(() => window.runApp('com.test.nosy', `export default async (tiny) => {
      const port = await tiny.lookup('tiny.sources')
      const ask = async (msg) => (await tiny.request(port, msg)).data
      const results = [await ask({ op: 'list' }), await ask({ op: 'add', url: 'https://x.test' })]
      await tiny.writeFile('/tmp/com.test.nosy.out', new TextEncoder().encode(JSON.stringify(results)))
    }`))
    for (const r of out) expect(r.ok === false ? r.error.code : 'allowed').toBe('EPERM')
  })

  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => void window.attachDrivers())
    await page.waitForTimeout(200)
  })

  test('add a source: preview shows what will be trusted, nothing is saved until add', async ({ page }) => {
    await serve(page, 'apps.acme.test', registry('apps.acme.test'))
    const out = await page.evaluate(async () => {
      const preview = await window.ask('sources', { op: 'preview', url: 'apps.acme.test' })
      const before = await window.ask('sources', { op: 'list' })
      const added = await window.ask('sources', { op: 'add', url: 'apps.acme.test', fingerprint: '' })
      const dup = await window.ask('sources', { op: 'add', url: 'https://apps.acme.test/' })
      const plain = await window.ask('sources', { op: 'preview', url: 'http://apps.acme.test' })
      const none = await window.ask('sources', { op: 'preview', url: 'https://nothing.test' })
      return { preview, before, added, dup, plain, none, after: await window.ask('sources', { op: 'list' }) }
    })
    expect(out.preview).toMatchObject({ url: 'https://apps.acme.test', host: 'apps.acme.test', name: 'Acme Apps', signed: false, fingerprint: null, apps: 2 })
    expect(out.before).toEqual([])
    expect(out.added).toMatchObject({ id: 'acme-apps', origin: 'user', enabled: true, status: { state: 'ok', apps: 2 } })
    expect(out.dup).toEqual({ error: 'EEXIST' })
    expect(out.plain).toEqual({ error: 'EPERM' })
    expect(out.none.error).toBeTruthy()
    expect(out.after.map((s: { id: string }) => s.id)).toEqual(['acme-apps'])
  })

  test('native sources come from system settings: they can be turned off, not removed', async ({ page }) => {
    await serve(page, 'native.test', registry('native.test'))
    const out = await page.evaluate(async () => {
      await window.kernel.configSet('tiny.apps.sources', 'native', [{ id: 'native', name: 'Pear Apps', url: 'https://native.test' }], { scope: 'system' })
      const list = await window.ask('sources', { op: 'list' })
      const remove = await window.ask('sources', { op: 'remove', id: 'native' })
      const rename = await window.ask('sources', { op: 'set', id: 'native', name: 'Mine' })
      const off = await window.ask('sources', { op: 'set', id: 'native', enabled: false })
      const search = await window.ask('sources', { op: 'search', query: 'notes' })
      return { list, remove, rename, off, search, after: await window.ask('sources', { op: 'list' }) }
    })
    expect(out.list[0]).toMatchObject({ id: 'native', origin: 'native', enabled: true })
    expect(out.remove).toEqual({ error: 'EPERM' })
    expect(out.rename).toEqual({ error: 'EPERM' })
    expect(out.off).toMatchObject({ enabled: false })
    expect(out.search).toEqual([]) // a source that is off is not searched
    expect(out.after[0].enabled).toBe(false)
  })

  test('search groups results by source; the same id in two sources is shown twice', async ({ page }) => {
    await serve(page, 'a.test', registry('a.test', { id: 'org.a.apps', name: 'A' }))
    await serve(page, 'b.test', registry('b.test', { id: 'org.b.apps', name: 'B' }))
    const out = await page.evaluate(async () => {
      await window.ask('sources', { op: 'add', url: 'a.test' })
      await window.ask('sources', { op: 'add', url: 'b.test' })
      return { all: await window.ask('sources', { op: 'search', query: 'notes' }), one: await window.ask('sources', { op: 'search', query: '', sources: ['b'], category: 'utilities' }) }
    })
    expect(out.all.map((g: { sourceId: string; apps: Array<{ id: string }> }) => [g.sourceId, g.apps.map((a) => a.id)])).toEqual([['a', ['com.acme.notes']], ['b', ['com.acme.notes']]])
    expect(out.one).toHaveLength(1)
    expect(out.one[0].apps.map((a: { id: string }) => a.id)).toEqual(['com.acme.clock'])
  })

  test('install what the record pinned, remember where it came from, and update from the same source', async ({ page }) => {
    const mock = registry('apps.acme.test')
    await serve(page, 'apps.acme.test', mock)
    const base = 'https://apps.acme.test'
    await page.evaluate(async () => void (await window.ask('sources', { op: 'add', url: 'apps.acme.test' })))

    const install = () => page.evaluate(async () => {
      const prepared = await window.ask('sources', { op: 'prepare', sourceId: 'acme-apps', appId: 'com.acme.notes' })
      if (prepared.error) return prepared
      const info = await window.kernel.bundleInstall({ files: prepared.files })
      await window.ask('sources', { op: 'record', id: info.id, sourceId: prepared.sourceId, version: prepared.version, digest: prepared.digest })
      return { id: info.id, version: info.version, provenance: await window.ask('sources', { op: 'provenance', id: info.id }), updates: await window.ask('sources', { op: 'updates' }) }
    })
    const first = await install()
    expect(first).toMatchObject({ id: 'com.acme.notes', version: '1.0.0', provenance: { sourceId: 'acme-apps', version: '1.0.0' }, updates: [] })

    // the source publishes 1.1.0, which asks for more access
    const v2 = bundle('com.acme.notes', '1.1.0', ['network'])
    mock.files.set('/apps/com.acme.notes/app.json', JSON.stringify(record('com.acme.notes', [{ version: '1.1.0', permissions: ['network'] }, { version: '1.0.0' }], base)))
    mock.files.set('/apps/com.acme.notes/1.1.0/manifest.json', v2.manifest)
    mock.files.set('/apps/com.acme.notes/1.1.0/main.js', v2.main)

    const out = await page.evaluate(async () => {
      const updates = await window.ask('sources', { op: 'updates' })
      const refused = await window.ask('sources', { op: 'prepareUpdate', id: 'com.acme.notes' })
      const ok = await window.ask('sources', { op: 'prepareUpdate', id: 'com.acme.notes', allowNewPermissions: true })
      const info = await window.kernel.bundleUpdate('com.acme.notes', { files: ok.files })
      await window.ask('sources', { op: 'record', id: info.id, sourceId: ok.sourceId, version: ok.version, digest: ok.digest })
      return { updates, refused, added: ok.permissionsAdded, version: info.version, again: await window.ask('sources', { op: 'updates' }), latest: await window.ask('sources', { op: 'prepareUpdate', id: 'com.acme.notes' }) }
    })
    expect(out.updates).toEqual([{ id: 'com.acme.notes', name: 'Notes', sourceId: 'acme-apps', installed: '1.0.0', available: '1.1.0', permissionsAdded: ['network'] }])
    expect(out.refused).toEqual({ error: 'EPERM' })
    expect(out.added).toEqual(['network'])
    expect(out.version).toBe('1.1.0')
    expect(out.again).toEqual([])
    expect(out.latest).toEqual({ error: 'EEXIST' })
  })

  test('nothing is handed back when a file, the manifest or the permissions do not match the record', async ({ page }) => {
    const mock = registry('apps.acme.test')
    await serve(page, 'apps.acme.test', mock)
    await page.evaluate(async () => void (await window.ask('sources', { op: 'add', url: 'apps.acme.test' })))
    const prepare = () => page.evaluate(() => window.ask('sources', { op: 'prepare', sourceId: 'acme-apps', appId: 'com.acme.notes' }))

    mock.files.set('/apps/com.acme.notes/1.0.0/main.js', 'export default () => fetch("https://evil.test")')
    expect(await prepare()).toEqual({ error: 'EINVAL' }) // a changed file

    const tampered = bundle('com.acme.notes', '1.0.0', ['fs.all'])
    mock.files.set('/apps/com.acme.notes/1.0.0/manifest.json', tampered.manifest)
    mock.files.set('/apps/com.acme.notes/1.0.0/main.js', tampered.main)
    expect(await prepare()).toEqual({ error: 'EINVAL' }) // a changed manifest no longer matches the pinned digest

    // the record is honest about the digest but the manifest asks for more than the listing shows
    const sneaky = bundle('com.acme.notes', '1.0.0', ['fs.all'])
    mock.files.set('/apps/com.acme.notes/app.json', JSON.stringify(record('com.acme.notes', [{ version: '1.0.0', permissions: [], manifest: sneaky.manifest }], 'https://apps.acme.test')))
    expect(await prepare()).toEqual({ error: 'EINVAL' })
  })

  test('a withdrawn version is not offered, whether asked for by default or by number', async ({ page }) => {
    const mock = registry('apps.acme.test')
    await serve(page, 'apps.acme.test', mock)
    await page.evaluate(async () => void (await window.ask('sources', { op: 'add', url: 'apps.acme.test' })))
    const rec = record('com.acme.notes', [{ version: '1.0.0', yanked: 'broken' }], 'https://apps.acme.test')
    mock.files.set('/apps/com.acme.notes/app.json', JSON.stringify(rec))
    const out = await page.evaluate(async () => ({
      yanked: await window.ask('sources', { op: 'prepare', sourceId: 'acme-apps', appId: 'com.acme.notes' }),
      exact: await window.ask('sources', { op: 'prepare', sourceId: 'acme-apps', appId: 'com.acme.notes', version: '1.0.0' }),
    }))
    expect(out.yanked).toEqual({ error: 'ENOENT' })
    expect(out.exact).toEqual({ error: 'EINVAL' })
  })

  test('a .pearapp version is fetched, pinned to the listing digest, and installed by the kernel against what the listing promised', async ({ page }) => {
    const mock = registry('apps.acme.test')
    await serve(page, 'apps.acme.test', mock)
    await page.evaluate(async () => void (await window.ask('sources', { op: 'add', url: 'apps.acme.test' })))
    // a package of 1.0.0 built by the kernel, and published as the artifact
    const built = await page.evaluate(async () => {
      const k = window.kernel
      await k.mkdir('/tmp/pa', { recursive: true })
      await k.writeFile('/tmp/pa/manifest.json', new TextEncoder().encode(JSON.stringify({ id: 'com.acme.notes', name: 'Notes', version: '1.0.0', permissions: ['clipboard'] })))
      await k.writeFile('/tmp/pa/main.js', new TextEncoder().encode('export default () => 1'))
      const blob = await k.bundlePackage('/tmp/pa')
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    const bytes = Buffer.from(built)
    const publish = (listed: string[], digest = sha(bytes)) => {
      const rec = record('com.acme.notes', [{ version: '1.0.0', permissions: listed }], 'https://apps.acme.test')
      rec.versions[0]!.artifact = { kind: 'pearapp', url: 'https://apps.acme.test/apps/com.acme.notes/1.0.0/notes.pearapp', sha256: digest, size: bytes.length } as never
      mock.files.set('/apps/com.acme.notes/app.json', JSON.stringify(rec))
      mock.files.set('/apps/com.acme.notes/1.0.0/notes.pearapp', bytes)
    }
    const prepare = () => page.evaluate(() => window.ask('sources', { op: 'prepare', sourceId: 'acme-apps', appId: 'com.acme.notes' }))

    publish(['clipboard'])
    const ok = await prepare()
    expect(ok).toMatchObject({ kind: 'archive', version: '1.0.0', digest: sha(bytes), permissions: ['clipboard'] })
    expect(ok.bytes).toHaveLength(bytes.length)

    publish(['clipboard'], '0'.repeat(64))
    expect(await prepare()).toEqual({ error: 'EINVAL' }) // not the package the listing pinned

    // the package is the pinned one, but it asks for more than the listing shows: the kernel refuses it
    publish([])
    const result = await page.evaluate(async () => {
      const p = await window.ask('sources', { op: 'prepare', sourceId: 'acme-apps', appId: 'com.acme.notes' })
      const k = window.kernel
      const lie = await k.bundleInstallArchive(new Blob([p.bytes]), { expectDigest: p.digest, expect: { id: p.appId, version: p.version, permissions: p.permissions } }).then(() => 'installed', (e: any) => `${e.code}: ${e.message}`)
      const wrongApp = await k.bundleInstallArchive(new Blob([p.bytes]), { expect: { id: 'com.other.app' } }).then(() => 'installed', (e: any) => e.code)
      const wrongVersion = await k.bundleInstallArchive(new Blob([p.bytes]), { expect: { version: '9.9.9' } }).then(() => 'installed', (e: any) => e.code)
      return { lie, wrongApp, wrongVersion, listed: (await k.bundleList()).some((b) => b.id === 'com.acme.notes') }
    })
    expect(result.lie).toMatch(/^EINVAL: .*clipboard/)
    expect(result).toMatchObject({ wrongApp: 'EINVAL', wrongVersion: 'EINVAL', listed: false })

    publish(['clipboard'])
    const installed = await page.evaluate(async () => {
      const k = window.kernel
      const p = await window.ask('sources', { op: 'prepare', sourceId: 'acme-apps', appId: 'com.acme.notes' })
      const info = await k.bundleInstallArchive(new Blob([p.bytes]), { expectDigest: p.digest, expect: { id: p.appId, version: p.version, permissions: p.permissions }, from: { kind: 'registry', sourceId: p.sourceId, url: p.sourceUrl, version: p.version, digest: p.digest } })
      await window.ask('sources', { op: 'record', id: info.id, sourceId: p.sourceId, version: p.version, digest: p.digest })
      return { id: info.id, from: await k.bundleInstalledFrom('com.acme.notes'), updates: await window.ask('sources', { op: 'updates' }) }
    })
    expect(installed).toMatchObject({ id: 'com.acme.notes', from: { kind: 'registry', sourceId: 'acme-apps', version: '1.0.0' }, updates: [] })
  })

  test('a source that is down keeps showing what was cached', async ({ page }) => {
    const mock = registry('apps.acme.test')
    await serve(page, 'apps.acme.test', mock)
    await page.evaluate(async () => void (await window.ask('sources', { op: 'add', url: 'apps.acme.test' })))
    await page.unroute('https://apps.acme.test/**')
    await page.route('https://apps.acme.test/**', (route) => route.abort('failed'))
    const out = await page.evaluate(() => window.ask('sources', { op: 'search', query: 'notes' }))
    expect(out[0]).toMatchObject({ sourceId: 'acme-apps', stale: true, total: 1, error: { code: 'EACCES' } })
  })

  test('a signed source: documents must verify, and a changed key turns the source off', async ({ page }) => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64')
    const mock = registry('signed.test', { key: { alg: 'ed25519', public: pub } })
    const signAll = () => {
      for (const [path, body] of [...mock.files]) if (!path.endsWith('.sig') && path.endsWith('.json') && !path.includes('well-known')) mock.files.set(`${path}.sig`, sign(null, typeof body === 'string' ? Buffer.from(body) : body, privateKey).toString('base64'))
    }
    signAll()
    await serve(page, 'signed.test', mock)
    const added = await page.evaluate(() => window.ask('sources', { op: 'add', url: 'signed.test' }))
    expect(added).toMatchObject({ status: { state: 'ok', apps: 2 } })
    expect(added.keyFingerprint).toMatch(/^[0-9a-f]{64}$/)

    // an index someone altered after signing is refused
    mock.files.set('/index.json', JSON.stringify({ apps: [] }))
    const search = await page.evaluate(() => window.ask('sources', { op: 'search', query: '' }))
    expect(search[0]).toMatchObject({ stale: true, total: 2, error: { code: 'EACCES' } }) // the last verified copy, and why it is old

    // the registry starts advertising another key
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!
    mock.files.set('/.well-known/pear-registry.json', JSON.stringify({ protocol: 1, id: 'org.acme.apps', name: 'Acme Apps', capabilities: ['index'], key: { alg: 'ed25519', public: Buffer.from(other, 'base64url').toString('base64') } }))
    const after = await page.evaluate(async () => {
      const refresh = await window.ask('sources', { op: 'search', query: '' })
      return { refresh, list: await window.ask('sources', { op: 'list' }) }
    })
    expect(after.refresh[0].error.code).toBe('EACCES')
    expect(after.list[0].enabled).toBe(false)
  })
})
