import { SysError } from './errors'
import { FileSystem, type BootOptions, type JournalStats, type Recovery } from './fs'
import type { ProcessHost } from './hosting'
import { request, type Message, type SendOptions } from './ipc'
import type { Termios, WinSize } from './pty'
import { INIT_PID, ProcessTable, type ExitStatus, type HeartbeatOptions, type KernelEvent, type ProcessInfo, type Signal, type SpawnOptions, type SystemContext } from './process'
import { BundleManager, OS_VERSION, type BundleInfo, type BundleSource, type VerifyResult } from './bundle'
import { Config, WELL_KNOWN, type ConfigScope, type ConfigValue, type Schema } from './config'
import { LaunchServices, type AppRecord, type IconInfo, type OpenOptions, type RecentItem, type RunningApp } from './launch'
import { Permissions, type AuditEntry, type Capability, type Grant, type Status } from './perm'
import { bootSystem, SESSION_MARK, type BootInfo, type SystemOptions } from './system'
import { TypeRegistry, type TypeInfo } from './uti'
import { UserDb } from './users'
import { Images, type ImageCreateOptions, type ImageInfo, type RestoreOptions, type RestoreResult } from './image'
import type { HostMountOptions } from './hostvol'
import { Logger, type CrashReport, type Diagnostics, type LogEntry, type LogFilter, type LogInput, type Trace } from './log'

export interface KernelBootOptions extends BootOptions {
  /** Where the page loads the process runtime from. Defaults to `process.js` next to the kernel. */
  processUrl?: string | URL
  /** Ping live processes to detect ones that stopped responding. `false` turns it off. Default: every 1 s, 3 s to answer. */
  heartbeat?: HeartbeatOptions | false
  /**
   * Run the boot sequence: create the default hierarchy on first run, install the core utilities and the system
   * services, and start the services. Off by default, so a bare kernel can be used (and tested) without them.
   */
  system?: boolean | SystemOptions
  /** Stored settings, as the page read them from LocalStorage (`client.ts` fills this in). */
  config?: { prefix: string; snapshot: Record<string, string> }
  /** Seconds a permission prompt waits for an answer before it counts as denied. Default 30. */
  promptTimeout?: number
}

/** How the kernel Worker reaches the page's LocalStorage. */
export interface ConfigStorage {
  write(key: string, value: string | null): void
}

/** The kernel: file system plus process table. Runs inside the kernel Worker. */
export class Kernel {
  private constructor(
    readonly fs: FileSystem,
    private procs: ProcessTable,
    readonly sys: SystemContext,
    private boot_: BootInfo,
    private emit: (e: KernelEvent) => void,
    readonly logger: Logger,
  ) {}

  static async boot(opts: KernelBootOptions = {}, emit: (e: KernelEvent) => void, host: ProcessHost, storage?: ConfigStorage): Promise<Kernel> {
    const fs = await FileSystem.boot(opts)
    const procs = new ProcessTable(fs, emit, host, opts.processUrl ?? new URL('process.js', import.meta.url),
      opts.heartbeat === false ? null : (opts.heartbeat ?? { interval: 1000, timeout: 3000 }),
    )
    const logger = new Logger(fs, emit, OS_VERSION)
    procs.logger = logger
    logger.mark('kernel')
    await logger.load()
    const users = new UserDb()
    await users.load(fs)
    const types = new TypeRegistry()
    const config = new Config(
      opts.config?.prefix ?? `tiny:${opts.namespace ?? 'tiny'}:cfg:`,
      opts.config?.snapshot ?? {},
      (key, value) => storage?.write(key, value),
      (message) => emit({ type: 'config', event: 'warning', message }),
    )
    const bundles: BundleManager = new BundleManager(fs, users, types, emit, {
      running: (id) => procs.pidsOf(id),
      quit: (id) => quitApp(procs, id),
    })
    const perms = new Permissions(fs, users, (id) => bundles.find(id), (e) => {
      emit(e)
      if (e.event === 'changed' && e.status !== 'granted') procs.enforce(e.appId)
    }, { promptTimeout: opts.promptTimeout })
    const launch = new LaunchServices(fs, procs, bundles, types, config, perms, users, emit)
    const sys: SystemContext = { perms, users, config, bundles, launch }
    procs.system = sys
    config.onChange((change) => {
      emit({ type: 'config', event: 'changed', change })
      procs.deliverConfig(change)
    })
    for (const [domain, schema] of Object.entries(WELL_KNOWN)) config.register(domain, schema)
    await perms.load()
    await bundles.scan()
    launch.applyTypeOverrides()
    const info: BootInfo = { firstBoot: false, bootTime: Date.now(), version: '', previousShutdown: 'clean', safeMode: false, services: [], warnings: [] }
    const kernel = new Kernel(fs, procs, sys, info, emit, logger)
    if (opts.system) {
      kernel.boot_ = await bootSystem({ fs, users, config, bundles, perms, launch, procs, logger }, opts.system === true ? {} : opts.system, emit)
    }
    return kernel
  }

