import { tiny, bytesOf, textOf } from '@tiny/sdk'
import { bus } from './bus'
import type { Loc } from './state'
import { attempt, freeName, joinPath, SAVED_DIR } from './util'

export interface SavedSearch {
  name: string
  path: string
  loc: Extract<Loc, { type: 'search' }>
}

const EXT = '.savedSearch'

export async function listSaved(): Promise<SavedSearch[]> {
  const out: SavedSearch[] = []
  for (const e of await tiny.readdir(SAVED_DIR).catch(() => [])) {
    if (!e.name.endsWith(EXT)) continue
    const path = joinPath(SAVED_DIR, e.name)
    try {
      const j = JSON.parse(textOf(await tiny.readFile(path))) as { q: string; scope: 'folder' | 'mac'; base: string }
      const name = e.name.slice(0, -EXT.length)
      out.push({ name, path, loc: { type: 'search', q: j.q, scope: j.scope, base: j.base, label: name, typed: false, saved: path } })
    } catch {
      // not ours, or damaged: leave it alone
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Ask for a name and keep the search as a smart folder. */
export async function saveSearch(loc: Extract<Loc, { type: 'search' }>): Promise<void> {
  const name = await tiny.dialogs.prompt('Save this search as:', { value: loc.label ?? loc.q, button: 'Save' })
  const clean = name?.trim().replace(/\//g, '-')
  if (!clean) return
  const ok = await attempt('The search cannot be saved.', async () => {
    await tiny.mkdir(SAVED_DIR, { recursive: true })
    const file = await freeName(SAVED_DIR, clean + EXT, ' ')
    await tiny.writeFile(joinPath(SAVED_DIR, file), bytesOf(JSON.stringify({ q: loc.q, scope: loc.scope, base: loc.base })))
  })
  if (ok) bus.emit('sidebar')
}

export async function deleteSaved(path: string): Promise<void> {
  await attempt('The saved search cannot be deleted.', () => tiny.unlink(path))
  bus.emit('sidebar')
}
