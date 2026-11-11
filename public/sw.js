// Cadence service worker: shows push notifications (phone and desktop, even with the app closed), opens the
// task when one is tapped, and keeps the app's files so the installed app starts quickly.
const SHELL = 'cadence-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // Built files have hashed names, so a cached copy is always right. The page itself: network first.
  if (u.pathname.startsWith('/assets/')) {
    e.respondWith(caches.open(SHELL).then(async c => (await c.match(e.request)) ?? fetch(e.request).then(r => {
      if (r.ok) { c.put(e.request, r.clone()); c.keys().then(k => k.slice(0, -60).forEach(x => c.delete(x))); }
      return r;
    })));
  } else if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put('/', copy)); }
      return r;
    }).catch(async () => (await caches.match('/')) ?? Response.error()));
  }
});

self.addEventListener('push', e => {
  let n = {title: 'Cadence', body: 'You have a new notification', url: '/#/inbox'};
  try { if (e.data) n = e.data.json(); } catch { /* keep the generic one */ }
  e.waitUntil(Promise.all([
    self.registration.showNotification(n.title, {body: n.body, tag: n.tag, renotify: !!n.tag, icon: '/icon-192.png', data: {url: n.url}}),
    typeof n.unread === 'number' && self.navigator.setAppBadge ? self.navigator.setAppBadge(n.unread).catch(() => {}) : null,
  ]));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/#/inbox', location.origin).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const open = list.find(w => new URL(w.url).origin === location.origin);
    if (open) { open.postMessage({open: url}); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});

// The browser renewed the subscription: tell the server about the new one.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const sub = e.newSubscription ?? await self.registration.pushManager.subscribe(e.oldSubscription.options);
    await fetch('/api/push/subscribe', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({subscription: sub.toJSON(), replaces: e.oldSubscription?.endpoint})});
  })());
});