  // ---- drivers: the page tells a driver service about the hardware (the service asks the page back with `driverEmit`)

  /**
   * Hand `data` to the driver service for `device` (`clipboard`, `timers`, `input`, `display`, `audio`) as a
   * message from the kernel. False if the service is not running or its queue is full (the event is dropped).
   */
  driverPush = async (device: string, data: unknown): Promise<boolean> => {
    const port = this.procs.ports.find(`tiny.${device}`)
    return port !== undefined && this.procs.ports.notify(port, { type: 'driver', data })
  }

  // ---- logging, crash reports, diagnostics (see `log.ts`)

  /** Desktop's own entries; the subsystem should start with `desktop.`. */
  logWrite = async (entry: LogInput): Promise<boolean> => this.logger.write({ subsystem: 'desktop', ...entry })
  logQuery = (filter?: LogFilter): Promise<LogEntry[]> => this.logger.query(filter)
  /** JSON lines; private entries are redacted unless `includePrivate`. */
  logExport = (range?: { since?: number; until?: number; includePrivate?: boolean }): Promise<string> => this.logger.export(range)
  logClear = (): Promise<void> => this.logger.clear()
  logFlush = (): Promise<void> => this.logger.flush(true)
  /** Get each new entry as a `{type: 'log', entry}` event (off by default: it can be a lot of traffic). */
  logSubscribe = async (on: boolean): Promise<void> => void (this.logger.live = on)
  crashList = async () => this.logger.crashList()
  crashGet = async (id: string): Promise<CrashReport> => this.logger.crashGet(id)
  crashSubmit = (id: string): Promise<CrashReport> => this.logger.crashSubmit(id)
  crashClear = (): Promise<void> => this.logger.crashClear()
  /** Processes, ports, files, memory and the log's own state, right now. */
  diagSnapshot = async (): Promise<Diagnostics> => {
    const list = this.procs.list()
    const mem = (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    return {
      time: Date.now(),
      uptime: Date.now() - this.boot_.bootTime,
      processes: list.map((p) => ({ pid: p.pid, name: p.name, state: p.state, appId: p.appId, bundleId: p.bundleId, openFds: p.openFds, uptime: (p.exitedAt ?? Date.now()) - p.startedAt, unresponsive: p.unresponsive, uid: p.uid })),
      ports: this.procs.ports.size,
      openFiles: list.reduce((n, p) => n + p.openFds, 0),
      memory: mem ? { usedJSHeapSize: mem.usedJSHeapSize, totalJSHeapSize: mem.totalJSHeapSize, limit: mem.jsHeapSizeLimit } : null,
      journal: await this.fs.journalStats().catch(() => null),
      log: this.logger.stats(),
      crashes: this.logger.crashList().length,
    }
  }
  traceStart = async (name: string): Promise<void> => this.logger.traceStart(name)
  traceMark = async (name: string, label: string): Promise<void> => this.logger.traceMark(name, label)
  traceMeasure = async (name: string, measure: string, from: string, to?: string): Promise<void> => this.logger.traceMeasure(name, measure, from, to)
  traceStop = async (name: string): Promise<Trace> => this.logger.traceStop(name)
  /** Marks the boot path left (milliseconds since the kernel started), for profiling. */
  bootMarks = async () => this.logger.boot()

  // ---- host volumes, bookmarks, disk images (Desktop only: processes get `flock` from the file calls)

  private imagesImpl: Images | undefined
  private get images(): Images {
    return (this.imagesImpl ??= new Images(this.fs, OS_VERSION, () => this.fs.mountPoints().map((m) => m.point)))
  }
  private canceled = false
  private replaced = false

  /**
   * Show a host folder (a `FileSystemDirectoryHandle` the page got from `showDirectoryPicker`, with access already
   * granted) at `point`. `owner` is the user who owns its files (default: the first regular user).
   */
  mount = async (handle: FileSystemDirectoryHandle, point: string, opts: HostMountOptions & { owner?: string | number } = {}): Promise<void> => {
    const users = this.sys.users
    const owner = opts.owner !== undefined ? (typeof opts.owner === 'number' ? users.byUid(opts.owner) : users.byName(opts.owner)) : users.primary
    if (!owner) throw new SysError('ESRCH', `no such user ${String(opts.owner)}`)
    await this.fs.mount(handle, point, { readOnly: opts.readOnly, uid: owner.uid, gid: owner.gid })
    this.emit({ type: 'volume', event: 'mounted', point })
  }
  unmount = async (point: string, opts?: { force?: boolean }): Promise<void> => {
    await this.fs.unmount(point, opts)
    this.emit({ type: 'volume', event: 'unmounted', point })
  }
  mounts = async () => this.fs.mountPoints()
  bookmark = (path: string): Promise<string> => this.fs.bookmark(path)
  resolveBookmark = (id: string): Promise<string> => this.fs.resolveBookmark(id)
  removeBookmark = (id: string): Promise<void> => this.fs.removeBookmark(id)
  listBookmarks = (): Promise<Array<{ id: string; path: string }>> => this.fs.listBookmarks()

  private progressFor(op: 'create' | 'restore') {
    this.canceled = false
    let last = 0
    return (entries: number, bytes: number) => {
      if (entries - last >= 50) {
        last = entries
        this.emit({ type: 'image', event: 'progress', op, entries, bytes })
      }
      return !this.canceled
    }
  }
  /** The file system (or the folders in `include`) as one `.tinyimg` file. Progress arrives as `image` events; `imageCancel` stops it. */
  imageCreate = (opts: Omit<ImageCreateOptions, 'progress'> = {}): Promise<Blob> => this.images.create({ ...opts, progress: this.progressFor('create') })
  /** Check an image's version and checksum without restoring it. */
  imageVerify = (file: Blob, passphrase?: string): Promise<ImageInfo> => this.images.verify(file, passphrase)
  /** `replace` needs `confirm: true`, ends every process, and leaves the system to be restarted. */
  imageRestore = async (file: Blob, opts: Omit<RestoreOptions, 'progress'>): Promise<RestoreResult> => {
    const res = await this.images.restore(file, { ...opts, progress: this.progressFor('restore') }, async () => {
      this.replaced = true
      await this.procs.killAll()
    })
    this.emit({ type: 'image', event: 'restored', mode: opts.mode, restartRequired: res.restartRequired })
    return res
  }
  imageCancel = async (): Promise<void> => void (this.canceled = true)

  configExternal = (key: string, value: string | null): void => this.sys.config.applyExternal(key, value)
  configFlush = async (): Promise<void> => this.sys.config.flush()

  // ---- processes, as seen from outside the kernel (Desktop, tests): the caller is init (pid 1)

  spawn = (path: string, opts?: SpawnOptions): Promise<number> => this.procs.spawn(path, opts)
  kill = async (pid: number, signal?: Signal): Promise<void> => this.procs.kill(pid, signal)
  wait = (pid: number): Promise<ExitStatus> => this.procs.wait(pid)
  listProcesses = async (): Promise<ProcessInfo[]> => this.procs.list()
  /** Round-trip time of a ping in ms; `ETIMEDOUT` if the process does not answer. */
  ping = (pid: number, timeout?: number): Promise<number> => this.procs.ping(pid, timeout)

  // ---- pipes, as init: descriptors are numbers private to init, usable only with these calls

  pipe = async (): Promise<[number, number]> => this.procs.pipe(INIT_PID)
  /** Descriptors for the pipes you asked for with `spawn(..., {stdio: {stdout: 'pipe'}})`. */
  stdio = async (pid: number): Promise<{ stdin?: number; stdout?: number; stderr?: number }> => this.procs.stdioFds(INIT_PID, pid)
  pipeRead = (fd: number, max = 65536): Promise<Uint8Array> => this.pipeOp('read', [fd, max]) as Promise<Uint8Array>
  pipeWrite = (fd: number, data: Uint8Array | string): Promise<number> => this.pipeOp('write', [fd, data]) as Promise<number>
  pipeClose = async (fd: number): Promise<void> => void (await this.pipeOp('close', [fd]))
  private pipeOp(call: 'read' | 'write' | 'close', args: unknown[]): Promise<unknown> {
    const op = this.procs.fdOp(INIT_PID, call, args)
    if (!op) return Promise.reject(new SysError('EBADF', 'not a pipe descriptor'))
    return op
  }

  // ---- terminals, as init: `master` is a descriptor for pipeRead / pipeWrite / pipeClose

  openpty = async (): Promise<{ master: number; slave: number }> => this.procs.openpty(INIT_PID)
  /**
   * Run a program on a new terminal as its session leader. Read what it prints with `pipeRead(master)`,
   * send keystrokes with `pipeWrite(master, ...)`. Close `master` when the terminal window closes (the program gets SIGHUP).
   */
  spawnPty = (path: string, opts?: SpawnOptions & { size?: WinSize }): Promise<{ pid: number; master: number }> => this.procs.spawnPty(path, opts)
  isatty = async (fd: number): Promise<boolean> => this.procs.ttyOp(INIT_PID, 'isatty', [fd]) as boolean
  tcgetattr = async (fd: number): Promise<Termios> => this.procs.ttyOp(INIT_PID, 'tcgetattr', [fd]) as Termios
  tcsetattr = async (fd: number, change: Partial<Termios>): Promise<void> => void this.procs.ttyOp(INIT_PID, 'tcsetattr', [fd, change])
  getwinsize = async (fd: number): Promise<WinSize> => this.procs.ttyOp(INIT_PID, 'getwinsize', [fd]) as WinSize
  setwinsize = async (fd: number, size: WinSize): Promise<void> => void this.procs.ttyOp(INIT_PID, 'setwinsize', [fd, size])
  /** How the file system's journal is doing, and what the last boot had to repair after a crash. */
  fsInfo = async (): Promise<{ recovery: Recovery; journal: JournalStats }> => ({
    recovery: await this.fs.recovery(),
    journal: await this.fs.journalStats(),
  })
  /** Fold the journal into a fresh index. Shutdown does this too. */
  fsCheckpoint = (): Promise<void> => this.fs.checkpoint()
  processInfo = async (pid: number): Promise<ProcessInfo> => this.procs.info(pid)

  // ---- boot

  bootInfo = async (): Promise<BootInfo> => ({ ...this.boot_ })

  // ---- settings, as init (see `config.ts`)

  configGet = async (domain: string, key: string, fallback?: ConfigValue): Promise<ConfigValue> => this.sys.config.get(domain, key, fallback)
  configSet = async (domain: string, key: string, value: unknown, opts: { scope?: ConfigScope } = {}): Promise<void> =>
    this.sys.config.set(domain, key, value, opts.scope ?? 'user')
  configDelete = async (domain: string, key: string, opts: { scope?: ConfigScope } = {}): Promise<void> =>
    this.sys.config.delete(domain, key, opts.scope ?? 'user')
  configList = async (domain: string): Promise<Record<string, ConfigValue>> => this.sys.config.list(domain)
  configReset = async (domain: string, opts: { scope?: ConfigScope } = {}): Promise<void> => this.sys.config.reset(domain, opts.scope ?? 'user')
  /** Defaults and types for a domain; later writes that do not match are `EINVAL`. */
  configRegister = async (domain: string, schema: Schema): Promise<void> => this.sys.config.register(domain, schema)
  configDomains = async (): Promise<string[]> => this.sys.config.domains()

  // ---- app bundles

  /** `source`: `{path}` of a `.app` directory in the VFS, or `{files}` with the contents. `grant` gives the app every permission it declares. */
  bundleInstall = async (source: BundleSource, opts: { location?: string; grant?: boolean } = {}): Promise<BundleInfo> => {
    const info = await this.sys.bundles.install(source, opts)
    if (opts.grant || info.system) this.sys.perms.grantDeclared(info.id)
    return info
  }
  bundleUpdate = (id: string, source: BundleSource): Promise<BundleInfo> => this.sys.bundles.update(id, source)
  bundleUninstall = (id: string, opts?: { deleteData?: boolean }): Promise<void> => this.sys.bundles.uninstall(id, opts)
  bundleList = async (): Promise<BundleInfo[]> => this.sys.bundles.list()
  bundleInfo = async (id: string): Promise<BundleInfo> => this.sys.bundles.info(id)
  bundleVerify = (path: string): Promise<VerifyResult> => this.sys.bundles.verify(path)
  /** Look at the install locations again (after files were added by hand). Returns what could not be used, by path. */
  bundleRescan = async (): Promise<Record<string, string>> => {
    await this.sys.bundles.scan()
    return Object.fromEntries(this.sys.bundles.invalid)
  }

  // ---- launch services

  /** Open a bundle id, path, or URL. Resolves with the pid that has it. A file is also made available to the app that opens it. */
  launchOpen = (target: string, opts?: OpenOptions): Promise<number> => this.sys.launch.open(target, opts)
  launchOpenWith = (path: string, appId: string): Promise<number> => this.sys.launch.openWith(path, appId)
  launchApps = async (): Promise<AppRecord[]> => this.sys.launch.apps()
  launchAppsFor = (target: string): Promise<AppRecord[]> => this.sys.launch.appsFor(target)
  launchDefaultFor = async (typeOrScheme: string): Promise<AppRecord | null> => this.sys.launch.defaultFor(typeOrScheme)
  launchSetDefault = async (typeOrScheme: string, appId: string): Promise<void> => this.sys.launch.setDefault(typeOrScheme, appId)
  launchTypeOf = (path: string): Promise<TypeInfo> => this.sys.launch.typeOf(path)
  launchRunning = async (): Promise<RunningApp[]> => this.sys.launch.running()
  launchActivate = (appId: string): Promise<number> => this.sys.launch.activate(appId)
  launchRecents = async (appId?: string): Promise<RecentItem[]> => this.sys.launch.recents(appId)
  /** What to draw for a bundle id, path, or type name (see `IconInfo`). */
  launchIconFor = (target: string): Promise<IconInfo> => this.sys.launch.iconFor(target)
  /** Extensions that two definitions wanted, and which one is in effect. */
  launchTypeConflicts = async () => this.sys.launch.typeConflicts()
  /** The user decides what an extension means (`null`: back to install order). */
  launchSetTypeOwner = (ext: string, uti: string | null): Promise<void> => this.sys.launch.setTypeOwner(ext, uti)

  // ---- permissions

  /** Every capability an app declared, with its state. Without `appId`, all apps with a decision on record. */
  permList = async (appId?: string): Promise<Grant[]> => this.sys.perms.list(appId)
  permStatus = async (appId: string, capability: Capability): Promise<Status> => this.sys.perms.status(appId, capability)
  permGrant = async (appId: string, capability: Capability): Promise<void> => this.sys.perms.decide(appId, capability, 'granted')
  /** Deny from now on, and close the files the app holds open that depended on it. */
  permRevoke = async (appId: string, capability: Capability): Promise<void> => this.sys.perms.revoke(appId, capability)
  permReset = async (appId: string, capability: Capability): Promise<void> => this.sys.perms.reset(appId, capability)
  /** Desktop calls this with `true` once it can show prompts (the `permission`/`prompt` event). Without it requests are denied. */
  permSetPrompter = async (on: boolean): Promise<void> => this.sys.perms.setPrompter(on)
  permRespond = async (id: number, answer: 'granted' | 'denied'): Promise<void> => this.sys.perms.respond(id, answer)
  /** The user picked `path` in an open or save panel for this app: it may use that path (and below) while it runs. */
  permPickerGrant = async (appId: string, path: string, opts?: { write?: boolean }): Promise<void> => this.sys.perms.pickerGrant(appId, path, opts)
  /** Newest audit entries (grants, denials, refused file access). The full log is `/var/log/audit.log`. */
  permAudit = async (limit?: number): Promise<AuditEntry[]> => this.sys.perms.recent(limit)

  // ---- ports, as init (pid 1)

  portCreate = async (): Promise<number> => this.procs.ports.create(INIT_PID)
  portDestroy = async (port: number): Promise<void> => this.procs.ports.destroy(INIT_PID, port)
  send = async (port: number, data: unknown, opts?: SendOptions): Promise<void> => this.procs.ports.send(INIT_PID, port, data, opts)
  receive = (port: number, opts?: { timeout?: number }): Promise<Message> => this.procs.ports.receive(INIT_PID, port, opts?.timeout)
  register = async (name: string, port: number): Promise<void> => this.procs.ports.register(INIT_PID, name, port)
  lookup = async (name: string): Promise<number> => this.procs.ports.lookup(INIT_PID, name)
  /** Ask to be sent `{type: 'dead-name', port}` on `notify` (a port init owns) when `port` dies. */
  watch = async (port: number, notify: number): Promise<void> => this.procs.ports.watch(INIT_PID, port, notify)
  unwatch = async (port: number, notify: number): Promise<void> => this.procs.ports.unwatch(INIT_PID, port, notify)
  request = (port: number, data: unknown, opts?: { timeout?: number; rights?: number[]; transfer?: Transferable[] }): Promise<Message> =>
    request(this, port, data, opts)

  /** Ends every process (closing their files), then flushes and releases the file system. */
  async shutdown(opts: { destroy?: boolean } = {}): Promise<void> {
    await this.procs.killAll()
    if (!this.replaced) await this.sys.perms.shutdown() // after a restore it would write the old grants over the image's
    this.sys.config.flush()
    await this.logger.shutdown()
    await this.fs.unlink(SESSION_MARK).catch(() => {})
    await this.fs.shutdown(opts)
  }
}

/** Ask an app to quit (SIGTERM), then end what is left after a grace period. */
async function quitApp(procs: ProcessTable, id: string): Promise<void> {
  const pids = procs.pidsOf(id)
  for (const pid of pids) procs.kill(pid, 'SIGTERM')
  const done = Promise.all(pids.map((pid) => procs.wait(pid).catch(() => null)))
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))])
  for (const pid of procs.pidsOf(id)) procs.kill(pid, 'SIGKILL')
  await done
}

