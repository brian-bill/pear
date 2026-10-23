import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const HOME = '/Users/pear'

/** Files owned by the user, made through the page's kernel. */
async function prepare(page: Page, files: Record<string, string>, dirs: string[] = []): Promise<void> {
  await page.evaluate(
    async ({ files, dirs }) => {
      const k = window.tiny!.kernel
      for (const d of dirs) {
        await k.mkdir(d, { recursive: true })
        await k.chown(d, 501, 20)
      }
      for (const [p, text] of Object.entries(files)) {
        await k.writeFile(p, new TextEncoder().encode(text))
        await k.chown(p, 501, 20)
      }
    },
    { files, dirs },
  )
}

/** The Finder window's title follows the folder, so find its frame by the app name instead. */
async function openFinder(desktop: { dock(app: string): ReturnType<Page['locator']>; page: Page }) {
  const ui = desktop.page.frameLocator('iframe[title="Finder"]').first()
  await expect(async () => {
    if (!(await desktop.page.locator('iframe[title="Finder"]').count())) await desktop.dock('org.tiny.finder').click()
    await expect(ui.locator('#sidebar')).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 20_000 })
  await expect(ui.locator('#sidebar')).toBeVisible()
  return { ui }
}

const exists = (page: Page, p: string) => page.evaluate((x) => window.tiny!.kernel.exists(x), p)

test('navigates by double click, breadcrumbs, sidebar and history', async ({ desktop }) => {
  const { page } = desktop
  await prepare(page, { [`${HOME}/Documents/Projects/readme.txt`]: 'hello' }, [`${HOME}/Documents/Projects`])
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await expect(desktop.win('Documents')).toBeVisible()
  await expect(ui.locator('#files .item')).toHaveCount(1)
  await ui.locator('#files .item', { hasText: 'Projects' }).dblclick()
  await expect(desktop.win('Projects')).toBeVisible()
  await expect(ui.locator('#files .item', { hasText: 'readme.txt' })).toBeVisible()
  await expect(ui.locator('#pathbar .crumb')).toHaveText(['Macintosh HD', 'Users', 'pear', 'Documents', 'Projects'])
  await expect(ui.locator('#status')).toContainText('1 item')

  await ui.locator('#back').click()
  await expect(desktop.win('Documents')).toBeVisible()
  await ui.locator('#fwd').click()
  await expect(desktop.win('Projects')).toBeVisible()
  await ui.locator('#pathbar .crumb', { hasText: 'Users' }).click()
  await expect(ui.locator('#files .item', { hasText: 'pear' })).toBeVisible()
  await ui.locator('#files .item', { hasText: 'pear' }).click()
  await page.keyboard.press('Meta+ArrowDown')
  await expect(ui.locator('#files .item', { hasText: 'Documents' })).toBeVisible()
  await page.keyboard.press('Meta+ArrowUp')
  await expect(ui.locator('#files .item', { hasText: 'pear' })).toBeVisible()
})

test('new folder, rename, duplicate, trash, put back and empty trash', async ({ desktop }) => {
  const { page } = desktop
  await prepare(page, { [`${HOME}/Documents/a.txt`]: 'aaa' })
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await expect(ui.locator('#files .item', { hasText: 'a.txt' })).toBeVisible()

  await page.keyboard.press('Meta+Shift+N')
  const input = ui.locator('input.rename')
  await expect(input).toBeFocused()
  await page.keyboard.type('Stuff')
  await page.keyboard.press('Enter')
  await expect(ui.locator('#files .item', { hasText: 'Stuff' })).toBeVisible()
  expect(await exists(page, `${HOME}/Documents/Stuff`)).toBe(true)

  // rename via context menu
  await ui.locator('#files .item', { hasText: 'a.txt' }).click({ button: 'right' })
  await page.locator('.menu button', { hasText: 'Rename' }).click()
  await expect(input).toBeFocused()
  await input.fill('b.txt')
  await page.keyboard.press('Enter')
  await expect(ui.locator('#files .item', { hasText: 'b.txt' })).toBeVisible()
  expect(await exists(page, `${HOME}/Documents/a.txt`)).toBe(false)

  // duplicate
  await page.keyboard.press('Meta+d')
  await expect(ui.locator('#files .item', { hasText: 'b copy.txt' })).toBeVisible()

  // trash
  await page.keyboard.press('Meta+Backspace')
  await expect(ui.locator('#files .item', { hasText: 'b copy.txt' })).toHaveCount(0)
  expect(await exists(page, `${HOME}/.Trash/b copy.txt`)).toBe(true)

  // put back
  await ui.locator('#sidebar .item', { hasText: 'Trash' }).click()
  await expect(ui.locator('#files .item', { hasText: 'b copy.txt' })).toBeVisible()
  await ui.locator('#files .item', { hasText: 'b copy.txt' }).click({ button: 'right' })
  await page.locator('.menu button', { hasText: 'Put Back' }).click()
  // like the Mac, Put Back shows the item where it went
  await expect(desktop.win('Documents')).toBeVisible()
  await expect(ui.locator('#files .item.selected', { hasText: 'b copy.txt' })).toBeVisible()
  expect(await exists(page, `${HOME}/Documents/b copy.txt`)).toBe(true)

  // empty trash asks first
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await ui.locator('#files .item', { hasText: 'b.txt' }).click()
  await page.keyboard.press('Meta+Backspace')
  await expect(ui.locator('#sidebar [data-empty]')).toBeVisible()
  await ui.locator('#sidebar [data-empty]').click()
  await page.locator('.sheet button, .dialog button', { hasText: 'Empty Trash' }).first().click()
  await expect.poll(() => page.evaluate((h) => window.tiny!.kernel.readdir(`${h}/.Trash`).then((l) => l.length), HOME)).toBe(0)
})

