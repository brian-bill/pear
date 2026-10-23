/**
 * The shell and core utilities, end to end: scripts run with `sh -c`, and interactive sessions on a terminal.
 */
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

let installed: string[] = []

test.beforeEach(async ({ page }) => {
  installed = await page.evaluate(() => window.sh.installUserland())
})

interface Result {
  out: string
  err: string
  code: number | null
  signal: string | null
}

/** Run each script in a fresh `sh -c`; they share the file system, so later ones can use what earlier ones made. */
async function scripts(page: Page, list: Array<string | [string, ...string[]]>): Promise<Result[]> {
  return page.evaluate(async (list) => {
    const results = []
    for (const entry of list) {
      const [script, ...args] = typeof entry === 'string' ? [entry] : entry
      const st = await window.sh.run('/bin/sh', { args: ['-c', script!, ...args] })
      results.push({ out: st.stdout ?? '', err: st.stderr ?? '', code: st.code, signal: st.signal })
    }
    return results
  }, list)
}

const run = async (page: Page, script: string, ...args: string[]): Promise<Result> => (await scripts(page, [[script, ...args]]))[0]!

// ------------------------------------------------------------------- the language

test('echo, variables, quoting, status, && and ||, comments, ~', async ({ page }) => {
  const r = await run(
    page,
    `echo hello world
X=42; echo "x=$X" 'lit $X' $X
echo a  b   c
echo "a  b   c"
false; echo $?
true && echo and || echo or
false && echo and || echo or
echo one; echo two # a comment
echo ~
Y=$(echo   spaced   out); echo "[$Y]"
echo "[\${U:-default}] [\${X:+set}] [\${#X}]"
echo $0 $1 $# "$@"
echo 'it'"'"'s' "tab	in" \\$X`,
    'name',
    'a',
    'b c',
  )
  expect(r.err).toBe('')
  expect(r.out).toBe(
    [
      'hello world',
      'x=42 lit $X 42',
      'a b c',
      'a  b   c',
      '1',
      'and',
      'or',
      'one',
      'two',
      '/',
      '[spaced out]',
      '[default] [set] [2]',
      'name a 2 a b c',
      "it's tab\tin $X",
      '',
    ].join('\n'),
  )
})

test('wildcards expand against the real file system', async ({ page }) => {
  const r = await run(
    page,
    `mkdir -p /tmp/g/sub; cd /tmp/g; touch a.txt b.txt c.md .hid sub/x.txt
echo *.txt; echo *; echo .h*; echo sub/*; echo */; echo '*'; echo nomatch*; echo [ab].txt; echo ?.md; echo "*.md"`,
  )
  expect(r.err).toBe('')
  expect(r.out.split('\n')).toEqual(['a.txt b.txt', 'a.txt b.txt c.md sub', '.hid', 'sub/x.txt', 'sub/', '*', 'nomatch*', 'a.txt b.txt', 'c.md', '*.md', ''])
})

test('redirections: > >> < 2> 2>&1 &> and their order', async ({ page }) => {
  const r = await run(
    page,
    `cd /tmp
echo one > f; echo two >> f; cat f
cat < f | wc -l
ls /nonexistent 2> err; cat err
ls /nonexistent > out 2>&1; cat out
echo both &> all; cat all
cat missing 2>&1 | wc -l
ls /nonexistent 2>&1 > o2 | wc -l
ls /nonexistent > o3 2>&1 | wc -l
echo hi > /nonexistent/dir/f; echo status=$?
cat < nope; echo status=$?
echo to-err 1>&2`,
  )
  expect(r.out).toBe(
    [
      'one', 'two', '2',
      "ls: cannot access '/nonexistent': no such file or directory",
      "ls: cannot access '/nonexistent': no such file or directory",
      'both',
      '1', '1', '0',
      'status=1', 'status=1',
      '',
    ].join('\n'),
  )
  expect(r.err).toContain('/nonexistent/dir/f')
  expect(r.err).toContain('nope')
  expect(r.err).toMatch(/to-err\n$/)
})

