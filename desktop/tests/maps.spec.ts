import type { FrameLocator } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

async function open(desktop: Desktop): Promise<FrameLocator> {
  await desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.maps'))
  const frame = desktop.win('Maps').frameLocator('iframe')
  await expect(frame.locator('#map')).toBeVisible()
  return frame
}

const worldTransform = (frame: FrameLocator): Promise<string> =>
  frame.locator('#world').getAttribute('transform').then((t) => t ?? '')

/** The `scale(…)` factor out of the #world group's transform attribute. */
const scaleNow = async (frame: FrameLocator): Promise<number> => {
  const t = await worldTransform(frame)
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? Number.NaN)
}

test('the world renders and a drag pans it', async ({ desktop }) => {
  const { page } = desktop
  const frame = await open(desktop)
  await expect(frame.locator('.city')).toHaveCount(25)
  for (const name of ['Tokyo', 'Paris', 'São Paulo', 'Cairo'])
    await expect(frame.locator(`.city[data-name="${name}"] text`)).toBeVisible()

  const before = await worldTransform(frame)
  const tokyo = frame.locator('.city[data-name="Tokyo"]')
  const was = (await tokyo.boundingBox())!
  const map = (await frame.locator('#map').boundingBox())!
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2)
  await page.mouse.down()
  await page.mouse.move(map.x + map.width / 2 + 50, map.y + map.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect.poll(() => worldTransform(frame)).not.toBe(before)
  const gone = (await tokyo.boundingBox())!
  expect(Math.round(gone.x - was.x)).toBe(50)
})

test('zoom in changes the scale and the indicator', async ({ desktop }) => {
  const frame = await open(desktop)
  const before = await scaleNow(frame)
  expect(before).toBeGreaterThan(0)
  await frame.getByRole('button', { name: 'Zoom in' }).click()
  await frame.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(() => scaleNow(frame)).toBeGreaterThan(before * 1.6)
  await expect(frame.locator('#scale')).toContainText('169')
})

test('searching for Tokyo flies there and shows its pin card', async ({ desktop }) => {
  const frame = await open(desktop)
  const before = await worldTransform(frame)
  const input = frame.locator('#search')
  await input.fill('Tokyo')
  await input.press('Enter')
  await expect(frame.locator('#card')).toBeVisible()
  await expect(frame.locator('#card')).toContainText('Japan')
  await expect.poll(() => worldTransform(frame)).not.toBe(before)
  // the pin comes to rest near the center of the map
  const area = (await frame.locator('#map').boundingBox())!
  await expect
    .poll(async () => {
      const p = (await frame.locator('#pin').boundingBox())!
      return Math.hypot(
        p.x + p.width / 2 - (area.x + area.width / 2),
        p.y + p.height / 2 - (area.y + area.height / 2),
      )
    })
    .toBeLessThan(40)
})

test('a chosen city zooms in, the picture is worth keeping', async ({ desktop }) => {
  const { page } = desktop
  const frame = await open(desktop)
  const input = frame.locator('#search')
  await input.fill('Sydney')
  await input.press('Enter')
  await expect(frame.locator('#card')).toContainText('Australia')
  await frame.locator('#zoomto').click()
  let still = ''
  await expect
    .poll(async () => {
      const t = await worldTransform(frame)
      const settled = t !== '' && t === still
      still = t
      return settled
    })
    .toBe(true)
  await page.screenshot({ path: 'test-results/maps.png' })
})
