import { tiny, type ContextItem } from '@tiny/sdk'
import { goFolder, setSort } from './browser'
import { readClip } from './clipboard'
import { copySelection, deleteNow, download, duplicate, emptyTrash, importFromComputer, newFolder, pasteInto, putBack, setTags, trashEntries } from './ops'
import { openEntry, openInfo, openSelection, openWith, showPackageContents } from './open'
import { startRename } from './view'
import { dirname, isInTrash, TRASH } from './util'
import { selectedEntries, st, type SortKey, type ViewMode } from './state'
import { setView } from './chrome'

const SORTS: Array<[SortKey, string]> = [['name', 'Name'], ['kind', 'Kind'], ['date', 'Date Modified'], ['size', 'Size']]

async function openWithItems(path: string): Promise<ContextItem[]> {
  const apps = await tiny.launchAppsFor(path).catch(() => [])
  if (!apps.length) return []
  return [{ separator: true }, ...apps.map((a) => ({ label: `Open With ${a.name}`, action: () => void openWith(selectedEntries()[0]!, a.id) }))]
}

async function tagsPrompt(): Promise<void> {
  const list = selectedEntries()
  const current = list.length === 1 ? list[0]!.tags.join(', ') : ''
  const v = await tiny.dialogs.prompt('Tags (separated by commas):', { value: current, title: 'Tags', button: 'Set Tags' })
  if (v === null) return
  await setTags(list.map((e) => e.path), v.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))
}

export async function showContextMenu(x: number, y: number, onItem: boolean): Promise<void> {
  const clip = await readClip()
  const sel = selectedEntries()
  const trashed = st.loc.type === 'folder' && isInTrash(st.loc.path)
  const inFolder = st.loc.type === 'folder'
  const items: ContextItem[] = []

  if (onItem && sel.length) {
    const one = sel.length === 1 ? sel[0]! : null
    items.push({ label: 'Open', action: () => void openSelection() })
    if (one && !one.isDir) items.push(...(await openWithItems(one.path)))
    if (one?.isApp) items.push({ label: 'Show Package Contents', action: () => void showPackageContents(one) })
    items.push({ separator: true }, { label: 'Get Info', shortcut: 'Cmd+I', action: () => void openInfo() })
    if (one) items.push({ label: 'Rename', action: () => startRename(one.path) })
    if (trashed) items.push({ label: 'Put Back', action: () => void putBack() }, { label: 'Delete Immediately…', action: () => void deleteNow() })
    else items.push({ label: 'Duplicate', shortcut: 'Cmd+D', action: () => void duplicate() }, { label: 'Move to Trash', shortcut: 'Cmd+Backspace', action: () => void trashEntries() })
    items.push({ separator: true }, { label: sel.length > 1 ? `Copy ${sel.length} Items` : `Copy “${one!.name}”`, shortcut: 'Cmd+C', action: () => void copySelection('copy') }, { label: 'Cut', shortcut: 'Cmd+X', action: () => void copySelection('cut') })
    if (one?.isDir) items.push({ label: 'Paste into Folder', disabled: !clip, action: () => void pasteInto(one.path) })
    items.push({ separator: true }, { label: 'Tags…', action: () => void tagsPrompt() }, { label: sel.length > 1 ? 'Download…' : `Download “${sel[0]!.name}”…`, action: () => void download() })
    if (st.loc.type === 'search' && one) items.push({ label: 'Show in Enclosing Folder', action: () => void goFolder(dirname(one.path), [one.path]) })
  } else {
    if (trashed || (inFolder && st.loc.type === 'folder' && st.loc.path === TRASH)) items.push({ label: 'Empty Trash…', action: () => void emptyTrash() })
    else if (inFolder) items.push({ label: 'New Folder', shortcut: 'Cmd+Shift+N', action: () => void newFolder() })
    items.push({ label: 'Paste', shortcut: 'Cmd+V', disabled: !clip || !inFolder, action: () => void pasteInto() })
    if (inFolder && !trashed) items.push({ label: 'Import from Computer…', action: () => void importFromComputer() })
    items.push({ separator: true }, { label: 'Get Info', action: () => void openInfo() }, { separator: true })
    for (const v of ['icons', 'list'] as ViewMode[]) items.push({ label: `as ${v === 'icons' ? 'Icons' : 'List'}`, checked: st.view === v, action: () => setView(v) })
    items.push({ separator: true })
    for (const [k, label] of SORTS) items.push({ label: `Sort by ${label}`, checked: st.sort.key === k, action: () => setSort(k, true) })
  }
  await tiny.shell.contextMenu(items, { x, y })
}
