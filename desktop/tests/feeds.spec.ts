/// The three info apps end-to-end: Weather (open-meteo), Stocks (frankfurter + coingecko) and News
/// (hn.algolia). Hermetic: no request ever touches the internet — the apps fetch through the
/// `tiny.network` service, Desktop performs them from this top page, so `page.route` half of every
/// call (fulfilled here, aborted for the offline case).
import type { FrameLocator } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

const HOME = '/Users/pear'

/** `n` days from today as a UTC calendar date — open-meteo answers plain dates in `daily.time`. */
const day = (n: number): string => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()

/** A JSON 200 for `route.fulfill`. */
const ok = (v: unknown): { status: number; contentType: string; body: string } => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(v),
})

/** Launch an app and return its window's iframe. A fresh boot also opens Profile: never count windows. */
const launch = async (desktop: Desktop, appId: string, title: string): Promise<FrameLocator> => {
  await desktop.page.evaluate((id) => window.tiny!.apps.launch(id).then(() => undefined), appId)
  return desktop.win(title).frameLocator('iframe')
}

/** Does `path` exist? Read via the page's kernel (acting as the system) — the retry wrapper is the
 *  put() retry shape from tests/media.spec.ts: the kernel can panic once on wasm aliasing. */
const exists = (desktop: Desktop, path: string): Promise<boolean> =>
  desktop.page.evaluate(async ({ path }) => {
    const k = window.tiny!.kernel
    for (let tries = 0; ; tries++) {
      try {
        await k.readFile(path)
        return true
      } catch (e) {
        if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') return false
      }
    }
  }, { path })

test('Weather: search, pick a city, see the current block and three days, and have it saved', async ({ desktop }) => {
  const { page } = desktop
  await page.route('**/geocoding-api.open-meteo.com/**', (r) =>
    r.fulfill(ok({ results: [{ name: 'Stockholm', country: 'Sweden', latitude: 59.33, longitude: 18.06, id: 2673730 }] })),
  )
  await page.route('**/api.open-meteo.com/**', (r) =>
    r.fulfill(
      ok({
        current: { temperature_2m: 12.6, weather_code: 61, wind_speed_10m: 14 },
        daily: {
          time: [day(0), day(1), day(2)],
          weather_code: [61, 3, 1],
          temperature_2m_max: [13, 11, 10],
          temperature_2m_min: [8, 7, 6],
        },
        hourly: { temperature_2m: [10.1, 11.5, 12.6, 12.4, 12.1, 11.6] },
      }),
    ),
  )
  const app = await launch(desktop, 'org.tiny.weather', 'Weather')
  const search = app.locator('#search')
  await search.fill('Stockholm')
  await search.press('Enter')
  await app.locator('#results button').filter({ hasText: 'Stockholm' }).first().click()
  await expect(app.locator('#temp')).toContainText('12.6') // the current temperature
  await expect(app.locator('#desc')).toContainText('Rain') // WMO code 61 in words
  await expect(app.locator('#days li')).toHaveCount(3) // the three-day outlook
  await expect(app.locator('#saved')).toContainText('Stockholm') // kept as a saved place
  await expect.poll(() => exists(desktop, `${HOME}/Library/Weather.json`)).toBe(true)
  await page.screenshot({ path: 'test-results/feeds-weather.png' })
})

test('Stocks: currency and crypto rows with the honest as-of date', async ({ desktop }) => {
  const { page } = desktop
  await page.route('**/api.frankfurter.app/**', (r) =>
    r.fulfill(ok({ amount: 1, base: 'USD', date: '2099-01-01', rates: { EUR: 0.9, GBP: 0.78, JPY: 155 } })),
  )
  await page.route('**/api.coingecko.com/**', (r) => r.fulfill(ok({ bitcoin: { usd: 97000 }, ethereum: { usd: 3500 } })))
  const app = await launch(desktop, 'org.tiny.stocks', 'Stocks')
  await expect(app.locator('tr[data-code="EUR"]')).toContainText('0.9')
  await expect(app.locator('tr[data-code="EUR"]')).toContainText('Euro')
  await expect(app.locator('tr[data-code="JPY"]')).toContainText('155')
  await expect(app.locator('tr[data-code="bitcoin"]')).toContainText('97000')
  await expect(app.locator('tr[data-code="ethereum"]')).toContainText('3500')
  await expect(app.locator('#asof')).toContainText('as of 2099-01-01')
  await expect.poll(() => exists(desktop, `${HOME}/Library/Stocks.json`)).toBe(true)
  await page.screenshot({ path: 'test-results/feeds-stocks.png' })
})

test('News: the front page, and a story without a link says so instead of throwing', async ({ desktop }) => {
  const { page } = desktop
  await page.route('**/hn.algolia.com/**', (r) =>
    r.fulfill(
      ok({
        hits: [
          { title: 'Pear OS ships nine apps', points: 100, author: 't', objectID: '1', url: 'https://tinyos.example/release', created_at: hoursAgo(2) },
          { title: 'Ask Pear: what should ship next?', points: 42, author: 'u', objectID: '2', url: null, created_at: hoursAgo(5) },
          { title: 'Show Pear: a window manager in one page of code', points: 10, author: 'v', objectID: '3', url: 'https://tinyos.example/wm', created_at: hoursAgo(9) },
          { title: 'Clocked RAM could let the kernel skip its save', points: 3, author: 'w', objectID: '4', url: '', created_at: hoursAgo(27) },
        ],
      }),
    ),
  )
  const app = await launch(desktop, 'org.tiny.news', 'News')
  await expect(app.getByText('Pear OS ships nine apps')).toBeVisible()
  // a story with no link: rendered disabled with a hint; activating it must not throw
  const noLink = app.locator('button.nolink').filter({ hasText: 'Ask Pear: what should ship next?' })
  await expect(noLink).toContainText('no link')
  await noLink.click()
  await expect(app.locator('#status')).toContainText('no link')
  await expect(app.locator('button.nolink')).toHaveCount(2)
  await expect(app.getByText('Pear OS ships nine apps')).toBeVisible() // the list survived the click
  await page.screenshot({ path: 'test-results/feeds-news.png' })
})

test('Offline: the friendly error card carries the code (EACCES) and Retry recovers', async ({ desktop }) => {
  const { page } = desktop
  let offline = true
  await page.route('**/hn.algolia.com/**', (r) =>
    offline
      ? r.abort()
      : r.fulfill(ok({ hits: [{ title: 'Pear OS ships nine apps', points: 100, author: 't', objectID: '1', url: 'https://tinyos.example/release', created_at: hoursAgo(1) }] })),
  )
  const app = await launch(desktop, 'org.tiny.news', 'News')
  await expect(app.locator('#error')).toContainText('EACCES')
  await expect(app.getByRole('button', { name: 'Retry' })).toBeVisible()
  offline = false
  await app.getByRole('button', { name: 'Retry' }).click()
  await expect(app.getByText('Pear OS ships nine apps')).toBeVisible()
  await expect(app.locator('#error')).toBeHidden()
})
