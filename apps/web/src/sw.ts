/**
 * Service worker (spec T3): precache-only for the built bundle. The fetch handler:
 * - bypasses (network-only) every `*.ts.net` URL — host RPC traffic is NEVER cached;
 * - bypasses every non-GET request;
 * - bypasses every path outside the precache manifest (no runtime caching at all);
 * - answers precached GETs from cache, network fallback otherwise (never stores the response).
 */
/// <reference lib="webworker" />
declare const __PRECACHE__: string[]

const sw = self as unknown as ServiceWorkerGlobalScope
const PRECACHE = __PRECACHE__ as readonly string[]

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open('lix-web-precache')
      await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))))
      await sw.skipWaiting()
    })(),
  )
})

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim())
})

const isTailnet = (url: URL): boolean => url.hostname.endsWith('.ts.net') || url.hostname.endsWith('.ts.net.')

sw.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request
  const url = new URL(req.url)
  // Host data plane and API traffic: always network, never cache.
  if (req.method !== 'GET' || isTailnet(url) || url.origin !== self.location.origin) return
  if (!PRECACHE.includes(url.pathname)) return
  event.respondWith(
    (async () => {
      const cache = await caches.open('lix-web-precache')
      const cached = await cache.match(url.pathname)
      if (cached) return cached
      return fetch(req)
    })(),
  )
})
