/// Safari: a web page viewer inside the window sandbox. Every page fetch goes through `tiny.network`; the fetched
/// HTML is shown in a sandboxed iframe (`render.ts` adds a `<base>` and a bridge), so the page keeps its own styles,
/// scripts, frames and network life while staying away from the browser chrome. The bridge also carries the page's
/// own `fetch`/XHR requests, which are answered here through the same `tiny.network`. Per-window history lives in
/// this memory; bookmarks live in `~/Library/Bookmarks.json`.
import { tiny, type MenuDef } from '@tiny/sdk'
import { type Bookmark, loadBookmarks, saveBookmarks } from './bookmarks'
import { buildPage, errorHtml, homeHtml, hostOf, plainDoc, unsupportedDoc, type FetchResult } from './render'

// Element lookups happen in `main()`, after `tiny.ready`: while the srcdoc parser is still running,
// `getElementById` can transiently miss elements that appear earlier in the markup.
let browser: HTMLElement
let urlEl: HTMLInputElement
let pageEl: HTMLDivElement
let frame: HTMLIFrameElement
let backBtn: HTMLButtonElement
let forwardBtn: HTMLButtonElement

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** One history frame: the requested URL and the title the page had when it was shown (empty for failures). */
interface Entry {
  url: string
  title: string
}

const stack: Entry[] = []
let at = -1
let seq = 0 // guards against overlapping loads finishing out of order
let pageToken = 0 // tags bridge messages from the page currently in the frame
let bookmarks: Bookmark[] = []
let zoom = 1

