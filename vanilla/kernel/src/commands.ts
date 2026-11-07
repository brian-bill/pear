/// Console apps: bundles that declare `commands`. The registry keeps one shim per command in `/usr/local/bin`
/// (`#!pear-command <bundle id> <name>`) in step with the installed bundles, and, for projects still being written,
/// development links in `~/.local/bin` (`#!pear-command-link <absolute path> <name>`). It reuses the runtime shim
/// mechanism: the kernel recognises the first line when asked to run the file (see `ProcessTable.resolveProgram`).
import { SysError } from './errors'
import type { FileSystem } from './fs'
import { COMMAND_NAME, parseManifest, type BundleInfo, type BundleManager, type CommandDecl, type Manifest } from './bundle'
import type { RuntimeRegistry } from './runtimes'
import type { UserDb } from './users'

const STATE_FILE = '/var/db/commands.json'
const SHIM_DIR = '/usr/local/bin'
/** First word of a command shim for an installed bundle. */
export const COMMAND_MARK = '#!pear-command'
/** First word of a development link shim. */
export const LINK_MARK = '#!pear-command-link'
const SYSTEM_BIN = ['/bin', '/usr/bin']
const enc = new TextEncoder()
const dec = new TextDecoder()

export interface CommandInfo {
  name: string
  summary: string | null
  bundleId: string
  bundleName: string
  /** Path of the file the command runs. */
  entry: string
  /** Who holds the name: an installed bundle, a development link, or a language runtime. */
  owner: { kind: 'bundle'; id: string } | { kind: 'link'; path: string } | { kind: 'runtime'; name: string }
  shim: string
  man: string | null
  completion: string | null
}

export interface LinkInfo {
  /** The project folder. */
  path: string
  bundleId: string
  name: string
  commands: string[]
  /** The folder or its manifest is gone. */
  broken: boolean
  /** Why it is broken. */
  reason?: string
}

export type CommandEvent =
  | { type: 'command'; event: 'registered' | 'unregistered'; name: string; owner: string }
  | { type: 'command'; event: 'taken-over'; name: string; from: string; to: string }
  | { type: 'command'; event: 'linked' | 'unlinked'; path: string }

export interface CommandConflict {
  name: string
  /** What holds the name now. */
  holder: string
  /** What wanted it. */
  wanted: string
}

interface State {
  /** command name -> bundle id of the installed bundle that holds it */
  owners: Record<string, string>
  /** project folders linked for development */
  links: string[]
}

const join = (a: string, b: string) => (a === '/' ? `/${b}` : `${a}/${b}`)
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

/** What a shim file says, or null if the text is not a command shim. */
export function parseShim(text: string): { kind: 'bundle'; id: string; name: string } | { kind: 'link'; path: string; name: string } | null {
  const line = text.split('\n')[0]!.trim()
  if (line.startsWith(`${LINK_MARK} `)) {
    // the project path may contain spaces: the command name is the last word
    const rest = line.slice(LINK_MARK.length + 1).trim()
    const cut = rest.lastIndexOf(' ')
    if (cut < 1) return null
    return { kind: 'link', path: rest.slice(0, cut).trim(), name: rest.slice(cut + 1) }
  }
  if (line.startsWith(`${COMMAND_MARK} `)) {
    const [id, name] = line.slice(COMMAND_MARK.length + 1).trim().split(/\s+/)
    return id && name ? { kind: 'bundle', id, name } : null
  }
  return null
}

export class CommandRegistry {
  private state: State = { owners: {}, links: [] }
  private loaded = false
  private chain: Promise<void> = Promise.resolve()
  /** Commands wanted by one bundle and held by another; the review lists them and the user may take over. */
  conflicts: CommandConflict[] = []
  private linked = new Map<string, { info: BundleInfo; broken: string | null }>()
  private byName = new Map<string, CommandInfo>()
  listeners: Array<(e: CommandEvent) => void> = []

  constructor(
    private fs: FileSystem,
    private bundles: BundleManager,
    private runtimes: RuntimeRegistry,
    private users: UserDb,
    private emit: (e: CommandEvent) => void,
  ) {}

