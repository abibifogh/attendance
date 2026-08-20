/**
 * Service worker: alerts when the app is closed, and the shell when the signal
 * is not.
 *
 * ONE RULE ABOVE ALL: no answer from this app is ever served from a cache.
 * Every /api/ request goes to the network and fails if the network fails,
 * because a cached list of who to chase is yesterday's list, and somebody
 * acting on yesterday's list is worse off than somebody who knows they are
 * offline.
 *
 * What is cached is the shell — the page, the stylesheet, the scripts. Those
 * are the same for everybody and mean nothing on their own. Caching them is
 * what turns a bookmark into something that opens from the home screen like an
 * app instead of showing a dinosaur, and it is also what Chrome looks for
 * before it will offer to install anything: a service worker with a fetch
 * handler. Network first, always, so a deploy is picked up the moment there is
 * a signal to pick it up with; the cache is only ever the fallback.
 */

const SHELL = 'hive-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      // A shell that would not pre-cache is not a reason to refuse to install.
      // It fills itself as the app is used.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Anything left by an older version of this worker.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Somebody else's server, a POST, or anything the app asks of its own API:
  // straight to the network, cached never, and failing honestly when it fails.
  if (request.method !== 'GET'
      || url.origin !== self.location.origin
      || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      // Only keep what is worth keeping, and only when it actually arrived.
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(SHELL);
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(request);
      if (hit) return hit;
      // A page asked for with no signal and nothing kept: give the app itself,
      // which knows how to say "no connection to the server" in its own words.
      if (request.mode === 'navigate') {
        const shell = await caches.match('/index.html') || await caches.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

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
