/** The driver services (clipboard, timers, input, display, audio) and the page glue that feeds them. */
import { expect, test } from './fixtures'

test.use({ system: true })

declare global {
  interface Window {
    /** Ask a driver service: the result, or `{error: code}`. `from` is the port id to pass in rights. */
    ask(name: string, msg: Record<string, unknown>, rights?: number[]): Promise<any>
    /** A port init owns, plus `next(ms)` to read what arrives on it. */
    inbox(): Promise<{ port: number; next(ms?: number): Promise<any>; all(ms?: number): Promise<any[]> }>
    /** Run `main` as an app named `id`; resolves with what it returned (JSON). */
    runApp(id: string, main: string, extra?: Record<string, unknown>, grant?: boolean): Promise<any>
  }
}

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => {
    const k = window.kernel
    window.ask = async (name, msg, rights) => {
      const reply = (await k.request(await k.lookup(`tiny.${name}`), msg, { rights, timeout: 8000 })).data as any
      return reply.ok ? reply.result : { error: reply.error.code }
    }
    window.inbox = async () => {
      const port = await k.portCreate()
      const next = (ms = 1500) => k.receive(port, { timeout: ms }).then((m) => m.data, () => null)
      const all = async (ms = 300) => {
        const out: any[] = []
        for (;;) {
          const d = await next(ms)
          if (d === null) return out
          out.push(d)
        }
      }
      return { port, next, all }
    }
    window.runApp = async (id, main, extra, grant) => {
      const installed = (await k.bundleList()).find((b) => b.id === id)
      const info = installed ?? (await window.sh.app(id, main, extra, grant))
      const pid = await k.launchOpen(info.id)
      const st = await k.wait(pid)
      if (st.code !== 0) throw new Error(`app failed: ${st.stderr}`)
      return JSON.parse(await window.sh.cat(`/tmp/${id}.out`))
    }
  })
})

/** Source for an app that asks a service and records the answer in /tmp/<name>.out. */
const appAsking = (name: string, svc: string, msg: unknown, extra = '') => `export default async (tiny) => {
  const port = await tiny.lookup('tiny.${svc}')
  ${extra}
  const reply = (await tiny.request(port, ${JSON.stringify(msg)}, { timeout: 5000 })).data
  await tiny.writeFile('/tmp/${name}.out', new TextEncoder().encode(JSON.stringify(reply.ok ? { ok: reply.result } : { error: reply.error.code })))
}`

test('the kernel side: only system services may call drivers; pushes reach the service', async ({ page }) => {
  const out = await page.evaluate(async (src) => {
    const k = window.kernel
    const events: any[] = []
    k.onEvent((e) => e.type === 'driver' && events.push(`${e.device}:${(e.data as any).op}`))
    const app = await window.runApp('com.example.sneaky', src, { permissions: [] }, true)
    return {
      app,
      missing: await k.driverPush('nothing', {}),
      delivered: await k.driverPush('timers', { event: 'visibility', visible: true }),
      events,
    }
  }, `export default async (tiny) => {
    const r = await tiny.driverEmit('audio', { op: 'pcm' }).then(() => 'allowed', (e) => e.code)
    await tiny.writeFile('/tmp/com.example.sneaky.out', new TextEncoder().encode(JSON.stringify(r)))
  }`)
  expect(out).toMatchObject({ app: 'EPERM', missing: false, delivered: true })
  expect(out.events).not.toContain('audio:pcm')
})

// ------------------------------------------------------------------------------------------ timers

test('timers: clocks, time zone, one-shot, repeating, absolute, and clear', async ({ page }) => {
  const out = await page.evaluate(async (appSrc) => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const now = await ask('timers', { op: 'now' })
    res.clock = [Math.abs(now.wall - Date.now()) < 2000, now.monotonic > 0, typeof now.timezone]
    const box = await inbox()
    const watcher = await inbox()
    await ask('timers', { op: 'subscribe' }, [watcher.port])
    res.badZone = await ask('timers', { op: 'setTimezone', zone: 'Mars/Olympus' })
    await ask('timers', { op: 'setTimezone', zone: 'Asia/Tokyo' })
    res.zone = [await ask('timers', { op: 'timezone' }), await k.configGet('tiny.system', 'timezone')]
    res.zoneEvent = await watcher.next()
    res.appZone = await window.runApp('com.example.tz', appSrc, {}, true)
    await ask('timers', { op: 'setTimezone', zone: 'auto' })

    const t0 = performance.now()
    const one = await ask('timers', { op: 'set', ms: 60 }, [box.port])
    const fired = await box.next()
    res.one = [fired.type, fired.id === one, performance.now() - t0 >= 50]
    res.noRepeat = (await box.all(150)).length

    const rep = await ask('timers', { op: 'set', ms: 30, repeat: true }, [box.port])
    const ticks = []
    for (let i = 0; i < 3; i++) ticks.push(await box.next())
    res.repeat = ticks.map((t) => t.id === rep)
    res.cleared = await ask('timers', { op: 'clear', id: rep })
    await box.all(100)
    res.stopped = (await box.all(200)).length
    res.clearAgain = await ask('timers', { op: 'clear', id: rep })

    const at = await ask('timers', { op: 'at', time: Date.now() + 70 }, [box.port])
    res.at = (await box.next()).id === at
    const early = await ask('timers', { op: 'set', ms: 5000 }, [box.port])
    await ask('timers', { op: 'clear', id: early })
    res.noPort = await ask('timers', { op: 'set', ms: 10 })
    res.badMs = await ask('timers', { op: 'set', ms: 'soon' }, [box.port])
    // a tolerance lets timers land together on a shared tick
    const a = await ask('timers', { op: 'set', ms: 20, tolerance: 200 }, [box.port])
    const b = await ask('timers', { op: 'set', ms: 60, tolerance: 200 }, [box.port])
    const [x, y] = [await box.next(), await box.next()]
    res.coalesced = [[x.id, y.id].sort().join() === [a, b].sort().join(), Math.abs(x.time - y.time) < 40]
    return res
  }, appAsking('com.example.tz', 'timers', { op: 'setTimezone', zone: 'Europe/Paris' }))
  expect(out.clock).toEqual([true, true, 'string'])
  expect(out.badZone).toEqual({ error: 'EINVAL' })
  expect(out.zone).toEqual(['Asia/Tokyo', 'Asia/Tokyo'])
  expect(out.zoneEvent).toEqual({ type: 'timezone', zone: 'Asia/Tokyo' })
  expect(out.appZone).toEqual({ error: 'EPERM' })
  expect(out.one).toEqual(['timer', true, true])
  expect(out.noRepeat).toBe(0)
  expect(out.repeat).toEqual([true, true, true])
  expect(out.cleared).toBe(true)
  expect(out.stopped).toBe(0)
  expect(out.clearAgain).toBe(false)
  expect(out.at).toBe(true)
  expect(out.noPort).toEqual({ error: 'EINVAL' })
  expect(out.badMs).toEqual({ error: 'EINVAL' })
  expect(out.coalesced).toEqual([true, true])
})

