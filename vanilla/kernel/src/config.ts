/// Settings and light state: namespaced keys with an in-memory cache. The kernel runs in a Worker, which has no
/// LocalStorage, so the page that owns it does the storing (`client.ts`): it hands over a snapshot at boot, applies the
/// writes this class reports, and forwards `storage` events from other tabs.
import { SysError } from './errors'

export type ConfigScope = 'system' | 'user'
export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue }
type TypeName = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'

interface SchemaEntry {
  type: TypeName | TypeName[]
  default?: ConfigValue
  /** Allowed values. */
  enum?: ConfigValue[]
}
export type Schema = Record<string, SchemaEntry>

export interface ConfigChange {
  domain: string
  key: string
  scope: ConfigScope
  /** The new effective value (user over system over default), or `null` if there is none. */
  value: ConfigValue | null
  /** True when another tab made the change. */
  external: boolean
}

/** Where changes go. Called with the storage key and the whole JSON text of that scope + domain, or `null` to remove it. */
type ConfigSink = (storageKey: string, value: string | null) => void

/** A value over this many bytes of JSON belongs in a file. */
const MAX_VALUE_BYTES = 64 * 1024
const DOMAIN = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/
const WRITE_DELAY_MS = 50

const typeOf = (v: unknown): TypeName => (v === null ? 'null' : Array.isArray(v) ? 'array' : (typeof v as TypeName))

export class Config {
  private data = new Map<string, Record<string, ConfigValue>>() // `${scope}:${domain}` -> values
  private schemas = new Map<string, Schema>()
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<(c: ConfigChange) => void>()
  /** Set when the sink fails (storage full or unavailable): values still work, in memory only. */
  private degraded = false

  constructor(
    private prefix: string,
    snapshot: Record<string, string>,
    private sink: ConfigSink,
    private warn: (message: string) => void = () => {},
  ) {
    for (const [storageKey, text] of Object.entries(snapshot)) {
      if (!storageKey.startsWith(prefix)) continue
      const parsed = parse(text)
      if (parsed) this.data.set(storageKey.slice(prefix.length), parsed)
    }
  }

  private static domainOk(domain: unknown): asserts domain is string {
    if (typeof domain !== 'string' || domain.length > 128 || !DOMAIN.test(domain)) throw new SysError('EINVAL', `bad config domain ${String(domain)}`)
  }
  private static keyOk(key: unknown): asserts key is string {
    if (typeof key !== 'string' || !key || key.length > 128) throw new SysError('EINVAL', 'bad config key')
  }

