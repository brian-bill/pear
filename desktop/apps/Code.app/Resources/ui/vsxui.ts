// The Extensions view's VS Code side: installed extensions, search
// on Open VSX, the install review, Workspace Trust, and the commands extensions contribute.
import { escapeHtml, formatBytes, tiny } from '@tiny/sdk'
import { icon } from './icons'
import { NEEDS_NODE, VsxError, type Listing, type Runnable } from './vsx'
import { ExtensionHost } from './vsxhost'
import { applyAll, extensionThemes, setExtensionTheme } from './vsxcontrib'
import { iconUrl, renderDetail } from './vsxdetail'
import type { RawBinding } from './keys'
import * as views from './vsxviews'
import * as store from './vsxstore'
import type { Installed, Review, Source } from './vsxstore'

const CONFIG = 'org.tiny.code'

export interface UiEnv {
  project(): string | null
  log(line: string, cls?: 'err' | 'ok'): void
  status(text: string): void
  /** Extension themes or languages changed: refresh whatever shows them. */
  changed(): void
  /** Open (or focus) the details tab of an extension. */
  openDetail(id: string): void
}

export interface ViewsEls {
  nav: HTMLElement
  side: HTMLElement
  sash: HTMLElement
  explorer: HTMLElement
  select(id: string): void
  isSelected(id: string): boolean
}

interface Els {
  views: ViewsEls
  commands: HTMLElement
  installed: HTMLElement
  resultsHead: HTMLElement
  results: HTMLElement
  count: HTMLElement
}

let env: UiEnv
let els: Els
let list: Installed[] = []
let query = ''
let trustedPaths = new Set<string>()
let host: ExtensionHost
let searching = 0
/** Ids being installed from the marketplace: their buttons say "Installing…" wherever they appear. */
const installing = new Set<string>()
/** Whether each listing can run in a browser; absent while it is being checked. */
const runs = new Map<string, Runnable>()

