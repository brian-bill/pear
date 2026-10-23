/// Status items at the right of the menu bar: search, volume, network, battery, notifications.
import type { Kernel } from '../../../vanilla/kernel/src/client'
import type { MenuBar } from './menubar'
import type { Notifications } from './notifications'

const svg = (inner: string) => `<svg viewBox="0 0 20 16" width="18" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
const ICON = {
  search: svg('<circle cx="8.5" cy="7" r="4.5"/><path d="M12 10.5L16 14.5"/>'),
  volume: svg('<path d="M3 6h3l4-3v10l-4-3H3z" fill="currentColor"/><path d="M13 5.5a4 4 0 010 5"/>'),
  muted: svg('<path d="M3 6h3l4-3v10l-4-3H3z" fill="currentColor"/><path d="M13 5l4 6M17 5l-4 6"/>'),
  online: svg('<path d="M3 6.5a10 10 0 0114 0M5.5 9a6.5 6.5 0 019 0M8 11.5a3 3 0 014 0"/><circle cx="10" cy="13.5" r="0.8" fill="currentColor"/>'),
  offline: svg('<path d="M3 6.5a10 10 0 0114 0M5.5 9a6.5 6.5 0 019 0M8 11.5a3 3 0 014 0"/><path d="M3 15L17 2" stroke-width="1.8"/>'),
  bell: svg('<path d="M5 12V8a5 5 0 0110 0v4l1.5 2h-13z"/><path d="M8.5 15a1.5 1.5 0 003 0"/>'),
}

export class StatusBar {
  private volume: HTMLButtonElement
  private net: HTMLButtonElement
  private battery: HTMLButtonElement | null = null
  private bell: HTMLButtonElement
  private panel: HTMLElement | null = null
  private level = 1
  private muted = false
  private online = true

  constructor(
    private kernel: Kernel,
    private menubar: MenuBar,
    private notes: Notifications,
    private openLauncher: () => void,
  ) {
    const search = menubar.addStatus('search', '', () => this.openLauncher())
    search.innerHTML = ICON.search
    search.setAttribute('aria-label', 'Search')
    this.volume = menubar.addStatus('volume', '', () => this.volumePanel())
    this.volume.setAttribute('aria-label', 'Volume')
    this.net = menubar.addStatus('network', '', () => this.infoPanel('Network', [`${this.online ? 'Online' : 'Offline'}`]))
    this.net.setAttribute('aria-label', 'Network')
    this.bell = menubar.addStatus('notifications', '', () => this.notes.toggleCenter())
    this.bell.setAttribute('aria-label', 'Notification Center')
    notes.onChange(() => this.drawBell())
    document.addEventListener('pointerdown', (e) => {
      if (this.panel && !(e.target as HTMLElement).closest('.status-panel, .menubar .status')) this.closePanel()
    })
    this.draw()
    this.drawBell()
  }

  /** Read the audio settings and listen for changes from the system services. */
  async start(): Promise<void> {
    const k = this.kernel
    const read = async () => {
      this.level = Number(await k.configGet('tiny.audio', 'volume', 1))
      this.muted = Boolean(await k.configGet('tiny.audio', 'muted', false))
      this.draw()
    }
    await read()
    k.onEvent((e) => {
      if (e.type === 'config' && e.event === 'changed' && e.change.domain === 'tiny.audio') void read()
    })
    this.online = navigator.onLine
    addEventListener('online', () => ((this.online = true), this.draw()))
    addEventListener('offline', () => ((this.online = false), this.draw()))
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(t: string, f: () => void): void }> }
    if (nav.getBattery) {
      void nav.getBattery().then((b) => {
        const show = () => {
          if (!this.battery) {
            this.battery = this.menubar.addStatus('battery', '', () => this.infoPanel('Battery', [`${Math.round(b.level * 100)}%`, b.charging ? 'Charging' : 'On battery power']))
            this.battery.setAttribute('aria-label', 'Battery')
          }
          this.battery.textContent = `${Math.round(b.level * 100)}%${b.charging ? ' ⚡' : ''}`
        }
        show()
        b.addEventListener('levelchange', show)
        b.addEventListener('chargingchange', show)
      }, () => {})
    }
  }

  private draw(): void {
    this.volume.innerHTML = this.muted || this.level === 0 ? ICON.muted : ICON.volume
    this.net.innerHTML = this.online ? ICON.online : ICON.offline
  }

  private drawBell(): void {
    const n = this.notes.count
    this.bell.innerHTML = ICON.bell + (n ? `<span class="badge">${n > 9 ? '9+' : n}</span>` : '')
    this.bell.setAttribute('aria-label', n ? `Notification Center, ${n} notifications` : 'Notification Center')
  }

  private closePanel(): void {
    this.panel?.remove()
    this.panel = null
  }

  private place(el: HTMLElement, anchor: HTMLElement): void {
    this.closePanel()
    el.classList.add('menu', 'status-panel')
    document.body.append(el)
    const r = anchor.getBoundingClientRect()
    el.style.left = `${Math.max(4, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 4))}px`
    el.style.top = `${r.bottom + 2}px`
    this.panel = el
  }

  private infoPanel(title: string, lines: string[]): void {
    const el = document.createElement('div')
    el.innerHTML = `<strong></strong>${lines.map(() => '<div class="dim"></div>').join('')}`
    el.querySelector('strong')!.textContent = title
    el.querySelectorAll('.dim').forEach((d, i) => (d.textContent = lines[i]!))
    this.place(el, this.net)
  }

  private volumePanel(): void {
    const el = document.createElement('div')
    el.innerHTML = '<label>Volume<br><input type="range" min="0" max="100" step="1" aria-label="Output volume"></label><label class="mute"><input type="checkbox"> Mute</label>'
    const range = el.querySelector<HTMLInputElement>('input[type=range]')!
    const mute = el.querySelector<HTMLInputElement>('input[type=checkbox]')!
    range.value = String(Math.round(this.level * 100))
    mute.checked = this.muted
    range.addEventListener('input', () => void this.kernel.configSet('tiny.audio', 'volume', Number(range.value) / 100))
    mute.addEventListener('change', () => void this.kernel.configSet('tiny.audio', 'muted', mute.checked))
    this.place(el, this.volume)
  }
}
