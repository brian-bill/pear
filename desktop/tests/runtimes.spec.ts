/** Language runtimes in Desktop: Settings > Runtimes and the install review. */
import type { FrameLocator, Page } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

const HOME = '/Users/pear'

const manifest = (id: string, provides: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, name: id.split('.').pop(), version: '1.0.0', kind: 'runtime', entry: 'launcher.js', provides, ...extra,
})

/** Install a tiny runtime straight into the kernel. */
async function addRuntime(page: Page, id: string, provides: Record<string, unknown>): Promise<void> {
  await page.evaluate(([id, provides, m]) => {
    return window.tiny!.kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify(m), 'launcher.js': 'export default async () => 0' } }).then(() => undefined)
  }, [id, provides, manifest(id, provides)] as const)
}

/** Package a project folder written into the file system and leave the `.pearapp` in Downloads. */
async function packageTo(page: Page, m: Record<string, unknown>, file: string): Promise<string> {
  const path = `${HOME}/Downloads/${file}`
  await page.evaluate(async ([m, path]) => {
    const k = window.tiny!.kernel
    const dir = `/tmp/proj-${String((m as { id: string }).id)}`
    await k.mkdir(dir, { recursive: true })
    const enc = new TextEncoder()
    await k.writeFile(`${dir}/manifest.json`, enc.encode(JSON.stringify(m)))
    await k.writeFile(`${dir}/launcher.js`, enc.encode('export default async () => 0'))
    await k.writeFile(`${dir}/main.js`, enc.encode('export default async () => {}'))
    await k.writeFile(path as string, new Uint8Array(await (await k.bundlePackage(dir)).arrayBuffer()))
  }, [m, path] as const)
  return path
}

async function openRuntimes(desktop: Desktop): Promise<FrameLocator> {
  await desktop.page.evaluate(() => window.tiny!.apps.launch('org.tiny.settings', { args: ['pane:runtimes'] }))
  await expect(desktop.win('System Settings')).toBeVisible()
  const f = desktop.win('System Settings').frameLocator('iframe')
  await expect(f.locator('#title')).toHaveText('Runtimes')
  return f
}

const LANG = { name: 'lang', version: '1.2.0', abi: ['program'], commands: ['lang'], shebangs: ['lang'], handles: [{ ext: ['lng'] }] }

test('with no runtime, the pane explains what one is and offers to add one', async ({ desktop }) => {
  const f = await openRuntimes(desktop)
  await expect(f.locator('#runtimes-empty')).toContainText('No runtime is installed')
  await expect(f.locator('#runtimes-empty')).toContainText('Add a runtime to run Node.js, PHP')
  await expect(f.getByRole('button', { name: 'Add Runtime from a file' })).toBeVisible()
  // the App Store ships with the system, so it is offered
  await expect(f.getByRole('button', { name: 'Get runtimes from the App Store' })).toBeVisible()
  await expect(f.locator('.pane-body')).toContainText('Only add runtimes you trust.')
})

test('an installed runtime is listed with its commands and file types, and can be removed', async ({ desktop }) => {
  const { page } = desktop
  await addRuntime(page, 'org.test.lang', LANG)
  const f = await openRuntimes(desktop)
  const row = f.locator('[data-runtime="org.test.lang"]')
  await expect(row).toContainText('lang 1.2.0')
  await expect(row).toContainText('commands: lang')
  await expect(row).toContainText('.lng')
  await expect(row).toContainText('Default')
  await expect(f.locator('#runtimes-empty')).toHaveCount(0)

  await f.getByRole('button', { name: 'Remove lang 1.2.0' }).click()
  await page.locator('.sheet button', { hasText: /^Remove$/ }).click()
  await expect(f.locator('#runtimes-empty')).toBeVisible()
  expect(await page.evaluate(() => window.tiny!.kernel.runtimeList())).toEqual([])
})

test('with two versions, the user chooses the default', async ({ desktop }) => {
  const { page } = desktop
  await addRuntime(page, 'org.test.lang1', { ...LANG, version: '1.4.0' })
  await addRuntime(page, 'org.test.lang2', { ...LANG, version: '2.1.0' })
  const f = await openRuntimes(desktop)
  const def = () => page.evaluate(() => window.tiny!.kernel.runtimeResolve({ name: 'lang' }).then((r) => r?.version))
  expect(await def()).toBe('2.1.0')
  await expect(f.locator('.pane-body')).not.toContainText('Command conflicts') // versions of one runtime share its commands
  await f.getByLabel('Default version of lang').selectOption({ label: '1.4.0 (lang1)' })
  await expect.poll(def).toBe('1.4.0')
  await expect(f.locator('[data-runtime="org.test.lang1"]')).toContainText('Default')
  await expect(f.locator('[data-runtime="org.test.lang2"]')).not.toContainText('Default')
})

