import { expect, test, type Desktop } from './fixtures'

const win = (desktop: Desktop) => desktop.win(/Code/)
const ui = (desktop: Desktop) => win(desktop).frameLocator('iframe')
const preview = (desktop: Desktop) => ui(desktop).frameLocator('#prevFrame')
const sheet = (desktop: Desktop) => win(desktop).locator('.sheet')

const launch = (desktop: Desktop): Promise<void> =>
  desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.code'))

/** Create a project with the given name through Code's own UI, picking a template from the menu. */
async function newProject(desktop: Desktop, name: string, template: string): Promise<void> {
  await ui(desktop).locator('#newproj').click()
  await sheet(desktop).locator('input').fill(name)
  await sheet(desktop).getByRole('button', { name: 'OK' }).click()
  await desktop.page.getByRole('menuitem', { name: template, exact: true }).click()
  await expect(ui(desktop).locator('#project')).toHaveText(`${name}.app`)
}

test('a new project: scaffold, edit, save, and preview', async ({ desktop }) => {
  await launch(desktop)
  await expect(ui(desktop).locator('#project')).toHaveText('No Project')

  await newProject(desktop, 'Demo', 'Web App')
  await expect(ui(desktop).locator('#tree .row', { hasText: 'main.js' })).toBeVisible()

  // preview runs the project
  await ui(desktop).getByRole('button', { name: /Preview/ }).click()
  await expect(preview(desktop).locator('h1')).toHaveText('Hello, Pear')

  // Monaco: type into main.js and save; the change lands in the VFS
  await ui(desktop).locator('.tab', { hasText: 'main.js' }).click()
  await ui(desktop).locator('.monaco-host .view-lines').click()
  await desktop.page.keyboard.press('Meta+ArrowDown') // to end of file
  await desktop.page.keyboard.type('\nconsole.log("typed in Code")')
  await desktop.page.keyboard.press('Meta+s')
  await expect
    .poll(
      async () =>
        desktop.page.evaluate(() =>
          window.tiny!.kernel
            .readFile('/Users/pear/Projects/Demo.app/Resources/ui/main.js')
            .then((b) => new TextDecoder().decode(b))
            .catch(() => ''),
        ),
      { timeout: 15_000 },
    )
    .toContain('console.log("typed in Code")')

  // edits on disk show up after a preview reload
  await desktop.page.evaluate(() =>
    window.tiny!.kernel.writeFile('/Users/pear/Projects/Demo.app/Resources/ui/index.html', new TextEncoder().encode('<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Hello, Test</h1></body></html>')),
  )
  await ui(desktop).locator('#prevReload').click()
  await expect(preview(desktop).locator('h1')).toHaveText('Hello, Test')
})

test('the project comes back after a reload', async ({ desktop }) => {
  await launch(desktop)
  await newProject(desktop, 'Persist', 'Web App')
  await expect(ui(desktop).locator('#project')).toHaveText('Persist.app')
  // give the kernel's 250 ms write-ahead flush a beat before tearing the page down
  await desktop.page.waitForTimeout(700)
  await desktop.reload()
  await launch(desktop)
  await expect(ui(desktop).locator('#project')).toHaveText('Persist.app')
  await expect(ui(desktop).locator('#tree .row', { hasText: 'main.js' })).toBeVisible()
})

test('AssemblyScript builds WebAssembly in the browser, and the preview runs it', async ({ desktop }) => {
  test.setTimeout(240_000)
  await launch(desktop)
  await newProject(desktop, 'Native', 'Web App + AssemblyScript')

  // before the first build, the preview runs the JavaScript stand-in
  await ui(desktop).getByRole('button', { name: /Preview/ }).click()
  await expect(preview(desktop).locator('#msg')).toContainText('plain JavaScript')

  await ui(desktop).getByRole('button', { name: 'Build', exact: true }).click()
  await expect(ui(desktop).locator('#outlog')).toContainText('Built src/main.wasm', { timeout: 180_000 })
  const size = await desktop.page.evaluate(() =>
    window.tiny!.kernel.stat('/Users/pear/Projects/Native.app/src/main.wasm').then((s) => s.size),
  )
  expect(size).toBeGreaterThan(0)

  // now the preview loads the native module
  await ui(desktop).locator('#prevReload').click()
  await expect(preview(desktop).locator('#msg')).toContainText('wasm module is loaded')
})

