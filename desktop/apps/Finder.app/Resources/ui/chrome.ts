import { tiny, escapeHtml, formatBytes } from '@tiny/sdk'
import { bus } from './bus'
import { applyView, canBack, canForward, canUp, go, goFolder, setSort, step, up } from './browser'
import { $, debounce, dragPaths, hasPaths } from './dom'
import { moveSelectionTo } from './ops'
import { saveSearch } from './saved'
import { folderPath, st, type SortKey, type ViewMode } from './state'
import { folderTitle, TRASH } from './util'

export function setView(v: ViewMode): void {
  st.view = v
  bus.emit('entries')
  bus.emit('chrome')
}

export function toggleHidden(): void {
  st.showHidden = !st.showHidden
  applyView()
  bus.emit('chrome')
}

export function locationTitle(): string {
  const l = st.loc
  return l.type === 'folder' ? folderTitle(l.path) : l.label ?? `Search: ${l.q}`
}

function renderPath(): void {
  const bar = $('pathbar')
  const l = st.loc
  if (l.type === 'search') {
    bar.innerHTML = `<span class="dim">${escapeHtml(l.label ?? `Search: ${l.q}`)}</span>`
    return
  }
  const parts = l.path.split('/').filter(Boolean)
  const crumbs = [{ label: 'Macintosh HD', path: '/' }, ...parts.map((p, i) => ({ label: p, path: '/' + parts.slice(0, i + 1).join('/') }))]
  bar.innerHTML = crumbs.map((c, i) => `<button class="plain crumb" data-path="${escapeHtml(c.path)}" ${i === crumbs.length - 1 ? 'aria-current="location"' : ''}>${escapeHtml(c.label)}</button>`).join('<span class="sep" aria-hidden="true">›</span>')
}

function renderStatus(): void {
  const total = st.entries.length
  const sel = st.selection.size
  const free = st.free != null ? `, ${formatBytes(st.free)} available` : ''
  $('status').textContent = sel ? `${sel} of ${total} selected${free}` : `${total} ${total === 1 ? 'item' : 'items'}${free}`
}

function renderScope(): void {
  const l = st.loc
  const bar = $('scopebar')
  bar.hidden = l.type !== 'search'
  if (l.type !== 'search') return
  const q = $<HTMLInputElement>('q')
  if (document.activeElement !== q) q.value = l.typed ? l.q : ''
  bar.querySelectorAll<HTMLElement>('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === l.scope)))
  $('scope-folder').textContent = 'This Folder'
  $('scope-folder').title = `Search in “${folderTitle(l.base)}”`
}

export function renderChrome(): void {
  $<HTMLButtonElement>('back').disabled = !canBack()
  $<HTMLButtonElement>('fwd').disabled = !canForward()
  $<HTMLButtonElement>('up').disabled = !canUp()
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === st.view)))
  $<HTMLSelectElement>('sort').value = st.sort.key
  $<HTMLButtonElement>('dir').textContent = st.sort.asc ? '↑' : '↓'
  $('dir').setAttribute('aria-label', st.sort.asc ? 'Ascending' : 'Descending')
  renderStatus()
}

export function initChrome(): void {
  $('back').addEventListener('click', () => void step(-1))
  $('fwd').addEventListener('click', () => void step(1))
  $('up').addEventListener('click', () => void up())
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as ViewMode)))
  $<HTMLSelectElement>('sort').addEventListener('change', (e) => setSort((e.target as HTMLSelectElement).value as SortKey, true))
  $('dir').addEventListener('click', () => setSort(st.sort.key, !st.sort.asc))

  $('pathbar').addEventListener('click', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (c) void goFolder(c.dataset.path!)
  })
  const bar = $('pathbar')
  bar.addEventListener('dragover', (e) => {
    if (!hasPaths(e) || !(e.target as HTMLElement).closest('[data-path]')) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = e.altKey ? 'copy' : 'move'
  })
  bar.addEventListener('drop', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (!c) return
    e.preventDefault()
    void moveSelectionTo(c.dataset.path!, e.altKey, dragPaths(e))
  })

  // search
  const q = $<HTMLInputElement>('q')
  const run = debounce(250, () => {
    const text = q.value
    const cur = st.loc
    if (!text.trim()) {
      if (cur.type === 'search' && cur.typed) void go({ type: 'folder', path: cur.base })
      return
    }
    const base = folderPath()
    const scope = cur.type === 'search' ? cur.scope : 'folder'
    void go({ type: 'search', q: text, scope, base, typed: true }, { push: !(cur.type === 'search' && cur.typed) })
  })
  q.addEventListener('input', run)
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      q.value = ''
      run()
      q.blur()
      $('files').focus()
    } else if (e.key === 'Enter') run()
  })
  $('scopebar').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-scope]')
    const l = st.loc
    if (b && l.type === 'search') void go({ ...l, scope: b.dataset.scope as 'folder' | 'mac' }, { push: false })
    if ((e.target as HTMLElement).closest('#save-search') && l.type === 'search') void saveSearch(l)
  })

  bus.on('location', () => {
    renderPath()
    renderScope()
    renderChrome()
    if (st.loc.type === 'folder') $<HTMLInputElement>('q').value = ''
    void tiny.window.setTitle(locationTitle())
    $('files').dataset.trash = String(st.loc.type === 'folder' && st.loc.path === TRASH)
  })
  bus.on('chrome', renderChrome)
  bus.on('entries', renderChrome)
  bus.on('selection', renderStatus)
}
