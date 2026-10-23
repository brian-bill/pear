/** The parts of Vanilla's replies this app reads (see vanilla/kernel/src/process.ts and log.ts). */
export interface ProcessInfo {
  pid: number
  ppid: number
  name: string
  path: string
  args: string[]
  state: 'running' | 'zombie'
  startedAt: number
  exitedAt: number | null
  cwd: string
  pgid: number
  sid: number
  openFds: number
  unresponsive: boolean
  status: unknown
  uid: number
  gid: number
  bundleId: string | null
  kind: string | null
  appId: string | null
}

export interface Diagnostics {
  time: number
  uptime: number
  processes: Array<{ pid: number }>
  ports: number
  openFiles: number
  memory: { usedJSHeapSize: number; totalJSHeapSize: number; limit: number } | null
  journal: Record<string, number> | null
  log: { entries: number; dropped: number; persisted: boolean; bytes: number }
  crashes: number
}

/** What one refresh gathered; every tab draws from it. */
export interface Sample {
  now: number
  snap: Diagnostics
  procs: ProcessInfo[]
  /** App ids to display names. */
  appNames: Map<string, string>
}

export interface Tab {
  id: string
  title: string
  el: HTMLElement
  /** Called on every refresh while this tab is showing, and when it is shown. */
  update(s: Sample): Promise<void> | void
}
