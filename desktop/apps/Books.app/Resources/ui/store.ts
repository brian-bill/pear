import { basename, tiny } from '@tiny/sdk'

/** Where the whole app keeps its state: one file, one source. */
export const HOME = '/Users/pear'
export const LIBRARY_DIR = `${HOME}/Library/Books`
export const LIBRARY_PATH = `${LIBRARY_DIR}/library.json`

/** One chapter of a book: a heading (may be empty) and its paragraphs. */
export interface Chapter {
  title: string
  paragraphs: string[]
}

/** How far into a book the user is. `line` is the viewport top as a visual line index, so a reopen
 *  puts the same number of lines above the fold exactly as the window was when it was saved. */
export interface Progress {
  chapter?: number
  line?: number
}

/** Typography of this window; kept with the book so every window opens it the same way. */
export interface ViewPrefs {
  size?: number
  font?: 'serif' | 'mono'
  theme?: 'light' | 'sepia' | 'dark'
}

/** One entry of library.json. The id is the book's own path: one book is one file on disk. */
export interface Book {
  id: string
  path: string
  title: string
  author?: string
  added: string
  lastRead?: string
  progress?: Progress
  view?: ViewPrefs
}

export interface LibraryData {
  books: Book[]
}

export const isEnoent = (e: unknown): boolean =>
  e instanceof Error && (e as Error & { code?: string }).code === 'ENOENT'

/** Read the library. `ENOENT` (nothing added yet) reads as an empty one. */
export async function readLibrary(): Promise<LibraryData> {
  try {
    const raw = await tiny.readFile(LIBRARY_PATH)
    const data = JSON.parse(new TextDecoder().decode(raw)) as Partial<LibraryData>
    return { books: Array.isArray(data.books) ? data.books.filter((b): b is Book => Boolean(b && b.path)) : [] }
  } catch (e) {
    if (isEnoent(e)) return { books: [] }
    throw e
  }
}

export async function writeLibrary(data: LibraryData): Promise<void> {
  await tiny.mkdir(LIBRARY_DIR, { recursive: true })
  await tiny.writeFileAtomic(LIBRARY_PATH, new TextEncoder().encode(JSON.stringify(data, null, 2)))
}

/** The window title: "Odyssey.txt" is a book about the Odyssey. */
export const titleOf = (path: string): string => {
  const name = basename(path).replace(/\.(txt|md|markdown|text)$/i, '')
  return name || basename(path)
}

/** A new entry for a picked file. */
export const entryOf = (path: string): Book => ({
  id: path,
  path,
  title: titleOf(path),
  added: new Date().toISOString(),
})

/** Cover color derived from the title, so two runs paint a card the same. */
export const bookHue = (title: string): number => {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  return h % 360
}
