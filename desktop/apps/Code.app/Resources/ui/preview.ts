// The Preview extension — installed by default. It renders the project's UI page in a sandboxed
// pane next to the editor, the way Desktop serves real app windows: styles, scripts and images
// inlined into one document. A tiny shim gives the previewed app the SDK's `tiny` API, served by
// Code with its own permissions. It is persistent: it follows whichever file is being edited, builds
// from the editor's buffers (unsaved edits included) and rebuilds as you type, on save, or on demand.
import { escapeHtml, joinPath, tiny } from '@tiny/sdk'
import type { ExtActions, ExtHost, ExtensionDef } from './extension'
import { add as consoleAdd, clear as clearConsole, separator as consoleSeparator, setEvaluator, type EvalReply, type Level, type Ser } from './debugconsole'
import { previewShim } from './shim'

const SHIM = `(${previewShim})();`

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const pane = $('previewPane')
const frame = $<HTMLIFrameElement>('prevFrame')
const titleEl = $('prevTitle')
const modeEl = $<HTMLSelectElement>('prevMode')
const stampEl = $('prevStamp')
const CONFIG = 'org.tiny.code'
const enc = new TextEncoder()

type Mode = 'type' | 'save' | 'manual'
const mode = (): Mode => modeEl.value as Mode

/** Files read from disk for earlier builds, so typing does not re-read the whole project each time. */
const diskCache = new Map<string, Uint8Array>()

let host: ExtHost | null = null
let wired = false

/** What the running page hands over before a rebuild (shim.ts `snapshot`). Opaque to Code. */
type Snapshot = object

// ---- talking to the running page
let frameReady = false
let nextReq = 1
const waiters = new Map<number, (m: PreviewMsg) => void>()

/** Send a request to the page and wait for its answer; null if it does not answer in time. */
function ask(msg: object, timeout = 600): Promise<PreviewMsg | null> {
  return new Promise((resolve) => {
    const win = frame.contentWindow
    if (!win || !frameReady) return resolve(null)
    const id = nextReq++
    const timer = setTimeout(() => {
      waiters.delete(id)
      resolve(null)
    }, timeout)
    waiters.set(id, (m) => {
      clearTimeout(timer)
      waiters.delete(id)
      resolve(m)
    })
    win.postMessage({ ...msg, id }, '*')
  })
}

// the console prompt evaluates in the running app
setEvaluator(async (code): Promise<EvalReply | null> => {
  const reply = await ask({ t: 'peval', code }, 30_000)
  return reply?.value ? { ok: reply.ok === true, value: reply.value } : null
})

// ---- the preview's RPC host: serve `tiny` calls from the shim, as Code

type PreviewMsg = {
  t: 'pcall' | 'pcon' | 'pready' | 'preplyx'
  where?: string
  snap?: Snapshot
  ok?: boolean
  value?: Ser
  id?: number
  method?: string
  args?: unknown[]
  level?: string
}

const isSysError = (e: unknown): e is { code: string; message: string } =>
  e instanceof Error && typeof (e as { code?: unknown }).code === 'string'

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== frame.contentWindow || !host) return
  const m = ev.data as PreviewMsg
  if (!m || typeof m !== 'object') return
  if (m.t === 'pready') {
    frameReady = true
    return
  }
  if (m.t === 'preplyx') {
    waiters.get(m.id!)?.(m)
    return
  }
  if (m.t === 'pcon') {
    if ((m.level as string) === 'clear') clearConsole()
    else consoleAdd((m.level ?? 'log') as Level, (m.args ?? []) as Ser[], m.where)
    return
  }
  if (m.t !== 'pcall' || typeof m.method !== 'string') return
  void serve(m.method, m.args ?? []).then(
    (result) => frame.contentWindow?.postMessage({ t: 'preply', id: m.id, ok: true, result }, '*'),
    (e) => {
      const err = isSysError(e) ? { code: e.code, message: e.message } : { code: 'EIO', message: String(e) }
      frame.contentWindow?.postMessage({ t: 'preply', id: m.id, ok: false, error: err }, '*')
    },
  )
})

