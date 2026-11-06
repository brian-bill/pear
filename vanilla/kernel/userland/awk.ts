// awk: patterns and actions over records and fields. A tree-walking interpreter for the POSIX language plus a few common
// extensions (gensub-free): BEGIN/END, user functions, arrays (with `in`, `delete`, `SUBSEP`), getline in its forms,
// print/printf with `>`, `>>` and `|`, regular-expression and range patterns, and the usual built-in functions.
import { main, reason, readAllText, type Pear } from './lib'
import { format, posixRegex, unescape } from './shell/escapes'

// ------------------------------------------------------------------------------------------------ values

class SN {
  constructor(readonly s: string) {}
}
type Arr = Map<string, Val>
type Val = number | string | SN | undefined

const NUM = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/
const NUM_ALL = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/
const looksNum = (s: string) => NUM_ALL.test(s)

const toNum = (v: Val): number => {
  if (typeof v === 'number') return v
  if (v === undefined) return 0
  const s = typeof v === 'string' ? v : v.s
  const m = NUM.exec(s)
  return m ? Number(m[0]) : 0
}
const fmtNum = (n: number, conv: string): string => {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n)
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'nan' : n < 0 ? '-inf' : 'inf'
  return format(conv, [String(n)]).out
}
const isNumeric = (v: Val): boolean => typeof v === 'number' || v === undefined || (v instanceof SN && looksNum(v.s))
const truthy = (v: Val): boolean => (typeof v === 'number' ? v !== 0 : v === undefined ? false : v instanceof SN ? (looksNum(v.s) ? toNum(v) !== 0 : v.s !== '') : v !== '')

class AwkExit {
  constructor(readonly code: number) {}
}
class Next {}
class NextFile {}
class Break {}
class Continue {}
class Return {
  constructor(readonly v: Val) {}
}
class AwkError extends Error {}

// ------------------------------------------------------------------------------------------------ lexer

type Tok = { t: string; v: string; nl?: boolean }
const KEYWORDS = new Set(['BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete', 'in', 'getline', 'print', 'printf'])
const BUILTIN_FN = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush'])

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const regexOk = () => {
    const p = out[out.length - 1]
    if (!p) return true
    if (['num', 'str', 'name', 'func', 'builtin'].includes(p.t)) return false
    if (p.t === 'op' && [')', ']', '$', '++', '--'].includes(p.v)) return false
    if (p.t === 'kw' && p.v === 'getline') return false
    return true
  }
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\r') i++
    else if (c === '\\' && src[i + 1] === '\n') i += 2
    else if (c === '\n') {
      out.push({ t: 'nl', v: '\n' })
      i++
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < src.length) {
          if (src[j + 1] === '\n') {
            j++
            continue
          }
          if (src[j + 1] === '/') {
            s += '/'
            j++
            continue
          }
          const m = /^\\([\\"abfnrtv]|[0-7]{1,3}|x[0-9a-fA-F]{1,2})/.exec(src.slice(j))
          if (m) {
            s += unescape(m[0]).text
            j += m[0].length - 1
          } else {
            s += src[j + 1]
            j++
          }
        } else s += src[j]
      }
      if (j >= src.length) throw new AwkError('unterminated string')
      out.push({ t: 'str', v: s })
      i = j + 1
    } else if (c === '/' && regexOk()) {
      let j = i + 1
      let s = ''
      let inBracket = false
      for (; j < src.length && (src[j] !== '/' || inBracket); j++) {
        if (src[j] === '\n') throw new AwkError('newline in regular expression')
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1] === '/' ? '/' : `\\${src[j + 1]}`
          j++
        } else {
          if (src[j] === '[') inBracket = true
          else if (src[j] === ']') inBracket = false
          s += src[j]
        }
      }
      out.push({ t: 'regex', v: s })
      i = j + 1
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|\d*\.?\d*([eE][-+]?\d+)?)/.exec(src.slice(i))!
      out.push({ t: 'num', v: String(Number(m[0])) })
      i += m[0].length
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      const w = m[0]
      i += w.length
      if (KEYWORDS.has(w)) out.push({ t: 'kw', v: w === 'func' ? 'function' : w })
      else if (BUILTIN_FN.has(w)) out.push({ t: 'builtin', v: w })
      else if (src[i] === '(') out.push({ t: 'func', v: w })
      else out.push({ t: 'name', v: w })
    } else {
      const ops = ['**=', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '++', '--', '>>', '!~', '**']
      const op = ops.find((o) => src.startsWith(o, i)) ?? c
      out.push({ t: 'op', v: op === '**' ? '^' : op === '**=' ? '^=' : op })
      i += op.length
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------------ parser

type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'regex'; v: string }
  | { t: 'name'; v: string }
  | { t: 'index'; name: string; subs: Expr[] }
  | { t: 'field'; e: Expr }
  | { t: 'assign'; op: string; l: Expr; r: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'un'; op: string; e: Expr }
  | { t: 'incr'; op: '++' | '--'; prefix: boolean; e: Expr }
  | { t: 'in'; subs: Expr[]; name: string }
  | { t: 'call'; name: string; args: Expr[] }
  | { t: 'builtin'; name: string; args: Expr[] }
  | { t: 'getline'; kind: 'main' | 'file' | 'cmd'; lv?: Expr; src?: Expr }
  | { t: 'group'; e: Expr }

type Stmt =
  | { t: 'expr'; e: Expr }
  | { t: 'print'; args: Expr[]; dest?: { kind: '>' | '>>' | '|'; e: Expr }; f?: boolean }
  | { t: 'if'; c: Expr; a: Stmt; b?: Stmt }
  | { t: 'while'; c: Expr; body: Stmt }
  | { t: 'do'; body: Stmt; c: Expr }
  | { t: 'for'; init?: Stmt; c?: Expr; step?: Stmt; body: Stmt }
  | { t: 'forin'; v: string; arr: string; body: Stmt }
  | { t: 'block'; body: Stmt[] }
  | { t: 'delete'; name: string; subs?: Expr[] }
  | { t: 'next' | 'nextfile' | 'break' | 'continue' }
  | { t: 'exit' | 'return'; e?: Expr }

