/// Stocks: a watchlist of currency rates (via frankfurter.app) and crypto prices (via coingecko) in one
/// list. These sources answer a point-in-time snapshot (frankfurter says "as of <date>"), so rows show
/// current values with that honesty instead of a history graph. The watchlist persists in
/// ~/Library/Stocks.json and every request goes through the `tiny.network` service.
import { bytesOf, tiny } from '@tiny/sdk'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const FILE = '/Users/pear/Library/Stocks.json'
const FX_URL = 'https://api.frankfurter.app/latest?from=USD'
const CRYPTO_URL = 'https://api.coingecko.com/api/v3/simple/price'

const DEFAULT_FX = ['EUR', 'GBP', 'JPY', 'CHF', 'CNY', 'CAD', 'AUD']
const DEFAULT_COINS = ['bitcoin', 'ethereum']

const FX_NAMES: Record<string, string> = {
  AUD: 'Australian Dollar', BGN: 'Bulgarian Lev', BRL: 'Brazilian Real', CAD: 'Canadian Dollar',
  CHF: 'Swiss Franc', CNY: 'Chinese Yuan', CZK: 'Czech Koruna', DKK: 'Danish Krone', EUR: 'Euro',
  GBP: 'British Pound', HKD: 'Hong Kong Dollar', HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah',
  ILS: 'Israeli Shekel', INR: 'Indian Rupee', ISK: 'Icelandic Krona', JPY: 'Japanese Yen',
  KRW: 'South Korean Won', MXN: 'Mexican Peso', MYR: 'Malaysian Ringgit', NOK: 'Norwegian Krone',
  NZD: 'New Zealand Dollar', PHP: 'Philippine Peso', PLN: 'Polish Zloty', RON: 'Romanian Leu',
  SEK: 'Swedish Krona', SGD: 'Singapore Dollar', THB: 'Thai Baht', TRY: 'Turkish Lira',
  USD: 'US Dollar', ZAR: 'South African Rand',
}
const COIN_SYMBOLS: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH' }

interface Rates { amount?: number; base?: string; date?: string; rates?: Record<string, number> }
interface Coins { [coin: string]: { usd?: number } }
interface NetReply { status: number; statusText: string; body: Uint8Array | number[] }

const state = {
  fx: DEFAULT_FX.slice(),
  coins: DEFAULT_COINS.slice(),
  fxRates: {} as Record<string, number>,
  coinRates: {} as Record<string, number>,
  fxDate: '',
}

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
  strong.textContent = 'Could not load the rates'
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

/** No thousand separators: `97,000` would swallow a text search for `97000`. */
const fmtRate = (n: number): string =>
  Number.isFinite(n)
    ? Math.abs(n) >= 1000
      ? String(Math.round(n))
      : String(Number(n.toPrecision(6)))
    : '—'

const coinName = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1)
const coinSymbol = (id: string): string => COIN_SYMBOLS[id] ?? id.slice(0, 3).toUpperCase() + '?'

function row(code: string, name: string, second: string, rate: number | undefined): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.dataset.code = code
  const a = document.createElement('td')
  a.textContent = name
  const b = document.createElement('td')
  b.className = 'code'
  b.textContent = second
  const c = document.createElement('td')
  c.className = 'num'
  if (rate === undefined) {
    c.classList.add('missing')
    c.textContent = '—'
    c.setAttribute('aria-label', 'no rate available')
  } else {
    c.textContent = fmtRate(rate)
  }
  tr.append(a, b, c)
  return tr
}

function render(): void {
  const fx = $('fx')
  fx.replaceChildren()
  for (const code of state.fx) {
    fx.append(row(code, FX_NAMES[code] ?? code, `USD → ${code}`, state.fxRates[code]))
  }
  const coins = $('coins')
  coins.replaceChildren()
  for (const id of state.coins) {
    coins.append(row(id, coinName(id), coinSymbol(id), state.coinRates[id]))
  }
  $('asof').textContent = state.fxDate
    ? `Currency rates from frankfurter.app, as of ${state.fxDate} · crypto prices from coingecko · no history`
    : ''
}

// ---- the watchlist (~/Library/Stocks.json)

