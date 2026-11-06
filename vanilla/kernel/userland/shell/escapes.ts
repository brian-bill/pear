/// Backslash escapes (`printf`, `echo -e`, `$'…'`) and shell quoting. Pure functions.

/** Backslash escapes as `printf` and `echo -e` read them. Returns the text and whether `\c` ended the output. */
export function unescape(s: string, forB = false): { text: string; stop: boolean } {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c !== '\\' || i + 1 >= s.length) {
      out += c
      continue
    }
    const n = s[++i]!
    switch (n) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case 'a': out += '\x07'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case 'v': out += '\v'; break
      case 'e': case 'E': out += '\x1b'; break
      case '\\': out += '\\'; break
      case "'": out += "'"; break
      case '"': out += '"'; break
      case 'c': return { text: out, stop: true }
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1))
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length } else out += '\\x'
        break
      }
      case 'u': case 'U': {
        const m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(s.slice(i + 1))
        if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length } else out += `\\${n}`
        break
      }
      case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
        // `%b` reads \0nnn; a format string reads \nnn
        const zero = forB && n === '0'
        const digits = zero ? /^[0-7]{0,3}/.exec(s.slice(i + 1))![0] : /^[0-7]{1,3}/.exec(s.slice(i))![0]
        out += String.fromCharCode(parseInt(digits || '0', 8) & 0xff)
        i += zero ? digits.length : digits.length - 1
        break
      }
      default: out += `\\${n}`
    }
  }
  return { text: out, stop: false }
}

/** A string quoted so the shell reads it back as the same word (`%q`). */
export function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  if (/[\x00-\x1f\x7f]/.test(s)) return `$'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}'`
  return `'${s.replace(/'/g, "'\\''")}'`
}


/** Splits the inside of an array literal `(a "b c" 'd' [k]=v)` into words, undoing quotes and backslashes. */
export function splitWords(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let have = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      cur += text.slice(i + 1, end < 0 ? text.length : end)
      i = end < 0 ? text.length : end
      have = true
    } else if (c === '"') {
      i++
      for (; i < text.length && text[i] !== '"'; i++) cur += text[i] === '\\' && i + 1 < text.length ? text[++i] : text[i]
      have = true
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i]
      have = true
    } else if (/\s/.test(c)) {
      if (have) out.push(cur)
      cur = ''
      have = false
    } else {
      cur += c
      have = true
    }
  }
  if (have) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------------------------------- printf

export function toNumber(arg: string, errors: string[]): number {
  if (arg === '') return 0
  if (/^['"]/.test(arg)) return arg.codePointAt(1) ?? 0
  const t = arg.trim()
  if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16)
  if (/^[-+]?0[0-7]+$/.test(t)) return parseInt(t, 8)
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t)
  errors.push(`${arg}: invalid number`)
  return 0
}

export function pad(s: string, width: number, left: boolean, zero = false): string {
  if (s.length >= width) return s
  if (left) return s + ' '.repeat(width - s.length)
  if (zero) {
    const m = /^([-+ ]?(?:0[xX])?)(.*)$/s.exec(s)!
    return m[1] + '0'.repeat(width - s.length) + m[2]
  }
  return ' '.repeat(width - s.length) + s
}

/** `toFixed` rounding exact ties to even, as C does (2.25 -> 2.2). */
function fixed(n: number, prec: number): string {
  const scaled = n * 10 ** prec
  if (prec <= 15 && Number.isFinite(scaled) && scaled < 2 ** 52 && scaled - Math.floor(scaled) === 0.5) {
    const down = Math.floor(scaled)
    const even = down % 2 === 0 ? down : down + 1
    return (even / 10 ** prec).toFixed(prec)
  }
  return n.toFixed(prec)
}

function expFormat(n: number, prec: number, upper: boolean): string {
  let s = n.toExponential(prec).replace(/e([-+])(\d)$/, 'e$10$2')
  if (upper) s = s.toUpperCase()
  return s
}

function gFormat(n: number, prec: number, alt: boolean, upper: boolean): string {
  const p = prec === 0 ? 1 : prec
  if (n === 0) return alt ? (0).toFixed(p - 1) : '0'
  const exp = Math.floor(Math.log10(Math.abs(n)))
  let s: string
  if (exp < -4 || exp >= p) {
    s = expFormat(n, p - 1, false)
    if (!alt) s = s.replace(/\.?0+e/, 'e')
  } else {
    s = n.toFixed(Math.max(0, p - 1 - exp))
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '')
  }
  return upper ? s.toUpperCase() : s
}

