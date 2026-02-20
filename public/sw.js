// Minimal service worker for PWA installability
// No caching — all requests go to network (we want fresh content)
self.addEventListener("install", function (e) {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function (e) {
  e.respondWith(fetch(e.request));
});
