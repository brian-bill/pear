import { expect, test, type Desktop } from './fixtures'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
// several sibling test runs share the dev server and reload the page when other apps are edited
test.describe.configure({ retries: 1 })

/** Screenshot goes next to the other runs' output folders, relative to desktop/. */
const SCREENSHOT = fileURLToPath(new URL('../test-results/clock.png', import.meta.url))

async function open(desktop: Desktop) {
  // Profile also opens at boot: windows are never counted in these tests.
  await desktop.page.evaluate(() => window.tiny!.apps.launch('org.tiny.clock'))
  const frame = desktop.win('Clock').frameLocator('iframe')
  await expect(frame.locator('.tabs')).toBeVisible()
  return frame
}

async function switchTab(desktop: Desktop, name: string) {
  const frame = await open(desktop)
  await frame.getByRole('tab', { name }).click()
  return frame
}

test('world clocks tick', async ({ desktop }) => {
  const frame = await open(desktop)
  await expect(frame.locator('#tab-world')).toHaveAttribute('aria-selected', 'true')

  // the built-in grid opens with eight city tiles, one per time zone
  const tiles = frame.locator('#cities .tile')
  await expect(tiles).toHaveCount(8)
  const tokyo = tiles.filter({ hasText: 'Tokyo' })
  await expect(tokyo).toHaveCount(1)
  const time = tokyo.locator('.time')
  await expect(time).toHaveText(/^\d{1,2}:\d{2}$/)

  // the clock keeps ticking along (minute granularity) while the tab stays in the foreground
  await desktop.page.waitForTimeout(2_000)
  await expect(time).toHaveText(/^\d{1,2}:\d{2}$/)

  // the search adds a city and refuses a time zone that is already on the grid
  await frame.locator('#city-query').fill('chicago')
  const chicago = frame.locator('#city-results .result', { hasText: 'Chicago' })
  await expect(chicago).toHaveCount(1)
  await chicago.click()
  await expect(tiles).toHaveCount(9)
  await frame.locator('#city-query').fill('chicago')
  await expect(frame.locator('#city-results')).toContainText('No new cities')

  mkdirSync(dirname(SCREENSHOT), { recursive: true })
  await desktop.win('Clock').screenshot({ path: SCREENSHOT, timeout: 15_000 })
})

test('timer counts down and lands on zero', async ({ desktop }) => {
  const frame = await switchTab(desktop, 'Timer')
  const display = frame.locator('#timer-display')
  await frame.locator('#t-h').fill('0')
  await frame.locator('#t-m').fill('0')
  await frame.locator('#t-s').fill('3')
  await expect(display).toHaveText('00:03')
  await frame.getByRole('button', { name: 'Start' }).click()
  await expect.poll(() => display.textContent()).toBe('00:00')
  // no crash at zero: the countdown rests there and Reset is on offer
  await expect(display).toBeVisible()
  await expect(display).toHaveText('00:00')
  await expect(frame.getByRole('button', { name: 'Reset' })).toBeVisible()
  // the app listed the notification it posted at zero (permission comes from the manifest)
  await expect
    .poll(() =>
      desktop.page.evaluate(async () => {
        const k = window.tiny!.kernel
        const r = await k.request(await k.lookup('tiny.notifications'), { op: 'list' })
        const items = ((r as unknown as { data?: { result?: Array<{ title: string }> } }).data?.result ?? [])
        return items.some((n) => n.title === 'Timer')
      }),
    )
    .toBe(true)
  await frame.getByRole('button', { name: 'Reset' }).click()
  await expect(frame.getByRole('button', { name: 'Start' })).toBeVisible()
})

test('stopwatch runs and laps', async ({ desktop }) => {
  const { page } = desktop
  const frame = await switchTab(desktop, 'Stopwatch')
  const display = frame.locator('#sw-display')
  await expect(display).toHaveText('00:00.00')
  await frame.getByRole('button', { name: 'Start' }).click()
  await expect.poll(() => display.textContent()).not.toBe('00:00.00')

  await frame.getByRole('button', { name: 'Lap' }).click()
  const lap = frame.locator('#laps .lap')
  await expect(lap).toHaveCount(1)
  await expect(lap.first()).toContainText('Lap 1')

  await frame.getByRole('button', { name: 'Stop' }).click()
  const frozen = await display.textContent()
  await page.waitForTimeout(300)
  await expect(display).toHaveText(frozen!)

  await frame.getByRole('button', { name: 'Reset' }).click()
  await expect(display).toHaveText('00:00.00')
  await expect(frame.locator('#laps .lap')).toHaveCount(0)
})
