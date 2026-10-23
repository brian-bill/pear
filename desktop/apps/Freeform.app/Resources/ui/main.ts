import { basename, bytesOf, dirname, textOf, tiny, type MenuDef } from '@tiny/sdk'
import { MAX_ZOOM, MIN_ZOOM, bounds, clamp, hits, newId, normRect, parseBoard, pathOf, type Box, type Item, type Tool } from './board'

// Freeform: an SVG whiteboard. The document is a list of items in board space; the view
// is a scroll/zoom transform over one <g>, and every command mutates the list only.

const NS = 'http://www.w3.org/2000/svg'
const START = { x: 24, y: 24 } // the scroll at a fresh board, so the origin sits just inside the view
const UNDO_MAX = 500

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T
const svgEl = (tag: string): SVGElement => document.createElementNS(NS, tag)

const board = $<HTMLDivElement>('board')
const world = $<SVGGElement>('world')
const itemsLayer = $<SVGGElement>('items')
const draftLayer = $<SVGGElement>('draft')
const outline = $<SVGRectElement>('outline')
const zoomFit = $<HTMLButtonElement>('zoom-fit')

const COLORS: Array<{ token: string; label: string }> = [
  { token: 'var(--text)', label: 'Text' },
  { token: 'var(--accent)', label: 'Accent' },
  { token: 'var(--text-dim)', label: 'Dim' },
  { token: 'var(--separator)', label: 'Line' },
  { token: 'var(--window-titlebar)', label: 'Panel' },
  { token: 'var(--window-bg)', label: 'Paper' },
]
const WIDTHS = [1, 2, 4, 8]
const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'select', label: 'Select' },
  { id: 'pen', label: 'Pen' },
  { id: 'rect', label: 'Rect' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'note', label: 'Note' },
]

// ---- the document

let items: Item[] = []
let path: string | null = null
const view = { scrollX: START.x, scrollY: START.y, zoom: 1 }
let tool: Tool = 'select'
let color = COLORS[0]!.token
let width = 2
let selId: string | null = null

let undoStack: Item[][] = []
let redoStack: Item[][] = []

const serialize = (): string => JSON.stringify({ version: 1, items })
let saved = serialize()
const isDirty = (): boolean => serialize() !== saved
const docName = (): string => (path ? basename(path) : 'Freeform')
const isEmpty = (): boolean => !path && items.length === 0 && !isDirty()
const clone = (): Item[] => structuredClone(items)

const shown = { title: '', edited: false }

async function keepFocus<T>(ask: Promise<T>): Promise<T> {
  const was = document.activeElement as HTMLElement | null
  const r = await ask
  ;(was && was !== document.body ? was : board).focus()
  return r
}
const alertBox = (o: Parameters<typeof tiny.dialogs.alert>[0]) => keepFocus(tiny.dialogs.alert(o))

function refresh(): void {
  const name = docName()
  if (name !== shown.title) {
    shown.title = name
    void tiny.window.setTitle(name)
  }
  const dirty = isDirty()
  if (dirty !== shown.edited) {
    shown.edited = dirty
    void tiny.window.setEdited(dirty)
  }
  buildMenus()
}

// ---- undo and redo

function pushUndo(): void {
  undoStack.push(clone())
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack = []
}

function applySnapshot(): void {
  if (selId && !items.some((it) => it.id === selId)) selId = null
  renderAll()
  refresh()
}

function undo(): void {
  const prev = undoStack.pop()
  if (!prev) return
  redoStack.push(clone())
  items = prev
  applySnapshot()
}

function redo(): void {
  const next = redoStack.pop()
  if (!next) return
  undoStack.push(clone())
  items = next
  applySnapshot()
}

function deleteSel(): void {
  if (!selId) return
  pushUndo()
  items = items.filter((it) => it.id !== selId)
  applySnapshot() // clears the now-dangling selection and repaints
}

// ---- rendering

let els = new Map<string, SVGElement>()
let draftEl: SVGElement | null = null

