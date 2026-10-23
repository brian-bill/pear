/// Running apps. An app is a Vanilla process (the SDK's host program, `main.js`) plus windows: each window is a
/// sandboxed iframe showing the app's UI page. The iframe can only talk to Desktop; Desktop runs the app's file,
/// settings and service calls *inside the app's process*, so Vanilla's permissions apply as for any app.
import type { Kernel } from '../../vanilla/kernel/src/client'
import type { HostEvent, HostReply, InitMsg, MenuSpec, ThemeInfo, UiToDesktop } from '../sdk/protocol'
import baseCss from '../sdk/base.css?raw'
import { ICONS, TYPE_ICONS } from './apps/icons'
import type { AppInfo, AppRegistry } from './apps/registry'
import { alertSheet, panel, promptSheet } from './shell/dialogs'
import type { MenuBar, Menu, MenuItem } from './shell/menubar'
import { showPopup } from './shell/popup'
import { Win, type Rect, type WindowManager } from './wm/windows'

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'"
/**
 * Safari shows fetched pages in a nested sandboxed frame, so that frame needs the page's own styles, scripts,
 * iframes and workers. Scripts still run with an opaque origin (no access to the app or kernel) and
 * `connect-src 'none'` keeps the frame's own XHR, `fetch` and WebSocket out — a page's requests go through
 * Safari's bridge to `tiny.network` instead (`apps/Safari.app`), under the app's network permission.
 */
const BROWSER_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: http: https:; style-src 'unsafe-inline' http: https:; img-src data: blob: http: https:; font-src data: http: https:; media-src data: blob: http: https:; connect-src 'none'; worker-src blob: http: https:; frame-src http: https:; form-action 'none'"
const THEME_VARS = [
  '--accent', '--window-bg', '--window-titlebar', '--window-border', '--menu-bg', '--text', '--text-dim', '--separator', '--terminal-bg', '--terminal-fg', '--font', '--mono', '--radius-window',
]
const enc = new TextEncoder()
const dec = new TextDecoder()

/** Apps that manage the system. Their calls under `admin.` run as the system; every other app is refused. */
const ADMIN_APPS = new Set(['org.tiny.settings', 'org.tiny.activitymonitor', 'org.tiny.console', 'org.tiny.finder'])
/** The kernel calls `admin.kernel` passes through. Anything that moves the process table or the file system's contents stays out. */
const ADMIN_KERNEL = new Set([
  'permList', 'permStatus', 'permGrant', 'permRevoke', 'permReset', 'permAudit',
  'bundleList', 'bundleInfo', 'bundleUninstall', 'bundleVerify', 'bundleRescan', 'bundleInstall', 'bundleUpdate',
  'configGet', 'configSet', 'configDelete', 'configList', 'configReset', 'configDomains', 'configFlush',
  'listProcesses', 'processInfo', 'kill', 'ping', 'diagSnapshot', 'bootInfo', 'bootMarks', 'fsInfo',
  'logQuery', 'logExport', 'logClear', 'logWrite', 'crashList', 'crashGet', 'crashSubmit', 'crashClear', 'traceStart', 'traceMark', 'traceMeasure', 'traceStop',
  'imageCreate', 'imageVerify', 'imageRestore', 'imageCancel',
  'launchApps', 'launchRecents', 'launchSetDefault', 'launchDefaultFor', 'launchTypeConflicts', 'launchSetTypeOwner', 'launchRunning',
  'mounts', 'listBookmarks',
])

export interface Deps {
  kernel: Kernel
  wm: WindowManager
  menubar: MenuBar
  registry: AppRegistry
  home(): string
  /** Post a notification on the system's behalf (crash notices). */
  notify(title: string, body: string): void
  /** Host file transfer (import from and export to the real computer). */
  transfer: {
    importInto(dest: string, opts: { directory?: boolean }): Promise<string[]>
    exportPath(path: string, opts: { saveAs?: boolean }): Promise<void>
  }
  /** A window changed: let the session be saved. */
  changed(): void
  /** Rebuild the menu bar for this focused window. */
  showMenus(win: Win): void
}

