// Code — write Pear apps in Pear. A project is an ordinary `.app` bundle in the user's files
// (docs/sdk.md); the Preview extension serves it like a real app window, the AssemblyScript
// extension compiles WebAssembly in the browser. Everything runs client-side.
import { basename, bytesOf, dirname, escapeHtml, formatBytes, joinPath, textOf, tiny } from '@tiny/sdk'
import { buildShortcut, assemblyScriptExtension } from './asm'
import { CodeEditor, initLanguages, looksLikeAssemblyScript, onProblemsChanged, problems, setAssemblyScriptProject, setBuildProblems, syncTheme, type Problem } from './editor'
import { fileIcon, icon, languageName, type IconName } from './icons'
import { AUTO, THEMES, applyTheme, currentPalette, themeChoice } from './themes'
import type { ExtActions, ExtHost, ExtensionDef, ToolbarButton } from './extension'
import * as debugConsole from './debugconsole'
import * as share from './share'
import * as vsx from './vsxui'
import * as palette from './palette'
import { DEFAULT_KEYS, chordOf, createKeymap, display, isMac, parseKey, type Context, type Keymap } from './keys'
import { parseJsonc } from './vsx'
import type { MenuDef } from '@tiny/sdk'
import { KIND_LABEL, defaultKind, jsonToggleAll, render as renderPreview, type PreviewKind } from './previews'
import { previewExtension, togglePreview } from './preview'
import { TEMPLATES, instantiate, type TemplateDef } from './templates'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const CONFIG = 'org.tiny.code'

// ---- elements
const projectEl = $('project')
const treeEl = $('tree')
const tabsEl = $('tabs')
const editorsEl = $('editors')
const welcomeEl = $('welcome')
const extDetail = $('extDetail')

/** Tabs that are not files: an extension's details page is `ext://publisher.name`. */
const EXT_TAB = 'ext://'
const isVirtual = (path: string | null): boolean => !!path && path.startsWith(EXT_TAB)
const outputEl = $('output')
const outLog = $('outlog')
const stState = $('stState')
const stLang = $('stLang')
const stPos = $('stPos')
const saveBtn = $('save') as HTMLButtonElement
const filesView = $('filesView')
const extView = $('extView')
const tabFiles = $('tabFiles')
const tabExt = $('tabExt')
const extButtons = $('extButtons')
const breadcrumbsEl = $('breadcrumbs')
const secTitle = $('secTitle')
const explorerEmpty = $('explorerEmpty')
const extSearch = $('extSearch') as HTMLInputElement
const extCount = $('extCount')
const stIndent = $('stIndent')
const stEnc = $('stEnc')
const stProblems = $('stProblems')
const panelTabOutput = $('panelTabOutput')
const panelTabProblems = $('panelTabProblems')
const problemsList = $('problemsList')
const problemsBadge = $('problemsBadge')
const imageView = $('imageView')
const imageStage = $('imageStage')
const imageEl = $('imageEl') as HTMLImageElement
const zoomLabel = $('zoomLabel')
const sidePreview = $('sidePreview')
const svgStage = $('svgStage')
const svgEl = $('svgEl') as HTMLImageElement
const sideTitle = $('sideTitle')
const panelTabConsole = $('panelTabConsole')
const consoleView = $('consoleView')
const consoleFilter = $('consoleFilter') as HTMLSelectElement
const sideError = $('sideError')
const sideToggle = $('sideToggle')
const docView = $('docView')
const merkleChunk = $('merkleChunk') as HTMLSelectElement
const jsonExpand = $('jsonExpand')
const jsonCollapse = $('jsonCollapse')
const stAuto = $('stAuto')

/** Fill every `[data-icon]` placeholder with its codicon. */
function hydrateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon as IconName, Number(el.dataset.size) || 16)
  }
}

// ---- state
interface Entry {
  name: string
  kind: 'file' | 'dir'
}

let project: string | null = null
let entries = new Map<string, Entry>() // rel -> entry
let expanded = new Set<string>(['Resources', 'Resources/ui'])
let selected: string | null = null
let open: string[] = []
let active: string | null = null
let dirtySeen = new Set<string>()
let statusTimer: ReturnType<typeof setTimeout> | null = null

const extensions: ExtensionDef[] = [previewExtension, assemblyScriptExtension]
const actions = new Map<string, ExtActions>()

// ---- the extension host
const extHost: ExtHost = {
  project: () => project,
  readProjectFile: async (rel) => {
    if (!project) return null
    try {
      return await tiny.readFile(joinPath(project, rel))
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null
      throw e
    }
  },
  buffer: (rel) => (editor.isDirty(rel) ? editor.value(rel) : null),
  problems: (items) => setBuildProblems(items, 'AssemblyScript build'),
  fileExists: async (rel) => {
    try {
      return (await tiny.stat(joinPath(project!, rel))).kind === 'file'
    } catch {
      return false
    }
  },
  log: (line, cls) => {
    const span = document.createElement('span')
    if (cls) span.className = cls
    span.textContent = line + '\n'
    outLog.append(span)
    outLog.scrollTop = outLog.scrollHeight
  },
  showOutput: () => {
    outputEl.hidden = false
    selectPanel('output')
  },
  status,
}

function status(text: string): void {
  stState.textContent = text
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => (stState.textContent = project ? basename(project) : ''), 4000)
}

// ---- extensions
function activateExtensions(): void {
  for (const ext of extensions) {
    if (actions.has(ext.id)) continue
    actions.set(ext.id, ext.activate(extHost))
  }
  renderToolbar()
}

function renderToolbar(): void {
  extButtons.replaceChildren()
  for (const ext of extensions) {
    for (const button of actions.get(ext.id)?.toolbar ?? []) {
      if (!button.visible()) continue
      const el = document.createElement('button')
      el.className = button.primary ? 'action primary' : 'action'
      el.innerHTML = icon(button.icon ?? 'play')
      el.title = button.title
      el.setAttribute('aria-label', button.label)
      el.addEventListener('click', button.run)
      extButtons.append(el)
    }
  }
}

// ---- the file tree
async function refreshTree(): Promise<void> {
  if (!project) return
  entries = new Map()
  await walk('', 0)
  renderTree()
}

async function walk(rel: string, depth: number): Promise<void> {
  if (depth > 6) return
  const dir = rel ? joinPath(project!, rel) : project!
  for (const e of await tiny.readdir(dir)) {
    if (e.name.startsWith('.')) continue
    const child = rel ? `${rel}/${e.name}` : e.name
    const kind = e.kind === 'dir' ? 'dir' : 'file'
    entries.set(child, { name: e.name, kind })
    if (kind === 'dir' && expanded.has(child)) await walk(child, depth + 1)
  }
}

function renderTree(): void {
  treeEl.replaceChildren()
  // depth-first order: at every level folders come before files, each group alphabetical
  const isDir = (rel: string, i: number, parts: string[]): boolean => i < parts.length - 1 || entries.get(rel)?.kind === 'dir'
  const sorted = [...entries.keys()].sort((a, b) => {
    const pa = a.split('/')
    const pb = b.split('/')
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue
      const da = isDir(a, i, pa)
      const db = isDir(b, i, pb)
      return da !== db ? (da ? -1 : 1) : pa[i]!.localeCompare(pb[i]!)
    }
    return pa.length - pb.length
  })
  for (const rel of sorted) renderRow(rel)
  explorerEmpty.hidden = !!project
  treeEl.hidden = !project
  secTitle.textContent = project ? basename(project) : 'No Project'
  for (const id of ['newfile', 'newfolder', 'refreshTree', 'collapseTree']) ($(id) as HTMLButtonElement).disabled = !project
}

function renderRow(rel: string): void {
  const entry = entries.get(rel)
  if (!entry) return
  const depth = rel.split('/').length - 1
  const row = document.createElement('div')
  row.className = 'row'
  row.role = 'treeitem'
  if (selected === rel) row.classList.add('selected')
  const indent = document.createElement('span')
  indent.className = 'indent'
  indent.style.width = `${depth * 8}px`
  const twist = document.createElement('span')
  twist.className = 'twist'
  if (entry.kind === 'dir') twist.innerHTML = icon(expanded.has(rel) ? 'chevron-down' : 'chevron-right')
  const glyph = document.createElement('span')
  glyph.className = 'glyph'
  glyph.innerHTML = fileIcon(entry.name, entry.kind, expanded.has(rel))
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = entry.name
  row.title = rel
  row.setAttribute('aria-selected', String(selected === rel))
  if (entry.kind === 'dir') row.setAttribute('aria-expanded', String(expanded.has(rel)))
  row.append(indent, twist, glyph, label)
  row.addEventListener('click', () => void select(rel))
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    selected = rel
    renderTree()
    void rowMenu(rel, entry.kind, e.clientX, e.clientY)
  })
  treeEl.append(row)
}

