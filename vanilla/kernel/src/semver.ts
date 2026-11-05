/// Versions and ranges for `requires` and runtime resolution: `20.18.0`, `^20`, `~1.2`, `>=18 <22`, `1.x`, `*`, `a || b`.
export type Version = [number, number, number]

/** `20`, `20.1`, `20.1.2` (a pre-release or build suffix is ignored). Missing parts are 0. */
export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0]
  const y = parseVersion(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
  return 0
}

const cmp = (a: Version, b: Version) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  return 0
}

/** A comparator as an interval: `lo` inclusive, `hi` exclusive (null = unbounded). */
type Interval = { lo: Version | null; hi: Version | null }

/** The written parts of a partial version (`20`, `20.1`, `20.x`): how many were given, and their values. */
function parts(text: string): { given: number; v: Version } | null {
  if (text === '' || text === '*' || text === 'x' || text === 'X') return { given: 0, v: [0, 0, 0] }
  const m = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(text)
  if (!m) return null
  const num = (s: string | undefined) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s))
  const a = Number(m[1])
  const b = num(m[2])
  const c = b === null ? null : num(m[3])
  const given = b === null ? 1 : c === null ? 2 : 3
  return { given, v: [a, b ?? 0, c ?? 0] }
}

/** The first version above everything that matches a partial: `20` -> 21.0.0, `20.1` -> 20.2.0, `20.1.2` -> 20.1.3. */
const above = (p: { given: number; v: Version }): Version =>
  p.given <= 1 ? [p.v[0] + 1, 0, 0] : p.given === 2 ? [p.v[0], p.v[1] + 1, 0] : [p.v[0], p.v[1], p.v[2] + 1]

function comparator(text: string): Interval | null {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(text)!
  const op = m[1] ?? ''
  const p = parts(m[2]!)
  if (!p) return null
  if (p.given === 0) return { lo: null, hi: null }
  switch (op) {
    case '^': {
      const [a, b, c] = p.v
      // The leftmost non-zero part is the one that may not change; fewer given parts means the rest is free.
      const hi: Version = a > 0 || p.given === 1 ? [a + 1, 0, 0] : b > 0 || p.given === 2 ? [0, b + 1, 0] : [0, 0, c + 1]
      return { lo: p.v, hi }
    }
    case '~':
      return { lo: p.v, hi: p.given === 1 ? [p.v[0] + 1, 0, 0] : [p.v[0], p.v[1] + 1, 0] }
    case '>=':
      return { lo: p.v, hi: null }
    case '>':
      return { lo: above(p), hi: null }
    case '<=':
      return { lo: null, hi: above(p) }
    case '<':
      return { lo: null, hi: p.v }
    default:
      return { lo: p.v, hi: above(p) }
  }
}

function parseRange(range: string): Interval[][] | null {
  const sets: Interval[][] = []
  for (const alt of range.split('||')) {
    // "a - b" style is not supported; comparators are space separated, and "> 1" with a space is joined first.
    const tokens = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean)
    const set: Interval[] = []
    for (const t of tokens.length ? tokens : ['*']) {
      const i = comparator(t)
      if (!i) return null
      set.push(i)
    }
    sets.push(set)
  }
  return sets
}

export const validRange = (range: string): boolean => typeof range === 'string' && parseRange(range) !== null

/** Does `version` satisfy `range`? An invalid range matches nothing. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const sets = parseRange(range)
  if (!v || !sets) return false
  return sets.some((set) => set.every((i) => (!i.lo || cmp(v, i.lo) >= 0) && (!i.hi || cmp(v, i.hi) < 0)))
}
