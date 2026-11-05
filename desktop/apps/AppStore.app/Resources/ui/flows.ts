import { tiny } from '@tiny/sdk'
import { attempt, installable, k, kindLabel, reqLabel, say, sameReq, svc, type AppRecord, type Bundle, type Installed, type Listing, type Prepared, type Req, type ResolveGroup, type SourceRow, type Unmet, type Update } from './lib'

export const st = {
  sources: [] as SourceRow[],
  bundles: new Map<string, Bundle>(),
  prov: {} as Record<string, Installed>,
  updates: new Map<string, Update>(),
}

/** Sources, what is installed and where it came from. Updates are asked separately (they use the network per app). */
export async function refreshState(): Promise<void> {
  const [sources, bundles, prov] = await Promise.all([
    svc<SourceRow[]>({ op: 'list' }).catch(() => [] as SourceRow[]),
    k<Bundle[]>('bundleList').catch(() => [] as Bundle[]),
    svc<Record<string, Installed>>({ op: 'provenance' }).catch(() => ({}) as Record<string, Installed>),
  ])
  st.sources = sources
  st.bundles = new Map(bundles.map((b) => [b.id, b]))
  st.prov = prov
}

export async function refreshUpdates(): Promise<Update[]> {
  const list = await svc<Update[]>({ op: 'updates' }).catch(() => [] as Update[])
  st.updates = new Map(list.filter((u) => u.available).map((u) => [u.id, u]))
  return list
}

export const sourceName = (id: string): string => st.sources.find((s) => s.id === id)?.name ?? id

// ---- button states

export type Action = 'install' | 'open' | 'update' | 'installed'
export interface ButtonState { action: Action; label: string; note?: string }

/** Install, Open, Update or Installed for a listing of `sourceId`, from what is installed and where it came from. */
export function stateOf(l: Listing, sourceId: string): ButtonState {
  const have = st.bundles.get(l.id)
  if (!have) return { action: 'install', label: 'Install' }
  const from = st.prov[l.id]
  if (from && from.sourceId !== sourceId) return { action: 'installed', label: 'Installed', note: `Installed from ${sourceName(from.sourceId)}` }
  if (from && st.updates.get(l.id)) return { action: 'update', label: 'Update' }
  if (l.kind === 'app' && !have.system) return { action: 'open', label: 'Open' }
  return { action: 'installed', label: 'Installed', note: from ? `Installed from ${sourceName(from.sourceId)}` : 'Installed' }
}

// ---- the install review

/** Where a missing requirement can be had: the listing a source offers for it, the app's own source first. */
export async function provider(sourceId: string, r: Req): Promise<{ sourceId: string; sourceName: string; listing: Listing } | null> {
  const groups = await svc<ResolveGroup[]>({ op: 'resolveRequirement', sourceId, ...(r.runtime !== undefined ? { runtime: r.runtime } : { framework: r.framework }), range: r.range }).catch(() => [] as ResolveGroup[])
  const g = groups.find((x) => x.apps.length)
  return g ? { sourceId: g.sourceId, sourceName: g.sourceName, listing: g.apps[0]! } : null
}

export interface Needs { req: Req; met: boolean; reason?: string; from: Awaited<ReturnType<typeof provider>> }
/** Each requirement with whether the machine meets it (the kernel's answer, the one a launch uses) and where to get it if not. */
export async function needs(sourceId: string, requires: Req[]): Promise<Needs[]> {
  if (!requires.length) return []
  const unmet = await svc<Unmet[]>({ op: 'unmet', requires }).catch(() => requires.map((r) => ({ kind: r.runtime !== undefined ? 'runtime' : 'framework', name: (r.runtime ?? r.framework)!, range: r.range, reason: 'not installed' }) as Unmet))
  return Promise.all(requires.map(async (req) => {
    const u = unmet.find((x) => sameReq(req, x))
    return { req, met: !u, reason: u?.reason, from: u ? await provider(sourceId, req) : null }
  }))
}

async function review(rec: AppRecord, version: string, permissions: string[], requires: Needs[], verb: string, extra: string[], go?: (sourceId: string, id: string) => void): Promise<boolean> {
  const source = st.sources.find((s) => s.id === rec.sourceId)
  const warn = source?.origin === 'user' && (await k<string | boolean>('configGet', 'tiny.apps.sources', 'warnUserSources', true)) !== false
  const missing = requires.filter((n) => !n.met)
  const lines = [
    `Version ${version} · ${kindLabel(rec.kind)} · from ${source?.name ?? rec.sourceName} (${source?.host ?? '?'})${rec.publisher.name ? ` · by ${rec.publisher.name}` : ''}`,
    permissions.length ? `Can ask to use: ${permissions.join(', ')}.` : 'Asks for no special access.',
    rec.provides?.commands?.length ? `Adds the command${rec.provides.commands.length > 1 ? 's' : ''}: ${rec.provides.commands.join(', ')}.` : '',
    ...requires.map((n) => (n.met
      ? `Needs ${reqLabel(n.req)}: installed.`
      : `Needs ${reqLabel(n.req)}: ${n.reason ?? 'not installed'}.${n.from ? ` Available as “${n.from.listing.name}” ${n.from.listing.provides?.version ?? n.from.listing.version} from ${n.from.sourceName}.` : ' No source you use offers it.'}`)),
    missing.length ? 'The app will not start until it is installed. It is not installed for you; you can get it first or continue.' : '',
    ...extra,
    'This version has no verified publisher.',
    warn ? 'This source was added by you, not built in. Only install apps you trust.' : '',
  ].filter(Boolean)
  const firstFix = missing.find((n) => n.from)
  const buttons = firstFix && go ? [`Get ${firstFix.from!.listing.name} First`, `${verb} Anyway`, 'Cancel'] : missing.length ? [`${verb} Anyway`, 'Cancel'] : [verb, 'Cancel']
  const choice = await tiny.dialogs.alert({ message: `${verb} “${rec.name}”?`, detail: lines.join('\n'), buttons, defaultButton: 0, cancelButton: buttons.length - 1 })
  if (choice === buttons.length - 1) return false
  if (firstFix && go && choice === 0) {
    go(firstFix.from!.sourceId, firstFix.from!.listing.id)
    return false
  }
  return true
}