async function select(rel: string): Promise<void> {
  const entry = entries.get(rel)
  if (!entry) return
  selected = rel
  if (entry.kind === 'dir') {
    if (expanded.has(rel)) expanded.delete(rel)
    else {
      expanded.add(rel)
      await refreshTree()
      return
    }
    await refreshTree()
    return
  }
  renderTree()
  await openFile(rel)
}

async function rowMenu(rel: string, kind: 'file' | 'dir', x: number, y: number): Promise<void> {
  await tiny.shell.contextMenu(
    [
      { label: 'New File…', action: () => void newFile(kind === 'dir' ? rel : dirname(rel)) },
      ...(kind === 'dir' ? [{ label: 'New Folder…', action: () => void newFolder(rel) }] : []),
      { separator: true },
      { label: 'Rename…', action: () => void renamePath(rel) },
      { label: 'Delete', action: () => void deletePath(rel), disabled: false },
    ],
    { x, y },
  )
}

function createIn(folder: string, what: 'file' | 'folder'): void {
  if (!project) return
  void (async () => {
    const name = await tiny.dialogs.prompt(`New ${what} in ${folder || projectRootName()}`, {
      value: what === 'file' ? 'untitled.js' : 'folder',
      placeholder: what === 'file' ? 'name.js' : 'name',
    })
    if (!name) return
    const rel = folder ? `${folder}/${name}` : name
    try {
      if (what === 'folder') {
        await tiny.mkdir(joinPath(project!, rel))
        expanded.add(rel)
      } else {
        await tiny.writeFile(joinPath(project!, rel), bytesOf(''))
        open.push(rel)
      }
    } catch (e) {
      status((e as Error).message)
      return
    }
    await refreshTree()
    if (what === 'file') await openFile(rel)
  })()
}
const newFile = (folder: string): void => createIn(folder, 'file')
const newFolder = (folder: string): void => createIn(folder, 'folder')

function renamePath(rel: string): void {
  void (async () => {
    const name = await tiny.dialogs.prompt('Rename', { value: basename(rel) })
    if (!name || name === basename(rel)) return
    try {
      await tiny.rename(joinPath(project!, rel), joinPath(dirname(joinPath(project!, rel)), name))
    } catch (e) {
      status((e as Error).message)
      return
    }
    const target = rel === basename(rel) ? name : `${dirname(rel)}/${name}`
    for (const p of editor.paths()) if (p === rel || p.startsWith(`${rel}/`)) editor.close(p)
    if (project) void preloadProject(project)
    if (open.includes(rel)) open[open.indexOf(rel)] = target
    if (active === rel) active = target
    renderTabs()
    await refreshTree()
  })()
}

function deletePath(rel: string): void {
  void (async () => {
    if (!(await tiny.dialogs.confirm(`Delete “${basename(rel)}”?`))) return
    try {
      await tiny.removeAll(joinPath(project!, rel))
    } catch (e) {
      status((e as Error).message)
      return
    }
    for (const p of editor.paths()) if (p === rel || p.startsWith(`${rel}/`)) editor.close(p)
    open = open.filter((o) => o !== rel && !o.startsWith(`${rel}/`))
    if (active && (active === rel || active.startsWith(`${rel}/`))) active = open[open.length - 1] ?? null
    renderTabs()
    await refreshTree()
  })()
}

const projectRootName = (): string => (project ? basename(project) : '')

// ---- tabs and the editor
const editor = new CodeEditor(
  editorsEl,
  (path, dirty) => {
    if (dirty) dirtySeen.add(path)
    else dirtySeen.delete(path)
    renderTabs()
    updateEdited()
    if (path === active) scheduleSidePreview()
    scheduleChange(path)
    if (dirty) scheduleAutoSave(path)
  },
  (line, col) => (stPos.textContent = `Ln ${line}, Col ${col}`),
  () => void save(),
)

function renderTabs(): void {
  tabsEl.replaceChildren()
  for (const path of open) {
    const pinned = pins.has(path)
    const tab = document.createElement('div')
    tab.className = `tab${editor.isDirty(path) ? ' dirty' : ''}${pinned ? ' pinned' : ''}`
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(path === active))
    tab.title = path
    const glyph = document.createElement('span')
    glyph.className = 'glyph'
    const virtual = isVirtual(path)
    glyph.innerHTML = virtual ? icon('extensions', 16) : fileIcon(basename(path), 'file')
    const label = document.createElement('span')
    label.className = 'tablabel'
    label.textContent = virtual ? `Extension: ${vsx.detailTitle(path.slice(EXT_TAB.length))}` : basename(path)
    if (virtual) tab.title = label.textContent
    const close = document.createElement('button')
    close.className = 'close'
    if (pinned) {
      close.innerHTML = icon('pin', 16)
      close.title = 'Unpin'
      close.setAttribute('aria-label', `Unpin ${basename(path)}`)
    } else {
      close.innerHTML = icon('close', 16)
      close.title = 'Close'
      close.setAttribute('aria-label', `Close ${basename(path)}`)
    }
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      if (pinned) togglePin(path)
      else void closeTab(path)
    })
    tab.addEventListener('click', () => {
      saveOnLeave(path)
      active = path
      showActive()
    })
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1 && !pinned) void closeTab(path)
    })
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (virtual) void tiny.shell.contextMenu([{ label: 'Close', action: () => void closeTab(path) }], { x: e.clientX, y: e.clientY })
      else void tabMenu(path, e.clientX, e.clientY)
    })
    tab.append(glyph, label, close)
    tabsEl.append(tab)
  }
  tabsEl.querySelector('.tab[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  saveBtn.disabled = !active || isVirtual(active)
  renderBreadcrumbs()
  scheduleMenus()
}

function renderBreadcrumbs(): void {
  breadcrumbsEl.replaceChildren()
  breadcrumbsEl.hidden = !active || isVirtual(active)
  if (!active || isVirtual(active)) return
  const parts = active.split('/')
  parts.forEach((part, i) => {
    if (i) {
      const sep = document.createElement('span')
      sep.className = 'sep'
      sep.innerHTML = icon('chevron-right', 14)
      breadcrumbsEl.append(sep)
    }
    const crumb = document.createElement('span')
    crumb.className = 'crumb'
    const last = i === parts.length - 1
    crumb.innerHTML = `${last ? fileIcon(part, 'file') : ''}<span>${escapeHtml(part)}</span>`
    breadcrumbsEl.append(crumb)
  })
}

/** Close one tab, asking first when it has changes that were never written. Resolves false if the user kept it open. */
async function closeTab(path: string): Promise<boolean> {
  if (editor.isDirty(path) && !(await tiny.dialogs.confirm(`Discard unsaved changes to ${basename(path)}?`))) return false
  if (!isVirtual(path)) {
    editor.close(path)
    void loadBackground(path)
  }
  open = open.filter((p) => p !== path)
  pins.delete(path)
  previewChoice.delete(path)
  if (!isVirtual(path)) closedStack.push(path)
  if (active === path) active = open[open.length - 1] ?? null
  dirtySeen.delete(path)
  renderTabs()
  showActive()
  updateEdited()
  return true
}

async function closeMany(paths: string[]): Promise<void> {
  for (const p of paths) if (!(await closeTab(p))) return
}

// ---- tab context menu (what VS Code offers on a tab, plus the preview views)
const pins = new Set<string>()
const closedStack: string[] = []

function togglePin(path: string): void {
  if (pins.has(path)) pins.delete(path)
  else {
    pins.add(path)
    // pinned tabs sit together at the left
    open = [...open.filter((p) => pins.has(p) && p !== path), path, ...open.filter((p) => !pins.has(p))]
  }
  renderTabs()
}

