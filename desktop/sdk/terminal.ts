/// A terminal for apps: xterm.js (the emulator) wired to a Vanilla pseudo-terminal and a shell, with the features people
/// expect of one: 256-colour and truecolor, the alternate screen, mouse reporting, bracketed paste, Unicode 11, inline
/// images (sixel and iTerm), hyperlinks (plain and OSC 8), find, scrollback, copy and paste through the system clipboard,
/// OSC 0/2 titles, OSC 7 working directory, OSC 9/777 notifications, OSC 52 clipboard writes, a visual bell, and splits.
///
/// Terminal.app and Code.app both build on this module (`@tiny/terminal`). An app that uses it needs `process.spawn` and
/// `fs.user`, plus `clipboard` for copy and paste and `notifications` for programs that ask to notify.
import { Terminal, type IDisposable, type ITheme } from '@xterm/xterm'
import xtermCss from '@xterm/xterm/css/xterm.css?raw'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { tiny } from '@tiny/sdk'

// ------------------------------------------------------------------------------------------------ preferences

export interface TerminalPrefs {
  fontSize: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  /** Option acts as Meta (Option+B / Option+F word movement, Esc-prefixed keys). */
  optionIsMeta: boolean
  /** Flash the terminal on the bell character. */
  visualBell: boolean
  /** Let programs set the clipboard with OSC 52. */
  osc52: boolean
}

export const DEFAULT_PREFS: TerminalPrefs = {
  fontSize: 12,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  optionIsMeta: true,
  visualBell: true,
  osc52: true,
}

export const MIN_FONT = 8
export const MAX_FONT = 32

let prefs: TerminalPrefs = { ...DEFAULT_PREFS }
let domain: string | null = null
const live = new Set<TerminalSession>()

export const getPrefs = (): Readonly<TerminalPrefs> => prefs

/** Load the saved preferences (config domain `domain`) and apply them to every open terminal. */
export async function loadPrefs(configDomain: string, defaults: Partial<TerminalPrefs> = {}): Promise<void> {
  domain = configDomain
  const saved = (await tiny.configGet(configDomain, 'terminal', null).catch(() => null)) as Partial<TerminalPrefs> | null
  prefs = { ...DEFAULT_PREFS, ...defaults, ...sanitize(saved) }
  for (const s of live) s.applyPrefs()
}

/** Change preferences, persist them, and apply them everywhere. */
export function setPrefs(change: Partial<TerminalPrefs>): void {
  prefs = { ...prefs, ...sanitize(change) }
  if (domain) void tiny.configSet(domain, 'terminal', prefs).catch(() => {})
  for (const s of live) s.applyPrefs()
}

function sanitize(p: Partial<TerminalPrefs> | null | undefined): Partial<TerminalPrefs> {
  const out: Partial<TerminalPrefs> = {}
  if (!p || typeof p !== 'object') return out
  if (typeof p.fontSize === 'number') out.fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(p.fontSize)))
  if (p.cursorStyle === 'block' || p.cursorStyle === 'underline' || p.cursorStyle === 'bar') out.cursorStyle = p.cursorStyle
  if (typeof p.cursorBlink === 'boolean') out.cursorBlink = p.cursorBlink
  if (typeof p.scrollback === 'number') out.scrollback = Math.min(100000, Math.max(0, Math.round(p.scrollback)))
  if (typeof p.optionIsMeta === 'boolean') out.optionIsMeta = p.optionIsMeta
  if (typeof p.visualBell === 'boolean') out.visualBell = p.visualBell
  if (typeof p.osc52 === 'boolean') out.osc52 = p.osc52
  return out
}

/** Re-read colours after the theme changed (call from `tiny.on('theme')` or when an app restyles the terminal). */
export function refreshThemes(): void {
  for (const s of live) s.retheme()
}

// ------------------------------------------------------------------------------------------------ appearance

const DARK_ANSI = ['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#969896', '#ff7b7b', '#c5d37a', '#ffd988', '#9bbddd', '#cba9d8', '#a3d6cf', '#ffffff']
const LIGHT_ANSI = ['#000000', '#c91b00', '#00a600', '#a08a00', '#0225c7', '#c930c7', '#00a5a5', '#a9a9a9', '#686868', '#ff6e67', '#37c837', '#b8a000', '#6871ff', '#ff77ff', '#00b6b6', '#4d4d4d']

