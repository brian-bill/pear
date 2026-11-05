/**
 * The loopback bridge (`tiny.loopback`): programs serve HTTP to each other and to Desktop's page with no network.
 * Requests arrive on a port the server owns; the service checks the `loopback` capability, routes, and enforces limits.
 */
import { expect, test } from './fixtures'

/** A server: listens (port from /tmp/want.json if present), reports the result to /tmp/lb-<name>.json, then answers requests. */
const SERVER = `export default async function (tiny) {
  const name = tiny.args[0] ?? 'a'
  const want = tiny.args[1] ? Number(tiny.args[1]) : undefined
  const handler = await tiny.portCreate()
  const svc = await tiny.lookup('tiny.loopback')
  const r = (await tiny.request(svc, { op: 'listen', port: want }, { rights: [handler] })).data
  await tiny.writeFile('/tmp/lb-' + name + '.json', new TextEncoder().encode(JSON.stringify(r.ok ? r.result : { error: r.error.code })))
  if (!r.ok) return 1
  const dec = new TextDecoder()
  for (;;) {
    const m = await tiny.receive(handler)
    const q = m.data
    if (q.path === '/silent') continue
    if (q.path === '/bad') { await tiny.send(m.replyTo, { status: 'x' }); continue }
    await tiny.send(m.replyTo, {
      status: q.path === '/missing' ? 404 : 200,
      statusText: q.path === '/missing' ? 'Not Found' : 'OK',
      headers: [['content-type', 'application/json'], ['x-seen-method', q.method], ['connection', 'close']],
      body: JSON.stringify({ method: q.method, path: q.path, headers: q.headers, body: dec.decode(q.body), remote: q.remote }),
    })
  }
}`

test.use({ system: true, helpers: true })

test.beforeEach(async ({ page }) => {
  await page.evaluate(async (server) => {
    await window.sh.install('/tmp/server.js', server)
  }, SERVER)
})

test('a program listens, and requests reach it and come back with status, headers and body', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, ask } = window
    const pid = await kernel.spawn('/tmp/server.js', { args: ['a'] })
    await sh.waitFor('/tmp/lb-a.json')
    const listened = JSON.parse(await sh.cat('/tmp/lb-a.json'))
    const get = await ask('loopback', { op: 'request', port: listened.port, method: 'get', path: '/hello?x=1' })
    const post = await ask('loopback', { op: 'request', port: listened.port, method: 'POST', path: '/p', headers: [['Content-Type', 'text/plain'], ['Host', 'evil'], ['connection', 'keep-alive']], body: 'ping' })
    const missing = await ask('loopback', { op: 'request', port: listened.port, path: '/missing' })
    const dec = new TextDecoder()
    await kernel.kill(pid, 'SIGKILL')
    return { listened, get: { ...get, body: JSON.parse(dec.decode(get.body)) }, post: { ...post, body: JSON.parse(dec.decode(post.body)) }, missing }
  })
  expect(out.listened.port).toBeGreaterThanOrEqual(49152)
  expect(out.listened.url).toBe(`/__loopback/${out.listened.port}/`)
  expect(out.get.status).toBe(200)
  expect(out.get.statusText).toBe('OK')
  expect(out.get.headers).toEqual([['content-type', 'application/json'], ['x-seen-method', 'GET']]) // hop-by-hop headers are dropped
  expect(out.get.body).toMatchObject({ method: 'GET', path: '/hello?x=1', body: '', remote: 'system' })
  // request headers are lower-cased and the hop-by-hop ones never reach the server
  expect(out.post.body).toMatchObject({ method: 'POST', body: 'ping', headers: [['content-type', 'text/plain']] })
  expect(out.missing).toMatchObject({ status: 404, statusText: 'Not Found' })
})

test('ports: explicit, in use, invalid, free again when the owner closes or exits', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, ask } = window
    const a = await kernel.spawn('/tmp/server.js', { args: ['a', '8080'] })
    await sh.waitFor('/tmp/lb-a.json')
    const first = JSON.parse(await sh.cat('/tmp/lb-a.json'))
    const b = await kernel.spawn('/tmp/server.js', { args: ['b', '8080'] })
    await sh.waitFor('/tmp/lb-b.json')
    const second = JSON.parse(await sh.cat('/tmp/lb-b.json'))
    await kernel.wait(b)
    const bad = []
    for (const p of [70000, -1, 1.5, 'x']) {
      await sh.install('/tmp/bad.js', `export default async function (tiny) { const h = await tiny.portCreate(); const s = await tiny.lookup('tiny.loopback'); const r = (await tiny.request(s, { op: 'listen', port: ${JSON.stringify(p)} }, { rights: [h] })).data; await tiny.writeFile('/tmp/bad.out', new TextEncoder().encode(JSON.stringify(r.ok ? 'ok' : r.error.code))) }`)
      await sh.run('/tmp/bad.js')
      bad.push(await sh.cat('/tmp/bad.out'))
    }
    const listed = (await ask('loopback', { op: 'list' })).map((s: { port: number }) => s.port)
    const closedByStranger = await ask('loopback', { op: 'close', port: 9 })
    await kernel.kill(a, 'SIGKILL')
    // the service notices the owner is gone within its sweep, or on the next request to the dead handler
    let refused = ''
    for (let i = 0; i < 40 && refused !== 'ECONNREFUSED'; i++) {
      refused = (await ask('loopback', { op: 'request', port: 8080, path: '/' }))?.error ?? ''
      if (refused !== 'ECONNREFUSED') await sh.sleep(100)
    }
    const listedAfter = (await ask('loopback', { op: 'list' })).map((s: { port: number }) => s.port)
    return { first, second, bad, listed, closedByStranger, refused, listedAfter }
  })
  expect(out.first.port).toBe(8080)
  expect(out.second).toEqual({ error: 'EADDRINUSE' })
  expect(out.bad).toEqual(['"EINVAL"', '"EINVAL"', '"EINVAL"', '"EINVAL"'])
  expect(out.listed).toEqual([8080])
  expect(out.closedByStranger).toEqual({ error: 'ENOENT' })
  expect(out.refused).toBe('ECONNREFUSED')
  expect(out.listedAfter).toEqual([])
})

