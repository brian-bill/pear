/// The Desktop SDK, app side. An app's UI runs in a sandboxed iframe (no network, no access to Vanilla); this module is
/// bundled into the app and talks to Desktop with postMessage. File, settings and service calls run in the app's own
/// process, so Vanilla's permissions apply exactly as for any app.
///
///   import { tiny } from '@tiny/sdk'
///   await tiny.ready
///   const text = new TextDecoder().decode(await tiny.readFile('/Users/pear/Documents/a.txt'))
import type { Pear as ProcessApi } from '../../vanilla/kernel/src/runtime'
import type { AnswerMsg, DesktopToUi, EventMsg, InitMsg, MenuSpec, ThemeInfo, UiToDesktop } from './protocol'
export type { MenuItemSpec, MenuSpec, ThemeInfo } from './protocol'

/** An error with a Vanilla errno name in `code` (`ENOENT`, `EACCES`, `EPERM`...). */
export class SysError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'SysError'
  }
}

/** The file, settings, permission and launch calls of a process (`Pear` in Vanilla), minus process control. */
type Calls = Omit<ProcessApi, 'pid' | 'name' | 'args' | 'stdin' | 'stdout' | 'stderr' | 'exit' | 'onSignal' | 'driverEmit' | 'portCreate' | 'portDestroy' | 'send' | 'receive' | 'register' | 'lookup' | 'watch' | 'unwatch' | 'request'>

export interface ContextItem {
  label?: string
  /** Called when chosen. */
  action?: () => void | Promise<void>
  disabled?: boolean
  separator?: boolean
  checked?: boolean
  shortcut?: string
}

export interface FileFilter {
  name: string
  /** Extensions without dots. */
  ext: string[]
}

export interface PickOptions {
  title?: string
  /** Start in this folder. */
  startIn?: string
  /** Button label (Open, Choose, Save). */
  button?: string
  filters?: FileFilter[]
  multiple?: boolean
}

export interface SaveOptions extends PickOptions {
  /** File name suggested. */
  name?: string
}

export interface AlertOptions {
  title?: string
  message: string
  detail?: string
  buttons?: string[]
  /** Index of the button Enter chooses. */
  defaultButton?: number
  /** Index Escape chooses. */
  cancelButton?: number
  danger?: boolean
}

type Handler = (data: any) => unknown

let nextId = 1
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const handlers = new Map<string, Set<Handler>>()
const contextActions = new Map<string, () => void | Promise<void>>()
const menuActions = new Map<string, () => void | Promise<void>>()
const shortcuts = new Map<string, string>()
let initMsg!: InitMsg
let menus: MenuSpec[] = []
let resolveReady!: (i: InitMsg) => void
const ready = new Promise<InitMsg>((r) => (resolveReady = r))
const parentWin = window.parent

const send = (m: UiToDesktop) => parentWin.postMessage(m, '*')
const call = <T = unknown>(method: string, ...args: unknown[]): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    try {
      send({ t: 'call', id, method, args })
    } catch (e) {
      pending.delete(id)
      reject(new SysError((e as Error).message, 'EINVAL'))
    }
  })

/** Events that arrived before the app registered a handler for them (a file the app was opened with, say): replayed on `on`. */
const early = new Map<string, unknown[]>()
const REPLAY = new Set(['openFile', 'openURL', 'reveal', 'openPane'])
const emit = (name: string, data?: unknown) => {
  if (!handlers.get(name)?.size && REPLAY.has(name)) {
    early.set(name, [...(early.get(name) ?? []), data])
    return
  }
  for (const h of handlers.get(name) ?? []) {
    try {
      void h(data)
    } catch (e) {
      console.error(e)
    }
  }
}

function applyTheme(t: ThemeInfo): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v)
  root.dataset.theme = t.dark ? 'dark' : 'light'
  root.dataset.reduceMotion = String(t.reduceMotion)
  root.style.colorScheme = t.dark ? 'dark' : 'light'
}

