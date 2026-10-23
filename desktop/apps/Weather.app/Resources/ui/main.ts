/// Weather: city forecasts from open-meteo.com (geocoding + forecast, no key). Saved places persist
/// as JSON in ~/Library/Weather.json; every request goes through the `tiny.network` service because
/// windows are sandboxed without network access.
import { bytesOf, tiny } from '@tiny/sdk'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const FILE = '/Users/pear/Library/Weather.json'
const GEO = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'

interface Place {
  id: number
  name: string
  country?: string
  latitude: number
  longitude: number
}
interface Forecast {
  current: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number }
  daily: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] }
}
interface GeoReply { results?: Place[] }
interface NetReply { status: number; statusText: string; body: Uint8Array | number[] }

/** WMO code → a plain-words description of the sky (the common codes). */
const WMO: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Sleet drizzle', 57: 'Freezing drizzle',
  61: 'Rain', 63: 'Heavy rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Rain showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
}
const skyOf = (code: number) => WMO[code] ?? 'Unknown'

const decodeBytes = (b: Uint8Array | number[]): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b))
const codeOf = (e: unknown): string =>
  (e as { code?: string } | null)?.code ?? 'EIO'
const messageOf = (e: unknown): string => ((e as { message?: string } | null)?.message ?? String(e))

/** Fetch a URL through the `tiny.network` service and decode its JSON body. */
async function fetchJson<T>(url: string): Promise<T> {
  const r = await tiny.service<NetReply>('tiny.network', { op: 'fetch', url })
  if (r.status >= 400) throw Object.assign(new Error(`the server answered ${r.status} ${r.statusText}`.trim()), { code: 'EHTTP' })
  try {
    return JSON.parse(new TextDecoder().decode(decodeBytes(r.body))) as T
  } catch {
    throw Object.assign(new Error('the answer was not readable JSON'), { code: 'EIO' })
  }
}

const state = {
  places: [] as Place[],
  selected: null as Place | null,
}

function setStatus(text: string): void {
  $('status').textContent = text
}

function hideError(): void {
  $('error').hidden = true
}

/** A card with the failure's code, its message and a Retry button that reruns the same call. */
function showError(code: string, message: string, again: () => void): void {
  const card = $('error')
  const head = document.createElement('div')
  const strong = document.createElement('strong')
  strong.textContent = 'Could not load the weather'
  const kbd = document.createElement('kbd')
  kbd.textContent = code
  head.append(strong, kbd)
  const rest = document.createElement('div')
  rest.className = 'dim'
  rest.textContent = message
  const retry = document.createElement('button')
  retry.className = 'primary'
  retry.textContent = 'Retry'
  retry.setAttribute('aria-label', 'Retry the request')
  retry.addEventListener('click', again)
  card.replaceChildren(head, rest, retry)
  card.hidden = false
  setStatus(`Error ${code}`)
}

// ---- search: geocoding; picking a result shows the forecast there

function showResults(list: Place[]): void {
  const box = $('results')
  box.replaceChildren()
  for (const place of list.slice(0, 5)) {
    const b = document.createElement('button')
    b.textContent = [place.name, place.country || ''].filter(Boolean).join(', ')
    b.addEventListener('click', () => {
      box.hidden = true
      const input = $('search') as HTMLInputElement
      input.value = ''
      void choose(place)
    })
    box.append(b)
  }
  box.hidden = list.length === 0
}

async function doSearch(): Promise<void> {
  const q = ($('search') as HTMLInputElement).value.trim()
  if (!q) return
  hideError()
  setStatus('Searching…')
  try {
    const g = await fetchJson<GeoReply>(`${GEO}?name=${encodeURIComponent(q)}&count=5&language=en`)
    const list = (g.results ?? []).filter((p) => p && typeof p.id === 'number' && typeof p.name === 'string')
    showResults(list)
    setStatus(list.length ? 'Choose a place from the list' : `No matches for “${q}”`)
  } catch (e) {
    showResults([])
    showError(codeOf(e), messageOf(e), () => void doSearch())
  }
}

// ---- saved places (~/Library/Weather.json) and the selected one

async function save(): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await tiny.mkdir('/Users/pear/Library', { recursive: true })
      await tiny.writeFile(FILE, bytesOf(JSON.stringify({ locations: state.places })))
      return
    } catch (e) {
      // The kernel worker serves requests concurrently; two interleaved wasm calls can panic with an
      // aliasing error once — a retry comes right. Anything else is reported and the rest keeps working.
      if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') {
        setStatus(`Could not save locations: ${codeOf(e)}`)
        return
      }
    }
  }
}

async function load(): Promise<void> {
  try {
    const j = JSON.parse(new TextDecoder().decode(await tiny.readFile(FILE))) as { locations?: unknown }
    const list = Array.isArray(j.locations) ? (j.locations as Place[]) : []
    state.places = list.filter((p) => p && typeof p.id === 'number' && typeof p.name === 'string')
  } catch {
    state.places = [] // ENOENT or damage: start with no saved places
  }
  renderSaved()
  const first = state.places[0]
  if (first) void choose(first, { silent: true })
}

