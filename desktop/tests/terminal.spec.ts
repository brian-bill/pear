import { expect, test } from './fixtures'

test('the terminal runs the Vanilla shell: commands, files, pipes, ^C', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.terminal').click()
  const term = desktop.win('Terminal').frameLocator('iframe').locator('.terminal')
  await expect(term).toContainText('pear@pear ~ %')
  await page.keyboard.type('echo hello from pear')
  await page.keyboard.press('Enter')
  await expect(term).toContainText('hello from pear')

  await page.keyboard.type('echo data > Documents/note.txt && cat Documents/note.txt | wc -c')
  await page.keyboard.press('Enter')
  await expect(term).toContainText(/\b5\b/)
  await page.keyboard.type('ls Documents')
  await page.keyboard.press('Enter')
  await expect(term).toContainText('note.txt')

  // the file really is in Vanilla's file system, owned by the user
  const owner = await page.evaluate(() => window.tiny!.kernel.stat('/Users/pear/Documents/note.txt').then((s) => s.uid))
  expect(owner).toBe(501)

  await page.keyboard.type('sleep 30')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+c')
  await page.keyboard.type('echo back')
  await page.keyboard.press('Enter')
  await expect(term).toContainText(/^back/m)

  // Backspace edits the line
  await page.keyboard.type('echo wrongg')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await expect(term).toContainText(/^wrong$/m)
})

test('closing the terminal ends its shell', async ({ desktop }) => {
  const { page } = desktop
  await desktop.dock('org.tiny.terminal').click()
  await expect(desktop.win('Terminal').frameLocator('iframe').locator('.terminal')).toContainText('%')
  const shells = () => page.evaluate(() => window.tiny!.kernel.listProcesses().then((l) => l.filter((p) => p.name === 'sh' && p.state === 'running').length))
  expect(await shells()).toBe(1)
  await desktop.win('Terminal').locator('.light.close').click()
  await expect.poll(shells).toBe(0)
})