/** Hand a checked version to the kernel: a package is verified again there against the listing; a directory was checked by the service. */
async function place(p: Prepared, update: boolean): Promise<{ id: string; name: string }> {
  const from = { kind: 'registry', sourceId: p.sourceId, url: p.sourceUrl, version: p.version, digest: p.digest, unsigned: true }
  if (p.kind === 'archive') return k('bundleInstallArchive', new Blob([p.bytes as BlobPart]), { update, expectDigest: p.digest, expect: { id: p.appId, version: p.version, permissions: p.permissions }, from })
  return update ? k('bundleUpdate', p.appId, { files: p.files }, { from }) : k('bundleInstall', { files: p.files }, { from })
}

/** Install the newest version of a listing after the review. `go` opens another listing (to get a requirement first). */
export async function install(sourceId: string, appId: string, go?: (sourceId: string, id: string) => void): Promise<boolean> {
  const rec = await attempt(() => svc<AppRecord>({ op: 'app', sourceId, appId }))
  if (!rec) return false
  const v = installable(rec)
  if (!v) {
    say(`${rec.name} has no version that can be installed.`, true)
    return false
  }
  const requires = await needs(sourceId, v.manifest.requires ?? [])
  if (!(await review(rec, v.version, v.manifest.permissions, requires, 'Install', [], go))) return false
  const info = await attempt(async () => {
    const p = await svc<Prepared>({ op: 'prepare', sourceId, appId, version: v.version })
    const done = await place(p, false)
    await svc({ op: 'record', id: done.id, sourceId: p.sourceId, version: p.version, digest: p.digest })
    return done
  }, `${rec.name} was installed.`)
  await refreshState()
  return Boolean(info)
}

export async function update(u: Update): Promise<boolean> {
  const rec = await attempt(() => svc<AppRecord>({ op: 'app', sourceId: u.sourceId, appId: u.id }))
  if (!rec || !u.available) return false
  const v = rec.versions.find((x) => x.version === u.available)
  const requires = await needs(u.sourceId, v?.manifest.requires ?? [])
  const extra = u.permissionsAdded?.length ? [`This update asks for more access: ${u.permissionsAdded.join(', ')}.`] : []
  if (!(await review(rec, u.available, v?.manifest.permissions ?? [], requires, 'Update', extra))) return false
  const ok = await attempt(async () => {
    const p = await svc<Prepared>({ op: 'prepareUpdate', id: u.id, allowNewPermissions: Boolean(u.permissionsAdded?.length) })
    await place(p, true)
    await svc({ op: 'record', id: u.id, sourceId: p.sourceId, version: p.version, digest: p.digest })
    return true
  }, `${u.name} was updated.`)
  await refreshState()
  await refreshUpdates()
  return Boolean(ok)
}

export async function uninstall(b: Bundle): Promise<boolean> {
  if (b.system) {
    say(`${b.name} is part of the system and cannot be removed.`, true)
    return false
  }
  const offers = b.provides?.name ?? b.provides?.framework
  const used = offers ? [...st.bundles.values()].filter((o) => o.id !== b.id && o.requires?.some((r) => (r.runtime ?? r.framework) === offers)) : []
  const detail = ['The bundle is removed. Its data is kept.', used.length ? `Used by: ${used.map((o) => o.name).join(', ')}. They will not start without it.` : ''].filter(Boolean).join('\n')
  if (!(await tiny.dialogs.confirm(`Uninstall ${b.name}?`, { detail, danger: true, buttons: ['Uninstall', 'Cancel'] }))) return false
  try {
    await k('bundleUninstall', b.id)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    say(err.code === 'EBUSY' ? `${b.name} is running or in use. Quit it and try again.` : `${err.message ?? 'Failed'}${err.code ? ` (${err.code})` : ''}`, true)
    return false
  }
  await svc({ op: 'forget', id: b.id }).catch(() => {})
  say(`${b.name} was uninstalled.`)
  await refreshState()
  await refreshUpdates()
  return true
}
