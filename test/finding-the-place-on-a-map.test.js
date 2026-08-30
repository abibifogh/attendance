import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  mapLink, mapsKey, mapsRegion, placeDetails, suggestPlaces,
} from '../src/lib/places.js';
import { details, placesReady, suggest } from '../src/routes/places.js';
import {
  addCandidate, addSlots, board, createRole, inviteCandidate,
} from '../src/routes/recruitment.js';
import { choose, open } from '../src/routes/hiring.js';
import { updateSettings } from '../src/routes/attendance-setup.js';
import { bootstrap } from '../src/routes/attendance.js';

/**
 * Finding a place on the map.
 *
 * Three things matter here and only one of them is about Google.
 *
 * THE KEY NEVER REACHES A BROWSER. It is billed, and the ordinary way of doing
 * this puts it in the source of every page with an address box. Every answer
 * the browser can get is checked here for it.
 *
 * IT IS OFF UNTIL A KEY IS SET, and off means an ordinary text box rather than
 * an error. A property that never sets one should not be able to tell this was
 * built.
 *
 * AND WHAT IS PICKED TURNS INTO DIRECTIONS. That is the point of asking Google
 * rather than autocompleting for its own sake: "the office, main building" is
 * not somewhere a candidate can navigate to.
 */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => st(sql),
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_staff; DELETE FROM rec_role; DELETE FROM rec_candidate;
            DELETE FROM rec_slot; DELETE FROM audit_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  const set = (key, value) => raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
  ).run(key, value, value);
  return { raw, db: d1(raw), set };
}

const HELD = ['rec_view', 'rec_manage', 'att_setup', 'att_view'];

const ctx = (db, { body = null, query = '', env = {} } = {}) => ({
  db,
  env,
  url: new URL(`https://x/api/places${query}`),
  session: { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: HELD },
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const body = async (res) => JSON.parse(await res.text());

/** The candidate's side: a link and no login. */
const publicCtx = (db, payload = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/c/x'),
  session: null,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }),
});
const soon = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

/** Google, stood in for. Every test that talks to it says what it answered. */
function pretendGoogle(answers) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init, key: init?.headers?.['X-Goog-Api-Key'] });
    const answer = answers.shift();
    if (!answer) throw new Error(`Google was asked something unexpected: ${url}`);
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const A_SUGGESTION = {
  suggestions: [
    {
      placePrediction: {
        placeId: 'ChIJ_somewhere_nice',
        text: { text: 'Somewhere Nice Hotel, Kokomlemle, Accra' },
        structuredFormat: {
          mainText: { text: 'Somewhere Nice Hotel' },
          secondaryText: { text: 'Kokomlemle, Accra' },
        },
      },
    },
  ],
};

const A_PLACE = {
  id: 'ChIJ_somewhere_nice',
  displayName: { text: 'Somewhere Nice Hotel' },
  formattedAddress: '7 Nortei Ababio Loop, Accra',
  location: { latitude: 5.5719, longitude: -0.2012 },
};

// ------------------------------------------------------------------ pure --

test('a link opens the place itself where there is one, and a pin where there is not', () => {
  assert.equal(
    mapLink({ placeId: 'abc', lat: 5.57, lng: -0.2 }),
    'https://www.google.com/maps/search/?api=1&query=5.57%2C-0.2&query_place_id=abc',
  );
  // No coordinates, but a name is still something Maps can search for.
  assert.match(mapLink({ label: 'Somewhere Nice, Accra' }), /query=Somewhere\+Nice/);
  // And nothing at all is not a link. A button that goes nowhere is worse than
  // no button.
  assert.equal(mapLink({}), null);
  assert.equal(mapLink({ label: '   ' }), null);
});

test('a Worker secret beats a pasted key, and neither is invented', async () => {
  const { db, set } = setup();
  assert.deepEqual(await mapsKey({}, db), { key: null, from: null });

  set('maps_key', 'from-settings');
  assert.deepEqual(await mapsKey({}, db), { key: 'from-settings', from: 'settings' });

  assert.deepEqual(
    await mapsKey({ GOOGLE_MAPS_KEY: 'from-secret' }, db),
    { key: 'from-secret', from: 'secret' },
  );
  // Whitespace is not a key.
  assert.deepEqual(await mapsKey({ GOOGLE_MAPS_KEY: '   ' }, db),
    { key: 'from-settings', from: 'settings' });
});

test('a country is two letters or nothing', async () => {
  const { db, set } = setup();
  assert.equal(await mapsRegion(db), 'gh');
  set('maps_region', 'GH');
  assert.equal(await mapsRegion(db), 'gh');
  set('maps_region', 'ghana');
  assert.equal(await mapsRegion(db), null);
});

// --------------------------------------------------------------- talking --

