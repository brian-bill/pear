/// Turn a fetched web page into a document for Safari's page frame. The page keeps its own styles, scripts,
/// iframes and network life: it runs in a sandboxed iframe (`main.ts`), so its CSS cannot reach the browser chrome
/// and its scripts cannot reach the app. A bridge script injected ahead of the page's own reports link clicks,
/// forms and title changes to the app, stands in for `fetch`/`XMLHttpRequest`/`sendBeacon` (each request runs
/// through `tiny.network`, like the page document itself did), and a `<base>` makes the page's relative resources
/// resolve against its final address. Non-HTML replies get a reader view.
import { escapeHtml } from '@tiny/sdk'

/** A `tiny.network` `fetch` reply (`contracts/network.md`). */
export interface FetchResult {
  status: number
  statusText?: string
  headers?: Record<string, string>
  url?: string
  redirected?: boolean
  body?: unknown
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** `b.html` -> `http://host/dir/b.html`, or null if it can never resolve. */
const resolve = (value: string, base: string): string | null => {
  try {
    return new URL(value, base).href
  } catch {
    return null
  }
}

const READER_CSS = `
html, body { margin: 0; }
body { background: #fff; color: #1d1d1f; }
.doc { margin: 0 auto; padding: 20px 24px 48px; max-width: 720px; font: 15px/1.55 -apple-system, 'Helvetica Neue', 'Segoe UI', sans-serif; overflow-wrap: break-word; }
a { color: #0a84ff; text-decoration: underline; text-decoration-color: rgba(10,132,255,.4); }
img, video, audio, canvas { max-width: 100%; height: auto; }
pre, code, kbd { font: 12px Menlo, Consolas, monospace; }
pre { padding: 10px 12px; border-radius: 8px; background: rgba(127,127,127,.08); white-space: pre-wrap; }
table { border-collapse: collapse; max-width: 100%; } td, th { padding: 4px 8px; border: 1px solid rgba(127,127,127,.3); }
.err, .home { margin: 44px auto 0; max-width: 480px; text-align: center; }
.err h1 { font-size: 21px; margin: 0 0 10px; }
.err .detail { font-size: 13px; color: #6e6e73; margin: 0 0 10px; }
.err .code { font: 12px Menlo, Consolas, monospace; color: #6e6e73; margin: 8px 0; overflow-wrap: break-word; }
.err .row, .home .row { margin-top: 18px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.err a.btn, .home a.btn { color: #fff; background: #0a84ff; border-radius: 7px; padding: 5px 14px; text-decoration: none; font-size: 13px; }
.home h1 { margin: 0 0 4px; font-size: 26px; }
.home p.big { margin: 0 0 18px; color: #6e6e73; }
.home h2 { margin: 26px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #6e6e73; text-align: center; }
.home ul { margin: 0; padding: 0; list-style: none; text-align: left; }
.home li { padding: 7px 4px; border-top: 1px solid rgba(127,127,127,.2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home li small { color: #6e6e73; margin-left: 6px; }
.home p.none { color: #6e6e73; }`

/**
 * The script injected into every page shown in the frame, first in `<head>` so it is in place before the page's
 * own scripts run. It cannot touch the app's DOM (the frame has an opaque origin); messages are tagged with a
 * token so a slow page cannot update the entry of the one that replaced it.
 *
 * The sandbox has no network of its own (`connect-src 'none'`), so `fetch`, `XMLHttpRequest` and `sendBeacon` are
 * replaced with a bridge to Safari (`main.ts`), which runs each request through `tiny.network` — the same
 * permissioned path the page document itself took. An opaque origin also has no `history`, `document.cookie` or
 * storage; those become quiet no-ops and in-memory shims so a page's routing, analytics and boot code do not die
 * on them. The CSP backstops all of this: the frame itself still cannot connect anywhere.
 */
const pageScript = (token: number): string => `(() => {
  const token = ${JSON.stringify(token)}
  const send = (message) => { try { parent.postMessage(Object.assign({ __tiny: true, token }, message), '*') } catch {} }
  const absolute = (value) => { try { return new URL(String(value), document.baseURI).href } catch { return '' } }
  const followable = (value) => {
    try { const url = new URL(value, document.baseURI); return /^https?:$/i.test(url.protocol) ? url.href : '' } catch { return '' }
  }

  // ---- the network bridge: every http(s) request becomes a message to Safari, which answers with the reply
  const pending = new Map()
  let requestId = 0
  addEventListener('message', (event) => {
    if (event.source !== parent) return
    const m = event.data
    if (!m || m.__tiny !== true || m.token !== token || m.t !== 'http-reply' || !pending.has(m.id)) return
    const settle = pending.get(m.id)
    pending.delete(m.id)
    settle(m)
  })
  const call = (url, init, settle) => { const id = ++requestId; pending.set(id, settle); send({ t: 'http', id, url, init }); return id }
  const headersOf = (value) => {
    const out = {}
    if (!value) return out
    if (value instanceof Headers) { value.forEach((v, k) => { out[k] = v }); return out }
    if (Array.isArray(value)) { for (const entry of value) out[entry[0]] = String(entry[1]); return out }
    for (const [k, v] of Object.entries(value)) out[k] = String(v)
    return out
  }
  const bodyOf = async (body, headers) => {
    if (body === undefined || body === null || body === '') return undefined
    if (typeof body === 'string') return body
    if (body instanceof URLSearchParams) {
      if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
      return body.toString()
    }
    if (body instanceof Blob) {
      if (body.type && !headers['content-type']) headers['content-type'] = body.type
      return new Uint8Array(await body.arrayBuffer())
    }
    if (body instanceof FormData) {
      const packed = new Response(body)
      const type = packed.headers.get('content-type')
      if (type) headers['content-type'] = type
      return new Uint8Array(await packed.arrayBuffer())
    }
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (ArrayBuffer.isView(body)) return body instanceof Uint8Array ? body : new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return String(body)
  }
  const responseOf = (m) => {
    const bytes = m.body instanceof Uint8Array ? m.body : new Uint8Array(m.body || [])
    const bare = m.status === 204 || m.status === 205 || m.status === 304
    const res = new Response(bare ? null : bytes, { status: m.status, statusText: m.statusText || '', headers: m.headers || {} })
    try { Object.defineProperty(res, 'url', { value: m.url || '' }) } catch {}
    try { Object.defineProperty(res, 'redirected', { value: Boolean(m.redirected) }) } catch {}
    return res
  }
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

  window.fetch = async (input, init) => {
    init = init || {}
    let url
    let method = init.method || 'GET'
    let headers = headersOf(init.headers)
    let body = await bodyOf(init.body, headers)
    const signal = init.signal
    if (input instanceof Request) {
      url = absolute(input.url)
      if (init.method === undefined) method = input.method || 'GET'
      if (init.headers === undefined && input.headers) headers = headersOf(input.headers)
      if (init.body === undefined && input.body) { try { body = await bodyOf(await input.arrayBuffer(), headers) } catch {} }
      if (!signal && input.signal) signal = input.signal
    } else url = absolute(input)
    if (!/^https?:/i.test(url)) throw new TypeError('only http(s) requests are supported')
    if (signal && signal.aborted) throw abortError()
    return await new Promise((resolve, reject) => {
      let id = 0
      const onAbort = () => { if (id) pending.delete(id); reject(abortError()) }
      if (signal) signal.addEventListener('abort', onAbort)
      id = call(url, { method, headers, body }, (m) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        if (m.ok) resolve(responseOf(m))
        else reject(new TypeError(m.message || 'the request failed'))
      })
    })
  }

  class BridgeXHR extends EventTarget {
    constructor() {
      super()
      this.readyState = 0
      this.status = 0
      this.statusText = ''
      this.response = ''
      this.responseText = ''
      this.responseXML = null
      this.responseURL = ''
      this.responseType = ''
      this.timeout = 0
      this.withCredentials = false
      this.onreadystatechange = null
      this.onloadstart = null
      this.onprogress = null
      this.onload = null
      this.onloadend = null
      this.onerror = null
      this.onabort = null
      this.ontimeout = null
      this.upload = new EventTarget()
      this._method = 'GET'
      this._url = ''
      this._headers = {}
      this._responseHeaders = {}
      this._bytes = new Uint8Array()
      this._settled = true
    }
    fire(type, Ctor, init) {
      const ev = new (Ctor || Event)(type, init)
      if (typeof this['on' + type] === 'function') this['on' + type].call(this, ev)
      this.dispatchEvent(ev)
    }
    open(method, url) {
      this._method = String(method || 'GET').toUpperCase()
      this._url = absolute(url)
      this._headers = {}
      this._responseHeaders = {}
      this._settled = false
      this.status = 0
      this.statusText = ''
      this.response = ''
      this.responseText = ''
      this.responseXML = null
      this.readyState = 1
      this.fire('readystatechange')
    }
    setRequestHeader(name, value) { this._headers[String(name).toLowerCase()] = String(value) }
    getResponseHeader(name) { const v = this._responseHeaders[String(name).toLowerCase()]; return v === undefined ? null : String(v) }
    getAllResponseHeaders() { return Object.entries(this._responseHeaders).map(([k, v]) => k + ': ' + v).join('\\r\\n') }
    overrideMimeType() {}
    abort() {
      if (this._settled || this.readyState === 0) return
      this._settled = true
      this.readyState = 0
      this.fire('abort', ProgressEvent)
      this.fire('loadend', ProgressEvent)
    }
    send(body) {
      this.fire('loadstart', ProgressEvent)
      const headers = Object.assign({}, this._headers)
      bodyOf(body, headers).then((bytes) => call(this._url, { method: this._method, headers, body: bytes, timeout: this.timeout || undefined }, (m) => {
        if (this._settled) return
        this._settled = true
        if (!m.ok) {
          this.readyState = 4
          this.fire(m.code === 'ETIMEDOUT' ? 'timeout' : 'error', ProgressEvent)
          this.fire('loadend', ProgressEvent)
          return
        }
        this.status = m.status
        this.statusText = m.statusText || ''
        this.responseURL = m.url || this._url
        this._responseHeaders = m.headers || {}
        this._bytes = m.body instanceof Uint8Array ? m.body : new Uint8Array(m.body || [])
        const text = new TextDecoder().decode(this._bytes)
        if (this.responseType === 'arraybuffer') this.response = this._bytes.slice().buffer
        else if (this.responseType === 'blob') this.response = new Blob([this._bytes], { type: this._responseHeaders['content-type'] || '' })
        else if (this.responseType === 'json') { try { this.response = JSON.parse(text) } catch { this.response = null } }
        else if (this.responseType === 'document') { this.responseXML = new DOMParser().parseFromString(text, 'text/html'); this.response = this.responseXML }
        else { this.responseText = text; this.response = text }
        this.readyState = 4
        this.fire('readystatechange')
        this.fire('progress', ProgressEvent, { loaded: this._bytes.length, total: this._bytes.length })
        this.fire('load', ProgressEvent)
        this.fire('loadend', ProgressEvent)
      }), () => {
        if (this._settled) return
        this._settled = true
        this.readyState = 4
        this.fire('error', ProgressEvent)
        this.fire('loadend', ProgressEvent)
      })
    }
  }
  for (const [name, value] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) {
    BridgeXHR[name] = value
    BridgeXHR.prototype[name] = value
  }
  window.XMLHttpRequest = BridgeXHR

  navigator.sendBeacon = (url, data) => {
    const headers = {}
    bodyOf(data, headers).then((body) => call(absolute(url), { method: 'POST', headers, body }, () => {})).catch(() => {})
    return true
  }

  // ---- an opaque origin has no history, cookies or storage. history becomes a quiet no-op, document.cookie
  // reads empty, and storage becomes an in-memory shim — a page loses its state on reload, which is still better
  // than a SecurityError mid-boot.
  for (const name of ['pushState', 'replaceState']) {
    const native = history[name].bind(history)
    history[name] = (...args) => {
      try { return native(...args) } catch (e) { if (!e || e.name !== 'SecurityError') throw e }
    }
  }
  try { Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => {} }) } catch {}
  const storageShim = () => {
    const map = new Map()
    return {
      get length() { return map.size },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => void map.set(String(k), String(v)),
      removeItem: (k) => void map.delete(String(k)),
      clear: () => void map.clear(),
    }
  }
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storageShim() })
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storageShim() })
  } catch {}
  const refused = () => {
    const req = new EventTarget()
    req.result = undefined
    req.error = new DOMException('The document is sandboxed and lacks the allow-same-origin flag.', 'SecurityError')
    setTimeout(() => {
      if (typeof req.onerror === 'function') req.onerror(new Event('error'))
      req.dispatchEvent(new Event('error'))
    }, 0)
    return req
  }
  try {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: refused, deleteDatabase: refused, cmp: () => { throw new DOMException('The document is sandboxed and lacks the allow-same-origin flag.', 'SecurityError') } } })
  } catch {}

  // ---- forms: GET becomes an app navigation, POST is fetched and shown by Safari; the CSP blocks anything else
  const sendForm = (form, submitter) => {
    const method = String((submitter && submitter.formMethod) || form.method || 'get').toLowerCase()
    const url = followable((submitter && submitter.formAction) || form.action || document.baseURI)
    if (!url) return
    if (method === 'get') {
      try {
        const target = new URL(url)
        for (const [name, value] of new FormData(form, submitter)) target.searchParams.append(name, typeof value === 'string' ? value : value.name)
        send({ t: 'navigate', url: target.href })
      } catch {}
      return
    }
    const headers = {}
    bodyOf(new FormData(form, submitter), headers)
      .then((body) => send({ t: 'navigate', url, method: 'POST', body, headers }))
      .catch(() => {})
  }
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return
    const target = event.composedPath()[0]
    const link = target instanceof Element ? target.closest('a[href]') : null
    if (!link || link.hasAttribute('download')) return
    const raw = link.getAttribute('href') || ''
    if (raw.startsWith('#')) return
    const url = followable(link.href)
    if (!url) return
    event.preventDefault()
    send({ t: 'navigate', url })
  }, true)
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    event.preventDefault()
    sendForm(form, event.submitter)
  }, true)
  // form.submit() fires no submit event, so it is routed the same way here
  HTMLFormElement.prototype.submit = function () { sendForm(this, null) }

  const title = () => send({ t: 'title', title: document.title })
  let timer = 0
  const soon = () => { clearTimeout(timer); timer = setTimeout(title, 200) }
  addEventListener('DOMContentLoaded', () => { scrollTo(0, 0); soon() })
  addEventListener('load', () => { scrollTo(0, 0); soon() })
  if (document.readyState !== 'loading') soon()
  try { new MutationObserver(soon).observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true }) } catch {}
})()`

/** A complete reader document: the stylesheet, then the body. The bridge makes its links act like page links. */
const readerPage = (body: string, token: number): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${READER_CSS}</style></head><body><div class="doc">${body}</div><script>${pageScript(token)}</script></body></html>`

/** The start page: how to use Safari, plus the user's bookmarks. */
export function homeHtml(bookmarks: Array<{ url: string; title: string }>, token: number): string {
  const list = bookmarks.slice(0, 8).map(
    (b) => `<li><a href="${escapeHtml(b.url)}">${escapeHtml(b.title)}</a><small>${escapeHtml(hostOf(b.url))}</small></li>`,
  )
  return readerPage(
    `<main class="home"><h1>Safari</h1><p class="big">Type an address in the toolbar, or choose a bookmark.</p>${
      list.length ? `<h2>Bookmarks</h2><ul>${list.join('')}</ul>` : `<p class="big">Bookmarks you add (⌘D) appear here.</p>`
    }</main>`,
    token,
  )
}

/** A fetch (or unsupported-content) failure: the host in the open, the errno code, the raw message. */
export function errorHtml(url: string, code: string, message: string, token: number): string {
  const hints: Record<string, string> = {
    EACCES: 'The request was blocked or refused (often CORS or mixed content, even through the fallback proxy), or the network rules for Safari deny it.',
    ENETUNREACH: 'Your computer is not connected to the internet.',
    EINVAL: 'The address has a scheme Safari does not understand.',
    ETIMEDOUT: 'The server took too long to answer.',
    EIO: 'The server answered with an error, or the connection broke.',
  }
  return readerPage(
    `<main class="err"><h1>${escapeHtml(hostOf(url))} can't be loaded</h1>` +
      `<p class="detail">${escapeHtml(hints[code] ?? 'The page could not be loaded.')}</p>` +
      `<p class="code"><kbd>${escapeHtml(code)}</kbd> ${escapeHtml(message)}</p>` +
      `<p class="code">${escapeHtml(url)}</p>` +
      `<p class="row"><a class="btn" href="${escapeHtml(url)}">Try Again</a></p></main>`,
    token,
  )
}