interface Pending {
  resolve: (v: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class AppWindow {
  menus: MenuSpec[] = []
  iframe!: HTMLIFrameElement
  ready = false
  /** Messages posted before the page said it was ready. */
  queued: unknown[] = []
  asks = new Map<number, Pending>()
  state: unknown
  /** What this window was opened with; the app's own launch arguments when not given. */
  args: string[] | undefined
  constructor(readonly inst: AppInstance, readonly win: Win) {}

  post(m: unknown): void {
    if (!this.ready) return void this.queued.push(m)
    this.iframe.contentWindow?.postMessage(m, '*')
  }
}

export class AppInstance {
  windows = new Set<AppWindow>()
  dead = false
  quitting = false
  constructor(readonly app: AppInfo, readonly pid: number, readonly ui: number, readonly events: number, readonly args: string[], private kernel: Kernel) {}

  async raw(req: unknown, rights?: number[], timeout = 20_000): Promise<HostReply> {
    if (this.dead) return { ok: false, error: { code: 'ESRCH', message: `${this.app.name} is not running` } }
    try {
      return (await this.kernel.request(this.ui, req, { rights, timeout })).data as HostReply
    } catch (e) {
      const err = e as { code?: string; message?: string }
      return { ok: false, error: { code: err.code ?? 'EIO', message: err.message ?? 'the app did not answer' } }
    }
  }
  async call(method: string, args: unknown[]): Promise<unknown> {
    const r = await this.raw({ op: 'call', method, args })
    if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code })
    return r.result
  }
  async service(name: string, msg: unknown, timeout?: number): Promise<unknown> {
    const r = await this.raw({ op: 'service', name, msg, timeout }, undefined, (timeout ?? 15_000) + 2000)
    if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code })
    return r.result
  }
}

export class AppHost {
  readonly instances = new Map<string, AppInstance>()
  private starting = new Map<string, Promise<AppInstance>>()
  private byFrame = new Map<Window, AppWindow>()
  private byWin = new Map<number, AppWindow>()
  private nextAsk = 1
  private iconData = new Map<string, string>()
  locale = 'en-US'

  constructor(private d: Deps) {
    window.addEventListener('message', (ev) => this.onMessage(ev))
    d.wm.on((e) => {
      if (e.type === 'focused') {
        const aw = this.byWin.get(e.win.id)
        if (aw) for (const o of this.byWin.values()) o.post({ t: 'event', name: o === aw ? 'focus' : 'blur' })
      } else if (e.type === 'closed') this.windowClosed(e.win)
    })
    d.kernel.onEvent((e) => {
      if (e.type === 'process' && e.event === 'exited') this.processExited(e.pid, e.status.crashed, e.status.code, e.status.signal)
      else if (e.type === 'launch' && e.event === 'launched') void this.adopt(e.appId, e.pid)
      else if (e.type === 'launch' && e.event === 'activated') void this.activated(e.appId)
    })
  }

  // ---- starting apps

  /** Is this an app with windows of its own (as opposed to one that only runs a process)? */
  isUi(appId: string): boolean {
    return Boolean(this.d.registry.get(appId)?.ui)
  }