test('list view sorts, selection with keyboard and type-to-select, quick preview', async ({ desktop }) => {
  const { page } = desktop
  await prepare(page, { [`${HOME}/Documents/apple.txt`]: 'a', [`${HOME}/Documents/banana.txt`]: 'bbbbbbbb', [`${HOME}/Documents/cherry.md`]: '# hi' })
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await ui.locator('[data-view="list"]').click()
  await expect(ui.locator('table.list tbody tr')).toHaveCount(3)
  await ui.locator('.colbtn', { hasText: 'Size' }).click()
  await expect(ui.locator('table.list tbody tr').first()).toContainText('apple.txt')
  await ui.locator('.colbtn', { hasText: 'Size' }).click()
  await expect(ui.locator('table.list tbody tr').first()).toContainText('banana.txt')
  await ui.locator('.colbtn', { hasText: 'Name' }).click()

  await ui.locator('table.list tbody tr').first().click()
  await page.keyboard.press('ArrowDown')
  await expect(ui.locator('tr.selected')).toContainText('banana.txt')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(ui.locator('tr.selected')).toHaveCount(2)
  await page.keyboard.press('Meta+a')
  await expect(ui.locator('tr.selected')).toHaveCount(3)
  await page.keyboard.press('c')
  await expect(ui.locator('tr.selected')).toHaveCount(1)
  await expect(ui.locator('tr.selected')).toContainText('cherry.md')

  await page.keyboard.press(' ')
  await expect(ui.locator('#preview')).toContainText('# hi')
  await page.keyboard.press(' ')
  await expect(ui.locator('#preview')).toBeHidden()
})

test('search, tags and saved searches', async ({ desktop }) => {
  const { page } = desktop
  await prepare(page, { [`${HOME}/Documents/report.txt`]: 'quarterly numbers', [`${HOME}/Desktop/other.txt`]: 'x' })
  await page.evaluate(async (p) => {
    const k = window.tiny!.kernel
    await k.setxattr(p, 'user.tags', 'red')
    const port = await k.lookup('tiny.search')
    await k.request(port, { op: 'index.sync' })
  }, `${HOME}/Documents/report.txt`)
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await ui.locator('#q').fill('report')
  await expect(ui.locator('#files .item', { hasText: 'report.txt' })).toBeVisible()
  await expect(ui.locator('#scopebar')).toBeVisible()
  await ui.locator('[data-scope="mac"]').click()
  await expect(ui.locator('#files .item', { hasText: 'report.txt' })).toBeVisible()

  // save it as a smart folder
  await ui.locator('#save-search').click()
  await page.locator('.sheet input, .dialog input').first().fill('My Reports')
  await page.keyboard.press('Enter')
  await expect(ui.locator('#sidebar .item', { hasText: 'My Reports' })).toBeVisible()
  expect(await exists(page, `${HOME}/Library/Saved Searches/My Reports.savedSearch`)).toBe(true)

  // tags view
  await ui.locator('#q').fill('')
  await ui.locator('#sidebar .item', { hasText: 'Red' }).click()
  await expect(ui.locator('#files .item', { hasText: 'report.txt' })).toBeVisible()
  await expect(ui.locator('#files .item')).toHaveCount(1)

  // saved search opens again
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await ui.locator('#sidebar .item', { hasText: 'My Reports' }).click()
  await expect(ui.locator('#files .item', { hasText: 'report.txt' })).toBeVisible()
})

