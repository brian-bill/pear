// What installed extensions put on the left: activity-bar icons with their own side bar views
// (`contributes.viewsContainers.activitybar` + `contributes.views`), views added to the Explorer,
// and the tree data providers behind them (`vscode.window.registerTreeDataProvider`). The data
// comes from the extension's Worker through the host; this file draws it.
import { escapeHtml } from '@tiny/sdk'
import { icon, type IconName } from './icons'
import type { ExtensionHost, TreeNode } from './vsxhost'
import { parseJsonc } from './vsx'
import { readExtFile, readExtText, type Installed } from './vsxstore'

interface ViewDef { id: string; name: string; type?: string; ext: Installed }
interface ContainerDef { id: string; title: string; iconPath?: string; ext: Installed; views: ViewDef[] }
interface Welcome { view: string; contents: string }

export interface ViewsDeps {
  host: ExtensionHost
  /** The activity bar; extension buttons go before its spacer. */
  nav: HTMLElement
  /** Where extension containers' side views go (the side bar element, before its sash). */
  side: HTMLElement
  sash: HTMLElement
  /** Extension views contributed to the Explorer are listed in here. */
  explorer: HTMLElement
  /** Show this container (the button was clicked). */
  select(id: string): void
  isSelected(id: string): boolean
  /** Why an extension is not running (Restricted Mode, crashed), if it is not. */
  skipped(extId: string): string | undefined
  runCommand(command: string): void
}

let deps: ViewsDeps
let containers: ContainerDef[] = []
let explorerViews: ViewDef[] = []
let welcomes: Welcome[] = []
const nlsCache = new Map<string, Promise<Record<string, string>>>()
const blobs = new Map<string, Promise<string | null>>()
const expanded = new Set<string>()
const bodies = new Map<string, HTMLElement>()
const KEY = (view: string, path: string): string => `${view}\u0000${path}`

export const init = (d: ViewsDeps): void => void (deps = d)

function nlsOf(ext: Installed): Promise<Record<string, string>> {
  let p = nlsCache.get(ext.dir + ext.version)
  if (!p) {
    p = readExtText(ext, 'package.nls.json').then((t) => parseJsonc<Record<string, string>>(t)).catch(() => ({}))
    nlsCache.set(ext.dir + ext.version, p)
  }
  return p
}

/** `%key%` placeholders are looked up in package.nls.json. */
const localized = (nls: Record<string, string>, s: string): string => {
  const m = /^%(.+)%$/.exec(s)
  const v = m ? nls[m[1]!] : s
  return typeof v === 'string' ? v : typeof v === 'object' && v && 'message' in v ? String((v as { message: unknown }).message) : s
}

