/**
 * IPC extras: dead-name notifications, zero-copy transfer, blocking send, and heartbeats.
 */
import { PRELUDE, expect, test } from './fixtures'

// ------------------------------------------------------------------ dead names

test('watch delivers a dead-name message when the port dies, and fails for dead or unknown ports', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/mortal.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.mortal', port)
         await t.receive(port)
       }`,
    )
    const pid = await kernel.spawn('/Applications/mortal.js')
    let port: number | undefined
    for (let i = 0; i < 400 && port === undefined; i++) {
      port = await kernel.lookup('test.mortal').catch(() => undefined)
      if (port === undefined) await sh.sleep(10)
    }
    const notify = await kernel.portCreate()
    await kernel.watch(port!, notify)
    const before = await kernel.receive(notify, { timeout: 100 }).then(() => 'message', (e) => e.code)
    await kernel.kill(pid, 'SIGKILL')
    await kernel.wait(pid)
    const note = await kernel.receive(notify, { timeout: 5000 })
    const again = await kernel.watch(port!, notify).then(() => 'ok', (e) => e.code)
    const stranger = await kernel.watch(9999, notify).then(() => 'ok', (e) => e.code)
    return { before, note, again, stranger }
  }, PRELUDE)
  expect(res.before).toBe('ETIMEDOUT')
  expect(res.note.data).toEqual({ type: 'dead-name', port: expect.any(Number) })
  expect(res.note.from).toBe(0) // the kernel
  expect(res.again).toBe('EPIPE')
  expect(res.stranger).toBe('EPIPE')
})

test('a process can watch another process, needs a send right, and can unwatch', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/victim.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.victim', port)
         const quiet = await t.portCreate()
         await t.register('test.quiet', quiet)
         for (;;) {
           const m = await t.receive(port)
           if (m.data === 'die') return 0
         }
       }`,
    )
    await sh.install(
      '/Applications/watcher.js',
      `${prelude}
       export default async (t) => {
         const victim = await find(t, 'test.victim')
         const quiet = await find(t, 'test.quiet')
         const mine = await t.portCreate()
         const notOwner = await code(t.watch(victim, victim)) // notify port must be yours
         const noRight = await code(t.watch(4242, mine))
         await t.watch(victim, mine)
         await t.watch(quiet, mine)
         await t.unwatch(quiet, mine)
         await t.send(victim, 'die')
         const note = await t.receive(mine, { timeout: 5000 })
         const extra = await code(t.receive(mine, { timeout: 150 }))
         await out(t, 'watcher.json', { note: note.data, from: note.from, victim, notOwner, noRight, extra })
       }`,
    )
    const v = await kernel.spawn('/Applications/victim.js')
    const w = await kernel.spawn('/Applications/watcher.js')
    const [vs, ws] = [await kernel.wait(v), await kernel.wait(w)]
    return { vs: vs.code, ws: ws.code, werr: ws.stderr, ...JSON.parse(await sh.cat('/tmp/watcher.json')) }
  }, PRELUDE)
  expect(res.werr).toBe('')
  expect(res.vs).toBe(0)
  expect(res.note).toEqual({ type: 'dead-name', port: res.victim })
  expect(res.from).toBe(0)
  expect(res.notOwner).toBe('EBADF')
  expect(res.noRight).toBe('EPIPE')
  expect(res.extra).toBe('ETIMEDOUT') // the unwatched port sent nothing
})

// -------------------------------------------------------------------- transfer

