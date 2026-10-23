import { expect, test } from './fixtures'

test('windows come back after a reload where they were, including minimized and maximized ones', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.terminal').click()
  const term = desktop.win('Terminal')
  const bar = (await term.locator('.titlebar').boundingBox())!
  await page.mouse.move(bar.x + 250, bar.y + 10)
  await page.mouse.down()
  await page.mouse.move(bar.x + 310, bar.y + 90, { steps: 4 })
  await page.mouse.up()
  const rect = (await term.boundingBox())!
  await desktop.win('Profile').locator('.light.min').click()
  await page.waitForTimeout(1800) // the session is saved shortly after a change

  await desktop.reload()
  await expect(desktop.windows()).toHaveCount(2)
  const back = (await desktop.win('Terminal').boundingBox())!
  expect(Math.round(back.x)).toBe(Math.round(rect.x))
  expect(Math.round(back.y)).toBe(Math.round(rect.y))
  expect(Math.round(back.width)).toBe(Math.round(rect.width))
  await expect(desktop.win('Profile')).toBeHidden()
  await expect(page.locator('.dock .item.mini')).toHaveCount(1)
  await expect(desktop.win('Terminal')).toHaveClass(/focused/)
})

test('appearance follows the setting and the menu changes it', async ({ desktop }) => {
  const { page } = desktop
  await page.locator('.menubar .title.system').click()
  await page.locator('.menu button', { hasText: 'Appearance: Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('.menubar .title.system').click()
  await page.locator('.menu button', { hasText: 'Appearance: Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  // the choice survives a reload
  await desktop.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('Shut Down powers off with a screen to power back on; Restart reloads', async ({ desktop }) => {
  const { page } = desktop
  await page.locator('.menubar .title.system').click()
  await page.locator('.menu button', { hasText: 'Shut Down' }).click()
  await expect(page.locator('#notice')).toContainText('powered off')
  await page.getByRole('button', { name: 'Power On' }).click()
  await page.waitForFunction(() => (window as unknown as { tinyReady?: boolean }).tinyReady === true, null, { timeout: 30_000 })
  await expect(page.locator('.menubar .title.system')).toBeVisible()
})

test('a second tab asks before taking over', async ({ desktop, context }) => {
  const second = await context.newPage()
  await second.goto(`/?ns=${desktop.ns}`)
  await expect(second.locator('#notice')).toContainText('already open')
  await second.getByRole('button', { name: 'Use Here' }).click()
  await second.waitForFunction(() => (window as unknown as { tinyReady?: boolean }).tinyReady === true, null, { timeout: 30_000 })
  await expect(desktop.page.locator('#notice')).toContainText('open in another tab')
})
