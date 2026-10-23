/// The kernel Worker: owns the file system and processes, and serves RPC requests.
import { toWireError, type WireError } from './errors'
import { FS_METHODS } from './fs'
import { RemoteHost, type HostEvent, type HostRequest } from './hosting'
import { transfersOf } from './ipc'
import { Kernel, KERNEL_METHODS, type KernelBootOptions, type KernelMethod } from './kernel'
import type { KernelEvent } from './process'

export interface Request {
  id: number
  method: string
  args: unknown[]
}

export type Response =
  | { id: number; result: unknown }
  | { id: number; error: WireError }
  | { event: KernelEvent }
  | { hostRequest: HostRequest }
  /** The kernel's settings changed: the page stores them (the Worker has no LocalStorage). `value: null` removes the key. */
  | { storage: { key: string; value: string | null } }

const fsMethods = new Set<string>(FS_METHODS)
const kernelMethods = new Set<string>(KERNEL_METHODS)
const post = (msg: Response, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer)
let kernel: Kernel | null = null
const host = new RemoteHost((hostRequest, transfer) => post({ hostRequest }, transfer))

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  if (method === 'boot') {
    if (kernel) throw new Error('already booted')
    kernel = await Kernel.boot(args[0] as KernelBootOptions | undefined, (event) => post({ event }), host, {
      write: (key, value) => post({ storage: { key, value } }),
    })
    return null
  }
  if (method === 'shutdown') {
    await kernel?.shutdown(args[0] as { destroy?: boolean } | undefined)
    kernel = null
    return null
  }
  if (!kernel) throw new Error('kernel is not booted')
  if (kernelMethods.has(method)) {
    const fn = kernel[method as KernelMethod] as (...a: unknown[]) => Promise<unknown>
    return fn.apply(kernel, args)
  }
  if (fsMethods.has(method)) {
    const fn = (kernel.fs as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!
    return fn.apply(kernel.fs, args)
  }
  throw new Error(`unknown method ${method}`)
}

self.onmessage = async (ev: MessageEvent<Request | HostEvent>) => {
  if ('host' in ev.data) return host.handleEvent(ev.data)
  const { id, method, args } = ev.data
  try {
    const result = await dispatch(method, args)
    post({ id, result }, result instanceof Uint8Array ? [result.buffer as ArrayBuffer] : transfersOf(result))
  } catch (e) {
    post({ id, error: toWireError(e) })
  }
}