/** Give an element its full geometry/style for `item`. Used for real items and for the draft. */
function applyGeometry(el: SVGElement, item: Item): void {
  if (item.kind === 'path') {
    el.setAttribute('d', pathOf(item))
    el.style.fill = 'none'
    el.style.stroke = item.stroke ?? 'var(--text)'
    el.style.strokeWidth = String(item.sw ?? 2)
    el.setAttribute('stroke-linecap', 'round')
    el.setAttribute('stroke-linejoin', 'round')
  } else if (item.kind === 'rect') {
    el.setAttribute('x', String(item.x))
    el.setAttribute('y', String(item.y))
    el.setAttribute('width', String(Math.max(0, item.w ?? 0)))
    el.setAttribute('height', String(Math.max(0, item.h ?? 0)))
    el.style.fill = item.fill ?? 'none'
    el.style.stroke = item.stroke ?? 'var(--text)'
    el.style.strokeWidth = String(item.sw ?? 2)
  } else if (item.kind === 'ellipse') {
    const w = item.w ?? 0
    const h = item.h ?? 0
    el.setAttribute('cx', String(item.x + w / 2))
    el.setAttribute('cy', String(item.y + h / 2))
    el.setAttribute('rx', String(Math.max(0, w / 2)))
    el.setAttribute('ry', String(Math.max(0, h / 2)))
    el.style.fill = item.fill ?? 'none'
    el.style.stroke = item.stroke ?? 'var(--text)'
    el.style.strokeWidth = String(item.sw ?? 2)
  } else {
    // note: a filled box with a clipped-in label, positioned by transform
    el.setAttribute('transform', `translate(${item.x} ${item.y})`)
    const box = svgEl('rect')
    box.setAttribute('width', String(Math.max(0, item.w ?? 0)))
    box.setAttribute('height', String(Math.max(0, item.h ?? 0)))
    box.style.fill = item.fill ?? 'var(--note-bg, rgba(255, 243, 128, 0.88))'
    box.style.stroke = 'var(--separator)'
    box.style.strokeWidth = '1'
    const label = svgEl('text')
    label.setAttribute('x', '9')
    label.setAttribute('y', '20')
    label.textContent = item.text ?? 'Note'
    label.classList.add('ntext')
    label.style.fill = '#4a3a00'
    el.replaceChildren(box, label)
  }
}

function elFor(item: Item): SVGElement {
  const el = svgEl(item.kind === 'path' ? 'path' : item.kind === 'rect' ? 'rect' : item.kind === 'ellipse' ? 'ellipse' : 'g')
  el.classList.add('item')
  if (item.id === selId) el.classList.add('sel')
  el.dataset.id = item.id
  applyGeometry(el, item)
  return el
}

function renderAll(): void {
  const kids = items.map(elFor)
  els = new Map(kids.map((el, i) => [items[i]!.id, el]))
  itemsLayer.replaceChildren(...kids)
  updateOutline()
}

const itemEl = (item: Item): SVGElement | undefined => els.get(item.id)
const findItem = (id: string | null): Item | undefined => (id ? items.find((it) => it.id === id) : undefined)

function select(id: string | null): void {
  selId = id
  for (const el of itemsLayer.children) {
    const isSel = el instanceof SVGElement && el.dataset.id === id
    el.classList.toggle('sel', isSel)
  }
  updateOutline()
  buildMenus()
}

/** The selection outline lives in screen space, so its dashes do not zoom with the board. */
function updateOutline(): void {
  const it = findItem(selId)
  if (!it) {
    outline.style.display = 'none'
    return
  }
  const b = bounds(it)
  outline.style.display = ''
  outline.setAttribute('x', String(Math.round(b.x * view.zoom)))
  outline.setAttribute('width', String(Math.round(b.w * view.zoom)))
  outline.setAttribute('y', String(Math.round(b.y * view.zoom)))
  outline.setAttribute('height', String(Math.round(b.h * view.zoom)))
  outline.style.transform = `translate(${view.scrollX}px, ${view.scrollY}px)`
}

function applyView(): void {
  world.style.transform = `translate(${view.scrollX}px, ${view.scrollY}px) scale(${view.zoom})`
  updateOutline()
  zoomFit.textContent = `${Math.round(view.zoom * 100)}%`
}

// ---- creating and moving with the pointer

type Drag =
  | { kind: 'pan'; grabX: number; grabY: number }
  | { kind: 'move'; id: string; downX: number; downY: number; origX: number; origY: number; pushed: boolean; moved: boolean }
  | { kind: 'create'; shape: 'pen' | 'rect' | 'ellipse' | 'note'; x0: number; y0: number; lx: number; ly: number; pts: number[] }