test('pipelines: status, negation, large data, early exit of the reader', async ({ page }) => {
  const r = await run(
    page,
    `cd /tmp
echo hello | cat | cat | wc -c
yes | head -n 3
yes line | head -n 2 | wc -l
! false; echo $?
! true; echo $?
echo a | false; echo $?
false | true; echo $?
yes 0123456789 | head -n 20000 > big
wc -l big
cat big | cat | wc -c
cat big | grep -c 5678`,
  )
  expect(r.err).toBe('')
  expect(r.out.split('\n')).toEqual(['6', 'y', 'y', 'y', '2', '0', '1', '1', '0', '20000 big', '220000', '20000', ''])
})

test('command substitution captures output (including large), strips trailing newlines, nests', async ({ page }) => {
  const r = await run(
    page,
    `cd /tmp
A=$(echo one; echo two)
echo "[$A]"
echo "[$(echo $(echo nested))]"
B=$(yes 0123456789 | head -n 10000)
echo \${#B}
echo $(false) $?
C=$(ls /nonexistent 2>&1); echo "$C"`,
  )
  expect(r.out.split('\n')).toEqual(['[one', 'two]', '[nested]', String(10000 * 11 - 1), '1', "ls: cannot access '/nonexistent': no such file or directory", ''])
})

test('variables: export, assignment prefix, scripts and source', async ({ page }) => {
  const r = await run(
    page,
    `export A=1; B=2
sh -c 'echo [$A] [$B]'
C=3 sh -c 'echo [$C]'; echo [$C]
unset A; sh -c 'echo [$A]'
echo 'echo in script: $1 $#' > /tmp/s.sh
echo 'exit 7' >> /tmp/s.sh
echo 'echo not reached' >> /tmp/s.sh
sh /tmp/s.sh x y; echo status=$?
echo 'ZED=from-source' > /tmp/src.sh; . /tmp/src.sh; echo $ZED
sh -c 'exit 3'; echo $?
echo 'echo from stdin' | sh
cd /tmp && pwd && cd / && pwd`,
  )
  expect(r.err).toBe('')
  expect(r.out.split('\n')).toEqual(['[1] []', '[3]', '[]', '[]', 'in script: x 2', 'status=7', 'from-source', '3', 'from stdin', '/tmp', '/', ''])
})

test('errors: unknown commands, syntax, bad redirects', async ({ page }) => {
  const rs = await scripts(page, [
    'nosuchcmd; echo $?',
    "echo 'unterminated",
    'echo a | | cat',
    'cd /nonexistent; echo $?',
    '/bin/nonexistent; echo $?',
    '/tmp; echo $?',
    'echo hi >&9',
  ])
  expect(rs[0]).toMatchObject({ out: '127\n', err: 'sh: nosuchcmd: command not found\n' })
  expect(rs[1]).toMatchObject({ code: 2 })
  expect(rs[1]!.err).toContain('unterminated single quote')
  expect(rs[2]).toMatchObject({ code: 2 })
  expect(rs[3]!.out).toBe('1\n')
  expect(rs[3]!.err).toContain('/nonexistent')
  expect(rs[4]!.out).toBe('127\n')
  expect(rs[5]!.out).toBe('127\n')
  expect(rs[6]!.err).not.toBe('')
})

// ------------------------------------------------------------- core utilities