async function copyText(text: string): Promise<void> {
  try {
    await tiny.service('tiny.clipboard', { op: 'write', items: [{ type: 'public.utf8-plain-text', data: text }] })
    return
  } catch {
    // no clipboard permission: the selection trick needs none
  }
  const area = document.createElement('textarea')
  area.value = text
  document.body.append(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

function revealInExplorer(path: string): void {
  void switchSide(true)
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'))
  selected = path
  void refreshTree().then(() => treeEl.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' }))
}

async function revertFile(path: string): Promise<void> {
  if (!project) return
  if (editor.isDirty(path) && !(await tiny.dialogs.confirm(`Discard changes to ${basename(path)} and reload it from disk?`))) return
  const bytes = await extHost.readProjectFile(path)
  if (bytes) {
    editor.setSavedValue(path, textOf(bytes))
    dirtySeen.delete(path)
    renderTabs()
    updateEdited()
  }
}

async function tabMenu(path: string, x: number, y: number): Promise<void> {
  const i = open.indexOf(path)
  const dirty = editor.isDirty(path)
  const unpinned = (list: string[]): string[] => list.filter((p) => !pins.has(p))
  const kind = defaultKind(path)
  const previews: Array<[string, PreviewKind, boolean]> = [
    ['Open Markdown Preview to the Side', 'markdown', kind === 'markdown'],
    ['Open Mermaid Preview to the Side', 'mermaid', kind === 'mermaid'],
    ['Open JSON Tree View to the Side', 'json', kind === 'json'],
    ['Open Merkle Tree View to the Side', 'merkle', true],
    ['Open SVG Preview to the Side', 'svg', kind === 'svg'],
  ]
  await tiny.shell.contextMenu(
    [
      { label: 'Close', action: () => void closeTab(path), disabled: pins.has(path) },
      { label: 'Close Others', action: () => void closeMany(unpinned(open.filter((p) => p !== path))), disabled: unpinned(open).filter((p) => p !== path).length === 0 },
      { label: 'Close to the Right', action: () => void closeMany(unpinned(open.slice(i + 1))), disabled: unpinned(open.slice(i + 1)).length === 0 },
      { label: 'Close Saved', action: () => void closeMany(unpinned(open.filter((p) => !editor.isDirty(p)))), disabled: unpinned(open.filter((p) => !editor.isDirty(p))).length === 0 },
      { label: 'Close All', action: () => void closeMany(unpinned(open)), disabled: unpinned(open).length === 0 },
      { separator: true },
      { label: 'Copy Path', action: () => void copyText(joinPath(project ?? '', path)) },
      { label: 'Copy Relative Path', action: () => void copyText(path) },
      { separator: true },
      { label: 'Reveal in Finder', action: () => void tiny.shell.reveal(joinPath(project ?? '', path)) },
      { label: 'Reveal in Explorer', action: () => revealInExplorer(path) },
      { separator: true },
      { label: pins.has(path) ? 'Unpin' : 'Pin', action: () => togglePin(path) },
      { label: 'Reopen Closed Editor', action: () => void openFile(closedStack.pop()!), disabled: closedStack.length === 0 },
      { separator: true },
      { label: 'Save', action: () => void saveFile(path), disabled: !dirty },
      { label: 'Revert File', action: () => void revertFile(path), disabled: isRaster(path) },
      { label: 'Rename…', action: () => renamePath(path) },
      { separator: true },
      ...previews.map(([label, k, enabled]) => ({
        label,
        action: () => {
          if (path !== active) {
            saveOnLeave(path)
            active = path
            showActive()
          }
          openPreview(path, k)
        },
        disabled: !enabled,
        checked: effectiveKind(path) === k ? true : undefined,
      })),
    ],
    { x, y },
  )
}

async function openFile(rel: string): Promise<void> {
  if (!project) return
  if (!open.includes(rel)) open.push(rel)
  saveOnLeave(rel)
  active = rel
  const bytes = await extHost.readProjectFile(rel)
  if (bytes === null) {
    status(`Cannot read ${rel}`)
    return
  }
  welcomeEl.hidden = true
  if (isRaster(rel)) {
    showImage(rel, bytes)
  } else {
    hideImage()
    editor.open(rel, textOf(bytes))
  }
  setFileStatus(rel)
  renderTabs()
  showActive()
}

function setFileStatus(rel: string | null): void {
  const image = !!rel && isRaster(rel)
  if (!image) imageInfo = ''
  stLang.textContent = rel ? (image ? `Image${imageInfo}` : languageName(rel)) : ''
  if (!rel || image) stPos.textContent = ''
  stIndent.hidden = stEnc.hidden = !rel || image
}

function showActive(): void {
  extDetail.hidden = true
  vsx.hideDetail()
  if (active && isVirtual(active)) {
    hideImage()
    welcomeEl.hidden = true
    setFileStatus(null)
    extDetail.hidden = false
    vsx.showDetail(active.slice(EXT_TAB.length), extDetail)
    renderTabs()
    updateSidePreview()
    return
  }
  if (!active) {
    hideImage()
    updateSidePreview()
    welcomeEl.hidden = false
    welcomeEl.classList.toggle('watermark', !!project)
    setFileStatus(null)
    renderTabs()
    return
  }
  setFileStatus(active)
  if (isRaster(active)) {
    if (imageFor !== active) void openFile(active)
    else imageView.hidden = false
  } else {
    hideImage()
    const text = editor.value(active)
    if (text === null) void openFile(active)
    else editor.open(active, text)
  }
  renderTabs()
  updateSidePreview()
}

// ---- tell the extensions about edits (debounced): the preview follows the buffer, not just saved files
const changed = new Set<string>()
let changeTimer: ReturnType<typeof setTimeout> | null = null
function scheduleChange(path: string): void {
  changed.add(path)
  if (changeTimer) clearTimeout(changeTimer)
  changeTimer = setTimeout(() => {
    const paths = [...changed]
    changed.clear()
    for (const rel of paths) for (const a of actions.values()) a.onDidChangeFile?.(rel)
  }, 500)
}

// ---- images
const RASTER: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' }
const extOf = (rel: string): string => rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
const isRaster = (rel: string): boolean => extOf(rel) in RASTER

let imageFor: string | null = null
let imageUrl: string | null = null
let imageInfo = ''
let zoom: number | null = null // null = fit to the window

function setZoom(z: number | null): void {
  zoom = z
  imageStage.classList.toggle('fit', z === null)
  imageEl.style.width = z === null ? '' : `${Math.round(imageEl.naturalWidth * z)}px`
  imageEl.style.height = z === null ? '' : `${Math.round(imageEl.naturalHeight * z)}px`
  zoomLabel.textContent = z === null ? 'Fit' : `${Math.round(z * 100)}%`
}

function currentScale(): number {
  return zoom ?? (imageEl.naturalWidth ? imageEl.clientWidth / imageEl.naturalWidth : 1)
}

function showImage(rel: string, bytes: Uint8Array): void {
  if (imageUrl) URL.revokeObjectURL(imageUrl)
  imageUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: RASTER[extOf(rel)] }))
  imageFor = rel
  imageEl.onload = () => {
    imageInfo = ` · ${imageEl.naturalWidth} × ${imageEl.naturalHeight} · ${formatBytes(bytes.byteLength)}`
    if (active === rel) stLang.textContent = `Image${imageInfo}`
    setZoom(null)
  }
  imageEl.alt = basename(rel)
  imageEl.src = imageUrl
  imageView.hidden = false
}

function hideImage(): void {
  imageView.hidden = true
}

// ---- side preview: the file beside its source, redrawn as you type.
// An SVG, a Markdown file (with Mermaid blocks), a Mermaid diagram, a JSON tree, or any file's Merkle tree.
// SVG opens by itself; the others open from the tab's context menu or the tab bar's preview button.
const previewChoice = new Map<string, PreviewKind | null>() // per file: what the user picked (null = closed)
let sideTimer: ReturnType<typeof setTimeout> | null = null
let sideSeq = 0
let sideShown = ''

const effectiveKind = (rel: string | null): PreviewKind | null => {
  if (!rel) return null
  const picked = previewChoice.get(rel)
  if (picked !== undefined) return picked
  return defaultKind(rel) === 'svg' ? 'svg' : null
}

function openPreview(rel: string, kind: PreviewKind | null): void {
  previewChoice.set(rel, kind)
  if (rel === active) updateSidePreview()
}

function scheduleSidePreview(): void {
  if (!effectiveKind(active)) return
  if (sideTimer) clearTimeout(sideTimer)
  sideTimer = setTimeout(updateSidePreview, 250)
}

