// Terminal 2: tabs and split panes of xterm.js terminals on Vanilla ptys (see sdk/terminal.ts for the terminal itself).
import { tiny } from '@tiny/sdk'
import { getPrefs, loadPrefs, MAX_FONT, MIN_FONT, refreshThemes, setPrefs, TerminalGroup, TerminalSession } from '@tiny/terminal'

const CONFIG = 'org.tiny.terminal'
const HOME = '/Users/pear'
const tabsEl = document.getElementById('tabs')!
const stage = document.getElementById('stage')!

interface Tab {
  group: TerminalGroup
  title: string
  button: HTMLElement
  label: HTMLElement
}
const tabs: Tab[] = []
let current: Tab | null = null
let closing = false

const active = (): TerminalSession | null => current?.group.active ?? null

// ---- tabs

async function newTab(cwd?: string): Promise<void> {
  const tab = {} as Tab
  tab.title = 'Terminal'
  tab.group = new TerminalGroup(
    (dir) =>
      new TerminalSession({
        cwd: dir ?? cwd ?? HOME,
        onTitle: () => retitle(tab),
        onCwd: () => retitle(tab),
        onExit: (st) => {
          const s = tab.group.sessions.find((x) => x.ended && x.exit === st)
          if (!s) return
          if (st.clean || closing) tab.group.closePane(s)
          else s.showExit(`Process ${st.signal ? `ended by ${st.signal}` : `exited with status ${st.code ?? '?'}`}. Press Return to restart.`)
        },
      }),
    () => {
      retitle(tab)
      setMenus()
    },
    () => closeTab(tab),
  )
  tab.group.el.hidden = true
  stage.append(tab.group.el)
  tab.label = Object.assign(document.createElement('span'), { className: 'label', textContent: tab.title })
  const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Close Tab' })
  x.setAttribute('aria-label', 'Close tab')
  tab.button = Object.assign(document.createElement('div'), { className: 'tab', role: 'tab' })
  tab.button.append(tab.label, x)
  tab.button.addEventListener('click', (e) => (e.target === x ? closeTab(tab) : select(tab)))
  tab.button.addEventListener('auxclick', (e) => e.button === 1 && closeTab(tab))
  tabsEl.insertBefore(tab.button, newTabButton)
  tabs.push(tab)
  select(tab)
  await tab.group.start(cwd)
  retitle(tab)
}

function select(tab: Tab): void {
  current = tab
  for (const t of tabs) {
    t.group.el.hidden = t !== tab
    t.button.setAttribute('aria-selected', String(t === tab))
  }
  tabsEl.hidden = tabs.length < 2
  requestAnimationFrame(() => {
    tab.group.refitAll()
    tab.group.active.focus()
  })
  retitle(tab)
  setMenus()
}

function closeTab(tab: Tab): void {
  const i = tabs.indexOf(tab)
  if (i < 0) return
  tabs.splice(i, 1)
  tab.group.dispose()
  tab.button.remove()
  if (!tabs.length) {
    if (!closing) tiny.window.close()
    return
  }
  if (current === tab) select(tabs[Math.min(i, tabs.length - 1)]!)
  tabsEl.hidden = tabs.length < 2
  setMenus()
}

const dirName = (p: string): string => (p === HOME ? '~' : p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1))

function retitle(tab: Tab): void {
  const s = tab.group.active
  if (!s) return
  tab.title = s.title !== 'Terminal' ? s.title : dirName(s.cwd)
  tab.label.textContent = tab.title
  tab.button.title = tab.title
  if (tab === current) tiny.window.setTitle(tab.title === '~' || !tab.title ? 'Terminal' : `Terminal — ${tab.title}`)
}

const newTabButton = Object.assign(document.createElement('button'), { className: 'newtab', textContent: '+', title: 'New Tab (Cmd+T)' })
newTabButton.setAttribute('aria-label', 'New tab')
newTabButton.addEventListener('click', () => void newTab(active()?.cwd))
tabsEl.append(newTabButton)

function step(by: 1 | -1): void {
  if (tabs.length < 2 || !current) return
  select(tabs[(tabs.indexOf(current) + by + tabs.length) % tabs.length]!)
}

// ---- commands

async function saveText(): Promise<void> {
  const s = active()
  if (!s) return
  const path = await tiny.dialogs.saveFile({ name: 'Terminal Output.txt', startIn: `${HOME}/Documents`, title: 'Save Terminal Text As' })
  if (path) await tiny.writeFile(path, new TextEncoder().encode(s.text())).catch((e) => tiny.dialogs.alert({ message: 'The text could not be saved.', detail: (e as Error).message }))
}

async function scrollbackPrompt(): Promise<void> {
  const v = await tiny.dialogs.prompt('Lines of scrollback to keep:', { value: String(getPrefs().scrollback), title: 'Scrollback' })
  const n = Number(v)
  if (v !== null && Number.isFinite(n)) setPrefs({ scrollback: n })
  setMenus()
}

const zoom = (by: number) => {
  setPrefs({ fontSize: Math.min(MAX_FONT, Math.max(MIN_FONT, getPrefs().fontSize + by)) })
  setMenus()
}

