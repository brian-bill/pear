/// `net` for programs: the same object windows get from the SDK, over the network service (`tiny.network`).
/// `net.fetch` resolves to a standard `Response`; HTTP error statuses are responses, not exceptions.
/// The program needs the `network` permission (the user is asked on first use).

export interface NetStatus {
  online: boolean
  effectiveType?: string
  downlink?: number
  saveData?: boolean
}

type NetInit = RequestInit & { /** http(s) base URL or root-relative path for this one request */ proxy?: string; /** ms, default 30000 */ timeout?: number }
type NetReply = { status: number; statusText: string; headers: Record<string, string> | Array<[string, string]>; url: string; redirected: boolean; body: Uint8Array }

interface Caller {
  lookup(name: string): Promise<number>
  request(port: number, data: unknown, opts?: { timeout?: number }): Promise<{ data: unknown }>
}

async function body(init?: NetInit): Promise<Record<string, unknown> | undefined> {
  if (!init) return undefined
  const { body: b, headers, proxy: _p, timeout: _t, signal: _s, ...rest } = init
  const out: Record<string, unknown> = { ...rest }
  if (headers) out.headers = Object.fromEntries(new Headers(headers as HeadersInit).entries())
  if (b !== undefined && b !== null) {
    if (typeof b === 'string' || b instanceof Uint8Array) out.body = b
    else out.body = new Uint8Array(await new Response(b as BodyInit).arrayBuffer())
  }
  return out
}

export function makeNet(tiny: Caller) {
  const call = async <T>(msg: Record<string, unknown>, timeout = 15_000): Promise<T> => {
    const port = await tiny.lookup('tiny.network')
    const reply = (await tiny.request(port, msg, { timeout })).data as { ok: boolean; result?: T; error?: { code: string; message: string } }
    if (!reply.ok) throw Object.assign(new Error(reply.error?.message ?? 'the network service failed'), { code: reply.error?.code ?? 'EIO' })
    return reply.result as T
  }
  const headersOf = (r: NetReply) => new Headers(Array.isArray(r.headers) ? r.headers : Object.entries(r.headers ?? {}))
  const net = {
    async fetch(input: string | URL | Request, init?: NetInit): Promise<Response> {
      const req = input instanceof Request ? input : null
      const url = req ? req.url : String(input)
      const merged = req
        ? { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer().then((b) => new Uint8Array(b)), ...init }
        : init
      const r = await call<NetReply>({ op: 'fetch', url, init: await body(merged), timeout: init?.timeout, proxy: init?.proxy }, (init?.timeout ?? 30_000) + 3000)
      const nullBody = [101, 204, 205, 304].includes(r.status)
      const res = new Response(nullBody ? null : (r.body as BodyInit), { status: r.status, statusText: r.statusText, headers: headersOf(r) })
      Object.defineProperty(res, 'url', { value: r.url })
      Object.defineProperty(res, 'redirected', { value: r.redirected })
      return res
    },
    status: () => call<NetStatus>({ op: 'status' }),
    /** Calls `fn` when the connection goes online or offline (checked every 2 s). Returns an unsubscribe function. */
    subscribe(fn: (e: { type: 'online' | 'offline'; status: Promise<NetStatus> }) => void): () => void {
      let last: boolean | null = null
      const timer = setInterval(() => {
        void net.status().then((s) => {
          if (last !== null && s.online !== last) fn({ type: s.online ? 'online' : 'offline', status: Promise.resolve(s) })
          last = s.online
        }, () => {})
      }, 2000)
      return () => clearInterval(timer)
    },
    /** Save `url` to `dest` (the app's container or ~/Downloads). */
    async download(url: string, dest: string, init?: RequestInit): Promise<{ id: number; status: number; total: number | null }> {
      return call({ op: 'download', url, dest, init: await body(init) }, 10 * 60_000)
    },
    /** Send the file at `path` to `url`. */
    async upload(path: string, url: string, init?: RequestInit): Promise<Response> {
      const r = await call<NetReply>({ op: 'upload', path, url, init: await body(init) }, 5 * 60_000)
      return new Response(r.body as BodyInit, { status: r.status, statusText: r.statusText, headers: headersOf(r) })
    },
  }
  return net
}

/** What `tiny.net` is. */
export type PearNetApi = ReturnType<typeof makeNet>
