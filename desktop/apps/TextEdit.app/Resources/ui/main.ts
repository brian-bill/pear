import { basename, dirname, formatBytes, tiny, type MenuDef } from '@tiny/sdk'
import { clip, enter, insert, replaceRange, tab, type Field } from './editing'
import { Gutter } from './gutter'
import { Mirror } from './measure'
import { countMatches, detectEol, find, kindOf, lineCol, lineCount, lineStart, normalize, replaceAll, withEol, type Eol } from './text'

const LARGE_FILE = 5 * 1024 * 1024
const PREFS = 'org.tiny.textedit'

/** What a window keeps between sessions (and what `openWindow` hands a new window). */
interface Saved {
  path?: string | null
  draft?: string
  scroll?: number
  sel?: [number, number]
  eol?: Eol
  bom?: boolean
  readOnly?: boolean
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const app = $('app')
const ta = $<HTMLTextAreaElement>('text')
const findbar = $('findbar')
const findInput = $<HTMLInputElement>('find')
const replInput = $<HTMLInputElement>('repl')
const caseBox = $<HTMLInputElement>('case')
const count = $('count')

// ---- the document

const doc = { path: null as string | null, eol: 'LF' as Eol, bom: false, readOnly: false, saved: '' }
const view = { wrap: true, lines: false, size: 13 }
let recents: string[] = []

const mirror = new Mirror(ta)
const gutter = new Gutter($('gutter'), ta, mirror, () => view.wrap)

const docName = () => (doc.path ? basename(doc.path) : 'Untitled')
const isDirty = () => ta.value !== doc.saved
const isEmptyUntitled = () => !doc.path && ta.value === '' && !isDirty()

/** Dialogs are sheets over the window; when one closes, focus goes back to where it was. */
async function keepFocus<T>(ask: Promise<T>): Promise<T> {
  const was = document.activeElement as HTMLElement | null
  const r = await ask
  ;(was && was !== document.body ? was : ta).focus()
  return r
}
const alertBox = (o: Parameters<typeof tiny.dialogs.alert>[0]) => keepFocus(tiny.dialogs.alert(o))

const shown = { title: '', edited: false }
let statusFrame = 0

function refresh(): void {
  const dirty = isDirty()
  if (docName() !== shown.title) {
    shown.title = docName()
    void tiny.window.setTitle(shown.title)
  }
  if (dirty !== shown.edited) {
    shown.edited = dirty
    void tiny.window.setEdited(dirty)
    buildMenus()
  }
  statusFrame ||= requestAnimationFrame(updateStatus)
}

function updateStatus(): void {
  statusFrame = 0
  const sel = ta.selectionEnd - ta.selectionStart
  const { line, col } = lineCol(ta.value, ta.selectionEnd)
  $('pos').textContent = `Ln ${line}, Col ${col}`
  const n = ta.value.length
  $('chars').textContent = `${n.toLocaleString()} character${n === 1 ? '' : 's'}${sel ? ` (${sel.toLocaleString()} selected)` : ''} · ${lineCount(ta.value).toLocaleString()} lines`
  $('eol').textContent = doc.eol
  $('kind').textContent = kindOf(doc.path)
  $('ro').hidden = !doc.readOnly
}

function setContent(text: string): void {
  ta.value = text
  doc.saved = text
  ta.readOnly = false
  ta.scrollTop = 0
  ta.setSelectionRange(0, 0)
  gutter.update(true)
  updateCount()
  refresh()
}

// ---- opening

const looksBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0)

/** Read `path` into this window. Resolves false if the user declined or it failed. */
async function loadFile(path: string, quiet = false): Promise<boolean> {
  const name = basename(path)
  try {
    const st = await tiny.stat(path)
    if (st.kind === 'dir') throw new Error('It is a folder.')
    if (st.size > LARGE_FILE && (await alertBox({ message: `“${name}” is large (${formatBytes(st.size)}).`, detail: 'Opening a big file can make TextEdit slow.', buttons: ['Open Anyway', 'Cancel'], cancelButton: 1 })) !== 0) return false
    const bytes = await tiny.readFile(path)
    if (looksBinary(bytes) && (await alertBox({ message: `“${name}” does not look like a text file.`, detail: 'Opening it may show garbage.', buttons: ['Open Anyway', 'Cancel'], cancelButton: 1 })) !== 0) return false
    const raw = new TextDecoder().decode(bytes)
    doc.bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    doc.eol = detectEol(raw)
    doc.path = path
    doc.readOnly = (st.mode & 0o222) === 0
    setContent(normalize(raw))
    ta.readOnly = doc.readOnly
    void loadRecents()
    return true
  } catch (e) {
    if (!quiet) await alertBox({ message: `“${name}” could not be opened.`, detail: (e as Error).message })
    return false
  }
}

