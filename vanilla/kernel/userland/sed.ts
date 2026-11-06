import { main, parseArgs, readAllText, reason, type Pear } from './lib'
import { posixRegex } from './shell/escapes'

type Addr = { k: 'line'; n: number } | { k: 'last' } | { k: 're'; re: RegExp | null } | { k: 'step'; first: number; step: number } | { k: 'plus'; n: number }
interface Cmd {
  a1?: Addr
  a2?: Addr
  not: boolean
  name: string
  text?: string
  re?: RegExp | null
  repl?: string
  flags?: { g: boolean; p: boolean; nth: number; w?: string }
  map?: Map<string, string>
  label?: string
  end?: number
  file?: string
  active?: boolean
  endLine?: number
}

class SedError extends Error {}

function parseScript(src: string, ere: boolean): Cmd[] {
  const cmds: Cmd[] = []
  const stack: number[] = []
  let i = 0
  let lastRe: RegExp | null = null
  const ws = () => {
    while (i < src.length && /[ \t]/.test(src[i]!)) i++
  }
  const regex = (pattern: string, ignoreCase: boolean): RegExp | null => {
    if (pattern === '') return lastRe
    try {
      lastRe = new RegExp(posixRegex(pattern, ere), ignoreCase ? 'i' : '')
    } catch {
      throw new SedError(`invalid regular expression: ${pattern}`)
    }
    return lastRe
  }
  /** Text up to the next unescaped `delim` (an escaped delimiter becomes the plain character). */
  const until = (delim: string): string => {
    let out = ''
    for (; i < src.length; i++) {
      const c = src[i]!
      if (c === '\\' && i + 1 < src.length) {
        const n = src[++i]!
        out += n === delim ? n : `\\${n}`
      } else if (c === delim) {
        i++
        return out
      } else out += c
    }
    throw new SedError('unterminated command')
  }
  const addr = (): Addr | undefined => {
    const c = src[i]
    if (c === undefined) return undefined
    if (/\d/.test(c)) {
      const m = /^(\d+)(?:~(\d+))?/.exec(src.slice(i))!
      i += m[0].length
      return m[2] !== undefined ? { k: 'step', first: Number(m[1]), step: Number(m[2]) } : { k: 'line', n: Number(m[1]) }
    }
    if (c === '$') {
      i++
      return { k: 'last' }
    }
    if (c === '/' || c === '\\') {
      const delim = c === '\\' ? src[++i]! : '/'
      i++
      const pat = until(delim)
      let ic = false
      if (src[i] === 'I') {
        ic = true
        i++
      }
      return { k: 're', re: regex(pat, ic) }
    }
    return undefined
  }
  const endOfCommand = () => {
    ws()
    if (i < src.length && src[i] !== '\n' && src[i] !== ';' && src[i] !== '}') throw new SedError(`extra characters after command: ${src.slice(i, i + 10)}`)
  }
  const label = (): string => {
    ws()
    const start = i
    while (i < src.length && src[i] !== '\n' && src[i] !== ';') i++
    return src.slice(start, i).trim()
  }
  const textArg = (): string => {
    ws()
    if (src[i] === '\\') {
      i++
      if (src[i] === '\n') i++
    }
    let out = ''
    for (; i < src.length; i++) {
      if (src[i] === '\\' && i + 1 < src.length) {
        out += src[++i] === 'n' ? '\n' : src[i]
      } else if (src[i] === '\n') break
      else out += src[i]
    }
    return out
  }

  while (i < src.length) {
    while (i < src.length && /[\s;]/.test(src[i]!)) i++
    if (i >= src.length) break
    if (src[i] === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    const cmd: Cmd = { not: false, name: '' }
    cmd.a1 = addr()
    if (cmd.a1) {
      ws()
      if (src[i] === ',') {
        i++
        ws()
        if (src[i] === '+') {
          i++
          const m = /^\d+/.exec(src.slice(i))!
          i += m[0].length
          cmd.a2 = { k: 'plus', n: Number(m[0]) }
        } else cmd.a2 = addr()
        if (!cmd.a2) throw new SedError('unexpected `,\'')
      }
    }
    ws()
    while (src[i] === '!') {
      cmd.not = true
      i++
      ws()
    }
    const name = src[i++]
    if (name === undefined) throw new SedError('missing command')
    cmd.name = name
    switch (name) {
      case '{':
        stack.push(cmds.length)
        break
      case '}': {
        const open = stack.pop()
        if (open === undefined) throw new SedError('unexpected `}\'')
        cmds[open]!.end = cmds.length
        endOfCommand()
        break
      }
      case 's': {
        const delim = src[i++]!
        const pat = until(delim)
        let repl = ''
        for (; i < src.length; i++) {
          const c = src[i]!
          if (c === '\\' && i + 1 < src.length) {
            const n = src[++i]!
            repl += n === delim ? n : `\\${n}`
          } else if (c === delim) break
          else repl += c
        }
        if (src[i] !== delim) throw new SedError('unterminated `s\' command')
        i++
        const flags = { g: false, p: false, nth: 0, w: undefined as string | undefined }
        let ic = false
        for (; i < src.length && !/[;\n}]/.test(src[i]!); i++) {
          const f = src[i]!
          if (f === 'g') flags.g = true
          else if (f === 'p') flags.p = true
          else if (f === 'i' || f === 'I') ic = true
          else if (/\d/.test(f)) {
            const m = /^\d+/.exec(src.slice(i))!
            flags.nth = Number(m[0])
            i += m[0].length - 1
          } else if (f === 'w') {
            flags.w = src.slice(i + 1).trim()
            i = src.length
          } else if (f !== ' ') throw new SedError(`unknown option to \`s': ${f}`)
        }
        cmd.re = regex(pat, ic)
        cmd.repl = repl
        cmd.flags = flags
        break
      }
      case 'y': {
        const delim = src[i++]!
        const from = [...until(delim).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')]
        const to = [...until(delim).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')]
        if (from.length !== to.length) throw new SedError('strings for `y\' command are different lengths')
        cmd.map = new Map(from.map((c, k) => [c, to[k]!]))
        endOfCommand()
        break
      }
      case 'a':
      case 'i':
      case 'c':
        cmd.text = textArg()
        break
      case 'b':
      case 't':
      case 'T':
      case ':':
        cmd.label = label()
        break
      case 'r':
      case 'w':
      case 'R':
        ws()
        cmd.file = src.slice(i).split('\n')[0]!.trim()
        i += src.slice(i).split('\n')[0]!.length
        break
      case 'q':
      case 'Q':
      case 'l':
        while (/[ \t\d]/.test(src[i] ?? '')) i++
        break
      case 'p': case 'P': case 'd': case 'D': case 'n': case 'N': case 'h': case 'H': case 'g': case 'G': case 'x': case '=': case 'z':
        endOfCommand()
        break
      default:
        throw new SedError(`unknown command: \`${name}'`)
    }
    cmds.push(cmd)
  }
  if (stack.length) throw new SedError('unmatched `{\'')
  return cmds
}

function expandReplacement(repl: string, m: RegExpExecArray): string {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i]!
    if (c === '&') out += m[0]
    else if (c === '\\' && i + 1 < repl.length) {
      const n = repl[++i]!
      if (/\d/.test(n)) out += m[Number(n)] ?? ''
      else if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'U' || n === 'L' || n === 'E' || n === 'u' || n === 'l') out += `\u0000${n}`
      else out += n
    } else out += c
  }
  // \U \L \u \l \E (GNU case conversion)
  if (!out.includes('\u0000')) return out
  let res = ''
  let mode: 'U' | 'L' | null = null
  let once: 'u' | 'l' | null = null
  for (let k = 0; k < out.length; k++) {
    const ch = out[k]!
    if (ch === '\u0000') {
      const f = out[++k]!
      if (f === 'U' || f === 'L') mode = f
      else if (f === 'E') mode = null
      else once = f as 'u' | 'l'
      continue
    }
    let t = mode === 'U' ? ch.toUpperCase() : mode === 'L' ? ch.toLowerCase() : ch
    if (once) {
      t = once === 'u' ? ch.toUpperCase() : ch.toLowerCase()
      once = null
    }
    res += t
  }
  return res
}