function themeOf(el: HTMLElement): ITheme {
  const css = getComputedStyle(el)
  const dark = document.documentElement.dataset.theme !== 'light'
  const background = css.backgroundColor && css.backgroundColor !== 'rgba(0, 0, 0, 0)' ? css.backgroundColor : dark ? '#1e1e1e' : '#ffffff'
  const foreground = css.color || (dark ? '#d4d4d4' : '#1e1e1e')
  const a = dark ? DARK_ANSI : LIGHT_ANSI
  return {
    background, foreground,
    cursor: foreground, cursorAccent: background,
    selectionBackground: dark ? 'rgba(120,150,210,0.45)' : 'rgba(60,110,200,0.30)',
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11], brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  }
}

const monoFont = (): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
  return v || 'Menlo, Monaco, "Courier New", monospace'
}

const STYLE = `
${xtermCss}
.tm-session { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--terminal-bg, #1e1e1e); color: var(--terminal-fg, #d4d4d4); padding: 4px 0 0 8px; box-sizing: border-box; }
.tm-session .xterm { height: 100%; }
.tm-session .xterm-viewport { background: transparent !important; }
.tm-session.bell::after { content: ''; position: absolute; inset: 0; background: currentColor; opacity: .18; pointer-events: none; }
.tm-group { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.tm-group > .tm-cell, .tm-group > .tm-split { flex: 1 1 0; position: relative; display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.tm-split { display: flex; min-width: 0; min-height: 0; }
.tm-split.row { flex-direction: row; }
.tm-split.col { flex-direction: column; }
.tm-split > .tm-cell { position: relative; min-width: 0; min-height: 0; flex: 1 1 0; overflow: hidden; }
.tm-split > .tm-divider { flex: none; background: var(--separator, rgba(128,128,128,.35)); z-index: 2; }
.tm-split.row > .tm-divider { width: 1px; cursor: col-resize; margin: 0 -2px; padding: 0 2px; background-clip: content-box; }
.tm-split.col > .tm-divider { height: 1px; cursor: row-resize; margin: -2px 0; padding: 2px 0; background-clip: content-box; }
.tm-cell.inactive .tm-session::before { content: ''; position: absolute; inset: 0; background: var(--terminal-bg, #000); opacity: .28; pointer-events: none; z-index: 3; }
.tm-find { position: absolute; top: 6px; right: 18px; z-index: 5; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 6px; font: 12px var(--font, system-ui); background: var(--window-titlebar, #2b2b2b); color: var(--text, #ddd); border: 1px solid var(--separator, #555); box-shadow: 0 2px 8px rgba(0,0,0,.35); }
.tm-find[hidden] { display: none; }
.tm-find input { width: 170px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--separator, #555); border-radius: 4px; padding: 2px 6px; outline: 0; }
.tm-find input:focus { border-color: var(--accent, #3b82f6); }
.tm-find button { font: inherit; min-width: 24px; height: 22px; padding: 0 4px; color: inherit; background: none; border: 0; border-radius: 4px; cursor: pointer; }
.tm-find button:hover { background: rgba(128,128,128,.25); }
.tm-find button[aria-pressed='true'] { background: var(--accent, #3b82f6); color: #fff; }
.tm-find .count { min-width: 44px; text-align: center; opacity: .7; }
.tm-exit { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; padding: 4px 10px; font: 12px var(--mono, monospace); background: var(--window-titlebar, #333); color: var(--text, #ddd); border-top: 1px solid var(--separator, #555); }
`

let styled = false
function ensureStyle(): void {
  if (styled) return
  styled = true
  document.head.append(Object.assign(document.createElement('style'), { id: 'tm-style', textContent: STYLE }))
}

// ------------------------------------------------------------------------------------------------ one terminal

