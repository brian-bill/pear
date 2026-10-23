/**
 * Shell syntax and expansion, tested directly (no browser): parser output, quoting, variables, globbing.
 */
import { expect, test } from '@playwright/test'

import { evalArith } from '../userland/shell/arith'
import { braceExpand, expandPattern, expandWord, glob, hasMagic, segmentToRegex, type ExpandContext } from '../userland/shell/expand'
import { parse, ParseError, type Compound } from '../userland/shell/parse'

const FILES = ['/home/a.txt', '/home/b.txt', '/home/c.md', '/home/.hidden', '/home/sub/x.txt', '/home/sub/y.md', '/other/z.txt']

function fakeContext(vars: Record<string, string> = {}, positional: string[] = [], captured: Record<string, string> = {}): ExpandContext {
  const dirs = new Set<string>(['/', '/home', '/home/sub', '/other'])
  return {
    get: (n) => vars[n],
    positional: () => positional,
    runCapture: async (src) => captured[src] ?? `<${src}>`,
    home: () => '/home',
    cwd: () => '/home',
    readdir: async (path) => {
      const clean = path === '' ? '/home' : path.replace(/\/$/, '') || '/'
      const p = clean.startsWith('/') ? clean : `/home/${clean}`
      if (!dirs.has(p)) throw new Error('ENOENT')
      const names = new Set<string>()
      for (const f of [...FILES, ...dirs]) {
        const parent = f.slice(0, f.lastIndexOf('/')) || '/'
        if (parent === p && f !== p) names.add(f.slice(f.lastIndexOf('/') + 1))
      }
      return [...names].map((name) => ({ name }))
    },
    exists: async (path) => FILES.includes(path) || dirs.has(path.replace(/\/$/, '') || '/'),
    isDir: async (path) => dirs.has(path.replace(/\/$/, '') || '/'),
  }
}

const words = async (src: string, ctx = fakeContext()) => {
  const item = parse(src)[0]!
  const cmd = item.andor.first.cmds[0]!
  const out: string[] = []
  for (const w of cmd.words) out.push(...(await expandWord(w, ctx)))
  return out
}

// ------------------------------------------------------------------- parsing

test('a list of commands: ; & && || | and newlines', () => {
  const items = parse('a; b && c || d | e & f\ng')
  expect(items.map((i) => i.src)).toEqual(['a', 'b && c || d | e', 'f', 'g'])
  expect(items.map((i) => i.background)).toEqual([false, true, false, false])
  expect(items[1]!.andor.rest.map((r) => r.op)).toEqual(['&&', '||'])
  expect(items[1]!.andor.rest[1]!.pipe.cmds).toHaveLength(2)
})

test('redirections, with and without a stream number', () => {
  const cmd = parse('cmd <in >out 2>err >>log 2>&1 &>all')[0]!.andor.first.cmds[0]!
  expect(cmd.words).toHaveLength(1)
  expect(cmd.redirs.map((r) => [r.fd, r.op])).toEqual([
    [0, '<'], [1, '>'], [2, '>'], [1, '>>'], [2, '>&'], [1, '>'], [2, '>&'],
  ])
  // A number that is not glued to the operator is an ordinary argument.
  expect(parse('echo 2 > f')[0]!.andor.first.cmds[0]!.words).toHaveLength(2)
})

test('assignments before a command, and alone', () => {
  const a = parse('A=1 B="x y" cmd arg')[0]!.andor.first.cmds[0]!
  expect(a.assigns.map((x) => x.name)).toEqual(['A', 'B'])
  expect(a.words).toHaveLength(2)
  const b = parse('X=1')[0]!.andor.first.cmds[0]!
  expect(b.words).toHaveLength(0)
  // After the command word it is just an argument.
  expect(parse('echo A=1')[0]!.andor.first.cmds[0]!.assigns).toHaveLength(0)
})

test('! negates a pipeline; comments are ignored', () => {
  expect(parse('! false')[0]!.andor.first.negate).toBe(true)
  expect(parse('echo hi # not this')[0]!.andor.first.cmds[0]!.words).toHaveLength(2)
  expect(parse('# only a comment')).toEqual([])
  expect(parse('echo a#b')[0]!.andor.first.cmds[0]!.words).toHaveLength(2) // # inside a word is literal
})