test('timers: frames and idle time, with and without the page driver; visibility and resume', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const box = await inbox()
    // without a page driver frames still come (paced by the service) and idle callbacks run at their timeout
    const f = await ask('timers', { op: 'frameRequest' }, [box.port])
    const frame = await box.next()
    res.frameFallback = [frame.type, frame.id === f]
    const idle = await ask('timers', { op: 'idleRequest', timeout: 120 }, [box.port])
    const idled = await box.next()
    res.idleFallback = [idled.type, idled.id === idle, idled.timedOut]
    const gone = await ask('timers', { op: 'frameRequest' }, [box.port])
    res.frameCancel = await ask('timers', { op: 'frameCancel', id: gone })
    res.frameNone = (await box.all(150)).filter((e) => e.type === 'frame').length

    const detach = window.attachDrivers()
    await ask('timers', { op: 'frameRequest' }, [box.port])
    const pageFrame = await box.next()
    const t = Date.now()
    await ask('timers', { op: 'idleRequest', timeout: 5000 }, [box.port])
    const pageIdle = await box.next()
    res.page = [pageFrame.type, pageFrame.time > 0, pageIdle.type, pageIdle.timedOut, Date.now() - t < 4000]
    detach()

    // hidden and visible again: watchers hear about it and may catch up
    await ask('timers', { op: 'subscribe' }, [box.port])
    await k.driverPush('timers', { event: 'visibility', visible: false })
    await k.driverPush('timers', { event: 'visibility', visible: true })
    const seen = await box.all(300)
    res.visibility = [await ask('timers', { op: 'visibility' }), seen.map((e) => (e.type === 'visibility' ? `visible=${e.visible}` : e.type))]

    // wake locks reach the page driver, and are released with the last holder
    const asked: boolean[] = []
    k.onEvent((e) => e.type === 'driver' && e.device === 'timers' && (e.data as any).op === 'keepAwake' && asked.push((e.data as any).on))
    const l1 = await ask('timers', { op: 'keepAwake', reason: 'export' })
    const l2 = await ask('timers', { op: 'keepAwake', reason: 'render' })
    await ask('timers', { op: 'release', id: l1 })
    await ask('timers', { op: 'release', id: l2 })
    res.awake = [asked, await ask('timers', { op: 'keepAwake' })]
    return res
  })
  expect(out.frameFallback).toEqual(['frame', true])
  expect(out.idleFallback).toEqual(['idle', true, true])
  expect(out.frameCancel).toBe(true)
  expect(out.frameNone).toBe(0)
  expect(out.page).toEqual(['frame', true, 'idle', false, true])
  expect(out.visibility).toEqual([{ visible: true }, ['visible=false', 'visible=true', 'resumed']])
  expect(out.awake).toEqual([[true, false], { error: 'EINVAL' }])
})

// ------------------------------------------------------------------------------------------ clipboard