function assetUrl(ext: Installed, path: string): Promise<string | null> {
  const key = `${ext.dir}\u0000${path}`
  let p = blobs.get(key)
  if (!p) {
    p = readExtFile(ext, path)
      .then((b) => URL.createObjectURL(new Blob([b as BlobPart], { type: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png' })))
      .catch(() => null)
    blobs.set(key, p)
  }
  return p
}

async function collect(list: Installed[]): Promise<void> {
  containers = []
  explorerViews = []
  welcomes = []
  for (const ext of list.filter((e) => e.enabled && e.manifest.browser)) {
    const c = ext.manifest.contributes as Record<string, unknown> | undefined
    if (!c) continue
    const nls = await nlsOf(ext)
    const bars = ((c.viewsContainers as { activitybar?: Array<{ id: string; title: string; icon?: string }> } | undefined)?.activitybar ?? [])
    const views = (c.views as Record<string, Array<{ id: string; name: string; type?: string }>> | undefined) ?? {}
    const defs = (id: string): ViewDef[] => (views[id] ?? []).map((v) => ({ id: v.id, name: localized(nls, v.name), type: v.type, ext }))
    for (const bar of bars) {
      containers.push({ id: `${ext.id}:${bar.id}`, title: localized(nls, bar.title), iconPath: bar.icon && !bar.icon.startsWith('$(') ? bar.icon : undefined, ext, views: defs(bar.id) })
    }
    explorerViews.push(...defs('explorer'))
    for (const w of (c.viewsWelcome as Array<{ view: string; contents: string }> | undefined) ?? []) welcomes.push({ view: w.view, contents: localized(nls, w.contents) })
  }
}

// ---- drawing
const row = (depth: number): HTMLDivElement => {
  const r = document.createElement('div')
  r.className = 'vrow'
  r.style.paddingLeft = `${8 + depth * 14}px`
  r.setAttribute('role', 'treeitem')
  return r
}

function iconFor(node: TreeNode, ext: Installed): HTMLElement {
  const span = document.createElement('span')
  span.className = 'vglyph'
  const i = node.icon
  if (i?.theme) {
    const name = ({ folder: 'folder', file: 'file', 'symbol-file': 'file', 'folder-opened': 'folder-opened', gear: 'settings', add: 'new-file' } as Record<string, string>)[i.theme] ?? i.theme
    span.innerHTML = name in { folder: 1, file: 1, 'folder-opened': 1, settings: 1, 'new-file': 1, refresh: 1 } ? icon(name as IconName, 16) : ''
  } else if (i?.path) {
    const rel = i.path.startsWith(ext.dir) ? i.path.slice(ext.dir.length + 1) : i.path.replace(/^\/+/, '')
    void assetUrl(ext, rel).then((u) => u && (span.innerHTML = `<img src="${u}" alt="" width="16" height="16">`))
  }
  return span
}

async function loadChildren(view: ViewDef, parent: HTMLElement, handle: number | undefined, depth: number, path: string): Promise<void> {
  let nodes: TreeNode[]
  try {
    nodes = await deps.host.treeChildren(view.id, handle)
  } catch (e) {
    parent.replaceChildren(Object.assign(document.createElement('div'), { className: 'vmsg', textContent: (e as Error).message }))
    return
  }
  parent.replaceChildren()
  for (const node of nodes) {
    const here = `${path}/${node.label}`
    const r = row(depth)
    const chev = document.createElement('span')
    chev.className = 'vchev'
    const kids = document.createElement('div')
    kids.setAttribute('role', 'group')
    const isOpen = (): boolean => expanded.has(KEY(view.id, here))
    const paint = (): void => void (chev.innerHTML = node.state ? icon(isOpen() ? 'chevron-down' : 'chevron-right', 16) : '')
    paint()
    const label = document.createElement('span')
    label.className = 'vlabel'
    label.textContent = node.label
    const desc = document.createElement('span')
    desc.className = 'vdesc'
    desc.textContent = node.description
    r.append(chev, iconFor(node, view.ext), label, desc)
    if (node.tooltip) r.title = node.tooltip
    if (node.state) r.setAttribute('aria-expanded', String(isOpen()))
    const open = async (): Promise<void> => {
      kids.hidden = !isOpen()
      if (isOpen() && !kids.childElementCount) await loadChildren(view, kids, node.handle, depth + 1, here)
    }
    r.addEventListener('click', () => {
      if (node.hasCommand) deps.host.treeClick(view.id, node.handle)
      if (node.state) {
        if (isOpen()) expanded.delete(KEY(view.id, here))
        else expanded.add(KEY(view.id, here))
        r.setAttribute('aria-expanded', String(isOpen()))
        paint()
        void open()
      }
    })
    parent.append(r, kids)
    if (node.state === 2 && !expanded.has(KEY(view.id, here)) && !expanded.has(KEY(view.id, here + '\u0001closed'))) expanded.add(KEY(view.id, here))
    kids.hidden = true
    if (node.state && isOpen()) {
      paint()
      r.setAttribute('aria-expanded', 'true')
      await open()
    }
  }
}

/** `[label](command:id)` links become buttons, other lines text. */
function welcomeFor(view: string): HTMLElement | null {
  const text = welcomes.filter((w) => w.view === view).map((w) => w.contents).join('\n')
  if (!text) return null
  const box = document.createElement('div')
  box.className = 'emptyview'
  for (const line of text.split('\n').filter((l) => l.trim())) {
    const m = /^\[([^\]]+)\]\(command:([^)\s]+)[^)]*\)\s*$/.exec(line.trim())
    if (m) {
      const b = document.createElement('button')
      b.className = 'vbtn'
      b.textContent = m[1]!
      b.addEventListener('click', () => deps.runCommand(m[2]!))
      box.append(b)
    } else box.append(Object.assign(document.createElement('p'), { textContent: line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') }))
  }
  return box
}

async function fill(view: ViewDef, body: HTMLElement): Promise<void> {
  if (view.type === 'webview') {
    body.replaceChildren(Object.assign(document.createElement('div'), { className: 'vmsg', textContent: 'This view is a webview, which Code does not support yet.' }))
    return
  }
  if (!deps.host.hasView(view.id)) {
    const why = deps.skipped(view.ext.id)
    body.replaceChildren(Object.assign(document.createElement('div'), { className: 'vmsg', textContent: why ?? 'Waiting for the extension to start…' }))
    return
  }
  const probe = document.createElement('div')
  await loadChildren(view, probe, undefined, 0, '')
  const welcome = !probe.childElementCount ? welcomeFor(view.id) : null
  body.replaceChildren(...(welcome ? [welcome] : probe.childElementCount ? [...probe.childNodes] : [Object.assign(document.createElement('div'), { className: 'vmsg', textContent: 'No items.' })]))
}

function section(view: ViewDef): HTMLElement {
  const sec = document.createElement('div')
  sec.className = 'vsection'
  const head = document.createElement('button')
  head.className = 'sechead vhead'
  head.innerHTML = `<span class="chev">${icon('chevron-down', 16)}</span><span class="sectitle">${escapeHtml(view.name)}</span>`
  const body = document.createElement('div')
  body.className = 'vtree'
  body.setAttribute('role', 'tree')
  body.setAttribute('aria-label', view.name)
  head.addEventListener('click', () => {
    body.hidden = !body.hidden
    head.querySelector('.chev')!.innerHTML = icon(body.hidden ? 'chevron-right' : 'chevron-down', 16)
  })
  bodies.set(view.id, body)
  sec.append(head, body)
  void fill(view, body)
  return sec
}

const allViews = (): ViewDef[] => [...containers.flatMap((c) => c.views), ...explorerViews]
const findView = (id: string): ViewDef | undefined => allViews().find((v) => v.id === id)

/** Rebuild the activity-bar buttons and side views for the enabled extensions. */
export async function sync(list: Installed[]): Promise<void> {
  await collect(list)
  for (const el of deps.nav.querySelectorAll('[data-vsx-container]')) el.remove()
  for (const el of deps.side.querySelectorAll('[data-vsx-container]')) el.remove()
  bodies.clear()
  const spacer = deps.nav.querySelector('.grow')
  for (const c of containers) {
    const btn = document.createElement('button')
    btn.className = 'actitem'
    btn.dataset.vsxContainer = c.id
    btn.title = c.title
    btn.setAttribute('aria-label', c.title)
    btn.setAttribute('aria-pressed', String(deps.isSelected(c.id)))
    btn.innerHTML = icon('extensions', 24)
    if (c.iconPath) {
      void assetUrl(c.ext, c.iconPath.replace(/^\.\//, '')).then((u) => {
        if (!u) return
        btn.innerHTML = ''
        const mask = document.createElement('span')
        mask.className = 'vmask'
        mask.style.setProperty('--vmask', `url(${u})`)
        btn.append(mask)
      })
    }
    btn.addEventListener('click', () => deps.select(c.id))
    deps.nav.insertBefore(btn, spacer)

    const view = document.createElement('div')
    view.className = 'sideview'
    view.dataset.vsxContainer = c.id
    view.hidden = !deps.isSelected(c.id)
    view.innerHTML = `<div class="viewtitle"><span>${escapeHtml(c.title)}</span></div>`
    const scroller = document.createElement('div')
    scroller.className = 'vscroll'
    for (const v of c.views) scroller.append(section(v))
    if (!c.views.length) scroller.append(Object.assign(document.createElement('div'), { className: 'vmsg', textContent: 'This extension adds no views here.' }))
    view.append(scroller)
    deps.side.insertBefore(view, deps.sash)
  }
  deps.explorer.replaceChildren(...explorerViews.map(section))
  deps.explorer.hidden = explorerViews.length === 0
}

/** A view's provider changed (an extension started, stopped, or asked to refresh): redraw it. */
export function refresh(viewId?: string): void {
  for (const [id, body] of bodies) {
    if (viewId && id !== viewId) continue
    const def = findView(id)
    if (def && body.isConnected) void fill(def, body)
  }
}

export const hasContainer = (id: string): boolean => containers.some((c) => c.id === id)
