/// Shell syntax: text in, a syntax tree out. No I/O here, so it can be tested on its own.

/** A piece of a word. `q` is true when it was quoted (no word splitting, no globbing). */
export type Part =
  | { t: 'lit'; s: string; q: boolean }
  | { t: 'var'; name: string; mod?: string; arg?: Word; q: boolean }
  | { t: 'cmd'; src: string; q: boolean }
  /** `word` is the expression with its own `$`-expansions still to do. */
  | { t: 'arith'; src: string; word: Word; q: boolean }
export type Word = Part[]

export interface Redir {
  /** The stream being redirected: 0, 1 or 2. */
  fd: number
  op: '<' | '>' | '>>' | '>&' | '<&' | '<<'
  /** For `<<` (a here-document) this is the body, to be expanded unless the delimiter was quoted. */
  target: Word
}

/** A command: a simple one (words, assignments), or a compound one with optional redirections after it. */
export interface Simple {
  assigns: Array<{ name: string; value: Word }>
  words: Word[]
  redirs: Redir[]
  compound?: Compound
}

export type Compound =
  | { k: 'if'; branches: Array<{ cond: Item[]; body: Item[] }>; else: Item[] | null }
  | { k: 'while'; until: boolean; cond: Item[]; body: Item[] }
  /** `words: null` means `"$@"`. */
  | { k: 'for'; name: string; words: Word[] | null; body: Item[] }
  | { k: 'case'; word: Word; clauses: Array<{ patterns: Word[]; body: Item[] }> }
  | { k: 'group'; body: Item[] }
  | { k: 'subshell'; body: Item[] }
  | { k: 'func'; name: string; body: Simple }

export interface Pipeline {
  cmds: Simple[]
  negate: boolean
}

export interface AndOr {
  first: Pipeline
  rest: Array<{ op: '&&' | '||'; pipe: Pipeline }>
}

export interface Item {
  andor: AndOr
  background: boolean
  /** The text of the command, for `jobs`. */
  src: string
}

export class ParseError extends Error {
  /** More input could complete this (unclosed quote, trailing `|`): an interactive shell asks for another line. */
  constructor(
    message: string,
    readonly incomplete = false,
  ) {
    super(message)
  }
}

interface HereDoc {
  delim: string
  /** `<<-`: leading tabs are removed from the body and the delimiter line. */
  strip: boolean
  /** The delimiter was quoted: the body is taken literally. */
  quoted: boolean
  /** Filled in when the lexer reaches the end of the line the `<<` is on. */
  text: string
}

type Token =
  | { type: 'word'; word: Word; pos: number; end: number }
  | { type: 'op'; op: string; fd?: number; here?: HereDoc; pos: number; end: number }
  | { type: 'sep'; op: ';' | '&' | '\n' | ';;'; pos: number; end: number }

export interface ParseOptions {
  /** Alias name -> text, replaced where a command starts. */
  aliases?: Map<string, string>
}

const META = new Set([' ', '\t', '\n', '|', '&', ';', '<', '>', '(', ')'])
const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const SPECIAL_VARS = new Set(['?', '$', '!', '#', '@', '*', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])

class Lexer {
  i = 0
  private pendingHere: HereDoc[] = []
  constructor(private src: string) {}

