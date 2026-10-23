import type { Chapter } from './store'

/** A book's plain text becomes chapters: blank-line groups; a `#` heading or a "Chapter 12" line
 *  starts a new chapter, everything between headings is its paragraphs. */
export function chaptersOf(text: string): Chapter[] {
  const groups = text
    .split(/\n\s*\n/)
    .map((g) => g.trim())
    .filter(Boolean)
  const out: Chapter[] = []
  for (const g of groups) {
    if (/^#+\s/.test(g) || /^Chapter\s+\d/.test(g)) {
      const lines = g.split('\n')
      const first = (lines[0] ?? g).replace(/^#+\s*/, '').trim()
      const rest = lines.slice(1).join('\n').trim()
      const ch: Chapter = { title: first || 'Untitled', paragraphs: [] }
      if (rest) ch.paragraphs.push(rest)
      out.push(ch)
    } else if (out.length > 0) {
      const last = out[out.length - 1]
      if (last) last.paragraphs.push(g)
    } else {
      out.push({ title: '', paragraphs: [g] })
    }
  }
  return out.length > 0 ? out : [{ title: '', paragraphs: [] }]
}
