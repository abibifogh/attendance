/**
 * The service worker: what lets Insight and the Nice Place desk page be put
 * on a phone as an app.
 *
 * It keeps nothing. Everything still comes from the network, every time, so
 * a deploy is seen at once and nobody reads yesterday's numbers. When there
 * is no network at all, a page that was asked for says so in plain words
 * instead of the browser's own error.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>No connection</title><style>body{margin:0;font:20px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px;color:#14161a}
b{display:block;font-size:26px;margin-bottom:8px}button{font:inherit;font-weight:700;border:0;border-radius:16px;padding:16px 28px;background:#4f46e5;color:#fff;margin-top:18px}</style></head>
<body><div><b>No internet just now</b>Check the phone's data or Wi-Fi, then try again.<br><button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

/**
 * A notification from Insight, pushed to this phone or computer: shown, with
 * a buzz. One tag per thing, so a reminder about the same store request
 * replaces the last one rather than piling up; renotify, so it still buzzes.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Insight', {
    body: data.body || '',
    tag: data.tag || 'insight',
    renotify: true,
    requireInteraction: Boolean(data.urgent),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: data.urgent ? [200, 100, 200, 100, 200] : [200, 100, 200],
    data: { url: data.url || '/#/notifications', id: data.id || null },
  }));
});

/** Pressed: Insight, at the page it is about, in a window already open if there is one. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/#/notifications';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
