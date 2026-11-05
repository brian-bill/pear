export class VsxError extends Error {
  constructor(message: string, public code: string) {
    super(message)
  }
}

export const MAX_FILES = 5000
/** Largest package, packed (download) or unpacked. Bigger extensions bundle language servers or binaries. */
export const MAX_BYTES = 256 * 1024 * 1024

// ---- zip (the subset a .vsix uses: stored and deflate entries, no zip64, no encryption)

const u16 = (d: DataView, o: number): number => d.getUint16(o, true)
const u32 = (d: DataView, o: number): number => d.getUint32(o, true)

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A path inside an extension: relative, no `..`, no empty or backslash segments. */
export function safePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every((s, i, a) => (s !== '' || i === a.length - 1) && s !== '.' && s !== '..')
}

/** Unzip every file. Directories are skipped; unsafe paths, too many files, or too many bytes refuse the whole archive. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(d, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new VsxError('Not a valid .vsix: no zip directory.', 'EINVAL')
  const count = u16(d, eocd + 10)
  let at = u32(d, eocd + 16)
  if (count > MAX_FILES) throw new VsxError(`Too many files (limit ${MAX_FILES}).`, 'EINVAL')
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(d, at) !== 0x02014b50) throw new VsxError('Not a valid .vsix: damaged zip directory.', 'EIO')
    const flags = u16(d, at + 8)
    const method = u16(d, at + 10)
    const csize = u32(d, at + 20)
    const usize = u32(d, at + 24)
    const nameLen = u16(d, at + 28)
    const extraLen = u16(d, at + 30)
    const commentLen = u16(d, at + 32)
    const local = u32(d, at + 42)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (!safePath(name)) throw new VsxError(`Unsafe path in package: ${name}`, 'EINVAL')
    if (flags & 1) throw new VsxError('Encrypted packages are not supported.', 'EINVAL')
    total += usize
    if (total > MAX_BYTES) throw new VsxError(`The package unpacks to more than ${MAX_BYTES / 1024 / 1024} MB.`, 'ENOSPC')
    if (local + 30 > bytes.length || u32(d, local) !== 0x04034b50) throw new VsxError(`Damaged entry: ${name}`, 'EIO')
    const start = local + 30 + u16(d, local + 26) + u16(d, local + 28)
    const raw = bytes.subarray(start, start + csize)
    if (raw.length !== csize) throw new VsxError(`Truncated entry: ${name}`, 'EIO')
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) data = await inflate(raw)
    else throw new VsxError(`Unsupported compression in ${name}.`, 'EINVAL')
    if (data.length !== usize) throw new VsxError(`Damaged entry (size mismatch): ${name}`, 'EIO')
    files.set(name, data)
  }
  return files
}

// ---- manifest

export interface Contributes {
  themes?: Array<{ id?: string; label: string; uiTheme?: string; path: string }>
  snippets?: Array<{ language?: string; path: string }>
  languages?: Array<{ id: string; extensions?: string[]; filenames?: string[]; aliases?: string[]; configuration?: string }>
  grammars?: Array<{ language?: string; scopeName: string; path: string }>
  commands?: Array<{ command: string; title: string }>
  [point: string]: unknown
}

export interface VsxManifest {
  publisher: string
  name: string
  version: string
  displayName?: string
  description?: string
  engines?: { vscode?: string; node?: string }
  type?: string
  main?: string
  browser?: string
  extensionKind?: string[]
  activationEvents?: string[]
  contributes?: Contributes
  capabilities?: {
    untrustedWorkspaces?: { supported: boolean | 'limited'; description?: string }
    virtualWorkspaces?: boolean | { supported: boolean | 'limited'; description?: string }
  }
  icon?: string
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function parseManifest(text: string): VsxManifest {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    throw new VsxError('package.json is not valid JSON.', 'EINVAL')
  }
  const o = m as Partial<VsxManifest> | null
  if (!o || typeof o !== 'object') throw new VsxError('package.json is not an object.', 'EINVAL')
  for (const k of ['publisher', 'name', 'version'] as const) {
    if (typeof o[k] !== 'string' || !PART.test(o[k] as string)) throw new VsxError(`package.json: "${k}" is missing or invalid.`, 'EINVAL')
  }
  for (const k of ['main', 'browser'] as const) {
    const v = o[k]
    if (v !== undefined && (typeof v !== 'string' || !safePath(v.replace(/^\.\//, '')))) throw new VsxError(`package.json: "${k}" is not a path inside the extension.`, 'EINVAL')
  }
  return o as VsxManifest
}

export const extId = (m: Pick<VsxManifest, 'publisher' | 'name'>): string => `${m.publisher}.${m.name}`.toLowerCase()
export const folderName = (m: VsxManifest): string => `${extId(m)}-${m.version}`

/** Extensions are at `extension/` inside a .vsix; a plain folder has package.json at its root. */
export function findRoot(files: Map<string, Uint8Array>): string {
  if (files.has('extension/package.json')) return 'extension/'
  if (files.has('package.json')) return ''
  throw new VsxError('No package.json found in the package.', 'EINVAL')
}

