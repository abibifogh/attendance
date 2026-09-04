/**
 * Putting the app on a phone's home screen.
 *
 * Two entirely different mechanisms wearing one word.
 *
 * On Android and on desktop Chrome the browser decides the app is installable
 * and fires `beforeinstallprompt`. Left alone, that shows a bar the reader
 * dismisses without reading. Caught and held, it becomes a button somewhere
 * the reader went looking for it.
 *
 * On an iPhone there is no event and no prompt at all: it is Share → Add to
 * Home Screen, by hand, and the only thing the app can do is say so. Saying so
 * matters more than the button does, because that is the half nobody guesses.
 */

let deferred = null;
const listeners = new Set();

const announce = () => { for (const fn of listeners) fn(); };

/** Already opened from the home screen rather than in a browser. */
export function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

export function isApple() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; the touch points give it away.
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

/** Whether a one-press install is available right now. */
export function canPrompt() {
  return Boolean(deferred);
}

/** Tell me when that changes, so a screen already drawn can redraw itself. */
export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Ask. Resolves to what the reader chose, or null where there is nothing to
 * ask with — an iPhone, or a browser that has already been answered.
 */
export async function promptInstall() {
  if (!deferred) return null;
  const event = deferred;
  // A held prompt can only be used once. Dropped before showing it, so a
  // second press cannot throw rather than doing nothing.
  deferred = null;
  announce();
  event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}

export function watchForInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Held rather than allowed to show itself, so the offer appears where the
    // reader is looking for it instead of over whatever they were doing.
    event.preventDefault();
    deferred = event;
    announce();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    announce();
  });
}

/**
 * The worker.
 *
 * Registered on every load, not only when somebody turns alerts on. It is what
 * lets the app open from a home screen without a signal, and Chrome will not
 * offer to install anything without one.
 */
export function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  // After load: a worker registering during boot competes with the app's own
  // first requests for the connection, on exactly the phones that can least
  // afford it.
  window.addEventListener('load', () => {
    // `updateViaCache: 'none'` so the browser fetches sw.js itself from the
    // network rather than from its own HTTP cache. Without it a phone can go
    // on running last week's worker for up to a day after a deploy, which is
    // how a fix to what a notification looks like reaches nobody.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // No worker is a missing convenience, not a broken app.
    });
  });
}
