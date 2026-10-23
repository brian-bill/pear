/// A small same-origin CORS/mixed-content proxy for `tiny.network` (`contracts/network.md`). A page cannot read a
/// cross-origin response without the site's permission, and an HTTPS page cannot fetch HTTP at all; Safari retries
/// those requests here. The endpoint is deliberately boring: it forwards one http(s) URL and streams the reply.
///
/// It is used by the Vite dev server (`vite.config.ts`) and the Vercel Edge Function (`api/proxy.ts`). Requests must
/// carry `x-tiny-proxy: 1`, which only the network driver adds; a web page cannot set that header cross-origin without
/// a CORS preflight, and a plain link or form cannot set it at all. That keeps it from being a casual open proxy.
/// Replies carry the same marker, so Safari can tell this endpoint from a static host's fallback page.

const METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'

/** Headers that belong to one connection and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
])

/** Browser and host headers that describe the proxy request rather than the target. */
const REQUEST_DROP = new Set([
  ...HOP_BY_HOP,
  'host', 'cookie', 'origin', 'referer', 'content-length', 'accept-encoding', 'x-tiny-proxy',
  'forwarded', 'via', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
])

/** Headers the hosting platform adds; they describe the edge, not the user's request. */
const HOST_HEADER = /^(?:x-vercel-|cf-)/

/** Response headers that would mislead or harm the page consuming the body. `x-tiny-proxy` is set by us below. */
const RESPONSE_DROP = new Set([
  ...HOP_BY_HOP,
  'content-encoding', 'content-length', 'content-disposition', 'set-cookie', 'x-tiny-proxy',
])

export interface ProxyOptions {
  /** Allow requests to loopback and private addresses. Development servers set this; the public deployment does not. */
  allowPrivate?: boolean
  /** How long the upstream request may take. Default 30 s. */
  timeout?: number
}

/**
 * The target of a `/api/proxy?url=...` request, or null if the request is malformed or the URL is not http(s).
 * `requestUrl` may be absolute or just a path (`/api/proxy?url=...`).
 */
export function targetOf(requestUrl: string): URL | null {
  try {
    const request = new URL(requestUrl, 'http://proxy.invalid')
    if (request.pathname !== '/api/proxy') return null
    const raw = request.searchParams.get('url')
    if (!raw) return null
    const target = new URL(raw)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
    if (target.username || target.password) return null
    return target
  } catch {
    return null
  }
}

const privateV4 = (a: number, b: number, c: number, d: number): boolean =>
  a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) || a >= 224

/** Expand an IPv6 literal into eight groups; null if it is not a plain IPv6 address. */
const ipv6Groups = (value: string): number[] | null => {
  if (!value.includes(':')) return null
  let host = value
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) is two hex groups; the URL parser usually writes it that way already.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (dotted) {
    const n = dotted.slice(2, 6).map(Number)
    if (n.some((part) => part > 255)) return null
    host = `${dotted[1]}${((n[0]! << 8) | n[1]!).toString(16)}:${((n[2]! << 8) | n[3]!).toString(16)}`
  }
  const halves = host.split('::')
  if (halves.length > 2) return null
  const parse = (half: string | undefined): number[] | null => {
    if (!half) return []
    const groups: number[] = []
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      groups.push(Number.parseInt(group, 16))
    }
    return groups
  }
  const left = parse(halves[0])
  const right = parse(halves[1])
  if (!left || !right) return null
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length
    return missing > 0 ? [...left, ...new Array<number>(missing).fill(0), ...right] : null
  }
  return left.length === 8 ? left : null
}

/**
 * True for loopback, link-local, private, carrier-grade NAT, multicast and other non-public addresses.
 * This checks literals (including IPv4-mapped/compatible and NAT64 forms); a public name that resolves
 * privately is the hosting platform's responsibility to refuse.
 */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/\.+$/, '') // a trailing dot is the same host (`localhost.`)
  if (!host) return true
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === 'metadata.google.internal') return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    if (a > 255 || b > 255 || c > 255 || d > 255) return true
    return privateV4(a, b, c, d)
  }

  const groups = ipv6Groups(host)
  if (!groups) return false
  const [a, b, c, d, e, f, g, h] = groups as [number, number, number, number, number, number, number, number]
  // Unspecified, loopback, unique-local, link-local and multicast.
  if (groups.every((n) => n === 0)) return true
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return true
  if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00) return true

  // IPv4-mapped (::ffff:7f00:1), IPv4-compatible (deprecated) and NAT64 (64:ff9b::/96).
  const v4Tail = ((g << 16) | h) >>> 0
  const isV4 = (): boolean => privateV4(v4Tail >>> 24, (v4Tail >>> 16) & 255, (v4Tail >>> 8) & 255, v4Tail & 255)
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) return isV4()
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isV4()
  return false
}

const text = (status: number, body: string): Response =>
  new Response(`${body}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      // Safari tells a missing endpoint (a static host's fallback page) from our own errors by this marker.
      'x-tiny-proxy': '1',
    },
  })

/** Forward one request to its target and return the upstream response. Errors are returned as 4xx/5xx responses. */
export async function proxy(request: Request, opts: ProxyOptions = {}): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: METHODS, 'x-tiny-proxy': '1', 'cache-control': 'no-store' } })
  }
  if (request.headers.get('x-tiny-proxy') !== '1') {
    return text(403, 'This proxy is only for tiny.network requests.')
  }

  const target = targetOf(request.url)
  if (!target) return text(400, 'Use /api/proxy?url=<an absolute http(s) URL>.')
  if (!opts.allowPrivate && isPrivateHost(target.hostname)) {
    return text(403, 'The proxy does not reach private or loopback addresses.')
  }

  const headers = new Headers()
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase()
    if (!REQUEST_DROP.has(key) && !HOST_HEADER.test(key)) headers.set(name, value)
  }
  // Some sites reject requests without a believable user agent; keep the browser's when it sent one.
  if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')
  if (!headers.has('accept')) headers.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')

  const method = request.method.toUpperCase()
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }

  let upstream: Response
  try {
    upstream = await fetch(target, init)
  } catch (e) {
    const name = (e as { name?: string }).name
    return text(name === 'TimeoutError' ? 504 : 502, name === 'TimeoutError' ? 'The site took too long to answer.' : 'The site could not be reached.')
  }

  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    const key = name.toLowerCase()
    if (!RESPONSE_DROP.has(key)) out.set(name, value)
  }
  // The reader should show the page's own address, not the proxy's; the network service consumes this header.
  out.set('x-tiny-url', upstream.url || target.href)
  out.set('x-tiny-proxy', '1')
  out.set('cache-control', 'no-store')
  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  })
}
