/// sh: an interactive shell on a terminal, or a script interpreter.
///   sh                 read commands from stdin (interactive if it is a terminal)
///   sh -c 'cmd' [name args...]
///   sh file [args...]
import { decoder, reason, type Pear } from './lib'
import { ExitRequest, Shell } from './shell/shell'
import { parse, ParseError } from './shell/parse'

class LineReader {
  private buf = ''
  private dec = new TextDecoder()
  private eof = false
  constructor(private tiny: Pear) {}
  async next(): Promise<string | null> {
    for (;;) {
      const i = this.buf.indexOf('\n')
      if (i >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        return line
      }
      if (this.eof) {
        const rest = this.buf
        this.buf = ''
        return rest === '' ? null : rest
      }
      const chunk = await this.tiny.stdin.read()
      if (!chunk) {
        this.eof = true
        this.buf += this.dec.decode()
      } else this.buf += this.dec.decode(chunk, { stream: true })
    }
  }
}

export default async function (tiny: Pear): Promise<number> {
  const args = [...tiny.args]
  let command: string | null = null
  let file: string | null = null
  if (args[0] === '-c') {
    if (args.length < 2) {
      await tiny.stderr.write('sh: -c: option requires an argument\n')
      return 2
    }
    command = args[1]!
    args.splice(0, 2)
  } else if (args[0] !== undefined) {
    file = args.shift()!
  }

  const interactive = command === null && file === null && tiny.stdin.isTTY
  const sh = new Shell(tiny)
  await sh.init(interactive)
  if (command !== null && args.length) sh.scriptName = args.shift()!
  if (file !== null) sh.scriptName = file
  sh.positional = args

  try {
    if (command !== null) return await sh.run(command)
    if (file !== null) {
      let text: string
      try {
        text = decoder.decode(await tiny.readFile(file))
      } catch (e) {
        await tiny.stderr.write(`sh: ${file}: ${reason(e)}\n`)
        return 127
      }
      return await sh.run(text)
    }
    if (!interactive) {
      let text = ''
      for (let chunk; (chunk = await tiny.stdin.read()); ) text += decoder.decode(chunk, { stream: true })
      return await sh.run(text)
    }
    return await interactiveLoop(tiny, sh)
  } catch (e) {
    if (e instanceof ExitRequest) return e.code
    throw e
  } finally {
    await sh.runExitTrap().catch(() => {})
    await sh.hangUpJobs()
  }
}

/**
 * `!!`, `!n`, `!-n` and `!prefix` in an interactive line, replaced by the history entry. Not inside single quotes or
 * after a backslash; a `!` before a space, `=` or `(` is left alone. Returns the line, or throws `Error` for an event that does not exist.
 */
export function expandHistory(line: string, history: string[]): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '\\') {
      out += c + (line[++i] ?? '')
      continue
    }
    if (c === "'") quoted = !quoted
    if (c !== '!' || quoted) {
      out += c
      continue
    }
    const rest = line.slice(i + 1)
    const m = /^(!|-?\d+|[A-Za-z_][^\s;&|<>()]*)/.exec(rest)
    if (!m) {
      out += c
      continue
    }
    const ref = m[1]!
    let found: string | undefined
    if (ref === '!') found = history[history.length - 1]
    else if (/^-?\d+$/.test(ref)) found = ref[0] === '-' ? history[history.length + Number(ref)] : history[Number(ref) - 1]
    else found = [...history].reverse().find((h) => h.startsWith(ref))
    if (found === undefined) throw new Error(`!${ref}: event not found`)
    out += found
    i += ref.length
  }
  return out
}

/** An interactive shell reads `/etc/profile` and `~/.shrc` if they exist. */
async function startupFiles(tiny: Pear, sh: Shell): Promise<void> {
  for (const file of ['/etc/profile', `${sh.vars.get('HOME') ?? ''}/.shrc`]) {
    if (!(await tiny.exists(file).catch(() => false))) continue
    await sh.run(`. '${file.replace(/'/g, "'\\''")}'`).catch(() => 1)
  }
  sh.status = 0
}

async function interactiveLoop(tiny: Pear, sh: Shell): Promise<number> {
  const reader = new LineReader(tiny)
  await startupFiles(tiny, sh)
  let pending = ''
  const prompt = () => (pending ? (sh.vars.get('PS2') ?? '> ') : (sh.vars.get('PS1') ?? '$ '))

  // ^C at the prompt abandons the line; while a job runs the shell is not in the foreground group and never sees it.
  tiny.onSignal('SIGINT', async () => {
    pending = ''
    await tiny.stdout.write(`\n${prompt()}`)
  })
  tiny.onSignal('SIGHUP', async () => {
    await sh.hangUpJobs()
    await tiny.exit(129)
  })

  for (;;) {
    await sh.notifyJobs()
    const ps = prompt()
    if (ps) await tiny.stdout.write(ps)
    const line = await reader.next()
    if (line === null) {
      await tiny.stdout.write('exit\n')
      return sh.status
    }
    let text = pending ? `${pending}\n${line}` : line
    if (!pending && text.includes('!')) {
      try {
        const expanded = expandHistory(text, sh.history)
        if (expanded !== text) await tiny.stdout.write(`${expanded}\n`)
        text = expanded
      } catch (e) {
        await tiny.stderr.write(`sh: ${(e as Error).message}\n`)
        sh.status = 1
        continue
      }
    }
    if (!text.trim()) {
      pending = ''
      continue
    }
    try {
      parse(text)
    } catch (e) {
      if (!(e instanceof ParseError)) throw e
      if (e.incomplete) {
        pending = text
        continue
      }
      pending = ''
      sh.status = 2
      await tiny.stderr.write(`sh: ${e.message}\n`)
      continue
    }
    pending = ''
    sh.history.push(text)
    try {
      await sh.run(text)
    } catch (e) {
      if (e instanceof ExitRequest) return e.code
      await tiny.stderr.write(`sh: ${reason(e)}\n`)
      sh.status = 1
    }
  }
}