window.addEventListener('message', (ev: MessageEvent<DesktopToUi>) => {
  if (ev.source !== parentWin) return
  const m = ev.data
  if (!m || typeof m !== 'object') return
  if (m.t === 'init') {
    initMsg = m
    applyTheme(m.theme)
    resolveReady(m)
    // a window that arrives before init finished still hears about it
    return
  }
  if (m.t === 'reply') {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.result)
    else p.reject(new SysError(m.error?.message ?? 'failed', m.error?.code ?? 'EIO'))
    return
  }
  if (m.t === 'event') return void onEvent(m)
})

async function onEvent(m: EventMsg): Promise<void> {
  let value: unknown
  switch (m.name) {
    case 'theme':
      applyTheme(m.data as ThemeInfo)
      initMsg.theme = m.data as ThemeInfo
      break
    case 'menu': {
      const id = String(m.data)
      const act = menuActions.get(id)
      if (act) await act()
      break
    }
    case 'context': {
      await contextActions.get(String(m.data))?.()
      break
    }
  }
  if (m.reqId !== undefined) {
    // the answer is whatever the first handler returned (save-state, close-request)
    for (const h of handlers.get(m.name) ?? []) {
      try {
        value = await h(m.data)
      } catch (e) {
        console.error(e)
      }
      break
    }
    send({ t: 'answer', reqId: m.reqId, value } satisfies AnswerMsg)
  } else emit(m.name, m.data)
}

// Desktop needs to know about clicks (to focus this window) and shortcuts it owns (Cmd+W...).
addEventListener('pointerdown', () => send({ t: 'note', kind: 'pointer' }), true)
addEventListener('focus', () => send({ t: 'note', kind: 'focus' }))
const norm = (e: KeyboardEvent) => {
  const parts: string[] = []
  if (e.metaKey) parts.push('Cmd')
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) parts.push(k)
  return parts.join('+')
}
addEventListener('keydown', (e) => {
  const combo = norm(e)
  const id = shortcuts.get(combo)
  if (id) {
    e.preventDefault()
    void menuActions.get(id)?.()
    return
  }
  // Keys that belong to Desktop (window shortcuts, the launcher, Mission Control): a focused iframe would swallow them
  const desktopKey = e.metaKey || (e.altKey && (e.key === 'Tab' || e.code === 'Space')) || (e.ctrlKey && e.key === 'ArrowUp') || e.key === 'F3'
  if (desktopKey) {
    // the browser must not also act on them
    if (e.altKey || e.key === 'F3' || e.key === 'ArrowUp' || ['w', 'm', '`', 'q'].includes(e.key.toLowerCase())) e.preventDefault()
    send({ t: 'note', kind: 'key', data: { key: e.key, code: e.code, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey } })
  }
})

const on = (name: string, fn: Handler): (() => void) => {
  const set = handlers.get(name) ?? new Set()
  set.add(fn)
  handlers.set(name, set)
  for (const data of early.get(name)?.splice(0) ?? []) queueMicrotask(() => void fn(data))
  return () => void set.delete(fn)
}

/** Menu items given as functions: ids are made here, Desktop only ever sees plain data. */
export interface MenuDef {
  title: string
  items: Array<{ label?: string; shortcut?: string; action?: () => void | Promise<void>; disabled?: boolean; checked?: boolean; separator?: boolean }>
}

