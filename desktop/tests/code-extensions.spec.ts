/** VS Code web extensions in Code (`contracts/code-extensions.md`): sideload, review, contributions, Workspace Trust, the host. */
import { expect, test, type Desktop } from './fixtures'

const win = (d: Desktop) => d.win(/Code/)
const ui = (d: Desktop) => win(d).frameLocator('iframe')
const sheet = (d: Desktop) => win(d).locator('.sheet')
const HOME = '/Users/pear'

import { zip } from './zip'

const HELLO = zip({
  'extension/package.json': JSON.stringify({
    publisher: 'acme',
    name: 'hello',
    version: '1.0.0',
    displayName: 'Hello',
    description: 'Says hello',
    engines: { vscode: '^1.90.0' },
    browser: './extension.web.js',
    activationEvents: ['onStartupFinished'],
    contributes: { commands: [{ command: 'hello.say', title: 'Hello: Say' }], themes: [{ label: 'Hello Dark', uiTheme: 'vs-dark', path: './theme.json' }] },
  }),
  'extension/extension.web.js': `const vscode = require('vscode')
exports.activate = (ctx) => { ctx.subscriptions.push(vscode.commands.registerCommand('hello.say', () => vscode.window.showInformationMessage('hello from the extension'))) }`,
  'extension/theme.json': '{ // jsonc\n "type": "dark", "colors": { "editor.background": "#101010", }, "tokenColors": [] }',
})

const NODE_ONLY = zip({
  'extension/package.json': JSON.stringify({ publisher: 'acme', name: 'nodey', version: '1.0.0', main: './x.js' }),
  'extension/x.js': 'module.exports = {}',
})

async function open(d: Desktop, name: string, bytes: number[]): Promise<void> {
  const path = `${HOME}/Downloads/${name}`
  await d.page.evaluate(async ([b, p]) => void (await window.tiny!.kernel.writeFile(p as string, new Uint8Array(b as number[]))), [bytes, path] as const)
  await d.page.evaluate((p) => window.tiny!.kernel.launchOpen(p), path)
}

test('a .vsix is reviewed before install, then listed, themed, and kept in the VFS', async ({ desktop }) => {
  await open(desktop, 'hello.vsix', HELLO)
  await expect(sheet(desktop)).toContainText('Hello 1.0.0')
  await expect(sheet(desktop)).toContainText('unsigned')
  await expect(sheet(desktop)).toContainText('1 themes')
  // reviewing installs nothing
  expect(await desktop.page.evaluate((h) => window.tiny!.kernel.exists(`${h}/Library/Application Support/Code/extensions/extensions.json`), HOME)).toBe(false)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()

  await ui(desktop).locator('#tabExt').click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Hello' })).toBeVisible()
  expect(await desktop.page.evaluate((h) => window.tiny!.kernel.exists(`${h}/Library/Application Support/Code/extensions/acme.hello-1.0.0/package.json`), HOME)).toBe(true)

  // disabling and uninstalling work, and the files go
  await ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Hello' }).getByRole('button', { name: 'Uninstall' }).click()
  await sheet(desktop).getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard')).toHaveCount(0)
  expect(await desktop.page.evaluate((h) => window.tiny!.kernel.exists(`${h}/Library/Application Support/Code/extensions/acme.hello-1.0.0`), HOME)).toBe(false)
})

test('a Node-only extension is refused and nothing is written', async ({ desktop }) => {
  await open(desktop, 'nodey.vsix', NODE_ONLY)
  await expect(sheet(desktop)).toContainText('needs Node.js')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  expect(await desktop.page.evaluate((h) => window.tiny!.kernel.exists(`${h}/Library/Application Support/Code/extensions/acme.nodey-1.0.0`), HOME)).toBe(false)
})

