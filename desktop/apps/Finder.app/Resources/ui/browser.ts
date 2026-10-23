import { tiny } from '@tiny/sdk'
import { bus } from './bus'
import { st, type Entry, type Loc, type SortKey } from './state'
import { alertError, dirname, extOf, isAppName, isInTrash, readTags, TRASH } from './util'

// ---- reading folders

const kinds = new Map<string, Promise<string>>()

async function kindText(e: { path: string; name: string; kind: string; isApp: boolean; isDir: boolean }): Promise<string> {
  if (e.isApp) return 'Application'
  if (e.isDir) return 'Folder'
  if (e.kind === 'symlink') return 'Alias'
  const ext = extOf(e.name)
  const key = ext || e.name
  let p = kinds.get(key)
  if (!p) {
    p = tiny.launchTypeOf(e.path).then((t) => t.description).catch(() => 'Document')
    kinds.set(key, p)
  }
  return p
}

export async function toEntry(path: string, name: string, kind: 'file' | 'dir' | 'symlink', where?: string): Promise<Entry> {
  let s
  try {
    s = await tiny.stat(path)
  } catch {
    s = await tiny.lstat(path) // a broken link is still an item
  }
  const isApp = s.kind === 'dir' && isAppName(name)
  const base = { name, path, kind, isApp, isDir: s.kind === 'dir' && !isApp }
  return { ...base, size: s.size, mtime: s.mtime, mode: s.mode, uid: s.uid, tags: await readTags(path), kindText: await kindText(base), where }
}

async function inBatches<T, R>(items: T[], fn: (t: T) => Promise<R | null>, size = 48): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const part = await Promise.all(items.slice(i, i + size).map((t) => fn(t).catch(() => null)))
    for (const r of part) if (r) out.push(r)
  }
  return out
}

export async function readFolder(path: string): Promise<Entry[]> {
  const list = await tiny.readdir(path)
  return inBatches(list, (d) => toEntry(`${path === '/' ? '' : path}/${d.name}`, d.name, d.kind as Entry['kind']))
}

interface SearchHit { path?: string; title?: string }

async function runSearch(loc: Extract<Loc, { type: 'search' }>): Promise<Entry[]> {
  const scopes = loc.scope === 'folder' ? [loc.base] : ['all']
  const r = await tiny.service<{ results: SearchHit[] }>('tiny.search', { op: 'query', q: loc.q, scopes, limit: 300 })
  const paths = [...new Set(r.results.map((h) => h.path).filter((p): p is string => !!p && !p.endsWith('/')))]
  return inBatches(paths, async (p) => {
    const s = await tiny.lstat(p)
    return toEntry(p, p.slice(p.lastIndexOf('/') + 1), s.kind as Entry['kind'], dirname(p))
  })
}

// ---- sorting

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function sortEntries(list: Entry[]): Entry[] {
  const { key, asc } = st.sort
  const cmp: Record<SortKey, (a: Entry, b: Entry) => number> = {
    name: (a, b) => collator.compare(a.name, b.name),
    kind: (a, b) => collator.compare(a.kindText, b.kindText) || collator.compare(a.name, b.name),
    date: (a, b) => a.mtime - b.mtime || collator.compare(a.name, b.name),
    size: (a, b) => (a.isDir ? -1 : a.size) - (b.isDir ? -1 : b.size) || collator.compare(a.name, b.name),
  }
  const sorted = [...list].sort(cmp[key])
  return asc ? sorted : sorted.reverse()
}

export function applyView(): void {
  const shown = st.all.filter((e) => st.showHidden || !e.name.startsWith('.') || isInTrash(e.path))
  st.entries = sortEntries(shown)
  const have = new Set(st.entries.map((e) => e.path))
  for (const p of [...st.selection]) if (!have.has(p)) st.selection.delete(p)
  if (!have.has(st.cursor)) st.cursor = [...st.selection].pop() ?? ''
  bus.emit('entries')
}

export function setSort(key: SortKey, asc?: boolean): void {
  st.sort = { key, asc: asc ?? (st.sort.key === key ? !st.sort.asc : true) }
  applyView()
  bus.emit('chrome')
}

// ---- loading

