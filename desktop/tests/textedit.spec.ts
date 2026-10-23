import { expect, test, type Desktop } from './fixtures'

const DOCS = '/Users/pear/Documents'

/** Put a file in the VFS, owned by the user. */
async function put(desktop: Desktop, path: string, text: string | number[], mode?: number): Promise<void> {
  await desktop.page.evaluate(
    async ([p, t, m]) => {
      const kern = window.tiny!.kernel
      await kern.writeFile(p as string, typeof t === 'string' ? new TextEncoder().encode(t) : new Uint8Array(t as number[]))
      await kern.chown(p as string, 501, 20)
      if (m) await kern.chmod(p as string, m as number)
    },
    [path, text, mode ?? 0] as const,
  )
}

const read = (desktop: Desktop, path: string) =>
  desktop.page.evaluate((p) => window.tiny!.kernel.readFile(p).then((b) => new TextDecoder().decode(b)), path)

const editor = (desktop: Desktop, title: string | RegExp) => desktop.win(title).frameLocator('iframe').locator('#text')

async function openWith(desktop: Desktop, path: string): Promise<void> {
  await desktop.page.evaluate((p) => window.tiny!.kernel.launchOpen(p, { app: 'org.tiny.textedit' }), path)
}

test('a new document: type, Save As through the panel, and read it back from the VFS', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.textedit').click()
  const text = editor(desktop, 'Untitled')
  await expect(text).toBeFocused()
  await page.keyboard.type('hello pear')
  await expect(desktop.win('Untitled').frameLocator('iframe').locator('#pos')).toHaveText('Ln 1, Col 11')
  await expect(desktop.win('Untitled').frameLocator('iframe').locator('#chars')).toContainText('10 characters')

  await page.keyboard.press('Meta+s') // Untitled: asks where
  const sheet = desktop.win('Untitled').locator('.sheet')
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Name').fill('greeting.txt')
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(desktop.win('greeting.txt')).toBeVisible()
  expect(await read(desktop, `${DOCS}/greeting.txt`)).toBe('hello pear')

  // it is a normal save now: edit, Cmd+S, no panel
  await page.keyboard.type('!')
  await page.keyboard.press('Meta+s')
  await expect.poll(() => read(desktop, `${DOCS}/greeting.txt`)).toBe('hello pear!')
  await expect(desktop.win('greeting.txt').locator('.sheet')).toHaveCount(0)
})

test('files open from launch, a second file gets its own window, line endings are kept', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${DOCS}/dos.txt`, 'one\r\ntwo\r\n')
  await put(desktop, `${DOCS}/unix.md`, '# Title\n')
  await openWith(desktop, `${DOCS}/dos.txt`)
  const dos = editor(desktop, 'dos.txt')
  await expect(dos).toHaveValue('one\ntwo\n')
  await expect(desktop.win('dos.txt').frameLocator('iframe').locator('#eol')).toHaveText('CRLF')
  await expect(desktop.win('dos.txt').frameLocator('iframe').locator('#kind')).toHaveText('Plain Text')

  await dos.click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('three')
  await page.keyboard.press('Meta+s')
  await expect.poll(() => read(desktop, `${DOCS}/dos.txt`)).toBe('one\r\ntwo\r\nthree')

  await openWith(desktop, `${DOCS}/unix.md`)
  await expect(editor(desktop, 'unix.md')).toHaveValue('# Title\n')
  await expect(desktop.win('unix.md').frameLocator('iframe').locator('#kind')).toHaveText('Markdown')
  await expect(desktop.win('dos.txt')).toBeVisible()
})

test('closing a document with unsaved changes asks Save / Don\'t Save / Cancel', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${DOCS}/draft.txt`, 'saved text')
  await openWith(desktop, `${DOCS}/draft.txt`)
  const text = editor(desktop, 'draft.txt')
  await expect(text).toHaveValue('saved text')
  await text.click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type(' plus more')
  const win = desktop.win('draft.txt')

  await win.locator('.light.close').click()
  const sheet = win.locator('.sheet')
  await expect(sheet).toContainText('save the changes')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(win).toBeVisible()
  expect(await read(desktop, `${DOCS}/draft.txt`)).toBe('saved text')

  // undo brings it back to the saved text: no question any more
  await text.click()
  for (let i = 0; i < 12; i++) await page.keyboard.press('Meta+z')
  await expect(text).toHaveValue('saved text')
  await win.locator('.light.close').click()
  await expect(win).toHaveCount(0)

  // Save: the file is written and the window closes
  await openWith(desktop, `${DOCS}/draft.txt`)
  await editor(desktop, 'draft.txt').click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('!')
  await desktop.win('draft.txt').locator('.light.close').click()
  await desktop.win('draft.txt').locator('.sheet').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(desktop.win('draft.txt')).toHaveCount(0)
  expect(await read(desktop, `${DOCS}/draft.txt`)).toBe('saved text!')

  // Don't Save: the file stays as it was
  await openWith(desktop, `${DOCS}/draft.txt`)
  await editor(desktop, 'draft.txt').click()
  await page.keyboard.type('X')
  await desktop.win('draft.txt').locator('.light.close').click()
  await desktop.win('draft.txt').locator('.sheet').getByRole('button', { name: "Don't Save" }).click()
  await expect(desktop.win('draft.txt')).toHaveCount(0)
  expect(await read(desktop, `${DOCS}/draft.txt`)).toBe('saved text!')
})

