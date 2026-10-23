/**
 * A small terminal screen: lines of text and a cursor, enough for the Vanilla shell and its utilities (carriage
 * return, backspace, erase-in-line, clear; colours are ignored). Replace with a full emulator when apps need one.
 */
export class Screen {
  lines: string[] = ['']
  row = 0
  col = 0
  private esc: string | null = null
  constructor(public maxLines = 2000) {}

  write(text: string): void {
    for (const ch of text) {
      if (this.esc !== null) {
        this.esc += ch
        // CSI: ESC [ params final-byte (0x40-0x7e); anything else ends after one char
        if (this.esc.length === 1 && ch !== '[') this.esc = null
        else if (this.esc.length > 1 && /[@-~]/.test(ch)) this.csi(this.esc.slice(1, -1), ch)
        continue
      }
      switch (ch) {
        case '\x1b': this.esc = ''; break
        case '\n': this.newline(); break
        case '\r': this.col = 0; break
        case '\b': this.col = Math.max(0, this.col - 1); break
        case '\t': this.put(' '.repeat(8 - (this.col % 8))); break
        case '\x07': break
        default: if (ch >= ' ') this.put(ch)
      }
    }
  }

  private csi(params: string, final: string): void {
    this.esc = null
    const n = Number(params.split(';')[0]) || 0
    const line = this.lines[this.row]!
    if (final === 'K') {
      if (n === 0) this.lines[this.row] = line.slice(0, this.col)
      else if (n === 2) this.lines[this.row] = ''
      else if (n === 1) this.lines[this.row] = ' '.repeat(this.col) + line.slice(this.col)
    } else if (final === 'J' && (n === 2 || n === 3)) {
      this.lines = ['']
      this.row = 0
      this.col = 0
    } else if (final === 'C') this.col += n || 1
    else if (final === 'D') this.col = Math.max(0, this.col - (n || 1))
    else if (final === 'H') {
      this.row = Math.min(this.lines.length - 1, Math.max(0, (n || 1) - 1))
      this.col = 0
    }
  }

  private put(s: string): void {
    let line = this.lines[this.row]!
    if (line.length < this.col) line += ' '.repeat(this.col - line.length)
    this.lines[this.row] = line.slice(0, this.col) + s + line.slice(this.col + s.length)
    this.col += s.length
  }

  private newline(): void {
    this.row++
    if (this.row >= this.lines.length) this.lines.push('')
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines)
      this.row = this.lines.length - 1
    }
  }
}
