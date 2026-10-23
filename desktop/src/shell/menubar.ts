/// The menu bar: Pear menu, the active app's menus, and status items on the right.

import { showPopup, type PopupHandle } from './popup'

export interface MenuItem {
  /** Shown with a check mark when set (true or false decides the mark). */
  checked?: boolean
  label?: string
  shortcut?: string
  action?: () => void
  disabled?: boolean
  separator?: boolean
}

export interface Menu {
  title: string
  /** Inline SVG shown in place of the title (the title stays as its accessible name). */
  icon?: string
  items: MenuItem[]
}

export class MenuBar {
  readonly el: HTMLElement
  private left: HTMLElement
  private right: HTMLElement
  private open: { menu: HTMLElement; button: HTMLElement; handle: PopupHandle } | null = null
  private appName = ''
  private appMenus: Menu[] = []
  private clockEl: HTMLElement
  private clockTimer: ReturnType<typeof setTimeout> | undefined
  private locale = 'en-US'
  private timeZone: string | undefined

  constructor(private system: () => Menu) {
    this.el = document.createElement('div')
    this.el.className = 'menubar'
    this.el.setAttribute('role', 'menubar')
    this.left = Object.assign(document.createElement('div'), { className: 'group' })
    this.right = Object.assign(document.createElement('div'), { className: 'group' })
    this.clockEl = Object.assign(document.createElement('div'), { className: 'status clock' })
    this.right.append(this.clockEl)
    this.el.append(this.left, this.right)
    this.render()
    this.tick()
  }

  /** The active app changed: show its name and menus (the first menu is the app's own). */
  setApp(name: string, menus: Menu[]): void {
    this.close()
    this.appName = name
    this.appMenus = menus
    this.render()
  }

  /** Add a status item at the right (before the clock). Returns its element. */
  addStatus(id: string, label: string, onClick?: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'title status'
    b.dataset.status = id
    b.textContent = label
    if (onClick) b.addEventListener('click', onClick)
    this.right.insertBefore(b, this.clockEl)
    return b
  }

  setLocale(locale: string, timeZone?: string): void {
    this.locale = locale
    this.timeZone = timeZone === 'auto' ? undefined : timeZone
    this.updateClock()
  }

  private render(): void {
    this.left.replaceChildren()
    const add = (menu: Menu, cls: string) => {
      const b = document.createElement('button')
      b.className = `title ${cls}`
      if (menu.icon) (b.innerHTML = menu.icon, b.setAttribute('aria-label', menu.title))
      else b.textContent = menu.title
      b.setAttribute('role', 'menuitem')
      b.setAttribute('aria-haspopup', 'menu')
      b.setAttribute('aria-expanded', 'false')
      b.addEventListener('click', () => (this.open?.button === b ? this.close() : this.show(b, menu)))
      // moving along the bar while a menu is open switches menus, like macOS
      b.addEventListener('pointerenter', () => this.open && this.open.button !== b && this.show(b, menu))
      this.left.append(b)
      return b
    }
    add(this.system(), 'system').dataset.menu = 'system'
    if (this.appName) add({ title: this.appName, items: this.appMenus[0]?.items ?? [] }, 'app')
    for (const m of this.appMenus.slice(1)) add(m, '')
  }

  private show(button: HTMLElement, menu: Menu): void {
    this.close()
    const r = button.getBoundingClientRect()
    const handle = showPopup(menu.items, { x: r.left, y: r.bottom + 2 }, () => {
      if (this.open?.button === button) {
        button.setAttribute('aria-expanded', 'false')
        this.open = null
      }
    })
    button.setAttribute('aria-expanded', 'true')
    this.open = { menu: handle.el, button, handle }
  }

  close(): void {
    this.open?.handle.close()
    this.open = null
  }

  private updateClock(): void {
    const now = new Date()
    this.clockEl.textContent = new Intl.DateTimeFormat(this.locale, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: this.timeZone,
    }).format(now)
  }

  private tick(): void {
    this.updateClock()
    // on the minute, so an idle desktop does no work in between
    this.clockTimer = setTimeout(() => this.tick(), 60_000 - (Date.now() % 60_000) + 50)
  }

  destroy(): void {
    clearTimeout(this.clockTimer)
  }
}
