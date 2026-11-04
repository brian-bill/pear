/** Installing apps from a package file or a link (`contracts/app-distribution.md`): the App Installer. */
import type { Page } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

const HOME = '/Users/pear'
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' }

/** Build a small project and package it with the kernel; the bytes come back to the test. */
async function packageBytes(page: Page, id: string, version = '1.0.0', permissions: string[] = ['clipboard']): Promise<number[]> {
  return page.evaluate(async ([id, version, permissions]) => {
    const k = window.tiny!.kernel
    const dir = `/tmp/proj-${id}`
    await k.mkdir(`${dir}/Resources`, { recursive: true })
    const enc = new TextEncoder()
    await k.writeFile(`${dir}/manifest.json`, enc.encode(JSON.stringify({ id, name: 'Hello', version, entry: 'main.js', icon: 'Resources/icon.svg', permissions })))
    await k.writeFile(`${dir}/main.js`, enc.encode('export default async () => {}'))
    await k.writeFile(`${dir}/Resources/icon.svg`, enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    return Array.from(new Uint8Array(await (await k.bundlePackage(dir)).arrayBuffer()))
  }, [id, version, permissions] as const)
}

async function serve(page: Page, path: string, bytes: number[]): Promise<void> {
  await page.route('https://apps.acme.test/**', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    return new URL(route.request().url()).pathname === path
      ? route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: Buffer.from(bytes) })
      : route.fulfill({ status: 404, headers: CORS, body: 'no' })
  })
}

const installer = (d: Desktop) => d.win('Install App')
const frame = (d: Desktop) => installer(d).frameLocator('iframe')
const installed = (page: Page, id: string) => page.evaluate((id) => window.tiny!.kernel.bundleList().then((l) => l.some((b) => b.id === id)), id)

async function reopen(d: Desktop, query: string): Promise<void> {
  await d.page.goto(`/?ns=${d.ns}&${query}`)
  await d.page.waitForFunction(() => (window as unknown as { tinyReady?: boolean }).tinyReady === true, null, { timeout: 30_000 })
}

test('opening a .pearapp reviews it, installs it, and it shows up without a reload', async ({ desktop }) => {
  const { page } = desktop
  const bytes = await packageBytes(page, 'com.acme.hello')
  await page.evaluate(async ([bytes, path]) => void (await window.tiny!.kernel.writeFile(path as string, new Uint8Array(bytes as number[]))), [bytes, `${HOME}/Downloads/hello.pearapp`] as const)
  await page.evaluate((p) => window.tiny!.kernel.launchOpen(p), `${HOME}/Downloads/hello.pearapp`)

  const f = frame(desktop)
  await expect(f.locator('h1')).toHaveText('Hello')
  await expect(f.locator('.head')).toContainText('Version 1.0.0')
  await expect(f.locator('.badge.warn')).toHaveText('No verified publisher')
  await expect(f.locator('.card')).toContainText('Use the clipboard')
  await expect(f.locator('.facts')).toContainText('hello.pearapp')
  expect(await installed(page, 'com.acme.hello')).toBe(false) // reviewing installs nothing

  await f.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(f.locator('h1')).toHaveText('Hello was installed')
  expect(await installed(page, 'com.acme.hello')).toBe(true)
  expect(await page.evaluate(() => window.tiny!.kernel.bundleInstalledFrom('com.acme.hello'))).toMatchObject({ kind: 'archive', version: '1.0.0', unsigned: true })
  // the registry follows the install: Dock and Launchpad can list it now
  await expect.poll(() => page.evaluate(() => Boolean((window.tiny as unknown as { registry: { get(id: string): unknown } }).registry.get('com.acme.hello')))).toBe(true)
})

test('a package that was changed is refused with the reason and nothing is installed', async ({ desktop }) => {
  const { page } = desktop
  const bytes = await packageBytes(page, 'com.acme.broken')
  bytes[Math.floor(bytes.length / 2)]! ^= 0xff
  await page.evaluate(async ([bytes, path]) => void (await window.tiny!.kernel.writeFile(path as string, new Uint8Array(bytes as number[]))), [bytes, `${HOME}/Downloads/broken.pearapp`] as const)
  await page.evaluate((p) => window.tiny!.kernel.launchOpen(p), `${HOME}/Downloads/broken.pearapp`)
  const f = frame(desktop)
  await expect(f.locator('[role="alert"]')).toContainText(/damaged|checksum/)
  await expect(f.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0)
  expect(await installed(page, 'com.acme.broken')).toBe(false)
})

