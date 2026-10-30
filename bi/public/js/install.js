/**
 * Putting Insight, or the Nice Place desk page, on a phone as an app.
 *
 * Android and computers: the browser offers to install once the page has a
 * manifest and a service worker; that offer is caught here and kept, so a
 * button of our own can make it when somebody presses it. An iPhone makes no
 * offer: there it is Share, then Add to Home Screen, and the button says so.
 */
let offer = null;
const waiting = new Set();

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  offer = event;
  for (const fn of waiting) fn();
});
window.addEventListener('appinstalled', () => { offer = null; for (const fn of waiting) fn(); });

/** Opened as an installed app already. */
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
/** Whether a button to install makes sense here. */
export const canInstall = () => !installed() && Boolean(offer || isIphone());

/** Ask to install: the browser's own question, or 'iphone' when it is Share › Add to Home Screen. */
export async function install() {
  if (!offer) return isIphone() ? 'iphone' : 'unavailable';
  offer.prompt();
  const { outcome } = await offer.userChoice;
  offer = null;
  return outcome;
}

/** Be told when installing becomes possible, or is done. */
export function onInstallChange(fn) { waiting.add(fn); return () => waiting.delete(fn); }

export const IPHONE_STEPS = 'On an iPhone: tap the Share button (the square with an arrow, at the bottom), then “Add to Home Screen”.';

/** The service worker that makes the page installable. It keeps nothing: see /sw.js. */
export function registerWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