interface Rule {
  pattern?: Expr
  pattern2?: Expr
  action?: Stmt
  kind: 'begin' | 'end' | 'main'
  inRange?: boolean
}
interface Func {
  params: string[]
  body: Stmt
}

function parseProgram(src: string): { rules: Rule[]; funcs: Map<string, Func> } {
  const toks = lex(src)
  let at = 0
  const rules: Rule[] = []
  const funcs = new Map<string, Func>()
  const peek = () => toks[at]
  const is = (t: string, v?: string) => toks[at]?.t === t && (v === undefined || toks[at]!.v === v)
  const isOp = (v: string) => is('op', v)
  const eat = (t: string, v?: string): Tok => {
    if (!is(t, v)) throw new AwkError(`syntax error: expected ${v ?? t}, found ${toks[at]?.v ?? 'end of program'}`)
    return toks[at++]!
  }
  const nls = () => {
    while (is('nl')) at++
  }
  const terms = () => {
    while (is('nl') || isOp(';')) at++
  }
  let noIn = 0
  let noGt = 0

  const primary = (): Expr => {
    const t = peek()
    if (!t) throw new AwkError('syntax error: unexpected end of program')
    if (t.t === 'num') {
      at++
      return { t: 'num', v: Number(t.v) }
    }
    if (t.t === 'str') {
      at++
      return { t: 'str', v: t.v }
    }
    if (t.t === 'regex') {
      at++
      return { t: 'regex', v: t.v }
    }
    if (t.t === 'op') {
      if (t.v === '(') {
        at++
        const save = [noIn, noGt]
        noIn = 0
        noGt = 0
        nls()
        const e = expr()
        nls()
        // (a, b) in arr
        if (isOp(',')) {
          const subs = [e]
          while (isOp(',')) {
            at++
            nls()
            subs.push(expr())
          }
          eat('op', ')')
          eat('kw', 'in')
          return { t: 'in', subs, name: eat('name').v }
        }
        eat('op', ')')
        ;[noIn, noGt] = save as [number, number]
        return { t: 'group', e }
      }
      if (t.v === '$') {
        at++
        const e = incdec()
        return { t: 'field', e }
      }
      if (t.v === '-' || t.v === '+' || t.v === '!') {
        at++
        const e = unary()
        return { t: 'un', op: t.v, e }
      }
      if (t.v === '++' || t.v === '--') {
        at++
        return { t: 'incr', op: t.v, prefix: true, e: lvalue() }
      }
    }
    if (t.t === 'name') {
      at++
      if (isOp('[')) {
        at++
        const subs = [expr()]
        while (isOp(',')) {
          at++
          subs.push(expr())
        }
        eat('op', ']')
        return { t: 'index', name: t.v, subs }
      }
      return { t: 'name', v: t.v }
    }
    if (t.t === 'func') {
      at++
      eat('op', '(')
      const args = argList()
      return { t: 'call', name: t.v, args }
    }
    if (t.t === 'builtin') {
      at++
      let args: Expr[] = []
      if (isOp('(')) {
        at++
        args = argList()
      } else if (t.v !== 'length') throw new AwkError(`syntax error: ${t.v} needs arguments`)
      return { t: 'builtin', name: t.v, args }
    }
    if (t.t === 'kw' && t.v === 'getline') {
      at++
      let lv: Expr | undefined
      if (is('name') || isOp('$')) lv = lvalue()
      if (isOp('<')) {
        at++
        return { t: 'getline', kind: 'file', lv, src: concat(true) }
      }
      return { t: 'getline', kind: 'main', lv }
    }
    throw new AwkError(`syntax error near ${t.v === '\n' ? 'end of line' : t.v}`)
  }
  const argList = (): Expr[] => {
    const args: Expr[] = []
    const save = [noIn, noGt]
    noIn = 0
    noGt = 0
    nls()
    if (!isOp(')')) {
      args.push(expr())
      nls()
      while (isOp(',')) {
        at++
        nls()
        args.push(expr())
        nls()
      }
    }
    eat('op', ')')
    ;[noIn, noGt] = save as [number, number]
    return args
  }
  const lvalue = (): Expr => {
    const e = primary()
    if (e.t === 'name' || e.t === 'index' || e.t === 'field') return e
    if (e.t === 'group') return lvalue2(e.e)
    throw new AwkError('syntax error: not an lvalue')
  }
  const lvalue2 = (e: Expr): Expr => {
    if (e.t === 'name' || e.t === 'index' || e.t === 'field') return e
    throw new AwkError('syntax error: not an lvalue')
  }
  const incdec = (): Expr => {
    const e = primary()
    if ((e.t === 'name' || e.t === 'index' || e.t === 'field') && (isOp('++') || isOp('--'))) {
      const op = toks[at++]!.v as '++' | '--'
      return { t: 'incr', op, prefix: false, e }
    }
    return e
  }
  const power = (): Expr => {
    const base = incdec()
    if (isOp('^')) {
      at++
      const exp = unaryForPower()
      return { t: 'bin', op: '^', l: base, r: exp }
    }
    return base
  }
  const unaryForPower = (): Expr => {
    if (isOp('-') || isOp('+') || isOp('!')) {
      const op = toks[at++]!.v
      return { t: 'un', op, e: unaryForPower() }
    }
    return power()
  }
  const unary = (): Expr => {
    if (isOp('!') || isOp('-') || isOp('+')) {
      const op = toks[at++]!.v
      return { t: 'un', op, e: unary() }
    }
    return power()
  }
  const mul = (): Expr => {
    let l = unary()
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = toks[at++]!.v
      l = { t: 'bin', op, l, r: unary() }
    }
    return l
  }
  const add = (): Expr => {
    let l = mul()
    while (isOp('+') || isOp('-')) {
      const op = toks[at++]!.v
      l = { t: 'bin', op, l, r: mul() }
    }
    return l
  }
  const startsOperand = (): boolean => {
    const t = peek()
    if (!t) return false
    if (['num', 'str', 'name', 'func', 'builtin', 'regex'].includes(t.t)) return true
    if (t.t === 'op') return ['$', '(', '!', '-', '+', '++', '--'].includes(t.v) && !['-', '+'].includes(t.v)
    if (t.t === 'kw') return t.v === 'getline' ? false : false
    return false
  }
  function concat(noGetlineCmd = false): Expr {
    let l = add()
    while (startsOperand() && !(is('kw', 'in')) && !(noGetlineCmd && false)) {
      if (isOp('!') ) break
      l = { t: 'bin', op: ' ', l, r: add() }
    }
    return l
  }
  const compare = (): Expr => {
    let l = concat()
    for (;;) {
      const t = peek()
      if (t?.t === 'op' && ['<', '<=', '==', '!=', '>=', '>'].includes(t.v) && !(t.v === '>' && noGt)) {
        at++
        l = { t: 'bin', op: t.v, l, r: concat() }
      } else if (t?.t === 'op' && t.v === '|' && toks[at + 1]?.t === 'kw' && toks[at + 1]!.v === 'getline') {
        at += 2
        let lv: Expr | undefined
        if (is('name') || isOp('$')) lv = lvalue()
        l = { t: 'getline', kind: 'cmd', lv, src: l }
      } else return l
    }
  }
  const match = (): Expr => {
    let l = compare()
    while (isOp('~') || isOp('!~')) {
      const op = toks[at++]!.v
      l = { t: 'bin', op, l, r: compare() }
    }
    return l
  }
  const inExpr = (): Expr => {
    let l = match()
    while (is('kw', 'in') && !noIn) {
      at++
      const name = eat('name').v
      l = { t: 'in', subs: [l], name }
    }
    return l
  }
  const and = (): Expr => {
    let l = inExpr()
    while (isOp('&&')) {
      at++
      nls()
      l = { t: 'bin', op: '&&', l, r: inExpr() }
    }
    return l
  }
  const or = (): Expr => {
    let l = and()
    while (isOp('||')) {
      at++
      nls()
      l = { t: 'bin', op: '||', l, r: and() }
    }
    return l
  }
  const ternary = (): Expr => {
    const c = or()
    if (!isOp('?')) return c
    at++
    nls()
    const a = ternary()
    nls()
    eat('op', ':')
    nls()
    return { t: 'cond', c, a, b: ternary() }
  }
  function expr(): Expr {
    const l = ternary()
    const t = peek()
    if (t?.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(t.v) && (l.t === 'name' || l.t === 'index' || l.t === 'field')) {
      at++
      nls()
      return { t: 'assign', op: t.v, l, r: expr() }
    }
    return l
  }

  const simpleStmt = (): Stmt => {
    const t = peek()!
    if (t.t === 'kw') {
      switch (t.v) {
        case 'print':
        case 'printf': {
          at++
          const args: Expr[] = []
          noGt++
          // print (a, b) [> file]: a parenthesised list is the argument list
          if (isOp('(')) {
            let depth = 0
            let j = at
            let comma = false
            for (; j < toks.length; j++) {
              const x = toks[j]!
              if (x.t === 'op' && x.v === '(') depth++
              else if (x.t === 'op' && x.v === ')' && --depth === 0) break
              else if (x.t === 'op' && x.v === ',' && depth === 1) comma = true
            }
            const after = toks[j + 1]
            if (comma && (!after || after.t === 'nl' || (after.t === 'op' && [';', '}', '>', '>>', '|'].includes(after.v)))) {
              at++
              noGt = 0
              args.push(expr())
              while (isOp(',')) {
                at++
                nls()
                args.push(expr())
              }
              eat('op', ')')
              noGt = 1
            }
          }
          if (!args.length && !is('nl') && !isOp(';') && !isOp('}') && !isOp('>') && !isOp('>>') && !isOp('|')) {
            args.push(expr())
            while (isOp(',')) {
              at++
              nls()
              args.push(expr())
            }
          }
          noGt--
          let dest: { kind: '>' | '>>' | '|'; e: Expr } | undefined
          if (isOp('>') || isOp('>>') || isOp('|')) {
            const kind = toks[at++]!.v as '>' | '>>' | '|'
            dest = { kind, e: concat() }
          }
          // print (a, b) > "x": the parenthesised list is the argument list
          if (args.length === 1 && args[0]!.t === 'group') {
            /* a single parenthesised expression is just an expression */
          }
          return { t: 'print', args, dest, f: t.v === 'printf' }
        }
        case 'delete': {
          at++
          const name = eat('name').v
          if (isOp('[')) {
            at++
            const subs = [expr()]
            while (isOp(',')) {
              at++
              subs.push(expr())
            }
            eat('op', ']')
            return { t: 'delete', name, subs }
          }
          return { t: 'delete', name }
        }
        case 'next': at++; return { t: 'next' }
        case 'nextfile': at++; return { t: 'nextfile' }
        case 'break': at++; return { t: 'break' }
        case 'continue': at++; return { t: 'continue' }
        case 'exit':
        case 'return': {
          at++
          if (is('nl') || isOp(';') || isOp('}') || !peek()) return { t: t.v as 'exit' | 'return' }
          return { t: t.v as 'exit' | 'return', e: expr() }
        }
      }
    }
    return { t: 'expr', e: expr() }
  }

  const stmt = (): Stmt => {
    nls()
    const t = peek()
    if (!t) throw new AwkError('syntax error: unexpected end of program')
    if (t.t === 'op' && t.v === '{') {
      at++
      const body: Stmt[] = []
      terms()
      while (!isOp('}')) {
        if (!peek()) throw new AwkError('syntax error: missing }')
        body.push(stmt())
        terms()
      }
      at++
      return { t: 'block', body }
    }
    if (t.t === 'op' && t.v === ';') {
      at++
      return { t: 'block', body: [] }
    }
    if (t.t === 'kw') {
      if (t.v === 'if') {
        at++
        eat('op', '(')
        const c = expr()
        eat('op', ')')
        const a = stmt()
        const save = at
        terms()
        if (is('kw', 'else')) {
          at++
          return { t: 'if', c, a, b: stmt() }
        }
        at = save
        return { t: 'if', c, a }
      }
      if (t.v === 'while') {
        at++
        eat('op', '(')
        const c = expr()
        eat('op', ')')
        if (isOp(';')) {
          at++
          return { t: 'while', c, body: { t: 'block', body: [] } }
        }
        return { t: 'while', c, body: stmt() }
      }
      if (t.v === 'do') {
        at++
        const body = stmt()
        terms()
        eat('kw', 'while')
        eat('op', '(')
        const c = expr()
        eat('op', ')')
        return { t: 'do', body, c }
      }
      if (t.v === 'for') {
        at++
        eat('op', '(')
        if (is('name') && toks[at + 1]?.t === 'kw' && toks[at + 1]!.v === 'in' && toks[at + 2]?.t === 'name' && toks[at + 3]?.v === ')') {
          const v = toks[at]!.v
          const arr = toks[at + 2]!.v
          at += 4
          return { t: 'forin', v, arr, body: stmt() }
        }
        let init: Stmt | undefined
        let c: Expr | undefined
        let step: Stmt | undefined
        if (!isOp(';')) init = simpleStmt()
        eat('op', ';')
        nls()
        if (!isOp(';')) c = expr()
        eat('op', ';')
        nls()
        if (!isOp(')')) step = simpleStmt()
        eat('op', ')')
        if (isOp(';')) {
          at++
          return { t: 'for', init, c, step, body: { t: 'block', body: [] } }
        }
        return { t: 'for', init, c, step, body: stmt() }
      }
    }
    return simpleStmt()
  }

  terms()
  while (peek()) {
    if (is('kw', 'function')) {
      at++
      const name = (is('func') ? toks[at++]! : eat('name')).v
      eat('op', '(')
      const params: string[] = []
      nls()
      while (!isOp(')')) {
        params.push(eat('name').v)
        nls()
        if (isOp(',')) {
          at++
          nls()
        }
      }
      at++
      nls()
      funcs.set(name, { params, body: stmt() })
    } else if (is('kw', 'BEGIN') || is('kw', 'END')) {
      const kind = toks[at++]!.v === 'BEGIN' ? 'begin' : 'end'
      nls()
      rules.push({ kind, action: stmt() })
    } else {
      const rule: Rule = { kind: 'main' }
      if (!isOp('{')) {
        rule.pattern = expr()
        if (isOp(',')) {
          at++
          nls()
          rule.pattern2 = expr()
        }
      }
      if (isOp('{')) rule.action = stmt()
      rules.push(rule)
    }
    terms()
  }
  return { rules, funcs }
}

