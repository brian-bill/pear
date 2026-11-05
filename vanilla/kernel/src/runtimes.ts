/// Runtimes and frameworks: language runtimes are ordinary bundles of `kind: "runtime"`.
/// The kernel knows no language. This registry is rebuilt from the installed bundles' manifests; it answers "which
/// runtime runs this?", keeps the command shims in `/usr/local/bin` in step with what is installed, and checks `requires`.
import { SysError } from './errors'
import type { FileSystem } from './fs'
import type { BundleInfo, BundleManager, FrameworkProvides, Manifest, Requirement, RuntimeProvides } from './bundle'
import { compareVersions, satisfies } from './semver'
import type { TypeRegistry } from './uti'

const STATE_FILE = '/var/db/runtimes.json'
const SHIM_DIR = '/usr/local/bin'
/** First line of a command shim. The kernel recognises it when asked to run the file. */
export const SHIM_MARK = '#!pear-runtime-command'
/** Commands the system owns; a runtime may not shadow them. */
const SYSTEM_BIN = ['/bin', '/usr/bin']
const enc = new TextEncoder()
const dec = new TextDecoder()

export interface RuntimeInfo {
  name: string
  version: string
  bundleId: string
  bundleName: string
  /** The bundle directory. */
  path: string
  /** The launcher: the bundle's entry module. */
  launcher: string
  abi: string[]
  commands: string[]
  shebangs: string[]
  handles: RuntimeProvides['handles']
  /** Absolute path of the embed script, if it has one. */
  embed: string | null
  requires: Requirement[]
  /** This one is what `name` resolves to when no version is asked for. */
  default: boolean
  system: boolean
}

export interface FrameworkInfo {
  name: string
  version: string
  api: string | null
  bundleId: string
  path: string
  /** Absolute path of the library module. */
  module: string
}

export type RuntimeQuery = { name: string; range?: string } | { command: string } | { shebang: string } | { path: string }

export interface Unmet {
  kind: 'runtime' | 'framework'
  name: string
  range: string
  reason: string
}

interface State {
  /** runtime name -> bundle id chosen by the user */
  defaults: Record<string, string>
  /** command -> runtime name that owns its shim */
  commands: Record<string, string>
}

const join = (a: string, b: string) => (a === '/' ? `/${b}` : `${a}/${b}`)
const extOf = (path: string): string | null => {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null
}

export class RuntimeRegistry {
  private runtimes: RuntimeInfo[] = []
  private fws: FrameworkInfo[] = []
  private state: State = { defaults: {}, commands: {} }
  private loaded = false
  private chain: Promise<void> = Promise.resolve()
  /** Commands wanted by a runtime but held by another one: command -> [holder, wanted by]. */
  conflicts: Array<{ command: string; holder: string; wanted: string }> = []

