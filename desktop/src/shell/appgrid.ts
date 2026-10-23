/// The app grid (Launchpad-style): every installed app as an icon, with a filter field. Opened from the dock.
import { ICONS } from '../apps/icons'
import type { AppRegistry } from '../apps/registry'

export class AppGrid {
  private el: HTMLElement | null = null

  constructor(
    private registry: AppRegistry,
    private launch: (appId: string) => void,
  ) {
    addEventListener('keydown', (e) => e.key === 'Escape' && this.el && this.hide(), true)
  }

  get visible(): boolean {
    return this.el !== null
  }

  toggle(): void {
    if (this.el) this.hide()
    else this.show()
  }

  hide(): void {
    this.el?.dispatchEvent(new Event('remove-grid'))
    this.el?.remove()
    this.el = null
  }

  show(): void {
    this.hide()
    const back = Object.assign(document.createElement('div'), { className: 'appgrid-back' })
    back.innerHTML = '<div class="appgrid" role="dialog" aria-label="Apps"><input type="text" class="appgrid-search" placeholder="Search" aria-label="Filter apps" autocomplete="off" spellcheck="false"><div class="appgrid-items" role="list"></div><div class="appgrid-empty" hidden>No apps match</div></div>'
    const input = back.querySelector('input')!
    const items = back.querySelector<HTMLElement>('.appgrid-items')!
    const empty = back.querySelector<HTMLElement>('.appgrid-empty')!
    const apps = this.registry.list()

    const tiles = apps.map((app) => {
      const b = document.createElement('button')
      b.className = 'appgrid-app'
      b.dataset.app = app.id
      b.setAttribute('role', 'listitem')
      const url = this.registry.iconUrl(app.id)
      b.innerHTML = `${url ? '<img alt="" draggable="false">' : ICONS.window!}<span></span>`
      const img = b.querySelector('img')
      if (img) {
        img.src = url!
        img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('div'), { innerHTML: ICONS.window!, className: 'appgrid-fallback' })))
      }
      b.querySelector('span')!.textContent = app.name
      b.addEventListener('click', () => (this.hide(), this.launch(app.id)))
      return { app, b }
    })
    items.append(...tiles.map((t) => t.b))

    const visible = () => tiles.filter((t) => !t.b.hidden)
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase()
      for (const t of tiles) t.b.hidden = !!q && !t.app.name.toLowerCase().includes(q)
      empty.hidden = visible().length > 0
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = visible()[0]
        if (first) (this.hide(), this.launch(first.app.id))
      }
    })
    // a click on the empty space around the grid dismisses it
    back.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement
      if (t === back || t.classList.contains('appgrid') || t === items) this.hide()
    })
    // icons are re-read when the registry reloads them (a reloaded icon gets a new URL)
    const off = this.registry.onChange(() => {
      for (const { app, b } of tiles) {
        const img = b.querySelector('img'), url = this.registry.iconUrl(app.id)
        if (img && url) img.src = url
      }
    })
    back.addEventListener('remove-grid', off, { once: true })
    document.body.append(back)
    this.el = back
    input.focus()
  }
}
