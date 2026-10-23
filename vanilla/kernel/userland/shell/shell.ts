/// The shell: runs parsed command lines. Variables, redirections, pipelines, && and ||, background jobs
/// with job control on a terminal, and the builtins.
import type { Pear } from '../lib'
import { O, SIGNUM, decoder, encoder, parseArgs, reason, signalName } from '../lib'
import { evalArith } from './arith'
import { expandPattern, expandString, expandWord, segmentToRegex, type ExpandContext } from './expand'
import { parse, ParseError, type AndOr, type Compound, type Item, type Pipeline, type Redir, type Simple } from './parse'

/** Where one of a command's streams goes. Two streams with the same object share one destination (`2>&1`). */
type Target =
  | { k: 'inherit'; std: 0 | 1 | 2 } // one of the shell's own streams
  | { k: 'null' }
  | { k: 'fd'; fd: number }
  | { k: 'file'; path: string; append: boolean }
type Targets = [Target, Target, Target]

interface Job {
  id: number
  pgid: number
  pids: number[]
  src: string
  done: boolean
  status: number
  finished: Promise<number>
  notified: boolean
  /** Resolves once something was started (or the job ended without starting anything). */
  started: Promise<void>
  markStarted: () => void
}

class ExitRequest {
  constructor(readonly code: number) {}
}
/** Thrown by `break` and `continue`; `depth` counts the loops still to leave. */
class LoopControl {
  constructor(
    readonly kind: 'break' | 'continue',
    readonly depth: number,
  ) {}
}
/** Thrown by `return`. */
class ReturnRequest {
  constructor(readonly code: number) {}
}
/** A command died of ^C: the rest of the list is abandoned. */
class Interrupt {}

/** A stream the `read` builtin pulls lines from: what is buffered and, for a file, the descriptor. */
interface Input {
  buf: string
  eof: boolean
  fd: number | null
  dec: TextDecoder
}

const BUILTINS = new Set([
  'cd', 'pwd', 'echo', 'export', 'unset', 'exit', 'jobs', 'fg', 'bg', 'wait', 'history', 'true', 'false', ':', 'source', '.', 'kill', 'type',
  'break', 'continue', 'return', 'shift', 'read', 'test', '[', 'set', 'trap', 'alias', 'unalias', 'local', 'eval',
])
const TRAP_SIGNALS = ['HUP', 'INT', 'TERM', 'USR1', 'USR2']

export class Shell {
  vars = new Map<string, string>()
  exported = new Set<string>()
  positional: string[] = []
  scriptName = 'sh'
  status = 0
  lastBackground = 0
  history: string[] = []
  jobs: Job[] = []
  functions = new Map<string, Simple>()
  aliases = new Map<string, string>()
  /** `trap` commands by signal name without the `SIG` (`EXIT` too). */
  traps = new Map<string, string>()
  options = { errexit: false, nounset: false, xtrace: false }
  private nextJob = 1
  private noErrexit = 0
  private errexitExempt = false
  private loopDepth = 0
  private callDepth = 0
  private sourceDepth = 0
  private runDepth = 0
  private sigint = false
  /** Variables a function declared `local`, with the value to put back when it returns. */
  private locals: Array<Map<string, string | undefined>> = []
  private inputs = new WeakMap<object, Input>()
  private trapped = new Set<string>()
  private tempCount = 0
  /** Only a shell reading from a terminal does job control. */
  interactive = false
  private shellPgid = 0

  constructor(readonly tiny: Pear) {}

  async init(interactive: boolean): Promise<void> {
    const env = await this.tiny.environ()
    for (const [k, v] of Object.entries(env)) {
      this.vars.set(k, v)
      this.exported.add(k)
    }
    this.interactive = interactive
    if (!this.vars.has('PWD')) this.setVar('PWD', await this.tiny.getcwd(), true)
    if (interactive) this.shellPgid = await this.tiny.getpgid()
  }

  // ------------------------------------------------------------ variables

  setVar(name: string, value: string, exportIt = false): void {
    this.vars.set(name, value)
    if (exportIt) this.exported.add(name)
  }

  get(name: string): string | undefined {
    switch (name) {
      case '?':
        return String(this.status)
      case '$':
        return String(this.tiny.pid)
      case '!':
        return this.lastBackground ? String(this.lastBackground) : ''
      case '#':
        return String(this.positional.length)
      case '0':
        return this.scriptName
    }
    if (/^[1-9]$/.test(name)) return this.positional[Number(name) - 1]
    return this.vars.get(name)
  }