test('extension code is paused in Restricted Mode and runs once the workspace is trusted', async ({ desktop }) => {
  await open(desktop, 'hello.vsix', HELLO)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()
  await ui(desktop).locator('#newproj').click()
  await sheet(desktop).locator('input').fill('Trusty')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  await desktop.page.getByRole('menuitem', { name: 'Web App', exact: true }).click()
  await expect(ui(desktop).locator('#project')).toHaveText('Trusty.app')

  // the trust question comes first; extension code has not run
  await expect(sheet(desktop)).toContainText('Do you trust the authors')
  await sheet(desktop).getByRole('button', { name: 'Restricted Mode' }).click()
  await ui(desktop).locator('#tabExt').click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Hello' })).toContainText('Restricted Mode')

  // trusting starts it; its command reaches the host and its message lands in the output
  await desktop.page.locator('.menubar .title', { hasText: 'Extensions' }).click()
  await desktop.page.locator('.menu button', { hasText: 'Trust This Workspace' }).click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Hello' })).not.toContainText('Restricted Mode')
  await desktop.page.locator('.menubar .title', { hasText: 'Extensions' }).click()
  await desktop.page.locator('.menu button', { hasText: 'Run Extension Command' }).click()
  await desktop.page.getByRole('menuitem', { name: 'Hello: Say' }).click()
  await expect(ui(desktop).locator('#outlog')).toContainText('hello from the extension')
})

test('the Extensions view searches the marketplace as you type, like VS Code, and installs from the results', async ({ desktop }) => {
  const { page } = desktop
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  const queries: string[] = []
  const entry = (name: string) => ({ namespace: 'acme', name, version: '1.0.0', displayName: name === 'hello' ? 'Hello' : 'Other', description: `The ${name} extension`, downloadCount: 1234, verified: true, files: { download: name === 'hello' ? 'https://open-vsx.org/files/hello.vsix' : 'https://open-vsx.org/other/other.vsix' } })
  await page.route('https://open-vsx.org/**', (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (url.pathname === '/api/-/search') {
      const q = url.searchParams.get('query') ?? ''
      queries.push(`${q}|${url.searchParams.get('sortBy')}`)
      const all = [entry('hello'), entry('other')].filter((e) => !q || e.name.includes(q))
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ extensions: all }) })
    }
    if (url.pathname === '/api/acme/hello') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ ...entry('hello'), repository: 'https://github.com/acme/hello', license: 'MIT', categories: ['Themes'], files: { download: 'https://open-vsx.org/files/hello.vsix', readme: 'https://open-vsx.org/files/README.md' } }) })
    if (url.pathname === '/files/package.json') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ browser: './extension.web.js' }) })
    if (url.pathname === '/other/package.json') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ main: './extension.js' }) })
    if (url.pathname === '/files/README.md') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/markdown' }, body: '# Hello Extension\n\nSays **hello** from the README.' })
    if (url.pathname === '/files/hello.vsix') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: Buffer.from(HELLO) })
    return route.fulfill({ status: 404, headers: CORS, body: 'no' })
  })
  await page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))
  await ui(desktop).locator('#tabExt').click()

  // popular extensions are listed before anything is typed
  await expect(ui(desktop).locator('#vsxResults .extcard')).toHaveCount(2)
  expect(queries[0]).toBe('|downloadCount')

  // an extension that needs Node.js can't run here: its Install is greyed out and disabled; the other one is installable
  const other = ui(desktop).locator('#vsxResults .extcard', { hasText: 'Other' })
  await expect(other.getByRole('button', { name: 'Install' })).toBeDisabled()
  await expect(other.getByRole('button', { name: 'Install' })).toHaveClass(/unavailable/)
  await expect(other.getByRole('button', { name: 'Install' })).toHaveAttribute('title', /Node\.js/)
  await expect(ui(desktop).locator('#vsxResults .extcard', { hasText: 'Hello' }).getByRole('button', { name: 'Install' })).toBeEnabled()

  // typing searches (no Enter needed)
  await ui(desktop).locator('#extSearch').fill('hello')
  await expect(ui(desktop).locator('#vsxResults .extcard')).toHaveCount(1)
  await expect(ui(desktop).locator('#vsxResults .extcard')).toContainText('1,234 downloads')

  // install from the result: reviewed, installed, and the result says so
  await ui(desktop).locator('#vsxResults .extcard').getByRole('button', { name: 'Install' }).click()
  await expect(sheet(desktop)).toContainText('verified publisher')
  // while it is being reviewed and installed the button says so
  await expect(ui(desktop).locator('#vsxResults .extcard').getByRole('button')).toHaveText('Installing…')
  await expect(ui(desktop).locator('#vsxResults .extcard').getByRole('button')).toBeDisabled()
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()
  await expect(ui(desktop).locator('#vsxResults .extcard')).toContainText('Installed')
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Hello' })).toBeVisible()

  // clicking a result opens its details in the editor area, as a tab, before it is installed
  await ui(desktop).locator('#extSearch').fill('')
  await ui(desktop).locator('#vsxResults .extcard', { hasText: 'Other' }).click()
  await expect(ui(desktop).locator('.tab[aria-selected="true"]')).toContainText('Extension: Other')
  await expect(ui(desktop).locator('#extDetail .vsxinfo h1')).toHaveText('Other')
  await expect(ui(desktop).locator('#extDetail').getByRole('button', { name: 'Install' })).toBeDisabled()
  await expect(ui(desktop).locator('#extDetail .vsxinfo')).toContainText('needs Node.js')

  // the installed one: README from its own files, features, and actions
  await ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Hello' }).click()
  await expect(ui(desktop).locator('.tab[aria-selected="true"]')).toContainText('Extension: Hello')
  await expect(ui(desktop).locator('#extDetail .vsxinfo h1')).toHaveText('Hello')
  // the package has no README of its own, so the marketplace's is shown
  await expect(ui(desktop).locator('#extDetail .vsxmain')).toContainText('Says hello from the README')
  await ui(desktop).locator('#extDetail .vsxtabs').getByRole('button', { name: 'Features' }).click()
  await expect(ui(desktop).locator('#extDetail .vsxmain')).toContainText('hello.say')
  await expect(ui(desktop).locator('#extDetail').getByRole('button', { name: 'Uninstall' })).toBeVisible()
  await ui(desktop).locator('#extDetail').getByRole('button', { name: 'Disable' }).click()
  await expect(ui(desktop).locator('#extDetail').getByRole('button', { name: 'Enable' })).toBeVisible()

  // closing the tab returns to the welcome screen
  await ui(desktop).locator('.tab[aria-selected="true"] .close').click()
  await ui(desktop).locator('.tab[aria-selected="true"] .close').click()
  await expect(ui(desktop).locator('#extDetail')).toBeHidden()
})

