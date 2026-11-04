/** Installing from a link (`contracts/app-distribution.md`): the `?install=` intent and `tiny.installer`. */
import { createHash } from 'node:crypto'
import { parseIntents, withoutIntents } from '../src/intents'
import { expect, test } from './fixtures'

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' }
const NOW = new Date('2026-11-01T12:00:00Z')

test.describe('intents', () => {
  test('?install= and ?addSource= become typed intents; nothing else does', () => {
    const link = 'https://apps.example.com/notes.pearapp'
    expect(parseIntents(`?install=${encodeURIComponent(link)}`, NOW)).toEqual([{ kind: 'installUrl', source: link, receivedAt: NOW.toISOString() }])
    expect(parseIntents(`?addSource=${encodeURIComponent('https://apps.example.com')}&ns=x`, NOW)).toEqual([{ kind: 'addSource', url: 'https://apps.example.com/', receivedAt: NOW.toISOString() }])
    expect(parseIntents('?ns=x&safe', NOW)).toEqual([])
    expect(parseIntents('', NOW)).toEqual([])
    // only the first of a repeated parameter counts
    expect(parseIntents(`?install=${encodeURIComponent(link)}&install=${encodeURIComponent('https://evil.test/x.pearapp')}`, NOW)).toHaveLength(1)
  })

  test('http (except on localhost), credentials and junk are rejected with a reason, never acted on', () => {
    const rejected = (q: string) => parseIntents(q, NOW)[0] as { kind: string; reason: string }
    expect(rejected(`?install=${encodeURIComponent('http://apps.example.com/a.pearapp')}`)).toMatchObject({ kind: 'rejected', reason: expect.stringMatching(/https/) })
    expect(rejected(`?install=${encodeURIComponent('https://user:pw@apps.example.com/a.pearapp')}`)).toMatchObject({ kind: 'rejected', reason: expect.stringMatching(/user name/) })
    expect(rejected(`?install=${encodeURIComponent('javascript:alert(1)')}`).kind).toBe('rejected')
    expect(rejected('?install=').kind).toBe('rejected')
    expect(rejected('?install=not a url').kind).toBe('rejected')
    expect(rejected(`?install=${'a'.repeat(3000)}`)).toMatchObject({ kind: 'rejected', reason: expect.stringMatching(/too long/) })
    expect(parseIntents(`?install=${encodeURIComponent('http://localhost:8080/a.pearapp')}`, NOW)[0]!.kind).toBe('installUrl')
  })

  test('the address loses only the intent parameters', () => {
    expect(withoutIntents('https://pear.example/app/?ns=x&install=https%3A%2F%2Fa.test%2Fa.pearapp&addSource=https%3A%2F%2Fb.test#top')).toBe('/app/?ns=x#top')
    expect(withoutIntents('https://pear.example/')).toBe('/')
  })
})

