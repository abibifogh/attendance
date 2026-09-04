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

/**
 * The browser this is running in, as far as it will say.
 *
 * Not for deciding what the app does. It is for telling somebody where the
 * button is, and "it is in the ⋮ menu" is no help at all to a person holding
 * Samsung Internet, where it is in a menu with a different icon and a
 * different name.
 *
 * Order matters. Every browser on Android puts "Chrome" in its own user agent,
 * so Chrome is what is left after the others have been ruled out.
 */
export function browserName(ua = navigator.userAgent || '') {
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return 'facebook';
  if (/Instagram/.test(ua)) return 'instagram';
  if (/\bLine\//.test(ua)) return 'line';
  if (/TikTok|musical_ly|BytedanceWebview/.test(ua)) return 'tiktok';
  if (/\bwv\b/.test(ua) && /Version\/[\d.]+/.test(ua)) return 'webview';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/OPR\/|OPT\/|Opera Mini/.test(ua)) return 'opera';
  if (/EdgA?\//.test(ua)) return 'edge';
  if (/FxiOS|Firefox/.test(ua)) return 'firefox';
  if (/CriOS/.test(ua)) return 'chrome-ios';
  if (/Chrome|Chromium/.test(ua)) return 'chrome';
  if (/Safari/.test(ua)) return 'safari';
  return 'other';
}

/**
 * Opened inside another app rather than in a browser.
 *
 * The commonest reason a phone has no install option, and the one nobody
 * guesses: a link sent on WhatsApp opens in WhatsApp, a link on Facebook opens
 * in Facebook, and those windows have no menu to install anything from. The
 * page looks completely normal, which is exactly why somebody spends twenty
 * minutes hunting for a button that was never going to be there.
 */
export function inAnotherApp(ua = navigator.userAgent || '') {
  return ['facebook', 'instagram', 'line', 'tiktok', 'webview'].includes(browserName(ua));
}

/** Android, as far as anything here needs to know. */
export function isAndroid(ua = navigator.userAgent || '') {
  return /Android/.test(ua);
}

/**
 * A link that hands the page to Chrome, from wherever it is now.
 *
 * Android's own escape hatch: an intent URL naming Chrome, with the ordinary
 * address as the fallback for a phone that does not have it. Nothing like it
 * exists on iOS, where the answer is Safari and saying so.
 */
export function openInChromeUrl(href = window.location.href) {
  const at = new URL(href);
  // The page's own fragment is left off the intent and carried in the
  // fallback instead. An intent URL keeps its instructions in the fragment,
  // so a second # in front of them is not a longer address, it is a broken
  // one, and Android answers a broken one by doing nothing at all.
  const rest = `${at.host}${at.pathname}${at.search}`;
  return `intent://${rest}#Intent;scheme=${at.protocol.replace(':', '')};`
    + `package=com.android.chrome;`
    + `S.browser_fallback_url=${encodeURIComponent(href)};end`;
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
