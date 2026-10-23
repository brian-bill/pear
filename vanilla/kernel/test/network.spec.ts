/** `tiny.network`: outbound HTTP and WebSocket through the page (`contracts/network.md`). */
import { expect, test } from './fixtures'

test.use({ system: true, helpers: true })
test.beforeEach(async ({ page }) => {
  await page.route('https://api.test/**', async (route) => {
    const url = new URL(route.request().url())
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (url.pathname === '/nocors') return route.abort('failed') // what the browser does when CORS blocks a response
    if (url.pathname === '/big') return route.fulfill({ status: 200, headers: { ...cors, 'content-length': String(300_000) }, body: 'x'.repeat(300_000) })
    if (url.pathname === '/missing') return route.fulfill({ status: 404, headers: cors, body: 'gone' })
    const body = route.request().postData()
    return route.fulfill({ status: 200, headers: { ...cors, 'x-echo': route.request().headers()['x-token'] ?? '', 'content-type': 'text/plain' }, body: `${route.request().method()} ${url.pathname}${body ? ` body=${body}` : ''}` })
  })
  await page.evaluate(() => void window.attachDrivers())
  await page.waitForTimeout(200)
})

test('the system can fetch; the response carries status, headers and bytes', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const dec = new TextDecoder()
    const get = await window.ask('network', { op: 'fetch', url: 'https://api.test/hello', init: { headers: { 'x-token': 'abc' } } })
    const post = await window.ask('network', { op: 'fetch', url: 'https://api.test/save', init: { method: 'post', body: 'data' } })
    const missing = await window.ask('network', { op: 'fetch', url: 'https://api.test/missing' })
    const bad = await window.ask('network', { op: 'fetch', url: 'file:///etc/passwd' })
    const junk = await window.ask('network', { op: 'fetch', url: 'not a url' })
    return {
      get: [get.status, get.headers['x-echo'], dec.decode(get.body)], post: dec.decode(post.body), missing: [missing.status, dec.decode(missing.body)], bad, junk,
      status: await window.ask('network', { op: 'status' }),
    }
  })
  expect(out.get).toEqual([200, 'abc', 'GET /hello'])
  expect(out.post).toBe('POST /save body=data')
  expect(out.missing).toEqual([404, 'gone'])
  expect(out.bad).toEqual({ error: 'EINVAL' })
  expect(out.junk).toEqual({ error: 'EINVAL' })
  expect(out.status.online).toBe(true)
})

test('a response the browser hides (CORS) is an EACCES with a hint; offline is ENETUNREACH', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const reply = async (msg: object) => ((await k.request(await k.lookup('tiny.network'), msg, { timeout: 8000 })).data as any)
    const cors = await reply({ op: 'fetch', url: 'https://api.test/nocors' })
    const inbox = await window.inbox()
    await window.ask('network', { op: 'subscribe' }, [inbox.port])
    await k.driverPush('network', { event: 'online', online: false })
    const offline = await reply({ op: 'fetch', url: 'https://api.test/hello' })
    await k.driverPush('network', { event: 'online', online: true, connection: { effectiveType: '4g' } })
    const events = (await inbox.all(300)).map((e) => e.type)
    return { cors: [cors.error.code, /CORS/.test(cors.error.message)], offline: offline.error.code, events, status: await window.ask('network', { op: 'status' }) }
  })
  expect(out.cors).toEqual(['EACCES', true])
  expect(out.offline).toBe('ENETUNREACH')
  expect(out.events).toEqual(['offline', 'online'])
  expect(out.status).toEqual({ online: true, effectiveType: '4g' })
})

