// Pear Reminders — lists and reminders.
//
// Data shape, stored as one JSON file at ~/Library/Reminders.json:
//   { version: 1, lists: [{ id, title, items: [{ id, title, completed, due?, notes? }] }] }
// `due` is an ISO 8601 instant or absent; `notes` an optional line. Every change rewrites the
// whole store with writeFileAtomic (the folder is created with a recursive mkdir; ENOENT while
// reading just means an empty store — first run seeds a "Personal" list and writes the file).
import { tiny } from '@tiny/sdk'

interface Item { id: string; title: string; completed: boolean; due?: string; notes?: string }
interface RList { id: string; title: string; items: Item[] }
interface Store { version: 1; lists: RList[] }

const HOME = '/Users/pear'
const LIB = `${HOME}/Library`
const STORE = `${LIB}/Reminders.json`
/** Sidebar id of the smart list: everything due today or overdue, across lists. */
const TODAY = '@today'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const uid = () => crypto.randomUUID().slice(0, 8)
const text = new TextEncoder()
const fromText = new TextDecoder()

const store: Store = { version: 1, lists: [] }
let view = TODAY // id of the list or smart list shown (init to the first list after load)
let selectedId: string | null = null // row showing its details line
let focusBack = '' // title input to re-focus after the rows re-render (inline editing)
let showCompleted = true
const notified = new Set<string>() // item ids that already fired a notification in this session
let notifyTimer: number | undefined

// ---- the store on disk

/** Parse one saved item defensively; anything malformed is dropped. */
function asItem(x: unknown): Item | null {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.title !== 'string' || typeof o.completed !== 'boolean') return null
  return {
    id: o.id,
    title: o.title,
    completed: o.completed,
    ...(typeof o.due === 'string' ? { due: o.due } : {}),
    ...(typeof o.notes === 'string' ? { notes: o.notes } : {}),
  }
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

/** A read that failed for a reason other than "no file yet": the store must not be overwritten. */
let unreadable = false

/** Read ~/Library/Reminders.json. Resolves false when there was nothing (or nothing valid). */
async function load(): Promise<boolean> {
  try {
    const raw = JSON.parse(fromText.decode(await retry(() => tiny.readFile(STORE)))) as unknown
    const lists = (raw as { lists?: unknown }).lists
    if (!Array.isArray(lists)) throw new Error('unexpected shape')
    const parsed: RList[] = []
    for (const x of lists) {
      if (typeof x !== 'object' || x === null) continue
      const o = x as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.title !== 'string' || !Array.isArray(o.items)) continue
      parsed.push({ id: o.id, title: o.title, items: o.items.map(asItem).filter((i): i is Item => i !== null) })
    }
    if (!parsed.length) throw new Error('no lists inside')
    store.lists = parsed
    return true
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT') { /* first run: an empty store */ }
    else {
      unreadable = true
      console.error('Reminders: could not read', e)
    }
    return false
  }
}

/** Write the store atomically. The Library folder is created if missing. */
async function persist(): Promise<void> {
  try {
    await tiny.mkdir(LIB, { recursive: true })
    await retry(() => tiny.writeFileAtomic(STORE, text.encode(JSON.stringify(store, null, '\t'))))
  } catch (e) {
    console.error('Reminders: could not save', e)
  }
}

/** A change: mutate the store, write it out, then repaint. */
async function commit(mutation: () => void): Promise<void> {
  mutation()
  await persist()
  render()
  scheduleNotify()
}

// ---- queries

const currentList = (): RList | null => store.lists.find((l) => l.id === view) ?? null
const findEntry = (id: string | null): { item: Item; list: RList } | null => {
  for (const list of store.lists) {
    const item = list.items.find((i) => i.id === id)
    if (item) return { item, list }
  }
  return null
}

const startOfDay = (ms: number): number => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
/** Is this due date today or earlier (overdue), in local time? */
const dueToday = (iso: string | undefined): boolean => {
  if (!iso) return false
  const t = new Date(iso).getTime()
  return !Number.isNaN(t) && t < startOfDay(Date.now() + 86_400_000)
}

/** The rows the current view shows, with the list each belongs to. */
function viewEntries(): Array<{ item: Item; list: RList }> {
  const cur = currentList()
  if (cur) return cur.items.map((item) => ({ item, list: cur }))
  const out: Array<{ item: Item; list: RList }> = []
  for (const list of store.lists) {
    for (const item of list.items) {
      if (dueToday(item.due)) out.push({ item, list })
    }
  }
  return out
}

/** The list a New Reminder goes to. In Today the first list is the target. */
function targetList(): RList | null {
  if (view !== TODAY) return currentList()
  return store.lists[0] ?? null
}

// ---- mutations

function addItem(value: string): void {
  const list = targetList()
  if (!list) return
  const item: Item = { id: uid(), title: value, completed: false }
  const firstDone = list.items.findIndex((i) => i.completed) // open items stay above completed ones
  if (firstDone < 0) list.items.push(item)
  else list.items.splice(firstDone, 0, item)
  selectedId = item.id
  view = list.id // from Today the row would have no due date yet: land on the list
}

