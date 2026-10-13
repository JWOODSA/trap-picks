// Trap Picks service worker: shows push alerts and opens the app when one is tapped.
// It does not cache anything, so the app always shows the current lines and calls.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: 'Trap Picks', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Trap Picks', {
    body: m.body || '', tag: m.tag, renotify: !!m.tag, data: { url: m.url || '/app' },
    icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/app', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).pathname.startsWith('/app'));
    if (open) return open.focus().then((c) => c && c.navigate ? c.navigate(url) : null);
    return self.clients.openWindow(url);
  }));
});
