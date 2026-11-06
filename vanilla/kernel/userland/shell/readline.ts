/// The interactive line editor: what the shell reads a command line with on a terminal. The terminal is put in raw mode
/// while a line is typed (the editor echoes and edits itself) and back in line mode before a command runs, so programs
/// still get a normal terminal. It honours the terminal's own `echo` setting: with echo off nothing is drawn.
///
/// Keys (bash/readline): Left Right Home End Delete Backspace, ^A ^E ^B ^F ^D ^H, Alt-b Alt-f (and Ctrl-Left/Right),
/// ^U ^K ^W Alt-d Alt-Backspace (kill) and ^Y (yank), ^T, Up/Down/^P/^N history, ^R reverse search, Tab completion,
/// ^L clear, bracketed paste, wrapped and multi-line text, and a redraw when the window size changes.
import type { Pear } from '../lib'

/** What a completer found: replace `line[start..cursor)` by one of `candidates` (already quoted for the shell). */
export interface Completion {
  start: number
  candidates: string[]
}

export interface ReadlineHost {
  history(): string[]
  /** `$TERM` */
  term(): string | undefined
  complete(line: string, cursor: number): Promise<Completion>
}

const ESC = '\x1b'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`
const KEY = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.?)/s

/** Width of a prompt on the screen: escape sequences take none. */
const visible = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x01\x02]/g, '')

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

export class Readline {
  private queue = ''
  private dec = new TextDecoder()
  private eof = false
  private line: string[] = []
  private pos = 0
  private hist = -1
  private saved = ''
  private killed = ''
  private cols = 80
  /** Rows between the first row of the prompt and the cursor, as last drawn. */
  private row = 0
  private show = true
  private tabbed = false
  private search: { query: string; at: number } | null = null
  private resized = false
  private prompt = ''
  /** A character typed at the end of the line that needs no repaint: just print it. */
  private quick: string | null = null

  constructor(private tiny: Pear, private host: ReadlineHost) {}

  /** Bracketed paste is requested only from terminals that know it (`TERM` says so). */
  private paste = false

  /** ^C at the prompt: forget the line being typed. */
  cancel(): void {
    this.line = []
    this.pos = 0
    this.hist = -1
    this.row = 0
    this.search = null
  }

  /** The window changed size: redraw at the next chance. */
  resize(): void {
    this.resized = true
    this.wake?.()
  }

  private wake: (() => void) | null = null
  private reading: Promise<Uint8Array | null> | null = null

  /**
   * One line (without the newline), null at end of input, or undefined when the terminal cannot be put in raw mode
   * (the caller falls back to reading lines from the line discipline).
   */
  async next(prompt: string, initial = ''): Promise<string | null | undefined> {
    let before
    try {
      before = await this.tiny.tcgetattr(0)
      await this.tiny.tcsetattr(0, { icanon: false, echo: false })
    } catch {
      return undefined
    }
    this.show = before.echo
    this.prompt = prompt
    this.row = 0
    this.cancel()
    if (initial) {
      this.line = [...initial]
      this.pos = this.line.length
    }
    try {
      if (this.show) await this.size()
      else if (prompt) await this.tiny.stdout.write(prompt)
      this.paste = this.show && /^(xterm|screen|tmux|rxvt|alacritty|kitty|foot|wezterm|vt[1-9]|linux)/.test(this.host.term() ?? '')
      await this.draw(true)
      if (this.paste) await this.tiny.stdout.write(`${ESC}[?2004h`)
      for (;;) {
        const r = await this.step()
        if (r !== undefined) return r
        if (this.eof) return null
        // one read stays outstanding across a wake-up (a window resize): a second one would swallow the next keystrokes
        const pending = (this.reading ??= this.tiny.stdin.read().catch(() => null))
        const chunk = await Promise.race([pending, new Promise<'wake'>((resolve) => (this.wake = () => resolve('wake')))])
        this.wake = null
        if (chunk === 'wake') continue
        this.reading = null
        if (!chunk) this.eof = true
        else this.queue += this.dec.decode(chunk, { stream: true })
      }
    } finally {
      this.wake = null
      if (this.paste) await this.tiny.stdout.write(`${ESC}[?2004l`).catch(() => {})
      await this.tiny.tcsetattr(0, { icanon: before.icanon, echo: before.echo }).catch(() => {})
    }
  }

  // --------------------------------------------------------------- drawing

  private async size(): Promise<void> {
    const w = await this.tiny.getwinsize(0).catch(() => null)
    this.cols = w && w.cols > 0 ? w.cols : 80
  }

  /** Where text puts the cursor: row and column after `chars`, starting at column 0 of row 0. */
  private layout(text: string[]): { row: number; col: number } {
    let row = 0
    let col = 0
    for (const c of text) {
      if (c === '\n') {
        row++
        col = 0
      } else {
        if (col >= this.cols) {
          row++
          col = 0
        }
        col++
      }
    }
    return { row, col }
  }

  /** Repaint the prompt and line, and put the cursor where it belongs. `first` is the prompt's first paint (nothing to erase). */
  private async draw(first = false): Promise<void> {
    if (!this.show) return
    const shown = this.search ? this.searchPrompt() : this.prompt
    const head = [...visible(shown).replace(/\r?\n/g, '\n')]
    const end = this.layout([...head, ...this.line])
    const cur = this.layout([...head, ...this.line.slice(0, this.pos)])
    let out = ''
    if (!first) out += `${this.row > 0 ? `${ESC}[${this.row}A` : ''}\r${ESC}[J`
    out += shown + this.line.join('')
    // a line that fills the last column leaves the cursor waiting to wrap: step onto the next row
    if (end.col >= this.cols) {
      out += ' \r'
      end.row++
      end.col = 0
    }
    const col = cur.col >= this.cols ? 0 : cur.col
    const row = cur.row + (cur.col >= this.cols ? 1 : 0)
    if (row !== end.row || col !== end.col) {
      if (end.row > row) out += `${ESC}[${end.row - row}A`
      out += `\r${col ? `${ESC}[${col}C` : ''}`
    }
    this.row = row
    await this.tiny.stdout.write(out.replace(/\n/g, '\r\n'))
  }

  private searchPrompt(): string {
    const s = this.search!
    return `(${s.at < 0 ? 'failed ' : ''}reverse-i-search)\`${s.query}': `
  }

  /** Move the cursor past the end of the text, so what comes next prints below it. */
  private async finish(): Promise<void> {
    if (!this.show) return
    const moved = this.pos !== this.line.length || this.search !== null
    this.pos = this.line.length
    this.search = null
    if (moved) await this.draw()
    await this.tiny.stdout.write('\r\n')
    this.row = 0
  }

  // ------------------------------------------------------------- editing

  private set(text: string): void {
    this.line = [...text]
    this.pos = this.line.length
  }

  private kill(from: number, to: number, append = false): void {
    const gone = this.line.splice(from, to - from).join('')
    this.killed = append ? this.killed + gone : gone
    this.pos = from
  }

  private wordLeft(): number {
    let i = this.pos
    while (i > 0 && !isWordChar(this.line[i - 1])) i--
    while (i > 0 && isWordChar(this.line[i - 1])) i--
    return i
  }

  private wordRight(): number {
    let i = this.pos
    while (i < this.line.length && !isWordChar(this.line[i])) i++
    while (i < this.line.length && isWordChar(this.line[i])) i++
    return i
  }

  private incomplete(): boolean {
    const q = this.queue
    if (q.startsWith(PASTE_START)) return !q.includes(PASTE_END)
    if (q[0] !== ESC) return false
    if (q.length === 1) return true
    if (q[1] === '[') return !/[@-~]/.test(q.slice(2)) || (PASTE_START.startsWith(q) && q.length < PASTE_START.length)
    if (q[1] === 'O') return q.length < 3
    return false
  }

  /** Handle queued input until a line is complete (string / null) or more input is needed (undefined). */
  private async step(): Promise<string | null | undefined> {
    if (this.resized) {
      this.resized = false
      await this.size()
      await this.draw()
    }
    while (this.queue !== '' && !this.incomplete()) {
      let key: string
      if (this.queue.startsWith(PASTE_START)) {
        const end = this.queue.indexOf(PASTE_END)
        const text = this.queue.slice(PASTE_START.length, end).replace(/\r\n?/g, '\n')
        this.queue = this.queue.slice(end + PASTE_END.length)
        this.line.splice(this.pos, 0, ...text)
        this.pos += [...text].length
        await this.draw()
        continue
      }
      if (this.queue[0] === ESC) key = KEY.exec(this.queue)![0]
      else key = [...this.queue][0]!
      this.queue = this.queue.slice(key.length)
      const r = this.search ? await this.searchKey(key) : await this.key(key)
      if (r !== undefined) return r
      if (this.quick !== null) {
        const q = this.quick
        this.quick = null
        await this.tiny.stdout.write(q)
      } else await this.draw()
    }
    return undefined
  }

  private async key(key: string): Promise<string | null | undefined> {
    const tab = key === '\t'
    if (!tab) this.tabbed = false
    switch (key) {
      case '\r':
      case '\n': {
        await this.finish()
        const out = this.line.join('')
        this.cancel()
        return out
      }
      case '\x04':
        if (this.line.length === 0) {
          if (this.show) await this.tiny.stdout.write('\r\n')
          return null
        }
        if (this.pos < this.line.length) this.line.splice(this.pos, 1)
        break
      case '\x7f':
      case '\b':
        if (this.pos > 0) this.line.splice(--this.pos, 1)
        break
      case `${ESC}[3~`:
        if (this.pos < this.line.length) this.line.splice(this.pos, 1)
        break
      case `${ESC}[D`:
      case `${ESC}OD`:
      case '\x02':
        if (this.pos > 0) this.pos--
        break
      case `${ESC}[C`:
      case `${ESC}OC`:
      case '\x06':
        if (this.pos < this.line.length) this.pos++
        break
      case `${ESC}[1;5D`:
      case `${ESC}[1;3D`:
      case `${ESC}b`:
        this.pos = this.wordLeft()
        break
      case `${ESC}[1;5C`:
      case `${ESC}[1;3C`:
      case `${ESC}f`:
        this.pos = this.wordRight()
        break
      case `${ESC}[H`:
      case `${ESC}OH`:
      case `${ESC}[1~`:
      case '\x01':
        this.pos = 0
        break
      case `${ESC}[F`:
      case `${ESC}OF`:
      case `${ESC}[4~`:
      case '\x05':
        this.pos = this.line.length
        break
      case '\x15':
        this.kill(0, this.pos)
        break
      case '\x0b':
        this.kill(this.pos, this.line.length)
        break
      case '\x17': {
        let i = this.pos
        while (i > 0 && /\s/.test(this.line[i - 1]!)) i--
        while (i > 0 && !/\s/.test(this.line[i - 1]!)) i--
        this.kill(i, this.pos)
        break
      }
      case `${ESC}d`:
        this.kill(this.pos, this.wordRight())
        break
      case `${ESC}\x7f`:
        this.kill(this.wordLeft(), this.pos)
        break
      case '\x19':
        this.line.splice(this.pos, 0, ...this.killed)
        this.pos += [...this.killed].length
        break
      case '\x14':
        if (this.pos > 0 && this.line.length > 1) {
          if (this.pos === this.line.length) this.pos--
          const a = this.line[this.pos - 1]!
          this.line[this.pos - 1] = this.line[this.pos]!
          this.line[this.pos] = a
          this.pos++
        }
        break
      case '\x0c':
        if (this.show) await this.tiny.stdout.write(`${ESC}[H${ESC}[2J${ESC}[3J`)
        this.row = 0
        break
      case `${ESC}[A`:
      case `${ESC}OA`:
      case '\x10': {
        const h = this.host.history()
        if (!h.length || this.hist === 0) break
        if (this.hist === -1) {
          this.saved = this.line.join('')
          this.hist = h.length
        }
        this.set(h[--this.hist]!)
        break
      }
      case `${ESC}[B`:
      case `${ESC}OB`:
      case '\x0e': {
        if (this.hist === -1) break
        const h = this.host.history()
        if (++this.hist >= h.length) {
          this.hist = -1
          this.set(this.saved)
        } else this.set(h[this.hist]!)
        break
      }
      case `${ESC}<`:
      case `${ESC}[5~`: {
        const h = this.host.history()
        if (!h.length) break
        if (this.hist === -1) this.saved = this.line.join('')
        this.hist = 0
        this.set(h[0]!)
        break
      }
      case `${ESC}>`:
      case `${ESC}[6~`:
        if (this.hist !== -1) {
          this.hist = -1
          this.set(this.saved)
        }
        break
      case '\x12': {
        this.search = { query: '', at: -1 }
        this.saved = this.line.join('')
        break
      }
      case '\t':
        await this.complete()
        break
      default:
        if (key.startsWith(ESC) || key < ' ') break // keys with no meaning here are ignored
        {
          const atEnd = this.pos === this.line.length
          this.line.splice(this.pos++, 0, key)
          if (atEnd && this.show) {
            const end = this.layout([...visible(this.prompt).replace(/\r?\n/g, '\n'), ...this.line])
            if (end.row === this.row && end.col < this.cols) this.quick = key
          }
        }
    }
    return undefined
  }

  /** Reverse incremental search: ^R again finds an older match, Enter runs it, anything else edits it. */
  private async searchKey(key: string): Promise<string | null | undefined> {
    const s = this.search!
    const h = this.host.history()
    const find = (from: number): number => {
      for (let i = Math.min(from, h.length - 1); i >= 0; i--) if (s.query === '' || h[i]!.includes(s.query)) return i
      return -1
    }
    const show = () => {
      if (s.at >= 0) this.set(h[s.at]!)
      else this.set(this.saved)
    }
    if (key === '\x12') {
      const i = find(s.at < 0 ? h.length - 1 : s.at - 1)
      if (i >= 0) s.at = i
    } else if (key === '\x7f' || key === '\b') {
      s.query = s.query.slice(0, -1)
      s.at = find(h.length - 1)
    } else if (key === '\x07' || key === ESC || key === '\x03') {
      this.search = null
      this.set(this.saved)
      return undefined
    } else if (key.length === 1 && key >= ' ') {
      s.query += key
      s.at = find(s.at < 0 ? h.length - 1 : s.at)
    } else {
      // any other key leaves the search with the found line in the editor, and the key acts on it
      this.search = null
      return await this.key(key)
    }
    show()
    return undefined
  }

  private async complete(): Promise<void> {
    const text = this.line.join('')
    const upto = this.line.slice(0, this.pos).join('')
    const { start, candidates } = await this.host.complete(text, upto.length).catch(() => ({ start: 0, candidates: [] as string[] }))
    if (!candidates.length) return
    const word = upto.slice(start)
    const sorted = [...new Set(candidates)].sort()
    let common = sorted[0]!
    for (const c of sorted) while (!c.startsWith(common)) common = common.slice(0, -1)
    const finish = sorted.length === 1 && !common.endsWith('/') ? `${common} ` : common
    if (finish.length > word.length || (sorted.length === 1 && finish !== word)) {
      const before = [...upto.slice(0, start)]
      const after = this.line.slice(this.pos)
      this.line = [...before, ...finish, ...after]
      this.pos = before.length + [...finish].length
      this.tabbed = false
      return
    }
    // nothing more to add: the second Tab lists the choices
    if (!this.tabbed) {
      this.tabbed = true
      return
    }
    if (this.show) {
      // a list shows the last path component only, as other shells do
      const names = sorted.map((c) => c.replace(/(?<=.)\/$/, '\u0000').replace(/^.*\//, '').replace('\u0000', '/'))
      const width = Math.max(...names.map((c) => [...c].length)) + 2
      const per = Math.max(1, Math.floor(this.cols / width))
      const rows = Math.ceil(sorted.length / per)
      let out = ''
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < per; c++) {
          const item = names[c * rows + r]
          if (item !== undefined) out += c === per - 1 || c * rows + r + rows >= names.length ? item : item.padEnd(width)
        }
        out += '\r\n'
      }
      this.pos = this.line.length
      await this.draw()
      await this.tiny.stdout.write(`\r\n${out}`)
      this.row = 0
    }
  }
}