let drag: Drag | null = null
let spaced = false

const screenPt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
  const r = board.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
const boardPt = (e: PointerEvent | MouseEvent): { x: number; y: number } => {
  const p = screenPt(e)
  return { x: (p.x - view.scrollX) / view.zoom, y: (p.y - view.scrollY) / view.zoom }
}

function ensureDraft(tag: string): SVGElement {
  if (!draftEl) {
    draftEl = svgEl(tag)
    draftLayer.replaceChildren(draftEl)
  }
  return draftEl
}
function clearDraft(): void {
  draftEl = null
  draftLayer.replaceChildren()
}

function itemAt(bx: number, by: number): Item | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it && hits(it, bx, by, view.zoom)) return it
  }
  return undefined
}

board.addEventListener('pointerdown', (e: PointerEvent) => {
  if (e.button !== 0 && e.button !== 1) return
  board.focus()
  try {
    board.setPointerCapture(e.pointerId)
  } catch {
    /* dragging still works while the pointer stays inside the frame */
  }
  const p = screenPt(e)
  const b = boardPt(e)
  drag = null
  if (spaced || e.button === 1) {
    drag = { kind: 'pan', grabX: p.x - view.scrollX, grabY: p.y - view.scrollY }
    board.classList.add('panning')
  } else if (tool === 'select') {
    const it = itemAt(b.x, b.y)
    if (it) {
      if (selId !== it.id) select(it.id)
      drag = { kind: 'move', id: it.id, downX: b.x, downY: b.y, origX: it.x, origY: it.y, pushed: false, moved: false }
    } else {
      select(null)
    }
  } else {
    drag = { kind: 'create', shape: tool, x0: b.x, y0: b.y, lx: b.x, ly: b.y, pts: [b.x, b.y] }
    if (tool === 'pen') {
      const el = ensureDraft('path')
      el.style.fill = 'none'
      el.style.stroke = color
      el.style.strokeWidth = String(width)
      el.setAttribute('stroke-linecap', 'round')
      el.setAttribute('stroke-linejoin', 'round')
    }
  }
})

board.addEventListener('pointermove', (e: PointerEvent) => {
  if (!drag) return
  const p = screenPt(e)
  const b = boardPt(e)
  if (drag.kind === 'pan') {
    view.scrollX = Math.round(p.x - drag.grabX)
    view.scrollY = Math.round(p.y - drag.grabY)
    applyView()
  } else if (drag.kind === 'move') {
    if (!drag.pushed && Math.hypot(b.x - drag.downX, b.y - drag.downY) >= 0.5) {
      pushUndo() // the drag has truly started: the pre-move board goes on the stack, once
      drag.pushed = true
    }
    if (!drag.pushed) return
    const it = findItem(drag.id)
    if (!it) return
    it.x = drag.origX + Math.round(b.x - drag.downX)
    it.y = drag.origY + Math.round(b.y - drag.downY)
    drag.moved = true
    const el = itemEl(it)
    if (el) applyGeometry(el, it)
    updateOutline()
  } else {
    drag.lx = b.x
    drag.ly = b.y
    const el = drag.shape === 'pen' ? ensureDraft('path') : ensureDraft(drag.shape === 'note' ? 'g' : drag.shape === 'rect' ? 'rect' : 'ellipse')
    if (drag.shape === 'pen') {
      const last = drag.pts.length - 2
      if (last < 0 || Math.hypot(b.x - (drag.pts[last] ?? 0), b.y - (drag.pts[last + 1] ?? 0)) * view.zoom >= 3) {
        // min-move filter: drop jitter below ~3 screen px
        drag.pts.push(b.x, b.y)
        const fake: Item = { id: 'draft', kind: 'path', x: 0, y: 0, points: drag.pts.slice(), stroke: color, sw: width }
        el.setAttribute('d', pathOf(fake))
      }
    } else {
      applyGeometry(el, shapeDraft(drag.shape, drag.x0, drag.y0, b.x, b.y))
    }
  }
})

