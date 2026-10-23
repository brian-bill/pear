/// The system log, crash reports, diagnostics and traces (`contracts/logging.md`). Entries live in a ring buffer in
/// memory and are appended to `/var/log/system.log` (rotated by size); crash reports are JSON files in
/// `/var/log/crashes`. If the disk is full or the write fails, logging carries on in memory.
import { SysError } from './errors'
import { O, type FileSystem } from './fs'
import type { KernelEvent } from './process'

const LOG_FILE = '/var/log/system.log'
const CRASH_DIR = '/var/log/crashes'

export const LEVELS = ['debug', 'info', 'notice', 'error', 'fault'] as const
type LogLevel = (typeof LEVELS)[number]

export interface LogEntry {
  id: number
  time: number
  level: LogLevel
  subsystem: string
  category: string
  message: string
  data?: unknown
  pid: number | null
  appId: string | null
  /** The message and data are redacted in exports. */
  private?: boolean
}

export interface LogInput {
  level?: LogLevel
  subsystem?: string
  category?: string
  message: string
  data?: unknown
  private?: boolean
}

export interface LogFilter {
  since?: number
  until?: number
  /** This level and above. */
  level?: LogLevel
  subsystem?: string
  category?: string
  pid?: number
  appId?: string
  text?: string
  limit?: number
}

export interface CrashReport {
  id: string
  time: number
  pid: number
  name: string
  appId: string | null
  bundleId: string | null
  code: number | null
  signal: string | null
  error: string | null
  /** Last output of the process (stderr usually holds the stack). */
  stderr: string
  /** Log lines of the process shortly before the end. */
  recent: LogEntry[]
  version: string
  submitted: boolean
}

export interface Diagnostics {
  time: number
  uptime: number
  processes: Array<{ pid: number; name: string; state: string; appId: string | null; bundleId: string | null; openFds: number; uptime: number; unresponsive: boolean; uid: number }>
  ports: number
  openFiles: number
  memory: { usedJSHeapSize: number; totalJSHeapSize: number; limit: number } | null
  journal: unknown
  log: { entries: number; dropped: number; persisted: boolean; bytes: number }
  crashes: number
}

export interface Trace {
  name: string
  started: number
  marks: Array<{ label: string; at: number }>
  measures: Array<{ name: string; start: number; duration: number }>
  syscalls: Record<string, { count: number; ms: number }>
  duration?: number
}

const RING = 5000
const FLUSH_MS = 300
const SEGMENT_BYTES = 512 * 1024
const KEEP_SEGMENTS = 4
const MAX_CRASHES = 50
const RATE_PER_SECOND = 200
const MAX_MESSAGE = 4000
const MAX_DATA = 4000

const enc = new TextEncoder()
const dec = new TextDecoder()
const rank = (l: string) => LEVELS.indexOf(l as LogLevel)
const segmentPath = (i: number) => (i === 0 ? LOG_FILE : `${LOG_FILE}.${i}`)

interface Bucket {
  window: number
  count: number
  dropped: number
}

export class Logger {
  private ring: LogEntry[] = []
  private nextId = 1
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> = Promise.resolve()
  private segmentBytes = 0
  private persisted = true
  private buckets = new Map<number, Bucket>()
  private droppedTotal = 0
  private traces = new Map<string, Trace>()
  private crashes: CrashReport[] = []
  private loaded = false
  private bootMarks: Array<{ label: string; at: number }> = []
  readonly startedAt = Date.now()
  /** Send each entry to the page as a `log` event (a Console window is open). */
  live = false

  constructor(
    private fs: FileSystem,
    private emit: (e: KernelEvent) => void,
    private version: string,
  ) {}