test('unfinished input is reported as incomplete, other mistakes as errors', () => {
  const incomplete = ['if true', 'if true; then echo hi', 'while true; do', 'for x in a b', 'case x in', 'case x in a) echo', '{ echo', '(echo', 'cat <<EOF\nbody', "echo 'abc", 'echo "abc', 'echo hi |', 'a &&', 'echo \\', 'echo $(ls', 'echo ${X']
  for (const src of incomplete) {
    const e = (() => { try { parse(src) } catch (err) { return err } })()
    expect(e, src).toBeInstanceOf(ParseError)
    expect((e as ParseError).incomplete, src).toBe(true)
  }
  const wrong = ['| a', 'a ; ; b' + ' ||', '>', 'echo >', '(a', 'a ;; b', 'fi', 'echo )', 'f() echo hi']
  for (const src of wrong) {
    const e = (() => { try { parse(src) } catch (err) { return err } })()
    expect(e, src).toBeInstanceOf(ParseError)
  }
  expect(() => parse('a ; b ;')).not.toThrow()
})

// ------------------------------------------------------------------ expansion

test('quoting: single, double, backslash', async () => {
  const ctx = fakeContext({ X: 'val ue' })
  expect(await words("echo 'a  b' \"c $X\" d\\ e", ctx)).toEqual(['echo', 'a  b', 'c val ue', 'd e'])
  expect(await words('echo "a\\"b" \'$X\' "\\$X" "\\n"', ctx)).toEqual(['echo', 'a"b', '$X', '$X', '\\n'])
  expect(await words('echo "" \'\' a""b', ctx)).toEqual(['echo', '', '', 'ab'])
})

test('variables: splitting only when unquoted; ${} forms', async () => {
  const ctx = fakeContext({ X: 'a  b c', E: '', N: '5' })
  expect(await words('echo $X', ctx)).toEqual(['echo', 'a', 'b', 'c'])
  expect(await words('echo "$X"', ctx)).toEqual(['echo', 'a  b c'])
  expect(await words('echo $E x', ctx)).toEqual(['echo', 'x']) // empty unquoted vanishes
  expect(await words('echo "$E" x', ctx)).toEqual(['echo', '', 'x'])
  expect(await words('echo ${X} ${U:-dflt} ${E:-dflt} ${E-kept} ${U-kept} ${N:+set} ${U:+set}x', ctx)).toEqual(['echo', 'a', 'b', 'c', 'dflt', 'dflt', 'kept', 'set', 'x'])
  expect(await words('echo ${#X} pre${N}post $N$N', ctx)).toEqual(['echo', '6', 'pre5post', '55'])
  expect(await words('echo $ $5 a$', ctx)).toEqual(['echo', '$', 'a$'])
})

test('positional parameters and "$@"', async () => {
  const ctx = fakeContext({ '#': '3', '1': 'one', '2': 'two words' }, ['one', 'two words', 'three'])
  expect(await words('echo $1 "$2"', ctx)).toEqual(['echo', 'one', 'two words'])
  expect(await words('echo "$@"', ctx)).toEqual(['echo', 'one', 'two words', 'three'])
  expect(await words('echo "$*"', ctx)).toEqual(['echo', 'one two words three'])
  expect(await words('echo $*', ctx)).toEqual(['echo', 'one', 'two', 'words', 'three'])
  expect(await words('echo "x$@y"', fakeContext({}, ['a', 'b']))).toEqual(['echo', 'xa', 'by'])
  expect(await words('echo "$@"', fakeContext())).toEqual(['echo'])
})

test('command substitution, nested and quoted', async () => {
  const ctx = fakeContext({}, [], { 'echo a b': 'a b', 'echo $(echo x)': 'x' })
  expect(await words('echo $(echo a b)', ctx)).toEqual(['echo', 'a', 'b'])
  expect(await words('echo "$(echo a b)"', ctx)).toEqual(['echo', 'a b'])
  expect(await words('echo $(echo $(echo x))', ctx)).toEqual(['echo', 'x'])
  expect(await words('echo "$(echo "a)")"', ctx)).toEqual(['echo', '<echo "a)">'])
})

test('tilde expands only at the start of an unquoted word', async () => {
  expect(await words('echo ~ ~/x a~ "~" \'~\'')).toEqual(['echo', '/home', '/home/x', 'a~', '~', '~'])
})

// -------------------------------------------------------------------- globbing

test('wildcards: *, ?, [..], directories, hidden files', async () => {
  const w = (src: string) => words(src)
  expect(await w('echo *.txt')).toEqual(['echo', 'a.txt', 'b.txt'])
  expect(await w('echo [ab].*')).toEqual(['echo', 'a.txt', 'b.txt'])
  expect(await w('echo [!a]*')).toEqual(['echo', 'b.txt', 'c.md', 'sub'])
  expect(await w('echo ?.md')).toEqual(['echo', 'c.md'])
  expect(await w('echo sub/*')).toEqual(['echo', 'sub/x.txt', 'sub/y.md'])
  expect(await w('echo */*.md')).toEqual(['echo', 'sub/y.md'])
  expect(await w('echo /other/*')).toEqual(['echo', '/other/z.txt'])
  expect(await w('echo .h*')).toEqual(['echo', '.hidden'])
  expect(await w('echo *')).toEqual(['echo', 'a.txt', 'b.txt', 'c.md', 'sub']) // no dotfiles
  expect(await w('echo */')).toEqual(['echo', 'sub/'])
})

