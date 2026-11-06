import { expect, test, type Desktop } from './fixtures'

const ESC = '\x1b'
const BEL = '\x07'

const frame = (d: Desktop) => d.win(/Terminal/).frameLocator('iframe')
/** The rows of the active terminal. A row is one line on screen, so assertions can anchor to a whole line. */
const rows = (d: Desktop) => frame(d).locator('.xterm-rows:visible').first().locator('> div')
const row = (d: Desktop, re: RegExp) => rows(d).filter({ hasText: re })

const launch = (d: Desktop) => d.dock('org.tiny.terminal').click()

async function run(d: Desktop, line: string): Promise<void> {
  await d.page.keyboard.type(line)
  await d.page.keyboard.press('Enter')
}

/** Put a script in the user's Documents. */
const script = (d: Desktop, name: string, body: string) =>
  d.page.evaluate(([n, b]) => window.tiny!.kernel.writeFile(`/Users/pear/Documents/${n}`, new TextEncoder().encode(b!)).then(() => window.tiny!.kernel.chown(`/Users/pear/Documents/${n}`, 501, 20)), [name, body] as const)

test('the terminal runs the Vanilla shell: commands, files, pipes, ^C', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /pear@pear ~ %/)).toHaveCount(1)
  await run(desktop, 'echo hello from pear')
  await expect(row(desktop, /^hello from pear$/)).toHaveCount(1)

  await run(desktop, 'echo data > Documents/note.txt && cat Documents/note.txt | wc -c')
  await expect(row(desktop, /^\s*5$/)).toHaveCount(1)
  await run(desktop, 'ls Documents')
  await expect(row(desktop, /^note\.txt/)).toHaveCount(1)

  // the file really is in Vanilla's file system, owned by the user
  const owner = await page.evaluate(() => window.tiny!.kernel.stat('/Users/pear/Documents/note.txt').then((s) => s.uid))
  expect(owner).toBe(501)

  await run(desktop, 'sleep 30')
  const sleeping = () => page.evaluate(() => window.tiny!.kernel.listProcesses().then((l) => l.some((p) => p.name === 'sleep' && p.state === 'running')))
  await expect.poll(sleeping).toBe(true)
  await page.keyboard.press('Control+c')
  await expect.poll(sleeping).toBe(false)
  await run(desktop, 'echo back')
  await expect(row(desktop, /^back$/)).toHaveCount(1)

  // Backspace edits the line
  await page.keyboard.type('echo wrongg')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^wrong$/)).toHaveCount(1)
})

test('closing the terminal ends its shell', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  const shells = () => page.evaluate(() => window.tiny!.kernel.listProcesses().then((l) => l.filter((p) => p.name === 'sh' && p.state === 'running').length))
  expect(await shells()).toBe(1)
  await desktop.win('Terminal').locator('.light.close').click()
  await expect.poll(shells).toBe(0)
})

test('the shell sees a real terminal: TERM, size, and resizing follows the window', async ({ desktop }) => {
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await run(desktop, 'echo term=$TERM color=$COLORTERM')
  await expect(row(desktop, /^term=xterm-256color color=truecolor$/)).toHaveCount(1)

  // the grid fills the window (not a few columns), and grows with it
  const width = () => frame(desktop).locator('.xterm-screen').first().evaluate((el) => el.getBoundingClientRect().width)
  const wrap = () => frame(desktop).locator('#stage').evaluate((el) => el.getBoundingClientRect().width)
  expect(await width()).toBeGreaterThan((await wrap()) * 0.85)
  const before = await width()
  const se = (await desktop.win(/Terminal/).locator('.handle.se').boundingBox())!
  await desktop.page.mouse.move(se.x + 4, se.y + 4)
  await desktop.page.mouse.down()
  await desktop.page.mouse.move(se.x + 204, se.y + 4, { steps: 6 })
  await desktop.page.mouse.up()
  await expect.poll(width).toBeGreaterThan(before + 150)
})

test('colours: 16, 256 and truecolor, bold, underline, inverse', async ({ desktop }) => {
  await script(
    desktop,
    'colors.sh',
    `echo '${ESC}[31mRED16${ESC}[0m ${ESC}[38;5;202mORNG256${ESC}[0m ${ESC}[38;2;10;200;30mTRUE24${ESC}[0m ${ESC}[1mBOLD${ESC}[0m ${ESC}[4mUNDER${ESC}[0m'\n`,
  )
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await run(desktop, 'sh Documents/colors.sh')
  const line = row(desktop, /^RED16/)
  await expect(line).toHaveCount(1)
  await expect(line.locator('span', { hasText: 'RED16' }).first()).toHaveClass(/xterm-fg-1/)
  await expect(line.locator('span', { hasText: 'ORNG256' }).first()).toHaveClass(/xterm-fg-202/)
  await expect(line.locator('span', { hasText: 'TRUE24' }).first()).toHaveCSS('color', 'rgb(10, 200, 30)')
  await expect(line.locator('span', { hasText: 'BOLD' }).first()).toHaveClass(/xterm-bold/)
  await expect(line.locator('span', { hasText: 'UNDER' }).first()).toHaveClass(/xterm-underline/)
})

test('OSC titles and the working directory reach the tab and the window title', async ({ desktop }) => {
  await script(desktop, 'title.sh', `echo '${ESC}]0;build output${BEL}done'\n`)
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await run(desktop, 'sh Documents/title.sh')
  await expect(desktop.win(/build output/).locator('.name')).toContainText('build output')
})

