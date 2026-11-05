/** The App Store: browse, search, install with a review, updates, uninstall. */
import { createHash } from 'node:crypto'
import type { FrameLocator, Page } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

const HELLO = 'org.tiny.sample.hello'
const NODE = 'org.tiny.sample.node'
const WASI = 'org.tiny.sample.wasi'
const LINT = 'org.tiny.sample.lint'

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#08f"/></svg>'

interface Item {
  id: string
  name: string
  kind: string
  summary?: string
  provides?: Record<string, unknown>
  requires?: Array<Record<string, string>>
  /** newest first */
  versions: Array<{ version: string; permissions?: string[]; manifest?: Record<string, unknown> }>
  featured?: boolean
}

/** The sample content of these tests: a Node.js runtime, a WASI framework, a tool, and an app that requires the runtime. Built here; nothing of it ships. */
const SAMPLES: Item[] = [
  { id: NODE, name: 'Node.js runtime', kind: 'runtime', summary: 'A placeholder runtime', provides: { runtime: 'node', version: '20.18.0', commands: ['node'] }, versions: [{ version: '20.18.0', manifest: { kind: 'runtime', entry: 'launcher.js', provides: { name: 'node', version: '20.18.0', abi: ['program'], commands: ['node'] } } }] },
  { id: WASI, name: 'WASI', kind: 'framework', summary: 'A placeholder framework', provides: { framework: 'wasi', version: '1.0.0' }, versions: [{ version: '1.0.0', manifest: { kind: 'framework', provides: { framework: 'wasi', version: '1.0.0', module: 'wasi.js' } } }] },
  { id: HELLO, name: 'Hello Node', kind: 'app', summary: 'Needs the Node.js runtime', featured: true, requires: [{ runtime: 'node', range: '^20' }], versions: [{ version: '1.1.0', permissions: ['notifications'] }, { version: '1.0.0' }] },
  { id: LINT, name: 'Pear Lint', kind: 'tool', summary: 'A developer tool', versions: [{ version: '1.0.0' }] },
]

/**
 * Serve a registry of `directory` artifacts (hashes computed here) from `page.route`. `base` is the registry's URL
 * without a trailing slash; `state.down` makes it unreachable.
 */
async function serveSource(page: Page, base: string, items: Item[], disco: Record<string, unknown>, state: { down?: boolean } = {}): Promise<void> {
  const files = new Map<string, string>()
  const listings = items.map((it) => ({
    id: it.id, name: it.name, summary: it.summary ?? '', kind: it.kind, ...(it.provides && { provides: it.provides }), version: it.versions[0]!.version,
    icon: `apps/${it.id}/icon.svg`, publisher: { name: 'Test' }, categories: [], size: 10, updated: '2026-11-01',
  }))
  const root = new URL(base).pathname.replace(/\/+$/, '')
  files.set(`${root}/.well-known/pear-registry.json`, JSON.stringify({ protocol: 1, capabilities: ['index'], ...disco }))
  files.set(`${root}/index.json`, JSON.stringify({ apps: listings, featured: items.filter((i) => i.featured).map((i) => i.id) }))
  items.forEach((it, n) => {
    files.set(`${root}/apps/${it.id}/icon.svg`, ICON)
    const records = it.versions.map((v) => {
      const entry = it.kind === 'framework' ? 'wasi.js' : it.kind === 'runtime' ? 'launcher.js' : 'main.js'
      const body = `export default async () => { /* ${it.id} ${v.version} */ }`
      const manifest = JSON.stringify({ id: it.id, name: it.name, version: v.version, kind: it.kind, entry, permissions: v.permissions ?? [], ...(it.requires && { requires: it.requires }), ...v.manifest, hashes: { [entry]: sha(body) } })
      files.set(`${root}/apps/${it.id}/${v.version}/manifest.json`, manifest)
      files.set(`${root}/apps/${it.id}/${v.version}/${entry}`, body)
      return { version: v.version, created: '2026-11-01', artifact: { kind: 'directory', url: `apps/${it.id}/${v.version}`, sha256: sha(manifest), size: 10 }, manifest: { permissions: v.permissions ?? [], ...(it.requires && { requires: it.requires }) } }
    })
    files.set(`${root}/apps/${it.id}/app.json`, JSON.stringify({ ...listings[n], description: `${it.name} (test)`, screenshots: [], versions: records }))
  })
  await page.route(`${new URL(base).origin}${root}/**`, (route) => {
    if (state.down) return route.abort('failed')
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = files.get(new URL(route.request().url()).pathname)
    return body === undefined ? route.fulfill({ status: 404, headers: CORS, body: 'no' }) : route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body })
  })
}
/** The deployment's built-in source (`/registry`), filled with the samples. */
const native = (page: Page, state: { down?: boolean } = {}, items = SAMPLES) =>
  serveSource(page, 'http://localhost:5173/registry', items, { id: 'org.tiny.apps', name: 'Pear Apps' }, state)