export interface SessionOptions {
  /** Starting directory. */
  cwd: string
  /** The program to run (default `/bin/sh`). */
  shell?: string
  args?: string[]
  /** Extra environment; `TERM`, `COLORTERM`, `HOME`, `USER` have defaults. */
  env?: Record<string, string>
  /** Shell prompt (`PS1`). */
  prompt?: string
  /** The title before the program sets one. */
  title?: string
  onTitle?(title: string): void
  onCwd?(path: string): void
  /** Handle Cmd+C, V, A, F, G, K inside the terminal, for an app with no menu that owns them. */
  shortcuts?: boolean
  /** The program ended. `clean` means exit status 0. */
  onExit?(status: { code: number | null; signal: string | null; clean: boolean }): void
}

const enc = new TextEncoder()
const HIGH_WATER = 1 << 20

/** One xterm.js instance attached to a Vanilla pty, with a shell on the slave side. */
export class TerminalSession {
  readonly el = Object.assign(document.createElement('div'), { className: 'tm-session' })
  readonly term: Terminal
  cwd: string
  title: string
  pid = -1
  /** The program has ended (or the session was disposed). */
  ended = false
  /** Called when the terminal takes keyboard focus. */
  onFocus?: () => void
  exit: { code: number | null; signal: string | null; clean: boolean } | null = null

  private fit = new FitAddon()
  private search = new SearchAddon()
  private master = -1
  private opened = false
  private disposed = false
  private pending = 0
  private drain: (() => void) | null = null
  private subs: IDisposable[] = []
  private find: HTMLDivElement
  private findInput: HTMLInputElement
  private findCount: HTMLSpanElement
  private findCase = false
  private findRegex = false
  private fitFrame = 0
  private bellTimer: ReturnType<typeof setTimeout> | undefined
  private lastPaste = { text: '', at: 0 }
  private resizer: ResizeObserver

