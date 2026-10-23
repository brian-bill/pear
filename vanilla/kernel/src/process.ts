import { SysError, toWireError } from './errors'
import type { Logger, LogFilter, LogInput } from './log'
import { FS_METHODS, O, type FileSystem, type FsMethod } from './fs'
import type { HostHandle, ProcessHost } from './hosting'
import {
  captureEndpoint, dup, nullEndpoint, openFileEndpoint, pipeEndpoints, ptyEndpoints, readFrom, release, writeTo, type Endpoint,
} from './pipe'
import { Pty, type Termios, type WinSize } from './pty'
import { PortTable, transfersOf, type SendOptions } from './ipc'
import type { BundleEvent, BundleKind, BundleManager } from './bundle'
import type { Config, ConfigChange, ConfigScope } from './config'
import type { LaunchEvent, LaunchServices } from './launch'
import type { PermissionEvent, Permissions, Subject } from './perm'
import type { SystemEvent } from './system'
import type { UserDb } from './users'
import { ROOT_CREDS, type Credentials } from './users'

const SIGNAL_NAMES = ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGUSR1', 'SIGUSR2', 'SIGPIPE', 'SIGWINCH', 'SIGTSTP'] as const
export type Signal = (typeof SIGNAL_NAMES)[number]
const SIGNALS = new Set<string>(SIGNAL_NAMES)

export interface ExitStatus {
  pid: number
  /** Exit code, or null if the process was ended by a signal. */
  code: number | null
  signal: Signal | null
  /** True if the program threw or rejected without handling it. */
  crashed: boolean
  error?: string
  /** Last output the process wrote (until pipes and terminals exist). */
  stdout?: string
  stderr?: string
}

export interface ProcessInfo {
  pid: number
  ppid: number
  name: string
  path: string
  args: string[]
  /** `zombie`: exited, but its parent has not waited for it yet. */
  state: 'running' | 'zombie'
  startedAt: number
  exitedAt: number | null
  cwd: string
  /** Process group and session. Children inherit both unless they ask for a new session. */
  pgid: number
  sid: number
  openFds: number
  /** True while the process has not answered a heartbeat in time (stuck in a loop, say). */
  unresponsive: boolean
  status: ExitStatus | null
  uid: number
  gid: number
  /** Bundle the program belongs to (`null` for programs started directly), and its role. */
  bundleId: string | null
  kind: BundleKind | null
  /** Set when the process is confined to the permissions of this app. */
  appId: string | null
}

/**
 * Where one of a child's standard streams goes.
 * - `'capture'` (default for stdout/stderr): kept, last 64 KB, in the `wait` result.
 * - `'null'` (default for stdin): reads give EOF, writes are dropped.
 * - `'inherit'`: share the parent's stream (a parent started from outside has none: stdin is null, output is captured).
 * - `'pipe'`: a new pipe; the parent gets the other end as an fd, see `stdio(pid)`.
 * - `{ file, append? }`: a file in the VFS (stdout/stderr are created and truncated unless `append`).
 * - `{ fd }`: the pipe end the parent holds as `fd` (read end for stdin, write end for stdout/stderr).
 *   `fd` 0, 1 or 2 means the parent's own standard stream of that number, whatever it is (a shell uses
 *   this to hand its terminal to a job).
 * - `'stdout'` (stderr only) or `'stderr'` (stdout only): the same destination as the child's other stream,
 *   sharing one descriptor (`2>&1`).
 */
export type StdioSpec =
  | 'inherit'
  | 'pipe'
  | 'null'
  | 'capture'
  | 'stdout'
  | 'stderr'
  | { file: string; append?: boolean }
  | { fd: number }

export interface StdioOptions {
  stdin?: StdioSpec
  stdout?: StdioSpec
  stderr?: StdioSpec
}

export interface SpawnOptions {
  stdio?: StdioOptions
  /**
   * Start in a new session and process group (the child is both leader). If a standard stream is the
   * slave of a terminal without a session yet, the child becomes its controlling process: ^C goes to its group.
   */
  setsid?: boolean
  args?: string[]
  env?: Record<string, string>
  /** Defaults to the parent's working directory. */
  cwd?: string
  /** Defaults to the program's file name. */
  name?: string
  /** Run as this user (name or uid). Only init and root may; children otherwise keep their parent's user. */
  user?: string | number
  /**
   * Run as part of an installed bundle (set by launch services). An `app` or `tool` is confined to what its manifest
   * and the user's grants allow; a `service` from the system's own bundles is trusted, runs as root, and is not confined.
   * Only init and root may set it.
   */
  bundle?: { id: string; kind: BundleKind; trusted?: boolean }
}

export type KernelEvent =
  | { type: 'process'; event: 'spawned'; pid: number; ppid: number; name: string }
  | { type: 'process'; event: 'exited'; pid: number; status: ExitStatus }
  | { type: 'process'; event: 'stateChanged'; pid: number; unresponsive: boolean }
  | BundleEvent
  | LaunchEvent
  | PermissionEvent
  | { type: 'config'; event: 'changed'; change: ConfigChange }
  | { type: 'config'; event: 'warning'; message: string }
  /** A system service asks the page to do something with the hardware (`tiny.driverEmit`). */
  | { type: 'driver'; device: string; data: unknown }
  | { type: 'volume'; event: 'mounted' | 'unmounted'; point: string }
  | { type: 'image'; event: 'progress'; op: 'create' | 'restore'; entries: number; bytes: number }
  | { type: 'image'; event: 'restored'; mode: 'replace' | 'merge'; restartRequired: boolean }
  /** A log entry, once `logSubscribe(true)` was called. */
  | { type: 'log'; entry: import('./log').LogEntry }
  | { type: 'crash'; event: 'reported' | 'submitted'; report: import('./log').CrashReport }
  | SystemEvent

/** How often live processes are pinged, and how long an answer may take before they count as unresponsive. */
export interface HeartbeatOptions {
  interval: number
  timeout: number
}

/** The kernel itself acts as pid 1: the parent of processes started from outside. */
export const INIT_PID = 1
const MAX_PROCESSES = 64
const MAX_ZOMBIES = 128
const OUTPUT_CAP = 64 * 1024
/** Pipe descriptors one process (or init) may hold. */
const MAX_PIPE_FDS = 256
const PIPE_FD_BASE = 1 << 20 // far above file handles, so the two kinds of number never collide
const STREAMS = ['stdin', 'stdout', 'stderr'] as const

