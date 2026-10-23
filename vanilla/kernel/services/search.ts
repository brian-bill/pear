import { Subscribers, callerInfo, fail, needPort, needSystem, serve, subscription } from './lib'
import type { Pear } from '../src/runtime'

type Kind = 'app' | 'folder' | 'file' | 'image' | 'text' | 'document' | 'audio' | 'video' | 'code' | 'archive'

interface Doc {
  path: string
  name: string
  lname: string
  ext: string
  kind: Kind
  dir: boolean
  size: number
  mtime: number
  tags: string[]
  /** Distinct lowercase words of the content (empty for names-only files). */
  tokens: string[]
}

interface Result {
  kind: Kind | 'provider' | 'setting' | 'calc'
  title: string
  subtitle?: string
  path?: string
  appId?: string
  provider?: string
  action?: unknown
  score: number
  size?: number
  mtime?: number
  /** Where the match was: the name, or the content. */
  match?: 'name' | 'content' | 'tag' | 'app' | 'provider'
}

interface Provider {
  id: string
  name: string
  port: number
}

interface Parsed {
  terms: string[]
  phrases: string[]
  not: string[]
  kinds: Kind[]
  names: string[]
  tags: string[]
  exts: string[]
  date: { from?: number; to?: number } | null
  size: { min?: number; max?: number } | null
}

const INDEX_FILE = '/System/Library/Search/index.json'
const INDEX_VERSION = 1
/** Folders walked by the indexer. Everything the user can see lives in one of them. */
const ROOTS = ['/Users', '/Applications']
const ALWAYS_SKIP = ['/System/Library/Search', '/Users/pear/.Trash']
const MAX_CONTENT_BYTES = 256 * 1024
const MAX_TOKENS = 2000
const MAX_DOCS = 200_000
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'html', 'htm', 'xml', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'log', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'sh', 'rs', 'py', 'c', 'h', 'svg', 'rtf', 'tex'])
const KIND_BY_EXT: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', ico: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  js: 'code', mjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', rs: 'code', py: 'code', c: 'code', h: 'code', sh: 'code', css: 'code', html: 'code', json: 'code',
  txt: 'text', md: 'text', markdown: 'text', log: 'text', csv: 'text', rtf: 'document', pdf: 'document', doc: 'document', docx: 'document', pages: 'document',
  zip: 'archive', gz: 'archive', tar: 'archive', tinyimg: 'archive',
}
const dec = new TextDecoder()
const enc = new TextEncoder()
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const parentOf = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))
const isUnder = (p: string, root: string) => root === '/' || p === root || p.startsWith(`${root}/`)
const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []
const yield_ = () => new Promise<void>((r) => setTimeout(r, 0))

function parseSize(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(v)
  if (!m) return null
  const mult = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase() as 'b']
  return Number(m[1]) * mult
}

function parseDate(v: string): { from?: number; to?: number } | null {
  const now = new Date()
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const DAY = 86_400_000
  switch (v.toLowerCase()) {
    case 'today': return { from: day }
    case 'yesterday': return { from: day - DAY, to: day }
    case 'week': return { from: day - 7 * DAY }
    case 'month': return { from: day - 30 * DAY }
    case 'year': return { from: day - 365 * DAY }
  }
  const m = /^([<>])?(\d{4}-\d{2}-\d{2})$/.exec(v)
  if (!m) return null
  const t = Date.parse(`${m[2]}T00:00:00`)
  if (Number.isNaN(t)) return null
  return m[1] === '<' ? { to: t } : m[1] === '>' ? { from: t + DAY } : { from: t, to: t + DAY }
}

