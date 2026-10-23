import { Owners, Subscribers, callerInfo, fail, hostBridge, needCapability, needPort, needSystem, serve, subscription } from './lib'
import type { Pear } from '../src/runtime'

interface Rule {
  mode: 'allow' | 'deny'
  /** With `allow`: only these hosts (`example.com`, `*.example.com`). Empty means any. */
  hosts?: string[]
}

interface Usage {
  bytesIn: number
  bytesOut: number
  requests: number
}

interface Socket {
  id: number
  owner: number
  appId: string | null
  port: number
  url: string
}

interface Stream {
  appId: string | null
  caller: number
  path: string
  fd: number
  port: number | null
  received: number
  total: number | null
  uid: number
  gid: number
  done: (e?: Error) => void
  chain: Promise<void>
  cancelled: boolean
}

const MAX_BODY = 64 * 1024 * 1024
const MAX_SOCKETS_PER_PROCESS = 16
const MAX_STREAMS = 8
const O_WRONLY = 1
const O_CREAT = 0x40
const O_TRUNC = 0x200
const dec = new TextDecoder()

const hostMatches = (host: string, pattern: string) =>
  pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern

/**
 * `tiny.network`: outbound HTTP and WebSocket for apps (`contracts/network.md`). Processes cannot reach the network
 * themselves (their sandbox forbids it), so every request goes through this service, which checks the `network`
 * capability and the user's per-app rules, and asks the page's driver to do the actual fetch. Browser limits apply:
 * CORS, mixed content, no raw sockets.
 */
