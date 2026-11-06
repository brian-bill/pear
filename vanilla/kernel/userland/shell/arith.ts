/// Shell arithmetic, for `$((…))`: integers, variables, the C operators, assignment. Bitwise operators work on 32 bits.

export interface ArithEnv {
  get(name: string): string | undefined
  /** Receives the result of `=`, `+=`, `++`, … Without it, assignments are errors. */
  set?(name: string, value: string): void
  /** `name[key]` for arrays (an element's value, `undefined` if unset). */
  getAt?(name: string, key: string): string | undefined
  setAt?(name: string, key: string, value: string): void
}

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string }

const OPS = ['<<=', '>>=', '**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--', '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '|', '^', '?', ':', ',', '(', ')', '[', ']']
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^='])

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < src.length; ) {
    const c = src[i]!
    if (/\s/.test(c)) i++
    else if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]+)/.exec(src.slice(i))!
      const text = m[1]!
      const octal = /^0[0-7]+$/.test(text)
      if (/^0[0-9]+$/.test(text) && !octal) throw new Error(`${text}: value too great for base`)
      out.push({ k: 'num', v: octal ? parseInt(text, 8) : Number(text) })
      i += text.length
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      out.push({ k: 'id', v: m[0] })
      i += m[0].length
    } else {
      const op = OPS.find((o) => src.startsWith(o, i))
      if (!op) throw new Error(`${src.trim()}: syntax error: unexpected '${c}'`)
      out.push({ k: 'op', v: op })
      i += op.length
    }
  }
  return out
}

