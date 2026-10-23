import { expect, test, type Desktop } from './fixtures'

// the dev server is shared and reloads the page when other apps are edited
test.describe.configure({ retries: 1 })

async function openConsole(desktop: Desktop) {
  await desktop.page.evaluate(() => window.tiny!.apps.launch('org.tiny.console'))
  const win = desktop.win('Console')
  await expect(win).toBeVisible()
  return { win, ui: win.frameLocator('iframe') }
}

const write = (desktop: Desktop, entry: Record<string, unknown>) => desktop.page.evaluate((e) => window.tiny!.kernel.logWrite(e as never), entry)

test('shows the startup line, follows new messages live, filters and shows details', async ({ desktop }) => {
  const { ui } = await openConsole(desktop)
  const rows = ui.locator('.vrow')
  await expect(rows.filter({ hasText: 'Console opened' })).toBeVisible()
  await expect(rows.filter({ hasText: 'Console opened' })).toContainText('desktop.console')

  // messages written after the window opened arrive without any action
  await write(desktop, { level: 'info', subsystem: 'desktop.test', category: 'alpha', message: 'Hello Live One', data: { answer: 42 } })
  await write(desktop, { level: 'error', subsystem: 'desktop.other', category: 'beta', message: 'Something broke' })
  await write(desktop, { level: 'debug', subsystem: 'desktop.test', category: 'alpha', message: 'chatty detail' })
  await expect(rows.filter({ hasText: 'Hello Live One' })).toBeVisible()
  await expect(rows.filter({ hasText: 'Something broke' })).toBeVisible()

  // the sidebar lists the subsystems it has seen
  await expect(ui.locator('.sidebar [data-sub="desktop.test"]')).toBeVisible()

  // search is case-insensitive
  await ui.locator('#q').fill('hello live')
  await expect(rows).toHaveCount(1)
  // prefixes
  await ui.locator('#q').fill('subsystem:desktop.test')
  await expect(rows).toHaveCount(2)
  await ui.locator('#q').fill('level:error')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Something broke')
  await ui.locator('#q').fill('')

  // level menu: error and above
  await ui.locator('#level').selectOption('error')
  await expect(rows.filter({ hasText: 'Hello Live One' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'Something broke' })).toHaveCount(1)
  await ui.locator('#level').selectOption('debug')

  // the Errors and Faults source
  await ui.getByRole('button', { name: 'Errors and Faults' }).click()
  await expect(rows.filter({ hasText: 'Hello Live One' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'Something broke' })).toHaveCount(1)
  await ui.getByRole('button', { name: 'All Messages' }).click()

  // a subsystem in the sidebar
  await ui.locator('.sidebar [data-sub="desktop.test"]').click()
  await expect(rows.filter({ hasText: 'Something broke' })).toHaveCount(0)
  await ui.getByRole('button', { name: 'All Messages' }).click()

  // the detail pane shows the message and its data
  await rows.filter({ hasText: 'Hello Live One' }).click()
  await expect(ui.locator('.detail')).toContainText('Hello Live One')
  await expect(ui.locator('#ddata')).toContainText('"answer": 42')
})

test('pause stops the tail and resume catches up', async ({ desktop }) => {
  const { ui } = await openConsole(desktop)
  const rows = ui.locator('.vrow')
  await expect(rows.filter({ hasText: 'Console opened' })).toBeVisible()
  await ui.locator('#pause').click()
  await expect(ui.locator('#pause')).toHaveText('Resume')
  await write(desktop, { subsystem: 'desktop.test', message: 'written while paused' })
  await desktop.page.waitForTimeout(2500)
  await expect(rows.filter({ hasText: 'written while paused' })).toHaveCount(0)
  await ui.locator('#pause').click()
  await expect(rows.filter({ hasText: 'written while paused' })).toBeVisible()
})

