/// Runs inside the sandboxed iframe that hosts one process (inlined into host.html by build.mjs).
/// The frame has an opaque origin (no OPFS, IndexedDB, or storage) and a CSP with `connect-src 'none'`,
/// which the process Worker inherits. This script is the only trusted code in the frame: it starts
/// the runtime in a Worker and hands it the MessagePort, then stays out of the way.

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window.parent || ev.data?.type !== 'start') return
  const { runtime, init } = ev.data as { runtime: string; init: { port: MessagePort; source: Uint8Array } }
  const fail = (message: string) => window.parent.postMessage({ type: 'error', message }, '*')
  try {
    // The runtime is a blob, so the Worker inherits this document's CSP.
    const url = URL.createObjectURL(new Blob([runtime], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.onerror = (e) => {
      e.preventDefault()
      fail(e.message || 'worker error')
    }
    worker.postMessage(init, [init.port, init.source.buffer])
  } catch (e) {
    fail(`cannot start a worker: ${e}`)
  }
})

window.parent.postMessage({ type: 'ready' }, '*')