test('clipboard: write, read, aliases, change counts, subscribers, limits and large data', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const box = await inbox()
    await ask('clipboard', { op: 'subscribe', board: 'general' }, [box.port])
    const hostWrites: any[] = []
    k.onEvent((e) => e.type === 'driver' && e.device === 'clipboard' && (e.data as any).op === 'write' && hostWrites.push((e.data as any).items))

    res.empty = await ask('clipboard', { op: 'read' })
    const n1 = await ask('clipboard', {
      op: 'write', items: [{ type: 'public.utf8-plain-text', data: 'hello' }, { type: 'text/html', data: '<b>hello</b>' }, { type: 'image/png', data: new Uint8Array([1, 2, 3]) }],
    })
    res.read = await ask('clipboard', { op: 'read' })
    res.only = (await ask('clipboard', { op: 'read', types: ['public.html'] })).items.map((i: any) => i.type)
    res.types = (await ask('clipboard', { op: 'types' })).map((t: any) => `${t.type}:${t.size > 0}`)
    res.count = [n1, await ask('clipboard', { op: 'changeCount' })]
    res.event = await box.next()
    res.host = hostWrites[0]?.map((i: any) => i.type)

    res.dup = await ask('clipboard', { op: 'write', items: [{ type: 'text/plain', data: 'a' }, { type: 'public.text', data: 'b' }] })
    res.badData = await ask('clipboard', { op: 'write', items: [{ type: 'text/plain', data: { no: 1 } }] })
    res.noType = await ask('clipboard', { op: 'write', items: [{ data: 'x' }] })
    res.tooMany = await ask('clipboard', { op: 'write', items: Array.from({ length: 40 }, (_, i) => ({ type: `x/${i}`, data: '1' })) })
    res.badBoard = await ask('clipboard', { op: 'read', board: 'secret' })
    res.afterErrors = (await ask('clipboard', { op: 'read' })).items.length // a rejected write leaves the old content

    // other pasteboards are separate
    await ask('clipboard', { op: 'write', board: 'find', items: [{ type: 'text/plain', data: 'needle' }] })
    res.find = (await ask('clipboard', { op: 'read', board: 'find' })).items[0].data
    res.general = (await ask('clipboard', { op: 'read' })).items.length

    // big data is parked in a file and comes back identical; clearing removes the file
    const big = new Uint8Array(400_000).map((_, i) => (i * 13) & 0xff)
    await ask('clipboard', { op: 'write', items: [{ type: 'application/x-big', data: big }, { type: 'text/plain', data: 'x'.repeat(300_000) }] })
    const spilled = (await k.readdir('/tmp/.pasteboard')).length
    const back = (await ask('clipboard', { op: 'read' })).items
    res.big = [spilled, back[0].data.length, back[0].data.every((b: number, i: number) => b === ((i * 13) & 0xff)), back[1].data.length]
    await ask('clipboard', { op: 'clear' })
    res.cleared = [(await ask('clipboard', { op: 'read' })).items.length, (await k.readdir('/tmp/.pasteboard')).length]
    res.huge = await ask('clipboard', { op: 'write', items: [{ type: 'a/b', data: new Uint8Array(33 * 1024 * 1024) }] })
    return res
  })
  expect(out.empty.items).toEqual([])
  expect(out.read.items.map((i: any) => `${i.type}:${i.data.length ?? i.data}`)).toEqual(['text/plain:5', 'text/html:12', 'image/png:3'])
  expect(out.only).toEqual(['text/html'])
  expect(out.types).toEqual(['text/plain:true', 'text/html:true', 'image/png:true'])
  expect(out.count).toEqual([1, 1])
  expect(out.event).toMatchObject({ type: 'changed', board: 'general', changeCount: 1, types: ['text/plain', 'text/html', 'image/png'], source: 'app' })
  expect(out.host).toEqual(['text/plain', 'text/html']) // images are not sent to the host
  expect(out.dup).toEqual({ error: 'EINVAL' })
  expect(out.badData).toEqual({ error: 'EINVAL' })
  expect(out.noType).toEqual({ error: 'EINVAL' })
  expect(out.tooMany).toEqual({ error: 'EINVAL' })
  expect(out.badBoard).toEqual({ error: 'EINVAL' })
  expect(out.afterErrors).toBe(3)
  expect(out.find).toBe('needle')
  expect(out.general).toBe(3)
  expect(out.big).toEqual([2, 400000, true, 300000])
  expect(out.cleared).toEqual([0, 0])
  expect(out.huge).toEqual({ error: 'E2BIG' })
})

test('clipboard: apps need the permission; lazy data comes from its provider; the host can write', async ({ page }) => {
  const out = await page.evaluate(async (apps) => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    await ask('clipboard', { op: 'write', items: [{ type: 'text/plain', data: 'secret' }] })
    res.ungranted = await window.runApp('com.example.nosy', apps.nosy, { permissions: ['clipboard'] }, false)
    res.granted = await window.runApp('com.example.allowed', apps.allowed, { permissions: ['clipboard'] }, true)
    res.undeclared = await window.runApp('com.example.undeclared', apps.undeclared, {}, true)
    res.drag = await window.runApp('com.example.dragboard', apps.drag, {}, false) // the drag board is not private

    // lazy items: the owner is asked when somebody pastes
    const provider = await inbox()
    await ask('clipboard', { op: 'write', items: [{ type: 'text/plain', lazy: true }, { type: 'text/html', data: '<i>eager</i>' }] }, [provider.port])
    const pending = ask('clipboard', { op: 'read' })
    const wanted = await k.receive(provider.port, { timeout: 3000 })
    await k.send(wanted.replyTo!, { data: 'lazy text' })
    const read = await pending
    res.lazy = [wanted.data, read.items.map((i: any) => `${i.type}=${i.data}`)]
    // a provider that went away loses only its own items
    await k.portDestroy(provider.port)
    const orphan = await ask('clipboard', { op: 'read' })
    res.orphan = orphan.items.map((i: any) => i.type)

    // the host clipboard (paste in the page) replaces the general pasteboard
    const box = await inbox()
    await ask('clipboard', { op: 'subscribe' }, [box.port])
    await k.driverPush('clipboard', { event: 'host-write', items: [{ type: 'text/plain', data: 'from the host' }] })
    res.host = [(await ask('clipboard', { op: 'read' })).items[0].data, (await box.next()).source]
    return res
  }, {
    nosy: appAsking('com.example.nosy', 'clipboard', { op: 'read' }),
    allowed: appAsking('com.example.allowed', 'clipboard', { op: 'read' }),
    undeclared: appAsking('com.example.undeclared', 'clipboard', { op: 'read' }),
    drag: appAsking('com.example.dragboard', 'clipboard', { op: 'read', board: 'drag' }),
  })
  expect(out.ungranted).toEqual({ error: 'EPERM' })
  expect(out.granted.ok.items[0].data).toBe('secret')
  expect(out.undeclared).toEqual({ error: 'EPERM' })
  expect(out.drag.ok.items).toEqual([])
  expect(out.lazy).toEqual([{ type: 'provide', mime: 'text/plain' }, ['text/plain=lazy text', 'text/html=<i>eager</i>']])
  expect(out.orphan).toEqual(['text/html'])
  expect(out.host).toEqual(['from the host', 'host'])
})

