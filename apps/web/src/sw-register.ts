/**
 * Registers the precache-only service worker in production HTTPS contexts only. Local dev and
 * plain HTTP (no secure context) skip registration — no SW to avoid stale-dev confusion, and
 * `crypto.subtle`-adjacent APIs already require HTTPS for the app to matter anyway.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  if (location.protocol !== 'https:') return
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW is a progressive enhancement; the app works without it */
    })
  })
}