  constructor(private opts: SessionOptions) {
    ensureStyle()
    this.cwd = opts.cwd
    this.title = opts.title ?? 'Terminal'
    const p = prefs
    this.term = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      fontFamily: monoFont(),
      fontSize: p.fontSize,
      lineHeight: 1.15,
      cursorStyle: p.cursorStyle,
      cursorBlink: p.cursorBlink,
      scrollback: p.scrollback,
      macOptionIsMeta: p.optionIsMeta,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      convertEol: false,
      theme: {},
      linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false },
    })
    live.add(this)
    this.find = this.buildFind()
    this.findInput = this.find.querySelector('input')!
    this.findCount = this.find.querySelector('.count')!
    this.resizer = new ResizeObserver(() => this.scheduleFit())
  }

  /** Attach to the page (the element must be in the document) and start the program, which keeps running after this returns. */
  open(host: HTMLElement): void {
    host.append(this.el)
    this.term.open(this.el)
    this.opened = true
    this.el.append(this.find)
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)))
    try {
      this.term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true }))
    } catch {
      /* images are optional */
    }
    this.retheme()
    this.wire()
    this.resizer.observe(this.el)
    this.fitNow()
    void this.start()
  }

  // ---- the program

  private async start(): Promise<void> {
    try {
      const pty = await tiny.openpty()
      if (this.disposed) {
        await tiny.close(pty.master).catch(() => {})
        await tiny.close(pty.slave).catch(() => {})
        return
      }
      this.master = pty.master
      await tiny.setwinsize(this.master, { cols: this.term.cols, rows: this.term.rows })
      const o = this.opts
      this.pid = await tiny.spawn(o.shell ?? '/bin/sh', {
        args: o.args,
        cwd: this.cwd,
        env: {
          HOME: '/Users/pear', USER: 'pear', LOGNAME: 'pear', LANG: 'en_US.UTF-8',
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Pear_Terminal',
          PS1: o.prompt ?? 'pear@pear ~ % ',
          ...o.env,
        },
        setsid: true,
        stdio: { stdin: { fd: pty.slave }, stdout: { fd: pty.slave }, stderr: { fd: pty.slave } },
      } as Parameters<typeof tiny.spawn>[1])
      await tiny.close(pty.slave)
      for (;;) {
        const chunk = await tiny.read(this.master, 65536)
        if (!chunk || !chunk.length) break
        await this.feed(chunk)
      }
    } catch (e) {
      if (!this.disposed) this.term.write(`\r\nTerminal: ${(e as Error).message}\r\n`)
    }
    if (this.disposed) return
    const st = this.pid > 0 ? await tiny.wait(this.pid).catch(() => null) : null
    this.ended = true
    const code = st?.code ?? null
    this.exit = { code, signal: st?.signal ?? null, clean: code === 0 }
    if (this.master >= 0) void tiny.close(this.master).catch(() => {})
    this.master = -1
    this.opts.onExit?.(this.exit)
  }

  /** Write program output, waiting when the emulator is far behind so a flood cannot exhaust memory. */
  private async feed(chunk: Uint8Array): Promise<void> {
    this.pending += chunk.length
    this.term.write(chunk, () => {
      this.pending -= chunk.length
      if (this.pending < HIGH_WATER / 2) this.drain?.()
    })
    if (this.pending > HIGH_WATER) await new Promise<void>((r) => (this.drain = r))
    this.drain = null
  }

  /** Bytes to the program (through the pty's line discipline). */
  send(data: string | Uint8Array): void {
    if (this.master < 0) return
    void tiny.write(this.master, typeof data === 'string' ? enc.encode(data) : data).catch(() => {})
  }

  /** Print a message in the terminal without involving the program. */
  print(text: string): void {
    this.term.write(text.replace(/\r?\n/g, '\r\n'))
  }

  /** Run the program again in the same terminal (after it ended). */
  async restart(): Promise<void> {
    if (!this.ended) return
    this.ended = false
    this.exit = null
    this.el.querySelector('.tm-exit')?.remove()
    this.term.reset()
    this.pid = -1
    await this.start()
  }

  // ---- wiring

  private wire(): void {
    const t = this.term
    this.subs.push(
      t.onData((d) => this.send(d)),
      t.onBinary((d) => this.send(Uint8Array.from(d, (c) => c.charCodeAt(0)))),
      t.onResize(({ cols, rows }) => {
        if (this.master >= 0) void tiny.setwinsize(this.master, { cols, rows }).catch(() => {})
      }),
      t.onTitleChange((title) => {
        this.title = title || this.opts.title || 'Terminal'
        this.opts.onTitle?.(this.title)
      }),
      t.onBell(() => this.bell()),
    )
    // OSC 7: the program says where it is (`file://host/path`)
    this.subs.push(
      t.parser.registerOscHandler(7, (data) => {
        try {
          const url = new URL(data)
          if (url.protocol !== 'file:') return false
          this.cwd = decodeURIComponent(url.pathname)
          this.opts.onCwd?.(this.cwd)
        } catch {
          return false
        }
        return true
      }),
      // OSC 52: a program sets the clipboard (reading it back is never allowed)
      t.parser.registerOscHandler(52, (data) => {
        const i = data.indexOf(';')
        const payload = i >= 0 ? data.slice(i + 1) : data
        if (!prefs.osc52 || !payload || payload === '?') return true
        try {
          const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
          void writeClipboard(new TextDecoder().decode(bytes))
        } catch {
          /* not base64 */
        }
        return true
      }),
      // OSC 9 (iTerm2 / ConEmu) and OSC 777;notify (urxvt / VTE): a program asks for a notification
      t.parser.registerOscHandler(9, (data) => {
        if (/^\d+(;|$)/.test(data)) return true // ConEmu progress and friends are not notifications
        if (data) void tiny.shell.notify(this.title, data).catch(() => {})
        return true
      }),
      t.parser.registerOscHandler(777, (data) => {
        const [kind, title = '', ...body] = data.split(';')
        if (kind === 'notify') void tiny.shell.notify(title, body.join(';')).catch(() => {})
        return true
      }),
    )
    t.attachCustomKeyEventHandler((e) => this.key(e))
    t.textarea?.addEventListener('focus', () => this.onFocus?.())
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      void this.contextMenu(e)
    })
  }

  /** Keys Desktop, the menu or the host app owns are not typed into the program; returning false skips xterm's own handling. */
  private key(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return !(e.metaKey && !e.ctrlKey)
    // keys Desktop owns (Mission Control, the launcher, window switching) never reach the program
    if ((e.ctrlKey && e.key === 'ArrowUp') || (e.altKey && (e.key === 'Tab' || e.code === 'Space')) || e.key === 'F3') return false
    if (this.ended) {
      if (e.key === 'Enter' && !this.exit?.clean) {
        e.preventDefault()
        void this.restart()
      }
      return false
    }
    if (e.metaKey && !e.ctrlKey) {
      if (this.opts.shortcuts && !e.altKey) this.shortcut(e)
      return false // Cmd+C/V/A/F/K/T/W..., Desktop's and the menus' shortcuts
    }
    if (e.ctrlKey && e.shiftKey && !e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'c' && this.term.hasSelection()) {
        e.preventDefault()
        void this.copy()
        return false
      }
      if (k === 'v') {
        e.preventDefault()
        void this.paste()
        return false
      }
      if (k === 'f') {
        e.preventDefault()
        this.showFind()
        return false
      }
    }
    return true
  }

  private shortcut(e: KeyboardEvent): void {
    const k = e.key.toLowerCase()
    const run = (f: () => void) => {
      e.preventDefault()
      e.stopPropagation()
      f()
    }
    if (k === 'c' && this.term.hasSelection()) run(() => void this.copy())
    else if (k === 'v') run(() => void this.paste())
    else if (k === 'a') run(() => this.selectAll())
    else if (k === 'f') run(() => this.showFind())
    else if (k === 'g') run(() => this.findNext(e.shiftKey))
    else if (k === 'k') run(() => this.clear())
  }

  private bell(): void {
    if (!prefs.visualBell) return
    clearTimeout(this.bellTimer)
    this.el.classList.add('bell')
    this.bellTimer = setTimeout(() => this.el.classList.remove('bell'), 120)
  }

  // ---- appearance

  applyPrefs(): void {
    if (!this.opened) return
    const t = this.term
    t.options.fontSize = prefs.fontSize
    t.options.cursorStyle = prefs.cursorStyle
    t.options.cursorBlink = prefs.cursorBlink
    t.options.scrollback = prefs.scrollback
    t.options.macOptionIsMeta = prefs.optionIsMeta
    this.scheduleFit()
  }

  retheme(): void {
    this.term.options.theme = themeOf(this.el)
    this.term.options.fontFamily = monoFont()
    if (this.opened) this.scheduleFit()
  }

  private scheduleFit(): void {
    this.fitFrame ||= requestAnimationFrame(() => {
      this.fitFrame = 0
      this.fitNow()
    })
  }

  /** Make the grid fill the element. Does nothing while the terminal is hidden. */
  fitNow(): void {
    if (!this.opened || this.disposed || !this.el.clientWidth || !this.el.clientHeight) return
    try {
      this.fit.fit()
    } catch {
      /* not laid out yet */
    }
  }

  focus(): void {
    this.term.focus()
  }

  // ---- clipboard

  get selection(): string {
    return this.term.getSelection()
  }

  async copy(): Promise<void> {
    const text = this.term.getSelection()
    if (text) await writeClipboard(text)
  }

  async paste(text?: string): Promise<void> {
    const t = text ?? (await readClipboard())
    if (!t) return
    // the native paste event and a menu shortcut can both fire for one keystroke
    const now = Date.now()
    if (t === this.lastPaste.text && now - this.lastPaste.at < 80) return
    this.lastPaste = { text: t, at: now }
    this.term.paste(t.replace(/\r?\n/g, '\r'))
    this.term.focus()
  }

  selectAll(): void {
    this.term.selectAll()
  }

  /** Clear the screen and the scrollback; the line the cursor is on stays. */
  clear(): void {
    this.term.clear()
  }

  /** Forget everything, including scrollback and modes (a full reset, RIS). */
  reset(): void {
    this.term.reset()
    this.send('\r') // an empty line: the shell prints a fresh prompt
  }

  /** The visible text and scrollback as plain text. */
  text(): string {
    const b = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i)
      if (!l) continue
      const s = l.translateToString(true)
      if (l.isWrapped && lines.length) lines[lines.length - 1] += s
      else lines.push(s)
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    return lines.join('\n') + '\n'
  }

  scrollTo(where: 'top' | 'bottom' | 'pageUp' | 'pageDown'): void {
    if (where === 'top') this.term.scrollToTop()
    else if (where === 'bottom') this.term.scrollToBottom()
    else this.term.scrollPages(where === 'pageUp' ? -1 : 1)
  }

  // ---- find

  private buildFind(): HTMLDivElement {
    const bar = document.createElement('div')
    bar.className = 'tm-find'
    bar.hidden = true
    bar.setAttribute('role', 'search')
    bar.innerHTML =
      '<input type="text" placeholder="Find" aria-label="Find in terminal" spellcheck="false" autocomplete="off">' +
      '<span class="count" aria-live="polite"></span>' +
      '<button type="button" data-k="case" title="Match Case" aria-label="Match case" aria-pressed="false">Aa</button>' +
      '<button type="button" data-k="regex" title="Regular Expression" aria-label="Regular expression" aria-pressed="false">.*</button>' +
      '<button type="button" data-k="prev" title="Previous (Shift+Enter)" aria-label="Previous match">↑</button>' +
      '<button type="button" data-k="next" title="Next (Enter)" aria-label="Next match">↓</button>' +
      '<button type="button" data-k="close" title="Close (Esc)" aria-label="Close find">✕</button>'
    const input = bar.querySelector('input')!
    const run = (dir: 'next' | 'prev', incremental = false) => {
      if (!input.value) {
        this.search.clearDecorations()
        this.findCount.textContent = ''
        return
      }
      const o = { caseSensitive: this.findCase, regex: this.findRegex, incremental, decorations: { matchOverviewRuler: '#d18616', activeMatchColorOverviewRuler: '#a05e00', matchBackground: '#7a5c00', activeMatchBackground: '#c88a00' } }
      const found = dir === 'next' ? this.search.findNext(input.value, o) : this.search.findPrevious(input.value, o)
      if (!found) this.findCount.textContent = 'No results'
    }
    this.subs.push(this.search.onDidChangeResults(({ resultIndex, resultCount }) => (this.findCount.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : 'No results')))
    input.addEventListener('input', () => run('next', true))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        run(e.shiftKey ? 'prev' : 'next')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.hideFind()
      }
      e.stopPropagation()
    })
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button')
      if (!b) return
      const k = b.dataset.k
      if (k === 'case' || k === 'regex') {
        if (k === 'case') this.findCase = !this.findCase
        else this.findRegex = !this.findRegex
        b.setAttribute('aria-pressed', String(k === 'case' ? this.findCase : this.findRegex))
        run('next', true)
      } else if (k === 'next' || k === 'prev') run(k)
      else if (k === 'close') this.hideFind()
    })
    return bar
  }

  showFind(): void {
    this.find.hidden = false
    const sel = this.term.getSelection()
    if (sel && !sel.includes('\n')) this.findInput.value = sel
    this.findInput.focus()
    this.findInput.select()
  }

  hideFind(): void {
    this.find.hidden = true
    this.search.clearDecorations()
    this.findCount.textContent = ''
    this.term.focus()
  }

  findNext(back = false): void {
    if (this.find.hidden || !this.findInput.value) return this.showFind()
    const o = { caseSensitive: this.findCase, regex: this.findRegex }
    if (back) this.search.findPrevious(this.findInput.value, o)
    else this.search.findNext(this.findInput.value, o)
  }

  // ---- context menu

  private async contextMenu(e: MouseEvent): Promise<void> {
    const has = this.term.hasSelection()
    await tiny.shell.contextMenu(
      [
        { label: 'Copy', shortcut: 'Cmd+C', disabled: !has, action: () => this.copy() },
        { label: 'Paste', shortcut: 'Cmd+V', action: () => this.paste() },
        { label: 'Select All', shortcut: 'Cmd+A', action: () => this.selectAll() },
        { separator: true },
        { label: 'Find…', shortcut: 'Cmd+F', action: () => this.showFind() },
        { label: 'Clear Screen', shortcut: 'Cmd+K', action: () => this.clear() },
      ],
      { x: e.clientX, y: e.clientY },
    )
  }

  // ---- end

  /** Hang up the terminal: the shell gets SIGHUP and the emulator is removed. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    live.delete(this)
    clearTimeout(this.bellTimer)
    cancelAnimationFrame(this.fitFrame)
    this.resizer.disconnect()
    this.drain?.()
    if (this.master >= 0) void tiny.close(this.master).catch(() => {})
    if (this.pid > 0 && !this.ended) void tiny.kill(this.pid, 'SIGHUP').catch(() => {})
    this.master = -1
    for (const s of this.subs) s.dispose()
    try {
      this.term.dispose()
    } catch {
      /* already gone */
    }
    this.el.remove()
  }

  /** Shown over a terminal whose program ended abnormally. */
  showExit(text: string): void {
    this.el.querySelector('.tm-exit')?.remove()
    this.el.append(Object.assign(document.createElement('div'), { className: 'tm-exit', textContent: text }))
  }
}