/** Syscalls a process may make on the file system. `takeEvents` drains a global queue, so it stays kernel-only. */
const PROCESS_FS = new Set<string>(FS_METHODS.filter((m) => m !== 'takeEvents'))
const FD_FIRST_ARG = new Set<string>(['close', 'read', 'write', 'lseek', 'fstat', 'ftruncate', 'flock'])
/** Which arguments of each call are paths (resolved against the caller's working directory). */
const PATH_ARGS: Partial<Record<FsMethod, number[]>> = {
  rename: [0, 1],
  copy: [0, 1],
  symlink: [1], // arg 0 is the link target, stored as written
  trash: [0, 1],
}

interface Proc {
  pid: number
  ppid: number
  name: string
  path: string
  args: string[]
  env: Record<string, string>
  cwd: string
  host: HostHandle
  port: MessagePort
  fds: Set<number>
  /** Standard streams 0, 1, 2. */
  stdio: Endpoint[]
  /** Pipe descriptors made by `pipe()` or handed back by `stdio(pid)`. */
  pipes: Map<number, Endpoint>
  /** Who started it (not changed when it is orphaned), and the parent's fds for the pipes it asked for. */
  spawner: number
  pgid: number
  sid: number
  /** Terminal this process is the session leader of. */
  ctty: Pty | null
  stdioFds: Partial<Record<(typeof STREAMS)[number], number>>
  startedAt: number
  exitedAt: number | null
  status: ExitStatus | null
  /** Set when the parent exited first: nobody will wait, so reap on exit. */
  orphaned: boolean
  waiters: Array<(s: ExitStatus) => void>
  /** The runtime has started and can answer pings. */
  ready: boolean
  unresponsive: boolean
  monitoring: boolean
  nextPing: number
  pings: Map<number, { resolve: (ms: number) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; sent: number }>
  stdout: string
  stderr: string
  uid: number
  gid: number
  groups: number[]
  bundleId: string | null
  kind: BundleKind | null
  appId: string | null
  /** Files this process opened, by canonical path: revoking a permission closes the ones it no longer covers. */
  fdPaths: Map<number, { path: string; write: boolean }>
}

/** What the kernel has beyond files and processes. Set by `Kernel.boot`. */
export interface SystemContext {
  perms: Permissions
  users: UserDb
  config: Config
  bundles: BundleManager
  launch: LaunchServices
}

const append = (buf: string, data: string) => (buf + data).slice(-OUTPUT_CAP)
/** Root outside any app sandbox. */
const isSystem = (p: { uid: number; appId: string | null }) => p.uid === 0 && !p.appId
const killed = { code: null, signal: 'SIGKILL', crashed: false } as const

export class ProcessTable {
  private procs = new Map<number, Proc>()
  private nextPid = INIT_PID + 1
  /** Message ports. Init (pid 1) uses them too, through the kernel's own methods. */
  readonly ports = new PortTable()
  /** Pipe descriptors held by init (the outside world), numbered like a process's. */
  private initPipes = new Map<number, Endpoint>()
  private nextPipeFd = PIPE_FD_BASE
  /** Users, permissions, settings, apps. Without it every process runs as root. */
  system?: SystemContext
  /** The system log: console output of apps, crash reports, syscall timing for traces. */
  logger?: Logger
  private configWatchers: Array<{ pid: number; port: number; domain: string; key?: string }> = []

  constructor(
    private fs: FileSystem,
    private emit: (e: KernelEvent) => void,
    private host: ProcessHost,
    private processUrl: string | URL,
    heartbeat: HeartbeatOptions | null = null,
  ) {
    if (heartbeat) this.monitor = setInterval(() => this.checkHeartbeats(heartbeat.timeout), heartbeat.interval)
  }

  private monitor?: ReturnType<typeof setInterval>
  private startedAt = Date.now()

  // ------------------------------------------------------------- lifecycle

  async spawn(path: string, opts: SpawnOptions = {}, parent: number = INIT_PID): Promise<number> {
    const parentProc = this.procs.get(parent)
    const cwd = opts.cwd ? this.abs(parentProc?.cwd ?? '/', opts.cwd) : (parentProc?.cwd ?? '/')
    const full = this.abs(parentProc?.cwd ?? '/', path)

    const privileged = parent === INIT_PID || (parentProc !== undefined && isSystem(parentProc))
    if ((opts.user !== undefined || opts.bundle !== undefined) && !privileged) throw new SysError('EPERM', 'only root can choose the user or bundle of a process')
    let creds: Credentials & { appId: string | null } = parentProc
      ? { uid: parentProc.uid, gid: parentProc.gid, groups: parentProc.groups, appId: parentProc.appId }
      : { ...ROOT_CREDS, appId: null }
    if (opts.user !== undefined) {
      const user = typeof opts.user === 'number' ? this.system?.users.byUid(opts.user) : this.system?.users.byName(opts.user)
      if (!user || !this.system) throw new SysError('ESRCH', `no such user ${String(opts.user)}`)
      creds = { ...this.system.users.credentials(user), appId: parentProc?.appId ?? null }
    }
    const bundle = opts.bundle ? { id: opts.bundle.id, kind: opts.bundle.kind } : parentProc ? { id: parentProc.bundleId, kind: parentProc.kind } : { id: null, kind: null }
    if (opts.bundle) {
      if (opts.bundle.trusted) creds = { ...ROOT_CREDS, appId: null }
      else creds = { ...creds, appId: opts.bundle.id }
    }
    const who: Subject = { ...creds, pid: parent }

    const sys = this.system
    if (sys && !privileged) {
      // A process may start only what it could read, in a folder it could enter; apps also need the capability.
      if (who.appId) sys.perms.require(who, 'process.spawn', 'spawn')
      await sys.perms.checkFs(who, 'readFile', [full])
      await sys.perms.checkSearch(who, cwd)
    }
    const stat = await this.fs.stat(cwd)
    if (stat.kind !== 'dir') throw new SysError('ENOTDIR', undefined, cwd)
    const source = await this.fs.readFile(full) // ENOENT / EISDIR come from the engine

    this.checkProcessLimit()

    const { port1, port2 } = new MessageChannel()
    const pid = this.nextPid++
    const proc: Proc = {
      pid,
      ppid: parent,
      name: opts.name ?? full.split('/').pop() ?? full,
      path: full,
      args: opts.args ?? [],
      env: { ...(parentProc?.env ?? { PATH: '/bin:/Applications', HOME: '/' }), ...opts.env },
      cwd,
      host: null as unknown as HostHandle, // set below, once the container exists
      port: port1,
      fds: new Set(),
      stdio: [nullEndpoint(), nullEndpoint(), nullEndpoint()],
      pipes: new Map(),
      spawner: parent,
      pgid: opts.setsid || !parentProc ? pid : parentProc.pgid,
      sid: opts.setsid || !parentProc ? pid : parentProc.sid,
      ctty: null,
      stdioFds: {},
      startedAt: Date.now(),
      exitedAt: null,
      status: null,
      orphaned: false,
      waiters: [],
      ready: false,
      unresponsive: false,
      monitoring: false,
      nextPing: 1,
      pings: new Map(),
      stdout: '',
      stderr: '',
      uid: creds.uid,
      gid: creds.gid,
      groups: creds.groups,
      bundleId: bundle.id,
      kind: bundle.kind,
      appId: creds.appId,
      fdPaths: new Map(),
    }
    try {
      await this.setupStdio(proc, parentProc, parent, opts.stdio ?? {})
      this.checkProcessLimit()
    } catch (e) {
      port1.close()
      await this.releaseDescriptors(proc)
      throw e
    }
    if (opts.setsid) {
      for (const ep of proc.stdio) {
        if (ep.kind === 'pty' && ep.side === 'slave' && ep.pty.sid === null) {
          ep.pty.sid = pid
          ep.pty.fg = pid
          proc.ctty = ep.pty
          break
        }
      }
    }
    this.procs.set(pid, proc)

    port1.onmessage = (ev) => void this.onMessage(proc, ev.data)
    try {
      proc.host = this.host.start(
        { type: 'init', pid, ppid: parent, name: proc.name, args: proc.args, env: proc.env, cwd, source, port: port2, tty: proc.stdio.map((e) => e.kind === 'pty') },
        [port2, source.buffer as ArrayBuffer],
        String(this.processUrl),
      )
    } catch (e) {
      this.procs.delete(pid)
      port1.close()
      await this.releaseDescriptors(proc)
      throw new SysError('EAGAIN', `cannot start a process container: ${e}`)
    }
    // A crash outside our control (syntax error in the program, container failure).
    proc.host.onerror = (message) => void this.finish(proc, { code: null, signal: null, crashed: true, error: message })
    this.emit({ type: 'process', event: 'spawned', pid, ppid: parent, name: proc.name })
    return pid
  }

