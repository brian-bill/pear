// The web extension host (contracts/code-extensions.md): each enabled code extension runs in its
// own Worker, built from a Blob that holds a small `vscode` API plus the extension's bundled
// `browser` entry. The worker has no page access and no syscall surface; everything it can do goes
// through `rpc` calls that this file answers, with a path policy for files and the proxy for fetch.
//
// Supported API: commands, window messages / output channels / status bar messages, workspace.fs,
// Uri, Disposable, EventEmitter, ExtensionContext, and `fetch`. Language-feature providers
// (`vscode.languages.register*`) are accepted and ignored with a note in the output.
import { dirname, tiny } from '@tiny/sdk'
import { API_VERSION } from './vsx'
import { readEntry, storageDir, type Installed } from './vsxstore'

type Level = 'info' | 'warning' | 'error'

export interface HostEnv {
  project(): string | null
  /** Workspace Trust: true once the person trusts the open workspace. */
  trusted(): boolean
  log(extId: string, line: string, cls?: 'err' | 'ok'): void
  notify(extId: string, level: Level, message: string): void
  status(text: string): void
  /** A view was registered or removed by an extension. */
  viewsChanged(): void
  /** An extension asked a view to refresh. */
  treeChanged(view: string): void
}

export interface TreeNode {
  handle: number
  label: string
  description: string
  tooltip: string
  /** 0 none, 1 collapsed, 2 expanded */
  state: number
  hasCommand: boolean
  contextValue: string
  icon?: { theme?: string; path?: string }
}