/** A file asked for: here if this window is an empty Untitled one, else in a new window. */
async function openPath(path: string): Promise<void> {
  if (isEmptyUntitled()) await loadFile(path)
  else if (path === doc.path && !isDirty()) ta.focus()
  else await tiny.app.openWindow({ path } satisfies Saved)
}

async function openDialog(): Promise<void> {
  const paths = await keepFocus(tiny.dialogs.openFile({ title: 'Open', startIn: doc.path ? dirname(doc.path) : undefined, multiple: true }))
  for (const p of paths ?? []) await openPath(p)
}

async function loadRecents(): Promise<void> {
  try {
    const items = await tiny.launchRecents(tiny.app.id)
    recents = [...new Set(items.map((i) => i.target).filter((t) => t.startsWith('/')))].slice(0, 8)
    buildMenus()
  } catch {
    /* recents are a convenience */
  }
}

// ---- saving

async function writeTo(path: string): Promise<boolean> {
  const text = ta.value
  const body = new TextEncoder().encode(withEol(text, doc.eol))
  const data = doc.bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body
  try {
    try {
      await tiny.writeFileAtomic(path, data)
    } catch (e) {
      // a file we may write but whose folder we may not (a picked file): write it in place
      if (!['EACCES', 'EPERM'].includes((e as { code?: string }).code ?? '')) throw e
      await tiny.writeFile(path, data)
    }
  } catch (e) {
    await alertBox({ message: `“${basename(path)}” could not be saved.`, detail: (e as Error).message, buttons: ['OK'] })
    return false
  }
  doc.path = path
  doc.saved = text
  doc.readOnly = false
  ta.readOnly = false
  refresh()
  return true
}

async function saveAs(): Promise<boolean> {
  const path = await keepFocus(tiny.dialogs.saveFile({ title: 'Save', name: doc.path ? basename(doc.path) : 'Untitled.txt', startIn: doc.path ? dirname(doc.path) : undefined }))
  return path ? writeTo(path) : false
}

async function save(): Promise<boolean> {
  if (!doc.path) return saveAs()
  if (doc.readOnly) {
    const i = await alertBox({ message: `“${docName()}” is read-only.`, detail: 'Save a copy to keep your changes.', buttons: ['Save As…', 'Cancel'], cancelButton: 1 })
    return i === 0 ? saveAs() : false
  }
  return writeTo(doc.path)
}

async function revert(): Promise<void> {
  if (!doc.path) return
  if (isDirty() && (await alertBox({ message: `Revert to the saved version of “${docName()}”?`, detail: 'Your changes will be lost.', buttons: ['Revert', 'Cancel'], cancelButton: 1, danger: true })) !== 0) return
  await loadFile(doc.path)
}

tiny.window.onCloseRequest(async () => {
  if (!isDirty()) return true
  const choice = await alertBox({ message: `Do you want to save the changes made to “${docName()}”?`, detail: 'Your changes will be lost if you do not save them.', buttons: ['Save', "Don't Save", 'Cancel'], defaultButton: 0, cancelButton: 2 })
  if (choice === 2) return false
  return choice === 0 ? save() : true
})

tiny.app.onSaveState((): Saved => ({
  path: doc.path,
  draft: isDirty() && ta.value.length < 2_000_000 ? ta.value : undefined,
  scroll: ta.scrollTop,
  sel: [ta.selectionStart, ta.selectionEnd],
  eol: doc.eol,
  bom: doc.bom,
  readOnly: doc.readOnly,
}))

tiny.app.onOpenFile((p) => void openPath(p))

// ---- find

function updateCount(): void {
  const q = findInput.value
  const n = findbar.hidden || !q ? 0 : countMatches(ta.value, q, caseBox.checked)
  count.textContent = findbar.hidden || !q ? '' : n ? `${n} found` : 'Not found'
}