export async function reload(): Promise<void> {
  const id = ++st.loadId
  const loc = st.loc
  st.loading = true
  let all: Entry[] = []
  let dirMtime = 0
  try {
    if (loc.type === 'folder') {
      dirMtime = (await tiny.stat(loc.path)).mtime
      all = await readFolder(loc.path)
    } else all = loc.q.trim() ? await runSearch(loc) : []
  } catch (e) {
    if (id === st.loadId) await alertError(`The folder “${loc.type === 'folder' ? loc.path : loc.q}” cannot be opened.`, e)
  }
  if (id !== st.loadId) return
  st.loading = false
  st.all = all
  st.dirMtime = dirMtime
  applyView()
  void refreshMeta()
}

export async function refreshMeta(): Promise<void> {
  const [free, trash] = await Promise.all([tiny.statfs().then((s) => s.free).catch(() => null), tiny.readdir(TRASH).then((l) => l.length).catch(() => 0)])
  const changed = free !== st.free || trash !== st.trashCount
  st.free = free
  st.trashCount = trash
  if (changed) bus.emit('chrome')
}

// ---- navigation

const same = (a: Loc, b: Loc) => JSON.stringify(a) === JSON.stringify(b)

export async function go(loc: Loc, o: { push?: boolean; select?: string[] } = {}): Promise<void> {
  if (loc.type === 'folder') {
    try {
      const s = await tiny.stat(loc.path)
      if (s.kind !== 'dir') return go({ type: 'folder', path: dirname(loc.path) }, { ...o, select: [loc.path] })
    } catch (e) {
      await alertError(`The folder “${loc.path}” cannot be opened.`, e)
      return
    }
  }
  if (o.push !== false && !same(st.history[st.hIndex]!, loc)) {
    st.history.splice(st.hIndex + 1)
    st.history.push(loc)
    st.hIndex = st.history.length - 1
  } else if (o.push === false && st.hIndex >= 0 && loc.type === 'search' && st.history[st.hIndex]?.type === 'search') st.history[st.hIndex] = loc
  st.loc = loc
  st.selection = new Set(o.select ?? [])
  st.cursor = st.anchor = o.select?.[0] ?? ''
  st.quickLook = false
  await reload()
  bus.emit('location')
  bus.emit('selection')
}

export const goFolder = (path: string, select?: string[]) => go({ type: 'folder', path }, { select })

export async function step(delta: -1 | 1): Promise<void> {
  const i = st.hIndex + delta
  if (i < 0 || i >= st.history.length) return
  st.hIndex = i
  await go(st.history[i]!, { push: false })
}

export const canBack = () => st.hIndex > 0
export const canForward = () => st.hIndex < st.history.length - 1
export const canUp = () => st.loc.type === 'folder' && st.loc.path !== '/'

export async function up(): Promise<void> {
  const here = st.loc.type === 'folder' ? st.loc.path : st.loc.base
  if (st.loc.type === 'folder' && here === '/') return
  await goFolder(st.loc.type === 'folder' ? dirname(here) : here, st.loc.type === 'folder' ? [here] : undefined)
}

/** Navigate to a folder and select an item in it (Reveal). */
export async function reveal(path: string): Promise<void> {
  if (path === TRASH) return void (await goFolder(TRASH))
  try {
    const s = await tiny.stat(path)
    if (s.kind === 'dir' && !isAppName(path)) return void (await goFolder(path))
  } catch {
    return void (await goFolder(dirname(path)))
  }
  await goFolder(dirname(path), [path])
}

// ---- cheap change detection (windows are separate iframes, so there is no shared watch)

export function startPolling(): void {
  setInterval(async () => {
    if (st.renaming || st.loading) return
    if (st.loc.type !== 'folder') return void refreshMeta()
    try {
      const m = (await tiny.stat(st.loc.path)).mtime
      if (m !== st.dirMtime) await reload()
      else void refreshMeta()
    } catch {
      // the folder went away: go to its parent
      if (st.loc.type === 'folder' && st.loc.path !== '/') await goFolder(dirname(st.loc.path))
    }
  }, 2000)
  addEventListener('focus', () => st.renaming || void reload())
}