/** `kind:app name:report tag:red date:week size:>1mb ext:md "exact phrase" -excluded free text`. */
export function parseQuery(q: string): Parsed {
  const p: Parsed = { terms: [], phrases: [], not: [], kinds: [], names: [], tags: [], exts: [], date: null, size: null }
  const re = /(-?)(?:(kind|name|tag|date|size|ext):)?(?:"([^"]*)"|(\S+))/gi
  for (let m; (m = re.exec(q)); ) {
    const neg = m[1] === '-'
    const key = m[2]?.toLowerCase()
    const val = (m[3] ?? m[4] ?? '').trim()
    if (!val) continue
    if (key === 'kind') p.kinds.push(val.toLowerCase().replace(/s$/, '') as Kind)
    else if (key === 'name') p.names.push(val.toLowerCase())
    else if (key === 'tag') p.tags.push(val.toLowerCase())
    else if (key === 'ext') p.exts.push(val.toLowerCase().replace(/^\./, ''))
    else if (key === 'date') p.date = parseDate(val) ?? p.date
    else if (key === 'size') {
      const op = val[0] === '<' || val[0] === '>' ? val[0] : ''
      const n = parseSize(op ? val.slice(1) : val)
      if (n !== null) p.size = op === '<' ? { max: n } : op === '>' ? { min: n } : { min: n, max: n }
    } else if (neg) p.not.push(val.toLowerCase())
    else if (m[3] !== undefined) p.phrases.push(val.toLowerCase())
    else p.terms.push(val.toLowerCase())
  }
  return p
}

// ---- built-in providers: arithmetic and unit conversion

function calc(expr: string): number | null {
  if (!/^[\d\s+\-*/().%^,]+$/.test(expr) || !/[+\-*/^%]/.test(expr)) return null
  let i = 0
  const s = expr.replace(/,/g, '').replace(/\s+/g, '')
  const peek = () => s[i]
  const num = (): number => {
    if (peek() === '(') {
      i++
      const v = add()
      if (s[i++] !== ')') throw new Error('paren')
      return v
    }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i))
    if (!m) throw new Error('number')
    i += m[0].length
    return Number(m[0])
  }
  const unary = (): number => (peek() === '-' ? (i++, -unary()) : peek() === '+' ? (i++, unary()) : pow())
  const pow = (): number => {
    const b = num()
    return peek() === '^' ? (i++, b ** unary()) : b
  }
  const mul = (): number => {
    let v = unary()
    for (;;) {
      const c = peek()
      if (c === '*') (i++, (v *= unary()))
      else if (c === '/') (i++, (v /= unary()))
      else if (c === '%') (i++, (v %= unary()))
      else return v
    }
  }
  const add = (): number => {
    let v = mul()
    for (;;) {
      const c = peek()
      if (c === '+') (i++, (v += mul()))
      else if (c === '-') (i++, (v -= mul()))
      else return v
    }
  }
  try {
    const v = add()
    return i === s.length && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

const UNITS: Record<string, [string, number]> = {
  m: ['length', 1], km: ['length', 1000], cm: ['length', 0.01], mm: ['length', 0.001], mi: ['length', 1609.344], ft: ['length', 0.3048], in: ['length', 0.0254], yd: ['length', 0.9144],
  kg: ['mass', 1], g: ['mass', 0.001], lb: ['mass', 0.45359237], oz: ['mass', 0.028349523125],
  l: ['volume', 1], ml: ['volume', 0.001], gal: ['volume', 3.785411784], floz: ['volume', 0.0295735295625],
  b: ['data', 1], kb: ['data', 1000], mb: ['data', 1e6], gb: ['data', 1e9], tb: ['data', 1e12],
  s: ['time', 1], min: ['time', 60], h: ['time', 3600], d: ['time', 86400],
}

function convert(q: string): string | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:in|to|as)\s+([a-z]+)$/i.exec(q.trim())
  if (!m) return null
  const f = m[2]!.toLowerCase()
  const t = m[3]!.toLowerCase()
  const n = Number(m[1])
  const temps: Record<string, (v: number) => number> = { c: (v) => v, f: (v) => ((v - 32) * 5) / 9, k: (v) => v - 273.15 }
  if (temps[f] && temps[t] && f !== t) {
    const c = temps[f]!(n)
    const out = t === 'c' ? c : t === 'f' ? (c * 9) / 5 + 32 : c + 273.15
    return `${+out.toFixed(4)} ${t.toUpperCase()}`
  }
  const a = UNITS[f]
  const b = UNITS[t]
  if (!a || !b || a[0] !== b[0]) return null
  return `${+((n * a[1]) / b[1]).toPrecision(8)} ${t}`
}