  private checkProcessLimit(): void {
    if ([...this.procs.values()].filter((p) => !p.status).length >= MAX_PROCESSES) throw new SysError('EAGAIN', 'too many processes')
  }

  /** Ends a process and runs cleanup. Safe to call more than once. */
  private async finish(proc: Proc, status: Omit<ExitStatus, 'pid' | 'stdout' | 'stderr'>): Promise<void> {
    if (proc.status) return
    const full: ExitStatus = { pid: proc.pid, ...status, stdout: proc.stdout, stderr: proc.stderr }
    proc.status = full
    proc.exitedAt = Date.now()
    proc.host.terminate()
    for (const p of proc.pings.values()) {
      clearTimeout(p.timer)
      p.reject(new SysError('ESRCH', 'process ended'))
    }
    proc.pings.clear()
    proc.port.close()
    this.ports.dropProcess(proc.pid)

    // A dead process must not keep files open.
    for (const fd of proc.fds) await this.fs.close(fd).catch(() => {})
    proc.fds.clear()
    proc.fdPaths.clear()
    this.configWatchers = this.configWatchers.filter((w) => w.pid !== proc.pid)
    await this.releaseDescriptors(proc)

    // The session leader is gone: its terminal hangs up on whoever was in the foreground.
    if (proc.ctty && proc.ctty.sid === proc.pid) {
      const fg = proc.ctty.fg
      proc.ctty.sid = null
      proc.ctty.fg = null
      if (fg !== null) this.signalGroup(fg, 'SIGHUP')
    }

    // Children outlive their parent and are adopted by init, which reaps them.
    for (const child of this.procs.values()) {
      if (child.ppid !== proc.pid) continue
      child.ppid = INIT_PID
      child.orphaned = true
      if (child.status) this.procs.delete(child.pid)
    }

    const waiters = proc.waiters.splice(0)
    for (const w of waiters) w(full)
    if (proc.orphaned) this.procs.delete(proc.pid)
    this.trimZombies()
    this.emit({ type: 'process', event: 'exited', pid: proc.pid, status: full })
    this.logger?.forget(proc.pid)
    if (this.logger && (status.crashed || (status.signal && ['SIGSEGV', 'SIGABRT', 'SIGILL'].includes(status.signal)))) {
      void this.logger.recordCrash({
        pid: proc.pid, name: proc.name, appId: proc.appId, bundleId: proc.bundleId, code: status.code ?? null, signal: status.signal ?? null,
        error: status.error ?? null, stderr: proc.stderr.slice(-4000),
      })
    }
    if (proc.bundleId) {
      const left = [...this.procs.values()].some((p) => !p.status && p.bundleId === proc.bundleId)
      if (proc.appId && !left) this.system?.perms.dropPickers(proc.appId)
      this.system?.launch.exited(proc.bundleId, proc.pid, proc.kind, !left, full)
    }
  }

  private async releaseDescriptors(proc: Proc): Promise<void> {
    const eps = [...proc.stdio, ...proc.pipes.values()]
    proc.stdio = [nullEndpoint(), nullEndpoint(), nullEndpoint()]
    proc.pipes.clear()
    for (const ep of eps) await release(this.fs, ep)
  }

  private table(pid: number): Map<number, Endpoint> {
    if (pid === INIT_PID) return this.initPipes
    const proc = this.procs.get(pid)
    if (!proc || proc.status) throw new SysError('ESRCH')
    return proc.pipes
  }

  private addFd(table: Map<number, Endpoint>, ep: Endpoint): number {
    if (table.size >= MAX_PIPE_FDS) throw new SysError('EMFILE')
    const fd = this.nextPipeFd++
    table.set(fd, ep)
    return fd
  }

