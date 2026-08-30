import { badRequest, json, str } from '../lib/http.js';
import {
  MIN_QUERY, mapsKey, mapsRegion, placeDetails, suggestPlaces,
} from '../lib/places.js';

/**
 * Asking Google where somewhere is, on the browser's behalf.
 *
 * Two routes and nothing else. They exist so the key can stay on the server:
 * the ordinary way to do this puts a billable key in the source of every page
 * that has an address box, and referrer restrictions are a request rather than
 * a wall.
 *
 * Both are behind a permission for the same reason. Every call costs the
 * property money, so this is not something a signed-in browser gets for free
 * because it happens to be signed in.
 */

/** Whether the field should offer suggestions at all, without saying with what. */
export async function placesReady(ctx) {
  const { key, from } = await mapsKey(ctx.env, ctx.db);
  return json({
    ready: Boolean(key),
    // Which of the two places it came from, so somebody setting this up can
    // tell a secret that is working from a settings row that is being ignored.
    from,
    region: await mapsRegion(ctx.db),
    minimum: MIN_QUERY,
  });
}

export async function suggest(ctx) {
  const { key } = await mapsKey(ctx.env, ctx.db);
  // Not an error. The field falls back to being an ordinary text box, and an
  // empty list is exactly what that needs to hear.
  if (!key) return json({ ready: false, places: [] });

  const input = str(ctx.url.searchParams.get('q'), 'What to look for', { max: 200 }) ?? '';
  if (input.trim().length < MIN_QUERY) return json({ ready: true, places: [] });

  try {
    const places = await suggestPlaces(key, input.trim(), {
      session: sessionOf(ctx),
      region: await mapsRegion(ctx.db),
    });
    return json({ ready: true, places });
  } catch (err) {
    // Said plainly rather than thrown. A box that stops taking keystrokes
    // because a lookup failed is worse than one that quietly goes back to
    // being a text box.
    return json({ ready: true, places: [], problem: err.message });
  }
}

export async function details(ctx, id) {
  const { key } = await mapsKey(ctx.env, ctx.db);
  if (!key) throw badRequest('No maps key is set, so a place cannot be looked up.');

  const placeId = str(id, 'Place', { required: true, max: 300 });
  const place = await placeDetails(key, placeId, { session: sessionOf(ctx) });
  return json(place);
}

/**
 * The token that ties a session of typing to the one place picked at the end.
 *
 * Google bills autocomplete by the session when this is carried through, and
 * by the request when it is not, so a nine-letter address is one billable
 * lookup rather than seven. It comes from the browser because only the browser
 * knows when somebody has started typing a new address.
 */
const sessionOf = (ctx) => str(ctx.url.searchParams.get('session'), 'Session', { max: 60 }) || null;
