import { el } from './util'

/** A list of fixed-height rows that only builds the ones in view. */
export class VList<T> {
  readonly el = el('div', 'vlist')
  private inner = el('div', 'vlist-inner')
  private items: T[] = []
  private frame = 0
  /** Called when the user scrolls; `atBottom` says whether the end is in view. */
  onUserScroll: (atBottom: boolean) => void = () => {}
  onPick: (index: number, ev: MouseEvent) => void = () => {}

  constructor(
    private rowHeight: number,
    private row: (item: T, index: number) => string,
    private rowClass: (item: T) => string = () => "",
  ) {
    this.el.tabIndex = 0
    this.el.append(this.inner)
    this.el.addEventListener('scroll', () => {
      this.schedule()
      this.onUserScroll(this.atBottom())
    })
    this.inner.addEventListener('click', (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')
      if (r) this.onPick(Number(r.dataset.i), e)
    })
    new ResizeObserver(() => this.schedule()).observe(this.el)
  }

  atBottom = () => this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < this.rowHeight

  set(items: T[]): void {
    this.items = items
    this.inner.style.height = `${items.length * this.rowHeight}px`
    this.schedule()
  }

  scrollToBottom(): void {
    this.el.scrollTop = this.el.scrollHeight
    this.schedule()
  }

  reveal(i: number): void {
    const top = i * this.rowHeight
    if (top < this.el.scrollTop) this.el.scrollTop = top
    else if (top + this.rowHeight > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = top + this.rowHeight - this.el.clientHeight
    this.schedule()
  }

  schedule(): void {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  private draw(): void {
    const first = Math.max(0, Math.floor(this.el.scrollTop / this.rowHeight) - 3)
    const last = Math.min(this.items.length, Math.ceil((this.el.scrollTop + this.el.clientHeight) / this.rowHeight) + 3)
    let out = ''
    for (let i = first; i < last; i++) out += `<div class="vrow ${this.rowClass(this.items[i]!)}" data-i="${i}" style="top:${i * this.rowHeight}px;height:${this.rowHeight}px">${this.row(this.items[i]!, i)}</div>`
    this.inner.innerHTML = out
  }
}
