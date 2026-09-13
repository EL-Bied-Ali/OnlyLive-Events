/* OnlyLive scanner service worker: intentionally network-only.
 * Ticket validity is never cached or decided offline. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
