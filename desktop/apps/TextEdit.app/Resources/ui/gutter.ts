import { lineCount } from './text'
import type { Mirror } from './measure'

/** The line number column. With word wrap, a numbered line that wraps leaves blank rows under its number. */
export class Gutter {
  visible = false
  private frame = 0
  private shown = ''
  constructor(private el: HTMLElement, private ta: HTMLTextAreaElement, private mirror: Mirror, private wrap: () => boolean) {
    ta.addEventListener('scroll', () => this.scroll())
    new ResizeObserver(() => this.update(true)).observe(ta)
  }

  show(on: boolean): void {
    this.visible = on
    this.el.hidden = !on
    this.update(true)
  }

  private scroll(): void {
    this.el.scrollTop = this.ta.scrollTop
  }

  /** Rebuild soon (once per frame). */
  update(force = false): void {
    if (!this.visible) return
    if (force) this.shown = ''
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0
      this.render()
    })
  }

  private render(): void {
    const text = this.ta.value
    const n = lineCount(text)
    let out: string
    if (this.wrap() && n <= 20000) {
      const rows = this.mirror.rows(text.split('\n'))
      out = rows.map((r, i) => `${i + 1}${'\n'.repeat(r)}`).join('').replace(/\n$/, '')
    } else {
      out = Array.from({ length: n }, (_, i) => i + 1).join('\n')
    }
    if (out !== this.shown) {
      this.shown = out
      this.el.textContent = out
      this.el.style.minWidth = `${String(n).length + 2}ch`
    }
    this.scroll()
  }
}