function updateSidePreview(): void {
  const kind = effectiveKind(active)
  const available = defaultKind(active)
  sideToggle.hidden = !available
  const show = !!kind && !!active
  sidePreview.hidden = !show
  editorsEl.classList.toggle('split', show)
  sideToggle.setAttribute('aria-pressed', String(show))
  if (available) sideToggle.title = `${show ? 'Close' : 'Open'} ${KIND_LABEL[available]} to the Side`
  if (!show || !active || !kind) return
  sideTitle.textContent = KIND_LABEL[kind]
  merkleChunk.hidden = kind !== 'merkle'
  jsonExpand.hidden = jsonCollapse.hidden = kind !== 'json'
  svgStage.hidden = kind !== 'svg'
  docView.hidden = kind === 'svg'
  const key = `${active}:${kind}`
  if (key !== sideShown) {
    sideShown = key
    docView.scrollTop = 0
  }
  const path = active
  const text = editor.value(path) ?? ''
  if (kind === 'svg') {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const err = doc.querySelector('parsererror')
    sideError.hidden = !err
    if (err) {
      sideError.textContent = (err.textContent ?? 'Invalid SVG').split('\n').find((l) => l.trim() && !l.startsWith('This page')) ?? 'Invalid SVG'
      return
    }
    if (svgEl.dataset.url) URL.revokeObjectURL(svgEl.dataset.url)
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    svgEl.dataset.url = url
    svgEl.src = url
    return
  }
  sideError.hidden = true
  const seq = ++sideSeq
  void renderPreview(kind, docView, {
    path,
    text,
    dark: currentPalette().dark,
    chunk: Number(merkleChunk.value),
    current: () => seq === sideSeq && active === path,
    bytes: async () => (isRaster(path) || editor.value(path) === null ? extHost.readProjectFile(path) : bytesOf(editor.value(path) ?? '')),
    readRel: (rel) => extHost.readProjectFile(rel).catch(() => null),
    openFile: (rel) => void openFile(rel),
  })
}

// ---- project files the language services should know about (not only the open tabs)
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'htm', 'svg', 'xml', 'md'])
const isCode = (rel: string): boolean => CODE_EXT.has(extOf(rel))

async function loadBackground(rel: string): Promise<void> {
  if (!project || editor.has(rel) || !isCode(rel)) return
  const bytes = await extHost.readProjectFile(rel).catch(() => null)
  if (bytes && bytes.byteLength < 512 * 1024 && !editor.has(rel)) editor.addBackground(rel, textOf(bytes))
}

async function preloadProject(root: string): Promise<void> {
  const files: string[] = []
  const scan = async (rel: string, depth: number): Promise<void> => {
    if (depth > 8 || files.length > 400) return
    for (const e of await tiny.readdir(rel ? joinPath(root, rel) : root).catch(() => [])) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir') await scan(child, depth + 1)
      else if (isCode(child)) files.push(child)
    }
  }
  await scan('', 0)
  for (const rel of files) {
    if (project !== root) return // another project was opened meanwhile
    await loadBackground(rel)
  }
}

// ---- panel: Output and Problems
function selectPanel(which: 'output' | 'problems' | 'console'): void {
  panelTabOutput.setAttribute('aria-selected', String(which === 'output'))
  panelTabProblems.setAttribute('aria-selected', String(which === 'problems'))
  panelTabConsole.setAttribute('aria-selected', String(which === 'console'))
  outLog.hidden = which !== 'output'
  problemsList.hidden = which !== 'problems'
  consoleView.hidden = which !== 'console'
  consoleFilter.hidden = which !== 'console'
  $('outclear').hidden = which === 'problems'
  $('outclear').title = which === 'console' ? 'Clear Console (Ctrl+L)' : 'Clear Output'
  if (which === 'console') ($('consoleInput') as HTMLInputElement).focus()
  currentPanel = which
}
let currentPanel: 'output' | 'problems' | 'console' = 'output'

function showConsole(): void {
  outputEl.hidden = false
  selectPanel('console')
}

function renderProblems(): void {
  const list: Problem[] = problems()
  const errors = list.filter((p) => p.severity === 'error').length
  const warnings = list.filter((p) => p.severity === 'warning').length
  stProblems.innerHTML = `<span class="n">${icon('error', 14)}${errors}</span><span class="n">${icon('warning', 14)}${warnings}</span>`
  problemsBadge.hidden = list.length === 0
  problemsBadge.textContent = String(list.length)
  problemsList.replaceChildren()
  if (!list.length) {
    const none = document.createElement('div')
    none.className = 'none'
    none.textContent = 'No problems have been detected in the project.'
    problemsList.append(none)
    return
  }
  let lastPath = ''
  for (const p of list) {
    if (p.path !== lastPath) {
      lastPath = p.path
      const head = document.createElement('div')
      head.className = 'pfile'
      const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : ''
      head.innerHTML = `${fileIcon(basename(p.path), 'file')}<span>${escapeHtml(basename(p.path))}</span><span class="dim">${escapeHtml(dir)}</span><span class="badge count">${list.filter((q) => q.path === p.path).length}</span>`
      problemsList.append(head)
    }
    const row = document.createElement('div')
    row.className = 'pitem'
    row.role = 'listitem'
    row.innerHTML = `<span class="sev sev-${p.severity}">${icon(p.severity, 16)}</span><span class="msg">${escapeHtml(p.message)}</span><span class="dim">${escapeHtml(p.source)} [Ln ${p.line}, Col ${p.col}]</span>`
    row.addEventListener('click', () => void goTo(p.path, p.line, p.col))
    problemsList.append(row)
  }
}

async function goTo(rel: string, line: number, col: number): Promise<void> {
  if (active !== rel) await openFile(rel)
  editor.reveal(line, col)
}

function showProblems(): void {
  outputEl.hidden = false
  selectPanel('problems')
}

function updateEdited(): void {
  void tiny.window.setEdited(editor.allDirty().length > 0)
}

// Writes are queued per file and record the version they wrote, so typing during a write stays unsaved.
const writing = new Map<string, Promise<void>>()

function saveFile(path: string, quiet = false): Promise<void> {
  const run = (writing.get(path) ?? Promise.resolve()).then(async () => {
    const snap = editor.snapshot(path)
    if (!project || !snap || !editor.isDirty(path)) return
    try {
      await tiny.writeFile(joinPath(project, path), bytesOf(snap.text))
      editor.markSaved(path, snap.version)
      if (!editor.isDirty(path)) dirtySeen.delete(path)
      if (!quiet) status(`Saved ${basename(path)}`)
      renderTabs()
      updateEdited()
      for (const a of actions.values()) a.onDidSaveProject?.(path)
      renderToolbar()
    } catch (e) {
      status(`Save failed: ${(e as Error).message}`)
    }
  })
  writing.set(path, run)
  return run
}

const save = (): Promise<void> => (active && !isVirtual(active) ? saveFile(active) : Promise.resolve())
const saveAll = (): Promise<void> => Promise.all(editor.allDirty().map((p) => saveFile(p))).then(() => undefined)

// ---- auto save: After Delay (the default), On Focus Change, or Off
type AutoSave = 'off' | 'afterDelay' | 'onFocusChange'
const AUTO_SAVE_LABEL: Record<AutoSave, string> = { off: 'Off', afterDelay: 'After Delay', onFocusChange: 'On Focus Change' }
const AUTO_SAVE_DELAY = 1000
let autoSave: AutoSave = 'afterDelay'
const autoTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleAutoSave(path: string): void {
  if (autoSave !== 'afterDelay') return
  clearTimeout(autoTimers.get(path))
  autoTimers.set(
    path,
    setTimeout(() => {
      autoTimers.delete(path)
      if (editor.isDirty(path)) void saveFile(path, true)
    }, AUTO_SAVE_DELAY),
  )
}

/** Leaving a file (another tab, another window) writes it when auto save is On Focus Change. */
function saveOnLeave(next: string | null): void {
  if (autoSave === 'onFocusChange' && active && active !== next) void saveAll()
}

function setAutoSave(mode: AutoSave): void {
  autoSave = mode
  for (const t of autoTimers.values()) clearTimeout(t)
  autoTimers.clear()
  if (mode === 'afterDelay') for (const p of editor.allDirty()) scheduleAutoSave(p)
  void tiny.configSet(CONFIG, 'autoSave', mode)
  stAuto.textContent = mode === 'off' ? 'Auto Save: Off' : 'Auto Save'
  stAuto.title = `Auto Save: ${AUTO_SAVE_LABEL[mode]}`
  scheduleMenus()
}

function autoSaveMenu(at: { x: number; y: number }): void {
  void tiny.shell.contextMenu(
    (['afterDelay', 'onFocusChange', 'off'] as AutoSave[]).map((m) => ({ label: `Auto Save: ${AUTO_SAVE_LABEL[m]}`, checked: autoSave === m, action: () => setAutoSave(m) })),
    at,
  )
}

