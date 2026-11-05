import { Owners, callerInfo, fail, needCapability, needPort, serve } from './lib'
import type { Pear } from '../src/runtime'

/** A program that serves HTTP on the in-OS loopback. */
interface Server {
  port: number
  owner: number
  appId: string | null
  /** The port the owner receives requests on (the service holds a send right to it). */
  handler: number
  since: number
}

const MAX_BODY = 64 * 1024 * 1024
const MAX_HEADERS = 100
const MAX_PATH = 8192
const PER_OWNER = 16
const FIRST_FREE = 49152
const DEFAULT_TIMEOUT = 30_000
const METHOD = /^[A-Za-z]{1,16}$/
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])
const enc = new TextEncoder()

/**
 * `tiny.loopback`: inbound HTTP between programs on this device, with no network.
 * A browser tab cannot listen on a port, so a program that wants to serve HTTP registers a port here and receives
 * `{type: 'http', method, path, headers, body}` requests on a port it owns, answering each with
 * `{status, statusText?, headers, body}`. Desktop's page relays requests for `/__loopback/<port>/...` (served by a
 * ServiceWorker) here, and programs can call each other with `request`. Nothing leaves the device.
 *
 *   listen {port?} + rights [handlerPort]  -> {port, url}     close {port}     list     request {port, method, path, ...}
 */
export default async (tiny: Pear) => {
  const servers = new Map<number, Server>()
  const owners = new Owners(tiny, (pid) => {
    for (const s of [...servers.values()]) if (s.owner === pid) servers.delete(s.port)
  })

  const urlOf = (port: number) => `/__loopback/${port}/`

  const freePort = (): number => {
    for (let p = FIRST_FREE; p < 65536; p++) if (!servers.has(p)) return p
    throw fail('EADDRINUSE', 'no free loopback port')
  }

  const bytesOf = (v: unknown, what: string): Uint8Array => {
    if (v === undefined || v === null) return new Uint8Array(0)
    if (typeof v === 'string') return enc.encode(v)
    if (v instanceof Uint8Array) return v
    if (v instanceof ArrayBuffer) return new Uint8Array(v)
    throw fail('EINVAL', `${what} must be text or bytes`)
  }

  const headerList = (v: unknown, what: string): Array<[string, string]> => {
    if (v === undefined || v === null) return []
    const pairs = Array.isArray(v) ? v : typeof v === 'object' ? Object.entries(v as Record<string, unknown>) : null
    if (!pairs || pairs.length > MAX_HEADERS) throw fail('EINVAL', `${what} must be a list of [name, value] pairs (at most ${MAX_HEADERS})`)
    return pairs.map((p) => {
      if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p[0])) throw fail('EINVAL', `${what} has a bad header`)
      return [p[0].toLowerCase(), p[1]]
    })
  }

  return serve(tiny, 'tiny.loopback', {
    listen: async (a, m) => {
      await needCapability(tiny, m, 'loopback', 'run a local server')
      const handler = needPort(m, 'pass the port requests should arrive on in rights')
      let port = a.port
      if (port === undefined || port === null || port === 0) port = freePort()
      else if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('EINVAL', 'port must be 1 to 65535')
      if (servers.has(port)) throw fail('EADDRINUSE', `port ${port} is in use`)
      if ([...servers.values()].filter((s) => s.owner === m.from).length >= PER_OWNER) throw fail('EMFILE', `at most ${PER_OWNER} servers per process`)
      const who = await callerInfo(tiny, m)
      owners.add(m.from)
      servers.set(port, { port, owner: m.from, appId: who.appId, handler, since: Date.now() })
      return { port, url: urlOf(port) }
    },

    close: async (a, m) => {
      const s = servers.get(a.port)
      if (!s) throw fail('ENOENT', `nothing is listening on ${String(a.port)}`)
      if (s.owner !== m.from && !(await callerInfo(tiny, m)).system) throw fail('EPERM', 'not your server')
      servers.delete(s.port)
    },

    list: async (_a, m) => {
      const who = await callerInfo(tiny, m)
      return [...servers.values()]
        .filter((s) => who.system || s.owner === m.from || (who.appId !== null && s.appId === who.appId))
        .map((s) => ({ port: s.port, owner: s.owner, appId: s.appId, url: urlOf(s.port), since: s.since }))
        .sort((x, y) => x.port - y.port)
    },

    request: async (a, m) => {
      await needCapability(tiny, m, 'loopback', 'connect to local servers')
      const server = servers.get(a.port)
      if (!server) throw fail('ECONNREFUSED', `nothing is listening on port ${String(a.port)}`)
      const method = typeof a.method === 'string' ? a.method.toUpperCase() : 'GET'
      if (!METHOD.test(method)) throw fail('EINVAL', 'bad method')
      const path = typeof a.path === 'string' ? a.path : '/'
      if (!path.startsWith('/') || path.length > MAX_PATH || /[\r\n\0]/.test(path)) throw fail('EINVAL', 'path must start with / and be a plain path')
      const headers = headerList(a.headers, 'headers').filter(([k]) => !HOP_BY_HOP.has(k))
      const body = bytesOf(a.body, 'body')
      if (body.byteLength > MAX_BODY) throw fail('E2BIG', 'the request body is larger than 64 MB')
      const who = await callerInfo(tiny, m)
      const timeout = typeof a.timeout === 'number' && a.timeout > 0 ? Math.min(a.timeout, 120_000) : DEFAULT_TIMEOUT
      let answer: any
      try {
        answer = (await tiny.request(server.handler, { type: 'http', method, path, headers, body, remote: who.system ? 'system' : (who.appId ?? `pid:${m.from}`) }, { timeout })).data
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'EPIPE' || code === 'EACCES') {
          servers.delete(server.port) // its owner is gone
          throw fail('ECONNREFUSED', `the server on port ${server.port} is gone`)
        }
        if (code === 'ETIMEDOUT') throw fail('ETIMEDOUT', `the server on port ${server.port} did not answer`)
        throw e
      }
      if (!answer || typeof answer !== 'object' || !Number.isInteger(answer.status) || answer.status < 100 || answer.status > 599) {
        throw fail('EIO', `the server on port ${server.port} sent a malformed response`)
      }
      const out = bytesOf(answer.body, 'response body')
      if (out.byteLength > MAX_BODY) throw fail('E2BIG', 'the response body is larger than 64 MB')
      return {
        status: answer.status as number,
        statusText: typeof answer.statusText === 'string' ? answer.statusText : '',
        headers: headerList(answer.headers, 'response headers').filter(([k]) => !HOP_BY_HOP.has(k)),
        body: out,
      }
    },
  })
}
