import { expect, test, type Desktop } from './fixtures'

const win = (d: Desktop) => d.win(/Code/)
const ui = (d: Desktop) => win(d).frameLocator('iframe')
const sheet = (d: Desktop) => win(d).locator('.sheet')
const rows = (d: Desktop) => ui(d).locator('.terminalview .xterm-rows:visible').first().locator('> div')
const row = (d: Desktop, re: RegExp) => rows(d).filter({ hasText: re })

const launch = (d: Desktop): Promise<void> => d.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))

async function newProject(d: Desktop, name: string): Promise<void> {
  await ui(d).locator('#newproj').click()
  await sheet(d).locator('input').fill(name)
  await sheet(d).getByRole('button', { name: 'OK' }).click()
  await d.page.getByRole('menuitem', { name: 'Web App', exact: true }).click()
  await expect(ui(d).locator('#project')).toHaveText(`${name}.app`)
}

test('the integrated terminal opens in the project folder and runs the shell', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await newProject(desktop, 'Demo')

  // Ctrl+` opens the Terminal tab in the panel, with a shell running in the project
  await page.keyboard.press('Control+Backquote')
  await expect(ui(desktop).locator('#panelTabTerminal')).toHaveAttribute('aria-selected', 'true')
  await expect(row(desktop, /Demo\.app %/)).not.toHaveCount(0)
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /manifest\.json/)).not.toHaveCount(0)
  await page.keyboard.type('echo built > out.txt')
  await page.keyboard.press('Enter')
  await page.keyboard.type('cat out.txt')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^built$/)).toHaveCount(1)

  // the terminal fills the panel
  const panel = await ui(desktop).locator('.terminalview').boundingBox()
  const screen = await ui(desktop).locator('.terminalview .xterm-screen').boundingBox()
  expect(screen!.width).toBeGreaterThan(panel!.width * 0.8)

  // the toggle hides the panel again, and the shell keeps running
  await page.keyboard.press('Control+Backquote')
  await expect(ui(desktop).locator('#output')).toBeHidden()
  await page.keyboard.press('Control+Backquote')
  await expect(row(desktop, /^built$/)).toHaveCount(1)
})

test('several terminals: new, split, switch, kill', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await newProject(desktop, 'Many')
  await page.keyboard.press('Control+Backquote')
  await expect(row(desktop, /Many\.app %/)).not.toHaveCount(0)
  const shells = () => page.evaluate(() => window.tiny!.kernel.listProcesses().then((l) => l.filter((p) => p.name === 'sh' && p.state === 'running').length))
  await expect.poll(shells).toBe(1)
  await expect(ui(desktop).locator('#termList')).toBeHidden() // one terminal: nothing to choose from

  await page.keyboard.type('echo one')
  await page.keyboard.press('Enter')
  await ui(desktop).locator('#termNew').click()
  await expect(ui(desktop).locator('#termList option')).toHaveCount(2)
  await expect.poll(shells).toBe(2)
  await expect(row(desktop, /^one$/)).toHaveCount(0)

  await ui(desktop).locator('#termSplit').click()
  await expect(ui(desktop).locator('.terminalview .xterm')).toHaveCount(3)
  await expect.poll(shells).toBe(3)

  await ui(desktop).locator('#termList').selectOption({ index: 0 })
  await expect(row(desktop, /^one$/)).toHaveCount(1)

  await ui(desktop).locator('#termKill').click()
  await expect(ui(desktop).locator('#termList')).toBeHidden()
  await expect.poll(shells).toBe(2)
  await ui(desktop).locator('#termKill').click()
  await expect.poll(shells).toBe(0)
  await expect(ui(desktop).locator('#output')).toBeHidden() // the last terminal closed
})

test('the terminal follows Code: typing "exit" closes it, Cmd+K clears, and closing the window ends the shell', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(ui(desktop).locator('#project')).toHaveText('No Project')
  await ui(desktop).locator('#welcome').click() // the window has the keyboard
  await page.keyboard.press('Control+Backquote')
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await page.keyboard.type('echo something')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^something$/)).toHaveCount(1)
  await page.keyboard.press('Meta+k')
  await expect(row(desktop, /^something$/)).toHaveCount(0)
  const shells = () => page.evaluate(() => window.tiny!.kernel.listProcesses().then((l) => l.filter((p) => p.name === 'sh' && p.state === 'running').length))
  expect(await shells()).toBe(1)
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(ui(desktop).locator('#output')).toBeHidden()
  await expect.poll(shells).toBe(0)

  await page.keyboard.press('Control+Backquote')
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await expect.poll(shells).toBe(1)
  await win(desktop).locator('.light.close').click()
  await expect.poll(shells).toBe(0)
})
