import { Owners, Subscribers, callerInfo, fail, hostBridge, needPort, needSystem, serve, subscription, type Handler } from './lib'
import type { Pear } from '../src/runtime'

interface Timer {
  id: number
  owner: number
  port: number
  repeat: boolean
  ms: number
  tolerance: number
  handle: ReturnType<typeof setTimeout> | undefined
  due: number
  /** When the current handle is set to fire. A later timer may join this tick. */
  tick: number
}
interface Pending {
  id: number
  owner: number
  port: number
  timer?: ReturnType<typeof setTimeout>
}

const MAX_TIMERS = 256
const MIN_REPEAT_MS = 4 // what browsers clamp nested timers to
const KEEP_AWAKE_MAX = 16

/**
 * `tiny.timers`: clocks and timers (`contracts/timers.md`). A timer delivers `{type: 'timer', id}` to the port the
 * caller passes in `rights`; frames `{type: 'frame', id, time}`, idle callbacks `{type: 'idle', id}`. The page's driver
 * supplies display-aligned frames, idle time, wake locks and visibility; without it frames are paced at 60 Hz and idle
 * callbacks run after their timeout.
 */
export default async (tiny: Pear) => {
  const timers = new Map<number, Timer>()
  const frames = new Map<number, Pending>()
  const idles = new Map<number, Pending>()
  const awake = new Map<number, { owner: number; reason: string; type: 'display' | 'system' | 'idle'; since: number }>()
  const idleWatch = new Set<{ port: number; owner: number; after: number; idle: boolean }>()
  let lastActivity = Date.now()
  const watchers = new Subscribers<{ port: number }>(tiny)
  const host = hostBridge(tiny, 'timers')
  const owners = new Owners(tiny, (pid) => drop(pid))
  let nextId = 1
  let visible = true
  let frameAsked = false
  let lastWall = Date.now()
  let lastMono = performance.now()

  const tz = async () => {
    const z = String(await tiny.configGet('tiny.system', 'timezone', 'auto'))
    return z === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : z
  }
  const tell = (port: number, event: unknown) => tiny.send(port, event)

  const arm = (t: Timer) => {
    const now = Date.now()
    let fire = Math.max(now, t.due)
    if (t.tolerance > 0) {
      // coalesce: land on the next multiple of the tolerance, or on the tick a like timer
      // is already waiting for, when that costs no more than the tolerance allows
      fire = Math.ceil(fire / t.tolerance) * t.tolerance
      for (const u of timers.values()) {
        if (u === t || u.tolerance !== t.tolerance || u.handle === undefined || u.tick <= now) continue
        if (Math.abs(u.tick - t.due) <= t.tolerance) {
          fire = u.tick
          break
        }
      }
    }
    t.tick = fire
    t.handle = setTimeout(async () => {
      await tell(t.port, { type: 'timer', id: t.id, time: Date.now() }).catch((e: { code?: string }) => {
        if (e?.code === 'EPIPE' || e?.code === 'EACCES') stop(t.id)
      })
      if (!timers.has(t.id)) return
      if (t.repeat) {
        t.due = Math.max(t.due + t.ms, Date.now())
        arm(t)
      } else timers.delete(t.id)
    }, fire - now)
  }
  const stop = (id: number) => {
    const t = timers.get(id)
    if (!t) return false
    clearTimeout(t.handle)
    timers.delete(id)
    return true
  }
  const add = (owner: number, port: number | undefined, due: number, ms: number, repeat: boolean, tolerance: unknown) => {
    if (port === undefined) throw fail('EINVAL', 'pass a port in rights to receive the timer')
    if ([...timers.values()].filter((t) => t.owner === owner).length >= MAX_TIMERS) throw fail('EMFILE', 'too many timers')
    if (typeof tolerance !== 'number' && tolerance !== undefined) throw fail('EINVAL', 'tolerance must be a number of ms')
    const t: Timer = { id: nextId++, owner, port, repeat, ms, tolerance: Math.max(0, Math.min(Number(tolerance ?? 0), 60_000)), handle: undefined, due, tick: 0 }
    timers.set(t.id, t)
    owners.add(owner)
    arm(t)
    return t.id
  }
  const num = (v: unknown, what: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw fail('EINVAL', `${what} must be a number`)
    return v
  }

  // frames: ask the page for one display-aligned callback at a time and hand it to everyone waiting
  const askFrame = () => {
    if (frameAsked) return
    frameAsked = true
    void host.emit('frame').catch(() => {})
    // no page driver (or a hidden tab): do not leave callers hanging forever
    setTimeout(() => visible && frameAsked && deliverFrames(performance.now()), 50)
  }
  const deliverFrames = (time: number) => {
    frameAsked = false
    const due = [...frames.values()]
    frames.clear()
    for (const f of due) void tell(f.port, { type: 'frame', id: f.id, time }).catch(() => {})
  }
  const finishIdle = (id: number, timedOut: boolean) => {
    const p = idles.get(id)
    if (!p) return
    clearTimeout(p.timer)
    idles.delete(id)
    void tell(p.port, { type: 'idle', id, timedOut }).catch(() => {})
  }

  const drop = (pid: number) => {
    for (const t of [...timers.values()]) if (t.owner === pid) stop(t.id)
    for (const [id, f] of frames) if (f.owner === pid) frames.delete(id)
    for (const [id, p] of idles) if (p.owner === pid) (clearTimeout(p.timer), idles.delete(id))
    for (const [id, a] of awake) if (a.owner === pid) awake.delete(id)
    for (const w of [...idleWatch]) if (w.owner === pid) idleWatch.delete(w)
    syncAwake()
  }
  let wasAwake = false
  const syncAwake = () => {
    const shown = [...awake.values()].filter((a) => a.type === 'display')
    const on = shown.length > 0
    if (on === wasAwake) return
    wasAwake = on
    void host.emit('keepAwake', { on, reasons: shown.map((a) => a.reason) }).catch(() => {})
  }

  // user idle: checked once a second, only while someone watches
  setInterval(async () => {
    if (!idleWatch.size) return
    const held = [...awake.values()].some((a) => a.type === 'idle' || a.type === 'display')
    const idleFor = Date.now() - lastActivity
    for (const w of [...idleWatch]) {
      if (w.idle || held || idleFor < w.after) continue
      w.idle = true
      await tiny.send(w.port, { type: 'userIdle', idle: true, after: w.after }).catch(() => idleWatch.delete(w))
    }
  }, 1000)

  // a clock that jumped: wall time moved differently from the monotonic clock
  setInterval(() => {
    const wall = Date.now()
    const mono = performance.now()
    const jump = wall - lastWall - (mono - lastMono)
    lastWall = wall
    lastMono = mono
    if (Math.abs(jump) > 1500) void watchers.send({ type: 'clock-jump', delta: Math.round(jump) })
  }, 1000)

  const cancelPending = (map: Map<number, Pending>, id: number, owner: number) => {
    const p = map.get(id)
    if (!p) return false
    if (p.owner !== owner && owner !== 1) throw fail('EPERM', 'not your request')
    clearTimeout(p.timer)
    return map.delete(id)
  }

  const table: Record<string, Handler> = {
      now: async () => ({ wall: Date.now(), monotonic: performance.now(), timezone: await tz() }),
      timezone: tz,
      setTimezone: async (a, m) => {
        await needSystem(tiny, m, 'change the time zone')
        const zone = String(a.zone)
        if (zone !== 'auto') {
          try {
            new Intl.DateTimeFormat('en', { timeZone: zone })
          } catch {
            throw fail('EINVAL', `unknown time zone ${zone}`)
          }
        }
        await tiny.configSet('tiny.system', 'timezone', zone)
        await watchers.send({ type: 'timezone', zone: await tz() })
      },
      set: (a, m) => add(m.from, m.rights[0], Date.now() + Math.max(num(a.ms, 'ms'), a.repeat ? MIN_REPEAT_MS : 0), Math.max(num(a.ms, 'ms'), MIN_REPEAT_MS), Boolean(a.repeat), a.tolerance),
      at: (a, m) => {
        const when = a.time instanceof Date ? a.time.getTime() : num(a.time, 'time')
        return add(m.from, m.rights[0], when, 0, false, a.tolerance)
      },
      clear: (a, m) => {
        const t = timers.get(a.id)
        if (!t) return false
        if (t.owner !== m.from && m.from !== 1) throw fail('EPERM', 'not your timer')
        return stop(t.id)
      },
      frameRequest: (a, m) => {
        const port = needPort(m)
        if ([...frames.values()].filter((f) => f.owner === m.from).length >= 64) throw fail('EMFILE', 'too many frame requests')
        const id = nextId++
        frames.set(id, { id, owner: m.from, port })
        owners.add(m.from)
        askFrame()
        return id
      },
      frameCancel: (a, m) => cancelPending(frames, a.id, m.from),
      idleRequest: (a, m) => {
        const port = needPort(m)
        if ([...idles.values()].filter((f) => f.owner === m.from).length >= 64) throw fail('EMFILE', 'too many idle requests')
        const id = nextId++
        const p: Pending = { id, owner: m.from, port }
        // the page tells us when it is idle; whatever happens the callback runs by its timeout
        p.timer = setTimeout(() => finishIdle(id, true), Math.max(0, Math.min(Number(a.timeout ?? 1000), 60_000)))
        idles.set(id, p)
        owners.add(m.from)
        void host.emit('idle', { ref: id }).catch(() => {})
        return id
      },
      idleCancel: (a, m) => cancelPending(idles, a.id, m.from),
      keepAwake: async (a, m) => {
        const reason = String(a.reason ?? '').slice(0, 100)
        if (!reason) throw fail('EINVAL', 'say why the system should stay awake')
        if ([...awake.values()].filter((x) => x.owner === m.from).length >= KEEP_AWAKE_MAX) throw fail('EMFILE', 'too many wake locks')
        const id = nextId++
        const type = ['display', 'system', 'idle'].includes(a.type) ? a.type : 'display'
        awake.set(id, { owner: m.from, reason, type, since: Date.now() })
        owners.add(m.from)
        syncAwake()
        return id
      },
      /**
       * Power assertions: `display` keeps the screen on (Wake Lock), `system` asks that the system not sleep, `idle`
       * stops the user-idle signal (a video is playing, say). `power.assertions` lists them for Activity Monitor.
       */
      'power.assertions': () => [...awake].map(([id, x]) => ({ id, type: x.type, reason: x.reason, owner: x.owner, since: x.since })),
      'power.state': () => ({
        visible, assertions: awake.size, preventsSleep: [...awake.values()].some((a) => a.type !== 'idle'),
        preventsIdle: [...awake.values()].some((a) => a.type === 'idle' || a.type === 'display'),
      }),
      'userIdle.watch': (a, m) => {
        const port = needPort(m)
        const after = Math.max(1000, Math.min(Number(a.after ?? 60_000), 24 * 3600_000))
        if (idleWatch.size >= 32) throw fail('EMFILE', 'too many idle watchers')
        idleWatch.add({ port, owner: m.from, after, idle: false })
        owners.add(m.from)
      },
      'userIdle.unwatch': (_a, m) => {
        for (const w of idleWatch) if (w.port === m.rights[0]) idleWatch.delete(w)
      },
      'userIdle.state': () => ({ idleMs: Date.now() - lastActivity, lastActivity }),
      release: (a, m) => {
        const x = awake.get(a.id)
        if (!x) return false
        if (x.owner !== m.from && m.from !== 1) throw fail('EPERM', 'not your wake lock')
        awake.delete(a.id)
        syncAwake()
        return true
      },
      visibility: () => ({ visible }),
      ...subscription(watchers),
      info: async (_a, m) => {
        const c = await callerInfo(tiny, m)
        return { timers: [...timers.values()].filter((t) => c.system || t.owner === m.from).length, awake: awake.size, visible }
      },
  }
  table['power.assert'] = table.keepAwake!
  table['power.release'] = table.release!

  return serve(
    tiny,
    'tiny.timers',
    table,
    async (d) => {
      const data = d?.type === 'driver' ? d.data : null
      if (!data || host.reply(data)) return
      switch (data.event) {
        case 'frame':
          return deliverFrames(Number(data.time ?? performance.now()))
        case 'idle':
          return finishIdle(Number(data.id), false)
        case 'visibility': {
          visible = Boolean(data.visible)
          await watchers.send({ type: 'visibility', visible })
          if (visible) {
            // timers were throttled while hidden: tell clocks to catch up
            await watchers.send({ type: 'resumed', wall: Date.now() })
            if (frames.size) askFrame()
          }
          return
        }
        case 'activity':
          lastActivity = Date.now()
          for (const w of [...idleWatch]) {
            if (!w.idle) continue
            w.idle = false
            await tiny.send(w.port, { type: 'userIdle', idle: false }).catch(() => idleWatch.delete(w))
          }
          return
        case 'resumed':
          lastWall = Date.now()
          lastMono = performance.now()
          return watchers.send({ type: 'resumed', wall: Date.now() })
      }
    },
  )
}