/** The item a shape tool is in the middle of drawing; a barely-moved drag makes a default-size note. */
function shapeDraft(shape: 'rect' | 'ellipse' | 'note', x0: number, y0: number, x1: number, y1: number): Item {
  const r = normRect(x0, y0, x1, y1)
  const lazy = Math.hypot(x1 - x0, y1 - y0) < 6
  return {
    id: 'draft',
    kind: shape,
    x: r.x,
    y: r.y,
    w: shape === 'note' ? (lazy ? 120 : Math.max(r.w, 24)) : r.w,
    h: shape === 'note' ? (lazy ? 80 : Math.max(r.h, 24)) : r.h,
    stroke: color,
    sw: width,
    text: shape === 'note' ? 'Note' : undefined,
  }
}

function endDrag(commit: boolean): void {
  const d = drag
  drag = null
  board.classList.remove('panning')
  if (!d) return
  if (d.kind === 'pan') return
  if (d.kind === 'move') {
    if (d.moved) refresh()
    return
  }
  clearDraft()
  if (!commit) return
  if (d.shape === 'pen') {
    const p = d.pts
    if (p.length < 4) return // a plain click leaves no dot
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i] ?? 0)
      maxX = Math.max(maxX, p[i] ?? 0)
      minY = Math.min(minY, p[i + 1] ?? 0)
      maxY = Math.max(maxY, p[i + 1] ?? 0)
    }
    const rel: number[] = []
    for (let i = 0; i < p.length; i += 2) rel.push((p[i] ?? 0) - minX, (p[i + 1] ?? 0) - minY)
    pushUndo()
    items.push({ id: newId(), kind: 'path', x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY), points: rel, stroke: color, sw: width })
  } else {
    const fake = shapeDraft(d.shape, d.x0, d.y0, d.lx, d.ly)
    if (d.shape !== 'note' && (fake.w ?? 0) < 2 && (fake.h ?? 0) < 2) return // a plain click with a shape tool
    pushUndo()
    items.push({ ...fake, id: newId() })
  }
  select(null)
  renderAll()
  refresh()
}

board.addEventListener('pointerup', () => endDrag(true))
board.addEventListener('pointercancel', () => endDrag(false))

itemsLayer.addEventListener('dblclick', (e) => {
  const t = (e.target as Element).closest('.item')
  if (!t) return
  const id = t instanceof SVGElement ? t.dataset.id ?? null : null
  const it = findItem(id)
  if (it) {
    if (selId !== it.id) select(it.id)
    void editNote(it)
  }
})

async function editNote(item: Item): Promise<void> {
  if (item.kind !== 'note') return
  const next = await keepFocus(tiny.dialogs.prompt('Note text:', { value: item.text ?? '', title: 'Note' }))
  if (next === null || next === item.text) return
  pushUndo()
  item.text = next
  const el = itemEl(item)
  if (el) applyGeometry(el, item)
  refresh()
}

// ---- panning and zooming

function zoomAt(sx: number, sy: number, factor: number): void {
  const nz = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  if (nz === view.zoom) return
  const bx = (sx - view.scrollX) / view.zoom
  const by = (sy - view.scrollY) / view.zoom
  view.zoom = nz
  view.scrollX = Math.round(sx - bx * nz)
  view.scrollY = Math.round(sy - by * nz)
  applyView()
}

function zoomStep(factor: number): void {
  zoomAt(board.clientWidth / 2, board.clientHeight / 2, factor)
}

function fitAll(): void {
  let b: Box | null = null
  for (const it of items) {
    const t = bounds(it)
    b = b ? { x: Math.min(b.x, t.x), y: Math.min(b.y, t.y), w: Math.max(b.x + b.w, t.x + t.w) - Math.min(b.x, t.x), h: Math.max(b.y + b.h, t.y + t.h) - Math.min(b.y, t.y) } : t
  }
  if (!b) {
    view.zoom = 1
    view.scrollX = START.x
    view.scrollY = START.y
  } else {
    const W = board.clientWidth
    const H = board.clientHeight
    const m = 48
    const z = clamp(Math.min((W - 2 * m) / Math.max(1, b.w), (H - 2 * m) / Math.max(1, b.h), 1), MIN_ZOOM, 1) // never enlarge
    view.zoom = z
    view.scrollX = Math.round((W - b.w * z) / 2 - b.x * z)
    view.scrollY = Math.round((H - b.h * z) / 2 - b.y * z)
  }
  applyView()
}

