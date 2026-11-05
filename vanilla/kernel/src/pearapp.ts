/// App packages, `.pearapp`: one `*.app` bundle in one file, to download, send, or
/// install from a link. The container and record engine are the disk image's (`container.ts`); what differs is the
/// header (the manifest and a per-file hash list) and that the body holds exactly one bundle root.
///
/// Packaging reads project files and nothing else: no project code is imported or run. Reading a package checks the
/// container checksum and every file's SHA-256 against the header before a single file is placed anywhere.
import { MAX_BUNDLE_FILES, dirName, parseManifest, sha256, type Manifest } from './bundle'
import { ByteReader, END_RECORD, FLAG_GZIP, bodyStream, frame, gzipped, readRecord, record, unframe } from './container'
import { SysError } from './errors'
import type { FileSystem } from './fs'

export const PEARAPP_MAGIC = 'PEARAPP\0'
export const PEARAPP_VERSION = 1
export const PEARAPP_TYPE = 'application/vnd.pear.app'
/** Most bytes of file content in one package: the same as a bundle served as a directory. */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
/** Left out of a package unless the project says otherwise. */
const SKIP = new Set(['.git', '.DS_Store', 'node_modules'])

export interface PackageHeader {
  /** The full manifest, as it is in the package's `manifest.json`. */
  app: Record<string, unknown>
  /** The bundle's directory name, `Notes.app`. Every record's path starts with it. */
  root: string
  /** Every file, by path inside the bundle. */
  files: Array<{ path: string; sha256: string; size: number }>
  created: string
  generator: string
}

export interface PackageOptions {
  /** Fields to put over the project's `manifest.json` (for the package only; the project is not changed). */
  manifest?: Record<string, unknown>
  /** Shorthand for `manifest: {version}`. */
  version?: string
  /**
   * Files to put in the package that the project does not have (a project's own file of the same name wins). A UI app
   * that has no `main.js` gets Desktop's standard host process this way, as the bundled apps do at build time.
   */
  extra?: Record<string, string | Uint8Array>
  /** Paths (relative to the project, or bare names) to leave out, besides `.git`, `.DS_Store`, `node_modules`. */
  exclude?: string[]
  /** gzip the body. Default true. */
  compress?: boolean
  /** Called with `(files, bytes)` as it goes; return `false` to cancel (`ECANCELED`). */
  progress?: (files: number, bytes: number) => boolean | void
}

export interface Check {
  id: 'manifest' | 'schema' | 'entry' | 'icon' | 'links' | 'size'
  ok: boolean
  /** A failed `error` stops packaging; a failed `warning` is shown but does not. */
  severity: 'error' | 'warning'
  message: string
}

export interface PackageReport {
  ok: boolean
  checks: Check[]
  manifest: Manifest | null
  files: number
  bytes: number
  /** Size of the package as it would be written. */
  packageBytes: number
}

export interface ArchiveInfo {
  ok: boolean
  /** Why the package cannot be installed. */
  error?: string
  /** Size of the file. */
  size: number
  /** SHA-256 (hex) of the whole file: what a registry or a link can pin. */
  digest: string
  manifest?: Manifest
  root?: string
  files: number
  bytes: number
  created?: string
  generator?: string
  /** Packages carry no publisher signature yet: every package is unsigned. */
  unsigned: true
}

export interface InstalledFrom {
  kind: 'archive' | 'url' | 'registry'
  url?: string
  digest?: string
  version?: string
  sourceId?: string
  at: string
  unsigned?: boolean
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const bad = (message: string): never => {
  throw new SysError('EINVAL', message)
}
const join = (a: string, b: string) => (a === '/' ? `/${b}` : `${a}/${b}`)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const ROOT = /^[^/\\\0]{1,200}\.(app|framework)$/
const HEX64 = /^[0-9a-f]{64}$/

function safeRelative(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 512 || path.startsWith('/') || path.includes('\0') || path.includes('\\') || path.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    return bad(`"${String(path)}" is not a path inside a bundle`)
  }
  return path
}

const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]))
  if (isObject(a) && isObject(b)) {
    const k = Object.keys(a)
    return k.length === Object.keys(b).length && k.every((key) => key in b && sameJson(a[key], b[key]))
  }
  return false
}

export class Packager {
  constructor(
    private fs: FileSystem,
    private osVersion: string,
  ) {}