test('clipboard: drag and drop sessions', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const box = await inbox()
    await ask('clipboard', { op: 'dragSubscribe' }, [box.port])
    const item = { type: 'application/x-tiny-file-ref', data: '/Users/pear/Documents/a.txt' }
    res.badOps = await ask('clipboard', { op: 'dragBegin', items: [item], allowedOps: ['teleport'] })
    res.domImage = await ask('clipboard', { op: 'dragBegin', items: [item], image: { tag: 'div' } })
    res.noItems = await ask('clipboard', { op: 'dragBegin', items: [] })
    const id = await ask('clipboard', { op: 'dragBegin', items: [item], allowedOps: ['copy', 'move'], image: new Uint8Array([137, 80]) })
    res.second = await ask('clipboard', { op: 'dragBegin', items: [item] })
    res.info = await ask('clipboard', { op: 'dragInfo' })
    res.board = (await ask('clipboard', { op: 'read', board: 'drag' })).items.map((i: any) => i.type)
    await ask('clipboard', { op: 'dragUpdate', session: id, position: { x: 10, y: 20 }, target: 'finder' })
    await ask('clipboard', { op: 'dragUpdate', session: id, position: { x: 30, y: 40 }, target: 'finder' })
    await ask('clipboard', { op: 'dragUpdate', session: id, position: { x: 50, y: 60 }, target: 'dock' })
    res.badPos = await ask('clipboard', { op: 'dragUpdate', session: id, position: 'here' })
    res.link = await ask('clipboard', { op: 'dragDrop', session: id, target: 'dock', operation: 'link' })
    res.drop = await ask('clipboard', { op: 'dragDrop', session: id, target: 'dock' })
    res.after = await ask('clipboard', { op: 'dragInfo' })
    res.events = (await box.all(200)).map((e) => (e.type === 'begin' ? `begin(${e.types})` : e.type === 'over' ? `over:${e.target}` : e.type === 'drop' ? `drop:${e.target}:${e.operation}` : `${e.type}${e.target ? ':' + e.target : ''}`))

    const second = await ask('clipboard', { op: 'dragBegin', items: [item] })
    res.cancel = [await ask('clipboard', { op: 'dragCancel', session: second }), await ask('clipboard', { op: 'dragCancel', session: second })]
    res.gone = await ask('clipboard', { op: 'dragDrop', session: second })
    const third = await ask('clipboard', { op: 'dragBegin', items: [item] })
    await box.all(100)
    // files dropped from the host are announced to drop targets
    await k.driverPush('clipboard', { event: 'host-drop', files: [new File(['hi'], 'a.txt')], position: { x: 1, y: 2 } })
    const hostDrop = await box.next()
    res.hostDrop = [hostDrop.type, hostDrop.files[0].name, hostDrop.position]
    await ask('clipboard', { op: 'dragCancel', session: third })
    return res
  })
  expect(out.badOps).toEqual({ error: 'EINVAL' })
  expect(out.domImage).toEqual({ error: 'EINVAL' })
  expect(out.noItems).toEqual({ error: 'EINVAL' })
  expect(out.second).toEqual({ error: 'EBUSY' })
  expect(out.info).toMatchObject({ types: ['application/x-tiny-file-ref'], allowedOps: ['copy', 'move'] })
  expect(out.board).toEqual(['application/x-tiny-file-ref'])
  expect(out.badPos).toEqual({ error: 'EINVAL' })
  expect(out.link).toEqual({ error: 'EINVAL' })
  expect(out.drop).toBe('copy')
  expect(out.after).toBeNull()
  expect(out.events).toEqual([
    'begin(application/x-tiny-file-ref)', 'enter:finder', 'over:finder', 'over:finder', 'leave:finder', 'enter:dock', 'over:dock', 'drop:dock:copy',
  ])
  expect(out.cancel).toEqual([true, false])
  expect(out.gone).toEqual({ error: 'ENOENT' })
  expect(out.hostDrop).toEqual(['host-drop', 'a.txt', { x: 1, y: 2 }])
})

// ------------------------------------------------------------------------------------------ input

