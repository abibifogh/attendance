/**
 * Finding a place on the map, without putting a billable key in a web page.
 *
 * TYPING AN ADDRESS IS THE PROBLEM THIS SOLVES, and only half of it. Somebody
 * publishing interview times types "the office" and knows exactly where that
 * is; the candidate reading it on a phone at the other end of Accra does not.
 * So the point of asking Google is not the autocomplete: it is that a place
 * picked off the map carries an address and a pair of coordinates, and those
 * turn into a directions link on the page of somebody who has never been here.
 *
 * THE KEY NEVER REACHES THE BROWSER. The ordinary way to do this is to load
 * Google's own script into the page with the key in the URL, restricted by
 * referrer. That works, and it means the key is in the source of every page
 * that has it, and referrer restrictions are a request rather than a wall. A
 * key on a billed account is money, so it stays on the server and the browser
 * asks this app instead. Two requests rather than one, and nothing to leak.
 *
 * IT IS OFF UNTIL SOMEBODY SETS A KEY, and off means the field is an ordinary
 * text box that does exactly what it did before. A half-working autocomplete
 * that silently returns nothing is worse than no autocomplete at all, so
 * everything here reports plainly whether it is switched on.
 *
 * WHAT IT COSTS. Google bills autocomplete by the session, not the keystroke,
 * when a session token is carried through from the first letter to the moment
 * somebody picks something. So a token is generated once per editing session
 * and passed on both calls. Without that, a nine-letter address is nine
 * billable requests instead of one.
 */

const AUTOCOMPLETE = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS = 'https://places.googleapis.com/v1/places';

/** Long enough to mean something. One letter is a request that costs money. */
export const MIN_QUERY = 3;

/**
 * The key, and where it came from.
 *
 * A Worker secret first, because that is the right place for anything billed,
 * and a setting second, because a property that wants to paste one in without
 * a deploy should be able to. Neither is ever sent to a browser.
 */
export async function mapsKey(env, db) {
  const fromEnv = String(env?.GOOGLE_MAPS_KEY ?? '').trim();
  if (fromEnv) return { key: fromEnv, from: 'secret' };

  const row = await db.prepare("SELECT value FROM settings WHERE key = 'maps_key'")
    .first().catch(() => null);
  const stored = String(row?.value ?? '').trim();
  return stored ? { key: stored, from: 'settings' } : { key: null, from: null };
}

/** Which country's places to offer first. A setting, because this is one app. */
export async function mapsRegion(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'maps_region'")
    .first().catch(() => null);
  const code = String(row?.value ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : null;
}

/**
 * What Google thinks somebody is typing.
 *
 * Returns a plain list of `{ id, name, address }`. The shape Google sends is
 * three levels deep and changes between API versions; flattening it here means
 * one file has to be edited when it does, rather than a screen.
 */
export async function suggestPlaces(key, input, { session = null, region = null } = {}) {
  const body = {
    input: String(input).slice(0, 200),
    ...(session ? { sessionToken: session } : {}),
    ...(region ? { includedRegionCodes: [region] } : {}),
  };

  const response = await fetch(AUTOCOMPLETE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await googleSaidNo(response);
  const data = await response.json().catch(() => ({}));

  return (data.suggestions ?? [])
    .map((row) => row.placePrediction)
    .filter(Boolean)
    .slice(0, 8)
    .map((place) => ({
      id: place.placeId,
      // The building, then where it is. Shown on two lines, because a single
      // line of "Somewhere Nice Hotel, 12 Boundary Road, East Legon, Accra"
      // is unreadable on a phone at a glance.
      name: place.structuredFormat?.mainText?.text ?? place.text?.text ?? '',
      address: place.structuredFormat?.secondaryText?.text ?? '',
    }))
    .filter((place) => place.name);
}

/**
 * One place, once somebody has picked it.
 *
 * The field mask is not a nicety: Places bills by what is asked for, and
 * asking for everything about a place in order to show a name and put a pin on
 * a map is the difference between the cheapest tier and the dearest.
 */
export async function placeDetails(key, placeId, { session = null } = {}) {
  const url = new URL(`${DETAILS}/${encodeURIComponent(placeId)}`);
  if (session) url.searchParams.set('sessionToken', session);

  const response = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,googleMapsUri',
    },
  });

  if (!response.ok) throw await googleSaidNo(response);
  const place = await response.json().catch(() => ({}));

  const name = place.displayName?.text ?? '';
  const address = place.formattedAddress ?? '';

  return {
    id: place.id ?? placeId,
    name,
    address,
    // What goes in the box and on the candidate's page. The name on its own is
    // "The Office", which is not somewhere anybody can find; the address on its
    // own loses which building it is.
    label: [name, address].filter(Boolean).join(', ').slice(0, 160),
    lat: numberOrNull(place.location?.latitude),
    lng: numberOrNull(place.location?.longitude),
  };
}

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A link anybody can open, whatever they have on their phone.
 *
 * Google's universal maps URL rather than a deep link into one app: it opens
 * the Maps app where there is one and the website where there is not, which is
 * the difference between a candidate finding the place and a candidate
 * pressing something that does nothing.
 */
export function mapLink({ placeId = null, lat = null, lng = null, label = '' } = {}) {
  const query = lat != null && lng != null ? `${lat},${lng}` : String(label ?? '').trim();
  if (!query) return null;

  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', query);
  // With the id as well, Maps opens the place itself rather than a pin at a
  // coordinate, so the name and the opening hours are there too.
  if (placeId) url.searchParams.set('query_place_id', placeId);
  return url.toString();
}

/**
 * What went wrong, in words somebody here can act on.
 *
 * Google's own message is written for whoever wrote the code, not for a
 * manager who has just pasted a key in and wants to know why nothing happens.
 * The three that actually occur get their own sentence.
 */
async function googleSaidNo(response) {
  const text = await response.text().catch(() => '');
  let said = '';
  try {
    said = JSON.parse(text)?.error?.message ?? '';
  } catch {
    said = text.slice(0, 200);
  }

  if (response.status === 403 || /API key not valid|not authorized|PERMISSION_DENIED/i.test(said)) {
    return new Error('Google refused the key. Check it is right, that the Places API (New) is '
      + 'turned on for that project, and that billing is enabled.');
  }
  if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(said)) {
    return new Error('Google is rate-limiting this key. Try again in a minute.');
  }
  return new Error(said
    ? `Google could not answer: ${said}`
    : 'Google could not answer that. Type the address in by hand.');
}