async function openStore(desktop: Desktop): Promise<FrameLocator> {
  await desktop.dock('org.tiny.appstore').click()
  await expect(desktop.win('App Store')).toBeVisible()
  const f = desktop.win('App Store').frameLocator('iframe')
  await expect(f.locator('#title')).toHaveText('Discover')
  return f
}
const section = (f: FrameLocator, name: string) => f.locator('#nav .item', { hasText: new RegExp(`^${name}`) }).click()

/** A request to `tiny.sources` as the system. */
const sources = <T = any>(page: Page, msg: Record<string, unknown>) =>
  page.evaluate(async (m) => {
    const k = window.tiny!.kernel
    const reply = (await k.request(await k.lookup('tiny.sources'), m)).data as { ok: boolean; result?: unknown; error?: { code: string } }
    if (!reply.ok) throw new Error(reply.error?.code)
    return reply.result ?? null
  }, msg) as Promise<T>
/** The sample bundles on the machine (the apps Desktop ships are installed too, and are not the subject here). */
const installed = (page: Page) => page.evaluate(async () => (await window.tiny!.kernel.bundleList()).map((b) => b.id).filter((id) => id.startsWith('org.tiny.sample.')).sort())

/** A second source on https://apps.acme.test that lists its own copy of the sample app. */
const acme = (page: Page, state: { down?: boolean } = {}) =>
  serveSource(page, 'https://apps.acme.test', [{ id: HELLO, name: 'Hello Node (Acme)', kind: 'app', summary: 'Acme copy', versions: [{ version: '2.0.0' }] }], { id: 'org.acme.apps', name: 'Acme Apps' }, state)

// the deployment's built-in source answers from the test's own samples
test.beforeEach(async ({ desktop }) => native(desktop.page))

test('opens from the Dock and lists what the built-in source offers', async ({ desktop }) => {
  const f = await openStore(desktop)
  for (const name of ['Discover', 'Apps', 'Developer tools', 'Runtimes', 'Frameworks', 'Installed', 'Updates']) await expect(f.locator('#nav .item', { hasText: name })).toBeVisible()
  const group = f.locator('[data-group="native"]').first()
  await expect(group).toContainText('Pear Apps')
  await expect(f.locator(`[data-listing="${HELLO}"]`)).toBeVisible() // featured
})