/** Check listings a few at a time; `done` is called as each answer arrives. */
async function checkAll(items: Listing[], done: (l: Listing) => void): Promise<void> {
  await store.refreshNode()
  const todo = items.filter((l) => !runs.has(l.id))
  const worker = async (): Promise<void> => {
    for (let l = todo.shift(); l; l = todo.shift()) {
      runs.set(l.id, await store.runnable(l))
      done(l)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
}
/** Marketplace listings seen so far, for the details page of an extension that is not installed. */
const listings = new Map<string, Listing>()
let detail: { id: string; el: HTMLElement } | null = null

const trusted = (): boolean => !!env.project() && trustedPaths.has(env.project()!)

async function loadTrust(): Promise<void> {
  const saved = await tiny.configGet(CONFIG, 'trustedWorkspaces', [])
  trustedPaths = new Set(Array.isArray(saved) ? (saved as string[]) : [])
}

const needsTrust = (e: Installed): boolean => !!e.enabled && !!(e.manifest.browser || e.manifest.main) && e.manifest.capabilities?.untrustedWorkspaces?.supported !== true

/** Workspace Trust, VS Code style: a workspace is in Restricted Mode (extension code that needs trust does not run) until trusted. */
export async function ensureTrust(): Promise<void> {
  const project = env.project()
  if (!project || trusted() || !list.some(needsTrust)) return
  const choice = await tiny.dialogs.alert({
    title: 'Workspace Trust',
    message: 'Do you trust the authors of the files in this folder?',
    detail: 'Trusting lets installed extensions run code in this project. In Restricted Mode, extensions that need trust are paused; themes, snippets and languages still work.',
    buttons: ['Trust Workspace', 'Restricted Mode'],
    cancelButton: 1,
  })
  if (choice === 0) {
    trustedPaths.add(project)
    await tiny.configSet(CONFIG, 'trustedWorkspaces', [...trustedPaths])
  }
  await host.sync(list)
  views.refresh()
  render()
  renderCommands()
  env.changed()
}

async function setTrust(on: boolean): Promise<void> {
  const project = env.project()
  if (!project) return void (await tiny.dialogs.alert({ title: 'Workspace Trust', message: 'Open a project first.' }))
  if (on === trusted()) return
  if (on) trustedPaths.add(project)
  else trustedPaths.delete(project)
  await tiny.configSet(CONFIG, 'trustedWorkspaces', [...trustedPaths])
  await host.sync(list) // stops what now needs trust, starts what was paused
  views.refresh()
  render()
  renderCommands()
  env.status(on ? 'Workspace trusted' : 'Restricted Mode')
  env.changed() // the menus say which of the two is available
}

export const trustWorkspace = (): Promise<void> => setTrust(true)
export const restrictWorkspace = (): Promise<void> => setTrust(false)

export const isTrusted = trusted

const sourceLabel = (s: Source): string => (s.kind === 'registry' ? 'Open VSX' : s.kind === 'vsix' ? 'VSIX' : 'Local folder')

function reviewDetail(r: Review, s: Source): string {
  const c = r.manifest.contributes ?? {}
  const parts = ['themes', 'snippets', 'languages', 'grammars', 'commands'].flatMap((k) => {
    const v = c[k]
    return Array.isArray(v) && v.length ? [`${v.length} ${k}`] : []
  })
  return [
    `Publisher: ${r.manifest.publisher}`,
    `Source: ${sourceLabel(s)}${s.kind === 'registry' ? (s.verified ? ' (verified publisher)' : '') : ''}${r.unsigned ? ' — unsigned' : ''}`,
    `Runs as: ${r.kind === 'web' ? 'code in a Worker (web extension)' : r.kind === 'both' ? 'code in a Worker (web entry; it also has a Node.js entry)' : r.kind === 'node' ? 'code in the Node.js runtime (a Worker with its own Node environment)' : 'declarative (no code)'}`,
    parts.length ? `Contributes: ${parts.join(', ')}` : 'Contributes: nothing declarative',
    `Size: ${r.files} files, ${formatBytes(r.bytes)}`,
    ...(s.kind !== 'folder' ? [`SHA-256: ${s.digest.slice(0, 16)}…`] : []),
    ...(r.warning ? [`⚠ ${r.warning}`] : []),
    ...(r.kind !== 'declarative' ? ['Needs Workspace Trust to run unless it declares that it supports untrusted workspaces.'] : []),
  ].join('\n')
}

const confirmInstall: store.InstallOptions['confirm'] = async (r, s) =>
  (await tiny.dialogs.alert({ title: 'Install Extension', message: `${r.manifest.displayName ?? r.manifest.name} ${r.manifest.version}`, detail: reviewDetail(r, s), buttons: ['Install', 'Cancel'], cancelButton: 1 })) === 0

async function failed(what: string, e: unknown): Promise<void> {
  const err = e as { code?: string; message?: string }
  env.log(`${what}: ${err.message ?? e}`, 'err')
  await tiny.dialogs.alert({ title: what, message: err.message || 'Something went wrong.', detail: err.code ? `(${err.code})` : undefined, buttons: ['OK'] })
}

async function afterInstall(ext: Installed | null): Promise<void> {
  if (!ext) return
  env.status(`Installed ${ext.id}`)
  await ensureTrust()
}

function refreshInstalling(id: string): void {
  if (lastResults.length) renderResults()
  if (detail?.id === id) drawDetail()
}

export async function installListing(l: Listing): Promise<void> {
  if (installing.has(l.id)) return
  installing.add(l.id)
  refreshInstalling(l.id)
  try {
    env.status(`Downloading ${l.id}…`)
    await afterInstall(await store.installFromRegistry(l, { confirm: confirmInstall }))
  } catch (e) {
    await failed('Install Extension', e)
  } finally {
    installing.delete(l.id)
    refreshInstalling(l.id)
  }
}

export async function installVsixDialog(): Promise<void> {
  const home = (await tiny.getenv('HOME')) || '/Users/pear'
  const picked = await tiny.dialogs.openFile({ title: 'Install Extension from VSIX', startIn: home })
  if (!picked?.[0]) return
  try {
    await afterInstall(await store.installVsix(picked[0], { confirm: confirmInstall }))
  } catch (e) {
    await failed('Install from VSIX', e)
  }
}

export async function installVsixAt(path: string): Promise<void> {
  try {
    await afterInstall(await store.installVsix(path, { confirm: confirmInstall }))
  } catch (e) {
    await failed('Install from VSIX', e)
  }
}

export async function installFolderDialog(): Promise<void> {
  const home = (await tiny.getenv('HOME')) || '/Users/pear'
  const picked = await tiny.dialogs.openFolder({ title: 'Install Extension from Location', startIn: home })
  if (!picked?.[0]) return
  try {
    await afterInstall(await store.installFolder(picked[0]))
  } catch (e) {
    await failed('Install from Location', e)
  }
}

export async function updateAll(): Promise<void> {
  let n = 0
  for (const ext of list) {
    try {
      if (await store.update(ext.id)) n++
    } catch (e) {
      env.log(`update ${ext.id}: ${(e as Error).message}`, 'err')
    }
  }
  env.status(n ? `Updated ${n} extension${n === 1 ? '' : 's'}` : 'Extensions are up to date')
}

/** Keybindings that installed extensions contribute (`contributes.keybindings`). */
export function extensionKeybindings(): RawBinding[] {
  return list
    .filter((e) => e.enabled)
    .flatMap((e) => ((e.manifest.contributes?.keybindings as RawBinding[] | undefined) ?? []).filter((k) => typeof k?.key === 'string' && typeof k?.command === 'string'))
}

/** Commands installed extensions declare, for the command palette. */
export const extensionCommands = (): Array<{ ext: string; command: string; title: string }> => host.commands(list)
export const runExtensionCommand = (command: string): Promise<void> => run(command)

export function commandMenu(at: { x: number; y: number }): void {
  const cmds = host.commands(list)
  void tiny.shell.contextMenu(
    cmds.length
      ? cmds.map((c) => ({ label: c.title, action: () => void run(c.command) }))
      : [{ label: 'No extension commands', disabled: true }],
    at,
  )
}

async function run(command: string): Promise<void> {
  try {
    await host.run(list, command)
  } catch (e) {
    await failed('Run Command', e)
  }
}

// ---- rendering
function card(opts: { id: string; name: string; tag?: string; desc: string; meta: string; warn?: string; foot: HTMLElement[]; art?: string }): HTMLElement {
  const el = document.createElement('div')
  el.className = 'extcard'
  const art = document.createElement('div')
  art.className = 'exticon'
  art.innerHTML = icon('extensions', 24)
  if (opts.art) void iconUrl(opts.art).then((u) => u && (art.innerHTML = `<img src="${u}" alt="" width="42" height="42" style="border-radius:6px">`))
  const body = document.createElement('div')
  body.className = 'body'
  const top = document.createElement('div')
  top.className = 'top'
  top.innerHTML = `<span class="name">${escapeHtml(opts.name)}</span>${opts.tag ? `<span class="tag">${escapeHtml(opts.tag)}</span>` : ''}`
  const desc = document.createElement('div')
  desc.className = 'desc'
  desc.textContent = opts.desc
  const meta = document.createElement('div')
  meta.className = 'desc'
  meta.textContent = opts.meta
  body.append(top, desc, meta)
  if (opts.warn) {
    const w = document.createElement('div')
    w.className = 'desc vsxwarn'
    w.textContent = opts.warn
    body.append(w)
  }
  const foot = document.createElement('div')
  foot.className = 'foot'
  foot.append(...opts.foot)
  body.append(foot)
  el.append(art, body)
  el.tabIndex = 0
  el.style.cursor = 'pointer'
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', `${opts.name}: show details`)
  const openIt = (): void => env.openDetail(opts.id)
  el.addEventListener('click', (e) => !(e.target as HTMLElement).closest('button, label, input') && openIt())
  el.addEventListener('keydown', (e) => e.key === 'Enter' && e.target === el && openIt())
  return el
}

const button = (label: string, fn: () => void): HTMLButtonElement => {
  const b = document.createElement('button')
  b.className = 'vsxbtn'
  b.textContent = label
  b.addEventListener('click', fn)
  return b
}

function installedCard(ext: Installed): HTMLElement {
  const label = document.createElement('label')
  label.textContent = 'Enabled'
  const sw = document.createElement('input')
  sw.type = 'checkbox'
  sw.className = 'switch'
  sw.checked = ext.enabled
  sw.addEventListener('change', () => void store.setEnabled(ext.id, sw.checked))
  label.append(sw)
  const reason = host.skipped.get(ext.id)
  const m = ext.manifest
  return card({
    id: ext.id,
    name: m.displayName ?? m.name,
    tag: ext.signed ? sourceLabel(ext.source) : `${sourceLabel(ext.source)} · unsigned`,
    desc: m.description ?? '',
    meta: `${m.publisher} · ${ext.version} · ${ext.kind === 'web' ? 'web extension' : ext.kind === 'node' ? 'Node.js extension' : ext.kind === 'both' ? 'web + Node.js extension' : 'declarative'}`,
    warn: reason ?? ext.warning,
    foot: [label, button('Uninstall', () => void uninstall(ext))],
  })
}

async function uninstall(ext: Installed): Promise<void> {
  const choice = await tiny.dialogs.alert({
    title: 'Uninstall Extension',
    message: `Uninstall ${ext.manifest.displayName ?? ext.id}?`,
    detail: ext.source.kind === 'folder' ? 'The folder itself is not deleted.' : undefined,
    buttons: ['Uninstall', 'Uninstall and Delete Data', 'Cancel'],
    cancelButton: 2,
  })
  if (choice === 2) return
  try {
    await store.uninstall(ext.id, { deleteData: choice === 1 })
  } catch (e) {
    await failed('Uninstall Extension', e)
  }
}

/** What a listing needs: a Node-only one is fine once the Node.js runtime is installed (Code never installs it). */
const runState = (id: string): Runnable | undefined => {
  const s = runs.get(id)
  return s === 'node' && store.nodeRuntime() ? 'web' : s
}

function installButton(l: Listing): HTMLButtonElement {
  const state = runState(l.id)
  const b = button(installing.has(l.id) ? 'Installing…' : 'Install', () => void installListing(l))
  if (state === 'node') {
    b.disabled = true
    b.classList.add('unavailable')
    b.title = NEEDS_NODE
  } else if (installing.has(l.id)) b.disabled = true
  else if (!state) b.disabled = true // still being checked
  return b
}

function resultCard(l: Listing): HTMLElement {
  const have = list.find((e) => e.id === l.id)
  listings.set(l.id, l)
  const el = card({
    id: l.id,
    name: l.displayName,
    tag: l.verified ? 'verified' : undefined,
    desc: l.description,
    meta: `${l.namespace} · ${l.version} · ${l.downloads.toLocaleString()} downloads`,
    foot: [have ? Object.assign(document.createElement('span'), { textContent: have.version === l.version ? '✓ Installed' : `Installed ${have.version}` }) : installButton(l)],
    art: l.iconUrl,
  })
  if (runState(l.id) === 'node') el.classList.add('unavailable')
  resultEls.set(l.id, el)
  return el
}

const resultEls = new Map<string, HTMLElement>()

/** Look up whether each result can run in a browser, updating its card as the answers arrive. */
function checkResults(items: Listing[]): void {
  void checkAll(items, (l) => {
    const old = resultEls.get(l.id)
    if (old?.isConnected) old.replaceWith(resultCard(l))
    if (detail?.id === l.id) drawDetail()
  })
}

/** The commands that installed extensions contribute, runnable from the Extensions view. */
function renderCommands(): void {
  const cmds = host.commands(list)
  els.commands.replaceChildren(
    ...(cmds.length
      ? cmds.map((c) => {
          const b = document.createElement('button')
          b.className = 'vcmd'
          b.innerHTML = `<span class="vcmdtitle">${escapeHtml(c.title)}</span><span class="vdesc">${escapeHtml(c.ext)}</span>`
          b.addEventListener('click', () => void run(c.command))
          return b
        })
      : [Object.assign(document.createElement('div'), { className: 'extempty', textContent: 'No commands from installed extensions.' })]),
  )
}

function render(): void {
  // the installed list is always complete: the search box searches the marketplace, it does not hide what you have
  els.installed.replaceChildren(...list.map(installedCard))
  els.count.textContent = String(list.length)
}

let lastResults: Listing[] = []
let searchTimer: ReturnType<typeof setTimeout> | undefined

function renderResults(message?: string): void {
  els.resultsHead.hidden = els.results.hidden = false
  els.resultsHead.querySelector('.sectitle')!.textContent = query ? 'Marketplace' : 'Popular'
  els.results.replaceChildren()
  if (message) {
    const div = document.createElement('div')
    div.className = 'extempty'
    div.textContent = message
    els.results.append(div)
    return
  }
  els.results.append(...lastResults.map(resultCard))
}

/** The search box, as in VS Code: filters the installed list and searches the marketplace (Open VSX) as you type. */
export function setQuery(q: string): void {
  query = q.trim()
  render()
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void searchRegistry(), query ? 350 : 0)
}

export async function searchRegistry(): Promise<void> {
  clearTimeout(searchTimer)
  const mine = ++searching
  renderResults(query ? `Searching the marketplace for “${query}”…` : 'Loading popular extensions…')
  try {
    const found = await store.search(query)
    if (mine !== searching) return
    lastResults = found
    renderResults(found.length ? undefined : 'No extensions found in the marketplace (Open VSX). Some extensions are not published there.')
    checkResults(found)
  } catch (e) {
    if (mine !== searching) return
    lastResults = []
    renderResults(`The marketplace (Open VSX) is unavailable (${(e as VsxError).code ?? 'error'}). Installed extensions keep working.`)
  }
}

/** The Extensions view was opened: show popular extensions until something is typed. */
export function viewShown(): void {
  if (!lastResults.length) void searchRegistry()
}

export async function reload(): Promise<void> {
  list = await store.list()
  const { errors } = await applyAll(list)
  for (const e of errors) env.log(`${e.id}: ${e.message}`, 'err')
  await host.sync(list)
  await views.sync(list)
  render()
  renderCommands()
  if (lastResults.length) renderResults()
  drawDetail()
  env.changed()
}

const detailActions: import('./vsxdetail').DetailActions = {
  install: (l) => void installListing(l),
  uninstall: (e) => void uninstall(e),
  setEnabled: (e, on) => void store.setEnabled(e.id, on),
  installing: (id) => installing.has(id),
  runnable: (id) => runState(id),
  nodeOnly: NEEDS_NODE,
}

export function detailTitle(id: string): string {
  const ext = list.find((e) => e.id === id)
  return ext?.manifest.displayName ?? listings.get(id)?.displayName ?? id
}

function drawDetail(): void {
  if (!detail) return
  const { id, el } = detail
  renderDetail(el, { id, installed: list.find((e) => e.id === id), listing: listings.get(id) }, detailActions)
}

/** Show an extension's details in `el` (the editor area). Fetches the full marketplace record when it is not installed. */
export function showDetail(id: string, el: HTMLElement): void {
  detail = { id, el }
  drawDetail()
  if (!list.find((e) => e.id === id) || !listings.get(id)?.readmeUrl) {
    void store.lookup(id).then((l) => {
      if (!l || detail?.id !== id) return
      listings.set(id, l)
      drawDetail()
    })
  }
  const known = listings.get(id)
  if (known && !list.find((e) => e.id === id)) checkResults([known])
}

export function hideDetail(): void {
  detail = null
}

/** The open project changed: extensions get the new workspace, and Workspace Trust is asked for it. */
export async function projectChanged(): Promise<void> {
  await host.stopAll()
  await host.sync(list)
  render()
  await ensureTrust()
}

export { extensionThemes, setExtensionTheme }

export async function init(e: UiEnv, elements: Els): Promise<void> {
  env = e
  els = elements
  await loadTrust()
  host = new ExtensionHost({
    project: () => env.project(),
    trusted,
    log: (id, line, cls) => env.log(`[${id}] ${line}`, cls),
    notify: (id, level, message) => {
      env.log(`[${id}] ${message}`, level === 'error' ? 'err' : undefined)
      env.status(message)
      if (level !== 'info') void tiny.shell.notify(id, message)
    },
    status: (t) => env.status(t),
    viewsChanged: () => {
      views.refresh()
      renderCommands()
    },
    treeChanged: (view) => views.refresh(view),
  })
  views.init({ host, ...els.views, skipped: (id) => host.skipped.get(id), runCommand: (c) => void run(c) })
  store.onChange(() => void reload())
  await reload()
  await ensureTrust()
}