const windowApi = {
  get id() { return initMsg.windowId },
  setTitle: (title: string) => call<void>('window.setTitle', title),
  /** Menus of this app while this window has focus. The first menu is the app menu. Replaces the previous set. */
  setMenus(defs: MenuDef[]): Promise<void> {
    menuActions.clear()
    shortcuts.clear()
    let n = 0
    menus = defs.map((d) => ({
      title: d.title,
      items: d.items.map((i) => {
        if (i.separator) return { separator: true }
        const id = `m${n++}`
        if (i.action) menuActions.set(id, i.action)
        if (i.shortcut) shortcuts.set(i.shortcut.replace(/⌘/g, 'Cmd+').replace(/\+\+/g, '+'), id)
        return { id, label: i.label, shortcut: i.shortcut, disabled: i.disabled, checked: i.checked }
      }),
    }))
    return call<void>('window.setMenus', menus)
  },
  close: () => call<void>('window.close'),
  minimize: () => call<void>('window.minimize'),
  toggleMaximize: () => call<void>('window.toggleMaximize'),
  focus: () => call<void>('window.focus'),
  resize: (width: number, height: number) => call<void>('window.resize', width, height),
  /** Show a dot in the close button and ask before closing, like a document with unsaved changes. */
  setEdited: (edited: boolean) => call<void>('window.setEdited', edited),
  /** Runs when the user closes the window: return `false` to keep it open (after asking the user, say). */
  onCloseRequest: (fn: () => boolean | void | Promise<boolean | void>) => on('close-request', fn),
  /** Windows of this app. */
  list: () => call<Array<{ id: number; title: string }>>('window.list'),
}

const appApi = {
  get id() { return initMsg.appId },
  get name() { return initMsg.appName },
  /** What the app was launched with: file paths or URLs. */
  get args() { return initMsg.args },
  /** What this window saved with `onSaveState` last time (or was opened with). */
  get state() { return initMsg.state },
  /** Called when a file is opened with this app (Finder double-click, drop on the dock, `open`). */
  onOpenFile: (fn: (path: string) => void) => on('openFile', fn),
  onOpenURL: (fn: (url: string) => void) => on('openURL', fn),
  /** Return what should be put back when the session is restored. Called often; keep it small and JSON-safe. */
  onSaveState: (fn: () => unknown) => on('save-state', fn),
  /** Open another window of this app. `state` becomes `tiny.app.state` there. */
  openWindow: (state?: unknown) => call<number>('app.openWindow', state),
  /** Tell Desktop this window's state changed, so the session is saved soon (a draft was typed, say). */
  stateChanged: () => call<void>('app.stateChanged'),
  /** Close every window and end the process. */
  quit: () => call<void>('app.quit'),
}

const dialogs = {
  alert: (o: AlertOptions | string) => call<number>('dialogs.alert', typeof o === 'string' ? { message: o } : o),
  /** Resolves `true` if the user chose the first button. */
  confirm: async (message: string, o: Partial<AlertOptions> = {}) => (await call<number>('dialogs.alert', { buttons: ['OK', 'Cancel'], cancelButton: 1, ...o, message })) === 0,
  prompt: (message: string, o: { value?: string; title?: string; placeholder?: string; button?: string; select?: [number, number] } = {}) => call<string | null>('dialogs.prompt', { message, ...o }),
  /** The Open panel. The app may use what was picked for as long as it runs. Resolves paths, or `null` if cancelled. */
  openFile: (o: PickOptions = {}) => call<string[] | null>('dialogs.open', { ...o, directory: false }),
  openFolder: (o: PickOptions = {}) => call<string[] | null>('dialogs.open', { ...o, directory: true }),
  saveFile: (o: SaveOptions = {}) => call<string | null>('dialogs.save', o),
}

const host = {
  /** Choose files on the real computer and copy them into `dest` (a folder). Resolves the new paths. */
  importFiles: (dest: string, o: { directory?: boolean } = {}) => call<string[]>('host.import', dest, o),
  /** Download a file (or a folder, as a zip) to the real computer. */
  exportPath: (path: string, o: { saveAs?: boolean } = {}) => call<void>('host.export', path, o),
}

