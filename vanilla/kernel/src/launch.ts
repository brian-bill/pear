/// Launch services: which app opens what, and starting it. Knows the installed bundles, the file type system,
/// the user's default apps, and which apps are running.
import { BUNDLE_ID, type BundleInfo, type BundleKind, type BundleManager, type DocumentType } from './bundle'
import type { Config } from './config'
import { SysError } from './errors'
import { O, type FileSystem } from './fs'
import type { Permissions, Subject } from './perm'
import { INIT_PID, type ExitStatus, type ProcessTable } from './process'
import { SNIFF_BYTES, type TypeConflict, type TypeInfo, type TypeRegistry } from './uti'
import type { UserDb } from './users'

export interface AppRecord {
  id: string
  name: string
  version: string
  kind: BundleKind
  path: string
  icon: string | null
  singleInstance: boolean
  documentTypes: DocumentType[]
  urlSchemes: string[]
  system: boolean
}

export interface RunningApp {
  id: string
  name: string
  pids: number[]
  since: number
}

export interface OpenOptions {
  /** Open with this app (bundle id) instead of the default. */
  app?: string
  /** Extra arguments for a new instance. */
  args?: string[]
  /** Start without asking the app to come to the front (the `activated` event is not sent). */
  background?: boolean
}

export interface RecentItem {
  target: string
  appId: string
  time: number
}

export type LaunchEvent =
  | { type: 'launch'; event: 'launched'; appId: string; pid: number; kind: BundleKind; background: boolean }
  | { type: 'launch'; event: 'activated'; appId: string; pid: number }
  | { type: 'launch'; event: 'terminated'; appId: string; pid: number; kind: BundleKind | null; last: boolean; status: ExitStatus }

/** What a running app receives (on the port it registered as `app.<id>`) when something is opened with it. */
type OpenMessage =
  | { type: 'openFile'; path: string }
  | { type: 'openURL'; url: string }
  | { type: 'activate' }

const LAUNCH_DOMAIN = 'tiny.launch'
const MAX_RECENTS = 30
/** How long a program gets to fail loading before launch counts as successful. */
const LAUNCH_GRACE_MS = 150
const URL_TARGET = /^[A-Za-z][A-Za-z0-9+.-]*:/

const isUrl = (target: string) => URL_TARGET.test(target)
const schemeOf = (url: string) => url.slice(0, url.indexOf(':')).toLowerCase()

const record = (b: BundleInfo): AppRecord => ({
  id: b.id,
  name: b.name,
  version: b.version,
  kind: b.kind,
  path: b.path,
  icon: b.iconPath,
  singleInstance: b.singleInstance,
  documentTypes: structuredClone(b.documentTypes),
  urlSchemes: [...b.urlSchemes],
  system: b.system,
})

/** What to draw for a file, app or type. Desktop picks the artwork: `path` (an image in the VFS) if there is one, else the symbolic `name`. */
export interface IconInfo {
  source: 'app' | 'custom' | 'document' | 'type'
  /** Symbolic name from the type hierarchy: `folder`, `app`, `image`, `text`, `code`, `json`, `markdown`, `audio`, `video`, `archive`, `pdf`, `alias`, `document`. */
  name: string
  path: string | null
  uti: string | null
  description: string
}

/** First match along a type's conformance chain wins. */
const SYMBOLIC: Array<[string, string]> = [
  ['com.apple.application-bundle', 'app'], ['public.folder', 'folder'], ['public.directory', 'folder'], ['public.symlink', 'alias'],
  ['net.daringfireball.markdown', 'markdown'], ['public.json', 'json'], ['public.html', 'html'], ['com.adobe.pdf', 'pdf'],
  ['public.zip-archive', 'archive'], ['public.archive', 'archive'],
  ['public.source-code', 'code'], ['public.image', 'image'], ['public.audio', 'audio'], ['public.movie', 'video'], ['public.text', 'text'],
]

