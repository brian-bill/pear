/// News: Hacker News front page via the algolia API (`tags=front_page`). Rows open the story's URL with
/// the system (`tiny.shell.open`); with no URL linked — as Ask-HN posts often are — the row is honest
/// about it. Everything is fetched through the `tiny.network` service, like every windowed app.
import { tiny } from '@tiny/sdk'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const HN_URL = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30'

interface Hit {
  title?: string
  points?: number
  author?: string
  objectID?: string
  url?: string | null
  created_at?: string
  num_comments?: number
}
interface Reply { hits?: Hit[] }
interface NetReply { status: number; statusText: string; body: Uint8Array | number[] }

let loading = 0 // a guardtoken, so a slow reload never paints over a newer one

const codeOf = (e: unknown): string => (e as { code?: string } | null)?.code ?? 'EIO'
const messageOf = (e: unknown): string => ((e as { message?: string } | null)?.message ?? String(e))
const decodeBytes = (b: Uint8Array | number[]): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b))

/** Fetch a URL through the `tiny.network` service and decode its JSON body. */
async function fetchJson<T>(url: string): Promise<T> {
  const r = await tiny.service<NetReply>('tiny.network', { op: 'fetch', url })
  if (r.status >= 400) throw Object.assign(new Error(`the server answered ${r.status} ${r.statusText}`.trim()), { code: 'EHTTP' })
  try {
    return JSON.parse(new TextDecoder().decode(decodeBytes(r.body))) as T
  } catch {
    throw Object.assign(new Error('the answer was not readable JSON'), { code: 'EIO' })
  }
}

function setStatus(text: string): void {
  $('status').textContent = text
}

function hideError(): void {
  $('error').hidden = true
}

/** A card with the failure's code, its message and a Retry button that reruns the same call. */
function showError(code: string, message: string, again: () => void): void {
  const card = $('error')
  const head = document.createElement('div')
  const strong = document.createElement('strong')
  strong.textContent = 'Could not load the front page'
  const kbd = document.createElement('kbd')
  kbd.textContent = code
  head.append(strong, kbd)
  const rest = document.createElement('div')
  rest.className = 'dim'
  rest.textContent = message
  const retry = document.createElement('button')
  retry.className = 'primary'
  retry.textContent = 'Retry'
  retry.setAttribute('aria-label', 'Retry the request')
  retry.addEventListener('click', again)
  card.replaceChildren(head, rest, retry)
  card.hidden = false
  setStatus(`Error ${code}`)
}

/** `3h ago` — the only time display, since the stories have no other durable order. */
function ago(iso: string | undefined): string {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return ''
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Stories without a linked URL say so when activated instead of pretending to open. */
async function activate(hit: Hit): Promise<void> {
  const url = /^https?:\/\//i.test(hit.url ?? '') ? hit.url! : null
  if (!url) {
    setStatus('This story has no link')
    await tiny.shell.notify('Story has no link', hit.title ?? 'a Hacker News story').catch(() => {})
    return
  }
  setStatus('Opening…')
  try {
    await tiny.shell.open(url)
    setStatus(`Opened ${url}`)
  } catch (e) {
    // no browser app is registered for this scheme, or the shell refused: say so, stay alive
    setStatus(`Cannot open link: ${codeOf(e)}`)
    await tiny.shell.notify('Cannot open link', `${codeOf(e)} — ${messageOf(e)}`).catch(() => {})
  }
}

function render(hits: Hit[]): void {
  const list = $('list')
  list.replaceChildren()
  for (const hit of hits) {
    const title = hit.title ?? '(untitled story)'
    const linked = /^https?:\/\//i.test(hit.url ?? '')
    const b = document.createElement('button')
    b.className = linked ? 'row' : 'row nolink'
    b.setAttribute('aria-label', `${title}${linked ? '' : ' (no link)'}`)
    const t = document.createElement('span')
    t.className = 'title'
    t.textContent = title
    const meta = document.createElement('span')
    meta.className = 'meta'
    const bits = [`${hit.points ?? 0} points`, hit.author ? `by ${hit.author}` : '', ago(hit.created_at)].filter(Boolean)
    meta.textContent = bits.join(' · ')
    if (!linked) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'no link'
      meta.append(badge)
    }
    b.append(t, meta)
    b.addEventListener('click', () => void activate(hit))
    list.append(b)
  }
  setStatus(`${hits.length} stories from Hacker News`)
}

async function load(): Promise<void> {
  const tick = ++loading
  hideError()
  $('list').replaceChildren()
  setStatus('Loading the front page…')
  try {
    const r = await fetchJson<Reply>(HN_URL)
    if (tick !== loading) return // a reload arrived first
    render((r.hits ?? []).filter((h) => h && typeof h.objectID === 'string'))
  } catch (e) {
    if (tick !== loading) return
    showError(codeOf(e), messageOf(e), () => void load())
  }
}

function about(): void {
  void tiny.dialogs.alert({
    message: 'News 1.0.0',
    detail: 'The Hacker News front page via hn.algolia.com. No account needed; rows without an URL cannot open.',
  })
}

async function main(): Promise<void> {
  await tiny.ready
  $('reload').addEventListener('click', () => void load())
  $('apropos').addEventListener('click', about)
  await tiny.window.setMenus([
    { title: 'News', items: [{ label: 'About News', action: about }] },
    { title: 'File', items: [{ label: 'Reload', shortcut: 'Cmd+R', action: () => void load() }] },
  ])
  void load()
}
void main()