test('what Google sends is flattened to a name and where it is', async () => {
  const google = pretendGoogle([{ body: A_SUGGESTION }]);
  try {
    const places = await suggestPlaces('a-key', 'somewhere ni', { session: 's1', region: 'gh' });
    assert.deepEqual(places, [{
      id: 'ChIJ_somewhere_nice',
      name: 'Somewhere Nice Hotel',
      address: 'Kokomlemle, Accra',
    }]);

    const sent = JSON.parse(google.calls[0].init.body);
    assert.equal(sent.input, 'somewhere ni');
    assert.deepEqual(sent.includedRegionCodes, ['gh']);
    // The token is what makes a whole address one billable session rather than
    // one per keystroke.
    assert.equal(sent.sessionToken, 's1');
    assert.equal(google.calls[0].key, 'a-key');
  } finally {
    google.restore();
  }
});

test('a place comes back with the words and the pin', async () => {
  const google = pretendGoogle([{ body: A_PLACE }]);
  try {
    const place = await placeDetails('a-key', 'ChIJ_somewhere_nice', { session: 's1' });
    assert.equal(place.label, 'Somewhere Nice Hotel, 7 Nortei Ababio Loop, Accra');
    assert.equal(place.lat, 5.5719);
    assert.equal(place.lng, -0.2012);
    // Billed by what is asked for, so only what is shown is asked for.
    assert.match(google.calls[0].init.headers['X-Goog-FieldMask'], /^id,displayName/);
    assert.match(google.calls[0].url, /sessionToken=s1/);
  } finally {
    google.restore();
  }
});

test('a refusal from Google is said in words somebody here can act on', async () => {
  const google = pretendGoogle([
    { status: 403, body: { error: { message: 'API key not valid' } } },
    { status: 429, body: { error: { message: 'RESOURCE_EXHAUSTED' } } },
  ]);
  try {
    await assert.rejects(() => suggestPlaces('bad', 'somewhere'),
      /Places API \(New\) is turned on.*billing is enabled/s);
    await assert.rejects(() => suggestPlaces('bad', 'somewhere'), /rate-limiting/);
  } finally {
    google.restore();
  }
});

// --------------------------------------------------------------- the API --

test('with no key the box is told so, and given an empty list rather than an error', async () => {
  const { db } = setup();
  const ready = await body(await placesReady(ctx(db)));
  assert.equal(ready.ready, false);
  assert.equal(ready.from, null);

  const asked = await body(await suggest(ctx(db, { query: '?q=somewhere' })));
  assert.equal(asked.ready, false);
  assert.deepEqual(asked.places, []);
});

test('a query too short to mean anything is never sent to Google', async () => {
  const { db, set } = setup();
  set('maps_key', 'a-key');
  // No stand-in installed, so any call at all would throw.
  const asked = await body(await suggest(ctx(db, { query: '?q=so' })));
  assert.deepEqual(asked.places, []);
  assert.equal(asked.ready, true);
});

test('a lookup that fails leaves the box working and says why', async () => {
  const { db, set } = setup();
  set('maps_key', 'a-key');
  const google = pretendGoogle([{ status: 403, body: { error: { message: 'API key not valid' } } }]);
  try {
    const asked = await body(await suggest(ctx(db, { query: '?q=somewhere' })));
    // Not a 500. A box that stops taking keystrokes because a lookup failed is
    // worse than one that is simply not helping.
    assert.equal(asked.ready, true);
    assert.deepEqual(asked.places, []);
    assert.match(asked.problem, /Google refused the key/);
  } finally {
    google.restore();
  }
});

test('the key is in nothing a browser can fetch', async () => {
  const { db, set } = setup();
  set('maps_key', 'sk-the-secret-key');
  await createRole(ctx(db, { body: { title: 'Room attendant' } }));

  const answers = [
    await body(await placesReady(ctx(db))),
    await body(await board(ctx(db))),
    await body(await bootstrap(ctx(db))),
  ];
  for (const answer of answers) {
    assert.ok(!JSON.stringify(answer).includes('sk-the-secret-key'),
      'a billable key must never travel to a page');
  }
  // What the screens are told instead: whether one is set.
  assert.equal(answers[0].ready, true);
  assert.equal(answers[1].canFindPlaces, true);
});

// ------------------------------------------------------- through the app --

test('a place picked off the map is kept, and becomes directions', async () => {
  const { db } = setup();
  const role = await body(await createRole(ctx(db, { body: { title: 'Room attendant' } })));

  await addSlots(ctx(db, {
    body: {
      roleId: role.id, day: soon(), from: '10:00', to: '10:30', minutes: 30,
      place: 'Somewhere Nice Hotel, 7 Nortei Ababio Loop, Accra',
      placeId: 'ChIJ_somewhere_nice', lat: 5.5719, lng: -0.2012,
    },
  }));

  const slot = (await body(await board(ctx(db)))).diary[0];
  assert.equal(slot.placeId, 'ChIJ_somewhere_nice');
  assert.equal(slot.lat, 5.5719);
  assert.match(slot.directions, /query=5\.5719%2C-0\.2012/);
  assert.match(slot.directions, /query_place_id=ChIJ_somewhere_nice/);
});