const PRELUDE = String.raw`
const __info = __INFO__;
const __pending = new Map(); let __seq = 0;
const __rpc = (op, ...args) => new Promise((res, rej) => { const n = ++__seq; __pending.set(n, { res, rej }); postMessage({ t: 'rpc', n, op, args }); });
const __commands = new Map();
class Disposable { constructor(f) { this.f = f } dispose() { const f = this.f; this.f = null; if (f) f() } static from(...d) { return new Disposable(() => d.forEach((x) => x && x.dispose())) } }
class EventEmitter { constructor() { this.l = new Set(); this.event = (fn, thisArg) => { const f = thisArg ? fn.bind(thisArg) : fn; this.l.add(f); return new Disposable(() => this.l.delete(f)) } } fire(e) { for (const f of [...this.l]) { try { f(e) } catch (err) { console.error(err) } } } dispose() { this.l.clear() } }
const __uri = (path) => ({ scheme: 'file', authority: '', path, fsPath: path, query: '', fragment: '', toString() { return 'file://' + path }, with(c) { return __uri(c && c.path !== undefined ? c.path : path) } });
const Uri = {
  file: (p) => __uri(p),
  parse: (s) => __uri(String(s).replace(/^file:\/\//, '')),
  joinPath: (b, ...s) => __uri([b.path.replace(/\/+$/, ''), ...s].join('/').replace(/\/{2,}/g, '/')),
};
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
class ThemeColor { constructor(id) { this.id = id } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color } }
ThemeIcon.File = new ThemeIcon('file'); ThemeIcon.Folder = new ThemeIcon('folder');
class MarkdownString { constructor(v) { this.value = v || '' } appendText(t) { this.value += t; return this } appendMarkdown(t) { this.value += t; return this } }
class TreeItem { constructor(l, s) { if (l && typeof l === 'object' && 'scheme' in l) { this.resourceUri = l; this.label = l.path.split('/').pop() } else this.label = l; this.collapsibleState = s || 0 } }
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const __views = new Map();
const __registerTree = (view, provider) => {
  __views.set(view, { provider, handles: new Map(), next: 1 });
  if (provider.onDidChangeTreeData) provider.onDidChangeTreeData(() => postMessage({ t: 'treeChanged', view }));
  postMessage({ t: 'treeRegistered', view });
  return new Disposable(() => { __views.delete(view); postMessage({ t: 'treeGone', view }) });
};
const __icon = (p) => { if (!p) return undefined; if (p instanceof ThemeIcon) return { theme: p.id }; if (typeof p === 'string') return { path: p }; if (p.path) return { path: p.path }; const x = p.dark || p.light; return x ? { path: typeof x === 'string' ? x : x.path } : undefined };
const __label = (l) => (typeof l === 'string' ? l : (l && l.label) || '');
const __children = async (view, handle) => {
  const v = __views.get(view); if (!v) throw new Error('no such view: ' + view);
  let el; if (handle) { const h = v.handles.get(handle); el = h && h.element } else { v.handles.clear(); v.next = 1 }
  const kids = (await v.provider.getChildren(el)) || [];
  const out = [];
  for (const k of kids) {
    const item = await v.provider.getTreeItem(k); const h = v.next++; v.handles.set(h, { element: k, item });
    const tip = item.tooltip; const d = item.description;
    out.push({ handle: h, label: __label(item.label), description: d === true || d === undefined ? '' : String(d), tooltip: tip ? (typeof tip === 'string' ? tip : tip.value || '') : '', state: item.collapsibleState || 0, hasCommand: !!item.command, contextValue: item.contextValue || '', icon: __icon(item.iconPath) });
  }
  return out;
};
const __ignored = (what) => { postMessage({ t: 'rpc', n: 0, op: 'unsupported', args: [what] }); return new Disposable(() => {}) };
const __lang = new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.startsWith('register') ? () => __ignored('languages.' + k) : () => undefined) });
const __memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { m.set(k, v); return Promise.resolve() }, keys: () => [...m.keys()] } };
const vscode = {
  version: __info.api,
  env: { appName: 'Pear Code', language: 'en', uiKind: 2, machineId: 'pear', sessionId: 'pear', appRoot: '/' },
  Uri, Disposable, EventEmitter, FileType, ThemeColor, ThemeIcon, MarkdownString, TreeItem, TreeItemCollapsibleState,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  commands: {
    registerCommand(id, fn) { __commands.set(id, fn); postMessage({ t: 'registered', id }); return new Disposable(() => __commands.delete(id)) },
    executeCommand(id, ...a) { const fn = __commands.get(id); return fn ? Promise.resolve(fn(...a)) : __rpc('command', id, a) },
    getCommands: () => Promise.resolve([...__commands.keys()]),
  },
  window: {
    showInformationMessage: (m) => { __rpc('message', 'info', String(m)); return Promise.resolve(undefined) },
    showWarningMessage: (m) => { __rpc('message', 'warning', String(m)); return Promise.resolve(undefined) },
    showErrorMessage: (m) => { __rpc('message', 'error', String(m)); return Promise.resolve(undefined) },
    setStatusBarMessage: (t) => { __rpc('status', String(t)); return new Disposable(() => {}) },
    createOutputChannel: (name) => ({ name, append: (s) => __rpc('log', name, String(s), false), appendLine: (s) => __rpc('log', name, String(s), true), replace: (s) => __rpc('log', name, String(s), true), clear() {}, show() {}, hide() {}, dispose() {} }),
    get activeTextEditor() { return undefined }, visibleTextEditors: [],
    registerTreeDataProvider: (view, provider) => __registerTree(view, provider),
    createTreeView: (view, o) => { const d = __registerTree(view, o.treeDataProvider); const ev = () => new EventEmitter().event; return { dispose: () => d.dispose(), reveal: () => Promise.resolve(), visible: true, selection: [], onDidChangeSelection: ev(), onDidChangeVisibility: ev(), onDidExpandElement: ev(), onDidCollapseElement: ev(), title: undefined, description: undefined, message: undefined, badge: undefined } },
    registerWebviewViewProvider: () => __ignored('window.registerWebviewViewProvider'),
    registerWebviewPanelSerializer: () => __ignored('window.registerWebviewPanelSerializer'),
  },
  workspace: {
    get workspaceFolders() { return __info.project ? [{ uri: Uri.file(__info.project), name: __info.project.split('/').pop(), index: 0 }] : undefined },
    getConfiguration: () => ({ get: (_k, d) => d, has: () => false, update: () => Promise.resolve(), inspect: () => undefined }),
    onDidChangeConfiguration: new EventEmitter().event,
    isTrusted: __info.trusted,
    fs: {
      readFile: (u) => __rpc('fs.readFile', u.path),
      writeFile: (u, b) => __rpc('fs.writeFile', u.path, b),
      readDirectory: (u) => __rpc('fs.readDirectory', u.path),
      stat: (u) => __rpc('fs.stat', u.path),
      createDirectory: (u) => __rpc('fs.createDirectory', u.path),
      delete: (u) => __rpc('fs.delete', u.path),
    },
  },
  languages: __lang,
  extensions: { all: [], getExtension: () => undefined },
};
const __require = (name) => { if (name === 'vscode') return vscode; throw new Error("Cannot find module '" + name + "'") };
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const r = await __rpc('fetch', url, init && init.method ? { method: init.method } : {});
  return new Response([101, 204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
};
const __module = { exports: {} };
let __activated = null;
onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'result') { const p = __pending.get(m.n); if (p) { __pending.delete(m.n); m.ok ? p.res(m.value) : p.rej(new Error(m.error)) } }
  else if (m.t === 'activate') {
    try {
      const ctx = { subscriptions: [], extensionPath: __info.dir, extensionUri: Uri.file(__info.dir), globalStoragePath: __info.storage, globalStorageUri: Uri.file(__info.storage), storageUri: undefined, extension: { id: __info.id, extensionPath: __info.dir, packageJSON: __info.manifest }, globalState: __memento(), workspaceState: __memento(), environmentVariableCollection: {} };
      const mod = __module.exports;
      __activated = ctx;
      if (mod && typeof mod.activate === 'function') await mod.activate(ctx);
      postMessage({ t: 'activated' });
    } catch (err) { postMessage({ t: 'failed', error: String((err && err.stack) || err) }) }
  } else if (m.t === 'deactivate') {
    try { const mod = __module.exports; if (mod && typeof mod.deactivate === 'function') await mod.deactivate(); if (__activated) __activated.subscriptions.forEach((d) => { try { d.dispose() } catch {} }) } catch {}
    postMessage({ t: 'deactivated' });
  } else if (m.t === 'tree') {
    try { postMessage({ t: 'treeReply', n: m.n, items: await __children(m.view, m.handle) }) } catch (err) { postMessage({ t: 'treeReply', n: m.n, error: String((err && err.message) || err) }) }
  } else if (m.t === 'treeClick') {
    const v = __views.get(m.view); const h = v && v.handles.get(m.handle);
    if (h && h.item.command) { const fn = __commands.get(h.item.command.command); try { if (fn) await fn(...(h.item.command.arguments || [])) } catch (err) { postMessage({ t: 'failed', error: String((err && err.stack) || err) }) } }
  } else if (m.t === 'command') {
    const fn = __commands.get(m.id);
    try { if (fn) await fn(...(m.args || [])); postMessage({ t: 'ran', id: m.id }) } catch (err) { postMessage({ t: 'failed', error: String((err && err.stack) || err) }) }
  }
};
`