test('extensions: Preview is installed by default and can be disabled', async ({ desktop }) => {
  await launch(desktop)
  await ui(desktop).locator('#tabExt').click()
  const cards = ui(desktop).locator('.extcard')
  await expect(cards).toHaveCount(2)
  await expect(cards.first().locator('.name')).toHaveText(/Preview/)
  // disable Preview: its button disappears from the toolbar
  await cards.first().locator('input[type=checkbox]').click()
  await expect(ui(desktop).getByRole('button', { name: /Preview/ })).toHaveCount(0)
  await expect(cards.first().locator('.tag')).toContainText('built-in')
})

/** Write a project file through the kernel, as another program (or the user in Finder) would. */
const putFile = (desktop: Desktop, path: string, content: string | number[]): Promise<void> =>
  desktop.page.evaluate(
    ([p, c]) => window.tiny!.kernel.writeFile(p as string, typeof c === 'string' ? new TextEncoder().encode(c) : new Uint8Array(c as number[])),
    [path, content] as const,
  )

const edit = async (desktop: Desktop, tab: string, text: string): Promise<void> => {
  await ui(desktop).locator('.tab', { hasText: tab }).click()
  await ui(desktop).locator('.monaco-host .view-lines').click({ position: { x: 120, y: 8 }, force: true })
  await desktop.page.keyboard.press('Meta+a')
  await desktop.page.keyboard.insertText(text)
}

/** Pick an Auto Save mode from the status bar. */
const autoSave = async (desktop: Desktop, mode: string): Promise<void> => {
  await ui(desktop).locator('#stAuto').dispatchEvent('click') // the dock covers the status bar at this window size
  await desktop.page.getByRole('menuitemcheckbox', { name: `Auto Save: ${mode}` }).click()
}

const tabMenu = async (desktop: Desktop, tab: string): Promise<void> => {
  await ui(desktop).locator('.tab', { hasText: tab }).click({ button: 'right' })
}

test('language services: problems from the TypeScript, CSS and JSON services', async ({ desktop }) => {
  test.setTimeout(120_000)
  await launch(desktop)
  await newProject(desktop, 'Lang', 'Web App')
  const problems = ui(desktop).locator('#problemsList')
  await ui(desktop).locator('#stProblems').click()

  // JavaScript is type-checked; the `tiny` global is known
  await ui(desktop).locator('#tree .row', { hasText: 'main.js' }).click()
  await edit(desktop, 'main.js', 'await tiny.ready\nundefinedCall()\n')
  await expect(problems).toContainText("Cannot find name 'undefinedCall'", { timeout: 60_000 })
  await expect(problems).not.toContainText("Cannot find name 'tiny'")
  await expect(problems).not.toContainText('Cannot redeclare') // the bundled `tiny` typings are declared once

  // completion: `tiny.` offers the Pear API
  await ui(desktop).locator('.monaco-host .view-lines').click({ position: { x: 120, y: 8 }, force: true })
  await desktop.page.keyboard.press('Meta+a')
  await desktop.page.keyboard.insertText('tiny.readF')
  await desktop.page.keyboard.press('Control+Space')
  await expect(ui(desktop).locator('.suggest-widget')).toContainText('readFile', { timeout: 30_000 })
  await desktop.page.keyboard.press('Escape')
  await edit(desktop, 'main.js', 'await tiny.ready\nundefinedCall()\n')

  // CSS lint
  await ui(desktop).locator('#tree .row', { hasText: 'style.css' }).click()
  await edit(desktop, 'style.css', 'a { colr: red }\n')
  await expect(problems).toContainText("Unknown property: 'colr'", { timeout: 30_000 })

  // manifest.json is validated against the Pear manifest schema
  await ui(desktop).locator('#tree .row', { hasText: 'manifest.json' }).click()
  await edit(desktop, 'manifest.json', '{ "id": "org.x.lang", "name": "Lang", "permissions": ["teleport"] }')
  await expect(problems).toContainText('Value is not accepted', { timeout: 30_000 })
  await expect(ui(desktop).locator('#stProblems')).not.toHaveText('00')
})

