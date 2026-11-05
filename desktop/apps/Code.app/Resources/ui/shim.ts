/**
 * The shim that runs at the top of every preview document, inside the preview iframe. It is a
 * self-contained function: Code injects its compiled source as the preview's first script. It
 * gives the previewed app a `tiny` object with the same shape as the SDK — backed by a small
 * message channel to Code, which serves calls with its own SDK identity and permissions.
 */
export function previewShim(): void {
  if ('tiny' in window) return
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error & { code?: string }) => void }>()
  const handlers = new Map<string, Set<(data?: unknown) => unknown>>()
  type Reply = { t: 'preply'; id: number; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  const parent = window.parent

  const send = (m: unknown) => parent.postMessage(m, '*')
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      send({ t: 'pcall', id, method, args })
    })

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== parent) return
    const m = ev.data as Reply
    if (!m || typeof m !== 'object' || m.t !== 'preply') return
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.result)
    else p.reject(Object.assign(new Error(m.error?.message ?? 'preview call failed'), { code: m.error?.code ?? 'EIO' }))
  })

  const KERNEL = new Set(['readFile', 'writeFile', 'writeFileAtomic', 'readdir', 'stat', 'lstat', 'exists', 'mkdir', 'rmdir', 'unlink', 'removeAll', 'rename', 'copy', 'trash', 'realpath', 'launchOpen', 'launchApps', 'launchAppsFor', 'getenv', 'permCheck', 'bundleList', 'bundleInfo'])

  const handlersFor = (name: string): Set<(data?: unknown) => unknown> => {
    const set = handlers.get(name) ?? new Set()
    handlers.set(name, set)
    return set
  }
  const on = (name: string, fn: (data?: unknown) => unknown): (() => void) => {
    handlersFor(name).add(fn)
    return () => void handlersFor(name).delete(fn)
  }
  const emit = (name: string, data?: unknown) => {
    for (const h of handlers.get(name) ?? []) {
      try {
        void h(data)
      } catch (e) {
        console.error(e)
      }
    }
  }

  // What the previous build of this page left behind (see "state that survives a rebuild" below).
  const w = window as unknown as Record<string, unknown>
  type Snap = {
    state?: unknown
    local?: Record<string, string>
    session?: Record<string, string>
    dom?: {
      fields: Array<{ key: string; value: string; checked: boolean }>
      scrolls: Array<{ key: string; top: number; left: number }>
      doc: { x: number; y: number }
      focus: { key: string; start: number | null; end: number | null } | null
      open: Array<{ key: string; open: boolean }>
    }
  }
  const restore = (w.__pearRestore ?? null) as Snap | null
  const saveHandlers = new Set<() => unknown>()

  let theme: unknown = null
  const notInPreview = (name: string) => async () => {
    throw Object.assign(new Error(`${name} is not available in the preview`), { name: 'SysError', code: 'EPERM' })
  }


  type NetReply = { status: number; statusText: string; headers: Record<string, string> | Array<[string, string]>; url: string; redirected: boolean; body: Uint8Array }
  const netInit = async (init?: RequestInit & { proxy?: string; timeout?: number }): Promise<Record<string, unknown> | undefined> => {
    if (!init) return undefined
    const { body, headers, proxy: _p, timeout: _t, signal: _s, ...rest } = init
    const out: Record<string, unknown> = { ...rest }
    if (headers) out.headers = Object.fromEntries(new Headers(headers).entries())
    if (body !== undefined && body !== null) out.body = typeof body === 'string' || body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
    return out
  }
  const netHeaders = (h: NetReply['headers']) => new Headers(Array.isArray(h) ? h : Object.entries(h ?? {}))
  const net = {
    async fetch(input: string | URL | Request, init?: RequestInit & { proxy?: string; timeout?: number }): Promise<Response> {
      const req = input instanceof Request ? input : null
      const merged = req ? { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(await req.arrayBuffer()), ...init } : init
      const r = await call<NetReply>('service', 'tiny.network', { op: 'fetch', url: req ? req.url : String(input), init: await netInit(merged), timeout: init?.timeout, proxy: init?.proxy })
      const res = new Response([101, 204, 205, 304].includes(r.status) ? null : (r.body as BodyInit), { status: r.status, statusText: r.statusText, headers: netHeaders(r.headers) })
      Object.defineProperty(res, 'url', { value: r.url })
      Object.defineProperty(res, 'redirected', { value: r.redirected })
      return res
    },
    status: () => call<unknown>('service', 'tiny.network', { op: 'status' }),
    subscribe(fn: (e: { type: string; status: Promise<unknown> }) => void): () => void {
      const mk = (type: string) => () => fn({ type, status: net.status() })
      const on = mk('online'), off = mk('offline')
      addEventListener('online', on)
      addEventListener('offline', off)
      return () => (removeEventListener('online', on), removeEventListener('offline', off))
    },
    async download(url: string, dest: string, init?: RequestInit) {
      return call('service', 'tiny.network', { op: 'download', url, dest, init: await netInit(init) })
    },
    async upload(path: string, url: string, init?: RequestInit): Promise<Response> {
      const r = await call<NetReply>('service', 'tiny.network', { op: 'upload', path, url, init: await netInit(init) })
      return new Response(r.body as BodyInit, { status: r.status, statusText: r.statusText, headers: netHeaders(r.headers) })
    },
  }
  w.net = net

  const tiny: Record<string, unknown> = {
    ready: call<{ theme: unknown }>('preview.init').then((init) => {
      theme = init.theme
      emit('theme', init.theme)
    }),
    window: {
      id: 0,
      setTitle: (t: string) => call<void>('preview.title', String(t)),
      setMenus: async () => {},
      close: () => {},
      minimize: () => {},
      toggleMaximize: () => {},
      focus: () => {},
      resize: () => {},
      setEdited: () => {},
      list: async () => [],
    },
    app: {
      id: 'preview',
      name: 'Preview',
      args: [] as string[],
      state: restore?.state ?? null,
      onOpenFile: () => () => {},
      onOpenURL: () => () => {},
      onSaveState: (fn: () => unknown) => {
        saveHandlers.add(fn)
        return () => void saveHandlers.delete(fn)
      },
      openWindow: notInPreview('openWindow'),
      stateChanged: () => {},
      quit: () => {},
    },
    dialogs: new Proxy({}, {
      get: (_, name: string) => (...args: unknown[]) => call('dialogs.' + name, ...args),
    }),
    shell: {
      open: (t: string, o: unknown) => call('shell.open', t, o),
      reveal: (p: string) => call('shell.reveal', p),
      notify: (t: string, b: string) => call('shell.notify', t, b),
      contextMenu: notInPreview('contextMenu'),
      openApp: (id: string) => call('shell.openApp', id),
      apps: () => call('shell.apps'),
      icon: async () => ({ name: '', url: null, description: '' }),
    },
    host: {
      importFiles: (dest: string, o: unknown) => call('host.importFiles', dest, o),
      exportPath: (p: string, o: unknown) => call('host.exportPath', p, o),
    },
    service: (name: string, msg: unknown) => call('service', name, msg),
    net,
    on,
    get theme() {
      return theme
    },
    locale: 'en-US',
    platform: 'web',
  }

  // The previewed app sees `tiny` as a plain object: known members above, known kernel calls
  // served by Code (running as Code), everything else refused.
  const surface = new Proxy(tiny, {
    get(target, name) {
      if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined
      if (name in target) return target[name]
      if (KERNEL.has(name)) return (...args: unknown[]) => call('tiny.' + name, ...args)
      return notInPreview(name)
    },
  })
  Object.defineProperty(window, 'tiny', { get: () => surface, configurable: true })

  // The tiny module registry for the previewed app's ES modules (Code transforms them to this form).
  const modules = new Map<string, { factory: (exports: Record<string, unknown>) => void; exports?: Record<string, unknown> }>()
  w.__pearDefine = (name: string, factory: (exports: Record<string, unknown>) => void) => void modules.set(name, { factory })
  w.__pearRequire = (name: string): Record<string, unknown> => {
    const m = modules.get(name)
    if (!m) throw Object.assign(new Error(`Cannot find module '${name}'`), { name: 'SysError', code: 'ENOENT' })
    if (!m.exports) {
      m.exports = {}
      m.factory(m.exports)
    }
    return m.exports
  }
  w.__pearInterop = (m: Record<string, unknown>): Record<string, unknown> => ('default' in m ? m : Object.assign(Object.create(null), m, { default: m.default }))

  // ---- state that survives a rebuild
  // A sandboxed page has no real storage, so localStorage and sessionStorage are in-memory stand-ins.
  // Before Code rebuilds the page it asks for a snapshot (these stores, the app's own
  // `tiny.app.onSaveState` data, form fields, scroll positions, focus) and hands it to the next
  // document, which restores it. The app keeps its place while its code changes.
  const makeStorage = (init?: Record<string, string>) => {
    const data = new Map<string, string>(Object.entries(init ?? {}))
    const api = {
      getItem: (k: string) => (data.has(String(k)) ? data.get(String(k))! : null),
      setItem: (k: string, v: unknown) => void data.set(String(k), String(v)),
      removeItem: (k: string) => void data.delete(String(k)),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size
      },
    }
    const storage = new Proxy(api, {
      get: (t, p) => (p in t ? (t as Record<string | symbol, unknown>)[p] : typeof p === 'string' && data.has(p) ? data.get(p) : undefined),
      set: (_, p, v) => (typeof p === 'string' && data.set(p, String(v)), true),
      deleteProperty: (_, p) => (data.delete(String(p)), true),
      has: (t, p) => p in t || (typeof p === 'string' && data.has(p)),
      ownKeys: () => [...data.keys()],
      getOwnPropertyDescriptor: (_, p) => (typeof p === 'string' && data.has(p) ? { value: data.get(p), enumerable: true, configurable: true, writable: true } : undefined),
    })
    return { storage: storage as unknown as Storage, dump: () => Object.fromEntries(data) }
  }
  const local = makeStorage(restore?.local)
  const session = makeStorage(restore?.session)
  try {
    Object.defineProperty(window, 'localStorage', { get: () => local.storage, configurable: true })
    Object.defineProperty(window, 'sessionStorage', { get: () => session.storage, configurable: true })
  } catch {}

  // A key that finds the same element in the rebuilt page: its id, else its position in the tree.
  const keyOf = (el: Element): string => {
    if (el.id) return '#' + el.id
    const parts: string[] = []
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      const p: Element | null = n.parentElement
      if (!p) break
      parts.unshift(`${n.tagName}:${Array.prototype.indexOf.call(p.children, n)}`)
    }
    return 'body>' + parts.join('>')
  }
  const find = (key: string): Element | null => {
    if (key.startsWith('#')) return document.getElementById(key.slice(1))
    let cur: Element | null = document.body
    for (const part of key.split('>').slice(1)) {
      if (!part) continue
      const [tag, idx] = part.split(':')
      cur = cur?.children[Number(idx)] ?? null
      if (!cur || cur.tagName !== tag) return null
    }
    return cur
  }
  const snapshot = (): Snap => {
    const fields: NonNullable<Snap['dom']>['fields'] = []
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const f = el as HTMLInputElement
      if (f.type === 'password' || f.type === 'file') continue
      fields.push({ key: keyOf(el), value: f.value, checked: f.checked })
    }
    const scrolls: NonNullable<Snap['dom']>['scrolls'] = []
    for (const el of document.querySelectorAll('*')) if (el.scrollTop || el.scrollLeft) scrolls.push({ key: keyOf(el), top: el.scrollTop, left: el.scrollLeft })
    const a = document.activeElement as HTMLInputElement | null
    const focus = a && a !== document.body && a !== document.documentElement ? { key: keyOf(a), start: a.selectionStart ?? null, end: a.selectionEnd ?? null } : null
    let state: unknown = null
    for (const h of saveHandlers) {
      try {
        state = h()
        break
      } catch {}
    }
    return {
      state,
      local: local.dump(),
      session: session.dump(),
      dom: { fields, scrolls, doc: { x: scrollX, y: scrollY }, focus, open: [...document.querySelectorAll('details')].map((d) => ({ key: keyOf(d), open: d.open })) },
    }
  }
  if (restore?.dom) {
    const dom = restore.dom
    let touched = false // once the user acts on the new page, stop putting the old one back
    for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => (touched = true), { capture: true, once: true })
    const apply = () => {
      if (touched) return
      for (const f of dom.fields) {
        const el = find(f.key) as HTMLInputElement | null
        if (!el || !('value' in el)) continue
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.checked
        else if (el.value !== f.value) el.value = f.value
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      for (const d of dom.open) {
        const el = find(d.key) as HTMLDetailsElement | null
        if (el && 'open' in el) el.open = d.open
      }
      for (const sc of dom.scrolls) {
        const el = find(sc.key)
        if (el) el.scrollTo(sc.left, sc.top)
      }
      scrollTo(dom.doc.x, dom.doc.y)
      if (dom.focus) {
        const el = find(dom.focus.key) as HTMLInputElement | null
        el?.focus?.()
        if (el && dom.focus.start !== null) try { el.setSelectionRange(dom.focus.start, dom.focus.end ?? dom.focus.start) } catch {}
      }
    }
    // the page may render after load (fetched data, timers): try again a little later
    addEventListener('load', () => {
      apply()
      setTimeout(apply, 150)
      setTimeout(apply, 600)
    })
  }

  // ---- the debug console: console output and errors, with values that can be expanded
  type Ser =
    | { k: 'prim'; t: string; v: string }
    | { k: 'fn' | 'node'; v: string }
    | { k: 'err'; name: string; v: string; stack: string }
    | { k: 'obj'; cls: string; len?: number; props: Array<[string, Ser]>; more: number }
    | { k: 'circ' }
  const ser = (v: unknown, depth: number, seen: WeakSet<object>, budget: { n: number }): Ser => {
    if (v === null) return { k: 'prim', t: 'null', v: 'null' }
    const t = typeof v
    if (t === 'string') return { k: 'prim', t: 'string', v: (v as string).length > 2000 ? (v as string).slice(0, 2000) + '… (' + (v as string).length + ' chars)' : (v as string) }
    if (t === 'undefined' || t === 'number' || t === 'boolean') return { k: 'prim', t, v: String(v) }
    if (t === 'bigint') return { k: 'prim', t: 'number', v: String(v) + 'n' }
    if (t === 'symbol') return { k: 'prim', t: 'symbol', v: String(v) }
    if (t === 'function') return { k: 'fn', v: (v as Function).name ? `ƒ ${(v as Function).name}()` : 'ƒ ()' }
    const o = v as object
    if (o instanceof Error) return { k: 'err', name: o.name, v: o.message, stack: String(o.stack ?? '') }
    if (typeof Node !== 'undefined' && o instanceof Node) {
      const el = o as Element
      return { k: 'node', v: el.nodeType === 1 ? `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}${typeof el.className === 'string' && el.className ? ` class="${el.className}"` : ''}>` : o.nodeName }
    }
    if (seen.has(o)) return { k: 'circ' }
    const cls = Array.isArray(o) ? 'Array' : o instanceof Map ? 'Map' : o instanceof Set ? 'Set' : (o.constructor && o.constructor.name) || 'Object'
    if (depth <= 0) return { k: 'obj', cls, len: Array.isArray(o) ? o.length : undefined, props: [], more: 1 }
    seen.add(o)
    let entries: Array<[string, unknown]> = []
    try {
      if (o instanceof Map) entries = [...o.entries()].map(([k, val], i) => [String(i), [k, val]] as [string, unknown])
      else if (o instanceof Set) entries = [...o.values()].map((val, i) => [String(i), val] as [string, unknown])
      else entries = Object.keys(o).map((k) => [k, (o as Record<string, unknown>)[k]] as [string, unknown])
    } catch {}
    const props: Array<[string, Ser]> = []
    for (const [k, val] of entries.slice(0, 40)) {
      if (budget.n-- <= 0) break
      props.push([k, ser(val, depth - 1, seen, budget)])
    }
    seen.delete(o)
    return { k: 'obj', cls, len: Array.isArray(o) ? o.length : o instanceof Map ? o.size : o instanceof Set ? o.size : undefined, props, more: Math.max(0, entries.length - props.length) }
  }
  const pack = (v: unknown): Ser => {
    try {
      return ser(v, 3, new WeakSet(), { n: 300 })
    } catch (e) {
      return { k: 'prim', t: 'string', v: String(e) }
    }
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...parts: unknown[]) => {
      orig(...parts)
      try {
        send({ t: 'pcon', level, args: parts.map(pack) })
      } catch {}
    }
  }
  const origDir = console.dir.bind(console)
  console.dir = (v: unknown, ...rest: unknown[]) => {
    origDir(v, ...rest)
    send({ t: 'pcon', level: 'log', args: [pack(v)] })
  }
  const origTable = console.table.bind(console)
  console.table = (v: unknown) => {
    origTable(v)
    send({ t: 'pcon', level: 'log', args: [pack(v)] })
  }
  console.assert = (cond?: boolean, ...parts: unknown[]) => {
    if (!cond) send({ t: 'pcon', level: 'error', args: [pack('Assertion failed:'), ...parts.map(pack)] })
  }
  const origClear = console.clear.bind(console)
  console.clear = () => {
    origClear()
    send({ t: 'pcon', level: 'clear', args: [] })
  }
  window.addEventListener('error', (e) => {
    if (e.error) send({ t: 'pcon', level: 'error', args: [pack(e.error)], where: e.lineno ? `line ${e.lineno}:${e.colno}` : '' })
    else send({ t: 'pcon', level: 'error', args: [pack(e.message)], where: e.lineno ? `line ${e.lineno}:${e.colno}` : '' })
  })
  window.addEventListener('unhandledrejection', (e) => send({ t: 'pcon', level: 'error', args: [pack('Uncaught (in promise)'), pack((e as PromiseRejectionEvent).reason)] }))

  // Code asks the page for things: a snapshot, a stylesheet swap, or to evaluate an expression (the console prompt).
  // The page's CSP forbids eval and `new Function`, but inline scripts are allowed (the app's own are
  // inline), so the prompt's code is run as a script element in the page's global scope: top-level
  // bindings are visible and `await` works. An expression is tried first, then a statement list.
  const runInPage = (body: string): { promise?: Promise<unknown>; syntax?: unknown } => {
    let syntax: unknown
    const onError = (e: ErrorEvent) => {
      syntax = e.error ?? new SyntaxError(e.message)
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    w.__pearEval = undefined
    addEventListener('error', onError, true)
    const el = document.createElement('script')
    el.textContent = `window.__pearEval = (async () => ${body})()`
    document.documentElement.appendChild(el)
    el.remove()
    removeEventListener('error', onError, true)
    const promise = w.__pearEval as Promise<unknown> | undefined
    w.__pearEval = undefined
    return promise ? { promise } : { syntax: syntax ?? new SyntaxError('Invalid or unexpected token') }
  }
  const evaluate = async (code: string): Promise<unknown> => {
    const first = runInPage(`(${code}\n)`)
    const run = first.promise ? first : runInPage(`{\n${code}\n}`)
    if (!run.promise) throw run.syntax
    const value = await run.promise
    w.$_ = value
    return value
  }
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== parent) return
    const m = ev.data as { t?: string; id?: number; code?: string; files?: Record<string, string> }
    if (!m || typeof m !== 'object') return
    if (m.t === 'psnap') {
      let snap: Snap | null = null
      try {
        snap = snapshot()
      } catch {}
      send({ t: 'preplyx', id: m.id, snap })
    } else if (m.t === 'pcss' && m.files) {
      for (const [rel, text] of Object.entries(m.files)) {
        for (const el of document.querySelectorAll(`style[data-pear-src="${rel}"]`)) el.textContent = text
      }
    } else if (m.t === 'peval' && typeof m.code === 'string') {
      evaluate(m.code).then(
        (value) => send({ t: 'preplyx', id: m.id, ok: true, value: pack(value) }),
        (error) => send({ t: 'preplyx', id: m.id, ok: false, value: pack(error) }),
      )
    }
  })
  send({ t: 'pready' })
}
