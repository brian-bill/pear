/// The launcher (Spotlight-style): type, get apps, files, settings panes and calculations from `tiny.search`.
import type { Kernel } from '../../../vanilla/kernel/src/client'
import type { AppHost } from '../apphost'
import { svgUrl } from '../apphost'
import { ICONS } from '../apps/icons'
import type { AppRegistry } from '../apps/registry'

interface Result {
  kind: string
  title: string
  subtitle?: string
  path?: string
  appId?: string
  provider?: string
  action?: { pane?: string }
  score: number
}

/** The panes of System Settings the launcher can jump to. */
export const SETTINGS_PANES: Array<{ id: string; title: string; keywords: string }> = [
  { id: 'general', title: 'General', keywords: 'about storage backup software update startup name' },
  { id: 'appearance', title: 'Appearance', keywords: 'dark light mode accent color theme text size' },
  { id: 'desktop', title: 'Desktop & Dock', keywords: 'dock wallpaper size magnification position hide' },
  { id: 'displays', title: 'Displays', keywords: 'screen resolution fullscreen' },
  { id: 'sound', title: 'Sound', keywords: 'volume mute output audio' },
  { id: 'keyboard', title: 'Keyboard', keywords: 'layout shortcuts command key' },
  { id: 'language', title: 'Language & Region', keywords: 'locale timezone time zone date format measurement' },
  { id: 'notifications', title: 'Notifications', keywords: 'do not disturb alerts banners' },
  { id: 'privacy', title: 'Privacy & Security', keywords: 'permissions password lock search privacy' },
  { id: 'network', title: 'Network', keywords: 'internet proxy offline data usage' },
  { id: 'apps', title: 'Apps', keywords: 'default apps uninstall file types' },
  { id: 'accessibility', title: 'Accessibility', keywords: 'motion transparency contrast' },
  { id: 'battery', title: 'Battery', keywords: 'power energy' },
]

const LIMIT = 10

export class Launcher {
  private el: HTMLElement | null = null
  private input!: HTMLInputElement
  private list!: HTMLElement
  private results: Result[] = []
  private index = 0
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private searchPort = -1

  constructor(
    private kernel: Kernel,
    private registry: AppRegistry,
    private apps: AppHost,
    private openPath: (path: string) => void,
    private reveal: (path: string) => void,
  ) {
    addEventListener('keydown', (e) => {
      if (this.matches(e)) {
        e.preventDefault()
        this.toggle()
      } else if (e.key === 'Escape' && this.el) this.hide()
    })
  }

  private shortcut = 'Alt+Space'
  private matches(e: KeyboardEvent): boolean {
    const want = this.shortcut.split('+')
    const key = want[want.length - 1]!
    const mods = new Set(want.slice(0, -1))
    const code = e.code === 'Space' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
    return code.toLowerCase() === key.toLowerCase() && e.altKey === mods.has('Alt') && e.metaKey === mods.has('Cmd') && e.ctrlKey === mods.has('Ctrl') && e.shiftKey === mods.has('Shift')
  }

  setShortcut(s: string): void {
    this.shortcut = s || 'Alt+Space'
  }