  tokens(): Token[] {
    const out: Token[] = []
    const s = this.src
    while (this.i < s.length) {
      const c = s[this.i]!
      const pos = this.i
      if (c === ' ' || c === '\t') {
        this.i++
      } else if (c === '\\' && s[this.i + 1] === '\n') {
        this.i += 2 // line continuation
      } else if (c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++
      } else if (c === '\n') {
        this.i++
        out.push({ type: 'sep', op: '\n', pos, end: this.i })
        this.readHereDocs()
      } else if (c === ';') {
        this.i++
        const dsemi = s[this.i] === ';'
        if (dsemi) this.i++
        out.push({ type: 'sep', op: dsemi ? ';;' : ';', pos, end: this.i })
      } else if (c === '|') {
        const op = s[this.i + 1] === '|' ? '||' : '|'
        this.i += op.length
        out.push({ type: 'op', op, pos, end: this.i })
      } else if (c === '&') {
        if (s[this.i + 1] === '&') {
          this.i += 2
          out.push({ type: 'op', op: '&&', pos, end: this.i })
        } else if (s[this.i + 1] === '>') {
          this.i += 2
          const append = s[this.i] === '>'
          if (append) this.i++
          out.push({ type: 'op', op: append ? '&>>' : '&>', pos, end: this.i })
        } else {
          this.i++
          out.push({ type: 'sep', op: '&', pos, end: this.i })
        }
      } else if (c === '<' || c === '>') {
        out.push(this.redirect(undefined))
      } else if (c === '(' || c === ')') {
        this.i++
        out.push({ type: 'op', op: c, pos, end: this.i })
      } else {
        const word = this.word()
        // `2>file`: a number glued to a redirection is the stream it applies to.
        const next = s[this.i]
        if ((next === '<' || next === '>') && word.length === 1 && word[0]!.t === 'lit' && !word[0]!.q && /^[0-2]$/.test(word[0]!.s)) {
          out.push(this.redirect(Number(word[0]!.s), pos))
        } else {
          out.push({ type: 'word', word, pos, end: this.i })
        }
      }
    }
    if (this.pendingHere.length) throw new ParseError(`here-document delimited by end of input (wanted '${this.pendingHere[0]!.delim}')`, true)
    return out
  }

  /** At the start of the line after a `<<`: read each pending body up to its delimiter line. */
  private readHereDocs(): void {
    const s = this.src
    for (const h of this.pendingHere) {
      const lines: string[] = []
      for (;;) {
        if (this.i >= s.length) throw new ParseError(`here-document delimited by end of input (wanted '${h.delim}')`, true)
        const nl = s.indexOf('\n', this.i)
        const raw = s.slice(this.i, nl < 0 ? s.length : nl)
        this.i = nl < 0 ? s.length : nl + 1
        const line = h.strip ? raw.replace(/^\t+/, '') : raw
        if (line === h.delim) break
        lines.push(line)
      }
      h.text = lines.map((l) => `${l}\n`).join('')
    }
    this.pendingHere = []
  }

  /** The text of a here-document that is not quoted: `$`-expansions apply, `\` escapes `$ \` and newline. */
  bodyWord(): Word {
    const s = this.src
    const parts: Word = []
    let lit = ''
    const flush = () => {
      if (lit) parts.push({ t: 'lit', s: lit, q: true })
      lit = ''
    }
    while (this.i < s.length) {
      const c = s[this.i]!
      if (c === '\\' && '$\\\n'.includes(s[this.i + 1] ?? 'x')) {
        if (s[this.i + 1] !== '\n') lit += s[this.i + 1]
        this.i += 2
      } else if (c === '$') {
        flush()
        this.dollar(parts, true)
      } else {
        lit += c
        this.i++
      }
    }
    flush()
    return parts
  }

  private redirect(fd: number | undefined, startPos = this.i): Token {
    const s = this.src
    const c = s[this.i]!
    this.i++
    let op = c
    if (c === '>' && s[this.i] === '>') {
      op = '>>'
      this.i++
    } else if (c === '<' && s[this.i] === '<') {
      this.i++
      const strip = s[this.i] === '-'
      if (strip) this.i++
      while (s[this.i] === ' ' || s[this.i] === '\t') this.i++
      if (this.i >= s.length || META.has(s[this.i]!)) throw new ParseError("syntax error: expected a delimiter after '<<'", this.i >= s.length)
      const word = this.word()
      const here: HereDoc = {
        delim: word.map((x) => (x.t === 'lit' ? x.s : '')).join(''),
        strip,
        quoted: word.some((x) => x.t === 'lit' && x.q),
        text: '',
      }
      this.pendingHere.push(here)
      return { type: 'op', op: '<<', fd, here, pos: startPos, end: this.i }
    } else if (s[this.i] === '&') {
      op = c + '&'
      this.i++
    }
    return { type: 'op', op, fd, pos: startPos, end: this.i }
  }

