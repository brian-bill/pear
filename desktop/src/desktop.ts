/// The desktop shell: wires the window manager, menu bar, dock and the app host to Vanilla, themes it, and saves and
/// restores the session. Desktop talks to Vanilla only through the kernel client and the system services.
import type { Kernel } from '../../vanilla/kernel/src/client'
import * as transfer from '../../vanilla/kernel/src/host-transfer'
import { AppHost } from './apphost'
import { AppRegistry } from './apps/registry'
import { Dock, type DockSettings } from './shell/dock'
import { ICONS } from './apps/icons'
import { AppGrid } from './shell/appgrid'
import { Launcher } from './shell/launcher'
import { LockScreen } from './shell/lock'
import { MissionControl } from './shell/missioncontrol'
import { Notifications } from './shell/notifications'
import { StatusBar } from './shell/statusbar'
import { DesktopSurface } from './shell/surface'
import { MenuBar, type Menu } from './shell/menubar'
import { WindowManager, type Win } from './wm/windows'

export const APP = {
  finder: 'org.tiny.finder',
  terminal: 'org.tiny.terminal',
  about: 'org.tiny.about',
  profile: 'org.tiny.profile',
  settings: 'org.tiny.settings',
  editor: 'org.tiny.textedit',
}
const DEFAULT_DOCK = [APP.profile, APP.finder, APP.terminal, APP.editor, APP.settings]

interface SavedWindow {
  appId: string
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  minimized: boolean
  state?: unknown
}
export interface SavedSession {
  windows: SavedWindow[]
  focused: number | null
}

export class Desktop {
  readonly wm: WindowManager
  readonly menubar: MenuBar
  readonly dock: Dock
  readonly registry: AppRegistry
  readonly apps: AppHost
  readonly notes: Notifications
  readonly launcher: Launcher
  readonly appGrid: AppGrid
  readonly mission: MissionControl
  readonly lock: LockScreen
  readonly surface: DesktopSurface
  readonly status: StatusBar
  private trashFull = false
  home = '/Users/pear'
  private user = { uid: 501, gid: 20 }
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private restoring = false

  constructor(readonly kernel: Kernel, root: HTMLElement) {
    const area = Object.assign(document.createElement('div'), { className: 'windows' })
    this.wm = new WindowManager(area)
    this.registry = new AppRegistry(kernel)
    this.menubar = new MenuBar(() => this.systemMenu())
    this.apps = new AppHost({
      kernel,
      wm: this.wm,
      menubar: this.menubar,
      registry: this.registry,
      home: () => this.home,
      notify: (title, body) => this.notify(title, body),
      transfer: { importInto: (dest, o) => this.importInto(dest, o), exportPath: (path, o) => this.exportPath(path, o) },
      changed: () => this.scheduleSave(),
      showMenus: (win) => this.showMenus(win),
    })
    this.dock = new Dock(
      this.wm,
      this.registry,
      {
        launch: (id) => void this.apps.launch(id),
        quit: (id) => {
          const inst = this.apps.instances.get(id)
          if (inst) void this.apps.quit(inst)
        },
        newWindow: (id) => void this.apps.launch(id, { newWindow: true }),
        reveal: (id) => void this.apps.deliver(APP.finder, 'reveal', this.registry.get(id)?.path ?? '/Applications'),
        openApps: () => this.appGrid.toggle(),
        openTrash: () => void this.apps.deliver(APP.finder, 'reveal', `${this.home}/.Trash`),
        pin: (items) => void this.setDock({ items }),
        trashEmpty: () => (void this.emptyTrash(), true),
      },
      () => new Set([...this.apps.instances.values()].filter((i) => !i.dead && i.windows.size > 0).map((i) => i.app.id)),
    )
    this.appGrid = new AppGrid(this.registry, (id) => void this.apps.launch(id))
    this.notes = new Notifications(kernel, this.registry, (id) => void this.apps.launch(id))
    this.launcher = new Launcher(kernel, this.registry, this.apps, (p) => void this.openPath(p), (p) => void this.apps.deliver(APP.finder, 'reveal', p))
    this.mission = new MissionControl(this.wm, this.registry)
    this.lock = new LockScreen(kernel, () => this.home.slice(this.home.lastIndexOf('/') + 1))
    this.surface = new DesktopSurface(kernel, this.apps, (p) => void this.openPath(p), (p) => void this.apps.deliver(APP.finder, 'reveal', p), (id) => void this.apps.launch(id))
    this.status = new StatusBar(kernel, this.menubar, this.notes, () => this.launcher.toggle())
    root.append(this.surface.el, area, this.menubar.el, this.dock.el)
    // the windows layer lets clicks through, so a click on the bare desktop reaches the surface
    this.surface.el.addEventListener('pointerdown', () => (this.wm.blur(), this.menubar.close()))
    this.wm.on((e) => {
      if (e.type === 'focused') this.showMenus(e.win)
      else if (e.type === 'blur' || (e.type === 'closed' && !this.wm.focused)) this.menubar.setApp('', [])
      if (e.type !== 'titled') this.scheduleSave()
    })
    document.addEventListener('keydown', (e) => {
      if (e.metaKey && e.key.toLowerCase() === 'q' && this.wm.focused) {
        const inst = [...this.apps.instances.values()].find((i) => [...i.windows].some((w) => w.win === this.wm.focused))
        if (inst) {
          e.preventDefault()
          void this.apps.quit(inst)
        }
      }
    })
  }

