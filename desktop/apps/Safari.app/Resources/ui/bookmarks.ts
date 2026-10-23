/// Bookmarks live in a JSON file in the user's Library, so they survive windows, launches and boots.
import { tiny } from '@tiny/sdk'

export interface Bookmark {
  url: string
  title: string
}

const DIR = '/Users/pear/Library'
const FILE = `${DIR}/Bookmarks.json`

/** ENOENT (first run) or any other read failure counts as "no bookmarks yet". */
export async function loadBookmarks(): Promise<Bookmark[]> {
  try {
    const text = new TextDecoder().decode(await tiny.readFile(FILE))
    const list = JSON.parse(text) as unknown
    if (!Array.isArray(list)) return []
    return list.filter((b): b is Bookmark => {
      if (!b || typeof b !== 'object') return false
      const { url } = b as { url?: unknown }
      return typeof url === 'string' && url !== ''
    })
  } catch {
    return []
  }
}

export async function saveBookmarks(list: Bookmark[]): Promise<void> {
  await tiny.mkdir(DIR).catch(() => {}) // it exists at first boot; a miss never blocks the write
  await tiny.writeFile(FILE, new TextEncoder().encode(`${JSON.stringify(list, null, 2)}\n`))
}
