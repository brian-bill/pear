/** Layout questions a textarea cannot answer: how tall is each wrapped line, where on screen is an offset. */
export class Mirror {
  private el = document.createElement('div')
  constructor(private ta: HTMLTextAreaElement) {
    this.el.className = 'mirror'
    ta.parentElement!.append(this.el)
  }

  private sync(): void {
    const cs = getComputedStyle(this.ta)
    const e = this.el
    e.style.font = cs.font
    e.style.padding = '0'
    e.style.letterSpacing = cs.letterSpacing
    e.style.tabSize = cs.tabSize
    e.style.whiteSpace = cs.whiteSpace
    e.style.overflowWrap = cs.overflowWrap
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    e.style.width = `${this.ta.clientWidth - pad}px`
  }

  get lineHeight(): number {
    return parseFloat(getComputedStyle(this.ta).lineHeight) || 18
  }

  /** How many screen rows each line takes. */
  rows(lines: string[]): number[] {
    this.sync()
    const lh = this.lineHeight
    const frag = document.createDocumentFragment()
    for (const l of lines) frag.append(Object.assign(document.createElement('div'), { textContent: l || '​' }))
    this.el.style.height = 'auto'
    this.el.replaceChildren(frag)
    const out = Array.from(this.el.children, (c) => Math.max(1, Math.round((c as HTMLElement).offsetHeight / lh)))
    this.el.replaceChildren()
    this.el.style.height = '0'
    return out
  }

  /** Distance from the top of the text to the top of the row holding `pos`. */
  top(pos: number): number {
    this.sync()
    const marker = document.createElement('span')
    marker.textContent = '​'
    this.el.style.height = 'auto'
    this.el.replaceChildren(this.ta.value.slice(0, pos), marker)
    const y = marker.offsetTop
    this.el.replaceChildren()
    this.el.style.height = '0'
    return y
  }
}