test('a place typed by hand still works, and still gets a searchable link', async () => {
  const { db } = setup();
  await addSlots(ctx(db, {
    body: { day: soon(), from: '10:00', to: '10:30', place: 'The office, main building' },
  }));

  const slot = (await body(await board(ctx(db)))).diary[0];
  assert.equal(slot.placeId, null);
  assert.equal(slot.lat, null);
  // No pin, but Maps can still search for the words.
  assert.match(slot.directions, /query=The\+office/);
});

test('the property remembers the place it picked, and can be told not to', async () => {
  const { db, raw } = setup();
  await addSlots(ctx(db, {
    body: {
      day: soon(), from: '10:00', to: '10:30', place: 'Somewhere Nice Hotel, Accra',
      placeId: 'ChIJ_somewhere_nice', lat: 5.5719, lng: -0.2012,
    },
  }));

  const data = await body(await board(ctx(db)));
  assert.equal(data.place, 'Somewhere Nice Hotel, Accra');
  assert.equal(data.placeAt.id, 'ChIJ_somewhere_nice');
  assert.equal(data.placeAt.lat, 5.5719);

  await addSlots(ctx(db, {
    body: {
      day: soon(), from: '14:00', to: '14:30', place: 'A different room', remember: false,
    },
  }));
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'rec_place'").get().value,
    'Somewhere Nice Hotel, Accra');
});

test('a candidate is given a way of getting there', async () => {
  const { db, raw } = setup();
  const role = await body(await createRole(ctx(db, { body: { title: 'Room attendant' } })));
  await addSlots(ctx(db, {
    body: {
      roleId: role.id, day: soon(), from: '10:00', to: '10:30',
      place: 'Somewhere Nice Hotel, Accra',
      placeId: 'ChIJ_somewhere_nice', lat: 5.5719, lng: -0.2012,
    },
  }));

  const person = await body(await addCandidate(ctx(db, {
    body: { name: 'Ama Mensah', roleId: role.id },
  })));
  const made = await body(await inviteCandidate(
    ctx(db, { body: { wantsSlot: true } }), person.id,
  ));
  const token = made.url.split('/c/')[1];

  // What the candidate is offered, before they have picked anything.
  const offered = await body(await open(publicCtx(db), token));
  assert.equal(offered.slots.length, 1);
  assert.match(offered.slots[0].directions, /query_place_id=ChIJ_somewhere_nice/);
  // And nothing about who is on the panel, map or no map.
  assert.equal(offered.slots[0].interviewer, undefined);

  await choose(publicCtx(db, { slotId: offered.slots[0].id }), token);

  // And what they are given once they have.
  const booked = await body(await open(publicCtx(db), token));
  assert.equal(booked.chosen.place, 'Somewhere Nice Hotel, Accra');
  assert.match(booked.chosen.directions, /query=5\.5719%2C-0\.2012/);
  assert.equal(raw.prepare('SELECT place_id FROM rec_slot LIMIT 1').get().place_id,
    'ChIJ_somewhere_nice');
});

test('a place typed by hand still gets the candidate a searchable link', async () => {
  const { db } = setup();
  const role = await body(await createRole(ctx(db, { body: { title: 'Room attendant' } })));
  await addSlots(ctx(db, {
    body: { roleId: role.id, day: soon(), from: '10:00', to: '10:30', place: 'The office' },
  }));
  const person = await body(await addCandidate(ctx(db, {
    body: { name: 'Kofi Boateng', roleId: role.id },
  })));
  const made = await body(await inviteCandidate(
    ctx(db, { body: { wantsSlot: true } }), person.id,
  ));

  const offered = await body(await open(publicCtx(db), made.url.split('/c/')[1]));
  assert.match(offered.slots[0].directions, /query=The\+office/);
});

// --------------------------------------------------------------- setting --

test('the key is set and taken off from the setup screen', async () => {
  const { db, raw } = setup();
  await updateSettings(ctx(db, { body: { maps_key: 'sk-pasted', maps_region: 'GH' } }));

  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'maps_key'").get().value,
    'sk-pasted');
  assert.equal((await mapsKey({}, db)).key, 'sk-pasted');
  assert.equal(await mapsRegion(db), 'gh');

  await updateSettings(ctx(db, { body: { maps_key: '' } }));
  assert.equal((await mapsKey({}, db)).key, null);
});

test('a country that is not two letters is refused rather than stored', async () => {
  const { db } = setup();
  await assert.rejects(
    () => updateSettings(ctx(db, { body: { maps_region: 'ghana' } })),
    /two letters/,
  );
});