export const normalize = (p: string): string => p.replace(/^\.\//, '').replace(/^\/+/, '')

/** Where an entry such as `./dist/extension-web` may be: as written, with `.js`, or as a directory's index (Node's rules, which VS Code follows). */
export const entryCandidates = (entry: string): string[] => {
  const p = normalize(entry)
  return /\.[cm]?js$/.test(p) ? [p] : [p, `${p}.js`, `${p}/index.js`]
}

export type Compat =
  | { ok: true; kind: 'declarative' | 'web' | 'node' | 'both' }
  | { ok: false; kind: 'node' | 'unsupported'; reason: string }

/** Can this run in the web extension host? Code with only a Node `main` cannot. */
export function webCompat(m: VsxManifest): Compat {
  if (m.browser) return { ok: true, kind: 'web' }
  if (m.main) return { ok: false, kind: 'node', reason: 'This extension needs Node.js (it has no "browser" entry), so it cannot run in a browser.' }
  return { ok: true, kind: 'declarative' }
}

export const NEEDS_NODE = 'This extension needs the Node.js runtime. Add it in Settings ▸ Runtimes.'

/** `a` is a version, `range` is `>=20`, `^18`, `20.x`...: true when the version satisfies the lower bound the range names. */
const satisfiesNode = (version: string, range: string): boolean => {
  const want = range.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!want) return true
  const [a = 0, b = 0, c = 0] = version.split('.').map((n) => parseInt(n, 10) || 0)
  const [x, y = 0, z = 0] = [parseInt(want[1]!, 10), parseInt(want[2] ?? '0', 10), parseInt(want[3] ?? '0', 10)]
  if (/^\s*(<|<=)/.test(range)) return true
  return a > x || (a === x && (b > y || (b === y && c >= z)))
}

/**
 * Where can this extension run? `node` is the installed Node.js runtime's version (null: none installed). An extension with a
 * `browser` entry runs in the web host (also when it has a `main`: `both`); one with only `main` runs in the Node host when a
 * runtime is installed. Refused, with the reason: no runtime, `engines.node` newer than the runtime, an ES-module `main`.
 */
export function compatibility(m: VsxManifest, node: string | null): Compat {
  if (m.browser) return { ok: true, kind: m.main && node ? 'both' : 'web' }
  if (!m.main) return { ok: true, kind: 'declarative' }
  if (!node) return { ok: false, kind: 'node', reason: NEEDS_NODE }
  if (m.engines?.node && !satisfiesNode(node, m.engines.node)) return { ok: false, kind: 'unsupported', reason: `This extension needs Node.js ${m.engines.node}; the installed runtime is ${node}.` }
  if (m.type === 'module' || /\.mjs$/.test(m.main)) return { ok: false, kind: 'unsupported', reason: 'This extension’s main entry is an ES module, which the Node.js runtime does not load yet.' }
  return { ok: true, kind: 'node' }
}

/** The VS Code API version the host provides; `engines.vscode` newer than this warns. */
export const API_VERSION = '1.90.0'

const parts = (v: string): number[] => v.replace(/^[^\d]*/, '').split('.').map((n) => parseInt(n, 10) || 0)
export function engineWarning(m: VsxManifest): string | null {
  const want = m.engines?.vscode
  if (!want || want === '*') return null
  const [a = 0, b = 0, c = 0] = parts(want)
  const [x = 0, y = 0, z = 0] = parts(API_VERSION)
  return a > x || (a === x && (b > y || (b === y && c > z))) ? `Requires VS Code ${want}; this host provides ${API_VERSION}.` : null
}

/** Strip comments and trailing commas: the JSON that VS Code themes, snippets and language configs are written in. */
export function parseJsonc<T = unknown>(text: string): T {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      i = i < 0 ? n : i + 2
    } else {
      out += ch
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, '')) as T
}

// ---- Open VSX

export const OPEN_VSX = 'https://open-vsx.org'

export interface Listing {
  id: string // publisher.name
  namespace: string
  name: string
  version: string
  displayName: string
  description: string
  downloads: number
  verified: boolean
  iconUrl?: string
  downloadUrl: string
  sha256Url?: string
  /** The extension's package.json on the registry (derived from the download URL when the record does not list it). */
  manifestUrl: string
  readmeUrl?: string
  changelogUrl?: string
  repository?: string
  license?: string
  categories: string[]
  rating?: number
  reviews?: number
  published?: string
}