  /** Read settings, install the apps that ship with Pear, and follow the settings that change how Desktop looks. */
  async start(): Promise<void> {
    const k = this.kernel
    const passwd = await k.readFile('/etc/passwd').then((b) => new TextDecoder().decode(b), () => '')
    const line = passwd.split('\n').map((l) => l.split(':')).find((f) => f[2] && f[2] !== '0')
    if (line) {
      this.user = { uid: Number(line[2]), gid: Number(line[3]) }
      this.home = line[4] ?? this.home
    }
    await this.registry.installBundled()
    const apply = async () => {
      const appearance = String(await k.configGet('tiny.system', 'appearance', 'auto'))
      const dark = appearance === 'dark' || (appearance === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
      const root = document.documentElement
      root.dataset.theme = dark ? 'dark' : 'light'
      root.style.setProperty('--accent', ACCENTS[String(await k.configGet('tiny.system', 'accentColor', 'blue'))] ?? ACCENTS.blue!)
      root.dataset.reduceMotion = String(await k.configGet('tiny.system', 'reduceMotion', false))
      const locale = String(await k.configGet('tiny.system', 'locale', 'en-US'))
      this.menubar.setLocale(locale, String(await k.configGet('tiny.system', 'timezone', 'auto')))
      this.apps.locale = locale
      await this.applyDock()
      await this.surface.applyWallpaper()
      this.launcher.setShortcut(String(await k.configGet('tiny.desktop.launcher', 'shortcut', 'Alt+Space')))
      this.apps.broadcastTheme()
    }
    await apply()
    await this.surface.start(this.home, this.user)
    await Promise.all([this.notes.start(), this.status.start(), this.launcher.registerProvider(), this.lock.start()]).catch((e) => console.warn('shell services:', e))
    void this.watchFiles()
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void apply())
    k.onEvent((e) => {
      if (e.type === 'config' && e.event === 'changed' && (e.change.domain === 'tiny.system' || e.change.domain.startsWith('tiny.desktop.'))) void apply()
    })
  }

  // ---- dock settings

  private async applyDock(): Promise<void> {
    const k = this.kernel
    const items = (await k.configGet('tiny.desktop.dock', 'items', [])) as string[]
    const s: Partial<DockSettings> = {
      items: items.length ? items : DEFAULT_DOCK,
      size: Number(await k.configGet('tiny.desktop.dock', 'size', 48)),
      position: String(await k.configGet('tiny.desktop.dock', 'position', 'bottom')) as DockSettings['position'],
      autohide: Boolean(await k.configGet('tiny.desktop.dock', 'autohide', false)),
      magnification: Boolean(await k.configGet('tiny.desktop.dock', 'magnification', true)),
    }
    this.dock.configure(s)
  }