const SECOND = zip({
  'extension/package.json': JSON.stringify({ publisher: 'acme', name: 'second', version: '2.0.0', displayName: 'Second', contributes: { themes: [{ label: 'Second Dark', uiTheme: 'vs-dark', path: './t.json' }] } }),
  'extension/t.json': '{"type":"dark","colors":{},"tokenColors":[]}',
})

test('installing another extension adds to the list instead of replacing it', async ({ desktop }) => {
  await open(desktop, 'hello.vsix', HELLO)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()
  await ui(desktop).locator('#tabExt').click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard')).toHaveCount(1)

  await open(desktop, 'second.vsix', SECOND)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard')).toHaveCount(2)
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Hello' })).toBeVisible()
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Second' })).toBeVisible()
  // searching the marketplace does not hide what is installed
  await ui(desktop).locator('#extSearch').fill('zzz-nothing-matches')
  await expect(ui(desktop).locator('#vsxInstalled .extcard')).toHaveCount(2)
  const ids = await desktop.page.evaluate(async (h) => JSON.parse(new TextDecoder().decode(await window.tiny!.kernel.readFile(`${h}/Library/Application Support/Code/extensions/extensions.json`))).map((e: { id: string }) => e.id), HOME)
  expect(ids.sort()).toEqual(['acme.hello', 'acme.second'])
})

const TREE = zip({
  'extension/package.json': JSON.stringify({
    publisher: 'acme',
    name: 'treedemo',
    version: '1.0.0',
    displayName: 'Tree Demo',
    browser: './ext.js',
    activationEvents: ['onStartupFinished'],
    capabilities: { untrustedWorkspaces: { supported: true } },
    contributes: {
      viewsContainers: { activitybar: [{ id: 'demo', title: 'Tree Demo' }] },
      views: { demo: [{ id: 'treeDemo.list', name: 'Items' }, { id: 'treeDemo.empty', name: 'Nothing Yet' }], explorer: [{ id: 'treeDemo.inExplorer', name: 'Demo Files' }] },
      viewsWelcome: [{ view: 'treeDemo.empty', contents: 'No items here.\n[Add one](command:treeDemo.add)' }],
      commands: [{ command: 'treeDemo.pick', title: 'Tree: Pick' }, { command: 'treeDemo.add', title: 'Tree: Add' }],
    },
  }),
  'extension/ext.js': `const vscode = require('vscode')
exports.activate = (ctx) => {
  const items = [{ label: 'Alpha', kids: ['A1', 'A2'] }, { label: 'Beta' }]
  const provider = {
    getChildren: (el) => (el ? el.kids.map((k) => ({ label: k })) : items),
    getTreeItem: (el) => { const t = new vscode.TreeItem(el.label, el.kids ? vscode.TreeItemCollapsibleState.Collapsed : 0); if (!el.kids) t.command = { command: 'treeDemo.pick', title: 'pick', arguments: [el.label] }; return t },
  }
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('treeDemo.list', provider))
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('treeDemo.empty', { getChildren: () => [], getTreeItem: (e) => new vscode.TreeItem(e.label) }))
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('treeDemo.inExplorer', { getChildren: (el) => (el ? [] : [{ label: 'in the explorer' }]), getTreeItem: (e) => new vscode.TreeItem(e.label) }))
  ctx.subscriptions.push(vscode.commands.registerCommand('treeDemo.pick', (l) => vscode.window.showInformationMessage('picked ' + l)))
  ctx.subscriptions.push(vscode.commands.registerCommand('treeDemo.add', () => vscode.window.showInformationMessage('added')))
}`,
})

