// The integrated terminal: the panel's Terminal tab. Terminals (each a group of split panes) run the Vanilla shell in the
// project folder. The terminal itself is the shared one (sdk/terminal.ts); this file is the panel around it.
import { refreshThemes, loadPrefs, TerminalGroup, TerminalSession } from '@tiny/terminal'
import { basename } from '@tiny/sdk'

const HOME = '/Users/pear'

export interface TerminalHost {
  /** The element the terminals are drawn in. */
  view: HTMLElement
  /** The terminal chooser and its buttons. */
  list: HTMLSelectElement
  /** The open project folder, if any. */
  project(): string | null
  /** Hide the panel (the last terminal closed). */
  hide(): void
}

interface Entry {
  group: TerminalGroup
  title: string
}

let host: TerminalHost
const entries: Entry[] = []
let current: Entry | null = null
let showing = false

export async function mount(h: TerminalHost, configDomain: string): Promise<void> {
  host = h
  await loadPrefs(configDomain, { fontSize: 13 })
  host.list.addEventListener('change', () => {
    const e = entries[Number(host.list.value)]
    if (e) select(e)
  })
  window.addEventListener('pagehide', disposeAll)
}

const dir = (): string => host.project() ?? HOME

/** A new terminal, in a new panel entry (the caller shows the panel). */
export async function create(): Promise<void> {
  const entry: Entry = { title: 'sh', group: null as unknown as TerminalGroup }
  entry.group = new TerminalGroup(
    (cwd) =>
      new TerminalSession({
        cwd: cwd ?? dir(),
        prompt: `${host.project() ? basename(host.project()!) : '~'} % `,
        shortcuts: true,
        onTitle: () => retitle(entry),
        onExit: (st) => {
          const s = entry.group.sessions.find((x) => x.ended && x.exit === st)
          if (!s) return
          if (st.clean) entry.group.closePane(s)
          else s.showExit(`The terminal process ${st.signal ? `was ended by ${st.signal}` : `exited with status ${st.code ?? '?'}`}. Press Return to restart.`)
        },
      }),
    () => retitle(entry),
    () => remove(entry),
  )
  entry.group.el.hidden = true
  host.view.append(entry.group.el)
  entries.push(entry)
  select(entry)
  await entry.group.start()
}

function retitle(e: Entry): void {
  const s = e.group.active
  if (s) e.title = s.title !== 'Terminal' ? s.title : 'sh'
  renderList()
}

function renderList(): void {
  host.list.replaceChildren(...entries.map((e, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: `${i + 1}: ${e.title}`, selected: e === current })))
  host.list.hidden = entries.length < 2
}

function select(e: Entry): void {
  current = e
  for (const x of entries) x.group.el.hidden = x !== e
  renderList()
  if (showing) {
    e.group.refitAll()
    requestAnimationFrame(() => e.group.active.focus())
  }
}

function remove(e: Entry): void {
  const i = entries.indexOf(e)
  if (i < 0) return
  entries.splice(i, 1)
  e.group.dispose()
  if (!entries.length) {
    current = null
    renderList()
    host.hide()
    return
  }
  if (current === e) select(entries[Math.min(i, entries.length - 1)]!)
  else renderList()
}

/** The Terminal tab was shown or hidden; the first time it is shown a terminal starts. */
export function shown(visible: boolean): void {
  showing = visible
  if (!visible) return
  if (!entries.length) void create()
  else if (current) select(current)
}

export const split = (): Promise<void> | undefined => current?.group.split('row')
export const kill = (): void => {
  if (current) remove(current)
}
/** Type a command line into the active terminal (starting one first if needed) and run it. */
export async function run(line: string): Promise<void> {
  if (!current) await create()
  current?.group.active.send(line + '\r')
  current?.group.active.focus()
}
export const clear = (): void => current?.group.active.clear()
export const focus = (): void => current?.group.active.focus()
export const cycle = (by: 1 | -1): void => current?.group.cycle(by)
export const retheme = (): void => refreshThemes()
export const hasTerminals = (): boolean => entries.length > 0

export function disposeAll(): void {
  for (const e of entries.splice(0)) e.group.dispose()
  current = null
}
