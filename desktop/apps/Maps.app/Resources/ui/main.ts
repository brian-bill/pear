import { tiny } from '@tiny/sdk'
import { CITIES, coordsOf, type City } from './cities'
import { chooseZoom, tileBounds, tilesFor, tileRowOf, tileUrl } from './live'
import { LAND, MERIDIANS, PARALLELS, pathOf, px, py, WORLD_H, WORLD_W } from './world'

/**
 * Maps: a stylized, offline world map. All pan/zoom state lives in one `view` object — `x`/`y` are
 * the #world group's translate (svg user units, which map 1:1 to css px), `scale` its scale factor.
 * Drag, wheel, buttons, double-click, keyboard and search are all arithmetic on that one object.
 */
interface View {
  x: number
  y: number
  scale: number
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const NS = 'http://www.w3.org/2000/svg'
const svgEl = (name: string, attrs: Record<string, string | number>): SVGElement => {
  const el = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

const svg = document.getElementById('map') as unknown as SVGSVGElement
const stage = $('stage')
const input = $<HTMLInputElement>('search')
const MAX_SCALE = 24

let box = { w: 0, h: 0 } // the svg's size in css px; its viewBox tracks it 1:1
const view: View = { x: 0, y: 0, scale: 1 }
let fitScale = 1 // the scale at which the whole world is just visible; the indicator ratios against it
let selected: City | null = null

let worldG!: SVGGElement
let tilesG!: SVGGElement
let landG!: SVGGElement
let citiesG!: SVGGElement
let pinG!: SVGGElement
const cityEls = new Map<string, SVGGElement>()
let scaleString = '' // last `scale(k)` handed to the counter-scaled city groups; skip no-op rewrites

/* ---- building the SVG ---- */

const oceanGradient = (): SVGElement => {
  const defs = svgEl('defs', {})
  const grad = svgEl('linearGradient', { id: 'oceangrad', x1: '0', y1: '0', x2: '0', y2: '1' })
  grad.appendChild(svgEl('stop', { offset: '0', 'stop-color': '#5e93c8' }))
  grad.appendChild(svgEl('stop', { offset: '1', 'stop-color': '#3f6da3' }))
  defs.appendChild(grad)
  return defs
}

const cityTransform = (lon: number, lat: number, k: number): string =>
  `translate(${px(lon).toFixed(2)} ${py(lat).toFixed(2)}) scale(${k.toFixed(4)})`

function buildMap(): void {
  svg.append(oceanGradient())

  // a backdrop beyond the world's edges, visible when the world is smaller than the window
  svg.appendChild(svgEl('rect', { x: -4000, y: -4000, width: 12000, height: 12000, fill: '#2d4f75' }))

  worldG = svgEl('g', { id: 'world' }) as SVGGElement
  svg.appendChild(worldG)

  worldG.appendChild(
    svgEl('rect', { x: 0, y: 0, width: WORLD_W, height: WORLD_H, class: 'ocean', fill: 'url(#oceangrad)' }),
  )

  landG = svgEl('g', { id: 'land' }) as SVGGElement
  for (const poly of LAND) {
    const p = svgEl('path', { d: pathOf(poly.pts), class: 'land' })
    const title = svgEl('title', {})
    title.textContent = poly.name
    p.appendChild(title)
    landG.appendChild(p)
  }
  worldG.appendChild(landG)

  tilesG = svgEl('g', { id: 'tiles' }) as SVGGElement
  tilesG.style.display = 'none'
  worldG.appendChild(tilesG)

  const grat = svgEl('g', { class: 'grat' })
  for (const lon of MERIDIANS) grat.appendChild(svgEl('path', { d: `M${px(lon).toFixed(2)} 0V${WORLD_H}` }))
  for (const lat of PARALLELS) grat.appendChild(svgEl('path', { d: `M0 ${py(lat).toFixed(2)}H${WORLD_W}` }))
  grat.appendChild(svgEl('path', { d: `M0 ${py(0).toFixed(2)}H${WORLD_W}`, class: 'eq', 'data-kind': 'equator' }))
  const antarctica = svgEl('text', { x: px(15).toFixed(2), y: py(-79).toFixed(2), class: 'label', 'text-anchor': 'middle' })
  antarctica.textContent = 'Antarctica'
  grat.appendChild(antarctica)
  worldG.appendChild(grat)

  citiesG = svgEl('g', { id: 'cities' }) as SVGGElement
  for (const c of CITIES) {
    const g = svgEl('g', {
      class: 'city',
      transform: cityTransform(c.lon, c.lat, 1),
      'data-name': c.name,
      'aria-label': `${c.name}, ${c.country}`,
    }) as SVGGElement
    const text = svgEl('text', { x: 5, y: 3.8 })
    text.textContent = c.name
    g.append(svgEl('circle', { r: 2.8 }), text)
    citiesG.appendChild(g)
    cityEls.set(c.name, g)
  }
  worldG.appendChild(citiesG)

  pinG = svgEl('g', { id: 'pin', class: 'pin', visibility: 'hidden' }) as SVGGElement
  pinG.append(
    svgEl('path', { d: 'M0 0C-8.6 -10.5 -11.4 -14 -11.4 -18A11.4 11.4 0 1 1 11.4 -18C11.4 -14 8.6 -10.5 0 0Z' }),
    svgEl('circle', { cx: '0', cy: '-18', r: '4' }),
  )
  worldG.appendChild(pinG)
}

/* ---- view ---- */

/** The transform attribute for the root group — what the tests (and every city) watch. */
const worldTransform = (): string =>
  `translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.scale.toFixed(4)})`

const reduceMotion = (): boolean =>
  document.documentElement.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches

function apply(): void {
  clampView()
  // counter-scaling: at zoom s, place cities at scale 1/s so dots and labels stay put on screen
  const k = (1 / view.scale).toFixed(4)
  if (k !== scaleString) {
    scaleString = k
    for (const c of CITIES) cityEls.get(c.name)?.setAttribute('transform', cityTransform(c.lon, c.lat, 1 / view.scale))
    if (selected) pinG.setAttribute('transform', cityTransform(selected.lon, selected.lat, 1 / view.scale))
  }
  worldG.setAttribute('transform', worldTransform())
  $('scale').textContent = `${Math.round((view.scale / fitScale) * 100)}%`
}

/** Keep the world on screen: it may stick out either way, but never slip away entirely. */
function clampView(): void {
  const slackX = Math.min(WORLD_W * view.scale * 0.5, 300)
  const slackY = Math.min(WORLD_H * view.scale * 0.5, 300)
  const wrap = (v: number, edge: number, slack: number): number =>
    Math.max(Math.min(0, edge) - slack, Math.min(Math.max(0, edge) + slack, v))
  view.x = wrap(view.x, box.w - WORLD_W * view.scale, slackX)
  view.y = wrap(view.y, box.h - WORLD_H * view.scale, slackY)
}

const clampScale = (s: number): number => Math.max(fitScale * 0.6, Math.min(MAX_SCALE, s))

/** Keep the world point under (cx, cy) fixed while the scale moves to `s`. */
function zoomAround(s: number, cx: number, cy: number): void {
  const next = clampScale(s)
  if (next === view.scale) return
  view.x = cx - ((cx - view.x) / view.scale) * next
  view.y = cy - ((cy - view.y) / view.scale) * next
  view.scale = next
  apply()
  scheduleTiles()
}

function measure(): void {
  const w = stage.clientWidth
  const h = stage.clientHeight
  if (!w || !h) return
  box = { w, h }
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  fitScale = Math.min(w / WORLD_W, h / WORLD_H) * 0.92
  view.scale = clampScale(view.scale)
  apply()
}

function resetView(immediate = false): void {
  glide({ x: (box.w - WORLD_W * fitScale) / 2, y: (box.h - WORLD_H * fitScale) / 2, scale: fitScale }, immediate)
}

/** Center (and, if far out, gently zoom in to) a city. */
function centerOn(c: City): void {
  const s = Math.min(MAX_SCALE, Math.max(view.scale, fitScale * 2.2))
  glide({ x: box.w / 2 - px(c.lon) * s, y: box.h / 2 - py(c.lat) * s, scale: s })
}

const ease = (t: number): number => 1 - (1 - t) ** 3

function glide(to: View, immediate = false): void {
  if (immediate || reduceMotion()) {
    moving++ // cancels a running animation
    Object.assign(view, to)
    apply()
    scheduleTiles()
    return
  }
  animate({ ...view }, to)
}

let moving = 0 // id of the running animation; 0 means settled

function animate(from: View, to: View): void {
  const id = ++moving
  const t0 = performance.now()
  const tick = (now: number): void => {
    if (id !== moving) return
    const t = Math.min(1, (now - t0) / 450)
    const e = ease(t)
    view.x = from.x + (to.x - from.x) * e
    view.y = from.y + (to.y - from.y) * e
    view.scale = from.scale + (to.scale - from.scale) * e
    apply()
    if (t < 1) requestAnimationFrame(tick)
    else {
      moving = 0
      scheduleTiles()
    }
  }
  requestAnimationFrame(tick)
}

/* ---- pan, wheel, double click, keyboard ---- */

let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; city: string | null } | null = null

function bindInput(): void {
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    drag = {
      x: e.clientX,
      y: e.clientY,
      tx: view.x,
      ty: view.y,
      moved: false,
      city: (e.target as Element).closest('.city')?.getAttribute('data-name') ?? null,
    }
    svg.setPointerCapture(e.pointerId)
    svg.classList.add('panning')
  })
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    view.x = drag.tx + dx
    view.y = drag.ty + dy
    apply()
  })
  const endDrag = (): void => {
    if (drag && !drag.moved) {
      const c = drag.city ? CITIES.find((c2) => c2.name === drag?.city) : undefined
      if (c) select(c) // a plain click on a city dot selects it
    }
    if (drag?.moved) scheduleTiles()
    svg.classList.remove('panning')
    drag = null
  }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', () => endDrag())
  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    const r = svg.getBoundingClientRect()
    zoomAround(view.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18), e.clientX - r.left, e.clientY - r.top)
  }, { passive: false })
  svg.addEventListener('dblclick', (e) => {
    const r = svg.getBoundingClientRect()
    zoomAround(view.scale * 1.7, e.clientX - r.left, e.clientY - r.top)
  })
  stage.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'ArrowLeft') { view.x -= 40; e.preventDefault() }
    else if (e.key === 'ArrowRight') { view.x += 40; e.preventDefault() }
    else if (e.key === 'ArrowUp') { view.y -= 40; e.preventDefault() }
    else if (e.key === 'ArrowDown') { view.y += 40; e.preventDefault() }
    else if (e.key === '+' || e.key === '=') { zoomAround(view.scale * 1.3, box.w / 2, box.h / 2); e.preventDefault() }
    else if (e.key === '-') { zoomAround(view.scale / 1.3, box.w / 2, box.h / 2); e.preventDefault() }
    else if (e.key === '0') { resetView(); e.preventDefault() }
    else if (e.key === 'Escape') { clearSelection(); e.preventDefault() }
    else return
    scheduleTiles()
  })
  $('in').addEventListener('click', () => zoomAround(view.scale * 1.3, box.w / 2, box.h / 2))
  $('out').addEventListener('click', () => zoomAround(view.scale / 1.3, box.w / 2, box.h / 2))
}