const symbolic = (type: TypeInfo): string => {
  for (const u of type.conformsTo) {
    const hit = SYMBOLIC.find(([k]) => k === u)
    if (hit) return hit[1]
  }
  return 'document'
}

export class LaunchServices {
  private starting = new Map<string, Promise<number>>()

  constructor(
    private fs: FileSystem,
    private procs: ProcessTable,
    private bundles: BundleManager,
    private types: TypeRegistry,
    private config: Config,
    private perms: Permissions,
    private users: UserDb,
    private emit: (e: LaunchEvent) => void,
  ) {}

  // ------------------------------------------------------------------ queries

  apps(): AppRecord[] {
    return this.bundles.list().filter((b) => b.kind === 'app').map(record)
  }

  /** Name of the app's port: a running app listens on it for open requests. */
  static portName = (appId: string) => `app.${appId}`

  async typeOf(path: string, caller: Subject | null = null): Promise<TypeInfo> {
    if (caller) await this.perms.checkFs(caller, 'stat', [path])
    const st = await this.fs.stat(path)
    // A link is its target: name it by where it leads.
    const real = await this.fs.realpath(path)
    const name = real.slice(real.lastIndexOf('/') + 1)
    let head: Uint8Array | undefined
    if (st.kind === 'file' && !this.types.fromExtension(name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : null) && st.size > 0) {
      if (caller) await this.perms.checkFs(caller, 'open', [real, O.RDONLY])
      const fd = await this.fs.open(real, O.RDONLY)
      try {
        head = await this.fs.read(fd, SNIFF_BYTES, 0)
      } finally {
        await this.fs.close(fd)
      }
    }
    return this.types.classify({ name, kind: st.kind, head })
  }

  /**
   * The icon for a bundle id, a path, or a type name. An app shows its own icon; a file shows `user.icon` (an image
   * path or a symbolic name, set by the user), else the icon its default app gives that kind of document, else a
   * symbolic name from the type hierarchy.
   */
  async iconFor(target: string, caller: Subject | null = null): Promise<IconInfo> {
    const app = !target.startsWith('/') ? this.bundles.find(target) : undefined
    if (app) return { source: 'app', name: 'app', path: app.iconPath, uti: 'com.apple.application-bundle', description: app.name }
    if (!target.startsWith('/')) {
      const type = this.types.info(target)
      return { source: 'type', name: symbolic(type), path: await this.documentIcon(type, null), uti: type.uti, description: type.description }
    }
    const type = await this.typeOf(target, caller)
    if (type.uti === 'com.apple.application-bundle') {
      const owner = this.bundles.owning(target)
      if (owner && owner.path === target) return { source: 'app', name: 'app', path: owner.iconPath, uti: type.uti, description: owner.name }
    }
    try {
      const custom = await this.fs.getxattr(target, 'user.icon')
      if (custom) {
        const isPath = custom.startsWith('/') && (await this.fs.exists(custom))
        return { source: 'custom', name: isPath ? symbolic(type) : custom, path: isPath ? custom : null, uti: type.uti, description: type.description }
      }
    } catch {
      // no extended attributes here (a host folder): fall through
    }
    return { source: 'type', name: symbolic(type), path: await this.documentIcon(type, type.ext), uti: type.uti, description: type.description }
  }

  /** The icon a document type of the default (or best) app brings, if it ships one. */
  private async documentIcon(type: TypeInfo, ext: string | null): Promise<string | null> {
    const app = this.defaultFor(type.uti) ?? (await this.appsFor(type.uti)).find(Boolean) ?? null
    const info = app ? this.bundles.find(app.id) : undefined
    if (!info) return null
    for (const d of info.documentTypes) {
      if (!d.icon) continue
      const covers = (ext && d.ext.includes(ext)) || (d.uti && type.conformsTo.includes(d.uti))
      if (!covers) continue
      const path = `${info.path}/${d.icon}`
      if (await this.fs.exists(path)) return path
    }
    return null
  }

