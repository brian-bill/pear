import { basename, dirname, formatBytes, tiny } from '@tiny/sdk'
import { IMAGE_EXT, isImage, mimeOf, siblings } from './files'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const stage = $('stage')
const img = $<HTMLImageElement>('img')
const infoEl = $('info')

const ZOOM_STEP = 1.25
const MIN = 0.02
const MAX = 32

let path: string | null = null
let folder: string[] = []
let url: string | null = null
let size = 0
let mtime = 0
let type = ''
let loadId = 0
// view: `fit` means "scale to the window"; otherwise `scale` is exact
const view = { fit: true, scale: 1, rot: 0, tx: 0, ty: 0 }

const natural = () => ({ w: img.naturalWidth || 300, h: img.naturalHeight || 150 })

function fitScale(): number {
  const { w, h } = natural()
  const turned = view.rot % 180 !== 0
  const iw = turned ? h : w
  const ih = turned ? w : h
  const room = 16
  return Math.min(1, (stage.clientWidth - room) / iw, (stage.clientHeight - room) / ih) || 1
}
const scale = () => (view.fit ? fitScale() : view.scale)

function apply(): void {
  if (!path) return
  const { w, h } = natural()
  const s = scale()
  // img is centered on the stage by its own center: the origin is its top-left corner, so shift by half its size
  img.style.transform = `translate(${view.tx}px, ${view.ty}px) rotate(${view.rot}deg) scale(${s}) translate(${-w / 2}px, ${-h / 2}px)`
  img.classList.toggle('pixel', s >= 3)
  $('zoom').textContent = `${Math.round(s * 100)}%`
  $('fit').toggleAttribute('data-on', view.fit)
}

function zoomTo(s: number, fit = false): void {
  if (fit) {
    view.fit = true
    view.tx = view.ty = 0
  } else {
    view.fit = false
    view.scale = Math.min(MAX, Math.max(MIN, s))
  }
  apply()
}
const zoomBy = (f: number) => zoomTo(scale() * f)
function rotate(by: number): void {
  view.rot = (view.rot + by + 360) % 360
  view.tx = view.ty = 0
  apply()
}

function showInfo(): void {
  if (!path) return
  const { w, h } = natural()
  const rows: Array<[string, string]> = [['Name', basename(path)], ['Dimensions', `${w} × ${h}`], ['Size', formatBytes(size)], ['Type', type], ['Modified', new Date(mtime).toLocaleString()], ['Where', dirname(path)]]
  infoEl.replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]))
}

function toggleInfo(on = infoEl.hidden): void {
  infoEl.hidden = !on
  $('infobtn').setAttribute('aria-pressed', String(on))
  if (on) showInfo()
}

async function show(p: string, list?: string[]): Promise<boolean> {
  const id = ++loadId
  const name = basename(p)
  try {
    const [bytes, st] = await Promise.all([tiny.readFile(p), tiny.stat(p)])
    if (id !== loadId) return false
    const blob = new Blob([bytes as BlobPart], { type: mimeOf(name) })
    const next = URL.createObjectURL(blob)
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('This file is not an image Preview can show.'))
      img.src = next
    })
    if (id !== loadId) {
      URL.revokeObjectURL(next)
      return false
    }
    if (url) URL.revokeObjectURL(url)
    url = next
    path = p
    size = st.size
    mtime = st.mtime
    type = blob.type
    Object.assign(view, { fit: true, rot: 0, tx: 0, ty: 0 })
    img.hidden = false
    $('empty').hidden = true
    img.alt = name
    void tiny.window.setTitle(name)
    $('name').textContent = p
    const { w, h } = natural()
    $('dims').textContent = `${w} × ${h}`
    folder = list ?? folder
    if (!folder.includes(p)) folder = await siblings(p)
    $('index').textContent = folder.length > 1 ? `${folder.indexOf(p) + 1} of ${folder.length}` : ''
    apply()
    if (!infoEl.hidden) showInfo()
    if (!list) void siblings(p).then((l) => id === loadId && ((folder = l), ($('index').textContent = l.length > 1 ? `${l.indexOf(p) + 1} of ${l.length}` : '')))
    return true
  } catch (e) {
    if (id === loadId) await tiny.dialogs.alert({ message: `“${name}” could not be opened.`, detail: (e as Error).message })
    return false
  }
}

