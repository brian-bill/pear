/// App sources (`contracts/app-registry.md`): the parts of a registry client that need no kernel, so the rules can be
/// tested alone. The `tiny.sources` service (`services/sources.ts`) does the fetching and storing.
import { SysError } from './errors'

export const PROTOCOL = 1
/** Largest JSON document taken from a source. A bigger index should be dropped in favour of `search`. */
export const MAX_DOCUMENT = 20 * 1024 * 1024
const MAX_APPS = 50_000
const CAPABILITIES = ['index', 'search', 'updates', 'publish'] as const
const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/i
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const HEX64 = /^[0-9a-f]{64}$/
const VERSION = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/i

export interface Source {
  id: string
  name: string
  url: string
  origin: 'native' | 'user'
  enabled: boolean
  priority: number
  addedAt?: string
  /** SHA-256 (hex) of the source's public key, pinned when the source was added. */
  keyFingerprint?: string
}

export interface Discovery {
  protocol: number
  id: string
  name: string
  description: string
  icon?: string
  homepage?: string
  /** Absolute base for the endpoints. */
  api: string
  capabilities: string[]
  key?: { alg: 'ed25519'; public: string }
  policy: Record<string, unknown>
}

export interface Listing {
  id: string
  name: string
  summary: string
  version: string
  icon?: string
  publisher: { name: string; keyFingerprint?: string }
  categories: string[]
  size: number
  updated: string
}

export interface VersionRecord {
  version: string
  created: string
  yanked?: { reason: string }
  /** `directory`: `url` is a served bundle directory; `sha256` pins its `manifest.json`, whose `hashes` pin every file. */
  artifact: { kind: 'pearapp' | 'directory'; url: string; sha256: string; size: number }
  manifest: { minOS?: string; permissions: string[] }
  releaseNotes?: string
}

export interface AppRecord extends Listing {
  description: string
  screenshots: string[]
  homepage?: string
  license?: string
  versions: VersionRecord[]
}

const bad = (message: string): never => {
  throw new SysError('EINVAL', message)
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, what: string, max = 500, optional = false): string => {
  if (v === undefined && optional) return ''
  if (typeof v !== 'string' || v.length > max) bad(`${what} must be a string of at most ${max} characters`)
  return v as string
}
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : (bad(`${what} must be a non-negative number`) as never))

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Only https, or http on this machine (for development). Credentials in a URL are refused. */
export function checkUrl(url: URL, what = 'the URL'): URL {
  if (url.username || url.password) bad(`${what} may not carry a user name or password`)
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && LOCAL.has(url.hostname)) return url
  throw new SysError('EPERM', `${what} must use https (http is allowed only on localhost)`)
}

/** What a user typed (`apps.example.com` or a full URL) as a base URL with no query, hash or trailing slash. */
export function normalizeSourceUrl(input: string, base?: string): string {
  const raw = input.trim()
  if (!raw) bad('enter the address of a source')
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : raw.startsWith('/') ? raw : `https://${raw}`, base)
  } catch {
    return bad('that is not a valid address')
  }
  checkUrl(url, 'a source')
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/+$/, '')
}

/** `ref` against `base`, held to the same rules as a source URL. Images and links never become `data:` or `javascript:`. */
export function resolveUrl(ref: string, base: string, what: string): string {
  try {
    return checkUrl(new URL(ref, `${base.replace(/\/+$/, '')}/`), what).href
  } catch (e) {
    if (e instanceof SysError) throw e
    return bad(`${what} is not a valid URL`)
  }
}

export function sourceId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'source'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return SLUG.test(id) ? id : 'source'
}

