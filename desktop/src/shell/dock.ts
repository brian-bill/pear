/// The dock: pinned and running apps, minimized windows, the Trash. Size, position, auto-hide and magnification come
/// from the `tiny.desktop.dock` settings.
import { ICONS } from '../apps/icons'
import type { AppRegistry } from '../apps/registry'
import type { Win, WindowManager } from '../wm/windows'
import type { MenuItem } from './menubar'
import { showPopup } from './popup'

export interface DockSettings {
  items: string[]
  size: number
  position: 'bottom' | 'left' | 'right'
  autohide: boolean
  magnification: boolean
}

export interface DockActions {
  launch(appId: string): void
  quit(appId: string): void
  newWindow(appId: string): void
  reveal(appId: string): void
  openTrash(): void
  /** Show the grid of all installed apps. */
  openApps(): void
  /** Persist a new list of pinned apps. */
  pin(items: string[]): void
  trashEmpty(): boolean
}

const svgImg = (svg: string) => svg

export class Dock {
  readonly el: HTMLElement
  private dock: HTMLElement
  settings: DockSettings = { items: [], size: 48, position: 'bottom', autohide: false, magnification: true }
  private hidden = false
  private trashFull = false

  constructor(
    private wm: WindowManager,
    private registry: AppRegistry,
    private actions: DockActions,
    private running: () => Set<string>,
  ) {
    this.el = document.createElement('div')
    this.el.className = 'dock-wrap'
    this.dock = Object.assign(document.createElement('div'), { className: 'dock' })
    this.dock.setAttribute('role', 'toolbar')
    this.dock.setAttribute('aria-label', 'Dock')
    this.el.append(this.dock)
    wm.on(() => this.render())
    registry.onChange(() => this.render())
    wm.minimizeTarget = (win) => {
      const mini = this.dock.querySelector<HTMLElement>(`[data-window="${win.id}"]`) ?? this.dock.querySelector<HTMLElement>(`[data-app="${win.appId}"]`)
      if (!mini) return null
      const r = mini.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    // magnification: icons near the pointer grow
    this.dock.addEventListener('pointermove', (e) => this.magnify(e))
    this.dock.addEventListener('pointerleave', () => this.magnify(null))
    // auto-hide: reveal when the pointer reaches the screen edge
    document.addEventListener('pointermove', (e) => {
      if (!this.settings.autohide) return
      const s = this.settings.position
      const edge = s === 'bottom' ? innerHeight - e.clientY : s === 'left' ? e.clientX : innerWidth - e.clientX
      const over = this.dock.matches(':hover')
      this.setHidden(edge > 4 && !over && edge > this.settings.size + 24)
    })
    this.render()
  }

  configure(s: Partial<DockSettings>): void {
    Object.assign(this.settings, s)
    const root = document.documentElement
    root.style.setProperty('--dock-size', `${this.settings.size}px`)
    this.el.dataset.position = this.settings.position
    this.el.dataset.autohide = String(this.settings.autohide)
    this.setHidden(this.settings.autohide)
    this.render()
  }

  private setHidden(h: boolean): void {
    this.hidden = h
    this.el.classList.toggle('hidden', h)
  }

  /** Magnification grows only the icon under the pointer; the others stay put. */
  private magnify(e: PointerEvent | null): void {
    const over = e && this.settings.magnification ? (e.target as HTMLElement | null)?.closest<HTMLElement>('.item') : null
    for (const i of this.dock.querySelectorAll<HTMLElement>('.item')) {
      if (i === over) i.style.setProperty('--scale', '1.45')
      else i.style.removeProperty('--scale')
    }
  }

  setTrashFull(full: boolean): void {
    this.trashFull = full
    this.render()
  }

  render(): void {
    const items: HTMLElement[] = []
    const shown = new Set<string>()
    const running = this.running()
    const add = (id: string) => {
      const app = this.registry.get(id)
      if (!app || app.kind !== 'app' || shown.has(id)) return
      shown.add(id)
      items.push(this.item({ label: app.name, icon: this.registry.iconUrl(id), fallback: ICONS.window!, app: id, running: running.has(id), onClick: () => this.actions.launch(id), onMenu: (e) => this.appMenu(id, e) }))
    }
    for (const id of this.settings.items) add(id)
    // running apps that are not pinned stay in the dock until they quit
    for (const id of running) add(id)
    // the app grid sits right after Finder (or first, when Finder is not in the dock)
    const grid = this.item({ label: 'Apps', icon: null, fallback: ICONS.apps!, app: 'launchpad', onClick: () => this.actions.openApps() })
    const at = items.findIndex((i) => i.dataset.app === 'org.tiny.finder')
    items.splice(at + 1, 0, grid)

    const tail: HTMLElement[] = this.wm.wins
      .filter((w) => w.minimized)
      .map((w) => this.item({ label: w.title, icon: this.registry.iconUrl(w.appId), fallback: ICONS.window!, win: w.id, mini: true, onClick: () => this.wm.restore(w) }))
    tail.push(this.item({ label: 'Trash', icon: null, fallback: this.trashFull ? ICONS.trashFull ?? ICONS.trash! : ICONS.trash!, app: 'trash', onClick: () => this.actions.openTrash(), onMenu: (e) => {
      showPopup([{ label: 'Open', action: () => this.actions.openTrash() }, { label: 'Empty Trash', disabled: !this.trashFull, action: () => void this.actions.trashEmpty() }], { x: e.clientX, y: e.clientY - 60 })
    } }))
    const sep = Object.assign(document.createElement('div'), { className: 'sep' })
    this.dock.replaceChildren(...items, sep, ...tail)
    this.dock.dataset.position = this.settings.position
  }

  private appMenu(id: string, e: MouseEvent): void {
    const app = this.registry.get(id)!
    const isRunning = this.running().has(id)
    const pinned = this.settings.items.includes(id)
    const items: MenuItem[] = [
      { label: isRunning ? 'New Window' : 'Open', action: () => (isRunning ? this.actions.newWindow(id) : this.actions.launch(id)) },
      { label: 'Show in Finder', action: () => this.actions.reveal(id) },
      { separator: true },
      { label: 'Keep in Dock', checked: pinned, action: () => this.actions.pin(pinned ? this.settings.items.filter((x) => x !== id) : [...this.settings.items, id]) },
      ...(isRunning ? [{ separator: true } as MenuItem, { label: `Quit ${app.name}`, action: () => this.actions.quit(id) }] : []),
    ]
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showPopup(items, { x: r.left, y: this.settings.position === 'bottom' ? Math.max(30, r.top - 20 - items.length * 24) : r.top })
  }

  private item(o: { label: string; icon: string | null; fallback: string; app?: string; win?: number; running?: boolean; mini?: boolean; onClick: () => void; onMenu?: (e: MouseEvent) => void }): HTMLElement {
    const b = document.createElement('button')
    b.className = `item${o.running ? ' running' : ''}${o.mini ? ' mini' : ''}`
    if (o.app) b.dataset.app = o.app
    if (o.win !== undefined) b.dataset.window = String(o.win)
    b.setAttribute('aria-label', o.label)
    b.innerHTML = `${o.icon ? '<img alt="" draggable="false">' : svgImg(o.fallback)}<span class="dot"></span><span class="tip"></span>`
    if (o.icon) b.querySelector('img')!.src = o.icon
    b.querySelector('.tip')!.textContent = o.label
    b.addEventListener('click', o.onClick)
    if (o.onMenu) b.addEventListener('contextmenu', (e) => (e.preventDefault(), o.onMenu!(e)))
    return b
  }
}

export type { Win }