// ------------------------------------------------------------------------------------------------ helpers

function openLink(uri: string): void {
  if (/^(https?|mailto):/i.test(uri)) void tiny.shell.open(uri).catch(() => {})
}

export async function writeClipboard(text: string): Promise<void> {
  await tiny.service('tiny.clipboard', { op: 'write', items: [{ type: 'public.utf8-plain-text', data: text }] }).catch(() => {})
}

export async function readClipboard(): Promise<string> {
  const r = await tiny
    .service<{ items?: Array<{ data: unknown }> }>('tiny.clipboard', { op: 'read', types: ['public.utf8-plain-text'] })
    .catch(() => null)
  const d = r?.items?.[0]?.data
  return typeof d === 'string' ? d : d instanceof Uint8Array ? new TextDecoder().decode(d) : ''
}

// ------------------------------------------------------------------------------------------------ splits

type Node = { kind: 'leaf'; session: TerminalSession; el: HTMLElement } | { kind: 'split'; dir: 'row' | 'col'; a: Node; b: Node; el: HTMLElement; ratio: number }

/** A set of terminals laid out in splits, shown together (one tab). */
export class TerminalGroup {
  readonly el = Object.assign(document.createElement('div'), { className: 'tm-group' })
  active!: TerminalSession
  private root!: Node

