/// Pseudo-terminals. The master side is what a terminal emulator (xterm.js) attaches to; the slave side is
/// the stdin/stdout/stderr of the programs. Between them sits a small line discipline: echo, line editing,
/// ^C ^Z ^D, and CR/LF translation. The special characters are fixed (no termios `c_cc`).
import { SysError } from './errors'
import { cancelWaiters, Pipe, type Endpoint, type ReadWaiter } from './pipe'

/** The settings programs actually change. All on by default, like a shell session. */
export interface Termios {
  /** Echo typed characters back to the terminal. */
  echo: boolean
  /** Line mode: input is edited and delivered a line at a time. Off = raw bytes as they arrive. */
  icanon: boolean
  /** ^C and ^Z raise SIGINT and SIGTSTP in the foreground process group. */
  isig: boolean
  /** Output `\n` becomes `\r\n`. */
  onlcr: boolean
  /** Input `\r` (the Enter key) becomes `\n`. */
  icrnl: boolean
}

export interface WinSize {
  rows: number
  cols: number
}

const TERMIOS_KEYS: Array<keyof Termios> = ['echo', 'icanon', 'isig', 'onlcr', 'icrnl']

const INTR = 3 // ^C
const EOF = 4 // ^D
const ERASE = 127
const BACKSPACE = 8
const WERASE = 23 // ^W
const KILL = 21 // ^U
const SUSP = 26 // ^Z

const encoder = new TextEncoder()
const isContinuation = (b: number) => (b & 0xc0) === 0x80

export class Pty {
  termios: Termios = { echo: true, icanon: true, isig: true, onlcr: true, icrnl: true }
  winsize: WinSize = { rows: 24, cols: 80 }
  /** Session that owns this terminal as its controlling terminal, and its foreground process group. */
  sid: number | null = null
  fg: number | null = null

  private masters = 1
  private slaves = 1
  /** Slave output on its way to the master (also carries echo). */
  private out = new Pipe()
  /** The line being edited in line mode. */
  private line: number[] = []
  /** Input the slave can read. An empty entry is an end-of-file mark (^D on an empty line), delivered once. */
  private ready: Uint8Array[] = []
  private waiters: ReadWaiter[] = []
  private hungUp = false
  private echoOwner: Endpoint = { kind: 'null' }

  constructor(private signal: (pgid: number, sig: string) => void) {
    this.out.readers = 1
    this.out.writers = 1
  }

  // ------------------------------------------------------------ descriptors

  open(side: 'master' | 'slave'): void {
    if (side === 'master') {
      this.masters++
      this.out.readers++
    } else {
      this.slaves++
      this.out.writers++
    }
  }

  close(ep: Endpoint, side: 'master' | 'slave'): void {
    if (side === 'master') {
      this.masters--
      this.out.closeEnd(ep, 'r')
      if (this.masters === 0) this.hangUp()
    } else {
      this.slaves--
      this.out.closeEnd(ep, 'w')
      cancelWaiters(this.waiters, ep)
    }
  }

  /** The terminal went away: readers see end of input, and the foreground group gets SIGHUP. */
  private hangUp(): void {
    this.hungUp = true
    this.line = []
    this.settle()
    if (this.fg !== null) this.signal(this.fg, 'SIGHUP')
  }

  // ---------------------------------------------------------------- master

  /** What the programs wrote (and the echo), for the terminal emulator to draw. Empty = all slaves closed. */
  masterRead(ep: Endpoint, max: number): Promise<Uint8Array> {
    return this.out.read(ep, max)
  }

  /** Keystrokes from the terminal emulator, run through the line discipline. */
  masterWrite(data: Uint8Array): void {
    for (const raw of data) this.input(raw)
    this.settle()
  }

