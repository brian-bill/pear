import { basename, bytesOf, textOf, tiny, type MenuDef } from '@tiny/sdk'

const HOME = '/Users/pear'
const DOCS = `${HOME}/Documents`
const NOTES_DIR = `${DOCS}/Notes`
const TRASH = `${HOME}/.Trash`
const PREFS = 'org.tiny.notes'
const DRAFT_MS = 600 // autosave after this much quiet
const FONT_MIN = 9
const FONT_MAX = 30

/** What a window keeps between sessions: the open note and its unsaved text. */
interface Saved {
  /** Path of the open note (in the Notes folder, or an outside file opened with Open…). */
  id?: string | null
  /** The text as typed, including edits not saved to disk yet. */
  text?: string
  scroll?: number
}

interface Note {
  path: string
  /** The file name without extension, what the list shows. */
  name: string
  text: string
  mtime: number
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ta = $<HTMLTextAreaElement>('text')
const search = $<HTMLInputElement>('search')
const list = $('list')

const doc = { path: null as string | null, saved: null as string | null }
const view = { size: 13 }
let notes: Note[] = []
const shown = { title: '', edited: false }
let saveTimer = 0
let saving = false

// ---- small helpers

const stemOf = (p: string) => {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}
const inNotes = (p: string) => p.startsWith(`${NOTES_DIR}/`)
const pathExists = (p: string) => tiny.exists(p).catch(() => false)
const isDirty = () => doc.path !== null && ta.value !== doc.saved

/** A plain file name from a note's first line (`Groceries`); empty when that line is blank. */
const titleOf = (text: string) =>
  (text.split('\n', 1)[0] ?? '').replace(/[/\\:]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64)

/** The second line of a note, shown under its name in the list. */
const snippetOf = (text: string) => {
  const second = (text.split('\n')[1] ?? '').trim()
  return second || 'No additional text'
}

/** A short edited-at stamp for a row; old notes fall back to the calendar date. */
const relTime = (ms: number): string => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d`
  return new Date(ms).toLocaleDateString()
}

/** Dialogs are sheets over the window; when one closes, focus goes back to where it was. */
async function keepFocus<T>(ask: Promise<T>): Promise<T> {
  const was = document.activeElement as HTMLElement | null
  const r = await ask
    ; (was && was !== document.body ? was : ta).focus()
  return r
}
const alertBox = (o: Parameters<typeof tiny.dialogs.alert>[0]) => keepFocus(tiny.dialogs.alert(o))

// ---- window chrome (title follows the file name, like a TextEdit document window)

function refresh(): void {
  const name = doc.path ? basename(doc.path) : 'Notes'
  const dirty = isDirty()
  if (name !== shown.title) {
    shown.title = name
    void tiny.window.setTitle(name)
  }
  if (dirty !== shown.edited) {
    shown.edited = dirty
    void tiny.window.setEdited(dirty)
  }
}

// ---- the list

async function loadList(): Promise<void> {
  try {
    const entries = await tiny.readdir(NOTES_DIR)
    const loaded: Note[] = []
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.txt')) continue
      const path = `${NOTES_DIR}/${e.name}`
      try {
        const [st, bytes] = await Promise.all([tiny.stat(path), tiny.readFile(path)])
        loaded.push({ path, name: stemOf(e.name), text: textOf(bytes), mtime: st.mtime })
      } catch {
        /* an unreadable file is skipped */
      }
    }
    notes = loaded.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  } catch {
    notes = [] // no Notes folder yet
  }
  renderList()
}

function renderList(): void {
  const q = search.value.trim().toLowerCase()
  const visible = q ? notes.filter((n) => n.name.toLowerCase().includes(q) || n.text.toLowerCase().includes(q)) : notes
  list.replaceChildren(
    ...visible.map((n) => {
      const row = document.createElement('button')
      row.className = 'note'
      row.dataset.path = n.path
      row.dataset.name = n.name
      row.setAttribute('role', 'option')
      row.classList.toggle('sel', n.path === doc.path)
      row.setAttribute('aria-selected', String(n.path === doc.path))
      row.append(
        Object.assign(document.createElement('span'), { className: 'ntitle', textContent: n.name }),
        Object.assign(document.createElement('span'), { className: 'nfoot' }),
      )
      const foot = row.lastElementChild as HTMLElement
      foot.append(
        Object.assign(document.createElement('span'), { className: 'nsnippet', textContent: snippetOf(n.text) }),
        Object.assign(document.createElement('span'), { className: 'ntime', textContent: relTime(n.mtime) }),
      )
      row.addEventListener('click', () => void select(n.path))
      return row
    }),
  )
  const empty = $('empty')
  empty.hidden = visible.length > 0
  empty.textContent = q ? 'No matches' : 'No notes yet — press ⌘N to add one'
}

// ---- the document

function showNote(path: string, text: string, saved: string | null): void {
  doc.path = path
  doc.saved = saved
  ta.readOnly = false
  ta.value = text
  ta.scrollTop = 0
  ta.setSelectionRange(0, 0)
  renderList()
  buildMenus()
  refresh()
  void tiny.app.stateChanged()
}

function clearDoc(): void {
  doc.path = null
  doc.saved = null
  ta.value = ''
  ta.readOnly = true
  renderList()
  buildMenus()
  refresh()
  void tiny.app.stateChanged()
}

/** Read `path` into the editor. `draft` (a saved session's text) wins over what the file has. */
async function select(path: string, draft?: string): Promise<void> {
  if (doc.path === path && draft === undefined) {
    ta.focus()
    return
  }
  if (doc.path !== path) await saveNow() // the note being edited is written before we switch
  const name = basename(path)
  let saved: string | null = null
  let text = draft ?? ''
  try {
    saved = textOf(await tiny.readFile(path))
    if (draft === undefined) text = saved
  } catch (e) {
    if (draft === undefined) {
      void alertBox({ message: `“${name}” could not be opened.`, detail: (e as Error).message, buttons: ['OK'] })
      return
    }
    /* a draft without a file behind it (the note it belonged to is gone) is still worth showing */
  }
  showNote(path, text, saved)
  ta.focus()
}

// ---- saving

function edited(): void {
  const dirty = isDirty()
  if (dirty !== shown.edited) {
    shown.edited = dirty
    void tiny.window.setEdited(dirty)
  }
  void tiny.app.stateChanged()
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void saveNow(), DRAFT_MS)
}

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

/** A note inside the Notes folder lives under its first line: keep the file name in step. */
async function mayRename(was: string, text: string): Promise<string> {
  const stem = titleOf(text)
  if (!stem || !inNotes(was) || stem === stemOf(was)) return was
  const target = `${NOTES_DIR}/${stem}.txt`
  if (target === was) return was
  try {
    if (await retry(() => tiny.exists(target))) return was // the name is taken: this note keeps its file
    await retry(() => tiny.rename(was, target))
    return target
  } catch (e) {
    console.error('Notes: could not rename the note', e)
    return was
  }
}

/** Write the open note to disk now (autosave calls this too). */
async function saveNow(): Promise<void> {
  clearTimeout(saveTimer)
  saveTimer = 0
  if (saving) {
    saveTimer = window.setTimeout(() => void saveNow(), DRAFT_MS)
    return
  }
  const path = doc.path
  const text = ta.value
  if (!path || text === doc.saved) return
  const data = bytesOf(text)
  saving = true
  try {
    try {
      await retry(() => tiny.writeFileAtomic(path, data))
    } catch (e) {
      // a file we may write but whose folder we may not: write it in place
      if (!['EACCES', 'EPERM'].includes((e as { code?: string }).code ?? '')) throw e
      await retry(() => tiny.writeFile(path, data))
    }
  } catch (e) {
    void alertBox({ message: `“${basename(path)}” could not be saved.`, detail: (e as Error).message, buttons: ['OK'] })
    return
  } finally {
    saving = false
  }
  doc.saved = text // typing that arrived meanwhile stays unsaved and outlives this save
  doc.path = await mayRename(path, text)
  refresh()
  void loadList()
  void tiny.app.stateChanged()
}

// ---- commands

async function newNote(): Promise<void> {
  try {
    console.log('Notes: creating the Notes folder')
    await tiny.mkdir(NOTES_DIR, { recursive: true })
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') {
      void alertBox({ message: 'Notes could not make the Notes folder.', detail: (e as Error).message, buttons: ['OK'] })
      return
    }
  }
  let n = 1
  for (; await pathExists(`${NOTES_DIR}/Note ${n}.txt`); n++);
  const path = `${NOTES_DIR}/Note ${n}.txt`
  try {
    await tiny.writeFileAtomic(path, bytesOf(''))
  } catch (e) {
    void alertBox({ message: 'A new note could not be created.', detail: (e as Error).message, buttons: ['OK'] })
    return
  }
  await loadList()
  await select(path)
}

async function openNote(): Promise<void> {
  const paths = await keepFocus(
    tiny.dialogs.openFile({
      title: 'Open',
      startIn: DOCS,
      filters: [{ name: 'Text Files', ext: ['txt', 'md'] }],
    }),
  )
  const p = paths?.[0]
  if (p) await select(p)
}

/** Move the open note to the Trash, asking first. A note being typed is written before it leaves. */
async function deleteNote(): Promise<void> {
  if (!doc.path) return
  await saveNow()
  const path = doc.path
  if (!path) return
  const name = stemOf(path)
  const choice = await keepFocus(
    tiny.dialogs.alert({
      message: `Delete the note “${name}”?`,
      detail: 'The note moves to the Trash.',
      buttons: ['Delete', 'Cancel'],
      defaultButton: 0,
      cancelButton: 1,
      danger: true,
    }),
  )
  if (choice !== 0) return
  try {
    await tiny.trash(path, TRASH)
  } catch (e) {
    void alertBox({ message: `“${name}” could not be deleted.`, detail: (e as Error).message, buttons: ['OK'] })
    return
  }
  clearDoc()
  await loadList()
}

function applySize(save = true): void {
  document.documentElement.style.setProperty('--fs', `${view.size}px`)
  if (save) void tiny.configSet(PREFS, 'view', view).catch(() => { })
}
function setSize(n: number): void {
  view.size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)))
  applySize()
}

const about = () =>
  void alertBox({ message: 'Notes', detail: 'Plain notes in ~/Documents/Notes.\nVersion 1.0.0', buttons: ['OK'] })

function buildMenus(): void {
  const open = doc.path !== null
  const menus: MenuDef[] = [
    { title: 'Notes', items: [{ label: 'About Notes', action: about }] },
    {
      title: 'File',
      items: [
        { label: 'New Note', shortcut: 'Cmd+N', action: () => void newNote() },
        { label: 'Open…', shortcut: 'Cmd+O', action: () => void openNote() },
        { separator: true },
        { label: 'Save', shortcut: 'Cmd+S', action: () => void saveNow(), disabled: !open },
        { separator: true },
        { label: 'Close Window', action: () => void tiny.window.close() },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Cut', shortcut: 'Cmd+X', action: () => void document.execCommand('cut') },
        { label: 'Copy', shortcut: 'Cmd+C', action: () => void document.execCommand('copy') },
        { label: 'Paste', shortcut: 'Cmd+V', action: () => void document.execCommand('paste') },
        { label: 'Select All', shortcut: 'Cmd+A', action: () => ta.select() },
        { separator: true },
        { label: 'Delete', shortcut: 'Cmd+Backspace', action: () => void deleteNote(), disabled: !open },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Bigger Text', shortcut: 'Cmd+=', action: () => setSize(view.size + 1) },
        { label: 'Smaller Text', shortcut: 'Cmd+-', action: () => setSize(view.size - 1) },
        { label: 'Actual Size', shortcut: 'Cmd+0', action: () => setSize(13) },
      ],
    },
  ]
  void tiny.window.setMenus(menus)
}

// ---- events

ta.addEventListener('input', edited)
search.addEventListener('input', renderList)
tiny.on('focus', () => {
  if (document.activeElement === document.body) ta.focus()
})
// the pending autosave is flushed; typed text never leaves only in the session's hands
tiny.window.onCloseRequest(async () => {
  await saveNow()
  return true
})
tiny.app.onOpenFile((p) => void select(p))
tiny.app.onSaveState((): Saved => {
  const id = doc.path
  return { id, text: id && ta.value.length < 1_000_000 ? ta.value : undefined, scroll: ta.scrollTop }
})

// ---- start

async function main(): Promise<void> {
  await tiny.ready
  try {
    const prefs = (await tiny.configGet(PREFS, 'view', null)) as { size?: number } | null
    if (typeof prefs?.size === 'number') view.size = Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.size))
  } catch {
    /* defaults */
  }
  applySize(false)
  await loadList()
  const state = tiny.app.state as Saved | undefined | null
  const arg = tiny.app.args[0]
  if (state?.id) await select(state.id, state.text)
  else if (arg) await select(String(arg))
  else if (notes[0]) await select(notes[0].path)
  buildMenus()
  refresh()
  ta.focus()
}
void main()