async function save(): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await tiny.mkdir('/Users/pear/Library', { recursive: true })
      await tiny.writeFile(FILE, bytesOf(JSON.stringify({ fx: state.fx, crypto: state.coins })))
      return
    } catch (e) {
      // The kernel worker serves requests concurrently; two interleaved wasm calls can panic with an
      // aliasing error once — a retry comes right. Anything else is reported and the rest keeps working.
      if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') {
        setStatus(`Could not save the watchlist: ${codeOf(e)}`)
        return
      }
    }
  }
}

async function load(): Promise<void> {
  try {
    const j = JSON.parse(new TextDecoder().decode(await tiny.readFile(FILE))) as { fx?: unknown; crypto?: unknown }
    state.fx = Array.isArray(j.fx) && j.fx.length ? (j.fx as string[]).map(String) : DEFAULT_FX.slice()
    state.coins =
      Array.isArray(j.crypto) && j.crypto.length ? (j.crypto as string[]).map(String) : DEFAULT_COINS.slice()
  } catch {
    // ENOENT: first run with the default list — write it back so the file exists
    void save()
  }
  render()
}

// ---- fetching both sources; each half can fail on its own

const cryptoUrl = (): string => `${CRYPTO_URL}?ids=${encodeURIComponent(state.coins.join(','))}&vs_currencies=usd`

async function refresh(): Promise<void> {
  hideError()
  setStatus('Fetching rates…')
  const results = await Promise.allSettled([fetchJson<Rates>(FX_URL), fetchJson<Coins>(cryptoUrl())])
  const failed: string[] = []
  const first = results[0]
  const second = results[1]
  if (first.status === 'fulfilled') {
    const r = first.value
    state.fxRates = r.rates && typeof r.rates === 'object' ? r.rates : {}
    state.fxDate = typeof r.date === 'string' ? r.date : ''
  } else {
    failed.push(codeOf(first.reason))
  }
  if (second.status === 'fulfilled') {
    state.coinRates = {}
    for (const [id, v] of Object.entries(second.value)) state.coinRates[id] = Number(v?.usd ?? NaN)
  } else {
    failed.push(codeOf(second.reason))
  }
  render()
  if (failed.length) {
    showError(
      failed[0]!,
      failed.length === 2 ? 'The currency and crypto sources both failed.' : 'One of the two sources failed; the other loaded below.',
      () => void refresh(),
    )
    setStatus(`Partial data — error ${failed.join(', ')}`)
  } else {
    setStatus(`Loaded ${state.fx.length} currencies and ${state.coins.length} coins${state.fxDate ? ` (FX as of ${state.fxDate})` : ''}`)
  }
}

/** Add a row: a three-letter code joins the currencies, anything else joins the crypto ids. */
async function addSymbol(): Promise<void> {
  const value = await tiny.dialogs.prompt('Add a symbol:', {
    title: 'Add to Watchlist',
    value: '',
    placeholder: 'SEK or cardano',
    button: 'Add',
  })
  const s = (value ?? '').trim()
  if (!s) return
  if (/^[A-Za-z]{3}$/.test(s)) {
    const code = s.toUpperCase()
    if (!state.fx.includes(code)) state.fx.push(code)
  } else {
    const id = s.toLowerCase()
    if (!/^[a-z0-9-]{2,}$/.test(id) || state.coins.includes(id)) {
      setStatus(`“${s}” is not a usable symbol`)
      return
    }
    state.coins.push(id)
  }
  await save()
  await refresh()
}

function about(): void {
  void tiny.dialogs.alert({
    message: 'Stocks 1.0.0',
    detail: 'Currency rates from frankfurter.app, crypto prices from coingecko. Point-in-time quotes — no history.',
  })
}

async function main(): Promise<void> {
  await tiny.ready
  $('add').addEventListener('click', () => void addSymbol())
  $('reload').addEventListener('click', () => void refresh())
  await tiny.window.setMenus([
    { title: 'Stocks', items: [{ label: 'About Stocks', action: about }] },
    {
      title: 'File',
      items: [
        { label: 'Reload', shortcut: 'Cmd+R', action: () => void refresh() },
        { label: 'Add Symbol…', shortcut: 'Cmd+N', action: () => void addSymbol() },
      ],
    },
  ])
  await load()
  void refresh()
}
void main()