/** Non-HTML text (json, xml, plain text) as a reader view; other kinds get the "not a web page" doc. */
export function plainDoc(text: string, url: string, token: number): { html: string; title: string } {
  return { html: readerPage(`<main><pre>${escapeHtml(text.slice(0, 200000))}</pre></main>`, token), title: hostOf(url) }
}

export function unsupportedDoc(url: string, contentType: string, size: number, token: number): { html: string; title: string } {
  return {
    html: readerPage(
      `<main class="err"><h1>Not a web page</h1>` +
        `<p class="detail">Safari shows HTML and text; this resource is of another kind.</p>` +
        `<p class="code"><kbd>${escapeHtml(contentType || 'unknown type')}</kbd> ${size} bytes</p></main>`,
      token,
    ),
    title: hostOf(url),
  }
}

/**
 * The page document, ready for the frame: its own markup, a `<base>` for relative resources, and the bridge ahead
 * of the page's own scripts. A page-supplied CSP or refresh is dropped (it would fight the frame or navigate it
 * away). Frames stay — they inherit this frame's sandbox, so they are as confined as the page itself — while the
 * dead plugin elements are removed.
 */
export function buildPage(text: string, baseUrl: string, token: number): { html: string; title: string } {
  const parsed = new DOMParser().parseFromString(text, 'text/html')
  const baseHref = parsed.querySelector('base[href]')
  const candidate = baseHref ? resolve(baseHref.getAttribute('href') ?? '', baseUrl) : null
  const base = candidate && /^https?:\/\//i.test(candidate) ? candidate : baseUrl

  for (const el of parsed.querySelectorAll('meta[http-equiv], base, object, embed, applet')) el.remove()

  // Relative CSS, scripts, images, fonts and links resolve against the page's final address, not about:srcdoc.
  const baseEl = parsed.createElement('base')
  baseEl.setAttribute('href', base)
  parsed.head.prepend(baseEl)

  // First in the head: the bridge is in place before any page script can capture a native network method.
  const bridge = parsed.createElement('script')
  bridge.textContent = pageScript(token)
  parsed.head.prepend(bridge)

  const title = (parsed.title ?? '').trim()
  return { html: `<!doctype html>${parsed.documentElement.outerHTML}`, title }
}
