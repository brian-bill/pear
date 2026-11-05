import { tiny } from '@tiny/sdk'
import { attempt, bindStatus, bytes, h, iconTile, image, installable, kindLabel, reqLabel, say, svc, type AppRecord, type Bundle, type Group, type Listing, type VersionRec } from './lib'
import { install, needs, refreshState, refreshUpdates, st, stateOf, uninstall, update, type Needs } from './flows'

/// Results are grouped by source and never merged. A runtime a listing needs is shown, never installed for the person.

type Section = 'discover' | 'apps' | 'tool' | 'runtime' | 'framework' | 'installed' | 'updates'
type View = { type: 'section'; section: Section } | { type: 'search'; query: string } | { type: 'detail'; sourceId: string; appId: string }

const SECTIONS: Array<[Section | '-', string]> = [
  ['discover', 'Discover'], ['apps', 'Apps'], ['tool', 'Developer tools'], ['runtime', 'Runtimes'], ['framework', 'Frameworks'], ['-', ''], ['installed', 'Installed'], ['updates', 'Updates'],
]
const TITLES: Record<Section, string> = { discover: 'Discover', apps: 'Apps', tool: 'Developer tools', runtime: 'Runtimes', framework: 'Frameworks', installed: 'Installed', updates: 'Updates' }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const viewEl = $('view')
const navEl = $('nav')
const titleEl = $('title')
const backEl = $<HTMLButtonElement>('back')
const searchEl = $<HTMLInputElement>('search')
bindStatus($('status'))

let current: View = { type: 'section', section: 'discover' }
const trail: View[] = []
let drawing = 0

// ---- navigation

function go(view: View, push = false): void {
  if (push) trail.push(current)
  else if (view.type !== 'detail') trail.length = 0
  current = view
  void draw()
}
const openListing = (sourceId: string, appId: string): void => go({ type: 'detail', sourceId, appId }, true)

function drawNav(): void {
  const on = current.type === 'section' ? current.section : null
  navEl.replaceChildren(...SECTIONS.map(([id, label]) => {
    if (id === '-') return h('div', { class: 'rule' })
    const badge = id === 'updates' && st.updates.size ? h('span', { class: 'badge', 'aria-label': `${st.updates.size} updates` }, st.updates.size) : null
    return h('button', { type: 'button', class: `item${on === id ? ' selected' : ''}`, 'data-section': id, 'aria-current': on === id ? 'true' : null, role: 'listitem', onclick: () => { searchEl.value = ''; go({ type: 'section', section: id }) } }, label, badge)
  }))
}

// ---- pieces

