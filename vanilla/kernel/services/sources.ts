import { fail, needSystem, serve } from './lib'
import type { Pear } from '../src/runtime'
import { fetchDirectory, type Get } from '../src/dirbundle'
import {
  MAX_DOCUMENT,
  compareVersions,
  b64,
  latest,
  mergeSources,
  normalizeSourceUrl,
  parseApp,
  parseDiscovery,
  parseIndex,
  resolveUrl,
  searchListings,
  sourceId,
  type AppRecord,
  type Discovery,
  type Listing,
  type Source,
  type VersionRecord,
} from '../src/sources'

const DOMAIN = 'tiny.apps.sources'
const dec = new TextDecoder()
const MAX_FILES = 500
const MAX_BUNDLE = 64 * 1024 * 1024
const FETCH_TIMEOUT = 20_000

interface Status {
  state: 'ok' | 'stale' | 'error' | 'unknown'
  apps?: number
  refreshed?: string
  error?: { code: string; message: string }
}
interface Cached {
  etag?: string
  bytes: Uint8Array
  at: string
}
interface Installed {
  sourceId: string
  sourceUrl: string
  appId: string
  version: string
  digest: string
  at: string
}
interface Net {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

/**
 * `tiny.sources`: app sources (`contracts/app-registry.md`). It keeps the list of registries, reads their catalogs
 * through `tiny.network`, and fetches and checks an app before the Desktop installs it. A process cannot install
 * bundles, so `prepare` hands back verified files and the Desktop calls `bundleInstall` and then `record`. Only the
 * system may call this service: an app can neither add a source nor start an install.
 */
export default async (tiny: Pear) => {
  const sha256 = (data: Uint8Array) => tiny.cryptoDigest(data)
  const network = () => tiny.lookup('tiny.network')
  const discovery = new Map<string, Discovery>()
  const docs = new Map<string, Cached>() // by URL: conditional requests, and what to show when a source is down
  const indexes = new Map<string, { apps: Listing[]; featured: string[] }>()
  const status = new Map<string, Status>()

  // ---- stored settings

  const read = async <T>(key: string, fallback: T): Promise<T> => ((await tiny.configGet(DOMAIN, key, fallback as never)) ?? fallback) as T
  const write = (key: string, value: unknown, scope: 'user' | 'system' = 'user') => tiny.configSet(DOMAIN, key, value, { scope })

  const sources = async (): Promise<Source[]> => {
    const native = (await read<Array<{ id: string; name: string; url: string }>>('native', [])).map((n, i) => ({
      id: n.id, name: n.name, url: n.url, origin: 'native' as const, enabled: true, priority: i,
    }))
    const added = await read<Source[]>('added', [])
    return mergeSources(native, added, await read('overrides', {}))
  }
  const find = async (id: unknown): Promise<Source> => {
    const s = (await sources()).find((x) => x.id === id)
    if (!s) throw fail('ENOENT', `no source named ${String(id)}`)
    return s
  }

  // ---- fetching

  const get = async (url: string, opts: { etag?: string; accept?: string } = {}): Promise<Net> => {
    const headers: Record<string, string> = { accept: opts.accept ?? 'application/json' }
    if (opts.etag) headers['if-none-match'] = opts.etag
    const reply = (await tiny.request(await network(), { op: 'fetch', url, init: { headers, credentials: 'omit' }, timeout: FETCH_TIMEOUT }, { timeout: FETCH_TIMEOUT + 5000 })).data as {
      ok: boolean
      result?: Net
      error?: { code: string; message: string }
    }
    if (!reply.ok) throw fail(reply.error?.code ?? 'EIO', reply.error?.message ?? 'the request failed')
    return reply.result!
  }

  /** A document: from the network (or the cache if the server says `304`), at most 20 MB. `stale` if only the cache answered. */
  const document = async (url: string): Promise<{ bytes: Uint8Array; stale: boolean }> => {
    const cached = docs.get(url)
    try {
      const res = await get(url, { etag: cached?.etag })
      if (res.status === 304 && cached) return { bytes: cached.bytes, stale: false }
      if (res.status === 404) throw fail('ENOENT', `${url} was not found`)
      if (res.status < 200 || res.status >= 300) throw fail(res.status === 401 || res.status === 403 ? 'EACCES' : 'EIO', `${url} answered ${res.status}`)
      if (res.body.length > MAX_DOCUMENT) throw fail('E2BIG', `${url} is larger than 20 MB`)
      docs.set(url, { etag: res.headers['etag'], bytes: res.body, at: new Date().toISOString() })
      return { bytes: res.body, stale: false }
    } catch (e) {
      const code = (e as { code?: string }).code
      if (cached && (code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EACCES' || code === 'EIO')) return { bytes: cached.bytes, stale: true }
      throw e
    }
  }

  const json = (bytes: Uint8Array): unknown => {
    try {
      return JSON.parse(dec.decode(bytes))
    } catch {
      throw fail('EINVAL', 'the source returned something that is not JSON')
    }
  }

  const discover = async (url: string): Promise<{ disco: Discovery; fp: string | null }> => {
    const res = await get(`${url}/.well-known/pear-registry.json`)
    if (res.status === 404) throw fail('EINVAL', 'that address is not a Pear registry (no .well-known/pear-registry.json)')
    if (res.status < 200 || res.status >= 300) throw fail('EIO', `the source answered ${res.status}`)
    if (res.body.length > 256 * 1024) throw fail('E2BIG', 'the registry description is too large')
    const disco = parseDiscovery(json(res.body), url)
    return { disco, fp: disco.key ? await sha256(b64(disco.key.public)) : null }
  }

  /** A JSON document of a source. When the source advertises a key, the detached `<url>.sig` must verify. */
  const signed = async (src: Source, disco: Discovery, url: string): Promise<{ value: unknown; stale: boolean }> => {
    const doc = await document(url)
    if (disco.key) {
      const sig = await document(`${url}.sig`).catch(() => null)
      if (!sig || !(await tiny.cryptoVerify(disco.key.public, dec.decode(sig.bytes), doc.bytes))) {
        throw fail('EACCES', `${url} is not signed by ${src.name}'s key`)
      }
    }
    return { value: json(doc.bytes), stale: doc.stale }
  }

  /** The source's description, checked against the pinned key. A changed or dropped key turns the source off. */
  const open = async (src: Source): Promise<Discovery> => {
    const { disco, fp } = await discover(src.url)
    if ((src.keyFingerprint ?? null) !== fp) {
      await setEnabled(src, false)
      // fatal: never answered from the cache, because the cache was vouched for by the old key
      throw Object.assign(fail('EACCES', `${src.name} now uses a different signing key. It was turned off; remove it and add it again if you trust the change.`), { fatal: true })
    }
    discovery.set(src.id, disco)
    return disco
  }

  const catalog = async (src: Source): Promise<{ apps: Listing[]; featured: string[]; stale: boolean; disco: Discovery }> => {
    let disco: Discovery | undefined
    try {
      disco = await open(src)
      if (!disco.capabilities.includes('index')) return { apps: [], featured: [], stale: false, disco }
      const { value, stale } = await signed(src, disco, resolveUrl('index.json', disco.api, 'index'))
      const parsed = parseIndex(value, disco.api)
      indexes.set(src.id, parsed)
      status.set(src.id, { state: stale ? 'stale' : 'ok', apps: parsed.apps.length, refreshed: new Date().toISOString() })
      return { ...parsed, stale, disco }
    } catch (e) {
      const cached = indexes.get(src.id)
      const err = e as { code?: string; message?: string }
      status.set(src.id, { state: cached ? 'stale' : 'error', apps: cached?.apps.length, error: { code: err.code ?? 'EIO', message: err.message ?? String(e) } })
      const known = disco ?? discovery.get(src.id)
      if (cached && known && !(e as { fatal?: boolean }).fatal) return { ...cached, stale: true, disco: known }
      throw e
    }
  }

  const setEnabled = async (src: Source, enabled: boolean) => {
    if (src.origin === 'native') {
      const all = await read<Record<string, object>>('overrides', {})
      await write('overrides', { ...all, [src.id]: { ...all[src.id], enabled } })
    } else await write('added', (await read<Source[]>('added', [])).map((s) => (s.id === src.id ? { ...s, enabled } : s)))
  }

  const appRecord = async (src: Source, appId: string): Promise<{ app: AppRecord; stale: boolean }> => {
    const disco = discovery.get(src.id) ?? (await open(src))
    const { value, stale } = await signed(src, disco, resolveUrl(`apps/${encodeURIComponent(appId)}/app.json`, disco.api, 'app record'))
    const app = parseApp(value, disco.api)
    if (app.id !== appId) throw fail('EINVAL', `${src.name} returned a record for ${app.id}, not ${appId}`)
    return { app, stale }
  }

  // ---- fetch and check an app (the directory form; .pearapp is read by the kernel, see `prepare`)

  const fetchBundle = async (_src: Source, app: AppRecord, v: VersionRecord): Promise<Record<string, Uint8Array>> => {
    const get_: Get = async (url, accept) => {
      const r = await get(url, { accept })
      return { status: r.status, body: r.body }
    }
    const { files } = await fetchDirectory(get_, sha256, v.artifact.url, { manifestDigest: v.artifact.sha256, id: app.id, version: v.version, permissions: v.manifest.permissions })
    return files
  }

  const pickVersion = (app: AppRecord, wanted?: string): VersionRecord => {
    const v = wanted ? app.versions.find((x) => x.version === wanted) : latest(app.versions)
    if (!v) throw fail('ENOENT', wanted ? `${app.name} has no version ${wanted}` : `${app.name} has no version that can be installed`)
    if (v.yanked) throw fail('EINVAL', `${app.name} ${v.version} was withdrawn: ${v.yanked.reason || 'no reason given'}`)
    return v
  }

  const PEARAPP_MAGIC = 'PEARAPP\0'
  const MAX_PACKAGE = 80 * 1024 * 1024

  /** A `.pearapp` image, fetched and pinned to the listing's digest. The kernel reads it when it is installed. */
  const fetchArchive = async (v: VersionRecord): Promise<{ bytes: Uint8Array }> => {
    const res = await get(v.artifact.url, { accept: 'application/vnd.pear.app, application/octet-stream' })
    if (res.status === 404) throw fail('ENOENT', 'the package is not there (404)')
    if (res.status !== 200) throw fail('EIO', `the package answered ${res.status}`)
    if (res.body.length > MAX_PACKAGE) throw fail('ENOSPC', 'the package is larger than allowed')
    if (dec.decode(res.body.subarray(0, PEARAPP_MAGIC.length)) !== PEARAPP_MAGIC) throw fail('EINVAL', 'the artifact is not a Pear app package')
    if ((await sha256(res.body)) !== v.artifact.sha256) throw fail('EINVAL', 'the package does not match the digest the source published')
    return { bytes: res.body }
  }

  /**
   * A version, fetched and checked. `kind: 'directory'` comes back as `files` (for `bundleInstall`), `kind: 'archive'` as
   * `bytes` (for `bundleInstallArchive` with the same `digest`, `id`, `version` and `permissions` as `expect`).
   */
  const prepare = async (src: Source, appId: string, wanted?: string) => {
    if (!src.enabled) throw fail('EACCES', `${src.name} is turned off`)
    const { app } = await appRecord(src, appId)
    const v = pickVersion(app, wanted)
    const common = { appId, name: app.name, version: v.version, digest: v.artifact.sha256, sourceId: src.id, sourceUrl: src.url, permissions: v.manifest.permissions, publisher: app.publisher.name, unsigned: true }
    if (v.artifact.kind === 'pearapp') return { kind: 'archive' as const, bytes: (await fetchArchive(v)).bytes, ...common }
    return { kind: 'directory' as const, files: await fetchBundle(src, app, v), ...common }
  }

  // ---- operations

  const status_ = async (s: Source) => ({ ...s, status: status.get(s.id) ?? { state: 'unknown' as const }, host: new URL(s.url).host })

  const preview = async (rawUrl: unknown) => {
    const url = normalizeSourceUrl(String(rawUrl ?? ''))
    const all = await sources()
    const same = all.find((s) => s.url === url)
    if (same) throw fail('EEXIST', `${same.name} is already a source`)
    const { disco, fp } = await discover(url)
    const dup = all.find((s) => discovery.get(s.id)?.id === disco.id)
    if (dup) throw fail('EEXIST', `${dup.name} is the same registry`)
    let apps: number | null = null
    if (disco.capabilities.includes('index') && !disco.key) {
      const doc = await document(resolveUrl('index.json', disco.api, 'index')).catch(() => null)
      if (doc) apps = parseIndex(json(doc.bytes), disco.api).apps.length
    }
    return { url, host: new URL(url).host, name: disco.name, description: disco.description, icon: disco.icon ?? null, capabilities: disco.capabilities, fingerprint: fp, signed: Boolean(disco.key), apps, registryId: disco.id }
  }

  const bundleOf = async (id: string) => tiny.bundleInfo(id).catch(() => null)

  return serve(tiny, 'tiny.sources', {
    list: async (_a, m) => {
      await needSystem(tiny, m, 'list sources')
      return Promise.all((await sources()).map(status_))
    },

    preview: async (a, m) => {
      await needSystem(tiny, m, 'add a source')
      return preview(a.url)
    },

    /** `fingerprint` is what the user was shown by `preview`; if the source now says something else, nothing is added. */
    add: async (a, m) => {
      await needSystem(tiny, m, 'add a source')
      const p = await preview(a.url)
      if (a.fingerprint !== undefined && (a.fingerprint ?? '') !== (p.fingerprint ?? '')) throw fail('EACCES', 'the source changed its key while you were looking at it')
      const all = await sources()
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : p.name
      const src: Source = {
        id: sourceId(name, new Set(all.map((s) => s.id))), name, url: p.url, origin: 'user', enabled: true,
        priority: Math.max(-1, ...all.map((s) => s.priority)) + 1, addedAt: new Date().toISOString(),
        ...(p.fingerprint && { keyFingerprint: p.fingerprint }),
      }
      await write('added', [...(await read<Source[]>('added', [])), src])
      await catalog(src).catch(() => {}) // fills the status; a failure is shown in the list, not here
      return status_(src)
    },

    remove: async (a, m) => {
      await needSystem(tiny, m, 'remove a source')
      const src = await find(a.id)
      if (src.origin === 'native') throw fail('EPERM', `${src.name} is built in. You can turn it off instead.`)
      await write('added', (await read<Source[]>('added', [])).filter((s) => s.id !== src.id))
      for (const map of [discovery, indexes, status] as Array<Map<string, unknown>>) map.delete(src.id)
    },

    set: async (a, m) => {
      await needSystem(tiny, m, 'change a source')
      const src = await find(a.id)
      const change: { enabled?: boolean; priority?: number; name?: string } = {}
      if (typeof a.enabled === 'boolean') change.enabled = a.enabled
      if (typeof a.priority === 'number' && Number.isFinite(a.priority)) change.priority = a.priority
      if (typeof a.name === 'string' && a.name.trim()) change.name = a.name.trim().slice(0, 80)
      if (src.origin === 'native') {
        if (change.name !== undefined) throw fail('EPERM', 'a built-in source keeps its name')
        const all = await read<Record<string, object>>('overrides', {})
        await write('overrides', { ...all, [src.id]: { ...all[src.id], ...change } })
      } else {
        await write('added', (await read<Source[]>('added', [])).map((s) => (s.id === src.id ? { ...s, ...change } : s)))
      }
      return status_({ ...src, ...change })
    },

    refresh: async (a, m) => {
      await needSystem(tiny, m, 'refresh sources')
      const targets = a.id ? [await find(a.id)] : (await sources()).filter((s) => s.enabled)
      await Promise.all(targets.map((s) => catalog(s).catch(() => {})))
      return Promise.all(targets.map(async (s) => status_((await find(s.id)))))
    },

    /** Listings from every enabled source (or `sources`), grouped by source; the same app id in two sources stays two entries. */
    search: async (a, m) => {
      await needSystem(tiny, m, 'search sources')
      const chosen = (await sources()).filter((s) => s.enabled && (!Array.isArray(a.sources) || a.sources.includes(s.id)))
      const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 200)
      return Promise.all(chosen.map(async (src) => {
        try {
          const c = await catalog(src)
          const query = String(a.query ?? '')
          const hits = query.trim() || a.category ? searchListings(c.apps, query, { category: a.category }) : [...c.apps].sort((x, y) => Number(c.featured.includes(y.id)) - Number(c.featured.includes(x.id)) || x.name.localeCompare(y.name))
          return { sourceId: src.id, sourceName: src.name, stale: c.stale, total: hits.length, apps: hits.slice(0, limit), ...(c.stale && { error: status.get(src.id)?.error }) }
        } catch (e) {
          const err = e as { code?: string; message?: string }
          return { sourceId: src.id, sourceName: src.name, stale: false, total: 0, apps: [], error: { code: err.code ?? 'EIO', message: err.message ?? String(e) } }
        }
      }))
    },

    app: async (a, m) => {
      await needSystem(tiny, m, 'read a source')
      const src = await find(a.sourceId)
      const { app, stale } = await appRecord(src, String(a.appId))
      return { ...app, sourceId: src.id, sourceName: src.name, stale, installed: (await read<Record<string, Installed>>('installed', {}))[app.id] ?? null }
    },

    /** Fetch and check a version; the caller then installs `files` and calls `record`. */
    prepare: async (a, m) => {
      await needSystem(tiny, m, 'install from a source')
      return prepare(await find(a.sourceId), String(a.appId), typeof a.version === 'string' ? a.version : undefined)
    },

    /** Like `prepare` for an installed app, from the source it came from. New permissions need `allowNewPermissions`. */
    prepareUpdate: async (a, m) => {
      await needSystem(tiny, m, 'update from a source')
      const from = (await read<Record<string, Installed>>('installed', {}))[String(a.id)]
      if (!from) throw fail('ENOENT', `${String(a.id)} was not installed from a source`)
      const out = await prepare(await find(from.sourceId), from.appId, typeof a.version === 'string' ? a.version : undefined)
      if (compareVersions(out.version, from.version) <= 0 && !a.force) throw fail('EEXIST', `${out.name} is already up to date`)
      const have: string[] = (await bundleOf(from.appId))?.permissions ?? []
      const added = out.permissions.filter((p) => !have.includes(p))
      if (added.length && !a.allowNewPermissions) throw fail('EPERM', `the new version asks for more access: ${added.join(', ')}`)
      return { ...out, permissionsAdded: added }
    },

    /** Remember where an installed app came from; updates follow this. */
    record: async (a, m) => {
      await needSystem(tiny, m, 'record an install')
      const src = await find(a.sourceId)
      if (typeof a.id !== 'string' || typeof a.version !== 'string' || typeof a.digest !== 'string') throw fail('EINVAL', 'id, version and digest are required')
      const all = await read<Record<string, Installed>>('installed', {})
      all[a.id] = { sourceId: src.id, sourceUrl: src.url, appId: a.id, version: a.version, digest: a.digest, at: new Date().toISOString() }
      await write('installed', all)
      return all[a.id]
    },

    forget: async (a, m) => {
      await needSystem(tiny, m, 'forget an install')
      const all = await read<Record<string, Installed>>('installed', {})
      delete all[String(a.id)]
      await write('installed', all)
    },

    provenance: async (a, m) => {
      await needSystem(tiny, m, 'read install history')
      const all = await read<Record<string, Installed>>('installed', {})
      return a.id ? (all[String(a.id)] ?? null) : all
    },

    /** Ask only the source each app came from. A source that is down or turned off is reported, not skipped silently. */
    updates: async (_a, m) => {
      await needSystem(tiny, m, 'check for updates')
      const all = await read<Record<string, Installed>>('installed', {})
      const list = await sources()
      const out: Array<Record<string, unknown>> = []
      for (const rec of Object.values(all)) {
        const info = await bundleOf(rec.appId)
        if (!info) continue
        const src = list.find((s) => s.id === rec.sourceId)
        const item: Record<string, unknown> = { id: rec.appId, name: info.name, sourceId: rec.sourceId, installed: rec.version }
        if (!src || !src.enabled) out.push({ ...item, available: null, problem: src ? `${src.name} is turned off` : 'the source was removed' })
        else {
          try {
            const { app } = await appRecord(src, rec.appId)
            const next = latest(app.versions)
            const mine = app.versions.find((v) => v.version === rec.version)
            const added = next ? next.manifest.permissions.filter((p) => !(info.permissions as string[]).includes(p)) : []
            if ((next && compareVersions(next.version, rec.version) > 0) || mine?.yanked) {
              out.push({ ...item, available: next && compareVersions(next.version, rec.version) > 0 ? next.version : null, permissionsAdded: added, ...(mine?.yanked && { yanked: mine.yanked.reason }) })
            }
          } catch (e) {
            out.push({ ...item, available: null, problem: (e as Error).message })
          }
        }
      }
      return out
    },
  })
}
