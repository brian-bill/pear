/** The Freeform board: plain, JSON-safe data without behaviour. Coordinates are board units (px at 100% zoom). */

export type Kind = 'path' | 'rect' | 'ellipse' | 'note'
export type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'note'

export interface Item {
  id: string
  kind: Kind
  x: number
  y: number
  /** For rect/ellipse/note. Pen strokes derive theirs from `points` on commit (and are stored too). */
  w?: number
  h?: number
  /** Pen strokes only: [dx, dy, dx, dy, ...] relative to x/y. */
  points?: number[]
  /** Stroke colour, stored as a theme token ('var(--text)') so boards re-theme. */
  stroke?: string
  /** Stroke width in board units. */
  sw?: number
  fill?: string
  /** Notes only. */
  text?: string
}

export interface Box { x: number; y: number; w: number; h: number }

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 8

let seq = 0
export const newId = (): string => `i${Date.now().toString(36)}${(++seq).toString(36)}`
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** A drag rectangle made normal (x/y at the top left). */
export function normRect(x0: number, y0: number, x1: number, y1: number): Box {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

/** True bounds of an item; recovers pen-stroke bounds from `points` rather than trusting stored w/h. */
export function bounds(item: Item): Box {
  if (item.kind === 'path') {
    const p = item.points ?? []
    let x0 = item.x
    let y0 = item.y
    let x1 = item.x
    let y1 = item.y
    for (let i = 0; i < p.length; i += 2) {
      const ax = item.x + (p[i] ?? 0)
      const ay = item.y + (p[i + 1] ?? 0)
      x0 = Math.min(x0, ax)
      y0 = Math.min(y0, ay)
      x1 = Math.max(x1, ax)
      y1 = Math.max(y1, ay)
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  return { x: item.x, y: item.y, w: Math.max(0, item.w ?? 0), h: Math.max(0, item.h ?? 0) }
}

const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1)
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Does a point in board space hit the item? `zoom` scales how forgiving the test is on screen. */
export function hits(item: Item, px: number, py: number, zoom: number): boolean {
  const b = bounds(item)
  const pad = 6 / zoom + (item.kind === 'note' ? 0 : (item.sw ?? 0) / 2)
  if (item.kind === 'path') {
    const p = item.points ?? []
    if (p.length < 4) return false
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (distToSegment(px, py, item.x + (p[i] ?? 0), item.y + (p[i + 1] ?? 0), item.x + (p[i + 2] ?? 0), item.y + (p[i + 3] ?? 0)) <= pad) return true
    }
    return false
  }
  return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad
}

/** Path data for a stroke, from points relative to x/y. */
export function pathOf(item: Item): string {
  const p = item.points ?? []
  if (p.length < 4) return ''
  let d = `M${(item.x + (p[0] ?? 0)).toFixed(1)} ${(item.y + (p[1] ?? 0)).toFixed(1)}`
  for (let i = 2; i < p.length; i += 2) d += ` L${(item.x + (p[i] ?? 0)).toFixed(1)} ${(item.y + (p[i + 1] ?? 0)).toFixed(1)}`
  return d
}

/** Read a board from file text. Throws with a human message; tolerant of junk items rather than of junk files. */
export function parseBoard(text: string): Item[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('The file is not valid JSON.')
  }
  const d = (data ?? {}) as { version?: unknown; items?: unknown }
  if (d.version !== 1 || !Array.isArray(d.items)) throw new Error('It is not a Freeform board.')
  const items: Item[] = []
  for (const raw of d.items as unknown[]) {
    const it = (raw ?? {}) as Partial<Record<keyof Item, unknown>>
    const kind = it.kind
    if (kind !== 'path' && kind !== 'rect' && kind !== 'ellipse' && kind !== 'note') continue
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const x = num(it.x)
    const y = num(it.y)
    if (x === undefined || y === undefined) continue
    const item: Item = { id: typeof it.id === 'string' && it.id ? it.id : newId(), kind, x, y }
    for (const [key, value] of Object.entries({ w: num(it.w), h: num(it.h), sw: num(it.sw) })) {
      if (value !== undefined) item[key as 'w' | 'h' | 'sw'] = value
    }
    if (Array.isArray(it.points)) {
      const pts = (it.points as unknown[]).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      const even = pts.length - (pts.length % 2)
      if (even >= 4) item.points = pts.slice(0, even)
    }
    if (typeof it.stroke === 'string') item.stroke = it.stroke
    if (typeof it.fill === 'string') item.fill = it.fill
    if (typeof it.text === 'string') item.text = it.text
    items.push(item)
  }
  return items
}
