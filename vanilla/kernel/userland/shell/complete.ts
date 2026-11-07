/// Tab completion for the interactive shell: command names (builtins, functions, aliases, programs on PATH), file names,
/// and `$VARIABLE` names. Candidates come back quoted for the shell, with `/` after a directory.
import type { Pear } from '../lib'
import { BUILTINS, type Shell } from './shell'
import type { Completion } from './readline'

const KEYWORDS = ['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function']

/** Characters that need a backslash in a word. */
const SPECIAL = /[ \t\n"'`$&|;<>()*?\[\]{}!#\\~]/g
const quote = (s: string): string => s.replace(SPECIAL, (c) => `\\${c}`)

/** Where the word under the cursor starts, whether it is in command position, and the word with quoting removed. */
function wordAt(line: string, cursor: number): { start: number; command: boolean; text: string; quote: string } {
  let start = 0
  let q = ''
  let command = true
  let i = 0
  let text = ''
  let seenWord = false
  while (i < cursor) {
    const c = line[i]!
    if (q) {
      if (c === q) q = ''
      else text += c
      i++
    } else if (c === "'" || c === '"') {
      q = c
      i++
    } else if (c === '\\' && i + 1 < cursor) {
      text += line[i + 1]
      i += 2
    } else if (/\s/.test(c)) {
      if (text !== '' || seenWord) command = command && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)
      start = i + 1
      text = ''
      seenWord = false
      i++
    } else if (c === '|' || c === ';' || c === '&' || c === '(' || c === '`') {
      command = true
      start = i + 1
      text = ''
      seenWord = false
      i++
    } else {
      text += c
      seenWord = true
      i++
    }
  }
  // a quote that opened just before the word belongs to it
  return { start, command, text, quote: q }
}

async function programs(tiny: Pear, sh: Shell, prefix: string): Promise<string[]> {
  const out = new Set<string>()
  for (const dir of (sh.get('PATH') ?? '/bin').split(':')) {
    if (!dir) continue
    const list = await tiny.readdir(dir).catch(() => [])
    for (const e of list) if (e.name.startsWith(prefix) && e.kind !== 'dir') out.add(e.name.replace(/\.app$/, ''))
  }
  return [...out]
}

async function files(tiny: Pear, sh: Shell, text: string, dirsOnly = false): Promise<string[]> {
  const slash = text.lastIndexOf('/')
  const dirPart = slash >= 0 ? text.slice(0, slash + 1) : ''
  const base = text.slice(slash + 1)
  let dir = dirPart || '.'
  if (dir.startsWith('~')) dir = (sh.get('HOME') ?? '/') + dir.slice(1)
  if (!dir.startsWith('/')) dir = `${sh.get('PWD') ?? (await tiny.getcwd())}/${dir}`
  const list = await tiny.readdir(dir).catch(() => [])
  const out: string[] = []
  for (const e of list) {
    if (!e.name.startsWith(base)) continue
    if (e.name.startsWith('.') && !base.startsWith('.')) continue
    let isDir = e.kind === 'dir'
    if (e.kind === 'symlink') isDir = (await tiny.stat(`${dir}/${e.name}`).catch(() => null))?.kind === 'dir'
    if (dirsOnly && !isDir) continue
    out.push(dirPart + e.name + (isDir ? '/' : ''))
  }
  return out
}

/**
 * What a console app's `completion` file says about the word being completed. The file is JSON:
 * `{ "flags": ["-v", "--verbose"], "args": [{ "kind": "file" | "dir" | "command" | "enum", "values": ["a", "b"] }] }`;
 * `args` is by position (after the command name, flags not counted) and its last entry repeats.
 */
interface CompletionSpec {
  flags?: string[]
  args?: Array<{ kind: 'file' | 'dir' | 'command' | 'enum'; values?: string[] }>
}

async function specFor(tiny: Pear, line: string, wordStart: number): Promise<{ spec: CompletionSpec; position: number } | null> {
  const before = line.slice(0, wordStart)
  const words = before.slice(Math.max(before.lastIndexOf('|'), before.lastIndexOf(';'), before.lastIndexOf('&'), before.lastIndexOf('('), before.lastIndexOf('`')) + 1).trim().split(/\s+/).filter(Boolean)
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()
  const name = words[0]
  if (!name || name.includes('/')) return null
  const cmd = await tiny.commandResolve(name).catch(() => null)
  if (!cmd?.completion) return null
  try {
    const spec = JSON.parse(new TextDecoder().decode(await tiny.readFile(cmd.completion))) as CompletionSpec
    return { spec, position: words.slice(1).filter((x) => !x.startsWith('-')).length }
  } catch {
    return null
  }
}

export async function complete(tiny: Pear, sh: Shell, line: string, cursor: number): Promise<Completion> {
  const w = wordAt(line, cursor)
  const text = w.text
  // $NAME and ${NAME
  const v = /^(.*?)\$\{?([A-Za-z_][A-Za-z0-9_]*)?$/.exec(text)
  if (v && !w.quote.startsWith("'")) {
    const braced = text.slice(v[1]!.length + 1).startsWith('{')
    const names = [...new Set([...sh.vars.keys()])].filter((n) => n.startsWith(v[2] ?? ''))
    return { start: w.start + (w.quote ? 1 : 0), candidates: names.map((n) => `${v[1]!}$${braced ? `{${n}}` : n}`) }
  }
  let found: string[]
  const described = w.command ? null : await specFor(tiny, line, w.start)
  if (described && text.startsWith('-')) {
    found = (described.spec.flags ?? []).filter((f) => f.startsWith(text))
  } else if (described?.spec.args?.length) {
    const args = described.spec.args
    const arg = args[Math.min(described.position, args.length - 1)]!
    if (arg.kind === 'enum') found = (arg.values ?? []).filter((v) => v.startsWith(text))
    else if (arg.kind === 'command') found = [...(await programs(tiny, sh, text))]
    else found = await files(tiny, sh, text, arg.kind === 'dir')
  } else if (w.command && !text.includes('/') && !text.startsWith('~')) {
    found = [
      ...[...BUILTINS, ...KEYWORDS, ...sh.functions.keys(), ...sh.aliases.keys()].filter((n) => n.startsWith(text)),
      ...(await programs(tiny, sh, text)),
    ]
  } else found = await files(tiny, sh, text, !w.command && ['cd', 'pushd', 'rmdir'].includes(line.slice(0, w.start).trim().split(/\s+/).pop() ?? ''))
  // an unquoted word is escaped; inside quotes only the quote itself matters
  const esc = (s: string) => (w.quote ? s : quote(s).replace(/^\\~/, '~'))
  return { start: w.start + (w.quote ? 1 : 0), candidates: found.map(esc) }
}