/** Evaluates an arithmetic expression. Throws with a short message on a syntax error or division by zero. */
export function evalArith(src: string, env: ArithEnv, depth = 0): number {
  if (depth > 20) throw new Error('expression recursion level exceeded')
  // `$x` and `${x}` inside the expression were not expanded by the lexer.
  const text = src.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9])\}?/g, (_, n: string) => env.get(n) || '0')
  const toks = tokenize(text)
  if (!toks.length) return 0
  let at = 0
  let skip = 0 // > 0 inside a branch that is not taken: no assignments, no division errors
  const peek = () => toks[at]
  const isOp = (...ops: string[]) => {
    const t = peek()
    return t?.k === 'op' && ops.includes(t.v)
  }
  const bad = (): never => {
    throw new Error(`${src.trim()}: syntax error in expression`)
  }
  /** A variable or an array element: `x` or `x[expr]`, with the subscript evaluated once however often it is looked at. */
  type L = { name: string; key?: string; end: number }
  const lvals = new Map<number, L | null>()
  const lval = (from: number): L | null => {
    if (lvals.has(from)) return lvals.get(from)!
    const t = toks[from]
    let out: L | null = null
    if (t?.k === 'id') {
      const n = toks[from + 1]
      if (n?.k === 'op' && n.v === '[') {
        let depth = 0
        let j = from + 1
        for (; j < toks.length; j++) {
          const x = toks[j]!
          if (x.k === 'op' && x.v === '[') depth++
          else if (x.k === 'op' && x.v === ']' && --depth === 0) break
        }
        if (j >= toks.length) bad()
        const saved = at
        at = from + 2
        const k = comma()
        if (at !== j) bad()
        at = saved
        out = { name: t.v, key: String(k), end: j + 1 }
      } else out = { name: t.v, end: from + 1 }
    }
    lvals.set(from, out)
    return out
  }
  const value = (l: L): number => {
    const v = l.key !== undefined ? env.getAt?.(l.name, l.key) : env.get(l.name)
    if (v === undefined || v.trim() === '') return 0
    return evalArith(v, env, depth + 1)
  }
  const store = (l: L, v: number): number => {
    if (skip) return v
    if (l.key !== undefined) {
      if (!env.setAt) throw new Error(`${src.trim()}: assignment not allowed here`)
      env.setAt(l.name, l.key, String(v))
      return v
    }
    if (!env.set) throw new Error(`${src.trim()}: assignment not allowed here`)
    env.set(l.name, String(v))
    return v
  }
  const int = (n: number) => n | 0

  const comma = (): number => {
    let v = assign()
    while (isOp(',')) {
      at++
      v = assign()
    }
    return v
  }
  const assign = (): number => {
    const l = lval(at)
    const n = l ? toks[l.end] : undefined
    if (l && n?.k === 'op' && ASSIGN.has(n.v)) {
      at = l.end + 1
      const rhs = assign()
      if (n.v === '=') return store(l, rhs)
      return store(l, binary(n.v.slice(0, -1), value(l), rhs))
    }
    return ternary()
  }
  const ternary = (): number => {
    const c = logicalOr()
    if (!isOp('?')) return c
    at++
    if (c === 0) skip++
    const a = assign()
    if (c === 0) skip--
    if (!isOp(':')) bad()
    at++
    if (c !== 0) skip++
    const b = ternary()
    if (c !== 0) skip--
    return c !== 0 ? a : b
  }
  const logicalOr = (): number => {
    let v = logicalAnd()
    while (isOp('||')) {
      at++
      if (v !== 0) skip++
      const r = logicalAnd()
      if (v !== 0) skip--
      v = v !== 0 || r !== 0 ? 1 : 0
    }
    return v
  }
  const logicalAnd = (): number => {
    let v = level(0)
    while (isOp('&&')) {
      at++
      if (v === 0) skip++
      const r = level(0)
      if (v === 0) skip--
      v = v !== 0 && r !== 0 ? 1 : 0
    }
    return v
  }
  const LEVELS = [['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]
  const binary = (op: string, a: number, b: number): number => {
    switch (op) {
      case '|': return int(a) | int(b)
      case '^': return int(a) ^ int(b)
      case '&': return int(a) & int(b)
      case '==': return a === b ? 1 : 0
      case '!=': return a !== b ? 1 : 0
      case '<': return a < b ? 1 : 0
      case '<=': return a <= b ? 1 : 0
      case '>': return a > b ? 1 : 0
      case '>=': return a >= b ? 1 : 0
      case '<<': return int(a) << int(b)
      case '>>': return int(a) >> int(b)
      case '+': return a + b
      case '-': return a - b
      case '*': return a * b
      case '/':
      case '%':
        if (b === 0) {
          if (skip) return 0
          throw new Error(`${src.trim()}: division by 0`)
        }
        return op === '/' ? Math.trunc(a / b) : a % b
    }
    return bad()
  }
  const level = (n: number): number => {
    if (n === LEVELS.length) return power()
    let v = level(n + 1)
    while (isOp(...LEVELS[n]!)) {
      const op = (peek() as { v: string }).v
      at++
      v = binary(op, v, level(n + 1))
    }
    return v
  }
  const power = (): number => {
    const base = unary()
    if (!isOp('**')) return base
    at++
    return Math.trunc(base ** power())
  }
  const unary = (): number => {
    const t = peek()
    if (t?.k === 'op') {
      if (t.v === '+' || t.v === '-' || t.v === '!' || t.v === '~') {
        at++
        const v = unary()
        return t.v === '+' ? v : t.v === '-' ? -v : t.v === '!' ? (v === 0 ? 1 : 0) : ~int(v)
      }
      if (t.v === '++' || t.v === '--') {
        at++
        const l = lval(at)
        if (!l) return bad()
        at = l.end
        return store(l, value(l) + (t.v === '++' ? 1 : -1))
      }
    }
    return postfix()
  }
  const postfix = (): number => {
    const l = lval(at)
    const n = l ? toks[l.end] : undefined
    if (l && n?.k === 'op' && (n.v === '++' || n.v === '--')) {
      const old = value(l)
      store(l, old + (n.v === '++' ? 1 : -1))
      at = l.end + 1
      return old
    }
    return primary()
  }
  const primary = (): number => {
    const t = toks[at]
    if (!t) return bad()
    if (t.k === 'id') {
      const l = lval(at)!
      at = l.end
      return value(l)
    }
    at++
    if (t.k === 'num') return t.v
    if (t.v === '(') {
      const v = comma()
      if (!isOp(')')) bad()
      at++
      return v
    }
    return bad()
  }

  const result = comma()
  if (at < toks.length) bad()
  return result
}
