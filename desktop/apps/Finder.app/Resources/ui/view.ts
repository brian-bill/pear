import { escapeHtml } from '@tiny/sdk'
import { bus } from './bus'
import { setSort } from './browser'
import { showContextMenu } from './contextmenu'
import { $, dragPaths, hasHostFiles, hasPaths, PATHS_TYPE } from './dom'
import { fillIcon } from './icons'
import { dropHostFiles, moveSelectionTo, renameEntry } from './ops'
import { openEntry } from './open'
import { select } from './sel'
import { folderPath, selectedEntries, st, type Entry, type SortKey } from './state'
import { dateText, sizeText, splitExt, TAG_HEX } from './util'

const scroll = () => $('scroll')
const files = () => $('files')

const tagDots = (e: Entry) =>
  e.tags.length ? `<span class="dots" title="${escapeHtml(e.tags.join(', '))}">${e.tags.map((t) => `<i style="background:${TAG_HEX[t] ?? TAG_HEX.gray}"></i>`).join('')}</span>` : ''

function nameCell(e: Entry): string {
  if (st.renaming === e.path) return `<input class="rename" type="text" value="${escapeHtml(e.name)}" aria-label="Name" spellcheck="false">`
  return `<span class="name">${escapeHtml(e.name)}</span>${tagDots(e)}`
}

const attrs = (e: Entry, i: number) =>
  `id="f${i}" data-path="${escapeHtml(e.path)}" data-dir="${e.isDir}" aria-selected="${st.selection.has(e.path)}" draggable="true" tabindex="-1" title="${escapeHtml(e.where ? e.path : e.name)}"`

function iconsHtml(): string {
  return st.entries
    .map((e, i) => `<div class="item${e.isApp ? ' pkg' : ''}" role="option" ${attrs(e, i)}><img class="thumb" alt="" draggable="false"><div class="label">${nameCell(e)}</div></div>`)
    .join('')
}

const COLS: Array<{ key: SortKey; title: string }> = [
  { key: 'name', title: 'Name' },
  { key: 'date', title: 'Date Modified' },
  { key: 'size', title: 'Size' },
  { key: 'kind', title: 'Kind' },
]

function listHtml(): string {
  const searching = st.loc.type === 'search'
  const head = COLS.map((c) => {
    const on = st.sort.key === c.key
    return `<th role="columnheader" aria-sort="${on ? (st.sort.asc ? 'ascending' : 'descending') : 'none'}"><button class="plain colbtn" data-sort="${c.key}">${c.title}${on ? (st.sort.asc ? ' ▲' : ' ▼') : ''}</button></th>`
  }).join('')
  const rows = st.entries
    .map(
      (e, i) =>
        `<tr role="row" class="item" ${attrs(e, i)}><td role="gridcell"><div class="namecell"><img class="thumb" alt="" draggable="false">${nameCell(e)}</div></td><td role="gridcell">${dateText(e.mtime)}</td><td role="gridcell">${e.isDir ? '--' : sizeText(e.size)}</td><td role="gridcell">${escapeHtml(e.kindText)}</td>${searching ? `<td role="gridcell" class="dim">${escapeHtml(e.where ?? '')}</td>` : ''}</tr>`,
    )
    .join('')
  return `<table class="list" role="grid" aria-label="Files"><colgroup><col><col style="width:150px"><col style="width:84px"><col style="width:150px">${searching ? '<col style="width:200px">' : ''}</colgroup><thead><tr>${head}${searching ? '<th role="columnheader">Where</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`
}

export function render(): void {
  const f = files()
  f.className = st.view
  f.setAttribute('role', st.view === 'list' ? 'presentation' : 'listbox')
  f.setAttribute('aria-multiselectable', 'true')
  f.setAttribute('aria-label', 'Files')
  const top = scroll().scrollTop
  f.innerHTML = st.entries.length ? (st.view === 'list' ? listHtml() : iconsHtml()) : `<div class="empty dim">${st.loading ? '' : st.loc.type === 'search' ? (st.loc.q.trim() ? 'No results' : 'Type to search') : 'Folder is empty'}</div>`
  const byPath = new Map(st.entries.map((e) => [e.path, e]))
  f.querySelectorAll<HTMLElement>('[data-path]').forEach((el) => {
    const e = byPath.get(el.dataset.path!)
    const img = el.querySelector<HTMLImageElement>('img.thumb')
    if (e && img) fillIcon(img, e)
  })
  scroll().scrollTop = top
  if (st.renaming) startRenameInput()
  syncSelection()
}