test('ls, mkdir, touch, cp, mv, rm', async ({ page }) => {
  const r = await run(
    page,
    `cd /tmp; mkdir -p d/e/f; echo data > d/a; cp d/a d/b; cp -r d d2; mv d2 d3
ls d3; echo --; ls -a d3; echo --; ls -d d3; ls -l d3/a
touch t d3/t2; ls t d3
mv t d3; ls d3
rm d3/a; ls d3
rm d3; echo status=$?
rm -r d3; ls d3 2>&1
rm -f nothing; echo f=$?
rm nothing; echo plain=$?
cp d/a; echo cp=$?
mkdir d; echo mkdir=$?
mkdir -p d; echo mkdirp=$?`,
  )
  const lines = r.out.split('\n')
  const long = lines[11]!
  expect(long).toMatch(/^-rw[-rwx]{7} 1 \d+ \d+ 5 [A-Z][a-z]{2} [ \d]\d [ \d:]{5} d3\/a$/)
  lines.splice(11, 1)
  expect(lines).toEqual([
    'a', 'b', 'e', '--',
    '.', '..', 'a', 'b', 'e', '--',
    'd3',
    't', '', 'd3:', 'a', 'b', 'e', 't2',
    'a', 'b', 'e', 't', 't2',
    'b', 'e', 't', 't2',
    'status=1',
    "ls: cannot access 'd3': no such file or directory",
    'f=0', 'plain=1', 'cp=1', 'mkdir=1', 'mkdirp=0',
    '',
  ])
  expect(r.err).toContain('rm: d3: is a directory')
})

test('cat, head, tail, wc', async ({ page }) => {
  const r = await run(
    page,
    `cd /tmp; echo 1 > n; echo 2 >> n; echo 3 >> n; echo 4 >> n; echo 5 >> n
head -n 2 n; echo --; head -2 n; echo --; tail -n 2 n; echo --; tail -1 n; echo --; cat n | tail -n 3; echo --; head -n 0 n; echo --
wc -l n; wc n; cat n | wc -l; wc -c n; wc -w n n
echo from-stdin | cat n - n | wc -l
head -n 1 n n
cat nonexistent n; echo status=$?`,
  )
  expect(r.out.split('\n')).toEqual([
    '1', '2', '--', '1', '2', '--', '4', '5', '--', '5', '--', '3', '4', '5', '--', '--',
    '5 n', ' 5  5 10 n', '5', '10 n', ' 5 n', ' 5 n', '10 total',
    '11',
    '==> n <==', '1', '', '==> n <==', '1',
    '1', '2', '3', '4', '5', 'status=1',
    '',
  ])
  expect(r.err).toBe('cat: nonexistent: no such file or directory\n')
})

test('grep', async ({ page }) => {
  const r = await run(
    page,
    `cd /tmp; echo apple > g; echo Banana >> g; echo cherry >> g; echo apple pie >> g; echo x > n2
grep apple g; echo --; grep -c apple g; grep -v apple g; echo --; grep -i banana g; grep -n cherry g
grep -F 'a.p' g; echo F=$?
grep -E '^(apple|cherry)' g; echo --
grep nomatch g; echo none=$?
cat g | grep -c e
grep apple g n2; echo --
mkdir -p gd/sub; echo needle > gd/sub/f; echo hay > gd/h; grep -r needle gd
grep -l apple g n2; grep -q apple g; echo q=$?
grep '[' g; echo bad=$?`,
  )
  expect(r.out.split('\n')).toEqual([
    'apple', 'apple pie', '--', '2', 'Banana', 'cherry', '--', 'Banana', '3:cherry', 'F=1',
    'apple', 'cherry', 'apple pie', '--',
    'none=1', '3', 'g:apple', 'g:apple pie', '--', 'gd/sub/f:needle', 'g', 'q=0', 'bad=2',
    '',
  ])
  expect(r.err).toContain('grep: bad pattern')
})

