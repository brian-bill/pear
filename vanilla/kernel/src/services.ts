/// Supervision for `kind: "service"` bundles: boot start, stop/start/restart, restart policy with back-off,
/// enable/disable per user, state events and logs. A service is an ordinary bundle process that registers a named port;
/// this module only decides when it runs.
import { SysError } from './errors'
import type { FileSystem } from './fs'
import type { BundleInfo, BundleManager } from './bundle'
import type { CommandRegistry } from './commands'
import type { LaunchServices } from './launch'
import type { Logger } from './log'
import type { ExitStatus, ProcessTable } from './process'

const STATE_FILE = '/var/db/services.json'
/** Restarts older than this no longer count towards `maxRestarts`. */
const WINDOW_MS = 5 * 60 * 1000
const MAX_DELAY_MS = 60_000
const STOP_GRACE_MS = 3000
const enc = new TextEncoder()
const dec = new TextDecoder()

export type ServiceState = 'stopped' | 'starting' | 'running' | 'failed'

export interface ServiceInfo {
  /** The bundle id (a development service has its project's id). */
  id: string
  /** The port name it registers. */
  name: string
  bundleName: string
  state: ServiceState
  pid: number | null
  /** When the current run started (ms since epoch), or null. */
  started: number | null
  /** Restarts in the last five minutes. */
  restarts: number
  lastExit: { code: number | null; signal: string | null; at: number } | null
  /** Starts at boot for this user (the manifest's `autostart`, unless `enable`/`disable` changed it). */
  enabled: boolean
  /** Why it is stopped or failed, when the system knows. */
  reason: string | null
  /** The project folder of a service started from a project, not installed. */
  project: string | null
  system: boolean
}

export type ServiceEvent = { type: 'service'; event: 'state'; id: string; state: ServiceState; pid: number | null; reason: string | null }

export interface LogLine {
  time: number
  stream: 'stdout' | 'stderr'
  message: string
}

interface Run {
  bundle: BundleInfo
  project: string | null
  state: ServiceState
  pid: number | null
  started: number | null
  restartTimes: number[]
  lastExit: ServiceInfo['lastExit']
  reason: string | null
  stopping: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface Persisted {
  /** bundle id -> the user's choice, over the manifest's `autostart` */
  enabled: Record<string, boolean>
}

export class ServiceManager {
  private runs = new Map<string, Run>()
  private persisted: Persisted = { enabled: {} }
  private loaded = false
  listeners: Array<(e: ServiceEvent) => void> = []

  constructor(
    private fs: FileSystem,
    private bundles: BundleManager,
    private commands: CommandRegistry,
    private launch: LaunchServices,
    private procs: ProcessTable,
    private logger: Logger | undefined,
    private emit: (e: ServiceEvent) => void,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(dec.decode(await this.fs.readFile(STATE_FILE))) as Partial<Persisted>
      this.persisted = { enabled: { ...raw.enabled } }
    } catch {
      this.persisted = { enabled: {} }
    }
  }

  private async save(): Promise<void> {
    await this.fs.mkdir('/var/db', { recursive: true })
    await this.fs.writeFile(STATE_FILE, enc.encode(JSON.stringify(this.persisted, null, 2)))
  }

  private set(run: Run, state: ServiceState, reason: string | null = null): void {
    run.state = state
    run.reason = reason
    const e: ServiceEvent = { type: 'service', event: 'state', id: run.bundle.id, state, pid: run.pid, reason }
    this.emit(e)
    for (const l of this.listeners) l(e)
  }

  // ------------------------------------------------------------------ queries

  private isEnabled(b: BundleInfo): boolean {
    return this.persisted.enabled[b.id] ?? b.autostart
  }

  private describe(run: Run | undefined, b: BundleInfo): ServiceInfo {
    return {
      id: b.id,
      name: b.service?.name ?? b.id,
      bundleName: b.name,
      state: run?.state ?? 'stopped',
      pid: run?.pid ?? null,
      started: run?.started ?? null,
      restarts: run ? this.recent(run).length : 0,
      lastExit: run?.lastExit ?? null,
      enabled: this.isEnabled(b),
      reason: run?.reason ?? null,
      project: run?.project ?? null,
      system: b.system,
    }
  }