function isSelected(place: Place): boolean {
  return state.selected !== null && state.selected.id === place.id && state.selected.name === place.name
}

function renderSaved(): void {
  const box = $('saved')
  box.replaceChildren()
  for (const place of state.places) {
    const chip = document.createElement('div')
    chip.className = 'chip'
    const show = document.createElement('button')
    show.textContent = place.name
    show.setAttribute('aria-label', `Show ${place.name}`)
    show.setAttribute('aria-current', String(isSelected(place)))
    show.addEventListener('click', () => void choose(place))
    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = '✕'
    x.setAttribute('aria-label', `Remove ${place.name} from saved locations`)
    x.addEventListener('click', () => void remove(place))
    chip.append(show, x)
    box.append(chip)
  }
  box.hidden = state.places.length === 0
}

function remove(place: Place): void {
  state.places = state.places.filter((p) => p.id !== place.id)
  if (isSelected(place)) {
    state.selected = null
    $('now').hidden = true
    $('days').hidden = true
  }
  void save()
  renderSaved()
  setStatus(state.selected ? '' : 'Saved location removed')
}

/** Select a place: add it to the saved list (once), then show its forecast. */
async function choose(place: Place, o: { silent?: boolean } = {}): Promise<void> {
  state.selected = place
  if (!state.places.some((p) => p.id === place.id)) {
    state.places = [place, ...state.places].slice(0, 20)
    void save()
  }
  renderSaved()
  await loadForecast(o)
}

// ---- the forecast itself

const dayName = (iso: string): string => {
  const d = new Date();
  const [y, m, day] = iso.split('-').map(Number);
  d.setFullYear(y ?? 0, (m ?? 1) - 1, day ?? 1);
  return d.toLocaleDateString(undefined, { weekday: 'short' })
}

function renderNow(place: Place, f: Forecast): void {
  const c = f.current
  const code = typeof c.weather_code === 'number' ? c.weather_code : 0
  $('place').textContent = place.country ? `${place.name}, ${place.country}` : place.name
  $('temp').textContent = `${(c.temperature_2m ?? 0).toFixed(1)}°`
  $('desc').textContent = skyOf(code)
  $('wind').textContent = `Wind ${Math.round(c.wind_speed_10m ?? 0)} km/h`
  $('now').hidden = false
  $('empty').hidden = true
}

function renderDays(f: Forecast): void {
  const ol = $('days')
  const times = f.daily.time ?? []
  const codes = f.daily.weather_code ?? []
  const max = f.daily.temperature_2m_max ?? []
  const min = f.daily.temperature_2m_min ?? []
  ol.replaceChildren()
  for (let i = 0; i < Math.min(times.length, 3); i++) {
    const li = document.createElement('li')
    const day = document.createElement('span')
    day.className = 'day'
    day.textContent = dayName(times[i] ?? '')
    const sky = document.createElement('span')
    sky.className = 'sky dim'
    sky.textContent = skyOf(codes[i] ?? 0)
    const range = document.createElement('span')
    range.className = 'range'
    range.textContent = `${Math.round(max[i] ?? 0)}° / ${Math.round(min[i] ?? 0)}°`
    li.append(day, sky, range)
    ol.append(li)
  }
  ol.hidden = times.length === 0
}

async function loadForecast(o: { silent?: boolean } = {}): Promise<void> {
  const p = state.selected
  if (!p) return
  if (!o.silent) hideError()
  $('empty').hidden = true
  setStatus(o.silent ? 'Loading…' : 'Loading forecast…')
  try {
    const url =
      `${FORECAST}?latitude=${p.latitude}&longitude=${p.longitude}` +
      `&current=temperature_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&hourly=temperature_2m&forecast_days=3&timezone=auto`
    const f = await fetchJson<Forecast>(url)
    renderNow(p, f)
    renderDays(f)
    setStatus(`Updated ${new Date().toLocaleTimeString()}`)
  } catch (e) {
    showError(codeOf(e), messageOf(e), () => void loadForecast())
  }
}

/** File ▸ Reload (Cmd+R): fetch the selected place's forecast again. */
function reload(): void {
  if (state.selected) void loadForecast()
  else setStatus('Choose a place to reload its forecast')
}

function about(): void {
  void tiny.dialogs.alert({
    message: 'Weather 1.0.0',
    detail: 'Geocoding and three-day forecasts from open-meteo.com (no key needed).',
  })
}

async function main(): Promise<void> {
  await tiny.ready
  const search = $('search') as HTMLInputElement
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      void doSearch()
    } else if (e.key === 'Escape') {
      $('results').hidden = true
    }
  })
  $('go').addEventListener('click', () => void doSearch())
  await tiny.window.setMenus([
    { title: 'Weather', items: [{ label: 'About Weather', action: about }] },
    { title: 'File', items: [{ label: 'Reload', shortcut: 'Cmd+R', action: reload }] },
  ])
  await load()
  search.focus()
}
void main()