/** `htxp://x` and other schemes pass through (the service rejects them kindly); bare hosts get https, like a browser. */
const normalize = (typed: string): string => {
  const v = typed.trim()
  if (!v) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v
  // `localhost:5173/x` and `127.0.0.1:8080` parse as a scheme but are host:port
  if (/^localhost(:\d+)?([/?#]|$)/i.test(v) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(v)) return `https://${v}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v
  return `https://${v}`
}

const charsetOf = (contentType: string): string => /charset=([\w-]+)/i.exec(contentType)?.[1] ?? ''

const decodeBytes = (bytes: Uint8Array, contentType: string): string => {
  try {
    return new TextDecoder(charsetOf(contentType) || undefined, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

function readPage(body: unknown, contentType: string, finalUrl: string, askedUrl: string, token: number): { html: string; title: string } {
  const bytes = body
  const hasBody = bytes instanceof Uint8Array
  const text = hasBody ? decodeBytes(bytes, contentType) : ''
  if (/text\/html|application\/xhtml/i.test(contentType) || (!contentType && /^\s*</.test(text)))
    return buildPage(text, finalUrl, token)
  if (/^text\/|\bjson\b|\bxml\b/i.test(contentType)) return plainDoc(text, finalUrl, token)
  return unsupportedDoc(askedUrl, contentType, hasBody ? bytes.length : 0, token)
}

/** Show a document in the page frame. The frame is sandboxed: its scripts run, but cannot reach this window. */
function show(html: string, token: number): void {
  pageToken = token
  frame.srcdoc = html
}

/** Paint everything that is not the page pane: URL field, window title, buttons, menus. */
function setEntry(entry: Entry | null): void {
  urlEl.value = entry?.url ?? ''
  void tiny.window.setTitle(entry ? entry.title || hostOf(entry.url) : 'Safari')
  paint()
}

function paint(): void {
  backBtn.disabled = at <= 0
  forwardBtn.disabled = at < 0 || at >= stack.length - 1
  $<HTMLButtonElement>('reload').disabled = at < 0
  void menus()
}

function goBack(): void {
  if (at > 0) void load(stack[--at]!.url, false)
}
function goForward(): void {
  if (at >= 0 && at < stack.length - 1) void load(stack[++at]!.url, false)
}
function goHome(): void {
  seq++ // forget loads in flight; the start page is not history, Back still reaches the last page
  show(homeHtml(bookmarks, seq), seq)
  void setEntry(null)
}
function reload(): void {
  const e = atEntry()
  if (e) void load(e.url, false)
}
const atEntry = (): Entry | null => (at >= 0 && at < stack.length ? stack[at]! : null)

/** The deployment's same-origin proxy (`desktop/server/proxy.ts`); absent on a plain static server. */
const FALLBACK_PROXY = '/api/proxy?url='

/**
 * Fetch a page. A cross-origin site usually does not allow the browser to read its answer (CORS), and an HTTPS
 * page may not fetch an `http` one (mixed content); both surface as EACCES. Retry just those through the small
 * proxy the dev server and Vercel provide, and keep the direct error if the proxy is not there.
 *
 * The page document may always use the proxy (opening any site is the point of a browser). A page's own requests
 * (`render.ts`'s bridge) may only use it for the page's own host — the proxy would otherwise hand every third-party
 * script a CORS-free ride to any site. `init` carries a page bridge request's method, headers and body.
 */
interface PageRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  timeout?: number
}

type ProxyRule = 'always' | 'same-host'

async function fetchPage(url: string, init: PageRequestInit = {}, proxy: ProxyRule = 'always'): Promise<FetchResult> {
  const wait = typeof init.timeout === 'number' && init.timeout > 0 ? init.timeout : undefined
  const ask = (proxyUrl?: string) =>
    tiny.service<FetchResult>('tiny.network', { op: 'fetch', url, init, timeout: wait, proxy: proxyUrl }, wait)
  try {
    return await ask()
  } catch (e) {
    if ((e as { code?: string }).code !== 'EACCES') throw e
    if (proxy === 'same-host') {
      const page = atEntry()
      if (!page || hostOf(url) !== hostOf(page.url)) throw e
    }
    try {
      const res = await ask(FALLBACK_PROXY)
      // A static host without the endpoint may answer with its own page or a 404; only the proxy marks its replies.
      if (res.headers?.['x-tiny-proxy'] !== '1') throw e
      return res
    } catch {
      throw e
    }
  }
}

async function addBookmark(): Promise<void> {
  const entry = atEntry()
  if (!entry) return
  const b: Bookmark = { url: entry.url, title: entry.title || hostOf(entry.url) }
  bookmarks = bookmarks.filter((x) => x.url !== b.url) // re-adding moves it to the end, like Safari
  bookmarks.push(b)
  try {
    await saveBookmarks(bookmarks)
  } catch {
    // keep the menu working; the write failure is an edge case we cannot act on
  }
  void menus()
}

async function openLocation(): Promise<void> {
  const typed = await tiny.dialogs.prompt('Open a web page:', { title: 'Open Location', value: urlEl.value, button: 'Go' })
  if (typed) void load(typed, true)
}

/** Fetch one page (an error becomes an error view) and show it, pushing onto history when `push`.
 *  A form POST arrives as `init`; reloading that history entry re-runs it as a GET, like a plain link. */
async function load(typed: string, push: boolean, init: PageRequestInit = {}): Promise<void> {
  const url = normalize(typed)
  if (!url) return void goHome()
  const mine = ++seq
  pageToken = mine // the outgoing page must not steer history while the next one loads
  browser.classList.add('busy')
  if (push) {
    stack.splice(at + 1)
    stack.push({ url, title: '' })
    at = stack.length - 1
  }
  setEntry(atEntry())
  try {
    const res = await fetchPage(url, init)
    if (mine !== seq) return
    if (res.status >= 400) {
      throw Object.assign(new Error(`the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`), { code: `HTTP ${res.status}` })
    }
    const built = readPage(res.body, String(res.headers?.['content-type'] ?? ''), res.url || url, url, mine)
    if (mine !== seq) return
    const entry: Entry = { url: res.url || url, title: built.title }
    stack[at] = entry
    show(built.html, mine)
    setEntry(entry)
  } catch (e) {
    if (mine !== seq) return
    const err = e as { code?: string; message?: string }
    const entry: Entry = { url, title: '' }
    show(errorHtml(url, err.code ?? 'EIO', err.message ?? 'the request could not be sent', mine), mine)
    setEntry(entry)
  } finally {
    if (mine === seq) browser.classList.remove('busy')
  }
}

function zoomTo(next: number): void {
  zoom = Math.min(2, Math.max(0.5, Math.round(next * 10) / 10))
  pageEl.style.setProperty('zoom', String(zoom))
}

async function menus(): Promise<void> {
  const back = at > 0
  const forward = at >= 0 && at < stack.length - 1
  const recent = stack.slice(0, Math.max(at, 0)).reverse()
  const defs: MenuDef[] = [
    { title: 'Safari', items: [{ label: 'New Window', shortcut: 'Cmd+N', action: () => void tiny.app.openWindow() }] },
    { title: 'File', items: [{ label: 'Open Location…', shortcut: 'Cmd+L', action: () => void openLocation() }] },
    {
      title: 'History',
      items: [
        { label: 'Back', shortcut: 'Cmd+[', disabled: !back, action: goBack },
        { label: 'Forward', shortcut: 'Cmd+]', disabled: !forward, action: goForward },
        { separator: true },
        ...(recent.length
          ? recent.slice(0, 8).map((e) => ({ label: e.title || hostOf(e.url), action: () => void load(e.url, true) }))
          : [{ label: 'No History', disabled: true }]),
      ],
    },
    {
      title: 'Bookmarks',
      items: [
        { label: 'Add Bookmark', shortcut: 'Cmd+D', disabled: at < 0, action: () => void addBookmark() },
        { separator: true },
        ...(bookmarks.length
          ? bookmarks.slice(0, 10).map((b) => ({ label: `${b.title} — ${b.url}`, action: () => void load(b.url, true) }))
          : [{ label: 'No Bookmarks', disabled: true }]),
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Reload Page', shortcut: 'Cmd+R', disabled: at < 0, action: reload },
        { separator: true },
        { label: 'Bigger Text', shortcut: 'Cmd+=', action: () => zoomTo(zoom + 0.1) },
        { label: 'Actual Size', shortcut: 'Cmd+0', action: () => zoomTo(1) },
        { label: 'Show Home', shortcut: 'Cmd+Shift+H', action: goHome },
      ],
    },
  ]
  await tiny.window.setMenus(defs)
}

// ---- bridge messages from the page frame: link clicks and forms start a load, dynamic titles update history,
//      and the network bridge's requests are run through tiny.network and answered

/** A page's bridge request: the frame answers with the reply (or an errno) for the page's `fetch`/XHR. */
async function answerPageHttp(msg: { id: number; token: number; url?: string; init?: PageRequestInit }): Promise<void> {
  const reply = (payload: Record<string, unknown>): void =>
    frame.contentWindow?.postMessage({ __tiny: true, token: msg.token, t: 'http-reply', id: msg.id, ...payload }, '*')
  const url = String(msg.url ?? '')
  if (!/^https?:\/\//i.test(url)) return reply({ ok: false, code: 'EINVAL', message: 'only http(s) requests are supported' })
  try {
    const res = await fetchPage(url, msg.init ?? {}, 'same-host')
    reply({
      ok: true, status: res.status, statusText: res.statusText ?? '', headers: res.headers ?? {},
      url: res.url || url, redirected: Boolean(res.redirected), body: res.body,
    })
  } catch (e) {
    const err = e as { code?: string; message?: string }
    reply({ ok: false, code: err.code ?? 'EIO', message: err.message ?? 'the request failed' })
  }
}

function onPageMessage(ev: MessageEvent): void {
  if (!frame || ev.source !== frame.contentWindow) return
  const msg = ev.data as {
    __tiny?: boolean; token?: number; t?: string; url?: string; title?: string; id?: number
    method?: string; headers?: Record<string, string>; body?: string | Uint8Array
  } | null
  if (!msg || msg.__tiny !== true || msg.token !== pageToken) return
  if (msg.t === 'navigate' && typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
    void load(msg.url, true, { method: msg.method, headers: msg.headers, body: msg.body })
  } else if (msg.t === 'http' && typeof msg.id === 'number') {
    void answerPageHttp(msg as { id: number; token: number; url?: string; init?: PageRequestInit })
  } else if (msg.t === 'title' && typeof msg.title === 'string') {
    const entry = atEntry()
    if (!entry || entry.title === msg.title) return
    entry.title = msg.title
    void tiny.window.setTitle(msg.title || hostOf(entry.url))
    void menus()
  }
}

async function main(): Promise<void> {
  await tiny.ready
  browser = $('browser')
  urlEl = $<HTMLInputElement>('url')
  pageEl = $<HTMLDivElement>('page')
  frame = $<HTMLIFrameElement>('frame')
  backBtn = $<HTMLButtonElement>('back')
  forwardBtn = $<HTMLButtonElement>('forward')
  window.addEventListener('message', onPageMessage)
  bookmarks = await loadBookmarks()
  backBtn.addEventListener('click', goBack)
  forwardBtn.addEventListener('click', goForward)
  document.getElementById('reload')!.addEventListener('click', reload)
  document.getElementById('go')!.addEventListener('click', () => void load(urlEl.value, true))
  urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void load(urlEl.value, true)
  })
  // A URL handed to Safari (a link from another app, or `open https://…`): show it instead of the start page.
  const asked = tiny.app.args[0]
  if (typeof asked === 'string' && /^https?:\/\//i.test(asked)) void load(asked, true)
  else goHome()
  tiny.on('openURL', (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void load(url, true)
  })
  document.body.dataset.ready = '1' // tests (and the window itself) can tell the toolbar is live
}

void main()
