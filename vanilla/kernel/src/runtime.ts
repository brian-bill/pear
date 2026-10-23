/// Runs inside every process Worker. Receives its identity and a MessagePort to
/// the kernel, builds the `tiny` object a program sees, then runs the program.
import type { ExitStatus, ProcessInfo, Signal, SpawnOptions } from './process'
import type { FileSystem, FsEvent, FsMethod } from './fs'
import { request, type Message, type SendOptions } from './ipc'
import type { WireError } from './errors'
import type { BundleInfo } from './bundle'
import type { ConfigScope, ConfigValue } from './config'
import type { AppRecord, IconInfo, OpenOptions, RecentItem, RunningApp } from './launch'
import type { LogEntry, LogFilter, LogInput } from './log'
import type { Grant, Status } from './perm'
import type { TypeConflict, TypeInfo } from './uti'
import type { Termios, WinSize } from './pty'

type FsApi = Omit<Pick<FileSystem, FsMethod>, 'takeEvents'>

/** What a program receives as its single argument. */
export interface Pear extends FsApi {
  readonly pid: number
  readonly name: string
  readonly args: string[]
  /** Parent pid. Not a constant: it becomes 1 if the parent exits first. */
  getppid(): Promise<number>
  getcwd(): Promise<string>
  chdir(path: string): Promise<string>
  environ(): Promise<Record<string, string>>
  getenv(name: string): Promise<string | null>
  setenv(name: string, value: string): Promise<void>
  spawn(path: string, opts?: SpawnOptions): Promise<number>
  kill(pid: number, signal?: Signal): Promise<void>
  wait(pid: number): Promise<ExitStatus>
  list(): Promise<ProcessInfo[]>
  info(pid: number): Promise<ProcessInfo>
  /** Make a port you own (you can receive on it). Returns its id. */
  portCreate(): Promise<number>
  portDestroy(port: number): Promise<void>
  /** Send to a port you hold a send right for. `EPIPE` if it is dead, `EACCES` without the right. */
  send(port: number, data: unknown, opts?: SendOptions): Promise<void>
  /** Next message on a port you own. `ETIMEDOUT` if `timeout` (ms) passes first. */
  receive(port: number, opts?: { timeout?: number }): Promise<Message>
  /** Send, then wait for the answer on a temporary reply port (`message.replyTo` on the receiving side). */
  request(port: number, data: unknown, opts?: { timeout?: number; rights?: number[]; transfer?: Transferable[] }): Promise<Message>
  /** Publish one of your ports under a name. `EEXIST` if taken. */
  register(name: string, port: number): Promise<void>
  /** Find a named port; you get a send right to it. `ENOENT` if nobody registered it. */
  lookup(name: string): Promise<number>
  /** Get `{type: 'dead-name', port}` on `notify` (a port you own) when `port` dies. `EPIPE` if it is already dead. */
  watch(port: number, notify: number): Promise<void>
  unwatch(port: number, notify: number): Promise<void>
  /** Round-trip time in ms of a ping to another process; `ETIMEDOUT` if it does not answer (it is stuck or busy). */
  ping(pid: number, timeout?: number): Promise<number>
  /** Handle a signal. Without a handler, SIGINT/SIGTERM/SIGHUP/SIGUSR* end the process. */
  onSignal(signal: Signal, handler: () => void | Promise<void>): void
  /** End the process. Never returns. */
  exit(code?: number): Promise<never>
  /**
   * A pipe: `[readFd, writeFd]`. Use `read(fd, length)` (empty result = end of input), `write(fd, data)`
   * (waits while the pipe is full; `EPIPE` if no reader is left) and `close(fd)` from the file calls.
   */
  pipe(): Promise<[number, number]>
  /** Your descriptors for the pipes you asked for with `spawn(path, { stdio: { stdout: 'pipe' } })`. */
  stdio(pid: number): Promise<{ stdin?: number; stdout?: number; stderr?: number }>
  /**
   * Terminals. `fd` is 0, 1 or 2 for a standard stream, or a descriptor from `openpty`. Settings:
   * `echo`, `icanon` (line mode), `isig` (^C ^Z make signals), `onlcr` (output \n -> \r\n), `icrnl` (input \r -> \n).
   * Typed characters: ^C SIGINT, ^Z SIGTSTP, ^D end of file, ^U kill line, ^W erase word, Backspace.
   */
  isatty(fd: number): Promise<boolean>
  tcgetattr(fd: number): Promise<Termios>
  tcsetattr(fd: number, change: Partial<Termios>): Promise<void>
  /** Turn line editing, echo and ^C handling off (`true`) or back on (`false`): what a full-screen program or shell prompt does. */
  setRawMode(raw: boolean, fd?: number): Promise<void>
  getwinsize(fd?: number): Promise<WinSize>
  setwinsize(fd: number, size: WinSize): Promise<void>
  /** A terminal pair: `master` is the emulator's side, `slave` goes to `spawn(..., { stdio: { stdout: { fd: slave } } })`. */
  openpty(): Promise<{ master: number; slave: number }>
  /** Process groups and sessions (`0` = this process). A new child shares its parent's group; give it its own to make it the foreground job. */
  getpgid(pid?: number): Promise<number>
  setpgid(pid?: number, pgid?: number): Promise<void>
  getsid(pid?: number): Promise<number>
  setsid(): Promise<number>
  /** Foreground process group of your controlling terminal: where ^C goes. */
  tcgetpgrp(fd?: number): Promise<number>
  tcsetpgrp(fd: number, pgid: number): Promise<void>
  /** Who you run as, and (for programs that belong to an installed app) which bundle. */
  getuid(): Promise<number>
  getgid(): Promise<number>
  getgroups(): Promise<number[]>
  getappid(): Promise<string | null>