/**
 * `tiny.search`: indexing and querying of files, apps and provider content (`contracts/search.md`).
 *
 * The index (names, type, size, dates, tags, content words for small text files) is built by walking `/Users` and
 * `/Applications`, kept current from the file system's change feed, and saved under `/System/Library/Search`. Queries
 * return what the caller may see: apps hold `fs.all` for everything, `fs.user` for the user's files, and otherwise only
 * see their own container.
 */
export default async (tiny: Pear) => {
  const docs = new Map<string, Doc>()
  const postings = new Map<string, Set<string>>()
  const providers = new Map<number, Provider>()
  const watchers = new Subscribers<{ port: number }>(tiny)
  let excluded: string[] = []
  let indexing = false
  let scanned = 0
  let lastIndexed = 0
  let startedAt = 0
  let cursor = 0
  let dirty = false
  let generation = 0 // a rebuild bumps it so an older walk stops
  let pendingPaths = new Set<string>()
  let notifyPort = 0
  const queries = new Map<number, { cancelled: boolean }>()
  let nextQuery = 1

  const status = () => ({
    indexing, indexed: docs.size, scanned, lastIndexed, startedAt, excluded: [...excluded], contentWords: postings.size, version: INDEX_VERSION,
  })
  const changed = () => {
    dirty = true
    void watchers.send({ type: 'changed', status: status() })
  }
  const skipped = (p: string) => ALWAYS_SKIP.some((s) => isUnder(p, s)) || excluded.some((e) => isUnder(p, e)) || baseName(p).startsWith('.DS_Store')

  const unindex = (path: string, subtree = false) => {
    for (const [p, d] of [...docs]) {
      if (p !== path && !(subtree && isUnder(p, path))) continue
      for (const t of d.tokens) {
        const set = postings.get(t)
        if (set?.delete(p) && set.size === 0) postings.delete(t)
      }
      docs.delete(p)
    }
  }

  const kindOf = (name: string, dir: boolean): Kind => {
    if (name.endsWith('.app')) return 'app'
    if (dir) return 'folder'
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    return KIND_BY_EXT[ext] ?? 'file'
  }

  /** (Re)index one path. A directory is not walked here. Returns the stat so the caller can recurse. */
  const indexOne = async (path: string, known?: Doc): Promise<Doc | null> => {
    if (skipped(path)) return null
    let st
    try {
      st = await tiny.lstat(path)
    } catch {
      unindex(path)
      return null
    }
    if (st.kind === 'symlink') return null
    const name = baseName(path)
    const dir = st.kind === 'dir'
    const ext = !dir && name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : name.endsWith('.app') ? 'app' : ''
    const old = known ?? docs.get(path)
    let tags: string[] = old?.tags ?? []
    try {
      const raw = await tiny.getxattr(path, 'user.tags')
      tags = raw ? String(raw).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : []
    } catch {
      // no xattr support here
    }
    let tokens: string[] = []
    if (old && old.mtime === st.mtime && old.size === st.size) tokens = old.tokens
    else if (!dir && TEXT_EXT.has(ext) && st.size <= MAX_CONTENT_BYTES) {
      try {
        tokens = [...new Set(wordsOf(dec.decode(await tiny.readFile(path)).slice(0, 64 * 1024)))].slice(0, MAX_TOKENS)
      } catch {
        tokens = []
      }
    }
    if (old) unindex(path)
    if (docs.size >= MAX_DOCS) return null
    const doc: Doc = { path, name, lname: name.toLowerCase(), ext, kind: kindOf(name, dir), dir, size: st.size, mtime: st.mtime, tags, tokens }
    docs.set(path, doc)
    for (const t of tokens) {
      let set = postings.get(t)
      if (!set) postings.set(t, (set = new Set()))
      set.add(path)
    }
    return doc
  }

  /** Walk below `dir`, indexing every entry. An `.app` bundle is one result: its insides are not walked. */
  const walk = async (dir: string, gen: number, seen?: Set<string>): Promise<void> => {
    if (skipped(dir)) return
    let entries
    try {
      entries = await tiny.readdir(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (gen !== generation) return
      const path = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`
      if (skipped(path)) continue
      seen?.add(path)
      await indexOne(path)
      if (++scanned % 100 === 0) {
        await yield_() // low priority: let other work in
        if (scanned % 1000 === 0) void watchers.send({ type: 'progress', status: status() })
      }
      if (e.kind === 'dir' && !e.name.endsWith('.app')) await walk(path, gen, seen)
    }
  }

  const crawl = async (paths: string[] = ROOTS) => {
    const gen = ++generation
    indexing = true
    scanned = 0
    startedAt = Date.now()
    void watchers.send({ type: 'progress', status: status() })
    const seen = new Set<string>()
    for (const root of paths) {
      await indexOne(root)
      seen.add(root)
      await walk(root, gen, seen)
    }
    if (gen !== generation) return // superseded by a newer crawl
    // forget what is gone since the last session
    for (const p of [...docs.keys()]) if (paths.some((r) => isUnder(p, r)) && !seen.has(p)) unindex(p)
    indexing = false
    lastIndexed = Date.now()
    changed()
    await save()
  }

  // ---- persistence

  const save = async () => {
    if (!dirty) return
    dirty = false
    try {
      await tiny.mkdir('/System/Library/Search', { recursive: true })
      const body = JSON.stringify({ version: INDEX_VERSION, savedAt: Date.now(), cursor, docs: [...docs.values()] })
      await tiny.writeFileAtomic(INDEX_FILE, enc.encode(body))
    } catch {
      dirty = true // try again next time (quota)
    }
  }

  const load = async () => {
    try {
      const j = JSON.parse(dec.decode(await tiny.readFile(INDEX_FILE)))
      if (j.version !== INDEX_VERSION) return
      for (const d of j.docs as Doc[]) {
        docs.set(d.path, d)
        for (const t of d.tokens) {
          let set = postings.get(t)
          if (!set) postings.set(t, (set = new Set()))
          set.add(d.path)
        }
      }
      lastIndexed = j.savedAt
    } catch {
      // first run, or a damaged index: crawl builds it again
    }
  }

  // ---- following changes

  let following: Promise<void> = Promise.resolve()
  /** One pass at a time: the timer and `index.sync` take turns. */
  const follow = (): Promise<void> => (following = following.then(followOnce))
  const followOnce = async () => {
    try {
      const r = await tiny.fsChanges(cursor)
      cursor = r.cursor
      if (r.lost && !indexing) return void crawl()
      if (!r.events.length) return
      const touched = new Set<string>()
      for (const e of r.events) {
        if (e.kind === 'renamed' && e.oldPath) {
          unindex(e.oldPath, true)
          touched.add(e.path)
        } else if (e.kind === 'deleted') unindex(e.path, true)
        else touched.add(e.path)
      }
      for (const p of touched) {
        if (!ROOTS.some((root) => isUnder(p, root)) || skipped(p)) continue
        const d = await indexOne(p)
        // a renamed or created folder brings its contents
        if (d?.dir && !d.name.endsWith('.app')) await walk(p, generation)
      }
      lastIndexed = Date.now()
      changed()
    } catch {
      // try again on the next tick
    }
  }

  // ---- querying

  const matches = (d: Doc, q: Parsed): number => {
    if (q.kinds.length && !q.kinds.some((k) => k === d.kind || (k === 'folder' && d.dir) || (k === 'file' && !d.dir))) return -1
    if (q.exts.length && !q.exts.includes(d.ext)) return -1
    if (q.tags.length && !q.tags.every((t) => d.tags.includes(t))) return -1
    if (q.date) {
      if (q.date.from !== undefined && d.mtime < q.date.from) return -1
      if (q.date.to !== undefined && d.mtime >= q.date.to) return -1
    }
    if (q.size && (d.size < (q.size.min ?? 0) || d.size > (q.size.max ?? Infinity))) return -1
    if (q.names.some((n) => !d.lname.includes(n))) return -1
    for (const n of q.not) if (d.lname.includes(n) || d.tokens.includes(n)) return -1
    let score = 0
    const words = d.lname.split(/[^\p{L}\p{N}]+/u)
    for (const t of [...q.terms, ...q.phrases]) {
      if (d.lname === t || d.lname.replace(/\.[^.]*$/, '') === t) score += 100
      else if (d.lname.startsWith(t)) score += 70
      else if (words.some((w) => w.startsWith(t))) score += 55
      else if (d.lname.includes(t)) score += 40
      else if (d.tags.includes(t)) score += 30
      else if (d.tokens.includes(t)) score += 10
      else return -1
    }
    for (const n of q.names) score += d.lname.startsWith(n) ? 60 : 35
    return score + (q.terms.length + q.phrases.length === 0 ? 1 : 0)
  }

  const allowed = async (m: { from: number }) => {
    const who = await callerInfo(tiny, m as never)
    if (who.system || !who.appId) return () => true
    if ((await tiny.permCheck('fs.all', undefined, { as: m.from })) === 'granted') return () => true
    if ((await tiny.permCheck('fs.user', undefined, { as: m.from })) === 'granted') return (p: string) => /^\/(Users|Applications)(\/|$)/.test(p)
    const mine = `/Library/Containers/${who.appId}`
    return (p: string) => p.includes(`${mine}/`) || p.endsWith(mine) || /^\/Applications(\/|$)/.test(p)
  }

  const recents = async () => {
    const out = new Map<string, number>()
    try {
      for (const r of await tiny.launchRecents()) out.set(r.target, Math.max(out.get(r.target) ?? 0, r.time))
    } catch {
      // no launch service yet
    }
    return out
  }

  const fromDoc = (d: Doc, score: number, recent: Map<string, number>): Result => {
    const used = recent.get(d.path)
    const boost = used ? Math.max(0, 20 - (Date.now() - used) / 3_600_000 / 24) : 0 // frecency: used within the last days
    return {
      kind: d.kind, title: d.name, subtitle: parentOf(d.path), path: d.path, score: score + boost, size: d.size, mtime: d.mtime,
      match: score >= 40 ? 'name' : score >= 30 ? 'tag' : 'content',
    }
  }

  const queryAll = async (text: string, a: Record<string, any>, m: { from: number }, emit?: (batch: Result[], done: boolean) => Promise<void>) => {
    const q = parseQuery(text)
    const limit = Math.max(1, Math.min(Number(a.limit ?? 50), 500))
    const scopes: string[] = Array.isArray(a.scopes) ? a.scopes : ['all']
    const types: string[] | undefined = Array.isArray(a.types) ? a.types : undefined
    const see = await allowed(m)
    const recent = await recents()
    const handle = { cancelled: false }
    const id = nextQuery++
    queries.set(id, handle)
    const out: Result[] = []
    const push = async (batch: Result[], done = false) => {
      out.push(...batch)
      await emit?.(batch, done)
    }
    try {
      const wantFiles = scopes.some((s) => s === 'all' || s === 'files' || s.startsWith('/'))
      const bare = !q.terms.length && !q.phrases.length && !q.names.length && !q.kinds.length && !q.tags.length && !q.exts.length && !q.date && !q.size
      if (bare && !text.trim()) return { id, results: [], status: status() }

      // 1. apps (fast, first)
      if (scopes.includes('all') || scopes.includes('apps')) {
        const apps: Result[] = []
        for (const app of await tiny.launchApps()) {
          const name = app.name.toLowerCase()
          const words = q.terms
          if (q.kinds.length && !q.kinds.includes('app')) break
          if (!words.length && !q.names.length) continue
          if (![...words, ...q.names].every((t) => name.includes(t))) continue
          const base = name.startsWith(words[0] ?? q.names[0]!) ? 120 : 90
          const used = recent.get(app.id) ?? [...recent.entries()].find(([k]) => k === app.path)?.[1] ?? 0
          apps.push({ kind: 'app', title: app.name, subtitle: app.id, path: app.path, appId: app.id, score: base + (used ? 15 : 0), match: 'app' })
        }
        await push(apps)
      }
      // 2. providers and built-ins
      if (scopes.includes('all') || scopes.includes('providers') || scopes.includes('settings')) {
        const extra: Result[] = []
        const v = calc(text.trim())
        if (v !== null) extra.push({ kind: 'calc', title: String(+v.toPrecision(12)), subtitle: text.trim(), score: 200, provider: 'calculator', match: 'provider' })
        const c = convert(text)
        if (c) extra.push({ kind: 'calc', title: c, subtitle: text.trim(), score: 200, provider: 'units', match: 'provider' })
        await push(extra)
        const asks = [...providers.values()]
          .filter((p) => scopes.includes('all') || scopes.includes('providers') || scopes.includes(p.id))
          .map(async (p) => {
            try {
              const r = await tiny.request(p.port, { type: 'search', query: text, limit }, { timeout: 400 })
              const list = Array.isArray((r.data as { results?: unknown })?.results) ? ((r.data as { results: any[] }).results) : []
              return list.slice(0, limit).map((x): Result => ({
                kind: x.kind === 'setting' ? 'setting' : 'provider', title: String(x.title ?? ''), subtitle: x.subtitle === undefined ? undefined : String(x.subtitle),
                provider: p.id, action: x.action, score: Number(x.score ?? 50), match: 'provider',
              }))
            } catch {
              return [] as Result[]
            }
          })
        for (const batch of await Promise.all(asks)) await push(batch)
      }
      // 3. files: names and tags first, then content
      if (wantFiles && (!types || types.some((t) => t !== 'app'))) {
        const roots = scopes.filter((s) => s.startsWith('/'))
        const files: Result[] = []
        let seen = 0
        for (const d of docs.values()) {
          if (handle.cancelled) break
          if (++seen % 5000 === 0) await yield_()
          if (roots.length && !roots.some((r) => isUnder(d.path, r))) continue
          if (types && !types.includes(d.kind)) continue
          if (!see(d.path)) continue
          const score = matches(d, q)
          if (score < 0) continue
          files.push(fromDoc(d, score, recent))
        }
        files.sort((x, y) => y.score - x.score)
        await push(files.slice(0, limit * 2))
      }
      const sort = String(a.sort ?? 'relevance')
      const cmp: Record<string, (x: Result, y: Result) => number> = {
        relevance: (x, y) => y.score - x.score || x.title.localeCompare(y.title),
        name: (x, y) => x.title.localeCompare(y.title),
        date: (x, y) => (y.mtime ?? 0) - (x.mtime ?? 0),
        size: (x, y) => (y.size ?? 0) - (x.size ?? 0),
      }
      out.sort(cmp[sort] ?? cmp.relevance!)
      const results = out.slice(0, limit)
      await emit?.([], true)
      return { id, results, status: status() }
    } finally {
      queries.delete(id)
    }
  }

  // ---- settings

  excluded = ((await tiny.configGet('tiny.search', 'excluded', [])) as string[]) ?? []
  await load()
  void (async () => {
    // the cursor is taken before the walk, so nothing that changes during it is missed
    cursor = (await tiny.fsChanges(0)).cursor
    await crawl()
  })()
  setInterval(() => void follow().then(() => save()), 1000)

  return serve(
    tiny,
    'tiny.search',
    {
      query: async (a, m) => {
        if (typeof a.q !== 'string' || a.q.length > 500) throw fail('EINVAL', 'q must be text up to 500 characters')
        const stream = m.rights[0]
        if (stream === undefined) return queryAll(a.q, a, m)
        // incremental: partial batches arrive on the port as {type: 'results', query, results, done}
        const done = queryAll(a.q, a, m, async (batch, finished) => {
          await tiny.send(stream, { type: 'results', tag: a.tag ?? null, results: batch, done: finished }).catch(() => {})
        })
        return done
      },
      cancel: (a) => {
        const q = queries.get(a.id)
        if (q) q.cancelled = true
      },
      status: () => status(),
      'index.status': () => status(),
      'index.rebuild': async (a, m) => {
        await needSystem(tiny, m, 'rebuild the index')
        if (a.path !== undefined && (typeof a.path !== 'string' || !a.path.startsWith('/'))) throw fail('EINVAL', 'path must be absolute')
        if (a.path === undefined) {
          docs.clear()
          postings.clear()
        } else unindex(a.path, true)
        void crawl(a.path === undefined ? ROOTS : [a.path])
      },
      'index.exclude': async (a, m) => {
        await needSystem(tiny, m, 'change the index')
        if (typeof a.path !== 'string' || !a.path.startsWith('/')) throw fail('EINVAL', 'path must be absolute')
        if (!excluded.includes(a.path)) excluded = [...excluded, a.path]
        await tiny.configSet('tiny.search', 'excluded', excluded)
        unindex(a.path, true)
        changed()
      },
      'index.include': async (a, m) => {
        await needSystem(tiny, m, 'change the index')
        excluded = excluded.filter((p) => p !== a.path)
        await tiny.configSet('tiny.search', 'excluded', excluded)
        void crawl([String(a.path)])
      },
      'index.excluded': () => [...excluded],
      'index.sync': async () => {
        await follow()
        return status()
      },
      /** Index a path right now (Finder just saved something and wants it findable). */
      'index.touch': async (a, m) => {
        await needSystem(tiny, m, 'index files')
        const d = await indexOne(String(a.path))
        if (d?.dir && !d.name.endsWith('.app')) await walk(d.path, generation)
        changed()
      },
      register: async (a, m) => {
        const port = needPort(m, 'pass the port the provider listens on in rights')
        if (typeof a.id !== 'string' || !a.id) throw fail('EINVAL', 'a provider needs an id')
        if (providers.size >= 32) throw fail('EMFILE', 'too many providers')
        const who = await callerInfo(tiny, m as never)
        if (who.appId && !a.id.startsWith(who.appId)) throw fail('EPERM', 'an app may register only providers whose id starts with its own')
        providers.set(port, { id: a.id, name: String(a.name ?? a.id), port })
        // a provider whose process is gone is dropped
        await tiny.watch(port, notifyPort).catch(() => {})
      },
      unregister: (_a, m) => void providers.delete(m.rights[0] as number),
      providers: () => [...providers.values()].map(({ id, name }) => ({ id, name })),
      ...subscription(watchers),
    },
    async (d) => {
      if (d?.type === 'dead-name') return void providers.delete(d.port)
      if (d?.type === 'config-changed' && d.domain === 'tiny.search') excluded = ((await tiny.configGet('tiny.search', 'excluded', [])) as string[]) ?? []
    },
    async (port) => {
      notifyPort = port
      await tiny.configWatch('tiny.search', 'excluded', port)
    },
  )
}
