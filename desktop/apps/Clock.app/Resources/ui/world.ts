/// World clock: a grid of city tiles driven by one minute-aligned tick. The tick reads `tiny.timers`'s
/// `now` for wall-clock and system time-zone awareness and re-renders on each minute boundary.
import { tiny } from '@tiny/sdk'

export interface City {
  name: string
  zone: string
}

interface Now {
  wall: number
  monotonic: number
  timezone: string
}

interface Tile {
  city: City
  root: HTMLElement
  time: HTMLElement
  abbrev: HTMLElement
  offset: HTMLElement
}

const CATALOG: City[] = [
  { name: 'Anchorage', zone: 'America/Anchorage' },
  { name: 'Athens', zone: 'Europe/Athens' },
  { name: 'Auckland', zone: 'Pacific/Auckland' },
  { name: 'Bangkok', zone: 'Asia/Bangkok' },
  { name: 'Berlin', zone: 'Europe/Berlin' },
  { name: 'Buenos Aires', zone: 'America/Argentina/Buenos_Aires' },
  { name: 'Cairo', zone: 'Africa/Cairo' },
  { name: 'Cape Town', zone: 'Africa/Johannesburg' },
  { name: 'Chicago', zone: 'America/Chicago' },
  { name: 'Dubai', zone: 'Asia/Dubai' },
  { name: 'Hong Kong', zone: 'Asia/Hong_Kong' },
  { name: 'Honolulu', zone: 'Pacific/Honolulu' },
  { name: 'Istanbul', zone: 'Europe/Istanbul' },
  { name: 'Lagos', zone: 'Africa/Lagos' },
  { name: 'London', zone: 'Europe/London' },
  { name: 'Los Angeles', zone: 'America/Los_Angeles' },
  { name: 'Madrid', zone: 'Europe/Madrid' },
  { name: 'Mexico City', zone: 'America/Mexico_City' },
  { name: 'Moscow', zone: 'Europe/Moscow' },
  { name: 'Mumbai', zone: 'Asia/Kolkata' },
  { name: 'Nairobi', zone: 'Africa/Nairobi' },
  { name: 'New York', zone: 'America/New_York' },
  { name: 'Paris', zone: 'Europe/Paris' },
  { name: 'Rome', zone: 'Europe/Rome' },
  { name: 'Seoul', zone: 'Asia/Seoul' },
  { name: 'Singapore', zone: 'Asia/Singapore' },
  { name: 'São Paulo', zone: 'America/Sao_Paulo' },
  { name: 'Sydney', zone: 'Australia/Sydney' },
  { name: 'Tokyo', zone: 'Asia/Tokyo' },
]

const DEFAULTS = ['New York', 'London', 'Berlin', 'Tokyo', 'Sydney', 'São Paulo', 'Dubai', 'Los Angeles']

export interface World {
  /** Add the first search hit (Enter in the search field). */
  pickFirst(): void
  pause(): void
  resume(): void
}