export const KERNEL_METHODS = [
  'spawn', 'kill', 'wait', 'listProcesses', 'processInfo', 'ping', 'pipe', 'stdio', 'pipeRead', 'pipeWrite', 'pipeClose',
  'driverPush', 'fsInfo', 'fsCheckpoint', 'mount', 'unmount', 'mounts', 'bookmark', 'resolveBookmark', 'removeBookmark', 'listBookmarks',
  'imageCreate', 'imageVerify', 'imageRestore', 'imageCancel', 'openpty', 'spawnPty', 'isatty', 'tcgetattr', 'tcsetattr', 'getwinsize', 'setwinsize',
  'portCreate', 'portDestroy', 'send', 'receive', 'register', 'lookup', 'watch', 'unwatch', 'request',
  'logWrite', 'logQuery', 'logExport', 'logClear', 'logFlush', 'logSubscribe', 'crashList', 'crashGet', 'crashSubmit', 'crashClear',
  'diagSnapshot', 'traceStart', 'traceMark', 'traceMeasure', 'traceStop', 'bootMarks',
  'bootInfo', 'configGet', 'configSet', 'configDelete', 'configList', 'configReset', 'configRegister', 'configDomains', 'configExternal', 'configFlush',
  'bundleInstall', 'bundleUpdate', 'bundleUninstall', 'bundleList', 'bundleInfo', 'bundleVerify', 'bundleRescan',
  'launchOpen', 'launchOpenWith', 'launchApps', 'launchAppsFor', 'launchDefaultFor', 'launchSetDefault', 'launchTypeOf', 'launchRunning', 'launchActivate', 'launchRecents', 'launchIconFor', 'launchTypeConflicts', 'launchSetTypeOwner',
  'permList', 'permStatus', 'permGrant', 'permRevoke', 'permReset', 'permSetPrompter', 'permRespond', 'permPickerGrant', 'permAudit',
] as const
export type KernelMethod = (typeof KERNEL_METHODS)[number]
