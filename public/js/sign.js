/**
 * Somebody outside the property, opening a link to sign.
 *
 * A document prepared in three steps opens the new way: a code first, then
 * boxes to fill. Everything sent before that keeps opening the way it always
 * did, so no link already in somebody's inbox changes under them.
 */
const parts = location.pathname.split('/').filter(Boolean);
const at = parts.lastIndexOf('s');
let token = at === -1 ? '' : parts[at + 1] ?? '';
try { token = decodeURIComponent(token); } catch { /* a stray % stays as it is */ }

let head = null;
if (token) {
  head = await fetch(`/api/s/${encodeURIComponent(token)}`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

if (head?.flow === 'v2') {
  const { startV2 } = await import('./sign-v2.js');
  startV2(token, head);
} else {
  await import('./sign-classic.js');
}