/* ---- selection and the city card ---- */

function select(c: City, fly = false): void {
  selected = c
  for (const [name, g] of cityEls) g.classList.toggle('sel', name === c.name)
  // requestAnimationFrame? no: the pin may already be visible; this also picks up re-selection
  pinG.setAttribute('transform', cityTransform(c.lon, c.lat, 1 / view.scale))
  pinG.setAttribute('visibility', 'visible')
  $('cname').textContent = c.name
  $('cmeta').textContent = `${c.country} · ${coordsOf(c)} · ${c.pop.toFixed(1)}M metro`
  $('card').hidden = false
  if (fly) centerOn(c)
}

function clearSelection(): void {
  selected = null
  for (const [, g] of cityEls) g.classList.remove('sel')
  pinG.setAttribute('visibility', 'hidden')
  $('card').hidden = true
}

/* ---- search ---- */

interface Suggestion {
  city: City
  el: HTMLButtonElement
}
let matches: Suggestion[] = []
let active = -1

function renderSuggestions(): void {
  const list = $('suggest')
  active = -1
  const q = input.value.trim().toLowerCase()
  const cities = q ? CITIES.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8) : []
  matches = cities.map((city, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = city.name
    const small = document.createElement('small')
    small.textContent = city.country
    b.append(small)
    b.addEventListener('click', () => pick(city))
    b.addEventListener('mousemove', () => setActive(i))
    return { city, el: b }
  })
  list.replaceChildren(...matches.map((m) => m.el))
  list.hidden = cities.length > 0 ? false : !q // nothing typed: no list; typed and empty: "No matches"
  if (q && cities.length === 0) {
    const d = document.createElement('div')
    d.className = 'none'
    d.textContent = 'No matches'
    list.appendChild(d)
  }
}