  /** Make the System Settings panes searchable. */
  async registerProvider(): Promise<void> {
    const k = this.kernel
    const service = await k.lookup('tiny.search')
    const port = await k.portCreate()
    await k.request(service, { op: 'register', id: 'settings', name: 'System Settings' }, { rights: [port], timeout: 5000 })
    void (async () => {
      for (;;) {
        const m = await k.receive(port).catch(() => null)
        if (!m) return
        const q = String((m.data as { query?: string }).query ?? '').toLowerCase().trim()
        const results = q.length < 2 ? [] : SETTINGS_PANES.filter((p) => `${p.title} ${p.keywords}`.toLowerCase().includes(q)).map((p) => ({ kind: 'setting', title: p.title, subtitle: 'System Settings', action: { pane: p.id }, score: p.title.toLowerCase().startsWith(q) ? 95 : 60 }))
        if (m.replyTo !== null) await k.send(m.replyTo, { results }).catch(() => {})
      }
    })()
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
    const back = Object.assign(document.createElement('div'), { className: 'launcher-back' })
    back.innerHTML = '<div class="launcher" role="dialog" aria-label="Search"><div class="launcher-bar"><input type="text" placeholder="Search apps, files and settings" aria-label="Search" autocomplete="off" spellcheck="false"></div><div class="launcher-list" role="listbox"></div></div>'
    this.input = back.querySelector('input')!
    this.list = back.querySelector('.launcher-list')!
    back.addEventListener('pointerdown', (e) => e.target === back && this.hide())
    this.input.addEventListener('input', () => this.schedule())
    this.input.addEventListener('keydown', (e) => this.key(e))
    document.body.append(back)
    this.el = back
    this.input.focus()
    void this.recents()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.search(), 60)
  }

  private async recents(): Promise<void> {
    const recents = await this.kernel.launchRecents().catch(() => [])
    const seen = new Set<string>()
    const out: Result[] = []
    for (const r of recents) {
      if (seen.has(r.target) || out.length >= 6) continue
      seen.add(r.target)
      const app = this.registry.get(r.target)
      out.push(app ? { kind: 'app', title: app.name, subtitle: 'Recent', appId: app.id, score: 1 } : { kind: 'file', title: r.target.slice(r.target.lastIndexOf('/') + 1), subtitle: r.target, path: r.target, score: 1 })
    }
    if (!this.input.value) await this.show_(out)
  }

  private async search(): Promise<void> {
    const q = this.input.value.trim()
    const seq = ++this.seq
    if (!q) return void (await this.recents())
    try {
      if (this.searchPort < 0) this.searchPort = await this.kernel.lookup('tiny.search')
      const reply = (await this.kernel.request(this.searchPort, { op: 'query', q, limit: LIMIT * 2, scopes: ['all'] }, { timeout: 4000 })).data as { ok: boolean; result?: { results: Result[] } }
      if (seq !== this.seq) return
      await this.show_(reply.ok ? reply.result!.results.slice(0, LIMIT) : [])
    } catch {
      if (seq === this.seq) await this.show_([])
    }
  }

  private async show_(results: Result[]): Promise<void> {
    this.results = results
    this.index = 0
    const rows = await Promise.all(results.map(async (r, i) => {
      const row = document.createElement('div')
      row.className = 'launcher-row'
      row.setAttribute('role', 'option')
      row.dataset.index = String(i)
      const icon = await this.icon(r)
      row.innerHTML = `<span class="launcher-icon">${icon ? `<img alt="" src="${icon}">` : ''}</span><span class="launcher-text"><span class="launcher-title"></span><span class="launcher-sub"></span></span><span class="launcher-kind"></span>`
      row.querySelector('.launcher-title')!.textContent = r.title
      row.querySelector('.launcher-sub')!.textContent = r.subtitle ?? ''
      row.querySelector('.launcher-kind')!.textContent = r.kind === 'calc' ? 'Calculation' : r.kind === 'setting' ? 'Settings' : r.kind === 'app' ? 'Application' : r.kind === 'folder' ? 'Folder' : ''
      row.addEventListener('click', () => void this.choose(r))
      row.addEventListener('pointermove', () => this.select(i))
      return row
    }))
    if (!this.el) return
    this.list.replaceChildren(...rows)
    if (!rows.length && this.input.value.trim()) this.list.append(Object.assign(document.createElement('div'), { className: 'launcher-empty', textContent: 'No results' }))
    this.select(0)
  }

  private async icon(r: Result): Promise<string | null> {
    if (r.kind === 'calc') return svgUrl(ICONS.about!)
    if (r.kind === 'setting') return this.registry.iconUrl('org.tiny.settings')
    if (r.appId) return this.registry.iconUrl(r.appId)
    if (r.path) return (await this.apps.icon(r.path).catch(() => null))?.url ?? null
    return null
  }

  private select(i: number): void {
    this.index = Math.max(0, Math.min(i, this.results.length - 1))
    this.list.querySelectorAll('.launcher-row').forEach((row, n) => row.classList.toggle('selected', n === this.index))
    this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }

  private key(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') (e.preventDefault(), this.select(this.index + 1))
    else if (e.key === 'ArrowUp') (e.preventDefault(), this.select(this.index - 1))
    else if (e.key === 'Enter') {
      e.preventDefault()
      const r = this.results[this.index]
      if (r) void this.choose(r, e.metaKey || e.altKey)
    }
  }

  private async choose(r: Result, reveal = false): Promise<void> {
    if (r.kind === 'calc') {
      await navigator.clipboard?.writeText(r.title).catch(() => {})
      return this.hide()
    }
    this.hide()
    if (r.action?.pane) return void (await this.apps.deliver('org.tiny.settings', 'openPane', r.action.pane))
    if (r.appId) return void (await this.apps.launch(r.appId))
    if (r.path) {
      if (reveal) this.reveal(r.path)
      else this.openPath(r.path)
    }
  }
}