test('tabs: Cmd+T opens one, each has its own shell, closing one leaves the other', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await expect(frame(desktop).locator('#tabs')).toBeHidden() // the tab bar appears with the second tab
  await run(desktop, 'echo first-tab')
  await page.keyboard.press('Meta+t')
  await expect(frame(desktop).locator('.tab')).toHaveCount(2)
  await expect(row(desktop, /pear@pear ~ %/)).not.toHaveCount(0)
  await run(desktop, 'echo second-tab')
  await expect(row(desktop, /^second-tab$/)).toHaveCount(1)
  await expect(row(desktop, /^first-tab$/)).toHaveCount(0)
  await frame(desktop).locator('.tab').first().click()
  await expect(row(desktop, /^first-tab$/)).toHaveCount(1)

  const shells = () => page.evaluate(() => window.tiny!.kernel.listProcesses().then((l) => l.filter((p) => p.name === 'sh' && p.state === 'running').length))
  expect(await shells()).toBe(2)
  await frame(desktop).locator('.tab').first().locator('.x').click()
  await expect(frame(desktop).locator('#tabs')).toBeHidden()
  await expect.poll(shells).toBe(1)
  await expect(row(desktop, /^second-tab$/)).toHaveCount(1)
})

test('split panes: Cmd+D splits, focus moves, exit closes the pane', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await page.keyboard.press('Meta+d')
  await expect(frame(desktop).locator('.xterm')).toHaveCount(2)
  await expect(frame(desktop).locator('.tm-cell.inactive')).toHaveCount(1)
  await run(desktop, 'exit')
  await expect(frame(desktop).locator('.xterm')).toHaveCount(1)
  await run(desktop, 'echo still-here')
  await expect(row(desktop, /^still-here$/)).toHaveCount(1)
})

test('find: Cmd+F searches the scrollback', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await run(desktop, 'echo needle-one')
  await run(desktop, 'echo hay')
  await page.keyboard.press('Meta+f')
  const bar = frame(desktop).locator('.tm-find')
  await expect(bar).toBeVisible()
  await page.keyboard.type('needle')
  await expect(bar.locator('.count')).toHaveText(/\d+\/\d+/)
  await page.keyboard.press('Escape')
  await expect(bar).toBeHidden()
})

test('typing exit in the only terminal closes the window', async ({ desktop }) => {
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await run(desktop, 'exit')
  await expect(desktop.win(/Terminal/)).toHaveCount(0)
})

test('font size changes from the View menu are kept', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  const size = () => rows(desktop).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const before = await size()
  await page.keyboard.press('Meta+=')
  await expect.poll(size).toBe(before + 1)
  await page.keyboard.press('Meta+0')
  await expect.poll(size).toBe(before)
})

test('line editing: Up/Down history, Left/Right, Home, Delete, ^U; no escape codes are echoed', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await run(desktop, 'echo first')
  await run(desktop, 'echo second')
  await expect(row(desktop, /^second$/)).toHaveCount(1)

  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(row(desktop, /% echo first$/)).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^second$/)).toHaveCount(2)

  // edit in the middle of a line: Home, move right past "echo ", insert, delete forward
  await page.keyboard.type('echo abXc')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Delete') // removes the X
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^abc$/)).toHaveCount(1)

  await page.keyboard.type('echo nope')
  await page.keyboard.press('Control+u')
  await page.keyboard.type('echo kept')
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^kept$/)).toHaveCount(1)
  await expect(row(desktop, /\^\[/)).toHaveCount(0)

  // a running program still gets a normal terminal (echo and line editing)
  await run(desktop, 'cat')
  await page.keyboard.type('line for cat')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^line for cat$/)).toHaveCount(2)
  await page.keyboard.press('Control+d')
  await run(desktop, 'echo after-cat')
  await expect(row(desktop, /^after-cat$/)).toHaveCount(1)
})

test('line editing: Up/Down history, Left/Delete, ^U, Tab completion; no escape codes are echoed', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(row(desktop, /%/)).not.toHaveCount(0)
  await run(desktop, 'echo first')
  await run(desktop, 'echo second')
  await expect(row(desktop, /^second$/)).toHaveCount(1)

  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(row(desktop, /% echo first$/)).not.toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^second$/)).toHaveCount(2)

  // edit in the middle of a line
  await page.keyboard.type('echo abXc')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^abc$/)).toHaveCount(1)

  await page.keyboard.type('echo nope')
  await page.keyboard.press('Control+u')
  await page.keyboard.type('echo kept')
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^kept$/)).toHaveCount(1)

  // Tab completes a command name and a file name
  await run(desktop, 'echo data > Documents/completion-target.txt')
  await page.keyboard.type('cat Documents/compl')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^data$/)).toHaveCount(1)
  await expect(rows(desktop).filter({ hasText: /\^\[/ })).toHaveCount(0)

  // a running program still gets an ordinary terminal (echo and line editing)
  await run(desktop, 'cat')
  await page.keyboard.type('line for cat')
  await page.keyboard.press('Enter')
  await expect(row(desktop, /^line for cat$/)).toHaveCount(2)
  await page.keyboard.press('Control+d')
  await run(desktop, 'echo after-cat')
  await expect(row(desktop, /^after-cat$/)).toHaveCount(1)
})
