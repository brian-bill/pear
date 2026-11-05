/// App bundles: a `.app` directory with a manifest, an entry module, and resources. Installing validates the
/// manifest and the content hashes in a staging directory, then moves the bundle into place in one rename.
import { SysError } from './errors'
import type { FileSystem } from './fs'
import { CAPABILITIES, type Capability } from './perm'
import type { TypeRegistry } from './uti'
import type { UserDb } from './users'
import { validRange } from './semver'

export const OS_VERSION = '1.0'
export const SYSTEM_APPS = '/System/Applications'
export const APPS = '/Applications'
export const SYSTEM_FRAMEWORKS = '/System/Library/Frameworks'
export const FRAMEWORKS = '/Library/Frameworks'
/** Where bundles may live. Only the system installs into `/System/...`. */
const BUNDLE_ROOTS = [SYSTEM_APPS, APPS]
const FRAMEWORK_ROOTS = [SYSTEM_FRAMEWORKS, FRAMEWORKS]

export type BundleKind = 'app' | 'service' | 'tool' | 'runtime' | 'framework'

/** What a `kind: "runtime"` bundle offers (`provides` in the manifest). */
export interface RuntimeProvides {
  /** `node`, `php`, `python`: what `requires` and `runtime.resolve` name. */
  name: string
  /** Version of the language runtime, not of the bundle. */
  version: string
  /** Ways it can be used: `program`, `embed`; others are carried and ignored. */
  abi: string[]
  commands: string[]
  shebangs: string[]
  handles: Array<{ ext: string[]; uti?: string }>
  /** Script inside the bundle an embedding app loads. */
  embed?: string
}

/** What a `kind: "framework"` bundle offers. */
export interface FrameworkProvides {
  framework: string
  version: string
  api?: string
  /** Library module inside the bundle (also its `entry`). */
  module: string
}

/** A runtime or framework a bundle needs (`requires` in the manifest). */
export interface Requirement {
  runtime?: string
  framework?: string
  range: string
}
export interface DocumentType {
  ext: string[]
  role: 'viewer' | 'editor' | 'none'
  uti?: string
  /** Icon (path inside the bundle) for documents of this type. */
  icon?: string
}

/** A file type the app introduces (`typeDefinitions` in the manifest). */
interface TypeDefinition {
  uti: string
  conformsTo: string[]
  mime?: string
  description?: string
  ext: string[]
}

interface WindowHints {
  title?: string
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  resizable?: boolean
  /** Open windows with no title bar chrome clutter (utilities); Desktop decides what that means. */
  utility?: boolean
}

/** The validated `manifest.json`. */
export interface Manifest {
  id: string
  name: string
  version: string
  minOS?: string
  entry: string
  kind: BundleKind
  icon?: string
  /** Desktop only: the page (inside the bundle) shown in the app's windows. Vanilla validates and carries it. */
  ui?: string
  /** Desktop only: how windows of the app start. */
  window?: WindowHints
  permissions: Capability[]
  /** Runtime and framework bundles: what they offer. */
  provides?: RuntimeProvides | FrameworkProvides
  /** Runtimes and frameworks this bundle needs. */
  requires: Requirement[]
  /** The language runtime that runs `entry` (not `pear`). */
  runtime?: string
  documentTypes: DocumentType[]
  typeDefinitions: TypeDefinition[]
  urlSchemes: string[]
  /** Opening a file while the app runs hands it to the running instance instead of starting another. Default for apps and services. */
  singleInstance: boolean
  /** Services only: start at boot. */
  autostart: boolean
  /** SHA-256 (hex) of bundle files, by path relative to the bundle. Every listed file must match. */
  hashes?: Record<string, string>
}

export interface BundleInfo extends Manifest {
  /** Absolute path of the `.app` directory. */
  path: string
  /** Absolute path of the entry module. */
  entryPath: string
  iconPath: string | null
  /** The app's private directories (`fs.container`). */
  container: string
  supportDir: string
  /** The manifest carries hashes and they all matched when it was last checked. */
  verified: boolean
  /** Shipped with the system: lives under `/System`. */
  system: boolean
}

export type BundleSource = { path: string } | { files: Record<string, string | Uint8Array> }

export interface VerifyResult {
  ok: boolean
  /** Files whose hash was checked. */
  checked: number
  problems: string[]
}

export type BundleEvent = { type: 'bundle'; event: 'installed' | 'removed' | 'updated'; id: string }

