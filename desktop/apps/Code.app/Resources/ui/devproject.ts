// What Code needs to know about a console project (a `tool` or `service` bundle) from its manifest.

export interface ConsoleManifest {
  kind: 'tool' | 'service'
  /** The program, relative to the project. */
  entry: string
  /** The command names the manifest declares (a name, or an object with a `name`). */
  commands: string[]
}

/** The console facts of a parsed manifest, or null for any other project. */
export function consoleManifest(m: unknown): ConsoleManifest | null {
  if (!m || typeof m !== 'object') return null
  const o = m as { kind?: unknown; entry?: unknown; commands?: unknown }
  if (o.kind !== 'tool' && o.kind !== 'service') return null
  const commands: string[] = []
  if (Array.isArray(o.commands)) {
    for (const c of o.commands) {
      const name = typeof c === 'string' ? c : c && typeof c === 'object' ? (c as { name?: unknown }).name : undefined
      if (typeof name === 'string' && name && !commands.includes(name)) commands.push(name)
    }
  }
  return { kind: o.kind, entry: typeof o.entry === 'string' && o.entry ? o.entry : 'main.js', commands }
}

/** Do two command lists name the same commands in the same order? */
export const sameCommands = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((n, i) => n === b[i])

/** Why a link or service call failed, in words for the status bar. */
export function devError(e: unknown): string {
  const err = e as { code?: string; message?: string }
  const msg = err?.message || String(e)
  return err?.code && !msg.includes(err.code) ? `${err.code}: ${msg}` : msg
}

export function stateLine(s: { name: string; state: string; pid: number | null; reason: string | null; restarts: number }): string {
  const bits = [`${s.name}: ${s.state}`]
  if (s.pid !== null && s.state === 'running') bits.push(`pid ${s.pid}`)
  if (s.restarts > 0) bits.push(`${s.restarts} restart${s.restarts === 1 ? '' : 's'}`)
  if (s.reason) bits.push(s.reason)
  return bits.join(' · ')
}