  /** Settings (`contracts/configuration.md`). Reads see user over system over default; an app may write only domains under its own id. */
  configGet(domain: string, key: string, fallback?: ConfigValue): Promise<ConfigValue>
  configSet(domain: string, key: string, value: unknown, opts?: ActingFor & { scope?: ConfigScope }): Promise<null>
  configDelete(domain: string, key: string, opts?: ActingFor & { scope?: ConfigScope }): Promise<null>
  configList(domain: string): Promise<Record<string, ConfigValue>>
  configReset(domain: string, opts?: ActingFor & { scope?: ConfigScope }): Promise<null>
  /** Get `{type: 'config-changed', domain, key, scope, value, external}` on `port` (one you own) for changes to `domain` (`'*'`: all) and, if given, `key`. */
  configWatch(domain: string, key: string | null, port: number): Promise<null>
  configUnwatch(port: number): Promise<null>

  /** Capabilities (`contracts/permissions.md`). Programs outside any app hold them all. */
  permCheck(capability: string, scope?: string, opts?: ActingFor): Promise<Status>
  /** Asks the user through Desktop if undecided; with no prompt handler the answer is `denied`. */
  permRequest(capability: string, opts?: ActingFor): Promise<Status>
  permList(opts?: ActingFor): Promise<Grant[]>

  bundleList(): Promise<BundleInfo[]>
  bundleInfo(id: string): Promise<BundleInfo>

  /** Launch services. `target` is a bundle id, an absolute path, or a URL. Returns the pid that has it. */
  launchOpen(target: string, opts?: OpenOptions & ActingFor): Promise<number>
  launchOpenWith(path: string, appId: string, opts?: ActingFor): Promise<number>
  launchApps(): Promise<AppRecord[]>
  launchAppsFor(target: string): Promise<AppRecord[]>
  launchDefaultFor(typeOrScheme: string): Promise<AppRecord | null>
  launchSetDefault(typeOrScheme: string, appId: string, opts?: ActingFor): Promise<null>
  launchTypeOf(path: string, opts?: ActingFor): Promise<TypeInfo>
  launchRunning(): Promise<RunningApp[]>
  launchActivate(appId: string, opts?: ActingFor): Promise<number>
  launchRecents(appId?: string): Promise<RecentItem[]>
  launchIconFor(target: string): Promise<IconInfo>
  launchTypeConflicts(): Promise<TypeConflict[]>