  private recent(run: Run): number[] {
    const cutoff = Date.now() - WINDOW_MS
    run.restartTimes = run.restartTimes.filter((t) => t > cutoff)
    return run.restartTimes
  }

  list(): ServiceInfo[] {
    const out = new Map<string, ServiceInfo>()
    for (const b of this.bundles.list()) if (b.kind === 'service') out.set(b.id, this.describe(this.runs.get(b.id), b))
    for (const [id, run] of this.runs) if (!out.has(id)) out.set(id, this.describe(run, run.bundle))
    return [...out.values()].sort((a, b) => a.bundleName.localeCompare(b.bundleName) || a.id.localeCompare(b.id))
  }

  get(id: string): ServiceInfo {
    const found = this.list().find((s) => s.id === id)
    if (!found) throw new SysError('ENOENT', `no service ${id}`)
    return found
  }

  // ------------------------------------------------------------------ control

  /** Which bundle `idOrPath` means: an installed service, or a project folder (a development service). */
  private async resolve(idOrPath: string): Promise<{ bundle: BundleInfo; project: string | null }> {
    if (idOrPath.startsWith('/')) {
      const bundle = await this.commands.project(idOrPath)
      if (bundle.kind !== 'service') throw new SysError('EINVAL', `${bundle.name} is not a service`)
      return { bundle, project: bundle.path }
    }
    const bundle = this.bundles.find(idOrPath)
    if (bundle) {
      if (bundle.kind !== 'service') throw new SysError('EINVAL', `${bundle.name} is not a service`)
      return { bundle, project: null }
    }
    const run = this.runs.get(idOrPath)
    if (run) return { bundle: run.bundle, project: run.project }
    throw new SysError('ENOENT', `no service ${idOrPath}`)
  }

  /** Start a service. Resolves with its pid. A service that cannot start stays `stopped` (process limit) or becomes `failed`. */
  async start(idOrPath: string): Promise<number> {
    await this.load()
    const { bundle, project } = await this.resolve(idOrPath)
    let run = this.runs.get(bundle.id)
    if (run && (run.state === 'running' || run.state === 'starting')) return run.pid!
    if (!run) {
      run = { bundle, project, state: 'stopped', pid: null, started: null, restartTimes: [], lastExit: null, reason: null, stopping: false, timer: null }
      this.runs.set(bundle.id, run)
    }
    run.bundle = bundle
    run.project = project
    if (run.timer) clearTimeout(run.timer)
    run.timer = null
    run.stopping = false
    return this.spawnRun(run)
  }

  private async spawnRun(run: Run): Promise<number> {
    this.set(run, 'starting')
    try {
      const pid = await this.launch.spawn(run.bundle, [], { background: true, supervised: !run.bundle.system })
      run.pid = pid
      run.started = Date.now()
      this.set(run, 'running')
      void this.procs.wait(pid).then((status) => this.exited(run, pid, status), () => {})
      return pid
    } catch (e) {
      const err = e as SysError
      run.pid = null
      if (err.code === 'EAGAIN') {
        this.set(run, 'stopped', `not started: ${err.message}`)
      } else {
        this.set(run, 'failed', err.message)
        this.log(run, 'error', `failed to start: ${err.message}`)
      }
      throw err
    }
  }

  private exited(run: Run, pid: number, status: ExitStatus): void {
    if (run.pid !== pid) return
    run.pid = null
    run.started = null
    run.lastExit = { code: status.code, signal: status.signal, at: Date.now() }
    const detail = status.signal ? `ended by ${status.signal}` : `exited with status ${status.code ?? '?'}`
    if (run.stopping) {
      run.stopping = false
      this.set(run, 'stopped', 'stopped')
      return
    }
    const failure = status.crashed || status.signal !== null || (status.code ?? 0) !== 0
    const text = `${status.error ?? ''}${status.stderr ?? ''}`
    this.log(run, failure ? 'error' : 'info', `service ${detail}${status.error ? `: ${status.error}` : ''}`)
    // Its port name is held by another process: restarting cannot help.
    if (failure && /EEXIST|already registered/.test(text)) return this.set(run, 'failed', `${detail}: the port name is already registered (EEXIST)`)
    const policy = run.bundle.service?.restart ?? 'never'
    const again = policy === 'always' || (policy === 'on-failure' && failure)
    if (!again) return this.set(run, failure ? 'failed' : 'stopped', failure ? detail : 'finished')
    const times = this.recent(run)
    const max = run.bundle.service?.maxRestarts ?? 5
    if (times.length >= max) return this.set(run, 'failed', `${detail}; gave up after ${times.length} restarts in five minutes`)
    const base = run.bundle.service?.restartDelayMs ?? 1000
    const delay = Math.min(MAX_DELAY_MS, Math.max(base, base * 2 ** times.length))
    times.push(Date.now())
    this.set(run, 'stopped', `${detail}; restarting in ${Math.round(delay / 100) / 10}s`)
    run.timer = setTimeout(() => {
      run.timer = null
      if (run.stopping) return
      this.spawnRun(run).catch(() => {})
    }, delay)
  }

