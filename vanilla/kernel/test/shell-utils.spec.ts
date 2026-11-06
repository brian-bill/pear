/** The core utilities added to /bin: files, text, find/du/df, diff/cmp. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => window.sh.installUserland())
})

const script = (name: string) => readFileSync(fileURLToPath(new URL(`./scripts/${name}`, import.meta.url)), 'utf8')

async function run(page: Page, source: string) {
  return page.evaluate(async (source) => {
    const st = await window.sh.run('/bin/sh', { args: ['-c', source], env: { HOME: '/root-home' } })
    return { out: st.stdout ?? '', err: st.stderr ?? '', code: st.code }
  }, source)
}

test('file utilities: rmdir ln readlink stat chmod realpath which basename dirname mktemp tee seq uname date head -c tail -c', async ({ page }) => {
  const r = await run(page, script('utils-files.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe(
    ['0', 'f', 'hi', '600 3 regular file', '740', '/tmp/u/f', '/bin/sh', 'which=1', 'c', '/a/b', '.', 'dir', 'file', '3', '1 2 3 ', '2 4 6 8 ', '08 09 10 ', 'Vanilla', 'pear.local', '1970-01-01T00:00:00', 'Fri Jan  2 002', 'abc', 'ef', '/root-home'].join('\n') + '\n',
  )
})

test('text utilities: sort uniq cut tr xargs', async ({ page }) => {
  const r = await run(page, script('utils-text.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe(
    ['   2 a', '   1 b', '   1 c', '9 10 100 ', '100 10 9 ', 'c,1 b,2 a,10 ', 'a b ', 'x', 'a:c', 'ell', 'HELLO', 'a b', 'abc', 'he', 'x a b c', 'n 1', 'n 2', '[a]', '[b]'].join('\n') + '\n',
  )
})

test('find, du, df', async ({ page }) => {
  const r = await run(page, script('utils-find.sh'))
  expect(r.out).toBe(
    [
      '/tmp/ft/a/y.txt', '/tmp/ft/x.txt',
      '/tmp/ft', '/tmp/ft/a', '/tmp/ft/a/b', '/tmp/ft/empty',
      '/tmp/ft/x.txt',
      'found /tmp/ft/a/b/z.md',
      '/tmp/ft/a/b/z.md',
      '/tmp/ft/a/b/z.md', '/tmp/ft/x.txt',
      '/tmp/ft/empty',
      '/tmp/ft/a/b', '/tmp/ft/a/y.txt',
      './a/y.txt',
      './a/b/z.md ./a/y.txt ./x.txt ',
      '0',
      'st=1',
      '/tmp/ft',
      '/tmp/ft/a/b', '/tmp/ft/a', '/tmp/ft/empty',
      'Filesystem',
    ].join('\n') + '\n',
  )
  expect(r.err).toContain('find: /nonexistent')
})

test('diff and cmp', async ({ page }) => {
  const r = await run(page, script('utils-diff.sh'))
  expect(r.out).toBe(
    ['2c2', '< 2', '---', '> x', '3a4', '> 4', 'same=0', '@@ -1,3 +1,4 @@', ' 1', '-2', '+x', ' 3', '+4', 'Files /tmp/da and /tmp/db differ', '/tmp/da /tmp/db differ: char 3, line 2', 'cmp=1', 'cmp=0'].join('\n') + '\n',
  )
})

test('awk', async ({ page }) => {
  const r = await run(page, script('awk.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe(
    [
      '6 3', 'x', 'b c ', ' 3.14|ab  |42', 'b 2', 'b 2;c 3;', '3 2', '42', 'a 10;b 20;c 30;', '3 14', 'hell0 w0rld', 'HELL0 7', '3 c', '3', '6', 'big',
      '0.333333', '1 1024 7', '3', 'y-x', '1 2 3 ', 'hi', 'c 3', 'no', 'yes', 'odd even odd ', 'AB', 'a 1', '1 2', 'a c ', '12 34 1 1', 'ell hello h', '5 abc',
      'st=3', 'cba', 'k -> v', '3 aaaaaa', '10000000000 0.3 1000 1000',
    ].join('\n') + '\n',
  )
})

test('sed', async ({ page }) => {
  const r = await run(page, script('sed.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe(
    [
      '0ne tw0 three ', '0nE tw0 threE ', 'two', 'two three ', 'one three ', 'one two ', 'one', 'two three ', 'one wto htree ', 'one wto htree ', '<one>', 'xxyyzz',
      'one inserted two three ', 'one two appended three ', 'one changed three ', '1', 'one+two three ', '1 one;2 two;3 three;', 'One', 'one two ', 'one two ', '3',
      'a-b', 'a_b', 'two', 'one one ', 'helLo', 'heLLo', 'path:to:x', 'XaXcX', ',a,b,c', 'a__b__', 'one 2 three one two three ', 'X Y',
    ].join('\n') + '\n',
  )
})

test('gzip, tar and zip round trips', async ({ page }) => {
  const r = await run(page, script('utils-archive.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe(
    [
      'a.txt a.txt.gz l sub ', 'hello', 'hello', 'streamed',
      'src/ src/a.txt src/a.txt.gz src/l src/sub/ src/sub/b.txt ', 'deep', 'a.txt',
      'src/ src/a.txt ', 'a.txt a.txt.gz l sub ',
      '6 files', 'hello', 'deep', 'st=1', 'st=0', '755', '127', 'z', 'b.txt.gz', 'b.txt',
    ].join('\n') + '\n',
  )
})

test('the kernel pushes file changes as they happen, whoever makes them', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const seen: string[] = []
    window.kernel.onEvent((e) => {
      if (e.type === 'fs') for (const c of e.events) seen.push(`${c.kind}:${c.path}`)
    })
    const started = Date.now()
    await window.sh.run('/bin/sh', { args: ['-c', 'mkdir -p /tmp/w/d; touch /tmp/w/a; echo hi > /tmp/w/d/b; mv /tmp/w/a /tmp/w/c; rm /tmp/w/c'], env: {} })
    // pushed, not polled: nothing here asks for the events
    for (let i = 0; i < 40 && !seen.includes('deleted:/tmp/w/c'); i++) await new Promise((r) => setTimeout(r, 25))
    return { seen, ms: Date.now() - started }
  })
  expect(out.seen).toEqual(expect.arrayContaining(['created:/tmp/w/d', 'created:/tmp/w/a', 'created:/tmp/w/d/b', 'deleted:/tmp/w/c']))
  expect(out.seen.some((s) => s.startsWith('renamed:') && s.endsWith('/tmp/w/c'))).toBe(true)
})
