import { rank, type LogEntry } from './types'

/**
 * Search text -> predicate. Words must all appear (case-insensitive) in the message, subsystem or category.
 * `subsystem:x`, `category:x`, `app:x` match part of that field; `level:x` matches that level; `pid:n` that process.
 */
export function parseQuery(text: string): (e: LogEntry) => boolean {
  const checks: Array<(e: LogEntry) => boolean> = []
  const words: string[] = []
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(subsystem|category|level|pid|app):(.*)$/i.exec(tok)
    if (!m || !m[2]) {
      words.push(tok.toLowerCase())
      continue
    }
    const v = m[2].toLowerCase()
    switch (m[1]!.toLowerCase()) {
      case 'subsystem': checks.push((e) => e.subsystem.toLowerCase().includes(v)); break
      case 'category': checks.push((e) => e.category.toLowerCase().includes(v)); break
      case 'app': checks.push((e) => (e.appId ?? '').toLowerCase().includes(v)); break
      case 'pid': checks.push((e) => String(e.pid) === v); break
      case 'level': checks.push((e) => e.level === v || (v.endsWith('+') && rank(e.level) >= rank(v.slice(0, -1)))); break
    }
  }
  if (words.length) checks.push((e) => {
    const hay = `${e.message}\n${e.subsystem}\n${e.category}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  return (e) => checks.every((c) => c(e))
}