test('ArrayBuffers move without copying, in both directions, and the sender loses them', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/xfer.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.xfer', port)
         const m = await t.receive(port)
         const bytes = new Uint8Array(m.data.buf)
         const sum = bytes.reduce((a, b) => a + b, 0)
         // Hand a new buffer back, moving it too.
         const back = new Uint8Array(1024 * 1024).fill(7).buffer
         await t.send(m.replyTo, { len: bytes.length, sum, back }, { transfer: [back] })
         await out(t, 'xfer.json', { backLenAfterSend: back.byteLength })
       }`,
    )
    const pid = await kernel.spawn('/Applications/xfer.js')
    let port: number | undefined
    for (let i = 0; i < 400 && port === undefined; i++) {
      port = await kernel.lookup('test.xfer').catch(() => undefined)
      if (port === undefined) await sh.sleep(10)
    }
    const buf = new Uint8Array(4 * 1024 * 1024).fill(2).buffer
    const reply = await kernel.request(port!, { buf }, { timeout: 5000, transfer: [buf] })
    await kernel.wait(pid)
    const back = new Uint8Array((reply.data as { back: ArrayBuffer }).back)
    return {
      sentDetached: buf.byteLength === 0,
      len: (reply.data as { len: number }).len,
      sum: (reply.data as { sum: number }).sum,
      backLen: back.length,
      backFirst: back[0],
      ...JSON.parse(await sh.cat('/tmp/xfer.json')),
    }
  }, PRELUDE)
  expect(res.sentDetached).toBe(true)
  expect(res.len).toBe(4 * 1024 * 1024)
  expect(res.sum).toBe(8 * 1024 * 1024)
  expect(res.backLen).toBe(1024 * 1024)
  expect(res.backFirst).toBe(7)
  expect(res.backLenAfterSend).toBe(0)
})

test('a MessagePort can be sent, giving two processes a direct channel', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/chan.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.chan', port)
         const m = await t.receive(port)
         const mp = m.data.port
         await new Promise((resolve) => {
           mp.onmessage = (e) => { mp.postMessage('echo:' + e.data); resolve() }
         })
       }`,
    )
    const pid = await kernel.spawn('/Applications/chan.js')
    let port: number | undefined
    for (let i = 0; i < 400 && port === undefined; i++) {
      port = await kernel.lookup('test.chan').catch(() => undefined)
      if (port === undefined) await sh.sleep(10)
    }
    const { port1, port2 } = new MessageChannel()
    await kernel.send(port!, { port: port1 }, { transfer: [port1] })
    const answer = new Promise((resolve) => (port2.onmessage = (e) => resolve(e.data)))
    port2.postMessage('hello')
    const got = await Promise.race([answer, sh.sleep(5000).then(() => 'timeout')])
    await kernel.wait(pid)
    return got
  }, PRELUDE)
  expect(res).toBe('echo:hello')
})