test('sleep, kill, env, ps, and background jobs in a script', async ({ page }) => {
  const r = await run(
    page,
    `sleep 30 & kill $!; wait; echo term=$?
sleep 30 & kill -KILL $!; wait; echo kill=$?
sleep 30 & kill -s TERM $!; wait; echo s=$?
sleep 0.1 & sleep 0.1 & wait; echo waited=$?
FOO=bar env | grep FOO
ps | head -n 1
sleep 5 & ps | grep -c '^ *[0-9]+ +[0-9]+ +[0-9]+ running  sleep 5$'; kill $!; wait
kill 99999; echo nokill=$?
sleep abc; echo badsleep=$?
sleep 0.05 & wait $!; echo pid-wait=$?`,
  )
  expect(r.out.split('\n')).toEqual([
    'term=143', 'kill=137', 's=143', 'waited=0', 'FOO=bar',
    '  PID  PPID  PGID STATE    COMMAND',
    '1', 'nokill=1', 'badsleep=1', 'pid-wait=0',
    '',
  ])
  expect(r.err).toContain('kill: 99999')
})

// ------------------------------------------------------------- control flow and more

test('if / elif / else, test and [', async ({ page }) => {
  const r = await run(
    page,
    `mkdir d; echo x > d/f
if [ -d d ]; then echo dir; fi
if [ -f d ]; then echo file; else echo notfile; fi
if test -s d/f && [ ! -e nope ]; then echo yes; fi
n=5
if [ "$n" -lt 3 ]; then echo small
elif [ "$n" -lt 10 ]; then echo medium
else echo large
fi
if [ a = a -a b != c ]; then echo both; fi
if [ -z "" ] && [ -n x ] && [ \\( 1 -eq 1 \\) ]; then echo strs; fi
if false; then echo no; fi; echo "status=$?"
if grep -q x d/f; then echo grepped; fi
[ 1 -eq x ]; echo "bad=$?"
[ 1 = 1; echo "unterminated=$?"`,
  )
  expect(r.out).toBe('dir\nnotfile\nyes\nmedium\nboth\nstrs\nstatus=0\ngrepped\nbad=2\nunterminated=2\n')
  expect(r.err).toContain('integer expression expected')
})

test('for, while, until, break and continue', async ({ page }) => {
  const r = await run(
    page,
    `for x in a b c; do echo "item $x"; done
for f in *.none; do echo "$f"; done
set -- p q
for a; do echo "arg $a"; done
i=0
while [ $i -lt 3 ]; do echo "i=$i"; i=$((i + 1)); done
until [ $i -eq 0 ]; do i=$((i - 1)); done; echo "i=$i"
for x in 1 2 3 4; do
  [ $x -eq 2 ] && continue
  [ $x -eq 4 ] && break
  echo "x=$x"
done
for a in 1 2; do for b in 1 2 3; do [ $b -eq 2 ] && continue 2; echo "$a$b"; done; done
for a in 1 2; do for b in 1 2; do echo "$a$b"; break 2; done; done
for x in {1..3}; do echo -n "$x "; done; echo
break; echo after`,
  )
  expect(r.out).toBe('item a\nitem b\nitem c\n*.none\narg p\narg q\ni=0\ni=1\ni=2\ni=0\nx=1\nx=3\n11\n21\n11\n1 2 3 \nafter\n')
  expect(r.err).toContain('only meaningful in a')
})

test('case matches patterns, alternatives, quoted text and falls through to *', async ({ page }) => {
  const r = await run(
    page,
    `t() {
  case "$1" in
    a|b) echo "ab" ;;
    [0-9]*) echo "number" ;;
    "*") echo "star" ;;
    *.txt) echo "text" ;;
    *) echo "other" ;;
  esac
}
t a; t b; t 42x; t '*'; t notes.txt; t zzz
case x in y) echo no ;; esac; echo "status=$?"`,
  )
  expect(r.out).toBe('ab\nab\nnumber\nstar\ntext\nother\nstatus=0\n')
})

