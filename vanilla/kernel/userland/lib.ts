// Each program is bundled into one file, because a program in the VFS cannot import anything.
import type { Pear } from '../src/runtime'

export type { Pear }

export const O = { RDONLY: 0, WRONLY: 1, CREAT: 0x40, TRUNC: 0x200, APPEND: 0x400 } as const

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

/** "no such file or directory" style text for an error from a syscall. */
export const reason = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e)
  // The file system engine says "ENOENT: no such file or directory (/path)": keep the human part.
  return /^[A-Z]{3,}: (.*?)(?: \(.*\))?$/s.exec(text)?.[1] ?? text
}

/** Signal names and the numbers a shell reports as `128 + n`. */
export const SIGNUM: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGPIPE: 13, SIGTERM: 15, SIGTSTP: 20, SIGWINCH: 28,
}

export interface Parsed {
  /** Flags seen, e.g. `{ l: true, n: '5' }` for `-ln 5`. */
  flags: Record<string, string | true>
  /** Everything that is not a flag, in order. */
  rest: string[]
}

/**
 * Small getopt: `-abc` is flags a, b, c; flags listed in `withValue` take the next argument (or the rest of
 * the cluster, as in `-n5`); `--` ends flags; a lone `-` is an operand. Long flags (`--name`, `--name=value`) are accepted if listed.
 */
export function parseArgs(args: string[], withValue: string[] = [], long: Record<string, string> = {}): Parsed {
  const flags: Record<string, string | true> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') {
      rest.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--') && a.length > 2) {
      const [name, value] = a.slice(2).split(/=(.*)/s)
      const short = long[name!]
      if (!short) throw new Error(`unrecognized option '--${name}'`)
      flags[short] = value ?? (withValue.includes(short) ? (args[++i] ?? '') : true)
    } else if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        const f = a[k]!
        if (withValue.includes(f)) {
          flags[f] = a.slice(k + 1) || (args[++i] ?? '')
          break
        }
        flags[f] = true
      }
    } else rest.push(a)
  }
  return { flags, rest }
}

export async function main(name: string, tiny: Pear, body: () => Promise<number | void>): Promise<number> {
  try {
    return (await body()) ?? 0
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === 'EPIPE') throw e // the reader went away: let the runtime end us quietly
    await tiny.stderr.write(`${name}: ${reason(e)}\n`)
    return 1
  }
}

/**
 * Runs `each` on every operand, reporting a failure as `name: operand: reason` and carrying on.
 * Returns `failStatus` if any failed, else 0.
 */
export async function eachOperand<T>(tiny: Pear, name: string, items: T[], each: (item: T, index: number) => Promise<void>, failStatus = 1): Promise<number> {
  let status = 0
  for (const [i, item] of items.entries()) {
    try {
      await each(item, i)
    } catch (e) {
      if ((e as { code?: string }).code === 'EPIPE') throw e
      await tiny.stderr.write(`${name}: ${item}: ${reason(e)}\n`)
      status = failStatus
    }
  }
  return status
}

/** `cp` and `mv`: pair every source with its destination (inside `target` if that is a directory) and run `op`. */
export async function transfer(tiny: Pear, name: string, operands: string[], op: (src: string, dest: string) => Promise<void>): Promise<number> {
  const sources = [...operands]
  const target = sources.pop()!
  const intoDir = await tiny.stat(target).then((s) => s.kind === 'dir', () => false)
  if (sources.length > 1 && !intoDir) {
    await tiny.stderr.write(`${name}: target '${target}' is not a directory\n`)
    return 1
  }
  return eachOperand(tiny, name, sources, (src) => op(src, intoDir ? `${target.replace(/\/$/, '')}/${src.replace(/\/$/, '').split('/').pop()}` : target))
}

/** `head` and `tail`: the `-n` count (also written `-5`) and the files, or `null` after reporting a bad count. */
export async function lineCountArgs(tiny: Pear, name: string): Promise<{ count: number; files: string[] } | null> {
  const { flags, rest } = parseArgs(tiny.args.map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a)), ['n'])
  const count = flags.n === undefined ? 10 : Number(flags.n)
  if (!Number.isInteger(count) || count < 0) {
    await tiny.stderr.write(`${name}: invalid number of lines: ${flags.n}\n`)
    return null
  }
  return { count, files: rest.length ? rest : ['-'] }
}

/** Like `eachOperand` over files, with a `==> name <==` heading before each when there are several. */
export function eachInput(tiny: Pear, name: string, files: string[], each: (path: string) => Promise<void>): Promise<number> {
  return eachOperand(tiny, name, files, async (path, k) => {
    if (files.length > 1) await tiny.stdout.write(`${k ? '\n' : ''}==> ${path === '-' ? 'standard input' : path} <==\n`)
    await each(path)
  })
}

async function readFileChunks(tiny: Pear, path: string, each: (chunk: Uint8Array) => Promise<boolean | void>): Promise<void> {
  const fd = await tiny.open(path, O.RDONLY)
  try {
    for (;;) {
      const chunk = await tiny.read(fd, 64 * 1024)
      if (!chunk.length) return
      if ((await each(chunk)) === false) return
    }
  } finally {
    await tiny.close(fd)
  }
}

/** Chunks of a file, or of stdin for `-`. */
export async function readInput(tiny: Pear, path: string, each: (chunk: Uint8Array) => Promise<boolean | void>): Promise<void> {
  if (path === '-') {
    for (let chunk; (chunk = await tiny.stdin.read()); ) if ((await each(chunk)) === false) return
    return
  }
  await readFileChunks(tiny, path, each)
}

/** Splits a stream of chunks into lines (without the newline); the last line may lack one. */
export class LineSplitter {
  private tail = ''
  private dec = new TextDecoder()
  push(chunk: Uint8Array): string[] {
    const text = this.tail + this.dec.decode(chunk, { stream: true })
    const lines = text.split('\n')
    this.tail = lines.pop()!
    return lines
  }
  /** What is left at end of input (no trailing newline), if anything. */
  end(): string | null {
    const rest = this.tail + this.dec.decode()
    this.tail = ''
    return rest === '' ? null : rest
  }
}

export const joinPath = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

/** Parses `-9`, `-KILL`, `-s TERM`, `-SIGTERM` style signal names. */
export function signalName(spec: string): string | null {
  if (/^\d+$/.test(spec)) {
    const entry = Object.entries(SIGNUM).find(([, n]) => n === Number(spec))
    return entry ? entry[0] : null
  }
  const name = spec.toUpperCase().startsWith('SIG') ? spec.toUpperCase() : `SIG${spec.toUpperCase()}`
  return name in SIGNUM ? name : null
}