function showFind(): void {
  findbar.hidden = false
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd)
  if (sel && !sel.includes('\n') && document.activeElement === ta) findInput.value = sel
  findInput.focus()
  findInput.select()
  updateCount()
}

function hideFind(): void {
  findbar.hidden = true
  ta.focus()
}

/** Select [a, b) in the document and scroll it into view. */
function reveal(a: number, b: number): void {
  ta.focus()
  ta.setSelectionRange(a, b)
  const lh = mirror.lineHeight
  const y = mirror.top(a) + 8
  if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - 3 * lh) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3)
  refresh()
}

function findNext(backwards = false): boolean {
  const q = findInput.value
  if (!q) {
    showFind()
    return false
  }
  const from = backwards ? ta.selectionStart : ta.selectionEnd
  const i = find(ta.value, q, from, { matchCase: caseBox.checked, backwards })
  updateCount()
  if (i < 0) return false
  reveal(i, i + q.length)
  return true
}

const selectionMatches = () => {
  const q = findInput.value
  const s = ta.value.slice(ta.selectionStart, ta.selectionEnd)
  return !!q && (caseBox.checked ? s === q : s.toLowerCase() === q.toLowerCase())
}

function replaceOne(): void {
  if (ta.readOnly) return
  if (!selectionMatches()) {
    findNext()
    return
  }
  replaceRange(ta, ta.selectionStart, ta.selectionEnd, replInput.value)
  findNext()
}

function replaceEverything(): void {
  if (ta.readOnly) return
  const r = replaceAll(ta.value, findInput.value, replInput.value, caseBox.checked)
  if (!r.count) return void (count.textContent = 'Not found')
  const top = ta.scrollTop
  replaceRange(ta, 0, ta.value.length, r.text)
  ta.setSelectionRange(0, 0)
  ta.scrollTop = top
  count.textContent = `${r.count} replaced`
  refresh()
}

async function gotoLine(): Promise<void> {
  const answer = await keepFocus(tiny.dialogs.prompt(`Go to line (1–${lineCount(ta.value)}):`, { title: 'Go to Line' }))
  const n = Number.parseInt(answer ?? '', 10)
  if (!Number.isFinite(n)) return ta.focus()
  const pos = lineStart(ta.value, Math.max(1, n))
  reveal(pos, pos)
}

// ---- view

function applyView(save = true): void {
  app.classList.toggle('wrap', view.wrap)
  app.style.setProperty('--fs', `${view.size}px`)
  gutter.show(view.lines)
  buildMenus()
  if (save) void tiny.configSet(PREFS, 'prefs', view).catch(() => {})
}
const setSize = (n: number) => {
  view.size = Math.min(36, Math.max(9, n))
  applyView()
}

// ---- menus and commands

/** The field edit commands act on: the find bar's inputs when they have focus, else the document. */
const field = (): Field => (document.activeElement === findInput || document.activeElement === replInput ? (document.activeElement as Field) : ta)
const selected = (f: Field) => f.value.slice(f.selectionStart ?? 0, f.selectionEnd ?? 0)

async function copy(cut: boolean): Promise<void> {
  const f = field()
  const s = selected(f)
  if (!s) return
  await clip.write(s).catch(() => {})
  if (cut && !f.readOnly) insert(f, '')
}

async function paste(): Promise<void> {
  const f = field()
  const t = await clip.read().catch(() => null)
  if (t && !f.readOnly) insert(f, f === ta ? normalize(t) : t.replace(/\s*\n\s*/g, ' '))
}