interface RawListing {
  namespace?: string
  name?: string
  version?: string
  displayName?: string
  description?: string
  downloadCount?: number
  verified?: boolean
  files?: { download?: string; icon?: string; sha256?: string; readme?: string; changelog?: string; manifest?: string }
  repository?: string
  license?: string
  categories?: string[]
  averageRating?: number
  reviewCount?: number
  timestamp?: string
}

type Fetch = (url: string, init?: { timeout?: number }) => Promise<Response>

const toListing = (r: RawListing): Listing | null =>
  r.namespace && r.name && r.version && r.files?.download
    ? {
        id: `${r.namespace}.${r.name}`.toLowerCase(),
        namespace: r.namespace,
        name: r.name,
        version: r.version,
        displayName: r.displayName || r.name,
        description: r.description || '',
        downloads: r.downloadCount ?? 0,
        verified: r.verified === true,
        iconUrl: r.files.icon,
        downloadUrl: r.files.download,
        sha256Url: r.files.sha256,
        manifestUrl: r.files.manifest ?? r.files.download.replace(/\/[^/]*$/, '/package.json'),
        readmeUrl: r.files.readme,
        changelogUrl: r.files.changelog,
        repository: r.repository,
        license: r.license,
        categories: r.categories ?? [],
        rating: r.averageRating,
        reviews: r.reviewCount,
        published: r.timestamp,
      }
    : null

const netError = (res: Response): VsxError =>
  new VsxError(`Open VSX answered ${res.status}.`, res.status === 404 ? 'ENOENT' : res.status === 403 ? 'EACCES' : 'EIO')

export async function searchOpenVsx(fetchFn: Fetch, query: string, source = OPEN_VSX, size = 30, sortBy: 'relevance' | 'downloadCount' = 'relevance'): Promise<Listing[]> {
  const url = `${source.replace(/\/$/, '')}/api/-/search?query=${encodeURIComponent(query)}&size=${size}&sortBy=${sortBy}&sortOrder=desc`
  const res = await fetchFn(url, { timeout: 15_000 })
  if (!res.ok) throw netError(res)
  const body = (await res.json()) as { extensions?: RawListing[] }
  return (body.extensions ?? []).map(toListing).filter((l): l is Listing => l !== null)
}

/** One extension by `publisher.name` (latest, or `version`). */
export async function lookupOpenVsx(fetchFn: Fetch, id: string, version?: string, source = OPEN_VSX): Promise<Listing> {
  const [ns, ...rest] = id.split('.')
  const url = `${source.replace(/\/$/, '')}/api/${encodeURIComponent(ns ?? '')}/${encodeURIComponent(rest.join('.'))}${version ? `/${encodeURIComponent(version)}` : ''}`
  const res = await fetchFn(url, { timeout: 15_000 })
  if (!res.ok) throw netError(res)
  const l = toListing((await res.json()) as RawListing)
  if (!l) throw new VsxError('Open VSX returned an incomplete listing.', 'EIO')
  return l
}

/**
 * Can this listing run in a browser? Read its package.json (a few KB) instead of downloading the package:
 * code with only a Node `main` cannot. 'unknown' when the manifest cannot be read (install then decides).
 */
export type Runnable = 'web' | 'node' | 'unknown'
export async function checkRunnable(fetchFn: Fetch, l: Listing): Promise<Runnable> {
  try {
    const res = await fetchFn(l.manifestUrl, { timeout: 15_000 })
    if (!res.ok) return 'unknown'
    const m = (await res.json()) as { main?: unknown; browser?: unknown }
    return m.browser || !m.main ? 'web' : 'node'
  } catch {
    return 'unknown'
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Download a listing's .vsix, checking it against the registry's published SHA-256 when it offers one.
 * `getBytes` streams the package (a `fetch` response is read whole and limited to 64 MB; a download is not).
 */
export async function downloadListing(fetchFn: Fetch, getBytes: (url: string) => Promise<Uint8Array>, l: Listing): Promise<{ bytes: Uint8Array; digest: string }> {
  const bytes = await getBytes(l.downloadUrl)
  if (bytes.length > MAX_BYTES) throw new VsxError(`The download is larger than ${MAX_BYTES / 1024 / 1024} MB.`, 'ENOSPC')
  const digest = await sha256Hex(bytes)
  if (l.sha256Url) {
    const want = await fetchFn(l.sha256Url, { timeout: 15_000 })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '')
    const expected = want.trim().split(/\s+/)[0]?.toLowerCase()
    if (expected && /^[0-9a-f]{64}$/.test(expected) && expected !== digest) throw new VsxError(`The download does not match the registry’s SHA-256 (got ${digest.slice(0, 12)}… for ${bytes.length} bytes, expected ${expected.slice(0, 12)}…).`, 'EINVAL')
  }
  return { bytes, digest }
}
