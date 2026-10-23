/** `tiny.session`: session save and restore, power, lock, startup items, safe mode (`contracts/boot-and-session.md`). */
import { expect, test } from './fixtures'

test.use({ system: true, helpers: true })

test('save, load and clear; an app keeps its own state; corrupt data is discarded', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, sh } = window
    const empty = await ask('session', { op: 'load' })
    await ask('session', { op: 'save', state: { windows: [{ id: 1, app: 'org.x' }], version: 3 } })
    const loaded = await ask('session', { op: 'load' })
    // an app stores its own state and reads it back
    const mine = await window.runApp('org.test.notes', `export default async (tiny) => {
      const port = await tiny.lookup('tiny.session')
      await tiny.request(port, { op: 'saveApp', state: { cursor: 42 } })
      const r = (await tiny.request(port, { op: 'appState' })).data
      const denied = (await tiny.request(port, { op: 'save', state: 'x' })).data
      await tiny.writeFile('/tmp/org.test.notes.out', new TextEncoder().encode(JSON.stringify({ state: r.result, denied: denied.error.code })))
    }`)
    const system = await ask('session', { op: 'appState', appId: 'org.test.notes' })
    await ask('session', { op: 'saveAll' })
    const after = await ask('session', { op: 'load' })
    await window.kernel.writeFile('/var/db/session.json', new TextEncoder().encode('{not json'))
    const corrupt = await ask('session', { op: 'load' })
    const removed = !(await window.kernel.exists('/var/db/session.json'))
    await ask('session', { op: 'save', state: 1 })
    await ask('session', { op: 'clear' })
    return { empty, loaded: loaded.state, mine, system, apps: after.apps, corrupt, removed, cleared: await ask('session', { op: 'load' }), log: (await window.kernel.logQuery({ subsystem: 'session' })).map((e) => e.message) }
  })
  expect(out.empty).toBeNull()
  expect(out.loaded).toEqual({ windows: [{ id: 1, app: 'org.x' }], version: 3 })
  expect(out.mine).toEqual({ state: { cursor: 42 }, denied: 'EPERM' })
  expect(out.system).toEqual({ cursor: 42 })
  expect(out.apps).toEqual(['org.test.notes'])
  expect(out.corrupt).toBeNull()
  expect(out.removed).toBe(true)
  expect(out.cleared).toBeNull()
  expect(out.log[0]).toMatch(/session data discarded/)
})

test('saveAll asks the session manager and registered apps for their state', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    // Desktop: a port that answers {type: 'save-state'}
    const manager = await kernel.portCreate()
    await ask('session', { op: 'registerSessionManager' }, [manager])
    const answering = (async () => {
      const m = await kernel.receive(manager, { timeout: 5000 })
      await kernel.send(m.replyTo!, { state: { windows: ['finder'] } })
    })()
    const r = await ask('session', { op: 'saveAll' })
    await answering
    return { r, loaded: (await ask('session', { op: 'load' })).state }
  })
  expect(out.loaded).toEqual({ windows: ['finder'] })
  expect(out.r.savedAt).toBeGreaterThan(0)
})

test('power: shutdown tells subscribers and saves first; sleep and wake; the page is told', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    const detach = window.attachDrivers()
    const power: string[] = []
    window.addEventListener('tiny:power', (e) => power.push((e as CustomEvent).detail.action))
    const inbox = await window.inbox()
    await ask('session', { op: 'subscribe' }, [inbox.port])
    const state0 = await ask('session', { op: 'state' })
    await ask('session', { op: 'sleep' })
    const asleep = (await ask('session', { op: 'state' })).phase
    await ask('session', { op: 'wake' })
    const awake = (await ask('session', { op: 'state' })).phase
    await ask('session', { op: 'restart' })
    const again = await ask('session', { op: 'shutdown' })
    await window.sh.sleep(300)
    const events = (await inbox.all(300)).map((e) => e.type)
    detach()
    return { state0, asleep, awake, again, events, power }
  })
  expect(out.state0).toMatchObject({ phase: 'running', locked: false, safeMode: false, restore: 'restore' })
  expect(out.asleep).toBe('asleep')
  expect(out.awake).toBe('running')
  expect(out.again).toEqual({ error: 'EBUSY' })
  expect(out.events).toEqual(['willSleep', 'sleeping', 'didWake', 'willShutdown', 'powerOff'])
  expect(out.power).toEqual(['sleep', 'restart'])
})