  /**
   * System services only: tell the page's driver for `device` (clipboard, timers, input, display, audio) to do
   * something. It arrives as a `{type: 'driver', device, data}` kernel event. The answer comes back as a message
   * the page pushes with `kernel.driverPush`.
   */
  driverEmit(device: string, data: unknown): Promise<null>

  /** Write to the system log. Apps always log under their own id. False if dropped by the rate limit. */
  logWrite(entry: LogInput): Promise<boolean>
  /** Newest matching entries, oldest first. Apps see only their own. */
  logQuery(filter?: LogFilter): Promise<LogEntry[]>
  /** System services only: file changes since `cursor` (0 for "from now on" the first time). */
  fsChanges(cursor?: number): Promise<{ cursor: number; events: FsEvent[]; lost: boolean }>

  stdin: Stdin
  stdout: Stdout
  stderr: Stdout
}

/** System services act for the process that asked: `as` is its pid. Other callers may not use it. */
export interface ActingFor {
  as?: number
}

export interface Stdin {
  readonly isTTY: boolean
  /** Up to `max` bytes (default 64 KB), waiting for some to arrive. `null` is end of input. */
  read(max?: number): Promise<Uint8Array | null>
  readAll(): Promise<Uint8Array>
  text(): Promise<string>
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
}

export interface Stdout {
  readonly isTTY: boolean
  /**
   * Resolves when the data is accepted: await it to slow down for a slow reader. With no reader left
   * it rejects with `EPIPE`; left unhandled, that ends the process with SIGPIPE, like a shell pipeline.
   */
  write(data: string | Uint8Array): Promise<void>
}

interface Init {
  type: 'init'
  pid: number
  ppid: number
  name: string
  args: string[]
  env: Record<string, string>
  cwd: string
  source: Uint8Array
  port: MessagePort
  /** Which of stdin, stdout, stderr are terminals. */
  tty: boolean[]
}

/** Signals that do nothing unless the program handles them (no job control without a way to suspend a Worker). */
const IGNORED_BY_DEFAULT = new Set(['SIGWINCH', 'SIGTSTP'])
const decoder = new TextDecoder()
const SYSTEM_CALLS = [
  'getuid', 'getgid', 'getgroups', 'getappid', 'driverEmit', 'logWrite', 'logQuery', 'fsChanges',
  'configGet', 'configSet', 'configDelete', 'configList', 'configReset', 'configWatch', 'configUnwatch',
  'permCheck', 'permRequest', 'permList', 'bundleList', 'bundleInfo',
  'launchOpen', 'launchOpenWith', 'launchApps', 'launchAppsFor', 'launchDefaultFor', 'launchSetDefault',
  'launchTypeOf', 'launchRunning', 'launchActivate', 'launchRecents', 'launchIconFor', 'launchTypeConflicts',
] as const
const FS_CALLS = [
  'flush', 'stat', 'lstat', 'exists', 'realpath', 'readdir', 'chmod', 'chown', 'utimes', 'statfs',
  'setxattr', 'getxattr', 'listxattr', 'removexattr',
  'mkdir', 'rmdir', 'unlink', 'removeAll', 'symlink', 'readlink', 'rename', 'copy', 'truncate',
  'open', 'close', 'read', 'write', 'lseek', 'fstat', 'ftruncate',
  'readFile', 'writeFile', 'writeFileAtomic', 'trash', 'restore', 'emptyTrash', 'flock',
] as const

self.onmessage = (ev: MessageEvent<Init>) => {
  if (ev.data?.type !== 'init') return
  self.onmessage = null
  void run(ev.data)
}