export default async (tiny: Pear) => {
  const watchers = new Subscribers<{ port: number }>(tiny)
  const bridge = hostBridge(tiny, 'network')
  const usage = new Map<string, Usage>() // by app id, or `pid:<n>` outside any app
  const sockets = new Map<number, Socket>()
  const streams = new Map<number, Stream>()
  let nextId = 1
  let online = true
  let connection: Record<string, unknown> | null = null

  const owners = new Owners(tiny, async (pid) => {
    for (const s of [...sockets.values()]) if (s.owner === pid) await closeSocket(s, 1001, true)
    for (const [id, st] of [...streams]) if (st.caller === pid) await endStream(id, new Error('the caller exited'))
  })

  const account = (key: string, field: keyof Usage, n: number) => {
    const u = usage.get(key) ?? { bytesIn: 0, bytesOut: 0, requests: 0 }
    u[field] += n
    usage.set(key, u)
  }
  const keyOf = (who: { appId: string | null }, pid: number) => who.appId ?? `pid:${pid}`

  const rules = async () => ((await tiny.configGet('tiny.network', 'rules', {})) ?? {}) as unknown as Record<string, Rule>

  const authorize = async (m: { from: number }, urlText: string): Promise<{ url: URL; who: { system: boolean; appId: string | null } }> => {
    let url: URL
    try {
      url = new URL(urlText)
    } catch {
      throw fail('EINVAL', 'not a valid URL')
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw fail('EINVAL', `${url.protocol} is not supported`)
    const who = await callerInfo(tiny, m as never)
    if (!who.system) {
      await needCapability(tiny, m as never, 'network', 'use the network')
      const rule = who.appId ? (await rules())[who.appId] : undefined
      if (rule?.mode === 'deny') throw fail('EACCES', `network access for ${who.appId} is turned off`)
      if (rule?.mode === 'allow' && rule.hosts?.length && !rule.hosts.some((h) => hostMatches(url.hostname, h))) {
        throw fail('EACCES', `${who.appId} may not connect to ${url.hostname}`)
      }
    }
    if (!online) throw fail('ENETUNREACH', 'the network is offline')
    return { url, who }
  }

  /**
   * A proxy base: the request's own (root-relative) fallback, or the configured absolute one. Safari uses the
   * root-relative `/api/proxy?url=` when the browser refuses a cross-origin read; an app may also name any http(s)
   * proxy, and the settings apply when neither is given.
   */
  const proxyBase = async (override?: unknown): Promise<string> => {
    if (override !== undefined && override !== null && override !== '') {
      if (typeof override !== 'string') throw fail('EINVAL', 'proxy must be an http(s) URL or a path')
      if (override.startsWith('/') && !override.startsWith('//')) return override
      try {
        const u = new URL(override)
        if (u.protocol === 'http:' || u.protocol === 'https:') return override
      } catch {
        // not an absolute URL: report it below
      }
      throw fail('EINVAL', 'proxy must be an http(s) URL or a path')
    }
    return String(await tiny.configGet('tiny.network', 'proxy', ''))
  }

  const proxied = async (url: URL, override?: unknown) => {
    const proxy = await proxyBase(override)
    return proxy ? `${proxy}${encodeURIComponent(url.href)}` : url.href
  }

  /** The proxy this project ships (`/api/proxy`, or its absolute form in a custom setting), as opposed to a third-party one. */
  const isBuiltinProxy = (base: string): boolean => {
    try {
      return new URL(base, 'http://tiny.invalid').pathname === '/api/proxy'
    } catch {
      return false
    }
  }

  /** Our own `/api/proxy` needs to know the request came from `tiny.network`, not from a random page. */
  const withProxyHeader = <T extends { headers: Record<string, string> }>(init: T, base: string): T => {
    delete init.headers['x-tiny-proxy']
    if (isBuiltinProxy(base)) init.headers['x-tiny-proxy'] = '1'
    return init
  }

  /** A proxied response carries the page's final address in `x-tiny-url`; keep the header out of the app's view. */
  const finalUrl = (res: any, base: string, asked: string) => {
    if (!isBuiltinProxy(base) || !res || typeof res !== 'object' || !res.headers) return res
    const seen = res.headers['x-tiny-url']
    delete res.headers['x-tiny-url']
    if (typeof seen === 'string' && seen) {
      res.url = seen
      res.redirected = seen !== asked
    }
    return res
  }

  const toBytes = (body: unknown): Uint8Array | string | undefined => {
    if (body === undefined || body === null) return undefined
    if (typeof body === 'string' || body instanceof Uint8Array) {
      if ((typeof body === 'string' ? body.length : body.length) > MAX_BODY) throw fail('EFBIG', 'the request body is too large')
      return body
    }
    throw fail('EINVAL', 'body must be text or bytes')
  }

  const initOf = (init: unknown) => {
    const i = (init ?? {}) as Record<string, any>
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(i.headers ?? {})) headers[k] = String(v)
    return {
      method: typeof i.method === 'string' ? i.method.toUpperCase() : 'GET',
      headers,
      body: toBytes(i.body),
      credentials: i.credentials === 'include' ? 'include' : 'omit',
      redirect: ['follow', 'error', 'manual'].includes(i.redirect) ? i.redirect : 'follow',
      mode: 'cors',
      cache: typeof i.cache === 'string' ? i.cache : 'default',
    }
  }

  const netError = (e: unknown): never => {
    const err = e as { code?: string; message?: string }
    if (err.code === 'ENOSYS' || err.code === 'ETIMEDOUT' || err.code === 'ECANCELED') throw e
    if (!online) throw fail('ENETUNREACH', 'the network is offline')
    throw fail('EACCES', `${err.message ?? 'the request failed'} (the server may not allow this site to read it: CORS, or mixed content)`)
  }

  // ---- downloads: the page streams chunks in, the service writes them out

  const home = async () => {
    try {
      for (const line of dec.decode(await tiny.readFile('/etc/passwd')).split('\n')) {
        const [name, , uid, gid, dir] = line.split(':')
        if (name && uid !== '0') return { dir: dir!, uid: Number(uid), gid: Number(gid) }
      }
    } catch {
      // no passwd yet
    }
    return { dir: '/var/root', uid: 0, gid: 0 }
  }

  /** Apps reach the downloads folder and their own container; the system, anywhere. */
  const placeOk = async (path: string, who: { system: boolean; appId: string | null }) => {
    if (!path.startsWith('/') || path.includes('/../') || path.endsWith('/..')) return false
    if (who.system) return true
    const h = await home()
    return path.startsWith(`${h.dir}/Downloads/`) || (who.appId !== null && path.startsWith(`${h.dir}/Library/Containers/${who.appId}/`))
  }

  const endStream = async (id: number, err?: Error, fromChain = false) => {
    const st = streams.get(id)
    if (!st) return
    streams.delete(id)
    st.cancelled = true
    if (!fromChain) await st.chain.catch(() => {}) // writes already queued finish first
    await tiny.close(st.fd).catch(() => {})
    if (err) await tiny.unlink(st.path).catch(() => {})
    else await tiny.chown(st.path, st.uid, st.gid).catch(() => {})
    if (st.port !== null) {
      await tiny.send(st.port, err ? { type: 'error', id, code: (err as { code?: string }).code ?? 'EIO', message: err.message } : { type: 'done', id, path: st.path, size: st.received }).catch(() => {})
    }
    st.done(err)
  }

  /** Ask the page to close it. The socket stays known until the page reports `close`, so its owner hears about it; an owner that is gone is not waited for. */
  const closeSocket = async (s: Socket, code = 1000, ownerGone = false) => {
    if (ownerGone) sockets.delete(s.id)
    await bridge.emit('wsClose', { socket: s.id, code }).catch(() => {})
  }

  const mine = async (id: unknown, m: { from: number }): Promise<Socket> => {
    const s = sockets.get(id as number)
    if (!s) throw fail('ENOENT', 'no such socket')
    if (s.owner !== m.from && !(await callerInfo(tiny, m as never)).system) throw fail('EPERM', 'not your socket')
    return s
  }

  const startDownload = async (a: Record<string, any>, m: { from: number; rights: number[] }) => {
    const { url, who } = await authorize(m, String(a.url))
    if (typeof a.dest !== 'string' || !(await placeOk(a.dest, who))) throw fail('EACCES', 'downloads go to ~/Downloads or the app\'s own container')
    if (streams.size >= MAX_STREAMS) throw fail('EMFILE', 'too many downloads at once')
    const id = nextId++
    const h = await home()
    const fd = await tiny.open(a.dest, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    const st: Stream = { appId: who.appId, caller: m.from, path: a.dest, fd, port: m.rights[0] ?? null, received: 0, total: null, uid: h.uid, gid: h.gid, done: () => {}, chain: Promise.resolve(), cancelled: false }
    streams.set(id, st)
    const finished = new Promise<void>((resolve, reject) => (st.done = (e) => (e ? reject(e) : resolve())))
    finished.catch(() => {})
    let head: { status: number; statusText?: string; total?: number | null }
    try {
      const base = await proxyBase(a.proxy)
      head = await bridge.call('stream', { stream: id, url: await proxied(url, a.proxy), init: withProxyHeader(initOf(a.init), base) }, a.timeout ?? 30_000)
    } catch (e) {
      await endStream(id, e as Error)
      return netError(e)
    }
    st.total = head.total ?? null
    account(keyOf(who, m.from), 'requests', 1)
    if (head.status >= 400) {
      const err = fail('EIO', `the server answered ${head.status} ${head.statusText ?? ''}`.trim())
      await bridge.emit('abort', { stream: id }).catch(() => {})
      await endStream(id, err)
      throw err
    }
    return { id, status: head.status, total: st.total, finished }
  }

  return serve(
    tiny,
    'tiny.network',
    {
      status: () => ({ online, ...(connection ?? {}) }),

      fetch: async (a, m) => {
        const { url, who } = await authorize(m, String(a.url))
        const base = await proxyBase(a.proxy)
        const init = withProxyHeader(initOf(a.init), base)
        const sent = init.body === undefined ? 0 : typeof init.body === 'string' ? init.body.length : init.body.length
        try {
          const res = await bridge.call('fetch', { url: await proxied(url, a.proxy), init, timeout: a.timeout ?? 30_000 }, (a.timeout ?? 30_000) + 2000)
          const key = keyOf(who, m.from)
          account(key, 'requests', 1)
          account(key, 'bytesOut', sent)
          account(key, 'bytesIn', (res.body as Uint8Array).length)
          return finalUrl(res, base, url.href)
        } catch (e) {
          return netError(e)
        }
      },

      download: async (a, m) => {
        const r = await startDownload(a, m)
        return { id: r.id, status: r.status, total: r.total }
      },
      /** Stop a download; the partial file is removed. */
      cancel: async (a, m) => {
        const st = streams.get(a.id)
        if (!st) return
        if (st.caller !== m.from && !(await callerInfo(tiny, m as never)).system) throw fail('EPERM', 'not your download')
        await bridge.emit('abort', { stream: a.id }).catch(() => {})
        await endStream(a.id, fail('ECANCELED', 'cancelled'))
      },
      downloads: () => [...streams].map(([id, s]) => ({ id, path: s.path, received: s.received, total: s.total, appId: s.appId })),

      upload: async (a, m) => {
        const who = await callerInfo(tiny, m as never)
        if (typeof a.path !== 'string' || !(await placeOk(a.path, who))) throw fail('EACCES', 'uploads read from ~/Downloads or the app\'s own container')
        const st = await tiny.stat(a.path)
        if (st.size > MAX_BODY) throw fail('EFBIG', 'the file is too large to upload')
        const data = await tiny.readFile(a.path)
        const { url } = await authorize(m, String(a.url))
        const base = await proxyBase(a.proxy)
        const init = withProxyHeader({ ...initOf(a.init), method: String(a.init?.method ?? 'POST').toUpperCase(), body: data }, base)
        try {
          const res = await bridge.call('fetch', { url: await proxied(url, a.proxy), init, timeout: a.timeout ?? 60_000 }, (a.timeout ?? 60_000) + 2000)
          const key = keyOf(who, m.from)
          account(key, 'requests', 1)
          account(key, 'bytesOut', data.length)
          account(key, 'bytesIn', (res.body as Uint8Array).length)
          return res
        } catch (e) {
          return netError(e)
        }
      },

      websocket: async (a, m) => {
        const { url, who } = await authorize(m, String(a.url))
        if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) throw fail('EINVAL', 'use a ws: or wss: URL')
        const port = needPort(m, 'pass a port for the socket\'s events in rights')
        if ([...sockets.values()].filter((s) => s.owner === m.from).length >= MAX_SOCKETS_PER_PROCESS) throw fail('EMFILE', 'too many sockets')
        owners.add(m.from)
        const socket: Socket = { id: nextId++, owner: m.from, appId: who.appId, port, url: url.href }
        sockets.set(socket.id, socket)
        const protocols = Array.isArray(a.protocols) ? a.protocols.map(String) : []
        try {
          const opened = await bridge.call('wsOpen', { socket: socket.id, url: url.href.replace(/^http/, 'ws'), protocols }, 10_000)
          account(keyOf(who, m.from), 'requests', 1)
          return { socket: socket.id, protocol: opened?.protocol ?? '' }
        } catch (e) {
          sockets.delete(socket.id)
          return netError(e)
        }
      },
      'ws.send': async (a, m) => {
        const s = await mine(a.socket, m)
        const n = typeof a.data === 'string' ? a.data.length : (a.data as Uint8Array).length
        account(keyOf({ appId: s.appId }, s.owner), 'bytesOut', n)
        await bridge.emit('wsSend', { socket: s.id, data: a.data })
      },
      'ws.close': async (a, m) => void (await closeSocket(await mine(a.socket, m), a.code ?? 1000)),

      // ---- rules, proxy and usage (Settings > Network)
      'rules.list': async (_a, m) => (await needSystem(tiny, m, 'read the network rules'), rules()),
      'rules.set': async (a, m) => {
        await needSystem(tiny, m, 'change the network rules')
        if (typeof a.appId !== 'string') throw fail('EINVAL', 'appId needed')
        const all = await rules()
        if (a.rule === null || a.rule === undefined) delete all[a.appId]
        else {
          if (!['allow', 'deny'].includes(a.rule.mode)) throw fail('EINVAL', 'mode is allow or deny')
          all[a.appId] = { mode: a.rule.mode, hosts: Array.isArray(a.rule.hosts) ? a.rule.hosts.map(String) : undefined }
        }
        await tiny.configSet('tiny.network', 'rules', all)
      },
      'proxy.set': async (a, m) => {
        await needSystem(tiny, m, 'set the proxy')
        const v = String(a.url ?? '')
        if (v && !/^https?:\/\//.test(v)) throw fail('EINVAL', 'the proxy must be an http(s) URL')
        await tiny.configSet('tiny.network', 'proxy', v)
      },
      'proxy.get': () => tiny.configGet('tiny.network', 'proxy', ''),
      usage: async (a, m) => {
        const who = await callerInfo(tiny, m as never)
        if (!who.system) return usage.get(keyOf(who, m.from)) ?? { bytesIn: 0, bytesOut: 0, requests: 0 }
        return a.appId ? (usage.get(a.appId) ?? { bytesIn: 0, bytesOut: 0, requests: 0 }) : Object.fromEntries(usage)
      },
      'usage.reset': async (_a, m) => (await needSystem(tiny, m, 'reset the counters'), usage.clear()),

      ...subscription(watchers),
    },
    async (d) => {
      const data = d?.type === 'driver' ? d.data : null
      if (!data || bridge.reply(data)) return
      switch (data.event) {
        case 'online':
          online = Boolean(data.online)
          connection = data.connection ?? connection
          await watchers.send({ type: online ? 'online' : 'offline', status: { online, ...(connection ?? {}) } })
          break
        case 'connection':
          connection = data.connection
          await watchers.send({ type: 'connection', status: { online, ...(connection ?? {}) } })
          break
        case 'chunk': {
          const st = streams.get(data.stream)
          if (!st || st.cancelled) return
          // writes happen in arrival order
          st.chain = st.chain.then(async () => {
            if (data.error) return void (await endStream(data.stream, fail('EIO', String(data.error)), true))
            if (data.data?.length) {
              await tiny.write(st.fd, data.data as Uint8Array)
              st.received += data.data.length
              account(keyOf({ appId: st.appId }, st.caller), 'bytesIn', data.data.length)
              if (st.port !== null) await tiny.send(st.port, { type: 'progress', id: data.stream, received: st.received, total: st.total }).catch(() => {})
            }
            if (data.done) await endStream(data.stream, undefined, true)
          }).catch(async (e) => void (await endStream(data.stream, e as Error, true)))
          break
        }
        case 'ws': {
          const s = sockets.get(data.socket)
          if (!s) return
          if (data.kind === 'message') account(keyOf({ appId: s.appId }, s.owner), 'bytesIn', typeof data.data === 'string' ? data.data.length : (data.data as Uint8Array).length)
          await tiny.send(s.port, { type: data.kind, socket: s.id, data: data.data, code: data.code, reason: data.reason }).catch(() => sockets.delete(s.id))
          if (data.kind === 'close') sockets.delete(s.id)
          break
        }
      }
    },
  )
}