test.describe('tiny.installer', () => {
  test.use({ system: true, helpers: true })

  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => void window.attachDrivers())
    await page.waitForTimeout(200)
  })

  const serve = async (page: import('@playwright/test').Page, files: Map<string, string | Buffer>) => {
    await page.route('https://apps.acme.test/**', (route) => {
      const url = new URL(route.request().url())
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      const body = files.get(url.pathname)
      return body === undefined ? route.fulfill({ status: 404, headers: CORS, body: 'no' }) : route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body })
    })
  }

  /** A package of a small project, built by the kernel; returned as bytes the mock host can serve. */
  const packaged = (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
      const { kernel } = window
      await kernel.mkdir('/tmp/lp', { recursive: true })
      await kernel.writeFile('/tmp/lp/manifest.json', new TextEncoder().encode(JSON.stringify({ id: 'com.acme.link', name: 'Link', version: '1.0.0' })))
      await kernel.writeFile('/tmp/lp/main.js', new TextEncoder().encode('export default () => 1'))
      const blob = await kernel.bundlePackage('/tmp/lp')
      return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), digest: (await kernel.bundleInspectArchive(blob)).digest }
    })

  test('a link to a package comes back as bytes the kernel then verifies and installs', async ({ page }) => {
    const pkg = await packaged(page)
    const files = new Map<string, string | Buffer>([['/apps/link.pearapp', Buffer.from(pkg.bytes)], ['/apps/fake.pearapp', 'hello'], ['/apps/dir/manifest.json', '{}']])
    await serve(page, files)
    const out = await page.evaluate(async (digest) => {
      const ask = window.ask
      const ok = await ask('installer', { op: 'fetch', url: 'https://apps.acme.test/apps/link.pearapp' })
      const pinned = await ask('installer', { op: 'fetch', url: 'https://apps.acme.test/apps/link.pearapp', digest })
      const wrongPin = await ask('installer', { op: 'fetch', url: 'https://apps.acme.test/apps/link.pearapp', digest: '0'.repeat(64) })
      const fake = await ask('installer', { op: 'fetch', url: 'https://apps.acme.test/apps/fake.pearapp' })
      const missing = await ask('installer', { op: 'fetch', url: 'https://apps.acme.test/apps/nothing.pearapp' })
      const plain = await ask('installer', { op: 'fetch', url: 'http://apps.acme.test/apps/link.pearapp' })
      const junk = await ask('installer', { op: 'fetch', url: 'not a url' })
      const info = await window.kernel.bundleInspectArchive(new Blob([ok.bytes]))
      const installed = await window.kernel.bundleInstallArchive(new Blob([ok.bytes]), { expectDigest: ok.digest, from: { kind: 'url', url: ok.url } })
      return { kind: ok.kind, digest: ok.digest, pinned: pinned.digest, wrongPin, fake, missing, plain, junk, info: info.ok, id: installed.id, from: await window.kernel.bundleInstalledFrom('com.acme.link') }
    }, pkg.digest)
    expect(out).toMatchObject({ kind: 'archive', digest: pkg.digest, pinned: pkg.digest, wrongPin: { error: 'EINVAL' }, fake: { error: 'EINVAL' }, missing: { error: 'ENOENT' }, plain: { error: 'EPERM' }, junk: { error: 'EINVAL' }, info: true, id: 'com.acme.link' })
    expect(out.from).toMatchObject({ kind: 'url', url: 'https://apps.acme.test/apps/link.pearapp', digest: pkg.digest, unsigned: true })
  })

  test('a served directory is accepted only when its manifest hashes every file, and each file matches', async ({ page }) => {
    const main = 'export default () => 2'
    const manifest = (o: object = {}) => JSON.stringify({ id: 'com.acme.dir', name: 'Dir', version: '1.0.0', entry: 'main.js', hashes: { 'main.js': sha(main) }, ...o })
    const files = new Map<string, string | Buffer>([
      ['/d/good/manifest.json', manifest()], ['/d/good/main.js', main],
      ['/d/bare/manifest.json', JSON.stringify({ id: 'com.acme.bare', name: 'Bare', version: '1.0.0' })], ['/d/bare/main.js', main],
      ['/d/changed/manifest.json', manifest()], ['/d/changed/main.js', 'export default () => fetch("//evil")'],
      ['/d/noentry/manifest.json', manifest({ hashes: { 'other.js': sha(main) } })], ['/d/noentry/other.js', main],
      ['/d/escape/manifest.json', manifest({ hashes: { 'main.js': sha(main), '../x.js': sha(main) } })], ['/d/escape/main.js', main],
    ])
    await serve(page, files)
    const out = await page.evaluate(async (good) => {
      const ask = window.ask
      const u = (p: string) => `https://apps.acme.test/d/${p}`
      return {
        good: await ask('installer', { op: 'fetch', url: u('good') }),
        manifestUrl: (await ask('installer', { op: 'fetch', url: u('good/manifest.json') })).url,
        pinned: await ask('installer', { op: 'fetch', url: u('good'), digest: good }),
        wrongPin: await ask('installer', { op: 'fetch', url: u('good'), digest: '1'.repeat(64) }),
        bare: await ask('installer', { op: 'fetch', url: u('bare') }),
        changed: await ask('installer', { op: 'fetch', url: u('changed') }),
        noentry: await ask('installer', { op: 'fetch', url: u('noentry') }),
        escape: await ask('installer', { op: 'fetch', url: u('escape') }),
        missing: await ask('installer', { op: 'fetch', url: u('absent') }),
      }
    }, sha(manifest()))
    expect(out.good).toMatchObject({ kind: 'directory', unsigned: true, url: 'https://apps.acme.test/d/good', manifestDigest: sha(manifest()) })
    expect(Object.keys(out.good.files).sort()).toEqual(['main.js', 'manifest.json'])
    expect(out.manifestUrl).toBe('https://apps.acme.test/d/good')
    expect(out.pinned.kind).toBe('directory')
    expect(out.wrongPin).toEqual({ error: 'EINVAL' })
    expect(out.bare).toEqual({ error: 'EPERM' }) // no hashes: nobody vouched for the files
    expect(out.changed).toEqual({ error: 'EINVAL' })
    expect(out.noentry).toEqual({ error: 'EINVAL' })
    expect(out.escape).toEqual({ error: 'EINVAL' })
    expect(out.missing.error).toBeTruthy()
  })
})
