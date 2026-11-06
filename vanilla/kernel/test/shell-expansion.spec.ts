/** Parameter expansion operators, arrays, [[ ]], (( )), C-style for, here-strings, $'…', backticks and <(…). */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => window.sh.installUserland())
})

const script = (name: string) => readFileSync(fileURLToPath(new URL(`./scripts/${name}`, import.meta.url)), 'utf8')

async function run(page: Page, script: string, ...args: string[]) {
  return page.evaluate(
    async ([script, args]) => {
      const st = await window.sh.run('/bin/sh', { args: ['-c', script!, ...(args as string[])] })
      return { out: st.stdout ?? '', err: st.stderr ?? '', code: st.code }
    },
    [script, args] as const,
  )
}

test('${var#pat} ${var##pat} ${var%pat} ${var%%pat} and ${var/pat/rep} in all its forms', async ({ page }) => {
  const r = await run(page, script('param-ops.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe(
    'usr/local/bin/file.tar.gz file.tar.gz /usr/local/bin/file.tar /usr/local/bin/file\n' +
      '/usr/LOCAL/bin/file.tar.gz :usr:local:bin:file.tar.gz X/local/bin/file.tar.gz /usr/local/bin/file.tar.zip\n' +
      '/usr/local//file.tar.gz /_sr/l_c_l/b_n/f_l_.t_r.gz\n' +
      'a.b a b.c c\n' +
      'x_y\n',
  )
})

test('defaults, assignment, errors, substrings, case, length and indirection', async ({ page }) => {
  const r = await run(page, script('param-misc.sh'))
  expect(r.out).toBe(
    'def set set alt x y\n' +
      '[][y][z][]\n' +
      'cdef bcd ef abcde\n' +
      'b c d b c d\n' +
      '<b>\n<c>\n' +
      'Hello HELLO hELLo\n' +
      'hELLO hello\n' +
      '6 4\n' +
      'val\n',
  )
  expect(r.err).toContain('nope: custom message')
  expect(r.code).not.toBe(0)
})

test('arrays: literals, elements, append, keys, slices, unset, arithmetic, read -a, mapfile', async ({ page }) => {
  const r = await run(page, script('arrays.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe(
    '3 two words three one one\n[one]\n[two words]\n[three]\n' +
      '0 1 2 3 6\n' +
      'one two words three four six\n' +
      'two words three\n' +
      '4\n4\n2 15 3\n' +
      '2 3 a b c\n' +
      '2\n' +
      'z 3\n' +
      '2 l2\n' +
      'declare -a z=([0]="p" [1]="q")\n' +
      '2\n' +
      '2\ngone\n' +
      '4\n',
  )
})

test('[[ ]]: patterns, regex with BASH_REMATCH, grouping, no word splitting, file and numeric tests', async ({ page }) => {
  const r = await run(page, script('cond.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe('m1\nm2\nm3\nm4\nfoo123 foo 123\nm5\nm6\nm7\nm8\nm9\nm10\nst=1\n')
})

test('(( )), C-style for, here-strings, $\'…\', backticks and <(…)', async ({ page }) => {
  const r = await run(page, script('syntax.sh'))
  expect(r.err).toBe('')
  expect(r.out).toBe('5 10\nbig\nst=1\ni=0\ni=1\ni=2\nonce\nhi world\nansi-ok\na b c\nfrom-psub\nsecond\n2\n')
})