async function serve(method: string, args: unknown[]): Promise<unknown> {
  if (!host) throw new Error('no host')
  if (method === 'preview.init') return { theme: tiny.theme }
  if (method === 'preview.title') {
    titleEl.textContent = args[0] ? `${args[0]} — Preview` : 'Preview'
    return null
  }
  // relative paths in the previewed app resolve against the project root (the previewed app has no
  // working directory of its own)
  const FILE_METHODS = new Set(['readFile', 'writeFile', 'writeFileAtomic', 'readdir', 'stat', 'lstat', 'exists', 'mkdir', 'rmdir', 'unlink', 'removeAll', 'rename', 'copy', 'trash', 'realpath'])
  const project = host.project()
  if (project && FILE_METHODS.has(method.replace(/^tiny\./, ''))) {
    args = args.map((a, i) => (i === 0 && typeof a === 'string' && a.length > 0 && !a.startsWith('/') && !/^[a-z]+:/.test(a) ? joinPath(project, a) : a))
  }
  if (method.startsWith('dialogs.')) {
    const fn = (tiny.dialogs as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method.slice(8)]
    if (fn) return fn(...args)
  }
  if (method === 'service') return tiny.service(args[0] as string, (args[1] as Record<string, unknown>) ?? {})
  if (method === 'shell.open') return tiny.shell.open(args[0] as string, args[1] as object)
  if (method === 'shell.reveal') return tiny.shell.reveal(args[0] as string)
  if (method === 'shell.notify') return tiny.shell.notify(args[0] as string, args[1] as string)
  if (method === 'shell.openApp') return tiny.shell.openApp(args[0] as string)
  if (method === 'shell.apps') return tiny.shell.apps()
  if (method === 'host.importFiles') return tiny.host.importFiles(args[0] as string, args[1] as object)
  if (method === 'host.exportPath') return tiny.host.exportPath(args[0] as string, args[1] as object)
  if (method.startsWith('tiny.')) {
    const name = method.slice(5)
    // file access in the preview runs as Code: the previewed app borrows Code's permissions,
    // which are fs.user — the same grant the built apps' templates ask for
    if (['readFile', 'writeFile', 'writeFileAtomic', 'readdir', 'stat', 'lstat', 'exists', 'mkdir', 'rmdir', 'unlink', 'removeAll', 'rename', 'copy', 'trash', 'realpath', 'launchOpen', 'launchApps', 'launchAppsFor', 'getenv', 'permCheck', 'bundleList', 'bundleInfo'].includes(name)) {
      const fn = (tiny as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]
      if (typeof fn === 'function') return fn.apply(tiny, args)
    }
  }
  throw Object.assign(new Error(`${method} is not available in the preview`), { code: 'EPERM' })
}

// ---- assembling the preview document

const MAX_FILE = 5 * 1024 * 1024
const dec = new TextDecoder()

interface Project {
  root: string
  dir: string // the ui directory, e.g. <root>/Resources/ui
  files: Map<string, Uint8Array> // by project-relative path
}

/** A project file as the editor has it (unsaved edits win), else from disk (cached between typing rebuilds). */
async function readFile(rel: string): Promise<Uint8Array | null> {
  const buffer = host!.buffer(rel)
  if (buffer !== null) return enc.encode(buffer)
  const cached = diskCache.get(rel)
  if (cached) return cached
  const bytes = await host!.readProjectFile(rel)
  if (bytes) diskCache.set(rel, bytes)
  return bytes
}

async function loadProject(root: string): Promise<Project | null> {
  const manifestBytes = await readFile('manifest.json')
  if (!manifestBytes) return null
  let ui = 'Resources/ui/index.html'
  try {
    const manifest = JSON.parse(dec.decode(manifestBytes)) as { ui?: string }
    if (manifest.ui) ui = manifest.ui
  } catch {
    host!.log('manifest.json could not be parsed; previewing the default page', 'err')
  }
  const files = new Map<string, Uint8Array>()
  await walk(root, '', files)
  return { root, dir: joinPath(root, ui.slice(0, ui.lastIndexOf('/'))), files }
}

