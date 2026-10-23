import { tiny } from '@tiny/sdk'
import { entryOf, readLibrary, titleOf, writeLibrary, type Book, type Chapter, type ViewPrefs } from './store'
import { chaptersOf } from './format'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const DEFAULT_VIEW: Required<ViewPrefs> = { size: 17, font: 'serif', theme: 'sepia' }
const SIZE_MIN = 12
const SIZE_MAX = 30
/** Scroll events are noisy; the library file is written at most this much later. */
const SAVE_DEBOUNCE = 600

/**
 * A reader window: one book, told by its path in `tiny.app.state` (or the launch args when the file
 * was opened with Books directly). Everything it remembers goes into the book's entry of
 * library.json — the one place this app keeps state.
 */
export function runReader(path: string): void {
  const root = $<HTMLDivElement>('reader')
  root.hidden = false // the page ships both views; a reader window shows this one
  const page = $<HTMLDivElement>('page')
  const flow = $<HTMLElement>('flow')
  const labelEl = $<HTMLElement>('progress')

  const title = titleOf(path)
  const view: Required<ViewPrefs> = { ...DEFAULT_VIEW }
  const chapters: Chapter[] = []
  let sections: HTMLElement[] = []
  let entry: Book | undefined
  let readable = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let labelQueued = false

  const alert = (o: Parameters<typeof tiny.dialogs.alert>[0]) => void tiny.dialogs.alert(o)

  // ---- typography (per window, written back to the book entry so every window agrees)

  function applyView(): void {
    root.style.setProperty('--fs', `${view.size}px`)
    root.dataset.font = view.font
    root.dataset.view = view.theme
  }

  function setSize(n: number): void {
    view.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, n))
    applyView()
    paint()
    saveSoon(0)
  }

  function setPref<K extends keyof ViewPrefs>(k: K, v: NonNullable<ViewPrefs[K]>): void {
    (view as Record<string, unknown>)[k] = v
    applyView()
    saveSoon(0)
    buildMenus()
  }

  // ---- the text

  function resetFlow(): void {
    flow.replaceChildren()
    sections = []
    chapters.splice(0)
  }

  function build(): void {
    const frag = document.createDocumentFragment()
    for (const ch of chapters) {
      const section = document.createElement('section')
      if (ch.title) {
        const h = document.createElement('h2')
        h.textContent = ch.title
        section.append(h)
      }
      for (const p of ch.paragraphs) {
        const el = document.createElement('p')
        el.textContent = p
        section.append(el)
      }
      frag.append(section)
      sections.push(section)
    }
    flow.replaceChildren(frag)
  }

  // ---- progress: where the viewport top is, as a share and as a book place

  const scrollRange = (): number => page.scrollHeight - page.clientHeight

  function pct(): number {
    const range = scrollRange()
    if (range <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((100 * page.scrollTop) / range)))
  }

  /** The index of the chapter under the viewport's top few lines. */
  function chapterAtTop(): number {
    for (let i = sections.length - 1; i >= 0; i--) {
      const s = sections[i]
      if (s && s.offsetTop <= page.scrollTop + 40) return i
    }
    return 0
  }

  const lineHeight = (): number => {
    const v = Number.parseFloat(getComputedStyle(flow).lineHeight)
    return Number.isFinite(v) && v > 0 ? v : 24
  }

  function paint(): void {
    const i = chapterAtTop()
    labelEl.textContent = `Chapter ${i + 1} · ${pct()}%`
  }

  function bookmark(): { chapter?: number; line?: number } {
    const i = chapterAtTop()
    return i > 0 || sections[0] ? { chapter: i, line: page.scrollTop / lineHeight() } : { chapter: i }
  }

  function restore(): void {
    const p = entry?.progress
    if (!p) return void paint()
    let top = 0
    if (typeof p.line === 'number' && Number.isFinite(p.line)) top = p.line * lineHeight()
    else if (typeof p.chapter === 'number' && sections[p.chapter]?.offsetTop !== undefined)
      top = sections[p.chapter]!.offsetTop - 24
    const range = scrollRange()
    page.scrollTop = Math.max(0, Math.min(Math.round(top), range))
    paint()
  }

  // ---- the library file: entries are read fresh, then the book's own entry is updated in place

  function saveSoon(after: number): void {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void save(), after || SAVE_DEBOUNCE)
  }
  async function save(): Promise<void> {
    clearTimeout(saveTimer)
    try {
      const lib = await readLibrary().catch(() => ({ books: [] as Book[] }))
      let mine = lib.books.find((b) => b.path === path)
      if (!mine) {
        entry ??= entryOf(path)
        lib.books.push(entry)
        mine = entry
      }
      mine.lastRead = new Date().toISOString()
      mine.view = { ...view }
      // the save runs after every scroll, so the viewport now is the bookmark. A book whose file
      // cannot be read must keep whatever bookmark it had.
      if (readable) mine.progress = bookmark()
      await writeLibrary(lib)
    } catch {
      /* reading must never depend on the library file being writable */
    }
  }

  // ---- events

  function pageBy(dir: 1 | -1): void {
    const amount = Math.max(page.clientHeight - 60, 120) * dir
    page.scrollBy({ top: amount, behavior: 'auto' })
    paint()
    saveSoon(0)
  }

  function onScroll(): void {
    if (labelQueued) return
    labelQueued = true
    requestAnimationFrame(() => {
      labelQueued = false
      paint()
    })
    saveSoon(0)
  }

  /** Reading keys scroll the pane themselves, so the app behaves the same over every platform. */
  function onKey(e: KeyboardEvent): void {
    const by: Partial<Record<string, number>> = {
      PageDown: Math.max(page.clientHeight - 60, 120),
      PageUp: -Math.max(page.clientHeight - 60, 120),
      ArrowDown: 64,
      ArrowUp: -64,
      Home: -page.scrollHeight,
      End: page.scrollHeight,
    }
    const amount = by[e.key]
    if (amount === undefined) return
    e.preventDefault()
    page.scrollBy({ top: amount, behavior: 'auto' })
    paint()
    saveSoon(0)
  }

  function buildMenus(): void {
    const themes: Array<[{ label: string }, NonNullable<ViewPrefs['theme']>]> = [
      [{ label: 'Sepia' }, 'sepia'],
      [{ label: 'Light' }, 'light'],
      [{ label: 'Dark' }, 'dark'],
    ]
    void tiny.window.setMenus([
      { title: 'Books', items: [{ label: 'About Books', action: () => alert({ message: 'Books', detail: 'A reading library and paged reader for plain-text books.\nVersion 1.0.0', buttons: ['OK'] }) }] },
      { title: 'File', items: [{ label: 'Close', action: () => void tiny.window.close() }] },
      {
        title: 'Go',
        items: [
          { label: 'Next Page', shortcut: 'Cmd+ArrowRight', action: () => pageBy(1) },
          { label: 'Previous Page', shortcut: 'Cmd+ArrowLeft', action: () => pageBy(-1) },
        ],
      },
      {
        title: 'View',
        items: [
          { label: 'Bigger Text', shortcut: 'Cmd+=', action: () => setSize(view.size + 1) },
          { label: 'Smaller Text', shortcut: 'Cmd+-', action: () => setSize(view.size - 1) },
          { separator: true },
          { label: 'Serif', checked: view.font === 'serif', action: () => setPref('font', 'serif') },
          { label: 'Monospace', checked: view.font === 'mono', action: () => setPref('font', 'mono') },
          { separator: true },
          ...themes.map(([{ label }, t]) => ({ label, checked: view.theme === t, action: () => setPref('theme', t) })),
        ],
      },
    ])
  }

  /** Where the entry for this book should live before anything is written. */
  async function loadEntry(): Promise<Book> {
    const lib = await readLibrary()
    const found = lib.books.find((b) => b.path === path)
    if (found) return found
    const b = entryOf(path)
    lib.books.push(b)
    return b
  }

  // ---- start

  async function start(): Promise<void> {
    await tiny.window.setTitle(title)
    try {
      entry = await loadEntry()
    } catch {
      if (!entry) entry = entryOf(path)
      await save().catch(() => {})
    }

    try {
      const bytes = await tiny.readFile(path)
      readable = true
      resetFlow()
      chapters.push(...chaptersOf(new TextDecoder().decode(bytes)))
      Object.assign(view, entry.view ?? DEFAULT_VIEW)
      applyView()
      build()
      restore()
      saveSoon(0)
    } catch (e) {
      resetFlow()
      Object.assign(view, entry.view ?? DEFAULT_VIEW)
      applyView()
      const why = document.createElement('p')
      why.className = 'hint'
      why.textContent = 'The original file cannot be read.'
      const detail = document.createElement('span')
      detail.textContent = (e as Error).message
      flow.append(why, detail)
      await save().catch(() => {})
    }

    page.addEventListener('scroll', onScroll)
    page.addEventListener('keydown', onKey)
    $<HTMLButtonElement>('tolibrary').addEventListener('click', () => {
      void tiny.app.openWindow({})
    })

    // progress and typography save with a debounce: flush before the window can go away
    tiny.window.onCloseRequest(async () => {
      await save()
      return true
    })

    buildMenus()
    paint()
    addEventListener('resize', () => paint()) // re-wrapping can move the chapter boundary
  }

  // A path opened with the app while some reader window is front-most becomes its own window.
  tiny.app.onOpenFile((p) => {
    if (p === path) void tiny.window.focus()
    else void tiny.app.openWindow({ path: p }).catch((e) => alert({ message: 'The book could not be opened.', detail: (e as Error).message }))
  })

  void start()
}