function noSources(): HTMLElement {
  return h('div', { class: 'empty', 'data-empty': 'no-sources' }, h('p', null, 'No sources are turned on, so there is nothing to browse.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => openSettings() }, 'Open App Sources in Settings')))
}
function openSettings(): void {
  void tiny.shell.open('settings://apps', { app: 'org.tiny.settings' }).catch(() => tiny.shell.openApp('org.tiny.settings'))
}

/** The button of a listing, from what is installed. */
function actionButton(l: Listing, sourceId: string, sourceName: string, after: () => void): HTMLButtonElement {
  const s = stateOf(l, sourceId)
  const label = s.action === 'open' ? `Open ${l.name}` : s.action === 'update' ? `Update ${l.name}` : s.action === 'install' ? `Install ${l.name} from ${sourceName}` : `${l.name} is installed`
  return h('button', {
    type: 'button', class: s.action === 'install' || s.action === 'update' ? 'primary' : '', 'data-state': s.action, 'aria-label': label, title: s.note, disabled: s.action === 'installed',
    onclick: async (e: Event) => {
      e.stopPropagation()
      if (s.action === 'open') return void tiny.shell.openApp(l.id)
      if (s.action === 'update') {
        const u = st.updates.get(l.id)
        if (u) await update(u)
      } else await install(sourceId, l.id, openListing)
      after()
    },
  }, s.label)
}

function meta(l: Listing, sourceName: string): string {
  return [l.kind === 'runtime' || l.kind === 'framework' ? (l.provides ? `provides ${l.provides.runtime ?? l.provides.framework} ${l.provides.version}` : null) : null, `version ${l.version}`, l.publisher.name || null, sourceName, bytes(l.size) || null].filter(Boolean).join(' · ')
}

function row(l: Listing, sourceId: string, sourceName: string, after: () => void, card = false): HTMLElement {
  return h('div', { class: `listing${card ? ' card' : ''}`, 'data-listing': l.id, 'data-source': sourceId, 'data-kind': l.kind, role: 'group', 'aria-label': `${l.name}, ${sourceName}` },
    iconTile(l.name, () => image(sourceId, l.icon)),
    h('div', { class: 'info' },
      h('div', { class: 'name' }, h('button', { type: 'button', class: 'plain open', style: 'padding:0;font-weight:600', 'aria-label': `Details of ${l.name} from ${sourceName}`, onclick: () => openListing(sourceId, l.id) }, l.name), h('span', { class: 'kind' }, kindLabel(l.kind))),
      h('div', { class: 'summary' }, l.summary || l.id),
      h('div', { class: 'meta' }, meta(l, sourceName))),
    actionButton(l, sourceId, sourceName, after))
}

/** One heading per source, then its listings (or why it has none). Sources are never merged. */
function groupBlock(g: Group, items: Listing[], after: () => void, emptyText: string, card = false): HTMLElement {
  const note = g.error ? h('div', { class: `note${g.stale ? ' warn' : ''}`, 'data-note': g.stale ? 'stale' : 'error' },
    g.stale ? `Cannot reach ${g.sourceName} right now (${g.error.message}). Showing the last copy; it is not used to install.` : `${g.sourceName}: ${g.error.message}`) : null
  return h('section', { 'data-group': g.sourceId },
    h('div', { class: 'source' }, h('h2', null, g.sourceName), h('small', null, `${items.length} ${items.length === 1 ? 'item' : 'items'}`)),
    note,
    items.length ? h('div', { class: card ? 'cards' : 'list' }, items.map((l) => row(l, g.sourceId, g.sourceName, after, card))) : g.error && !g.stale ? null : h('div', { class: 'note' }, emptyText))
}

// ---- views

async function discover(): Promise<HTMLElement> {
  const groups = await svc<Group[]>({ op: 'search', query: '', limit: 200 })
  const redraw = () => void draw(false)
  return h('div', null, groups.map((g) => {
    const featured = g.apps.filter((a) => g.featured?.includes(a.id))
    const rest = g.apps.filter((a) => !g.featured?.includes(a.id)).sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name)).slice(0, 8)
    return h('div', null,
      featured.length ? groupBlock({ ...g, error: g.error }, featured, redraw, '', true) : null,
      groupBlock(featured.length ? { ...g, sourceName: `${g.sourceName} · New and updated`, error: undefined } : g, rest, redraw, 'Nothing listed yet.'))
  }))
}

async function browse(section: 'apps' | 'tool' | 'runtime' | 'framework'): Promise<HTMLElement> {
  const groups = await svc<Group[]>({ op: 'search', query: '', limit: 200, ...(section === 'apps' ? {} : { kind: section }) })
  const redraw = () => void draw(false)
  const noun = { apps: 'apps', tool: 'developer tools', runtime: 'runtimes', framework: 'frameworks' }[section]
  return h('div', null, groups.map((g) => groupBlock(g, section === 'apps' ? g.apps.filter((a) => !['tool', 'runtime', 'framework'].includes(a.kind)) : g.apps, redraw, `This source lists no ${noun}.`)))
}

async function results(query: string): Promise<HTMLElement> {
  const groups = await svc<Group[]>({ op: 'search', query, limit: 100 })
  const redraw = () => void draw(false)
  const found = groups.reduce((n, g) => n + g.apps.length, 0)
  return h('div', null, found ? null : h('div', { class: 'empty', 'data-empty': 'nothing' }, `Nothing found for “${query}”.`), groups.map((g) => (g.apps.length || g.error ? groupBlock(g, g.apps, redraw, '') : null)))
}

function installedView(): HTMLElement {
  const bundles = [...st.bundles.values()].filter((b) => !b.system).sort((a, b) => a.name.localeCompare(b.name))
  if (!bundles.length) return h('div', { class: 'empty', 'data-empty': 'installed' }, 'Nothing has been installed yet.')
  const redraw = () => void draw(false)
  return h('div', { class: 'list' }, bundles.map((b) => {
    const from = st.prov[b.id]
    const up = st.updates.get(b.id)
    const source = from ? (st.sources.find((s) => s.id === from.sourceId)?.name ?? from.sourceId) : null
    return h('div', { class: 'listing', 'data-installed': b.id },
      iconTile(b.name, async () => (await tiny.shell.icon(b.id).catch(() => null))?.url ?? null),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, b.name, h('span', { class: 'kind' }, kindLabel(b.kind))),
        h('div', { class: 'meta' }, [`version ${b.version}`, source ? `from ${source}` : 'not from a source', b.permissions.length ? b.permissions.join(', ') : null, up ? `update ${up.available} available` : null].filter(Boolean).join(' · '))),
      from && up ? h('button', { type: 'button', class: 'primary', 'aria-label': `Update ${b.name}`, onclick: async () => { await update(up); redraw() } }, 'Update') : null,
      from ? h('button', { type: 'button', class: 'plain', 'aria-label': `About ${b.name}`, onclick: () => openListing(from.sourceId, b.id) }, 'Details') : null,
      h('button', { type: 'button', class: 'danger', 'aria-label': `Uninstall ${b.name}`, onclick: async () => { if (await uninstall(b)) redraw() } }, 'Uninstall'))
  }))
}

