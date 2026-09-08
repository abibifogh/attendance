/**
 * Picking up a new version without anybody having to think of it.
 *
 * A browser tab takes a deploy the next time it is loaded. An app on a home
 * screen does not. Closing it and opening it again hands back the page that
 * was already there, so a phone can sit on a version from last week and the
 * only cure anybody found is pulling down to refresh, which is not something
 * a housekeeper is going to think of doing. What they say instead is that the
 * app looks wrong, and they are right.
 *
 * So the app asks the server which version it is answering with, and when the
 * answer stops matching the one the page loaded with, the page reloads.
 *
 * WHEN IT ASKS. When somebody comes back to the screen, and not more than once
 * every few minutes. Not on a timer of its own: a phone in a pocket asking
 * every minute all night is somebody's data.
 *
 * WHEN IT RELOADS. Only when the screen is free — nothing half typed, no
 * dialog open, nothing unsaved. It is the same rule the quiet data refresh
 * follows, and for the same reason: losing what somebody had half filled in
 * because a deploy happened is its own small disaster. Until the screen is
 * free it simply waits.
 */

const ASK_EVERY_MS = 180000;

let loaded = null;
let stale = false;
let askedAt = 0;

/** What the page is running, learned once and never changed after that. */
export function versionLoaded() { return loaded; }

/** Whether a newer one is out there and the page is only waiting for a gap. */
export function waitingToRefresh() { return stale; }

/**
 * Ask the server what it is serving.
 *
 * Anything that goes wrong is nothing: no signal, no session yet, an older
 * deploy with no version to give. The app carries on with the page it has,
 * which is what it did before any of this existed.
 */
export async function checkVersion(ask, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - askedAt < ASK_EVERY_MS) return stale;
  askedAt = now;

  let serving = null;
  try {
    serving = (await ask())?.version ?? null;
  } catch {
    return stale;
  }
  if (!serving) return stale;

  if (!loaded) {
    loaded = serving;
    return false;
  }
  if (serving !== loaded) stale = true;
  return stale;
}

/**
 * Take the new one.
 *
 * The shell cache goes first. It is filled a file at a time as the app is
 * used, so after a deploy it can hold a stylesheet from one version beside a
 * script from another, and a reload with a poor signal is exactly when the
 * mixture gets served. Emptying it means the reload either gets one whole
 * version off the network or fails honestly.
 */
export async function takeTheNewOne(reload = () => window.location.reload()) {
  try {
    const names = await caches?.keys?.();
    await Promise.all((names ?? []).map((n) => caches.delete(n)));
  } catch {
    // A browser that will not let us near its caches still reloads.
  }
  reload();
}
