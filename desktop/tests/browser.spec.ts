import { createServer } from 'node:http'
import type { FrameLocator } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

test.describe.configure({ retries: 1 })

const A = 'http://localhost:5173/smoke/a.html'
const B = 'http://localhost:5173/smoke/b.html'
const C = 'http://localhost:5173/smoke/c.html'
const D = 'http://localhost:5173/smoke/d.html'
const E = 'http://localhost:5173/smoke/e.html'
const BOOKMARKS = '/Users/pear/Library/Bookmarks.json'

/** Launch Safari and wait until its toolbar answers. The page itself is a sandboxed iframe inside #page. */
async function launch(desktop: Desktop): Promise<{ ui: FrameLocator; inner: FrameLocator }> {
  await desktop.page.evaluate(() => window.tiny!.apps.launch('org.tiny.browser'))
  const win = desktop.page.locator('.window', { has: desktop.page.locator('iframe[title="Safari"]') }).first()
  const ui = win.frameLocator('iframe[title="Safari"]')
  await expect(ui.locator('body')).toHaveAttribute('data-ready', '1') // main() has wired the toolbar
  return { ui, inner: ui.frameLocator('iframe[title="Page"]') }
}

/** Type an address into the URL field and press Return, like a user (select-all first, the field may already have text). */
async function go(ui: FrameLocator, { page }: Desktop, url: string): Promise<void> {
  await ui.locator('#url').click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.type(url)
  await page.keyboard.press('Enter')
}

const fileText = ({ page }: Desktop, path: string) =>
  page.evaluate(async (p) => {
    const b = await window.tiny!.kernel.readFile(p).catch(() => null)
    return b ? new TextDecoder().decode(b) : ''
  }, path)

test('Safari opens a page and follows links', async ({ desktop }) => {
  const { ui, inner } = await launch(desktop)

  await go(ui, desktop, A)
  await expect(inner.locator('#page-a')).toContainText('Alpha page')
  await expect(desktop.win('Smoke A').locator('.name')).toHaveText('Smoke A') // document.title becomes the window title
  await expect(ui.locator('#url')).toHaveValue(A)

  // following the link fetches the next page; Back steps history and re-fetches
  await inner.locator('#to-b').click()
  await expect(inner.locator('#page-b')).toContainText('Beta page')
  await expect(desktop.win('Smoke B').locator('.name')).toHaveText('Smoke B')
  await expect(ui.locator('#url')).toHaveValue(B)

  await desktop.win('Smoke B').screenshot({ path: 'test-results/safari.png' })

  await ui.locator('#back').click()
  await expect(inner.locator('#page-a')).toContainText('Alpha page')
  await expect(desktop.win('Smoke A').locator('.name')).toHaveText('Smoke A')
  await expect(ui.locator('#url')).toHaveValue(A)
  await expect(ui.locator('#forward')).toBeEnabled()
})

test('a page keeps its own styles and scripts', async ({ desktop }) => {
  const { ui, inner } = await launch(desktop)

  await go(ui, desktop, C)
  await expect(inner.locator('#page-c')).toContainText('Gamma page')
  await expect(inner.locator('#css-out')).toHaveCSS('color', 'rgb(255, 0, 0)')
  await expect(inner.locator('#js-out')).toHaveText('external script ran')
  await expect(inner.locator('#inline-out')).toHaveText('inline script ran')
  await expect(desktop.win('Smoke C').locator('.name')).toHaveText('Smoke C')
})

test('a page reaches its own origin through the network bridge', async ({ desktop }) => {
  const { ui, inner } = await launch(desktop)

  // the page frame is CSP-blocked from connecting itself; fetch, JSON and XHR go through Safari to tiny.network
  await go(ui, desktop, D)
  await expect(inner.locator('#page-d')).toContainText('Delta page')
  await expect(inner.locator('#fetch-out')).toHaveText('fetch read alpha')
  await expect(inner.locator('#json-out')).toHaveText('json pear')
  await expect(inner.locator('#xhr-out')).toHaveText('xhr read beta')
})

test('a page may frame other pages, and a script-submitted form navigates the app', async ({ desktop }) => {
  const { ui, inner } = await launch(desktop)

  await go(ui, desktop, E)
  await expect(inner.locator('#page-e')).toContainText('Epsilon page')
  await expect(inner.frameLocator('iframe#frame-a').locator('#page-a')).toContainText('Alpha page')

  // `form.submit()` fires no submit event; the bridge routes it like a user-submitted GET
  await inner.locator('#submit-form').click()
  await expect(inner.locator('#page-b')).toContainText('Beta page')
  await expect(ui.locator('#url')).toHaveValue(`${B}?q=epsilon`)
})