/** Toggle one item and keep open items above completed ones (completed move to the bottom). */
function toggleEntry(item: Item, list: RList): void {
  item.completed = !item.completed
  const at = list.items.indexOf(item)
  if (at >= 0) list.items.splice(at, 1)
  const firstDone = list.items.findIndex((i) => i.completed)
  if (!item.completed && firstDone >= 0) list.items.splice(firstDone, 0, item)
  else list.items.push(item)
}

function deleteSelected(): void {
  const found = findEntry(selectedId)
  if (!found) return
  const at = found.list.items.indexOf(found.item)
  if (at >= 0) found.list.items.splice(at, 1)
  selectedId = null
}

function select(id: string): void {
  if (selectedId === id) return
  selectedId = id
  focusBack = id
  renderRows() // the details line moves to the newly selected row
  buildMenus() // Delete and Complete enablement follow the selection
}

// ---- due date helpers

const pad = (n: number) => String(n).padStart(2, '0')

/** The value a `<input type="datetime-local">` takes for an ISO instant (local time). */
function localInput(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The little chip text: Today 2:30 PM · Tomorrow · Oct 23, 2:30 PM. */
function chipText(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = startOfDay(Date.now())
  const that = startOfDay(d.getTime())
  const day = d.toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric' })
  if (that === today) return `Today ${time}`
  if (that === today + 86_400_000) return `Tomorrow ${time}`
  return `${day}, ${time}`
}

// ---- rendering

function render(): void {
  renderSidebar()
  renderRows()
  updateTitle()
  buildMenus()
}

function navItem(id: string, label: string, count: number): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'item' + (view === id ? ' selected' : '')
  b.setAttribute('aria-current', String(view === id))
  const lbl = document.createElement('span')
  lbl.className = 'lbl'
  lbl.textContent = label
  b.append(lbl)
  if (count) { // badges show open items; zero stays quiet
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.textContent = String(count)
    b.append(badge)
  }
  b.addEventListener('click', () => { view = id; selectedId = null; render() })
  return b
}

function renderSidebar(): void {
  const parts: Array<HTMLButtonElement | HTMLHeadingElement> = [
    navItem(TODAY, 'Today', viewEntries().filter((e) => !e.item.completed).length),
  ]
  const h = document.createElement('h4')
  h.textContent = 'My Lists'
  parts.push(h)
  for (const list of store.lists) {
    parts.push(navItem(list.id, list.title, list.items.filter((i) => !i.completed).length))
  }
  $('sidebar').replaceChildren(...parts)
}

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function rowEl(item: Item, list: RList): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'item' + (item.completed ? ' done' : '') + (item.id === selectedId ? ' selected' : '')
  row.dataset.id = item.id
  row.dataset.title = item.title
  row.setAttribute('role', 'listitem')

  const hrow = document.createElement('div')
  hrow.className = 'hrow'

  const circle = document.createElement('button')
  circle.className = 'circle' + (item.completed ? ' done' : '')
  circle.innerHTML = CHECK
  circle.setAttribute('aria-label', item.completed ? 'Mark not completed' : 'Mark completed')
  circle.setAttribute('aria-pressed', String(item.completed))
  circle.addEventListener('click', () => void commit(() => toggleEntry(item, list)))

  const title = document.createElement('input')
  title.className = 'title'
  title.type = 'text'
  title.value = item.title
  title.setAttribute('aria-label', item.title)
  title.setAttribute('spellcheck', 'false')
  title.addEventListener('focus', () => select(item.id))
  title.addEventListener('change', () => {
    const v = title.value.trim()
    if (!v || v === item.title) { title.value = item.title; return } // an empty line is not a title
    title.value = v
    void commit(() => { item.title = v })
  })
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur() }
    else if (e.key === 'Escape') { e.preventDefault(); title.value = item.title; title.blur() }
  })

  hrow.append(circle, title)
  hrow.addEventListener('click', () => select(item.id))
  const t = item.due ? new Date(item.due).getTime() : NaN
  if (!Number.isNaN(t)) {
    const chip = document.createElement('span')
    chip.className = 'chip' + (t < Date.now() ? ' overdue' : dueToday(item.due) ? ' today' : '')
    chip.textContent = chipText(item.due!)
    hrow.append(chip)
  }
  if (view === TODAY) {
    const src = document.createElement('span')
    src.className = 'src'
    src.textContent = list.title
    hrow.append(src)
  }

  row.append(hrow)
  if (item.id === selectedId) row.append(detailsEl(item))
  return row
}

/** The details line under the selected row: an always-visible due field plus notes. */
function detailsEl(item: Item): HTMLDivElement {
  const det = document.createElement('div')
  det.className = 'details'

  const due = document.createElement('input')
  due.id = 'due'
  due.type = 'datetime-local'
  due.value = item.due ? localInput(item.due) : ''
  due.setAttribute('aria-label', 'Due date')
  due.addEventListener('change', () => {
    const v = due.value
    void commit(() => { item.due = v ? new Date(v).toISOString() : undefined })
  })

  const notes = document.createElement('input')
  notes.id = 'notes'
  notes.className = 'notes'
  notes.type = 'text'
  notes.placeholder = 'Notes'
  notes.value = item.notes ?? ''
  notes.setAttribute('aria-label', 'Notes')
  notes.addEventListener('change', () => {
    const v = notes.value.trim()
    void commit(() => { item.notes = v || undefined })
  })

  det.append(due, notes)
  return det
}

