import { tiny } from '@tiny/sdk'
import { attempt, button, group, h, line, say, sys, toggle } from '../lib'

/// App sources (`contracts/app-registry.md`): the list of places apps can be installed from, a way to add one, and
/// browsing, installing and updating from them. The `tiny.sources` service does the work; this is the view.

interface SourceRow {
  id: string
  name: string
  url: string
  host: string
  origin: 'native' | 'user'
  enabled: boolean
  keyFingerprint?: string
  status: { state: 'ok' | 'stale' | 'error' | 'unknown'; apps?: number; refreshed?: string; error?: { code: string; message: string } }
}
interface Preview {
  url: string
  host: string
  name: string
  description: string
  capabilities: string[]
  fingerprint: string | null
  signed: boolean
  apps: number | null
}
interface Listing { id: string; name: string; summary: string; version: string; publisher: { name: string }; categories: string[] }
interface Group { sourceId: string; sourceName: string; stale: boolean; total: number; apps: Listing[]; error?: { code: string; message: string } }
interface AppRecord extends Listing { description: string; sourceName: string; versions: Array<{ version: string; yanked?: { reason: string }; manifest: { permissions: string[] } }> }
interface Update { id: string; name: string; sourceId: string; installed: string; available: string | null; permissionsAdded?: string[]; problem?: string; yanked?: string }
interface Installed { sourceId: string; version: string }
interface Prepared {
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

/** Hand a checked version to the kernel: a package is verified again there against the listing; a directory was checked by the service. */
async function place(p: Prepared, update: boolean): Promise<{ id: string; name: string }> {
  const from = { kind: 'registry', sourceId: p.sourceId, url: p.sourceUrl, version: p.version, digest: p.digest, unsigned: true }
  if (p.kind === 'archive') {
    return k('bundleInstallArchive', new Blob([p.bytes as BlobPart]), { update, expectDigest: p.digest, expect: { id: p.appId, version: p.version, permissions: p.permissions }, from })
  }
  return update ? k('bundleUpdate', p.appId, { files: p.files }, { from }) : k('bundleInstall', { files: p.files }, { from })
}

const svc = <T,>(msg: Record<string, unknown>) => sys<T>('tiny.sources', msg)
const k = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)

