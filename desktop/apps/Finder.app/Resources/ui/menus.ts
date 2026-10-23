import { tiny, type MenuDef } from '@tiny/sdk'
import { bus } from './bus'
import { canBack, canForward, canUp, goFolder, setSort, step, up } from './browser'
import { setView, toggleHidden } from './chrome'
import { copySelection, deleteNow, download, duplicate, emptyTrash, importFromComputer, newFolder, pasteInto, putBack, trashEntries } from './ops'
import { openInfo, openSelection, showPackageContents } from './open'
import { selectAll } from './sel'
import { selectedEntries, st, type SortKey } from './state'
import { toggleQuickLook } from './preview'
import { startRename } from './view'
import { APPS, HOME, isInTrash, TRASH } from './util'

type Items = MenuDef['items']

export function buildMenus(): MenuDef[] {
  const sel = selectedEntries()
  const has = sel.length > 0
  const folder = st.loc.type === 'folder'
  const trashed = sel.some((e) => isInTrash(e.path))
  const sorts: Array<[SortKey, string]> = [['name', 'Name'], ['kind', 'Kind'], ['date', 'Date Modified'], ['size', 'Size']]
  const go = (label: string, shortcut: string, path: string): Items[number] => ({ label, shortcut, action: () => void goFolder(path) })
  return [
    {
      title: 'Finder',
      items: [
        { label: 'About Finder', action: () => void tiny.dialogs.alert({ message: 'Finder', detail: 'Browse, organize and search the files on this Pear.' }) },
        { separator: true },
        { label: 'Empty Trash…', shortcut: 'Cmd+Shift+Backspace', action: () => void emptyTrash() },
      ],
    },
    {
      title: 'File',
      items: [
        { label: 'New Finder Window', shortcut: 'Cmd+N', action: () => void tiny.app.openWindow({ path: st.loc.type === 'folder' ? st.loc.path : HOME }) },
        { label: 'New Folder', shortcut: 'Cmd+Shift+N', disabled: !folder, action: () => void newFolder() },
        { label: 'Open', shortcut: 'Cmd+Down', disabled: !has, action: () => void openSelection() },
        { label: 'Show Package Contents', disabled: !(sel.length === 1 && sel[0]!.isApp), action: () => void showPackageContents(sel[0]!) },
        { separator: true },
        { label: 'Get Info', shortcut: 'Cmd+I', action: () => void openInfo() },
        { label: 'Rename', shortcut: 'F2', disabled: sel.length !== 1, action: () => startRename() },
        { label: 'Duplicate', shortcut: 'Cmd+D', disabled: !has || trashed, action: () => void duplicate() },
        { label: 'Move to Trash', shortcut: 'Cmd+Backspace', disabled: !has || trashed, action: () => void trashEntries() },
        { label: 'Put Back', disabled: !trashed, action: () => void putBack() },
        { label: 'Delete Immediately…', disabled: !trashed, action: () => void deleteNow() },
        { label: 'Quick Look', disabled: !has, checked: st.quickLook, action: toggleQuickLook },
        { separator: true },
        { label: 'Import from Computer…', disabled: !folder, action: () => void importFromComputer() },
        { label: 'Download…', disabled: !has, action: () => void download() },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Cut', shortcut: 'Cmd+X', disabled: !has, action: () => void copySelection('cut') },
        { label: 'Copy', shortcut: 'Cmd+C', disabled: !has, action: () => void copySelection('copy') },
        { label: 'Paste', shortcut: 'Cmd+V', disabled: !folder, action: () => void pasteInto() },
        { separator: true },
        { label: 'Select All', shortcut: 'Cmd+A', action: selectAll },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'as Icons', shortcut: 'Cmd+1', checked: st.view === 'icons', action: () => setView('icons') },
        { label: 'as List', shortcut: 'Cmd+2', checked: st.view === 'list', action: () => setView('list') },
        { separator: true },
        ...sorts.map(([k, label]): Items[number] => ({ label: `Sort by ${label}`, checked: st.sort.key === k, action: () => setSort(k, true) })),
        { separator: true },
        { label: 'Show Hidden Files', shortcut: 'Cmd+Shift+.', checked: st.showHidden, action: toggleHidden },
      ],
    },
    {
      title: 'Go',
      items: [
        { label: 'Back', shortcut: 'Cmd+[', disabled: !canBack(), action: () => void step(-1) },
        { label: 'Forward', shortcut: 'Cmd+]', disabled: !canForward(), action: () => void step(1) },
        { label: 'Enclosing Folder', shortcut: 'Cmd+Up', disabled: !canUp(), action: () => void up() },
        { separator: true },
        go('Home', 'Cmd+Shift+H', HOME),
        go('Desktop', 'Cmd+Shift+D', `${HOME}/Desktop`),
        go('Documents', 'Cmd+Shift+O', `${HOME}/Documents`),
        go('Downloads', 'Cmd+Shift+L', `${HOME}/Downloads`),
        go('Applications', 'Cmd+Shift+A', APPS),
        go('Trash', '', TRASH),
        { separator: true },
        {
          label: 'Go to Folder…',
          shortcut: 'Cmd+Shift+G',
          action: async () => {
            const p = await tiny.dialogs.prompt('Go to the folder:', { value: st.loc.type === 'folder' ? st.loc.path : HOME, button: 'Go' })
            if (p?.trim()) await goFolder(p.trim())
          },
        },
      ],
    },
  ]
}

export function initMenus(): void {
  let queued = false
  const update = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      void tiny.window.setMenus(buildMenus())
    })
  }
  for (const t of ['selection', 'location', 'chrome', 'entries'] as const) bus.on(t, update)
  update()
}