test('browse by kind: apps, developer tools, runtimes and frameworks each show their own listings', async ({ desktop }) => {
  const f = await openStore(desktop)
  await section(f, 'Runtimes')
  await expect(f.locator('#title')).toHaveText('Runtimes')
  await expect(f.locator(`[data-listing="${NODE}"]`)).toContainText('Node.js runtime')
  await expect(f.locator(`[data-listing="${NODE}"] .kind`)).toHaveText('Runtime')
  await expect(f.locator(`[data-listing="${NODE}"]`)).toContainText('provides node 20.18.0')
  await expect(f.locator(`[data-listing="${HELLO}"]`)).toHaveCount(0)
  await section(f, 'Frameworks')
  await expect(f.locator(`[data-listing="${WASI}"] .kind`)).toHaveText('Framework')
  await expect(f.locator('[data-listing]')).toHaveCount(1)
  await section(f, 'Developer tools')
  await expect(f.locator(`[data-listing="${LINT}"] .kind`)).toHaveText('Tool')
  await section(f, 'Apps')
  await expect(f.locator(`[data-listing="${HELLO}"] .kind`)).toHaveText('App')
  await expect(f.locator(`[data-listing="${NODE}"]`)).toHaveCount(0)
  // icons come from the source (a window cannot fetch them itself)
  await expect(f.locator(`[data-listing="${HELLO}"] .icon-tile img`)).toHaveAttribute('src', /^data:image\/svg\+xml/)
})

test('search covers every enabled source and groups the results by source; the same id is not merged', async ({ desktop }) => {
  const { page } = desktop
  await acme(page)
  await sources(page, { op: 'add', url: 'apps.acme.test' })
  const f = await openStore(desktop)
  await f.locator('#search').fill('hello')
  await expect(f.locator('#title')).toContainText('Results for')
  await expect(f.locator('[data-group]')).toHaveCount(2)
  await expect(f.locator('[data-group="native"] [data-listing]')).toHaveCount(1)
  await expect(f.locator('[data-group="acme-apps"] [data-listing]')).toContainText('Hello Node (Acme)')
  await expect(f.locator('[data-group]').first()).toContainText('Pear Apps') // priority order
  await expect(f.locator(`[data-listing="${HELLO}"]`)).toHaveCount(2)
  await f.locator('#search').fill('zzzz-not-there')
  await expect(f.locator('[data-empty="nothing"]')).toContainText('Nothing found')
})

test('an app that requires a runtime shows the requirement, the review lists it, and nothing installs the runtime', async ({ desktop }) => {
  const { page } = desktop
  const f = await openStore(desktop)
  await section(f, 'Apps')
  await f.locator(`[data-listing="${HELLO}"] button.open`).click()
  const req = f.locator('[data-req="node"]')
  await expect(req).toContainText('runtime node ^20')
  await expect(req).toContainText('Missing')
  await expect(req.getByRole('button', { name: 'Get Node.js runtime ^20' })).toBeVisible() // points at the matching listing of the same source
  await expect(f.locator('[data-section="provides"]')).toHaveCount(0)
  await expect(f.locator('[data-section="permissions"]')).toContainText('notifications')
  await expect(f.locator('[data-section="versions"]')).toContainText('1.0.0')

  await f.getByRole('button', { name: /^Install Hello Node from Pear Apps$/ }).click()
  const sheet = page.locator('.sheet')
  await expect(sheet).toContainText('Install “Hello Node”?')
  await expect(sheet).toContainText('Needs runtime node ^20: not installed')
  await expect(sheet).toContainText('Available as “Node.js runtime” 20.18.0 from Pear Apps')
  await expect(sheet).toContainText('It is not installed for you')
  await expect(sheet).toContainText('notifications')
  expect(await installed(page)).toEqual([])
  // continue without it
  await sheet.getByRole('button', { name: 'Install Anyway' }).click()
  await expect(f.locator('#status')).toContainText('Hello Node was installed')
  expect(await installed(page)).toEqual([HELLO]) // the runtime was not installed
  await expect(f.locator(`[data-detail] button[data-state="open"]`)).toBeVisible()
  expect(await sources(page, { op: 'provenance', id: HELLO })).toMatchObject({ sourceId: 'native', version: '1.1.0' })
})