  private word(): Word {
    const s = this.src
    const parts: Word = []
    let lit = ''
    const flush = (q: boolean) => {
      if (lit) parts.push({ t: 'lit', s: lit, q })
      lit = ''
    }
    while (this.i < s.length && !META.has(s[this.i]!)) {
      const c = s[this.i]!
      if (c === "'") {
        flush(false)
        const end = s.indexOf("'", this.i + 1)
        if (end < 0) throw new ParseError('unterminated single quote', true)
        parts.push({ t: 'lit', s: s.slice(this.i + 1, end), q: true })
        this.i = end + 1
      } else if (c === '"') {
        flush(false)
        this.i++
        this.doubleQuoted(parts)
      } else if (c === '\\') {
        if (this.i + 1 >= s.length) throw new ParseError('trailing backslash', true)
        if (s[this.i + 1] === '\n') {
          this.i += 2
        } else {
          flush(false)
          parts.push({ t: 'lit', s: s[this.i + 1]!, q: true })
          this.i += 2
        }
      } else if (c === '$') {
        flush(false)
        this.dollar(parts, false)
      } else {
        lit += c
        this.i++
      }
    }
    flush(false)
    return parts
  }

  private doubleQuoted(parts: Word): void {
    const s = this.src
    const before = parts.length
    let lit = ''
    const flush = () => {
      if (lit) parts.push({ t: 'lit', s: lit, q: true })
      lit = ''
    }
    for (;;) {
      if (this.i >= s.length) throw new ParseError('unterminated double quote', true)
      const c = s[this.i]!
      if (c === '"') {
        this.i++
        flush()
        // "" is an empty argument, not nothing.
        if (parts.length === before) parts.push({ t: 'lit', s: '', q: true })
        return
      }
      if (c === '\\' && '$`"\\\n'.includes(s[this.i + 1] ?? 'x')) {
        if (s[this.i + 1] !== '\n') lit += s[this.i + 1]
        this.i += 2
      } else if (c === '$') {
        flush()
        this.dollar(parts, true)
      } else {
        lit += c
        this.i++
      }
    }
  }

  /** At a `$`: `$(cmd)`, `${name…}`, `$name`, `$?`, … or a plain `$`. */
  private dollar(parts: Word, q: boolean): void {
    const s = this.src
    const next = s[this.i + 1]
    if (next === '(' && s[this.i + 2] === '(') {
      // `$((expr))`; `$( (cmd) )` with the two parentheses closing apart is a command substitution after all.
      let depth = 0
      for (let j = this.i + 3; j < s.length; j++) {
        if (s[j] === '(') depth++
        else if (s[j] === ')') {
          if (depth > 0) depth--
          else if (s[j + 1] === ')') {
            const src = s.slice(this.i + 3, j)
            parts.push({ t: 'arith', src, word: new Lexer(src).bodyWord(), q })
            this.i = j + 2
            return
          } else break
        }
      }
    }
    if (next === '(') {
      const start = this.i + 2
      let depth = 1
      let j = start
      while (j < s.length && depth > 0) {
        const c = s[j]!
        if (c === "'") j = s.indexOf("'", j + 1) < 0 ? s.length : s.indexOf("'", j + 1)
        else if (c === '"') {
          j++
          while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
        } else if (c === '\\') j++
        else if (c === '(') depth++
        else if (c === ')') depth--
        j++
      }
      if (depth > 0) throw new ParseError('unterminated $(', true)
      parts.push({ t: 'cmd', src: s.slice(start, j - 1), q })
      this.i = j
    } else if (next === '{') {
      const end = this.matchingBrace(this.i + 2)
      parts.push(this.braced(s.slice(this.i + 2, end), q))
      this.i = end + 1
    } else if (next !== undefined && NAME_START.test(next)) {
      let j = this.i + 1
      while (j < s.length && NAME_CHAR.test(s[j]!)) j++
      parts.push({ t: 'var', name: s.slice(this.i + 1, j), q })
      this.i = j
    } else if (next !== undefined && SPECIAL_VARS.has(next)) {
      parts.push({ t: 'var', name: next, q })
      this.i += 2
    } else {
      parts.push({ t: 'lit', s: '$', q })
      this.i++
    }
  }

