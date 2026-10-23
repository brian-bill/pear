/** The shapes Vanilla returns (vanilla/kernel/src/log.ts, perm.ts). */
export type Level = 'debug' | 'info' | 'notice' | 'error' | 'fault'
export const LEVELS: Level[] = ['debug', 'info', 'notice', 'error', 'fault']
export const rank = (l: string) => LEVELS.indexOf(l as Level)

export interface LogEntry {
  id: number
  time: number
  level: Level
  subsystem: string
  category: string
  message: string
  data?: unknown
  pid: number | null
  appId: string | null
  private?: boolean
}

export interface CrashSummary {
  id: string
  time: number
  pid: number
  name: string
  appId: string | null
  bundleId: string | null
  code: number | null
  signal: string | null
  error: string | null
  version: string
  submitted: boolean
}

export interface CrashReport extends CrashSummary {
  stderr: string
  recent: LogEntry[]
}

export interface AuditEntry {
  time: number
  event: string
  appId: string | null
  pid: number | null
  capability?: string
  path?: string
  call?: string
  detail?: string
}

export interface Pane {
  el: HTMLElement
  /** The pane was shown. */
  show(): void
  /** Called about once a second while the window is visible. */
  tick(): void | Promise<void>
}