  /** Read what earlier sessions left: the size of the current segment and the crash reports. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.segmentBytes = await this.fs.stat(LOG_FILE).then((s) => s.size, () => 0)
    try {
      const names = (await this.fs.readdir(CRASH_DIR)).map((e) => e.name).filter((n) => n.endsWith('.json')).sort()
      for (const name of names) {
        const text = dec.decode(await this.fs.readFile(`${CRASH_DIR}/${name}`))
        this.crashes.push(JSON.parse(text) as CrashReport)
      }
    } catch {
      // no crash reports yet, or one is damaged
    }
  }

  /** Record an entry. `pid` and `appId` say who wrote it; rate-limited per process. Returns false if dropped. */
  write(input: LogInput, from: { pid: number | null; appId: string | null } = { pid: null, appId: null }): boolean {
    const level = input.level ?? 'info'
    if (rank(level) < 0) throw new SysError('EINVAL', `level must be one of ${LEVELS.join(', ')}`)
    if (typeof input.message !== 'string') throw new SysError('EINVAL', 'message must be text')
    if (from.pid !== null && !this.allow(from.pid)) return false
    let data = input.data
    if (data !== undefined) {
      try {
        const text = JSON.stringify(data)
        if (text === undefined || text.length > MAX_DATA) data = text === undefined ? undefined : `${text.slice(0, MAX_DATA)}…`
      } catch {
        data = String(data)
      }
    }
    const entry: LogEntry = {
      id: this.nextId++,
      time: Date.now(),
      level,
      subsystem: String(input.subsystem ?? (from.appId ?? 'system')).slice(0, 80),
      category: String(input.category ?? 'default').slice(0, 80),
      message: input.message.length > MAX_MESSAGE ? `${input.message.slice(0, MAX_MESSAGE)}…` : input.message,
      pid: from.pid,
      appId: from.appId,
    }
    if (data !== undefined) entry.data = data
    if (input.private) entry.private = true
    this.ring.push(entry)
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING)
    this.pending.push(JSON.stringify(entry))
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS)
    if (this.live) this.emit({ type: 'log', entry })
    return true
  }

  private allow(pid: number): boolean {
    const now = Math.floor(Date.now() / 1000)
    let b = this.buckets.get(pid)
    if (!b || b.window !== now) {
      if (b?.dropped) {
        // say so once the burst is over
        this.buckets.set(pid, { window: now, count: 1, dropped: 0 })
        this.noteDropped(pid, b.dropped)
        return true
      }
      b = { window: now, count: 0, dropped: 0 }
      this.buckets.set(pid, b)
    }
    if (b.count >= RATE_PER_SECOND) {
      b.dropped++
      this.droppedTotal++
      return false
    }
    b.count++
    return true
  }

  forget(pid: number): void {
    const dropped = this.buckets.get(pid)?.dropped
    if (dropped) this.noteDropped(pid, dropped)
    this.buckets.delete(pid)
  }

  private noteDropped(pid: number, dropped: number): void {
    this.write({ level: 'notice', subsystem: 'logging', message: `${dropped} log entries dropped (rate limit)`, data: { pid } })
  }

  /** Write pending lines out now; `durable` also makes them survive a power cut. */
  async flush(durable = false): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    const lines = this.pending.splice(0)
    if (!lines.length) return durable ? this.writing.then(() => this.fs.flush().catch(() => {})) : this.writing
    const data = enc.encode(`${lines.join('\n')}\n`)
    this.writing = this.writing.then(async () => {
      try {
        if (this.segmentBytes + data.length > SEGMENT_BYTES) await this.rotate()
        await this.fs.mkdir('/var/log', { recursive: true, mode: 0o755 }).catch(() => {})
        const fd = await this.fs.open(LOG_FILE, O.WRONLY | O.CREAT | O.APPEND, 0o644)
        try {
          await this.fs.write(fd, data)
        } finally {
          await this.fs.close(fd)
        }
        this.segmentBytes += data.length
        this.persisted = true
      } catch {
        this.persisted = false // quota or I/O: keep logging in memory only
      }
    })
    if (durable) await this.writing.then(() => this.fs.flush().catch(() => {}))
    return this.writing
  }

  private async rotate(): Promise<void> {
    await this.fs.unlink(segmentPath(KEEP_SEGMENTS)).catch(() => {})
    for (let i = KEEP_SEGMENTS - 1; i >= 0; i--) await this.fs.rename(segmentPath(i), segmentPath(i + 1)).catch(() => {})
    this.segmentBytes = 0
  }

  private matches(e: LogEntry, f: LogFilter): boolean {
    if (f.since !== undefined && e.time < f.since) return false
    if (f.until !== undefined && e.time > f.until) return false
    if (f.level && rank(e.level) < rank(f.level)) return false
    if (f.subsystem !== undefined && e.subsystem !== f.subsystem) return false
    if (f.category !== undefined && e.category !== f.category) return false
    if (f.pid !== undefined && e.pid !== f.pid) return false
    if (f.appId !== undefined && e.appId !== f.appId) return false
    if (f.text && !e.message.toLowerCase().includes(f.text.toLowerCase())) return false
    return true
  }

  /** Newest `limit` matching entries (default 200), oldest first. Looks at memory, and at the files if `since` is older than the ring. */
  async query(f: LogFilter = {}): Promise<LogEntry[]> {
    const limit = Math.max(1, Math.min(f.limit ?? 200, 5000))
    let source: LogEntry[] = this.ring
    if (f.since !== undefined && (this.ring[0]?.time ?? Infinity) > f.since) {
      await this.flush()
      source = await this.readFiles()
    }
    const out: LogEntry[] = []
    for (let i = source.length - 1; i >= 0 && out.length < limit; i--) if (this.matches(source[i]!, f)) out.push(source[i]!)
    return out.reverse()
  }

  private async readFiles(): Promise<LogEntry[]> {
    const all: LogEntry[] = []
    for (let i = KEEP_SEGMENTS; i >= 0; i--) {
      let text: string
      try {
        text = dec.decode(await this.fs.readFile(segmentPath(i)))
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          all.push(JSON.parse(line) as LogEntry)
        } catch {
          // a torn last line after a crash
        }
      }
    }
    return all
  }

  /** The entries in `range` as text (JSON lines); private ones are redacted. */
  async export(range: { since?: number; until?: number; includePrivate?: boolean } = {}): Promise<string> {
    const entries = await this.query({ since: range.since, until: range.until, limit: 5000 })
    return entries
      .map((e) => JSON.stringify(e.private && !range.includePrivate ? { ...e, message: '<private>', data: undefined } : e))
      .join('\n')
  }

  async clear(): Promise<void> {
    this.ring = []
    this.pending = []
    this.segmentBytes = 0
    await this.writing
    for (let i = 0; i <= KEEP_SEGMENTS; i++) await this.fs.unlink(segmentPath(i)).catch(() => {})
  }

  stats() {
    return { entries: this.ring.length, dropped: this.droppedTotal, persisted: this.persisted, bytes: this.segmentBytes }
  }

  async recordCrash(c: Omit<CrashReport, 'id' | 'time' | 'recent' | 'version' | 'submitted'>): Promise<CrashReport> {
    const time = Date.now()
    const report: CrashReport = {
      ...c,
      id: `${time.toString(36)}-${c.pid}`,
      time,
      recent: this.ring.filter((e) => e.pid === c.pid).slice(-20),
      version: this.version,
      submitted: false,
    }
    this.crashes.push(report)
    this.write({ level: 'fault', subsystem: 'crash', message: `${c.name} (pid ${c.pid}) crashed${c.error ? `: ${c.error}` : ''}`, data: { id: report.id } }, { pid: null, appId: c.appId })
    try {
      await this.fs.mkdir(CRASH_DIR, { recursive: true, mode: 0o755 })
      await this.fs.writeFileAtomic(`${CRASH_DIR}/${report.id}.json`, enc.encode(JSON.stringify(report)))
      while (this.crashes.length > MAX_CRASHES) {
        const old = this.crashes.shift()!
        await this.fs.unlink(`${CRASH_DIR}/${old.id}.json`).catch(() => {})
      }
      await this.fs.flush()
    } catch {
      // the report stays in memory
    }
    this.emit({ type: 'crash', event: 'reported', report })
    return report
  }

  crashList(): Array<Omit<CrashReport, 'recent' | 'stderr'>> {
    return this.crashes.map(({ recent: _r, stderr: _s, ...rest }) => rest)
  }

  crashGet(id: string): CrashReport {
    const r = this.crashes.find((c) => c.id === id)
    if (!r) throw new SysError('ENOENT', `no crash report ${id}`)
    return r
  }

  /** The user chose to share it: marks it, and tells subscribers (nothing leaves the browser by itself). */
  async crashSubmit(id: string): Promise<CrashReport> {
    const r = this.crashGet(id)
    r.submitted = true
    await this.fs.writeFileAtomic(`${CRASH_DIR}/${r.id}.json`, enc.encode(JSON.stringify(r))).catch(() => {})
    this.emit({ type: 'crash', event: 'submitted', report: r })
    return r
  }

  async crashClear(): Promise<void> {
    for (const c of this.crashes.splice(0)) await this.fs.unlink(`${CRASH_DIR}/${c.id}.json`).catch(() => {})
  }

  // ---- traces and boot marks

  /** A mark from the boot path; kept for `traceStart` to include. */
  mark(label: string): void {
    const at = performance.now()
    this.bootMarks.push({ label, at })
    for (const t of this.traces.values()) t.marks.push({ label, at: at - t.started })
  }

  traceStart(name: string): void {
    if (this.traces.has(name)) throw new SysError('EEXIST', `trace ${name} is running`)
    if (this.traces.size >= 8) throw new SysError('EMFILE', 'too many traces')
    this.traces.set(name, { name, started: performance.now(), marks: [], measures: [], syscalls: {} })
  }

  traceMark(name: string, label: string): void {
    const t = this.traces.get(name)
    if (!t) throw new SysError('ENOENT', `no trace ${name}`)
    t.marks.push({ label, at: performance.now() - t.started })
  }

  /** Time from the mark `from` to the mark `to` (or now). */
  traceMeasure(name: string, measure: string, from: string, to?: string): void {
    const t = this.traces.get(name)
    if (!t) throw new SysError('ENOENT', `no trace ${name}`)
    const a = t.marks.find((m) => m.label === from)
    const b = to === undefined ? { at: performance.now() - t.started } : t.marks.find((m) => m.label === to)
    if (!a || !b) throw new SysError('ENOENT', 'no such mark')
    t.measures.push({ name: measure, start: a.at, duration: b.at - a.at })
  }

  traceStop(name: string): Trace {
    const t = this.traces.get(name)
    if (!t) throw new SysError('ENOENT', `no trace ${name}`)
    this.traces.delete(name)
    t.duration = performance.now() - t.started
    return t
  }

  get tracing(): boolean {
    return this.traces.size > 0
  }

  /** Called around every process syscall while a trace runs. */
  syscall(call: string, ms: number): void {
    for (const t of this.traces.values()) {
      const s = (t.syscalls[call] ??= { count: 0, ms: 0 })
      s.count++
      s.ms += ms
    }
  }

  /** Marks the boot path left, relative to the first. */
  boot(): Array<{ label: string; at: number }> {
    const t0 = this.bootMarks[0]?.at ?? 0
    return this.bootMarks.map((m) => ({ label: m.label, at: m.at - t0 }))
  }

  async shutdown(): Promise<void> {
    await this.flush()
  }
}
