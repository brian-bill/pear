import { tiny, joinPath } from '@tiny/sdk'
import { bus } from './bus'
import { reload, goFolder } from './browser'
import { clearClip, readClip, writeClip } from './clipboard'
import { select } from './sel'
import { folderPath, selectedEntries, st, type Entry } from './state'
import { alertError, APPS, attempt, basename, dirname, errCode, freeName, isInTrash, TRASH, writeTags } from './util'

const inFolder = (): string | null => (st.loc.type === 'folder' ? st.loc.path : null)

async function refreshAndSelect(paths: string[]): Promise<void> {
  await reload()
  const have = new Set(st.entries.map((e) => e.path))
  select(paths.filter((p) => have.has(p)))
}

export async function newFolder(): Promise<void> {
  const dir = inFolder()
  if (!dir) return
  const path = joinPath(dir, await freeName(dir, 'untitled folder', ''))
  if (!(await attempt('The folder cannot be created.', () => tiny.mkdir(path)))) return
  await refreshAndSelect([path])
  st.renaming = path
  bus.emit('entries')
}

export async function renameEntry(e: Entry, name: string): Promise<boolean> {
  name = name.trim()
  if (!name || name === e.name) return true
  if (name.includes('/')) {
    await tiny.dialogs.alert({ message: 'Names cannot contain a slash (/).' })
    return false
  }
  const to = joinPath(dirname(e.path), name)
  if (await tiny.exists(to)) {
    await tiny.dialogs.alert({ message: `The name “${name}” is already taken.`, detail: 'Please choose a different name.' })
    return false
  }
  if (!(await attempt(`“${e.name}” cannot be renamed.`, () => tiny.rename(e.path, to)))) return false
  await refreshAndSelect([to])
  return true
}

export async function duplicate(list: Entry[] = selectedEntries()): Promise<void> {
  const made: string[] = []
  for (const e of list) {
    const dir = dirname(e.path)
    const to = joinPath(dir, await freeName(dir, e.name))
    if (await attempt(`“${e.name}” cannot be duplicated.`, () => tiny.copy(e.path, to, { recursive: true }))) made.push(to)
  }
  await refreshAndSelect(made)
}

/** Move to the Trash; on volumes without one, offer to delete for good. */
export async function trashEntries(list: Entry[] = selectedEntries()): Promise<void> {
  if (!list.length) return
  if (list.every((e) => isInTrash(e.path))) return deleteNow(list)
  for (const e of list) {
    try {
      await tiny.trash(e.path, TRASH)
    } catch (err) {
      if (errCode(err) === 'ENOSYS') {
        if (await tiny.dialogs.confirm(`“${e.name}” cannot be moved to the Trash.`, { detail: 'It is on a volume without a Trash. Delete it immediately?', buttons: ['Delete', 'Cancel'], danger: true })) await attempt(`“${e.name}” cannot be deleted.`, () => tiny.removeAll(e.path))
      } else await alertError(`“${e.name}” cannot be moved to the Trash.`, err)
    }
  }
  select([])
  await reload()
}

export async function deleteNow(list: Entry[] = selectedEntries()): Promise<void> {
  if (!list.length) return
  const what = list.length === 1 ? `“${list[0]!.name}”` : `${list.length} items`
  if (!(await tiny.dialogs.confirm(`Delete ${what} immediately?`, { detail: 'You cannot undo this action.', buttons: ['Delete', 'Cancel'], danger: true }))) return
  for (const e of list) await attempt(`“${e.name}” cannot be deleted.`, () => tiny.removeAll(e.path))
  select([])
  await reload()
}

export async function putBack(list: Entry[] = selectedEntries()): Promise<void> {
  const back: string[] = []
  for (const e of list.filter((x) => isInTrash(x.path))) {
    try {
      back.push(await tiny.restore(e.path))
    } catch (err) {
      await alertError(`“${e.name}” cannot be put back.`, err)
    }
  }
  select([])
  await reload()
  if (back.length === 1) await goFolder(dirname(back[0]!), back)
}

export async function emptyTrash(): Promise<void> {
  const n = (await tiny.readdir(TRASH).catch(() => [])).length
  if (!n) return void (await tiny.dialogs.alert({ message: 'The Trash is empty.' }))
  if (!(await tiny.dialogs.confirm('Are you sure you want to permanently erase the items in the Trash?', { detail: 'You cannot undo this action.', buttons: ['Empty Trash', 'Cancel'], danger: true }))) return
  if (await attempt('The Trash cannot be emptied.', () => tiny.emptyTrash(TRASH))) {
    select([])
    await reload()
  }
}