export function syncSelection(): void {
  const f = files()
  f.querySelectorAll<HTMLElement>('[data-path]').forEach((el) => {
    const on = st.selection.has(el.dataset.path!)
    el.classList.toggle('selected', on)
    el.setAttribute('aria-selected', String(on))
    el.classList.toggle('cursor', el.dataset.path === st.cursor)
  })
  const cur = itemEl(st.cursor)
  if (cur) {
    f.setAttribute('aria-activedescendant', cur.id)
    cur.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  } else f.removeAttribute('aria-activedescendant')
}

export const itemEl = (path: string): HTMLElement | null => (path ? Array.from(files().querySelectorAll<HTMLElement>('[data-path]')).find((el) => el.dataset.path === path) ?? null : null)

// ---- rename

function startRenameInput(): void {
  const e = st.entries.find((x) => x.path === st.renaming)
  const input = e && itemEl(e.path)?.querySelector<HTMLInputElement>('input.rename')
  if (!e || !input) {
    st.renaming = ''
    return
  }
  input.focus()
  input.setSelectionRange(0, e.isDir || e.isApp ? e.name.length : splitExt(e.name)[0].length)
  let done = false
  // the menu that started a rename gives focus back a moment later
  for (const ms of [60, 200, 500]) setTimeout(() => !done && document.activeElement !== input && input.focus(), ms)
  const finish = async (commit: boolean) => {
    if (done) return
    done = true
    st.renaming = ''
    const ok = commit ? await renameEntry(e, input.value) : true
    if (!ok || !commit) render()
    files().focus()
  }
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key === 'Enter') {
      ev.preventDefault()
      void finish(true)
    } else if (ev.key === 'Escape') void finish(false)
  })
  // losing focus to another window (a menu closing, say) is not the end of the edit
  input.addEventListener('blur', () => {
    if (document.hasFocus()) return void finish(true)
    addEventListener('focus', () => !done && input.focus(), { once: true })
  })
  input.addEventListener('dblclick', (ev) => ev.stopPropagation())
}

export function startRename(path = st.cursor): void {
  if (!path || !st.entries.some((e) => e.path === path)) return
  st.renaming = path
  render()
}

// ---- pointer

const entryOf = (el: Element | null): Entry | undefined => {
  const p = el?.closest<HTMLElement>('[data-path]')?.dataset.path
  return p ? st.entries.find((e) => e.path === p) : undefined
}

function rangeSelect(to: string): void {
  const a = st.entries.findIndex((e) => e.path === st.anchor)
  const b = st.entries.findIndex((e) => e.path === to)
  if (b < 0) return
  const [lo, hi] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)]
  st.selection = new Set(st.entries.slice(lo, hi + 1).map((e) => e.path))
  st.cursor = to
  bus.emit('selection')
}

function pressItem(e: Entry, ev: MouseEvent): void {
  if (ev.shiftKey) return rangeSelect(e.path)
  if (ev.metaKey || ev.ctrlKey) {
    const next = new Set(st.selection)
    if (!next.delete(e.path)) next.add(e.path)
    st.selection = next
    st.cursor = st.anchor = e.path
    return bus.emit('selection')
  }
  if (!st.selection.has(e.path)) select([e.path])
  else {
    st.cursor = e.path
    bus.emit('selection')
  }
}