// ---- projects
async function openProject(path: string): Promise<void> {
  project = path.replace(/\/$/, '')
  expanded = new Set(['Resources', 'Resources/ui'])
  selected = null
  open = []
  active = null
  editor.closeAll()
  welcomeEl.hidden = false
  welcomeEl.classList.add('watermark')
  setFileStatus(null)
  projectEl.textContent = projectRootName()
  await tiny.window.setTitle(`${projectRootName()} — Code`)
  hideImage()
  imageFor = null
  updateSidePreview()
  // a project whose src/main.ts is AssemblyScript gets the AssemblyScript language service for src/**.ts
  const asMain = await extHost.readProjectFile('src/main.ts')
  setAssemblyScriptProject(!!asMain && looksLikeAssemblyScript(textOf(asMain)))
  await refreshTree()
  void preloadProject(project)
  activateExtensions()
  for (const a of actions.values()) await a.onDidOpenProject?.()
  renderToolbar()
  await tiny.configSet(CONFIG, 'lastProject', project)
  tiny.app.stateChanged()
  status('Ready')
  void vsx.projectChanged().then(setMenus)
}

function closeProject(): void {
  project = null
  open = []
  active = null
  selected = null
  entries = new Map()
  setAssemblyScriptProject(false)
  editor.closeAll()
  projectEl.textContent = 'No Project'
  welcomeEl.hidden = false
  welcomeEl.classList.remove('watermark')
  setFileStatus(null)
  void tiny.window.setTitle('Code')
  void tiny.configSet(CONFIG, 'lastProject', null)
  tiny.app.stateChanged()
  hideImage()
  imageFor = null
  updateSidePreview()
  renderTabs()
  renderTree()
  renderToolbar()
  for (const a of actions.values()) a.onDidCloseProject?.()
  void vsx.projectChanged().then(setMenus)
}

async function newProject(at: { x: number; y: number }): Promise<void> {
  const name = await tiny.dialogs.prompt('Name the new project', { value: 'Demo', placeholder: 'MyApp' })
  if (!name) return
  const choice = await new Promise<TemplateDef | null>((resolve) => {
    void tiny.shell.contextMenu(
      TEMPLATES.map((t) => ({
        label: t.label,
        action: () => resolve(t),
      })),
      at,
    )
    // cancelled
    setTimeout(() => resolve(null), 60_000)
  })
  if (!choice) return
  const home = (await tiny.getenv('HOME')) || '/Users/pear'
  const root = `${home}/Projects/${name.replace(/[^\w.-]+/g, '') || 'App'}.app`
  try {
    if (await tiny.exists(root)) {
      if (!(await tiny.dialogs.confirm(`${root} already exists. Open it?`))) return
      await openProject(root)
      return
    }
    for (const [rel, content] of Object.entries(instantiate(choice, name))) {
      const abs = joinPath(root, rel)
      await tiny.mkdir(dirname(abs), { recursive: true })
      await tiny.writeFile(abs, bytesOf(content))
    }
  } catch (e) {
    status((e as Error).message)
    return
  }
  await openProject(root)
  await openFile('Resources/ui/main.js')
  if (choice.id === 'wasm') await openFile('src/main.ts')
}

// ---- menus and shortcuts
let menuTimer: ReturnType<typeof setTimeout> | null = null
/** The menus are plain data, so they are rebuilt when what they show (open file, auto save mode) changes. */
function scheduleMenus(): void {
  if (menuTimer) return
  menuTimer = setTimeout(() => {
    menuTimer = null
    setMenus()
  }, 50)
}

function setMenus(): void {
  const menus: MenuDef[] = [
    {
      title: 'Code',
      items: [{ label: 'About Code', action: () => void tiny.dialogs.alert({ title: 'Code', message: 'Write Pear apps in Pear: HTML, CSS, JavaScript and WebAssembly, previewed live. Everything runs client-side.' }) }],
    },
    {
      title: 'File',
      items: [
        { label: 'New Project…', shortcut: 'Cmd+Shift+N', action: () => void newProject({ x: 200, y: 40 }) },
        { label: 'Open Project…', shortcut: 'Cmd+O', action: () => void openProjectDialog() },
        { separator: true },
        { label: 'Save', shortcut: 'Cmd+S', action: () => void save(), disabled: !active || isVirtual(active) },
        { label: 'Save All', shortcut: 'Cmd+Alt+S', action: () => void saveAll(), disabled: editor.allDirty().length === 0 },
        { separator: true },
        ...(['afterDelay', 'onFocusChange', 'off'] as AutoSave[]).map((m) => ({ label: `Auto Save: ${AUTO_SAVE_LABEL[m]}`, checked: autoSave === m, action: () => setAutoSave(m) })),
        { separator: true },
        { label: 'Close Project', action: closeProject, disabled: !project },
        { separator: true },
        { label: 'Close Editor', shortcut: 'Cmd+W', action: () => void execute('workbench.action.closeActiveEditor') },
        { label: 'Close Window', shortcut: 'Cmd+Shift+W', action: () => void execute('workbench.action.closeWindow') },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Find', action: () => editor.run('actions.find'), disabled: !active || isVirtual(active) },
        { label: 'Replace', action: () => editor.run('editor.action.startFindReplace'), disabled: !active || isVirtual(active) },
        { separator: true },
        { label: 'Format Document', action: () => editor.run('editor.action.formatDocument'), disabled: !active || isVirtual(active) },
        { label: 'Toggle Line Comment', action: () => editor.run('editor.action.commentLine'), disabled: !active || isVirtual(active) },
        { label: 'Go to Symbol…', action: () => editor.run('editor.action.quickOutline'), disabled: !active || isVirtual(active) },
        { label: 'Go to Line…', action: () => editor.run('editor.action.gotoLine'), disabled: !active || isVirtual(active) },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Problems', shortcut: 'Cmd+Shift+M', action: showProblems },
        { label: 'Debug Console', shortcut: 'Cmd+Shift+Y', action: showConsole },
        { label: 'Toggle Preview', shortcut: 'Cmd+Shift+V', action: togglePreview },
        { label: 'Reload Preview', shortcut: 'Cmd+R', action: () => $('prevReload').click() },
        { label: 'Toggle Output', shortcut: 'Cmd+Y', action: () => (outputEl.hidden = !outputEl.hidden) },
        { separator: true },
        { label: 'Command Palette…', hint: hint('workbench.action.showCommands'), action: () => void execute('workbench.action.showCommands') },
        { label: 'Toggle Primary Side Bar', hint: hint('workbench.action.toggleSidebarVisibility'), action: () => void execute('workbench.action.toggleSidebarVisibility') },
        { label: 'Toggle Panel', hint: hint('workbench.action.togglePanel'), action: () => void execute('workbench.action.togglePanel') },
        { label: 'Toggle Word Wrap', hint: hint('editor.action.toggleWordWrap'), action: () => void execute('editor.action.toggleWordWrap') },
        { separator: true },
        { label: 'Show Files', shortcut: 'Cmd+0', action: () => void switchSide(true) },
        { label: 'Show Extensions', shortcut: 'Cmd+Shift+X', action: () => void switchSide(false) },
        { separator: true },
        { label: 'Color Theme…', action: () => themeMenu({ x: 260, y: 60 }) },
        { separator: true },
        { label: 'Keyboard Shortcuts', hint: hint('workbench.action.openGlobalKeybindings'), action: () => void execute('workbench.action.openGlobalKeybindings') },
        { label: 'Keyboard Shortcuts (JSON)', action: () => void execute('workbench.action.openGlobalKeybindingsFile') },
      ],
    },
    {
      title: 'Go',
      items: [
        { label: 'Go to File…', hint: hint('workbench.action.quickOpen'), action: () => void execute('workbench.action.quickOpen'), disabled: !project },
        { label: 'Go to Line/Column…', hint: hint('workbench.action.gotoLine'), action: () => void execute('workbench.action.gotoLine'), disabled: !active || isVirtual(active) },
        { label: 'Go to Symbol in Editor…', hint: hint('workbench.action.gotoSymbol'), action: () => void execute('workbench.action.gotoSymbol'), disabled: !active || isVirtual(active) },
        { separator: true },
        { label: 'Next Editor', hint: hint('workbench.action.nextEditor'), action: () => void execute('workbench.action.nextEditor'), disabled: open.length < 2 },
        { label: 'Previous Editor', hint: hint('workbench.action.previousEditor'), action: () => void execute('workbench.action.previousEditor'), disabled: open.length < 2 },
        { label: 'Reopen Closed Editor', hint: hint('workbench.action.reopenClosedEditor'), action: () => void execute('workbench.action.reopenClosedEditor'), disabled: closedStack.length === 0 },
      ],
    },
    {
      title: 'Extensions',
      items: [
        { label: 'Install Extension from VSIX…', action: () => void vsx.installVsixDialog() },
        { label: 'Install Extension from Location…', action: () => void vsx.installFolderDialog() },
        { label: 'Update Extensions', action: () => void vsx.updateAll() },
        { separator: true },
        { label: 'Run Extension Command…', action: () => vsx.commandMenu({ x: 260, y: 60 }) },
        { label: 'Trust This Workspace', action: () => void vsx.trustWorkspace(), disabled: !project || vsx.isTrusted() },
        { label: 'Use Restricted Mode', action: () => void vsx.restrictWorkspace(), disabled: !project || !vsx.isTrusted() },
      ],
    },
    {
      title: 'Actions',
      items: [
        { label: 'Build', shortcut: 'Cmd+Shift+B', action: buildShortcut, disabled: !project, },
        { label: 'Package & Install', action: () => void share.packageAndInstall(project!), disabled: !project },
        { label: 'Download .pearapp', action: () => void share.downloadPackage(project!), disabled: !project },
        { separator: true },
        { label: 'Check Project…', action: () => void share.checkProject(project!), disabled: !project },
      ],
    }
  ]
  // remember which keys the menus own, so the keymap leaves them to the SDK instead of running them twice
  menuKeys.clear()
  for (const m of menus) for (const i of m.items) {
    const chords = typeof i.shortcut === 'string' ? parseKey(i.shortcut.replace(/⌘/g, 'Cmd+').replace(/\+\+/g, '+'), true) : null
    if (chords?.length === 1) menuKeys.add(chords[0]!)
  }
  void tiny.window.setMenus(menus)
}

