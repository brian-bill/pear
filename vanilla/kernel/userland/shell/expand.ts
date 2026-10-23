/// Word expansion: variables, command substitution, `~`, word splitting, and globbing.
import { evalArith } from './arith'
import type { Part, Word } from './parse'

export interface ExpandContext {
  /** A variable, including `?`, `$`, `!`, `#`, `0`-`9`. `undefined` if unset. */
  get(name: string): string | undefined
  /** `$1 $2 ...` */
  positional(): string[]
  /** Runs a command line and returns what it printed, without trailing newlines. */
  runCapture(src: string): Promise<string>
  home(): string
  cwd(): string
  readdir(path: string): Promise<Array<{ name: string }>>
  exists(path: string): Promise<boolean>
  isDir(path: string): Promise<boolean>
  /** `$((expr))`, with assignments reaching the shell. Without it the expression sees `get` only. */
  arith?(src: string): number
  /** `set -u`: an unset variable is an error. */
  nounset?(): boolean
}

interface Field {
  /** The text as it will be passed on. */
  text: string
  /** The same text with quoted wildcard characters escaped, for globbing. */
  pat: string
  /** Something quoted was in it, so an empty field still counts. */
  keep: boolean
}

const MAGIC = /[*?[\\]/g
const escapePattern = (s: string) => s.replace(MAGIC, (c) => `\\${c}`)

// ------------------------------------------------------------ brace expansion

/** One unquoted character, or any other part (which braces never look into). */
type Atom = string | Part

const toAtoms = (word: Word): Atom[] => word.flatMap((p): Atom[] => (p.t === 'lit' && !p.q ? [...p.s] : [p]))
const fromAtoms = (atoms: Atom[]): Word => {
  const out: Word = []
  for (const a of atoms) {
    const last = out[out.length - 1]
    if (typeof a !== 'string') out.push(a)
    else if (last?.t === 'lit' && !last.q) last.s += a
    else out.push({ t: 'lit', s: a, q: false })
  }
  return out
}

/** `1..5`, `a..e`, `05..10`: the items, or null if `text` is not a sequence. */
function sequence(text: string): string[] | null {
  const num = /^(-?\d+)\.\.(-?\d+)$/.exec(text)
  if (num) {
    const [a, b] = [Number(num[1]), Number(num[2])]
    if (Math.abs(b - a) > 10000) return null
    const width = /^-?0\d/.test(num[1]!) || /^-?0\d/.test(num[2]!) ? Math.max(num[1]!.length, num[2]!.length) : 0
    const out: string[] = []
    for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? 1 : -1) out.push(width ? String(n).padStart(width, '0') : String(n))
    return out
  }
  const chr = /^([A-Za-z])\.\.([A-Za-z])$/.exec(text)
  if (chr) {
    const [a, b] = [chr[1]!.charCodeAt(0), chr[2]!.charCodeAt(0)]
    const out: string[] = []
    for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? 1 : -1) out.push(String.fromCharCode(n))
    return out
  }
  return null
}

function braces(atoms: Atom[]): Atom[][] {
  for (let i = 0; i < atoms.length; i++) {
    if (atoms[i] !== '{') continue
    let depth = 0
    let close = -1
    const commas: number[] = []
    for (let j = i; j < atoms.length && close < 0; j++) {
      const a = atoms[j]
      if (a === '{') depth++
      else if (a === '}' && --depth === 0) close = j
      else if (a === ',' && depth === 1) commas.push(j)
    }
    if (close < 0) continue
    let alts: Atom[][] | null = null
    if (commas.length) {
      alts = []
      let from = i + 1
      for (const c of [...commas, close]) {
        alts.push(atoms.slice(from, c))
        from = c + 1
      }
    } else {
      const inner = atoms.slice(i + 1, close)
      const seq = inner.every((a) => typeof a === 'string') ? sequence(inner.join('')) : null
      if (seq) alts = seq.map((s) => [...s])
    }
    if (!alts) continue
    const pre = atoms.slice(0, i)
    const post = atoms.slice(close + 1)
    return alts.flatMap((alt) => braces([...pre, ...alt, ...post]))
  }
  return [atoms]
}

/** `a{b,c}d` is `abd acd`; `{1..3}` is `1 2 3`. Quoted braces stay. */
export function braceExpand(word: Word): Word[] {
  if (!word.some((p) => p.t === 'lit' && !p.q && p.s.includes('{'))) return [word]
  return braces(toAtoms(word)).map(fromAtoms)
}

export async function expandWord(word: Word, ctx: ExpandContext, opts: { split?: boolean; glob?: boolean; pattern?: boolean } = {}): Promise<string[]> {
  if (opts.split ?? true) {
    const out: string[] = []
    for (const w of braceExpand(word)) out.push(...(await expandOne(w, ctx, opts)))
    return out
  }
  return expandOne(word, ctx, opts)
}

/** A word as a glob pattern: quoted characters are escaped, so `"*"` matches only an asterisk (`case`). */
export async function expandPattern(word: Word, ctx: ExpandContext): Promise<string> {
  return (await expandOne(word, ctx, { split: false, glob: false, pattern: true })).join(' ')
}

