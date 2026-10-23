export type ViewMode = 'icons' | 'list'
export type SortKey = 'name' | 'kind' | 'date' | 'size'

export interface Entry {
  name: string
  path: string
  /** What the file system says. */
  kind: 'file' | 'dir' | 'symlink'
  /** A folder you navigate into (a `.app` is a package: it opens instead). */
  isDir: boolean
  isApp: boolean
  size: number
  mtime: number
  mode: number
  uid: number
  tags: string[]
  /** "Folder", "Plain text document"... */
  kindText: string
  /** Search results show where the item lives. */
  where?: string
}

export type Loc =
  | { type: 'folder'; path: string }
  | { type: 'search'; q: string; scope: 'folder' | 'mac'; base: string; label?: string; typed: boolean; saved?: string }

export interface SavedState {
  path?: string
  view?: ViewMode
  sort?: { key: SortKey; asc: boolean }
  hidden?: boolean
  info?: string
}

export const st = {
  loc: { type: 'folder', path: '/' } as Loc,
  /** Everything in the folder (or the search results); `entries` is what is shown, sorted. */
  all: [] as Entry[],
  entries: [] as Entry[],
  dirMtime: 0,
  /** Paths, in the order the user selected them. */
  selection: new Set<string>(),
  anchor: '' as string,
  cursor: '' as string,
  view: 'icons' as ViewMode,
  sort: { key: 'name', asc: true } as { key: SortKey; asc: boolean },
  showHidden: false,
  history: [] as Loc[],
  hIndex: -1,
  renaming: '' as string,
  loading: false,
  /** Bumped on every load so late answers are dropped. */
  loadId: 0,
  trashCount: 0,
  free: null as number | null,
  quickLook: false,
}

export const folderPath = (): string => (st.loc.type === 'folder' ? st.loc.path : st.loc.base)
export const selectedEntries = (): Entry[] => st.entries.filter((e) => st.selection.has(e.path))