test('functions: arguments, return, recursion, local, redirection and pipes', async ({ page }) => {
  const r = await run(
    page,
    `greet() { echo "hello $1 ($#)"; }
greet world; greet a b
add() { echo $(($1 + $2)); }
add 2 3
check() { [ "$1" = ok ] && return 0; return 7; }
check ok; echo "r=$?"; check no; echo "r=$?"
fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(($1 - 1))) )); fi; }
fact 5
X=outer
scope() { local X=inner; echo "in=$X"; }
scope; echo "out=$X"
out() { echo to-file; }
out > f.txt; cat f.txt
lines() { echo one; echo two; }
lines | wc -l
cnt() { echo $#; shift; echo $#; }
cnt a b c
type greet
unset -f greet; type greet`,
  )
  expect(r.out).toBe('hello world (1)\nhello a (2)\n5\nr=0\nr=7\n120\nin=inner\nout=outer\nto-file\n2\n3\n2\ngreet is a function\n')
  expect(r.err).toContain('greet: not found')
})

test('here-documents, with expansion, quoting, <<- and in a pipeline or loop', async ({ page }) => {
  const r = await run(
    page,
    `NAME=world
cat <<EOF
hello $NAME
sum=$((1 + 2)) \\$literal $(echo sub)
EOF
cat <<'EOF'
raw $NAME $(not run)
EOF
cat <<-EOF
	tabs removed
	EOF
cat <<EOF | grep -i PIPED
piped
EOF
while read a b; do echo "[$a|$b]"; done <<EOF
one two three
four
EOF
f() { cat; }
f <<EOF
through a function
EOF`,
  )
  expect(r.out).toBe('hello world\nsum=3 $literal sub\nraw $NAME $(not run)\ntabs removed\npiped\n[one|two three]\n[four|]\nthrough a function\n')
})

test('groups and subshells: redirection, and what a subshell may not change', async ({ page }) => {
  const r = await run(
    page,
    `{ echo a; echo b; } > g.txt; cat g.txt
X=1
( X=2; cd /tmp; echo "in $X $(pwd)" )
echo "out $X $(pwd)"
( exit 3 ); echo "status=$?"
{ echo piped; echo through; } | wc -l
V=$(X=9; echo $X); echo "$V $X"
(echo bg; sleep 0) & wait
echo done`,
  )
  expect(r.out).toBe('a\nb\nin 2 /tmp\nout 1 /\nstatus=3\n2\n9 1\nbg\ndone\n')
})

test('read, in a pipeline, from a file and from stdin; the exit status says end of input', async ({ page }) => {
  const r = await run(
    page,
    `echo "k1 v1
k2 v2 more" > in.txt
while read k v; do echo "$k=$v"; done < in.txt
echo "a b c" | { read x y; echo "x=$x y=$y"; }
echo hello | { read; echo "REPLY=$REPLY"; }
echo 'back\\slash' | { read -r l; echo "$l"; }
echo 'back\\slash' | { read l; echo "$l"; }
echo -n last | { read l; echo "l=$l status=$?"; }
read z < /dev/null; echo "empty=$? [$z]"
cat in.txt | while read line; do n=$((n+1)); done; echo done`,
  )
  expect(r.out).toBe('k1=v1\nk2=v2 more\nx=a y=b c\nREPLY=hello\nback\\slash\nbackslash\nl=last status=1\nempty=1 []\ndone\n')
})

test('arithmetic expansion, brace expansion, and aliases', async ({ page }) => {
  const r = await run(
    page,
    `n=6; echo $((n * 7)) $((n % 4)) $((n > 3 ? 1 : 0)) $(( (1+2) * 3 ))
echo $((x = 5)) $x $((x += 2)) $((x++)) $x
echo {a,b,c} file{1..3}.txt {x,y}{1,2}
echo "{a,b}" '{1..3}'
mkdir -p t/{a,b}; ls t
alias say='echo said'
eval 'say hi'
alias
unalias say
eval 'say again'
alias nope`,
  )
  expect(r.out).toBe("42 2 1 9\n5 5 7 7 8\na b c file1.txt file2.txt file3.txt x1 x2 y1 y2\n{a,b} {1..3}\na\nb\nsaid hi\nalias say='echo said'\n")
  expect(r.err).toContain('say: command not found')
  expect(r.err).toContain('alias: nope: not found')
})