  /**
   * @param make creates a session for a new pane (`cwd` is the active pane's directory)
   * @param onChange panes were added, removed, retitled or focused
   * @param onEmpty the last pane closed
   */
  constructor(
    private make: (cwd: string | undefined, group: TerminalGroup) => TerminalSession,
    private onChange: () => void,
    private onEmpty: () => void,
  ) {}

  /** Create the first pane. Attach `el` to the document first. */
  async start(cwd?: string): Promise<void> {
    const s = this.adopt(this.make(cwd, this))
    this.root = this.leaf(s)
    this.el.replaceChildren(this.root.el)
    this.active = s
    this.markActive()
    s.open(this.root.el)
    s.focus()
  }

  get sessions(): TerminalSession[] {
    const out: TerminalSession[] = []
    const walk = (n: Node): void => {
      if (n.kind === 'leaf') out.push(n.session)
      else (walk(n.a), walk(n.b))
    }
    if (this.root) walk(this.root)
    return out
  }

  private adopt(s: TerminalSession): TerminalSession {
    s.onFocus = () => this.setActive(s)
    return s
  }

  private leaf(session: TerminalSession): Node {
    const el = Object.assign(document.createElement('div'), { className: 'tm-cell' })
    return { kind: 'leaf', session, el }
  }

  private find(s: TerminalSession, n: Node = this.root, parent: Node | null = null): { node: Node; parent: Node | null } | null {
    if (n.kind === 'leaf') return n.session === s ? { node: n, parent } : null
    return this.find(s, n.a, n) ?? this.find(s, n.b, n)
  }