interface Running {
  ext: Installed
  worker: Worker
  url: string
  commands: Set<string>
  ready: Promise<void>
  storage: string
}

const within = (path: string, root: string | null): boolean => {
  if (!root) return false
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  const clean = '/' + parts.join('/')
  const r = root.replace(/\/+$/, '')
  return clean === r || clean.startsWith(r + '/')
}

const MAX_FETCH = 32 * 1024 * 1024

export class ExtensionHost {
  private running = new Map<string, Running>()
  /** view id -> the extension that registered a tree data provider for it */
  private views = new Map<string, string>()
  private waits = new Map<number, { resolve(items: TreeNode[]): void; reject(e: Error): void }>()
  private seq = 0
  /** Extensions that did not start, with the reason (Restricted Mode, failed to load...). */
  readonly skipped = new Map<string, string>()
  constructor(private env: HostEnv) {}

  /** Start every enabled code extension that is allowed to run, stop the rest. */
  async sync(list: Installed[]): Promise<void> {
    const want = new Map(list.filter((e) => e.enabled && e.manifest.browser).map((e) => [e.id, e]))
    for (const [id, r] of [...this.running]) {
      const next = want.get(id)
      if (!next || next.dir !== r.ext.dir || next.version !== r.ext.version) await this.stop(id)
    }
    this.skipped.clear()
    for (const ext of want.values()) {
      if (this.running.has(ext.id)) continue
      const blocked = this.restricted(ext)
      if (blocked) {
        this.skipped.set(ext.id, blocked)
        continue
      }
      const events = ext.manifest.activationEvents ?? []
      if (events.length && events.every((e) => e.startsWith('onCommand:'))) continue // started by its first command
      await this.start(ext)
    }
  }

  /** Why Restricted Mode keeps this extension from running, or null. */
  private restricted(ext: Installed): string | null {
    const support = ext.manifest.capabilities?.untrustedWorkspaces?.supported
    return this.env.trusted() || support === true || support === 'limited' ? null : 'Paused in Restricted Mode: trust this workspace to run it.'
  }

