/// Service worker: caches the OS itself so it loads offline. A new build installs in the background and waits;
/// the session service tells Desktop ("Restart to update"), and Desktop asks for it to take over at the next boot.
declare const self: ServiceWorkerGlobalScope
declare const __TINY_BUILD_ID__: string

const CACHE = `tiny-os-${__TINY_BUILD_ID__}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const manifest = (await (await fetch('os-manifest.json', { cache: 'no-store' })).json()) as string[]
      await cache.addAll(manifest)
    })(),
  )
  // no skipWaiting here: the running OS keeps its own version until the user restarts
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('tiny-os-') && key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'skip-waiting') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== location.origin) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(event.request, { ignoreSearch: true })
      if (hit) return hit
      try {
        return await fetch(event.request)
      } catch {
        return (await cache.match('index.html')) ?? Response.error()
      }
    })(),
  )
})
