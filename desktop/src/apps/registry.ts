/// Which apps are installed, with their icons; and putting the apps that ship with Pear into `/Applications`.
import bundled from 'virtual:bundled-apps'
import type { Kernel } from '../../../vanilla/kernel/src/client'
import type { BundleInfo } from '../../../vanilla/kernel/src/bundle'

export type AppInfo = BundleInfo

const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const dec = new TextDecoder()

export class AppRegistry {
  private apps = new Map<string, AppInfo>()
  private icons = new Map<string, { ver: string; url: string }>()
  private listeners = new Set<() => void>()

  constructor(private kernel: Kernel) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Apps (not services or tools), by name. */
  list(): AppInfo[] {
    return [...this.apps.values()].filter((a) => a.kind === 'app').sort((a, b) => a.name.localeCompare(b.name))
  }
  get(id: string): AppInfo | undefined {
    return this.apps.get(id)
  }
  /** An `<img>`-ready URL for the app's icon, or null if it has none. Filled by `refresh`. */
  iconUrl(id: string): string | null {
    return this.icons.get(id)?.url ?? null
  }

  async refresh(): Promise<void> {
    const list = await this.kernel.bundleList()
    this.apps = new Map(list.map((b) => [b.id, b]))
    await Promise.all(list.filter((b) => b.kind === 'app' && b.iconPath && this.icons.get(b.id)?.ver !== `${b.version}:${b.iconPath}`).map(async (b) => {
      try {
        const bytes = await this.kernel.readFile(b.iconPath!)
        const ext = b.iconPath!.slice(b.iconPath!.lastIndexOf('.') + 1).toLowerCase()
        const old = this.icons.get(b.id)
        if (old) URL.revokeObjectURL(old.url)
        this.icons.set(b.id, { ver: `${b.version}:${b.iconPath}`, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? 'image/png' })) })
      } catch {
        // an unreadable icon is just no icon
      }
    }))
    for (const l of this.listeners) l()
  }

  /**
   * Put the apps that ship with Pear in `/Applications` (first boot), and bring them up to date when the build changed.
   * Their permissions are granted: the user chose Pear.
   */
  async installBundled(): Promise<void> {
    const installed = new Map((await this.kernel.bundleList()).map((b) => [b.id, b]))
    for (const app of bundled) {
      const have = installed.get(app.id)
      try {
        if (!have) await this.kernel.bundleInstall({ files: app.files }, { location: '/Applications', grant: true })
        else {
          const build = await this.kernel.readFile(`${have.path}/.build`).then((b) => dec.decode(b), () => '')
          if (build !== app.build) {
            await this.kernel.bundleUpdate(app.id, { files: app.files })
            // an update may declare more permissions than before
            for (const p of (JSON.parse(app.files['manifest.json']!).permissions ?? []) as string[]) await this.kernel.permGrant(app.id, p as never).catch(() => {})
          }
        }
      } catch (e) {
        console.error(`could not install ${app.name}:`, e)
      }
    }
    await this.refresh()
  }
}