function setActive(i: number): void {
  active = i
  matches.forEach((m, j) => (j === active ? m.el.setAttribute('aria-current', 'true') : m.el.removeAttribute('aria-current')))
}

function pick(c: City): void {
  input.value = c.name
  matches = []
  $('suggest').hidden = true
  select(c, true)
}

function bindSearch(): void {
  input.addEventListener('input', renderSuggestions)
  input.addEventListener('focus', () => input.value.trim() !== '' && renderSuggestions())
  input.addEventListener('blur', () => setTimeout(() => ($('suggest').hidden = true), 150))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (matches.length) setActive((active + 1) % matches.length)
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      if (matches.length) setActive(active <= 0 ? matches.length - 1 : active - 1)
      e.preventDefault()
    } else if (e.key === 'Enter') {
      const c = matches[active]?.city ?? matches[0]?.city
      if (c) pick(c)
      e.preventDefault()
    } else if (e.key === 'Escape') {
      matches = []
      $('suggest').hidden = true
    }
  })
}

/* ---- live tiles (OpenStreetMap): optional, off by default ---- */

let liveOn = false
let tileTimer = 0
let tileRun = 0 // run id: answers from an older run are dropped
const tileCache = new Map<string, string>() // "z/x/y" -> blob URL
const shown = new Map<string, SVGImageElement>()
const needed = new Set<string>()
const queue: string[] = []
let fetching = 0