test('apps need the network capability, then the user\'s rule for that app and host; usage is counted per app', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask } = window
    const fetcher = (url: string) => `export default async (tiny) => {
      const r = (await tiny.request(await tiny.lookup('tiny.network'), { op: 'fetch', url: '${url}' }, { timeout: 8000 })).data
      await tiny.writeFile('/tmp/org.test.web.out', new TextEncoder().encode(JSON.stringify(r.ok ? r.result.status : r.error.code)))
    }`
    // not granted: the prompt hook is off, so the request is refused
    const refused = await window.runApp('org.test.web', fetcher('https://api.test/hello'), { permissions: ['network'] }, false)
    await window.kernel.permGrant('org.test.web', 'network')
    const allowed = await window.runApp('org.test.web', fetcher('https://api.test/hello'))
    await ask('network', { op: 'rules.set', appId: 'org.test.web', rule: { mode: 'allow', hosts: ['*.other.test'] } })
    const wrongHost = await window.runApp('org.test.web', fetcher('https://api.test/hello'))
    await ask('network', { op: 'rules.set', appId: 'org.test.web', rule: { mode: 'allow', hosts: ['*.test'] } })
    const rightHost = await window.runApp('org.test.web', fetcher('https://api.test/hello'))
    await ask('network', { op: 'rules.set', appId: 'org.test.web', rule: { mode: 'deny' } })
    const denied = await window.runApp('org.test.web', fetcher('https://api.test/hello'))
    const rules = await ask('network', { op: 'rules.list' })
    const usage = await ask('network', { op: 'usage', appId: 'org.test.web' })
    await ask('network', { op: 'rules.set', appId: 'org.test.web', rule: null })
    return { refused, allowed, wrongHost, rightHost, denied, rules, usage, after: await ask('network', { op: 'rules.list' }) }
  })
  expect(out).toMatchObject({ refused: 'EPERM', allowed: 200, wrongHost: 'EACCES', rightHost: 200, denied: 'EACCES', after: {} })
  expect(out.rules['org.test.web']).toEqual({ mode: 'deny' })
  expect(out.usage.requests).toBe(2)
  expect(out.usage.bytesIn).toBeGreaterThan(0)
})

test('a download streams into ~/Downloads with progress; apps may not write elsewhere; cancel removes the file', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    const inbox = await window.inbox()
    const started = await ask('network', { op: 'download', url: 'https://api.test/big', dest: '/Users/pear/Downloads/big.bin' }, [inbox.port])
    const events = await inbox.all(800)
    const st = await kernel.stat('/Users/pear/Downloads/big.bin')
    const failed = await ask('network', { op: 'download', url: 'https://api.test/missing', dest: '/Users/pear/Downloads/m.bin' }, [inbox.port])
    const errEvents = await inbox.all(300)
    const app = await window.runApp('org.test.dl', `export default async (tiny) => {
      const port = await tiny.lookup('tiny.network')
      const r = (await tiny.request(port, { op: 'download', url: 'https://api.test/big', dest: '/Users/pear/Documents/x.bin' })).data
      await tiny.writeFile('/tmp/org.test.dl.out', new TextEncoder().encode(JSON.stringify(r.ok ? 'ok' : r.error.code)))
    }`, { permissions: ['network'] }, true)
    return {
      started: started.status, total: started.total,
      last: events[events.length - 1], progress: events.filter((e) => e.type === 'progress').length > 0, size: st.size, owner: st.uid,
      failed, errEvents, exists: await kernel.exists('/Users/pear/Downloads/m.bin'), app, listed: await ask('network', { op: 'downloads' }),
    }
  })
  expect(out.started).toBe(200)
  expect(out.total).toBe(300000)
  expect(out.last).toMatchObject({ type: 'done', size: 300000 })
  expect(out.progress).toBe(true)
  expect(out.size).toBe(300000)
  expect(out.owner).toBe(501)
  expect(out.failed).toEqual({ error: 'EIO' })
  expect(out.exists).toBe(false)
  expect(out.app).toBe('EACCES')
  expect(out.listed).toEqual([])
})

