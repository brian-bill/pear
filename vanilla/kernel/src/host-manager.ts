/// Page side of process hosting: one sandboxed iframe per process, created on request from the kernel Worker.
import type { HostEvent, HostRequest } from './hosting'

export interface HostManagerOptions {
  /** The page served as `host.html` (built by `build.mjs`). Defaults to `host.html` next to this script. */
  hostUrl?: string | URL
}

interface Frame {
  el: HTMLIFrameElement
  dead: boolean
  stop: () => void
}

/**
 * `sandbox="allow-scripts"` without `allow-same-origin` gives the frame an opaque origin: it cannot
 * touch this origin's OPFS, IndexedDB, or cookies, and cannot reach this page. host.html adds a CSP
 * so the frame cannot make network requests either.
 */
export function manageHosts(
  respond: (ev: HostEvent) => void,
  opts: HostManagerOptions = {},
): (req: HostRequest) => void {
  const hostUrl = String(opts.hostUrl ?? new URL('host.html', import.meta.url))
  const frames = new Map<number, Frame>()
  const runtimes = new Map<string, Promise<string>>()

  const runtime = (url: string) => {
    let text = runtimes.get(url)
    if (!text) {
      text = fetch(url).then((r) => {
        if (!r.ok) throw new Error(`cannot load process runtime: ${r.status}`)
        return r.text()
      })
      text.catch(() => runtimes.delete(url))
      runtimes.set(url, text)
    }
    return text
  }

  const remove = (id: number) => {
    const frame = frames.get(id)
    if (!frame) return
    frame.dead = true
    frame.stop()
    frame.el.remove() // tears down the frame's Worker too
    frames.delete(id)
  }

  const bySource = (source: MessageEventSource | null) => {
    for (const [id, f] of frames) if (f.el.contentWindow === source) return id
    return undefined
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    const id = bySource(ev.source)
    if (id === undefined) return
    if (ev.data?.type === 'error') respond({ host: 'error', id, message: String(ev.data.message) })
  })

  return (req) => {
    if (req.host === 'kill') return remove(req.id)

    const el = document.createElement('iframe')
    el.setAttribute('sandbox', 'allow-scripts')
    el.setAttribute('referrerpolicy', 'no-referrer')
    el.setAttribute('aria-hidden', 'true')
    el.tabIndex = -1
    el.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'
    const frame: Frame = { el, dead: false, stop: () => window.removeEventListener('message', onReady) }
    frames.set(req.id, frame)

    const fail = (message: string) => {
      if (!frame.dead) respond({ host: 'error', id: req.id, message })
    }
    const init = req.init as { port: MessagePort; source: Uint8Array }

    // Start once the frame says it is listening.
    const onReady = (ev: MessageEvent) => {
      if (ev.source !== el.contentWindow || ev.data?.type !== 'ready') return
      frame.stop()
      runtime(req.runtimeUrl).then(
        (text) => {
          if (frame.dead) return
          el.contentWindow?.postMessage({ type: 'start', runtime: text, init }, '*', [init.port, init.source.buffer as ArrayBuffer])
        },
        (e) => fail(String(e)),
      )
    }
    window.addEventListener('message', onReady)
    el.src = hostUrl
    document.body.append(el)
  }
}
