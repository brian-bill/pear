import { tiny } from '@tiny/sdk'
import { bookHue, entryOf, readLibrary, writeLibrary, type Book } from './store'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** The library window. Every book it knows is a card; opening one is a reader window. */
export function runLibrary(): void {
  const grid = $<HTMLDivElement>('grid')
  const empty = $<HTMLDivElement>('empty')
  let books: Book[] = []

  const alert = (o: Parameters<typeof tiny.dialogs.alert>[0]) => void tiny.dialogs.alert(o)

  /** Which badge a card carries once its file has been checked. */
  function classify(b: Book, btn: HTMLButtonElement, initial: HTMLElement, sub: HTMLElement): void {
    void tiny
      .stat(b.path)
      .then((st) => {
        if (!btn.isConnected) return
        if (st.kind !== 'file') throw new Error('not a file')
        btn.classList.remove('missing')
        sub.textContent = readOn(b)
      })
      .catch(() => {
        if (!btn.isConnected) return
        btn.classList.add('missing')
        initial.textContent = '?'
        sub.textContent = 'Missing original file'
      })
  }

  const readOn = (b: Book): string => {
    const p = b.progress
    if (p?.line !== undefined && p.line > 0) return 'Continue reading'
    if (b.lastRead) return 'Read it once'
    return b.author ? b.author : 'Not read yet'
  }

  function card(b: Book): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'book'
    btn.title = b.path
    btn.setAttribute('role', 'listitem')
    btn.addEventListener('click', () => open(b.path))

    const cover = document.createElement('span')
    cover.className = 'cover'
    cover.style.background = `hsl(${bookHue(b.title)} 62% 46%)`
    const initial = document.createElement('span')
    initial.className = 'initial'
    initial.textContent = (b.title.trim()[0] ?? '?').toUpperCase()
    cover.append(initial)

    const title = document.createElement('span')
    title.className = 'btitle'
    title.textContent = b.title

    const sub = document.createElement('span')
    sub.className = 'bsub'
    sub.textContent = readOn(b)

    btn.append(cover, title, sub)
    classify(b, btn, initial, sub)
    return btn
  }

  function paint(): void {
    empty.hidden = books.length > 0
    grid.replaceChildren(...books.map(card))
  }

  /** A moved or deleted file shows as soon as the library comes forward again. */
  async function refresh(): Promise<void> {
    const lib = await readLibrary().catch(() => null)
    if (!lib) return
    books = lib.books
    paint()
  }

  /** `open` — one book, one reader window; the reader is told the book's path. Deduped by the
   *  reader itself? No: a second window of a book is a second reader (a real reader allows that). */
  function open(bookPath: string): void {
    tiny.app.openWindow({ path: bookPath }).catch((e) =>
      alert({ message: 'The book could not be opened.', detail: (e as Error).message, buttons: ['OK'] }),
    )
  }

  /** Add Books… — the system Open panel; the app only ever uses the picked paths. */
  async function add(): Promise<void> {
    const paths = await tiny.dialogs.openFile({
      title: 'Add Books',
      filters: [{ name: 'Text Books', ext: ['txt', 'md'] }],
      multiple: true,
    })
    if (!paths?.length) return
    const lib = await readLibrary().catch(() => ({ books: [] as Book[] }))
    let last: Book | undefined
    for (const p of paths) {
      let b = lib.books.find((x) => x.path === p)
      if (!b) {
        b = entryOf(p)
        lib.books.push(b)
      }
      last = b
    }
    books = lib.books
    await writeLibrary(lib).catch(() => {})
    paint()
    if (last) open(last.path)
  }

  function buildMenus(): void {
    void tiny.window.setMenus([
      { title: 'Books', items: [{ label: 'About Books', action: () => alert({ message: 'Books', detail: 'A reading library and paged reader for plain-text books.\nVersion 1.0.0', buttons: ['OK'] }) }] },
      { title: 'File', items: [{ label: 'Add Books…', shortcut: 'Cmd+O', action: () => void add() }] },
    ])
  }

  // A file opened with the app while the library is front-most becomes its own reader window.
  tiny.app.onOpenFile((p) => open(p))
  tiny.on('focus', () => void refresh())
  $<HTMLButtonElement>('add').addEventListener('click', () => void add())

  buildMenus()
  void refresh()
}
