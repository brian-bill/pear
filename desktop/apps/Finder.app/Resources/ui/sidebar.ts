import { tiny, escapeHtml } from '@tiny/sdk'
import { bus } from './bus'
import { go, goFolder } from './browser'
import { $, dragPaths, hasPaths } from './dom'
import { glyph } from './icons'
import { emptyTrash, moveSelectionTo } from './ops'
import { deleteSaved, listSaved, type SavedSearch } from './saved'
import { st, type Loc } from './state'
import { APPS, cap, folderTitle, HOME, TAG_COLORS, TAG_HEX, TRASH } from './util'

interface Place {
  id: string
  label: string
  glyph?: string
  color?: string
  loc: Loc
  /** Dropping files here moves them into this folder. */
  dropInto?: string
  saved?: SavedSearch
  trash?: boolean
}

let saved: SavedSearch[] = []
let mounts: string[] = []
let places: Place[] = []
const folder = (path: string): Loc => ({ type: 'folder', path })

function build(): Array<{ title: string; items: Place[] }> {
  const fav = (id: string, label: string, g: string, path: string): Place => ({ id, label, glyph: g, loc: folder(path), dropInto: path })
  const tags = TAG_COLORS.map((t): Place => ({ id: `tag:${t}`, label: cap(t), color: TAG_HEX[t], loc: { type: 'search', q: `tag:${t}`, scope: 'mac', base: HOME, label: `${cap(t)} tag`, typed: false } }))
  const volumes = mounts.map((m): Place => ({ id: `vol:${m}`, label: folderTitle(m), glyph: 'disk', loc: folder(m), dropInto: m }))
  return [
    {
      title: 'Favorites',
      items: [
        fav('home', folderTitle(HOME), 'home', HOME),
        fav('desktop', 'Desktop', 'desktop', `${HOME}/Desktop`),
        fav('documents', 'Documents', 'doc', `${HOME}/Documents`),
        fav('downloads', 'Downloads', 'download', `${HOME}/Downloads`),
        fav('applications', 'Applications', 'apps', APPS),
      ],
    },
    ...(saved.length ? [{ title: 'Saved Searches', items: saved.map((s): Place => ({ id: `saved:${s.path}`, label: s.name, glyph: 'smart', loc: s.loc, saved: s })) }] : []),
    { title: 'Tags', items: tags },
    { title: 'Locations', items: [fav('hd', 'Macintosh HD', 'disk', '/'), ...volumes, { id: 'trash', label: 'Trash', glyph: 'trash', loc: folder(TRASH), dropInto: TRASH, trash: true }] },
  ]
}

const isCurrent = (p: Place): boolean => {
  const l = st.loc
  if (p.loc.type === 'folder') return l.type === 'folder' && l.path === p.loc.path
  return l.type === 'search' && !l.typed && l.q === p.loc.q && l.label === p.loc.label
}

let renderedTrash = -1

function render(): void {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#sidebar [data-id]')?.dataset.id
  renderedTrash = st.trashCount
  const groups = build()
  places = groups.flatMap((g) => g.items)
  $('sidebar').innerHTML = groups
    .map(
      (g) =>
        `<h4>${escapeHtml(g.title)}</h4>` +
        g.items
          .map((p) => {
            const icon = p.color ? `<span class="tagdot" style="background:${p.color}"></span>` : glyph(p.glyph!)
            const empty = p.trash && st.trashCount ? `<button class="plain mini" data-empty aria-label="Empty Trash">Empty</button>` : ''
            return `<div class="srow"><button class="item" data-id="${escapeHtml(p.id)}" aria-current="${isCurrent(p)}">${icon}<span class="grow">${escapeHtml(p.label)}</span></button>${empty}</div>`
          })
          .join(''),
    )
    .join('')
  if (focused) $('sidebar').querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`)?.focus()
}

async function refreshLists(): Promise<void> {
  saved = await listSaved()
  const raw = await tiny.admin.kernel<unknown[]>('mounts').catch(() => [])
  mounts = (raw ?? []).map((m) => (typeof m === 'string' ? m : String((m as { point?: string; path?: string }).point ?? (m as { path?: string }).path ?? ''))).filter(Boolean)
  render()
}

const placeOf = (el: Element | null): Place | undefined => places.find((p) => p.id === el?.closest<HTMLElement>('[data-id]')?.dataset.id)

export function initSidebar(): void {
  const bar = $('sidebar')
  bar.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement
    if (t.closest('[data-empty]')) return void emptyTrash()
    const p = placeOf(t)
    if (p) void go(p.loc)
  })
  bar.addEventListener('contextmenu', (ev) => {
    const p = placeOf(ev.target as Element)
    if (!p || !(p.saved || p.trash)) return
    ev.preventDefault()
    const items = p.saved
      ? [{ label: 'Delete Saved Search', action: () => void deleteSaved(p.saved!.path) }]
      : [{ label: 'Open', action: () => void goFolder(TRASH) }, { label: 'Empty Trash…', disabled: !st.trashCount, action: () => void emptyTrash() }]
    void tiny.shell.contextMenu(items, { x: ev.clientX, y: ev.clientY })
  })
  // drop files on a favourite or the Trash
  bar.addEventListener('dragover', (ev) => {
    const p = placeOf(ev.target as Element)
    bar.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'))
    if (!p?.dropInto || !hasPaths(ev)) return
    ev.preventDefault()
    ev.dataTransfer!.dropEffect = ev.altKey ? 'copy' : 'move'
    ;(ev.target as HTMLElement).closest('.item')?.classList.add('drop')
  })
  bar.addEventListener('dragleave', (ev) => (ev.target as HTMLElement).closest('.item')?.classList.remove('drop'))
  bar.addEventListener('drop', (ev) => {
    bar.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'))
    const p = placeOf(ev.target as Element)
    if (!p?.dropInto) return
    ev.preventDefault()
    void moveSelectionTo(p.dropInto, ev.altKey, dragPaths(ev))
  })
  bus.on('sidebar', () => void refreshLists())
  bus.on('location', render)
  bus.on('chrome', () => st.trashCount !== renderedTrash && render())
  void refreshLists()
}