async function openProjectDialog(): Promise<void> {
  const home = (await tiny.getenv('HOME')) || '/Users/pear'
  const picked = await tiny.dialogs.openFolder({ title: 'Open Project', startIn: `${home}/Projects` })
  if (picked?.[0]) await openProject(picked[0])
}

/** The side bar shows one view: Files, Extensions, or a container an extension contributed (its id). */
let sideView: string = 'files'
function setSide(which: string): void {
  sideView = which
  filesView.hidden = which !== 'files'
  extView.hidden = which !== 'ext'
  tabFiles.setAttribute('aria-pressed', String(which === 'files'))
  tabExt.setAttribute('aria-pressed', String(which === 'ext'))
  for (const el of document.querySelectorAll<HTMLElement>('[data-vsx-container]')) {
    const on = el.dataset.vsxContainer === which
    if (el.classList.contains('actitem')) el.setAttribute('aria-pressed', String(on))
    else el.hidden = !on
  }
  if (which === 'ext') vsx.viewShown()
  editor.layout()
}

async function switchSide(files: boolean): Promise<void> {
  setSide(files ? 'files' : 'ext')
}

// ---- colour theme
const hostDark = (): boolean => document.documentElement.dataset.theme === 'dark'

/** Apply the chosen theme: a built-in palette drives the workbench and Monaco; an extension theme colours Monaco on top of the current palette. */
function applyChoice(id: string): void {
  syncTheme(applyTheme(id, hostDark()))
  if (id.startsWith('vsx:')) vsx.setExtensionTheme(id)
}

function setTheme(id: string): void {
  applyChoice(id)
  void tiny.configSet(CONFIG, 'colorTheme', id)
}

function themeMenu(at: { x: number; y: number }): void {
  const chosen = themeChoice()
  const mark = (on: boolean): string => (on ? '✓ ' : '    ')
  void tiny.shell.contextMenu(
    [
      ...THEMES.map((t) => ({ label: mark(chosen === t.id) + t.label, action: () => setTheme(t.id) })),
      { separator: true },
      { label: mark(chosen === AUTO) + 'Match Pear Appearance', action: () => setTheme(AUTO) },
      ...(vsx.extensionThemes().length ? [{ separator: true }, ...vsx.extensionThemes().map((t) => ({ label: mark(chosen === t.id) + `${t.label} (extension)`, action: () => setTheme(t.id) }))] : []),
    ],
    at,
  )
}


// ---- commands and keybindings (contracts/code-extensions.md; keys follow VS Code's defaults)
interface Command { title: string; run(args?: unknown): unknown; hidden?: boolean }
const commands = new Map<string, Command>()
const reg = (id: string, title: string, run: Command['run'], hidden = false): void => void commands.set(id, { title, run, hidden })
let keymap = undefined as unknown as Keymap // set by initKeys() at boot
let treeFocus = false
/** Keys that menu items own (the SDK runs those itself), as canonical chords. */
const menuKeys = new Set<string>()
let sideHidden = false

function keyContext(): Context {
  const a = document.activeElement as HTMLElement | null
  const inEditor = !!a?.closest('.monaco-editor')
  const input = !!a && !inEditor && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)
  return { editorTextFocus: inEditor, inputFocus: inEditor || input, explorerViewletFocus: treeFocus, hasProject: !!project, sideBarVisible: !sideHidden, panelVisible: !outputEl.hidden, activeEditor: !!active, sideBar: sideView }
}

/** Run a command by id: the workbench's, then Monaco's (`editor.action.*`), then an extension's. */
async function execute(id: string, args?: unknown): Promise<void> {
  const c = commands.get(id)
  try {
    if (c) await c.run(args)
    else if (editor.actions().some((a) => a.id === id)) editor.run(id)
    else await vsx.runExtensionCommand(id)
  } catch (e) {
    status((e as Error).message)
  }
}

function toggleSidebar(): void {
  sideHidden = !sideHidden
  $('side').style.display = sideHidden ? 'none' : ''
  $('sashSide').style.display = sideHidden ? 'none' : ''
  editor.layout()
}

function cycleEditor(step: number): void {
  if (open.length < 2) return
  const at = Math.max(0, open.indexOf(active ?? ''))
  const next = open[(at + step + open.length) % open.length]!
  saveOnLeave(next)
  active = next
  showActive()
}

function openEditorAt(n: number): void {
  const target = n >= 9 ? open[open.length - 1] : open[n - 1]
  if (!target) return
  saveOnLeave(target)
  active = target
  showActive()
}

async function listProjectFiles(): Promise<string[]> {
  if (!project) return []
  const files: string[] = []
  const scan = async (rel: string, depth: number): Promise<void> => {
    if (depth > 8 || files.length >= 5000) return
    for (const e of await tiny.readdir(rel ? joinPath(project!, rel) : project!).catch(() => [])) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir') await scan(child, depth + 1)
      else files.push(child)
    }
  }
  await scan('', 0)
  const rank = (p: string): number => (open.includes(p) ? open.length - open.indexOf(p) : 0)
  return files.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))
}

const hint = (id: string): string => keymap?.hint(id) ?? ''
const refocus = (): void => {
  if (active && !isVirtual(active)) editor.focus()
}

const paletteSource = (files: string[] = []): palette.PaletteSource => ({
  commands: () => [
    ...[...commands].filter(([, c]) => !c.hidden).map(([id, c]) => ({ label: c.title, description: id.startsWith('workbench') ? undefined : id, keys: hint(id), run: () => void execute(id) })),
    ...vsx.extensionCommands().map((c) => ({ label: c.title, description: c.ext, keys: hint(c.command), run: () => void execute(c.command) })),
    ...editor.actions().filter((a) => !commands.has(a.id)).map((a) => ({ label: a.label, description: 'Editor', keys: hint(a.id), run: () => void execute(a.id) })),
  ],
  files: () => files.map((rel) => ({ label: basename(rel), description: dirname(rel) === '.' ? '' : dirname(rel), run: () => void openFile(rel) })),
  shortcuts: () => {
    const title = (id: string): string => commands.get(id)?.title ?? editor.actions().find((a) => a.id === id)?.label ?? vsx.extensionCommands().find((c) => c.command === id)?.title ?? id
    const bound = keymap.all().map((b) => ({ label: title(b.command), description: `${b.command}${b.when ? `  when ${b.when}` : ''}${b.source === 'default' ? '' : `  (${b.source})`}`, keys: display(b.chords, mac()), run: () => void execute(b.command, b.args) }))
    const have = new Set(keymap.all().map((b) => b.command))
    const unbound = [...commands].filter(([id, c]) => !c.hidden && !have.has(id)).map(([id, c]) => ({ label: c.title, description: id, keys: '', run: () => void execute(id) }))
    return [...bound, ...unbound]
  },
  gotoLine: (line) => {
    editor.revealLine(line)
  },
  gotoSymbol: () => editor.run('editor.action.quickOutline'),
})

