import type { FileSystem, FsMethod } from './fs'
import type { Kernel as KernelImpl, KernelBootOptions, KernelMethod } from './kernel'
import type { KernelEvent } from './process'
import { manageHosts, type HostManagerOptions } from './host-manager'
import type { Response, Request } from './worker'

export type Kernel = {
  boot(opts?: KernelBootOptions): Promise<void>
  shutdown(opts?: { destroy?: boolean }): Promise<void>
  onEvent(listener: (e: KernelEvent) => void): () => void
} & Pick<FileSystem, FsMethod> &
  Pick<KernelImpl, KernelMethod>

/** An error thrown by the kernel. `code` is an errno name such as `ENOENT`. */
export class KernelError extends Error {
  constructor(
    message: string,
    public code?: string,
    public path?: string,
  ) {
    super(message)
    this.name = 'KernelError'
  }
}

/** Talk to a kernel Worker as if its methods were local async functions. */
export function createKernel(worker: Worker, opts: HostManagerOptions = {}): Kernel {
  const startHost = manageHosts((ev) => worker.postMessage(ev), opts)
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const listeners = new Set<(e: KernelEvent) => void>()

  let prefix = ''
  worker.onmessage = (ev: MessageEvent<Response>) => {
    const msg = ev.data
    if ('hostRequest' in msg) return startHost(msg.hostRequest)
    if ('storage' in msg) {
      try {
        if (msg.storage.value === null) localStorage.removeItem(msg.storage.key)
        else localStorage.setItem(msg.storage.key, msg.storage.value)
      } catch (e) {
        // full, blocked, or a private window: settings keep working in memory
        for (const l of listeners) l({ type: 'config', event: 'warning', message: `settings cannot be saved: ${(e as Error).message}` })
      }
      return
    }
    if ('event' in msg) {
      for (const l of listeners) l(msg.event)
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if ('error' in msg) p.reject(new KernelError(msg.error.message, msg.error.code, msg.error.path))
    else p.resolve(msg.result)
  }

  /** Settings that LocalStorage holds for this namespace, handed to the kernel at boot so early code can read them without waiting. */
  const readSettings = (namespace: string) => {
    prefix = `tiny:${namespace}:cfg:`
    const snapshot: Record<string, string> = {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        const value = key?.startsWith(prefix) ? localStorage.getItem(key) : null
        if (key && value !== null) snapshot[key] = value
      }
    } catch {
      // storage unavailable: start with defaults
    }
    return { prefix, snapshot }
  }

  const call = (method: string, args: unknown[]) =>
    new Promise((resolve, reject) => {
      if (method === 'boot') {
        const boot = (args[0] ?? {}) as { namespace?: string }
        args = [{ ...boot, config: readSettings(boot.namespace ?? 'tiny') }]
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      // Buffers and ports named in `transfer` move instead of being copied.
      const opts = method === 'send' || method === 'request' ? (args[2] as { transfer?: Transferable[] } | undefined) : undefined
      worker.postMessage({ id, method, args } satisfies Request, opts?.transfer ?? [])
    })

  const onEvent = (listener: (e: KernelEvent) => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }

  if (typeof window !== 'undefined') {
    // Another tab changed a setting; and the page is going away, so write out what is pending.
    window.addEventListener('storage', (ev) => {
      if (prefix && ev.key?.startsWith(prefix) && ev.storageArea === localStorage) void call('configExternal', [ev.key, ev.newValue]).catch(() => {})
    })
    const flush = () => void call('configFlush', []).catch(() => {})
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())
  }

  return new Proxy({} as Kernel, {
    // `toJSON` is left out so JSON.stringify of a value holding the kernel (a test handle, a log) serializes it
    // as `{}` instead of turning the inspection into a kernel call
    get: (_, method: string) => (method === 'onEvent' ? onEvent : method === 'toJSON' ? undefined : (...args: unknown[]) => call(method, args)),
  })
}