  constructor(
    private fs: FileSystem,
    private bundles: BundleManager,
    private types: TypeRegistry,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(dec.decode(await this.fs.readFile(STATE_FILE))) as Partial<State>
      this.state = { defaults: { ...raw.defaults }, commands: { ...raw.commands } }
    } catch {
      this.state = { defaults: {}, commands: {} }
    }
  }

  // ------------------------------------------------------------------ rebuilding

  /** Rebuild from the installed bundles and bring the shims in line. Calls queue up; each sees the latest bundles. */
  sync(): Promise<void> {
    const run = this.chain.then(() => this.rebuild())
    this.chain = run.catch(() => {})
    return run
  }

  private async rebuild(): Promise<void> {
    await this.load()
    const all = this.bundles.list()
    this.fws = all
      .filter((b) => b.kind === 'framework' && b.provides)
      .map((b) => {
        const p = b.provides as FrameworkProvides
        return { name: p.framework, version: p.version, api: p.api ?? null, bundleId: b.id, path: b.path, module: join(b.path, p.module) }
      })
    const wanted = all.filter((b) => b.kind === 'runtime' && b.provides)
    // Defaults whose bundle is gone fall back to "highest version".
    for (const [name, id] of Object.entries(this.state.defaults)) if (!wanted.some((b) => b.id === id)) delete this.state.defaults[name]
    this.runtimes = wanted.map((b) => this.describe(b))
    // Command ownership: a claim stays while some installed runtime of that name still provides the command.
    const before = JSON.stringify(this.state)
    for (const [cmd, name] of Object.entries(this.state.commands)) {
      if (!this.runtimes.some((r) => r.name === name && r.commands.includes(cmd))) delete this.state.commands[cmd]
    }
    this.conflicts = []
    for (const r of this.runtimes) {
      for (const cmd of r.commands) {
        const holder = this.state.commands[cmd]
        if (!holder) this.state.commands[cmd] = r.name
        else if (holder !== r.name) this.conflicts.push({ command: cmd, holder, wanted: r.name })
      }
    }
    await this.writeShims()
    if (JSON.stringify(this.state) !== before) await this.save()
    this.runtimes = this.runtimes.map((r) => ({ ...r, default: this.best(r.name)?.bundleId === r.bundleId }))
  }

  private describe(b: BundleInfo): RuntimeInfo {
    const p = b.provides as RuntimeProvides
    return {
      name: p.name,
      version: p.version,
      bundleId: b.id,
      bundleName: b.name,
      path: b.path,
      launcher: b.entryPath,
      abi: p.abi,
      commands: p.commands,
      shebangs: p.shebangs,
      handles: p.handles,
      embed: p.embed ? join(b.path, p.embed) : null,
      requires: b.requires,
      default: false,
      system: b.system,
    }
  }

  private async save(): Promise<void> {
    await this.fs.mkdir('/var/db', { recursive: true })
    await this.fs.writeFile(STATE_FILE, enc.encode(JSON.stringify(this.state, null, 2)))
  }

  /** One shim per claimed command; shims for commands nobody claims any more are removed. */
  private async writeShims(): Promise<void> {
    await this.fs.mkdir(SHIM_DIR, { recursive: true })
    for (const [cmd, name] of Object.entries(this.state.commands)) {
      const path = join(SHIM_DIR, cmd)
      const text = `${SHIM_MARK} ${name}\n`
      const current = await this.fs.readFile(path).then((b) => dec.decode(b), () => null)
      if (current === text) continue
      if (current !== null && !current.startsWith(SHIM_MARK)) {
        // Something else owns the name: leave it alone and say so.
        this.conflicts.push({ command: cmd, holder: 'system', wanted: name })
        delete this.state.commands[cmd]
        continue
      }
      await this.fs.writeFile(path, enc.encode(text))
      await this.fs.chmod(path, 0o755)
    }
    for (const e of await this.fs.readdir(SHIM_DIR)) {
      if (e.kind !== 'file' || this.state.commands[e.name]) continue
      const head = await this.fs.readFile(join(SHIM_DIR, e.name)).then((b) => dec.decode(b.subarray(0, SHIM_MARK.length)), () => '')
      if (head === SHIM_MARK) await this.fs.unlink(join(SHIM_DIR, e.name)).catch(() => {})
    }
  }

  /** Refuse a runtime whose command is a system program (`ls`, `sh`). Runs before anything is placed. */
  async checkInstall(manifest: Manifest): Promise<void> {
    if (manifest.kind !== 'runtime') return
    for (const cmd of (manifest.provides as RuntimeProvides).commands) {
      for (const dir of SYSTEM_BIN) {
        if (await this.fs.exists(join(dir, cmd))) throw new SysError('EEXIST', `${manifest.name} provides "${cmd}", which is a system program (${join(dir, cmd)})`)
      }
    }
  }

  // ------------------------------------------------------------------ queries

  list(): RuntimeInfo[] {
    return structuredClone(this.runtimes)
  }

  frameworks(): FrameworkInfo[] {
    return structuredClone(this.fws)
  }

  /** Installed runtimes of `name` that satisfy `range`, best first: the user's default, then the highest version. */
  candidates(name: string, range?: string): RuntimeInfo[] {
    const pick = this.state.defaults[name]
    return this.runtimes
      .filter((r) => r.name === name && (!range || satisfies(r.version, range)))
      .sort((a, b) => (a.bundleId === pick ? -1 : b.bundleId === pick ? 1 : 0) || compareVersions(b.version, a.version) || a.bundleId.localeCompare(b.bundleId))
  }

  private best(name: string): RuntimeInfo | undefined {
    return this.candidates(name)[0]
  }

  info(name: string, range?: string): RuntimeInfo | null {
    const r = this.candidates(name, range)[0]
    return r ? structuredClone(r) : null
  }

  /** Does some installed runtime handle files with this extension? Cheap, so `spawn` can ask before reading a file. */
  handlesExtension(ext: string | null): boolean {
    return ext !== null && this.runtimes.some((r) => this.handles(r, ext))
  }

  private handles(r: RuntimeInfo, ext: string): boolean {
    const uti = this.types.fromExtension(ext)
    const kinds = uti ? this.types.info(uti, ext).conformsTo : []
    return r.handles.some((h) => h.ext.includes(ext) || (h.uti !== undefined && kinds.includes(h.uti)))
  }

  resolve(q: RuntimeQuery): RuntimeInfo | null {
    if ('name' in q) return this.info(q.name, q.range)
    if ('command' in q) {
      const name = this.state.commands[q.command]
      return name ? this.info(name) : null
    }
    if ('shebang' in q) {
      const hit = this.runtimes.find((r) => r.shebangs.includes(q.shebang))
      return hit ? this.info(hit.name) : null
    }
    const ext = extOf(q.path)
    const hit = ext ? this.runtimes.find((r) => this.handles(r, ext)) : undefined
    return hit ? this.info(hit.name) : null
  }

  /** Make `bundleId` the one `name` resolves to. */
  async setDefault(name: string, bundleId: string): Promise<void> {
    if (!this.runtimes.some((r) => r.name === name && r.bundleId === bundleId)) throw new SysError('ENOENT', `${bundleId} is not an installed ${name} runtime`)
    this.state.defaults[name] = bundleId
    await this.save()
    await this.sync()
  }

  /** What an app needs to run `name` inside its own sandbox: the embed script. `ENOSYS` if the runtime has none. */
  embed(name: string, range?: string): { name: string; version: string; bundleId: string; abi: string[]; scriptPath: string } {
    const r = this.candidates(name, range)[0]
    if (!r) throw new SysError('ENOENT', `no ${name} runtime is installed${range ? ` for ${range}` : ''}`)
    if (!r.abi.includes('embed') || !r.embed) throw new SysError('ENOSYS', `${r.bundleName} cannot be embedded`)
    return { name: r.name, version: r.version, bundleId: r.bundleId, abi: r.abi, scriptPath: r.embed }
  }

  framework(name: string, range?: string): FrameworkInfo | null {
    const best = this.fws
      .filter((f) => f.name === name && (!range || satisfies(f.version, range)))
      .sort((a, b) => compareVersions(b.version, a.version) || a.bundleId.localeCompare(b.bundleId))[0]
    return best ? structuredClone(best) : null
  }

  /** Requirements nothing installed satisfies. */
  unmet(requires: Requirement[]): Unmet[] {
    const out: Unmet[] = []
    for (const r of requires) {
      if (r.runtime !== undefined) {
        if (this.candidates(r.runtime, r.range).length) continue
        const have = this.runtimes.filter((x) => x.name === r.runtime).map((x) => x.version)
        out.push({ kind: 'runtime', name: r.runtime, range: r.range, reason: have.length ? `installed ${have.join(', ')} does not satisfy ${r.range}` : 'not installed' })
      } else if (r.framework !== undefined) {
        if (this.framework(r.framework, r.range)) continue
        const have = this.fws.filter((x) => x.name === r.framework).map((x) => x.version)
        out.push({ kind: 'framework', name: r.framework, range: r.range, reason: have.length ? `installed ${have.join(', ')} does not satisfy ${r.range}` : 'not installed' })
      }
    }
    return out
  }

  /** The frameworks a set of requirements resolves to, for the launcher's `PEAR_FRAMEWORKS`. */
  frameworksFor(requires: Requirement[]): Record<string, { version: string; path: string; module: string }> {
    const out: Record<string, { version: string; path: string; module: string }> = {}
    for (const r of requires) {
      if (r.framework === undefined) continue
      const f = this.framework(r.framework, r.range)
      if (f) out[f.name] = { version: f.version, path: f.path, module: f.module }
    }
    return out
  }
}