test('a proxy rewrites requests; upload sends a file; the setting is validated', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    const dec = new TextDecoder()
    await kernel.writeFile('/Users/pear/Downloads/up.txt', new TextEncoder().encode('file contents'))
    const up = await ask('network', { op: 'upload', path: '/Users/pear/Downloads/up.txt', url: 'https://api.test/upload' })
    const bad = await ask('network', { op: 'proxy.set', url: 'ftp://nope' })
    await ask('network', { op: 'proxy.set', url: 'https://api.test/proxy?u=' })
    const proxied = await ask('network', { op: 'fetch', url: 'https://example.org/page' })
    await ask('network', { op: 'proxy.set', url: '' })
    return { up: dec.decode(up.body), bad, proxied: dec.decode(proxied.body), get: await ask('network', { op: 'proxy.get' }) }
  })
  expect(out.up).toBe('POST /upload body=file contents')
  expect(out.bad).toEqual({ error: 'EINVAL' })
  expect(out.proxied).toBe('GET /proxy')
  expect(out.get).toBe('')
})

test('a per-request proxy overrides the setting; the built-in fallback is marked and reports the final URL', async ({ page }) => {
  let seen: { url: string; marked: string | undefined } | null = null
  await page.route('**/api/proxy**', async (route) => {
    const url = new URL(route.request().url())
    seen = { url: url.searchParams.get('url') ?? '', marked: route.request().headers()['x-tiny-proxy'] }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html', 'x-tiny-url': 'https://example.org/final' },
      body: '<title>proxied</title>',
    })
  })
  await page.route('https://proxy.test/**', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' },
      body: url.searchParams.get('u') ?? '',
    })
  })
  const out = await page.evaluate(async () => {
    const dec = new TextDecoder()
    const res = await window.ask('network', { op: 'fetch', url: 'https://example.org/start', proxy: '/api/proxy?url=' })
    const override = await window.ask('network', { op: 'fetch', url: 'https://example.org/other', proxy: 'https://proxy.test/p?u=' })
    const bad = await window.ask('network', { op: 'fetch', url: 'https://example.org/', proxy: 'ftp://nope' })
    return { body: dec.decode(res.body), url: res.url, redirected: res.redirected, hidden: res.headers['x-tiny-url'], override: dec.decode(override.body), bad }
  })
  expect(seen).toEqual({ url: 'https://example.org/start', marked: '1' })
  expect(out.body).toBe('<title>proxied</title>')
  expect(out.url).toBe('https://example.org/final')
  expect(out.redirected).toBe(true)
  expect(out.hidden).toBeUndefined()
  expect(out.override).toBe('https://example.org/other')
  expect(out.bad).toEqual({ error: 'EINVAL' })
})

test('websockets deliver messages and close to the owner\'s port', async ({ page }) => {
  await page.routeWebSocket('wss://sock.test/echo', (ws) => {
    ws.onMessage((m) => ws.send(typeof m === 'string' ? `echo:${m}` : m))
    ws.onClose(() => ws.close())
  })
  const out = await page.evaluate(async () => {
    const { ask } = window
    const inbox = await window.inbox()
    const opened = await ask('network', { op: 'websocket', url: 'wss://sock.test/echo' }, [inbox.port])
    await ask('network', { op: 'ws.send', socket: opened.socket, data: 'hi' })
    await ask('network', { op: 'ws.send', socket: opened.socket, data: new Uint8Array([1, 2, 3]) })
    const msgs = await inbox.all(500)
    await ask('network', { op: 'ws.close', socket: opened.socket })
    const closed = await inbox.next(1000)
    const gone = await ask('network', { op: 'ws.send', socket: opened.socket, data: 'x' })
    const refused = await ask('network', { op: 'websocket', url: 'wss://nobody.invalid/' }, [inbox.port])
    return { opened: typeof opened.socket, msgs: msgs.map((m) => m.type + ':' + (typeof m.data === 'string' ? m.data : Array.from(m.data as Uint8Array).join(','))), closed: closed?.type, gone, refused }
  })
  expect(out.opened).toBe('number')
  expect(out.msgs).toEqual(['message:echo:hi', 'message:1,2,3'])
  expect(out.closed).toBe('close')
  expect(out.gone).toEqual({ error: 'ENOENT' })
  expect(out.refused).toMatchObject({ error: expect.stringMatching(/EACCES|ENETUNREACH/) })
})