  private async setupStdio(proc: Proc, parentProc: Proc | undefined, parent: number, spec: StdioOptions): Promise<void> {
    if (typeof spec !== 'object' || spec === null) throw new SysError('EINVAL', 'stdio must be an object')
    const table = this.table(parent)
    const wants = STREAMS.map((name, i) => spec[name] ?? (i === 0 ? 'null' : 'capture'))
    const refTo = (i: number): number | null => (wants[i] === 'stdout' ? 1 : wants[i] === 'stderr' ? 2 : null)
    // Streams that copy another one come last, so the other already exists.
    const order = [0, 1, 2].sort((a, b) => Number(refTo(a) !== null) - Number(refTo(b) !== null))
    for (const i of order) {
      const name = STREAMS[i]!
      const want = wants[i]!
      const ref = refTo(i)
      if (ref !== null) {
        if (ref === i || i === 0 || refTo(ref) !== null) throw new SysError('EINVAL', `${name}: '${want}' needs the other output stream to be a real destination`)
        proc.stdio[i] = dup(proc.stdio[ref]!)
        continue
      }
      const own = () =>
        captureEndpoint((t) => {
          if (i === 1) proc.stdout = append(proc.stdout, t)
          else proc.stderr = append(proc.stderr, t)
          this.consoleToLog(proc, i === 2, t)
        })
      let ep: Endpoint
      if (want === 'null') ep = nullEndpoint()
      else if (want === 'capture') {
        if (i === 0) throw new SysError('EINVAL', 'stdin cannot be captured')
        ep = own()
      } else if (want === 'inherit') {
        ep = parentProc ? dup(parentProc.stdio[i]!) : i === 0 ? nullEndpoint() : own()
      } else if (want === 'pipe') {
        const { read, write } = pipeEndpoints()
        proc.stdio[i] = i === 0 ? read : write
        proc.stdioFds[name] = this.addFd(table, i === 0 ? write : read)
        continue
      } else if (typeof want === 'object' && want !== null && 'file' in want) {
        const base = parentProc?.cwd ?? '/'
        const filePath = this.abs(base, want.file)
        if (this.system && parentProc && !isSystem(parentProc)) {
          const flags = i === 0 ? O.RDONLY : O.WRONLY | O.CREAT | (want.append ? O.APPEND : O.TRUNC)
          await this.system.perms.checkFs(this.subject(parentProc), 'open', [filePath, flags])
        }
        ep = await openFileEndpoint(this.fs, filePath, i === 0 ? 'r' : 'w', Boolean(want.append))
      } else if (typeof want === 'object' && want !== null && 'fd' in want) {
        const held = want.fd >= 0 && want.fd <= 2 ? parentProc?.stdio[want.fd] : table.get(want.fd)
        if (!held) throw new SysError('EBADF', `no pipe descriptor ${want.fd}`)
        const std = want.fd >= 0 && want.fd <= 2
        const readable = held.kind === 'null' || held.kind === 'pty' || ((held.kind === 'pipe' || held.kind === 'file') && held.mode === 'r')
        const writable = held.kind === 'null' || held.kind === 'pty' || held.kind === 'capture' || ((held.kind === 'pipe' || held.kind === 'file') && held.mode === 'w')
        if (std) {
          if (i === 0 ? !readable : !writable) throw new SysError('EINVAL', `your stream ${want.fd} cannot be ${name}`)
          proc.stdio[i] = dup(held)
          continue
        }
        const fits =
          (held.kind === 'pty' && held.side === 'slave') ||
          ((held.kind === 'pipe' || held.kind === 'file') && held.mode === (i === 0 ? 'r' : 'w'))
        if (!fits) throw new SysError('EINVAL', `descriptor ${want.fd} cannot be ${name}`)
        ep = dup(held)
      } else {
        throw new SysError('EINVAL', `bad ${name} option`)
      }
      proc.stdio[i] = ep
    }
  }

  // ------------------------------------------------------------- pipes

  pipe(caller: number = INIT_PID): [number, number] {
    const table = this.table(caller)
    if (table.size + 2 > MAX_PIPE_FDS) throw new SysError('EMFILE')
    const { read, write } = pipeEndpoints()
    return [this.addFd(table, read), this.addFd(table, write)]
  }

  /** The caller's descriptors for the pipes it asked for in `spawn` (`stdio: 'pipe'`). */
  stdioFds(caller: number, pid: number): Partial<Record<(typeof STREAMS)[number], number>> {
    const child = this.procs.get(pid)
    if (!child) throw new SysError('ESRCH')
    if (child.spawner !== caller) throw new SysError('EPERM', 'not your child')
    return { ...child.stdioFds }
  }

