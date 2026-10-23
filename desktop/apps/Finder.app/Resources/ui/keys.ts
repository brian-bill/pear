import { up } from './browser'
import { isTyping } from './dom'
import { trashEntries } from './ops'
import { openSelection } from './open'
import { select } from './sel'
import { st } from './state'
import { toggleQuickLook } from './preview'
import { itemEl, startRename } from './view'
import { bus } from './bus'
import { toggleHidden } from './chrome'

/** Number of icons per row, from the layout. */
function columns(): number {
  if (st.view === 'list') return 1
  const first = itemEl(st.entries[0]?.path ?? '')
  if (!first) return 1
  let n = 0
  for (const e of st.entries) {
    if (itemEl(e.path)!.offsetTop !== first.offsetTop) break
    n++
  }
  return Math.max(1, n)
}

export function moveCursor(delta: number, extend: boolean): void {
  if (!st.entries.length) return
  const at = st.entries.findIndex((e) => e.path === st.cursor)
  const i = at < 0 ? (delta > 0 ? 0 : st.entries.length - 1) : Math.min(st.entries.length - 1, Math.max(0, at + delta))
  const path = st.entries[i]!.path
  if (!extend) return select([path])
  const a = Math.max(0, st.entries.findIndex((e) => e.path === st.anchor))
  const [lo, hi] = [Math.min(a, i), Math.max(a, i)]
  st.selection = new Set(st.entries.slice(lo, hi + 1).map((e) => e.path))
  st.cursor = path
  bus.emit('selection')
}

let typed = ''
let typedAt = 0
function typeToSelect(ch: string): void {
  const now = Date.now()
  typed = now - typedAt > 900 ? ch : typed + ch
  typedAt = now
  const lower = typed.toLowerCase()
  const hit = st.entries.find((e) => e.name.toLowerCase().startsWith(lower)) ?? (typed.length === 1 ? undefined : st.entries.find((e) => e.name.toLowerCase().startsWith(ch.toLowerCase())))
  if (hit) select([hit.path])
}

export function initKeys(): void {
  // Edit shortcuts belong to a text field while one has focus: keep the SDK's menu shortcuts out of its way
  addEventListener(
    'keydown',
    (e) => {
      if (isTyping(e.target) && (e.metaKey || e.ctrlKey) && ['a', 'c', 'x', 'v', 'z', 'Backspace'].includes(e.key.length === 1 ? e.key.toLowerCase() : e.key)) e.stopImmediatePropagation()
    },
    true,
  )

  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.isComposing) return
    const cmd = e.metaKey || e.ctrlKey
    const k = e.key
    if (cmd) {
      if (k === 'ArrowDown') return void (e.preventDefault(), openSelection())
      if (k === 'ArrowUp') return void (e.preventDefault(), up())
      if (e.shiftKey && k === '>') return void (e.preventDefault(), toggleHidden())
      return
    }
    if (e.altKey) return
    switch (k) {
      case 'ArrowRight': return void (e.preventDefault(), moveCursor(1, e.shiftKey))
      case 'ArrowLeft': return void (e.preventDefault(), moveCursor(-1, e.shiftKey))
      case 'ArrowDown': return void (e.preventDefault(), moveCursor(columns(), e.shiftKey))
      case 'ArrowUp': return void (e.preventDefault(), moveCursor(-columns(), e.shiftKey))
      case 'Home': return void (e.preventDefault(), moveCursor(-1e9, e.shiftKey))
      case 'End': return void (e.preventDefault(), moveCursor(1e9, e.shiftKey))
      case 'Enter': return void (e.preventDefault(), openSelection())
      case 'F2': return void (e.preventDefault(), startRename())
      case 'Backspace': case 'Delete': return void (e.preventDefault(), trashEntries())
      case ' ': return void (e.preventDefault(), toggleQuickLook())
      case 'Escape':
        if (st.quickLook) toggleQuickLook()
        else select([])
        return
    }
    if (k.length === 1 && !e.ctrlKey) typeToSelect(k)
  })
}