  async start(ext: Installed): Promise<void> {
    if (this.running.has(ext.id)) return this.running.get(ext.id)!.ready
    let source: string
    try {
      source = await readEntry(ext)
    } catch (e) {
      this.skipped.set(ext.id, `Could not read ${ext.manifest.browser}: ${(e as Error).message}`)
      return
    }
    const storage = await storageDir(ext.id)
    const info = { id: ext.id, dir: ext.dir, storage, project: this.env.project(), trusted: this.env.trusted(), api: API_VERSION, manifest: ext.manifest }
    const code = `'use strict';${PRELUDE.replace('__INFO__', () => JSON.stringify(info).replace(/</g, '\\u003c'))}\n(function (module, exports, require) {\n${source}\n})(__module, __module.exports, __require);`
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    const worker = new Worker(url)
    const run: Running = { ext, worker, url, commands: new Set(), storage, ready: Promise.resolve() }
    run.ready = new Promise<void>((resolve) => {
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { t: string; n?: number; op?: string; args?: unknown[]; id?: string; error?: string; view?: string }
        if (m.t === 'rpc') void this.answer(run, m.n!, m.op!, m.args ?? [])
        else if (m.t === 'registered') run.commands.add(m.id!)
        else if (m.t === 'treeRegistered') {
          this.views.set(m.view!, ext.id)
          this.env.viewsChanged()
        } else if (m.t === 'treeGone') {
          this.views.delete(m.view!)
          this.env.viewsChanged()
        } else if (m.t === 'treeChanged') this.env.treeChanged(m.view!)
        else if (m.t === 'treeReply') {
          const r = m as unknown as { n: number; items?: TreeNode[]; error?: string }
          const w = this.waits.get(r.n)
          this.waits.delete(r.n)
          if (r.error) w?.reject(new Error(r.error))
          else w?.resolve(r.items ?? [])
        }
        else if (m.t === 'activated') resolve()
        else if (m.t === 'failed') {
          this.env.log(ext.id, `${ext.id} failed: ${m.error}`, 'err')
          this.skipped.set(ext.id, 'Failed to activate; see Output.')
          resolve()
        }
      }
      worker.onerror = (e) => {
        this.env.log(ext.id, `${ext.id} crashed: ${e.message}`, 'err')
        this.skipped.set(ext.id, 'Crashed; see Output.')
        resolve()
      }
    })
    this.running.set(ext.id, run)
    worker.postMessage({ t: 'activate' })
    await Promise.race([run.ready, new Promise<void>((r) => setTimeout(r, 10_000))])
  }

  async stop(id: string): Promise<void> {
    const r = this.running.get(id)
    if (!r) return
    this.running.delete(id)
    for (const [view, owner] of [...this.views]) if (owner === id) this.views.delete(view)
    this.env.viewsChanged()
    r.worker.postMessage({ t: 'deactivate' })
    await new Promise((res) => setTimeout(res, 50))
    r.worker.terminate()
    URL.revokeObjectURL(r.url)
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stop(id)
  }

  /** Is a tree data provider registered for this view (its extension is running and has set it up)? */
  hasView(view: string): boolean {
    return this.views.has(view)
  }

  /** The children of a tree view node (the root when `handle` is omitted). */
  treeChildren(view: string, handle?: number): Promise<TreeNode[]> {
    const run = this.running.get(this.views.get(view) ?? '')
    if (!run) return Promise.reject(new Error('This view is not available.'))
    const n = ++this.seq
    return new Promise<TreeNode[]>((resolve, reject) => {
      this.waits.set(n, { resolve, reject })
      run.worker.postMessage({ t: 'tree', n, view, handle })
      setTimeout(() => this.waits.delete(n) && reject(new Error('The extension did not answer.')), 15_000)
    })
  }

  /** The person chose a tree item: the extension runs its command. */
  treeClick(view: string, handle: number): void {
    this.running.get(this.views.get(view) ?? '')?.worker.postMessage({ t: 'treeClick', view, handle })
  }

  /** Commands the installed extensions declare (`contributes.commands`), whether or not they are running. */
  commands(list: Installed[]): Array<{ ext: string; command: string; title: string }> {
    return list
      .filter((e) => e.enabled && e.manifest.browser)
      .flatMap((e) => (e.manifest.contributes?.commands ?? []).map((c) => ({ ext: e.id, command: c.command, title: c.title })))
  }

  /** Run a command; an extension that is waiting for its first command is started now. */
  async run(list: Installed[], command: string): Promise<void> {
    let owner = [...this.running.values()].find((r) => r.commands.has(command))
    if (!owner) {
      const ext = list.find((e) => e.enabled && e.manifest.browser && e.manifest.contributes?.commands?.some((c) => c.command === command))
      if (!ext) throw new Error(`No extension provides the command ${command}.`)
      const blocked = this.restricted(ext)
      if (blocked) throw new Error(`${command}: ${blocked}`)
      await this.start(ext)
      owner = this.running.get(ext.id)
    }
    if (!owner) throw new Error(`${command} is unavailable: its extension did not start.`)
    owner.worker.postMessage({ t: 'command', id: command, args: [] })
  }

  private async answer(run: Running, n: number, op: string, args: unknown[]): Promise<void> {
    const id = run.ext.id
    const reply = (ok: boolean, value?: unknown, error?: string): void => {
      if (n) run.worker.postMessage({ t: 'result', n, ok, value, error })
    }
    try {
      reply(true, await this.handle(run, op, args))
    } catch (e) {
      const err = e as { code?: string; message?: string }
      this.env.log(id, `${op}: ${err.message ?? err}`, 'err')
      reply(false, undefined, `${err.code ? err.code + ': ' : ''}${err.message ?? err}`)
    }
  }

  private readable(run: Running, p: string): boolean {
    return within(p, run.storage) || within(p, run.ext.dir) || within(p, this.env.project())
  }

  private writable(run: Running, p: string): boolean {
    return within(p, run.storage) || (this.env.trusted() && within(p, this.env.project()))
  }

  private denied(p: string): Error {
    return Object.assign(new Error(`Access to ${p} is not allowed for extensions.`), { code: 'EACCES' })
  }

  private async handle(run: Running, op: string, args: unknown[]): Promise<unknown> {
    const id = run.ext.id
    const [a, b] = args as [string, unknown]
    switch (op) {
      case 'message':
        this.env.notify(id, a as unknown as Level, String(b))
        return
      case 'status':
        this.env.status(a)
        return
      case 'log':
        this.env.log(id, `[${a}] ${String(b)}`)
        return
      case 'unsupported':
        this.env.log(id, `${id}: ${a} is not supported in this host and was ignored.`)
        return
      case 'command': {
        const target = [...this.running.values()].find((r) => r.commands.has(a))
        if (!target) throw new Error(`command '${a}' not found`)
        target.worker.postMessage({ t: 'command', id: a, args: b })
        return
      }
      case 'fetch': {
        if (!/^https:\/\//i.test(a)) throw Object.assign(new Error('Extensions may only fetch https URLs.'), { code: 'EACCES' })
        const res = await tiny.net.fetch(a, { ...((b as RequestInit) ?? {}), timeout: 30_000 })
        const body = await res.arrayBuffer()
        if (body.byteLength > MAX_FETCH) throw Object.assign(new Error('The response is larger than 32 MB.'), { code: 'ENOSPC' })
        return { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body }
      }
      case 'fs.readFile':
        if (!this.readable(run, a)) throw this.denied(a)
        return tiny.readFile(a)
      case 'fs.readDirectory': {
        if (!this.readable(run, a)) throw this.denied(a)
        const entries = (await tiny.readdir(a)) as Array<{ name: string; kind?: string; type?: string }>
        return entries.map((e) => [e.name, (e.kind ?? e.type) === 'dir' || (e.kind ?? e.type) === 'directory' ? 2 : 1])
      }
      case 'fs.stat': {
        if (!this.readable(run, a)) throw this.denied(a)
        const s = (await tiny.stat(a)) as { kind: string; size?: number; mtime?: number; ctime?: number }
        return { type: s.kind === 'dir' || s.kind === 'directory' ? 2 : 1, size: s.size ?? 0, mtime: s.mtime ?? 0, ctime: s.ctime ?? s.mtime ?? 0 }
      }
      case 'fs.writeFile':
        if (!this.writable(run, a)) throw this.denied(a)
        await tiny.mkdir(dirname(a), { recursive: true })
        return tiny.writeFile(a, b as Uint8Array)
      case 'fs.createDirectory':
        if (!this.writable(run, a)) throw this.denied(a)
        return tiny.mkdir(a, { recursive: true })
      case 'fs.delete':
        if (!this.writable(run, a)) throw this.denied(a)
        return tiny.removeAll(a)
      default:
        throw Object.assign(new Error(`Unknown host call ${op}`), { code: 'ENOSYS' })
    }
  }
}