function buildMenus(): void {
  const recent = recents.map((p) => ({ label: basename(p), action: () => void openPath(p) }))
  const menus: MenuDef[] = [
    { title: 'TextEdit', items: [{ label: 'About TextEdit', action: () => void alertBox({ message: 'TextEdit', detail: 'Plain text editor for Pear.\nVersion 1.0.0', buttons: ['OK'] }) }] },
    {
      title: 'File',
      items: [
        { label: 'New', shortcut: 'Cmd+N', action: () => void tiny.app.openWindow({ path: null } satisfies Saved) },
        { label: 'Open…', shortcut: 'Cmd+O', action: () => void openDialog() },
        ...(recent.length ? [{ separator: true }, { label: 'Recent Documents', disabled: true }, ...recent] : []),
        { separator: true },
        { label: 'Save', shortcut: 'Cmd+S', action: () => void save(), disabled: !isDirty() && !!doc.path },
        { label: 'Save As…', shortcut: 'Cmd+Shift+S', action: () => void saveAs() },
        { label: 'Revert to Saved', action: () => void revert(), disabled: !doc.path },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Cmd+Z', action: () => void document.execCommand('undo') },
        { label: 'Redo', shortcut: 'Cmd+Shift+Z', action: () => void document.execCommand('redo') },
        { separator: true },
        { label: 'Cut', shortcut: 'Cmd+X', action: () => void copy(true) },
        { label: 'Copy', shortcut: 'Cmd+C', action: () => void copy(false) },
        { label: 'Paste', shortcut: 'Cmd+V', action: () => void paste() },
        { label: 'Select All', shortcut: 'Cmd+A', action: () => field().select() },
        { separator: true },
        { label: 'Find…', shortcut: 'Cmd+F', action: showFind },
        { label: 'Find and Replace…', shortcut: 'Cmd+Shift+F', action: () => { showFind(); replInput.focus() } },
        { label: 'Find Next', shortcut: 'Cmd+G', action: () => void findNext() },
        { label: 'Find Previous', shortcut: 'Cmd+Shift+G', action: () => void findNext(true) },
        { separator: true },
        { label: 'Go to Line…', shortcut: 'Cmd+L', action: () => void gotoLine() },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Word Wrap', checked: view.wrap, action: () => { view.wrap = !view.wrap; applyView() } },
        { label: 'Line Numbers', checked: view.lines, action: () => { view.lines = !view.lines; applyView() } },
        { separator: true },
        { label: 'Bigger', shortcut: 'Cmd+=', action: () => setSize(view.size + 1) },
        { label: 'Smaller', shortcut: 'Cmd+-', action: () => setSize(view.size - 1) },
        { label: 'Actual Size', shortcut: 'Cmd+0', action: () => setSize(13) },
      ],
    },
  ]
  void tiny.window.setMenus(menus)
}

// ---- events

ta.addEventListener('input', () => {
  gutter.update()
  updateCount()
  refresh()
})
for (const ev of ['keyup', 'mouseup', 'select', 'focus']) ta.addEventListener(ev, () => (statusFrame ||= requestAnimationFrame(updateStatus)))
ta.addEventListener('keydown', (e) => {
  if (e.isComposing || ta.readOnly) return
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    tab(ta, e.shiftKey)
  } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault()
    enter(ta)
  }
})
// Cmd + (the plus key needs Shift, so it is not a menu shortcut)
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !e.metaKey || e.altKey) return
  if (e.key === '+') {
    e.preventDefault()
    setSize(view.size + 1)
  }
})

findInput.addEventListener('input', updateCount)
caseBox.addEventListener('change', updateCount)
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    findNext(e.shiftKey)
  } else if (e.key === 'Escape') hideFind()
})
replInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    replaceOne()
  } else if (e.key === 'Escape') hideFind()
})
$('next').addEventListener('click', () => void findNext())
$('prev').addEventListener('click', () => void findNext(true))
$('replace').addEventListener('click', replaceOne)
$('replall').addEventListener('click', replaceEverything)
$('closefind').addEventListener('click', hideFind)
tiny.on('focus', () => {
  if (document.activeElement === document.body) ta.focus()
})

// ---- start

async function restore(state: Saved): Promise<void> {
  doc.eol = state.eol ?? 'LF'
  doc.bom = state.bom ?? false
  if (state.path) {
    const ok = await loadFile(state.path, true)
    if (!ok) doc.path = state.draft !== undefined ? state.path : null
  }
  if (state.draft !== undefined) {
    ta.value = state.draft
    doc.readOnly = state.readOnly ?? doc.readOnly
    ta.readOnly = false
    gutter.update(true)
  }
  if (state.sel) ta.setSelectionRange(state.sel[0], state.sel[1])
  ta.scrollTop = state.scroll ?? 0
}

async function main(): Promise<void> {
  await tiny.ready
  try {
    Object.assign(view, await tiny.configGet(PREFS, 'prefs', null))
  } catch {
    /* defaults */
  }
  applyView(false)
  refresh()
  const state = tiny.app.state as Saved | undefined | null
  if (state && typeof state === 'object') await restore(state)
  else if (tiny.app.args[0]) await loadFile(tiny.app.args[0])
  refresh()
  void loadRecents()
  ta.focus()
}
void main()
