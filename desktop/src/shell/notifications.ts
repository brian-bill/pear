/// Notification banners and the Notification Center, over Vanilla's `tiny.notifications` service. Apps post through
/// the service (it checks their `notifications` permission); Desktop only shows what arrives.
import type { Kernel } from '../../../vanilla/kernel/src/client'
import type { AppRegistry } from '../apps/registry'

export interface Note {
  id: number
  appId: string | null
  title: string
  body: string
  time: number
}

const BANNER_MS = 5000
const MAX_BANNERS = 4

export class Notifications {
  readonly items: Note[] = []
  private banners: HTMLElement
  private center: HTMLElement
  private listeners = new Set<() => void>()
  private timers = new Map<number, ReturnType<typeof setTimeout>>()
  private dnd = false
  private muted = new Set<string>()

  constructor(
    private kernel: Kernel,
    private registry: AppRegistry,
    private open: (appId: string) => void,
  ) {
    this.banners = Object.assign(document.createElement('div'), { className: 'banners' })
    this.banners.setAttribute('aria-live', 'polite')
    this.center = Object.assign(document.createElement('aside'), { className: 'note-center', hidden: true })
    this.center.setAttribute('aria-label', 'Notification Center')
    document.body.append(this.banners, this.center)
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement
      if (!this.center.hidden && !t.closest('.note-center, [data-status="notifications"]')) this.hideCenter()
    })
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  get count(): number {
    return this.items.length
  }
  get doNotDisturb(): boolean {
    return this.dnd
  }

  /** Subscribe to the service and load what is already waiting. */
  async start(): Promise<void> {
    const k = this.kernel
    await this.readSettings()
    const service = await k.lookup('tiny.notifications')
    const port = await k.portCreate()
    await k.request(service, { op: 'subscribe' }, { rights: [port], timeout: 5000 })
    const existing = (await k.request(service, { op: 'list' }, { timeout: 5000 })).data as { ok: boolean; result: Note[] }
    if (existing.ok) this.items.push(...existing.result)
    k.onEvent((e) => {
      if (e.type === 'config' && e.event === 'changed' && e.change.domain === 'tiny.notifications') void this.readSettings()
    })
    void (async () => {
      for (;;) {
        const m = await k.receive(port).catch(() => null)
        if (!m) return
        const d = m.data as { type: string; notification?: Note; id?: number }
        if (d.type === 'posted' && d.notification) this.posted(d.notification)
        else if (d.type === 'dismissed' && d.id !== undefined) this.removed(d.id)
      }
    })()
    this.changed()
  }

  private async readSettings(): Promise<void> {
    const k = this.kernel
    this.dnd = Boolean(await k.configGet('tiny.notifications', 'dnd', false))
    const apps = (await k.configGet('tiny.notifications', 'apps', {})) as Record<string, boolean>
    this.muted = new Set(Object.entries(apps).filter(([, on]) => on === false).map(([id]) => id))
    this.changed()
  }

  private posted(n: Note): void {
    this.items.push(n)
    this.changed()
    const silenced = this.dnd || (n.appId !== null && this.muted.has(n.appId))
    if (!silenced) this.banner(n)
    if (!this.center.hidden) this.renderCenter()
  }

  private removed(id: number): void {
    const i = this.items.findIndex((n) => n.id === id)
    if (i >= 0) this.items.splice(i, 1)
    this.hideBanner(id)
    this.changed()
    if (!this.center.hidden) this.renderCenter()
  }

  private changed(): void {
    for (const l of this.listeners) l()
  }

  async dismiss(id: number): Promise<void> {
    const service = await this.kernel.lookup('tiny.notifications')
    await this.kernel.request(service, { op: 'dismiss', id }, { timeout: 4000 }).catch(() => {})
  }

  async clear(): Promise<void> {
    const service = await this.kernel.lookup('tiny.notifications')
    await this.kernel.request(service, { op: 'clear' }, { timeout: 4000 }).catch(() => {})
  }

  async setDoNotDisturb(on: boolean): Promise<void> {
    await this.kernel.configSet('tiny.notifications', 'dnd', on)
    await this.kernel.configFlush()
  }

  // ---- banners

  private source(n: Note): { name: string; icon: string | null } {
    const app = n.appId ? this.registry.get(n.appId) : undefined
    return { name: app?.name ?? 'Pear', icon: n.appId ? this.registry.iconUrl(n.appId) : null }
  }

  private card(n: Note, banner: boolean): HTMLElement {
    const src = this.source(n)
    const el = document.createElement('div')
    el.className = 'note'
    el.dataset.note = String(n.id)
    el.setAttribute('role', banner ? 'alert' : 'listitem')
    el.innerHTML = `<div class="note-icon"></div><div class="note-text"><div class="note-app"></div><div class="note-title"></div><div class="note-body"></div></div><button class="note-x" aria-label="Dismiss">×</button>`
    el.querySelector('.note-app')!.textContent = src.name
    el.querySelector('.note-title')!.textContent = n.title
    el.querySelector('.note-body')!.textContent = n.body
    if (src.icon) el.querySelector('.note-icon')!.innerHTML = `<img alt="" src="${src.icon}">`
    el.querySelector('.note-x')!.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.dismiss(n.id)
    })
    el.addEventListener('click', () => {
      if (n.appId) this.open(n.appId)
      void this.dismiss(n.id)
    })
    return el
  }

  private banner(n: Note): void {
    const el = this.card(n, true)
    this.banners.prepend(el)
    while (this.banners.children.length > MAX_BANNERS) this.banners.lastElementChild!.remove()
    this.timers.set(n.id, setTimeout(() => this.hideBanner(n.id), BANNER_MS))
  }

  private hideBanner(id: number): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.banners.querySelector(`[data-note="${id}"]`)?.remove()
  }

  // ---- center

  toggleCenter(): void {
    if (this.center.hidden) {
      this.renderCenter()
      this.center.hidden = false
    } else this.hideCenter()
  }

  hideCenter(): void {
    this.center.hidden = true
  }

  private renderCenter(): void {
    const head = document.createElement('div')
    head.className = 'note-head'
    head.innerHTML = '<strong>Notifications</strong><span class="grow"></span>'
    const dnd = Object.assign(document.createElement('button'), { className: 'note-btn', textContent: this.dnd ? 'Do Not Disturb: On' : 'Do Not Disturb' })
    dnd.setAttribute('aria-pressed', String(this.dnd))
    dnd.addEventListener('click', () => void this.setDoNotDisturb(!this.dnd).then(() => this.renderCenter()))
    const clear = Object.assign(document.createElement('button'), { className: 'note-btn', textContent: 'Clear All', disabled: !this.items.length })
    clear.addEventListener('click', () => void this.clear())
    head.append(dnd, clear)
    const list = document.createElement('div')
    list.className = 'note-list'
    list.setAttribute('role', 'list')
    if (!this.items.length) list.append(Object.assign(document.createElement('div'), { className: 'note-empty', textContent: 'No Notifications' }))
    for (const n of [...this.items].reverse()) list.append(this.card(n, false))
    this.center.replaceChildren(head, list)
  }
}
