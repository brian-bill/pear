/**
 * IPC tests: ports routed by the kernel between real process Workers, and between
 * the outside (init, pid 1) and processes.
 */
import { PRELUDE, expect, test } from './fixtures'

const ECHO_SERVER = `${PRELUDE}
export default async (t) => {
  const port = await t.portCreate()
  await t.register('test.echo', port)
  for (;;) {
    const m = await t.receive(port)
    if (m.data === 'quit') return 0
    await t.send(m.replyTo, { echo: m.data, from: m.from })
  }
}`

test('a client finds a service by name and gets an answer', async ({ page }) => {
  const out = await page.evaluate(async (src) => {
    const { kernel, sh } = window
    await sh.install('/Applications/echo.js', src.server)
    await sh.install(
      '/Applications/client.js',
      `${src.prelude}
       export default async (t) => {
         const echo = await find(t, 'test.echo')
         const reply = await t.request(echo, { n: 42, list: [1, 2, 3] }, { timeout: 5000 })
         await out(t, 'reply.json', { reply: reply.data, me: t.pid })
         await t.send(echo, 'quit')
       }`,
    )
    const server = await kernel.spawn('/Applications/echo.js')
    const client = await kernel.spawn('/Applications/client.js')
    const [s, c] = [await kernel.wait(server), await kernel.wait(client)]
    return { server, client, s: s.code, c: c.code, cerr: c.stderr, ...JSON.parse(await sh.cat('/tmp/reply.json')) }
  }, { server: ECHO_SERVER, prelude: PRELUDE })
  expect(out.cerr).toBe('')
  expect([out.s, out.c]).toEqual([0, 0])
  expect(out.reply).toEqual({ echo: { n: 42, list: [1, 2, 3] }, from: out.client })
  expect(out.me).toBe(out.client)
})

test('the outside world (init) can talk to a process service and register its own', async ({ page }) => {
  const out = await page.evaluate(async (src) => {
    const { kernel, sh } = window
    await sh.install('/Applications/echo.js', src.server)
    await sh.install(
      '/Applications/asks-init.js',
      `${src.prelude}
       export default async (t) => {
         const svc = await find(t, 'desktop.test')
         const r = await t.request(svc, 'ping', { timeout: 5000 })
         await out(t, 'asks-init.json', r.data)
       }`,
    )
    const server = await kernel.spawn('/Applications/echo.js')
    let echo: number | undefined
    for (let i = 0; i < 400 && echo === undefined; i++) {
      echo = await kernel.lookup('test.echo').catch(() => undefined)
      if (echo === undefined) await sh.sleep(10)
    }
    const reply = await kernel.request(echo!, 'hello', { timeout: 5000 })

    // Init registers a service that a process then calls.
    const mine = await kernel.portCreate()
    await kernel.register('desktop.test', mine)
    const client = await kernel.spawn('/Applications/asks-init.js')
    const req = await kernel.receive(mine, { timeout: 5000 })
    await kernel.send(req.replyTo!, { pong: true, saw: req.data })
    await kernel.wait(client)
    await kernel.send(echo!, 'quit')
    await kernel.wait(server)
    return { reply, fromClient: req.from === client, answer: JSON.parse(await sh.cat('/tmp/asks-init.json')) }
  }, { server: ECHO_SERVER, prelude: PRELUDE })
  expect(out.reply.data).toEqual({ echo: 'hello', from: 1 })
  expect(out.fromClient).toBe(true)
  expect(out.answer).toEqual({ pong: true, saw: 'ping' })
})