async function execute(tiny: Pear, cmds: Cmd[], lines: string[], opts: { quiet: boolean; out: (s: string) => void; fileName: string }): Promise<number> {
  const labels = new Map<string, number>()
  cmds.forEach((c, k) => c.name === ':' && labels.set(c.label!, k))
  const writers = new Map<string, string>()
  let hold = ''
  let status = 0
  let n = 0 // index of the line in the pattern space
  const test = (a: Addr, ps: string): boolean => {
    switch (a.k) {
      case 'line': return n + 1 === a.n
      case 'last': return n === lines.length - 1
      case 're': return a.re ? new RegExp(a.re.source, a.re.flags).test(ps) : false
      case 'step': return a.step === 0 ? n + 1 === a.first : n + 1 >= a.first && (n + 1 - a.first) % a.step === 0
      default: return false
    }
  }
  const matches = (c: Cmd, ps: string): boolean => {
    let hit: boolean
    if (!c.a1) hit = true
    else if (!c.a2) hit = test(c.a1, ps)
    else if (c.active) {
      hit = true
      const a2 = c.a2
      if (a2.k === 'line' ? n + 1 >= a2.n : a2.k === 'plus' ? n + 1 >= c.endLine! : test(a2, ps)) c.active = false
      if (a2.k === 'line' && n + 1 > a2.n) c.active = false
    } else if (test(c.a1, ps)) {
      hit = true
      const a2 = c.a2
      if (a2.k === 'line' ? a2.n > n + 1 : a2.k === 'plus' ? a2.n > 0 : !(a2.k === 'last' && n === lines.length - 1)) {
        c.active = true
        if (a2.k === 'plus') c.endLine = n + 1 + a2.n
      }
    } else hit = false
    return hit !== c.not
  }

  let quit = false
  while (n < lines.length && !quit) {
    let ps = lines[n]!
    const appended: string[] = []
    let pc = 0
    let substituted = false
    let autoprint = !opts.quiet
    cycle: while (pc < cmds.length) {
      const c = cmds[pc]!
      if (c.name === '}' || c.name === ':') {
        pc++
        continue
      }
      if (!matches(c, ps)) {
        pc = c.name === '{' ? c.end! + 1 : pc + 1
        continue
      }
      switch (c.name) {
        case '{': break
        case 's': {
          if (!c.re) throw new SedError('no previous regular expression')
          const re = new RegExp(c.re.source, c.re.flags + 'g')
          let count = 0
          let out = ''
          let last = 0
          let did = false
          let prevEnd = -1
          for (let m: RegExpExecArray | null; (m = re.exec(ps)); ) {
            if (m[0] === '') re.lastIndex++
            // an empty match right after the previous match does not count (abc, s/b*/X/g -> XaXcX)
            if (m[0] === '' && m.index === prevEnd) continue
            prevEnd = m.index + m[0].length
            count++
            if (c.flags!.nth && count < c.flags!.nth) continue
            out += ps.slice(last, m.index) + expandReplacement(c.repl!, m)
            last = m.index + m[0].length
            did = true
            if (!c.flags!.g) break
          }
          if (did) {
            ps = out + ps.slice(last)
            substituted = true
            if (c.flags!.p) opts.out(ps + '\n')
            if (c.flags!.w) writers.set(c.flags!.w, (writers.get(c.flags!.w) ?? '') + ps + '\n')
          }
          break
        }
        case 'y': ps = [...ps].map((ch) => c.map!.get(ch) ?? ch).join(''); break
        case 'p': opts.out(ps + '\n'); break
        case 'P': opts.out(ps.split('\n')[0] + '\n'); break
        case 'd': autoprint = false; break cycle
        case 'D': {
          const nl = ps.indexOf('\n')
          if (nl < 0) {
            autoprint = false
            break cycle
          }
          ps = ps.slice(nl + 1)
          autoprint = false
          lines[n] = ps
          n--
          break cycle
        }
        case 'n':
          if (n + 1 >= lines.length) {
            quit = true
            break cycle
          }
          if (autoprint) opts.out(ps + '\n')
          ps = lines[++n]!
          break
        case 'N':
          if (n + 1 >= lines.length) {
            quit = true
            break cycle
          }
          ps += '\n' + lines[++n]!
          break
        case 'q': quit = true; break cycle
        case 'Q': quit = true; autoprint = false; break cycle
        case 'h': hold = ps; break
        case 'H': hold += '\n' + ps; break
        case 'g': ps = hold; break
        case 'G': ps += '\n' + hold; break
        case 'x': [ps, hold] = [hold, ps]; break
        case 'z': ps = ''; break
        case '=': opts.out(`${n + 1}\n`); break
        case 'l': opts.out(ps.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n') + '$\n'); break
        case 'a': appended.push(c.text! + '\n'); break
        case 'i': opts.out(c.text! + '\n'); break
        case 'c':
          if (!c.a2 || !c.active) opts.out(c.text! + '\n')
          autoprint = false
          break cycle
        case 'r': appended.push(await readAllText(tiny, c.file!).catch(() => '')); break
        case 'w': writers.set(c.file!, (writers.get(c.file!) ?? '') + ps + '\n'); break
        case 'b':
        case 't':
        case 'T': {
          const take = c.name === 'b' || (c.name === 't' ? substituted : !substituted)
          if (c.name !== 'b') substituted = c.name === 't' ? false : substituted
          if (take) {
            if (!c.label) pc = cmds.length
            else {
              const to = labels.get(c.label)
              if (to === undefined) throw new SedError(`can't find label for jump to \`${c.label}'`)
              pc = to
            }
            continue cycle
          }
          break
        }
      }
      pc++
    }
    if (autoprint) opts.out(ps + '\n')
    for (const a of appended) opts.out(a)
    n++
  }
  for (const [file, text] of writers) {
    if (file === '/dev/stdout') opts.out(text)
    else await tiny.writeFile(file, new TextEncoder().encode(text))
  }
  return status
}

export default function (tiny: Pear): Promise<number> {
  return main('sed', tiny, async () => {
    // -i may carry a suffix (-i.bak); the other flags are plain
    const args = tiny.args.map((a) => (/^-i./.test(a) ? `--in-place=${a.slice(2)}` : a === '-i' ? '--in-place=' : a))
    const { flags, rest } = parseArgs(args, ['e', 'f', 'i'], { 'in-place': 'i', expression: 'e', file: 'f', quiet: 'n', silent: 'n', regexp: 'E', 'regexp-extended': 'E' })
    const scripts: string[] = []
    // collect every -e / -f in order
    for (let k = 0; k < args.length; k++) {
      if (args[k] === '-e') scripts.push(args[++k] ?? '')
      else if (args[k]!.startsWith('--expression=')) scripts.push(args[k]!.slice(13))
      else if (args[k] === '-f') scripts.push(await readAllText(tiny, args[++k] ?? ''))
    }
    const files = [...rest]
    if (!scripts.length) {
      const s = files.shift()
      if (s === undefined) {
        await tiny.stderr.write('usage: sed [-nEi] [-e script] [-f file] [script] [file ...]\n')
        return 1
      }
      scripts.push(s)
    }
    let program: Cmd[]
    try {
      program = parseScript(scripts.join('\n'), Boolean(flags.E || flags.r))
    } catch (e) {
      if (!(e instanceof SedError)) throw e
      await tiny.stderr.write(`sed: ${e.message}\n`)
      return 1
    }
    const quiet = Boolean(flags.n)
    const split = (text: string): string[] => {
      const l = text.split('\n')
      if (l[l.length - 1] === '') l.pop()
      return l
    }
    let status = 0
    try {
      if (flags.i !== undefined && flags.i !== true) {
        for (const f of files) {
          try {
            const text = await readAllText(tiny, f)
            let out = ''
            await execute(tiny, parseScript(scripts.join('\n'), Boolean(flags.E || flags.r)), split(text), { quiet, out: (s) => void (out += s), fileName: f })
            if (typeof flags.i === 'string' && flags.i) await tiny.writeFile(f + flags.i, new TextEncoder().encode(text))
            await tiny.writeFile(f, new TextEncoder().encode(out))
          } catch (e) {
            await tiny.stderr.write(`sed: ${f}: ${reason(e)}\n`)
            status = 1
          }
        }
        return status
      }
      const all: string[] = []
      for (const f of files.length ? files : ['-']) {
        try {
          all.push(...split(await readAllText(tiny, f)))
        } catch (e) {
          await tiny.stderr.write(`sed: ${f}: ${reason(e)}\n`)
          status = 1
        }
      }
      let buffer = ''
      await execute(tiny, program, all, { quiet, out: (s) => void (buffer += s), fileName: '-' })
      if (buffer) await tiny.stdout.write(buffer)
    } catch (e) {
      if (!(e instanceof SedError)) throw e
      await tiny.stderr.write(`sed: ${e.message}\n`)
      return 1
    }
    return status
  })
}