const shell = {
  /** Open a path, URL or app id with the default app (like double-clicking). */
  open: (target: string, o: { app?: string } = {}) => call<void>('shell.open', target, o),
  /** Show a file in a Finder window. */
  reveal: (path: string) => call<void>('shell.reveal', path),
  openApp: (appId: string) => call<void>('shell.openApp', appId),
  /** Installed apps (for Open With, the Dock, Launchpad). */
  apps: () => call<Array<{ id: string; name: string; icon: string | null; kind: string }>>('shell.apps'),
  /** The icon for a bundle id, path or type, as an SVG/PNG data URL Desktop picked. */
  icon: (target: string) => call<{ name: string; url: string | null; description: string }>('shell.icon', target),
  /** A menu at the pointer. Resolves when it closes. */
  async contextMenu(items: ContextItem[], at: { x: number; y: number }): Promise<void> {
    contextActions.clear()
    let n = 0
    const spec = items.map((i) => {
      if (i.separator) return { separator: true }
      const id = `c${n++}`
      if (i.action) contextActions.set(id, i.action)
      return { id, label: i.label, disabled: i.disabled, checked: i.checked, shortcut: i.shortcut }
    })
    await call<void>('shell.contextMenu', spec, at)
  },
  notify: (title: string, body = '') => call<number>('shell.notify', title, body),
}

/**
 * System administration, for the apps that manage the system (Settings, Activity Monitor, Console, Finder). Desktop
 * refuses it to every other app. Calls run as the system, so these apps can do what an ordinary app cannot: change any
 * setting, grant permissions, see every process, read the whole log.
 */
const admin = {
  /** A Vanilla kernel call: `permList`, `permGrant`, `configSet`, `listProcesses`, `kill`, `logQuery`, `crashList`, `diagSnapshot`, `imageCreate`... */
  kernel: <T = unknown>(method: string, ...args: unknown[]) => call<T>('admin.kernel', method, ...args),
  /** A request to any `tiny.*` system service as the system itself (network rules, search index, session...). */
  service: <T = unknown>(name: string, msg: Record<string, unknown>, timeout?: number) => call<T>('admin.service', name, msg, timeout),
}

const system = {
  /** `tiny.system` requests: version, hardware, storage, locale... */
  info: (op: string, args: Record<string, unknown> = {}) => service<any>('tiny.system', { op, ...args }),
}

/** Call a Vanilla system service (`tiny.search`, `tiny.settings`, `tiny.network`...) as this app. */
function service<T = unknown>(name: string, msg: Record<string, unknown>, timeout?: number): Promise<T> {
  return call<T>('service', name, msg, timeout)
}

const extras = {
  ready,
  window: windowApi,
  app: appApi,
  dialogs,
  host,
  shell,
  admin,
  system,
  service,
  on,
  /** The current theme. Also arrives as a `theme` event. */
  get theme(): ThemeInfo { return initMsg.theme },
  get locale(): string { return initMsg.locale },
  get platform(): string { return initMsg.platform },
}

/** Everything that is not part of the SDK itself is a call into the app's process. */
export const tiny = new Proxy({} as Calls, {
  // `then` keeps `await tiny` honest; `toJSON` keeps JSON.stringify of a value holding `tiny` from making a call
  get: (_, name: string | symbol) => (name === 'then' || name === 'toJSON' ? undefined : typeof name === 'string' && name in extras ? Reflect.get(extras, name) : (...args: unknown[]) => call(`kernel.${String(name)}`, ...args)),
}) as Calls & {
  ready: Promise<InitMsg>
  window: typeof windowApi
  app: typeof appApi
  dialogs: typeof dialogs
  host: typeof host
  shell: typeof shell
  admin: typeof admin
  system: typeof system
  service: typeof service
  on: typeof on
  theme: ThemeInfo
  locale: string
  platform: string
}

send({ t: 'note', kind: 'ready' })

// ---- small helpers apps tend to need

/** Make an element from HTML. */
export function html<T extends HTMLElement = HTMLElement>(strings: TemplateStringsArray, ...values: unknown[]): T {
  const t = document.createElement('template')
  t.innerHTML = strings.reduce((a, s, i) => a + s + (i < values.length ? escapeHtml(String(values[i])) : ''), '').trim()
  return t.content.firstElementChild as T
}
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const dirname = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const joinPath = (a: string, b: string) => (a.endsWith('/') ? a + b : `${a}/${b}`)
export const formatBytes = (n: number) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(1)} GB`)
export const textOf = (b: Uint8Array) => new TextDecoder().decode(b)
export const bytesOf = (s: string) => new TextEncoder().encode(s)