  typeConflicts(): TypeConflict[] {
    return this.types.conflicts()
  }

  /** The user picks which type an extension means. `null` returns to install order. Remembered across restarts. */
  async setTypeOwner(ext: string, uti: string | null): Promise<void> {
    if (!/^[A-Za-z0-9_+-]{1,16}$/.test(ext)) throw new SysError('EINVAL', 'ext must be an extension without a dot')
    const map = { ...this.typeOverrides() }
    if (uti === null) delete map[ext.toLowerCase()]
    else {
      if (!this.types.conformances(uti).length || this.types.info(uti).uti !== uti) throw new SysError('ENOENT', `unknown type ${uti}`)
      map[ext.toLowerCase()] = uti
    }
    this.config.set(LAUNCH_DOMAIN, 'typeOverrides', map, 'user')
    this.types.setOverride(ext, uti)
  }

  applyTypeOverrides(): void {
    for (const [ext, uti] of Object.entries(this.typeOverrides())) this.types.setOverride(ext, uti)
  }

  private typeOverrides(): Record<string, string> {
    return (this.config.get(LAUNCH_DOMAIN, 'typeOverrides', {}) ?? {}) as unknown as Record<string, string>
  }

  /** Installed apps that can open a path, a URL, or a type, best match first. */
  async appsFor(target: string): Promise<AppRecord[]> {
    let scheme: string | null = null
    let type: TypeInfo | null = null
    let ext: string | null = null
    if (isUrl(target)) scheme = schemeOf(target)
    else if (target.startsWith('/')) {
      type = await this.typeOf(target)
      ext = type.ext
    } else type = this.types.info(target) // a type identifier

    const ranked: Array<{ app: BundleInfo; score: number }> = []
    for (const app of this.bundles.list()) {
      if (app.kind !== 'app') continue
      let score = 0
      if (scheme) score = app.urlSchemes.includes(scheme) ? 3 : 0
      else if (type) {
        for (const d of app.documentTypes) {
          if (d.role === 'none') continue
          const bonus = d.role === 'editor' ? 0.5 : 0
          // The types a document type stands for: its UTI, and what its extensions mean.
          const utis = [d.uti, ...d.ext.map((e) => this.types.fromExtension(e))].filter((u): u is string => Boolean(u))
          if (ext && d.ext.includes(ext)) score = Math.max(score, 3 + bonus)
          else if (utis.includes(type.uti)) score = Math.max(score, 2 + bonus)
          else {
            const nearest = Math.min(...utis.map((u) => type!.conformsTo.indexOf(u)).filter((i) => i >= 0))
            if (Number.isFinite(nearest)) score = Math.max(score, 1 + bonus - nearest / 100)
          }
        }
      }
      if (score > 0) ranked.push({ app, score })
    }
    const key = scheme ?? type?.uti
    const preferred = key ? this.defaultId(key, type?.conformsTo) : null
    ranked.sort((a, b) => (b.app.id === preferred ? 1 : 0) - (a.app.id === preferred ? 1 : 0) || b.score - a.score || a.app.name.localeCompare(b.app.name))
    return ranked.map((r) => record(r.app))
  }

  private defaults(): Record<string, string> {
    const v = this.config.get(LAUNCH_DOMAIN, 'defaults', {})
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  }

  private defaultId(key: string, conformsTo: string[] = [key]): string | null {
    const d = this.defaults()
    for (const k of conformsTo.includes(key) ? conformsTo : [key, ...conformsTo]) {
      const id = d[k]
      if (id && this.bundles.find(id)?.kind === 'app') return id
    }
    return null
  }

  /** The app the user chose for a type (`public.plain-text`) or URL scheme (`https`). A type uses the nearest type that has one. */
  defaultFor(typeOrScheme: string): AppRecord | null {
    const key = typeOrScheme.replace(/:$/, '')
    const id = this.defaultId(key, key.includes('.') ? this.types.conformances(key) : [key])
    return id ? record(this.bundles.find(id)!) : null
  }

