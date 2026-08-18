/**
 * Where this site lives, as an origin and nothing more.
 *
 * Every link the property sends out is built by sticking a path onto this:
 * `/i/<token>` for somebody's own details, `/s/<token>` for a letter waiting to
 * be signed, `/#/att-today` in a notification. All of them assume the left-hand
 * side ends where the host ends.
 *
 * The setting does not enforce that, and cannot: it is a text box somebody
 * types into once, and what gets typed into it is whatever was in the address
 * bar at the time — which may well carry a path. `https://staff.example.com/i`
 * looks harmless in the box and produces `/i/i/<token>`, a URL that serves the
 * page perfectly and then matches no API route, so the person is told their
 * link has expired when it is minutes old and the only real fault is one extra
 * word in a settings field nobody has looked at for a year.
 *
 * So this is the one place the question is answered, for all of them: parse it,
 * keep the origin, throw the rest away. A value with no scheme gets https —
 * somebody typing their own address rarely types the protocol, and every site
 * this could be is served over it. A value that cannot be parsed at all falls
 * back rather than failing, because a link built on the request's own origin is
 * right far more often than an error page is useful.
 */
export function originOf(value, fallback = '') {
  const clean = String(value ?? '').trim();
  if (clean) {
    // A scheme already there is taken at its word; one that is missing is
    // assumed to be https, because nobody types the protocol for their own
    // site. The distinction has to be made on the way in rather than by
    // trying both: `https://mailto:someone@example.com` parses perfectly
    // well, as a host of example.com with a username in front of it.
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(clean)
      ? clean
      : `https://${clean.replace(/^\/+/, '')}`;
    try {
      const { origin, protocol } = new URL(candidate);
      // `new URL('mailto:x')` parses happily and has an origin of "null".
      if (origin && origin !== 'null' && /^https?:$/.test(protocol)) return origin;
    } catch {
      // Not a URL at all. Fall back rather than fail.
    }
  }

  const spare = String(fallback ?? '').trim();
  if (!spare) return '';
  try {
    return new URL(spare).origin;
  } catch {
    return spare.replace(/\/+$/, '');
  }
}

/** The same question, asked of the database. */
export async function siteOrigin(db, fallback = '') {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'site_url'")
    .first().catch(() => null);
  return originOf(row?.value, fallback);
}
