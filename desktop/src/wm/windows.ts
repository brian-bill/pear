/// Window manager: DOM windows with move, resize, focus, stacking, minimize, maximize and close.
/// Windows are real elements (native text, IME and accessibility); effects stay in CSS.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowOptions extends Partial<Rect> {
  /** Which app owns the window (its bundle id). */
  appId: string
  title: string
  minWidth?: number
  minHeight?: number
  resizable?: boolean
  /** Fill the window body. May return a function that runs when the window closes. */
  content: (body: HTMLElement, win: Win) => void | (() => void)
}

export type WmEvent =
  | { type: 'created' | 'closed' | 'focused' | 'minimized' | 'restored' | 'maximized' | 'unmaximized' | 'moved' | 'resized' | 'titled'; win: Win }
  | { type: 'blur' }

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const DIRS: Dir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const MIN_VISIBLE = 60

export class Win {
  readonly el: HTMLElement
  readonly body: HTMLElement
  rect: Rect
  restoreRect: Rect | null = null
  minimized = false
  maximized = false
  private titleEl: HTMLElement
  private cleanup: void | (() => void) = undefined
  private closing = false
  /** Asked before the window closes by the user: resolve `false` to keep it open. */
  closeGuard: (() => Promise<boolean>) | null = null
  /** Runs when the window gains focus (move the keyboard focus into its content). */
  focusHook: (() => void) | null = null
  private editedFlag = false

  constructor(
    readonly id: number,
    readonly appId: string,
    private opts: WindowOptions,
    rect: Rect,
    private wm: WindowManager,
  ) {
    this.rect = rect
    this.el = document.createElement('div')
    this.el.className = 'window'
    this.el.dataset.window = String(id)
    this.el.dataset.app = appId
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', opts.title)
    this.el.innerHTML = `
      <div class="titlebar">
        <div class="lights">
          <button class="light close" aria-label="Close" data-action="close"></button>
          <button class="light min" aria-label="Minimize" data-action="minimize"></button>
          <button class="light max" aria-label="Zoom" data-action="maximize"></button>
        </div>
        <div class="name"></div>
      </div>
      <div class="body"></div>`
    this.titleEl = this.el.querySelector('.name')!
    this.body = this.el.querySelector('.body')!
    this.titleEl.textContent = opts.title
    if (opts.resizable === false) {
      this.el.querySelector<HTMLButtonElement>('.max')!.disabled = true
    } else {
      for (const d of DIRS) {
        const h = document.createElement('div')
        h.className = `handle ${d}`
        h.dataset.dir = d
        this.el.append(h)
      }
    }
    this.apply()
  }

  get title(): string {
    return this.opts.title
  }
  set title(t: string) {
    this.opts.title = t
    this.titleEl.textContent = t
    this.el.setAttribute('aria-label', t)
    this.wm.emit({ type: 'titled', win: this })
  }
  get edited(): boolean {
    return this.editedFlag
  }
  set edited(v: boolean) {
    this.editedFlag = v
    this.el.classList.toggle('edited', v)
  }
  get resizable(): boolean {
    return this.opts.resizable !== false
  }
  get minSize(): { width: number; height: number } {
    return { width: this.opts.minWidth ?? 220, height: this.opts.minHeight ?? 120 }
  }

  /** Run the app's content builder. */
  mount(): void {
    this.cleanup = this.opts.content(this.body, this)
  }

  apply(): void {
    const s = this.el.style
    s.left = `${this.rect.x}px`
    s.top = `${this.rect.y}px`
    s.width = `${this.rect.width}px`
    s.height = `${this.rect.height}px`
  }

  focus(): void {
    this.wm.focus(this)
  }
  /** Close as the user would: the content may refuse. */
  close(): void {
    void this.wm.requestClose(this)
  }
  minimize(): void {
    this.wm.minimize(this)
  }
  toggleMaximize(): void {
    this.wm.toggleMaximize(this)
  }

  /** @internal */
  destroy(): void {
    if (this.closing) return
    this.closing = true
    try {
      if (typeof this.cleanup === 'function') this.cleanup()
    } finally {
      this.el.remove()
    }
  }
}

export class WindowManager {
  readonly wins: Win[] = [] // back to front
  private nextId = 1
  private listeners = new Set<(e: WmEvent) => void>()
  private cascade = 0
  /** Where a window flies when minimized: the dock tells us (screen coordinates). */
  minimizeTarget: (win: Win) => { x: number; y: number } | null = () => null