function renderRows(): void {
  const entries = viewEntries().filter((e) => showCompleted || !e.item.completed)
  const rows = $('rows')
  if (!entries.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = view === TODAY ? 'Nothing due today' : 'No Reminders'
    rows.replaceChildren(empty)
    return
  }
  const refocus = focusBack
  focusBack = ''
  rows.replaceChildren(...entries.map((e) => rowEl(e.item, e.list)))
  if (refocus) { // inline editing survives the repaint
    const input = rows.querySelector<HTMLInputElement>(`.item[data-id="${refocus}"] input.title`)
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
  }
}

function updateTitle(): void {
  const open = viewEntries().filter((e) => !e.item.completed).length
  void tiny.window.setTitle(open ? `Reminders (${open})` : 'Reminders')
  $('listname').textContent = view === TODAY ? 'Today' : currentList()?.title ?? 'Reminders'
  $('listsub').textContent = open === 1 ? '1 open' : `${open} open`
}

// ---- due-time notifications
//
// Limits, on purpose: a reminder fires only while a Reminders window is open (the schedule lives
// in memory, there is no service-side scheduler), each item notifies at most once per session,
// and fires go in batches rescheduled at most once a minute (a plain setTimeout loop, not cron).

function scheduleNotify(): void {
  if (notifyTimer !== undefined) window.clearTimeout(notifyTimer)
  notifyTimer = undefined
  const now = Date.now()
  let next = 0
  for (const list of store.lists) {
    for (const item of list.items) {
      if (item.completed || !item.due || notified.has(item.id)) continue
      const t = new Date(item.due).getTime()
      if (t > now && (next === 0 || t < next)) next = t
    }
  }
  if (!next) return
  const delay = Math.min(Math.max(next - now, 500), 60_000)
  notifyTimer = window.setTimeout(fireNotify, delay)
}

function fireNotify(): void {
  notifyTimer = undefined
  const now = Date.now()
  for (const list of store.lists) {
    for (const item of list.items) {
      if (item.completed || !item.due || notified.has(item.id)) continue
      const t = new Date(item.due).getTime()
      if (t <= now && now - t < 65_000) {
        notified.add(item.id)
        void tiny.service('tiny.notifications', { op: 'post', title: item.title, body: `Due now · ${list.title}` }).catch(() => {})
      }
    }
  }
  scheduleNotify()
}

// ---- menus and commands

function focusAdd(): void {
  $('add').focus()
}

async function newList(): Promise<void> {
  const name = await tiny.dialogs.prompt('Name for the new list:', { title: 'New List', value: 'New List' })
  const trimmed = name?.trim()
  if (!trimmed) return
  await commit(() => {
    const list: RList = { id: uid(), title: trimmed, items: [] }
    store.lists.push(list)
    view = list.id
    selectedId = null
  })
}

function toggleSelected(): void {
  const found = findEntry(selectedId)
  if (!found) return
  toggleEntry(found.item, found.list)
}

function buildMenus(): void {
  void tiny.window.setMenus([
    {
      title: 'Reminders',
      items: [{ label: 'About Reminders', action: () => void tiny.dialogs.alert({ message: 'Reminders', detail: 'Lists, reminders and due dates for Pear.\nVersion 1.0.0', buttons: ['OK'] }) }],
    },
    {
      title: 'File',
      items: [
        { label: 'New List…', shortcut: 'Cmd+Shift+N', action: () => void newList() },
        { label: 'New Reminder', shortcut: 'Cmd+N', action: () => focusAdd() },
        { separator: true },
        { label: 'Delete Reminder', action: () => void commit(deleteSelected), disabled: !selectedId },
      ],
    },
    {
      title: 'Edit',
      items: [{ label: 'Toggle Complete', shortcut: 'Cmd+K', action: () => void commit(toggleSelected), disabled: !findEntry(selectedId) }],
    },
    {
      title: 'View',
      items: [{ label: showCompleted ? 'Hide Completed' : 'Show Completed', action: () => { showCompleted = !showCompleted; render() } }],
    },
  ])
}

// ---- boot

function bindEvents(): void {
  const add = $<HTMLInputElement>('add')
  add.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { add.value = ''; return }
    if (e.key !== 'Enter') return
    const value = add.value.trim()
    if (!value) return
    add.value = ''
    void commit(() => addItem(value))
  })
  tiny.on('focus', () => scheduleNotify())
}

async function main(): Promise<void> {
  await tiny.ready
  bindEvents()
  const existed = await load()
  if (!store.lists.length) store.lists = [{ id: uid(), title: 'Personal', items: [] }]
  view = store.lists[0]?.id ?? TODAY
  render()
  scheduleNotify()
  if (!existed && !unreadable) await persist() // first run: create ~/Library/Reminders.json
  focusAdd()
}

void main()