test('lock screen: locks, refuses a wrong password, unlocks; apps cannot lock or unlock', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask } = window
    const inbox = await window.inbox()
    await ask('session', { op: 'subscribe' }, [inbox.port])
    await ask('session', { op: 'lockScreen' })
    const open = await ask('session', { op: 'unlock', password: 'anything' }) // no password set yet
    await ask('session', { op: 'setPassword', password: 'hunter2' })
    await ask('session', { op: 'lockScreen' })
    const wrong = await ask('session', { op: 'unlock', password: 'nope' })
    const locked = (await ask('session', { op: 'state' })).locked
    const right = await ask('session', { op: 'unlock', password: 'hunter2' })
    const changeWrong = await ask('session', { op: 'setPassword', old: 'bad', password: 'x' })
    await ask('session', { op: 'setPassword', old: 'hunter2', password: '' })
    const app = await window.runApp('org.test.locker', `export default async (tiny) => {
      const r = (await tiny.request(await tiny.lookup('tiny.session'), { op: 'lockScreen' })).data
      await tiny.writeFile('/tmp/org.test.locker.out', new TextEncoder().encode(JSON.stringify(r.error.code)))
    }`)
    return { open, wrong, locked, right, changeWrong, hasPassword: await ask('session', { op: 'hasPassword' }), app, events: (await inbox.all(200)).map((e) => e.type) }
  })
  expect(out).toMatchObject({ open: true, wrong: { error: 'EACCES' }, locked: true, right: true, changeWrong: { error: 'EACCES' }, hasPassword: false, app: 'EPERM' })
  expect(out.events).toEqual(['locked', 'unlocked', 'locked', 'unlocked'])
})

test('startup items open at login; page events and updates reach subscribers', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    await window.sh.app('org.test.login', `export default async (tiny) => { await tiny.writeFile('/tmp/login.out', new TextEncoder().encode('opened')); await new Promise(() => {}) }`, {}, true)
    await ask('session', { op: 'startup.add', appId: 'org.test.login' })
    await ask('session', { op: 'startup.add', appId: 'org.test.login' })
    await ask('session', { op: 'startup.add', appId: 'org.missing' })
    const list = await ask('session', { op: 'startup.list' })
    const login = await ask('session', { op: 'login' })
    await window.sh.waitFor('/tmp/login.out')
    const inbox = await window.inbox()
    await ask('session', { op: 'subscribe' }, [inbox.port])
    await kernel.driverPush('session', { event: 'visibility', visible: false })
    await kernel.driverPush('session', { event: 'online', online: false })
    await kernel.driverPush('session', { event: 'update', ready: true, version: '1.1' })
    const events = await inbox.all(400)
    const noUpdate = await ask('session', { op: 'update.status' })
    await ask('session', { op: 'startup.remove', appId: 'org.missing' })
    return { list, opened: login.opened, events, status: noUpdate, state: await ask('session', { op: 'state' }) }
  })
  expect(out.list).toEqual(['org.test.login', 'org.missing'])
  expect(out.opened).toEqual(['org.test.login'])
  expect(out.events.map((e: any) => e.type)).toEqual(['visibility', 'offline', 'updateReady'])
  expect(out.status).toEqual({ ready: true, version: '1.1' })
  expect(out.state).toMatchObject({ visible: false, online: false })
})

test('after a crash the restore policy asks; safe mode skips startup items, session and third-party services', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const { ask } = window
    await window.sh.app('org.test.agent', `export default async (tiny) => { await tiny.writeFile('/tmp/agent.out', new TextEncoder().encode('up')); await new Promise(() => {}) }`, { kind: 'service', autostart: true }, true)
    await ask('session', { op: 'save', state: { windows: [1] } })

    await window.sh.crash(ns, { system: true })
    const ask2 = async (msg: Record<string, unknown>) => {
      const k = window.kernel
      const reply = (await k.request(await k.lookup('tiny.session'), msg, { timeout: 8000 })).data as any
      return reply.ok ? reply.result : { error: reply.error.code }
    }
    const crashed = { info: await window.kernel.bootInfo(), policy: await ask2({ op: 'restorePolicy' }), session: await ask2({ op: 'load' }) }
    const agentUp = (await window.kernel.listProcesses()).some((p) => p.bundleId === 'org.test.agent' && p.state === 'running')
    await window.sh.crash(ns, { system: { safeMode: true } } as never)
    const safe = {
      info: await window.kernel.bootInfo(), policy: await ask2({ op: 'restorePolicy' }), session: await ask2({ op: 'load' }),
      state: await ask2({ op: 'state' }), login: await ask2({ op: 'login' }),
      agentUp: (await window.kernel.listProcesses()).some((p) => p.bundleId === 'org.test.agent' && p.state === 'running'),
      sessionService: (await window.kernel.listProcesses()).some((p) => p.bundleId === 'org.tiny.service.session' && p.state === 'running'),
    }
    return { crashed, agentUp, safe }
  }, ns)
  expect(out.crashed.info).toMatchObject({ previousShutdown: 'crash', safeMode: false })
  expect(out.crashed.policy).toBe('ask')
  expect(out.crashed.session).toMatchObject({ state: { windows: [1] } })
  expect(out.agentUp).toBe(true)
  expect(out.safe.info.safeMode).toBe(true)
  expect(out.safe.policy).toBe('skip')
  expect(out.safe.session).toBeNull()
  expect(out.safe.state).toMatchObject({ safeMode: true, restore: 'skip' })
  expect(out.safe.login).toEqual({ opened: [], skipped: 'safeMode' })
  expect(out.safe.agentUp).toBe(false)
  expect(out.safe.sessionService).toBe(true)
})
