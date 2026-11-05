// Loopback bridge: a browser tab cannot listen on a port, so a program that serves HTTP
// registers with the `tiny.loopback` service, and this worker hands requests for `/__loopback/<port>/...` to the Desktop
// page, which asks that service and returns the answer. Nothing leaves the device. Every other request is left alone.
//
// Pages served from the bridge ask for their own files with absolute paths (`/style.css`); a request whose referrer is
// under `/__loopback/<port>/` and that is not itself a navigation is sent to that same port.
let host = null
const WAIT_HOST_MS = 1500
const REQUEST_MS = 40_000

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'loopback-host') host = event.source.id
})

const BRIDGE = /^\/__loopback\/(\d{1,5})(\/.*)?$/

function target(request) {
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return null
  const m = BRIDGE.exec(url.pathname)
  if (m) return { port: Number(m[1]), path: (m[2] || '/') + url.search }
  if (request.mode === 'navigate' || !request.referrer) return null
  try {
    const ref = BRIDGE.exec(new URL(request.referrer).pathname)
    if (ref && new URL(request.referrer).origin === self.location.origin) return { port: Number(ref[1]), path: url.pathname + url.search }
  } catch {
    // not a URL
  }
  return null
}

self.addEventListener('fetch', (event) => {
  const t = target(event.request)
  if (t) event.respondWith(relay(event.request, t))
})

async function findHost() {
  if (host) {
    const c = await self.clients.get(host)
    if (c) return c
    host = null
  }
  // this worker was restarted and forgot the page: ask the pages to announce themselves
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'loopback-announce' })
  const until = Date.now() + WAIT_HOST_MS
  while (!host && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  return host ? self.clients.get(host) : null
}

function page(status, title, text) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  return new Response(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:15px system-ui;margin:3em;max-width:34em"><h1 style="font-size:20px">${esc(title)}</h1><p>${esc(text)}</p>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const STATUS = { ECONNREFUSED: 502, ETIMEDOUT: 504, EPERM: 403, EACCES: 403, EINVAL: 400, E2BIG: 413 }

async function relay(request, t) {
  const client = await findHost()
  if (!client) return page(503, 'Pear is not running', 'Open Pear in a tab to reach programs that serve on this device.')
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer()
  const channel = new MessageChannel()
  const answer = new Promise((resolve) => {
    channel.port1.onmessage = (e) => resolve(e.data)
    setTimeout(() => resolve({ ok: false, code: 'ETIMEDOUT', message: 'Pear did not answer.' }), REQUEST_MS)
  })
  client.postMessage({ type: 'loopback-request', method: request.method, path: t.path, port: t.port, headers: [...request.headers], body }, body ? [channel.port2, body] : [channel.port2])
  const r = await answer
  if (!r.ok) {
    const code = r.code || 'EIO'
    return page(STATUS[code] || 500, code === 'ECONNREFUSED' ? `Nothing is listening on port ${t.port}` : 'The local server could not answer', r.message || code)
  }
  const nullBody = [101, 204, 205, 304].includes(r.status) || request.method === 'HEAD'
  return new Response(nullBody ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers })
}