test('input: normalisation, Cmd mapping, kinds, grabs, and who may listen', async ({ page }) => {
  const out = await page.evaluate(async (appSrc) => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const all = await inbox()
    const keys = await inbox()
    await ask('input', { op: 'subscribe' }, [all.port])
    await ask('input', { op: 'subscribe', kinds: ['key'] }, [keys.port])
    res.badKinds = await ask('input', { op: 'subscribe', kinds: ['smell'] }, [keys.port])
    const push = (input: unknown) => k.driverPush('input', { event: 'input', input })
    const key = (extra: Record<string, unknown>) => ({ kind: 'key', phase: 'down', code: 'KeyC', key: 'c', time: 5, ...extra })

    // a Linux/Windows host: Ctrl is Cmd. A Mac host: Meta is Cmd.
    await k.driverPush('input', { event: 'host-info', platform: 'Linux', keyboardLock: true })
    await push(key({ ctrlKey: true, shiftKey: true }))
    await push(key({ code: 'ControlLeft', key: 'Control', ctrlKey: true }))
    await k.driverPush('input', { event: 'host-info', platform: 'MacIntel' })
    await push(key({ metaKey: true, ctrlKey: true, altKey: true, phase: 'repeat' }))
    await k.configSet('tiny.input', 'cmdMapping', 'ctrl')
    await new Promise((r) => setTimeout(r, 100))
    await push(key({ ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 100))
    await k.configSet('tiny.input', 'cmdMapping', 'auto')
    const got = await keys.next(), got2 = await keys.next(), got3 = await keys.next(), got4 = await keys.next()
    res.linux = [got.mods, got2.code, got2.key, got2.mods.cmd]
    res.mac = [got3.phase, got3.mods]
    res.override = got4.mods
    res.state = await ask('input', { op: 'state' })

    // other kinds are cleaned up; unknown ones and garbage are dropped
    await push({ kind: 'pointer', phase: 'down', x: 10.5, y: '7', button: 0, buttons: 1, pointerType: 'laser', evil: 'x' })
    await push({ kind: 'wheel', dx: 1, dy: -3, mode: 'line', precise: 1 })
    await push({ kind: 'touch', points: [{ id: 1, x: 2, y: 3, force: 0.5 }, null] })
    await push({ kind: 'telepathy' })
    await push('nonsense')
    await push({ kind: 'text', text: 'é'.repeat(5000) })
    const rest = (await all.all(400)).filter((e) => e.kind !== 'key')
    res.kinds = rest.map((e) => e.kind)
    res.pointer = rest[0]
    res.wheel = [rest[1].dy, rest[1].mode, rest[1].precise]
    res.touch = rest[2].points
    res.textLen = rest[3].text.length
    res.keysOnly = (await keys.all(100)).length

    // exclusive grab: the grabber alone gets the events; shared grab adds a receiver
    const grabber = await inbox()
    await ask('input', { op: 'grab', kind: 'key', exclusive: true }, [grabber.port])
    res.secondExclusive = await ask('input', { op: 'grab', kind: 'key', exclusive: true }, [keys.port])
    await push(key({ key: 'g' }))
    res.grabbed = [(await grabber.next()).key, await keys.next(200), (await all.all(200)).filter((e) => e.kind === 'key').length]
    await ask('input', { op: 'release', kind: 'key' }, [grabber.port])
    await push(key({ key: 'h' }))
    res.released = [(await keys.next()).key, await grabber.next(150)]
    await ask('input', { op: 'grab', kind: 'key' }, [grabber.port])
    await push(key({ key: 'i' }))
    res.shared = [(await keys.next()).key, (await grabber.next()).key]
    await ask('input', { op: 'release' }, [grabber.port])

    // apps do not get to listen in
    res.app = await window.runApp('com.example.keylogger', appSrc, {}, true)
    res.layouts = await ask('input', { op: 'layouts' })
    res.badLayout = await ask('input', { op: 'setKeyboardLayout', id: 'klingon' })
    await ask('input', { op: 'setKeyboardLayout', id: 'dvorak' })
    res.layout = [(await ask('input', { op: 'layouts' })).current, await k.configGet('tiny.input', 'layout')]
    res.reserved = await ask('input', { op: 'reserved' })
    res.haptic = [await ask('input', { op: 'haptic', pattern: [10, 20] }), await ask('input', { op: 'haptic', pattern: 'buzz' })]
    res.announce = [await ask('input', { op: 'announce', text: 'Saved' }), await ask('input', { op: 'announce', text: '' })]
    return res
  }, appAsking('com.example.keylogger', 'input', { op: 'subscribe' }, 'const mine = await tiny.portCreate()').replace("{ op: \"subscribe\" }", '{ op: "subscribe" }, { rights: [mine] }'))
  expect(out.badKinds).toEqual({ error: 'EINVAL' })
  expect(out.linux[0]).toEqual({ cmd: true, ctrl: false, opt: false, shift: true, fn: false })
  expect(out.linux.slice(1)).toEqual(['MetaLeft', 'Meta', true])
  expect(out.mac).toEqual(['repeat', { cmd: true, ctrl: true, opt: true, shift: false, fn: false }])
  expect(out.override).toEqual({ cmd: true, ctrl: false, opt: false, shift: false, fn: false })
  expect(out.state).toMatchObject({ platform: 'MacIntel', cmd: 'meta', keyboardLock: false })
  expect(out.kinds).toEqual(['pointer', 'wheel', 'touch', 'text'])
  expect(out.pointer).toMatchObject({ type: 'input', phase: 'down', x: 10.5, y: 0, pointerType: 'mouse', buttons: 1 })
  expect(out.pointer.evil).toBeUndefined()
  expect(out.wheel).toEqual([-3, 'line', true])
  expect(out.touch).toEqual([{ id: 1, x: 2, y: 3, force: 0.5 }, { id: 0, x: 0, y: 0, force: 0 }])
  expect(out.textLen).toBe(4096)
  expect(out.keysOnly).toBe(0)
  expect(out.secondExclusive).toEqual({ error: 'EBUSY' })
  expect(out.grabbed).toEqual(['g', null, 0])
  expect(out.released).toEqual(['h', null])
  expect(out.shared).toEqual(['i', 'i'])
  expect(out.app).toEqual({ error: 'EPERM' })
  expect(out.layouts.layouts).toContain('dvorak')
  expect(out.badLayout).toEqual({ error: 'EINVAL' })
  expect(out.layout).toEqual(['dvorak', 'dvorak'])
  expect(out.reserved.shortcuts).toContain('Cmd+W')
  expect(out.haptic).toEqual([null, { error: 'EINVAL' }])
  expect(out.announce).toEqual([null, { error: 'EINVAL' }])
})