async function walk(root: string, rel: string, into: Map<string, Uint8Array>): Promise<void> {
  const dir = rel ? `${root}/${rel}` : root
  for (const e of await tiny.readdir(dir)) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.kind === 'dir') await walk(root, child, into)
    else {
      const bytes = await readFile(child)
      if (bytes && bytes.length <= MAX_FILE) into.set(child, bytes)
    }
  }
}

/** Resolve an href relative to the page's directory to a project-relative path. */
const resolveRel = (dir: string, href: string): string => {
  const parts = (href.startsWith('/') ? href.slice(1) : (dir ? `${dir}/` : '') + href).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

const textOf = (p: Project, rel: string): string | null => {
  const b = p.files.get(rel)
  return b ? dec.decode(b) : null
}

const dataUrl = (bytes: Uint8Array, rel: string): string => {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp' }
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return `data:${mime[ext] ?? 'application/octet-stream'};base64,${btoa(s)}`
}

const safeScript = (t: string): string => t.replace(/<\/script/gi, '<\\/script')

/**
 * Turn an ES module into a `__pearDefine` registration: imports become requires, exports become
 * assignments. Deliberately naive — relative imports of `.js` files, no cycles, no re-exports.
 */
function transformModule(p: Project, rel: string, done: Set<string>, register: (name: string, body: string) => void): void {
  if (done.has(rel)) return
  done.add(rel)
  let text = textOf(p, rel)
  if (text === null) {
    host?.log(`preview: module '${rel}' is missing`, 'err')
    text = ''
  }
  const dir = rel.slice(0, rel.lastIndexOf('/'))
  const requireFor = (spec: string): string => {
    if (!/^[./]/.test(spec)) {
      host?.log(`preview: '${rel}' imports '${spec}' — only relative imports are bundled`, 'err')
      return `__pearRequire('${spec}')`
    }
    const target = resolveRel(dir, spec)
    if (!p.files.has(target)) {
      host?.log(`preview: '${rel}' imports '${spec}' — no such file`, 'err')
      return `__pearRequire('${target}')`
    }
    transformModule(p, target, done, register)
    return `__pearRequire('${target}')`
  }
  // import <clause> from '<spec>' / import '<spec>'
  text = text.replace(/(^|\n)[ \t]*import\s*(?:([^\n;'"]*?)\s*from\s*)?['"]([^'"]+)['"][ \t]*;?/g, (_, nl: string, clause: string | undefined, spec: string) => {
    const req = requireFor(spec)
    if (!clause?.trim()) return `${nl}`
    const m = clause.trim().match(/^(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?$/)
    if (!m) return `${nl}/* preview: could not rewrite import of '${spec}' */`
    const lines: string[] = []
    if (m[1]) lines.push(`const { default: ${m[1]} } = ${req}`)
    if (m[2] !== undefined) {
      const names = m[2].split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ':'))
      if (names.length) lines.push(`const { ${names.join(', ')} } = ${req}`)
    }
    if (m[3]) lines.push(`const ${m[3]} = __pearInterop(${req})`)
    return `${nl}${lines.join('\n')}`
  })
  const namedExports: string[] = []
  // export { a, b as c }
  text = text.replace(/(^|\n)[ \t]*export\s*\{([^}]*)\}[ \t]*;?/g, (_, nl: string, list: string) => {
    for (const item of list.split(',')) {
      const s = item.trim()
      if (!s) continue
      const as = s.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
      if (as) namedExports.push(`${as[2] ?? as[1]}: ${as[1]}`)
      else host?.log(`preview: could not rewrite export '${s}' in '${rel}'`, 'err')
    }
    return nl
  })
  // export const/let/var <name> — names are collected and assigned at the end of the module
  // (one declarator per statement; destructuring exports are not rewritten)
  text = text.replace(/(^|\n)[ \t]*export\s+(?:const|let|var)\s+([\w$]+)/g, (_, nl: string, name: string) => {
    namedExports.push(`${name}: ${name}`)
    return nl
  })
  text = text.replace(/(^|\n)[ \t]*export\s+(async\s+function|function|class)\s+([\w$]+)/g, (_, nl: string, kw: string, name: string) => {
    namedExports.push(`${name}: ${name}`)
    return `${nl}${kw} ${name}`
  })
  // export default <expr>
  text = text.replace(/(^|\n)[ \t]*export\s+default\s+/g, '$1exports.default = ')
  const tail = namedExports.length ? `\nObject.assign(exports, { ${namedExports.join(', ')} })\n` : ''
  register(rel, `${text}${tail}`)
}

