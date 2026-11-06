/**
 * The interactive line editor: history, editing keys, completion, reverse search, bracketed paste, wrapped lines, and a
 * history file between sessions. Keys are typed into a real terminal and the commands that run are what is checked.
 */
import { expect, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => window.sh.installUserland())
})

/** Type each entry into a shell on a terminal (one `[keys, needle]` step at a time) and return what each step printed. */
async function type(page: import('@playwright/test').Page, steps: Array<[string, string]>, opts: { cols?: number; env?: Record<string, string> } = {}): Promise<string[]> {
  return page.evaluate(
    async ({ steps, opts }) => {
      const { kernel, sh } = window
      const { pid, master } = await kernel.spawnPty('/bin/sh', { env: { PS1: '$ ', ...opts.env }, size: { rows: 24, cols: opts.cols ?? 80 } })
      const seen: string[] = [await sh.expect(master, '$ ')]
      for (const [keys, needle] of steps) {
        await kernel.pipeWrite(master, keys)
        seen.push(await sh.expect(master, needle))
      }
      await kernel.pipeWrite(master, '\x04')
      await kernel.wait(pid)
      return seen
    },
    { steps, opts },
  )
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const LEFT = '\x1b[D'
const HOME = '\x1b[H'
const END = '\x1b[F'
const DEL = '\x1b[3~'

test('Up and Down walk the history; the recalled line can be run', async ({ page }) => {
  const seen = await type(page, [
    ['echo one\r', 'one\r\n$ '],
    ['echo two\r', 'two\r\n$ '],
    [`${UP}${UP}\r`, 'one\r\n$ '],
    [`${UP}${UP}${UP}${DOWN}\r`, 'two\r\n$ '],
  ])
  expect(seen[3]).toContain('echo one') // the recalled line was drawn
  expect(seen).toHaveLength(5)
})

test('editing in the middle of a line: arrows, Delete, Home, End, Backspace, ^A ^E', async ({ page }) => {
  const seen = await type(page, [
    [`echo abXc${LEFT}${LEFT}${DEL}\r`, 'abc\r\n$ '],
    [`echo bcd${HOME}${END}e\r`, 'bcde\r\n$ '],
    [`echo xyz\x01\x06\x06\x06\x06\x06\x04\x05!\r`, 'yz!\r\n$ '],
  ])
  expect(seen).toHaveLength(4)
})

test('kill and yank: ^U ^K ^W, Alt-d, Alt-Backspace, ^Y, ^T', async ({ page }) => {
  await type(page, [
    ['echo foo bar\x17baz\r', 'foo baz\r\n$ '],
    ['echo one two\x17\x19\x19\r', 'one twotwo\r\n$ '],
    ['echo keep drop\x01\x06\x06\x06\x06\x06\x06\x06\x06\x06\x0b\r', 'keep\r\n$ '],
    ['\x15echo gone\x15echo kept\r', 'kept\r\n$ '],
    ['echo ab\x14\r', 'ba\r\n$ '],
    ['echo foo bar\x1bb\x1bd\r', 'foo\r\n$ '],
  ])
})

test('Tab completes commands, paths and variables; a second Tab lists the choices', async ({ page }) => {
  await page.evaluate(async () => {
    const { kernel } = window
    await kernel.mkdir('/tmp/tc/sub', { recursive: true })
    for (const [name, text] of [['alpha.txt', 'A\n'], ['alphabet.txt', 'B\n'], ['with space.txt', 'C\n']]) await kernel.writeFile(`/tmp/tc/${name}`, new TextEncoder().encode(text!))
  })
  const seen = await type(page, [
    ['ech\t hi\r', 'hi\r\n$ '], // echo
    ['cat /tmp/tc/alp\t', 'alpha'], // common prefix
    ['\t\t', 'alphabet.txt'], // list
    ['\x15cat /tmp/tc/alpha.\t\r', 'A\r\n$ '],
    ['cat /tmp/tc/wi\t\r', 'C\r\n$ '], // the space is escaped
    ['cd /tmp/t\t\r', '$ '],
    ['pwd\r', '/tmp/tc\r\n$ '],
    ['MYVAR=7\r', '$ '],
    ['echo $MYV\t\r', '7\r\n$ '],
  ])
  expect(seen[3]).toMatch(/alpha\.txt\s+alphabet\.txt/)
})

test('^R searches the history', async ({ page }) => {
  const seen = await type(page, [
    ['echo needle1\r', 'needle1\r\n$ '],
    ['echo other\r', 'other\r\n$ '],
    ['\x12need', 'need'],
    ['\r', 'needle1\r\n$ '],
  ])
  expect(seen[3]).toContain('reverse-i-search')
})

test('bracketed paste inserts text, including newlines, without running it', async ({ page }) => {
  await type(page, [
    ['\x1b[200~echo pasted\x1b[201~', 'pasted'],
    ['\r', 'pasted\r\n$ '],
    ['\x1b[200~echo "a\nb"\x1b[201~\r', 'a\r\nb\r\n$ '],
  ])
})

test('a line longer than the window wraps and can be edited', async ({ page }) => {
  const a = 'a'.repeat(30)
  await type(page, [[`echo ${a}${HOME}${END}b\r`, `${a}b\r\n$ `]], { cols: 20 })
  await type(page, [[`echo ${a}${LEFT}${LEFT}\x7f\r`, `${a.slice(0, 28)}a\r\n$ `]], { cols: 20 })
})

test('the history file carries commands to the next session; a leading space keeps a command out of it', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await kernel.mkdir('/hh', { recursive: true })
    await sh.session('echo persisted\n echo secret\nexit\n', { HOME: '/hh' })
    const file = await sh.cat('/hh/.sh_history')
    const again = await sh.session('\x1b[A\x1b[A\nexit\n', { HOME: '/hh' })
    return { file, again: again.out }
  })
  expect(out.file).toBe('echo persisted\nexit\n')
  expect(out.again).toBe('persisted\r\n')
})

test('a window resize while the prompt waits does not lose the keystrokes that follow', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const { pid, master } = await kernel.spawnPty('/bin/sh', { env: { PS1: '$ ' }, size: { rows: 24, cols: 80 } })
    await sh.expect(master, '$ ')
    for (const cols of [60, 70, 50]) {
      await kernel.setwinsize(master, { rows: 24, cols })
      await sh.sleep(100)
    }
    await kernel.pipeWrite(master, 'echo kept-all\r')
    const text = await sh.expect(master, 'kept-all\r\n$ ')
    await kernel.pipeWrite(master, '\x04')
    await kernel.wait(pid)
    return text
  })
  expect(out).toContain('kept-all')
})
