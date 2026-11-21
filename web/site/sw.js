/* StroyCo — service worker : affiche les notifications push, même onglet fermé. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'StroyCo', {
      body: d.body || '',
      icon: '/icon.png',
      badge: '/icon.png',
      tag: d.tag || 'stroyco',
      renotify: true,
      requireInteraction: !!d.sticky,
      data: { id: d.id || null },
      actions: [{ action: 'stop', title: 'Ne plus recevoir' }],
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  if (e.action === 'stop') {
    e.waitUntil(
      fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {})
    );
    return;
  }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
      for (const w of ws) if ('focus' in w) return w.focus();
      return self.clients.openWindow('/');
    })
  );
});
