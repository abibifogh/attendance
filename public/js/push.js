import { api } from './api.js';

/**
 * Turning on alerts for this browser.
 *
 * Notification permission is granted by a browser to a site on one device. It
 * cannot be carried to another, so this is a per-device switch rather than a
 * per-person setting, and the wording in the app says so.
 */

export function pushSupported() {
  return 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/**
 * iOS only allows notifications once a site has been added to the Home Screen.
 * Worth saying out loud, because the alternative is a permission prompt that
 * never appears and no explanation of why.
 */
export function needsHomeScreen() {
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  return iOS && !standalone;
}

/**
 * An Apple device too old to show an alert at all.
 *
 * Apple only added notifications for a web app on the Home Screen in iOS 16.4,
 * in March 2023. Every iPhone before the XS — a 7, a 7 Plus, an 8 — stops at
 * iOS 15 and can never have them, and that is a good few of the phones in
 * pockets here. Telling somebody on one of those to add HIVE to the Home
 * Screen sends them to do a thing that cannot work, twice, before they give up
 * and assume the app is broken.
 *
 * The version comes out of the user agent, which is where the only honest
 * answer lives: there is nothing to feature-detect, because the thing to
 * detect is missing.
 */
export function tooOldForAlerts() {
  const ua = navigator.userAgent || '';
  const apple = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  if (!apple) return false;

  // Two places the version hides, and which one is there depends on how the
  // app was opened. A tab carries "OS 15_8"; the same phone with HIVE on the
  // Home Screen drops that and carries Safari's own "Version/15.6", which on
  // iOS tracks the system anyway. An iPad claims to be a Macintosh and gives
  // the Mac's version in the first, so the second is the one worth reading
  // there.
  const found = /OS (\d+)[._](\d+) like Mac OS X/.exec(ua)
    || /Version\/(\d+)\.(\d+)/.exec(ua);
  // No version to read is no claim either way: the general message is the
  // safer one.
  if (!found) return false;

  const major = Number(found[1]);
  const minor = Number(found[2]);
  return major < 16 || (major === 16 && minor < 4);
}

let registration = null;
async function ready() {
  if (!registration) registration = await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready.then(() => registration);
}

/** The subscription this browser already holds, if any. */
export async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await ready();
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function urlBase64ToBytes(value) {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function keysOf(subscription) {
  const raw = subscription.toJSON().keys ?? {};
  return { p256dh: raw.p256dh, auth: raw.auth };
}

/** A name for this device, so a list of them is readable later. */
function describeDevice() {
  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android phone'
        : /Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows PC'
            : 'This device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
          : 'browser';
  return `${platform} · ${browser}`;
}

/** Turn a browser's developer-facing failure into something actionable. */
function hintFor(err) {
  const text = String(err?.message || err);
  if (/incognito|private/i.test(text)) {
    return 'Private browsing windows cannot receive alerts — open the site in a normal window.';
  }
  if (/permission/i.test(text)) {
    return 'This can happen in a private window, or where notifications are switched off for the '
      + 'whole browser. Check your browser’s notification settings and try again.';
  }
  if (/push service|network|failed to fetch/i.test(text)) {
    return 'The browser could not reach its notification service. Check the connection and try again.';
  }
  return 'Try again, or use a different browser on this device.';
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser cannot show alerts.');

  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    throw new Error('This browser is blocking alerts for the site. Allow notifications for it in '
      + 'your browser settings, then try again.');
  }
  if (permission !== 'granted') throw new Error('Alerts were not allowed.');

  const reg = await ready();
  const { key } = await api.pushKey();

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(key),
      });
    } catch (err) {
      // The browser's own wording here is for developers — "Registration failed
      // - permission denied" means almost nothing to somebody trying to get
      // alerts on their phone.
      throw new Error(`This browser would not register for alerts. ${hintFor(err)}`);
    }
  }

  await api.pushSubscribe({
    endpoint: subscription.endpoint,
    ...keysOf(subscription),
    label: describeDevice(),
  });

  return subscription;
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api.pushUnsubscribe({ endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

export async function testPush() {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error('Turn alerts on for this device first.');
  await api.pushTest({ endpoint: subscription.endpoint });
}