const keyOf = (t: { z: number; x: number; y: number }): string => `${t.z}/${t.x}/${t.y}`

/** Visible part of the map in degrees. */
function worldToRect(): { lon0: number; lon1: number; lat0: number; lat1: number } {
  const sx = WORLD_W / 360 // world units per degree
  const sy = WORLD_H / 180
  return {
    lon0: (-view.x / view.scale) / sx - 180,
    lon1: ((box.w - view.x) / view.scale) / sx - 180,
    lat0: 90 - ((box.h - view.y) / view.scale) / sy,
    lat1: 90 - ((-view.y) / view.scale) / sy,
  }
}

/** Debounced: drags and scroll-wheel runs should not fetch a tile storm. */
function scheduleTiles(): void {
  if (!liveOn) return
  clearTimeout(tileTimer)
  tileTimer = window.setTimeout(() => void refreshTiles(), 120)
}

function refreshTiles(): void {
  if (!liveOn) return
  const run = ++tileRun
  needed.clear()
  for (const t of tilesFor(worldToRect(), chooseZoom(view.scale))) needed.add(keyOf(t))
  for (const [k, el] of shown)
    if (!needed.has(k)) {
      el.remove()
      shown.delete(k)
    }
  for (const k of needed) {
    if (shown.has(k)) continue
    if (tileCache.has(k)) show(k, run)
    else enqueue(k)
  }
  pump()
}

function show(k: string, run: number): void {
  if (run !== tileRun || !liveOn || shown.has(k)) return
  const url = tileCache.get(k)
  if (url === undefined) return
  const [z, x, y] = k.split('/').map(Number) as [number, number, number]
  const b = tileBounds(z, x, y)
  const img = svgEl('image', {
    x: px(b.lon0).toFixed(2),
    y: py(b.lat1).toFixed(2),
    width: (px(b.lon1) - px(b.lon0)).toFixed(2),
    height: (py(b.lat0) - py(b.lat1)).toFixed(2),
    preserveAspectRatio: 'none',
  })
  img.setAttribute('href', url)
  tilesG.appendChild(img)
  shown.set(k, img as SVGImageElement)
}

function enqueue(k: string): void {
  if (!queue.includes(k)) queue.push(k)
}