  /** Read a project into memory: its files, the manifest the package would carry, and what is wrong with it. */
  private async gather(project: string, o: PackageOptions) {
    const st = await this.fs.stat(project)
    if (st.kind !== 'dir') throw new SysError('ENOTDIR', undefined, project)
    const checks: Check[] = []
    const add = (id: Check['id'], ok: boolean, message: string, severity: Check['severity'] = 'error') => checks.push({ id, ok, severity, message })
    const skip = new Set([...SKIP, ...(o.exclude ?? [])])
    const files = new Map<string, Uint8Array>()
    let bytes = 0
    let links = 0
    let tooBig = false
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const e of await this.fs.readdir(dir)) {
        const path = rel ? `${rel}/${e.name}` : e.name
        if (skip.has(e.name) || skip.has(path) || e.name.endsWith('.pearapp')) continue
        const full = join(dir, e.name)
        const s = await this.fs.lstat(full)
        if (s.kind === 'symlink') links++
        else if (s.kind === 'dir') await walk(full, path)
        else if (s.kind === 'file') {
          if (files.size >= MAX_BUNDLE_FILES || bytes + s.size > MAX_PACKAGE_BYTES) {
            tooBig = true
            return
          }
          files.set(path, await this.fs.readFile(full))
          bytes += s.size
          if (o.progress?.(files.size, bytes) === false) throw new SysError('ECANCELED', 'packaging was canceled')
        }
        if (tooBig) return
      }
    }
    await walk(project, '')
    for (const [path, content] of Object.entries(o.extra ?? {})) {
      if (files.has(path)) continue
      safeRelative(path)
      const bytes_ = typeof content === 'string' ? enc.encode(content) : content
      if (files.size >= MAX_BUNDLE_FILES || bytes + bytes_.length > MAX_PACKAGE_BYTES) tooBig = true
      else {
        files.set(path, bytes_)
        bytes += bytes_.length
      }
    }

    add('links', links === 0, links ? `${links} symbolic link${links === 1 ? '' : 's'} (a bundle cannot contain links)` : 'No symbolic links')
    add('size', !tooBig, tooBig ? `More than ${MAX_BUNDLE_FILES} files or ${MAX_PACKAGE_BYTES / 1024 / 1024} MB` : `${files.size} files, ${bytes} bytes`)

    // the manifest the package carries: the project's, with the overrides, and the hash of every other file
    let raw: Record<string, unknown> | null = null
    const text = files.get('manifest.json')
    if (!text) add('manifest', false, 'manifest.json is missing')
    else {
      add('manifest', true, 'manifest.json is present')
      try {
        const parsed = JSON.parse(dec.decode(text))
        if (isObject(parsed)) raw = parsed
        else add('schema', false, 'manifest.json must be an object')
      } catch {
        add('schema', false, 'manifest.json is not valid JSON')
      }
    }
    let manifest: Manifest | null = null
    let finalRaw: Record<string, unknown> | null = null
    if (raw) {
      const hashes: Record<string, string> = {}
      for (const [p, c] of files) if (p !== 'manifest.json') hashes[p] = await sha256(c)
      finalRaw = { ...raw, ...(o.manifest ?? {}), ...(o.version ? { version: o.version } : {}), hashes }
      try {
        manifest = parseManifest(JSON.stringify(finalRaw))
        add('schema', true, `${manifest.name} ${manifest.version}, ${manifest.id}`)
      } catch (e) {
        add('schema', false, (e as Error).message)
      }
    }
    if (manifest) {
      add('entry', files.has(manifest.entry), files.has(manifest.entry) ? `Entry ${manifest.entry} is present` : `Entry ${manifest.entry} is missing`)
      if (manifest.icon) {
        const there = files.has(manifest.icon)
        add('icon', there, there ? `Icon ${manifest.icon} is present` : `Icon ${manifest.icon} is missing`)
        if (there && !manifest.icon.startsWith('Resources/')) add('icon', false, `Icon is not under Resources/ (${manifest.icon})`, 'warning')
      } else add('icon', false, 'The manifest names no icon', 'warning')
    }
    return { files, bytes, checks, manifest, finalRaw }
  }

  private async build(project: string, o: PackageOptions) {
    const g = await this.gather(project, o)
    const failed = g.checks.find((c) => !c.ok && c.severity === 'error')
    if (failed || !g.manifest || !g.finalRaw) {
      throw new SysError(failed?.id === 'manifest' ? 'ENOENT' : 'EINVAL', failed?.message ?? 'the project cannot be packaged', project)
    }
    const root = dirName(g.manifest.name, g.manifest.kind)
    g.files.set('manifest.json', enc.encode(`${JSON.stringify(g.finalRaw, null, 2)}\n`))
    const names = [...g.files.keys()].sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a < b ? -1 : 1))
    const listed: PackageHeader['files'] = []
    const parts: BlobPart[] = []
    for (const path of names) {
      const content = g.files.get(path)!
      listed.push({ path, sha256: await sha256(content), size: content.length })
      parts.push(...record({ path: `${root}/${path}`, kind: 'file', mode: 0o644, size: content.length }, content))
    }
    parts.push(END_RECORD as BlobPart)
    const compress = o.compress ?? true
    let body = new Blob(parts)
    if (compress) body = await gzipped(body)
    const header: PackageHeader = { app: g.finalRaw, root, files: listed, created: new Date().toISOString(), generator: `pear/${this.osVersion}` }
    const blob = await frame(PEARAPP_MAGIC, PEARAPP_VERSION, compress ? FLAG_GZIP : 0, header, body, PEARAPP_TYPE)
    return { blob, g, header }
  }

  /** The project as a `.pearapp`. `ENOENT` without a manifest, `EINVAL` for anything else wrong with it. Runs no project code. */
  async package(project: string, o: PackageOptions = {}): Promise<Blob> {
    return (await this.build(project, o)).blob
  }

  /** What `package` would do, without keeping the package: the checks, the sizes, and the size it would have. */
  async check(project: string, o: PackageOptions = {}): Promise<PackageReport> {
    const g = await this.gather(project, o)
    const ok = g.checks.every((c) => c.ok || c.severity === 'warning')
    let packageBytes = 0
    if (ok) packageBytes = (await this.build(project, o)).blob.size
    return { ok, checks: g.checks, manifest: g.manifest, files: g.files.size, bytes: g.bytes, packageBytes }
  }
}

