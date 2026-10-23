/// Mission Control: every window at once. Windows are real DOM (and iframes), which cannot be shrunk into a live
/// thumbnail, so each is a card with the app icon and title; choosing one brings it forward.
import type { AppRegistry } from '../apps/registry'
import { ICONS } from '../apps/icons'
import type { Win, WindowManager } from '../wm/windows'

export class MissionControl {
  private el: HTMLElement | null = null

  constructor(
    private wm: WindowManager,
    private registry: AppRegistry,
  ) {
    addEventListener('keydown', (e) => {
      if ((e.ctrlKey && e.key === 'ArrowUp') || e.key === 'F3') {
        e.preventDefault()
        this.toggle()
      } else if (e.key === 'Escape' && this.el) this.hide()
    })
  }

  toggle(): void {
    if (this.el) this.hide()
    else this.show()
  }

  hide(): void {
    this.el?.remove()
    this.el = null
  }

  show(): void {
    this.hide()
    const el = Object.assign(document.createElement('div'), { className: 'mission' })
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', 'Mission Control')
    const grid = Object.assign(document.createElement('div'), { className: 'mission-grid' })
    const wins = [...this.wm.wins].reverse()
    if (!wins.length) grid.append(Object.assign(document.createElement('div'), { className: 'mission-empty', textContent: 'No open windows' }))
    for (const w of wins) grid.append(this.card(w))
    el.append(grid)
    el.addEventListener('pointerdown', (e) => e.target === el && this.hide())
    document.body.append(el)
    this.el = el
    ;(grid.querySelector('button') as HTMLElement | null)?.focus()
  }

  private card(w: Win): HTMLElement {
    const b = document.createElement('button')
    b.className = `mission-card${w.minimized ? ' minimized' : ''}`
    b.dataset.window = String(w.id)
    const icon = this.registry.iconUrl(w.appId)
    b.innerHTML = `<span class="mission-thumb">${icon ? `<img alt="" src="${icon}">` : ICONS.window}</span><span class="mission-title"></span>`
    b.querySelector('.mission-title')!.textContent = w.title + (w.minimized ? ' (minimized)' : '')
    b.addEventListener('click', () => {
      this.hide()
      this.wm.focus(w)
    })
    return b
  }
}