export function parseDiscovery(raw: unknown, base: string): Discovery {
  if (!isObject(raw)) return bad('the address did not return a registry description')
  const protocol = raw.protocol
  if (!Number.isInteger(protocol)) bad('not a Pear registry (no protocol version)')
  if ((protocol as number) > PROTOCOL) bad('this source needs a newer version of Pear')
  if ((protocol as number) < 1) bad('unsupported protocol version')
  const id = text(raw.id, 'id', 120)
  if (!ID.test(id)) bad('id must be a reverse-DNS name')
  const caps = Array.isArray(raw.capabilities) ? raw.capabilities.filter((c): c is string => typeof c === 'string') : []
  if (!caps.some((c) => c === 'index' || c === 'search')) bad('a source must offer "index" or "search"')
  const doc: Discovery = {
    protocol: protocol as number,
    id,
    name: text(raw.name, 'name', 80) || bad('name is required'),
    description: text(raw.description, 'description', 500, true),
    api: raw.api === undefined ? base : resolveUrl(text(raw.api, 'api', 500), base, 'api'),
    capabilities: caps.filter((c) => (CAPABILITIES as readonly string[]).includes(c)),
    policy: isObject(raw.policy) ? raw.policy : {},
  }
  if (raw.icon !== undefined) doc.icon = resolveUrl(text(raw.icon, 'icon', 500), base, 'icon')
  if (raw.homepage !== undefined) doc.homepage = resolveUrl(text(raw.homepage, 'homepage', 500), base, 'homepage')
  if (raw.key !== undefined) {
    if (!isObject(raw.key) || raw.key.alg !== 'ed25519' || typeof raw.key.public !== 'string') bad('key must be {alg: "ed25519", public}')
    const k = raw.key as { public: string }
    if (b64(k.public).length !== 32) bad('key.public must be a 32-byte Ed25519 key')
    doc.key = { alg: 'ed25519', public: k.public }
  }
  return doc
}

export function parseListing(raw: unknown, base: string): Listing {
  if (!isObject(raw)) return bad('an app entry must be an object')
  const id = text(raw.id, 'app id', 120)
  if (!ID.test(id)) bad(`"${id}" is not a reverse-DNS app id`)
  const version = text(raw.version, 'version', 64)
  if (!VERSION.test(version)) bad(`"${version}" is not a version`)
  const publisher = isObject(raw.publisher) ? raw.publisher : {}
  const listing: Listing = {
    id,
    name: text(raw.name, 'name', 80) || bad('name is required'),
    summary: text(raw.summary, 'summary', 300, true),
    version,
    publisher: { name: text(publisher.name, 'publisher name', 80, true) },
    categories: Array.isArray(raw.categories) ? raw.categories.filter((c): c is string => typeof c === 'string').slice(0, 8).map((c) => c.slice(0, 40)) : [],
    size: raw.size === undefined ? 0 : num(raw.size, 'size'),
    updated: text(raw.updated, 'updated', 40, true),
  }
  if (typeof publisher.keyFingerprint === 'string' && HEX64.test(publisher.keyFingerprint)) listing.publisher.keyFingerprint = publisher.keyFingerprint
  if (raw.icon !== undefined) listing.icon = resolveUrl(text(raw.icon, 'icon', 500), base, 'icon')
  return listing
}

export function parseIndex(raw: unknown, base: string): { apps: Listing[]; featured: string[] } {
  if (!isObject(raw) || !Array.isArray(raw.apps)) return bad('index.json must be {"apps": [...]}')
  if (raw.apps.length > MAX_APPS) throw new SysError('E2BIG', 'the index lists too many apps; the source should use search instead')
  const seen = new Set<string>()
  const apps: Listing[] = []
  for (const entry of raw.apps) {
    const l = parseListing(entry, base)
    if (seen.has(l.id)) bad(`the index lists ${l.id} twice`)
    seen.add(l.id)
    apps.push(l)
  }
  const featured = Array.isArray(raw.featured) ? raw.featured.filter((f): f is string => typeof f === 'string' && seen.has(f)) : []
  return { apps, featured }
}

export function parseVersion(raw: unknown, base: string): VersionRecord {
  if (!isObject(raw)) return bad('a version entry must be an object')
  const version = text(raw.version, 'version', 64)
  if (!VERSION.test(version)) bad(`"${version}" is not a version`)
  const a = raw.artifact
  if (!isObject(a)) return bad(`version ${version} has no artifact`)
  const kind = a.kind === undefined ? 'pearapp' : a.kind
  if (kind !== 'pearapp' && kind !== 'directory') bad(`version ${version}: unknown artifact kind`)
  const sha = text(a.sha256, 'artifact.sha256', 64)
  if (!HEX64.test(sha)) bad(`version ${version}: artifact.sha256 must be 64 hex digits`)
  const m = isObject(raw.manifest) ? raw.manifest : {}
  const permissions = Array.isArray(m.permissions) ? m.permissions.filter((p): p is string => typeof p === 'string') : bad(`version ${version}: manifest.permissions must be listed`)
  const rec: VersionRecord = {
    version,
    created: text(raw.created, 'created', 40, true),
    artifact: { kind: kind as 'pearapp' | 'directory', url: resolveUrl(text(a.url, 'artifact.url', 1000), base, 'artifact.url'), sha256: sha, size: a.size === undefined ? 0 : num(a.size, 'artifact.size') },
    manifest: { permissions: permissions as string[] },
  }
  if (typeof m.minOS === 'string') rec.manifest.minOS = m.minOS
  if (isObject(raw.yanked)) rec.yanked = { reason: text(raw.yanked.reason, 'yanked.reason', 300, true) }
  if (typeof raw.releaseNotes === 'string') rec.releaseNotes = raw.releaseNotes.slice(0, 4000)
  return rec
}

