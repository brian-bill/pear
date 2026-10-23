import { test as base, expect, type Locator, type Page } from '@playwright/test'

let counter = 0

export interface Desktop {
  /** The page, booted to a usable desktop on a private file system. */
  page: Page
  ns: string
  windows(): Locator
  win(title: string | RegExp): Locator
  dock(app: string): Locator
  /** Reload the same file system. */
  reload(): Promise<void>
}

/** Each test gets its own namespace, so file systems and sessions never mix. */
export const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ page }, use, info) => {
    const ns = `d${info.workerIndex}-${Date.now()}-${counter++}`
    const ready = async () => {
      await page.waitForFunction(() => (window as unknown as { tinyReady?: boolean }).tinyReady === true, null, { timeout: 30_000 })
    }
    await page.goto(`/?ns=${ns}`)
    await ready()
    await use({
      page,
      ns,
      windows: () => page.locator('.window'),
      win: (title) => page.locator('.window', { has: page.locator('.name', { hasText: title }) }),
      dock: (app) => page.locator(`.dock .item[data-app="${app}"]`),
      reload: async () => {
        await page.reload()
        await ready()
      },
    })
    // free the file system; a tab that was taken over has no kernel left to answer
    await page.evaluate(() => Promise.race([window.tiny?.kernel.shutdown({ destroy: true }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))])).catch(() => {})
  },
})

export { expect }