/**
 * Read a package: container checksum first, then every file against the header's hashes. Nothing is placed anywhere.
 * `files` are the bundle's files by path inside the bundle, ready for `BundleManager.install({files})`.
 */
export async function readPackage(file: Blob): Promise<{ info: ArchiveInfo; files: Record<string, Uint8Array> }> {
  const info: ArchiveInfo = { ok: false, size: file.size, digest: '', files: 0, bytes: 0, unsigned: true }
  try {
    info.digest = await sha256(new Uint8Array(await file.arrayBuffer()))
    const { header: raw, body, gzip } = await unframe(file, { magic: PEARAPP_MAGIC, version: PEARAPP_VERSION, minVersion: 1, what: 'Pear app package', noun: 'package' })
    if (!isObject(raw) || !isObject(raw.app) || !Array.isArray(raw.files) || typeof raw.root !== 'string') bad('the package header is incomplete')
    const header = raw as unknown as PackageHeader
    if (!ROOT.test(header.root)) bad('a package holds one bundle, named like Notes.app')
    if (header.files.length === 0 || header.files.length > MAX_BUNDLE_FILES) bad(`a bundle needs between 1 and ${MAX_BUNDLE_FILES} files`)
    const want = new Map<string, { sha256: string; size: number }>()
    for (const f of header.files) {
      const path = safeRelative(f?.path)
      if (want.has(path)) bad(`the package lists ${path} twice`)
      if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0) bad(`bad entry for ${path}`)
      want.set(path, { sha256: f.sha256, size: f.size })
    }
    const manifest = parseManifest(JSON.stringify(header.app))

    const files: Record<string, Uint8Array> = {}
    const reader = new ByteReader(bodyStream(body, gzip))
    let bytes = 0
    try {
      for (;;) {
        const rec = await readRecord<{ path: string; kind: string; size: number }>(reader, MAX_PACKAGE_BYTES - bytes)
        if (!rec) break
        if (rec.meta.kind !== 'file') bad('a package holds files only')
        const slash = typeof rec.meta.path === 'string' ? rec.meta.path.indexOf('/') : -1
        if (slash < 1) bad('a package record has no bundle root')
        if (rec.meta.path.slice(0, slash) !== header.root) bad('a package must hold exactly one .app root')
        const path = safeRelative(rec.meta.path.slice(slash + 1))
        if (path in files) bad(`the package holds ${path} twice`)
        const content = rec.content!
        bytes += content.length
        const expected = want.get(path)
        if (!expected) bad(`${path} is in the package but not in its file list`)
        if (expected!.size !== content.length || expected!.sha256 !== (await sha256(content))) bad(`${path} does not match its hash`)
        files[path] = content
      }
    } finally {
      reader.cancel()
    }
    for (const path of want.keys()) if (!(path in files)) bad(`${path} is listed but missing from the package`)
    if (!('manifest.json' in files)) bad('manifest.json is missing')
    if (!sameJson(JSON.parse(dec.decode(files['manifest.json']!)), header.app)) bad('the manifest in the header is not the manifest in the package')

    Object.assign(info, { ok: true, manifest, root: header.root, files: want.size, bytes, created: header.created, generator: header.generator })
    return { info, files }
  } catch (e) {
    info.error = (e as Error).message
    return { info, files: {} }
  }
}

/** Where installs came from, kept in `/var/db` so an update can follow its source. */
export class ProvenanceStore {
  private cache: Record<string, InstalledFrom> | null = null
  constructor(
    private fs: FileSystem,
    private path = '/var/db/provenance.json',
  ) {}

  private async load(): Promise<Record<string, InstalledFrom>> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(dec.decode(await this.fs.readFile(this.path)))
      this.cache = isObject(parsed) ? (parsed as Record<string, InstalledFrom>) : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  async get(id: string): Promise<InstalledFrom | null> {
    return (await this.load())[id] ?? null
  }

  async set(id: string, from: Omit<InstalledFrom, 'at'>): Promise<InstalledFrom> {
    const all = await this.load()
    all[id] = { ...from, at: new Date().toISOString() }
    await this.fs.writeFileAtomic(this.path, enc.encode(JSON.stringify(all)))
    return all[id]
  }

  async delete(id: string): Promise<void> {
    const all = await this.load()
    if (!(id in all)) return
    delete all[id]
    await this.fs.writeFileAtomic(this.path, enc.encode(JSON.stringify(all)))
  }
}
