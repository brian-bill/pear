/** Pure helpers on text: positions, line endings, searching. */

export type Eol = 'LF' | 'CRLF'

/** CRLF if most line breaks in the file are CRLF. */
export function detectEol(raw: string): Eol {
  let crlf = 0
  let lf = 0
  for (let i = raw.indexOf('\n'); i >= 0; i = raw.indexOf('\n', i + 1)) raw[i - 1] === '\r' ? crlf++ : lf++
  return crlf > lf ? 'CRLF' : 'LF'
}

/** Text as shown in the editor: every line break is `\n` (a lone `\r` is a break too). */
export const normalize = (raw: string) => raw.replace(/\r\n?/g, '\n')
export const withEol = (text: string, eol: Eol) => (eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : text)

/** 1-based line and column of an offset. */
export function lineCol(text: string, pos: number): { line: number; col: number } {
  let line = 1
  let last = -1
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) {
    line++
    last = i
  }
  return { line, col: pos - last }
}

export function lineCount(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Offset of the start of a 1-based line (clamped to the last line). */
export function lineStart(text: string, line: number): number {
  let pos = 0
  for (let l = 1; l < line; l++) {
    const i = text.indexOf('\n', pos)
    if (i < 0) break
    pos = i + 1
  }
  return pos
}

/** Next match at or after `from` (or the last one before `from` when backwards), wrapping around. -1 if none. */
export function find(text: string, query: string, from: number, o: { matchCase: boolean; backwards?: boolean }): number {
  if (!query) return -1
  const hay = o.matchCase ? text : text.toLowerCase()
  const needle = o.matchCase ? query : query.toLowerCase()
  if (o.backwards) {
    const i = from > 0 ? hay.lastIndexOf(needle, from - 1) : -1
    return i >= 0 ? i : hay.lastIndexOf(needle)
  }
  const i = hay.indexOf(needle, from)
  return i >= 0 ? i : hay.indexOf(needle)
}

export function countMatches(text: string, query: string, matchCase: boolean): number {
  if (!query) return 0
  const hay = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? query : query.toLowerCase()
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

export function replaceAll(text: string, query: string, repl: string, matchCase: boolean): { text: string; count: number } {
  if (!query) return { text, count: 0 }
  const hay = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? query : query.toLowerCase()
  let out = ''
  let at = 0
  let count = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, at)) {
    out += text.slice(at, i) + repl
    at = i + needle.length
    count++
  }
  return { text: out + text.slice(at), count }
}

const KINDS: Record<string, string> = {
  txt: 'Plain Text', text: 'Plain Text', log: 'Log', md: 'Markdown', markdown: 'Markdown', json: 'JSON', xml: 'XML', html: 'HTML', htm: 'HTML',
  css: 'CSS', js: 'JavaScript', mjs: 'JavaScript', ts: 'TypeScript', sh: 'Shell Script', csv: 'CSV', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
  ini: 'INI', conf: 'Config',
}
export function kindOf(name: string | null): string {
  const ext = name?.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return KINDS[ext] ?? 'Plain Text'
}
