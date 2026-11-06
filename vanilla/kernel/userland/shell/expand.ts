/// Word expansion: variables, command substitution, `~`, word splitting, and globbing.
import { evalArith } from './arith'
import type { Part, Word } from './parse'
import { shellQuote } from './escapes'

/** An array variable: indexed (keys are integers as text) or associative. */
export interface ShellArray {
  assoc: boolean
  items: Map<string, string>
}

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
  /** The array called `name`, if there is one. */
  array?(name: string): ShellArray | undefined
  /** `${x:=word}` */
  assign?(name: string, value: string): void
  /** `<(cmd)`: run it and give back the name of a file holding its output. */
  procSub?(src: string): Promise<string>
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
    } else if (part.t === 'arr') {
      const parts: string[] = []
      for (const item of part.items) parts.push(...(await expandWord(item, ctx)))
      add(`(${parts.map(shellQuote).join(' ')})`, true)
    } else if (part.t === 'psub') {
      insert(ctx.procSub ? await ctx.procSub(part.src) : '', part.q)
    } else {
      const r = await resolve(part, ctx)
      if (!r.multi) insert(r.list[0] ?? '', part.q)
      else if (part.q && !r.star) {
        r.list.forEach((a, n) => {
          if (n > 0) flush()
          add(a, true)
        })
      } else insert(r.list.join(' '), part.q)
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

// ------------------------------------------------------------ parameters

type VarPart = Extract<Part, { t: 'var' }>

/** The values of an array in index order (numeric for indexed arrays, insertion order for associative ones). */
export function arrayValues(a: ShellArray): string[] {
  return arrayKeys(a).map((k) => a.items.get(k)!)
}

export function arrayKeys(a: ShellArray): string[] {
  const keys = [...a.items.keys()]
  return a.assoc ? keys : keys.sort((x, y) => Number(x) - Number(y))
}

const subscriptAll = (w: Word | undefined): '@' | '*' | null => (w && w.length === 1 && w[0]!.t === 'lit' && (w[0]!.s === '@' || w[0]!.s === '*') ? (w[0]!.s as '@' | '*') : null)

const arith = (ctx: ExpandContext, text: string): number => (ctx.arith ? ctx.arith(text) : evalArith(text, ctx))

/** The key of `name[index]` as stored. */
async function keyOf(a: ShellArray | undefined, index: Word, ctx: ExpandContext): Promise<string> {
  const text = await expandString(index, ctx)
  if (a?.assoc) return text
  let n = Math.trunc(arith(ctx, text))
  if (n < 0 && a) n += Math.max(-1, ...[...a.items.keys()].map(Number)) + 1
  return String(n)
}

/** A shell pattern (with `\\` escapes) as an unanchored-use regular expression for one candidate substring. */
const matcher = (pat: string): ((s: string) => boolean) => {
  const re = segmentToRegex(pat, true)
  return (s) => re.test(s)
}

function trim(value: string, pat: string, side: '#' | '%', long: boolean): string {
  const test = matcher(pat)
  const n = value.length
  if (side === '#') {
    for (let k = long ? n : 0; long ? k >= 0 : k <= n; k += long ? -1 : 1) if (test(value.slice(0, k))) return value.slice(k)
  } else {
    for (let k = long ? 0 : n; long ? k <= n : k >= 0; k += long ? 1 : -1) if (test(value.slice(k))) return value.slice(0, k)
  }
  return value
}

function replace(value: string, pat: string, rep: string, kind: string): string {
  if (pat === '') return value
  const test = matcher(pat)
  const n = value.length
  if (kind === '/#') {
    for (let e = n; e >= 0; e--) if (test(value.slice(0, e))) return rep + value.slice(e)
    return value
  }
  if (kind === '/%') {
    for (let b = 0; b <= n; b++) if (test(value.slice(b))) return value.slice(0, b) + rep
    return value
  }
  let out = ''
  let i = 0
  while (i <= n) {
    let hit = -1
    for (let e = n; e > i; e--) {
      if (test(value.slice(i, e))) {
        hit = e
        break
      }
    }
    if (hit < 0) {
      if (i < n) out += value[i]
      i++
    } else {
      out += rep
      i = hit
      if (kind === '/') return out + value.slice(i)
    }
  }
  return out
}

function recase(value: string, mod: string, pat: string | null): string {
  const upper = mod[0] === '^'
  const all = mod.length === 2
  const test = pat === null ? () => true : matcher(pat)
  let out = ''
  let done = false
  for (const ch of value) {
    if ((all || !done) && test(ch)) {
      out += upper ? ch.toUpperCase() : ch.toLowerCase()
      done = true
    } else {
      out += ch
      done = true
    }
  }
  return out
}

/** Evaluates a `${…}` to a list: one entry for a scalar, the elements for `$@`, `$*`, `${a[@]}`, `${!a[@]}`. */
async function resolve(part: VarPart, ctx: ExpandContext): Promise<{ list: string[]; multi: boolean; star: boolean }> {
  const all = subscriptAll(part.index)
  let name = part.name
  if (part.mod === 'indirect') {
    name = ctx.get(name) ?? ''
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(name)
    if (m) return resolve({ t: 'var', name: m[1]!, index: [{ t: 'lit', s: m[2]!, q: false }], q: part.q }, ctx)
  }
  const arr = ctx.array?.(name)
  let list: string[]
  let multi = false
  let star = false
  if (name === '@' || name === '*') {
    list = ctx.positional()
    multi = true
    star = name === '*'
  } else if (all) {
    multi = true
    star = all === '*'
    list = part.mod === 'keys' ? (arr ? arrayKeys(arr) : ctx.get(name) !== undefined ? ['0'] : []) : arr ? arrayValues(arr) : ctx.get(name) !== undefined ? [ctx.get(name)!] : []
  } else if (part.index) {
    const key = await keyOf(arr, part.index, ctx)
    const v = arr ? arr.items.get(key) : key === '0' ? ctx.get(name) : undefined
    list = v === undefined ? [] : [v]
  } else {
    const v = ctx.get(name)
    if (v === undefined && !part.mod && ctx.nounset?.()) throw new Error(`${name}: unbound variable`)
    list = v === undefined ? [] : [v]
  }
  const set = list.length > 0
  const value = list[0]
  const one = (f: (v: string) => string) => ({ list: multi ? list.map(f) : [f(value ?? '')], multi, star })
  const word = async (w: Word | undefined) => expandString(w ?? [], ctx)
  const pattern = async (w: Word | undefined) => expandPattern(w ?? [], ctx)

  switch (part.mod) {
    case undefined:
    case 'indirect':
    case 'keys':
      return { list: multi ? list : [value ?? ''], multi, star }
    case 'len':
      return { list: [String(multi ? list.length : (value ?? '').length)], multi: false, star: false }
    case ':-':
      return multi ? (list.length && list.join('') !== '' ? { list, multi, star } : { list: [await word(part.arg)], multi: false, star }) : { list: [value ? value : await word(part.arg)], multi: false, star }
    case '-':
      return set ? { list, multi, star } : { list: [await word(part.arg)], multi: false, star }
    case ':+':
      return { list: [value ? await word(part.arg) : ''], multi: false, star }
    case '+':
      return { list: [set ? await word(part.arg) : ''], multi: false, star }
    case ':=':
    case '=': {
      if (part.mod === ':=' ? value : set) return { list: multi ? list : [value ?? ''], multi, star }
      const w = await word(part.arg)
      ctx.assign?.(name, w)
      return { list: [w], multi: false, star }
    }
    case ':?':
    case '?': {
      if (part.mod === '?' ? set : value) return { list: multi ? list : [value ?? ''], multi, star }
      const msg = await word(part.arg)
      throw new Error(`${name}: ${msg || 'parameter null or not set'}`)
    }
    case '#':
    case '##':
    case '%':
    case '%%': {
      const pat = await pattern(part.arg)
      return one((v) => trim(v, pat, part.mod![0] as '#' | '%', part.mod!.length === 2))
    }
    case '/':
    case '//':
    case '/#':
    case '/%': {
      const pat = await pattern(part.arg)
      const rep = await word(part.arg2)
      return one((v) => replace(v, pat, rep, part.mod!))
    }
    case '^':
    case '^^':
    case ',':
    case ',,': {
      const pat = part.arg ? await pattern(part.arg) : null
      return one((v) => recase(v, part.mod!, pat))
    }
    case ':': {
      const off = Math.trunc(arith(ctx, await word(part.arg)))
      const lenText = part.arg2 ? await word(part.arg2) : null
      let len = lenText === null ? undefined : Math.trunc(arith(ctx, lenText))
      const slice = <T>(items: T[], start: number): T[] => {
        let b = off < 0 ? Math.max(0, items.length + off) : off - start
        if (b < 0) b = 0
        let e = items.length
        if (len !== undefined) e = len < 0 ? items.length + len : b + len
        return items.slice(b, Math.max(b, e))
      }
      if (multi) {
        if (name === '@' || name === '*') {
          // positional parameters count from 1; offset 0 includes $0
          const items = off === 0 ? [ctx.get('0') ?? '', ...list] : list
          return { list: slice(items, off === 0 ? 0 : 1), multi, star }
        }
        return { list: slice(list, 0), multi, star }
      }
      const v = value ?? ''
      const b = off < 0 ? Math.max(0, v.length + off) : Math.min(off, v.length)
      const e = len === undefined ? v.length : len < 0 ? v.length + len : b + len
      len = undefined
      return { list: [v.slice(b, Math.max(b, e))], multi: false, star }
    }
  }
  return { list: multi ? list : [value ?? ''], multi, star }
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
