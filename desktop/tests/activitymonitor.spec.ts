import { expect, test, type Desktop } from './fixtures'

// the dev server is shared and reloads the page when other apps are edited
test.describe.configure({ retries: 1 })

const SLEEPER = `export default async function (tiny) { await new Promise((r) => setTimeout(r, 600000)) }`

async function openMonitor(desktop: Desktop) {
  await desktop.page.evaluate(() => window.tiny!.apps.launch('org.tiny.activitymonitor'))
  const win = desktop.win('Activity Monitor')
  await expect(win).toBeVisible()
  return { win, ui: win.frameLocator('iframe') }
}

test('lists the Terminal shell, sorts and filters', async ({ desktop }) => {
  await desktop.dock('org.tiny.terminal').click()
  await expect(desktop.win('Terminal').frameLocator('iframe').locator('.terminal')).toContainText('%')
  const { ui } = await openMonitor(desktop)

  // the shell the Terminal started belongs to the Terminal app
  const shell = ui.locator('tbody tr', { hasText: 'Terminal' })
  await expect(shell.first()).toBeVisible()
  await expect(shell.first()).toContainText('pear')
  await expect(shell.first()).toContainText('Yes')

  // sort by PID descending: the first row has the highest pid
  const pids = async () => (await ui.locator('tbody tr td:first-child').allTextContents()).map(Number)
  await ui.locator('th[data-key=pid]').click()
  await expect(ui.locator('th[data-key=pid]')).toHaveAttribute('aria-sort', 'descending')
  const desc = await pids()
  expect(desc).toEqual([...desc].sort((a, b) => b - a))
  await ui.locator('th[data-key=pid]').click()
  const asc = await pids()
  expect(asc).toEqual([...asc].sort((a, b) => a - b))

  // the filter narrows the table
  const all = asc.length
  await ui.locator('#search').fill('Terminal')
  await expect(ui.locator('tbody tr').first()).toContainText('Terminal')
  expect(await ui.locator('tbody tr').count()).toBeLessThan(all)
  await ui.locator('#search').fill('no-such-process-xyz')
  await expect(ui.locator('tbody tr')).toHaveCount(0)
})

test('force quits a process, with confirmation, and shows its details', async ({ desktop }) => {
  const { page } = desktop
  const pid = await page.evaluate(async (src) => {
    await window.tiny!.kernel.writeFile('/tmp/sleeper.js', new TextEncoder().encode(src))
    return window.tiny!.kernel.spawn('/tmp/sleeper.js', { args: ['--demo', 'x'], cwd: '/tmp' })
  }, SLEEPER)
  const { win, ui } = await openMonitor(desktop)
  const row = ui.locator(`tbody tr[data-pid="${pid}"]`)
  await expect(row).toBeVisible()

  await row.click()
  await expect(row).toHaveClass(/selected/)
  await ui.getByRole('button', { name: 'Inspect' }).click()
  await expect(ui.locator('.inspect')).toContainText('/tmp/sleeper.js')
  await expect(ui.locator('.inspect')).toContainText('"--demo"')
  await expect(ui.locator('.inspect')).toContainText('/tmp')

  // cancelling leaves it running
  await ui.getByRole('button', { name: 'Force Quit' }).click()
  await win.locator('.sheet button', { hasText: 'Cancel' }).click()
  expect(await page.evaluate((p) => window.tiny!.kernel.listProcesses().then((l) => l.some((x) => x.pid === p)), pid)).toBe(true)

  await ui.getByRole('button', { name: 'Force Quit' }).click()
  await expect(win.locator('.sheet')).toContainText('Force quit')
  await win.locator('.sheet button', { hasText: 'Force Quit' }).click()
  await expect.poll(() => page.evaluate((p) => window.tiny!.kernel.listProcesses().then((l) => l.some((x) => x.pid === p && x.state === 'running')), pid)).toBe(false)
  // gone, or listed as a zombie until its parent waits for it
  await expect(async () => {
    if (await row.count()) await expect(row).toContainText('zombie', { timeout: 500 })
  }).toPass({ timeout: 8000 })
})

test('other tabs show memory, energy, network and disk information', async ({ desktop }) => {
  const { ui } = await openMonitor(desktop)
  const tab = (n: string) => ui.getByRole('tab', { name: n })

  await tab('Memory').click()
  await expect(ui.getByText('Open files', { exact: true })).toBeVisible()
  await expect(ui.getByText('Journal sequence')).toBeVisible()
  await expect(ui.locator('#stuse')).toContainText(/used of|does not report/)
  await expect(ui.locator('#heapspark')).toBeVisible()

  // a program holding a wake lock appears under Energy
  await desktop.page.evaluate(async () => {
    await window.tiny!.kernel.writeFile('/tmp/awake.js', new TextEncoder().encode(
      `export default async (tiny) => { await tiny.request(await tiny.lookup('tiny.timers'), { op: 'power.assert', type: 'system', reason: 'test-lock' }); await new Promise((r) => setTimeout(r, 600000)) }`))
    await window.tiny!.kernel.spawn('/tmp/awake.js')
  })
  await tab('Energy').click()
  await expect(ui.getByText('test-lock')).toBeVisible({ timeout: 10_000 })

  await tab('Network').click()
  await expect(ui.locator('.panel.on')).toContainText(/Network|used the network/)

  await tab('Disk').click()
  await expect(ui.locator('.panel.on [role=progressbar]')).toBeVisible()
  await expect(ui.getByText('Journal', { exact: true })).toBeVisible()
  await expect(ui.getByText('Recovery at the last mount')).toBeVisible()
})