  /** SIGTERM, then SIGKILL after three seconds. Resolves when the process is gone. */
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) {
      this.get(id)
      return
    }
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = null
      this.set(run, 'stopped', 'stopped')
    }
    const pid = run.pid
    if (pid === null) return
    run.stopping = true
    this.procs.kill(pid, 'SIGTERM')
    const gone = this.procs.wait(pid).catch(() => null)
    const killed = await Promise.race([gone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), STOP_GRACE_MS))])
    if (!killed) {
      this.procs.kill(pid, 'SIGKILL')
      await gone
    }
  }

  async restart(id: string): Promise<number> {
    await this.stop(id)
    const run = this.runs.get(id)
    if (run) run.restartTimes = []
    return this.start(run?.project ?? id)
  }

  /** Start at boot for this user (does not change the manifest). */
  async enable(id: string): Promise<void> {
    await this.load()
    this.get(id)
    this.persisted.enabled[id] = true
    await this.save()
    this.broadcast(id)
  }

  async disable(id: string): Promise<void> {
    await this.load()
    this.get(id)
    this.persisted.enabled[id] = false
    await this.save()
    this.broadcast(id)
  }

  private broadcast(id: string): void {
    const run = this.runs.get(id)
    const e: ServiceEvent = { type: 'service', event: 'state', id, state: run?.state ?? 'stopped', pid: run?.pid ?? null, reason: run?.reason ?? null }
    this.emit(e)
    for (const l of this.listeners) l(e)
  }

  /** The service's console output (stdout and stderr), oldest first. */
  async logs(id: string, opts: { since?: number; limit?: number } = {}): Promise<LogLine[]> {
    this.get(id)
    if (!this.logger) return []
    const entries = await this.logger.query({ appId: id, category: 'console', since: opts.since, limit: opts.limit ?? 500 })
    const service = await this.logger.query({ subsystem: id, category: 'service', since: opts.since, limit: opts.limit ?? 500 })
    return [...entries, ...service]
      .sort((a, b) => a.time - b.time || a.id - b.id)
      .map((e) => ({ time: e.time, stream: e.level === 'error' || e.level === 'fault' ? ('stderr' as const) : ('stdout' as const), message: e.message }))
  }

  private log(run: Run, level: 'info' | 'error', message: string): void {
    this.logger?.write({ level, subsystem: run.bundle.id, category: 'service', message }, { pid: null, appId: null })
  }

  // ------------------------------------------------------------------ boot

  /**
   * Start every service that is enabled. Third-party services wait for a normal boot (not safe mode); a service that
   * cannot start does not stop the boot. System services must start: their error is returned to the caller.
   */
  async boot(safeMode: boolean, only?: (b: BundleInfo) => boolean): Promise<Array<{ bundle: BundleInfo; error?: Error }>> {
    await this.load()
    const out: Array<{ bundle: BundleInfo; error?: Error }> = []
    for (const b of this.bundles.list()) {
      if (b.kind !== 'service' || !this.isEnabled(b)) continue
      if (safeMode && !b.system) continue
      if (only && !only(b)) continue
      if (this.procs.pidsOf(b.id).length) continue
      try {
        await this.start(b.id)
        out.push({ bundle: b })
      } catch (e) {
        if (b.system) throw e
        out.push({ bundle: b, error: e as Error })
      }
    }
    return out
  }
}