  private async setDock(s: Partial<DockSettings>): Promise<void> {
    for (const [key, value] of Object.entries(s)) await this.kernel.configSet('tiny.desktop.dock', key, value)
    await this.kernel.configFlush()
  }

  // ---- opening things

  /** Open a file, folder or URL with its default app, as a double-click does. */
  async openPath(target: string): Promise<void> {
    try {
      await this.kernel.launchOpen(target)
    } catch (e) {
      this.notify('Cannot open', (e as Error).message)
    }
  }

  notify(title: string, body: string): void {
    void this.kernel.lookup('tiny.notifications').then((port) => this.kernel.request(port, { op: 'post', title, body }, { timeout: 4000 })).catch(() => console.warn(title, body))
  }

  private showMenus(win: Win): void {
    const menus = this.apps.menusFor(win)
    const app = this.registry.get(win.appId)
    if (!menus || !app) return this.menubar.setApp('', [])
    const windowMenu: Menu = {
      title: 'Window',
      items: [
        { label: 'Minimize', shortcut: '⌘M', action: () => win.minimize() },
        { label: 'Zoom', action: () => win.toggleMaximize(), disabled: !win.resizable },
        { separator: true },
        ...this.wm.wins.map((w) => ({ label: w.title, action: () => this.wm.focus(w) })),
      ],
    }
    this.menubar.setApp(app.name, [...menus, windowMenu])
  }

  // ---- the Pear menu

  private systemMenu(): Menu {
    const k = this.kernel
    const set = (key: string, v: string) => void k.configSet('tiny.system', key, v).then(() => k.configFlush())
    const session = (op: string) => void k.lookup('tiny.session').then((port) => k.request(port, { op }, { timeout: 8000 })).catch(() => {})
    return {
      title: 'Pear',
      icon: ICONS.pear,
      items: [
        { label: 'About This Pear', action: () => void this.apps.launch(APP.about) },
        { label: 'Profile', action: () => void this.apps.launch(APP.profile) },
        { label: 'System Settings…', action: () => void this.apps.launch(APP.settings) },
        { separator: true },
        { label: 'Search…', shortcut: '⌥Space', action: () => this.launcher.toggle() },
        { label: 'Mission Control', shortcut: '⌃↑', action: () => this.mission.toggle() },
        { separator: true },
        { label: 'Appearance: Light', action: () => set('appearance', 'light') },
        { label: 'Appearance: Dark', action: () => set('appearance', 'dark') },
        { label: 'Appearance: Automatic', action: () => set('appearance', 'auto') },
        { separator: true },
        { label: 'Lock Screen', action: () => void this.lock.lock() },
        { label: 'Restart…', action: () => session('restart') },
        { label: 'Shut Down…', action: () => session('shutdown') },
      ],
    }
  }

  // ---- watching the user's files: the desktop icons and the Trash

  private async watchFiles(): Promise<void> {
    const k = this.kernel
    const checkTrash = async () => {
      const full = (await k.readdir(`${this.home}/.Trash`).catch(() => [])).length > 0
      if (full !== this.trashFull) {
        this.trashFull = full
        this.dock.setTrashFull(full)
      }
    }
    await checkTrash()
    await k.takeEvents().catch(() => []) // start from now
    setInterval(async () => {
      const events = await k.takeEvents().catch(() => [])
      if (!events.length) return
      const touches = (dir: string) => events.some((e) => e.path.startsWith(`${dir}/`) || e.path === dir || e.oldPath?.startsWith(`${dir}/`))
      if (touches(`${this.home}/.Trash`)) void checkTrash()
      if (touches(`${this.home}/Desktop`)) void this.surface.refresh()
    }, 1000)
  }

  async emptyTrash(): Promise<void> {
    const trash = `${this.home}/.Trash`
    for (const e of await this.kernel.readdir(trash).catch(() => [])) await this.kernel.removeAll(`${trash}/${e.name}`).catch(() => {})
  }