async function expandOne(word: Word, ctx: ExpandContext, opts: { split?: boolean; glob?: boolean; pattern?: boolean }): Promise<string[]> {
  const split = opts.split ?? true
  const doGlob = opts.glob ?? true
  const fields: Field[] = []
  let cur: Field | null = null

  const add = (text: string, quoted: boolean) => {
    cur ??= { text: '', pat: '', keep: false }
    cur.text += text
    cur.pat += quoted ? escapePattern(text) : text
    if (quoted) cur.keep = true
  }
  const flush = () => {
    if (cur && (cur.text !== '' || cur.keep)) fields.push(cur)
    cur = null
  }
  const insert = (value: string, quoted: boolean) => {
    if (quoted || !split) return add(value, true)
    value.split(/[ \t\n]+/).forEach((piece, k) => {
      if (k > 0) flush()
      if (piece) add(piece, false)
    })
  }

  for (let k = 0; k < word.length; k++) {
    const part = word[k]!
    if (part.t === 'lit') {
      let s = part.s
      if (k === 0 && !part.q && (s === '~' || s.startsWith('~/'))) s = ctx.home() + s.slice(1)
      add(s, part.q)
    } else if (part.t === 'cmd') {
      insert(await ctx.runCapture(part.src), part.q)
    } else if (part.t === 'arith') {
      const text = await expandString(part.word, ctx)
      insert(String(ctx.arith ? ctx.arith(text) : evalArith(text, ctx)), part.q)
    } else if ((part.name === '@' || part.name === '*') && !part.mod) {
      const args = ctx.positional()
      if (part.q && part.name === '@') {
        args.forEach((a, n) => {
          if (n > 0) flush()
          add(a, true)
        })
      } else {
        insert(args.join(' '), part.q)
      }
    } else {
      const value = await lookup(part, ctx)
      insert(value, part.q)
    }
  }
  flush()

  if (opts.pattern) return fields.map((f) => f.pat)
  if (!doGlob) return fields.map((f) => f.text)
  const out: string[] = []
  for (const f of fields) {
    if (hasMagic(f.pat)) {
      const hits = await glob(f.pat, ctx)
      if (hits.length) {
        out.push(...hits)
        continue
      }
    }
    out.push(f.text)
  }
  return out
}

/** Expands a word to a single string: no splitting, no globbing (assignments, redirection targets). */
export async function expandString(word: Word, ctx: ExpandContext): Promise<string> {
  return (await expandWord(word, ctx, { split: false, glob: false })).join(' ')
}

async function lookup(part: Extract<Word[number], { t: 'var' }>, ctx: ExpandContext): Promise<string> {
  const value = ctx.get(part.name)
  if (value === undefined && !part.mod && ctx.nounset?.()) throw new Error(`${part.name}: unbound variable`)
  switch (part.mod) {
    case undefined:
      return value ?? ''
    case '#':
      return String((value ?? '').length)
    case ':-':
      return value ? value : await expandString(part.arg ?? [], ctx)
    case '-':
      return value !== undefined ? value : await expandString(part.arg ?? [], ctx)
    case ':+':
      return value ? await expandString(part.arg ?? [], ctx) : ''
    case '+':
      return value !== undefined ? await expandString(part.arg ?? [], ctx) : ''
  }
  return value ?? ''
}

// ------------------------------------------------------------------- globbing

export function hasMagic(pat: string): boolean {
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === '\\') i++
    else if (c === '*' || c === '?') return true
    else if (c === '[' && pat.indexOf(']', i + 2) > 0) return true
  }
  return false
}

const unescape = (pat: string) => pat.replace(/\\(.)/gs, '$1')
const reEscape = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

export function segmentToRegex(seg: string, slashes = false): RegExp {
  let re = '^'
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === '\\') re += reEscape(seg[++i] ?? '\\')
    else if (c === '*') re += slashes ? '.*' : '[^/]*'
    else if (c === '?') re += slashes ? '.' : '[^/]'
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2)
      if (end < 0) {
        re += '\\['
        continue
      }
      let body = seg.slice(i + 1, end)
      const negate = body[0] === '!' || body[0] === '^'
      if (negate) body = body.slice(1)
      re += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
      i = end
    } else re += reEscape(c)
  }
  return new RegExp(`${re}$`, 's')
}

const joinPath = (base: string, name: string) => (base === '' ? name : base === '/' ? `/${name}` : `${base}/${name}`)

/** Paths matching `pat` (with `\` escapes), sorted. Hidden files only match a pattern that starts with a dot. */
export async function glob(pat: string, ctx: ExpandContext): Promise<string[]> {
  const absolute = pat.startsWith('/')
  const dirOnly = pat.endsWith('/')
  const segs = pat.split('/').filter((s) => s !== '')
  let results = [absolute ? '/' : '']
  for (const seg of segs) {
    const next: string[] = []
    if (hasMagic(seg)) {
      const re = segmentToRegex(seg)
      for (const base of results) {
        let entries: Array<{ name: string }> = []
        try {
          entries = await ctx.readdir(base === '' ? ctx.cwd() : base)
        } catch {
          continue
        }
        for (const e of entries.map((x) => x.name).sort()) {
          if (e.startsWith('.') && !seg.startsWith('.')) continue
          if (re.test(e)) next.push(joinPath(base, e))
        }
      }
    } else {
      for (const base of results) next.push(joinPath(base, unescape(seg)))
    }
    results = next
  }
  const found: string[] = []
  for (const r of results) {
    if (r === '') continue
    const full = r.startsWith('/') ? r : joinPath(ctx.cwd(), r)
    if (dirOnly ? await ctx.isDir(full) : await ctx.exists(full)) found.push(dirOnly ? `${r}/` : r)
  }
  return found.sort()
}
