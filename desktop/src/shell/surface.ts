/// The desktop itself: wallpaper, the icons of `~/Desktop`, its context menu, and files dropped from the real
/// computer. It sits under the windows.
import type { Kernel } from '../../../vanilla/kernel/src/client'
import * as transfer from '../../../vanilla/kernel/src/host-transfer'
import type { AppHost } from '../apphost'
import { ICONS } from '../apps/icons'
import { showPopup } from './popup'
import type { MenuItem } from './menubar'

/** Built-in wallpapers: `builtin:<name>` in the `tiny.desktop.wallpaper` setting. */
export const WALLPAPERS: Record<string, { name: string; css?: string; url?: string; dark?: string }> = {
  'one-piece': { name: 'One Piece', url: '/wallpapers/one-piece-4k.jpg' },
  aurora: { name: 'Aurora', css: 'linear-gradient(135deg, #5b8def 0%, #8e6ee8 45%, #e07bb5 100%)', dark: 'linear-gradient(135deg, #1b2a4a 0%, #3a2a5c 50%, #5a2a48 100%)' },
  dusk: { name: 'Dusk', css: 'linear-gradient(160deg, #ff9966 0%, #ff5e62 50%, #5b247a 100%)' },
  graphite: { name: 'Graphite', css: 'linear-gradient(160deg, #6b7280 0%, #374151 60%, #111827 100%)' },
  forest: { name: 'Forest', css: 'linear-gradient(150deg, #a8e063 0%, #56ab2f 45%, #134e5e 100%)' },
  ocean: { name: 'Ocean', css: 'linear-gradient(150deg, #56ccf2 0%, #2f80ed 55%, #0b3c6f 100%)' },
}

/** What the desktop shows while `tiny.desktop.wallpaper.path` is unset. */
export const DEFAULT_WALLPAPER = 'one-piece'

interface Item {
  name: string
  path: string
  dir: boolean
}

export class DesktopSurface {
  readonly el: HTMLElement
  private iconsEl: HTMLElement
  private wallpaperUrl: string | null = null
  private items: Item[] = []
  private selected = new Set<string>()
  private home = '/Users/pear'
  private user = { uid: 501, gid: 20 }

