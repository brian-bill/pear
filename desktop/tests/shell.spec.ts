import { expect, test } from './fixtures'

/** Shorthand for work in the page, as the system. */
const k = (page: import('@playwright/test').Page) => ({
  eval: <T>(fn: (kernel: NonNullable<Window['tiny']>['kernel']) => Promise<T> | T) => page.evaluate(`(${fn.toString()})(window.tiny.kernel)`) as Promise<T>,
})

test('the launcher opens with Alt+Space, finds apps and files, and Enter opens the choice', async ({ desktop }) => {
  const { page } = desktop
  // the first-run Profile window covers the desktop; close it before using the surface
  await desktop.win('Profile').locator('.light.close').click()
  await page.evaluate(async () => {
    const kern = window.tiny!.kernel
    await kern.writeFile('/Users/pear/Documents/quarterly report.txt', new TextEncoder().encode('numbers'))
    await kern.chown('/Users/pear/Documents/quarterly report.txt', 501, 20)
    for (let i = 0; i < 50; i++) {
      const port = await kern.lookup('tiny.search')
      await kern.request(port, { op: 'index.sync' })
      const r = (await kern.request(port, { op: 'query', q: 'quarterly' })).data as { result: { results: unknown[] } }
      if (r.result.results.length) return
      await new Promise((r) => setTimeout(r, 100))
    }
  })
  await page.locator('.surface').click({ position: { x: 400, y: 600 } }) // give the page the keyboard
  await page.keyboard.press('Alt+Space')
  const input = page.getByRole('textbox', { name: 'Search' })
  await expect(input).toBeFocused()
  await input.fill('termi')
  await expect(page.locator('.launcher-row').first()).toContainText('Terminal')
  await input.fill('quarterly')
  await expect(page.locator('.launcher-row').first()).toContainText('quarterly report.txt')
  await input.fill('2+3*4')
  await expect(page.locator('.launcher-row').first()).toContainText('14')
  await input.fill('settings')
  await expect(page.locator('.launcher-row').first()).toBeVisible()
  await input.fill('terminal')
  await expect(page.locator('.launcher-row').first()).toContainText('Terminal')
  await page.keyboard.press('Enter')
  await expect(page.locator('.launcher')).toHaveCount(0)
  await expect(desktop.win('Terminal')).toBeVisible()
  await page.keyboard.press('Alt+Space')
  await page.keyboard.press('Escape')
  await expect(page.locator('.launcher')).toHaveCount(0)
})

