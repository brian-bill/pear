/** The loopback bridge end to end: a program serves HTTP and the page, a new tab and other programs reach it with no network. */
import { expect, test } from './fixtures'

const SERVER = `export default async function (tiny) {
  const handler = await tiny.portCreate()
  const svc = await tiny.lookup('tiny.loopback')
  const r = (await tiny.request(svc, { op: 'listen' }, { rights: [handler] })).data
  await tiny.writeFile('/tmp/lb.json', new TextEncoder().encode(JSON.stringify(r.result)))
  const dec = new TextDecoder()
  for (;;) {
    const m = await tiny.receive(handler)
    const q = m.data
    const send = (status, type, body, extra = []) => tiny.send(m.replyTo, { status, headers: [['content-type', type], ...extra], body })
    if (q.path === '/') await send(200, 'text/html', '<!doctype html><title>served</title><h1 id="h">hello from a program</h1><script>fetch("/data.json?from=page").then((r) => r.json()).then((j) => { document.title = "loaded " + j.path })</script>')
    else if (q.path.startsWith('/data.json')) await send(200, 'application/json', JSON.stringify({ path: q.path, method: q.method, body: dec.decode(q.body), type: (q.headers.find((h) => h[0] === 'content-type') || [])[1] ?? null }), [['x-served-by', 'program']])
    else if (q.path === '/silent') continue
    else await send(404, 'text/plain', 'no ' + q.path)
  }
}`

test('a program that serves HTTP is reachable at /__loopback/<port>/ from the page and from a new tab', async ({ desktop, context }) => {
  const page = desktop.page
  const { port, url } = await page.evaluate(async (server) => {
    const k = window.tiny!.kernel
    await k.writeFile('/tmp/server.js', new TextEncoder().encode(server))
    await k.spawn('/tmp/server.js')
    for (let i = 0; i < 100 && !(await k.exists('/tmp/lb.json')); i++) await new Promise((r) => setTimeout(r, 50))
    // let the file finish being written
    await new Promise((r) => setTimeout(r, 100))
    return JSON.parse(new TextDecoder().decode(await k.readFile('/tmp/lb.json')))
  }, SERVER)
  expect(url).toBe(`/__loopback/${port}/`)

  // the worker controls the page once it has claimed it
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 })

  const fetched = await page.evaluate(async (u) => {
    const get = await fetch(`${u}data.json?x=1`)
    const post = await fetch(`${u}data.json`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'ping' })
    const missing = await fetch(`${u}nope`)
    return { status: get.status, served: get.headers.get('x-served-by'), json: await get.json(), post: await post.json(), missing: [missing.status, await missing.text()] }
  }, url)
  expect(fetched.status).toBe(200)
  expect(fetched.served).toBe('program')
  expect(fetched.json).toMatchObject({ path: '/data.json?x=1', method: 'GET' })
  expect(fetched.post).toMatchObject({ method: 'POST', body: 'ping', type: 'text/plain' })
  expect(fetched.missing).toEqual([404, 'no /nope'])

  // a new tab: a normal page, whose own absolute-path request (/data.json) is routed to the same program
  const tab = await context.newPage()
  await tab.goto(url)
  await expect(tab.locator('#h')).toHaveText('hello from a program')
  await expect(tab).toHaveTitle(`loaded /data.json?from=page`)
  await tab.close()
})

test('nothing listening is a readable error page, not a hang', async ({ desktop }) => {
  const page = desktop.page
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 })
  const refused = await page.evaluate(async () => {
    const r = await fetch('/__loopback/4999/')
    return { status: r.status, text: await r.text() }
  })
  expect(refused.status).toBe(502)
  expect(refused.text).toContain('Nothing is listening on port 4999')
})
