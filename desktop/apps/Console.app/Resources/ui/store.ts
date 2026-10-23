import { tiny } from '@tiny/sdk'
import { parseQuery } from './query'
import { rank, type Level, type LogEntry } from './types'

const MAX_KEPT = 20_000

export const procKey = (e: LogEntry) => e.appId ?? (e.pid ? `pid ${e.pid}` : 'system')

export interface Filter {
  /** `errors`: error and fault only. */
  section: 'all' | 'errors'
  subsystem: string | null
  proc: string | null
  level: Level
  text: string
}

/** Every log entry we have seen, the filtered view of them, and the polling that keeps both current. */
export class LogStore {
  all: LogEntry[] = []
  shown: LogEntry[] = []
  subsystems = new Map<string, number>()
  procs = new Map<string, number>()
  filter: Filter = { section: 'all', subsystem: null, proc: null, level: 'debug', text: '' }
  paused = false
  private pred: (e: LogEntry) => boolean = () => true
  private lastTime = 0
  private lastIds = new Set<number>()

  private matches(e: LogEntry): boolean {
    const f = this.filter
    if (f.section === 'errors' && rank(e.level) < rank('error')) return false
    if (rank(e.level) < rank(f.level)) return false
    if (f.subsystem !== null && e.subsystem !== f.subsystem) return false
    if (f.proc !== null && procKey(e) !== f.proc) return false
    return this.pred(e)
  }

  refilter(): void {
    this.pred = parseQuery(this.filter.text)
    this.shown = this.all.filter((e) => this.matches(e))
  }

  private count(e: LogEntry): void {
    this.subsystems.set(e.subsystem, (this.subsystems.get(e.subsystem) ?? 0) + 1)
    this.procs.set(procKey(e), (this.procs.get(procKey(e)) ?? 0) + 1)
  }

  /** Fetch what is new. Returns how many entries arrived. */
  async poll(): Promise<number> {
    const got = await tiny.admin.kernel<LogEntry[]>('logQuery', this.lastTime ? { since: this.lastTime, limit: 1000 } : { limit: 5000 })
    const fresh = got.filter((e) => e.time > this.lastTime || (e.time === this.lastTime && !this.lastIds.has(e.id)))
    if (!fresh.length) return 0
    const newest = Math.max(this.lastTime, ...fresh.map((e) => e.time))
    if (newest > this.lastTime) this.lastIds = new Set()
    this.lastTime = newest
    for (const e of fresh) {
      if (e.time === newest) this.lastIds.add(e.id)
      this.count(e)
      this.all.push(e)
      if (this.matches(e)) this.shown.push(e)
    }
    if (this.all.length > MAX_KEPT) {
      this.all.splice(0, this.all.length - MAX_KEPT)
      this.refilter()
    }
    return fresh.length
  }

  reset(): void {
    this.all = []
    this.shown = []
    this.subsystems.clear()
    this.procs.clear()
    this.lastTime = 0
    this.lastIds.clear()
  }
}