test('set -e, -u and -x; shift; eval; trap EXIT', async ({ page }) => {
  const results = await scripts(page, [
    'set -e; echo before; false; echo after',
    'set -e; false || echo rescued; if false; then :; fi; false && echo no; echo kept',
    'set -u; echo "$UNSETVAR"; echo after',
    'set -u; echo ${UNSETVAR:-fine}; echo ok',
    'set -x; echo traced "two words"',
    'set -- a b c; shift; echo "$# $1"; shift 5; echo "status=$?"',
    'eval "X=1; echo got \\$X"',
    'trap "echo bye" EXIT; echo working; exit 3',
    'trap "echo one" EXIT; trap - EXIT; echo none',
    'trap; trap "echo hi" EXIT; trap',
  ])
  expect(results.map((r) => r.out)).toEqual([
    'before\n', 'rescued\nkept\n', '', 'fine\nok\n', 'traced two words\n', '2 b\nstatus=1\n', 'got 1\n', 'working\nbye\n', 'none\n', "trap -- 'echo hi' EXIT\nhi\n",
  ])
  expect(results[0]!.code).toBe(1)
  expect(results[2]!.err).toContain('UNSETVAR: unbound variable')
  expect(results[2]!.code).toBe(1)
  expect(results[4]!.err).toBe('+ echo traced two words\n')
  expect(results[7]!.code).toBe(3)
})

test('a signal runs its trap', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.installUserland()
    const pid = await kernel.spawn('/bin/sh', { args: ['-c', 'trap "echo got-term; exit 5" TERM; echo ready; sleep 30 & wait'] })
    await sh.sleep(500)
    await kernel.kill(pid, 'SIGTERM')
    const st = await kernel.wait(pid)
    return { out: st.stdout, code: st.code }
  })
  expect(r).toEqual({ out: 'ready\ngot-term\n', code: 5 })
})

test('syntax errors in compound commands are reported, nothing runs', async ({ page }) => {
  const results = await scripts(page, ['echo before; if true; then echo x', 'echo a; fi', 'echo a; done', 'f() echo hi', 'for 1x in a; do :; done', 'case x in a) ;; ; esac', 'cat <<EOF\nno end'])
  for (const r of results) {
    expect(r.out).toBe('')
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/^sh: /)
  }
})

test('startup files and history recall on a terminal', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { kernel, sh } = window
    await kernel.mkdir('/root-home', { recursive: true })
    await kernel.writeFile('/root-home/.shrc', new TextEncoder().encode('alias hi="echo hi from"\nGREETING=hello\n'))
    return sh.session(
      `echo $GREETING
echo one
echo two
!!
!2
!ec
echo wow! x
echo '!!'
!nope
echo $((1 + 1))
f() {
  echo in-f
}
f
for i in 1 2; do
echo loop$i
done
hi there
exit
`,
      { HOME: '/root-home' },
    )
  })
  expect(r.out.split('\r\n')).toEqual([
    'hello', 'one', 'two', 'echo two', 'two', 'echo one', 'one', 'echo one', 'one', 'wow! x', '!!', 'sh: !nope: event not found', '2', 'in-f', 'loop1', 'loop2', 'hi from there', '',
  ])
  expect(r.code).toBe(0)
})

// --------------------------------------------------------------- on a terminal

test('an interactive shell: pipes, redirects, cd, history, continuation lines', async ({ page }) => {
  const r = await page.evaluate(
    (input) => window.sh.session(input),
    `echo hi
ls /bin | wc -l
cd /tmp
pwd
cd -
pwd
echo "a
b"
echo one > t; cat t
history
exit 4
`,
  )
  expect(r.out.split('\r\n')).toEqual([
    'hi', String(installed.length), '/tmp', '/', '/', 'a', 'b', 'one',
    '    1  echo hi', '    2  ls /bin | wc -l', '    3  cd /tmp', '    4  pwd', '    5  cd -', '    6  pwd',
    '    7  echo "a', 'b"', '    8  echo one > t; cat t', '    9  history',
    '',
  ])
  expect(r.code).toBe(4)
})