function rubberBand(start: PointerEvent): void {
  const sc = scroll()
  const box = document.createElement('div')
  box.className = 'band'
  sc.append(box)
  const origin = sc.getBoundingClientRect()
  const x0 = start.clientX - origin.left + sc.scrollLeft
  const y0 = start.clientY - origin.top + sc.scrollTop
  const base = start.shiftKey || start.metaKey ? new Set(st.selection) : new Set<string>()
  const els = Array.from(files().querySelectorAll<HTMLElement>('[data-path]'))
  const rects = els.map((el) => {
    const r = el.getBoundingClientRect()
    return { path: el.dataset.path!, l: r.left - origin.left + sc.scrollLeft, t: r.top - origin.top + sc.scrollTop, r: r.right - origin.left + sc.scrollLeft, b: r.bottom - origin.top + sc.scrollTop }
  })
  let moved = false
  const move = (ev: PointerEvent) => {
    const x1 = ev.clientX - origin.left + sc.scrollLeft
    const y1 = ev.clientY - origin.top + sc.scrollTop
    const [l, r, t, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)]
    if (!moved && r - l + (b - t) < 6) return
    moved = true
    box.style.cssText = `left:${l}px;top:${t}px;width:${r - l}px;height:${b - t}px`
    const hit = new Set(base)
    for (const q of rects) if (q.l < r && q.r > l && q.t < b && q.b > t) hit.add(q.path)
    st.selection = hit
    bus.emit('selection')
  }
  const up = () => {
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', up)
    box.remove()
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
}

export function initView(): void {
  const sc = scroll()
  sc.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    const t = ev.target as HTMLElement
    if (t.closest('input, .colbtn')) return
    const e = entryOf(t)
    if (e) return pressItem(e, ev)
    files().focus()
    if (!ev.shiftKey && !ev.metaKey) select([])
    rubberBand(ev)
    ev.preventDefault()
  })
  sc.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement
    const col = t.closest<HTMLElement>('[data-sort]')
    if (col) return setSort(col.dataset.sort as SortKey)
    const e = entryOf(t)
    // a plain click on one of several selected items narrows the selection to it
    if (e && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && st.selection.size > 1 && st.selection.has(e.path)) select([e.path])
    if (e) files().focus({ preventScroll: true })
  })
  sc.addEventListener('dblclick', (ev) => {
    const e = entryOf(ev.target as Element)
    if (e) void openEntry(e)
  })
  sc.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    const e = entryOf(ev.target as Element)
    if (e && !st.selection.has(e.path)) select([e.path])
    if (!e) select([])
    void showContextMenu(ev.clientX, ev.clientY, !!e)
  })

  // ---- drag and drop: within Finder, between folders, and files from the real computer
  sc.addEventListener('dragstart', (ev) => {
    const e = entryOf(ev.target as Element)
    if (!e || !ev.dataTransfer) return ev.preventDefault()
    if (!st.selection.has(e.path)) select([e.path])
    const paths = selectedEntries().map((x) => x.path)
    ev.dataTransfer.setData(PATHS_TYPE, JSON.stringify(paths))
    ev.dataTransfer.setData('text/plain', paths.join('\n'))
    ev.dataTransfer.effectAllowed = 'copyMove'
  })
  const clearDrop = () => sc.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'))
  sc.addEventListener('dragover', (ev) => {
    clearDrop()
    const own = hasPaths(ev)
    if (!own && !hasHostFiles(ev)) return
    const target = entryOf(ev.target as Element)
    const folderTarget = target?.isDir && !st.selection.has(target.path) ? target : undefined
    if (own && !folderTarget && st.loc.type !== 'folder') return
    ev.preventDefault()
    ev.dataTransfer!.dropEffect = hasHostFiles(ev) || ev.altKey ? 'copy' : 'move'
    if (folderTarget) itemEl(folderTarget.path)?.classList.add('drop')
    else if (st.loc.type === 'folder') sc.classList.add('dropzone')
  })
  sc.addEventListener('dragleave', (ev) => {
    if (ev.target === sc) sc.classList.remove('dropzone')
    ;(ev.target as HTMLElement).closest?.('.drop')?.classList.remove('drop')
  })
  sc.addEventListener('drop', (ev) => {
    clearDrop()
    sc.classList.remove('dropzone')
    const target = entryOf(ev.target as Element)
    const dest = target?.isDir && !st.selection.has(target.path) ? target.path : st.loc.type === 'folder' ? st.loc.path : ''
    if (!dest) return
    if (hasPaths(ev)) {
      ev.preventDefault()
      void moveSelectionTo(dest, ev.altKey, dragPaths(ev))
    } else if (hasHostFiles(ev)) {
      ev.preventDefault()
      void dropHostFiles(Array.from(ev.dataTransfer!.files), dest || folderPath())
    }
  })
  addEventListener('dragend', clearDrop)

  bus.on('entries', render)
  bus.on('selection', syncSelection)
}