async function updatesView(): Promise<HTMLElement> {
  const list = await refreshUpdates()
  drawNav()
  if (!list.length) return h('div', { class: 'empty', 'data-empty': 'updates' }, 'Everything installed from a source is up to date.')
  return h('div', { class: 'list' }, list.map((u) => h('div', { class: 'listing', 'data-update': u.id },
    iconTile(u.name, async () => (await tiny.shell.icon(u.id).catch(() => null))?.url ?? null),
    h('div', { class: 'info' }, h('div', { class: 'name' }, u.name),
      h('div', { class: 'meta' }, u.problem ? `Could not check: ${u.problem}` : `${u.installed} → ${u.available ?? 'withdrawn'} · ${st.sources.find((s) => s.id === u.sourceId)?.name ?? u.sourceId}${u.yanked ? ` · this version was withdrawn: ${u.yanked}` : ''}${u.permissionsAdded?.length ? ` · asks for more access: ${u.permissionsAdded.join(', ')}` : ''}`)),
    u.available ? h('button', { type: 'button', class: 'primary', 'aria-label': `Update ${u.name}`, onclick: async () => { await update(u); void draw(false) } }, 'Update') : null)))
}

function versionRow(v: VersionRec, installed?: string): HTMLElement {
  return h('div', { class: 'ver', 'data-version': v.version },
    h('strong', null, `Version ${v.version}`), installed === v.version ? ' · installed' : '', v.created ? ` · ${v.created}` : '',
    v.yanked ? h('div', { class: 'yank' }, `Withdrawn: ${v.yanked.reason || 'no reason given'}. It is not offered for new installs.`) : null,
    v.releaseNotes ? h('small', null, v.releaseNotes) : null)
}

function requirementRow(n: Needs, sourceId: string): HTMLElement {
  return h('div', { class: 'req', 'data-req': `${n.req.runtime ?? n.req.framework}` },
    h('div', { class: 'info' }, h('strong', null, reqLabel(n.req)),
      n.met ? null : h('small', { class: 'dim', style: 'display:block' }, n.reason ?? 'not installed')),
    h('span', { class: `state ${n.met ? 'ok' : 'missing'}` }, n.met ? 'Satisfied' : 'Missing'),
    !n.met && n.from ? h('button', { type: 'button', 'aria-label': `Get ${n.from.listing.name} ${n.req.range}`, onclick: () => openListing(n.from!.sourceId, n.from!.listing.id) },
      `Get ${n.from.listing.name} ${n.req.range}${n.from.sourceId === sourceId ? '' : ` (${n.from.sourceName})`}`) : null,
    !n.met && !n.from ? h('span', { class: 'dim' }, 'No source you use offers it') : null)
}

