import { type FrameLocator } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

const STORE = '/Users/pear/Library/Reminders.json'

/** Launch the app; the app id must be inside the evaluate call (page closures do not cross). */
async function launch(desktop: Desktop): Promise<void> {
  await desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.reminders'))
}

/** Read the store from the VFS (same aliasing-flake retry as the write pattern in media.spec). */
async function readStore(desktop: Desktop): Promise<string> {
  return desktop.page.evaluate(async (path) => {
    const k = window.tiny!.kernel
    for (let tries = 0; ; tries++) {
      try {
        return new TextDecoder().decode(await k.readFile(path))
      } catch (e) {
        // The kernel worker serves requests concurrently; two interleaved wasm calls can
        // panic with this aliasing error. It never leaves anything corrupted, so one retry is enough.
        if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') throw e
      }
    }
  }, STORE)
}

/** The value a `<input type="datetime-local">` holds at time `t` (local time). */
const dtLocal = (t: number): string => {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const frame = (desktop: Desktop): FrameLocator => desktop.win(/Reminders/).frameLocator('iframe')
const row = (f: FrameLocator, title: string) => f.locator(`.item[data-title="${title}"]`)
const winName = (desktop: Desktop) => desktop.win(/Reminders/).locator('.name')

/** Launch a fresh window (first run seeds a "Personal" list) and park the caret in the add row. */
async function open(desktop: Desktop): Promise<FrameLocator> {
  await launch(desktop)
  const f = frame(desktop)
  await expect(f.locator('#listname')).toHaveText('Personal')
  await expect(winName(desktop)).toHaveText('Reminders') // nothing open yet
  return f
}

/** Launch (or find the session-restored window) after a reload. */
async function reopen(desktop: Desktop): Promise<FrameLocator> {
  if ((await desktop.win(/Reminders/).count()) === 0) await launch(desktop)
  const f = frame(desktop)
  await expect(f.locator('#listname')).toHaveText('Personal')
  return f
}

/** An item goes through the add row: fill, then Enter on the (focused) field itself. */
async function addItem(f: FrameLocator, text: string): Promise<void> {
  await f.locator('#add').fill(text)
  await f.locator('#add').press('Enter')
}

const titles = (f: FrameLocator) =>
  f.locator('.item[data-title]').evaluateAll((els) => els.map((el) => (el.querySelector('input.title') as HTMLInputElement | null)?.value))

test('add + complete + persistence', async ({ desktop }) => {
  const { page } = desktop
  const f = await open(desktop)

  await addItem(f, 'Milk')
  await expect(row(f, 'Milk')).toBeVisible()
  await expect.poll(() => winName(desktop).textContent()).toBe('Reminders (1)')

  // a second reminder with a due date (the fresh row shows its details line right away)
  await addItem(f, 'Call mom')
  await expect(f.locator('#due')).toBeVisible()
  await f.locator('#due').fill(dtLocal(Date.now() + 86_400_000))
  await expect.poll(() => winName(desktop).textContent()).toBe('Reminders (2)')

  // completing Milk: filled circle + strikethrough, the row moves to the bottom, the count drops
  await row(f, 'Milk').locator('.circle').click()
  await expect(row(f, 'Milk')).toHaveClass(/\bdone\b/)
  await expect.poll(() => winName(desktop).textContent()).toBe('Reminders (1)')
  const strike = () => row(f, 'Milk').locator('input.title').evaluate((el: HTMLInputElement) => getComputedStyle(el).textDecorationLine)
  await expect.poll(strike).toContain('line-through')
  await expect.poll(() => titles(f)).toEqual(['Call mom', 'Milk'])

  // the ended session left the store on disk: reload, and the state comes back for the file
  await expect.poll(() => readStore(desktop)).toContain('"Milk"') // the app has written its store
  await page.waitForTimeout(800) // the kernel flushes the file system on a timer, like Finder's reload test
  await desktop.reload()
  const again = await reopen(desktop)
  await expect(row(again, 'Milk')).toBeVisible()
  await expect(row(again, 'Milk')).toHaveClass(/\bdone\b/)
  await expect.poll(() => winName(desktop).textContent()).toBe('Reminders (1)')
  await expect
    .poll(() => row(again, 'Milk').locator('input.title').evaluate((el: HTMLInputElement) => getComputedStyle(el).textDecorationLine))
    .toContain('line-through')

  const raw = await readStore(desktop)
  expect(raw).toContain('Milk')
  const data = JSON.parse(raw) as { lists: Array<{ title: string; items: Array<{ title: string; completed: boolean; due?: string }> }> }
  expect(data.lists).toHaveLength(1)
  const milk = data.lists.flatMap((l) => l.items).find((i) => i.title === 'Milk')
  expect(milk?.completed).toBe(true)
  const mom = data.lists.flatMap((l) => l.items).find((i) => i.title === 'Call mom')
  const due = new Date(mom?.due ?? '')
  expect(due.getTime() - Date.now()).toBeGreaterThan(3_600_000) // about a day ahead, as entered

  await page.screenshot({ path: 'test-results/reminders.png' })
})

test('today smart list', async ({ desktop }) => {
  const { page } = desktop
  const f = await open(desktop)

  // one item due today: noon on today's date, so it cannot land on tomorrow
  const now = new Date()
  await addItem(f, 'Water plants')
  await expect(f.locator('#due')).toBeVisible()
  await f.locator('#due').fill(dtLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime()))

  const today = f.locator('.sidebar button', { hasText: 'Today' })
  await expect(today.locator('.badge')).toHaveText('1')

  await today.click()
  await expect(f.locator('#listname')).toHaveText('Today')
  await expect(row(f, 'Water plants')).toBeVisible()
  await expect(row(f, 'Water plants').locator('.src')).toHaveText('Personal') // shown from its own list

  // adding from Today lands on the target list, where the undated row then lives
  await addItem(f, 'Someday')
  await expect(f.locator('#listname')).toHaveText('Personal')
  await expect(row(f, 'Someday')).toBeVisible()
  await today.click()
  await expect(f.locator('#listname')).toHaveText('Today')
  await expect(row(f, 'Someday')).toHaveCount(0) // an undated item does not belong in Today
  await expect(row(f, 'Water plants')).toBeVisible()
})

test('hide completed', async ({ desktop }) => {
  const { page } = desktop
  const f = await open(desktop)

  await addItem(f, 'Milk')
  await expect(row(f, 'Milk')).toBeVisible()
  await row(f, 'Milk').locator('.circle').click()
  await expect(row(f, 'Milk')).toHaveClass(/\bdone\b/)
  await expect.poll(() => winName(desktop).textContent()).toBe('Reminders') // nothing open left

  await desktop.win(/Reminders/).locator('.titlebar').click()
  await page.locator('.menubar').getByText('View', { exact: true }).click()
  await page.getByText('Hide Completed', { exact: true }).click()
  await expect(f.locator('.item[data-title]')).toHaveCount(0)
  await expect(f.locator('.empty')).toContainText('No Reminders')

  await page.locator('.menubar').getByText('View', { exact: true }).click()
  await page.getByText('Show Completed', { exact: true }).click()
  await expect(row(f, 'Milk')).toBeVisible()
  await expect(row(f, 'Milk')).toHaveClass(/\bdone\b/)
})
