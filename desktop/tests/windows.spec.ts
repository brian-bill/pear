import { expect, test } from './fixtures'

test('boots to a menu bar, a dock and the Profile window on first run', async ({ desktop }) => {
  const { page } = desktop
  await expect(page.locator('.menubar .title.system')).toHaveAccessibleName('Pear')
  await expect(page.locator('.menubar .clock')).not.toBeEmpty()
  await expect(desktop.dock('org.tiny.terminal')).toBeVisible()
  await expect(desktop.dock('org.tiny.profile')).toBeVisible()
  await expect(desktop.win('Profile')).toBeVisible()
  await expect(desktop.win('Profile').frameLocator('iframe').locator('dl')).toContainText('Vanilla 1.0')
  await expect(page.locator('.menubar .title.app')).toHaveText('Profile')
})

test('windows move, resize, stack and close', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.terminal').click()
  await desktop.dock('org.tiny.terminal').click() // already running: focuses, does not open a second
  const term = desktop.win('Terminal')
  await expect(term).toHaveCount(1)
  await expect(term).toHaveClass(/focused/)
  await expect(desktop.win('Profile')).not.toHaveClass(/focused/)

  const before = (await term.boundingBox())!
  const bar = term.locator('.titlebar')
  const b = (await bar.boundingBox())!
  await page.mouse.move(b.x + 200, b.y + 10)
  await page.mouse.down()
  await page.mouse.move(b.x + 260, b.y + 70, { steps: 5 })
  await page.mouse.up()
  const moved = (await term.boundingBox())!
  expect(Math.round(moved.x - before.x)).toBe(60)
  expect(Math.round(moved.y - before.y)).toBe(60)

  // resize from the bottom-right corner
  const se = (await term.locator('.handle.se').boundingBox())!
  await page.mouse.move(se.x + 4, se.y + 4)
  await page.mouse.down()
  await page.mouse.move(se.x + 54, se.y + 34, { steps: 5 })
  await page.mouse.up()
  const grown = (await term.boundingBox())!
  expect(Math.round(grown.width - moved.width)).toBe(50)
  expect(Math.round(grown.height - moved.height)).toBe(30)

  // a window cannot be made smaller than its minimum
  const nw = (await term.locator('.handle.se').boundingBox())!
  await page.mouse.move(nw.x + 4, nw.y + 4)
  await page.mouse.down()
  await page.mouse.move(nw.x - 800, nw.y - 600, { steps: 4 })
  await page.mouse.up()
  const small = (await term.boundingBox())!
  expect(small.width).toBeGreaterThanOrEqual(280)

  // clicking the other window raises it
  await desktop.win('Profile').locator('.titlebar').click({ position: { x: 150, y: 10 } })
  await expect(desktop.win('Profile')).toHaveClass(/focused/)
  await expect(term).not.toHaveClass(/focused/)
  const z = (w: string) => desktop.win(w).evaluate((el) => Number(el.style.zIndex))
  expect(await z('Profile')).toBeGreaterThan(await z('Terminal'))

  // bring the Terminal forward again so its close button is not under the Profile window
  await desktop.dock('org.tiny.terminal').click()
  await expect(term).toHaveClass(/focused/)
  await term.locator('.light.close').click()
  await expect(desktop.windows()).toHaveCount(1)
  await expect(desktop.dock('org.tiny.terminal')).not.toHaveClass(/running/)
})

test('a window cannot be dragged out of reach', async ({ desktop }) => {
  const { page } = desktop
  const win = desktop.win('Profile')
  const bar = (await win.locator('.titlebar').boundingBox())!
  await page.mouse.move(bar.x + 150, bar.y + 10)
  await page.mouse.down()
  await page.mouse.move(bar.x + 150, -400, { steps: 4 })
  await page.mouse.move(-2000, 300, { steps: 4 })
  await page.mouse.up()
  const box = (await win.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(28) // not under the menu bar
  expect(box.x + box.width).toBeGreaterThan(40) // some of it stays on screen
})

test('minimize goes to the dock and comes back; maximize toggles and a drag restores', async ({ desktop }) => {
  const { page } = desktop
  const profile = desktop.win('Profile')
  await profile.locator('.light.min').click()
  await expect(profile).toBeHidden()
  const mini = page.locator('.dock .item.mini')
  await expect(mini).toHaveCount(1)
  await expect(mini).toHaveAttribute('aria-label', 'Profile')
  await mini.click()
  await expect(profile).toBeVisible()
  await expect(profile).toHaveClass(/focused/)
  await expect(page.locator('.dock .item.mini')).toHaveCount(0)

  await desktop.dock('org.tiny.terminal').click()
  const term = desktop.win('Terminal')
  const original = (await term.boundingBox())!
  await term.locator('.titlebar').dblclick({ position: { x: 300, y: 10 } })
  await expect(term).toHaveClass(/maximized/)
  await expect.poll(async () => Math.round((await term.boundingBox())!.width)).toBe(1280)
  expect(Math.round((await term.boundingBox())!.y)).toBe(28)
  await term.locator('.titlebar').dblclick({ position: { x: 300, y: 10 } })
  await expect(term).not.toHaveClass(/maximized/)
  await expect.poll(async () => Math.round((await term.boundingBox())!.width)).toBe(Math.round(original.width))

  await term.locator('.light.max').click()
  await expect.poll(async () => Math.round((await term.boundingBox())!.width)).toBe(1280)
  const bar = (await term.locator('.titlebar').boundingBox())!
  await page.mouse.move(bar.x + 600, bar.y + 10)
  await page.mouse.down()
  await page.mouse.move(bar.x + 640, bar.y + 120, { steps: 5 })
  await page.mouse.up()
  await expect(term).not.toHaveClass(/maximized/)
  expect((await term.boundingBox())!.width).toBeLessThan(1280)
})

test('keyboard: Cmd+W closes, Cmd+M minimizes, Cmd+` and Alt+Tab cycle; Ctrl+W stays with the terminal', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.terminal').click()
  await desktop.win('Terminal').click({ position: { x: 100, y: 100 } })
  await page.keyboard.press('Control+w') // the shell's, not the window's
  await expect(desktop.win('Terminal')).toHaveCount(1)
  await page.keyboard.press('Meta+`')
  await expect(desktop.win('Profile')).toHaveClass(/focused/)
  await page.keyboard.press('Meta+m')
  await expect(desktop.win('Profile')).toBeHidden()
  await page.keyboard.press('Alt+Tab')
  await expect(desktop.win('Terminal')).toHaveClass(/focused/)
  await page.keyboard.press('Meta+w')
  await expect(desktop.win('Terminal')).toHaveCount(0)
})

test('the menu bar follows the focused app and its menus work', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.terminal').click()
  await expect(page.locator('.menubar .title.app')).toHaveText('Terminal')
  await expect(page.locator('.menubar .title', { hasText: 'Edit' })).toBeVisible()
  await page.locator('.menubar .title', { hasText: 'Window' }).click()
  await expect(page.locator('.menu')).toContainText('Minimize')
  await page.locator('.menu button', { hasText: 'Minimize' }).click()
  await expect(desktop.win('Terminal')).toBeHidden()
  await expect(page.locator('.menu')).toHaveCount(0)
  // clicking the desktop itself leaves no app focused
  await desktop.win('Profile').locator('.light.close').click()
  await expect(page.locator('.menubar .title.app')).toHaveCount(0)
})