  setDefault(typeOrScheme: string, appId: string): void {
    const app = this.bundles.find(appId)
    if (!app || app.kind !== 'app') throw new SysError('ENOENT', `no app with id ${appId}`)
    this.config.set(LAUNCH_DOMAIN, 'defaults', { ...this.defaults(), [typeOrScheme.replace(/:$/, '')]: appId })
  }

  running(): RunningApp[] {
    const by = new Map<string, RunningApp>()
    for (const p of this.procs.list()) {
      if (p.state !== 'running' || p.kind !== 'app' || !p.bundleId) continue
      const app = by.get(p.bundleId)
      if (app) {
        app.pids.push(p.pid)
        app.since = Math.min(app.since, p.startedAt)
      } else by.set(p.bundleId, { id: p.bundleId, name: this.bundles.find(p.bundleId)?.name ?? p.name, pids: [p.pid], since: p.startedAt })
    }
    return [...by.values()]
  }

  recents(appId?: string): RecentItem[] {
    const all = this.config.get(LAUNCH_DOMAIN, 'recents', []) as unknown as RecentItem[]
    return Array.isArray(all) ? all.filter((r) => !appId || r.appId === appId) : []
  }

  private addRecent(target: string, appId: string): void {
    const all = this.recents().filter((r) => !(r.target === target && r.appId === appId))
    all.unshift({ target, appId, time: Date.now() })
    this.config.set(LAUNCH_DOMAIN, 'recents', all.slice(0, MAX_RECENTS))
  }

  // ------------------------------------------------------------------ opening

  /**
   * Open a bundle id, a path, or a URL. Returns the pid that now has it (a new process, or the running instance).
   * A path is opened with `opts.app`, else the default app, else the best match. The app is also given access to
   * that one path (it chose to open it, like a file picked in a panel); `caller` must be able to read it.
   */
  async open(target: string, opts: OpenOptions = {}, caller: Subject | null = null): Promise<number> {
    if (typeof opts !== 'object' || opts === null) throw new SysError('EINVAL', 'options must be an object')
    if (opts.args !== undefined && (!Array.isArray(opts.args) || opts.args.some((a) => typeof a !== 'string'))) throw new SysError('EINVAL', 'args must be strings')

    if (isUrl(target)) {
      const scheme = schemeOf(target)
      const app = opts.app ? this.appById(opts.app) : (this.defaultFor(scheme) ?? (await this.appsFor(target))[0])
      if (!app) throw new SysError('ENOENT', `no app is registered for ${scheme}: links`)
      const pid = await this.start(this.bundles.find(app.id)!, [target], { type: 'openURL', url: target }, opts)
      this.addRecent(target, app.id)
      return pid
    }

    if (!target.startsWith('/')) {
      if (!BUNDLE_ID.test(target)) throw new SysError('EINVAL', 'target must be a bundle id, an absolute path, or a URL')
      const bundle = this.bundles.find(target)
      if (!bundle) throw new SysError('ENOENT', `no app with id ${target}`)
      return this.start(bundle, opts.args ?? [], null, opts)
    }

    if (caller) await this.perms.checkFs(caller, 'readFile', [target]).catch(async (e) => {
      // Folders are opened too (readdir would be the check), and `stat` says enough about a file you can see.
      if ((await this.fs.stat(target)).kind !== 'dir') throw e
      await this.perms.checkFs(caller, 'readdir', [target])
    })
    const st = await this.fs.stat(target)
    const owner = this.bundles.owning(target)
    if (owner && owner.path === target) return this.start(owner, opts.args ?? [], null, opts) // a .app bundle itself

    const type = await this.typeOf(target)
    const app = opts.app ? this.appById(opts.app) : (this.defaultFor(type.uti) ?? (await this.appsFor(target))[0])
    if (!app) throw new SysError('ENOENT', `no application is registered to open ${type.description.toLowerCase()} files (${type.uti})`)
    const bundle = this.bundles.find(app.id)!
    const role = bundle.documentTypes.find((d) => d.ext.includes(type.ext ?? '\0') || d.uti === type.uti)?.role
    this.perms.pickerGrant(app.id, target, { write: role === 'editor' && st.kind === 'file' })
    const pid = await this.start(bundle, [target, ...(opts.args ?? [])], { type: 'openFile', path: target }, opts)
    this.addRecent(target, app.id)
    return pid
  }