function pump(): void {
  while (fetching < 6 && queue.length) {
    const k = queue.shift()!
    const [z, x, y] = k.split('/').map(Number) as [number, number, number]
    fetching++
    void fetchTile({ z, x, y })
      .then((url) => {
        tileCache.set(k, url)
        if (tileCache.size > 300) {
          const oldest = tileCache.keys().next().value
          if (oldest !== undefined) {
            URL.revokeObjectURL(tileCache.get(oldest) ?? '')
            tileCache.delete(oldest)
          }
        }
        show(k, tileRun)
      })
      .catch(() => void failLive('Live maps could not load — back to the Pear World.'))
      .finally(() => {
        fetching--
        refreshTiles()
      })
  }
}

async function fetchTile(t: { z: number; x: number; y: number }): Promise<string> {
  const r = await tiny.service<{ status: number; body?: Uint8Array }>('tiny.network', { op: 'fetch', url: tileUrl(t) })
  if (r.status !== 200 || !r.body) throw new Error(`tile ${tileUrl(t)}: ${r.status}`)
  return URL.createObjectURL(new Blob([r.body as BlobPart], { type: 'image/png' }))
}

function stopLive(): void {
  liveOn = false
  queue.length = 0
  tileRun++
  clearTimeout(tileTimer)
  shown.clear()
  tilesG.replaceChildren()
  setLayers()
  $('src').textContent = 'Pear World · hand-drawn, offline'
}

/** Any failure reverts to the Pear World, loudly but politely. */
function failLive(message: string): void {
  if (!liveOn) return
  stopLive()
  menus()
  toast(message)
}

function setLayers(): void {
  tilesG.style.display = liveOn ? '' : 'none'
  landG.style.display = liveOn ? 'none' : ''
  citiesG.style.display = liveOn ? 'none' : ''
}

function toggleLive(): void {
  if (liveOn) {
    stopLive()
    menus()
    return
  }
  // probe with the tile under the view center before flipping the map over
  const rect = worldToRect()
  const z = chooseZoom(view.scale)
  const n = 2 ** z
  const tx = Math.floor(((Math.max(-180, Math.min(180, (rect.lon0 + rect.lon1) / 2)) + 180) / 360) * n)
  const ty = tileRowOf((rect.lat0 + rect.lat1) / 2, n)
  void fetchTile({ z, x: tx, y: ty })
    .then((url) => {
      tileCache.set(keyOf({ z, x: tx, y: ty }), url)
      liveOn = true
      setLayers()
      $('src').textContent = 'Live · © OpenStreetMap contributors'
      menus()
      refreshTiles()
    })
    .catch(() => void failLive('Live maps is not available right now — staying offline.'))
}

/* ---- menus, about, toast ---- */

/**
 * Zoom In declares Cmd+= because Cmd++ cannot be declared: plus needs Shift, and menu shortcuts are
 * single-key chords (TextEdit hit this first).
 */
function menus(): void {
  void tiny.window.setMenus([
    { title: 'Maps', items: [{ label: 'About Maps', action: about }] },
    {
      title: 'View',
      items: [
        { label: 'Zoom In', shortcut: 'Cmd+=', action: () => zoomAround(view.scale * 1.3, box.w / 2, box.h / 2) },
        { label: 'Zoom Out', shortcut: 'Cmd+-', action: () => zoomAround(view.scale / 1.3, box.w / 2, box.h / 2) },
        { separator: true },
        { label: 'Reset View', shortcut: 'Cmd+0', action: () => resetView() },
        { separator: true },
        { label: 'Live Maps (OpenStreetMap)', checked: liveOn, action: () => toggleLive() },
      ],
    },
  ])
}

function about(): void {
  void tiny.dialogs.alert({
    message: 'Maps',
    detail: 'Pear World — a stylized, offline map of the real Earth.\n\n25 cities sit at their true latitude and longitude. Drag to pan, scroll or double-click to zoom, search to fly somewhere. "Live Maps" in the View menu draws real OpenStreetMap tiles when you have a connection.',
  })
}

let toastTimer = 0
function toast(text: string): void {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (el.hidden = true), 3500)
}

/* ---- boot ---- */

function main(): void {
  buildMap()
  bindInput()
  bindSearch()
  $('card').addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('#closecity')) clearSelection()
    if (t.closest('#zoomto') && selected) centerOn(selected)
  })
  new ResizeObserver(() => measure()).observe(stage)
  measure()
  resetView(true)
  void tiny.ready.then(() => menus())
}

void main()