function step(d: number): void {
  if (!path || folder.length < 2) return
  const i = (folder.indexOf(path) + d + folder.length) % folder.length
  void show(folder[i]!, folder)
}

async function openDialog(): Promise<void> {
  const picked = await tiny.dialogs.openFile({ title: 'Open', startIn: path ? dirname(path) : undefined, filters: [{ name: 'Images', ext: Object.keys(IMAGE_EXT) }] })
  if (picked?.[0]) await show(picked[0], undefined)
}

// ---- input

let drag: { x: number; y: number; tx: number; ty: number } | null = null
stage.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('.info')) return
  stage.focus()
  drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
  stage.setPointerCapture(e.pointerId)
  stage.classList.add('panning')
})
stage.addEventListener('pointermove', (e) => {
  if (!drag) return
  // panning only matters once the image is bigger than the window; allow it always, it is harmless
  view.tx = drag.tx + e.clientX - drag.x
  view.ty = drag.ty + e.clientY - drag.y
  apply()
})
const endDrag = () => {
  drag = null
  stage.classList.remove('panning')
}
stage.addEventListener('pointerup', endDrag)
stage.addEventListener('pointercancel', endDrag)
stage.addEventListener('dblclick', () => (view.fit || view.scale !== 1 ? zoomTo(1) : zoomTo(1, true)))
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
    else {
      view.tx -= e.deltaX
      view.ty -= e.deltaY
      apply()
    }
  },
  { passive: false },
)
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1)
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1)
  else return
  e.preventDefault()
})
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !e.metaKey) return
  if (e.key === '+') zoomBy(ZOOM_STEP)
  else return
  e.preventDefault()
})

const click = (id: string, fn: () => void) => $(id).addEventListener('click', fn)
click('prev', () => step(-1))
click('next', () => step(1))
click('in', () => zoomBy(ZOOM_STEP))
click('out', () => zoomBy(1 / ZOOM_STEP))
click('fit', () => zoomTo(1, true))
click('actual', () => zoomTo(1))
click('rotl', () => rotate(-90))
click('rotr', () => rotate(90))
click('infobtn', () => toggleInfo())
new ResizeObserver(apply).observe(stage)

tiny.app.onSaveState(() => ({ path }))
tiny.app.onOpenFile((p) => void (isImage(p) ? show(p) : tiny.dialogs.alert({ message: `“${basename(p)}” is not an image Preview can show.` })))

async function main(): Promise<void> {
  await tiny.ready
  void tiny.window.setMenus([
    { title: 'Preview', items: [{ label: 'Open…', shortcut: 'Cmd+O', action: () => void openDialog() }] },
    {
      title: 'View',
      items: [
        { label: 'Actual Size', shortcut: 'Cmd+0', action: () => zoomTo(1) },
        { label: 'Zoom to Fit', shortcut: 'Cmd+9', action: () => zoomTo(1, true) },
        { label: 'Zoom In', shortcut: 'Cmd+=', action: () => zoomBy(ZOOM_STEP) },
        { label: 'Zoom Out', shortcut: 'Cmd+-', action: () => zoomBy(1 / ZOOM_STEP) },
        { separator: true },
        { label: 'Next Image', action: () => step(1) },
        { label: 'Previous Image', action: () => step(-1) },
        { separator: true },
        { label: 'Rotate Left', shortcut: 'Cmd+L', action: () => rotate(-90) },
        { label: 'Rotate Right', shortcut: 'Cmd+R', action: () => rotate(90) },
        { separator: true },
        { label: 'Show Info', shortcut: 'Cmd+I', action: () => toggleInfo() },
      ],
    },
  ])
  void tiny.window.setTitle('Preview')
  const state = tiny.app.state as { path?: string | null } | undefined | null
  const first = state?.path ?? tiny.app.args[0]
  if (first) await show(first)
  stage.focus()
}
void main()
