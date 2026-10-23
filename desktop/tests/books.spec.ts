import { expect, test, type Desktop } from './fixtures'

const HOME = '/Users/pear'
const DOCS = `${HOME}/Documents`
const LIBRARY = `${HOME}/Library/Books/library.json`

type Frame = ReturnType<ReturnType<Desktop['win']>['frameLocator']>

/** Store bytes in the VFS as if the user had saved or imported them. (verbatim from tests/media.spec.ts) */
async function put(desktop: Desktop, p: string, bytes: Uint8Array): Promise<void> {
  await desktop.page.evaluate(
    async ({ p, bytes }) => {
      const k = window.tiny!.kernel
      for (let tries = 0; ; tries++) {
        try {
          await k.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true })
          await k.writeFile(p, new Uint8Array(bytes))
          await k.chown(p, 501, 20)
          return
        } catch (e) {
          // The kernel worker serves requests concurrently; two interleaved wasm calls can
          // panic with this aliasing error. It never leaves a half-written file behind, so once is enough.
          if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') throw e
        }
      }
    },
    { p, bytes: Array.from(bytes) },
  )
}

const putFile = (desktop: Desktop, p: string, text: string) => put(desktop, p, new TextEncoder().encode(text))

/** A plain-text book of ~10k characters with '# Chapter N' breaks. Deterministic. */
function bookText(): string {
  const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '
  let out = ''
  for (let n = 1; out.length < 10_500; n++) {
    out += n === 1 ? '# Chapter 1\n\n' : `\n\n# Chapter ${n}\n\n`
    out += `${lorem.repeat(4)}\n\n`
    out += `${lorem.repeat(4)}\n\n`
    out += lorem.repeat(6)
  }
  return out
}

/** The library file's JSON, raw from the kernel. Throws (ENOENT) if the app never wrote it. */
const libData = (desktop: Desktop) =>
  desktop.page.evaluate((p) =>
    window.tiny!.kernel.readFile(p).then((b) => JSON.parse(new TextDecoder().decode(b)) as { books: Array<Record<string, unknown>> }), LIBRARY)

/** The part of the reading pane above the fold, as a share. */
const ratio = (reader: Frame) =>
  reader.locator('#page').evaluate((el: HTMLElement) => {
    const range = el.scrollHeight - el.clientHeight
    return range > 0 ? el.scrollTop / range : 0
  })

const int = (t: string | null): number => {
  const m = /(\d+)%/.exec(t ?? '')
  return m ? Number.parseInt(m[1]!, 10) : -1
}

test('read a book, keep progress, and land on the same page from the library', async ({ desktop }) => {
  const { page } = desktop
  await putFile(desktop, `${DOCS}/Odyssey.txt`, bookText())
  await page.evaluate(() => void window.tiny!.apps.launch('org.tiny.books'))
  const libWin = desktop.win('Books')
  const lib = libWin.frameLocator('iframe')
  await expect(lib.locator('#empty'), 'a brand new user has no books yet').toBeVisible()

  // File > Add Books… (Cmd+O) over the library: focus the app first (menu accelerators are app-side)
  await lib.locator('#empty').click()
  await page.keyboard.press('Meta+O')
  const sheet = page.locator('.sheet.picker')
  await expect(sheet, 'the Open panel over Books').toBeVisible()
  await sheet.locator('.entry', { hasText: 'Odyssey.txt' }).first().dblclick()

  // adding a book opens its reader directly, titled like the book (all Books windows say "Books" inside)
  const readerWin = desktop.win(/Odyssey/)
  await expect(readerWin).toBeVisible()
  const reader = readerWin.frameLocator('iframe')
  await expect(reader.locator('#progress')).toHaveText('Chapter 1 · 0%')

  // read a little: three page turns, focus the reading pane first
  await reader.locator('#page').click()
  for (let i = 0; i < 3; i++) await page.keyboard.press('PageDown')
  const shownPct = async () => int(await reader.locator('#progress').textContent())
  await expect.poll(shownPct, 'the reader reports how far in').toBeGreaterThan(0)
  const at = await ratio(reader)
  expect(at, 'three page turns are real progress but nowhere near the end').toBeLessThan(0.9)

  // the bookmark is written into the library file
  const path = `${DOCS}/Odyssey.txt`
  await expect
    .poll(async () => {
      try {
        const data = await libData(desktop)
        return (data.books.find((b) => b.path === path) as { progress?: { line?: number } } | undefined)?.progress?.line ?? 0
      } catch {
        return 0
      }
    }, 'the bookmark lands in library.json')
    .toBeGreaterThan(0)

  // close the reader; reopening the card lands on the same page (the exact same layout, so close)
  await readerWin.locator('.light.close').click()
  await expect(readerWin).toHaveCount(0)
  await expect(lib.locator('#grid')).toBeVisible()
  await lib.locator('.book', { hasText: 'Odyssey' }).click()

  const again = desktop.win(/Odyssey/)
  await expect(again).toBeVisible()
  const returned = again.frameLocator('iframe')
  await expect(returned.locator('#progress'), 'restored in to the same chapter').toHaveText(/^Chapter [1-9]/)
  const back = await ratio(returned)
  expect(Math.abs(back - at), 'the viewport top is restored to within 5%').toBeLessThan(0.05)

  await page.screenshot({ path: 'test-results/books.png' })
})

test('bigger text through the menus, kept with the book', async ({ desktop }) => {
  const { page } = desktop
  await putFile(desktop, `${DOCS}/Iliad.txt`, bookText())

  // this time the file is opened with the app itself: the first window is its reader
  await page.evaluate((p) => void window.tiny!.kernel.launchOpen(p, { app: 'org.tiny.books' }), `${DOCS}/Iliad.txt`)
  const readerWin = desktop.win(/Iliad/)
  await expect(readerWin).toBeVisible()
  const reader = readerWin.frameLocator('iframe')
  await expect(reader.locator('#flow')).toContainText('Lorem ipsum')

  const size = () => reader.locator('#flow').evaluate((el) => getComputedStyle(el).fontSize)
  expect(await size()).toBe('17px')

  await reader.locator('#page').click()
  await page.keyboard.press('Meta+=')
  expect(await size()).toBe('18px')
  await page.keyboard.press('Meta+-')
  expect(await size(), 'smaller undoes the step').toBe('17px')
  await page.keyboard.press('Meta+=')
  await page.keyboard.press('Meta+=')
  expect(await size()).toBe('19px')

  // one source of state: the size of this window's book is in the same library.json
  await expect
    .poll(async () => {
      try {
        const data = await libData(desktop)
        const v = (data.books.find((b) => (b.path as string | undefined)?.includes('Iliad')) as { view?: { size?: number } } | undefined)?.view
        return v?.size
      } catch {
        return undefined
      }
    }, 'the size lives with the book')
    .toBe(19)
})