  private input(raw: number): void {
    const t = this.termios
    let b = raw
    if (t.icrnl && b === 13) b = 10

    if (t.isig && (b === INTR || b === SUSP)) {
      this.line = []
      this.ready = [] // pending input is thrown away, as on a real terminal
      if (t.echo) this.echo(b === INTR ? '^C' : '^Z')
      if (this.fg !== null) this.signal(this.fg, b === INTR ? 'SIGINT' : 'SIGTSTP')
      return
    }

    if (!t.icanon) {
      this.ready.push(Uint8Array.of(b))
      if (t.echo) this.echoByte(b)
      return
    }

    switch (b) {
      case EOF:
        // On an empty line this is end of file; otherwise it hands over what has been typed, without a newline.
        this.ready.push(Uint8Array.from(this.line))
        this.line = []
        return
      case ERASE:
      case BACKSPACE:
        this.eraseChar()
        return
      case KILL:
        while (this.line.length) this.eraseChar()
        return
      case WERASE:
        while (this.line.length && this.line[this.line.length - 1] === 32) this.eraseChar()
        while (this.line.length && this.line[this.line.length - 1] !== 32) this.eraseChar()
        return
    }
    this.line.push(b)
    if (t.echo) this.echoByte(b)
    if (b === 10) {
      this.ready.push(Uint8Array.from(this.line))
      this.line = []
    }
  }

  private eraseChar(): void {
    if (!this.line.length) return
    while (this.line.length && isContinuation(this.line[this.line.length - 1]!)) this.line.pop()
    this.line.pop()
    if (this.termios.echo) this.echo('\b \b')
  }

  private echoByte(b: number): void {
    if (b === 10) this.echo(this.termios.onlcr ? '\r\n' : '\n')
    else if (b < 32 && b !== 9) this.echo('^' + String.fromCharCode(b + 64))
    else if (b === 127) this.echo('^?')
    else this.out.write(this.echoOwner, Uint8Array.of(b)).catch(() => {})
  }

  private echo(text: string): void {
    this.out.write(this.echoOwner, encoder.encode(text)).catch(() => {}) // nobody reading: nothing to draw
  }

  // ----------------------------------------------------------------- slave

  /** Line mode: one line (or what is left of it) per read. Raw mode: whatever has arrived. Empty = end of file. */
  slaveRead(ep: Endpoint, max: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ owner: ep, max, resolve, reject })
      this.settle()
    })
  }

  slaveWrite(ep: Endpoint, data: Uint8Array): Promise<void> {
    if (!this.termios.onlcr) return this.out.write(ep, data)
    const bytes: number[] = []
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 10 && data[i - 1] !== 13) bytes.push(13)
      bytes.push(data[i]!)
    }
    return this.out.write(ep, Uint8Array.from(bytes))
  }

  private settle(): void {
    while (this.waiters.length) {
      if (!this.ready.length) {
        if (this.hungUp) for (const w of this.waiters.splice(0)) w.resolve(new Uint8Array(0))
        return
      }
      const w = this.waiters.shift()!
      const head = this.ready[0]!
      if (head.length === 0) {
        this.ready.shift()
        w.resolve(new Uint8Array(0))
      } else if (this.termios.icanon) {
        const n = Math.min(w.max, head.length)
        w.resolve(head.slice(0, n))
        if (n === head.length) this.ready.shift()
        else this.ready[0] = head.subarray(n)
      } else {
        const parts: number[] = []
        while (this.ready.length && this.ready[0]!.length && parts.length < w.max) {
          const chunk = this.ready[0]!
          const n = Math.min(w.max - parts.length, chunk.length)
          for (let i = 0; i < n; i++) parts.push(chunk[i]!)
          if (n === chunk.length) this.ready.shift()
          else this.ready[0] = chunk.subarray(n)
        }
        w.resolve(Uint8Array.from(parts))
      }
    }
  }

  // ------------------------------------------------------------- settings

  setTermios(change: Partial<Termios>): void {
    if (typeof change !== 'object' || change === null) throw new SysError('EINVAL', 'termios settings expected')
    for (const [k, v] of Object.entries(change)) {
      if (!TERMIOS_KEYS.includes(k as keyof Termios) || typeof v !== 'boolean') throw new SysError('EINVAL', `bad terminal setting ${k}`)
    }
    const wasCanon = this.termios.icanon
    Object.assign(this.termios, change)
    if (wasCanon && !this.termios.icanon && this.line.length) {
      // Leaving line mode: what was half typed is now plain input.
      for (const b of this.line) this.ready.push(Uint8Array.of(b))
      this.line = []
    }
    this.settle()
  }

  setWinSize(size: WinSize): void {
    const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 65535
    if (!size || !ok(size.rows) || !ok(size.cols)) throw new SysError('EINVAL', 'rows and cols must be positive integers')
    const changed = size.rows !== this.winsize.rows || size.cols !== this.winsize.cols
    this.winsize = { rows: size.rows, cols: size.cols }
    if (changed && this.fg !== null) this.signal(this.fg, 'SIGWINCH')
  }
}
