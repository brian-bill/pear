import { expect, test, type Desktop } from './fixtures'

const HOME = '/Users/pear'
const DOCS = `${HOME}/Documents`
const NOTES = `${DOCS}/Notes`

/** Store text in the VFS as if the user had created it, owned by the user. */
async function put(desktop: Desktop, p: string, text: string): Promise<void> {
  await desktop.page.evaluate(
    async ({ p, text }) => {
      const k = window.tiny!.kernel
      for (let tries = 0; ; tries++) {
        try {
          await k.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true })
          await k.writeFile(p, new TextEncoder().encode(text))
          await k.chown(p, 501, 20)
          return
        } catch (e) {
          // The kernel worker serves requests concurrently; two interleaved wasm calls can
          // panic with this aliasing error. It never leaves a half-written file behind, so once is enough.
          if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') throw e
        }
      }
    },
    { p, text },
  )
}

const read = (desktop: Desktop, p: string) =>
  desktop.page.evaluate(
    (g) => window.tiny!.kernel.readFile(g.p).then((b) => new TextDecoder().decode(b), () => null),
    { p },
  )

/** The Notes window, by app id: the title moves with the open note, so `.name` cannot anchor it. */
const notesWindow = (desktop: Desktop) => desktop.page.locator('.window[data-app="org.tiny.notes"]')
/** The app's frame, titled by the manifest name no matter which note is open. */
const frame = (desktop: Desktop) => desktop.page.frameLocator('iframe[title="Notes"]').first()
const notesText = (desktop: Desktop) => frame(desktop).locator('#text')
const rowOf = (desktop: Desktop, name: string) => frame(desktop).locator('#list .note', { hasText: name })

const launch = (desktop: Desktop) => desktop.page.evaluate(() => void window.tiny!.apps.launch('org.tiny.notes'))

/** Sibling agents touch app files while tests run and the dev server then reloads the page: stand by until it is quiet. */
async function quiet(desktop: Desktop, ms = 2000): Promise<void> {
  const { page } = desktop
  const start = Date.now()
  let reloads = 0
  const bump = () => reloads++
  page.on('load', bump)
  try {
    do {
      reloads = 0
      await page.waitForTimeout(ms)
    } while (reloads > 0 && Date.now() - start < 30_000)
  } finally {
    page.off('load', bump)
  }
}

test('create — autosave — reload', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(notesWindow(desktop)).toBeVisible({ timeout: 20_000 })
  await quiet(desktop)
  await frame(desktop).locator('#list').click() // the app gets the keyboard (menu accelerators are app-side)
  await page.keyboard.press('Meta+N') // File > New
  await expect(rowOf(desktop, 'Note 1')).toBeVisible()
  await expect(notesText(desktop)).toBeEditable() // select() has loaded the new note

  await notesText(desktop).click()
  await page.keyboard.type('Groceries\nmilk')
  // the note files itself after its first line as the autosave lands (a slow poll: dense
  // filesystem polling interleaves with the kernel calls the app is retrying)
  await expect.poll(() => read(desktop, `${NOTES}/Groceries.txt`), { intervals: [500, 1000] }).toBe('Groceries\nmilk')
  // a document window carries the file's name
  await expect(desktop.win('Groceries.txt').locator('.name')).toHaveText('Groceries.txt')

  await desktop.reload()
  // a fresh boot brings no window on its own: launch Notes again and open the note
  await page.waitForSelector('iframe[title="Notes"]', { timeout: 4000 }).catch(() => {
    void launch(desktop)
  })
  await expect(rowOf(desktop, 'Groceries')).toBeVisible({ timeout: 20_000 })
  await expect(desktop.win('Groceries.txt')).toBeVisible({ timeout: 20_000 })
  await expect(desktop.win('Groceries.txt').locator('.name')).toHaveText('Groceries.txt')
  await rowOf(desktop, 'Groceries').click()
  await expect(notesText(desktop)).toHaveValue(/milk/)

  await page.screenshot({ path: 'test-results/notes.png' })
})

test('open an outside file', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${DOCS}/hello.txt`, 'hello there\nsecond line')
  await launch(desktop)
  await expect(notesWindow(desktop)).toBeVisible({ timeout: 20_000 })

  await notesWindow(desktop).locator('.titlebar').click()
  await page.locator('.menubar').getByText('File', { exact: true }).click()
  await page.getByText('Open…', { exact: true }).click()
  const sheet = page.locator('.sheet.picker')
  await expect(sheet, 'the Open panel over Notes').toBeVisible()
  await sheet.locator('.entry', { hasText: 'hello.txt' }).dblclick()

  await expect(desktop.win('hello.txt').locator('.name')).toHaveText('hello.txt')
  await expect(notesText(desktop)).toHaveValue('hello there\nsecond line')

  // the same file it was opened from: edits land there, not in the Notes folder
  await notesText(desktop).click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('!')
  await expect.poll(() => read(desktop, `${DOCS}/hello.txt`)).toBe('hello there\nsecond line!')
  await expect.poll(() => read(desktop, `${NOTES}/hello.txt`)).toBe(null)
})

test('delete moves to Trash', async ({ desktop }) => {
  const { page } = desktop
  await launch(desktop)
  await expect(notesWindow(desktop)).toBeVisible({ timeout: 20_000 })
  await frame(desktop).locator('#list').click() // the app gets the keyboard (menu accelerators are app-side)
  await page.keyboard.press('Meta+N')
  await expect(rowOf(desktop, 'Note 1')).toBeVisible()
  await expect(notesText(desktop)).toBeEditable()
  await notesText(desktop).click()
  await page.keyboard.type('Temp')
  await expect.poll(() => read(desktop, `${NOTES}/Temp.txt`), { intervals: [500, 1000] }).toBe('Temp')
  await expect(rowOf(desktop, 'Temp')).toBeVisible()

  await page.locator('.menubar').getByText('Edit', { exact: true }).click()
  await page.getByText('Delete', { exact: true }).click()
  const sheet = notesWindow(desktop).locator('.sheet')
  await expect(sheet).toContainText('Temp')
  await sheet.getByRole('button', { name: 'Delete' }).click()

  // the folder survives (still readable, no error) and the note is gone from it and from the list
  const names = () => page.evaluate(() => window.tiny!.kernel.readdir('/Users/pear/Documents/Notes').then((es) => es.map((e) => e.name)))
  await expect.poll(names, 'Temp.txt left the Notes folder').not.toContain('Temp.txt')
  await expect(rowOf(desktop, 'Temp')).toHaveCount(0)
})
