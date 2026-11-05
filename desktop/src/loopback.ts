/// The page's half of the loopback bridge: registers `loopback-sw.js` and answers its
/// requests by asking the `tiny.loopback` service, so a program that serves HTTP is reachable at `/__loopback/<port>/`.
import type { Kernel } from '../../vanilla/kernel/src/client'

interface BridgeRequest {
  type: 'loopback-request'
  method: string
  path: string
  port: number
  headers: Array<[string, string]>
  body: ArrayBuffer | null
}

/** Start the bridge. Resolves once the worker is active; a browser without service workers just has no bridge. */
export async function startLoopback(kernel: Kernel): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const sw = navigator.serviceWorker
  const announce = () => sw.controller?.postMessage({ type: 'loopback-host' })

  const answer = async (m: BridgeRequest, reply: MessagePort): Promise<void> => {
    try {
      const service = await kernel.lookup('tiny.loopback')
      const res = (await kernel.request(
        service,
        { op: 'request', port: m.port, method: m.method, path: m.path, headers: m.headers, body: m.body ? new Uint8Array(m.body) : null, timeout: 30_000 },
        { timeout: 35_000 },
      )).data as { ok: true; result: { status: number; statusText: string; headers: Array<[string, string]>; body: Uint8Array } } | { ok: false; error: { code: string; message: string } }
      if (!res.ok) reply.postMessage({ ok: false, code: res.error.code, message: res.error.message })
      else {
        const { status, statusText, headers, body } = res.result
        const copy = body.slice().buffer
        reply.postMessage({ ok: true, status, statusText, headers, body: copy }, [copy])
      }
    } catch (e) {
      reply.postMessage({ ok: false, code: (e as { code?: string }).code ?? 'EIO', message: (e as Error).message })
    }
  }

  sw.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { type?: string } | null
    if (m?.type === 'loopback-announce') announce()
    else if (m?.type === 'loopback-request' && ev.ports[0]) void answer(ev.data as BridgeRequest, ev.ports[0])
  })
  sw.addEventListener('controllerchange', announce)
  await sw.register('/loopback-sw.js', { scope: '/' })
  await sw.ready
  announce()
}