const ago = (iso?: string): string => {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

function describe(s: SourceRow): string {
  const st = s.status
  const state = !s.enabled ? 'Off' : st.state === 'ok' ? `Online · ${st.apps ?? 0} apps · refreshed ${ago(st.refreshed)}`
    : st.state === 'stale' ? `Unreachable · showing the last copy${st.error ? ` (${st.error.message})` : ''}`
    : st.state === 'error' ? `Problem: ${st.error?.message ?? 'unknown'}` : 'Not checked yet'
  return `${s.host} · ${s.origin === 'native' ? 'Built-in' : 'Added by you'}${s.keyFingerprint ? ' · signed' : ''} · ${state}`
}

let openedWith = ''

/** The list of sources, with turn off, remove, refresh and add. `onChange` runs after the list changed. */
export async function sourcesSection(onChange: () => void, openWith?: string): Promise<HTMLElement> {
  const list = h('div', { class: 'group', id: 'sources' })
  const draw = async (refresh = false): Promise<void> => {
    if (refresh) await attempt(() => svc({ op: 'refresh' }))
    const rows = await svc<SourceRow[]>({ op: 'list' })
    list.replaceChildren(...(rows.length ? rows.map((s) => h('div', { class: 'line', 'data-source': s.id },
      h('div', { class: 'label' }, s.name, h('small', null, describe(s))),
      h('div', { class: 'ctl' },
        toggle(`Use ${s.name}`, s.enabled, async (on) => {
          await attempt(() => svc({ op: 'set', id: s.id, enabled: on }))
          await draw()
          onChange()
        }),
        s.origin === 'user' ? button('Remove', async () => {
          if (!(await tiny.dialogs.confirm(`Remove ${s.name}?`, { detail: 'Apps already installed from it stay installed, but will not get updates from it.', danger: true, buttons: ['Remove', 'Cancel'] }))) return
          if ((await attempt(() => svc({ op: 'remove', id: s.id }), `${s.name} was removed.`)) === undefined) return
          await draw()
          onChange()
        }, 'danger', { 'aria-label': `Remove ${s.name}` }) : null))) : [line('No sources. Add one to find apps.')]))
  }
  await draw()
  const add = async (given?: string): Promise<void> => {
    const address = given ?? (await tiny.dialogs.prompt('Address of the source', { title: 'Add Source' }))
    if (!address?.trim()) return
    const p = await attempt(() => svc<Preview>({ op: 'preview', url: address }))
    if (!p) return
    const detail = [
      p.description,
      `Address: ${p.host}`,
      p.signed ? `Signed. Key fingerprint: ${p.fingerprint!.slice(0, 16)}…` : 'Not signed: you are trusting the address only.',
      p.apps !== null ? `${p.apps} apps listed.` : null,
      '',
      'Apps from this source can ask for permissions. You review each app before it installs.',
    ].filter((x) => x !== null).join('\n')
    if (!(await tiny.dialogs.confirm(`Add “${p.name}” as a source?`, { detail, buttons: ['Add Source', 'Cancel'] }))) return
    if ((await attempt(() => svc({ op: 'add', url: address, fingerprint: p.fingerprint ?? '' }), `${p.name} was added.`)) === undefined) return
    await draw()
    onChange()
  }
  const section = h('section', { id: 'app-sources' }, h('h2', null, 'App sources'), list,
    h('div', { class: 'line' }, h('div', { class: 'label' }, h('small', null, 'Anyone can run a source on their own domain. Pear adds none by itself beyond the built-in ones.')),
      h('div', { class: 'ctl' }, button('Refresh', async () => { await draw(true); say('Sources refreshed.') }), button('Add Source…', () => add()))))
  // a link that offered this source (`?addSource=`) opens the same review, with the address filled in; nothing is added until confirmed
  if (openWith && openedWith !== openWith) {
    openedWith = openWith // the pane is drawn again when it is shown; the link is asked about once
    void add(openWith)
  }
  return section
}

/** What the user is told before an app installs from a source. */
async function confirmInstall(rec: AppRecord, version: string, permissions: string[], source: SourceRow | undefined, verb: string, extra: string[] = []): Promise<boolean> {
  const warn = source?.origin === 'user' && (await k<string | boolean>('configGet', 'tiny.apps.sources', 'warnUserSources', true)) !== false
  const detail = [
    `Version ${version} · from ${source?.name ?? rec.sourceName} (${source?.host ?? '?'})${rec.publisher.name ? ` · by ${rec.publisher.name}` : ''}`,
    permissions.length ? `Can ask to use: ${permissions.join(', ')}.` : 'Asks for no special access.',
    ...extra,
    'This version has no verified publisher.',
    warn ? 'This source was added by you, not built in. Only install apps you trust.' : '',
  ].filter(Boolean).join('\n')
  return tiny.dialogs.confirm(`${verb} “${rec.name}”?`, { detail, buttons: [verb, 'Cancel'] })
}

async function installFrom(sourceId: string, appId: string, done: () => void): Promise<void> {
  const [rec, sources] = await Promise.all([attempt(() => svc<AppRecord>({ op: 'app', sourceId, appId })), svc<SourceRow[]>({ op: 'list' })])
  if (!rec) return
  const v = rec.versions.find((x) => !x.yanked && !x.version.includes('-')) ?? rec.versions.find((x) => !x.yanked)
  if (!v) return void say(`${rec.name} has no version that can be installed.`, true)
  if (!(await confirmInstall(rec, v.version, v.manifest.permissions, sources.find((s) => s.id === sourceId), 'Install'))) return
  const done_ = await attempt(async () => {
    const p = await svc<Prepared>({ op: 'prepare', sourceId, appId, version: v.version })
    const info = await place(p, false)
    await svc({ op: 'record', id: info.id, sourceId: p.sourceId, version: p.version, digest: p.digest })
    return info
  }, `${rec.name} was installed.`)
  if (done_) done()
}

async function update(u: Update, done: () => void): Promise<void> {
  const sources = await svc<SourceRow[]>({ op: 'list' })
  const rec = await attempt(() => svc<AppRecord>({ op: 'app', sourceId: u.sourceId, appId: u.id }))
  if (!rec || !u.available) return
  const v = rec.versions.find((x) => x.version === u.available)
  const extra = u.permissionsAdded?.length ? [`This update asks for more access: ${u.permissionsAdded.join(', ')}.`] : []
  if (!(await confirmInstall(rec, u.available, v?.manifest.permissions ?? [], sources.find((s) => s.id === u.sourceId), 'Update', extra))) return
  const ok = await attempt(async () => {
    const p = await svc<Prepared>({ op: 'prepareUpdate', id: u.id, allowNewPermissions: Boolean(u.permissionsAdded?.length) })
    await place(p, true)
    await svc({ op: 'record', id: u.id, sourceId: p.sourceId, version: p.version, digest: p.digest })
    return true
  }, `${u.name} was updated.`)
  if (ok) done()
}

/** Find apps in the enabled sources and install them. */
export function browseSection(onInstalled: () => void): { el: HTMLElement; refresh: () => Promise<void> } {
  const results = h('div', { class: 'group', id: 'source-results' })
  const box = h('input', { type: 'search', placeholder: 'Search apps in your sources', 'aria-label': 'Search apps in your sources' }) as HTMLInputElement
  const search = async (): Promise<void> => {
    const groups = await attempt(() => svc<Group[]>({ op: 'search', query: box.value }))
    if (!groups) return
    const rows: HTMLElement[] = []
    for (const g of groups) {
      if (g.error) rows.push(line(`${g.sourceName}: ${g.error.message}`, undefined, g.stale ? 'Showing the last copy that could be checked.' : undefined))
      for (const a of g.apps) {
        rows.push(h('div', { class: 'line', 'data-listing': a.id },
          h('div', { class: 'label' }, a.name, h('small', null, `${a.summary || a.id} · ${a.version} · ${g.sourceName}`)),
          h('div', { class: 'ctl' }, button('Install', () => installFrom(g.sourceId, a.id, () => { onInstalled(); void search() }), '', { 'aria-label': `Install ${a.name} from ${g.sourceName}` }))))
      }
    }
    results.replaceChildren(...(rows.length ? rows : [line(box.value ? 'Nothing found.' : 'The enabled sources list no apps yet.')]))
  }
  box.addEventListener('input', () => void search())
  void search()
  return { el: h('section', { id: 'get-apps' }, h('h2', null, 'Get apps'), group(null, line('Search', box)), results), refresh: search }
}

/** Updates for apps installed from a source: only that source is asked. */
export function updatesSection(onUpdated: () => void): HTMLElement {
  const list = h('div', { class: 'group' }, line('Not checked yet.'))
  const check = async (): Promise<void> => {
    const ups = await attempt(() => svc<Update[]>({ op: 'updates' }))
    if (!ups) return
    list.replaceChildren(...(ups.length ? ups.map((u) => h('div', { class: 'line', 'data-update': u.id },
      h('div', { class: 'label' }, u.name, h('small', null, u.problem ? `Could not check: ${u.problem}` : `${u.installed} → ${u.available ?? 'withdrawn'}${u.yanked ? ` · this version was withdrawn: ${u.yanked}` : ''}${u.permissionsAdded?.length ? ` · asks for more access: ${u.permissionsAdded.join(', ')}` : ''}`)),
      h('div', { class: 'ctl' }, u.available ? button('Update', () => update(u, () => { onUpdated(); void check() }), '', { 'aria-label': `Update ${u.name}` }) : null))) : [line('Everything installed from a source is up to date.')]))
  }
  return h('section', { id: 'app-updates' }, h('h2', null, 'Updates'), list,
    h('div', { class: 'line' }, h('div', { class: 'ctl' }, button('Check for Updates', check))))
}

/** `appId -> source name`, for the installed list. */
export async function provenanceNames(): Promise<Record<string, string>> {
  try {
    const [installed, sources] = await Promise.all([svc<Record<string, Installed>>({ op: 'provenance' }), svc<SourceRow[]>({ op: 'list' })])
    return Object.fromEntries(Object.entries(installed).map(([id, i]) => [id, sources.find((s) => s.id === i.sourceId)?.name ?? i.sourceId]))
  } catch {
    return {}
  }
}