  private fire(e: CommandEvent): void {
    this.emit(e)
    for (const l of this.listeners) l(e)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(dec.decode(await this.fs.readFile(STATE_FILE))) as Partial<State>
      this.state = { owners: { ...raw.owners }, links: Array.isArray(raw.links) ? raw.links.filter((x): x is string => typeof x === 'string') : [] }
    } catch {
      this.state = { owners: {}, links: [] }
    }
  }

  private async save(): Promise<void> {
    await this.fs.mkdir('/var/db', { recursive: true })
    await this.fs.writeFile(STATE_FILE, enc.encode(JSON.stringify(this.state, null, 2)))
  }

  private get linkDir(): string {
    return join(this.users.primary.home, '.local/bin')
  }

  // ------------------------------------------------------------------ install checks

  /** Refuse a bundle whose command is a system program. Runs before anything is placed. */
  async checkInstall(manifest: Manifest): Promise<void> {
    for (const c of manifest.commands) {
      for (const dir of SYSTEM_BIN) {
        if (await this.fs.exists(join(dir, c.name))) throw new SysError('EEXIST', `${manifest.name} declares the command "${c.name}", which is a system program (${join(dir, c.name)})`)
      }
    }
  }

  /** Conflicts a manifest would have with what is registered now (for the install review). */
  conflictsFor(manifest: Manifest): CommandConflict[] {
    const out: CommandConflict[] = []
    for (const c of manifest.commands) {
      const held = this.holderOf(c.name, manifest.id)
      if (held) out.push({ name: c.name, holder: held, wanted: manifest.id })
    }
    return out
  }

  /** Who holds `name` apart from `except`, as a readable label. */
  private holderOf(name: string, except?: string): string | null {
    const owner = this.state.owners[name]
    if (owner && owner !== except && this.bundles.find(owner)) return owner
    const rt = this.runtimes.resolve({ command: name })
    if (rt) return `runtime ${rt.name}`
    return null
  }

  // ------------------------------------------------------------------ rebuilding

  /** Rebuild from the installed bundles and links and bring the shims in line. Calls queue up; each sees the latest bundles. */
  sync(): Promise<void> {
    const run = this.chain.then(() => this.rebuild())
    this.chain = run.catch(() => {})
    return run
  }

  private async rebuild(): Promise<void> {
    await this.load()
    const before = new Map(this.byName)
    const saved = JSON.stringify(this.state)
    const all = this.bundles.list().filter((b) => b.commands.length)
    this.conflicts = []
    // A claim stays while its bundle is installed and still declares the command.
    for (const [name, id] of Object.entries(this.state.owners)) {
      const b = all.find((x) => x.id === id)
      if (!b || !b.commands.some((c) => c.name === name)) delete this.state.owners[name]
    }
    for (const b of all) {
      for (const c of b.commands) {
        const holder = this.state.owners[c.name]
        if (holder === b.id) continue
        const other = holder ?? this.runtimeHolder(c.name)
        if (other) {
          this.conflicts.push({ name: c.name, holder: other, wanted: b.id })
          continue
        }
        if (await this.systemHolds(c.name)) {
          this.conflicts.push({ name: c.name, holder: 'system', wanted: b.id })
          continue
        }
        this.state.owners[c.name] = b.id
      }
    }
    // A linked project that was installed since replaces its own link.
    await this.refreshLinks(this.bundles.list())
    this.byName.clear()
    for (const [name, id] of Object.entries(this.state.owners)) {
      const b = all.find((x) => x.id === id)!
      const c = b.commands.find((x) => x.name === name)!
      this.byName.set(name, this.describe(b, c, { kind: 'bundle', id: b.id }, join(SHIM_DIR, name)))
    }
    for (const l of this.linked.values()) {
      if (l.broken) continue
      for (const c of l.info.commands) if (!this.byName.has(c.name) || this.byName.get(c.name)!.owner.kind === 'link') this.byName.set(c.name, this.describe(l.info, c, { kind: 'link', path: l.info.path }, join(this.linkDir, c.name)))
    }
    await this.writeShims()
    // Only a change is written: an idle boot leaves the disk alone.
    if (JSON.stringify(this.state) !== saved) await this.save()
    for (const [name, info] of this.byName) if (!before.has(name)) this.fire({ type: 'command', event: 'registered', name, owner: ownerLabel(info) })
    for (const [name, info] of before) if (!this.byName.has(name)) this.fire({ type: 'command', event: 'unregistered', name, owner: ownerLabel(info) })
  }

  private runtimeHolder(name: string): string | null {
    const rt = this.runtimes.resolve({ command: name })
    return rt ? `runtime ${rt.name}` : null
  }

  private async systemHolds(name: string): Promise<boolean> {
    for (const dir of SYSTEM_BIN) if (await this.fs.exists(join(dir, name))) return true
    return false
  }

  private describe(b: BundleInfo, c: CommandDecl, owner: CommandInfo['owner'], shim: string): CommandInfo {
    return {
      name: c.name,
      summary: c.summary ?? null,
      bundleId: b.id,
      bundleName: b.name,
      entry: join(b.path, c.entry ?? b.entry),
      owner,
      shim,
      man: c.man ? join(b.path, c.man) : null,
      completion: c.completion ? join(b.path, c.completion) : null,
    }
  }

  /** One shim per registered command; shims of commands nobody holds are removed. A file that is not a command shim is never touched. */
  private async writeShims(): Promise<void> {
    await this.fs.mkdir(SHIM_DIR, { recursive: true })
    const wanted = new Map<string, string>() // path -> text
    for (const info of this.byName.values()) {
      if (info.owner.kind === 'bundle') wanted.set(join(SHIM_DIR, info.name), `${COMMAND_MARK} ${info.owner.id} ${info.name}\n`)
      else if (info.owner.kind === 'link') wanted.set(join(this.linkDir, info.name), `${LINK_MARK} ${info.owner.path} ${info.name}\n`)
    }
    for (const [path, text] of wanted) {
      const current = await this.fs.readFile(path).then((b) => dec.decode(b), () => null)
      if (current === text) continue
      if (current !== null && !parseShim(current)) {
        // Something else owns the name (not one of ours): leave it alone and report it.
        const name = path.slice(path.lastIndexOf('/') + 1)
        this.byName.delete(name)
        this.conflicts.push({ name, holder: 'system', wanted: text.split(' ')[1] ?? '' })
        continue
      }
      if (path.startsWith(this.linkDir)) await this.ensureLinkDir()
      await this.fs.writeFile(path, enc.encode(text))
      await this.fs.chmod(path, 0o755)
    }
    for (const dir of [SHIM_DIR, this.linkDir]) {
      const entries = await this.fs.readdir(dir).catch(() => [])
      for (const e of entries) {
        if (e.kind !== 'file') continue
        const path = join(dir, e.name)
        if (wanted.has(path)) continue
        const text = await this.fs.readFile(path).then((b) => dec.decode(b.subarray(0, 600)), () => '')
        const shim = parseShim(text)
        if (!shim) continue
        // Link shims of a broken link stay (they say the project is gone); everything else stale goes.
        if (shim.kind === 'link' && this.state.links.includes(shim.path)) continue
        await this.fs.unlink(path).catch(() => {})
      }
    }
  }

  private async ensureLinkDir(): Promise<void> {
    const user = this.users.primary
    await this.fs.as(user.uid, user.gid, async () => {
      await this.fs.mkdir(this.linkDir, { recursive: true, mode: 0o755 })
    })
  }

  // ------------------------------------------------------------------ links

  /** Read the linked projects' manifests again; drop links to projects that have since been installed. */
  private async refreshLinks(installed: BundleInfo[]): Promise<void> {
    this.linked.clear()
    const keep: string[] = []
    for (const path of this.state.links) {
      const state = await this.readProject(path)
      if (state.info && installed.some((b) => b.id === state.info!.id)) continue // installed now: the install replaces the link
      keep.push(path)
      this.linked.set(path, state.info ? { info: state.info, broken: null } : { info: this.placeholder(path), broken: state.reason })
    }
    this.state.links = keep
  }

  private placeholder(path: string): BundleInfo {
    return { path, name: path.slice(path.lastIndexOf('/') + 1), id: '', commands: [] } as unknown as BundleInfo
  }

  private async readProject(path: string): Promise<{ info: BundleInfo; reason?: undefined } | { info: null; reason: string }> {
    let text: string
    try {
      text = dec.decode(await this.fs.readFile(join(path, 'manifest.json')))
    } catch {
      return { info: null, reason: `linked project not found: ${path}` }
    }
    try {
      const manifest = parseManifest(text)
      if (manifest.kind !== 'app' && manifest.kind !== 'tool' && manifest.kind !== 'service') return { info: null, reason: `${manifest.name} is a ${manifest.kind}, which has no commands` }
      const entryPath = join(path, manifest.entry)
      if (!(await this.fs.exists(entryPath))) return { info: null, reason: `entry ${manifest.entry} is missing` }
      for (const c of manifest.commands) if (c.entry && !(await this.fs.exists(join(path, c.entry)))) return { info: null, reason: `command ${c.name}: entry ${c.entry} is missing` }
      const home = this.users.primary.home
      return {
        info: {
          ...manifest,
          path,
          entryPath,
          iconPath: null,
          container: `${home}/Library/Containers/${manifest.id}`,
          supportDir: `${home}/Library/Application Support/${manifest.id}`,
          verified: false,
          system: false,
        },
      }
    } catch (e) {
      return { info: null, reason: (e as Error).message }
    }
  }

  /** The development link's bundle record for permission lookups and service start: not shadowing an installed bundle. */
  linkedBundle(id: string): BundleInfo | undefined {
    for (const l of this.linked.values()) if (!l.broken && l.info.id === id) return l.info
    return this.dev.get(id)
  }

  /** Services started from a project folder (not linked, not installed): their bundle record, for permission lookups. */
  private dev = new Map<string, BundleInfo>()

  /** Read a project folder as a bundle that has not been installed. `EINVAL` with the reason if it cannot run. */
  async project(projectPath: string): Promise<BundleInfo> {
    const path = projectPath.replace(/\/+$/, '')
    const home = this.users.primary.home
    if (!path.startsWith(`${home}/`)) throw new SysError('EPERM', `a project may only be inside ${home}`)
    const state = await this.readProject(path)
    if (!state.info) throw new SysError('ENOENT', state.reason)
    if (this.bundles.find(state.info.id)) throw new SysError('EEXIST', `${state.info.id} is installed`)
    this.dev.set(state.info.id, state.info)
    return state.info
  }

  linkedAt(path: string): BundleInfo | undefined {
    const l = this.linked.get(path)
    return l && !l.broken ? l.info : undefined
  }

  /**
   * Register a project's commands for development: shims in `~/.local/bin` that run the files in place.
   * The project must be inside the user's home. A name held by a system program or an installed bundle's command is refused.
   */
  async link(projectPath: string): Promise<LinkInfo> {
    await this.load()
    const path = projectPath.replace(/\/+$/, '')
    const home = this.users.primary.home
    if (!path.startsWith(`${home}/`)) throw new SysError('EPERM', `a link may only point inside ${home}`)
    const state = await this.readProject(path)
    if (!state.info) throw new SysError('EINVAL', state.reason)
    const info = state.info
    if (!info.commands.length) throw new SysError('EINVAL', `${info.name} declares no commands`)
    for (const c of info.commands) {
      if (!COMMAND_NAME.test(c.name)) throw new SysError('EINVAL', `"${c.name}" is not a valid command name`)
      if (await this.systemHolds(c.name)) throw new SysError('EEXIST', `${c.name} is a system program`)
      const owner = this.state.owners[c.name]
      if (owner && this.bundles.find(owner)) throw new SysError('EEXIST', `${c.name} is a command of the installed bundle ${owner}`)
      const rt = this.runtimeHolder(c.name)
      if (rt) throw new SysError('EEXIST', `${c.name} is a command of ${rt}`)
      for (const [other, l] of this.linked) if (other !== path && !l.broken && l.info.commands.some((x) => x.name === c.name)) throw new SysError('EEXIST', `${c.name} is already linked from ${other}`)
    }
    if (this.bundles.find(info.id)) throw new SysError('EEXIST', `${info.id} is installed; update the installed bundle instead`)
    if (!this.state.links.includes(path)) this.state.links.push(path)
    await this.sync()
    this.fire({ type: 'command', event: 'linked', path })
    return this.linkInfo(path)
  }

  async unlink(projectPath: string): Promise<void> {
    await this.load()
    const path = projectPath.replace(/\/+$/, '')
    if (!this.state.links.includes(path)) throw new SysError('ENOENT', `${path} is not linked`)
    this.state.links = this.state.links.filter((p) => p !== path)
    // shims of a broken link are not rewritten by sync, so take them away here
    for (const e of await this.fs.readdir(this.linkDir).catch(() => [])) {
      const file = join(this.linkDir, e.name)
      const shim = await this.fs.readFile(file).then((b) => parseShim(dec.decode(b.subarray(0, 600))), () => null)
      if (shim?.kind === 'link' && shim.path === path) await this.fs.unlink(file).catch(() => {})
    }
    await this.sync()
    this.fire({ type: 'command', event: 'unlinked', path })
  }

  /** The links, checked against the disk now (a project can be moved or deleted at any time). */
  async links(): Promise<LinkInfo[]> {
    for (const path of this.state.links) {
      const state = await this.readProject(path)
      this.linked.set(path, state.info ? { info: state.info, broken: null } : { info: this.placeholder(path), broken: state.reason })
    }
    return this.state.links.map((p) => this.linkInfo(p))
  }

  private linkInfo(path: string): LinkInfo {
    const l = this.linked.get(path)
    return {
      path,
      bundleId: l?.info.id ?? '',
      name: l?.info.name ?? path.slice(path.lastIndexOf('/') + 1),
      commands: l?.info.commands.map((c) => c.name) ?? [],
      broken: !l || l.broken !== null,
      ...(l?.broken ? { reason: l.broken } : {}),
    }
  }

  // ------------------------------------------------------------------ queries

  list(): CommandInfo[] {
    return structuredClone([...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name)))
  }

  resolve(name: string): CommandInfo | null {
    const c = this.byName.get(name)
    if (c) return structuredClone(c)
    const rt = this.runtimes.resolve({ command: name })
    return rt
      ? { name, summary: null, bundleId: rt.bundleId, bundleName: rt.bundleName, entry: rt.launcher, owner: { kind: 'runtime', name: rt.name }, shim: join(SHIM_DIR, name), man: null, completion: null }
      : null
  }

  /** The user lets `bundleId` take `name` from its current holder (an installed bundle's command; never a system program). */
  async takeOver(name: string, bundleId: string): Promise<void> {
    await this.load()
    const b = this.bundles.find(bundleId)
    if (!b?.commands.some((c) => c.name === name)) throw new SysError('ENOENT', `${bundleId} does not declare ${name}`)
    if (await this.systemHolds(name)) throw new SysError('EEXIST', `${name} is a system program`)
    const from = this.state.owners[name]
    if (!from) {
      if (this.runtimeHolder(name)) throw new SysError('EEXIST', `${name} belongs to a language runtime`)
    } else if (from === bundleId) return
    this.state.owners[name] = bundleId
    await this.sync()
    this.fire({ type: 'command', event: 'taken-over', name, from: from ?? '', to: bundleId })
  }

  /**
   * What the kernel runs for a command shim: the bundle, the file, and the command name.
   * Errors carry the text the shell shows: `ENOENT` when the bundle or project is gone, `EIO` when it is damaged.
   */
  async target(shim: NonNullable<ReturnType<typeof parseShim>>): Promise<{ bundle: BundleInfo; entry: string; name: string; man: string | null; development: boolean }> {
    const lookup = (b: BundleInfo, development: boolean) => {
      const c = b.commands.find((x) => x.name === shim.name)
      if (!c) throw new SysError('ENOENT', `not a command of ${b.name} any more`)
      return { bundle: b, entry: join(b.path, c.entry ?? b.entry), name: shim.name, man: c.man ? join(b.path, c.man) : null, development }
    }
    if (shim.kind === 'bundle') {
      const b = this.bundles.find(shim.id)
      if (!b) throw new SysError('ENOENT', `${shim.id} is not installed`)
      const t = lookup(b, false)
      if (!(await this.fs.exists(t.entry))) throw new SysError('EIO', `cannot start: ${b.name} is damaged`)
      return t
    }
    const state = await this.readProject(shim.path)
    if (!state.info) throw new SysError('ENOENT', state.reason.startsWith('linked project not found') ? `${shim.name}: linked project not found: ${shim.path}` : `cannot start: ${state.reason}`)
    // keep the permission lookup current with what is on disk
    this.linked.set(shim.path, { info: state.info, broken: null })
    return lookup(state.info, true)
  }
}

const ownerLabel = (c: CommandInfo): string => (c.owner.kind === 'bundle' ? c.owner.id : c.owner.kind === 'link' ? `link:${c.owner.path}` : `runtime:${c.owner.name}`)