test('Get Info shows details, edits permissions and tags', async ({ desktop }) => {
  const { page } = desktop
  await prepare(page, { [`${HOME}/Documents/note.txt`]: 'twelve bytes' })
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await ui.locator('#files .item', { hasText: 'note.txt' }).click()
  await page.keyboard.press('Meta+i')
  const info = desktop.win('note.txt Info')
  await expect(info).toBeVisible()
  const iui = info.frameLocator('iframe')
  await expect(iui.locator('#i-size')).toHaveText('12 bytes')
  await expect(iui.locator('dl').first()).toContainText('Plain text')
  await expect(iui.locator('#i-mode')).toHaveText('644')

  await iui.locator('input[data-shift="0"][data-bit="4"]').uncheck()
  await expect(iui.locator('#i-mode')).toHaveText('640')
  expect(await page.evaluate((p) => window.tiny!.kernel.stat(p).then((s) => s.mode & 0o777), `${HOME}/Documents/note.txt`)).toBe(0o640)

  await iui.locator('[data-tag="green"]').click()
  await expect.poll(() => page.evaluate((p) => window.tiny!.kernel.getxattr(p, 'user.tags'), `${HOME}/Documents/note.txt`)).toBe('green')
  await expect(iui.locator('[data-tag="green"]')).toHaveAttribute('aria-pressed', 'true')
})

test('copy and paste between folders, drag and drop onto a sidebar folder', async ({ desktop }) => {
  const { page } = desktop
  await prepare(page, { [`${HOME}/Documents/one.txt`]: '1', [`${HOME}/Documents/two.txt`]: '2' })
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await ui.locator('#files .item', { hasText: 'one.txt' }).click()
  await page.keyboard.press('Meta+c')
  await ui.locator('#sidebar .item', { hasText: 'Downloads' }).click()
  await page.keyboard.press('Meta+v')
  await expect(ui.locator('#files .item', { hasText: 'one.txt' })).toBeVisible()
  expect(await exists(page, `${HOME}/Documents/one.txt`)).toBe(true)

  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await ui.locator('#files .item', { hasText: 'two.txt' }).dragTo(ui.locator('#sidebar .item', { hasText: 'Desktop' }))
  await expect.poll(() => exists(page, `${HOME}/Desktop/two.txt`)).toBe(true)
  expect(await exists(page, `${HOME}/Documents/two.txt`)).toBe(false)
})

test('files dropped from the computer are written into the folder; context menu on empty space', async ({ desktop }) => {
  const { page } = desktop
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Downloads' }).click()
  await ui.locator('#scroll').evaluate((el) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['dropped contents'], 'dropped.txt', { type: 'text/plain' }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(ui.locator('#files .item', { hasText: 'dropped.txt' })).toBeVisible()
  expect(await page.evaluate((p) => window.tiny!.kernel.readFile(p).then((b) => new TextDecoder().decode(b)), `${HOME}/Downloads/dropped.txt`)).toBe('dropped contents')

  await ui.locator('#scroll').click({ button: 'right', position: { x: 600, y: 300 } })
  await expect(page.locator('.menu button', { hasText: 'New Folder' })).toBeVisible()
  await expect(page.locator('.menu button', { hasText: 'Import from Computer' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('hidden files and app packages', async ({ desktop }) => {
  const { page } = desktop
  await prepare(page, { [`${HOME}/Documents/.secret`]: 's', [`${HOME}/Documents/shown.txt`]: 's' })
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Applications' }).click()
  const terminal = ui.locator('#files .item', { hasText: 'Terminal' })
  await expect(terminal).toBeVisible()
  await terminal.click({ button: 'right' })
  await page.locator('.menu button', { hasText: 'Show Package Contents' }).click()
  await expect(ui.locator('#files .item', { hasText: 'manifest.json' })).toBeVisible()

  await ui.locator('#sidebar .item', { hasText: 'Documents' }).click()
  await expect(ui.locator('#files .item', { hasText: '.secret' })).toHaveCount(0)
  await page.keyboard.press('Meta+Shift+.')
  await expect(ui.locator('#files .item', { hasText: '.secret' })).toBeVisible()

})

test('a Finder window comes back after a reload with its folder and view', async ({ desktop }) => {
  const { page } = desktop
  const { ui } = await openFinder(desktop)
  await ui.locator('#sidebar .item', { hasText: 'Downloads' }).click()
  await ui.locator('[data-view="list"]').click()
  await expect(desktop.win('Downloads')).toBeVisible()
  await page.waitForTimeout(1800)
  await desktop.reload()
  await expect(desktop.win('Downloads')).toBeVisible()
  await expect(desktop.win('Downloads').frameLocator('iframe').locator('#files.list')).toBeVisible()
})