test('a pattern with no match stays as written; quoting turns wildcards off', async () => {
  expect(await words('echo *.zip nothing[xy]')).toEqual(['echo', '*.zip', 'nothing[xy]'])
  expect(await words('echo "*.txt" \'*.txt\' \\*.txt *"."txt')).toEqual(['echo', '*.txt', '*.txt', '*.txt', 'a.txt', 'b.txt'].slice(0, 4).concat(['a.txt', 'b.txt']).slice(0, 4).concat(['a.txt', 'b.txt']))
  // A variable's value is globbed too, unless quoted.
  expect(await words('echo $P "$P"', fakeContext({ P: '*.md' }))).toEqual(['echo', 'c.md', '*.md'])
})

test('glob helpers', () => {
  expect(hasMagic('a*')).toBe(true)
  expect(hasMagic('a\\*')).toBe(false)
  expect(hasMagic('a[b')).toBe(false)
  expect(hasMagic('a[b]')).toBe(true)
  expect(segmentToRegex('a*b?').test('axxbc')).toBe(true)
  expect(segmentToRegex('a*b?').test('ab')).toBe(false)
  expect(segmentToRegex('[a-c]x').test('bx')).toBe(true)
  expect(segmentToRegex('a.b').test('axb')).toBe(false) // the dot is literal
})

test('glob returns nothing for a missing directory', async () => {
  expect(await glob('/nope/*', fakeContext())).toEqual([])
})

// ---------------------------------------------------------- compound commands

const compoundOf = (src: string): Compound => parse(src)[0]!.andor.first.cmds[0]!.compound!

test('if, while, for, case, groups, subshells and functions parse', () => {
  const c = compoundOf('if a; then b; elif c; then d; else e; fi')
  expect(c.k).toBe('if')
  if (c.k === 'if') {
    expect(c.branches).toHaveLength(2)
    expect(c.else).toHaveLength(1)
  }
  expect(compoundOf('while a\ndo\n b\ndone').k).toBe('while')
  expect((compoundOf('until a; do b; done') as Extract<Compound, { k: 'while' }>).until).toBe(true)
  const f = compoundOf('for x in a b c; do echo $x; done') as Extract<Compound, { k: 'for' }>
  expect([f.name, f.words!.length, f.body.length]).toEqual(['x', 3, 1])
  expect((compoundOf('for x; do :; done') as Extract<Compound, { k: 'for' }>).words).toBeNull()
  const k = compoundOf('case $x in\n a|b) one ;;\n (c) two\n ;;\n *) three\nesac') as Extract<Compound, { k: 'case' }>
  expect(k.clauses.map((cl) => cl.patterns.length)).toEqual([2, 1, 1])
  expect(compoundOf('{ a; b; }').k).toBe('group')
  expect(compoundOf('(a; b)').k).toBe('subshell')
  expect(compoundOf('f() { a; }')).toMatchObject({ k: 'func', name: 'f' })
  expect(compoundOf('function g { a; }')).toMatchObject({ k: 'func', name: 'g' })
  // redirections after a compound command, and a compound command in a pipeline
  const item = parse('while read l; do echo $l; done < in | sort')[0]!
  expect(item.andor.first.cmds).toHaveLength(2)
  expect(item.andor.first.cmds[0]!.redirs).toHaveLength(1)
  expect(item.src).toBe('while read l; do echo $l; done < in | sort')
})

test('keywords are only keywords where a command starts', () => {
  const cmd = parse('echo if then fi done }')[0]!.andor.first.cmds[0]!
  expect(cmd.compound).toBeUndefined()
  expect(cmd.words).toHaveLength(6)
})