board.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      // pinch on a trackpad: zoom to the cursor
      const p = screenPt(e)
      zoomAt(p.x, p.y, Math.exp(-e.deltaY / 240))
    } else {
      // two fingers: pan, horizontally and vertically
      const unit = e.deltaMode === 1 ? 16 : 1
      view.scrollX = Math.round(view.scrollX - e.deltaX * unit)
      view.scrollY = Math.round(view.scrollY - e.deltaY * unit)
      applyView()
    }
  },
  { passive: false },
)

$('zoom-in').addEventListener('click', () => zoomStep(1.25))
$('zoom-out').addEventListener('click', () => zoomStep(1 / 1.25))
$('zoom-fit').addEventListener('click', fitAll)
addEventListener('resize', updateOutline) // keep the outline honest when the window grows

// ---- keyboard

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const inField = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
  if (inField) return
  if (e.key === ' ') {
    e.preventDefault()
    if (!e.repeat) {
      spaced = true
      board.dataset.space = 'true'
    }
  } else if (e.key === 'Escape') {
    endDrag(false)
    select(null)
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selId) {
      e.preventDefault()
      deleteSel()
    }
  } else if (/^[1-5]$/.test(e.key)) {
    const t = TOOLS[Number(e.key) - 1]
    if (t) setTool(t.id)
  }
})

addEventListener('keyup', (e) => {
  if (e.key !== ' ') return
  spaced = false
  delete board.dataset.space
})
addEventListener('blur', () => {
  spaced = false
  delete board.dataset.space
})

// ---- toolbar

function setTool(next: Tool): void {
  tool = next
  board.dataset.tool = next
  for (const b of $('tools').children) {
    if (b instanceof HTMLButtonElement) b.setAttribute('aria-pressed', String(b.dataset.tool === next))
  }
}

function buildToolbar(): void {
  const tools = $('tools')
  for (const t of TOOLS) {
    const b = document.createElement('button')
    b.textContent = t.label
    b.dataset.tool = t.id
    b.setAttribute('aria-label', t.label)
    b.setAttribute('aria-pressed', String(t.id === tool))
    b.addEventListener('click', () => setTool(t.id))
    tools.append(b)
  }
  const colors = $('colors')
  for (const c of COLORS) {
    const b = document.createElement('button')
    b.className = 'swatch'
    b.title = c.label
    b.setAttribute('aria-label', `Colour ${c.label}`)
    b.setAttribute('aria-pressed', String(color === c.token))
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.background = c.token
    b.append(dot)
    b.addEventListener('click', () => {
      color = c.token
      for (const s of colors.children) {
        if (s instanceof HTMLButtonElement) s.setAttribute('aria-pressed', String(s.title === c.label))
      }
    })
    colors.append(b)
  }
  const widths = $('widths')
  for (const n of WIDTHS) {
    const b = document.createElement('button')
    b.className = 'widthb'
    b.setAttribute('aria-label', `Stroke width ${n}`)
    b.setAttribute('aria-pressed', String(n === width))
    const ink = document.createElement('span')
    ink.className = 'ink'
    const px = 4 + n
    ink.style.width = `${px}px`
    ink.style.height = `${px}px`
    b.dataset.w = String(n)
    b.append(ink)
    b.addEventListener('click', () => {
      width = n
      for (const w of widths.children) {
        if (w instanceof HTMLButtonElement) w.setAttribute('aria-pressed', String(n === Number(w.getAttribute('data-w') ?? -1)))
      }
    })
    widths.append(b)
  }
}

// ---- opening and saving

/** The kernel worker occasionally panics when two wasm calls interleave; the call is safe to repeat. */
async function retry<T>(run: () => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await run()
    } catch (e) {
      // Apps see the kernel's errors as SysError, not KernelError: match the message itself.
      const flake = e instanceof Error && /unsafe aliasing/.test(e.message)
      if (!flake || tries >= 11) throw e
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 100)) // leave the kernel an idle gap
    }
  }
}

async function loadPath(p: string): Promise<boolean> {
  try {
    const parsed = parseBoard(textOf(await retry(() => tiny.readFile(p))))
    items = parsed
    path = p
    saved = serialize()
    selId = null
    undoStack = []
    redoStack = []
    fitAll()
    renderAll()
    applyView()
    refresh()
    board.focus()
    return true
  } catch (err) {
    await alertBox({ message: `“${basename(p)}” could not be opened.`, detail: (err as Error).message, buttons: ['OK'] })
    return false
  }
}

async function openPath(p: string): Promise<void> {
  if (isEmpty()) await loadPath(p)
  else if (p === path) board.focus()
  else void tiny.app.openWindow({ path: p })
}

