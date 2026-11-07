/** Sharing a Code project as an app: check, package and install, and an install link. */
import { expect, test, type Desktop } from './fixtures'

const win = (d: Desktop) => d.win(/Code/)
const ui = (d: Desktop) => win(d).frameLocator('iframe')
const sheet = (d: Desktop) => win(d).locator('.sheet')

async function newProject(d: Desktop, name: string): Promise<void> {
  await d.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))
  await ui(d).locator('#newproj').click()
  await ui(d).getByRole('radio', { name: new RegExp('Web App') }).click()
  await ui(d).locator('.modal').getByRole('button', { name: 'Next' }).click()
  await ui(d).locator('.modal-input').fill(name)
  await ui(d).locator('.modal').getByRole('button', { name: 'Create' }).click()
  await expect(ui(d).locator('#project')).toHaveText(`${name}`)
}

const share = async (d: Desktop, item: string) => {
  await d.page.locator('.menubar .title', { hasText: 'Share' }).click()
  await d.page.locator('.menu button', { hasText: item }).click()
}

test('Share ▸ Check Project lists what is in order; Package & Install ends in the App Installer', async ({ desktop }) => {
  const { page } = desktop
  await newProject(desktop, 'Demo')

  await share(desktop, 'Check Project')
  await expect(sheet(desktop)).toContainText('Demo')
  await expect(sheet(desktop)).toContainText('✓ manifest.json is present')
  await expect(sheet(desktop)).toContainText('✓ Entry main.js is present')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()

  await share(desktop, 'Package & Install')
  // warnings (if any) are shown first and the person decides
  const proceed = sheet(desktop).getByRole('button', { name: 'Package', exact: true })
  if (await proceed.isVisible().catch(() => false)) await proceed.click()
  const installer = desktop.win('Install App').frameLocator('iframe')
  await expect(installer.locator('h1')).toHaveText('Demo')
  await expect(installer.locator('.facts')).toContainText('.pearapp')
  const id = await page.evaluate(async () => {
    const list = await window.tiny!.kernel.bundleList()
    return list.find((b) => b.name === 'Demo')?.id ?? null
  })
  expect(id).toBeNull() // reviewing installs nothing
  await installer.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(installer.locator('h1')).toHaveText('Demo was installed')
  expect(await page.evaluate(async () => (await window.tiny!.kernel.bundleList()).some((b) => b.name === 'Demo'))).toBe(true)

  // and it is a working app: it opens in its own window and shows what the project showed
  await installer.getByRole('button', { name: 'Open' }).click()
  const app = page.locator('.window', { has: page.locator('.name', { hasText: /^Demo$/ }) })
  await expect(app.frameLocator('iframe').locator('h1')).toHaveText('Hello, Pear')
})

test('Share ▸ Copy Install Link asks where the package is hosted and puts a link on the clipboard', async ({ desktop }) => {
  const { page } = desktop
  await newProject(desktop, 'Linked')
  await share(desktop, 'Copy Install Link')
  const proceed = sheet(desktop).getByRole('button', { name: 'Continue', exact: true })
  if (await proceed.isVisible().catch(() => false)) await proceed.click()

  // not an https address: refused with the reason, nothing copied
  await sheet(desktop).locator('input').fill('http://example.com/linked.pearapp')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  await expect(sheet(desktop)).toContainText('https')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()

  await share(desktop, 'Copy Install Link')
  if (await proceed.isVisible().catch(() => false)) await proceed.click()
  await sheet(desktop).locator('input').fill('https://apps.acme.test/linked.pearapp')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  await expect(sheet(desktop)).toContainText('The install link was copied')
  const expected = `?install=${encodeURIComponent('https://apps.acme.test/linked.pearapp')}`
  await expect(sheet(desktop)).toContainText(expected)
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  const copied = await page.evaluate(async () => {
    const k = window.tiny!.kernel
    const port = await k.lookup('tiny.clipboard')
    const r = (await k.request(port, { op: 'read', types: ['text/plain'] }, { timeout: 4000 })).data as { result: { items: Array<{ data: string }> } }
    return r.result.items[0]?.data ?? ''
  })
  expect(copied).toContain(expected)
})

test('a project that cannot be packaged says why and nothing is written', async ({ desktop }) => {
  const { page } = desktop
  await newProject(desktop, 'Broken')
  const root = await page.evaluate(async () => (await window.tiny!.kernel.bundleList()).length) // keep the page busy until the project exists
  expect(root).toBeGreaterThan(0)
  const project = await page.evaluate(async () => {
    const k = window.tiny!.kernel
    const find = async (dir: string): Promise<string | null> => {
      for (const e of await k.readdir(dir).catch(() => [])) {
        if (e.name === 'Broken') return `${dir}/${e.name}`
        if (e.name === 'Library' || e.name.startsWith('.')) continue
        const hit = await find(`${dir}/${e.name}`).catch(() => null)
        if (hit) return hit
      }
      return null
    }
    return find('/Users/pear')
  })
  expect(project).toBeTruthy()
  await page.evaluate(async (p) => void (await window.tiny!.kernel.writeFile(`${p}/manifest.json`, new TextEncoder().encode('{"id":"nope"}'))), project)
  await share(desktop, 'Package & Install')
  await expect(sheet(desktop)).toContainText('can’t be packaged')
  await expect(sheet(desktop)).toContainText('✗')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  expect(await page.evaluate(async () => (await window.tiny!.kernel.readdir('/Users/pear/Downloads')).map((e) => e.name))).not.toContain('Broken-1.0.0.pearapp')
  await expect(desktop.win('Install App')).toHaveCount(0)
})
