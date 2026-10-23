import { expect, test, type Desktop } from './fixtures'
import type { FrameLocator, Page } from '@playwright/test'

const DOCS = '/Users/pear/Documents'

const read = (desktop: Desktop, path: string) =>
  desktop.page.evaluate((p) => window.tiny!.kernel.readFile(p).then((b) => new TextDecoder().decode(b)), path)

/** Launch Freeform and wait for its window content. Anchor on the app frame: the window renames to the board. */
async function launch(desktop: Desktop): Promise<FrameLocator> {
  await desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.freeform'))
  const win = desktop.page.locator('.window', { has: desktop.page.locator('iframe[title="Freeform"]') }).first()
  const frame = win.frameLocator('iframe[title="Freeform"]')
  await expect(frame.locator('#board svg')).toBeVisible()
  // the frame settles (boot animation, layout) before its canvas is measured
  await desktop.page.waitForTimeout(400)
  return frame
}

/** Absolute page coordinates of the board's SVG, for page-level mouse work inside the iframe. */
async function canvasBox(frame: FrameLocator): Promise<{ x: number; y: number }> {
  const box = await frame.locator('#board svg').boundingBox()
  expect(box).toBeTruthy()
  return { x: box!.x, y: box!.y }
}

async function drag(page: import('@playwright/test').Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 4): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}

test('a pen stroke and a rect appear, and undo/redo walk them', async ({ desktop }) => {
  const { page } = desktop
  const frame = await launch(desktop)
  const { x, y } = await canvasBox(frame)

  // Pen: draw a stroke
  await frame.getByRole('button', { name: 'Pen', exact: true }).click()
  await drag(page, { x: x + 80, y: y + 120 }, { x: x + 150, y: y + 170 }, 6)
  await expect(frame.locator('#board svg .item')).toHaveCount(1)
  await expect(frame.locator('#board svg .item')).toHaveJSProperty('tagName', 'path')

  // Rect: drag out a rectangle
  await frame.getByRole('button', { name: 'Rect', exact: true }).click()
  await drag(page, { x: x + 240, y: y + 100 }, { x: x + 360, y: y + 180 })
  const items = frame.locator('#board svg .item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(1)).toHaveJSProperty('tagName', 'rect')

  // wheel pans vertically (hold nothing), a plain two-finger scroll
  await page.mouse.move(x + 400, y + 300)
  await page.mouse.wheel(0, 120)
  const worldTransform = () => frame.locator('#board svg #world').evaluate((el) => (el as HTMLElement).style.transform)
  await expect.poll(worldTransform).toBe('translate(24px, -96px) scale(1)')

  // undo via the Edit menu shortcut; redo brings it back
  await page.keyboard.press('Meta+z')
  await expect(items).toHaveCount(1)
  await page.keyboard.press('Meta+Shift+z')
  await expect(items).toHaveCount(2)
})

test('select, move with a drag, delete from the keyboard', async ({ desktop }) => {
  const { page } = desktop
  const frame = await launch(desktop)
  const { x, y } = await canvasBox(frame)

  await frame.getByRole('button', { name: 'Pen', exact: true }).click()
  await drag(page, { x: x + 60, y: y + 60 }, { x: x + 120, y: y + 80 }, 5)
  await frame.getByRole('button', { name: 'Rect', exact: true }).click()
  await drag(page, { x: x + 220, y: y + 140 }, { x: x + 330, y: y + 220 })
  const items = frame.locator('#board svg .item')
  await expect(items).toHaveCount(2)
  const rect = items.nth(1)
  await expect(rect).toHaveJSProperty('tagName', 'rect')

  // click the rect with the Select tool: it becomes the selection
  await frame.getByRole('button', { name: 'Select', exact: true }).click()
  await page.mouse.click(x + 275, y + 180)
  await expect(rect).toHaveClass(/sel/)

  // drag it a little: the rect's x moves along
  const x0 = await rect.getAttribute('x')
  await drag(page, { x: x + 275, y: y + 180 }, { x: x + 300, y: y + 195 }, 4)
  const x1 = await rect.getAttribute('x')
  expect(Number(x1)).toBeGreaterThan(Number(x0))
  await expect(rect).toHaveClass(/sel/)

  // Delete removes the selection, and the Edit menu item is there for it too
  await page.keyboard.press('Delete')
  await expect(items).toHaveCount(1)
  await page.keyboard.press('Meta+z')
  await expect(items).toHaveCount(2)
})

test('saving asks once, then writes silently; the file reopens with its items', async ({ desktop }) => {
  const { page } = desktop
  const frame = await launch(desktop)
  const { x, y } = await canvasBox(frame)

  await frame.getByRole('button', { name: 'Rect', exact: true }).click()
  await drag(page, { x: x + 160, y: y + 130 }, { x: x + 300, y: y + 210 })
  const first = frame
  await expect(first.locator('#board svg .item')).toHaveCount(1)

  // Untitled: Cmd+S opens Desktop's save panel
  await page.keyboard.press('Meta+s')
  const sheet = desktop.win('Freeform').locator('.sheet')
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Name').fill('Board.freeboard')
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(async () => {
      try {
        return await read(desktop, `${DOCS}/Board.freeboard`)
      } catch {
        return null // not written yet (ENOENT): keep waiting
      }
    }, { intervals: [300, 600] })
    .toBeTruthy()
  const disk = JSON.parse(await read(desktop, `${DOCS}/Board.freeboard`)) as { version: number; items: Array<{ kind: string }> }
  expect(disk.version).toBe(1)
  expect(disk.items.map((i) => i.kind)).toEqual(['rect'])
  await expect(desktop.win('Board')).toBeVisible()

  // a second save is silent, and a new edit shows the unsaved dot
  await page.keyboard.press('Meta+s')
  await expect(desktop.win('Board').locator('.sheet')).toHaveCount(0)
  await frame.getByRole('button', { name: 'Pen', exact: true }).click()
  await drag(page, { x: x + 60, y: y + 320 }, { x: x + 140, y: y + 350 }, 5)
  await expect(frame.locator('#board svg .item')).toHaveCount(2)
  await expect(desktop.win('Board')).toHaveClass(/edited/)

  // close it, declining the save prompt
  await desktop.win('Board').locator('.light.close').click()
  await desktop.win('Board').locator('.sheet').getByRole('button', { name: "Don't Save", exact: true }).click()
  await expect(desktop.win('Board')).toHaveCount(0)

  // reopen the saved board through the Open panel (or a fresh launch with the file)
  await desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.freeform'))
  const again = desktop.page.locator('.window', { has: desktop.page.locator('iframe[title="Freeform"]') }).first()
  const frame2 = again.frameLocator('iframe[title="Freeform"]')
  await expect(frame2.locator('#board svg')).toBeVisible()
  await page.keyboard.press('Meta+o')
  const open = again.locator('.sheet')
  await expect(open).toBeVisible()
  await open.locator('.files .entry', { hasText: 'Board.freeboard' }).click()
  await open.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(desktop.win('Board')).toBeVisible()
  await expect(frame2.locator('#board svg .item')).toHaveCount(1)
  // the pen edit was not saved; only the rect came back
  await expect(desktop.win('Board')).not.toHaveClass(/edited/)

  await desktop.page.screenshot({ path: 'test-results/freeform.png' })
})