  /** Split the active pane; `row` puts the new pane to the right, `col` below. */
  async split(dir: 'row' | 'col'): Promise<void> {
    const at = this.find(this.active)
    if (!at) return
    const s = this.adopt(this.make(this.active.cwd, this))
    const fresh = this.leaf(s)
    const old = at.node
    const holder = Object.assign(document.createElement('div'), { className: `tm-split tm-cell ${dir}` })
    const node: Node = { kind: 'split', dir, a: old, b: fresh, el: holder, ratio: 0.5 }
    const divider = Object.assign(document.createElement('div'), { className: 'tm-divider', role: 'separator' })
    divider.setAttribute('aria-orientation', dir === 'row' ? 'vertical' : 'horizontal')
    old.el.replaceWith(holder)
    holder.append(old.el, divider, fresh.el)
    this.size(node)
    this.drag(divider, node)
    if (at.parent && at.parent.kind === 'split') {
      if (at.parent.a === old) at.parent.a = node
      else at.parent.b = node
    } else {
      this.root = node
      holder.classList.remove('tm-cell')
      this.el.replaceChildren(holder)
    }
    this.active = s
    this.markActive()
    this.refitAll()
    s.open(fresh.el)
    s.focus()
    this.onChange()
  }

  private size(n: Extract<Node, { kind: 'split' }>): void {
    n.a.el.style.flex = `${n.ratio} 1 0`
    n.b.el.style.flex = `${1 - n.ratio} 1 0`
  }