async function run(init: Init): Promise<void> {
  const { port } = init
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const handlers = new Map<string, () => void | Promise<void>>()
  let exiting = false

  const exit = async (info: { code?: number | null; signal?: string | null; crashed?: boolean; error?: string }): Promise<never> => {
    // Output already written goes out first, unless a signal is ending us.
    if (!info.signal && !exiting) await Promise.allSettled([...writing])
    if (!exiting) {
      exiting = true
      port.postMessage({ type: 'exit', code: info.code ?? null, signal: info.signal ?? null, crashed: info.crashed ?? false, error: info.error })
    }
    return new Promise<never>(() => {}) // the kernel terminates this Worker
  }

  const crash = (reason: unknown) => {
    // An EPIPE nobody handled is what SIGPIPE is for: end quietly, like a process whose reader went away.
    if ((reason as { code?: string } | undefined)?.code === 'EPIPE') return void exit({ signal: 'SIGPIPE' })
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    void log('stderr', `${message}\n`)
    void exit({ code: 1, crashed: true, error: reason instanceof Error ? reason.message : message })
  }

  const callWith = (transfer: Transferable[], name: string, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        port.postMessage({ type: 'syscall', id, call: name, args }, transfer)
      } catch (e) {
        pending.delete(id) // e.g. a message that cannot be structured-cloned
        const message = e instanceof Error ? e.message : String(e)
        reject(Object.assign(new Error(message), { name: 'SysError', code: 'EINVAL' }))
      }
    })

  const call = (name: string, ...args: unknown[]) => callWith([], name, ...args)

  // Writes still on their way to the kernel (or waiting for a pipe reader). A normal exit waits for them.
  const writing = new Set<Promise<unknown>>()
  const emit = (stream: 'stdout' | 'stderr', data: string | Uint8Array): Promise<void> => {
    const p = call('stdwrite', stream === 'stdout' ? 1 : 2, data) as Promise<void>
    const done = () => void writing.delete(p)
    writing.add(p)
    p.then(done, done)
    return p.then(() => {}) // a copy, so a caller who ignores a failure still sees it as unhandled
  }
  /** console.* cannot wait, so a reader that went away ends the process the way SIGPIPE would. */
  const log = (stream: 'stdout' | 'stderr', text: string) =>
    emit(stream, text).catch((e: { code?: string }) => {
      if (e?.code === 'EPIPE') void exit({ signal: 'SIGPIPE' })
    })

  port.onmessage = (ev) => {
    const m = ev.data
    if (m.type === 'ping') return port.postMessage({ type: 'pong', id: m.id })
    if (m.type === 'signal') {
      const handler = handlers.get(m.signal)
      if (!handler) return IGNORED_BY_DEFAULT.has(m.signal) ? undefined : void exit({ signal: m.signal })
      Promise.resolve()
        .then(handler)
        .catch(crash)
      return
    }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error) {
      const e = m.error as WireError
      p.reject(Object.assign(new Error(e.message), { name: e.name, code: e.code, path: e.path }))
    } else {
      p.resolve(m.result)
    }
  }

  self.addEventListener('unhandledrejection', (ev) => {
    ev.preventDefault()
    crash(ev.reason)
  })
  self.addEventListener('error', (ev) => {
    ev.preventDefault()
    crash(ev.error ?? ev.message)
  })

  const fmt = (v: unknown) => (typeof v === 'string' ? v : v instanceof Error ? (v.stack ?? v.message) : safeJson(v))
  for (const [method, stream] of [['log', 'stdout'], ['info', 'stdout'], ['debug', 'stdout'], ['warn', 'stderr'], ['error', 'stderr']] as const) {
    console[method] = (...a: unknown[]) => void log(stream, `${a.map(fmt).join(' ')}\n`)
  }

  const stdin: Stdin = {
    isTTY: Boolean(init.tty?.[0]),
    read: async (max = 65536) => {
      const chunk = (await call('stdread', max)) as Uint8Array
      return chunk.length ? chunk : null
    },
    async readAll() {
      const parts: Uint8Array[] = []
      for (let chunk; (chunk = await stdin.read()); ) parts.push(chunk)
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let at = 0
      for (const p of parts) (out.set(p, at), (at += p.length))
      return out
    },
    text: async () => decoder.decode(await stdin.readAll()),
    async *[Symbol.asyncIterator]() {
      for (let chunk; (chunk = await stdin.read()); ) yield chunk
    },
  }

  const tiny = {
    pid: init.pid,
    getppid: () => call('getppid'),
    name: init.name,
    args: init.args,
    getcwd: () => call('getcwd'),
    chdir: (p: string) => call('chdir', p),
    environ: () => call('environ'),
    getenv: (n: string) => call('getenv', n),
    setenv: (n: string, v: string) => call('setenv', n, v),
    spawn: (p: string, o?: SpawnOptions) => call('spawn', p, o),
    kill: (pid: number, s?: Signal) => call('kill', pid, s),
    wait: (pid: number) => call('wait', pid),
    list: () => call('list'),
    info: (pid: number) => call('info', pid),
    portCreate: () => call('portCreate'),
    portDestroy: (p: number) => call('portDestroy', p),
    send: (p: number, d: unknown, o?: SendOptions) => callWith(o?.transfer ?? [], 'send', p, d, o),
    receive: (p: number, o?: { timeout?: number }) => call('receive', p, o),
    register: (n: string, p: number) => call('register', n, p),
    lookup: (n: string) => call('lookup', n),
    watch: (p: number, n: number) => call('watch', p, n),
    unwatch: (p: number, n: number) => call('unwatch', p, n),
    ping: (pid: number, t?: number) => call('ping', pid, t),
    onSignal: (s: Signal, h: () => void | Promise<void>) => void handlers.set(s, h),
    exit: (code = 0) => exit({ code }),
    pipe: () => call('pipe'),
    openpty: () => call('openpty'),
    isatty: (fd: number) => call('isatty', fd),
    tcgetattr: (fd: number) => call('tcgetattr', fd),
    tcsetattr: (fd: number, c: Partial<Termios>) => call('tcsetattr', fd, c),
    setRawMode: (raw: boolean, fd = 0) => call('tcsetattr', fd, { icanon: !raw, echo: !raw, isig: !raw }),
    getwinsize: (fd = 1) => call('getwinsize', fd),
    setwinsize: (fd: number, s: WinSize) => call('setwinsize', fd, s),
    getpgid: (pid = 0) => call('getpgid', pid),
    setpgid: (pid = 0, pgid = 0) => call('setpgid', pid, pgid),
    getsid: (pid = 0) => call('getsid', pid),
    setsid: () => call('setsid'),
    tcgetpgrp: (fd = 0) => call('tcgetpgrp', fd),
    tcsetpgrp: (fd: number, pgid: number) => call('tcsetpgrp', fd, pgid),
    stdio: (pid: number) => call('stdio', pid),
    stdin,
    stdout: { isTTY: Boolean(init.tty?.[1]), write: (d: string | Uint8Array) => emit('stdout', d) },
    stderr: { isTTY: Boolean(init.tty?.[2]), write: (d: string | Uint8Array) => emit('stderr', d) },
  } as unknown as Record<string, unknown>
  tiny.request = (p: number, d: unknown, o?: { timeout?: number; rights?: number[]; transfer?: Transferable[] }) => request(tiny as never, p, d, o)
  for (const name of [...FS_CALLS, ...SYSTEM_CALLS]) tiny[name] = (...args: unknown[]) => call(name, ...args)

  port.postMessage({ type: 'ready' })

  try {
    const url = URL.createObjectURL(new Blob([init.source as BlobPart], { type: 'text/javascript' }))
    let mod: { default?: unknown }
    try {
      mod = await import(/* @vite-ignore */ url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (typeof mod.default !== 'function') throw new Error('program must export a default function')
    const result = await (mod.default as (t: Pear) => unknown)(tiny as unknown as Pear)
    await exit({ code: typeof result === 'number' ? result : 0 })
  } catch (e) {
    crash(e)
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