test('SVG previews beside the editor, HTML has no extra preview, images open in a viewer', async ({ desktop }) => {
  await launch(desktop)
  await newProject(desktop, 'Media', 'Web App')

  const dir = '/Users/pear/Projects/Media.app/Resources'
  await putFile(desktop, `${dir}/ok.svg`, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>')
  await putFile(desktop, `${dir}/bad.svg`, '<svg><rect</svg>')
  await ui(desktop).locator('#refreshTree').click()

  await ui(desktop).locator('#tree .row', { hasText: 'ok.svg' }).click()
  await expect(ui(desktop).locator('#sidePreview')).toBeVisible()
  await expect(ui(desktop).locator('#sideTitle')).toHaveText('SVG Preview')
  await expect.poll(() => ui(desktop).locator('#svgEl').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0)
  await expect(ui(desktop).locator('#sideError')).toBeHidden()
  // a malformed SVG says so instead of showing a broken image
  await ui(desktop).locator('#tree .row', { hasText: 'bad.svg' }).click()
  await expect(ui(desktop).locator('#sideError')).toBeVisible()
  // the toggle hides the preview
  await ui(desktop).locator('#sideToggle').click()
  await expect(ui(desktop).locator('#sidePreview')).toBeHidden()

  // HTML has no side preview of its own: the app Preview is the one preview
  await ui(desktop).locator('#tree .row', { hasText: 'index.html' }).click()
  await expect(ui(desktop).locator('#sidePreview')).toBeHidden()
  await expect(ui(desktop).locator('#sideToggle')).toBeHidden()

  // a 1×1 PNG opens in the image viewer, not as garbled text
  const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
  await putFile(desktop, '/Users/pear/Projects/Media.app/Resources/ui/dot.png', png)
  await ui(desktop).locator('#refreshTree').click()
  await ui(desktop).locator('#tree .row', { hasText: 'dot.png' }).click()
  await expect(ui(desktop).locator('#imageView')).toBeVisible()
  await expect(ui(desktop).locator('#stLang')).toContainText('1 × 1')
})

test('the preview is persistent: it follows unsaved edits in any file and survives tab switches and reloads', async ({ desktop }) => {
  test.setTimeout(90_000)
  await launch(desktop)
  await newProject(desktop, 'Live', 'Web App')
  await autoSave(desktop, 'Off') // this test is about unsaved edits
  await ui(desktop).getByRole('button', { name: /Preview/ }).click()
  await expect(preview(desktop).locator('h1')).toHaveText('Hello, Pear')

  // editing business logic: the page's script changes, nothing is saved, the preview follows
  await ui(desktop).locator('#tree .row', { hasText: 'main.js' }).click()
  await edit(desktop, 'main.js', "document.querySelector('h1').textContent = 'Edited, unsaved'\n")
  await expect(preview(desktop).locator('h1')).toHaveText('Edited, unsaved', { timeout: 15_000 })
  await expect(ui(desktop).locator('.tab.dirty')).toHaveCount(1)

  // the pane stays open while other files, even non-web ones, are in the editor
  await ui(desktop).locator('#tree .row', { hasText: 'manifest.json' }).click()
  await ui(desktop).locator('#tree .row', { hasText: 'README.md' }).click()
  await expect(ui(desktop).locator('#previewPane')).toBeVisible()
  await expect(preview(desktop).locator('h1')).toHaveText('Edited, unsaved')

  // a stylesheet edit lands too
  await ui(desktop).locator('#tree .row', { hasText: 'style.css' }).click()
  await edit(desktop, 'style.css', 'h1 { color: rgb(255, 0, 0) }\n')
  await expect(preview(desktop).locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)', { timeout: 15_000 })

  // "On save" mode waits for the save
  await ui(desktop).locator('#prevMode').selectOption('save')
  await edit(desktop, 'style.css', 'h1 { color: rgb(0, 0, 255) }\n')
  await desktop.page.waitForTimeout(1500)
  await expect(preview(desktop).locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)')
  await desktop.page.keyboard.press('Meta+s')
  await expect(preview(desktop).locator('h1')).toHaveCSS('color', 'rgb(0, 0, 255)', { timeout: 15_000 })

  // a reload brings the preview back with the project
  await desktop.page.waitForTimeout(700)
  await desktop.reload()
  await launch(desktop)
  await expect(ui(desktop).locator('#project')).toHaveText('Live.app')
  await expect(ui(desktop).locator('#previewPane')).toBeVisible()
  await expect(ui(desktop).locator('#prevMode')).toHaveValue('save')
})

test('rebuilds keep the app where it was, and the debug console talks to the running app', async ({ desktop }) => {
  test.setTimeout(120_000)
  await launch(desktop)
  await newProject(desktop, 'State', 'Web App')
  const dir = '/Users/pear/Projects/State.app/Resources/ui'
  await putFile(desktop, `${dir}/index.html`, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><input id="note"><p id="out">hello</p><pre id="count"></pre><script src="main.js"></script></body></html>')
  await putFile(desktop, `${dir}/style.css`, '#out { color: rgb(1, 2, 3) }')
  await putFile(desktop, `${dir}/main.js`, "const n = Number(localStorage.getItem('n') || 0) + 1\nlocalStorage.setItem('n', String(n))\ndocument.getElementById('count').textContent = 'loads: ' + n\nconsole.log('boot', { n, list: [1, 2, 3] })\nconsole.warn('careful')\n")
  await ui(desktop).getByRole('button', { name: /Preview/ }).click()
  await expect(preview(desktop).locator('#count')).toHaveText('loads: 1')

  // the debug console shows what the app logs, objects expandable
  await ui(desktop).locator('#stConsole').click()
  const log = ui(desktop).locator('#consoleLog')
  await expect(log).toContainText('boot')
  await expect(log.locator('.lvl-warn')).toContainText('careful')
  await log.locator('.objline').first().click()
  await expect(log.locator('.children').first()).toContainText('list')

  // ... and evaluates in the running page, including its top-level bindings
  const prompt = ui(desktop).locator('#consoleInput')
  await prompt.fill('n + 40')
  await prompt.press('Enter')
  await expect(log.locator('.lvl-result').last()).toHaveText('41')
  await prompt.fill('await Promise.resolve(7)')
  await prompt.press('Enter')
  await expect(log.locator('.lvl-result').last()).toHaveText('7')
  await prompt.fill('nope()')
  await prompt.press('Enter')
  await expect(log.locator('.lvl-error').last()).toContainText('ReferenceError')

  // the user types into the page, then edits its code (unsaved): the page rebuilds and keeps the typing and its storage
  await preview(desktop).locator('#note').fill('typed by the user')
  await ui(desktop).locator('#tree .row', { hasText: 'main.js' }).click()
  await edit(desktop, 'main.js', "const n = Number(localStorage.getItem('n') || 0) + 1\nlocalStorage.setItem('n', String(n))\ndocument.getElementById('count').textContent = 'visits: ' + n\n")
  await expect(preview(desktop).locator('#count')).toHaveText('visits: 2', { timeout: 15_000 })
  await expect(preview(desktop).locator('#note')).toHaveValue('typed by the user')
  await expect(log.locator('.csep').last()).toContainText('reloaded')

  // a stylesheet edit is swapped in place: no reload, so the counter does not move
  await ui(desktop).locator('#tree .row', { hasText: 'style.css' }).click()
  await edit(desktop, 'style.css', '#out { color: rgb(9, 8, 7) }')
  await expect(preview(desktop).locator('#out')).toHaveCSS('color', 'rgb(9, 8, 7)', { timeout: 15_000 })
  await expect(preview(desktop).locator('#count')).toHaveText('visits: 2')
  await expect(preview(desktop).locator('#note')).toHaveValue('typed by the user')

  // Reload starts the page from scratch
  await ui(desktop).locator('#prevReload').click()
  await expect(preview(desktop).locator('#count')).toHaveText('visits: 1')
  await expect(preview(desktop).locator('#note')).toHaveValue('')
})

test('AssemblyScript files get their own IntelliSense: its types, its errors, its completions', async ({ desktop }) => {
  test.setTimeout(120_000)
  await launch(desktop)
  await newProject(desktop, 'Wasm', 'Web App + AssemblyScript')
  await ui(desktop).locator('#stProblems').click()
  await ui(desktop).locator('#tree .row', { hasText: /^src$/ }).click()
  await ui(desktop).locator('#tree .row', { hasText: 'main.ts' }).click()

  // type errors are reported against AssemblyScript's own library: i32 is known, a string argument is not an i32
  await edit(desktop, 'main.ts', 'export function add(a: i32, b: i32): i32 { return a + b }; export const bad: i32 = add(1, "z");')
  const problems = ui(desktop).locator('#problemsList')
  await expect(problems).toContainText("Argument of type 'string'", { timeout: 60_000 })
  await expect(problems).not.toContainText("Cannot find name 'i32'")
  await expect(ui(desktop).locator('#problemsBadge')).toHaveText('1') // valid AssemblyScript is not flagged

  // completion knows the AssemblyScript standard library
  await edit(desktop, 'main.ts', 'export const m = i32.MAX_V')
  await ui(desktop).locator('.monaco-host .view-lines').click({ position: { x: 120, y: 8 }, force: true })
  await desktop.page.keyboard.press('Meta+ArrowDown')
  await desktop.page.keyboard.press('Control+Space')
  await expect(ui(desktop).locator('.suggest-widget')).toContainText('MAX_VALUE', { timeout: 30_000 })
})

test('a failed AssemblyScript build says why: the compiler message, a marker on the line, and a stale-wasm warning', async ({ desktop }) => {
  test.setTimeout(240_000)
  await launch(desktop)
  await newProject(desktop, 'Broken', 'Web App + AssemblyScript')
  await ui(desktop).locator('#tree .row', { hasText: /^src$/ }).click()
  await ui(desktop).locator('#tree .row', { hasText: 'main.ts' }).click()
  // i16 * f64 needs an explicit conversion in AssemblyScript; this is unsaved, and still what gets built
  await edit(desktop, 'main.ts', 'export function mult(n: i16, t: f64): i16 { return n * t }')
  await ui(desktop).getByRole('button', { name: 'Build', exact: true }).click()
  await expect(ui(desktop).locator('#outlog')).toContainText('requires an explicit cast', { timeout: 200_000 })
  await expect(ui(desktop).locator('#outlog')).toContainText('was not updated')
  await ui(desktop).locator('#stProblems').click()
  await expect(ui(desktop).locator('#problemsList')).toContainText('AssemblyScript build')
  await expect(ui(desktop).locator('#problemsList')).toContainText('[Ln 1, Col 52]')
  await expect(ui(desktop).locator('#outlog')).not.toContainText('Unknown option')
})

test('auto save writes edits after a pause, and the setting can be changed and sticks', async ({ desktop }) => {
  test.setTimeout(90_000)
  await launch(desktop)
  await newProject(desktop, 'Auto', 'Web App')
  const read = (): Promise<string> =>
    desktop.page.evaluate(() => window.tiny!.kernel.readFile('/Users/pear/Projects/Auto.app/Resources/ui/main.js').then((b) => new TextDecoder().decode(b)))

  // the default: After Delay. No Cmd+S anywhere.
  await expect(ui(desktop).locator('#stAuto')).toHaveText('Auto Save')
  await ui(desktop).locator('#tree .row', { hasText: 'main.js' }).click()
  await edit(desktop, 'main.js', "console.log('autosaved')\n")
  await expect(ui(desktop).locator('.tab.dirty')).toHaveCount(1)
  await expect.poll(read, { timeout: 15_000 }).toContain('autosaved')
  await expect(ui(desktop).locator('.tab.dirty')).toHaveCount(0)

  // Off: edits stay in the editor
  await autoSave(desktop, 'Off')
  await expect(ui(desktop).locator('#stAuto')).toHaveText('Auto Save: Off')
  await edit(desktop, 'main.js', "console.log('not yet')\n")
  await desktop.page.waitForTimeout(2500)
  expect(await read()).toContain('autosaved')
  await expect(ui(desktop).locator('.tab.dirty')).toHaveCount(1)

  // On Focus Change: switching tabs writes the file you left
  await autoSave(desktop, 'On Focus Change')
  await ui(desktop).locator('#tree .row', { hasText: 'style.css' }).click()
  await expect.poll(read, { timeout: 15_000 }).toContain('not yet')
})

test('right-clicking a tab offers the VS Code tab actions and the preview views', async ({ desktop }) => {
  test.setTimeout(90_000)
  await launch(desktop)
  await newProject(desktop, 'Menu', 'Web App')
  await autoSave(desktop, 'Off')
  for (const f of ['main.js', 'style.css', 'index.html']) await ui(desktop).locator('#tree .row', { hasText: f }).click()
  await expect(ui(desktop).locator('.tab')).toHaveCount(3)

  await tabMenu(desktop, 'style.css')
  for (const name of ['Close', 'Close Others', 'Close to the Right', 'Close Saved', 'Close All', 'Copy Path', 'Copy Relative Path', 'Reveal in Finder', 'Reveal in Explorer', 'Pin', 'Reopen Closed Editor', 'Save', 'Revert File', 'Rename…']) {
    await expect(desktop.page.getByRole('menuitem', { name, exact: true })).toBeVisible()
  }
  // the preview views are always listed, enabled where they apply: a stylesheet has only the Merkle tree
  for (const name of ['Open Markdown Preview to the Side', 'Open Mermaid Preview to the Side', 'Open JSON Tree View to the Side', 'Open SVG Preview to the Side']) {
    await expect(desktop.page.getByRole('menuitem', { name })).toBeDisabled()
  }
  await expect(desktop.page.getByRole('menuitem', { name: 'Open Merkle Tree View to the Side' })).toBeEnabled()

  // Close Others leaves just this tab
  await desktop.page.getByRole('menuitem', { name: 'Close Others', exact: true }).click()
  await expect(ui(desktop).locator('.tab')).toHaveCount(1)
  await expect(ui(desktop).locator('.tab')).toContainText('style.css')

  // Reopen Closed Editor brings one back; Pin keeps a tab through Close All
  await tabMenu(desktop, 'style.css')
  await desktop.page.getByRole('menuitem', { name: 'Reopen Closed Editor' }).click()
  await expect(ui(desktop).locator('.tab')).toHaveCount(2)
  await tabMenu(desktop, 'style.css')
  await desktop.page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  await tabMenu(desktop, 'style.css')
  await desktop.page.getByRole('menuitem', { name: 'Close All', exact: true }).click()
  await expect(ui(desktop).locator('.tab')).toHaveCount(1)
  await expect(ui(desktop).locator('.tab.pinned')).toHaveCount(1)
})

test('previews: Markdown (with a Mermaid block), Mermaid, a JSON tree and a Merkle tree', async ({ desktop }) => {
  test.setTimeout(180_000)
  await launch(desktop)
  await newProject(desktop, 'Views', 'Web App')
  const dir = '/Users/pear/Projects/Views.app'
  await putFile(desktop, `${dir}/NOTES.md`, '# Hello notes\n\nSome *text* and a [link](README.md).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n\n```mermaid\ngraph TD; A-->B; B-->C\n```\n')
  await putFile(desktop, `${dir}/flow.mmd`, 'graph LR; X-->Y')
  await putFile(desktop, `${dir}/abc.txt`, 'abc')
  await ui(desktop).locator('#refreshTree').click()
  const doc = ui(desktop).locator('#docView')

  // Markdown, including the diagram in its fence and a highlighted code block
  await ui(desktop).locator('#tree .row', { hasText: 'NOTES.md' }).click()
  await ui(desktop).locator('#sideToggle').click()
  await expect(ui(desktop).locator('#sideTitle')).toHaveText('Markdown Preview')
  await expect(doc.locator('h1')).toHaveText('Hello notes')
  await expect(doc.locator('table td').first()).toHaveText('1')
  await expect(doc.locator('pre code span').first()).toBeVisible()
  await expect(doc.locator('.mermaid-block svg')).toBeVisible({ timeout: 120_000 })

  // a standalone Mermaid file, from the tab's menu; a broken one says why
  await ui(desktop).locator('#tree .row', { hasText: 'flow.mmd' }).click()
  await tabMenu(desktop, 'flow.mmd')
  await desktop.page.getByRole('menuitem', { name: 'Open Mermaid Preview to the Side' }).click()
  await expect(ui(desktop).locator('#sideTitle')).toHaveText('Mermaid Preview')
  await expect(doc.locator('.mermaid-block svg')).toBeVisible({ timeout: 60_000 })

  // a JSON tree, collapsible
  await ui(desktop).locator('#tree .row', { hasText: 'manifest.json' }).click()
  await tabMenu(desktop, 'manifest.json')
  await desktop.page.getByRole('menuitem', { name: 'Open JSON Tree View to the Side' }).click()
  await expect(ui(desktop).locator('#sideTitle')).toHaveText('JSON Tree')
  await expect(doc.locator('.jk', { hasText: 'permissions' })).toBeVisible()
  await ui(desktop).locator('#jsonCollapse').click()
  await expect(doc.locator('details[open]')).toHaveCount(0)
  await ui(desktop).locator('#jsonExpand').click()
  await expect(doc.locator('.jk', { hasText: 'permissions' })).toBeVisible()

  // a Merkle tree of any file: one chunk, so the root is the leaf hash: SHA-256(0x00 || "abc")
  await ui(desktop).locator('#tree .row', { hasText: 'abc.txt' }).click()
  await tabMenu(desktop, 'abc.txt')
  await desktop.page.getByRole('menuitem', { name: 'Open Merkle Tree View to the Side' }).click()
  await expect(ui(desktop).locator('#sideTitle')).toHaveText('Merkle Tree')
  const { createHash } = await import('node:crypto')
  const expected = createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from('abc')])).digest('hex')
  await expect(doc.locator('.mroot')).toHaveText(expected)
  // a bigger file builds a deeper tree whose leaves are hashes of its chunks
  await ui(desktop).locator('#tree .row', { hasText: 'README.md' }).click()
  await tabMenu(desktop, 'README.md')
  await desktop.page.getByRole('menuitem', { name: 'Open Merkle Tree View to the Side' }).click()
  await ui(desktop).locator('#merkleChunk').selectOption('64')
  await expect(doc.locator('.mleaf').first()).toContainText('chunk 0')
})