  private drag(divider: HTMLElement, n: Extract<Node, { kind: 'split' }>): void {
    divider.addEventListener('pointerdown', (down) => {
      down.preventDefault()
      divider.setPointerCapture(down.pointerId)
      const rect = n.el.getBoundingClientRect()
      const move = (e: PointerEvent) => {
        const r = n.dir === 'row' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height
        n.ratio = Math.min(0.9, Math.max(0.1, r))
        this.size(n)
      }
      const up = () => {
        divider.removeEventListener('pointermove', move)
        divider.removeEventListener('pointerup', up)
        this.refitAll()
      }
      divider.addEventListener('pointermove', move)
      divider.addEventListener('pointerup', up)
    })
  }

  /** Remove a pane (its program is hung up). The last one closing empties the group. */
  closePane(s: TerminalSession): void {
    const at = this.find(s)
    if (!at) return
    const order = this.sessions
    s.dispose()
    if (!at.parent || at.parent.kind !== 'split') {
      this.el.replaceChildren()
      this.onEmpty()
      return
    }
    const p = at.parent
    const sibling = p.a === at.node ? p.b : p.a
    // the sibling takes the place of the split that held both
    const grand = this.parentOf(p)
    if (grand && grand.kind === 'split') {
      p.el.replaceWith(sibling.el)
      if (grand.a === p) grand.a = sibling
      else grand.b = sibling
      this.size(grand)
    } else {
      this.root = sibling
      sibling.el.style.flex = ''
      if (sibling.kind === 'split') sibling.el.classList.remove('tm-cell')
      this.el.replaceChildren(sibling.el)
    }
    if (this.active === s) {
      const i = order.indexOf(s)
      this.active = order[i + 1] ?? order[i - 1] ?? this.firstOf(sibling)
    }
    this.markActive()
    this.refitAll()
    this.active.focus()
    this.onChange()
  }

  private firstOf(n: Node): TerminalSession {
    return n.kind === 'leaf' ? n.session : this.firstOf(n.a)
  }

  private parentOf(target: Node, n: Node = this.root): Node | null {
    if (n.kind === 'leaf') return null
    if (n.a === target || n.b === target) return n
    return this.parentOf(target, n.a) ?? this.parentOf(target, n.b)
  }

  setActive(s: TerminalSession): void {
    if (this.active === s) return
    this.active = s
    this.markActive()
    this.onChange()
  }

  /** Move focus to the next (or previous) pane. */
  cycle(step: 1 | -1 = 1): void {
    const all = this.sessions
    if (all.length < 2) return
    this.setActive(all[(all.indexOf(this.active) + step + all.length) % all.length]!)
    this.active.focus()
  }

  private markActive(): void {
    const multi = this.sessions.length > 1
    for (const s of this.sessions) s.el.parentElement?.classList.toggle('inactive', multi && s !== this.active)
  }

  refitAll(): void {
    requestAnimationFrame(() => this.sessions.forEach((s) => s.fitNow()))
  }

  dispose(): void {
    for (const s of this.sessions) s.dispose()
    this.el.remove()
  }
}
