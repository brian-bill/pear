/** printf, getopts, declare/readonly, let, pushd/popd, command, exec, pipefail, type flags and echo -e. */
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => window.sh.installUserland())
})

interface Result {
  out: string
  err: string
  code: number | null
}

async function run(page: Page, script: string, ...args: string[]): Promise<Result> {
  return page.evaluate(
    async ([script, args]) => {
      const st = await window.sh.run('/bin/sh', { args: ['-c', script!, ...(args as string[])] })
      return { out: st.stdout ?? '', err: st.stderr ?? '', code: st.code }
    },
    [script, args] as const,
  )
}

test('printf: conversions, flags, width and precision, escapes, reuse of the format', async ({ page }) => {
  const r = await run(
    page,
    String.raw`printf '%s|%5s|%-5s|%05d|%x|%X|%o|%c|%5.2f|%e|%g|%g\n' a b c 42 255 255 8 xyz 3.14159 1500 0.0001 1234567
printf '%b' 'a\tb\n'
printf '%q\n' "a b" "it's" ""
printf '%s\n' one two three
printf '%d %d\n' 0x1f "'A"
printf '\x41\101\n'
printf '100%%\n'
printf -v v '%03d' 7; echo $v
printf '%s-%s\n' a
printf '%+d % d %5.1f|%-8.3s|\n' 5 5 2.25 abcdef
printf '%*d|%-*d|\n' 4 7 4 7
printf 'no newline'
`,
  )
  expect(r.err).toBe('')
  expect(r.out).toBe(
    ['a|    b|c    |00042|ff|FF|10|x| 3.14|1.500000e+03|0.0001|1.23457e+06', 'a\tb', "'a b'", `'it'\\''s'`, "''", 'one', 'two', 'three', '31 65', 'AA', '100%', '007', 'a-', '+5  5   2.2|abc     |', '   7|7   |', 'no newline'].join('\n'),
  )
})

test('printf reports a bad number and carries on', async ({ page }) => {
  const r = await run(page, "printf '%d\\n' abc 5; echo status=$?")
  expect(r.out).toBe('0\n5\nstatus=1\n')
  expect(r.err).toContain('abc: invalid number')
})

test('getopts: flags, clustered flags, arguments, errors, OPTIND', async ({ page }) => {
  const script = `while getopts ":ab:c" o; do case $o in a) echo A;; b) echo B=$OPTARG;; c) echo C;; \\?) echo bad=$OPTARG;; :) echo missing=$OPTARG;; esac; done; shift $((OPTIND-1)); echo rest=$*`
  const r = await run(page, script, 'x', '-a', '-bval', '-ca', '-z', 'file1', 'file2')
  expect(r.out).toBe('A\nB=val\nC\nA\nbad=z\nrest=file1 file2\n')
  const m = await run(page, script, 'x', '-b')
  expect(m.out).toBe('missing=b\nrest=\n')
  const loud = await run(page, 'while getopts "a" o; do :; done; echo done', 'x', '-q')
  expect(loud.err).toContain('illegal option -- q')
  const dd = await run(page, script, 'x', '-a', '--', '-c')
  expect(dd.out).toBe('A\nrest=-c\n')
})

test('readonly, declare, let', async ({ page }) => {
  const r = await run(
    page,
    `readonly X=1
X=2
echo status=$? X=$X
declare -i n=2+3
echo n=$n
declare -x E=exported
sh -c 'echo child=$E'
f() { declare l=1; echo in=$l; }
f
echo after=\${l:-unset}
let "a=2+3" "b=a*2"
echo $a $b
let 0
echo let0=$?
declare -p E
`,
  )
  expect(r.out).toBe('status=1 X=1\nn=5\nchild=exported\nin=1\nafter=unset\n5 10\nlet0=1\ndeclare -x E=exported\n')
  expect(r.err).toContain('X: readonly variable')
})

test('pushd, popd and dirs keep a directory stack', async ({ page }) => {
  const r = await run(page, 'cd /tmp; pushd /; pwd; dirs; popd; pwd')
  expect(r.out).toBe('/ /tmp\n/\n/ /tmp\n/tmp\n/tmp\n')
})

test('command skips functions; command -v and -V; exec replaces the shell', async ({ page }) => {
  const r = await run(page, `echo() { printf 'shadow\\n'; }\necho hi\ncommand echo real\ncommand -v echo\ncommand -v nosuch; printf 'v=%s\\n' $?\ncommand -V ls\n`)
  expect(r.out).toBe('shadow\nreal\necho\nv=1\nls is /bin/ls\n')
  const e = await run(page, 'exec echo bye; echo not-reached')
  expect(e.out).toBe('bye\n')
  expect(e.code).toBe(0)
  const c = await run(page, "exec sh -c 'exit 3'; echo not-reached")
  expect(c.out).toBe('')
  expect(c.code).toBe(3)
})

test('set -o pipefail, set -o lists options', async ({ page }) => {
  const r = await run(page, 'false | true; echo a=$?; set -o pipefail; false | true; echo b=$?; true | false | true; echo c=$?; set +o pipefail; false | true; echo d=$?; set -o | grep pipefail')
  expect(r.out).toBe('a=0\nb=1\nc=1\nd=0\npipefail       off\n')
})

test('type -t, -a, -p; echo -e and -E', async ({ page }) => {
  const r = await run(page, `f() { :; }\ntype -t echo f ls nosuch\ntype -a echo\ntype -p ls\necho -e 'a\\tb\\x41'\necho -n -e 'x\\n'\necho -E 'a\\tb'\necho -e 'stop\\cnot'; echo`)
  expect(r.out).toBe('builtin\nfunction\nfile\necho is a shell builtin\necho is /bin/echo\n/bin/ls\na\tbA\nx\na\\tb\nstop\n')
})