test('a link from another app opens in Safari', async ({ desktop }) => {
  const { page } = desktop
  // no app named: a URL resolves to the system browser, so Safari must claim http/https
  await page.evaluate((url) => window.tiny!.kernel.launchOpen(url), A)
  const win = page.locator('.window', { has: page.locator('iframe[title="Safari"]') }).first()
  const ui = win.frameLocator('iframe[title="Safari"]')
  await expect(ui.locator('body')).toHaveAttribute('data-ready', '1')
  await expect(ui.locator('#url')).toHaveValue(A)
  await expect(ui.frameLocator('iframe[title="Page"]').locator('#page-a')).toContainText('Alpha page')

  // a second link while Safari is running lands in the same window (the openURL event)
  await page.evaluate((url) => window.tiny!.kernel.launchOpen(url), B)
  await expect(ui.frameLocator('iframe[title="Page"]').locator('#page-b')).toContainText('Beta page')
  await expect(ui.locator('#url')).toHaveValue(B)
  await expect(win.locator('.name')).toHaveText('Smoke B')
})

test('Bookmarks persist', async ({ desktop }) => {
  const { ui, inner } = await launch(desktop)
  await go(ui, desktop, A)
  await expect(inner.locator('#page-a')).toContainText('Alpha page')

  // Cmd+D acts through the menu shortcut; the write lands in ~/Library/Bookmarks.json
  await ui.locator('#url').click()
  await desktop.page.keyboard.press('Meta+D')
  await expect.poll(() => fileText(desktop, BOOKMARKS)).toContain('smoke/a.html')

  // close the window and start the app again: the bookmark comes back from the file
  const win = desktop.win('Smoke A')
  await win.locator('.light.close').click()
  await expect(win).toHaveCount(0)

  const { inner: inner2 } = await launch(desktop)

  await desktop.page.locator('.menubar').getByText('Bookmarks', { exact: true }).click()
  const item = desktop.page.locator('.menu').getByText('smoke/a.html')
  await expect(item).toContainText('smoke/a.html')
  await item.click()
  await expect(inner2.locator('#page-a')).toContainText('Alpha page')
  await expect(desktop.win('Smoke A').locator('.name')).toHaveText('Smoke A')
})

test('a page without CORS headers loads through the fallback proxy', async ({ desktop }) => {
  // A second origin, like any real site: it does not allow Desktop's origin to read its response. `/page` redirects,
  // so the page view must take the final address from the proxy to resolve the relative link and assets it shows.
  const upstream = createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(302, { location: '/final' })
      return void res.end()
    }
    if (req.url === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' })
      return void res.end('#cross-css { color: rgb(0, 128, 0); }')
    }
    if (req.url === '/script.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return void res.end("document.getElementById('cross-js').textContent = 'script loaded'")
    }
    if (req.url === '/final') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return void res.end(
        '<!doctype html><html><head><title>Cross Origin</title><link rel="stylesheet" href="/style.css"></head>' +
          '<body><h1 id="cross">Cross origin page</h1><p id="cross-css">stylesheet target</p><p id="cross-js">script target</p>' +
          '<script src="/script.js"></script><a id="next" href="/next">next</a></body></html>',
      )
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><head><title>Next Page</title></head><body><h1 id="next-page">Next page</h1></body></html>')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('the upstream server has no port')
  try {
    const { ui, inner } = await launch(desktop)
    await go(ui, desktop, `http://127.0.0.1:${address.port}/page`)
    await expect(inner.locator('#cross')).toContainText('Cross origin page')
    await expect(inner.locator('#cross-css')).toHaveCSS('color', 'rgb(0, 128, 0)')
    await expect(inner.locator('#cross-js')).toHaveText('script loaded')
    await expect(desktop.win('Cross Origin').locator('.name')).toHaveText('Cross Origin')
    await expect(ui.locator('#url')).toHaveValue(`http://127.0.0.1:${address.port}/final`)

    await inner.locator('#next').click()
    await expect(inner.locator('#next-page')).toContainText('Next page')
    await expect(ui.locator('#url')).toHaveValue(`http://127.0.0.1:${address.port}/next`)
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('Fetch error surfaces kindly', async ({ desktop }) => {
  const { ui, inner } = await launch(desktop)

  // one real load proves reachability; the routes then block the page-side fetch and imitate a static host that
  // answers `/api/proxy` with its own fallback page instead of providing the endpoint
  await go(ui, desktop, A)
  await expect(inner.locator('#page-a')).toContainText('Alpha page')
  await desktop.page.route('**/smoke/**', (route) => route.abort())
  await desktop.page.route('**/api/proxy**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1 id="fake">not the page</h1>' }),
  )

  await go(ui, desktop, B)
  const err = inner.locator('.err')
  await expect(err.locator('h1')).toContainText("localhost:5173 can't be loaded")
  await expect(err).toContainText('EACCES')
  await expect(err).toContainText('smoke/b.html')
  await expect(inner.locator('#fake')).toHaveCount(0)
  await expect(ui.locator('#url')).toHaveValue(B)
})
