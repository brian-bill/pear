import { expect, test, type Desktop } from './fixtures'

const PICS = '/Users/pear/Pictures'

/** Draw a w x h PNG of one color and store it in the VFS, owned by the user. */
async function png(desktop: Desktop, name: string, w: number, h: number, color: string): Promise<string> {
  const path = `${PICS}/${name}`
  await desktop.page.evaluate(
    async ([p, w, h, color]) => {
      const c = document.createElement('canvas')
      c.width = w as number
      c.height = h as number
      const g = c.getContext('2d')!
      g.fillStyle = color as string
      g.fillRect(0, 0, c.width, c.height)
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
      const kern = window.tiny!.kernel
      await kern.mkdir(PICS_DIR).catch(() => {})
      await kern.writeFile(p as string, new Uint8Array(await blob.arrayBuffer()))
      await kern.chown(p as string, 501, 20)
    },
    [path, w, h, color] as const,
  )
  return path
}
declare const PICS_DIR: string

const open = (desktop: Desktop, path: string) => desktop.page.evaluate((p) => window.tiny!.kernel.launchOpen(p), path)

test('shows a PNG from bytes, with dimensions and info, zoom, and rotation', async ({ desktop }) => {
  const { page } = desktop
  await page.addInitScript(`window.PICS_DIR = '${PICS}'`)
  await page.evaluate(`window.PICS_DIR = '${PICS}'`)
  const a = await png(desktop, 'a.png', 200, 100, '#ff0000')
  await open(desktop, a)
  const win = desktop.win('a.png')
  const frame = win.frameLocator('iframe')
  const img = frame.locator('#img')
  await expect(img).toBeVisible()
  expect(await img.evaluate((i: HTMLImageElement) => [i.src.startsWith('blob:'), i.naturalWidth, i.naturalHeight])).toEqual([true, 200, 100])
  await expect(frame.locator('#dims')).toHaveText('200 × 100')
  await expect(frame.locator('#zoom')).toHaveText('100%') // small image: fit never enlarges

  await frame.getByRole('button', { name: 'Info' }).click()
  await expect(frame.locator('#info')).toContainText('200 × 100')
  await expect(frame.locator('#info')).toContainText('image/png')

  await frame.getByRole('button', { name: 'Zoom in' }).click()
  await expect(frame.locator('#zoom')).toHaveText('125%')
  await frame.getByRole('button', { name: 'Zoom out' }).click()
  await frame.getByRole('button', { name: 'Zoom out' }).click()
  await expect(frame.locator('#zoom')).toHaveText('80%')
  await frame.getByRole('button', { name: 'Actual size' }).click()
  await expect(frame.locator('#zoom')).toHaveText('100%')
  await frame.locator('#stage').click()
  await page.keyboard.press('Meta+=')
  await expect(frame.locator('#zoom')).toHaveText('125%')
  await page.keyboard.press('Meta+0')
  await expect(frame.locator('#zoom')).toHaveText('100%')

  // rotating turns the picture: its bounding box swaps width and height
  const box = () => img.evaluate((i) => { const r = i.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })
  expect(await box()).toEqual([200, 100])
  await frame.getByRole('button', { name: 'Rotate right' }).click()
  expect(await box()).toEqual([100, 200])
  await frame.getByRole('button', { name: 'Rotate left' }).click()
  expect(await box()).toEqual([200, 100])
})

test('a big image fits the window and can be panned; actual size overflows', async ({ desktop }) => {
  const { page } = desktop
  await page.evaluate(`window.PICS_DIR = '${PICS}'`)
  const big = await png(desktop, 'big.png', 2000, 1000, '#0000ff')
  await open(desktop, big)
  const frame = desktop.win('big.png').frameLocator('iframe')
  const img = frame.locator('#img')
  await expect(img).toBeVisible()
  const stage = frame.locator('#stage')
  const fits = async () => {
    const s = (await stage.boundingBox())!
    const i = (await img.boundingBox())!
    return i.width <= s.width && i.height <= s.height
  }
  expect(await fits()).toBe(true)
  await frame.getByRole('button', { name: 'Actual size' }).click()
  await expect(frame.locator('#zoom')).toHaveText('100%')
  expect(await fits()).toBe(false)

  const before = (await img.boundingBox())!
  const s = (await stage.boundingBox())!
  await page.mouse.move(s.x + 200, s.y + 150)
  await page.mouse.down()
  await page.mouse.move(s.x + 260, s.y + 120, { steps: 4 })
  await page.mouse.up()
  const after = (await img.boundingBox())!
  expect(Math.round(after.x - before.x)).toBe(60)
  expect(Math.round(after.y - before.y)).toBe(-30)
  await frame.getByRole('button', { name: 'Zoom to fit' }).click()
  expect(await fits()).toBe(true)
})

test('arrow keys move between the images of the folder', async ({ desktop }) => {
  const { page } = desktop
  await page.evaluate(`window.PICS_DIR = '${PICS}'`)
  const one = await png(desktop, 'one.png', 10, 10, '#ff0000')
  await png(desktop, 'two.png', 20, 10, '#00ff00')
  await png(desktop, 'three.png', 30, 10, '#0000ff')
  await page.evaluate(() => window.tiny!.kernel.writeFile('/Users/pear/Pictures/notes.txt', new TextEncoder().encode('x')))
  await open(desktop, one)
  // sorted by name: one, three, two (the text file is skipped)
  const win = () => desktop.win(/\.png/)
  const frame = win().frameLocator('iframe')
  await expect(win().locator('.name')).toHaveText('one.png')
  await expect(frame.locator('#index')).toHaveText('1 of 3')
  await frame.locator('#stage').click()
  await page.keyboard.press('ArrowRight')
  await expect(win().locator('.name')).toHaveText('three.png')
  await expect(frame.locator('#dims')).toHaveText('30 × 10')
  await page.keyboard.press('ArrowRight')
  await expect(win().locator('.name')).toHaveText('two.png')
  await expect(frame.locator('#dims')).toHaveText('20 × 10')
  await page.keyboard.press('ArrowRight') // wraps around
  await expect(win().locator('.name')).toHaveText('one.png')
  await page.keyboard.press('ArrowLeft')
  await expect(win().locator('.name')).toHaveText('two.png')
  await expect(desktop.windows().filter({ hasText: /\.png/ })).toHaveCount(1)
})

test('a file that is not an image is refused politely', async ({ desktop }) => {
  const { page } = desktop
  await page.evaluate(`window.PICS_DIR = '${PICS}'`)
  await page.evaluate(async () => {
    const kern = window.tiny!.kernel
    await kern.mkdir('/Users/pear/Pictures').catch(() => {})
    await kern.writeFile('/Users/pear/Pictures/fake.png', new TextEncoder().encode('not a png'))
    await kern.chown('/Users/pear/Pictures/fake.png', 501, 20)
  })
  await open(desktop, `${PICS}/fake.png`)
  await expect(desktop.win('Preview').locator('.sheet')).toContainText('could not be opened')
})