test('here-documents: bodies, <<-, quoted delimiters, several on a line', async () => {
  const cmd = parse('cat <<EOF\nhello $X\nEOF\n')[0]!.andor.first.cmds[0]!
  expect(cmd.redirs).toHaveLength(1)
  expect(cmd.redirs[0]).toMatchObject({ fd: 0, op: '<<' })
  const ctx = fakeContext({ X: 'world' })
  expect(await expandWord(cmd.redirs[0]!.target, ctx, { split: false, glob: false })).toEqual(['hello world\n'])
  const quoted = parse("cat <<'EOF'\nhello $X\nEOF")[0]!.andor.first.cmds[0]!
  expect(await expandWord(quoted.redirs[0]!.target, ctx, { split: false, glob: false })).toEqual(['hello $X\n'])
  const stripped = parse('cat <<-EOF\n\t\tindented\n\tEOF')[0]!.andor.first.cmds[0]!
  expect(await expandWord(stripped.redirs[0]!.target, ctx, { split: false, glob: false })).toEqual(['indented\n'])
  const two = parse('cat <<A <<B\none\nA\ntwo\nB\necho after')
  expect(two).toHaveLength(2)
  expect(two[0]!.andor.first.cmds[0]!.redirs).toHaveLength(2)
})

test('aliases replace a word where a command starts', () => {
  const aliases = new Map([['ll', 'ls -l'], ['loop', 'loop']])
  const cmd = parse('ll /tmp', { aliases })[0]!.andor.first.cmds[0]!
  expect(cmd.words).toHaveLength(3)
  expect(parse('echo ll', { aliases })[0]!.andor.first.cmds[0]!.words).toHaveLength(2)
  expect(() => parse('loop', { aliases })).not.toThrow() // an alias that names itself does not recurse
})

// ----------------------------------------------------- braces and arithmetic

const braces = (src: string) => braceExpand(parse(`x ${src}`)[0]!.andor.first.cmds[0]!.words[1]!).map((w) => w.map((p) => (p.t === 'lit' ? p.s : `$${(p as { name: string }).name}`)).join(''))

test('brace expansion: lists, sequences, nesting, prefixes', () => {
  expect(braces('{a,b,c}')).toEqual(['a', 'b', 'c'])
  expect(braces('pre{a,b}post')).toEqual(['preapost', 'prebpost'])
  expect(braces('{1..4}')).toEqual(['1', '2', '3', '4'])
  expect(braces('{3..1}')).toEqual(['3', '2', '1'])
  expect(braces('{a..d}')).toEqual(['a', 'b', 'c', 'd'])
  expect(braces('{08..10}')).toEqual(['08', '09', '10'])
  expect(braces('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2'])
  expect(braces('{a,{b,c}}')).toEqual(['a', 'b', 'c'])
  expect(braces('{a}')).toEqual(['{a}'])
  expect(braces('{}')).toEqual(['{}'])
  expect(braces('{$A,$B}')).toEqual(['$A', '$B'])
  expect(braces('"{a,b}"')).toEqual(['{a,b}'])
})

test('arithmetic: operators, precedence, variables, assignment, errors', () => {
  const vars: Record<string, string> = { a: '7', b: '2', s: '3+4' }
  const env = { get: (n: string) => vars[n], set: (n: string, v: string) => void (vars[n] = v) }
  const ev = (s: string) => evalArith(s, env)
  expect(ev('1 + 2 * 3')).toBe(7)
  expect(ev('(1 + 2) * 3')).toBe(9)
  expect(ev('a / b')).toBe(3)
  expect(ev('-a % 4')).toBe(-3)
  expect(ev('2 ** 3 ** 2')).toBe(512)
  expect(ev('a > b && b > 1')).toBe(1)
  expect(ev('a < b || 0')).toBe(0)
  expect(ev('a > b ? 10 : 20')).toBe(10)
  expect(ev('1 << 4 | 3')).toBe(19)
  expect(ev('0x1f + 010')).toBe(39)
  expect(ev('$a + ${b}')).toBe(9)
  expect(ev('s')).toBe(7)
  expect(ev('')).toBe(0)
  expect(ev('c = a + 1, c * 2')).toBe(16)
  expect(vars.c).toBe('8')
  expect(ev('c += 2')).toBe(10)
  expect(ev('c++')).toBe(10)
  expect(vars.c).toBe('11')
  expect(ev('--c')).toBe(10)
  expect(ev('0 ? (x = 5) : 1')).toBe(1)
  expect(vars.x).toBeUndefined() // the branch not taken has no effect
  expect(() => ev('1 / 0')).toThrow(/division by 0/)
  expect(() => ev('1 +')).toThrow(/syntax error/)
  expect(() => ev('1 $ 2')).toThrow()
})

test('$((…)) in a word, and case patterns', async () => {
  const ctx = fakeContext({ n: '4' })
  expect(await words('echo $((n * 2)) x$((1+1))y', ctx)).toEqual(['echo', '8', 'x2y'])
  const pat = async (w: string) => expandPattern(parse(`x ${w}`)[0]!.andor.first.cmds[0]!.words[1]!, ctx)
  expect(await pat('a*')).toBe('a*')
  expect(await pat('"a*"')).toBe('a\\*')
})