test('"Get … first" in the review opens the runtime; installing the runtime then the app works and both show as installed', async ({ desktop }) => {
  const { page } = desktop
  const f = await openStore(desktop)
  await section(f, 'Apps')
  await f.getByRole('button', { name: /^Install Hello Node from Pear Apps$/ }).click()
  await page.locator('.sheet').getByRole('button', { name: 'Get Node.js runtime First' }).click()
  await expect(f.locator(`[data-detail="${NODE}"]`)).toBeVisible()
  expect(await installed(page)).toEqual([])
  await expect(f.locator('[data-section="provides"]')).toContainText('node 20.18.0')
  await expect(f.locator('[data-section="provides"] .tags')).toContainText('node')

  await f.getByRole('button', { name: /^Install Node.js runtime from Pear Apps$/ }).click()
  await expect(page.locator('.sheet')).toContainText('Install “Node.js runtime”?')
  await expect(page.locator('.sheet')).toContainText('Adds the command: node')
  await page.locator('.sheet button.primary').click()
  await expect(f.locator('#status')).toContainText('Node.js runtime was installed')
  expect(await page.evaluate(async () => (await window.tiny!.kernel.runtimeList()).map((r) => `${r.name}@${r.version}`))).toEqual(['node@20.18.0'])
  await expect(f.locator(`[data-detail] button[data-state="installed"]`)).toBeDisabled()

  // back to the app: the requirement is satisfied now, and the review has nothing to warn about
  await f.locator('#back').click()
  await section(f, 'Apps')
  await f.locator(`[data-listing="${HELLO}"] button.open`).click()
  await expect(f.locator('[data-req="node"]')).toContainText('Satisfied')
  await f.getByRole('button', { name: /^Install Hello Node from Pear Apps$/ }).click()
  await expect(page.locator('.sheet')).toContainText('Needs runtime node ^20: installed')
  await expect(page.locator('.sheet')).not.toContainText('not installed for you')
  await page.locator('.sheet button.primary').click()
  await expect(f.locator('#status')).toContainText('Hello Node was installed')

  await section(f, 'Installed')
  await expect(f.locator(`[data-installed="${NODE}"]`)).toContainText('Runtime')
  await expect(f.locator(`[data-installed="${NODE}"]`)).toContainText('from Pear Apps')
  await expect(f.locator(`[data-installed="${HELLO}"]`)).toContainText('from Pear Apps')
  expect(await installed(page)).toEqual([HELLO, NODE])
})

test('every sample artifact installs for real: runtime, framework, tool and app', async ({ desktop }) => {
  const { page } = desktop
  const out = await page.evaluate(async (ids) => {
    const k = window.tiny!.kernel
    const svc = async (m: Record<string, unknown>) => {
      const r = (await k.request(await k.lookup('tiny.sources'), m)).data as { ok: boolean; result?: any; error?: { message: string } }
      if (!r.ok) throw new Error(r.error?.message)
      return r.result
    }
    const done: string[] = []
    for (const id of ids) {
      const p = await svc({ op: 'prepare', sourceId: 'native', appId: id })
      const info = await k.bundleInstall({ files: p.files })
      done.push(`${info.id}:${info.kind}`)
    }
    return { done, frameworks: (await k.frameworkList()).map((f) => f.name), runtimes: (await k.runtimeList()).map((r) => r.name) }
  }, [NODE, WASI, LINT, HELLO])
  expect(out.done).toEqual([`${NODE}:runtime`, `${WASI}:framework`, `${LINT}:tool`, `${HELLO}:app`])
  expect(out.runtimes).toContain('node')
  expect(out.frameworks).toContain('wasi')
})

