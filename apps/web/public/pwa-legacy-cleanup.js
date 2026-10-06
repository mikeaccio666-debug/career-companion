// The new worker waits naturally for old controlled pages to close. Conservatively
// retain the legacy cache while any same-origin window remains, including an
// uncontrolled page. Deferred cleanup can happen at a later natural activation.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    if (clients.length) return;
    return caches.delete('openfield-shell-v1');
  }));
});