test('a server that never answers times out; one that answers nonsense is an I/O error; unknown ports are refused', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, ask } = window
    const pid = await kernel.spawn('/tmp/server.js', { args: ['a'] })
    await sh.waitFor('/tmp/lb-a.json')
    const { port } = JSON.parse(await sh.cat('/tmp/lb-a.json'))
    const r = {
      silent: await ask('loopback', { op: 'request', port, path: '/silent', timeout: 300 }),
      bad: await ask('loopback', { op: 'request', port, path: '/bad' }),
      nobody: await ask('loopback', { op: 'request', port: 5, path: '/' }),
      badPath: await ask('loopback', { op: 'request', port, path: 'no-slash' }),
      badMethod: await ask('loopback', { op: 'request', port, method: 'GE T', path: '/' }),
      badHeaders: await ask('loopback', { op: 'request', port, path: '/', headers: [['bad name', 'x']] }),
      unknownOp: await ask('loopback', { op: 'frobnicate' }),
    }
    await kernel.kill(pid, 'SIGKILL')
    return r
  })
  expect(out.silent).toEqual({ error: 'ETIMEDOUT' })
  expect(out.bad).toEqual({ error: 'EIO' })
  expect(out.nobody).toEqual({ error: 'ECONNREFUSED' })
  expect(out.badPath).toEqual({ error: 'EINVAL' })
  expect(out.badMethod).toEqual({ error: 'EINVAL' })
  expect(out.badHeaders).toEqual({ error: 'EINVAL' })
  expect(out.unknownOp).toEqual({ error: 'ENOSYS' })
})

test('apps need the loopback capability to serve or connect; they see only their own servers', async ({ page }) => {
  const out = await page.evaluate(async (server) => {
    const { kernel, sh, ask } = window
    // an app that declares and is granted loopback serves; one that did not declare it is refused
    await sh.app('org.test.serves', server, { permissions: ['loopback'] }, true)
    await sh.app('org.test.nope', server)
    await kernel.launchOpen('org.test.serves', { args: ['a'] })
    await sh.waitFor('/tmp/lb-a.json')
    const served = JSON.parse(await sh.cat('/tmp/lb-a.json'))
    await kernel.launchOpen('org.test.nope', { args: ['b'] }).catch(() => {})
    await sh.waitFor('/tmp/lb-b.json')
    const refused = JSON.parse(await sh.cat('/tmp/lb-b.json'))
    // a granted app that connects sees the system's view of nothing but its own server, and can call it
    await sh.install('/tmp/client.js', `export default async function (tiny) {
      const s = await tiny.lookup('tiny.loopback')
      const ask = async (msg) => { const r = (await tiny.request(s, msg)).data; return r.ok ? r.result : { error: r.error.code } }
      const list = await ask({ op: 'list' })
      const res = await ask({ op: 'request', port: ${'${PORT}'}, path: '/hi' })
      await tiny.writeFile('/tmp/client.out', new TextEncoder().encode(JSON.stringify({ ports: list.map((x) => x.port), status: res.status, remote: JSON.parse(new TextDecoder().decode(res.body)).remote })))
    }`.replace('${PORT}', String(served.port)))
    await sh.app('org.test.client', await sh.cat('/tmp/client.js'), { permissions: ['loopback'] }, true)
    await kernel.wait(await kernel.launchOpen('org.test.client'))
    const client = JSON.parse(await sh.cat('/tmp/client.out'))
    return { served, refused, client, system: (await ask('loopback', { op: 'list' })).map((s: { appId: string }) => s.appId) }
  }, SERVER)
  expect(out.served.port).toBeGreaterThanOrEqual(49152)
  expect(out.refused).toEqual({ error: 'EPERM' })
  expect(out.client).toEqual({ ports: [], status: 200, remote: 'org.test.client' })
  expect(out.system).toEqual(['org.test.serves'])
})
