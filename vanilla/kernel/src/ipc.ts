import { SysError } from './errors'

/** What a receiver gets: the payload plus who sent it and which send rights came with it. */
export interface Message {
  data: unknown
  /** Pid of the sender. */
  from: number
  /** Ports the sender passed along. The receiver may now send to them. */
  rights: number[]
  /** Port to answer on, if the sender used `request`. */
  replyTo: number | null
}

export interface SendOptions {
  /** Send rights to hand over. The sender must hold each of them. */
  rights?: number[]
  replyTo?: number
  /** `ArrayBuffer`s and `MessagePort`s inside `data` to move instead of copy. The sender loses them. */
  transfer?: Transferable[]
  /** If the port's queue is full, wait up to this many ms for room (`ETIMEDOUT`) instead of failing with `EAGAIN`. */
  timeout?: number
}

/** `from` of messages the kernel itself sends, such as dead-name notifications. */
const KERNEL_SENDER = 0

interface DeadName {
  type: 'dead-name'
  port: number
}

/** Transferables that travel with a queued message, so the kernel can pass them on without copying. */
const transfers = new WeakMap<Message, Transferable[]>()
export const transfersOf = (m: unknown): Transferable[] => (m && typeof m === 'object' ? (transfers.get(m as Message) ?? []) : [])

function checkTransfer(list: unknown): Transferable[] {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new SysError('EINVAL', 'transfer must be a list')
  for (const t of list) {
    if (!(t instanceof ArrayBuffer) && !(t instanceof MessagePort)) {
      throw new SysError('EINVAL', 'only ArrayBuffer and MessagePort can be transferred')
    }
  }
  return list
}

/** Messages a port holds before senders get `EAGAIN`. */
const QUEUE_LIMIT = 256
const MAX_NAME = 256

interface Receiver {
  resolve: (m: Message) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** A send blocked on a full queue. */
interface Sender {
  pid: number
  message: Message
  passing: number[]
  resolve: () => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface Port {
  id: number
  owner: number
  queue: Message[]
  receivers: Receiver[]
  senders: Sender[]
  /** Ports that get a dead-name notification when this one dies. */
  watchers: Set<number>
  name?: string
}

/**
 * Mach-style ports, routed by the kernel. A port has one owner, who holds the receive right
 * and is the only one who can receive. Anyone else needs a send right, which they get from
 * `lookup`, or from a message that carried it. Ids are not secrets: the rights table decides.
 */
export class PortTable {
  private ports = new Map<number, Port>()
  private names = new Map<string, number>()
  private rights = new Map<number, Set<number>>() // pid -> ports it may send to
  private nextId = 1

  private held(pid: number): Set<number> {
    let set = this.rights.get(pid)
    if (!set) this.rights.set(pid, (set = new Set()))
    return set
  }

  private live(id: unknown): Port {
    const port = typeof id === 'number' ? this.ports.get(id) : undefined
    if (!port) throw new SysError('EPIPE', 'port is dead or does not exist')
    return port
  }

  private owned(pid: number, id: unknown): Port {
    const port = this.live(id)
    if (port.owner !== pid) throw new SysError('EBADF', 'only the owner can do that to a port')
    return port
  }

  create(pid: number): number {
    const id = this.nextId++
    this.ports.set(id, { id, owner: pid, queue: [], receivers: [], senders: [], watchers: new Set() })
    this.held(pid).add(id)
    return id
  }

  destroy(pid: number, id: unknown): void {
    this.drop(this.owned(pid, id))
  }

  private drop(port: Port): void {
    this.ports.delete(port.id)
    if (port.name !== undefined && this.names.get(port.name) === port.id) this.names.delete(port.name)
    for (const r of port.receivers.splice(0)) {
      clearTimeout(r.timer)
      r.reject(new SysError('EPIPE', 'port was destroyed'))
    }
    for (const sender of port.senders.splice(0)) abortSend(sender, 'port was destroyed')
    for (const m of port.queue.splice(0)) closeTransferred(m)
    for (const set of this.rights.values()) set.delete(port.id)
    for (const other of this.ports.values()) other.watchers.delete(port.id) // it can no longer be notified

    for (const notify of port.watchers) {
      const target = this.ports.get(notify)
      if (!target) continue
      const data: DeadName = { type: 'dead-name', port: port.id }
      this.deliver(target, { data, from: KERNEL_SENDER, rights: [], replyTo: null })
    }
  }