export const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/
const VERSION = /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/
const EXTENSION = /^[A-Za-z0-9_+-]{1,16}$/
const SCHEME = /^[a-z][a-z0-9+.-]*$/
const RESERVED_SCHEMES = new Set(['file', 'javascript', 'data', 'blob', 'about', 'vbscript'])
export const MAX_BUNDLE_FILES = 5000
const enc = new TextEncoder()
const dec = new TextDecoder()

const bad = (message: string): never => {
  throw new SysError('EINVAL', message)
}

function relative(path: unknown, what: string): string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0') || path.split('/').some((p) => p === '..' || p === '')) {
    bad(`${what} must be a relative path inside the bundle`)
  }
  return path as string
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const extensions = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'string' || !EXTENSION.test(e))) bad(`${what} must be a list of extensions without dots`)
  return (v as string[]).map((e) => e.toLowerCase())
}

const majorOf = (v: string) => parseInt(v, 10)

const NAME = /^[a-z][a-z0-9-]{0,31}$/
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/

const names = (v: unknown, re: RegExp, what: string): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !re.test(x))) bad(`${what} must be a list of plain names`)
  return [...new Set(v as string[])]
}

function parseProvides(kind: BundleKind, raw: unknown): RuntimeProvides | FrameworkProvides | undefined {
  if (kind !== 'runtime' && kind !== 'framework') {
    if (raw !== undefined) bad('only runtime and framework bundles have provides')
    return undefined
  }
  if (!isObject(raw)) return bad(`a ${kind} bundle needs provides`)
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) bad('provides.version must look like 20.18.0')
  if (kind === 'framework') {
    if (typeof raw.framework !== 'string' || !NAME.test(raw.framework)) bad('provides.framework must be a lowercase name')
    return {
      framework: raw.framework as string,
      version: raw.version as string,
      ...(typeof raw.api === 'string' ? { api: raw.api } : {}),
      module: relative(raw.module, 'provides.module'),
    }
  }
  if (typeof raw.name !== 'string' || !NAME.test(raw.name)) bad('provides.name must be a lowercase name like node')
  const handles: RuntimeProvides['handles'] = []
  if (raw.handles !== undefined && !Array.isArray(raw.handles)) bad('provides.handles must be a list')
  for (const h of (raw.handles ?? []) as Array<Record<string, unknown>>) {
    if (!isObject(h)) bad('provides.handles entries must be objects')
    if (h.uti !== undefined && typeof h.uti !== 'string') bad('provides.handles[].uti must be a string')
    const ext = extensions(h.ext ?? [], 'provides.handles[].ext')
    if (!ext.length && !h.uti) bad('a handled type needs ext or uti')
    handles.push({ ext, ...(h.uti ? { uti: h.uti as string } : {}) })
  }
  return {
    name: raw.name as string,
    version: raw.version as string,
    abi: names(raw.abi ?? ['program'], NAME, 'provides.abi'),
    commands: names(raw.commands, COMMAND, 'provides.commands'),
    shebangs: names(raw.shebangs, COMMAND, 'provides.shebangs'),
    handles,
    ...(raw.embed !== undefined ? { embed: relative(raw.embed, 'provides.embed') } : {}),
  }
}

function parseRequires(raw: unknown): Requirement[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) bad('requires must be a list')
  return (raw as unknown[]).map((r) => {
    if (!isObject(r)) return bad('requires entries must be objects')
    const { runtime, framework } = r
    if ((runtime === undefined) === (framework === undefined)) bad('a requirement names either a runtime or a framework')
    const name = runtime ?? framework
    if (typeof name !== 'string' || !NAME.test(name)) bad('a requirement needs a lowercase name')
    const range = r.range ?? '*'
    if (typeof range !== 'string' || !validRange(range)) bad(`requires: "${String(range)}" is not a version range`)
    return runtime !== undefined ? { runtime: name as string, range: range as string } : { framework: name as string, range: range as string }
  })
}