/** Format `args` with `fmt` as printf does: the format is reused while arguments remain. */
export function format(fmt: string, args: string[]): { out: string; errors: string[]; stopped: boolean } {
  const errors: string[] = []
  let out = ''
  let used = 0
  const next = (): string | undefined => (used < args.length ? args[used++] : undefined)
  let stopped = false
  do {
    const startUsed = used
    for (let i = 0; i < fmt.length && !stopped; i++) {
      const c = fmt[i]!
      if (c === '\\') {
        const len = escLen(fmt, i + 1)
        const chunk = unescape(fmt.slice(i, i + 1 + len), false)
        out += chunk.text
        stopped = chunk.stop
        i += len
        continue
      }
      if (c !== '%') {
        out += c
        continue
      }
      if (fmt[i + 1] === '%') {
        out += '%'
        i++
        continue
      }
      const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z])/.exec(fmt.slice(i))
      if (!m) {
        errors.push(`${fmt.slice(i)}: invalid directive`)
        out += fmt.slice(i)
        break
      }
      i += m[0].length - 1
      const flags = m[1] ?? ''
      let width = m[2] === '*' ? Number(next() ?? 0) : Number(m[2] ?? 0)
      let left = flags.includes('-')
      if (width < 0) {
        left = true
        width = -width
      }
      const precRaw = m[3] === '*' ? Number(next() ?? 0) : m[3] === undefined ? undefined : Number(m[3] || 0)
      const conv = m[4]!
      const arg = next()
      const num = () => toNumber(arg ?? '', errors)
      const sign = (n: number, s: string) => (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s
      let text: string
      switch (conv) {
        case 's': text = arg ?? ''; if (precRaw !== undefined) text = [...text].slice(0, precRaw).join(''); out += pad(text, width, left); break
        case 'c': out += pad([...(arg ?? '')][0] ?? '', width, left); break
        case 'b': { const u = unescape(arg ?? '', true); text = u.text; if (precRaw !== undefined) text = text.slice(0, precRaw); out += pad(text, width, left); if (u.stop) stopped = true; break }
        case 'q': out += pad(shellQuote(arg ?? ''), width, left); break
        case 'd': case 'i': {
          const n = Math.trunc(num())
          let digits = String(Math.abs(n))
          if (precRaw !== undefined) digits = digits.padStart(precRaw, '0')
          out += pad(sign(n, digits), width, left, flags.includes('0') && precRaw === undefined)
          break
        }
        case 'u': case 'o': case 'x': case 'X': {
          let n = Math.trunc(num())
          const big = n < 0 ? BigInt.asUintN(64, BigInt(n)) : BigInt(n)
          let digits = big.toString(conv === 'u' ? 10 : conv === 'o' ? 8 : 16)
          if (conv === 'X') digits = digits.toUpperCase()
          if (precRaw !== undefined) digits = digits.padStart(precRaw, '0')
          if (flags.includes('#') && big !== 0n) digits = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + digits
          out += pad(digits, width, left, flags.includes('0') && precRaw === undefined)
          n = 0
          break
        }
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
          const n = num()
          const prec = precRaw ?? 6
          const abs = Math.abs(n)
          let body: string
          if (!Number.isFinite(n)) body = Number.isNaN(n) ? 'nan' : 'inf'
          else if (conv === 'f' || conv === 'F') body = fixed(abs, prec)
          else if (conv === 'e' || conv === 'E') body = expFormat(abs, prec, conv === 'E')
          else body = gFormat(abs, prec, flags.includes('#'), conv === 'G')
          out += pad(sign(n < 0 || Object.is(n, -0) ? -1 : 1, body), width, left, flags.includes('0'))
          break
        }
        default:
          errors.push(`%${conv}: invalid directive`)
      }
    }
    if (used === startUsed) break // a format with no conversions prints once
  } while (used < args.length && !stopped)
  return { out, errors, stopped }
}

/** Length of the escape sequence after a backslash at `fmt[at - 1]` (not counting the backslash). */
function escLen(fmt: string, at: number): number {
  const n = fmt[at]
  if (n === undefined) return 0
  if (n === 'x') return 1 + (/^[0-9a-fA-F]{1,2}/.exec(fmt.slice(at + 1))?.[0].length ?? 0)
  if (n === 'u') return 1 + (/^[0-9a-fA-F]{1,4}/.exec(fmt.slice(at + 1))?.[0].length ?? 0)
  if (n === 'U') return 1 + (/^[0-9a-fA-F]{1,8}/.exec(fmt.slice(at + 1))?.[0].length ?? 0)
  if (/[0-7]/.test(n)) return /^[0-7]{1,3}/.exec(fmt.slice(at))![0].length
  return 1
}


/** A POSIX regular expression (BRE or ERE) as JavaScript source. */
export function posixRegex(src: string, ere: boolean): string {
  const classes: Record<string, string> = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9a-fA-F', word: 'a-zA-Z0-9_' }
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '[') {
      // a bracket expression: copy it, translating [:class:] and escaping what JavaScript reads differently
      let j = i + 1
      let body = ''
      if (src[j] === '^') {
        body += '^'
        j++
      }
      if (src[j] === ']') {
        body += '\\]'
        j++
      }
      for (; j < src.length && src[j] !== ']'; j++) {
        if (src[j] === '[' && src[j + 1] === ':') {
          const end = src.indexOf(':]', j)
          const name = src.slice(j + 2, end)
          if (end > 0 && classes[name]) {
            body += classes[name]
            j = end + 1
            continue
          }
        }
        body += src[j] === '\\' ? '\\\\' : src[j] === '[' ? '\\[' : src[j]
      }
      out += `[${body}]`
      i = j
    } else if (c === '\\' && i + 1 < src.length) {
      const n = src[++i]!
      if (!ere && '(){}|+?'.includes(n)) out += n
      else if (n === '<' || n === '>') out += '\\b'
      else out += `\\${n}`
    } else if (!ere && '(){}|+?'.includes(c)) out += `\\${c}`
    else out += c
  }
  return out
}