const mac = (): boolean => isMac(tiny.platform || navigator.platform)

async function userKeybindingsPath(): Promise<string> {
  return joinPath((await tiny.getenv('HOME')) || '/Users/pear', 'Library/Application Support/Code/User/keybindings.json')
}

async function loadUserKeybindings(): Promise<void> {
  try {
    const parsed = parseJsonc<unknown>(textOf(await tiny.readFile(await userKeybindingsPath())))
    keymap.set('user', Array.isArray(parsed) ? parsed.filter((k) => k && typeof k.key === 'string' && typeof k.command === 'string') : [])
  } catch {
    keymap.set('user', []) // none yet, or not valid JSON: the defaults stand
  }
}

function registerCommands(): void {
  reg('workbench.action.showCommands', 'Show All Commands', () => palette.open(paletteSource(), 'commands', refocus))
  reg('workbench.action.quickOpen', 'Go to File…', async () => palette.open(paletteSource(await listProjectFiles()), 'files', refocus))
  reg('workbench.action.openGlobalKeybindings', 'Preferences: Open Keyboard Shortcuts', () => palette.open(paletteSource(), 'keys', refocus))
  reg('workbench.action.openGlobalKeybindingsFile', 'Preferences: Open Keyboard Shortcuts (JSON)', async () => {
    const path = await userKeybindingsPath()
    if (!(await tiny.exists(path))) {
      await tiny.mkdir(dirname(path), { recursive: true })
      await tiny.writeFile(path, bytesOf('// Place your key bindings in this file to override the defaults.\n// [{ "key": "ctrlcmd+shift+k", "command": "workbench.action.showCommands" }, { "key": "ctrlcmd+b", "command": "-workbench.action.toggleSidebarVisibility" }]\n[]\n'))
    }
    await tiny.shell.reveal(path)
  })
  reg('workbench.action.reloadKeybindings', 'Preferences: Reload Keyboard Shortcuts', async () => {
    await loadUserKeybindings()
    status('Keyboard shortcuts reloaded')
  })
  reg('workbench.action.selectTheme', 'Preferences: Color Theme', () => themeMenu({ x: window.innerWidth / 2 - 100, y: 80 }))
  reg('workbench.action.toggleSidebarVisibility', 'View: Toggle Primary Side Bar Visibility', toggleSidebar)
  reg('workbench.action.togglePanel', 'View: Toggle Panel Visibility', () => (outputEl.hidden = !outputEl.hidden))
  reg('workbench.action.output.toggleOutput', 'View: Toggle Output', () => {
    outputEl.hidden = false
    selectPanel('output')
  })
  reg('workbench.actions.view.problems', 'View: Toggle Problems', showProblems)
  reg('workbench.debug.action.toggleRepl', 'Debug: Toggle Debug Console', showConsole)
  reg('workbench.view.explorer', 'View: Show Explorer', () => {
    if (sideHidden) toggleSidebar()
    setSide('files')
  })
  reg('workbench.view.extensions', 'View: Show Extensions', () => {
    if (sideHidden) toggleSidebar()
    setSide('ext')
  })
  reg('markdown.showPreviewToSide', 'Preview: Toggle Preview to the Side', togglePreview)
  reg('workbench.action.reloadPreview', 'Preview: Reload', () => $('prevReload').click())
  reg('workbench.action.files.newUntitledFile', 'File: New File', () => createIn(selected && entries.get(selected)?.kind === 'dir' ? selected : dirname(selected ?? '') === '.' ? '' : dirname(selected ?? ''), 'file'))
  reg('workbench.action.files.newProject', 'File: New Project…', () => void newProject({ x: window.innerWidth / 2 - 100, y: 80 }))
  reg('workbench.action.files.openFolder', 'File: Open Project…', openProjectDialog)
  reg('workbench.action.closeFolder', 'File: Close Project', closeProject)
  reg('workbench.action.files.save', 'File: Save', () => save())
  reg('workbench.action.files.saveAll', 'File: Save All', () => saveAll())
  reg('workbench.action.closeActiveEditor', 'View: Close Editor', async () => {
    if (active) await closeTab(active)
    else tiny.window.close()
  })
  reg('workbench.action.closeWindow', 'File: Close Window', () => tiny.window.close())
  reg('workbench.action.closeAllEditors', 'View: Close All Editors', () => closeMany(open.filter((p) => !pins.has(p))))
  reg('workbench.action.closeOtherEditors', 'View: Close Other Editors', () => closeMany(open.filter((p) => p !== active && !pins.has(p))))
  reg('workbench.action.reopenClosedEditor', 'View: Reopen Closed Editor', () => {
    const last = closedStack.pop()
    if (last) return openFile(last)
  })
  reg('workbench.action.nextEditor', 'View: Open Next Editor', () => cycleEditor(1))
  reg('workbench.action.previousEditor', 'View: Open Previous Editor', () => cycleEditor(-1))
  for (let n = 1; n <= 9; n++) reg(`workbench.action.openEditorAtIndex${n}`, `View: Open Editor at Index ${n}`, () => openEditorAt(n), true)
  reg('workbench.action.tasks.build', 'Tasks: Run Build Task', buildShortcut)
  reg('workbench.action.gotoLine', 'Go to Line/Column…', () => editor.run('editor.action.gotoLine'))
  reg('workbench.action.gotoSymbol', 'Go to Symbol in Editor…', () => editor.run('editor.action.quickOutline'))
  reg('editor.action.toggleWordWrap', 'View: Toggle Word Wrap', () => status(editor.toggleWordWrap() ? 'Word wrap: on' : 'Word wrap: off'))
  reg('renameFile', 'Explorer: Rename', () => selected && renamePath(selected), true)
  reg('deleteFile', 'Explorer: Delete', () => selected && deletePath(selected), true)
  reg('extensions.installFromVSIX', 'Extensions: Install from VSIX…', vsx.installVsixDialog)
  reg('extensions.installFromLocation', 'Extensions: Install from Location…', vsx.installFolderDialog)
  reg('extensions.update', 'Extensions: Update Extensions', vsx.updateAll)
  reg('workbench.trust.manage', 'Workspace: Trust This Workspace', vsx.trustWorkspace)
  reg('workbench.trust.restrict', 'Workspace: Use Restricted Mode', vsx.restrictWorkspace)
  reg('share.packageAndInstall', 'Share: Package & Install', () => project && share.packageAndInstall(project))
  reg('share.checkProject', 'Share: Check Project…', () => project && share.checkProject(project))
}

function initKeys(): void {
  keymap = createKeymap(mac(), (shown) => shown && status(shown))
  keymap.set('default', DEFAULT_KEYS)
  registerCommands()
  editor.onWorkbenchKey = (id) => void execute(id)
  document.addEventListener('pointerdown', (e) => void (treeFocus = !!(e.target as HTMLElement).closest('#tree')), true)
  const onKey = (e: KeyboardEvent, inEditor: boolean): void => {
    if (e.isComposing) return
    const chord = chordOf(e)
    // from the editor, the menus run first (the SDK listens before this one does): leave their keys alone
    if (inEditor && chord && menuKeys.has(chord)) return
    const hit = keymap.handle(e, keyContext())
    if (!hit) return
    e.preventDefault()
    e.stopImmediatePropagation() // the SDK must not also run a menu item or hand the key to Desktop (Cmd+W closes the editor, not the window)
    if (hit === 'pending') return
    palette.close()
    void execute(hit.run.command, hit.run.args)
  }
  const inMonaco = (e: Event): boolean => !!(e.target as HTMLElement | null)?.closest?.('.monaco-editor')
  // Outside the editor the keymap goes first, so chords (Cmd+K Cmd+S) and Cmd+W reach it before any menu shortcut does.
  window.addEventListener('keydown', (e) => !inMonaco(e) && onKey(e, false), true)
  // Inside the editor Monaco goes first (its find, fold, multi-cursor...); the keys it does not use come here.
  window.addEventListener('keydown', (e) => inMonaco(e) && onKey(e, true))
}