test('a crashing program shows up under Crash Reports, can be shared and deleted', async ({ desktop }) => {
  const { page } = desktop
  const { win, ui } = await openConsole(desktop)
  await page.evaluate(async () => {
    const k = window.tiny!.kernel
    await k.writeFile('/tmp/crasher.js', new TextEncoder().encode(`export default async (tiny) => { await tiny.logWrite({ message: 'about to fail' }); throw new Error('kaboom-test') }`))
    await k.spawn('/tmp/crasher.js')
  })
  await expect.poll(() => page.evaluate(() => window.tiny!.kernel.crashList().then((l) => l.length))).toBeGreaterThan(0)

  await ui.getByRole('button', { name: /Crash Reports/ }).click()
  const row = ui.locator('.crashlist tbody tr', { hasText: 'crasher' })
  await expect(row).toBeVisible()
  await expect(ui.locator('.sidebar .badge')).toHaveText('1')
  await row.click()
  await expect(ui.locator('.crashdetail')).toContainText('kaboom-test')
  await expect(ui.locator('.crashdetail')).toContainText('Standard error')
  await expect(ui.locator('.crashdetail')).toContainText('about to fail')
  await expect(ui.locator('.explain')).toContainText('nothing is sent anywhere')

  await ui.getByRole('button', { name: 'Share Report' }).click()
  await expect(row).toContainText('Yes')
  expect(await page.evaluate(() => window.tiny!.kernel.crashList().then((l) => l[0]!.submitted))).toBe(true)

  await ui.getByRole('button', { name: 'Delete All...' }).click()
  await win.locator('.sheet button', { hasText: 'Cancel' }).click()
  expect(await page.evaluate(() => window.tiny!.kernel.crashList().then((l) => l.length))).toBe(1)
  await ui.getByRole('button', { name: 'Delete All...' }).click()
  await win.locator('.sheet button', { hasText: 'Delete All' }).click()
  await expect(ui.locator('.crashlist')).toContainText('No crash reports')
  expect(await page.evaluate(() => window.tiny!.kernel.crashList().then((l) => l.length))).toBe(0)
})

test('exports the log to a file and clears it', async ({ desktop }) => {
  const { page } = desktop
  const { win, ui } = await openConsole(desktop)
  const rows = ui.locator('.vrow')
  await write(desktop, { subsystem: 'desktop.test', message: 'exported line', data: { n: 1 } })
  await write(desktop, { subsystem: 'desktop.test', message: 'secret line', private: true })
  await expect(rows.filter({ hasText: 'exported line' })).toBeVisible()
  await expect(rows.filter({ hasText: 'secret line' })).toBeVisible()

  await ui.getByRole('button', { name: 'Export...' }).click()
  await win.locator('.sheet input[aria-label=Name]').fill('mylog.jsonl')
  await win.locator('.sheet button.primary', { hasText: 'Save' }).click()
  await expect(ui.locator('#note')).toContainText('Exported')
  const text = await page.evaluate(async () => {
    const dir = (await window.tiny!.kernel.readdir('/Users/pear/Documents')).map((e) => e.name)
    return dir.includes('mylog.jsonl') ? new TextDecoder().decode(await window.tiny!.kernel.readFile('/Users/pear/Documents/mylog.jsonl')) : `missing: ${dir}`
  })
  const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { message: string })
  expect(lines.some((l) => l.message === 'exported line')).toBe(true)
  expect(lines.some((l) => l.message === 'secret line')).toBe(false) // redacted
  expect(lines.some((l) => l.message === '<private>')).toBe(true)

  // clear: cancel keeps everything, confirm empties the view and the log
  await ui.getByRole('button', { name: 'Clear...' }).click()
  await win.locator('.sheet button', { hasText: 'Cancel' }).click()
  await expect(rows.filter({ hasText: 'exported line' })).toBeVisible()
  await ui.getByRole('button', { name: 'Clear...' }).click()
  await win.locator('.sheet button.danger', { hasText: 'Clear' }).click()
  await expect(rows.filter({ hasText: 'exported line' })).toHaveCount(0)
  expect(await page.evaluate(() => window.tiny!.kernel.logQuery({ text: 'exported line' }).then((l) => l.length))).toBe(0)
})

test('the audit section lists permission decisions', async ({ desktop }) => {
  const { ui } = await openConsole(desktop)
  await ui.getByRole('button', { name: 'Audit' }).click()
  await expect(ui.locator('#acount')).toContainText(/\d+ of \d+ entries/)
  await expect(ui.locator('[aria-label="Permission audit"]')).toBeVisible()
})