async function openDialog(): Promise<void> {
  const paths = await keepFocus(
    tiny.dialogs.openFile({ title: 'Open Board', startIn: path ? dirname(path) : undefined, filters: [{ name: 'Freeform Board', ext: ['freeboard'] }] }),
  )
  const first = paths?.[0]
  if (first) await openPath(first)
}

async function writeTo(p: string): Promise<boolean> {
  const data = bytesOf(serialize())
  try {
    try {
      await retry(() => tiny.writeFileAtomic(p, data))
    } catch (err) {
      // a file we may write but whose folder we may not (a panel-picked file): write in place
      if (!['EACCES', 'EPERM'].includes((err as { code?: string }).code ?? '')) throw err
      await retry(() => tiny.writeFile(p, data))
    }
  } catch (err) {
    await alertBox({ message: `“${basename(p)}” could not be saved.`, detail: (err as Error).message, buttons: ['OK'] })
    return false
  }
  saved = serialize()
  refresh()
  return true
}

async function save(): Promise<boolean> {
  if (!path) {
    const picked = await keepFocus(
      tiny.dialogs.saveFile({ title: 'Save Board', name: 'Untitled.freeboard', filters: [{ name: 'Freeform Board', ext: ['freeboard'] }] }),
    )
    if (!picked) return false
    path = picked
  }
  return writeTo(path)
}

async function newBoard(): Promise<void> {
  if (
    isDirty() &&
    (await alertBox({ message: `Replace the board with a new one?`, detail: 'Your unsaved changes will be lost.', buttons: ['New Board', 'Cancel'], cancelButton: 1 })) !== 0
  )
    return
  items = []
  path = null
  saved = serialize()
  selId = null
  undoStack = []
  redoStack = []
  view.zoom = 1
  view.scrollX = START.x
  view.scrollY = START.y
  applyView()
  renderAll()
  refresh()
  board.focus()
}

tiny.window.onCloseRequest(async () => {
  if (!isDirty()) return true
  const choice = await alertBox({
    message: `Do you want to save the changes made to “${docName()}”?`,
    detail: 'Your changes will be lost if you do not save them.',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultButton: 0,
    cancelButton: 2,
  })
  if (choice === 2) return false
  return choice === 0 ? save() : true
})

tiny.app.onOpenFile((p) => void openPath(p))

// ---- menus

function buildMenus(): void {
  const menus: MenuDef[] = [
    {
      title: 'Freeform',
      items: [{ label: 'About Freeform', action: () => void alertBox({ message: 'Freeform', detail: 'An SVG whiteboard for Pear.\nVersion 1.0.0', buttons: ['OK'] }) }],
    },
    {
      title: 'File',
      items: [
        { label: 'New Board', shortcut: 'Cmd+N', action: () => void newBoard() },
        { label: 'Open…', shortcut: 'Cmd+O', action: () => void openDialog() },
        { label: 'Save', shortcut: 'Cmd+S', action: () => void save() },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Cmd+Z', action: undo, disabled: !undoStack.length },
        { label: 'Redo', shortcut: 'Cmd+Shift+Z', action: redo, disabled: !redoStack.length },
        { separator: true },
        { label: 'Delete', action: deleteSel, disabled: !selId },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Zoom In', shortcut: 'Cmd+=', action: () => zoomStep(1.25) },
        { label: 'Zoom Out', shortcut: 'Cmd+-', action: () => zoomStep(1 / 1.25) },
        { label: 'Actual Size', shortcut: 'Cmd+0', action: () => zoomAt(board.clientWidth / 2, board.clientHeight / 2, 1 / view.zoom) },
        { label: 'Fit to Window', action: fitAll },
      ],
    },
  ]
  void tiny.window.setMenus(menus)
}

// ---- start

async function main(): Promise<void> {
  await tiny.ready
  buildToolbar()
  setTool('select')
  applyView()
  const state = tiny.app.state as { path?: string } | undefined | null
  const firstArg = tiny.app.args[0]
  if (typeof firstArg === 'string' && firstArg) await loadPath(firstArg)
  else if (state && typeof state === 'object' && state.path) await loadPath(state.path)
  else renderAll()
  refresh()
  tiny.on('focus', () => board.focus())
  board.focus()
}
void main()