// ---- sashes: drag to resize the side bar, the output panel and the preview
function sash(el: HTMLElement, cssVar: string, measure: (e: PointerEvent) => number, min: number, max: () => number): void {
  el.addEventListener('pointerdown', (down) => {
    down.preventDefault()
    el.setPointerCapture(down.pointerId)
    el.classList.add('active')
    const move = (e: PointerEvent): void => {
      const v = Math.min(max(), Math.max(min, measure(e)))
      document.documentElement.style.setProperty(cssVar, `${v}px`)
    }
    const up = (): void => {
      el.classList.remove('active')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      editor.layout()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })
}

function initSashes(): void {
  const side = $('side')
  const work = document.querySelector<HTMLElement>('.work')!
  const preview = $('previewPane')
  sash($('sashSide'), '--side-w', (e) => e.clientX - side.getBoundingClientRect().left, 170, () => window.innerWidth * 0.5)
  sash($('sashOutput'), '--panel-h', (e) => work.getBoundingClientRect().bottom - e.clientY, 60, () => work.getBoundingClientRect().height - 120)
  sash($('sashPreview'), '--preview-w', (e) => preview.getBoundingClientRect().right - e.clientX, 260, () => window.innerWidth * 0.7)
}

// ---- boot
void (async () => {
  await tiny.ready
  initLanguages()
  hydrateIcons()
  // the Extensions view's sections (Installed, Commands, Marketplace) fold away with their arrow
  for (const head of document.querySelectorAll<HTMLElement>('#extView .sechead.static')) {
    head.tabIndex = 0
    head.setAttribute('role', 'button')
    head.setAttribute('aria-expanded', 'true')
    const toggle = (): void => {
      const folded = head.classList.toggle('collapsed')
      head.setAttribute('aria-expanded', String(!folded))
      head.querySelector('.chev')!.innerHTML = icon(folded ? 'chevron-right' : 'chevron-down', 16)
    }
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()))
  }
  const savedTheme = await tiny.configGet(CONFIG, 'colorTheme', AUTO)
  syncTheme(applyTheme(typeof savedTheme === 'string' ? savedTheme : AUTO, hostDark()))
  // in "auto" the palette follows Pear's appearance
  tiny.on('theme', () => applyChoice(themeChoice()))
  activateExtensions()
  renderTree()
  initSashes()
  await vsx.init(
    {
      project: () => project,
      log: (line, cls) => extHost.log(line, cls),
      status,
      openDetail: (id) => {
        const tab = EXT_TAB + id
        if (!open.includes(tab)) open.push(tab)
        saveOnLeave(tab)
        active = tab
        showActive()
      },
      changed: () => {
        keymap?.set('extension', vsx.extensionKeybindings())
        if (themeChoice().startsWith('vsx:') && !vsx.setExtensionTheme(themeChoice())) applyChoice(AUTO)
        setMenus()
        if (active) showActive()
      },
    },
    {
      views: { nav: document.querySelector<HTMLElement>('.activitybar')!, side: $('side'), sash: $('sashSide'), explorer: $('vsxExplorer'), select: setSide, isSelected: (id) => id === sideView },
      commands: $('vsxCommands'),
      installed: $('vsxInstalled'), resultsHead: $('vsxResultsHead'), results: $('vsxResults'), count: extCount },
  )
  applyChoice(themeChoice())
  initKeys()
  await loadUserKeybindings()
  keymap.set('extension', vsx.extensionKeybindings())

  $('newproj').addEventListener('click', (e) => void newProject({ x: e.clientX, y: e.clientY }))
  $('openproj').addEventListener('click', () => void openProjectDialog())
  $('welcomeNew').addEventListener('click', (e) => void newProject({ x: e.clientX, y: e.clientY }))
  $('welcomeOpen').addEventListener('click', () => void openProjectDialog())
  saveBtn.addEventListener('click', () => void save())
  $('newfile').addEventListener('click', () => createIn(selected && entries.get(selected)?.kind === 'dir' ? selected : dirname(selected ?? ''), 'file'))
  $('outclose').addEventListener('click', () => (outputEl.hidden = true))
  $('outclear').addEventListener('click', () => (currentPanel === 'console' ? debugConsole.clear() : outLog.replaceChildren()))
  debugConsole.mount({
    log: $('consoleLog'),
    input: $('consoleInput') as HTMLInputElement,
    filter: consoleFilter,
    badge: $('consoleBadge'),
    // the first error after a reload brings the console forward, unless the user is reading something else
    onError: () => {
      if (outputEl.hidden) showConsole()
    },
  })
  panelTabConsole.addEventListener('click', () => selectPanel('console'))
  $('newfolder').addEventListener('click', () => createIn(selected && entries.get(selected)?.kind === 'dir' ? selected : dirname(selected ?? ''), 'folder'))
  $('refreshTree').addEventListener('click', () => void refreshTree())
  $('collapseTree').addEventListener('click', () => {
    expanded = new Set()
    void refreshTree()
  })
  $('emptyNew').addEventListener('click', (e) => void newProject({ x: e.clientX, y: e.clientY }))
  $('emptyOpen').addEventListener('click', () => void openProjectDialog())
  $('themeBtn').addEventListener('click', (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    themeMenu({ x: r.right, y: r.top })
  })
  extSearch.addEventListener('input', () => {
    vsx.setQuery(extSearch.value)
  })
  extSearch.addEventListener('keydown', (e) => e.key === 'Enter' && void vsx.searchRegistry())
  const savedAuto = await tiny.configGet(CONFIG, 'autoSave', 'afterDelay')
  setAutoSave(savedAuto === 'off' || savedAuto === 'onFocusChange' ? savedAuto : 'afterDelay')
  stAuto.addEventListener('click', (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    autoSaveMenu({ x: r.left, y: r.top })
  })
  // leaving the window saves too, when auto save is On Focus Change
  window.addEventListener('blur', () => autoSave === 'onFocusChange' && void saveAll())
  merkleChunk.addEventListener('change', updateSidePreview)
  jsonExpand.addEventListener('click', () => jsonToggleAll(docView, true))
  jsonCollapse.addEventListener('click', () => jsonToggleAll(docView, false))
  $('sideClose').addEventListener('click', () => active && openPreview(active, null))
  panelTabOutput.addEventListener('click', () => selectPanel('output'))
  panelTabProblems.addEventListener('click', () => selectPanel('problems'))
  stProblems.addEventListener('click', showProblems)
  $('stConsole').addEventListener('click', showConsole)
  onProblemsChanged(renderProblems)
  renderProblems()
  selectPanel('output')
  sideToggle.addEventListener('click', () => {
    if (!active) return
    openPreview(active, effectiveKind(active) ? null : defaultKind(active))
  })
  $('zoomIn').addEventListener('click', () => setZoom(Math.min(16, currentScale() * 1.25)))
  $('zoomOut').addEventListener('click', () => setZoom(Math.max(0.05, currentScale() / 1.25)))
  $('zoomFit').addEventListener('click', () => setZoom(null))
  $('zoomActual').addEventListener('click', () => setZoom(1))
  imageStage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom(Math.min(16, Math.max(0.05, currentScale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
  }, { passive: false })
  tabFiles.addEventListener('click', () => void switchSide(true))
  tabExt.addEventListener('click', () => void switchSide(false))

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      buildShortcut()
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      void newProject({ x: 200, y: 40 })
    }
  })

  tiny.window.onCloseRequest(() => {
    if (!editor.allDirty().length) return true
    void tiny.dialogs.confirm('Discard unsaved changes and close?').then((ok) => {
      if (ok) tiny.window.close()
    })
    return false
  })

  tiny.app.onSaveState(() => ({ project }))

    ; (window as unknown as Record<string, unknown>).__main = true
  setMenus()
  // opened with a path (dragged onto the dock, say) or the last project
  const argPath = tiny.app.args.find((a) => typeof a === 'string' && a.startsWith('/') && !a.endsWith('.vsix'))
  // a double-clicked .vsix is an install request, reviewed before anything is written
  for (const a of tiny.app.args) if (typeof a === 'string' && a.startsWith('/') && a.endsWith('.vsix')) void vsx.installVsixAt(a)
  tiny.app.onOpenFile((path) => path.endsWith('.vsix') && void vsx.installVsixAt(path))
  const last = await tiny.configGet(CONFIG, 'lastProject', null)
  const restore = (tiny.app.state as { project?: string | null } | null)?.project
  const target = argPath ?? restore ?? last
  if (target && typeof target === 'string' && (await tiny.exists(target))) await openProject(target)
})()