// ------------------------------------------------------------------------------------------------ interpreter

export default function (tiny: Pear): Promise<number> {
  return main('awk', tiny, async () => {
    const argv = [...tiny.args]
    let fs: string | null = null
    let progSrc: string | null = null
    const assigns: Array<[string, string]> = []
    while (argv.length && argv[0]!.startsWith('-') && argv[0] !== '-') {
      const a = argv.shift()!
      if (a === '--') break
      if (a.startsWith('-F')) fs = a.length > 2 ? a.slice(2) : (argv.shift() ?? '')
      else if (a.startsWith('-v')) {
        const kv = a.length > 2 ? a.slice(2) : (argv.shift() ?? '')
        const eq = kv.indexOf('=')
        assigns.push([kv.slice(0, eq), unescape(kv.slice(eq + 1)).text])
      } else if (a === '-f') progSrc = (progSrc ?? '') + (await readAllText(tiny, argv.shift() ?? '')) + '\n'
      else {
        await tiny.stderr.write(`awk: unknown option ${a}\n`)
        return 2
      }
    }
    if (progSrc === null) {
      progSrc = argv.shift() ?? null
      if (progSrc === null) {
        await tiny.stderr.write("usage: awk [-F fs] [-v var=value] 'program' [file ...]\n")
        return 2
      }
    }
    let program: ReturnType<typeof parseProgram>
    try {
      program = parseProgram(progSrc)
    } catch (e) {
      if (!(e instanceof AwkError)) throw e
      await tiny.stderr.write(`awk: ${e.message}\n`)
      return 2
    }

    const vars = new Map<string, Val>()
    const arrays = new Map<string, Arr>()
    const env = await tiny.environ()
    const envArr: Arr = new Map(Object.entries(env).map(([k, v]) => [k, new SN(v)]))
    arrays.set('ENVIRON', envArr)
    const argvArr: Arr = new Map([['0', 'awk']])
    arrays.set('ARGV', argvArr)
    const setVar = (n: string, v: Val) => void vars.set(n, v)
    const getVar = (n: string): Val => vars.get(n)
    setVar('FS', fs !== null ? (fs === 't' ? '\t' : unescape(fs).text) : ' ')
    setVar('OFS', ' ')
    setVar('ORS', '\n')
    setVar('RS', '\n')
    setVar('NR', 0)
    setVar('FNR', 0)
    setVar('SUBSEP', '\x1c')
    setVar('OFMT', '%.6g')
    setVar('CONVFMT', '%.6g')
    setVar('RSTART', 0)
    setVar('RLENGTH', -1)
    setVar('FILENAME', '')
    for (const [k, v] of assigns) setVar(k, looksNum(v) ? new SN(v) : v)

    const str = (v: Val): string => (typeof v === 'string' ? v : v instanceof SN ? v.s : v === undefined ? '' : fmtNum(v, toStr(getVar('CONVFMT'))))
    const toStr = (v: Val): string => (typeof v === 'string' ? v : v instanceof SN ? v.s : v === undefined ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : fmtNum(v, '%.6g')) : '')
    const outStr = (v: Val): string => (typeof v === 'number' && !Number.isInteger(v) ? fmtNum(v, toStr(getVar('OFMT'))) : str(v))

    // ---- records and fields
    let record = ''
    let fields: string[] | null = []
    let nf = 0
    const regexCache = new Map<string, RegExp>()
    const regex = (src: string): RegExp => {
      let re = regexCache.get(src)
      if (!re) {
        try {
          re = new RegExp(posixRegex(src, true))
        } catch {
          throw new AwkError(`invalid regular expression: ${src}`)
        }
        regexCache.set(src, re)
      }
      return re
    }
    const splitRecord = (text: string, sep: string): string[] => {
      if (text === '') return []
      if (sep === ' ') return text.split(/[ \t\n]+/).filter((x, k, a) => x !== '' || (k > 0 && k < a.length - 1 && false))
      if (sep === '\t' || (sep.length === 1 && sep !== ' ')) return text.split(sep.length === 1 && /[\\^$.|?*+()[\]{}]/.test(sep) ? sep : sep)
      return text.split(regex(sep))
    }
    const ensureFields = () => {
      if (fields) return
      fields = splitRecord(record, toStr(getVar('FS')))
      nf = fields.length
    }
    const setRecord = (text: string) => {
      record = text
      fields = null
    }
    const rebuild = () => {
      record = fields!.join(toStr(getVar('OFS')))
    }
    const getField = (i: number): Val => {
      if (i === 0) return new SN(record)
      ensureFields()
      if (i > nf) return undefined
      return new SN(fields![i - 1] ?? '')
    }
    const setField = (i: number, v: string) => {
      if (i === 0) return setRecord(v)
      ensureFields()
      while (fields!.length < i) fields!.push('')
      fields![i - 1] = v
      nf = fields!.length
      rebuild()
    }

    // ---- input
    interface Source {
      text: string
      at: number
      name: string
    }
    const sources = new Map<string, Source>()
    const nextRecord = (src: Source): string | null => {
      if (src.at >= src.text.length) return null
      const rs = toStr(getVar('RS'))
      if (rs === '\n' || rs.length === 1) {
        const i = src.text.indexOf(rs, src.at)
        const end = i < 0 ? src.text.length : i
        const r = src.text.slice(src.at, end)
        src.at = i < 0 ? src.text.length : i + 1
        return r
      }
      if (rs === '') {
        let m = /^\n+/.exec(src.text.slice(src.at))
        if (m) src.at += m[0].length
        if (src.at >= src.text.length) return null
        m = /\n\n+/.exec(src.text.slice(src.at))
        const end = m ? src.at + m.index : src.text.length
        const r = src.text.slice(src.at, end)
        src.at = m ? end + m[0].length : src.text.length
        return r.replace(/\n$/, '')
      }
      const re = new RegExp(posixRegex(rs, true), 'g')
      re.lastIndex = src.at
      const m = re.exec(src.text)
      const end = m ? m.index : src.text.length
      const r = src.text.slice(src.at, end)
      src.at = m ? end + m[0].length : src.text.length
      return r
    }
    const operands = argv
    let operandAt = 0
    let main: Source | null = null
    let usedFile = false
    const openMain = async (): Promise<boolean> => {
      for (;;) {
        if (operandAt >= operands.length) {
          if (usedFile) return false
          usedFile = true
          main = { text: await readAllText(tiny, '-'), at: 0, name: '' }
          return true
        }
        const a = operands[operandAt++]!
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a)
        if (m) {
          const v = unescape(m[2]!).text
          setVar(m[1]!, looksNum(v) ? new SN(v) : v)
          continue
        }
        usedFile = true
        try {
          main = { text: a === '-' ? await readAllText(tiny, '-') : await readAllText(tiny, a), at: 0, name: a }
        } catch (e) {
          await tiny.stderr.write(`awk: can't open file ${a}: ${reason(e)}\n`)
          exitCode = 2
          continue
        }
        setVar('FILENAME', a)
        setVar('FNR', 0)
        return true
      }
    }
    let exitCode = 0
    const readMain = async (): Promise<string | null> => {
      for (;;) {
        if (!main && !(await openMain())) return null
        const r = nextRecord(main!)
        if (r !== null) {
          setVar('NR', toNum(getVar('NR')) + 1)
          setVar('FNR', toNum(getVar('FNR')) + 1)
          return r
        }
        main = null
      }
    }

    // ---- output
    let stdoutBuf = ''
    const flushStdout = async () => {
      if (stdoutBuf) {
        const s = stdoutBuf
        stdoutBuf = ''
        await tiny.stdout.write(s)
      }
    }
    const files = new Map<string, string>()
    const appendTo = new Set<string>()
    const pipes = new Map<string, string>()
    const write = async (dest: { kind: '>' | '>>' | '|'; e: Expr } | undefined, text: string) => {
      if (!dest) {
        stdoutBuf += text
        if (stdoutBuf.length > 65536) await flushStdout()
        return
      }
      const name = str(await evalExpr(dest.e))
      if (dest.kind === '|') pipes.set(name, (pipes.get(name) ?? '') + text)
      else if (name === '/dev/stdout' || name === '-') stdoutBuf += text
      else if (name === '/dev/stderr') await tiny.stderr.write(text)
      else {
        if (!files.has(name) && dest.kind === '>>') appendTo.add(name)
        files.set(name, (files.get(name) ?? '') + text)
      }
    }
    const closeOutput = async (name: string): Promise<number> => {
      let status = 0
      if (files.has(name)) {
        const text = files.get(name)!
        files.delete(name)
        try {
          if (appendTo.has(name)) {
            const old = await readAllText(tiny, name).catch(() => '')
            await tiny.writeFile(name, new TextEncoder().encode(old + text))
          } else await tiny.writeFile(name, new TextEncoder().encode(text))
        } catch {
          status = -1
        }
        appendTo.delete(name)
      }
      if (pipes.has(name)) {
        const text = pipes.get(name)!
        pipes.delete(name)
        await flushStdout()
        status = await runWithInput(name, text)
      }
      sources.delete(name)
      return status
    }
    const runWithInput = async (cmd: string, input: string): Promise<number> => {
      const tmp = `/tmp/.awk-${tiny.pid}-${Math.random().toString(36).slice(2)}`
      await tiny.writeFile(tmp, new TextEncoder().encode(input))
      try {
        const pid = await tiny.spawn('/bin/sh', { args: ['-c', `${cmd} < '${tmp}'`], stdio: { stdin: 'null', stdout: 'inherit', stderr: 'inherit' } })
        return (await tiny.wait(pid)).code ?? 1
      } finally {
        await tiny.unlink(tmp).catch(() => {})
      }
    }
    const capture = async (cmd: string): Promise<string> => {
      await flushStdout()
      const [r, w] = await tiny.pipe()
      const pid = await tiny.spawn('/bin/sh', { args: ['-c', cmd], stdio: { stdin: 'null', stdout: { fd: w }, stderr: 'inherit' } })
      await tiny.close(w)
      let text = ''
      const dec = new TextDecoder()
      for (let c; (c = await tiny.read(r, 65536)).length; ) text += dec.decode(c, { stream: true })
      await tiny.close(r)
      await tiny.wait(pid)
      return text
    }

    // ---- evaluation
    const frames: Array<Map<string, Val | Arr>> = []
    const getArray = (name: string): Arr => {
      const f = frames[frames.length - 1]
      if (f?.has(name)) {
        const v = f.get(name)
        if (v instanceof Map) return v
        const a: Arr = new Map()
        f.set(name, a)
        return a
      }
      let a = arrays.get(name)
      if (!a) arrays.set(name, (a = new Map()))
      return a
    }
    const readName = async (name: string): Promise<Val> => {
      const f = frames[frames.length - 1]
      if (f?.has(name)) {
        const v = f.get(name)
        return v instanceof Map ? undefined : v
      }
      switch (name) {
        case 'NF': ensureFields(); return nf
      }
      return getVar(name)
    }
    const writeName = async (name: string, v: Val) => {
      const f = frames[frames.length - 1]
      if (f?.has(name)) return void f.set(name, v)
      if (name === 'NF') {
        ensureFields()
        const n = Math.max(0, Math.trunc(toNum(v)))
        while (fields!.length < n) fields!.push('')
        fields!.length = n
        nf = n
        rebuild()
        return
      }
      setVar(name, v)
      if (name === 'FS' && fields === null) fields = null
    }
    const subKey = async (subs: Expr[]): Promise<string> => {
      const parts: string[] = []
      for (const s of subs) parts.push(str(await evalExpr(s)))
      return parts.join(toStr(getVar('SUBSEP')))
    }
    const assignTo = async (l: Expr, v: Val): Promise<void> => {
      if (l.t === 'name') return writeName(l.v, v)
      if (l.t === 'index') return void getArray(l.name).set(await subKey(l.subs), v)
      if (l.t === 'field') return setField(Math.trunc(toNum(await evalExpr(l.e))), str(v))
      throw new AwkError('cannot assign')
    }
    const compare = (a: Val, b: Val): number => {
      if (isNumeric(a) && isNumeric(b)) {
        const x = toNum(a)
        const y = toNum(b)
        return x < y ? -1 : x > y ? 1 : 0
      }
      const x = str(a)
      const y = str(b)
      return x < y ? -1 : x > y ? 1 : 0
    }
    const fmt = (args: Val[]): string => {
      const f = str(args[0])
      const rest = args.slice(1)
      const re = /%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%])/g
      let k = 0
      const prepared = [...rest.map((v) => (typeof v === 'number' ? String(v) : str(v)))]
      for (let m; (m = re.exec(f)); ) {
        if (m[4] === '%') continue
        if (m[2] === '*') k++
        if (m[3] === '*') k++
        if (m[4] === 'c' && typeof rest[k] === 'number') prepared[k] = String.fromCodePoint(Math.trunc(rest[k] as number))
        k++
      }
      return format(f.replace(/\\/g, '\\\\'), prepared).out
    }
    const substitute = async (e: Expr & { t: 'builtin' }, global: boolean): Promise<Val> => {
      const reArg = e.args[0]!
      const re = new RegExp(reArg.t === 'regex' ? posixRegex(reArg.v, true) : posixRegex(str(await evalExpr(reArg)), true), 'g')
      const repl = str(await evalExpr(e.args[1]!))
      const target: Expr = e.args[2] ?? { t: 'field', e: { t: 'num', v: 0 } }
      const text = str(await evalExpr(target))
      let count = 0
      let out = ''
      let last = 0
      for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
        if (m[0] === '' && m.index === re.lastIndex) re.lastIndex++
        out += text.slice(last, m.index) + repl.replace(/\\(.)|&/g, (_x, c: string | undefined) => (c === undefined ? m![0] : c === '&' ? '&' : c === '\\' ? '\\' : `\\${c}`))
        last = m.index + m[0].length
        count++
        if (!global) break
        if (m[0] === '' && m.index >= text.length) break
      }
      if (count) await assignTo(target, out + text.slice(last))
      return count
    }
    const callBuiltin = async (e: Expr & { t: 'builtin' }): Promise<Val> => {
      const a = e.args
      const val = async (k: number) => evalExpr(a[k]!)
      switch (e.name) {
        case 'length': {
          if (!a.length) return record.length
          if (a[0]!.t === 'name') {
            const f = frames[frames.length - 1]
            const cell = f?.get(a[0]!.v)
            const arr = cell instanceof Map ? cell : f?.has(a[0]!.v) ? undefined : arrays.get(a[0]!.v)
            if (arr) return arr.size
          }
          return [...str(await val(0))].length
        }
        case 'substr': {
          const s = str(await val(0))
          let m = Math.round(toNum(await val(1)))
          let n = a[2] ? Math.round(toNum(await val(2))) : Infinity
          if (Number.isNaN(m)) m = 1
          const end = n === Infinity ? s.length + 1 : m + n
          const from = Math.max(1, m)
          n = end - from
          return n <= 0 ? '' : s.slice(from - 1, from - 1 + n)
        }
        case 'index': return str(await val(0)).indexOf(str(await val(1))) + 1
        case 'split': {
          const s = str(await val(0))
          const arrName = (a[1] as Expr & { t: 'name' }).v
          const sep = a[2] ? (a[2].t === 'regex' ? a[2].v : str(await val(2))) : toStr(getVar('FS'))
          const parts = a[2]?.t === 'regex' ? (s === '' ? [] : s.split(regex(sep))) : splitRecord(s, sep)
          const arr = getArray(arrName)
          arr.clear()
          parts.forEach((p, k) => arr.set(String(k + 1), looksNum(p) ? new SN(p) : p))
          return parts.length
        }
        case 'sub': return substitute(e, false)
        case 'gsub': return substitute(e, true)
        case 'match': {
          const s = str(await val(0))
          const m = (a[1]!.t === 'regex' ? regex(a[1]!.v) : regex(str(await val(1)))).exec(s)
          setVar('RSTART', m ? m.index + 1 : 0)
          setVar('RLENGTH', m ? m[0].length : -1)
          return m ? m.index + 1 : 0
        }
        case 'sprintf': return fmt(await Promise.all(a.map((x) => evalExpr(x))))
        case 'sin': return Math.sin(toNum(await val(0)))
        case 'cos': return Math.cos(toNum(await val(0)))
        case 'atan2': return Math.atan2(toNum(await val(0)), toNum(await val(1)))
        case 'exp': return Math.exp(toNum(await val(0)))
        case 'log': return Math.log(toNum(await val(0)))
        case 'sqrt': return Math.sqrt(toNum(await val(0)))
        case 'int': return Math.trunc(toNum(await val(0)))
        case 'rand': return Math.random()
        case 'srand': return 0
        case 'tolower': return str(await val(0)).toLowerCase()
        case 'toupper': return str(await val(0)).toUpperCase()
        case 'system': {
          await flushStdout()
          const pid = await tiny.spawn('/bin/sh', { args: ['-c', str(await val(0))], stdio: { stdin: 'null', stdout: 'inherit', stderr: 'inherit' } })
          return (await tiny.wait(pid)).code ?? 1
        }
        case 'close': return closeOutput(str(await val(0)))
        case 'fflush': await flushStdout(); return 0
      }
      throw new AwkError(`unknown function ${e.name}`)
    }
    const callFunction = async (name: string, args: Expr[]): Promise<Val> => {
      const fn = program.funcs.get(name)
      if (!fn) throw new AwkError(`calling undefined function ${name}`)
      if (frames.length > 200) throw new AwkError('function call nesting too deep')
      const frame = new Map<string, Val | Arr>()
      for (let k = 0; k < fn.params.length; k++) {
        const arg = args[k]
        if (!arg) frame.set(fn.params[k]!, undefined)
        else if (arg.t === 'name' && (getFrameArray(arg.v) || arrays.has(arg.v))) frame.set(fn.params[k]!, getArray(arg.v))
        else frame.set(fn.params[k]!, await evalExpr(arg))
      }
      frames.push(frame)
      try {
        await exec(fn.body)
        return undefined
      } catch (e) {
        if (e instanceof Return) return e.v
        throw e
      } finally {
        frames.pop()
      }
    }
    const getFrameArray = (name: string): boolean => {
      const f = frames[frames.length - 1]
      return f?.get(name) instanceof Map
    }
    const evalExpr = async (e: Expr): Promise<Val> => {
      switch (e.t) {
        case 'num': return e.v
        case 'str': return e.v
        case 'regex': return regex(e.v).test(record) ? 1 : 0
        case 'group': return evalExpr(e.e)
        case 'name': return readName(e.v)
        case 'index': {
          const arr = getArray(e.name)
          const k = await subKey(e.subs)
          if (!arr.has(k)) arr.set(k, undefined)
          return arr.get(k)
        }
        case 'field': return getField(Math.trunc(toNum(await evalExpr(e.e))))
        case 'assign': {
          let v: Val
          if (e.op === '=') {
            v = await evalExpr(e.r)
            if (v instanceof SN) v = v // keeps its string-number nature
          } else {
            const cur = toNum(await evalExpr(e.l))
            const r = toNum(await evalExpr(e.r))
            const op = e.op[0]!
            v = op === '+' ? cur + r : op === '-' ? cur - r : op === '*' ? cur * r : op === '/' ? (r === 0 ? divZero() : cur / r) : op === '%' ? (r === 0 ? divZero() : cur % r) : cur ** r
          }
          await assignTo(e.l, v)
          return v
        }
        case 'cond': return truthy(await evalExpr(e.c)) ? evalExpr(e.a) : evalExpr(e.b)
        case 'un': {
          const v = await evalExpr(e.e)
          return e.op === '!' ? (truthy(v) ? 0 : 1) : e.op === '-' ? -toNum(v) : toNum(v)
        }
        case 'incr': {
          const old = toNum(await evalExpr(e.e))
          const nv = old + (e.op === '++' ? 1 : -1)
          await assignTo(e.e, nv)
          return e.prefix ? nv : old
        }
        case 'in': return getArray(e.name).has(await subKey(e.subs)) ? 1 : 0
        case 'call': return callFunction(e.name, e.args)
        case 'builtin': return callBuiltin(e)
        case 'getline': {
          let line: string | null
          if (e.kind === 'main') {
            line = await readMain()
          } else {
            const name = str(await evalExpr(e.src!))
            let src = sources.get((e.kind === 'cmd' ? '|' : '<') + name)
            if (!src) {
              let text: string
              try {
                text = e.kind === 'cmd' ? await capture(name) : await readAllText(tiny, name)
              } catch {
                return -1
              }
              src = { text, at: 0, name }
              sources.set((e.kind === 'cmd' ? '|' : '<') + name, src)
            }
            line = nextRecord(src)
            if (line !== null && e.kind === 'cmd') setVar('NR', toNum(getVar('NR')) + 1)
          }
          if (line === null) return 0
          if (e.lv) await assignTo(e.lv, looksNum(line) ? new SN(line) : line)
          else {
            setRecord(line)
          }
          return 1
        }
        case 'bin': {
          switch (e.op) {
            case '&&': return truthy(await evalExpr(e.l)) && truthy(await evalExpr(e.r)) ? 1 : 0
            case '||': return truthy(await evalExpr(e.l)) || truthy(await evalExpr(e.r)) ? 1 : 0
            case '~':
            case '!~': {
              const s = str(await evalExpr(e.l))
              const re = e.r.t === 'regex' ? regex(e.r.v) : regex(str(await evalExpr(e.r)))
              return re.test(s) === (e.op === '~') ? 1 : 0
            }
          }
          const l = await evalExpr(e.l)
          const r = await evalExpr(e.r)
          switch (e.op) {
            case ' ': return str(l) + str(r)
            case '+': return toNum(l) + toNum(r)
            case '-': return toNum(l) - toNum(r)
            case '*': return toNum(l) * toNum(r)
            case '/': return toNum(r) === 0 ? divZero() : toNum(l) / toNum(r)
            case '%': return toNum(r) === 0 ? divZero() : toNum(l) % toNum(r)
            case '^': return toNum(l) ** toNum(r)
            case '<': return compare(l, r) < 0 ? 1 : 0
            case '<=': return compare(l, r) <= 0 ? 1 : 0
            case '>': return compare(l, r) > 0 ? 1 : 0
            case '>=': return compare(l, r) >= 0 ? 1 : 0
            case '==': return compare(l, r) === 0 ? 1 : 0
            case '!=': return compare(l, r) !== 0 ? 1 : 0
          }
        }
      }
      throw new AwkError('bad expression')
    }
    const divZero = (): never => {
      throw new AwkError('division by zero')
    }

    const exec = async (s: Stmt): Promise<void> => {
      switch (s.t) {
        case 'expr': await evalExpr(s.e); return
        case 'block': for (const x of s.body) await exec(x); return
        case 'print': {
          let text: string
          if (s.f) text = fmt(await Promise.all(s.args.map((x) => evalExpr(x))))
          else {
            const args = s.args.length ? s.args : [{ t: 'field', e: { t: 'num', v: 0 } } as Expr]
            // print (a, b): a group holding a list was parsed as the grouping of one expression
            const parts: string[] = []
            for (const a of args) parts.push(outStr(await evalExpr(a)))
            text = parts.join(toStr(getVar('OFS'))) + toStr(getVar('ORS'))
          }
          await write(s.dest, text)
          return
        }
        case 'if':
          if (truthy(await evalExpr(s.c))) await exec(s.a)
          else if (s.b) await exec(s.b)
          return
        case 'while':
          while (truthy(await evalExpr(s.c))) {
            try {
              await exec(s.body)
            } catch (e) {
              if (e instanceof Break) break
              if (!(e instanceof Continue)) throw e
            }
          }
          return
        case 'do':
          do {
            try {
              await exec(s.body)
            } catch (e) {
              if (e instanceof Break) break
              if (!(e instanceof Continue)) throw e
            }
          } while (truthy(await evalExpr(s.c)))
          return
        case 'for':
          if (s.init) await exec(s.init)
          while (!s.c || truthy(await evalExpr(s.c))) {
            try {
              await exec(s.body)
            } catch (e) {
              if (e instanceof Break) break
              if (!(e instanceof Continue)) throw e
            }
            if (s.step) await exec(s.step)
          }
          return
        case 'forin': {
          for (const k of [...getArray(s.arr).keys()]) {
            if (!getArray(s.arr).has(k)) continue
            await writeName(s.v, looksNum(k) ? new SN(k) : k)
            try {
              await exec(s.body)
            } catch (e) {
              if (e instanceof Break) break
              if (!(e instanceof Continue)) throw e
            }
          }
          return
        }
        case 'delete':
          if (s.subs) getArray(s.name).delete(await subKey(s.subs))
          else getArray(s.name).clear()
          return
        case 'next': throw new Next()
        case 'nextfile': throw new NextFile()
        case 'break': throw new Break()
        case 'continue': throw new Continue()
        case 'exit': throw new AwkExit(s.e ? Math.trunc(toNum(await evalExpr(s.e))) : exitCode)
        case 'return': throw new Return(s.e ? await evalExpr(s.e) : undefined)
      }
    }

    argvArr.clear()
    argvArr.set('0', 'awk')
    operands.forEach((o, k) => argvArr.set(String(k + 1), o))
    setVar('ARGC', operands.length + 1)

    const begin = program.rules.filter((r) => r.kind === 'begin')
    const end = program.rules.filter((r) => r.kind === 'end')
    const body = program.rules.filter((r) => r.kind === 'main')
    let exiting = false
    const finish = async (): Promise<number> => {
      await flushStdout()
      for (const n of [...files.keys(), ...pipes.keys()]) await closeOutput(n)
      return exitCode
    }
    try {
      try {
        for (const r of begin) await exec(r.action!)
      } catch (e) {
        if (e instanceof AwkExit) {
          exitCode = e.code
          exiting = true
        } else throw e
      }
      if (!exiting && (body.length || end.length)) {
        for (let rec: string | null; (rec = await readMain()) !== null; ) {
          setRecord(rec)
          try {
            for (const r of body) {
              let hit: boolean
              if (!r.pattern) hit = true
              else if (!r.pattern2) hit = truthy(await evalExpr(r.pattern))
              else if (r.inRange) {
                hit = true
                if (truthy(await evalExpr(r.pattern2))) r.inRange = false
              } else if (truthy(await evalExpr(r.pattern))) {
                hit = true
                r.inRange = !truthy(await evalExpr(r.pattern2))
              } else hit = false
              if (!hit) continue
              if (r.action) await exec(r.action)
              else await write(undefined, record + toStr(getVar('ORS')))
            }
          } catch (e) {
            if (e instanceof Next) continue
            if (e instanceof NextFile) {
              main = null
              continue
            }
            throw e
          }
        }
      }
    } catch (e) {
      if (e instanceof AwkExit) {
        exitCode = e.code
        exiting = true
      } else if (e instanceof AwkError) {
        await flushStdout()
        await tiny.stderr.write(`awk: ${e.message}\n`)
        return 2
      } else throw e
    }
    // END rules run after the input, or after `exit` in a main rule (not after `exit` in END or BEGIN-only programs)
    try {
      if (!(exiting && begin.length && !body.length)) for (const r of end) await exec(r.action!)
    } catch (e) {
      if (e instanceof AwkExit) exitCode = e.code
      else if (e instanceof AwkError) {
        await flushStdout()
        await tiny.stderr.write(`awk: ${e.message}\n`)
        return 2
      } else throw e
    }
    return finish()
  })
}