  // ---- host files

  private async chown(paths: string[]): Promise<void> {
    for (const p of paths) {
      // the file and any folders created for it belong to the user, not to Desktop (which acts as the system)
      let dir = p
      while (dir.startsWith(`${this.home}/`) && dir !== this.home) {
        if ((await this.kernel.stat(dir).catch(() => null))?.uid === this.user.uid) break
        await this.kernel.chown(dir, this.user.uid, this.user.gid).catch(() => {})
        dir = dir.slice(0, dir.lastIndexOf('/'))
      }
    }
  }

  async importInto(dest: string, o: { directory?: boolean }): Promise<string[]> {
    const session = o.directory ? await transfer.importDirectory() : await transfer.importPick({ multiple: true })
    if (!session.items.length && !session.emptyDirs.length) return []
    const written = await transfer.importCommit(this.kernel, session, dest)
    await this.chown(written)
    return written
  }

  async exportPath(path: string, o: { saveAs?: boolean }): Promise<void> {
    const st = await this.kernel.stat(path)
    if (st.kind === 'dir') await transfer.exportDirectory(this.kernel, path, o)
    else await transfer.exportFile(this.kernel, path, o)
  }

  // ---- session

  private async snapshot(): Promise<SavedSession> {
    const windows: SavedWindow[] = []
    for (const w of this.wm.wins) {
      if (!this.registry.get(w.appId)) continue
      windows.push({
        appId: w.appId,
        ...w.rect,
        ...(w.maximized && w.restoreRect ? w.restoreRect : {}),
        maximized: w.maximized,
        minimized: w.minimized,
        state: await this.apps.saveState(w),
      })
    }
    return { windows, focused: this.wm.focused ? this.wm.wins.indexOf(this.wm.focused) : null }
  }

  private scheduleSave(): void {
    if (this.restoring) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.saveNow(), 600)
  }

  async saveNow(): Promise<void> {
    const port = await this.kernel.lookup('tiny.session').catch(() => null)
    if (port === null) return
    await this.kernel.request(port, { op: 'save', state: await this.snapshot() }, { timeout: 5000 }).catch(() => {})
  }

  /** The session service asks for the desktop's state when it saves (page hidden, autosave, shutdown). */
  async serveSessionManager(): Promise<void> {
    const k = this.kernel
    const service = await k.lookup('tiny.session')
    const mine = await k.portCreate()
    await k.request(service, { op: 'registerSessionManager' }, { rights: [mine], timeout: 5000 })
    void (async () => {
      for (;;) {
        const m = await k.receive(mine).catch(() => null)
        if (!m) return
        if (m.replyTo !== null) void this.snapshot().then((state) => k.send(m.replyTo!, { state })).catch(() => {})
      }
    })()
  }

  async restore(saved: SavedSession): Promise<void> {
    this.restoring = true
    try {
      const wins: Array<Win | null> = []
      for (const s of saved.windows ?? []) {
        const aw = await this.apps.launch(s.appId, { state: s.state, rect: { x: s.x, y: s.y, width: s.width, height: s.height }, newWindow: true })
        const w = aw?.win ?? null
        if (w) {
          w.rect = this.wm.clamp({ x: s.x, y: s.y, width: s.width, height: s.height })
          w.apply()
          if (s.maximized) this.wm.toggleMaximize(w)
          if (s.minimized) this.wm.minimize(w)
        }
        wins.push(w)
      }
      const f = saved.focused !== null ? wins[saved.focused] : undefined
      if (f && !f.minimized) this.wm.focus(f)
    } finally {
      this.restoring = false
      this.scheduleSave()
    }
  }

  /** First run: what to show. */
  async firstRun(): Promise<void> {
    await this.apps.launch(APP.profile)
  }
}

const ACCENTS: Record<string, string> = { blue: '#007aff', purple: '#af52de', pink: '#ff2d55', red: '#ff3b30', orange: '#ff9500', green: '#28a745', graphite: '#8e8e93' }