  /** `read`, `write`, and `close` on a pipe descriptor. Returns undefined if `fd` is not one. */
  fdOp(caller: number, call: 'read' | 'write' | 'close', args: unknown[]): Promise<unknown> | undefined {
    const table = this.table(caller)
    const fd = args[0] as number
    const ep = table.get(fd)
    if (!ep) return undefined
    if (call === 'close') {
      table.delete(fd)
      return release(this.fs, ep).then(() => null)
    }
    if (call === 'read') {
      const max = args[1]
      if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0 || args[2] !== undefined) {
        return Promise.reject(new SysError('EINVAL', 'read(fd, length) with a positive length; pipes have no offset'))
      }
      return readFrom(this.fs, ep, max)
    }
    const data = args[1]
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) return Promise.reject(new SysError('EINVAL', 'data must be bytes'))
    return writeTo(this.fs, ep, data).then(() => (typeof data === 'string' ? new TextEncoder().encode(data).length : data.length))
  }

  // ------------------------------------------------------------ terminals

  /** `openpty()`: a terminal pair. The master is for the emulator, the slave for programs' stdio. */
  openpty(caller: number = INIT_PID): { master: number; slave: number } {
    const table = this.table(caller)
    if (table.size + 2 > MAX_PIPE_FDS) throw new SysError('EMFILE')
    const { master, slave } = ptyEndpoints(new Pty((pgid, sig) => this.signalGroup(pgid, sig)))
    return { master: this.addFd(table, master), slave: this.addFd(table, slave) }
  }

  /**
   * Start a program on a new terminal as its session leader, stdin/stdout/stderr on the slave.
   * Returns the master descriptor (held by the caller) for the terminal emulator to read and write.
   */
  async spawnPty(path: string, opts: SpawnOptions & { size?: WinSize } = {}, caller: number = INIT_PID): Promise<{ pid: number; master: number }> {
    const { master, slave } = this.openpty(caller)
    const closeBoth = async () => {
      for (const fd of [master, slave]) await this.fdOp(caller, 'close', [fd])?.catch(() => {})
    }
    try {
      if (opts.size) this.pty(caller, master).setWinSize(opts.size)
      const pid = await this.spawn(path, { ...opts, setsid: true, stdio: { stdin: { fd: slave }, stdout: { fd: slave }, stderr: { fd: slave } } }, caller)
      await this.fdOp(caller, 'close', [slave]) // the child holds the only slave now: when it is gone, the master sees EOF
      return { pid, master }
    } catch (e) {
      await closeBoth()
      throw e
    }
  }

  private endpointOf(caller: number, fd: unknown): Endpoint {
    if (typeof fd !== 'number') throw new SysError('EBADF')
    if (fd >= 0 && fd <= 2) {
      const proc = this.procs.get(caller)
      if (!proc) throw new SysError('EBADF', 'init has no standard streams')
      return proc.stdio[fd]!
    }
    const ep = this.table(caller).get(fd)
    if (!ep) throw new SysError('EBADF')
    return ep
  }

  private pty(caller: number, fd: unknown): Pty {
    const ep = this.endpointOf(caller, fd)
    if (ep.kind !== 'pty') throw new SysError('ENOTTY')
    return ep.pty
  }

  /** The terminal calls. `fd` is a descriptor, or 0/1/2 for a process's standard streams. */
  ttyOp(caller: number, call: string, args: unknown[]): unknown {
    switch (call) {
      case 'isatty':
        return this.endpointOf(caller, args[0]).kind === 'pty'
      case 'tcgetattr':
        return { ...this.pty(caller, args[0]).termios }
      case 'tcsetattr':
        return void this.pty(caller, args[0]).setTermios(args[1] as Partial<Termios>)
      case 'getwinsize':
        return { ...this.pty(caller, args[0]).winsize }
      case 'setwinsize':
        return void this.pty(caller, args[0]).setWinSize(args[1] as WinSize)
      case 'tcgetpgrp': {
        const pty = this.pty(caller, args[0])
        if (this.procs.get(caller)?.sid !== pty.sid || pty.fg === null) throw new SysError('ENOTTY', 'not your controlling terminal')
        return pty.fg
      }
      case 'tcsetpgrp': {
        const pty = this.pty(caller, args[0])
        const me = this.procs.get(caller)
        if (!me || me.sid !== pty.sid) throw new SysError('ENOTTY', 'not your controlling terminal')
        const pgid = args[1]
        if (![...this.procs.values()].some((p) => !p.status && p.pgid === pgid && p.sid === me.sid)) {
          throw new SysError('EPERM', 'no such process group in your session')
        }
        pty.fg = pgid as number
        return null
      }
    }
    throw new SysError('ENOSYS', `unknown call ${call}`)
  }

  /** Process groups and sessions. `0` means the caller. */
  groupOp(proc: Proc, call: string, args: unknown[]): number | null {
    const target = (pid: unknown): Proc => {
      if (pid === undefined || pid === 0 || pid === proc.pid) return proc
      const p = typeof pid === 'number' ? this.procs.get(pid) : undefined
      if (!p || p.status) throw new SysError('ESRCH')
      return p
    }
    switch (call) {
      case 'getpgid':
        return target(args[0]).pgid
      case 'getsid':
        return target(args[0]).sid
      case 'setsid':
        if (proc.sid === proc.pid) return proc.pid
        if (proc.pgid === proc.pid) throw new SysError('EPERM', 'a process group leader cannot start a session')
        proc.sid = proc.pgid = proc.pid
        return proc.pid
      case 'setpgid': {
        const t = target(args[0])
        if (t !== proc && t.ppid !== proc.pid) throw new SysError('EPERM', 'only yourself or your children')
        if (t.sid !== proc.sid || t.pid === t.sid) throw new SysError('EPERM', 'not allowed to move that process')
        const pgid = args[1] === undefined || args[1] === 0 ? t.pid : args[1]
        if (typeof pgid !== 'number' || pgid < 0) throw new SysError('EINVAL')
        if (pgid !== t.pid && ![...this.procs.values()].some((p) => !p.status && p.pgid === pgid && p.sid === t.sid)) {
          throw new SysError('EPERM', 'no such process group in that session')
        }
        t.pgid = pgid
        return null
      }
    }
    throw new SysError('ENOSYS')
  }

  private stdStream(proc: Proc, n: unknown, allowed: number[]): Endpoint {
    if (typeof n !== 'number' || !allowed.includes(n)) throw new SysError('EINVAL', 'bad standard stream')
    return proc.stdio[n]!
  }

  private trimZombies(): void {
    const zombies = [...this.procs.values()].filter((p) => p.status)
    for (const z of zombies.slice(0, Math.max(0, zombies.length - MAX_ZOMBIES))) this.procs.delete(z.pid)
  }

  async killAll(): Promise<void> {
    clearInterval(this.monitor)
    for (const ep of this.initPipes.values()) await release(this.fs, ep)
    this.initPipes.clear()
    await Promise.all(
      [...this.procs.values()].filter((p) => !p.status).map((p) => this.finish(p, killed)),
    )
    this.procs.clear()
  }

  // ----------------------------------------------------------- operations

  /** `EPERM` unless `caller` may signal `pid` (a process group if negative): same user, and apps only their own. */
  private mayKill(caller: Proc, pid: number): void {
    const targets = pid < 0 ? [...this.procs.values()].filter((p) => !p.status && p.pgid === -pid) : [this.procs.get(pid)]
    for (const t of targets) {
      if (!t || t.status || isSystem(caller)) continue
      if (t.uid !== caller.uid || (caller.appId && t.bundleId !== caller.bundleId)) throw new SysError('EPERM', `not allowed to signal process ${t.pid}`)
    }
  }

  kill(pid: number, signal: string = 'SIGTERM'): void {
    if (!SIGNALS.has(signal)) {
      throw new SysError(signal === 'SIGSTOP' || signal === 'SIGCONT' ? 'ENOSYS' : 'EINVAL', `unsupported signal ${signal}`)
    }
    if (pid < 0) return this.signalGroup(-pid, signal, true) // kill(-pgid): the whole process group
    if (pid === INIT_PID) throw new SysError('EPERM', 'cannot signal the kernel')
    const proc = this.procs.get(pid)
    if (!proc || proc.status) throw new SysError('ESRCH')
    this.deliver(proc, signal)
  }

  private deliver(proc: Proc, signal: string): void {
    if (signal === 'SIGKILL') void this.finish(proc, killed)
    else proc.port.postMessage({ type: 'signal', signal })
  }

  /** Signals every live process in a group. Strict: `ESRCH` if there is none (a terminal just ignores that). */
  private signalGroup(pgid: number, signal: string, strict = false): void {
    const members = [...this.procs.values()].filter((p) => !p.status && p.pgid === pgid)
    if (!members.length && strict) throw new SysError('ESRCH', 'no such process group')
    for (const proc of members) this.deliver(proc, signal)
  }

  async wait(pid: number, caller: number = INIT_PID): Promise<ExitStatus> {
    const proc = this.procs.get(pid)
    if (!proc) throw new SysError('ESRCH')
    const status = proc.status ?? (await new Promise<ExitStatus>((resolve) => proc.waiters.push(resolve)))
    if (proc.ppid === caller) this.procs.delete(pid) // only the parent reaps
    return status
  }

  /**
   * Round-trip time in ms of a ping to the process's runtime. A process that never yields (a busy loop)
   * cannot answer: `ETIMEDOUT`, and it is flagged `unresponsive` until a late answer arrives.
   */
  async ping(pid: number, timeout = 1000): Promise<number> {
    if (pid === INIT_PID) return 0
    const proc = this.procs.get(pid)
    if (!proc || proc.status) throw new SysError('ESRCH')
    if (typeof timeout !== 'number' || !(timeout > 0)) throw new SysError('EINVAL', 'timeout must be positive')
    return new Promise<number>((resolve, reject) => {
      const id = proc.nextPing++
      const timer = setTimeout(() => {
        proc.pings.delete(id)
        if (proc.ready) this.setResponsive(proc, false)
        reject(new SysError('ETIMEDOUT', 'no answer to ping'))
      }, timeout)
      proc.pings.set(id, { resolve, reject, timer, sent: performance.now() })
      proc.port.postMessage({ type: 'ping', id })
    })
  }

  private checkHeartbeats(timeout: number): void {
    for (const proc of this.procs.values()) {
      if (proc.status || !proc.ready || proc.monitoring) continue
      proc.monitoring = true
      this.ping(proc.pid, timeout).then(
        () => this.setResponsive(proc, true),
        () => {},
      ).finally(() => (proc.monitoring = false))
    }
  }

  private setResponsive(proc: Proc, responsive: boolean): void {
    if (proc.status || proc.unresponsive === !responsive) return
    proc.unresponsive = !responsive
    this.emit({ type: 'process', event: 'stateChanged', pid: proc.pid, unresponsive: proc.unresponsive })
  }

  list(): ProcessInfo[] {
    return [...this.procs.values()].map((p) => this.describe(p))
  }

  info(pid: number): ProcessInfo {
    if (pid === INIT_PID) {
      return {
        pid, ppid: 0, name: 'kernel', path: '', args: [], state: 'running', startedAt: this.startedAt, exitedAt: null, cwd: '/', pgid: pid, sid: pid,
        openFds: 0, unresponsive: false, status: null, uid: 0, gid: 0, bundleId: null, kind: null, appId: null,
      }
    }
    const proc = this.procs.get(pid)
    if (!proc) throw new SysError('ESRCH')
    return this.describe(proc)
  }

  private describe(p: Proc): ProcessInfo {
    return {
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      path: p.path,
      args: p.args,
      state: p.status ? 'zombie' : 'running',
      startedAt: p.startedAt,
      exitedAt: p.exitedAt,
      cwd: p.cwd,
      pgid: p.pgid,
      sid: p.sid,
      openFds: p.fds.size + p.pipes.size,
      unresponsive: p.unresponsive,
      status: p.status,
      uid: p.uid,
      gid: p.gid,
      bundleId: p.bundleId,
      kind: p.kind,
      appId: p.appId,
    }
  }

  // ----------------------------------------------------------- identity, permissions, settings

  subject(p: Proc): Subject {
    return { uid: p.uid, gid: p.gid, groups: p.groups, pid: p.pid, appId: p.appId }
  }

  pidsOf(bundleId: string): number[] {
    return [...this.procs.values()].filter((p) => !p.status && p.bundleId === bundleId).map((p) => p.pid)
  }

  /** Resolves once the process runtime has started (it can answer pings), or when the process ends. */
  async whenStarted(pid: number, graceMs = 0): Promise<ExitStatus | null> {
    const proc = this.procs.get(pid)
    if (!proc) throw new SysError('ESRCH')
    for (let waited = 0; !proc.ready && !proc.status && waited < 5000; waited += 10) await new Promise((r) => setTimeout(r, 10))
    if (graceMs && !proc.status) {
      // A program that fails to load or throws at once ends right after it starts: give it a moment to show that.
      await Promise.race([new Promise((r) => setTimeout(r, graceMs)), new Promise<void>((r) => proc.waiters.push(() => r()))])
    }
    return proc.status
  }

  /** Close the files of an app's processes that its current permissions no longer allow (after a revoke). */
  enforce(appId: string): void {
    const perms = this.system?.perms
    if (!perms) return
    for (const p of this.procs.values()) {
      if (p.status || p.appId !== appId) continue
      for (const [fd, f] of [...p.fdPaths]) {
        if (perms.scopeAllows(appId, f.path, f.write)) continue
        p.fdPaths.delete(fd)
        p.fds.delete(fd)
        void this.fs.close(fd).catch(() => {})
      }
    }
  }

  /** Tell processes that asked (`configWatch`) about a setting that changed. */
  deliverConfig(change: ConfigChange): void {
    for (const w of [...this.configWatchers]) {
      if ((w.domain !== '*' && w.domain !== change.domain) || (w.key !== undefined && w.key !== change.key)) continue
      if (!this.ports.notify(w.port, { type: 'config-changed', ...change })) {
        this.configWatchers = this.configWatchers.filter((x) => x !== w)
      }
    }
  }

  /** The process a privileged service acts for: `{as: pid}` in the last argument. */
  private actor(proc: Proc, opts: unknown): Proc {
    const as = (opts as { as?: unknown } | undefined)?.as
    if (as === undefined) return proc
    if (!isSystem(proc)) throw new SysError('EPERM', 'only system services may act for another process')
    if (as === INIT_PID) return proc // the outside world (Desktop) is root: the service already is
    const target = this.procs.get(as as number)
    if (!target || target.status) throw new SysError('ESRCH')
    return target
  }

  private async systemCall(proc: Proc, call: string, args: unknown[]): Promise<unknown> {
    const sys = this.system
    if (!sys) throw new SysError('ENOSYS', 'the system services are not running')
    const str = (v: unknown, what: string) => {
      if (typeof v !== 'string') throw new SysError('EINVAL', `${what} must be a string`)
      return v
    }
    const lastOpts = (n: number) => args[n] as { as?: number; scope?: ConfigScope } | undefined
    switch (call) {
      case 'configGet':
        return sys.config.get(str(args[0], 'domain'), str(args[1], 'key'), args[2] as never)
      case 'configList':
        return sys.config.list(str(args[0], 'domain'))
      case 'configSet': case 'configDelete': case 'configReset': {
        const opts = lastOpts(call === 'configSet' ? 3 : call === 'configDelete' ? 2 : 1)
        const who = this.actor(proc, opts)
        const domain = str(args[0], 'domain')
        const scope: ConfigScope = opts?.scope ?? 'user'
        if (scope === 'system' && !isSystem(who)) throw new SysError('EACCES', 'only root can change system settings')
        if (who.appId && domain !== who.appId && !domain.startsWith(`${who.appId}.`)) {
          sys.perms.audit({ event: 'fs-denied', appId: who.appId, pid: who.pid, call, path: domain, detail: 'settings of another app' })
          throw new SysError('EACCES', `${who.appId} may only change its own settings domain`)
        }
        if (call === 'configSet') sys.config.set(domain, str(args[1], 'key'), args[2], scope)
        else if (call === 'configDelete') sys.config.delete(domain, str(args[1], 'key'), scope)
        else sys.config.reset(domain, scope)
        return null
      }
      case 'configWatch': {
        // args: domain, key | null, port (a port the caller owns)
        const port = args[2]
        if (typeof port !== 'number' || !this.ports.ownedBy(proc.pid, port)) throw new SysError('EBADF', 'watch needs a port you own')
        if (this.configWatchers.filter((w) => w.pid === proc.pid).length >= 64) throw new SysError('EMFILE', 'too many watches')
        this.configWatchers.push({ pid: proc.pid, port, domain: str(args[0], 'domain'), key: typeof args[1] === 'string' ? args[1] : undefined })
        return null
      }
      case 'configUnwatch':
        this.configWatchers = this.configWatchers.filter((w) => !(w.pid === proc.pid && w.port === args[0]))
        return null
      case 'permCheck':
        return sys.perms.check(this.subject(this.actor(proc, lastOpts(2))), str(args[0], 'capability'), args[1] as string | undefined)
      case 'permRequest':
        return sys.perms.request(this.subject(this.actor(proc, lastOpts(1))), str(args[0], 'capability'))
      case 'permList': {
        const who = this.actor(proc, lastOpts(0))
        return sys.perms.list(who.appId ?? undefined)
      }
      case 'bundleList':
        return sys.bundles.list()
      case 'bundleInfo':
        return sys.bundles.info(str(args[0], 'id'))
    }
    // launch services act for the caller: a path must be one it can read
    // `as` is the last argument of each call (see Pear in runtime.ts)
    const who = this.actor(proc, lastOpts({ launchOpen: 1, launchOpenWith: 2, launchSetDefault: 2, launchTypeOf: 1, launchActivate: 1 }[call] ?? 9))
    const subject = isSystem(who) ? null : this.subject(who)
    switch (call) {
      case 'launchOpen':
        return sys.launch.open(str(args[0], 'target'), (args[1] as never) ?? {}, subject)
      case 'launchOpenWith':
        return sys.launch.openWith(str(args[0], 'path'), str(args[1], 'app id'), subject)
      case 'launchApps':
        return sys.launch.apps()
      case 'launchAppsFor':
        return sys.launch.appsFor(str(args[0], 'target'))
      case 'launchDefaultFor':
        return sys.launch.defaultFor(str(args[0], 'type or scheme'))
      case 'launchSetDefault':
        if (subject) throw new SysError('EPERM', 'only the system can change default apps')
        return sys.launch.setDefault(str(args[0], 'type or scheme'), str(args[1], 'app id'))
      case 'launchTypeOf':
        return sys.launch.typeOf(str(args[0], 'path'), subject)
      case 'launchIconFor':
        return sys.launch.iconFor(str(args[0], 'path, bundle id or type'), subject)
      case 'launchTypeConflicts':
        return sys.launch.typeConflicts()
      case 'launchRunning':
        return sys.launch.running()
      case 'launchActivate':
        return sys.launch.activate(str(args[0], 'app id'), subject)
      case 'launchRecents':
        return sys.launch.recents(typeof args[0] === 'string' ? args[0] : undefined)
    }
    throw new SysError('ENOSYS', `unknown syscall ${call}`)
  }

  // ----------------------------------------------------------- syscalls

  private abs(cwd: string, path: string): string {
    if (typeof path !== 'string') throw new SysError('EINVAL', 'path must be a string')
    if (path.startsWith('/')) return path
    return cwd === '/' ? `/${path}` : `${cwd}/${path}`
  }

  /** An app's `console.*` (what it writes to a captured stdout/stderr) goes into the system log under its id. */
  private consoleToLog(proc: Proc, isErr: boolean, text: string): void {
    if (!this.logger || !proc.appId) return
    for (const line of text.split('\n')) {
      if (line) this.logger.write({ level: isErr ? 'error' : 'info', subsystem: proc.appId, category: 'console', message: line }, { pid: proc.pid, appId: proc.appId })
    }
  }

  private async onMessage(proc: Proc, msg: { type: string } & Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'syscall': {
        const { id, call, args } = msg as unknown as { id: number; call: string; args: unknown[] }
        try {
          const started = this.logger?.tracing ? performance.now() : 0
          const result = await this.syscall(proc, call, args)
          if (started) this.logger?.syscall(call, performance.now() - started)
          const transfer = result instanceof Uint8Array ? [result.buffer as ArrayBuffer] : transfersOf(result)
          proc.port.postMessage({ id, result }, transfer)
        } catch (e) {
          proc.port.postMessage({ id, error: toWireError(e) })
        }
        return
      }
      case 'ready':
        proc.ready = true
        return
      case 'pong': {
        const ping = proc.pings.get(msg.id as number)
        if (ping) {
          proc.pings.delete(msg.id as number)
          clearTimeout(ping.timer)
          ping.resolve(performance.now() - ping.sent)
        }
        this.setResponsive(proc, true) // an answer, even a late one, means it is running again
        return
      }
      case 'exit':
        await this.finish(proc, {
          code: (msg.code as number | null) ?? null,
          signal: (msg.signal as Signal | null) ?? null,
          crashed: Boolean(msg.crashed),
          error: msg.error as string | undefined,
        })
    }
  }

  private requireLogger(): Logger {
    if (!this.logger) throw new SysError('ENOSYS', 'logging is not running')
    return this.logger
  }

  private async syscall(proc: Proc, call: string, args: unknown[]): Promise<unknown> {
    if (proc.status) throw new SysError('ESRCH')
    switch (call) {
      case 'getpid':
        return proc.pid
      case 'getppid':
        return proc.ppid
      case 'getcwd':
        return proc.cwd
      case 'chdir': {
        if (this.system) await this.system.perms.checkSearch(this.subject(proc), this.abs(proc.cwd, args[0] as string))
        const real = await this.fs.realpath(this.abs(proc.cwd, args[0] as string))
        const st = await this.fs.stat(real)
        if (st.kind !== 'dir') throw new SysError('ENOTDIR', undefined, real)
        proc.cwd = real
        return real
      }
      case 'environ':
        return { ...proc.env }
      case 'getenv':
        return proc.env[args[0] as string] ?? null
      case 'setenv':
        proc.env[args[0] as string] = String(args[1])
        return null
      case 'spawn':
        return this.spawn(args[0] as string, (args[1] as SpawnOptions | undefined) ?? {}, proc.pid)
      case 'kill':
        if (this.system) this.mayKill(proc, args[0] as number)
        return this.kill(args[0] as number, args[1] as string | undefined)
      case 'wait':
        return this.wait(args[0] as number, proc.pid)
      case 'list':
        return this.list()
      case 'info':
        return this.info(args[0] as number)
      case 'portCreate':
        return this.ports.create(proc.pid)
      case 'portDestroy':
        return this.ports.destroy(proc.pid, args[0])
      case 'send':
        return this.ports.send(proc.pid, args[0], args[1], args[2] as SendOptions | undefined)
      case 'receive':
        return this.ports.receive(proc.pid, args[0], (args[1] as { timeout?: number } | undefined)?.timeout)
      case 'register':
        return this.ports.register(proc.pid, args[0], args[1])
      case 'lookup':
        return this.ports.lookup(proc.pid, args[0])
      case 'watch':
        return this.ports.watch(proc.pid, args[0], args[1])
      case 'unwatch':
        return this.ports.unwatch(proc.pid, args[0], args[1])
      case 'ping':
        return this.ping(args[0] as number, args[1] as number | undefined)
      case 'pipe':
        return this.pipe(proc.pid)
      case 'openpty':
        return this.openpty(proc.pid)
      case 'isatty':
      case 'tcgetattr':
      case 'tcsetattr':
      case 'getwinsize':
      case 'setwinsize':
      case 'tcgetpgrp':
      case 'tcsetpgrp':
        return this.ttyOp(proc.pid, call, args)
      case 'getpgid':
      case 'getsid':
      case 'setsid':
      case 'setpgid':
        return this.groupOp(proc, call, args)
      case 'stdio':
        return this.stdioFds(proc.pid, args[0] as number)
      case 'getuid':
        return proc.uid
      case 'getgid':
        return proc.gid
      case 'getgroups':
        return [...proc.groups]
      case 'getappid':
        return proc.bundleId
      case 'driverEmit': {
        if (!isSystem(proc)) throw new SysError('EPERM', 'only system services may talk to the drivers')
        const device = args[0]
        if (typeof device !== 'string' || !/^[a-z]{2,16}$/.test(device)) throw new SysError('EINVAL', 'device must be a short lowercase name')
        this.emit({ type: 'driver', device, data: args[1] })
        return null
      }
      case 'logWrite': {
        const logger = this.requireLogger()
        const input = args[0] as LogInput | undefined
        if (typeof input !== 'object' || input === null) throw new SysError('EINVAL', 'pass {message, level?, subsystem?, category?, data?}')
        // Apps log under their own id; the system may name any subsystem.
        const subsystem = proc.appId ? proc.appId : input.subsystem
        return logger.write({ ...input, subsystem }, { pid: proc.pid, appId: proc.appId })
      }
      case 'logQuery': {
        const logger = this.requireLogger()
        const filter = { ...((args[0] as LogFilter | undefined) ?? {}) }
        if (proc.appId) filter.appId = proc.appId // an app reads only its own entries
        return logger.query(filter)
      }
      case 'fsChanges': {
        if (!isSystem(proc)) throw new SysError('EPERM', 'only system services may watch the whole file system')
        return this.fs.changesSince(typeof args[0] === 'number' ? args[0] : 0)
      }
      case 'configGet': case 'configSet': case 'configDelete': case 'configList': case 'configReset': case 'configWatch': case 'configUnwatch':
      case 'permCheck': case 'permRequest': case 'permList':
      case 'bundleList': case 'bundleInfo':
      case 'launchOpen': case 'launchOpenWith': case 'launchApps': case 'launchAppsFor': case 'launchDefaultFor': case 'launchSetDefault':
      case 'launchTypeOf': case 'launchRunning': case 'launchActivate': case 'launchRecents': case 'launchIconFor': case 'launchTypeConflicts':
        return this.systemCall(proc, call, args)
      case 'stdwrite': {
        const data = args[1]
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new SysError('EINVAL', 'data must be a string or bytes')
        // Not awaited before it is queued: writes must reach a pipe in the order the process made them.
        return writeTo(this.fs, this.stdStream(proc, args[0], [1, 2]), data)
      }
      case 'stdread': {
        const max = args[0]
        if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) throw new SysError('EINVAL', 'positive length expected')
        return readFrom(this.fs, proc.stdio[0]!, max)
      }
    }

    if (call === 'read' || call === 'write' || call === 'close') {
      const op = this.fdOp(proc.pid, call, args)
      if (op) return op
    }

    if (!PROCESS_FS.has(call)) throw new SysError('ENOSYS', `unknown syscall ${call}`)
    const method = call as FsMethod
    const a = [...args]

    if (FD_FIRST_ARG.has(call) && !proc.fds.has(a[0] as number)) throw new SysError('EBADF')
    for (const i of PATH_ARGS[method] ?? (FD_FIRST_ARG.has(call) || method === 'statfs' || method === 'flush' ? [] : [0])) {
      if (a[i] !== undefined) a[i] = this.abs(proc.cwd, a[i] as string)
    }

    let canonical: string | null = null
    if (this.system) canonical = await this.system.perms.checkFs(this.subject(proc), call, a)

    const fn = this.fs[method] as unknown as (...x: unknown[]) => Promise<unknown>
    // New files belong to the caller; the call must start inside `as` so the engine sees the right owner.
    const result = await this.fs.as(proc.uid, proc.gid, () => fn.apply(this.fs, a))
    if (call === 'open') {
      proc.fds.add(result as number)
      const flags = (a[1] as number | undefined) ?? O.RDONLY
      proc.fdPaths.set(result as number, { path: canonical ?? a[0] as string, write: (flags & 3) !== O.RDONLY || (flags & O.APPEND) !== 0 })
    }
    if (call === 'close') {
      proc.fds.delete(a[0] as number)
      proc.fdPaths.delete(a[0] as number)
    }
    return result
  }
}