  private env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of this.exported) {
      const v = this.vars.get(name)
      if (v !== undefined) env[name] = v
    }
    return { ...env, ...extra }
  }

  private ctx: ExpandContext = {
    get: (n) => this.get(n),
    positional: () => [...this.positional],
    runCapture: (src) => this.capture(src),
    home: () => this.vars.get('HOME') ?? '/',
    cwd: () => this.vars.get('PWD') ?? '/',
    readdir: (p) => this.tiny.readdir(p),
    exists: (p) => this.tiny.exists(p),
    isDir: (p) => this.tiny.stat(p).then((s) => s.kind === 'dir', () => false),
    arith: (src) => evalArith(src, { get: (n) => this.get(n), set: (n, v) => this.setVar(n, v, this.exported.has(n)) }),
    nounset: () => this.options.nounset,
  }

  /** `$(...)`: run it with stdout into a pipe we read while it runs. */
  private async capture(src: string): Promise<string> {
    const [r, w] = await this.tiny.pipe()
    const reader = this.readAll(r)
    const base = this.baseTargets()
    base[1] = { k: 'fd', fd: w }
    let status = 0
    try {
      status = await this.subshell(parse(src), base)
    } catch (e) {
      if (e instanceof ParseError) await this.err(`sh: ${e.message}\n`)
      else throw e
      status = 2
    } finally {
      await this.tiny.close(w)
    }
    const text = await reader
    await this.tiny.close(r)
    this.status = status
    return text.replace(/\n+$/, '')
  }

  private async readAll(fd: number): Promise<string> {
    const dec = new TextDecoder()
    let text = ''
    for (;;) {
      const chunk = await this.tiny.read(fd, 65536)
      if (!chunk.length) return text + dec.decode()
      text += dec.decode(chunk, { stream: true })
    }
  }

  private baseTargets(): Targets {
    return [{ k: 'inherit', std: 0 }, { k: 'inherit', std: 1 }, { k: 'inherit', std: 2 }]
  }

  private err = (s: string) => this.tiny.stderr.write(s)

  // ------------------------------------------------------------- running

  /** Parses and runs source text; returns the exit status. Syntax errors are reported and give 2. */
  async run(src: string): Promise<number> {
    let items: Item[]
    try {
      items = parse(src, { aliases: this.aliases })
    } catch (e) {
      if (!(e instanceof ParseError)) throw e
      await this.err(`sh: ${e.message}\n`)
      return (this.status = 2)
    }
    this.runDepth++
    try {
      return await this.runList(items, this.baseTargets(), null)
    } catch (e) {
      // Only the outermost run turns these into a status; `eval` and `source` pass them on.
      if (e instanceof ExitRequest || e instanceof ReturnRequest || e instanceof LoopControl || this.runDepth > 1) throw e
      if (e instanceof Interrupt) {
        this.sigint = false
        return (this.status = 130)
      }
      await this.err(`sh: ${(e as { code?: string }).code ? reason(e) : (e as Error).message}\n`)
      return (this.status = 1)
    } finally {
      this.runDepth--
    }
  }

  async runList(items: Item[], base: Targets, job: Job | null): Promise<number> {
    let status = this.status
    for (const item of items) {
      if (this.sigint) throw new Interrupt()
      if (item.background) {
        await this.startBackground(item, base)
        status = this.status = 0
      } else {
        status = this.status = await this.runAndOr(item.andor, base, job)
        if (this.sigint) throw new Interrupt()
        if (this.options.errexit && status !== 0 && !this.noErrexit && !this.errexitExempt) throw new ExitRequest(status)
      }
    }
    return status
  }

  /** Runs `fn` with `set -e` suspended (conditions, and every command of a `&&`/`||` list but the last). */
  private async quietly<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
    if (!on) return fn()
    this.noErrexit++
    try {
      return await fn()
    } finally {
      this.noErrexit--
    }
  }

  private async runAndOr(a: AndOr, base: Targets, job: Job | null): Promise<number> {
    let status = await this.quietly(a.rest.length > 0 || a.first.negate, () => this.runPipeline(a.first, base, job))
    this.status = status
    // `set -e` ignores a failure of anything but the last command of a list, and of `!`.
    let exempt = a.rest.length > 0 || a.first.negate
    for (const [i, { op, pipe }] of a.rest.entries()) {
      if ((op === '&&') === (status === 0)) {
        status = await this.quietly(i < a.rest.length - 1 || pipe.negate, () => this.runPipeline(pipe, base, job))
        this.status = status
        exempt = i < a.rest.length - 1 || pipe.negate
      }
    }
    this.errexitExempt = exempt
    return status
  }

  /** Runs `items` as `( … )` does: what they change in the shell (variables, directory, functions, traps) is undone afterwards. */
  private async subshell(items: Item[], targets: Targets): Promise<number> {
    const saved = {
      vars: new Map(this.vars),
      exported: new Set(this.exported),
      positional: [...this.positional],
      functions: new Map(this.functions),
      aliases: new Map(this.aliases),
      traps: new Map(this.traps),
      options: { ...this.options },
    }
    try {
      return await this.runList(items, targets, null)
    } catch (e) {
      if (e instanceof ExitRequest || e instanceof ReturnRequest) return e.code
      if (e instanceof LoopControl) return 0
      throw e
    } finally {
      const cwd = saved.vars.get('PWD')
      Object.assign(this, saved)
      if (cwd !== undefined && (await this.tiny.getcwd()) !== cwd) await this.tiny.chdir(cwd).catch(() => {})
    }
  }

  private async startBackground(item: Item, base: Targets): Promise<void> {
    let markStarted!: () => void
    const job: Job = {
      id: this.nextJob++,
      pgid: 0,
      pids: [],
      src: item.src,
      done: false,
      status: 0,
      notified: false,
      finished: undefined as unknown as Promise<number>,
      started: new Promise<void>((r) => (markStarted = r)),
      markStarted: () => markStarted(),
    }
    // Background jobs do not read the terminal.
    const targets: Targets = [{ k: 'null' }, base[1], base[2]]
    job.finished = this.runAndOr(item.andor, targets, job).then(
      (s) => s,
      async (e) => {
        await this.err(`sh: ${reason(e)}\n`)
        return 1
      },
    )
    job.finished.then((s) => {
      job.done = true
      job.status = s
      job.markStarted()
    })
    this.jobs.push(job)
    await job.started
    if (this.interactive) await this.tiny.stdout.write(`[${job.id}] ${job.pgid || job.pids[0] || ''}\n`)
    this.lastBackground = job.pids[job.pids.length - 1] ?? 0
  }

  // ------------------------------------------------------------ pipelines

  private async runPipeline(p: Pipeline, base: Targets, job: Job | null): Promise<number> {
    const stages = p.cmds.length
    const pending: Array<Promise<number>> = []
    const pids: number[] = []
    let carry: number | null = null // read end of the pipe into the next stage
    let status = 0

    try {
      for (let i = 0; i < stages; i++) {
        const cmd = p.cmds[i]!
        const targets: Targets = [base[0], base[1], base[2]]
        const closeAfter: number[] = []
        if (carry !== null) {
          targets[0] = { k: 'fd', fd: carry }
          closeAfter.push(carry)
          carry = null
        }
        if (i < stages - 1) {
          const [r, w] = await this.tiny.pipe()
          targets[1] = { k: 'fd', fd: w }
          closeAfter.push(w)
          carry = r
        }

        const started = await this.startCommand(cmd, targets, job, pids)
        // The shell's copies of pipe ends must go once the stage that needs them has them, or EOF never arrives.
        const release = () => Promise.all(closeAfter.map((fd) => this.tiny.close(fd).catch(() => {})))
        if ('pid' in started) {
          pids.push(started.pid)
          pending.push(this.waitFor(started.pid, job !== null))
          await release()
        } else {
          pending.push(started.done.finally(release))
        }
      }
    } catch (e) {
      if (carry !== null) await this.tiny.close(carry).catch(() => {})
      throw e
    }

    if (job) {
      job.pids.push(...pids)
      if (!job.pgid && pids[0]) job.pgid = pids[0]
      job.markStarted()
    }
    const foreground = !job && this.interactive && pids.length > 0
    if (foreground) await this.giveTerminal(pids[0]!)
    const results = await Promise.all(pending)
    if (foreground) await this.giveTerminal(this.shellPgid)
    status = results[results.length - 1] ?? 0
    return p.negate ? (status === 0 ? 1 : 0) : status
  }

  private async giveTerminal(pgid: number): Promise<void> {
    await this.tiny.tcsetpgrp(0, pgid).catch(() => {})
  }

  private async waitFor(pid: number, background = false): Promise<number> {
    const st = await this.tiny.wait(pid)
    if (st.signal) {
      if (st.signal === 'SIGINT' && !background) this.sigint = true
      if (st.signal === 'SIGINT' && this.interactive) await this.tiny.stdout.write('\n')
      return 128 + (SIGNUM[st.signal] ?? 0)
    }
    return st.code ?? 1
  }

  // ------------------------------------------------------------- commands

  /** Starts one command. Returns a pid for an external program, or a promise of the status for a builtin. */
  private async startCommand(cmd: Simple, targets: Targets, job: Job | null, pipePids: number[]): Promise<{ pid: number } | { done: Promise<number> }> {
    if (cmd.compound) {
      const opened: Array<() => Promise<void>> = []
      const cleanup = () => Promise.all(opened.map((f) => f().catch(() => {})))
      try {
        await this.applyRedirects(cmd.redirs, targets, opened)
      } catch (e) {
        await this.err(`sh: ${reason(e)}\n`)
        await cleanup()
        return { done: Promise.resolve(1) }
      }
      return { done: this.runCompound(cmd.compound, targets, job).finally(cleanup) }
    }
    const words: string[] = []
    for (const w of cmd.words) words.push(...(await expandWord(w, this.ctx)))
    const assigns: Array<[string, string]> = []
    for (const a of cmd.assigns) assigns.push([a.name, await expandString(a.value, this.ctx)])

    const opened: Array<() => Promise<void>> = []
    const cleanup = () => Promise.all(opened.map((f) => f().catch(() => {})))
    try {
      await this.applyRedirects(cmd.redirs, targets, opened)
    } catch (e) {
      await this.err(`sh: ${reason(e)}\n`)
      await cleanup()
      return { done: Promise.resolve(1) }
    }

    if (!words.length) {
      for (const [k, v] of assigns) this.setVar(k, v, this.exported.has(k))
      await cleanup()
      return { done: Promise.resolve(0) }
    }

    const name = words[0]!
    if (this.options.xtrace) await this.err(`+ ${words.join(' ')}\n`)
    const fn = this.functions.get(name)
    if (fn) return { done: this.callFunction(fn, words.slice(1), targets, job).finally(cleanup) }
    if (BUILTINS.has(name)) {
      // Assignments before a builtin are not kept, like most shells' special cases; they do not apply at all here.
      const run = this.runBuiltin(name, words.slice(1), targets).finally(cleanup)
      return { done: run } // runs alongside the other stages of a pipeline
    }

    const resolved = await this.findProgram(name)
    if (!resolved) {
      await this.err(`sh: ${name}: command not found\n`)
      await cleanup()
      return { done: Promise.resolve(127) }
    }
    try {
      const stdio = this.stdioFor(targets)
      const pid = await this.tiny.spawn(resolved, {
        args: words.slice(1),
        name,
        env: this.env(Object.fromEntries(assigns)),
        stdio,
      })
      if (this.interactive && !job) {
        const group = pipePids[0] ?? pid
        await this.tiny.setpgid(pid, group).catch(() => {})
      } else if (this.interactive && job) {
        await this.tiny.setpgid(pid, job.pgid || job.pids[0] || pipePids[0] || pid).catch(() => {})
        if (!job.pgid && !job.pids.length && !pipePids.length) job.pgid = pid
      }
      await cleanup()
      return { pid }
    } catch (e) {
      await cleanup()
      await this.err(`sh: ${name}: ${reason(e)}\n`)
      return { done: Promise.resolve(126) }
    }
  }

  private async findProgram(name: string): Promise<string | null> {
    const isFile = async (p: string) => {
      try {
        return (await this.tiny.stat(p)).kind === 'file'
      } catch {
        return false
      }
    }
    if (name.includes('/')) return (await isFile(name)) ? name : null
    for (const dir of (this.vars.get('PATH') ?? '').split(':')) {
      if (!dir) continue
      const candidate = `${dir.replace(/\/$/, '')}/${name}`
      if (await isFile(candidate)) return candidate
    }
    return null
  }

  private stdioFor(t: Targets): NonNullable<NonNullable<Parameters<Pear['spawn']>[1]>['stdio']> {
    const spec = (target: Target, i: number): 'inherit' | 'null' | { fd: number } | { file: string; append: boolean } => {
      switch (target.k) {
        case 'inherit':
          return target.std === i ? 'inherit' : { fd: target.std }
        case 'null':
          return 'null'
        case 'fd':
          return { fd: target.fd }
        case 'file':
          return { file: target.path, append: target.append }
      }
    }
    return {
      stdin: spec(t[0], 0),
      stdout: spec(t[1], 1),
      stderr: t[2] === t[1] ? 'stdout' : spec(t[2], 2),
    }
  }

  private async applyRedirects(redirs: Redir[], targets: Targets, opened: Array<() => Promise<void>>): Promise<void> {
    for (const r of redirs) {
      const where = await expandString(r.target, this.ctx)
      if (r.op === '<<') {
        // The body goes to a file the command reads; it is removed when the command has its own descriptor.
        const path = `/tmp/.sh-here-${this.tiny.pid}-${this.tempCount++}`
        await this.tiny.writeFile(path, encoder.encode(where))
        opened.push(() => this.tiny.unlink(path))
        targets[r.fd as 0 | 1 | 2] = { k: 'file', path, append: false }
        continue
      }
      if (r.op === '>&' || r.op === '<&') {
        if (where === '-') targets[r.fd as 0 | 1 | 2] = { k: 'null' }
        else if (/^[0-2]$/.test(where)) targets[r.fd as 0 | 1 | 2] = targets[Number(where) as 0 | 1 | 2]
        else throw new Error(`bad file descriptor: ${where}`)
        continue
      }
      const path = where.startsWith('/') ? where : `${this.vars.get('PWD') ?? '/'}/${where}`.replace(/\/+/g, '/')
      if (r.op === '<') {
        await this.tiny.stat(path).catch((e: unknown) => {
          throw new Error(`${where}: ${reason(e)}`)
        })
        targets[0] = { k: 'file', path, append: false }
      } else {
        // Create it now (and truncate), so a failure is reported before the command runs.
        try {
          const fd = await this.tiny.open(path, O.WRONLY | O.CREAT | (r.op === '>>' ? O.APPEND : O.TRUNC))
          opened.push(() => this.tiny.close(fd))
        } catch (e) {
          throw new Error(`${where}: ${reason(e)}`)
        }
        targets[r.fd as 0 | 1 | 2] = { k: 'file', path, append: true } // already truncated: the command appends
      }
    }
  }

  // ----------------------------------------------------- compound commands

  private async runCompound(c: Compound, targets: Targets, job: Job | null): Promise<number> {
    switch (c.k) {
      case 'group':
        return this.runList(c.body, targets, job)
      case 'subshell':
        return this.subshell(c.body, targets)
      case 'func':
        this.functions.set(c.name, c.body)
        return 0
      case 'if':
        for (const b of c.branches) {
          if ((await this.quietly(true, () => this.runList(b.cond, targets, job))) === 0) return this.runList(b.body, targets, job)
        }
        return c.else ? this.runList(c.else, targets, job) : (this.status = 0)
      case 'while': {
        let status = 0
        this.loopDepth++
        try {
          for (;;) {
            const next = await this.iteration(async () => {
              const cond = await this.quietly(true, () => this.runList(c.cond, targets, job))
              if ((cond === 0) === c.until) return false
              status = await this.runList(c.body, targets, job)
              return true
            })
            if (!next) break
          }
        } finally {
          this.loopDepth--
        }
        return status
      }
      case 'for': {
        const items: string[] = []
        if (c.words) for (const w of c.words) items.push(...(await expandWord(w, this.ctx)))
        else items.push(...this.positional)
        let status = 0
        this.loopDepth++
        try {
          for (const item of items) {
            this.setVar(c.name, item, this.exported.has(c.name))
            const next = await this.iteration(async () => {
              status = await this.runList(c.body, targets, job)
              return true
            })
            if (!next) break
          }
        } finally {
          this.loopDepth--
        }
        return status
      }
      case 'case': {
        const subject = await expandString(c.word, this.ctx)
        for (const clause of c.clauses) {
          for (const pattern of clause.patterns) {
            if (segmentToRegex(await expandPattern(pattern, this.ctx), true).test(subject)) return this.runList(clause.body, targets, job)
          }
        }
        return (this.status = 0)
      }
    }
  }

  /** One pass of a loop: false when `break` ended it. A `break 2` or `continue 2` goes on to the loop around this one. */
  private async iteration(body: () => Promise<boolean>): Promise<boolean> {
    try {
      return await body()
    } catch (e) {
      if (!(e instanceof LoopControl)) throw e
      if (e.depth > 1) throw new LoopControl(e.kind, e.depth - 1)
      return e.kind === 'continue'
    }
  }

  private async callFunction(fn: Simple, args: string[], targets: Targets, job: Job | null): Promise<number> {
    if (this.callDepth >= 100) {
      await this.err('sh: function nesting too deep\n')
      return 1
    }
    const savedArgs = this.positional
    const savedLoops = this.loopDepth
    const frame = new Map<string, string | undefined>()
    this.positional = args
    this.loopDepth = 0
    this.callDepth++
    this.locals.push(frame)
    try {
      const started = await this.startCommand(fn, targets, job, [])
      return 'pid' in started ? await this.waitFor(started.pid) : await started.done
    } catch (e) {
      if (e instanceof ReturnRequest) return e.code
      throw e
    } finally {
      this.locals.pop()
      for (const [name, old] of frame) {
        if (old === undefined) this.vars.delete(name)
        else this.vars.set(name, old)
      }
      this.callDepth--
      this.loopDepth = savedLoops
      this.positional = savedArgs
    }
  }

  /** The next line from a command's standard input (for `read`), or null at the end. `nl` is false for a last line without a newline. */
  private async readLine(t: Target): Promise<{ line: string; nl: boolean } | null> {
    let st = this.inputs.get(t)
    if (!st) this.inputs.set(t, (st = { buf: '', eof: false, fd: null, dec: new TextDecoder() }))
    for (;;) {
      const i = st.buf.indexOf('\n')
      if (i >= 0) {
        const line = st.buf.slice(0, i)
        st.buf = st.buf.slice(i + 1)
        return { line, nl: true }
      }
      if (st.eof) {
        const rest = st.buf
        st.buf = ''
        return rest === '' ? null : { line: rest, nl: false }
      }
      let chunk: Uint8Array | null = null
      if (t.k === 'inherit' && t.std === 0) chunk = await this.tiny.stdin.read()
      else if (t.k === 'fd') chunk = (await this.tiny.read(t.fd, 65536)) as Uint8Array
      else if (t.k === 'file') {
        st.fd ??= await this.tiny.open(t.path, O.RDONLY)
        chunk = await this.tiny.read(st.fd, 65536)
        if (!chunk.length && st.fd !== null) await this.tiny.close(st.fd)
      }
      if (!chunk?.length) {
        st.eof = true
        st.buf += st.dec.decode()
      } else st.buf += st.dec.decode(chunk, { stream: true })
    }
  }

  // ------------------------------------------------------------- builtins

  private async runBuiltin(name: string, args: string[], t: Targets): Promise<number> {
    const files = new Map<Target, number>()
    const write = async (i: 1 | 2, s: string) => {
      const target = t[i]
      switch (target.k) {
        case 'inherit':
          return void (await (target.std === 2 ? this.tiny.stderr : this.tiny.stdout).write(s))
        case 'null':
          return
        case 'fd':
          return void (await this.tiny.write(target.fd, encoder.encode(s)))
        case 'file': {
          let fd = files.get(target)
          if (fd === undefined) {
            fd = await this.tiny.open(target.path, O.WRONLY | O.CREAT | O.APPEND)
            files.set(target, fd)
          }
          await this.tiny.write(fd, encoder.encode(s))
        }
      }
    }
    const io: Io = { out: (s) => write(1, s), err: (s) => write(2, s), read: () => this.readLine(t[0]) }
    try {
      return await this.builtin(name, args, io)
    } catch (e) {
      if (e instanceof ExitRequest || e instanceof LoopControl || e instanceof ReturnRequest || e instanceof Interrupt) throw e
      if ((e as { code?: string })?.code === 'EPIPE') return 141
      await io.err(`${name}: ${reason(e)}\n`).catch(() => {})
      return 1
    } finally {
      for (const fd of files.values()) await this.tiny.close(fd).catch(() => {})
    }
  }

  private async builtin(name: string, args: string[], io: Io): Promise<number> {
    const tiny = this.tiny
    switch (name) {
      case ':':
      case 'true':
        return 0
      case 'false':
        return 1
      case 'echo': {
        let newline = true
        let rest = args
        while (rest[0] === '-n') {
          newline = false
          rest = rest.slice(1)
        }
        await io.out(rest.join(' ') + (newline ? '\n' : ''))
        return 0
      }
      case 'pwd':
        await io.out(`${this.vars.get('PWD') ?? (await tiny.getcwd())}\n`)
        return 0
      case 'cd': {
        const old = this.vars.get('PWD') ?? '/'
        let target = args[0] ?? this.vars.get('HOME') ?? '/'
        if (target === '-') {
          target = this.vars.get('OLDPWD') ?? old
          await io.out(`${target}\n`)
        }
        const abs = target.startsWith('/') ? target : `${old}/${target}`
        const real = await tiny.chdir(abs).catch((e: unknown) => {
          throw new Error(`${target}: ${reason(e)}`)
        })
        this.setVar('OLDPWD', old, true)
        this.setVar('PWD', real, true)
        return 0
      }
      case 'export': {
        if (!args.length) {
          for (const n of [...this.exported].sort()) await io.out(`export ${n}='${this.vars.get(n) ?? ''}'\n`)
          return 0
        }
        for (const a of args) {
          const eq = a.indexOf('=')
          const n = eq < 0 ? a : a.slice(0, eq)
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
            await io.err(`export: '${a}': not a valid identifier\n`)
            return 1
          }
          if (eq >= 0) this.setVar(n, a.slice(eq + 1), true)
          else this.exported.add(n)
        }
        return 0
      }
      case 'unset': {
        const fns = args[0] === '-f'
        for (const a of args.filter((x) => x !== '-f' && x !== '-v')) {
          if (fns) this.functions.delete(a)
          else {
            this.vars.delete(a)
            this.exported.delete(a)
          }
        }
        return 0
      }
      case 'exit': {
        const n = args[0] === undefined ? this.status : Number(args[0])
        if (!Number.isInteger(n)) {
          await io.err(`exit: ${args[0]}: numeric argument required\n`)
          throw new ExitRequest(2)
        }
        throw new ExitRequest(n & 255)
      }
      case 'history':
        for (const [i, line] of this.history.entries()) await io.out(`${String(i + 1).padStart(5)}  ${line}\n`)
        return 0
      case 'jobs':
        for (const j of this.jobs) {
          const state = j.done ? (j.status === 0 ? 'Done' : `Exit ${j.status}`) : 'Running'
          await io.out(`[${j.id}]${j === this.jobs[this.jobs.length - 1] ? '+' : ' '}  ${state.padEnd(10)} ${j.src}${j.done ? '' : ' &'}\n`)
          if (j.done) j.notified = true
        }
        this.jobs = this.jobs.filter((j) => !j.done)
        return 0
      case 'fg':
      case 'bg': {
        const job = this.pickJob(args[0])
        if (!job) {
          await io.err(`${name}: ${args[0] ?? 'current'}: no such job\n`)
          return 1
        }
        if (name === 'bg') {
          await io.err('bg: job is already running in the background\n')
          return 0
        }
        await io.out(`${job.src}\n`)
        if (this.interactive && job.pgid) await this.giveTerminal(job.pgid)
        const status = await job.finished
        if (this.interactive) await this.giveTerminal(this.shellPgid)
        this.jobs = this.jobs.filter((j) => j !== job)
        return status
      }
      case 'wait': {
        if (!args.length) {
          let last = 0
          for (const j of [...this.jobs]) last = await j.finished
          this.jobs = this.jobs.filter((j) => !j.done)
          return last
        }
        let status = 0
        for (const a of args) {
          const job = a.startsWith('%') ? this.pickJob(a) : this.jobs.find((j) => j.pids.includes(Number(a)))
          if (!job) {
            await io.err(`wait: ${a}: no such job\n`)
            status = 127
          } else status = await job.finished
        }
        return status
      }
      case 'kill': {
        const { flags, rest } = parseArgs(args.map((a) => (/^-[A-Za-z0-9]+$/.test(a) && !/^-[lsn]$/.test(a) ? `-s${a.slice(1)}` : a)), ['s'])
        const sig = flags.s === undefined ? 'SIGTERM' : signalName(String(flags.s))
        if (!sig) {
          await io.err(`kill: ${flags.s}: invalid signal\n`)
          return 1
        }
        let status = 0
        for (const target of rest) {
          try {
            if (target.startsWith('%')) {
              const job = this.pickJob(target)
              if (!job) throw new Error('no such job')
              await tiny.kill(-job.pgid, sig as never)
            } else {
              await tiny.kill(Number(target), sig as never)
            }
          } catch (e) {
            await io.err(`kill: ${target}: ${reason(e)}\n`)
            status = 1
          }
        }
        return status
      }
      case 'type': {
        let status = 0
        for (const a of args) {
          if (this.aliases.has(a)) await io.out(`${a} is aliased to '${this.aliases.get(a)}'\n`)
          else if (this.functions.has(a)) await io.out(`${a} is a function\n`)
          else if (BUILTINS.has(a)) await io.out(`${a} is a shell builtin\n`)
          else {
            const p = await this.findProgram(a)
            if (p) await io.out(`${a} is ${p}\n`)
            else {
              await io.err(`type: ${a}: not found\n`)
              status = 1
            }
          }
        }
        return status
      }
      case 'source':
      case '.': {
        if (!args[0]) {
          await io.err('source: filename argument required\n')
          return 2
        }
        const path = args[0].startsWith('/') ? args[0] : `${this.vars.get('PWD') ?? '/'}/${args[0]}`
        const text = decoder.decode(await tiny.readFile(path).catch((e: unknown) => {
          throw new Error(`${args[0]}: ${reason(e)}`)
        }))
        const saved = this.positional
        if (args.length > 1) this.positional = args.slice(1)
        this.sourceDepth++
        try {
          return await this.run(text)
        } catch (e) {
          if (e instanceof ReturnRequest) return e.code
          throw e
        } finally {
          this.sourceDepth--
          this.positional = saved
        }
      }
      case 'eval':
        return args.length ? this.run(args.join(' ')) : 0
      case 'break':
      case 'continue': {
        const n = args[0] === undefined ? 1 : Number(args[0])
        if (!Number.isInteger(n) || n < 1) {
          await io.err(`${name}: ${args[0]}: loop count out of range\n`)
          return 1
        }
        if (!this.loopDepth) {
          await io.err(`${name}: only meaningful in a 'for', 'while', or 'until' loop\n`)
          return 0
        }
        throw new LoopControl(name, Math.min(n, this.loopDepth))
      }
      case 'return': {
        const n = args[0] === undefined ? this.status : Number(args[0])
        if (!Number.isInteger(n)) {
          await io.err(`return: ${args[0]}: numeric argument required\n`)
          return 2
        }
        if (!this.callDepth && !this.sourceDepth) {
          await io.err('return: can only `return\' from a function or sourced script\n')
          return 1
        }
        throw new ReturnRequest(n & 255)
      }
      case 'shift': {
        const n = args[0] === undefined ? 1 : Number(args[0])
        if (!Number.isInteger(n) || n < 0 || n > this.positional.length) {
          await io.err(`shift: ${args[0] ?? 1}: shift count out of range\n`)
          return 1
        }
        this.positional = this.positional.slice(n)
        return 0
      }
      case 'local': {
        const frame = this.locals[this.locals.length - 1]
        if (!frame) {
          await io.err('local: can only be used in a function\n')
          return 1
        }
        for (const a of args) {
          const eq = a.indexOf('=')
          const n = eq < 0 ? a : a.slice(0, eq)
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
            await io.err(`local: '${a}': not a valid identifier\n`)
            return 1
          }
          if (!frame.has(n)) frame.set(n, this.vars.get(n))
          if (eq >= 0) this.vars.set(n, a.slice(eq + 1))
          else this.vars.delete(n)
        }
        return 0
      }
      case 'read': {
        const { flags, rest } = parseArgs(args, ['p'])
        const names = rest.length ? rest : ['REPLY']
        for (const n of names) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
            await io.err(`read: '${n}': not a valid identifier\n`)
            return 1
          }
        }
        if (typeof flags.p === 'string') await io.err(flags.p)
        const got = await io.read()
        const assign = (n: string, v: string) => this.setVar(n, v, this.exported.has(n))
        if (!got) {
          for (const n of names) assign(n, '')
          return 1
        }
        let rem = flags.r ? got.line : got.line.replace(/\\(.)/g, '$1')
        if (!rest.length) assign('REPLY', rem)
        else {
          rem = rem.replace(/^[ \t]+/, '')
          names.forEach((n, i) => {
            if (i === names.length - 1) return assign(n, rem.replace(/[ \t]+$/, ''))
            const m = /^(\S+)[ \t]*/.exec(rem)
            assign(n, m?.[1] ?? '')
            rem = rem.slice(m?.[0].length ?? 0)
          })
        }
        return got.nl ? 0 : 1
      }
      case 'test':
      case '[': {
        let operands = args
        if (name === '[') {
          if (args[args.length - 1] !== ']') {
            await io.err("[: missing ']'\n")
            return 2
          }
          operands = args.slice(0, -1)
        }
        try {
          return (await this.test(operands)) ? 0 : 1
        } catch (e) {
          await io.err(`${name}: ${(e as Error).message}\n`)
          return 2
        }
      }
      case 'set': {
        if (!args.length) {
          for (const [k, v] of [...this.vars].sort(([a], [b]) => (a < b ? -1 : 1))) await io.out(`${k}='${v}'\n`)
          return 0
        }
        const flagFor: Record<string, keyof Shell['options']> = { e: 'errexit', u: 'nounset', x: 'xtrace' }
        const named: Record<string, keyof Shell['options']> = { errexit: 'errexit', nounset: 'nounset', xtrace: 'xtrace' }
        let i = 0
        for (; i < args.length; i++) {
          const a = args[i]!
          if (a === '--') {
            this.positional = args.slice(i + 1)
            return 0
          }
          if ((a === '-o' || a === '+o') && args[i + 1] !== undefined) {
            const opt = named[args[++i]!]
            if (!opt) {
              await io.err(`set: ${args[i]}: invalid option name\n`)
              return 2
            }
            this.options[opt] = a === '-o'
          } else if (/^[-+][A-Za-z]+$/.test(a)) {
            for (const ch of a.slice(1)) {
              const opt = flagFor[ch]
              if (!opt) {
                await io.err(`set: ${a[0]}${ch}: invalid option\n`)
                return 2
              }
              this.options[opt] = a[0] === '-'
            }
          } else break
        }
        if (i < args.length) this.positional = args.slice(i)
        return 0
      }
      case 'alias': {
        if (!args.length) {
          for (const [k, v] of [...this.aliases].sort(([a], [b]) => (a < b ? -1 : 1))) await io.out(`alias ${k}='${v}'\n`)
          return 0
        }
        let status = 0
        for (const a of args) {
          const eq = a.indexOf('=')
          if (eq > 0) this.aliases.set(a.slice(0, eq), a.slice(eq + 1))
          else if (this.aliases.has(a)) await io.out(`alias ${a}='${this.aliases.get(a)}'\n`)
          else {
            await io.err(`alias: ${a}: not found\n`)
            status = 1
          }
        }
        return status
      }
      case 'unalias': {
        if (args[0] === '-a') {
          this.aliases.clear()
          return 0
        }
        let status = 0
        for (const a of args) {
          if (!this.aliases.delete(a)) {
            await io.err(`unalias: ${a}: not found\n`)
            status = 1
          }
        }
        return status
      }
      case 'trap': {
        const spec = (s: string) => s.toUpperCase().replace(/^SIG/, '').replace(/^0$/, 'EXIT')
        if (!args.length || args[0] === '-p') {
          for (const [sig, cmd] of this.traps) await io.out(`trap -- '${cmd}' ${sig === 'EXIT' ? sig : `SIG${sig}`}\n`)
          return 0
        }
        const [action, ...sigs] = args.length === 1 ? ['-', args[0]!] : args
        let status = 0
        for (const s of sigs.map(spec)) {
          if (s !== 'EXIT' && !TRAP_SIGNALS.includes(s)) {
            await io.err(`trap: ${s}: invalid signal specification\n`)
            status = 1
          } else if (action === '-') this.traps.delete(s)
          else {
            this.traps.set(s, action!)
            if (s !== 'EXIT' && !this.trapped.has(s)) {
              this.trapped.add(s)
              // The handler looks the trap up when the signal arrives, so `trap - INT` later restores the default.
              tiny.onSignal(`SIG${s}` as never, async () => {
                const cmd = this.traps.get(s)
                if (cmd === undefined) await tiny.exit(128 + (SIGNUM[`SIG${s}`] ?? 0))
                else if (cmd !== '') {
                  try {
                    await this.run(cmd)
                  } catch (e) {
                    if (!(e instanceof ExitRequest)) return
                    await this.runExitTrap()
                    await this.hangUpJobs()
                    await tiny.exit(e.code)
                  }
                }
              })
            }
          }
        }
        return status
      }
    }
    return 127
  }

  /** `test` / `[`: file, string and integer tests combined with `!`, `-a`, `-o` and parentheses. */
  private async test(args: string[]): Promise<boolean> {
    let at = 0
    const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
    const int = (s: string) => {
      if (!/^\s*-?\d+\s*$/.test(s)) throw new Error(`${s}: integer expression expected`)
      return Number(s)
    }
    const compare = (a: string, op: string, b: string): boolean => {
      switch (op) {
        case '=': case '==': return a === b
        case '!=': return a !== b
        case '<': return a < b
        case '>': return a > b
        case '-eq': return int(a) === int(b)
        case '-ne': return int(a) !== int(b)
        case '-lt': return int(a) < int(b)
        case '-le': return int(a) <= int(b)
        case '-gt': return int(a) > int(b)
        default: return int(a) >= int(b)
      }
    }
    const unary = async (op: string, v: string): Promise<boolean | null> => {
      const path = v.startsWith('/') ? v : `${this.vars.get('PWD') ?? '/'}/${v}`
      const stat = (follow: boolean) => (follow ? this.tiny.stat(path) : this.tiny.lstat(path)).catch(() => null)
      switch (op) {
        case '-z': return v === ''
        case '-n': return v !== ''
        case '-e': return (await stat(true)) !== null
        case '-f': return (await stat(true))?.kind === 'file'
        case '-d': return (await stat(true))?.kind === 'dir'
        case '-L': case '-h': return (await stat(false))?.kind === 'symlink'
        case '-s': return ((await stat(true))?.size ?? 0) > 0
        case '-r': return (((await stat(true))?.mode ?? 0) & 0o444) !== 0
        case '-w': return (((await stat(true))?.mode ?? 0) & 0o222) !== 0
        case '-x': return (((await stat(true))?.mode ?? 0) & 0o111) !== 0
      }
      return null
    }
    const primary = async (): Promise<boolean> => {
      const a = args[at]
      if (a === undefined) throw new Error('argument expected')
      if (a === '(') {
        at++
        const v = await or()
        if (args[at++] !== ')') throw new Error("')' expected")
        return v
      }
      if (a === '!' && args.length - at > 1) {
        at++
        return !(await primary())
      }
      const op = args[at + 1]
      if (op !== undefined && BINARY.has(op) && args[at + 2] !== undefined) {
        at += 3
        return compare(a, op, args[at - 1]!)
      }
      if (op !== undefined && /^-[a-zA-Z]$/.test(a)) {
        const r = await unary(a, op)
        if (r !== null) {
          at += 2
          return r
        }
      }
      at++
      return a !== ''
    }
    const and = async (): Promise<boolean> => {
      let v = await primary()
      while (args[at] === '-a') {
        at++
        const r = await primary()
        v = v && r
      }
      return v
    }
    const or = async (): Promise<boolean> => {
      let v = await and()
      while (args[at] === '-o') {
        at++
        const r = await and()
        v = v || r
      }
      return v
    }
    if (!args.length) return false
    const result = await or()
    if (at < args.length) throw new Error('too many arguments')
    return result
  }

  async runExitTrap(): Promise<void> {
    const cmd = this.traps.get('EXIT')
    if (cmd === undefined) return
    this.traps.delete('EXIT')
    await this.run(cmd).catch(() => 1)
  }

  private pickJob(spec?: string): Job | undefined {
    if (!spec) return this.jobs[this.jobs.length - 1]
    const id = Number(spec.replace(/^%/, ''))
    return this.jobs.find((j) => j.id === id)
  }

  /** Prints "[1]+ Done ..." for background jobs that finished since the last prompt. */
  async notifyJobs(): Promise<void> {
    for (const j of this.jobs) {
      if (j.done && !j.notified) {
        j.notified = true
        const state = j.status === 0 ? 'Done' : `Exit ${j.status}`
        await this.tiny.stdout.write(`[${j.id}]+  ${state.padEnd(10)} ${j.src}\n`)
      }
    }
    this.jobs = this.jobs.filter((j) => !(j.done && j.notified))
  }

  async hangUpJobs(): Promise<void> {
    for (const j of this.jobs) if (!j.done && j.pgid) await this.tiny.kill(-j.pgid, 'SIGHUP').catch(() => {})
  }
}

export { ExitRequest }

interface Io {
  out(s: string): Promise<void>
  err(s: string): Promise<void>
  read(): Promise<{ line: string; nl: boolean } | null>
}