function setMenus(): void {
  const p = getPrefs()
  // the actions look the active terminal up when they run: it changes while the menus stay as they are
  void tiny.window.setMenus([
    {
      title: 'Terminal',
      items: [
        { label: 'New Window', shortcut: 'Cmd+N', action: () => void tiny.app.openWindow() },
        { label: 'New Tab', shortcut: 'Cmd+T', action: () => void newTab(active()?.cwd) },
        { separator: true },
        { label: 'Split Pane Right', shortcut: 'Cmd+D', action: () => void current?.group.split('row') },
        { label: 'Split Pane Down', shortcut: 'Cmd+Shift+D', action: () => void current?.group.split('col') },
        { label: 'Close Pane', shortcut: 'Cmd+Alt+W', action: () => { const s = active(); if (s) current?.group.closePane(s) } },
        { label: 'Close Tab', shortcut: 'Cmd+Shift+W', action: () => current && closeTab(current) },
        { separator: true },
        { label: 'Save Text As…', shortcut: 'Cmd+S', action: () => void saveText() },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Copy', shortcut: 'Cmd+C', action: () => void active()?.copy() },
        { label: 'Paste', shortcut: 'Cmd+V', action: () => void active()?.paste() },
        { label: 'Select All', shortcut: 'Cmd+A', action: () => active()?.selectAll() },
        { separator: true },
        { label: 'Find…', shortcut: 'Cmd+F', action: () => active()?.showFind() },
        { label: 'Find Next', shortcut: 'Cmd+G', action: () => active()?.findNext() },
        { label: 'Find Previous', shortcut: 'Cmd+Shift+G', action: () => active()?.findNext(true) },
        { separator: true },
        { label: 'Clear Screen', shortcut: 'Cmd+K', action: () => active()?.clear() },
        { label: 'Reset Terminal', action: () => active()?.reset() },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Bigger', shortcut: 'Cmd+=', disabled: p.fontSize >= MAX_FONT, action: () => zoom(1) },
        { label: 'Smaller', shortcut: 'Cmd+-', disabled: p.fontSize <= MIN_FONT, action: () => zoom(-1) },
        { label: 'Actual Size', shortcut: 'Cmd+0', action: () => (setPrefs({ fontSize: 12 }), setMenus()) },
        { separator: true },
        { label: 'Block Cursor', checked: p.cursorStyle === 'block', action: () => (setPrefs({ cursorStyle: 'block' }), setMenus()) },
        { label: 'Underline Cursor', checked: p.cursorStyle === 'underline', action: () => (setPrefs({ cursorStyle: 'underline' }), setMenus()) },
        { label: 'Bar Cursor', checked: p.cursorStyle === 'bar', action: () => (setPrefs({ cursorStyle: 'bar' }), setMenus()) },
        { label: 'Blinking Cursor', checked: p.cursorBlink, action: () => (setPrefs({ cursorBlink: !p.cursorBlink }), setMenus()) },
        { separator: true },
        { label: 'Use Option as Meta Key', checked: p.optionIsMeta, action: () => (setPrefs({ optionIsMeta: !p.optionIsMeta }), setMenus()) },
        { label: 'Visual Bell', checked: p.visualBell, action: () => (setPrefs({ visualBell: !p.visualBell }), setMenus()) },
        { label: 'Allow Programs to Set the Clipboard', checked: p.osc52, action: () => (setPrefs({ osc52: !p.osc52 }), setMenus()) },
        { label: 'Scrollback…', action: () => void scrollbackPrompt() },
        { separator: true },
        { label: 'Scroll to Top', shortcut: 'Cmd+Home', action: () => active()?.scrollTo('top') },
        { label: 'Scroll to Bottom', shortcut: 'Cmd+End', action: () => active()?.scrollTo('bottom') },
        { separator: true },
        { label: 'Next Tab', shortcut: 'Cmd+Alt+ArrowRight', action: () => step(1) },
        { label: 'Previous Tab', shortcut: 'Cmd+Alt+ArrowLeft', action: () => step(-1) },
        { label: 'Next Pane', shortcut: 'Cmd+]', action: () => current?.group.cycle(1) },
        { label: 'Previous Pane', shortcut: 'Cmd+[', action: () => current?.group.cycle(-1) },
      ],
    },
  ])
}

// ---- start and stop

void (async () => {
  await tiny.ready
  await loadPrefs(CONFIG)
  tiny.on('theme', () => refreshThemes())
  tiny.on('focus', () => active()?.focus())
  document.body.addEventListener('pointerdown', () => queueMicrotask(() => active()?.focus()))
  tiny.window.onCloseRequest(() => {
    closing = true
    for (const t of [...tabs]) t.group.dispose()
    return true
  })
  setMenus()
  const cwd = (tiny.app.state as { cwd?: string } | null)?.cwd
  await newTab(typeof cwd === 'string' ? cwd : undefined)
  tiny.app.onSaveState(() => ({ cwd: active()?.cwd }))
})()