  onChange(fn: (c: ConfigChange) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Later writes that do not match the schema are `EINVAL`. */
  register(domain: string, schema: Schema): void {
    Config.domainOk(domain)
    this.schemas.set(domain, { ...this.schemas.get(domain), ...schema })
  }

  private scopeData(scope: ConfigScope, domain: string) {
    return this.data.get(`${scope}:${domain}`)
  }

  private effective(domain: string, key: string): ConfigValue | undefined {
    const user = this.scopeData('user', domain)
    if (user && key in user) return user[key]
    const system = this.scopeData('system', domain)
    if (system && key in system) return system[key]
    return this.schemas.get(domain)?.[key]?.default
  }

  get(domain: string, key: string, fallback?: ConfigValue): ConfigValue {
    Config.domainOk(domain)
    Config.keyOk(key)
    const v = this.effective(domain, key)
    return clone(v !== undefined ? v : (fallback ?? null))
  }

  has(domain: string, key: string): boolean {
    return this.effective(domain, key) !== undefined
  }

  list(domain: string): Record<string, ConfigValue> {
    Config.domainOk(domain)
    const out: Record<string, ConfigValue> = {}
    for (const [k, e] of Object.entries(this.schemas.get(domain) ?? {})) if (e.default !== undefined) out[k] = e.default
    Object.assign(out, this.scopeData('system', domain), this.scopeData('user', domain))
    return clone(out) as Record<string, ConfigValue>
  }

  domains(): string[] {
    return [...new Set([...this.data.keys()].map((k) => k.slice(k.indexOf(':') + 1)))].sort()
  }

  set(domain: string, key: string, value: unknown, scope: ConfigScope = 'user'): void {
    Config.domainOk(domain)
    Config.keyOk(key)
    if (scope !== 'user' && scope !== 'system') throw new SysError('EINVAL', 'scope must be user or system')
    const plain = this.validate(domain, key, value)
    const before = this.effective(domain, key)
    const bucket = this.bucket(scope, domain)
    bucket[key] = plain
    this.changed(scope, domain, key, before, false)
  }

  delete(domain: string, key: string, scope: ConfigScope = 'user'): void {
    Config.domainOk(domain)
    Config.keyOk(key)
    const bucket = this.scopeData(scope, domain)
    if (!bucket || !(key in bucket)) return
    const before = this.effective(domain, key)
    delete bucket[key]
    this.changed(scope, domain, key, before, false)
  }

  /** Remove every stored value of a domain (defaults apply again). */
  reset(domain: string, scope: ConfigScope = 'user'): void {
    Config.domainOk(domain)
    const bucket = this.scopeData(scope, domain)
    if (!bucket) return
    for (const key of Object.keys(bucket)) this.delete(domain, key, scope)
  }

  private bucket(scope: ConfigScope, domain: string): Record<string, ConfigValue> {
    const id = `${scope}:${domain}`
    let b = this.data.get(id)
    if (!b) this.data.set(id, (b = {}))
    return b
  }

  private validate(domain: string, key: string, value: unknown): ConfigValue {
    let text: string | undefined
    try {
      text = JSON.stringify(value)
    } catch {
      text = undefined
    }
    if (text === undefined) throw new SysError('EINVAL', 'config values must be JSON')
    if (text.length > MAX_VALUE_BYTES) throw new SysError('E2BIG', `value is over ${MAX_VALUE_BYTES} bytes: store it as a file`)
    const plain = JSON.parse(text) as ConfigValue
    const entry = this.schemas.get(domain)?.[key]
    if (entry) {
      const types = Array.isArray(entry.type) ? entry.type : [entry.type]
      if (!types.includes(typeOf(plain))) throw new SysError('EINVAL', `${domain}.${key} must be ${types.join(' or ')}`)
      if (entry.enum && !entry.enum.some((e) => JSON.stringify(e) === text)) {
        throw new SysError('EINVAL', `${domain}.${key} must be one of ${entry.enum.map((e) => JSON.stringify(e)).join(', ')}`)
      }
    }
    return plain
  }

  private changed(scope: ConfigScope, domain: string, key: string, before: ConfigValue | undefined, external: boolean): void {
    const bucket = this.scopeData(scope, domain)
    if (bucket && !Object.keys(bucket).length) this.data.delete(`${scope}:${domain}`)
    const after = this.effective(domain, key)
    if (!external) {
      this.pending.add(`${scope}:${domain}`)
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS)
    }
    if (JSON.stringify(before) === JSON.stringify(after) && !external) return
    const change: ConfigChange = { domain, key, scope, value: after === undefined ? null : clone(after), external }
    for (const l of this.listeners) l(change)
  }

  flush(): void {
    clearTimeout(this.timer)
    for (const id of this.pending) {
      const bucket = this.data.get(id)
      try {
        this.sink(this.prefix + id, bucket ? JSON.stringify(bucket) : null)
      } catch (e) {
        if (!this.degraded) this.warn(`settings cannot be saved: ${(e as Error).message}`)
        this.degraded = true
      }
    }
    this.pending.clear()
  }

  /** Another tab changed (or removed) a stored domain: take its version and tell watchers what differs. */
  applyExternal(storageKey: string, text: string | null): void {
    if (!storageKey.startsWith(this.prefix)) return
    const id = storageKey.slice(this.prefix.length)
    const colon = id.indexOf(':')
    const scope = id.slice(0, colon) as ConfigScope
    const domain = id.slice(colon + 1)
    if ((scope !== 'user' && scope !== 'system') || !DOMAIN.test(domain)) return
    const old = this.scopeData(scope, domain) ?? {}
    const next = (text === null ? null : parse(text)) ?? {}
    const keys = new Set([...Object.keys(old), ...Object.keys(next)])
    const before = new Map([...keys].map((k) => [k, this.effective(domain, k)]))
    if (Object.keys(next).length) this.data.set(id, next)
    else this.data.delete(id)
    for (const k of keys) {
      if (JSON.stringify(old[k]) !== JSON.stringify(next[k])) this.changed(scope, domain, k, before.get(k), true)
    }
  }
}