export function createWorld(grid: HTMLElement, search: HTMLInputElement, results: HTMLElement): World {
  const tiles = new Map<string, Tile>() // by time zone, so one zone is never shown twice
  const timeFmts = new Map<string, Intl.DateTimeFormat>()
  const anchor: Now = { wall: Date.now(), monotonic: performance.now(), timezone: localZone() }
  let handle: ReturnType<typeof setTimeout> | undefined

  function localZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }

  /** `HH:MM` in a zone, built from parts so the format is stable between ICU versions. */
  function fmtTime(zone: string, at: number): string {
    let f = timeFmts.get(zone)
    if (!f) {
      f = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone })
      timeFmts.set(zone, f)
    }
    const parts = new Map(f.formatToParts(at).map((p) => [p.type, p.value]))
    const h = parts.get('hour') ?? '--'
    const m = parts.get('minute') ?? '--'
    return `${h}:${m}`
  }

  function zoneShort(zone: string, at: number): string {
    try {
      const f = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'short' })
      const part = f.formatToParts(at).find((p) => p.type === 'timeZoneName')
      return part?.value ?? ''
    } catch {
      return ''
    }
  }

  /** Minutes east of UTC for a zone at one moment: "GMT+09:30" -> 570, plain "GMT" (UTC) -> 0. */
  function offsetMinutes(zone: string, at: number): number | null {
    try {
      const f = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
      const part = f.formatToParts(at).find((p) => p.type === 'timeZoneName')
      const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part?.value ?? '')
      if (!m) return /(GMT|UTC)\b/.test(part?.value ?? '') ? 0 : null
      const sign = m[1] === '-' ? -1 : 1
      return sign * (Number(m[2]) * 60 + Number(m[3]))
    } catch {
      return null
    }
  }

  function offsetLabel(diff: number): string {
    if (diff === 0) return ''
    const a = Math.abs(diff)
    const m = a % 60
    return `${diff < 0 ? '−' : '+'}${Math.floor(a / 60)}${m ? `:${String(m).padStart(2, '0')}` : ''}`
  }

  /** Ask `tiny.timers` for the system's wall clock and time zone; fall back to what we had. */
  async function sync(): Promise<void> {
    try {
      const n = await tiny.service<Now>('tiny.timers', { op: 'now' })
      if (n && typeof n.wall === 'number' && typeof n.monotonic === 'number') {
        anchor.wall = n.wall
        anchor.monotonic = n.monotonic
        if (typeof n.timezone === 'string' && n.timezone) anchor.timezone = n.timezone
      }
    } catch {
      // offline or the service is unreachable: keep ticking on our own clocks
    }
  }

  const now = (): number => anchor.wall + (performance.now() - anchor.monotonic)

  function render(): void {
    const at = now()
    const systemOff = offsetMinutes(anchor.timezone, at)
    for (const t of tiles.values()) renderTile(t, at, systemOff)
  }

  function renderTile(t: Tile, at: number, systemOff: number | null): void {
    t.time.textContent = fmtTime(t.city.zone, at)
    t.abbrev.textContent = zoneShort(t.city.zone, at)
    const off = offsetMinutes(t.city.zone, at)
    const diff = systemOff !== null && off !== null ? off - systemOff : null
    t.offset.textContent = diff === null ? '' : offsetLabel(diff)
    t.offset.hidden = diff === null || diff === 0
  }

  function tick(): void {
    void sync().then(render)
    scheduleNext()
  }

  /** Land just past each minute boundary of the (service-provided) wall clock. */
  function scheduleNext(): void {
    clearTimeout(handle)
    const delay = 60_500 - (now() % 60_000)
    handle = setTimeout(tick, Math.max(1_100, Math.min(delay, 62_000)))
  }

  function buildTile(city: City): Tile {
    const root = document.createElement('div')
    root.className = 'tile'
    root.setAttribute('role', 'listitem')
    root.title = city.zone
    const name = document.createElement('div')
    name.className = 'city'
    name.textContent = city.name
    const time = document.createElement('div')
    time.className = 'time'
    const meta = document.createElement('div')
    meta.className = 'meta'
    const abbrev = document.createElement('span')
    const offset = document.createElement('span')
    offset.className = 'offset'
    meta.append(abbrev, offset)
    root.append(name, time, meta)
    const tile: Tile = { city, root, time, abbrev, offset }
    tiles.set(city.zone, tile)
    grid.append(root)
    return tile
  }

  function addCity(city: City): boolean {
    if (tiles.has(city.zone)) return false
    const tile = buildTile(city)
    renderTile(tile, now(), offsetMinutes(anchor.timezone, now()))
    return true
  }

  function renderResults(): void {
    const q = search.value.trim().toLowerCase()
    results.hidden = q === ''
    if (!q) return
    const hits = CATALOG.filter((c) => c.name.toLowerCase().includes(q) && !tiles.has(c.zone)).slice(0, 6)
    results.replaceChildren(
      ...hits.map((c) => {
        const b = document.createElement('button')
        b.className = 'result'
        b.setAttribute('role', 'option')
        b.append(c.name)
        const z = document.createElement('span')
        z.className = 'zone'
        z.textContent = c.zone
        b.append(z)
        b.addEventListener('click', () => {
          addCity(c)
          search.value = ''
          renderResults()
          search.focus()
        })
        return b
      }),
    )
    if (!hits.length) {
      const note = document.createElement('div')
      note.className = 'result-note dim'
      note.textContent = 'No new cities'
      results.replaceChildren(note)
    }
  }

  function pickFirst(): void {
    const first = results.querySelector<HTMLElement>('.result')
    first?.click()
  }

  search.addEventListener('input', renderResults)

  for (const n of DEFAULTS) {
    const c = CATALOG.find((x) => x.name === n)
    if (c) addCity(c)
  }
  render()
  tick()

  return {
    pickFirst,
    pause: () => clearTimeout(handle),
    resume: () => tick(),
  }
}
