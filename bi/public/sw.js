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