function parse(text: string): Record<string, ConfigValue> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

const clone = <T>(v: T): T => (v === undefined || v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T))

/** Defaults for the well-known domains (see `contracts/configuration.md`). */
export const WELL_KNOWN: Record<string, Schema> = {
  'tiny.system': {
    appearance: { type: 'string', default: 'auto', enum: ['light', 'dark', 'auto'] },
    accentColor: { type: 'string', default: 'blue' },
    locale: { type: 'string', default: 'en-US' },
    timezone: { type: 'string', default: 'auto' },
    reduceMotion: { type: 'boolean', default: false },
    reduceTransparency: { type: 'boolean', default: false },
    textScale: { type: 'number', default: 1 },
    highContrast: { type: 'boolean', default: false },
    /** Force an accessibility value whatever the host says, e.g. `{reduceMotion: false}`. */
    accessibilityOverride: { type: 'object', default: {} },
    hostname: { type: 'string', default: 'pear.local' },
    /** `null` follows the host. */
    region: { type: ['string', 'null'], default: null },
    firstWeekday: { type: ['number', 'null'], default: null },
    measurement: { type: ['string', 'null'], default: null },
    languages: { type: 'array', default: [] },
  },
  'tiny.session': {
    /** Apps to open at login: bundle ids. */
    startupItems: { type: 'array', default: [] },
    /** Ask for "Reopen windows?" after an unclean shutdown, instead of restoring silently. */
    restoreOnCrash: { type: 'string', default: 'ask', enum: ['ask', 'always', 'never'] },
    lockOnWake: { type: 'boolean', default: false },
    /** Hash of the unlock password; empty means the lock screen opens without one. */
    lockHash: { type: 'string', default: '' },
    lockSalt: { type: 'string', default: '' },
  },
  'tiny.network': {
    /** Per-app rules: `{appId: {mode: 'allow' | 'deny', hosts?: string[]}}`. */
    rules: { type: 'object', default: {} },
    /** Base URL of a CORS proxy for development; empty for none. Requests go to `proxy + encodeURIComponent(url)`. */
    proxy: { type: 'string', default: '' },
  },
  'tiny.search': {
    /** Paths left out of the index (the "Privacy" list). */
    excluded: { type: 'array', default: [] },
  },
  'tiny.input': {
    /** Which host key counts as Cmd: `auto` is Meta on Mac hosts and Ctrl elsewhere. */
    cmdMapping: { type: 'string', default: 'auto', enum: ['auto', 'meta', 'ctrl'] },
    layout: { type: 'string', default: 'us' },
  },
  'tiny.audio': {
    volume: { type: 'number', default: 1 },
    muted: { type: 'boolean', default: false },
    device: { type: ['string', 'null'], default: null },
    /** Volume per app id; apps not listed play at 1. */
    appVolumes: { type: 'object', default: {} },
    mutedApps: { type: 'array', default: [] },
  },
  'tiny.desktop.dock': {
    items: { type: 'array', default: [] },
    size: { type: 'number', default: 48 },
    position: { type: 'string', default: 'bottom', enum: ['bottom', 'left', 'right'] },
    autohide: { type: 'boolean', default: false },
    magnification: { type: 'boolean', default: true },
  },
  'tiny.desktop.wallpaper': {
    path: { type: ['string', 'null'], default: null },
    fit: { type: 'string', default: 'fill' },
    perDisplay: { type: 'object', default: {} },
  },
  'tiny.desktop.session': {
    windows: { type: 'array', default: [] },
    openApps: { type: 'array', default: [] },
    activeApp: { type: ['string', 'null'], default: null },
  },
  'tiny.desktop.finder': {
    viewMode: { type: 'string', default: 'icons' },
    sidebar: { type: 'array', default: [] },
    showHidden: { type: 'boolean', default: false },
  },
}