test('updates: an installed older version is offered the newer one, with the permission growth confirmed', async ({ desktop }) => {
  const { page } = desktop
  // 1.0.0 is in the sample source's history; install it the way the store would
  await page.evaluate(async () => {
    const k = window.tiny!.kernel
    const ask = async (m: Record<string, unknown>) => ((await k.request(await k.lookup('tiny.sources'), m)).data as { result: any }).result
    const p = await ask({ op: 'prepare', sourceId: 'native', appId: 'org.tiny.sample.hello', version: '1.0.0' })
    await k.bundleInstall({ files: p.files })
    await ask({ op: 'record', id: p.appId, sourceId: p.sourceId, version: p.version, digest: p.digest })
  })
  const f = await openStore(desktop)
  await expect(f.locator('#nav .item[data-section="updates"] .badge')).toHaveText('1')
  await section(f, 'Installed')
  await expect(f.locator(`[data-installed="${HELLO}"]`)).toContainText('update 1.1.0 available')
  await section(f, 'Updates')
  const item = f.locator(`[data-update="${HELLO}"]`)
  await expect(item).toContainText('1.0.0 → 1.1.0')
  await expect(item).toContainText('asks for more access: notifications')
  await f.getByRole('button', { name: 'Update Hello Node' }).click()
  await expect(page.locator('.sheet')).toContainText('Update “Hello Node”?')
  await expect(page.locator('.sheet')).toContainText('This update asks for more access: notifications')
  await page.locator('.sheet button.primary').click()
  await expect(f.locator('#status')).toContainText('Hello Node was updated')
  await expect(f.locator('[data-empty="updates"]')).toBeVisible()
  expect((await page.evaluate(() => window.tiny!.kernel.bundleInfo('org.tiny.sample.hello'))).version).toBe('1.1.0')
})

test('uninstall asks first, then removes it from the machine and from the Installed list', async ({ desktop }) => {
  const { page } = desktop
  const f = await openStore(desktop)
  await section(f, 'Developer tools')
  await f.getByRole('button', { name: /^Install Pear Lint/ }).click()
  await page.locator('.sheet button.primary').click()
  await expect(f.locator('#status')).toContainText('Pear Lint was installed')
  await section(f, 'Installed')
  const row = f.locator(`[data-installed="${LINT}"]`)
  await expect(row).toContainText('from Pear Apps')
  await f.getByRole('button', { name: 'Uninstall Pear Lint' }).click()
  await expect(page.locator('.sheet')).toContainText('Uninstall Pear Lint?')
  await page.locator('.sheet').getByRole('button', { name: 'Cancel' }).click()
  await expect(row).toBeVisible()
  await f.getByRole('button', { name: 'Uninstall Pear Lint' }).click()
  await page.locator('.sheet button.danger').click()
  await expect(row).toHaveCount(0)
  expect(await installed(page)).toEqual([])
  expect(await sources(page, { op: 'provenance', id: LINT })).toBeNull()
})

test('no enabled sources: the store says so and points at Settings', async ({ desktop }) => {
  const { page } = desktop
  await sources(page, { op: 'set', id: 'native', enabled: false })
  const f = await openStore(desktop)
  await expect(f.locator('[data-empty="no-sources"]')).toContainText('No sources are turned on')
  await expect(f.getByRole('button', { name: 'Open App Sources in Settings' })).toBeVisible()
  await f.getByRole('button', { name: 'Open App Sources in Settings' }).click()
  await expect(desktop.win('System Settings')).toBeVisible()
})

test('a source that cannot be reached shows its last copy with a note; one that lists nothing says so', async ({ desktop }) => {
  const { page } = desktop
  const state = { down: false }
  await acme(page, state)
  await sources(page, { op: 'add', url: 'apps.acme.test' })
  const f = await openStore(desktop)
  await section(f, 'Runtimes')
  await expect(f.locator('[data-group="acme-apps"]')).toContainText('This source lists no runtimes')
  state.down = true
  await section(f, 'Apps')
  await f.getByRole('button', { name: 'Refresh' }).click()
  const note = f.locator('[data-group="acme-apps"] [data-note="stale"]')
  await expect(note).toContainText('Cannot reach Acme Apps')
  await expect(note).toContainText('last copy')
  await expect(f.locator('[data-group="acme-apps"] [data-listing]')).toHaveCount(1) // the cached listing is still shown
  await expect(f.locator('[data-group="native"] [data-listing]').first()).toBeVisible() // the other source is not affected
})