  private deliver(port: Port, message: Message): void {
    const waiting = port.receivers.shift()
    if (waiting) {
      clearTimeout(waiting.timer)
      waiting.resolve(message)
    } else {
      port.queue.push(message)
    }
  }

  /** Puts a message on a port (there is room or a receiver) and gives the owner the rights it carries. */
  private accept(port: Port, message: Message, passing: number[]): void {
    const owner = this.held(port.owner)
    for (const r of passing) if (this.ports.has(r)) owner.add(r)
    this.deliver(port, message)
  }

  /** The kernel puts a message on a port (config changes, open-file requests). A full or dead port drops it. */
  notify(id: number, data: unknown): boolean {
    const port = this.ports.get(id)
    if (!port || (port.receivers.length === 0 && port.queue.length >= QUEUE_LIMIT)) return false
    this.deliver(port, { data, from: KERNEL_SENDER, rights: [], replyTo: null })
    return true
  }

  /** True if `pid` holds the receive right of a live port. */
  ownedBy(pid: number, id: unknown): boolean {
    const port = typeof id === 'number' ? this.ports.get(id) : undefined
    return port?.owner === pid
  }

  /** The port registered under a name, if it is alive. */
  find(name: string): number | undefined {
    return this.names.get(name)
  }

  /** A message left the queue: let the longest-blocked sender in. */
  private admitSender(port: Port): void {
    const sender = port.senders.shift()
    if (!sender) return
    clearTimeout(sender.timer)
    this.accept(port, sender.message, sender.passing)
    sender.resolve()
  }

  /**
   * Ask to be told when `id` dies: a `DeadName` message arrives on `notify`, a port you own. You need a
   * send right for `id`. A port that is already dead fails with `EPIPE`, which is the same news.
   */
  watch(pid: number, id: unknown, notify: unknown): void {
    const port = this.live(id)
    if (!this.held(pid).has(port.id)) throw new SysError('EACCES', 'no send right for that port')
    const target = this.owned(pid, notify)
    port.watchers.add(target.id)
  }

  unwatch(pid: number, id: unknown, notify: unknown): void {
    const target = this.owned(pid, notify)
    if (typeof id === 'number') this.ports.get(id)?.watchers.delete(target.id)
  }

  /**
   * Queue a message. Returns nothing when it was accepted at once; with `timeout` and a full queue it
   * returns a promise that settles when there is room (or `ETIMEDOUT`). Without `timeout` a full queue is `EAGAIN`.
   */
  send(pid: number, id: unknown, data: unknown, opts: SendOptions = {}): void | Promise<void> {
    const port = this.live(id)
    const mine = this.held(pid)
    if (!mine.has(port.id)) throw new SysError('EACCES', 'no send right for that port')

    const passing = [...(opts.rights ?? [])]
    if (opts.replyTo !== undefined) passing.push(opts.replyTo)
    for (const r of passing) {
      if (!mine.has(r)) throw new SysError('EACCES', `no send right for port ${r} to pass on`)
      this.live(r)
    }
    const transfer = checkTransfer(opts.transfer)
    if (opts.timeout !== undefined && (typeof opts.timeout !== 'number' || !(opts.timeout >= 0))) {
      throw new SysError('EINVAL', 'timeout must be a number of milliseconds')
    }

    const message: Message = { data, from: pid, rights: [...(opts.rights ?? [])], replyTo: opts.replyTo ?? null }
    if (transfer.length) transfers.set(message, transfer)

    if (port.receivers.length === 0 && port.queue.length >= QUEUE_LIMIT) {
      if (opts.timeout === undefined) {
        closeTransferred(message)
        throw new SysError('EAGAIN', 'port queue is full')
      }
      return new Promise<void>((resolve, reject) => {
        const sender: Sender = { pid, message, passing, resolve, reject }
        sender.timer = setTimeout(() => {
          const at = port.senders.indexOf(sender)
          if (at >= 0) port.senders.splice(at, 1)
          closeTransferred(message)
          reject(new SysError('ETIMEDOUT', 'the port stayed full'))
        }, opts.timeout)
        port.senders.push(sender)
      })
    }
    this.accept(port, message, passing)
  }