/** Check `manifest.json` content. Does not look at the files it names. */
export function parseManifest(text: string): Manifest {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    return bad('manifest.json is not valid JSON')
  }
  if (!isObject(raw)) bad('manifest.json must be an object')
  const id = raw.id
  if (typeof id !== 'string' || id.length > 128 || !BUNDLE_ID.test(id)) bad('id must be reverse-DNS, like com.example.notes')
  const name = raw.name
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\0/]/.test(name)) bad('name must be 1-64 characters without "/"')
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) bad('version must look like 1.2.0')
  if (raw.minOS !== undefined && (typeof raw.minOS !== 'string' || !VERSION.test(raw.minOS))) bad('minOS must look like 1.0')
  if (raw.minOS && majorOf(raw.minOS as string) > majorOf(OS_VERSION)) bad(`requires OS ${raw.minOS}, this is ${OS_VERSION}`)
  const kind = (raw.kind ?? 'app') as BundleKind
  if (!['app', 'service', 'tool', 'runtime', 'framework'].includes(kind)) bad('kind must be app, service, tool, runtime, or framework')
  const provides = parseProvides(kind, raw.provides)
  const entry = relative(kind === 'framework' ? (provides as FrameworkProvides).module : (raw.entry ?? 'main.js'), 'entry')
  if (raw.runtime !== undefined && (typeof raw.runtime !== 'string' || !NAME.test(raw.runtime))) bad('runtime must be a lowercase name like node (or pear)')
  if (raw.runtime !== undefined && raw.runtime !== 'pear' && kind !== 'app' && kind !== 'tool') bad('only apps and tools can name a runtime')
  const icon = raw.icon === undefined ? undefined : relative(raw.icon, 'icon')
  const ui = raw.ui === undefined ? undefined : relative(raw.ui, 'ui')
  let windowHints: WindowHints | undefined
  if (raw.window !== undefined) {
    const w = raw.window as Record<string, unknown>
    if (!isObject(w)) bad('window must be an object')
    const num = (k: string) => {
      const v = w[k]
      if (v === undefined) return undefined
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 50 || v > 10000) bad(`window.${k} must be a number from 50 to 10000`)
      return v as number
    }
    if (w.title !== undefined && (typeof w.title !== 'string' || w.title.length > 64)) bad('window.title must be text up to 64 characters')
    for (const k of ['resizable', 'utility']) if (w[k] !== undefined && typeof w[k] !== 'boolean') bad(`window.${k} must be true or false`)
    windowHints = { title: w.title as string | undefined, width: num('width'), height: num('height'), minWidth: num('minWidth'), minHeight: num('minHeight'), resizable: w.resizable as boolean | undefined, utility: w.utility as boolean | undefined }
  }

  const permissions = raw.permissions ?? []
  if (!Array.isArray(permissions)) bad('permissions must be a list')
  for (const p of permissions as unknown[]) if (!CAPABILITIES.includes(p as Capability)) bad(`unknown permission ${String(p)}`)

  const documentTypes: DocumentType[] = []
  if (!Array.isArray(raw.documentTypes ?? [])) bad('documentTypes must be a list')
  for (const d of (raw.documentTypes ?? []) as Array<Record<string, unknown>>) {
    const exts = extensions(d?.ext ?? [], 'documentTypes[].ext')
    if (d.uti !== undefined && typeof d.uti !== 'string') bad('documentTypes[].uti must be a string')
    if (!exts.length && !d.uti) bad('a document type needs ext or uti')
    const role = (d.role ?? 'viewer') as DocumentType['role']
    if (!['viewer', 'editor', 'none'].includes(role)) bad('documentTypes[].role must be viewer, editor, or none')
    const dicon = d.icon === undefined ? undefined : relative(d.icon, 'documentTypes[].icon')
    documentTypes.push({ ext: exts, role, uti: d.uti as string | undefined, ...(dicon ? { icon: dicon } : {}) })
  }
  const typeDefinitions: TypeDefinition[] = []
  if (!Array.isArray(raw.typeDefinitions ?? [])) bad('typeDefinitions must be a list')
  for (const t of (raw.typeDefinitions ?? []) as Array<Record<string, unknown>>) {
    if (typeof t?.uti !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(t.uti) || t.uti.startsWith('public.')) bad('typeDefinitions[].uti must be a reverse-DNS name (not public.*)')
    const conforms = t.conformsTo ?? ['public.data']
    if (!Array.isArray(conforms) || conforms.some((c) => typeof c !== 'string')) bad('typeDefinitions[].conformsTo must be a list of type names')
    const ext = extensions(t.ext ?? [], 'typeDefinitions[].ext')
    typeDefinitions.push({ uti: t.uti as string, conformsTo: conforms as string[], mime: typeof t.mime === 'string' ? t.mime : undefined, description: typeof t.description === 'string' ? t.description : undefined, ext })
  }

  const urlSchemes = (raw.urlSchemes ?? []) as unknown[]
  if (!Array.isArray(urlSchemes) || urlSchemes.some((s) => typeof s !== 'string' || !SCHEME.test(s) || RESERVED_SCHEMES.has(s))) {
    bad('urlSchemes must be lowercase scheme names (file:, javascript: and similar are reserved)')
  }

  let hashes: Record<string, string> | undefined
  if (raw.hashes !== undefined) {
    if (!isObject(raw.hashes)) bad('hashes must be an object')
    hashes = {}
    for (const [p, h] of Object.entries(raw.hashes as Record<string, unknown>)) {
      relative(p, 'hash path')
      if (typeof h !== 'string' || !/^[0-9a-f]{64}$/i.test(h)) bad(`hash for ${p} must be a SHA-256 in hex`)
      hashes[p] = (h as string).toLowerCase()
    }
  }
  return {
    id: id as string,
    name: (name as string).trim(),
    version: raw.version as string,
    minOS: raw.minOS as string | undefined,
    entry,
    kind,
    icon,
    ...(ui ? { ui } : {}),
    ...(windowHints ? { window: windowHints } : {}),
    permissions: [...new Set(permissions as Capability[])],
    ...(provides ? { provides } : {}),
    requires: parseRequires(raw.requires),
    ...(typeof raw.runtime === 'string' && raw.runtime !== 'pear' ? { runtime: raw.runtime } : {}),
    documentTypes,
    typeDefinitions,
    urlSchemes: urlSchemes as string[],
    singleInstance: typeof raw.singleInstance === 'boolean' ? raw.singleInstance : kind === 'app' || kind === 'service',
    autostart: raw.autostart === true && kind === 'service',
    hashes,
  }
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const dirName = (name: string, kind: BundleKind = 'app') => `${name.replace(/[\\:*?"<>|\0]/g, '-')}.${kind === 'framework' ? 'framework' : 'app'}`
const join = (a: string, b: string) => (a === '/' ? `/${b}` : `${a}/${b}`)

