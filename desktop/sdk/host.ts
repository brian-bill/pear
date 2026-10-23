/// The program every UI app runs as its process (`main.js`). The app's windows live in iframes, which cannot touch
/// Vanilla, so each call from a window travels here and runs as *this process*: confined to the app's container and
/// grants, with the app's permissions. Desktop adds nothing the app could not do itself.
import type { Pear } from '../../vanilla/kernel/src/runtime'
import type { HostEvent, HostReply, HostRequest } from './protocol'

/** Calls a window may not make: process control belongs to Desktop. */
const BLOCKED = new Set(['exit', 'onSignal', 'driverEmit', 'portCreate', 'portDestroy', 'send', 'receive', 'register', 'lookup', 'watch', 'unwatch', 'request', 'stdin', 'stdout', 'stderr'])

export default async (tiny: Pear) => {
  const appId = (await tiny.getappid()) ?? 'unknown'
  const ui = await tiny.portCreate()
  await tiny.register(`ui.${appId}`, ui)
  // Launch services send openFile / openURL / activate to `app.<id>` for a running single-instance app.
  const app = await tiny.portCreate()
  await tiny.register(`app.${appId}`, app)

  let events: number | null = null
  const queue: HostEvent[] = []
  const emit = async (e: HostEvent) => {
    if (events === null) return void queue.push(e)
    await tiny.send(events, e).catch(() => {})
  }
  // a file the app was launched with arrives as an argument, not a message
  void (async () => {
    for (;;) {
      const m = await tiny.receive(app)
      const d = m.data as HostEvent
      if (d && typeof d === 'object' && typeof d.type === 'string') await emit(d)
    }
  })()

  const reply = (to: number | null, r: HostReply) => (to === null ? Promise.resolve() : tiny.send(to, r).catch(() => {}))
  const fail = (e: unknown): HostReply => {
    const err = e as { code?: string; message?: string }
    return { ok: false, error: { code: err.code ?? 'EIO', message: err.message ?? String(e) } }
  }

  const handle = async (req: HostRequest, rights: number[]): Promise<HostReply> => {
    switch (req.op) {
      case 'hello':
        return { ok: true, result: { pid: tiny.pid, appId, args: tiny.args } }
      case 'attach': {
        events = rights[0] ?? null
        for (const e of queue.splice(0)) await emit(e)
        return { ok: true, result: null }
      }
      case 'call': {
        if (BLOCKED.has(req.method)) return fail(Object.assign(new Error(`${req.method} is not available to windows`), { code: 'EPERM' }))
        const fn = (tiny as unknown as Record<string, unknown>)[req.method]
        if (typeof fn !== 'function') return fail(Object.assign(new Error(`no such call ${req.method}`), { code: 'ENOSYS' }))
        return { ok: true, result: (await (fn as (...a: unknown[]) => unknown).apply(tiny, req.args)) ?? null }
      }
      case 'service': {
        if (typeof req.name !== 'string' || !/^tiny\.[a-z]+$/.test(req.name)) return fail(Object.assign(new Error('only system services can be called'), { code: 'EINVAL' }))
        const port = await tiny.lookup(req.name)
        const r = (await tiny.request(port, req.msg, { timeout: req.timeout ?? 15_000 })).data as { ok: boolean; result?: unknown; error?: { code: string; message: string } }
        return r.ok ? { ok: true, result: r.result ?? null } : { ok: false, error: r.error ?? { code: 'EIO', message: 'the service failed' } }
      }
    }
    return fail(Object.assign(new Error('unknown request'), { code: 'EINVAL' }))
  }

  for (;;) {
    const m = await tiny.receive(ui)
    // requests are handled concurrently: a slow read must not hold up the next call
    void handle(m.data as HostRequest, m.rights).catch(fail).then((r) => reply(m.replyTo, r))
  }
}
