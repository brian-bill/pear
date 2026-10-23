import { tiny } from '@tiny/sdk'
import { goFolder } from './browser'
import { installApp } from './ops'
import { selectedEntries, st, type Entry } from './state'
import { APPS, HOME, attempt } from './util'

const installed = (p: string) => p.startsWith(`${APPS}/`) || p.startsWith(`${HOME}/Applications/`) || p.startsWith('/System/')

export async function openEntry(e: Entry): Promise<void> {
  if (e.isDir) return goFolder(e.path)
  if (e.isApp && !installed(e.path)) {
    if (await installApp(e)) await goFolder(APPS)
    return
  }
  await attempt(`“${e.name}” cannot be opened.`, () => tiny.shell.open(e.path))
}

export async function openSelection(): Promise<void> {
  const list = selectedEntries()
  const folder = list.find((e) => e.isDir)
  if (folder && list.length === 1) return goFolder(folder.path)
  for (const e of list) if (!e.isDir) await openEntry(e)
}

export async function openWith(e: Entry, appId: string): Promise<void> {
  await attempt(`“${e.name}” cannot be opened.`, () => tiny.shell.open(e.path, { app: appId }))
}

/** Look inside an app bundle. */
export const showPackageContents = (e: Entry) => goFolder(e.path)

export async function openInfo(list: Entry[] = selectedEntries()): Promise<void> {
  if (!list.length) {
    if (st.loc.type === 'folder') await tiny.app.openWindow({ info: st.loc.path })
    return
  }
  for (const e of list.slice(0, 6)) await tiny.app.openWindow({ info: e.path })
}