test('an installed extension adds its activity bar icon, side bar views and commands', async ({ desktop }) => {
  await open(desktop, 'tree.vsix', TREE)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()

  // its icon appears in the activity bar, and opens its views
  const button = ui(desktop).locator('.activitybar button[title="Tree Demo"]')
  await expect(button).toBeVisible()
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  const view = ui(desktop).locator('[data-vsx-container]:not(button)')
  await expect(view.locator('.viewtitle')).toHaveText('Tree Demo')
  await expect(view.locator('.vrow', { hasText: 'Alpha' })).toBeVisible()
  await expect(view.locator('.vrow', { hasText: 'Beta' })).toBeVisible()

  // folders expand lazily; choosing a leaf runs its command in the extension
  await view.locator('.vrow', { hasText: 'Alpha' }).click()
  await expect(view.locator('.vrow', { hasText: 'A1' })).toBeVisible()
  await view.locator('.vrow', { hasText: 'A1' }).click()
  await expect(ui(desktop).locator('#outlog')).toContainText('picked A1')

  // a view's arrow folds it and unfolds it again
  const items = view.locator('.vsection', { has: ui(desktop).locator('.sectitle', { hasText: /^Items$/ }) })
  await items.locator('.vhead .chev').click()
  await expect(items.locator('.vtree')).toBeHidden()
  await items.locator('.vhead .chev').click()
  await expect(items.locator('.vtree')).toBeVisible()
  await expect(view.locator('.vrow', { hasText: 'A1' })).toBeVisible()

  // an empty view shows its welcome content, and a button runs a command
  await expect(view.locator('.vsection', { hasText: 'Nothing Yet' })).toContainText('No items here.')
  await view.getByRole('button', { name: 'Add one' }).click()
  await expect(ui(desktop).locator('#outlog')).toContainText('added')

  // Explorer views and the Extensions view's command list
  await ui(desktop).locator('#tabFiles').click()
  await expect(ui(desktop).locator('#vsxExplorer')).toContainText('in the explorer')
  await ui(desktop).locator('#tabExt').click()
  await expect(ui(desktop).locator('#vsxCommands')).toContainText('Tree: Pick')

  // disabling the extension takes its icon away again
  await ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Tree Demo' }).locator('input[type=checkbox]').click()
  await expect(button).toHaveCount(0)
})

test('trusting the workspace starts extensions that were paused, and their views and cards update', async ({ desktop }) => {
  // an extension that does NOT declare support for untrusted workspaces
  const needsTrust = zip({
    'extension/package.json': JSON.stringify({ publisher: 'acme', name: 'needs', version: '1.0.0', displayName: 'Needs Trust', browser: './e.js', activationEvents: ['onStartupFinished'], contributes: { viewsContainers: { activitybar: [{ id: 'n', title: 'Needs Trust View' }] }, views: { n: [{ id: 'needs.list', name: 'Things' }] } } }),
    'extension/e.js': `const vscode = require('vscode'); exports.activate = () => { vscode.window.registerTreeDataProvider('needs.list', { getChildren: (el) => (el ? [] : [{ label: 'Thing One' }]), getTreeItem: (e) => new vscode.TreeItem(e.label) }) }`,
  })
  await open(desktop, 'needs.vsix', needsTrust)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()
  await ui(desktop).locator('#newproj').click()
  await sheet(desktop).locator('input').fill('Trusting')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  await desktop.page.getByRole('menuitem', { name: 'Web App', exact: true }).click()
  await expect(sheet(desktop)).toContainText('Do you trust the authors')
  await sheet(desktop).getByRole('button', { name: 'Restricted Mode' }).click()

  const button = ui(desktop).locator('.activitybar button[title="Needs Trust View"]')
  await button.click()
  const view = ui(desktop).locator('[data-vsx-container]:not(button)')
  await expect(view).toContainText('Restricted Mode')

  // trust it from the menu: the view fills in and the card loses its warning
  await desktop.page.locator('.menubar .title', { hasText: 'Extensions' }).click()
  await desktop.page.locator('.menu button', { hasText: 'Trust This Workspace' }).click()
  await expect(view).toContainText('Thing One')
  await expect(view).not.toContainText('Restricted Mode')
  await ui(desktop).locator('#tabExt').click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Needs Trust' })).not.toContainText('Restricted Mode')
})

