/**
 * What this app calls itself.
 *
 * A constant rather than a hostname check: unlike the operation's other sites,
 * this one is served by a single Worker on a single address, so there is
 * nothing to decide at runtime. It stays in its own module because
 * `index.html` settles the same three values inline — before any module
 * loads — and the two have to agree.
 *
 * It began as an attendance app and is not one any more: it runs the rota,
 * leave, the sign-off, the personnel records, contracts and the letter
 * register. `app` is left as `attendance` on purpose — it is the Worker's own
 * name and the repository's, and renaming those buys nothing a person can see
 * while costing a re-attached custom domain and a broken deploy.
 */
export const BRAND = {
  app: 'attendance',
  name: 'HIVE',
  full: 'Human Information & Verification Engine',
};

/**
 * The mark: the same hexagon as the icon on the home screen and in the tab.
 *
 * It used to be a bee emoji, which meant the app on somebody's phone and the
 * app on their screen were two different things. An emoji is also drawn by
 * whichever device is looking at it, so it was a different bee on every phone.
 * This is the icon's own outline, from the coordinates `index.html` repeats
 * for the favicon.
 */
const HEXAGON = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
  + '<polygon points="50,7 87,28.5 87,71.5 50,93 13,71.5 13,28.5" fill="none" '
  + 'stroke="currentColor" stroke-width="11" stroke-linejoin="round" /></svg>';

/**
 * One mark, at whatever size the place it is going asks for.
 *
 * A fresh element each time rather than a shared one, because the same node
 * cannot sit in the topbar and on a printed page at once.
 */
export function brandMark(size = null) {
  const el = document.createElement('span');
  el.className = 'brand-hex';
  el.setAttribute('aria-hidden', 'true');
  if (size) el.style.setProperty('--mark-size', size);
  el.innerHTML = HEXAGON;
  return el;
}