test('messages arrive in order, and a waiting receiver is woken by a later send', async ({ page }) => {
  const got = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/order.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.order', port)
         const seen = []
         for (let i = 0; i < 6; i++) seen.push((await t.receive(port, { timeout: 5000 })).data)
         await out(t, 'order.json', seen)
       }`,
    )
    const pid = await kernel.spawn('/Applications/order.js')
    let port: number | undefined
    for (let i = 0; i < 400 && port === undefined; i++) {
      port = await kernel.lookup('test.order').catch(() => undefined)
      if (port === undefined) await sh.sleep(10)
    }
    for (let i = 0; i < 3; i++) await kernel.send(port!, i) // queued or delivered straight away
    await sh.sleep(100) // the receiver is now waiting again
    for (let i = 3; i < 6; i++) await kernel.send(port!, i)
    await kernel.wait(pid)
    return JSON.parse(await sh.cat('/tmp/order.json'))
  }, PRELUDE)
  expect(got).toEqual([0, 1, 2, 3, 4, 5])
})

test('you cannot send to a port you were not given, even if you guess its id', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/owner.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.private', port)
         await out(t, 'owner-port.json', port)
         const m = await t.receive(port, { timeout: 8000 })
         await out(t, 'owner-got.json', m.data)
       }`,
    )
    await sh.install(
      '/Applications/intruder.js',
      `${prelude}
       export default async (t) => {
         const guessed = JSON.parse(new TextDecoder().decode(await t.readFile('/tmp/owner-port.json')))
         const r = {}
         r.send = await code(t.send(guessed, 'let me in'))
         r.receive = await code(t.receive(guessed, { timeout: 100 }))
         r.destroy = await code(t.portDestroy(guessed))
         r.rename = await code(t.register('test.other', guessed))
         // Looking it up by name is the sanctioned way in.
         const ok = await find(t, 'test.private')
         r.afterLookup = await code(t.send(ok, 'hello properly'))
         await out(t, 'intruder.json', r)
       }`,
    )
    const owner = await kernel.spawn('/Applications/owner.js')
    await sh.waitFor('/tmp/owner-port.json')
    const intruder = await kernel.spawn('/Applications/intruder.js')
    await kernel.wait(intruder)
    await kernel.wait(owner)
    return { intruder: JSON.parse(await sh.cat('/tmp/intruder.json')), got: JSON.parse(await sh.cat('/tmp/owner-got.json')) }
  }, PRELUDE)
  expect(res.intruder).toEqual({ send: 'EACCES', receive: 'EBADF', destroy: 'EBADF', rename: 'EBADF', afterLookup: 'ok' })
  expect(res.got).toBe('hello properly') // the rejected 'let me in' never arrived
})

test('send rights travel inside messages', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    // B owns a port (unnamed). A is told about it only through a message from C.
    await sh.install(
      '/Applications/b.js',
      `${prelude}
       export default async (t) => {
         const secret = await t.portCreate()
         const hello = await t.portCreate()
         await t.register('test.b.hello', hello)
         // Hand the secret port's receive side to nobody; give A a send right via a message.
         const a = await find(t, 'test.a')
         await t.send(a, 'here you go', { rights: [secret] })
         const m = await t.receive(secret, { timeout: 8000 })
         await out(t, 'b-got.json', { data: m.data, from: m.from })
       }`,
    )
    await sh.install(
      '/Applications/a.js',
      `${prelude}
       export default async (t) => {
         const mine = await t.portCreate()
         await t.register('test.a', mine)
         const m = await t.receive(mine, { timeout: 8000 })
         const secret = m.rights[0]
         const r = { first: m.data, rights: m.rights.length }
         r.send = await code(t.send(secret, 'thanks'))
         // Passing a right you do not hold is refused.
         r.forged = await code(t.send(secret, 'x', { rights: [9999] }))
         await out(t, 'a.json', r)
       }`,
    )
    const a = await kernel.spawn('/Applications/a.js')
    const b = await kernel.spawn('/Applications/b.js')
    await kernel.wait(a)
    await kernel.wait(b)
    return { a: JSON.parse(await sh.cat('/tmp/a.json')), b: JSON.parse(await sh.cat('/tmp/b-got.json')), apid: a }
  }, PRELUDE)
  expect(res.a).toEqual({ first: 'here you go', rights: 1, send: 'ok', forged: 'EACCES' })
  expect(res.b).toEqual({ data: 'thanks', from: res.apid })
})

test('receive times out, and a timed-out receiver does not eat a later message', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/slow.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.slow', port)
         const r = {}
         const start = Date.now()
         r.timeout = await code(t.receive(port, { timeout: 150 }))
         r.waited = Date.now() - start >= 140
         await out(t, 'slow-1.json', r)
         const m = await t.receive(port, { timeout: 8000 })
         await out(t, 'slow-2.json', m.data)
       }`,
    )
    const pid = await kernel.spawn('/Applications/slow.js')
    await sh.waitFor('/tmp/slow-1.json')
    const port = await kernel.lookup('test.slow')
    await kernel.send(port, 'late but not lost')
    await kernel.wait(pid)
    return { first: JSON.parse(await sh.cat('/tmp/slow-1.json')), second: JSON.parse(await sh.cat('/tmp/slow-2.json')) }
  }, PRELUDE)
  expect(res.first).toEqual({ timeout: 'ETIMEDOUT', waited: true })
  expect(res.second).toBe('late but not lost')
})

test('a port dies with its owner: senders get EPIPE, the name is freed, waiters are woken', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/mortal.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.mortal', port)
         await t.receive(port) // blocks until killed
       }`,
    )
    const pid = await kernel.spawn('/Applications/mortal.js')
    let port: number | undefined
    for (let i = 0; i < 400 && port === undefined; i++) {
      port = await kernel.lookup('test.mortal').catch(() => undefined)
      if (port === undefined) await sh.sleep(10)
    }
    const alive = await kernel.send(port!, 'hi').then(() => 'ok', (e) => e.code)
    await kernel.kill(pid, 'SIGKILL')
    await kernel.wait(pid)
    const after = await kernel.send(port!, 'hi').then(() => 'ok', (e) => e.code)
    const lookup = await kernel.lookup('test.mortal').then(() => 'ok', (e) => e.code)

    // The name can be reused by someone else.
    const again = await kernel.portCreate()
    const reregister = await kernel.register('test.mortal', again).then(() => 'ok', (e) => e.code)

    // Destroying a port wakes someone blocked on it.
    const doomed = await kernel.portCreate()
    const waiting = kernel.receive(doomed).then(() => 'message', (e) => e.code)
    await sh.sleep(50)
    await kernel.portDestroy(doomed)
    return { alive, after, lookup, reregister, woken: await waiting }
  }, PRELUDE)
  expect(res).toEqual({ alive: 'ok', after: 'EPIPE', lookup: 'ENOENT', reregister: 'ok', woken: 'EPIPE' })
})