test('input: real keyboard and mouse events in the page reach subscribers', async ({ page }) => {
  await page.evaluate(async () => {
    const box = await window.inbox()
    ;(window as any).box = box
    await window.ask('input', { op: 'subscribe', kinds: ['key', 'pointer', 'wheel', 'text'] }, [box.port])
    ;(window as any).detach = window.attachDrivers()
  })
  await page.waitForTimeout(100)
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Shift')
  await page.mouse.move(40, 50)
  await page.mouse.down()
  await page.mouse.up()
  await page.mouse.wheel(0, 120)
  const events = await page.evaluate(async () => {
    const out = await (window as any).box.all(500)
    ;(window as any).detach()
    return out.map((e: any) => ({ kind: e.kind, phase: e.phase, code: e.code, key: e.key, shift: e.mods?.shift, x: e.x, y: e.y, dy: e.dy }))
  })
  const key = events.filter((e: any) => e.kind === 'key')
  expect(key.map((e: any) => `${e.phase}:${e.code}`)).toEqual(['down:ShiftLeft', 'down:KeyA', 'up:KeyA', 'up:ShiftLeft'])
  expect(key[1].shift).toBe(true)
  expect(events.filter((e: any) => e.kind === 'text').map((e: any) => e.key ?? e.phase)).toEqual([]) // no editable element focused: no text
  const pointer = events.filter((e: any) => e.kind === 'pointer')
  expect(pointer.map((e: any) => e.phase)).toContain('down')
  expect(pointer.map((e: any) => e.phase)).toContain('up')
  expect(pointer.some((e: any) => e.x === 40 && e.y === 50)).toBe(true)
  expect(events.some((e: any) => e.kind === 'wheel' && e.dy === 120)).toBe(true)
})

// ------------------------------------------------------------------------------------------ display

test('display: screens, surfaces, commits, ownership, limits and cleanup', async ({ page }) => {
  const out = await page.evaluate(async (appSrc) => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const box = await inbox()
    await ask('display', { op: 'subscribe' }, [box.port])
    res.default = (await ask('display', { op: 'list' }))[0]
    const detach = window.attachDrivers()
    const change = await box.next(2000)
    const [screen] = await ask('display', { op: 'list' })
    res.page = [change?.type, screen.width === window.innerWidth, screen.scale === (window.devicePixelRatio || 1)]
    res.root = await ask('display', { op: 'root' })
    const gpu = await ask('display', { op: 'gpu' })
    res.gpu = [typeof gpu.maxTextureSize, gpu.maxTextureSize >= 1024]
    detach()
    await box.all(100)

    const id = await ask('display', { op: 'create', width: 4, height: 2, scale: 2, kind: 'bitmap' })
    res.created = (await box.next()).type
    res.badKind = await ask('display', { op: 'create', width: 4, height: 2, kind: 'vulkan' })
    res.badSize = await ask('display', { op: 'create', width: 0, height: 2 })
    res.huge = await ask('display', { op: 'create', width: 60000, height: 60000 })
    await ask('display', { op: 'setMeta', id, title: 'Doc', role: 'window', opaque: false })
    res.badRole = await ask('display', { op: 'setMeta', id, role: 'god' })
    res.meta = (await ask('display', { op: 'surfaces' }))[0]
    await box.all(100)

    const pixels = new Uint8Array(4 * 2 * 4).fill(255)
    const frame = await ask('display', { op: 'commit', id, buffer: pixels, damage: [{ x: 0, y: 0, width: 2, height: 2 }] })
    const commit = (await box.all(200)).find((e) => e.type === 'commit')
    res.commit = [frame, commit.frame, commit.damage, commit.buffer.length, commit.buffer.every((b: number) => b === 255)]
    res.wrongSize = await ask('display', { op: 'commit', id, buffer: new Uint8Array(5) })
    res.badDamage = await ask('display', { op: 'commit', id, damage: [{ x: -1, y: 0, width: 1, height: 1 }] })
    res.noPixels = await ask('display', { op: 'commit', id })
    await ask('display', { op: 'resize', id, width: 8, height: 8 })
    res.resized = (await box.all(100)).find((e) => e.type === 'surface-resized').surface.width
    res.attachBitmap = await ask('display', { op: 'attach', id, canvas: 1 })
    const gl = await ask('display', { op: 'create', width: 10, height: 10, kind: 'webgl' })
    res.commitGl = await ask('display', { op: 'commit', id: gl, buffer: new Uint8Array(400) })

    res.cursor = [await ask('display', { op: 'setCursor', shape: 'grab' }), await ask('display', { op: 'cursor' }), await ask('display', { op: 'setCursor', shape: 'hamburger' })]
    res.fonts = await ask('display', { op: 'fonts' })

    // an app can use its own surfaces only; they go away with it
    res.app = await window.runApp('com.example.painter', appSrc, {}, true)
    await new Promise((r) => setTimeout(r, 1600))
    res.afterExit = (await ask('display', { op: 'surfaces' })).map((s: any) => s.appId)
    res.destroyed = await ask('display', { op: 'destroy', id })
    res.again = await ask('display', { op: 'destroy', id })
    // no page driver is listening for these
    res.fullscreen = await ask('display', { op: 'requestFullscreen' })
    return res
  }, `export default async (tiny) => {
    const port = await tiny.lookup('tiny.display')
    const ask = async (m) => { const r = (await tiny.request(port, m, { timeout: 8000 })).data; return r.ok ? r.result : { error: r.error.code } }
    const mine = await ask({ op: 'create', width: 2, height: 2 })
    const other = await ask({ op: 'commit', id: 1, buffer: new Uint8Array(16) })
    const list = await ask({ op: 'surfaces' })
    const cap = await ask({ op: 'capture' })
    await tiny.writeFile('/tmp/com.example.painter.out', new TextEncoder().encode(JSON.stringify({ mine: typeof mine, other, listed: list.length, cap })))
  }`)
  expect(out.default).toMatchObject({ id: 0, width: 1280, height: 800, scale: 1, refreshRate: 60, colorSpace: 'srgb' })
  expect(out.page).toEqual(['display-changed', true, true])
  expect(out.root).toMatchObject({ display: 0 })
  expect(out.gpu).toEqual(['number', true])
  expect(out.created).toBe('surface-created')
  expect(out.badKind).toEqual({ error: 'EINVAL' })
  expect(out.badSize).toEqual({ error: 'EINVAL' })
  expect(out.huge).toEqual({ error: 'EINVAL' })
  expect(out.badRole).toEqual({ error: 'EINVAL' })
  expect(out.meta).toMatchObject({ title: 'Doc', role: 'window', opaque: false, width: 4, height: 2, scale: 2, kind: 'bitmap' })
  expect(out.commit).toEqual([1, 1, [{ x: 0, y: 0, width: 2, height: 2 }], 32, true])
  expect(out.wrongSize).toEqual({ error: 'EINVAL' })
  expect(out.badDamage).toEqual({ error: 'EINVAL' })
  expect(out.noPixels).toBe(2) // a commit without pixels is a frame notification (canvas surfaces)
  expect(out.resized).toBe(8)
  expect(out.attachBitmap).toEqual({ error: 'EINVAL' })
  expect(out.commitGl).toEqual({ error: 'EINVAL' })
  expect(out.cursor).toEqual([null, 'grab', { error: 'EINVAL' }])
  expect(out.fonts).toEqual([])
  expect(out.app).toEqual({ mine: 'number', other: { error: 'EPERM' }, listed: 1, cap: { error: 'EPERM' } })
  expect(out.afterExit).not.toContain('com.example.painter')
  expect(out.destroyed).toBeNull()
  expect(out.again).toEqual({ error: 'ENOENT' })
  expect(out.fullscreen).toEqual({ error: 'ETIMEDOUT' })
})

