/// Shared by the system services: a request loop on a named port. Each request is a message `{op, ...args}`
/// answered with `{ok: true, result}` or `{ok: false, error: {code, message}}`.
import type { Message } from '../src/ipc'
import type { Pear } from '../src/runtime'

export type Handler = (args: Record<string, any>, msg: Message) => unknown | Promise<unknown>

export async function serve(
  tiny: Pear,
  name: string,
  handlers: Record<string, Handler>,
  onKernel?: (data: any) => void | Promise<void>,
  setup?: (port: number) => void | Promise<void>,
): Promise<never> {
  const port = await tiny.portCreate()
  await tiny.register(name, port)
  await setup?.(port)
  for (;;) {
    const msg = await tiny.receive(port)
    if (msg.from === 0) {
      // sent by the kernel itself (settings changes)
      void Promise.resolve(onKernel?.(msg.data)).catch(() => {})
      continue
    }
    void answer(tiny, msg, handlers)
  }
}

async function answer(tiny: Pear, msg: Message, handlers: Record<string, Handler>): Promise<void> {
  let reply: unknown
  try {
    const req = (msg.data ?? {}) as Record<string, any>
    const handler = typeof req.op === 'string' ? handlers[req.op] : undefined
    if (!handler) throw Object.assign(new Error(`unknown operation ${String(req.op)}`), { code: 'ENOSYS' })
    reply = { ok: true, result: (await handler(req, msg)) ?? null }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    reply = { ok: false, error: { code: err.code ?? 'EIO', message: err.message ?? String(e) } }
  }
  if (msg.replyTo !== null) await tiny.send(msg.replyTo, reply).catch(() => {})
}

export const fail = (code: string, message: string) => Object.assign(new Error(message), { code })

/** Who is calling: init (the Desktop page, pid 1) and root outside any app are the system; everything else is an app or tool. */
export async function callerInfo(tiny: Pear, m: Message): Promise<{ system: boolean; appId: string | null }> {
  if (m.from === 1) return { system: true, appId: null }
  const info = await tiny.info(m.from)
  return { system: info.uid === 0 && !info.appId, appId: info.appId }
}
export async function needSystem(tiny: Pear, m: Message, what: string): Promise<void> {
  if (!(await callerInfo(tiny, m)).system) throw fail('EPERM', `only the system may ${what}`)
}
/** Apps need the capability (asking the user if undecided); programs outside any app hold them all. */
export async function needCapability(tiny: Pear, m: Message, capability: string, what: string): Promise<void> {
  if (m.from === 1) return
  let status = await tiny.permCheck(capability, undefined, { as: m.from })
  if (status === 'prompt') status = await tiny.permRequest(capability, { as: m.from })
  if (status !== 'granted') throw fail('EPERM', `this app may not ${what}`)
}

/** The port the caller passed in `rights`. */
export function needPort(m: Message, hint = 'pass a port in rights'): number {
  const port = m.rights[0]
  if (port === undefined) throw fail('EINVAL', hint)
  return port
}

/** Ports to tell about events. A port whose owner is gone is dropped; one with a full queue misses the event. */
export class Subscribers<T extends { port: number }> {
  readonly items = new Set<T>()
  constructor(
    private tiny: Pear,
    private limit = 64,
  ) {}
  add(s: T): T {
    if (this.items.size >= this.limit) throw fail('EMFILE', 'too many subscribers')
    this.items.add(s)
    return s
  }
  removePort(port: number): void {
    for (const s of this.items) if (s.port === port) this.items.delete(s)
  }
  async send(event: unknown, pick: (s: T) => boolean = () => true): Promise<void> {
    for (const s of [...this.items]) {
      if (!pick(s)) continue
      await this.tiny.send(s.port, event).catch((e: { code?: string }) => {
        if (e?.code === 'EPIPE' || e?.code === 'EACCES') this.items.delete(s)
      })
    }
  }
}

/** The `subscribe` / `unsubscribe` operations for a service whose watchers just get every event. */
export const subscription = (watchers: Subscribers<{ port: number }>): Record<'subscribe' | 'unsubscribe', Handler> => ({
  subscribe: (_a, m) => {
    watchers.add({ port: needPort(m) })
  },
  unsubscribe: (_a, m) => watchers.removePort(m.rights[0] as number),
})

/** The service's line to the page's driver: fire-and-forget commands, and commands whose answer the page pushes back. */
export function hostBridge(tiny: Pear, device: string) {
  let next = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  return {
    emit: (op: string, args: Record<string, unknown> = {}) => tiny.driverEmit(device, { op, ...args }).then(() => {}),
    /** Ask the page and wait for `{event: 'reply', id, ok, result | code, message}`. `ETIMEDOUT` if no page driver answers. */
    call: (op: string, args: Record<string, unknown> = {}, timeout = 1500): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = next++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(fail('ETIMEDOUT', `the ${device} driver did not answer`))
        }, timeout)
        pending.set(id, { resolve, reject, timer })
        tiny.driverEmit(device, { ...args, op, id }).catch((e) => {
          clearTimeout(timer)
          pending.delete(id)
          reject(e)
        })
      }),
    /** Feed the page's pushes through this first; true if it was an answer. */
    reply(data: any): boolean {
      if (data?.event !== 'reply') return false
      const p = pending.get(data.id)
      if (!p) return true
      pending.delete(data.id)
      clearTimeout(p.timer)
      if (data.ok) p.resolve(data.result ?? null)
      else p.reject(fail(data.code ?? 'EIO', data.message ?? 'the driver failed'))
      return true
    },
  }
}

/** Notices when the processes that own things (timers, surfaces, streams) are gone. */
export class Owners {
  private pids = new Set<number>()
  constructor(
    private tiny: Pear,
    private gone: (pid: number) => void | Promise<void>,
    every = 1000,
  ) {
    setInterval(() => void this.sweep(), every)
  }
  add(pid: number): void {
    if (pid !== 1) this.pids.add(pid)
  }
  async sweep(): Promise<void> {
    for (const pid of [...this.pids]) {
      const alive = await this.tiny.info(pid).then((i) => i.state === 'running', () => false)
      if (alive) continue
      this.pids.delete(pid)
      await this.gone(pid)
    }
  }
}

/** A random v4 UUID. `crypto.randomUUID` needs a secure context, which a sandboxed process does not have. */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