test('a command two different runtimes want is shown as a conflict, with who kept it', async ({ desktop }) => {
  const { page } = desktop
  await addRuntime(page, 'org.test.lang', LANG)
  await addRuntime(page, 'org.test.other', { name: 'other', version: '1.0.0', commands: ['lang'] })
  const f = await openRuntimes(desktop)
  await expect(f.locator('.pane-body')).toContainText('Command conflicts')
  await expect(f.locator('.pane-body')).toContainText('kept by lang')
})

test('the review of a runtime package shows the commands, the trust warning, and installs it', async ({ desktop }) => {
  const { page } = desktop
  await addRuntime(page, 'org.test.other', { name: 'other', version: '1.0.0', commands: ['lang'] }) // already holds "lang"
  const path = await packageTo(page, manifest('org.test.newlang', LANG, { permissions: ['network'] }), 'newlang.pearapp')
  await page.evaluate((p) => window.tiny!.kernel.launchOpen(p), path)
  const f = desktop.win('Install App').frameLocator('iframe')
  await expect(f.locator('h1')).toHaveText('newlang')
  await expect(f.locator('#runtime-card')).toContainText('This is a runtime')
  await expect(f.locator('#runtime-card')).toContainText('lang')
  await expect(f.locator('#runtime-card')).toContainText('#!/usr/bin/env lang')
  await expect(f.locator('#runtime-card')).toContainText('.lng')
  await expect(f.locator('#runtime-card')).toContainText('Can use (advisory)')
  await expect(f.locator('#runtime-card')).toContainText('Connect to the internet')
  await expect(f.locator('#runtime-conflicts')).toContainText('“lang” already belongs to other')
  await expect(f.locator('#runtime-trust')).toHaveText('A runtime runs inside every app that uses it, with that app’s rights. Only add runtimes you trust.')
  await expect(f.locator('.facts').first()).toContainText(/Size\s*\d+ B in \d+ files/)
  await expect(f.locator('.badge.warn')).toHaveText('No verified publisher')
  expect(await page.evaluate(() => window.tiny!.kernel.runtimeList().then((l) => l.map((r) => r.bundleId)))).toEqual(['org.test.other'])

  await f.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(f.locator('h1')).toHaveText('newlang was installed')
  await expect(f.locator('#open')).toHaveCount(0) // a runtime is not an app
  expect(await page.evaluate(() => window.tiny!.kernel.runtimeList().then((l) => l.map((r) => r.bundleId).sort()))).toEqual(['org.test.newlang', 'org.test.other'])
})

test('an app that needs a runtime that is not installed says so in the review and can still be installed', async ({ desktop }) => {
  const { page } = desktop
  const path = await packageTo(page, { id: 'org.test.needy', name: 'Needy', version: '1.0.0', entry: 'main.js', requires: [{ runtime: 'node', range: '^22' }, { framework: 'ghost', range: '1.x' }] }, 'needy.pearapp')
  await page.evaluate((p) => window.tiny!.kernel.launchOpen(p), path)
  const f = desktop.win('Install App').frameLocator('iframe')
  await expect(f.locator('h1')).toHaveText('Needy')
  await expect(f.locator('#unmet')).toContainText('Runtime node ^22')
  await expect(f.locator('#unmet')).toContainText('Framework ghost 1.x')
  await expect(f.locator('#unmet')).toContainText('Install it first, then this app will run')
  await expect(f.locator('#runtime-card')).toHaveCount(0)
  await f.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(f.locator('h1')).toHaveText('Needy was installed')
})

test('an app whose requirements are met shows no warning', async ({ desktop }) => {
  const { page } = desktop
  await addRuntime(page, 'org.test.lang', LANG)
  const path = await packageTo(page, { id: 'org.test.happy', name: 'Happy', version: '1.0.0', entry: 'main.js', requires: [{ runtime: 'lang', range: '^1' }] }, 'happy.pearapp')
  await page.evaluate((p) => window.tiny!.kernel.launchOpen(p), path)
  const f = desktop.win('Install App').frameLocator('iframe')
  await expect(f.locator('h1')).toHaveText('Happy')
  await expect(f.locator('#unmet')).toHaveCount(0)
})