// ------------------------------------------------------------------------------------------ audio

test('audio: volume, mute and per-app volume shape the samples that reach the page', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const pcm: Array<{ stream: number; samples: Float32Array }> = []
    k.onEvent((e) => e.type === 'driver' && e.device === 'audio' && (e.data as any).op === 'pcm' && pcm.push(e.data as any))
    const box = await inbox()
    await ask('audio', { op: 'subscribe' }, [box.port])
    const sound = new Float32Array([1, -1, 0.5, 0.5])
    res.badRate = await ask('audio', { op: 'open', sampleRate: 100 })
    res.badChannels = await ask('audio', { op: 'open', channels: 9 })
    res.badKind = await ask('audio', { op: 'open', kind: 'screech' })
    const s = await ask('audio', { op: 'open', sampleRate: 44100, channels: 2 })

    const w1 = await ask('audio', { op: 'write', stream: s, buffer: sound })
    await new Promise((r) => setTimeout(r, 100))
    res.full = [w1, Array.from(pcm[0]!.samples)]
    await new Promise((r) => setTimeout(r, 300)) // long enough for the speaker indicator to notice
    await ask('audio', { op: 'setVolume', volume: 0.25 })
    await ask('audio', { op: 'write', stream: s, buffer: sound.buffer })
    await new Promise((r) => setTimeout(r, 100))
    res.quarter = Array.from(pcm[1]!.samples)
    res.volume = [await ask('audio', { op: 'volume' }), await k.configGet('tiny.audio', 'volume')]
    res.badVolume = [await ask('audio', { op: 'setVolume', volume: 'loud' })]
    await ask('audio', { op: 'setVolume', volume: 7 })
    res.clamped = (await ask('audio', { op: 'volume' })).volume
    await ask('audio', { op: 'mute', on: true })
    const muted = await ask('audio', { op: 'write', stream: s, buffer: sound })
    await new Promise((r) => setTimeout(r, 100))
    res.muted = [muted.gain, pcm.length]
    await ask('audio', { op: 'mute', on: false })
    // setting changed elsewhere (Settings app writes the config) is picked up too
    await k.configSet('tiny.audio', 'volume', 0.5)
    await new Promise((r) => setTimeout(r, 100))
    res.configWatch = (await ask('audio', { op: 'volume' })).volume

    res.badWrite = [
      await ask('audio', { op: 'write', stream: s, buffer: new Float32Array(3) }), // not whole frames
      await ask('audio', { op: 'write', stream: s, buffer: 'la la' }),
      await ask('audio', { op: 'write', stream: s, buffer: new ArrayBuffer(2 << 20) }),
      await ask('audio', { op: 'write', stream: 999, buffer: sound }),
    ]
    res.streams = (await ask('audio', { op: 'streams' })).length
    await ask('audio', { op: 'close', stream: s })
    res.closed = await ask('audio', { op: 'write', stream: s, buffer: sound })

    const events = (await box.all(300)).map((e) => e.type)
    res.events = [events.includes('volume'), events.includes('playback')]
    res.node = await ask('audio', { op: 'node' })
    res.noSound = await ask('audio', { op: 'sound', name: 'nonexistent' })
    res.badSound = await ask('audio', { op: 'sound', name: '../../etc/passwd' })
    return res
  })
  expect(out.badRate).toEqual({ error: 'EINVAL' })
  expect(out.badChannels).toEqual({ error: 'EINVAL' })
  expect(out.badKind).toEqual({ error: 'EINVAL' })
  expect(out.full).toEqual([{ frames: 2, gain: 1 }, [1, -1, 0.5, 0.5]])
  expect(out.quarter).toEqual([0.25, -0.25, 0.125, 0.125])
  expect(out.volume).toEqual([{ volume: 0.25, muted: false }, 0.25])
  expect(out.badVolume).toEqual([{ error: 'EINVAL' }])
  expect(out.clamped).toBe(1)
  expect(out.muted).toEqual([0, 2])
  expect(out.configWatch).toBe(0.5)
  expect(out.badWrite).toEqual([{ error: 'EINVAL' }, { error: 'EINVAL' }, { error: 'E2BIG' }, { error: 'ENOENT' }])
  expect(out.streams).toBe(1)
  expect(out.closed).toEqual({ error: 'ENOENT' })
  expect(out.events).toEqual([true, true])
  expect(out.node).toEqual({ error: 'ENOSYS' })
  expect(out.noSound).toEqual({ error: 'ENOENT' })
  expect(out.badSound).toEqual({ error: 'EINVAL' })
})

