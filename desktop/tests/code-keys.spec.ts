/** VS Code keybindings in Code: the palette, quick open, chords, tabs, side bar, user and extension bindings. */
import { expect, test, type Desktop } from './fixtures'
import { zip } from './zip'

const win = (d: Desktop) => d.win(/Code/)
const ui = (d: Desktop) => win(d).frameLocator('iframe')
const sheet = (d: Desktop) => win(d).locator('.sheet')
const HOME = '/Users/pear'
const palette = (d: Desktop) => ui(d).locator('.palette')
const key = (d: Desktop, combo: string) => d.page.keyboard.press(combo.replace('Mod', 'ControlOrMeta'))

async function project(d: Desktop, name: string): Promise<void> {
  await d.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))
  await ui(d).locator('#newproj').click()
  await ui(d).getByRole('radio', { name: new RegExp('Web App') }).click()
  await ui(d).locator('.modal').getByRole('button', { name: 'Next' }).click()
  await ui(d).locator('.modal-input').fill(name)
  await ui(d).locator('.modal').getByRole('button', { name: 'Create' }).click()
  await expect(ui(d).locator('#project')).toHaveText(`${name}`)
  await ui(d).locator('#tabFiles').click() // focus the Code window: keys go to the focused frame
}

test('Cmd/Ctrl+Shift+P opens the command palette, filters, runs, and closes with Escape', async ({ desktop }) => {
  await project(desktop, 'Keys')
  await ui(desktop).locator('#tree .row', { hasText: 'main.js' }).click()
  await ui(desktop).locator('.monaco-host .view-lines').click()
  await key(desktop, 'Mod+Shift+P') // pressed with the editor focused: Monaco's own palette must not appear
  await expect(palette(desktop)).toBeVisible()
  await expect(ui(desktop).locator('.quick-input-widget:visible')).toHaveCount(0)
  await palette(desktop).locator('input').fill('word wrap')
  await expect(palette(desktop).locator('.palette-row').first()).toContainText('Toggle Word Wrap')
  await expect(palette(desktop).locator('.palette-row').first().locator('kbd')).toBeVisible() // its key shows
  await key(desktop, 'Escape')
  await expect(palette(desktop)).toHaveCount(0)

  await key(desktop, 'F1')
  await palette(desktop).locator('input').fill('toggle panel')
  await key(desktop, 'Enter')
  await expect(ui(desktop).locator('#output')).toBeVisible()
})

test('Cmd/Ctrl+P quick-opens a file by fuzzy name; ">" switches to commands and ":" goes to a line', async ({ desktop }) => {
  await project(desktop, 'Quick')
  await key(desktop, 'Mod+P')
  await expect(palette(desktop)).toBeVisible()
  await palette(desktop).locator('input').fill('mnjs')
  await expect(palette(desktop).locator('.palette-row').first()).toContainText('main.js')
  await key(desktop, 'Enter')
  await expect(ui(desktop).locator('.tab[aria-selected="true"]')).toContainText('main.js')

  await key(desktop, 'Mod+P')
  await palette(desktop).locator('input').fill('>word wrap')
  await expect(palette(desktop).locator('.palette-row').first()).toContainText('Word Wrap')
  await palette(desktop).locator('input').fill(':1')
  await expect(palette(desktop).locator('.palette-row').first()).toContainText('Go to line 1')
  await key(desktop, 'Escape')
})