test('notifications appear as banners, collect in the Notification Center, and Do Not Disturb silences them', async ({ desktop }) => {
  const { page } = desktop
  const post = (title: string) => page.evaluate((t) => window.tiny!.notify(t, 'details'), title)
  await post('Backup finished')
  await expect(page.locator('.banners .note')).toContainText('Backup finished')
  await expect(page.locator('[data-status="notifications"] .badge')).toHaveText('1')
  await page.locator('[data-status="notifications"]').click()
  await expect(page.locator('.note-center')).toContainText('Backup finished')
  await page.getByRole('button', { name: 'Do Not Disturb' }).click()
  await post('Quiet one')
  await expect(page.locator('.note-center')).toContainText('Quiet one')
  await expect(page.locator('.banners .note', { hasText: 'Quiet one' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear All' }).click()
  await expect(page.locator('.note-center')).toContainText('No Notifications')
  await expect(page.locator('[data-status="notifications"] .badge')).toHaveCount(0)
})

test('Mission Control shows every window and brings the chosen one forward', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.terminal').click()
  await expect(desktop.win('Terminal')).toHaveClass(/focused/)
  await page.keyboard.press('Control+ArrowUp')
  await expect(page.locator('.mission-card')).toHaveCount(2)
  await page.locator('.mission-card', { hasText: 'Profile' }).click()
  await expect(page.locator('.mission')).toHaveCount(0)
  await expect(desktop.win('Profile')).toHaveClass(/focused/)
})

test('lock screen: locks, refuses a wrong password, unlocks', async ({ desktop }) => {
  const { page } = desktop
  await page.evaluate(async () => {
    const kern = window.tiny!.kernel
    const port = await kern.lookup('tiny.session')
    await kern.request(port, { op: 'setPassword', password: 'hunter2' })
  })
  await page.locator('.menubar .title.system').click()
  await page.locator('.menu button', { hasText: 'Lock Screen' }).click()
  await expect(page.locator('#lock')).toBeVisible()
  await page.getByLabel('Password').fill('nope')
  await page.keyboard.press('Enter')
  await expect(page.locator('.lock-error')).toHaveText('Incorrect password')
  await page.getByLabel('Password').fill('hunter2')
  await page.keyboard.press('Enter')
  await expect(page.locator('#lock')).toHaveCount(0)
})

test('desktop icons show ~/Desktop, open on double-click, and the context menu makes folders', async ({ desktop }) => {
  const { page } = desktop
  // the first-run Profile window would cover the desktop this test uses
  await desktop.win('Profile').locator('.light.close').click()
  await page.evaluate(async () => {
    const kern = window.tiny!.kernel
    await kern.writeFile('/Users/pear/Desktop/todo.txt', new TextEncoder().encode('buy milk'))
    await kern.chown('/Users/pear/Desktop/todo.txt', 501, 20)
  })
  await expect(page.locator('.desktop-icon', { hasText: 'todo.txt' })).toBeVisible()
  await page.locator('.surface').click({ position: { x: 300, y: 300 }, button: 'right' })
  await page.locator('.menu button', { hasText: 'New Folder' }).click()
  await expect(page.locator('.desktop-icon', { hasText: 'untitled folder' })).toBeVisible()
  expect(await k(page).eval((kern) => kern.stat('/Users/pear/Desktop/untitled folder').then((s) => s.uid))).toBe(501)
  // move to Trash from the icon's menu: the dock's Trash fills up
  await page.locator('.desktop-icon', { hasText: 'todo.txt' }).click({ button: 'right' })
  await page.locator('.menu button', { hasText: 'Move to Trash' }).click()
  await expect(page.locator('.desktop-icon', { hasText: 'todo.txt' })).toHaveCount(0)
  await expect(page.locator('.dock .item[data-app="trash"] svg path[d^="M20 14"]')).toHaveCount(1) // the full-trash icon
})

test('Dock settings take effect: size, position, auto-hide; pinned apps can be unpinned from the Dock menu', async ({ desktop }) => {
  const { page } = desktop
  await page.evaluate(async () => {
    const kern = window.tiny!.kernel
    await kern.configSet('tiny.desktop.dock', 'size', 72)
    await kern.configSet('tiny.desktop.dock', 'position', 'left')
  })
  await expect(page.locator('.dock-wrap')).toHaveAttribute('data-position', 'left')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dock-size'))).toBe('72px')
  const box = (await page.locator('.dock').boundingBox())!
  expect(box.x).toBeLessThan(40)
  await page.locator('.dock .item[data-app="org.tiny.terminal"]').click({ button: 'right' })
  await page.locator('.menu button', { hasText: 'Keep in Dock' }).click()
  await expect(page.locator('.dock .item[data-app="org.tiny.terminal"]')).toHaveCount(0)
})

test('the wallpaper follows its setting: built-in presets and a picture from the file system', async ({ desktop }) => {
  const { page } = desktop
  const bg = () => page.evaluate(() => document.getElementById('desktop')!.style.background)
  await expect.poll(bg).toContain('one-piece-4k.jpg')
  await page.evaluate(() => window.tiny!.kernel.configSet('tiny.desktop.wallpaper', 'path', 'builtin:forest'))
  await expect.poll(bg).toContain('86, 171, 47')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>'
  await page.evaluate(async (s) => {
    const kern = window.tiny!.kernel
    await kern.writeFile('/Users/pear/Documents/wall.svg', new TextEncoder().encode(s))
    await kern.configSet('tiny.desktop.wallpaper', 'path', '/Users/pear/Documents/wall.svg')
  }, svg)
  await expect.poll(bg).toContain('blob:')
})

test('the volume status item changes the audio setting', async ({ desktop }) => {
  const { page } = desktop
  await page.locator('[data-status="volume"]').click()
  await page.getByLabel('Output volume').fill('30')
  await expect.poll(() => k(page).eval((kern) => kern.configGet('tiny.audio', 'volume', 1))).toBe(0.3)
  await page.getByLabel('Mute').check()
  await expect.poll(() => k(page).eval((kern) => kern.configGet('tiny.audio', 'muted', false))).toBe(true)
})

test('the app grid sits next to Finder and launches apps; dock magnification only grows the hovered icon', async ({ desktop }) => {
  const { page } = desktop
  const items = page.locator('.dock .item')
  await expect(items.first()).toHaveAttribute('data-app', 'org.tiny.profile')
  await expect(items.nth(1)).toHaveAttribute('data-app', 'org.tiny.finder')
  await expect(items.nth(2)).toHaveAttribute('data-app', 'launchpad')

  await items.nth(3).hover()
  await expect.poll(() => items.evaluateAll((els) => els.filter((e) => (e as HTMLElement).style.getPropertyValue('--scale')).length)).toBe(1)

  await items.nth(2).click()
  await expect(page.locator('.appgrid')).toBeVisible()
  await page.locator('.appgrid-search').fill('term')
  await expect(page.locator('.appgrid-app:not([hidden])')).toHaveCount(1)
  await page.locator('.appgrid-app:not([hidden])').click()
  await expect(page.locator('.appgrid')).toHaveCount(0)
  await expect(page.locator('iframe[title="Terminal"]')).toBeVisible()
})

test('Settings shows icons for pinned apps', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.settings').click()
  const ui = desktop.win('System Settings').frameLocator('iframe')
  await ui.locator('.sidebar .item', { hasText: 'Desktop & Dock' }).click()
  const img = ui.locator('.pinned .line[data-app="org.tiny.terminal"] img')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)
})