test('an install link opens the same review once the session is back, and is taken out of the address', async ({ desktop }) => {
  const { page } = desktop
  const link = 'https://apps.acme.test/apps/hello.pearapp'
  await serve(page, '/apps/hello.pearapp', await packageBytes(page, 'com.acme.linked'))
  await reopen(desktop, `install=${encodeURIComponent(link)}`)

  const f = frame(desktop)
  await expect(f.locator('h1')).toHaveText('Hello')
  await expect(f.locator('.facts')).toContainText('apps.acme.test')
  expect(page.url()).not.toContain('install=') // a reload will not ask again
  expect(await installed(page, 'com.acme.linked')).toBe(false)
  await f.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(f.locator('h1')).toHaveText('Hello was installed')
  expect(await page.evaluate(() => window.tiny!.kernel.bundleInstalledFrom('com.acme.linked'))).toMatchObject({ kind: 'url', url: link })

  // the same link again, now that it is installed, offers an update, not a second copy
  await page.evaluate((l) => window.tiny!.apps.launch('org.tiny.installer', { args: [`install:${l}`] }), link)
  await expect(f.getByRole('button', { name: 'Update' })).toBeVisible()
  await expect(f.locator('.facts')).toContainText('Version 1.0.0')
})

test('a link that is refused (plain http) opens nothing', async ({ desktop }) => {
  const { page } = desktop
  await reopen(desktop, `install=${encodeURIComponent('http://apps.acme.test/apps/hello.pearapp')}`)
  await expect(installer(desktop)).toHaveCount(0)
  expect(page.url()).not.toContain('install=')
})

test('an add-source link opens Settings with the review of that source; nothing is added until confirmed', async ({ desktop }) => {
  const { page } = desktop
  await page.route('https://apps.acme.test/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (path === '/.well-known/pear-registry.json') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 1, id: 'org.acme.apps', name: 'Acme Apps', capabilities: ['index'] }) })
    return route.fulfill({ status: 404, headers: CORS, body: 'no' })
  })
  await reopen(desktop, `addSource=${encodeURIComponent('https://apps.acme.test')}`)
  await expect(page.locator('.sheet')).toContainText('Add “Acme Apps” as a source?')
  expect(await page.evaluate(() => window.tiny!.kernel.configGet('tiny.apps.sources', 'added'))).toEqual([])
  await page.locator('.sheet button:not(.primary)').click() // Cancel
  expect(await page.evaluate(() => window.tiny!.kernel.configGet('tiny.apps.sources', 'added'))).toEqual([])
})

test('a packaged project that uses WebAssembly runs the same once installed as in its preview', async ({ desktop }) => {
  const { page } = desktop
  // add(a, b) in WebAssembly, loaded from the project the way Code's template does: a relative path, then instantiate
  const wasm = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 7, 1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 7, 1, 3, 0x61, 0x64, 0x64, 0, 0, 0x0a, 9, 1, 7, 0, 0x20, 0, 0x20, 1, 0x6a, 0x0b]
  const result = await page.evaluate(async (wasm) => {
    const k = window.tiny!.kernel
    const enc = new TextEncoder()
    const dir = '/tmp/wasm-proj'
    await k.mkdir(`${dir}/src`, { recursive: true })
    await k.writeFile(`${dir}/manifest.json`, enc.encode(JSON.stringify({ id: 'com.acme.wasm', name: 'Wasm Demo', version: '1.0.0', ui: 'index.html', permissions: [] })))
    await k.writeFile(`${dir}/index.html`, enc.encode('<!doctype html><body><button id="go">go</button><pre id="out">starting</pre><script src="app.js"></script></body>'))
    await k.writeFile(`${dir}/app.js`, enc.encode(`
      let instance
      async function load() {
        const bytes = await tiny.readFile('src/main.wasm')
        instance = (await WebAssembly.instantiate(bytes, {})).instance
        document.getElementById('out').textContent = 'loaded'
      }
      load().catch((e) => { document.getElementById('out').textContent = 'failed: ' + e.message })
      document.getElementById('go').addEventListener('click', () => { document.getElementById('out').textContent = 'add(2,3)=' + instance.exports.add(2, 3) })`))
    await k.writeFile(`${dir}/src/main.wasm`, new Uint8Array(wasm))
    // as Code does: the standard app process is added to a project that has none
    const runtime = new TextDecoder().decode(await k.readFile('/Applications/Preview.app/main.js'))
    const withHost = await k.bundlePackage(dir, { extra: { 'main.js': runtime } } as never)
    await k.bundleInstallArchive(withHost)
    for (let i = 0; i < 50 && !(window.tiny as unknown as { registry: { get(id: string): unknown } }).registry.get('com.acme.wasm'); i++) await new Promise((r) => setTimeout(r, 100))
    await window.tiny!.apps.launch('com.acme.wasm')
    return true
  }, wasm)
  expect(result).toBe(true)
  const app = page.locator('.window', { has: page.locator('.name', { hasText: /^Wasm Demo$/ }) }).frameLocator('iframe')
  await expect(app.locator('#out')).toHaveText('loaded')
  await app.locator('#go').click()
  await expect(app.locator('#out')).toHaveText('add(2,3)=5')
})