test('names are unique and validated', async ({ page }) => {
  const res = await page.evaluate(async () => {
    const { kernel } = window
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code)
    const a = await kernel.portCreate()
    const b = await kernel.portCreate()
    return {
      first: await code(kernel.register('svc', a)),
      duplicate: await code(kernel.register('svc', b)),
      renameSamePort: await code(kernel.register('other', a)),
      empty: await code(kernel.register('', b)),
      badId: await code(kernel.register('x', 12345)),
      destroyThenLookup: await (async () => {
        await kernel.portDestroy(a)
        return code(kernel.lookup('svc'))
      })(),
    }
  })
  expect(res).toEqual({ first: 'ok', duplicate: 'EEXIST', renameSamePort: 'EINVAL', empty: 'EINVAL', badId: 'EPIPE', destroyThenLookup: 'ENOENT' })
})

test('a full queue pushes back with EAGAIN instead of growing forever', async ({ page }) => {
  const res = await page.evaluate(async () => {
    const { kernel } = window
    const port = await kernel.portCreate()
    let accepted = 0
    let error: string | undefined
    for (let i = 0; i < 1000; i++) {
      try {
        await kernel.send(port, i)
        accepted++
      } catch (e) {
        error = (e as { code?: string }).code
        break
      }
    }
    // Draining makes room again.
    const first = (await kernel.receive(port)).data
    const again = await kernel.send(port, 'more').then(() => 'ok', (e) => e.code)
    return { accepted, error, first, again }
  })
  expect(res).toEqual({ accepted: 256, error: 'EAGAIN', first: 0, again: 'ok' })
})

test('a message that cannot be cloned is an error for the sender, not a crash', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/clone.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         const r = {}
         r.fn = await code(t.send(port, () => 1))
         // The process is still healthy and can use the port afterwards.
         await t.send(port, 'fine')
         r.after = (await t.receive(port, { timeout: 2000 })).data
         await out(t, 'clone.json', r)
       }`,
    )
    const status = await sh.run('/Applications/clone.js')
    return { status, r: JSON.parse(await sh.cat('/tmp/clone.json')) }
  }, PRELUDE)
  expect(res.status).toMatchObject({ code: 0, crashed: false })
  expect(res.r).toEqual({ fn: 'EINVAL', after: 'fine' })
})

test('request works across 10 concurrent clients without mixing up replies', async ({ page }) => {
  const res = await page.evaluate(async (src) => {
    const { kernel, sh } = window
    await sh.install('/Applications/echo.js', src.server)
    await sh.install(
      '/Applications/many.js',
      `${src.prelude}
       export default async (t) => {
         const echo = await find(t, 'test.echo')
         const mine = []
         for (let i = 0; i < 10; i++) mine.push((await t.request(echo, t.pid + ':' + i, { timeout: 8000 })).data.echo)
         await out(t, 'many-' + t.pid + '.json', mine)
       }`,
    )
    const server = await kernel.spawn('/Applications/echo.js')
    const clients = await Promise.all(Array.from({ length: 10 }, () => kernel.spawn('/Applications/many.js')))
    const statuses = await Promise.all(clients.map((c) => kernel.wait(c)))
    const echo = await kernel.lookup('test.echo')
    await kernel.send(echo, 'quit')
    await kernel.wait(server)
    const bad: string[] = []
    for (const pid of clients) {
      const got: string[] = JSON.parse(await sh.cat(`/tmp/many-${pid}.json`))
      got.forEach((v, i) => v === `${pid}:${i}` || bad.push(`${pid}[${i}]=${v}`))
    }
    return { codes: statuses.map((s) => s.code), bad }
  }, { server: ECHO_SERVER, prelude: PRELUDE })
  expect(res.codes).toEqual(Array(10).fill(0))
  expect(res.bad).toEqual([])
})