  /** Resolves with the next message. With `timeout` (ms), rejects with `ETIMEDOUT` instead of waiting forever. */
  receive(pid: number, id: unknown, timeout?: number): Promise<Message> {
    const port = this.owned(pid, id)
    const next = port.queue.shift()
    if (next) {
      this.admitSender(port)
      return Promise.resolve(next)
    }
    return new Promise<Message>((resolve, reject) => {
      const receiver: Receiver = { resolve, reject }
      if (timeout !== undefined) {
        receiver.timer = setTimeout(() => {
          const at = port.receivers.indexOf(receiver)
          if (at >= 0) port.receivers.splice(at, 1)
          reject(new SysError('ETIMEDOUT', 'no message arrived in time'))
        }, timeout)
      }
      port.receivers.push(receiver)
    })
  }

  register(pid: number, name: unknown, id: unknown): void {
    if (typeof name !== 'string' || !name || name.length > MAX_NAME) throw new SysError('EINVAL', 'bad service name')
    const port = this.owned(pid, id)
    if (this.names.has(name)) throw new SysError('EEXIST', `${name} is already registered`)
    if (port.name !== undefined) throw new SysError('EINVAL', 'port already has a name')
    port.name = name
    this.names.set(name, port.id)
  }

  /** Finds a service and grants the caller a send right to it. */
  lookup(pid: number, name: unknown): number {
    const id = typeof name === 'string' ? this.names.get(name) : undefined
    if (id === undefined) throw new SysError('ENOENT', `no service named ${String(name)}`)
    this.held(pid).add(id)
    return id
  }

  /** A process is gone: its ports die (waking anyone receiving on them) and its rights vanish. */
  dropProcess(pid: number): void {
    for (const port of [...this.ports.values()]) if (port.owner === pid) this.drop(port)
    this.rights.delete(pid)
    // Sends this process left blocked on other ports die with it.
    for (const port of this.ports.values()) {
      for (const sender of port.senders.filter((x) => x.pid === pid)) {
        port.senders.splice(port.senders.indexOf(sender), 1)
        abortSend(sender, 'sender exited')
      }
    }
  }

  get size(): number {
    return this.ports.size
  }
}

function abortSend(sender: Sender, reason: string): void {
  clearTimeout(sender.timer)
  closeTransferred(sender.message)
  sender.reject(new SysError('EPIPE', reason))
}

/** A message that will never be delivered: close the MessagePorts it carried so the other end sees it. */
function closeTransferred(m: Message): void {
  for (const t of transfers.get(m) ?? []) if (t instanceof MessagePort) t.close()
}

/** Send a message and wait for the answer: makes a throwaway reply port, sends, receives, cleans up. */
export async function request(
  api: {
    portCreate(): Promise<number>
    portDestroy(port: number): Promise<void>
    send(port: number, data: unknown, opts?: SendOptions): Promise<void>
    receive(port: number, opts?: { timeout?: number }): Promise<Message>
  },
  port: number,
  data: unknown,
  opts: { timeout?: number; rights?: number[]; transfer?: Transferable[] } = {},
): Promise<Message> {
  const reply = await api.portCreate()
  try {
    await api.send(port, data, { rights: opts.rights, replyTo: reply, transfer: opts.transfer })
    return await api.receive(reply, { timeout: opts.timeout })
  } finally {
    await api.portDestroy(reply).catch(() => {})
  }
}
