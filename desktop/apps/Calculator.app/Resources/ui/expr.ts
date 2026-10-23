/** A small expression parser (no eval: the window's CSP forbids it). Recursive descent with the usual precedence. */

export class ExprError extends Error {}

export type AngleMode = 'deg' | 'rad'

const FUNCS: Record<string, (x: number, deg: boolean) => number> = {
  sin: (x, d) => Math.sin(d ? (x * Math.PI) / 180 : x),
  cos: (x, d) => Math.cos(d ? (x * Math.PI) / 180 : x),
  tan: (x, d) => Math.tan(d ? (x * Math.PI) / 180 : x),
  asin: (x, d) => (d ? (Math.asin(x) * 180) / Math.PI : Math.asin(x)),
  acos: (x, d) => (d ? (Math.acos(x) * 180) / Math.PI : Math.acos(x)),
  atan: (x, d) => (d ? (Math.atan(x) * 180) / Math.PI : Math.atan(x)),
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  exp: Math.exp,
  abs: Math.abs,
}
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E }

const factorial = (n: number): number => {
  if (n < 0 || !Number.isInteger(n) || n > 170) throw new ExprError('Invalid factorial')
  let r = 1
  for (let i = 2; i <= n; i++) r *= i
  return r
}

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  const s = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/π/g, 'pi').replace(/√/g, 'sqrt').replace(/,/g, '.')
  for (let i = 0; i < s.length; ) {
    const c = s[i]!
    if (/\s/.test(c)) i++
    else if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i))
      if (!m) throw new ExprError('Bad number')
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
    } else if (/[a-z]/i.test(c)) {
      const m = /^[a-z]+/i.exec(s.slice(i))![0]
      out.push({ t: 'id', v: m.toLowerCase() })
      i += m.length
    } else if ('+-*/^%!()'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
    } else throw new ExprError(`Unexpected "${c}"`)
  }
  return out
}

/** Evaluate `src`. Throws ExprError. An open parenthesis at the end is closed for you (so "sin(30" works as you type). */
export function evaluate(src: string, angle: AngleMode = 'deg'): number {
  const toks = tokenize(src)
  let p = 0
  const deg = angle === 'deg'
  const peek = () => toks[p]
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v
  const eat = (v: string) => (isOp(v) ? (p++, true) : false)

  function expr(): number {
    let a = term()
    for (;;) {
      if (eat('+')) a += term()
      else if (eat('-')) a -= term()
      else return a
    }
  }
  function term(): number {
    let a = unary()
    for (;;) {
      if (eat('*')) a *= unary()
      else if (eat('/')) {
        const b = unary()
        if (b === 0) throw new ExprError('Division by zero')
        a /= b
      } else if (startsOperand()) a *= unary() // 2pi, 2(3), 3sin(30)
      else return a
    }
  }
  const startsOperand = () => {
    const t = peek()
    return !!t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '('))
  }
  function unary(): number {
    if (eat('-')) return -unary()
    if (eat('+')) return unary()
    return power()
  }
  // '^' is right-associative and binds tighter than unary minus on its left: -2^2 = -4
  function power(): number {
    const base = postfix()
    return eat('^') ? Math.pow(base, unary()) : base
  }
  function postfix(): number {
    let a = primary()
    for (;;) {
      if (eat('!')) a = factorial(a)
      else if (eat('%')) a /= 100
      else return a
    }
  }
  function primary(): number {
    const t = toks[p++]
    if (!t) throw new ExprError('Incomplete expression')
    if (t.t === 'num') return t.v
    if (t.t === 'id') {
      if (t.v in CONSTS) return CONSTS[t.v]!
      const f = FUNCS[t.v]
      if (!f) throw new ExprError(`Unknown "${t.v}"`)
      return f(isOp('(') ? primary() : postfix(), deg)
    }
    if (t.v === '(') {
      const v = expr()
      if (peek()) {
        if (!eat(')')) throw new ExprError('Missing )')
      }
      return v
    }
    throw new ExprError(`Unexpected "${t.v}"`)
  }

  if (!toks.length) throw new ExprError('Empty')
  const v = expr()
  if (p < toks.length) throw new ExprError(`Unexpected "${toks[p]!.v}"`)
  if (!Number.isFinite(v)) throw new ExprError('Not a number')
  return v
}

/** A result as shown: up to 12 significant digits, no trailing zeros, exponent when huge or tiny. */
export function format(v: number): string {
  if (Object.is(v, -0)) return '0'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e15 || a < 1e-9)) return v.toExponential(8).replace(/\.?0+e/, 'e').replace('e+', 'e')
  return String(Number(v.toPrecision(12)))
}