test('audio: apps are mixed per app, cannot change the mix, and need permission for the microphone', async ({ page }) => {
  const out = await page.evaluate(async (apps) => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const pcm: Array<{ stream: number; samples: Float32Array }> = []
    k.onEvent((e) => e.type === 'driver' && e.device === 'audio' && (e.data as any).op === 'pcm' && pcm.push(e.data as any))
    await ask('audio', { op: 'setAppVolume', app: 'com.example.player', volume: 0.5 })
    res.player = await window.runApp('com.example.player', apps.player, {}, true)
    await new Promise((r) => setTimeout(r, 100))
    res.appGain = [res.player.write?.gain, Array.from(pcm.at(-1)?.samples ?? [])]
    await ask('audio', { op: 'muteApp', app: 'com.example.player', on: true })
    pcm.length = 0
    res.mutedApp = (await window.runApp('com.example.player', apps.player, {}, true)).write?.gain
    res.noPcm = pcm.length
    res.table = await ask('audio', { op: 'appVolumes' })
    res.set = await window.runApp('com.example.mixer', apps.mixer, {}, true)
    res.mic = [await window.runApp('com.example.recorder', apps.mic, { permissions: ['audio.input'] }, false)]
    res.badApp = await ask('audio', { op: 'setAppVolume', app: '', volume: 1 })
    return res
  }, {
    player: `export default async (tiny) => {
      const port = await tiny.lookup('tiny.audio')
      const ask = async (m) => { const r = (await tiny.request(port, m, { timeout: 5000 })).data; return r.ok ? r.result : { error: r.error.code } }
      const stream = await ask({ op: 'open', channels: 1 })
      const write = await ask({ op: 'write', stream, buffer: new Float32Array([1, 0.5]) })
      const state = await ask({ op: 'state' })
      await tiny.writeFile('/tmp/com.example.player.out', new TextEncoder().encode(JSON.stringify({ write, playing: state.playing.length })))
    }`,
    mixer: appAsking('com.example.mixer', 'audio', { op: 'setVolume', volume: 0 }),
    mic: appAsking('com.example.recorder', 'audio', { op: 'inputRequest' }, 'const mine = await tiny.portCreate()').replace('{ op: "inputRequest" }', '{ op: "inputRequest" }, { rights: [mine] }'),
  })
  expect(out.player.write.gain).toBe(0.5)
  expect(out.player.playing).toBe(1)
  expect(out.appGain).toEqual([0.5, [0.5, 0.25]])
  expect(out.mutedApp).toBe(0)
  expect(out.noPcm).toBe(0)
  expect(out.table).toEqual({ volumes: { 'com.example.player': 0.5 }, muted: ['com.example.player'] })
  expect(out.set).toEqual({ error: 'EPERM' })
  expect(out.mic).toEqual([{ error: 'EPERM' }])
  expect(out.badApp).toEqual({ error: 'EINVAL' })
})

test('audio: the page driver answers device and microphone requests, and sends microphone samples', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel: k, ask, inbox } = window
    const res: Record<string, any> = {}
    const asked: Array<{ op: string; id: number; stream?: number }> = []
    k.onEvent((e) => {
      if (e.type !== 'driver' || e.device !== 'audio') return
      const d = e.data as any
      if (d.id === undefined) return asked.push(d)
      asked.push(d)
      // play the page: answer devices, the microphone and device changes
      if (d.op === 'devices') void k.driverPush('audio', { event: 'reply', id: d.id, ok: true, result: [{ id: 'speakers', label: 'Speakers' }] })
      else if (d.op === 'micOpen') void k.driverPush('audio', { event: 'reply', id: d.id, ok: true, result: { sampleRate: 16000, channels: 1 } })
      else if (d.op === 'setDevice') void k.driverPush('audio', { event: 'reply', id: d.id, ok: false, code: 'ENOSYS', message: 'no sinkId' })
    })
    res.devices = await ask('audio', { op: 'devices' })
    res.setDevice = await ask('audio', { op: 'setDevice', id: 'speakers' })
    const box = await inbox()
    const mic = await ask('audio', { op: 'inputRequest', sampleRate: 16000 }, [box.port])
    res.mic = mic
    await k.driverPush('audio', { event: 'mic', stream: mic.stream, samples: new Float32Array([0.1, 0.2]), sampleRate: 16000, channels: 1 })
    const chunk = await box.next()
    res.chunk = [chunk.type, chunk.stream === mic.stream, Array.from(chunk.samples as Float32Array).map((x) => +x.toFixed(1))]
    res.close = [await ask('audio', { op: 'inputClose', stream: mic.stream }), await ask('audio', { op: 'inputClose', stream: mic.stream })]
    res.micClosed = asked.some((a) => a.op === 'micClose')
    // context state from the page shows up in `state`
    await k.driverPush('audio', { event: 'context', state: 'running', baseLatency: 0.01, outputLatency: 0.02 })
    await new Promise((r) => setTimeout(r, 50))
    res.state = await ask('audio', { op: 'state' })
    return res
  })
  expect(out.devices).toEqual([{ id: 'speakers', label: 'Speakers' }])
  expect(out.setDevice).toEqual({ error: 'ENOSYS' })
  expect(out.mic).toMatchObject({ sampleRate: 16000, channels: 1 })
  expect(out.chunk).toEqual(['mic', true, [0.1, 0.2]])
  expect(out.close).toEqual([true, false])
  expect(out.micClosed).toBe(true)
  expect(out.state).toMatchObject({ context: 'running', baseLatency: 0.01, outputLatency: 0.02 })
})
