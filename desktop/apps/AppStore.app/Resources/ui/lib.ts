/// Types, DOM helpers and service calls for the App Store. Everything that touches sources goes through `tiny.sources`
/// (system-only); installing goes through the kernel's `bundleInstall*`, called here because a process cannot install.
import { tiny } from '@tiny/sdk'

export interface Provides { runtime?: string; framework?: string; version: string; commands?: string[] }
export interface Req { runtime?: string; framework?: string; range: string }
export interface Listing {
  id: string
  name: string
  summary: string
  kind: string
  provides?: Provides
  version: string
  icon?: string
  publisher: { name: string }
  categories: string[]
  size: number
  updated: string
}
export interface Group {
  sourceId: string
  sourceName: string
  stale: boolean
  total: number
  featured?: string[]
  apps: Listing[]
  error?: { code: string; message: string }
}
export interface VersionRec {
  version: string
  created: string
  yanked?: { reason: string }
  manifest: { permissions: string[]; requires?: Req[] }
  releaseNotes?: string
}
export interface AppRecord extends Listing {
  description: string
  screenshots: string[]
  homepage?: string
  license?: string
  versions: VersionRec[]
  sourceId: string
  sourceName: string
  stale: boolean
}
export interface SourceRow {
  id: string
  name: string
  url: string
  host: string
  origin: 'native' | 'user'
  enabled: boolean
  keyFingerprint?: string
  status: { state: 'ok' | 'stale' | 'error' | 'unknown'; apps?: number; error?: { code: string; message: string } }
}
export interface Bundle { id: string; name: string; version: string; kind: string; system: boolean; permissions: string[]; provides?: { name?: string; framework?: string; version: string }; requires?: Req[] }
export interface Installed { sourceId: string; version: string }
export interface Update { id: string; name: string; sourceId: string; installed: string; available: string | null; permissionsAdded?: string[]; problem?: string; yanked?: string }
export interface Unmet { kind: 'runtime' | 'framework'; name: string; range: string; reason: string }
export interface Prepared {
  kind: 'archive' | 'directory'
  bytes?: Uint8Array
  files?: Record<string, Uint8Array>
  appId: string
  version: string
  digest: string
  sourceId: string
  sourceUrl: string
  permissions: string[]
}
export interface ResolveGroup { sourceId: string; sourceName: string; stale: boolean; apps: Listing[]; error?: { code: string; message: string } }

export const svc = <T,>(msg: Record<string, unknown>) => tiny.admin.service<T>('tiny.sources', msg)
export const k = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)

// ---- DOM

export type Child = Node | string | number | null | false | undefined | Child[]

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v as EventListener)
    else if (key === 'class') el.className = String(v)
    else if (key === 'disabled' || key === 'value') (el as unknown as Record<string, unknown>)[key] = v
    else el.setAttribute(key, v === true ? '' : String(v))
  }
  const add = (c: Child): void => {
    if (Array.isArray(c)) c.forEach(add)
    else if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c))
  }
  kids.forEach(add)
  return el
}

let statusEl: HTMLElement | null = null
export const bindStatus = (el: HTMLElement): void => void (statusEl = el)
export function say(msg: string, error = false): void {
  if (!statusEl) return
  statusEl.textContent = msg
  statusEl.classList.toggle('error', error)
}
/** Run an action; a failure goes to the status line instead of being thrown. */
export async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn()
    if (ok) say(ok)
    return r
  } catch (e) {
    const code = (e as { code?: string }).code
    say(`${(e as Error).message || 'Failed'}${code ? ` (${code})` : ''}`, true)
    return undefined
  }
}

// ---- wording

const KINDS: Record<string, string> = { app: 'App', tool: 'Tool', service: 'Service', runtime: 'Runtime', framework: 'Framework' }
/** An unknown kind is shown as "Other". */
export const kindLabel = (kind: string): string => KINDS[kind] ?? 'Other'

export function bytes(n: number): string {
  if (!n) return ''
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`
}

export const reqLabel = (r: Req): string => `${r.runtime !== undefined ? 'runtime' : 'framework'} ${r.runtime ?? r.framework} ${r.range}`
export const sameReq = (r: Req, u: Unmet): boolean => (r.runtime ?? r.framework) === u.name && (r.runtime !== undefined) === (u.kind === 'runtime') && r.range === u.range

/** The version that would be installed: the highest that is not withdrawn or a prerelease (the service lists them newest first). */
export const installable = (rec: AppRecord): VersionRec | undefined => rec.versions.find((v) => !v.yanked && !v.version.includes('-')) ?? rec.versions.find((v) => !v.yanked)

// ---- images: a window may not fetch, so the service reads a source's icons and screenshots

const images = new Map<string, Promise<string | null>>()
export function image(sourceId: string, url: string | undefined): Promise<string | null> {
  if (!url) return Promise.resolve(null)
  const key = `${sourceId}|${url}`
  let p = images.get(key)
  if (!p) {
    p = svc<string>({ op: 'asset', sourceId, url }).catch(() => null)
    images.set(key, p)
  }
  return p
}

const TINTS = ['#ff9f0a', '#30b0c7', '#af52de', '#34c759', '#5e5ce6', '#ff375f']
/** An icon tile: the letter now, the image when the source's icon arrives. */
export function iconTile(name: string, load: () => Promise<string | null>, big = false): HTMLElement {
  const tile = h('div', { class: `icon-tile${big ? ' big' : ''}`, 'aria-hidden': 'true', style: `background:${TINTS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % TINTS.length]}` }, name.trim()[0]?.toUpperCase() ?? '?')
  void load().then((url) => {
    if (url) tile.replaceChildren(h('img', { src: url, alt: '' }))
    if (url) tile.style.background = 'transparent'
  })
  return tile
}