  constructor(
    private kernel: Kernel,
    private apps: AppHost,
    private openPath: (path: string) => void,
    private reveal: (path: string) => void,
    private launch: (appId: string) => void,
  ) {
    this.el = Object.assign(document.createElement('div'), { className: 'surface' })
    this.iconsEl = Object.assign(document.createElement('div'), { className: 'desktop-icons' })
    this.iconsEl.setAttribute('role', 'listbox')
    this.iconsEl.setAttribute('aria-label', 'Desktop')
    this.el.append(this.iconsEl)
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el || e.target === this.iconsEl) this.select([])
    })
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target !== this.el && e.target !== this.iconsEl) return
      e.preventDefault()
      this.menu(e.clientX, e.clientY, null)
    })
    // files from the real computer, dropped on the desktop, land in ~/Desktop
    this.el.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    })
    this.el.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      void this.importDrop(e)
    })
  }

  async start(home: string, user: { uid: number; gid: number }): Promise<void> {
    this.home = home
    this.user = user
    await this.refresh()
  }

  // ---- wallpaper

  async applyWallpaper(): Promise<void> {
    const k = this.kernel
    const path = (await k.configGet('tiny.desktop.wallpaper', 'path', null)) as string | null
    const fit = String(await k.configGet('tiny.desktop.wallpaper', 'fit', 'fill'))
    const dark = document.documentElement.dataset.theme === 'dark'
    const style = document.getElementById('desktop')!.style
    if (this.wallpaperUrl) URL.revokeObjectURL(this.wallpaperUrl)
    this.wallpaperUrl = null
    const builtin = path?.startsWith('builtin:') ? WALLPAPERS[path.slice(8)] : undefined
    const size = fit === 'fit' ? 'contain' : fit === 'stretch' ? '100% 100%' : fit === 'center' ? 'auto' : 'cover'
    const fitStyle = `${fit === 'tile' ? 'repeat' : 'no-repeat'}`
    if (path && !builtin) {
      try {
        const bytes = await k.readFile(path)
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
        this.wallpaperUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}` }))
        style.background = `#000 url("${this.wallpaperUrl}") center / ${size} ${fitStyle}`
        return
      } catch {
        // missing or unreadable picture: fall back to the default
      }
    }
    const w = builtin ?? WALLPAPERS[DEFAULT_WALLPAPER]!
    if (w.url) style.background = `#000 url("${w.url}") center / ${size} ${fitStyle}`
    else style.background = (dark && w.dark) || w.css || WALLPAPERS.aurora!.css!
  }

  // ---- icons

  async refresh(): Promise<void> {
    const dir = `${this.home}/Desktop`
    const entries = await this.kernel.readdir(dir).catch(() => [])
    this.items = entries.filter((e) => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({ name: e.name, path: `${dir}/${e.name}`, dir: e.kind === 'dir' }))
    const icons = await Promise.all(this.items.map((i) => this.apps.icon(i.path).then((r) => r.url, () => null)))
    this.iconsEl.replaceChildren(...this.items.map((it, n) => this.icon(it, icons[n] ?? null)))
  }

  private icon(it: Item, url: string | null): HTMLElement {
    const el = document.createElement('div')
    el.className = `desktop-icon${this.selected.has(it.path) ? ' selected' : ''}`
    el.setAttribute('role', 'option')
    el.tabIndex = 0
    el.dataset.path = it.path
    el.innerHTML = `${url ? '<img alt="" draggable="false">' : (it.dir ? ICONS.folder : ICONS.file)}<span></span>`
    if (url) el.querySelector('img')!.src = url
    el.querySelector('span')!.textContent = it.name
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      this.select(e.metaKey || e.shiftKey ? [...this.selected, it.path] : [it.path])
    })
    el.addEventListener('dblclick', () => this.openPath(it.path))
    el.addEventListener('keydown', (e) => e.key === 'Enter' && this.openPath(it.path))
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!this.selected.has(it.path)) this.select([it.path])
      this.menu(e.clientX, e.clientY, it)
    })
    return el
  }

  private select(paths: string[]): void {
    this.selected = new Set(paths)
    this.iconsEl.querySelectorAll<HTMLElement>('.desktop-icon').forEach((el) => el.classList.toggle('selected', this.selected.has(el.dataset.path!)))
  }

  private menu(x: number, y: number, it: Item | null): void {
    const items: MenuItem[] = it
      ? [
          { label: 'Open', action: () => this.openPath(it.path) },
          { label: 'Show in Finder', action: () => this.reveal(it.path) },
          { separator: true },
          { label: 'Move to Trash', action: () => void this.trash([...this.selected]) },
        ]
      : [
          { label: 'New Folder', action: () => void this.newFolder() },
          { separator: true },
          { label: 'Open Desktop in Finder', action: () => this.reveal(`${this.home}/Desktop`) },
          { label: 'Open Terminal', action: () => this.launch('org.tiny.terminal') },
          { separator: true },
          { label: 'Change Wallpaper…', action: () => void this.apps.deliver('org.tiny.settings', 'openPane', 'desktop') },
        ]
    showPopup(items, { x, y })
  }

  private async newFolder(): Promise<void> {
    let name = 'untitled folder'
    for (let n = 2; await this.kernel.exists(`${this.home}/Desktop/${name}`); n++) name = `untitled folder ${n}`
    const path = `${this.home}/Desktop/${name}`
    await this.kernel.mkdir(path)
    await this.kernel.chown(path, this.user.uid, this.user.gid)
    await this.refresh()
  }

  private async trash(paths: string[]): Promise<void> {
    // into the user's Trash (Desktop acts as the system, whose own trash is elsewhere)
    const trash = `${this.home}/.Trash`
    for (const p of paths) {
      const name = p.slice(p.lastIndexOf('/') + 1)
      let target = `${trash}/${name}`
      for (let n = 2; await this.kernel.exists(target); n++) target = `${trash}/${name} ${n}`
      await this.kernel.rename(p, target).catch(() => {})
    }
    await this.refresh()
  }

  private async importDrop(e: DragEvent): Promise<void> {
    const session = await transfer.importFromDrop(e)
    const written = await transfer.importCommit(this.kernel, session, `${this.home}/Desktop`)
    for (const p of written) {
      // the file, and any folder made for it, belongs to the user
      let dir = p
      while (dir.startsWith(`${this.home}/Desktop/`)) {
        await this.kernel.chown(dir, this.user.uid, this.user.gid).catch(() => {})
        dir = dir.slice(0, dir.lastIndexOf('/'))
      }
    }
    await this.refresh()
  }
}