// ---- copy, cut, paste, drag

export async function copySelection(op: 'copy' | 'cut'): Promise<void> {
  const paths = selectedEntries().map((e) => e.path)
  if (paths.length) await writeClip({ op, paths })
}

/** Move or copy `paths` into `dest`; names that clash get a "copy" suffix. Returns the new paths. */
export async function transfer(paths: string[], dest: string, copy: boolean): Promise<string[]> {
  const made: string[] = []
  for (const from of paths) {
    const name = basename(from)
    if (!copy && dirname(from) === dest) continue // dropped where it already is
    if (from === dest || dest.startsWith(`${from}/`)) {
      await tiny.dialogs.alert({ message: `“${name}” cannot be ${copy ? 'copied' : 'moved'} into itself.` })
      continue
    }
    if (dest === TRASH && !copy) {
      await trashEntries([{ name, path: from } as Entry])
      continue
    }
    const to = joinPath(dest, await freeName(dest, name))
    const ok = await attempt(`“${name}” cannot be ${copy ? 'copied' : 'moved'}.`, () => (copy ? tiny.copy(from, to, { recursive: true }) : tiny.rename(from, to)))
    if (ok) made.push(to)
  }
  return made
}

export async function pasteInto(dir: string | null = inFolder()): Promise<void> {
  if (!dir) return
  const clip = await readClip()
  if (!clip) return
  const made = await transfer(clip.paths, dir, clip.op === 'copy')
  if (clip.op === 'cut') await clearClip()
  if (dir === folderPath()) await refreshAndSelect(made)
}

export async function moveSelectionTo(dest: string, copy: boolean, paths: string[]): Promise<void> {
  const made = await transfer(paths, dest, copy)
  if (made.length || paths.length) await reload()
  select([])
}

// ---- tags

export async function setTags(paths: string[], tags: string[]): Promise<void> {
  for (const p of paths) await attempt('The tags cannot be changed.', () => writeTags(p, tags))
  await reload()
}

export async function toggleTag(list: Entry[], tag: string): Promise<void> {
  const all = list.every((e) => e.tags.includes(tag))
  for (const e of list) await attempt('The tags cannot be changed.', () => writeTags(e.path, all ? e.tags.filter((t) => t !== tag) : [...e.tags, tag]))
  await reload()
}

// ---- host files

export async function importFromComputer(): Promise<void> {
  const dir = inFolder()
  if (!dir) return
  try {
    const made = await tiny.host.importFiles(dir)
    if (made?.length) await refreshAndSelect(made)
  } catch (e) {
    if (errCode(e) !== 'ECANCELED') await alertError('The files cannot be imported.', e)
  }
}

export async function download(list: Entry[] = selectedEntries()): Promise<void> {
  for (const e of list) await attempt(`“${e.name}” cannot be downloaded.`, () => tiny.host.exportPath(e.path))
}

const CHUNK = 1 << 20
const O_WRITE_CREATE_TRUNC = 1 | 0x40 | 0x200

/** Write a file the user dropped from the real computer, a megabyte at a time. */
export async function writeHostFile(file: File, dir: string): Promise<string> {
  const to = joinPath(dir, await freeName(dir, file.name))
  const fd = await tiny.open(to, O_WRITE_CREATE_TRUNC, 0o644)
  try {
    for (let off = 0; off < file.size; off += CHUNK) await tiny.write(fd, new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()))
  } finally {
    await tiny.close(fd)
  }
  return to
}

export async function dropHostFiles(files: File[], dir: string): Promise<void> {
  const made: string[] = []
  for (const f of files) {
    try {
      made.push(await writeHostFile(f, dir))
    } catch (e) {
      await alertError(`“${f.name}” cannot be copied here.`, e)
    }
  }
  if (dir === folderPath()) await refreshAndSelect(made)
}

// ---- apps

/** Offer to install an app bundle that is not in /Applications. */
export async function installApp(e: Entry): Promise<boolean> {
  const ok = await tiny.dialogs.confirm(`Install “${e.name.replace(/\.app$/, '')}”?`, { detail: `The app will be copied to ${APPS}.`, buttons: ['Install', 'Cancel'] })
  if (!ok) return false
  try {
    const info = await tiny.admin.kernel<{ name: string }>('bundleInstall', { path: e.path }, { location: APPS })
    tiny.shell.notify('App installed', `${info?.name ?? e.name} is now in Applications.`).catch(() => {})
    return true
  } catch (err) {
    await alertError(`“${e.name}” cannot be installed.`, err)
    return false
  }
}