test('find, find next, replace, replace all and go to line', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${DOCS}/f.txt`, 'Foo bar foo\nbaz FOO\nlast foo line')
  await openWith(desktop, `${DOCS}/f.txt`)
  const frame = desktop.win('f.txt').frameLocator('iframe')
  const text = frame.locator('#text')
  await expect(text).toHaveValue(/Foo bar/)
  await text.click()
  await page.keyboard.press('Meta+f')
  await expect(frame.locator('#find')).toBeFocused()
  await page.keyboard.type('foo')
  await expect(frame.locator('#count')).toHaveText('4 found')
  await frame.locator('#case').check()
  await expect(frame.locator('#count')).toHaveText('2 found')
  await frame.locator('#case').uncheck()

  await frame.locator('#find').click()
  await page.keyboard.press('Enter') // first match
  const sel = () => text.evaluate((t: HTMLTextAreaElement) => [t.selectionStart, t.selectionEnd])
  expect(await sel()).toEqual([0, 3])
  await page.keyboard.press('Meta+g')
  expect(await sel()).toEqual([8, 11])
  await page.keyboard.press('Meta+Shift+g')
  expect(await sel()).toEqual([0, 3])

  await frame.locator('#repl').fill('QUX')
  await frame.locator('#replace').click() // replaces the selected match, moves on
  await expect(text).toHaveValue(/^QUX bar foo/)
  await frame.locator('#replall').click()
  await expect(text).toHaveValue('QUX bar QUX\nbaz QUX\nlast QUX line')
  await expect(frame.locator('#count')).toHaveText('3 replaced')
  // replace all is one undo step
  await page.keyboard.press('Meta+z')
  await expect(text).toHaveValue(/^QUX bar foo/)

  await frame.locator('#closefind').click()
  await page.keyboard.press('Meta+l')
  await desktop.win('f.txt').locator('.sheet input').fill('3')
  await page.keyboard.press('Enter')
  await expect(frame.locator('#pos')).toHaveText('Ln 3, Col 1')
})

test('view options: line numbers, word wrap, font size, tab and auto-indent', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.textedit').click()
  const frame = desktop.win('Untitled').frameLocator('iframe')
  const text = frame.locator('#text')
  await text.click()
  await page.keyboard.type('a')
  await page.keyboard.press('Tab')
  await page.keyboard.type('b')
  await page.keyboard.press('Enter')
  await page.keyboard.type('c')
  await expect(text).toHaveValue('a   b\nc')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('x')
  await page.keyboard.press('Enter') // keeps the indent
  await page.keyboard.type('y')
  await expect(text).toHaveValue('a   b\nc\n    x\n    y')
  await page.keyboard.press('Shift+Tab')
  await expect(text).toHaveValue('a   b\nc\n    x\ny')

  await expect(frame.locator('#gutter')).toBeHidden()
  await desktop.page.locator('.menubar').getByText('View', { exact: true }).click()
  await page.getByText('Line Numbers', { exact: true }).click()
  await expect(frame.locator('#gutter')).toBeVisible()
  await expect(frame.locator('#gutter')).toHaveText('1\n2\n3\n4')

  const size = () => text.evaluate((t) => getComputedStyle(t).fontSize)
  expect(await size()).toBe('13px')
  await text.click()
  await page.keyboard.press('Meta+=')
  expect(await size()).toBe('14px')
  await page.keyboard.press('Meta+-')
  await page.keyboard.press('Meta+-')
  expect(await size()).toBe('12px')
  await page.keyboard.press('Meta+0')
  expect(await size()).toBe('13px')

  // wrapping: a long line takes several rows, and its number leaves room for them
  await text.fill('x '.repeat(400))
  await expect(frame.locator('#gutter')).toHaveText(/^1\n\n/)
  await desktop.page.locator('.menubar').getByText('View', { exact: true }).click()
  await page.getByText('Word Wrap', { exact: true }).click()
  await expect(frame.locator('#gutter')).toHaveText('1')
})

test('a read-only file is flagged and Save offers Save As; a binary file asks first', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${DOCS}/locked.txt`, 'cannot touch', 0o444)
  await openWith(desktop, `${DOCS}/locked.txt`)
  const win = desktop.win('locked.txt')
  const frame = win.frameLocator('iframe')
  await expect(frame.locator('#ro')).toBeVisible()
  await expect(frame.locator('#text')).toHaveJSProperty('readOnly', true)
  await frame.locator('#text').click()
  await page.keyboard.type('zzz')
  await expect(frame.locator('#text')).toHaveValue('cannot touch')
  await page.keyboard.press('Meta+s')
  await expect(win.locator('.sheet')).toContainText('read-only')
  await win.locator('.sheet').getByRole('button', { name: 'Cancel' }).click()

  await put(desktop, `${DOCS}/blob.txt`, [0x41, 0, 0x42])
  await openWith(desktop, `${DOCS}/blob.txt`)
  await expect(desktop.win('Untitled').locator('.sheet')).toContainText('does not look like a text file')
})

test('unsaved text survives a reload as a draft and is still unsaved', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${DOCS}/keep.txt`, 'disk version')
  await openWith(desktop, `${DOCS}/keep.txt`)
  const text = editor(desktop, 'keep.txt')
  await expect(text).toHaveValue('disk version')
  await text.click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type(' + draft')
  await page.evaluate(() => window.tiny!.saveNow())
  await desktop.reload()
  const again = editor(desktop, 'keep.txt')
  await expect(again).toHaveValue('disk version + draft')
  expect(await read(desktop, `${DOCS}/keep.txt`)).toBe('disk version')
  await desktop.win('keep.txt').locator('.light.close').click()
  await expect(desktop.win('keep.txt').locator('.sheet')).toContainText('save the changes')
})