  /** Open an app: a new window, or the existing instance's front window. Resolves the window. */
  async launch(appId: string, o: { args?: string[]; state?: unknown; rect?: Partial<Rect>; newWindow?: boolean } = {}): Promise<AppWindow | null> {
    const app = this.d.registry.get(appId)
    if (!app?.ui) {
      // a process-only app: Vanilla launches it, Desktop has nothing to show
      await this.d.kernel.launchOpen(appId, { args: o.args }).catch((e) => this.d.notify('Cannot open the app', (e as Error).message))
      return null
    }
    let existing = this.instances.get(appId)
    // an app that is still shutting down finishes first
    for (let i = 0; existing?.quitting && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 30))
      existing = this.instances.get(appId)
    }
    if (existing && !existing.dead) {
      const front = [...existing.windows].pop()
      if (front && !o.newWindow && !o.state) {
        this.d.wm.focus(front.win)
        // files given to a running app reach it as if opened from Finder
        for (const a of o.args ?? []) front.post({ t: 'event', name: 'openFile', data: a })
        return front
      }
      return this.openWindow(existing, { state: o.state, rect: o.rect, args: o.args })
    }
    const inst = await this.start(appId, o.args ?? [], true)
    if (!inst) return null
    // two clicks while the app was starting share one start: the second finds the window the first opened
    const front = [...inst.windows].pop()
    if (front && !o.newWindow && !o.state) {
      this.d.wm.focus(front.win)
      return front
    }
    return this.openWindow(inst, { state: o.state, rect: o.rect, args: o.args ?? inst.args })
  }

  /** Some other party launched an app Desktop shows (the shell's `open`, another app, Finder): give it a window. */
  private async adopt(appId: string, pid: number): Promise<void> {
    if (!this.isUi(appId) || this.instances.has(appId) || this.starting.has(appId)) return
    const inst = await this.start(appId, [], false, pid)
    if (inst && inst.windows.size === 0) this.openWindow(inst, { args: inst.args })
  }

  private async activated(appId: string): Promise<void> {
    const inst = this.instances.get(appId)
    if (!inst) return
    const front = [...inst.windows].pop()
    if (front) this.d.wm.focus(front.win)
    else this.openWindow(inst, {})
  }

  private start(appId: string, args: string[], viaLaunch: boolean, knownPid?: number): Promise<AppInstance | null> {
    const pending = this.starting.get(appId)
    if (pending) return pending
    const app = this.d.registry.get(appId)!
    const p = (async () => {
      try {
        const pid = knownPid ?? (await this.d.kernel.launchOpen(appId, { args, background: true }))
        const inst = await this.connect(app, pid)
        this.instances.set(appId, inst)
        void this.eventLoop(inst)
        return inst
      } catch (e) {
        this.d.notify(`${app.name} could not start`, (e as Error).message)
        return null
      } finally {
        this.starting.delete(appId)
      }
    })() as Promise<AppInstance>
    this.starting.set(appId, p)
    void viaLaunch
    return p
  }

  /** Find the process's `ui.<id>` port, check that the process that owns it is the one we launched, and attach. */
  private async connect(app: AppInfo, pid: number): Promise<AppInstance> {
    const k = this.d.kernel
    let port = -1
    for (let i = 0; i < 250; i++) {
      try {
        port = await k.lookup(`ui.${app.id}`)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 30))
      }
    }
    if (port < 0) throw new Error(`${app.name} did not start`)
    const hello = await k.request(port, { op: 'hello' }, { timeout: 5000 })
    // another process could have claimed the name first
    if (hello.from !== pid) throw new Error(`${app.name}: the process behind its UI port is not the one that was launched`)
    const events = await k.portCreate()
    const r = (await k.request(port, { op: 'attach' }, { rights: [events], timeout: 5000 })).data as HostReply
    if (!r.ok) throw new Error(r.error.message)
    const args = ((hello.data as HostReply & { result?: { args?: string[] } }).result?.args ?? []) as string[]
    return new AppInstance(app, pid, port, events, args, k)
  }

  private async eventLoop(inst: AppInstance): Promise<void> {
    for (;;) {
      const m = await this.d.kernel.receive(inst.events).catch(() => null)
      if (!m || inst.dead) return
      const e = m.data as HostEvent
      const front = [...inst.windows].pop()
      if (e.type === 'openFile' || e.type === 'openURL') {
        if (front) {
          this.d.wm.focus(front.win)
          front.post({ t: 'event', name: e.type, data: e.type === 'openFile' ? e.path : e.url })
        } else this.openWindow(inst, { args: [e.type === 'openFile' ? e.path : e.url] })
      } else if (e.type === 'activate') void this.activated(inst.app.id)
    }
  }

  /** Deliver an event to the app's front window (opening one if the app has none). */
  async deliver(appId: string, name: string, data: unknown): Promise<void> {
    const inst = this.instances.get(appId) ?? (await this.start(appId, [], true))
    if (!inst) return
    let front = [...inst.windows].pop()
    if (!front) front = this.openWindow(inst, {})
    this.d.wm.focus(front.win)
    front.post({ t: 'event', name, data })
  }

  // ---- windows

  openWindow(inst: AppInstance, o: { state?: unknown; rect?: Partial<Rect>; args?: string[] }): AppWindow {
    const hints = inst.app.window ?? {}
    let aw!: AppWindow
    const win = this.d.wm.create({
      appId: inst.app.id,
      title: hints.title ?? inst.app.name,
      width: o.rect?.width ?? hints.width ?? 640,
      height: o.rect?.height ?? hints.height ?? 440,
      x: o.rect?.x,
      y: o.rect?.y,
      minWidth: hints.minWidth,
      minHeight: hints.minHeight,
      resizable: hints.resizable,
      content: (body, w) => {
        aw = new AppWindow(inst, w)
        const frame = document.createElement('iframe')
        frame.className = 'app'
        frame.setAttribute('sandbox', 'allow-scripts allow-forms')
        frame.setAttribute('referrerpolicy', 'no-referrer')
        frame.title = inst.app.name
        body.append(frame)
        aw.iframe = frame
        this.byFrame.set(frame.contentWindow!, aw)
        this.byWin.set(w.id, aw)
        inst.windows.add(aw)
        w.focusHook = () => frame.contentWindow?.focus()
        w.closeGuard = () => this.closeGuard(aw)
        void this.document(inst.app).then((html) => (frame.srcdoc = html)).catch((e) => {
          frame.srcdoc = `<body style="font:13px system-ui;padding:20px">Cannot load ${inst.app.name}: ${String((e as Error).message).replace(/</g, '&lt;')}</body>`
        })
        return () => {
          this.byFrame.delete(frame.contentWindow!)
        }
      },
    })
    aw.state = o.state
    aw.args = o.args
    void win
    this.d.changed()
    return aw
  }

  /** The app's UI page with its styles and scripts inlined, a strict CSP, and the base styles. */
  private async document(app: AppInfo): Promise<string> {
    const k = this.d.kernel
    const htmlPath = `${app.path}/${app.ui}`
    const dir = htmlPath.slice(0, htmlPath.lastIndexOf('/'))
    const read = (rel: string) => k.readFile(rel.startsWith('/') ? rel : `${dir}/${rel}`)
    const doc = new DOMParser().parseFromString(dec.decode(await k.readFile(htmlPath)), 'text/html')
    for (const link of [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')]) {
      const style = doc.createElement('style')
      style.textContent = dec.decode(await read(link.getAttribute('href')!))
      link.replaceWith(style)
    }
    for (const script of [...doc.querySelectorAll<HTMLScriptElement>('script[src]')]) {
      const inline = doc.createElement('script')
      inline.textContent = dec.decode(await read(script.getAttribute('src')!)).replace(/<\/script/gi, '<\\/script')
      script.replaceWith(inline)
    }
    for (const img of [...doc.querySelectorAll<HTMLImageElement>('img[src]')]) {
      const src = img.getAttribute('src')!
      if (/^(data:|blob:)/.test(src)) continue
      const bytes = await read(src).catch(() => null)
      if (bytes) img.setAttribute('src', toDataUrl(bytes, src))
    }
    const meta = doc.createElement('meta')
    meta.httpEquiv = 'Content-Security-Policy'
    meta.content = app.id === 'org.tiny.browser' ? BROWSER_CSP : CSP
    const base = doc.createElement('style')
    base.textContent = baseCss
    doc.head.prepend(meta, Object.assign(doc.createElement('meta'), { name: 'color-scheme', content: 'light dark' }))
    doc.head.insertBefore(base, doc.head.querySelector('meta[name="color-scheme"]')!.nextSibling)
    return `<!doctype html>${doc.documentElement.outerHTML}`
  }

  theme(): ThemeInfo {
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const vars: Record<string, string> = {}
    for (const v of THEME_VARS) vars[v] = cs.getPropertyValue(v).trim()
    return {
      dark: root.dataset.theme === 'dark',
      accent: vars['--accent']!,
      reduceMotion: root.dataset.reduceMotion === 'true',
      reduceTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      vars,
    }
  }

  /** The theme or accent changed: tell every window. */
  broadcastTheme(): void {
    const t = this.theme()
    for (const aw of this.byWin.values()) aw.post({ t: 'event', name: 'theme', data: t })
  }

  /** Menus for the focused window's app, with the standard items Desktop adds. */
  menusFor(win: Win): Menu[] | null {
    const aw = this.byWin.get(win.id)
    if (!aw) return null
    const app = aw.inst.app
    const toItem = (i: MenuSpec['items'][number]): MenuItem =>
      i.separator ? { separator: true } : { label: i.label, shortcut: i.shortcut?.replace(/Cmd\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃'), disabled: i.disabled, checked: i.checked, action: () => aw.post({ t: 'event', name: 'menu', data: i.id }) }
    const menus: Menu[] = aw.menus.map((m) => ({ title: m.title, items: m.items.map(toItem) }))
    const quit: MenuItem[] = [{ separator: true }, { label: `Close Window`, shortcut: '⌘W', action: () => win.close() }, { label: `Quit ${app.name}`, shortcut: '⌘Q', action: () => void this.quit(aw.inst) }]
    if (!menus.length) menus.push({ title: app.name, items: quit.slice(1) })
    else menus[0] = { title: menus[0]!.title, items: [...menus[0]!.items, ...quit] }
    return menus
  }

  // ---- closing and quitting

  private async ask(aw: AppWindow, name: string, data?: unknown, timeout = 800): Promise<unknown> {
    const reqId = this.nextAsk++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        aw.asks.delete(reqId)
        resolve(undefined)
      }, timeout)
      aw.asks.set(reqId, { resolve, timer })
      aw.post({ t: 'event', name, data, reqId })
    })
  }

  /** Ask the window if it may close (unsaved changes). A window that does not answer may. */
  private async closeGuard(aw: AppWindow): Promise<boolean> {
    if (aw.inst.dead || aw.inst.quitting) return true
    return (await this.ask(aw, 'close-request', undefined, 120_000)) !== false
  }

  /** The state a window wants kept for the next session. */
  async saveState(win: Win): Promise<unknown> {
    const aw = this.byWin.get(win.id)
    if (!aw || !aw.ready) return undefined
    return this.ask(aw, 'save-state')
  }

  async quit(inst: AppInstance): Promise<void> {
    if (inst.dead) return
    inst.quitting = false
    for (const aw of [...inst.windows]) if (!(await this.d.wm.requestClose(aw.win))) return
    this.stop(inst)
  }

  private stop(inst: AppInstance): void {
    if (inst.dead) return
    inst.quitting = true
    void this.d.kernel.kill(inst.pid, 'SIGTERM').catch(() => {})
  }

  private windowClosed(win: Win): void {
    const aw = this.byWin.get(win.id)
    if (!aw) return
    this.byWin.delete(win.id)
    for (const p of aw.asks.values()) (clearTimeout(p.timer), p.resolve(undefined))
    const inst = aw.inst
    inst.windows.delete(aw)
    this.d.changed()
    // the last window going away ends the app
    if (!inst.windows.size && !inst.dead) this.stop(inst)
  }

  private processExited(pid: number, crashed: boolean, code: number | null, signal: string | null): void {
    for (const [id, inst] of this.instances) {
      if (inst.pid !== pid) continue
      const expected = inst.quitting || signal === 'SIGTERM' || signal === 'SIGKILL'
      inst.dead = true
      this.instances.delete(id)
      inst.quitting = true
      for (const aw of [...inst.windows]) this.d.wm.close(aw.win)
      if (!expected && (crashed || (code ?? 0) !== 0)) this.d.notify(`${inst.app.name} quit unexpectedly`, 'Its windows were closed. The crash report is in Console.')
    }
  }

  // ---- messages from windows

  private onMessage(ev: MessageEvent): void {
    const aw = this.byFrame.get(ev.source as Window)
    if (!aw) return
    const m = ev.data as UiToDesktop
    if (!m || typeof m !== 'object') return
    if (m.t === 'note') return this.onNote(aw, m.kind, m.data)
    if (m.t === 'answer') {
      const p = aw.asks.get(m.reqId)
      if (p) (clearTimeout(p.timer), aw.asks.delete(m.reqId), p.resolve(m.value))
      return
    }
    if (m.t === 'call') {
      const reply = (ok: boolean, result?: unknown, error?: { code: string; message: string }) => aw.iframe.contentWindow?.postMessage({ t: 'reply', id: m.id, ok, result, error }, '*')
      void this.handleCall(aw, m.method, m.args ?? []).then(
        (r) => reply(true, r ?? null),
        (e: { code?: string; message?: string }) => reply(false, undefined, { code: e?.code ?? 'EIO', message: e?.message ?? String(e) }),
      )
    }
  }

  private onNote(aw: AppWindow, kind: string, data: unknown): void {
    if (kind === 'ready') {
      aw.ready = true
      const init: InitMsg = {
        t: 'init', appId: aw.inst.app.id, appName: aw.inst.app.name, windowId: aw.win.id, state: aw.state, args: aw.args ?? aw.inst.args,
        theme: this.theme(), locale: this.locale, platform: navigator.platform,
      }
      aw.iframe.contentWindow?.postMessage(init, '*')
      for (const q of aw.queued.splice(0)) aw.iframe.contentWindow?.postMessage(q, '*')
    } else if (kind === 'pointer' || kind === 'focus') {
      if (kind === 'pointer') this.d.menubar.close()
      if (!aw.win.el.classList.contains('focused') && !aw.win.minimized) this.d.wm.focus(aw.win)
    } else if (kind === 'key') {
      const k = data as { key: string; code: string; metaKey: boolean; altKey: boolean; shiftKey: boolean; ctrlKey: boolean }
      if (k.metaKey && k.key.toLowerCase() === 'q') void this.quit(aw.inst)
      else if (!this.d.wm.shortcut(k)) window.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, code: k.code, metaKey: k.metaKey, altKey: k.altKey, shiftKey: k.shiftKey, ctrlKey: k.ctrlKey, cancelable: true }))
    }
  }

  private async handleCall(aw: AppWindow, method: string, args: unknown[]): Promise<unknown> {
    const { inst, win } = aw
    const d = this.d
    const need = <T>(v: unknown, what: string): T => {
      if (v === undefined || v === null) throw Object.assign(new Error(`${what} is required`), { code: 'EINVAL' })
      return v as T
    }
    if (method.startsWith('kernel.')) return inst.call(method.slice(7), args)
    if (method.startsWith('admin.')) {
      if (!ADMIN_APPS.has(inst.app.id) || !inst.app.path.startsWith('/Applications/')) throw Object.assign(new Error(`${inst.app.name} may not administer the system`), { code: 'EPERM' })
      if (method === 'admin.kernel') {
        const name = String(args[0])
        if (!ADMIN_KERNEL.has(name)) throw Object.assign(new Error(`${name} is not available`), { code: 'EPERM' })
        return (d.kernel as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args.slice(1))
      }
      if (method === 'admin.service') {
        const name = String(args[0])
        if (!/^tiny\.[a-z]+$/.test(name)) throw Object.assign(new Error('only system services can be called'), { code: 'EINVAL' })
        const reply = (await d.kernel.request(await d.kernel.lookup(name), args[1], { timeout: (Number(args[2]) || 15_000) })).data as { ok: boolean; result?: unknown; error?: { code: string; message: string } }
        if (!reply.ok) throw Object.assign(new Error(reply.error?.message ?? 'the service failed'), { code: reply.error?.code ?? 'EIO' })
        return reply.result ?? null
      }
    }
    switch (method) {
      case 'service':
        return inst.service(need<string>(args[0], 'service'), args[1], args[2] as number | undefined)
      case 'window.setTitle':
        win.title = String(args[0] ?? '')
        return
      case 'window.setMenus':
        aw.menus = (args[0] as MenuSpec[]) ?? []
        if (win.el.classList.contains('focused')) d.showMenus(win)
        return
      case 'window.close':
        win.close()
        return
      case 'window.minimize':
        win.minimize()
        return
      case 'window.toggleMaximize':
        win.toggleMaximize()
        return
      case 'window.focus':
        d.wm.focus(win)
        return
      case 'window.resize': {
        const [w, h] = args as [number, number]
        win.rect = d.wm.clamp({ ...win.rect, width: Math.max(win.minSize.width, w), height: Math.max(win.minSize.height, h) })
        win.apply()
        return
      }
      case 'window.setEdited':
        win.edited = Boolean(args[0])
        return
      case 'window.list':
        return [...inst.windows].map((w) => ({ id: w.win.id, title: w.win.title }))
      case 'app.openWindow':
        return this.openWindow(inst, { state: args[0], args: [] }).win.id
      case 'app.stateChanged':
        d.changed()
        return
      case 'app.quit':
        void this.quit(inst)
        return
      case 'dialogs.alert':
        return alertSheet(win, args[0] as never)
      case 'dialogs.prompt':
        return promptSheet(win, args[0] as never)
      case 'dialogs.open':
      case 'dialogs.save': {
        const o = (args[0] ?? {}) as { directory?: boolean }
        const picked = await panel(d.kernel, win, method === 'dialogs.open' ? 'open' : 'save', args[0] as never, d.home())
        if (!picked) return null
        // the app may use exactly what the user chose
        for (const p of picked) await d.kernel.permPickerGrant(inst.app.id, p, { write: true })
        return method === 'dialogs.save' ? picked[0] : (void o, picked)
      }
      case 'host.import': {
        const dest = need<string>(args[0], 'destination')
        await this.probe(inst, dest, 'write')
        return d.transfer.importInto(dest, (args[1] ?? {}) as { directory?: boolean })
      }
      case 'host.export': {
        const path = need<string>(args[0], 'path')
        await this.probe(inst, path, 'read')
        return d.transfer.exportPath(path, (args[1] ?? {}) as { saveAs?: boolean })
      }
      case 'shell.open': {
        const [target, o] = args as [string, { app?: string }]
        await inst.call('launchOpen', [need<string>(target, 'target'), o ?? {}])
        return
      }
      case 'shell.reveal':
        return this.deliver('org.tiny.finder', 'reveal', need<string>(args[0], 'path'))
      case 'shell.openApp':
        void this.launch(need<string>(args[0], 'app'))
        return
      case 'shell.apps':
        return Promise.all(d.registry.list().map(async (a) => ({ id: a.id, name: a.name, kind: a.kind, icon: await this.appIconData(a.id) })))
      case 'shell.icon':
        return this.icon(need<string>(args[0], 'target'))
      case 'shell.contextMenu': {
        const [items, at] = args as [Array<MenuSpec['items'][number]>, { x: number; y: number }]
        const r = aw.iframe.getBoundingClientRect()
        await new Promise<void>((resolve) => {
          showPopup(
            items.map((i): MenuItem => (i.separator ? { separator: true } : { label: i.label, disabled: i.disabled, checked: i.checked, shortcut: i.shortcut, action: () => aw.post({ t: 'event', name: 'context', data: i.id }) })),
            { x: r.left + at.x, y: r.top + at.y },
            resolve,
          )
        })
        return
      }
      case 'shell.notify':
        return inst.service('tiny.notifications', { op: 'post', title: String(args[0] ?? ''), body: String(args[1] ?? '') })
    }
    throw Object.assign(new Error(`unknown call ${method}`), { code: 'ENOSYS' })
  }

  /** Can the app itself read or write here? Asked of its own process, so the answer is Vanilla's. */
  private async probe(inst: AppInstance, path: string, mode: 'read' | 'write'): Promise<void> {
    if (mode === 'write') {
      const name = `${path}/.tiny-probe-${Date.now()}`
      await inst.call('mkdir', [name])
      await inst.call('rmdir', [name]).catch(() => {})
    } else {
      const fd = (await inst.call('open', [path, 0])) as number
      await inst.call('close', [fd]).catch(() => {})
    }
  }

  // ---- icons for the SDK (as data URLs, which the sandbox can show)

  async icon(target: string): Promise<{ name: string; url: string | null; description: string }> {
    const info = await this.d.kernel.launchIconFor(target)
    const key = `${info.source}:${info.path ?? info.name}`
    let url = this.iconData.get(key)
    if (url === undefined) {
      if (info.source === 'app') url = (await this.appIconData(target.startsWith('/') ? this.d.registry.list().find((a) => a.path === target)?.id : target)) ?? ''
      else if (info.path) url = toDataUrl(await this.d.kernel.readFile(info.path), info.path)
      else url = svgUrl(info.name === 'folder' ? ICONS.folder! : info.name === 'app' ? ICONS.window! : TYPE_ICONS[info.name] ?? ICONS.file!)
      this.iconData.set(key, url)
    }
    return { name: info.name, url: url || null, description: info.description }
  }

  /** An app's icon as a data URL; the sandbox cannot load Desktop's blob: URLs. */
  private async appIconData(id: string | undefined): Promise<string | null> {
    const app = id ? this.d.registry.get(id) : undefined
    if (!app?.iconPath) return null
    const key = `app-icon:${app.id}:${app.version}:${app.iconPath}`
    let url = this.iconData.get(key)
    if (url === undefined) {
      url = await this.d.kernel.readFile(app.iconPath).then((b) => toDataUrl(b, app.iconPath!), () => '')
      this.iconData.set(key, url)
    }
    return url || null
  }
}

export const svgUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
function toDataUrl(bytes: Uint8Array, name: string): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'};base64,${btoa(s)}`
}
void enc