test('background jobs: numbering, jobs, kill %n, fg, and the Done notice', async ({ page }) => {
  const r = await page.evaluate(
    (input) => window.sh.session(input),
    `sleep 30 &
jobs
kill %1
wait
jobs
echo after-kill
sleep 0.1 &
sleep 0.6
echo next
sleep 0.3 &
fg
echo back
exit
`,
  )
  // The job numbers are fixed; the process group ids are not.
  const lines = r.out.split('\r\n').map((l) => l.replace(/^(\[\d\]) \d+$/, '$1 PGID'))
  expect(lines).toEqual([
    '[1] PGID',
    '[1]+  Running    sleep 30 &',
    'after-kill',
    '[2] PGID',
    '[2]+  Done       sleep 0.1',
    'next',
    '[3] PGID',
    'sleep 0.3',
    'back',
    '',
  ])
})

test('pipelines on a terminal: a reader that quits ends the writer, and the shell reports the last status', async ({ page }) => {
  const r = await page.evaluate(
    (input) => window.sh.session(input),
    `yes | head -n 2
echo $?
yes | head -n 1 | wc -l
false | true
echo $?
ps | grep -c running
exit
`,
  )
  expect(r.out.split('\r\n')).toEqual(['y', 'y', '0', '1', '0', '3', ''])
})

test('^C stops the foreground job and not the shell; ^D at the prompt exits', async ({ page }) => {
  const res = await page.evaluate(async () => {
    const { kernel, sh } = window
    const { pid, master } = await kernel.spawnPty('/bin/sh', { env: { PS1: '$ ' } })
    const seen: string[] = []
    const step = async (send: string, until: string) => {
      if (send) await kernel.pipeWrite(master, send)
      seen.push(await sh.expect(master, until))
    }
    await step('', '$ ')
    await step('sleep 30\r', 'sleep 30\r\n')
    await sh.sleep(400) // the job is running and owns the terminal
    await step('\x03', '$ ')
    await step('echo status=$?\r', 'status=130\r\n$ ')
    await step('echo alive\r', 'alive\r\n$ ')
    await step('sleep 30 &\r', '$ ')
    await step('\x03', '$ ') // ^C at the prompt only gives a fresh prompt; the background job is not touched
    await step('jobs\r', '$ ')
    await step('\x04', 'exit\r\n')
    const st = await kernel.wait(pid)
    return { seen, code: st.code, signal: st.signal }
  })
  expect(res.seen[2]).toContain('^C') // the terminal showed it
  expect(res.seen[3]).toBe('echo status=$?\r\nstatus=130\r\n$ ')
  expect(res.seen[7]).toMatch(/\[1\]\+  Running    sleep 30 &\r\n\$ $/)
  expect(res.code).toBe(0)
  expect(res.signal).toBeNull()
})

test('the shell hangs up its background jobs when it exits', async ({ page }) => {
  const res = await page.evaluate(async () => {
    const { kernel, sh } = window
    const { pid, master } = await kernel.spawnPty('/bin/sh', { env: { PS1: '' } })
    await kernel.tcsetattr(master, { echo: false })
    await kernel.pipeWrite(master, 'sleep 30 &\n')
    await sh.expect(master, '\r\n')
    const before = (await kernel.listProcesses()).filter((p) => p.name === 'sleep' && p.state === 'running').length
    await kernel.pipeWrite(master, 'exit\n')
    await kernel.wait(pid)
    let after = before
    for (let i = 0; i < 100 && after > 0; i++) {
      await sh.sleep(50)
      after = (await kernel.listProcesses()).filter((p) => p.name === 'sleep' && p.state === 'running').length
    }
    return { before, after }
  })
  expect(res).toEqual({ before: 1, after: 0 })
})