  async openWith(path: string, appId: string, caller: Subject | null = null): Promise<number> {
    return this.open(path, { app: appId }, caller)
  }

  /** Bring an app to the front, starting it if it is not running. */
  async activate(appId: string, _caller: Subject | null = null): Promise<number> {
    const app = this.bundles.find(appId)
    if (!app) throw new SysError('ENOENT', `no app with id ${appId}`)
    return this.start(app, [], { type: 'activate' }, {})
  }

  private appById(id: string): AppRecord {
    const b = this.bundles.find(id)
    if (!b || b.kind !== 'app') throw new SysError('ENOENT', `no app with id ${id}`)
    return record(b)
  }

  /** Hand a request to the running instance, or start the app. */
  private start(bundle: BundleInfo, args: string[], message: OpenMessage | null, opts: OpenOptions): Promise<number> {
    const running = this.procs.pidsOf(bundle.id)
    if (running.length && bundle.singleInstance) {
      const pid = running[0]!
      const port = this.procs.ports.find(LaunchServices.portName(bundle.id))
      if (message && port !== undefined) this.procs.ports.notify(port, message)
      if (!opts.background) this.emit({ type: 'launch', event: 'activated', appId: bundle.id, pid })
      return Promise.resolve(pid)
    }
    // Two opens racing for a single-instance app share one launch.
    const pending = bundle.singleInstance ? this.starting.get(bundle.id) : undefined
    if (pending) return pending
    const launch = this.spawn(bundle, args, opts).finally(() => this.starting.delete(bundle.id))
    if (bundle.singleInstance) this.starting.set(bundle.id, launch)
    return launch
  }

  /** Start a bundle's entry module as its process type: apps and tools are confined, system services trusted. */
  async spawn(bundle: BundleInfo, args: string[], opts: OpenOptions = {}): Promise<number> {
    const user = this.users.primary
    const trusted = bundle.kind === 'service' && bundle.system
    const pid = await this.procs.spawn(
      bundle.entryPath,
      {
        args,
        name: bundle.name,
        user: trusted ? 'root' : user.name,
        cwd: trusted ? '/' : bundle.container,
        env: {
          HOME: trusted ? '/var/root' : user.home,
          TINY_APP_ID: bundle.id,
          TINY_APP_PATH: bundle.path,
          TINY_APP_KIND: bundle.kind,
          PATH: '/bin:/Applications',
        },
        bundle: { id: bundle.id, kind: bundle.kind, trusted },
      },
      INIT_PID,
    )
    const ended = await this.procs.whenStarted(pid, LAUNCH_GRACE_MS)
    if (ended && ended.code !== 0) {
      const why = (ended.error ?? ended.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')
      throw new SysError('EIO', `${bundle.name} quit while starting (${ended.signal ?? `code ${ended.code}`})${why ? `: ${why}` : ''}`)
    }
    this.emit({ type: 'launch', event: 'launched', appId: bundle.id, pid, kind: bundle.kind, background: Boolean(opts.background) })
    return pid
  }

  /** Called when a process of a bundle ends. */
  exited(bundleId: string, pid: number, kind: BundleKind | null, last: boolean, status: ExitStatus): void {
    this.emit({ type: 'launch', event: 'terminated', appId: bundleId, pid, kind, last, status })
  }
}
