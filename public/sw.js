/**
 * Service worker: the only thing that can show an alert when the app is closed.
 *
 * Deliberately does nothing else. It does not cache pages and it does not
 * intercept requests — a stale cache here is a way to show somebody yesterday's
 * list of people to chase, which is worse than being offline.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'HIVE';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Some days need confirming.',
    // Same tag each morning, so a second alert replaces the first rather than
    // stacking underneath it.
    tag: data.day ? `att-${data.day}` : 'attendance',
    renotify: true,
    // No icon is named on purpose: the browser falls back to the site's own,
    // and pointing at a file that does not exist gets you a broken one.
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
