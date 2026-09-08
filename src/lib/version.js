/**
 * Which deploy is running, so a phone can tell it has an old one.
 *
 * A browser tab picks up a new version the next time somebody loads the page.
 * An app on a home screen does not: iOS hands back the page that was already
 * open, and Android often does the same, so "close it and open it again" is
 * not a reload. The screen somebody is looking at can be days and several
 * deploys behind, and the only cure anybody found was pulling to refresh,
 * which is not a thing a housekeeper is going to think of.
 *
 * So the app asks the server which version it is talking to, remembers the
 * answer from the moment it loaded, and refreshes itself when it changes. This
 * is the answer. It comes from Cloudflare's own deploy id, which moves on
 * every deploy whether or not anybody remembered to bump a number.
 */

/**
 * The running version, or null where nothing can say.
 *
 * Null rather than a guess: a made-up stamp that changes on its own would have
 * the app reloading itself for no reason, which is worse than never picking a
 * deploy up until somebody reloads by hand. Local runs and any deploy made
 * before the binding was added both land here.
 */
export function versionOf(env) {
  const said = env?.CF_VERSION_METADATA;
  if (!said) return null;
  const id = said.id ?? said.tag ?? null;
  return id ? String(id) : null;
}

/**
 * Whether what the screen is running is behind what the server is serving.
 *
 * Both have to be known. A screen that never learned its own version, or a
 * server that cannot say what it is, is left alone.
 */
export function isBehind(loaded, serving) {
  if (!loaded || !serving) return false;
  return String(loaded) !== String(serving);
}