test('a trusted workspace stays trusted after a reload, and its extensions start', async ({ desktop }) => {
  const e = zip({
    'extension/package.json': JSON.stringify({ publisher: 'acme', name: 'again', version: '1.0.0', displayName: 'Again', browser: './e.js', activationEvents: ['onStartupFinished'], contributes: { viewsContainers: { activitybar: [{ id: 'a', title: 'Again View' }] }, views: { a: [{ id: 'again.list', name: 'Things' }] } } }),
    'extension/e.js': `const vscode = require('vscode'); exports.activate = () => { vscode.window.registerTreeDataProvider('again.list', { getChildren: (el) => (el ? [] : [{ label: 'Thing Two' }]), getTreeItem: (x) => new vscode.TreeItem(x.label) }) }`,
  })
  await open(desktop, 'again.vsix', e)
  await sheet(desktop).getByRole('button', { name: 'Install', exact: true }).click()
  await ui(desktop).locator('#newproj').click()
  await sheet(desktop).locator('input').fill('Again')
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  await desktop.page.getByRole('menuitem', { name: 'Web App', exact: true }).click()
  await expect(sheet(desktop)).toContainText('Do you trust the authors')
  await sheet(desktop).getByRole('button', { name: 'Trust Workspace' }).click()
  await ui(desktop).locator('.activitybar button[title="Again View"]').click()
  await expect(ui(desktop).locator('[data-vsx-container]:not(button)')).toContainText('Thing Two')
  // the Extensions menu knows: trusting is no longer offered (it used to stay clickable and silently undo the trust)
  await desktop.page.locator('.menubar .title', { hasText: 'Extensions' }).click()
  await expect(desktop.page.locator('.menu button', { hasText: 'Trust This Workspace' })).toBeDisabled()
  await expect(desktop.page.locator('.menu button', { hasText: 'Use Restricted Mode' })).toBeEnabled()
  await desktop.page.keyboard.press('Escape')

  await desktop.reload()
  await desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))
  await expect(ui(desktop).locator('#project')).toHaveText('Again.app')
  await ui(desktop).locator('.activitybar button[title="Again View"]').click()
  await expect(ui(desktop).locator('[data-vsx-container]:not(button)')).toContainText('Thing Two')
  await expect(ui(desktop).locator('[data-vsx-container]:not(button)')).not.toContainText('Restricted Mode')
  await ui(desktop).locator('#tabExt').click()
  await expect(ui(desktop).locator('#vsxInstalled .extcard', { hasText: 'Again' })).not.toContainText('Restricted Mode')
})

test('the sections of the Extensions view fold with their arrows', async ({ desktop }) => {
  await desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))
  await ui(desktop).locator('#tabExt').click()
  for (const [title, list] of [['Installed', '#vsxInstalled'], ['Commands', '#vsxCommands']] as const) {
    const head = ui(desktop).locator('#extView .sechead.static', { hasText: title })
    await expect(ui(desktop).locator(list)).toBeVisible()
    await head.locator('.chev').click()
    await expect(ui(desktop).locator(list)).toBeHidden()
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await head.locator('.chev').click()
    await expect(ui(desktop).locator(list)).toBeVisible()
  }
  // the marketplace section too (its list may be loading or offline, but it folds either way)
  const market = ui(desktop).locator('#vsxResultsHead')
  await market.locator('.chev').click()
  await expect(ui(desktop).locator('#vsxResults')).toBeHidden()
  await market.locator('.chev').click()
  await expect(ui(desktop).locator('#vsxResults')).toBeVisible()
})