test('side bar, panel, tabs and chords: Cmd/Ctrl+B, J, Cmd+Alt+arrows, Cmd+W, Cmd+K Cmd+S', async ({ desktop }) => {
  await project(desktop, 'Bindings')
  await ui(desktop).locator('#tree .row', { hasText: 'main.js' }).click()
  await ui(desktop).locator('#tree .row', { hasText: 'index.html' }).click()
  const side = ui(desktop).locator('#side')
  await key(desktop, 'Mod+B')
  await expect(side).toBeHidden()
  await key(desktop, 'Mod+B')
  await expect(side).toBeVisible()

  await key(desktop, 'Mod+J')
  const out = ui(desktop).locator('#output')
  const wasHidden = await out.isHidden()
  await key(desktop, 'Mod+J')
  expect(await out.isHidden()).toBe(!wasHidden)

  // tabs: previous / next, and close the active one without closing the window
  await expect(ui(desktop).locator('.tab[aria-selected="true"]')).toContainText('index.html')
  await key(desktop, 'ControlOrMeta+Alt+ArrowLeft')
  await expect(ui(desktop).locator('.tab[aria-selected="true"]')).toContainText('main.js')
  await key(desktop, 'ControlOrMeta+Alt+ArrowRight')
  await expect(ui(desktop).locator('.tab[aria-selected="true"]')).toContainText('index.html')
  await key(desktop, 'Mod+W')
  await expect(ui(desktop).locator('.tab')).toHaveCount(1)
  await expect(win(desktop)).toBeVisible()

  // a chord, with the editor focused (Monaco starts its own chords with Cmd+K)
  await ui(desktop).locator('.monaco-host .view-lines').click()
  await key(desktop, 'Mod+K')
  await key(desktop, 'Mod+S')
  await expect(palette(desktop)).toBeVisible()
  await palette(desktop).locator('input').fill('show all commands')
  await expect(palette(desktop).locator('.palette-row').first()).toContainText('Show All Commands')
  await expect(palette(desktop).locator('.palette-row').first().locator('kbd')).toBeVisible()
})

test('user keybindings.json overrides and removes defaults; extensions contribute keys', async ({ desktop }) => {
  await project(desktop, 'Mine')
  await desktop.page.evaluate(async (h) => {
    const k = window.tiny!.kernel
    await k.mkdir(`${h}/Library/Application Support/Code/User`, { recursive: true })
    const text = `// mine\n[{ "key": "ctrl+alt+h", "command": "workbench.action.togglePanel" }, { "key": "ctrlcmd+b", "command": "-workbench.action.toggleSidebarVisibility" },]`
    await k.writeFile(`${h}/Library/Application Support/Code/User/keybindings.json`, new TextEncoder().encode(text))
  }, HOME)
  await key(desktop, 'F1')
  await palette(desktop).locator('input').fill('reload keyboard')
  await key(desktop, 'Enter')

  const out = ui(desktop).locator('#output')
  const before = await out.isHidden()
  await key(desktop, 'Control+Alt+H')
  expect(await out.isHidden()).toBe(!before)
  // the removed default no longer does anything
  await key(desktop, 'Mod+B')
  await expect(ui(desktop).locator('#side')).toBeVisible()
})

test('an extension can contribute keybindings that run its commands', async ({ desktop }) => {
  const vsix = zip({
    'extension/package.json': JSON.stringify({
      publisher: 'acme', name: 'keyed', version: '1.0.0', browser: './e.js', activationEvents: ['onStartupFinished'],
      capabilities: { untrustedWorkspaces: { supported: true } },
      contributes: { commands: [{ command: 'keyed.hi', title: 'Keyed: Hi' }], keybindings: [{ command: 'keyed.hi', key: 'ctrl+alt+j', mac: 'ctrl+alt+j' }] },
    }),
    'extension/e.js': `const vscode = require('vscode'); exports.activate = (c) => { c.subscriptions.push(vscode.commands.registerCommand('keyed.hi', () => vscode.window.showInformationMessage('hi from a key'))) }`,
  })
  await desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))
  await desktop.page.evaluate(async ([b, p]) => void (await window.tiny!.kernel.writeFile(p as string, new Uint8Array(b as number[]))), [vsix, `${HOME}/Downloads/keyed.vsix`] as const)
  await desktop.page.evaluate((p) => window.tiny!.kernel.launchOpen(p), `${HOME}/Downloads/keyed.vsix`)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard')).toHaveCount(1)
  await ui(desktop).locator('#tabExt').click() // focus the Code window
  await key(desktop, 'Control+Alt+J')
  await expect(ui(desktop).locator('#outlog')).toContainText('hi from a key')
  // and it is in the shortcuts list
  await key(desktop, 'F1')
  await palette(desktop).locator('input').fill('')
  await key(desktop, 'Escape')
  await key(desktop, 'Mod+K')
  await key(desktop, 'Mod+S')
  await palette(desktop).locator('input').fill('keyed.hi')
  await expect(palette(desktop).locator('.palette-row').first()).toContainText('Keyed: Hi')
})