interface BundleHooks {
  /** Pids running the app. */
  running(id: string): number[]
  /** Ask the app to quit and wait for it (SIGTERM, then SIGKILL after a grace period). */
  quit(id: string): Promise<void>
  /** Runs on a staged bundle before it is placed; throwing refuses the install or update. */
  prepare?(manifest: Manifest, replacing: string | null): Promise<void>
  /** Runs (awaited) after the set of installed bundles changed. */
  changed?(): Promise<void>
}

export class BundleManager {
  private bundles = new Map<string, BundleInfo>()
  /** Bundles found on disk that could not be used, by path. */
  invalid = new Map<string, string>()
  private stage = 0

  constructor(
    private fs: FileSystem,
    private users: UserDb,
    readonly types: TypeRegistry,
    private emit: (e: BundleEvent) => void,
    private hooks: BundleHooks,
  ) {}

  list(): BundleInfo[] {
    return [...this.bundles.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((b) => structuredClone(b))
  }

  /** No copy: for the kernel's own use. */
  find(id: string): BundleInfo | undefined {
    return this.bundles.get(id)
  }

  info(id: string): BundleInfo {
    const b = this.bundles.get(id)
    if (!b) throw new SysError('ENOENT', `no app with id ${id}`)
    return structuredClone(b)
  }

  /** The bundle that owns a program path, if the path is inside an installed bundle. */
  owning(path: string): BundleInfo | undefined {
    return [...this.bundles.values()].find((b) => path === b.path || path.startsWith(`${b.path}/`))
  }

  /** Look for bundles in the install locations and rebuild the registry. */
  async scan(): Promise<void> {
    this.bundles.clear()
    this.invalid.clear()
    this.types.reset()
    for (const root of BUNDLE_ROOTS) {
      let entries
      try {
        entries = await this.fs.readdir(root)
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.kind !== 'dir' || !e.name.toLowerCase().endsWith('.app')) continue
        const path = join(root, e.name)
        await this.scanOne(path)
      }
    }
    for (const root of FRAMEWORK_ROOTS) {
      let entries
      try {
        entries = await this.fs.readdir(root)
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.kind === 'dir' && e.name.toLowerCase().endsWith('.framework')) await this.scanOne(join(root, e.name))
      }
    }
    await this.hooks.changed?.()
  }

  private async scanOne(path: string): Promise<void> {
    try {
      const info = await this.load(path)
      if (this.bundles.has(info.id)) throw new SysError('EEXIST', `${info.id} is also installed at ${this.bundles.get(info.id)!.path}`)
      this.register(info)
    } catch (err) {
      this.invalid.set(path, (err as Error).message)
    }
  }

  private rebuildTypes(): void {
    this.types.reset()
    for (const b of this.bundles.values()) this.register(b)
  }

  private register(info: BundleInfo): void {
    this.bundles.set(info.id, info)
    for (const t of info.typeDefinitions) this.types.defineType(t, info.id)
    for (const d of info.documentTypes) if (d.uti) for (const ext of d.ext) this.types.declare(ext, d.uti, info.id)
  }

  private async checkResources(path: string, manifest: Manifest): Promise<{ entryPath: string; iconPath: string | null }> {
    const entryPath = join(path, manifest.entry)
    const st = await this.fs.stat(entryPath).catch(() => null)
    if (!st || st.kind !== 'file') bad(`entry ${manifest.entry} is missing`)
    const iconPath = manifest.icon ? join(path, manifest.icon) : null
    if (iconPath && !(await this.fs.exists(iconPath))) bad(`icon ${manifest.icon} is missing`)
    const embed = (manifest.provides as RuntimeProvides | undefined)?.embed
    if (manifest.kind === 'runtime' && embed && !(await this.fs.exists(join(path, embed)))) bad(`embed script ${embed} is missing`)
    return { entryPath, iconPath }
  }

  private async load(path: string): Promise<BundleInfo> {
    const manifest = parseManifest(dec.decode(await this.fs.readFile(join(path, 'manifest.json'))))
    const { entryPath, iconPath } = await this.checkResources(path, manifest)
    const home = this.users.primary.home
    return {
      ...manifest,
      path,
      entryPath,
      iconPath,
      container: `${home}/Library/Containers/${manifest.id}`,
      supportDir: `${home}/Library/Application Support/${manifest.id}`,
      verified: Boolean(manifest.hashes),
      system: path.startsWith('/System/'),
    }
  }

  // ------------------------------------------------------------------ verify

  /** Check the content hashes of a bundle directory. A manifest without hashes verifies trivially (`checked: 0`). */
  async verify(path: string): Promise<VerifyResult> {
    const manifest = parseManifest(dec.decode(await this.fs.readFile(join(path, 'manifest.json'))))
    const problems: string[] = []
    let checked = 0
    for (const [rel, want] of Object.entries(manifest.hashes ?? {})) {
      try {
        const got = await sha256(await this.fs.readFile(join(path, rel)))
        checked++
        if (got !== want) problems.push(`${rel}: hash does not match`)
      } catch {
        problems.push(`${rel}: missing`)
      }
    }
    if (manifest.entry && !(await this.fs.exists(join(path, manifest.entry)))) problems.push(`${manifest.entry}: entry is missing`)
    return { ok: problems.length === 0, checked, problems }
  }

  // ------------------------------------------------------------------ install / update / uninstall

  /** Put the source into a staging directory under /tmp and validate it. Returns the staged `.app` path. */
  private async stageSource(source: BundleSource): Promise<{ staged: string; dir: string; manifest: Manifest }> {
    const dir = `/tmp/.install-${Date.now().toString(36)}-${this.stage++}`
    await this.fs.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      let manifest: Manifest
      let staged: string
      if ('files' in source) {
        const names = Object.keys(source.files)
        if (!names.length || names.length > MAX_BUNDLE_FILES) bad('a bundle needs between 1 and 5000 files')
        const raw = source.files['manifest.json']
        if (raw === undefined) bad('manifest.json is missing')
        manifest = parseManifest(typeof raw === 'string' ? raw : dec.decode(raw))
        staged = join(dir, dirName(manifest.name, manifest.kind))
        await this.fs.mkdir(staged, { mode: 0o755 })
        for (const [rel, content] of Object.entries(source.files)) {
          relative(rel, 'file path')
          const parts = rel.split('/')
          for (let i = 1; i < parts.length; i++) await this.fs.mkdir(join(staged, parts.slice(0, i).join('/')), { recursive: true, mode: 0o755 })
          await this.fs.writeFile(join(staged, rel), typeof content === 'string' ? enc.encode(content) : content)
        }
      } else {
        const st = await this.fs.stat(source.path)
        if (st.kind !== 'dir') throw new SysError('ENOTDIR', undefined, source.path)
        manifest = parseManifest(dec.decode(await this.fs.readFile(join(source.path, 'manifest.json'))))
        staged = join(dir, dirName(manifest.name, manifest.kind))
        await this.fs.copy(source.path, staged, { recursive: true })
      }
      const check = await this.verify(staged)
      if (!check.ok) bad(`integrity check failed: ${check.problems.join('; ')}`)
      await this.checkResources(staged, manifest)
      return { staged, dir, manifest }
    } catch (e) {
      await this.fs.removeAll(dir).catch(() => {})
      throw e
    }
  }

  private async makeDataDirs(info: Pick<BundleInfo, 'container' | 'supportDir'>): Promise<void> {
    const user = this.users.primary
    for (const d of [info.container, info.supportDir]) {
      await this.fs.as(user.uid, user.gid, () => this.fs.mkdir(d, { recursive: true, mode: 0o700 }))
    }
  }

  /**
   * Install a bundle, from a directory in the VFS or from file contents (a download, a dropped folder).
   * `location` is `/Applications` (default) or `/System/Applications`.
   */
  async install(source: BundleSource, opts: { location?: string } = {}): Promise<BundleInfo> {
    const { staged, dir, manifest } = await this.stageSource(source)
    try {
      const roots = manifest.kind === 'framework' ? FRAMEWORK_ROOTS : BUNDLE_ROOTS
      const location = opts.location ?? roots[1]!
      if (!roots.includes(location)) bad(`location must be one of ${roots.join(', ')}`)
      const existing = this.bundles.get(manifest.id)
      if (existing) throw new SysError('EEXIST', `${manifest.id} is already installed at ${existing.path}`)
      await this.hooks.prepare?.(manifest, null)
      const dest = join(location, dirName(manifest.name, manifest.kind))
      if (await this.fs.exists(dest)) throw new SysError('EEXIST', `${dest} already exists`)
      await this.fs.mkdir(location, { recursive: true })
      await this.fs.rename(staged, dest)
      const info = await this.load(dest)
      await this.makeDataDirs(info)
      this.register(info)
      await this.hooks.changed?.()
      this.emit({ type: 'bundle', event: 'installed', id: info.id })
      return structuredClone(info)
    } finally {
      await this.fs.removeAll(dir).catch(() => {})
    }
  }

  /** Replace an installed app with a newer copy. Running instances are asked to quit first. Data is kept. */
  async update(id: string, source: BundleSource): Promise<BundleInfo> {
    const old = this.bundles.get(id)
    if (!old) throw new SysError('ENOENT', `no app with id ${id}`)
    const { staged, dir, manifest } = await this.stageSource(source)
    try {
      if (manifest.id !== id) bad(`the new bundle is ${manifest.id}, not ${id}`)
      await this.hooks.prepare?.(manifest, id)
      if (this.hooks.running(id).length) await this.hooks.quit(id)
      const backup = join(dir, 'previous.app')
      await this.fs.rename(old.path, backup)
      const dest = join(old.path.slice(0, old.path.lastIndexOf('/')), dirName(manifest.name, manifest.kind))
      try {
        await this.fs.rename(staged, dest)
      } catch (e) {
        await this.fs.rename(backup, old.path)
        throw e
      }
      this.bundles.delete(id)
      const info = await this.load(dest)
      await this.makeDataDirs(info)
      this.rebuildTypes()
      this.register(info)
      await this.hooks.changed?.()
      this.emit({ type: 'bundle', event: 'updated', id })
      return structuredClone(info)
    } finally {
      await this.fs.removeAll(dir).catch(() => {})
    }
  }

  /** Remove an app. Its data stays unless `deleteData`. `EBUSY` while it runs. */
  async uninstall(id: string, opts: { deleteData?: boolean } = {}): Promise<void> {
    const b = this.bundles.get(id)
    if (!b) throw new SysError('ENOENT', `no app with id ${id}`)
    if (b.system) throw new SysError('EPERM', 'system apps cannot be removed')
    if (this.hooks.running(id).length) throw new SysError('EBUSY', `${b.name} is running`)
    await this.fs.removeAll(b.path)
    if (opts.deleteData) {
      await this.fs.removeAll(b.container).catch(() => {})
      await this.fs.removeAll(b.supportDir).catch(() => {})
    }
    this.bundles.delete(id)
    this.rebuildTypes()
    await this.hooks.changed?.()
    this.emit({ type: 'bundle', event: 'removed', id })
  }
}