/** Stylesheets inlined into the last built page (project-relative), so a CSS edit can be swapped in place. */
let cssSources = new Set<string>()

async function buildDoc(project: string, snap: Snapshot | null): Promise<string> {
  cssSources = new Set()
  const p = await loadProject(project)
  if (!p) return `<body style="font:13px system-ui;padding:20px">This project has no <b>manifest.json</b> yet.</body>`
  const uiRel = ((): string => {
    try {
      const m = JSON.parse(dec.decode(p.files.get('manifest.json')!)) as { ui?: string }
      return m.ui ?? 'Resources/ui/index.html'
    } catch {
      return 'Resources/ui/index.html'
    }
  })()
  const html = textOf(p, uiRel)
  if (html === null) return `<body style="font:13px system-ui;padding:20px">The page <b>${escapeHtml(uiRel)}</b> does not exist.</body>`
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageDir = uiRel.slice(0, uiRel.lastIndexOf('/'))

  for (const link of [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')]) {
    const style = doc.createElement('style')
    const rel = resolveRel(pageDir, link.getAttribute('href')!)
    style.textContent = textOf(p, rel) ?? `/* missing ${link.getAttribute('href')} */`
    style.setAttribute('data-pear-src', rel)
    cssSources.add(rel)
    link.replaceWith(style)
  }
  const entries: string[] = []
  let entry: string | null = null
  const register = (name: string, body: string) => {
    entries.push(`__pearDefine('${name}', function (exports) {\n${safeScript(body)}\n})`)
  }
  for (const script of [...doc.querySelectorAll<HTMLScriptElement>('script[src]')]) {
    const src = script.getAttribute('src')!
    const rel = resolveRel(pageDir, src)
    const isModule = script.getAttribute('type') === 'module' || /\.mjs$/.test(src)
    if (isModule) {
      // the page's first module is the entry point; the rest are required by it or by each other
      entry ??= rel
      transformModule(p, rel, new Set(), register)
      script.remove()
    } else {
      const text = textOf(p, rel)
      if (text === null) {
        host?.log(`preview: script '${src}' is missing`, 'err')
        script.remove()
        continue
      }
      const inline = doc.createElement('script')
      inline.textContent = safeScript(text)
      script.replaceWith(inline)
    }
  }
  for (const img of [...doc.querySelectorAll<HTMLImageElement>('img[src]')]) {
    const src = img.getAttribute('src')!
    if (/^(data:|blob:)/.test(src)) continue
    const bytes = p.files.get(resolveRel(pageDir, src))
    if (bytes) img.setAttribute('src', dataUrl(bytes, src))
    else img.removeAttribute('src')
  }
  // the shim first (it defines `tiny` and the module registry), then modules, then the entry point
  const prelude = doc.createElement('script')
  prelude.textContent = (snap ? `window.__pearRestore=${JSON.stringify(snap).replace(/</g, '\\u003c')};` : '') + SHIM
  doc.head.prepend(prelude)
  if (entries.length && entry) {
    const mods = doc.createElement('script')
    mods.textContent = safeScript(entries.join('\n'))
    const bootstrap = doc.createElement('script')
    bootstrap.textContent = `try {\n  __pearRequire('${entry}')\n} catch (e) { console.error(e && e.message) }`
    doc.body.append(mods, bootstrap)
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

let building = false
let again = false
/** Files edited since the last build, so a stylesheet-only change can skip the rebuild. */
const edited = new Set<string>()

/**
 * Bring the preview up to date. `fresh` starts the page from scratch (the Reload button); otherwise
 * the running page is kept as it was: a stylesheet-only edit is swapped in without a reload, and
 * any other edit rebuilds the page and puts back its state (form fields, scroll, storage and the
 * app's own `onSaveState` data).
 */
async function rebuild(fresh = false): Promise<void> {
  if (fresh) {
    diskCache.clear()
    edited.clear()
  }
  const project = host?.project()
  if (!project || pane.hidden) return
  // builds never overlap: edits that arrive meanwhile trigger one more build when this one ends
  if (building) {
    again = true
    return
  }
  building = true
  try {
    do {
      again = false
      const files = [...edited]
      edited.clear()
      if (!fresh && frameReady && files.length && files.every((f) => cssSources.has(f))) {
        const css: Record<string, string> = {}
        for (const f of files) css[f] = dec.decode((await readFile(f)) ?? new Uint8Array())
        frame.contentWindow?.postMessage({ t: 'pcss', files: css }, '*')
        stamp()
        continue
      }
      const snap = fresh ? null : (await ask({ t: 'psnap' }))?.snap ?? null
      const html = await buildDoc(project, snap)
      frameReady = false
      frame.srcdoc = html
      consoleSeparator(fresh ? 'Preview restarted' : 'Preview reloaded')
      stamp()
    } while (again)
  } finally {
    building = false
  }
}

const stamp = (): void => {
  stampEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function setVisible(visible: boolean, remember = true): void {
  pane.hidden = !visible
  if (remember) void tiny.configSet(CONFIG, 'previewOpen', visible)
  if (visible) void rebuild(true)
}

/** View → Toggle Preview. The preview stays where it is across tabs and files until it is closed. */
export function togglePreview(): void {
  if (host?.project()) setVisible(pane.hidden)
}

export const previewExtension: ExtensionDef = {
  id: 'org.pear.code.preview',
  name: 'Preview',
  description: 'Run the project next to the editor and refresh it on every save. Serves the project like a real app window: styles, scripts and wasm inlined.',
  tag: 'built-in',
  installedByDefault: true,
  activate(h) {
    host = h
    // listeners are installed once; re-activation (after a disable/enable) only re-wires the toolbar
    if (!wired) {
      wired = true
      window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r' && !e.shiftKey) {
          e.preventDefault()
          void rebuild(true)
        }
      })
      $('prevReload').addEventListener('click', () => void rebuild(true))
      $('prevClose').addEventListener('click', () => setVisible(false))
      modeEl.addEventListener('change', () => {
        void tiny.configSet(CONFIG, 'previewMode', mode())
        if (mode() !== 'manual') void rebuild()
      })
      void tiny.configGet(CONFIG, 'previewMode', 'type').then((m) => {
        if (m === 'type' || m === 'save' || m === 'manual') modeEl.value = m
      })
    }
    const actions: ExtActions = {
      toolbar: [
        {
          id: 'run',
          label: 'Preview',
          icon: 'play',
          title: 'Show the live preview (Cmd+Shift+V)',
          primary: true,
          visible: () => !!h.project(),
          run: () => {
            h.status('Preview: building…')
            setVisible(true)
          },
        },
      ],
      async onDidOpenProject() {
        // the preview was open last time: it comes back with the project
        const wasOpen = await tiny.configGet(CONFIG, 'previewOpen', false)
        if (wasOpen === true) setVisible(true, false)
        else if (!pane.hidden) void rebuild(true)
      },
      onDidChangeFile(rel) {
        edited.add(rel)
        if (!pane.hidden && mode() === 'type') void rebuild()
      },
      onDidSaveProject(rel) {
        diskCache.delete(rel) // what was on disk before is stale now
        if (!pane.hidden && mode() === 'save') {
          h.status('Preview: rebuilding…')
          void rebuild()
        }
      },
      onDidCloseProject() {
        pane.hidden = true // the project is gone; whether the preview was open is remembered
        frame.srcdoc = ''
        stampEl.textContent = ''
        titleEl.textContent = 'Preview'
        diskCache.clear()
      },
    }
    return actions
  },
}