async function detail(sourceId: string, appId: string): Promise<HTMLElement> {
  const rec = await svc<AppRecord>({ op: 'app', sourceId, appId })
  const source = st.sources.find((s) => s.id === sourceId)
  const v = installable(rec)
  const requires = v ? await needs(sourceId, v.manifest.requires ?? []) : []
  const installedAs = st.prov[appId]?.sourceId === sourceId ? st.bundles.get(appId)?.version : undefined
  const redraw = () => void draw(false)
  const lines = (title: string, ...body: Array<HTMLElement | null | false>) => h('section', null, h('h3', null, title), ...body)
  const shots = await Promise.all(rec.screenshots.map((u) => image(sourceId, u)))
  titleEl.textContent = rec.name
  return h('div', { class: 'detail', 'data-detail': appId, 'data-source': sourceId },
    h('div', { class: 'hero' }, iconTile(rec.name, () => image(sourceId, rec.icon), true),
      h('div', { class: 'grow' }, h('h2', null, rec.name, ' ', h('span', { class: 'kind' }, kindLabel(rec.kind))),
        h('div', { class: 'meta' }, [rec.publisher.name ? `by ${rec.publisher.name}` : null, `version ${v?.version ?? rec.version}`, bytes(rec.size) || null, rec.license ?? null].filter(Boolean).join(' · ')),
        h('div', { class: 'meta' }, `${rec.sourceName}${source ? ` (${source.host})` : ''} · ${source?.keyFingerprint ? 'signed source' : 'unsigned source'}${rec.stale ? ' · showing the last copy; the source cannot be reached' : ''}`)),
      actionButton(rec, sourceId, rec.sourceName, redraw)),
    rec.summary ? h('p', null, rec.summary) : null,
    rec.description ? h('p', { class: 'selectable' }, rec.description) : null,
    shots.some(Boolean) ? h('div', { class: 'shots', 'aria-label': 'Screenshots' }, shots.filter(Boolean).map((u) => h('img', { src: u!, alt: 'Screenshot' }))) : null,
    requires.length ? lines('Requires', h('div', { class: 'list', 'data-section': 'requires' }, requires.map((n) => requirementRow(n, sourceId)))) : null,
    rec.provides ? lines('Provides', h('div', { class: 'card', 'data-section': 'provides' },
      h('div', null, `${rec.provides.runtime !== undefined ? 'Runtime' : 'Framework'} ${rec.provides.runtime ?? rec.provides.framework} ${rec.provides.version}`),
      rec.provides.commands?.length ? h('div', { class: 'tags', style: 'margin-top:6px', 'aria-label': 'Commands' }, rec.provides.commands.map((c) => h('span', null, c))) : null)) : null,
    lines('Permissions', v?.manifest.permissions.length ? h('div', { class: 'tags', 'data-section': 'permissions' }, v.manifest.permissions.map((p) => h('span', null, p))) : h('p', { class: 'dim' }, 'Asks for no special access.')),
    lines('Versions', h('div', { class: 'list', 'data-section': 'versions' }, rec.versions.map((x) => versionRow(x, installedAs)))),
    rec.homepage ? lines('Website', h('p', { class: 'selectable' }, rec.homepage)) : null)
}

// ---- drawing

async function draw(scrollTop = true): Promise<void> {
  const mine = ++drawing
  const view = current
  backEl.hidden = !(view.type === 'detail' && trail.length)
  drawNav()
  titleEl.textContent = view.type === 'section' ? TITLES[view.section] : view.type === 'search' ? `Results for “${view.query}”` : 'App Store'
  let body: HTMLElement
  try {
    await refreshState()
    if (mine !== drawing) return
    const needsSources = view.type === 'search' || view.type === 'detail' || (view.type === 'section' && !['installed'].includes(view.section))
    if (needsSources && !st.sources.some((s) => s.enabled)) body = noSources()
    else if (view.type === 'search') body = await results(view.query)
    else if (view.type === 'detail') body = await detail(view.sourceId, view.appId)
    else if (view.section === 'discover') body = await discover()
    else if (view.section === 'installed') body = installedView()
    else if (view.section === 'updates') body = await updatesView()
    else body = await browse(view.section)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    body = h('div', { class: 'empty', 'data-empty': 'error' }, `${err.message ?? 'Something went wrong'}${err.code ? ` (${err.code})` : ''}`)
  }
  if (mine !== drawing) return // another view was chosen meanwhile
  viewEl.replaceChildren(body)
  if (scrollTop) viewEl.scrollTop = 0
  drawNav()
}

async function main(): Promise<void> {
  await tiny.ready
  const saved = tiny.app.state as { section?: Section } | null
  if (saved?.section && TITLES[saved.section]) current = { type: 'section', section: saved.section }
  backEl.addEventListener('click', () => {
    const back = trail.pop()
    if (back) {
      current = back
      void draw()
    }
  })
  $('refresh').addEventListener('click', () => void attempt(async () => {
    await svc({ op: 'refresh' })
    await draw(false)
  }, 'Sources refreshed.'))
  let timer: ReturnType<typeof setTimeout> | undefined
  searchEl.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const q = searchEl.value.trim()
      if (q) go({ type: 'search', query: q })
      else go({ type: 'section', section: 'discover' })
    }, 200)
  })
  tiny.app.onSaveState(() => ({ section: current.type === 'section' ? current.section : 'discover' }))
  tiny.on('focus', () => {
    if (!document.activeElement?.matches('input, select, textarea') && current.type !== 'detail') void draw(false)
  })
  tiny.window.setMenus([{ title: 'App Store', items: [{ label: 'About App Store', action: () => void tiny.dialogs.alert({ message: 'App Store', detail: 'Find apps, tools and runtimes in the sources you use.' }) }] }])
  await draw()
  void refreshUpdates().then(drawNav)
}
void main()