  constructor(readonly root: HTMLElement) {
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) this.blur()
    })
    root.addEventListener('keydown', (e) => this.onKey(e))
    window.addEventListener('resize', () => {
      for (const w of this.wins) {
        if (w.maximized) w.rect = this.workArea()
        else w.rect = this.clamp(w.rect)
        w.apply()
      }
    })
  }

  on(fn: (e: WmEvent) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  emit(e: WmEvent): void {
    for (const l of this.listeners) l(e)
  }

  /** The area windows may use (below the menu bar). */
  workArea(): Rect {
    return { x: 0, y: 0, width: this.root.clientWidth, height: this.root.clientHeight }
  }

  get focused(): Win | null {
    for (let i = this.wins.length - 1; i >= 0; i--) {
      const w = this.wins[i]!
      if (!w.minimized) return w.el.classList.contains('focused') ? w : null
    }
    return null
  }

  create(opts: WindowOptions): Win {
    const area = this.workArea()
    const width = Math.min(opts.width ?? 640, area.width)
    const height = Math.min(opts.height ?? 420, area.height)
    const step = 28 * (this.cascade++ % 8)
    const rect = this.clamp({
      x: opts.x ?? Math.round((area.width - width) / 2) - 60 + step,
      y: opts.y ?? Math.round((area.height - height) / 3) + step,
      width,
      height,
    })
    const win = new Win(this.nextId++, opts.appId, opts, rect, this)
    this.wins.push(win)
    this.root.append(win.el)
    this.wire(win)
    win.mount()
    this.focus(win)
    this.emit({ type: 'created', win })
    return win
  }

  windowsOf(appId: string): Win[] {
    return this.wins.filter((w) => w.appId === appId)
  }

  /** `deferContent`: the focus came from a pointer press, so wait for it to end before moving the keyboard focus into the content. */
  focus(win: Win, deferContent = false): void {
    if (win.minimized) return this.restore(win)
    const wasFocused = win.el.classList.contains('focused')
    this.wins.splice(this.wins.indexOf(win), 1)
    this.wins.push(win)
    this.wins.forEach((w, i) => {
      w.el.style.zIndex = String(i + 1)
      w.el.classList.toggle('focused', w === win)
    })
    if (!wasFocused) {
      win.el.focus({ preventScroll: true })
      if (!deferContent) win.focusHook?.()
      // moving focus into an iframe in the middle of a click would swallow the click
      else addEventListener('pointerup', () => setTimeout(() => !win.minimized && win.el.classList.contains('focused') && win.focusHook?.(), 0), { once: true, capture: true })
    }
    this.emit({ type: 'focused', win })
  }

  blur(): void {
    for (const w of this.wins) w.el.classList.remove('focused')
    this.emit({ type: 'blur' })
  }

  /** Close because the user asked to: the window's guard may keep it open. */
  async requestClose(win: Win): Promise<boolean> {
    if (win.closeGuard && !(await win.closeGuard().catch(() => true))) return false
    this.close(win)
    return true
  }

  close(win: Win): void {
    const i = this.wins.indexOf(win)
    if (i < 0) return
    const wasFocused = win.el.classList.contains('focused')
    this.wins.splice(i, 1)
    win.destroy()
    this.emit({ type: 'closed', win })
    if (wasFocused) this.focusTop()
  }

  private focusTop(): void {
    for (let i = this.wins.length - 1; i >= 0; i--) {
      if (!this.wins[i]!.minimized) return this.focus(this.wins[i]!)
    }
    this.emit({ type: 'blur' })
  }

  minimize(win: Win): void {
    if (win.minimized) return
    win.minimized = true
    const target = this.minimizeTarget(win)
    const finish = () => {
      win.el.hidden = true
      win.el.style.transform = ''
      win.el.style.opacity = ''
    }
    if (target && !reduced()) {
      const r = win.el.getBoundingClientRect()
      const dx = target.x - (r.left + r.width / 2)
      const dy = target.y - (r.top + r.height / 2)
      const a = win.el.animate(
        [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.08)`, opacity: 0.2 }],
        { duration: 260, easing: 'ease-in' },
      )
      a.onfinish = finish
    } else finish()
    win.el.classList.remove('focused')
    this.emit({ type: 'minimized', win })
    this.focusTop()
  }

  restore(win: Win): void {
    if (!win.minimized) return win.focus()
    win.minimized = false
    win.el.hidden = false
    if (!reduced()) {
      const target = this.minimizeTarget(win)
      if (target) {
        const r = win.el.getBoundingClientRect()
        const dx = target.x - (r.left + r.width / 2)
        const dy = target.y - (r.top + r.height / 2)
        win.el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(0.08)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: 'ease-out' })
      }
    }
    this.emit({ type: 'restored', win })
    this.focus(win)
  }

  toggleMaximize(win: Win): void {
    if (!win.resizable) return
    win.el.classList.add('animating')
    if (win.maximized) {
      win.maximized = false
      win.rect = this.clamp(win.restoreRect ?? win.rect)
      win.restoreRect = null
      win.el.classList.remove('maximized')
      this.emit({ type: 'unmaximized', win })
    } else {
      win.restoreRect = { ...win.rect }
      win.maximized = true
      win.rect = this.workArea()
      win.el.classList.add('maximized')
      this.emit({ type: 'maximized', win })
    }
    win.apply()
    setTimeout(() => win.el.classList.remove('animating'), 250)
    this.focus(win)
  }

  /** Keep at least part of the title bar reachable. */
  clamp(r: Rect): Rect {
    const a = this.workArea()
    const width = Math.max(1, Math.min(r.width, a.width))
    const height = Math.max(1, Math.min(r.height, a.height))
    const x = Math.min(Math.max(r.x, MIN_VISIBLE - width), a.width - MIN_VISIBLE)
    const y = Math.min(Math.max(r.y, 0), a.height - 28)
    return { x, y, width, height }
  }

  // ---- pointer handling

  private wire(win: Win): void {
    const { el } = win
    el.tabIndex = -1
    el.addEventListener('pointerdown', () => {
      if (!el.classList.contains('focused')) this.focus(win, true)
    }, true)
    el.querySelector('.lights')!.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
      if (action === 'close') win.close()
      else if (action === 'minimize') win.minimize()
      else if (action === 'maximize') win.toggleMaximize()
    })
    const bar = el.querySelector<HTMLElement>('.titlebar')!
    bar.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.lights')) return
      win.toggleMaximize()
    })
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.lights')) return
      this.drag(win, e, bar)
    })
    el.addEventListener('pointerdown', (e) => {
      const dir = (e.target as HTMLElement).dataset.dir as Dir | undefined
      if (dir && e.button === 0) this.resize(win, e, dir)
    })
  }

  private drag(win: Win, start: PointerEvent, bar: HTMLElement): void {
    const origin = { ...win.rect }
    // dragging a maximized window pulls it back to its old size under the pointer
    let moved = false
    bar.setPointerCapture(start.pointerId)
    // from the first moment: an iframe under the pointer would otherwise take the moves away from us
    win.el.classList.add('dragging')
    this.root.classList.add('interacting')
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.clientX
      const dy = e.clientY - start.clientY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return
      if (!moved) {
        moved = true
        if (win.maximized) {
          const old = win.restoreRect!
          win.maximized = false
          win.el.classList.remove('maximized')
          origin.width = old.width
          origin.height = old.height
          origin.x = start.clientX - old.width * (start.clientX / this.workArea().width)
          origin.y = 0
          win.restoreRect = null
          win.rect = { ...origin }
          this.emit({ type: 'unmaximized', win })
        }
      }
      win.rect = this.clamp({ ...origin, x: origin.x + dx, y: origin.y + dy })
      win.apply()
    }
    const up = () => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      bar.removeEventListener('pointercancel', up)
      win.el.classList.remove('dragging')
      this.root.classList.remove('interacting')
      if (moved) this.emit({ type: 'moved', win })
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
    bar.addEventListener('pointercancel', up)
  }

  private resize(win: Win, start: PointerEvent, dir: Dir): void {
    const handle = start.target as HTMLElement
    const origin = { ...win.rect }
    const { width: minW, height: minH } = win.minSize
    const area = this.workArea()
    handle.setPointerCapture(start.pointerId)
    win.el.classList.add('resizing')
    this.root.classList.add('interacting')
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.clientX
      const dy = e.clientY - start.clientY
      let { x, y, width, height } = origin
      if (dir.includes('e')) width = Math.max(minW, origin.width + dx)
      if (dir.includes('s')) height = Math.max(minH, origin.height + dy)
      if (dir.includes('w')) {
        width = Math.max(minW, origin.width - dx)
        x = origin.x + origin.width - width
      }
      if (dir.includes('n')) {
        height = Math.max(minH, origin.height - dy)
        y = origin.y + origin.height - height
      }
      y = Math.max(0, y)
      if (y + height > area.height) height = area.height - y
      win.rect = { x, y, width, height }
      win.apply()
      this.emit({ type: 'resized', win })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      win.el.classList.remove('resizing')
      this.root.classList.remove('interacting')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  // ---- keyboard

  private onKey(e: KeyboardEvent): void {
    if (this.shortcut(e)) e.preventDefault()
  }

  /**
   * Window shortcuts: Cmd+W, Cmd+M, Cmd+\` and Alt+Tab. Cmd is Meta; Ctrl stays with the app (in a terminal Ctrl+W and
   * Ctrl+M mean something else). Also fed by windows whose content is an iframe, which swallows key events.
   */
  shortcut(e: { key: string; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
    const cmd = e.metaKey
    const win = this.focused
    if (!win) return false
    if (cmd && e.key.toLowerCase() === 'w') win.close()
    else if (cmd && e.key.toLowerCase() === 'm') win.minimize()
    else if ((e.altKey && e.key === 'Tab') || (cmd && e.key === '`')) this.cycle(e.shiftKey ? -1 : 1)
    else return false
    return true
  }

  /** Bring the next (or previous) window forward. */
  cycle(step: 1 | -1 = 1): void {
    const open = this.wins.filter((w) => !w.minimized)
    if (open.length < 2) return
    this.focus(step === 1 ? open[0]! : open[open.length - 2]!)
  }
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.reduceMotion === 'true'