  private matchingBrace(from: number): number {
    const s = this.src
    let depth = 1
    for (let j = from; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) return j
    }
    throw new ParseError('unterminated ${', true)
  }

  /** The inside of `${…}`: `name`, `name:-word`, `#name`, … */
  private braced(inner: string, q: boolean): Part {
    if (inner.startsWith('#') && inner.length > 1) return { t: 'var', name: inner.slice(1), mod: '#', q }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9?$!#@*])(:?[-+])?/.exec(inner)
    if (!m) throw new ParseError(`bad substitution: \${${inner}}`)
    if (!m[2]) {
      if (m[0].length !== inner.length) throw new ParseError(`bad substitution: \${${inner}}`)
      return { t: 'var', name: m[1]!, q }
    }
    const sub = new Lexer(inner.slice(m[0].length))
    const arg = sub.word()
    if (sub.i < sub.src.length) throw new ParseError(`bad substitution: \${${inner}}`)
    return { t: 'var', name: m[1]!, mod: m[2], arg, q }
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Words that end a clause: only meaningful where a command could start. */
const CLAUSE_END = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'])

/** The text of a word that is a single unquoted literal (a possible keyword), else null. */
const plain = (t: Token | undefined): string | null =>
  t?.type === 'word' && t.word.length === 1 && t.word[0]!.t === 'lit' && !t.word[0]!.q ? t.word[0]!.s : null

export function parse(src: string, opts: ParseOptions = {}): Item[] {
  const tokens = new Lexer(src).tokens()
  let at = 0
  const peek = () => tokens[at]
  const isOp = (t: Token | undefined, ...ops: string[]): t is Extract<Token, { type: 'op' }> => t?.type === 'op' && ops.includes(t.op)
  const isSep = (t: Token | undefined, ...ops: string[]): t is Extract<Token, { type: 'sep' }> => t?.type === 'sep' && ops.includes(t.op)
  const near = (t: Token) => `syntax error near '${t.type === 'word' ? (plain(t) ?? 'word') : t.op}'`
  const skipNewlines = () => {
    while (isSep(peek(), '\n')) at++
  }

  const redirections = (cmd: Simple): boolean => {
    const t = peek()
    if (!(t && t.type === 'op' && /^(<|>|>>|>&|<&|&>|&>>|<<)$/.test(t.op))) return false
    at++
    if (t.op === '<<') {
      const h = t.here!
      const body: Word = h.quoted ? [{ t: 'lit', s: h.text, q: true }] : new Lexer(h.text).bodyWord()
      cmd.redirs.push({ fd: t.fd ?? 0, op: '<<', target: body })
      return true
    }
    const target = peek()
    if (target?.type !== 'word') throw new ParseError(`syntax error: expected a file name after '${t.op}'`, target === undefined)
    at++
    if (t.op === '&>' || t.op === '&>>') {
      cmd.redirs.push({ fd: 1, op: t.op === '&>' ? '>' : '>>', target: target.word })
      cmd.redirs.push({ fd: 2, op: '>&', target: [{ t: 'lit', s: '1', q: false }] })
    } else {
      cmd.redirs.push({ fd: t.fd ?? (t.op[0] === '<' ? 0 : 1), op: t.op as Redir['op'], target: target.word })
    }
    return true
  }

  const simple = (): Simple => {
    const cmd: Simple = { assigns: [], words: [], redirs: [] }
    for (;;) {
      if (redirections(cmd)) continue
      const t = peek()
      if (t?.type !== 'word') break
      at++
      const first = t.word[0]
      const m = !cmd.words.length && first?.t === 'lit' && !first.q ? /^([A-Za-z_][A-Za-z0-9_]*)=([^]*)$/.exec(first.s) : null
      if (m) {
        const value: Word = [...(m[2] ? [{ t: 'lit' as const, s: m[2], q: false }] : []), ...t.word.slice(1)]
        cmd.assigns.push({ name: m[1]!, value })
      } else {
        cmd.words.push(t.word)
      }
    }
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) {
      const t = peek()
      throw t ? new ParseError(near(t)) : new ParseError('unexpected end of input', true)
    }
    return cmd
  }

  const expectWord = (what: string): string => {
    const t = peek()
    const w = plain(t)
    if (!t) throw new ParseError('unexpected end of input', true)
    if (w !== what) throw new ParseError(near(t))
    at++
    return w
  }
  const expectOp = (op: string) => {
    const t = peek()
    if (!t) throw new ParseError('unexpected end of input', true)
    if (!isOp(t, op)) throw new ParseError(near(t))
    at++
  }

  /** Commands up to (not including) one of the `stops` keywords, a `)`, or `;;`. */
  const list = (stops: string[], inCase = false): Item[] => {
    const items: Item[] = []
    for (;;) {
      while (isSep(peek(), '\n', ';')) at++
      const t = peek()
      if (!t) {
        if (stops.length) throw new ParseError('unexpected end of input', true)
        break
      }
      if (isSep(t, ';;')) {
        if (inCase) break
        throw new ParseError(near(t))
      }
      if (isOp(t, ')')) {
        if (stops.includes(')')) break
        throw new ParseError(near(t))
      }
      const kw = plain(t)
      if (kw !== null && stops.includes(kw)) break
      const start = t.pos
      const a = andor()
      const endTok = tokens[at - 1]!
      const sep = peek()
      let background = false
      if (isSep(sep, '&')) {
        background = true
        at++
      } else if (sep && (sep as Token).type !== 'sep' && !isOp(sep, ')')) {
        throw new ParseError(near(sep))
      }
      items.push({ andor: a, background, src: src.slice(start, endTok.end).trim() })
    }
    return items
  }

  const compound = (c: Compound): Simple => {
    const cmd: Simple = { assigns: [], words: [], redirs: [], compound: c }
    while (redirections(cmd));
    return cmd
  }

  const ifClause = (): Compound => {
    at++
    const branches: Array<{ cond: Item[]; body: Item[] }> = []
    let otherwise: Item[] | null = null
    for (;;) {
      const cond = list(['then'])
      expectWord('then')
      branches.push({ cond, body: list(['elif', 'else', 'fi']) })
      const kw = plain(peek())
      if (kw === 'elif') {
        at++
        continue
      }
      if (kw === 'else') {
        at++
        otherwise = list(['fi'])
      }
      expectWord('fi')
      return { k: 'if', branches, else: otherwise }
    }
  }

  const whileClause = (until: boolean): Compound => {
    at++
    const cond = list(['do'])
    expectWord('do')
    const body = list(['done'])
    expectWord('done')
    return { k: 'while', until, cond, body }
  }

  const forClause = (): Compound => {
    at++
    const nameTok = peek()
    const name = plain(nameTok)
    if (!nameTok) throw new ParseError('unexpected end of input', true)
    if (name === null || !NAME.test(name)) throw new ParseError(`syntax error: '${name ?? 'word'}' is not a valid variable name`)
    at++
    skipNewlines()
    let words: Word[] | null = null
    if (plain(peek()) === 'in') {
      at++
      words = []
      for (let t = peek(); t?.type === 'word'; t = peek()) {
        words.push(t.word)
        at++
      }
    }
    while (isSep(peek(), '\n', ';')) at++
    expectWord('do')
    const body = list(['done'])
    expectWord('done')
    return { k: 'for', name, words, body }
  }

  const caseClause = (): Compound => {
    at++
    const subject = peek()
    if (!subject) throw new ParseError('unexpected end of input', true)
    if (subject.type !== 'word') throw new ParseError(near(subject))
    at++
    skipNewlines()
    expectWord('in')
    const clauses: Array<{ patterns: Word[]; body: Item[] }> = []
    for (;;) {
      skipNewlines()
      const t = peek()
      if (!t) throw new ParseError('unexpected end of input', true)
      if (plain(t) === 'esac') {
        at++
        return { k: 'case', word: subject.word, clauses }
      }
      if (isOp(t, '(')) at++
      const patterns: Word[] = []
      for (;;) {
        const p = peek()
        if (!p) throw new ParseError('unexpected end of input', true)
        if (p.type !== 'word') throw new ParseError(near(p))
        patterns.push(p.word)
        at++
        if (!isOp(peek(), '|')) break
        at++
      }
      expectOp(')')
      const body = list(['esac'], true)
      if (isSep(peek(), ';;')) at++
      clauses.push({ patterns, body })
    }
  }

  const functionBody = (name: string): Simple => {
    skipNewlines()
    const body = command()
    if (!body.compound) throw new ParseError(`syntax error: the body of function '${name}' must be a compound command`)
    return body
  }

  const expandAlias = () => {
    const aliases = opts.aliases
    if (!aliases?.size) return
    const seen = new Set<string>()
    for (;;) {
      const t = peek()
      const name = plain(t)
      if (name === null || seen.has(name)) return
      const value = aliases.get(name)
      if (value === undefined) return
      seen.add(name)
      // The replacement keeps the position of the word it replaces, so `jobs` shows what was typed.
      tokens.splice(at, 1, ...new Lexer(value).tokens().map((x) => ({ ...x, pos: t!.pos, end: t!.end })))
    }
  }

  const command = (): Simple => {
    expandAlias()
    const t = peek()
    const kw = plain(t)
    if (isOp(t, '(')) {
      at++
      const body = list([')'])
      expectOp(')')
      return compound({ k: 'subshell', body })
    }
    if (kw !== null) {
      switch (kw) {
        case 'if':
          return compound(ifClause())
        case 'while':
        case 'until':
          return compound(whileClause(kw === 'until'))
        case 'for':
          return compound(forClause())
        case 'case':
          return compound(caseClause())
        case '{': {
          at++
          const body = list(['}'])
          expectWord('}')
          return compound({ k: 'group', body })
        }
        case 'function': {
          at++
          const name = plain(peek())
          if (name === null || !NAME.test(name)) throw new ParseError(peek() ? near(peek()!) : 'unexpected end of input', !peek())
          at++
          if (isOp(peek(), '(')) {
            at++
            expectOp(')')
          }
          return compound({ k: 'func', name, body: functionBody(name) })
        }
      }
      if (CLAUSE_END.has(kw)) throw new ParseError(near(t!))
      if (NAME.test(kw) && isOp(tokens[at + 1], '(') && isOp(tokens[at + 2], ')')) {
        at += 3
        return compound({ k: 'func', name: kw, body: functionBody(kw) })
      }
    }
    return simple()
  }

  const pipeline = (): Pipeline => {
    let negate = false
    if (plain(peek()) === '!') {
      negate = true
      at++
    }
    const cmds = [command()]
    while (isOp(peek(), '|')) {
      at++
      skipNewlines() // a newline after | continues
      cmds.push(command())
    }
    return { cmds, negate }
  }

  const andor = (): AndOr => {
    const first = pipeline()
    const rest: AndOr['rest'] = []
    while (isOp(peek(), '&&', '||')) {
      const op = (peek() as { op: '&&' | '||' }).op
      at++
      skipNewlines()
      rest.push({ op, pipe: pipeline() })
    }
    return { first, rest }
  }

  return list([])
}