export function parseApp(raw: unknown, base: string): AppRecord {
  const listing = parseListing(raw, base)
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.versions) || r.versions.length === 0 || r.versions.length > 500) bad('an app record needs between 1 and 500 versions')
  const versions = (r.versions as unknown[]).map((v) => parseVersion(v, base))
  if (new Set(versions.map((v) => v.version)).size !== versions.length) bad('an app record lists a version twice')
  const rec: AppRecord = {
    ...listing,
    description: text(r.description, 'description', 5000, true),
    screenshots: Array.isArray(r.screenshots) ? r.screenshots.filter((s): s is string => typeof s === 'string').slice(0, 10).map((s) => resolveUrl(s, base, 'screenshot')) : [],
    versions: versions.sort((a, b) => compareVersions(b.version, a.version)),
  }
  if (typeof r.homepage === 'string') rec.homepage = resolveUrl(r.homepage, base, 'homepage')
  if (typeof r.license === 'string') rec.license = r.license.slice(0, 60)
  return rec
}

/** Highest version that can be offered: not yanked, and not a prerelease unless nothing else exists or `prerelease`. */
export function latest(versions: VersionRecord[], prerelease = false): VersionRecord | null {
  const ok = versions.filter((v) => !v.yanked && (prerelease || !v.version.includes('-')))
  return ok.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}

/** Numeric comparison of `1.2.3[-pre]`. A prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const [ca = '', pa] = a.split(/-(.+)/)
  const [cb = '', pb] = b.split(/-(.+)/)
  const na = ca.split('.').map(Number)
  const nb = cb.split('.').map(Number)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (pa === pb) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  return pa < pb ? -1 : 1
}

/** Filter and rank listings by words in the name, id, summary and categories. Names weigh most. */
export function searchListings<T extends Listing>(items: T[], query: string, opts: { category?: string } = {}): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: Array<[number, T]> = []
  for (const item of items) {
    if (opts.category && !item.categories.includes(opts.category)) continue
    let score = 0
    let all = true
    for (const w of words) {
      const s = item.name.toLowerCase().includes(w) ? 4 : item.id.toLowerCase().includes(w) ? 2 : item.categories.some((c) => c.toLowerCase().includes(w)) ? 2 : item.summary.toLowerCase().includes(w) ? 1 : 0
      if (!s) all = false
      score += s
    }
    if (all) scored.push([score, item])
  }
  return scored.sort((x, y) => y[0] - x[0] || x[1].name.localeCompare(y[1].name)).map(([, i]) => i)
}

/** Native sources, the user's changes to them, then the sources the user added, in display order. */
export function mergeSources(native: Source[], added: Source[], overrides: Record<string, { enabled?: boolean; priority?: number }>): Source[] {
  const all = [
    ...native.map((s) => ({ ...s, origin: 'native' as const, ...pick(overrides[s.id]) })),
    ...added.filter((s) => !native.some((n) => n.id === s.id)).map((s) => ({ ...s, origin: 'user' as const })),
  ]
  return all.map((s, i) => ({ s, i })).sort((a, b) => a.s.priority - b.s.priority || a.i - b.i).map(({ s }) => s)
}
const pick = (o?: { enabled?: boolean; priority?: number }) => ({ ...(typeof o?.enabled === 'boolean' && { enabled: o.enabled }), ...(typeof o?.priority === 'number' && { priority: o.priority }) })

export function b64(s: string): Uint8Array {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return new Uint8Array(0)
  }
}

export const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
}

/** Check an Ed25519 signature over `data` with the source's key. */
export async function verifySignature(publicKey: string, signature: string, data: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', b64(publicKey) as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(signature.trim()) as BufferSource, data as BufferSource)
  } catch {
    throw new SysError('ENOSYS', 'this browser cannot verify Ed25519 signatures, so a signed source cannot be used')
  }
}