test('only ArrayBuffer and MessagePort can be transferred', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/bad.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         const view = new Uint8Array(8)
         const r = {
           view: await code(t.send(port, 'x', { transfer: [view] })),
           notList: await code(t.send(port, 'x', { transfer: 5 })),
           plain: await code(t.send(port, 'x', { transfer: [new ArrayBuffer(8)] })),
         }
         await out(t, 'bad.json', r)
       }`,
    )
    await sh.run('/Applications/bad.js')
    return JSON.parse(await sh.cat('/tmp/bad.json'))
  }, PRELUDE)
  expect(res).toEqual({ view: 'EINVAL', notList: 'EINVAL', plain: 'ok' })
})

// ---------------------------------------------------------------- blocking send

test('send waits for room with a timeout, otherwise fails fast when the queue is full', async ({ page }) => {
  const res = await page.evaluate(async () => {
    const { kernel } = window
    const port = await kernel.portCreate()
    for (let i = 0; i < 256; i++) await kernel.send(port, i)
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code)
    const fast = await code(kernel.send(port, 'x'))
    const t0 = Date.now()
    const slow = await code(kernel.send(port, 'x', { timeout: 150 }))
    const waited = Date.now() - t0

    // A blocked sender gets in once a receiver makes room, and keeps its place in line.
    const blocked1 = kernel.send(port, 'first-blocked', { timeout: 5000 })
    const blocked2 = kernel.send(port, 'second-blocked', { timeout: 5000 })
    const head = await kernel.receive(port)
    await blocked1
    let secondDone = false
    void blocked2.then(() => (secondDone = true))
    await new Promise((r) => setTimeout(r, 50))
    const secondStillWaiting = !secondDone
    await kernel.receive(port)
    await blocked2
    const rest: unknown[] = []
    for (let i = 0; i < 256; i++) rest.push((await kernel.receive(port)).data)
    return { fast, slow, waited, head: head.data, secondStillWaiting, tail: rest.slice(-2) }
  })
  expect(res.fast).toBe('EAGAIN')
  expect(res.slow).toBe('ETIMEDOUT')
  expect(res.waited).toBeGreaterThanOrEqual(120)
  expect(res.head).toBe(0)
  expect(res.secondStillWaiting).toBe(true)
  expect(res.tail).toEqual(['first-blocked', 'second-blocked'])
})

test('a send blocked on a port that dies fails with EPIPE', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/full.js',
      `${prelude}
       export default async (t) => {
         const port = await t.portCreate()
         await t.register('test.full', port)
         for (let i = 0; i < 256; i++) await t.send(port, i)
         await out(t, 'full-ready.json', true)
         await sleep(100000)
       }`,
    )
    const pid = await kernel.spawn('/Applications/full.js')
    let port: number | undefined
    for (let i = 0; i < 400 && port === undefined; i++) {
      port = await kernel.lookup('test.full').catch(() => undefined)
      if (port === undefined) await sh.sleep(10)
    }
    await sh.waitFor('/tmp/full-ready.json') // the queue is full now
    const blocked = kernel.send(port!, 'x', { timeout: 10000 }).then(() => 'ok', (e) => e.code)
    await sh.sleep(50)
    await kernel.kill(pid, 'SIGKILL')
    await kernel.wait(pid)
    return blocked
  }, PRELUDE)
  expect(res).toBe('EPIPE')
})

// ------------------------------------------------------------------- heartbeat

test('ping measures a round trip; a busy process times out and is flagged unresponsive', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/idle.js', `${prelude}\nexport default async (t) => { await sleep(100000) }`)
    await sh.install('/Applications/busy.js', `${prelude}\nexport default async (t) => { await sleep(100); for (;;) {} }`)
    const idle = await kernel.spawn('/Applications/idle.js')
    const busy = await kernel.spawn('/Applications/busy.js')
    await sh.sleep(500)
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code)
    const rtt = await kernel.ping(idle, 2000)
    const init = await kernel.ping(1)
    const stuck = await code(kernel.ping(busy, 300))
    const gone = await code(kernel.ping(9999))
    const info = { idle: (await kernel.processInfo(idle)).unresponsive, busy: (await kernel.processInfo(busy)).unresponsive }
    await kernel.kill(busy, 'SIGKILL')
    await kernel.kill(idle, 'SIGKILL')
    await kernel.wait(busy)
    await kernel.wait(idle)
    return { rtt, init, stuck, gone, info }
  }, PRELUDE)
  expect(res.rtt).toBeGreaterThanOrEqual(0)
  expect(res.rtt).toBeLessThan(1000)
  expect(res.init).toBe(0)
  expect(res.stuck).toBe('ETIMEDOUT')
  expect(res.gone).toBe('ESRCH')
  expect(res.info).toEqual({ idle: false, busy: true })
})

test('a process can ping another process', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/idle.js', `${prelude}\nexport default async (t) => { await sleep(100000) }`)
    await sh.install(
      '/Applications/pinger.js',
      `${prelude}
       export default async (t) => {
         const target = Number(t.args[0])
         const ms = await t.ping(target, 2000)
         await out(t, 'pinger.json', { numeric: typeof ms === 'number' })
       }`,
    )
    const idle = await kernel.spawn('/Applications/idle.js')
    await sh.sleep(300)
    const status = await sh.run('/Applications/pinger.js', { args: [String(idle)] })
    await kernel.kill(idle, 'SIGKILL')
    await kernel.wait(idle)
    return { code: status.code, ...JSON.parse(await sh.cat('/tmp/pinger.json')) }
  }, PRELUDE)
  expect(res).toEqual({ code: 0, numeric: true })
})

test('the heartbeat flags a stuck process, reports it, and clears the flag when it recovers', async ({ page, ns }) => {
  const res = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    await kernel.shutdown()
    await kernel.boot({ namespace: ns, heartbeat: { interval: 100, timeout: 300 } })
    const events: Array<{ pid: number; unresponsive: boolean }> = []
    kernel.onEvent((e) => {
      if (e.type === 'process' && e.event === 'stateChanged') events.push({ pid: e.pid, unresponsive: e.unresponsive })
    })
    await sh.install(
      '/Applications/hiccup.js',
      `const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
       export default async (t) => {
         await sleep(300)
         const end = Date.now() + 1500
         while (Date.now() < end) {}
         await sleep(100000)
       }`,
    )
    await sh.install('/Applications/idle.js', `export default async () => { await new Promise(() => {}) }`)
    const hiccup = await kernel.spawn('/Applications/hiccup.js')
    const idle = await kernel.spawn('/Applications/idle.js')
    let flagged = false
    for (let i = 0; i < 100 && !flagged; i++) {
      flagged = (await kernel.processInfo(hiccup)).unresponsive
      if (!flagged) await sh.sleep(50)
    }
    const idleWhileStuck = (await kernel.processInfo(idle)).unresponsive
    let recovered = false
    for (let i = 0; i < 200 && !recovered; i++) {
      recovered = !(await kernel.processInfo(hiccup)).unresponsive
      if (!recovered) await sh.sleep(50)
    }
    await kernel.kill(hiccup, 'SIGKILL')
    await kernel.kill(idle, 'SIGKILL')
    return { flagged, recovered, idleWhileStuck, events, hiccup }
  }, ns)
  expect(res.flagged).toBe(true)
  expect(res.recovered).toBe(true)
  expect(res.idleWhileStuck).toBe(false)
  // Under heavy load the 300 ms limit can trip again later, so only the first transitions are asserted.
  expect(res.events.slice(0, 2)).toEqual([
    { pid: res.hiccup, unresponsive: true },
    { pid: res.hiccup, unresponsive: false },
  ])
})
