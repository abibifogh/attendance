import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { familyWrites, listShifts, saveCoverMap, updateShift } from '../src/routes/attendance-setup.js';
import { loadDataset } from '../src/lib/attendance.js';
import { coverOf, suggestRota } from '../src/lib/suggest.js';

/**
 * What has to be on the rota, what is wanted on it, and what is a bonus.
 *
 * The point of the three levels is the first one: a shift nobody can be
 * found for still reaches the grid, empty, so the hole is a cell somebody
 * answers rather than a line in a list nobody reads.
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
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_availability; DELETE FROM users; DELETE FROM audit_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes,
                             sort_order, needed)
     VALUES (1, 'Breakfast early', '06:00', '14:00', 0, 5, 1, 1),
            (2, 'Breakfast late',  '06:00', '15:00', 0, 5, 2, 1),
            (3, 'Craft',           '09:00', '17:00', 0, 5, 3, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on)
     VALUES (1, '1', 'Kofi', '2020-01-01'),
            (2, '2', 'Ama', '2020-01-01'),
            (3, '3', 'Yaw', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const ADMIN = {
  user: { id: 3, name: 'Kwame', role: 'admin' },
  permissions: ['att_setup', 'att_rota'],
};

const ctx = (db, { body = null, query = '', session = ADMIN } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

// 2026-06-01 is a Monday; 2026-06-07 is the Sunday.
const MONDAY = '2026-06-01';
const SUNDAY = '2026-06-07';

const draft = async (db, from = MONDAY, to = MONDAY) => {
  const ds = await loadDataset(db, { from, to: '2026-06-08' });
  return suggestRota({ ds, history: [], from, to });
};

// ---------------------------------------------------------------------------
// Which days it runs
// ---------------------------------------------------------------------------

const cover = (raw, id, level) => raw.prepare('UPDATE att_shifts SET cover = ? WHERE id = ?').run(level, id);

/**
 * One person and two shifts on the same day.
 *
 * Nobody may hold two shifts in a day, whatever the arithmetic says, so
 * whichever of the two is reached second has nobody left for it. That is the
 * real shape of "nobody can be found": people exist and none of them can
 * take it, rather than a property with an empty staff list.
 */
const onePersonTwoShifts = (raw) => raw.exec('DELETE FROM att_staff WHERE id > 1');

test('what a shift is worth, and what an old row reads as', () => {
  assert.equal(coverOf({ cover: 'must' }), 'must');
  assert.equal(coverOf({ cover: 'optional' }), 'optional');
  assert.equal(coverOf({ cover: 'wanted' }), 'wanted');
  // Anything a database written before the column reads as the middle one,
  // which is what every shift was.
  assert.equal(coverOf({}), 'wanted');
  assert.equal(coverOf({ cover: null }), 'wanted');
  assert.equal(coverOf({ cover: 'nonsense' }), 'wanted');
  assert.equal(coverOf(null), 'wanted');
});

test('a must nobody can be found for goes on the rota empty', async () => {
  const { raw, db } = setup();
  cover(raw, 1, 'must');
  cover(raw, 2, 'must');
  onePersonTwoShifts(raw);

  const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
  const plan = suggestRota({ ds, history: [], from: MONDAY, to: MONDAY });

  const today = plan.entries.filter((e) => e.day === MONDAY);
  assert.equal(today.length, 2, 'both shifts reach the grid');
  assert.equal(today.filter((e) => e.staffId).length, 1, 'the one person takes one of them');

  assert.equal(plan.empties.length, 1, 'and the other is on it, empty');
  const [hole] = plan.empties;
  assert.equal(hole.staffId, null);
  assert.equal(hole.day, MONDAY);
  assert.equal(hole.empty, true);
  assert.match(hole.why, /has to be on the rota/);

  // A hole is not a shift that was filled, and the button must not say it was.
  assert.equal(plan.filled, 1);
});

test('a wanted or optional shift nobody can be found for is still left off', async () => {
  for (const level of ['wanted', 'optional']) {
    const { raw, db } = setup();
    cover(raw, 1, 'must');
    cover(raw, 2, level);
    onePersonTwoShifts(raw);

    const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
    const plan = suggestRota({ ds, history: [], from: MONDAY, to: MONDAY });

    assert.equal(plan.empties.length, 0, `${level}: no hole is left for it`);
    const two = plan.entries.filter((e) => e.day === MONDAY && e.shiftId === 2);
    assert.equal(two.length, 0, `${level}: it simply does not reach the grid`);
  }
});

test('a must that somebody can be found for is filled, not left empty', async () => {
  const { raw, db } = setup();
  cover(raw, 1, 'must');
  const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
  const plan = suggestRota({ ds, history: [], from: MONDAY, to: MONDAY });

  const mine = plan.entries.filter((e) => e.shiftId === 1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].empty, undefined);
  assert.ok(mine[0].staffId, 'a person, not a hole');
  assert.equal(plan.empties.length, 0);
});

test('a must wanting two people and only one to be had is filled once and holed once', async () => {
  const { raw, db } = setup();
  cover(raw, 1, 'must');
  raw.prepare('UPDATE att_shifts SET needed = 2 WHERE id = 1').run();
  raw.exec("DELETE FROM att_staff WHERE id > 1");

  const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
  const plan = suggestRota({ ds, history: [], from: MONDAY, to: MONDAY });

  const mine = plan.entries.filter((e) => e.shiftId === 1 && e.day === MONDAY);
  assert.equal(mine.length, 2, 'both slots reach the grid');
  assert.equal(mine.filter((e) => e.staffId).length, 1);
  assert.equal(mine.filter((e) => e.empty).length, 1);
});

test('the gap list says which of them is already a cell waiting to be filled', async () => {
  const { raw, db } = setup();
  cover(raw, 1, 'must');
  cover(raw, 2, 'wanted');
  raw.prepare('UPDATE att_shifts SET needed = 2 WHERE id IN (1, 2)').run();
  onePersonTwoShifts(raw);

  const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
  const plan = suggestRota({ ds, history: [], from: MONDAY, to: MONDAY });

  const must = plan.gaps.find((g) => g.shiftId === 1);
  const wanted = plan.gaps.find((g) => g.shiftId === 2);
  assert.equal(must.must, true, 'already a cell on the grid');
  assert.equal(must.optional, false);
  assert.equal(wanted.must, false, 'still only a line on a list');
});

test('a property with nobody on the books gets an answer, not a crash', async () => {
  const { raw, db } = setup();
  cover(raw, 1, 'must');
  raw.exec('DELETE FROM att_staff');
  const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
  const plan = suggestRota({ ds, history: [], from: MONDAY, to: MONDAY });
  // The early exit used to hand back a different shape from the real one, so
  // a screen reading any of the newer fields fell over on it.
  assert.deepEqual(plan.entries, []);
  assert.deepEqual(plan.empties, []);
  assert.deepEqual(plan.stretched, []);
  assert.equal(plan.filled, 0);
});

test('a must whose alternate ran is satisfied, and no hole is left for it', async () => {
  const { raw, db } = setup();
  raw.prepare("UPDATE att_shifts SET alt_group = 'morning' WHERE id IN (1, 2)").run();
  cover(raw, 1, 'must');
  raw.exec('DELETE FROM att_staff WHERE id > 1');

  const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
  const plan = suggestRota({ ds, history: [], from: MONDAY, to: MONDAY });

  const morning = plan.entries.filter((e) => e.day === MONDAY && [1, 2].includes(e.shiftId));
  assert.equal(morning.length, 1, 'one of the two runs, not both');
  assert.equal(morning[0].empty, undefined, 'and it was filled, so nothing is left empty');
});

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

test('the map saves what changed and leaves the rest alone', async () => {
  const { raw, db } = setup();
  const before = raw.prepare('SELECT cover FROM att_shifts WHERE id = 3').get().cover;

  const out = await (await saveCoverMap(ctx(db, {
    body: {
      shifts: [
        { id: 1, cover: 'must', altWith: [2] },
        // Sent unchanged: it should not count, and should not be written.
        { id: 3, cover: before },
      ],
    },
  }))).json();

  // Two rows are written: the one that was edited and its new partner, which
  // is what makes the relation mutual rather than one row's opinion.
  assert.equal(out.changed, 2);
  const one = raw.prepare('SELECT cover, alt_group, pair_group FROM att_shifts WHERE id = 1').get();
  assert.equal(one.cover, 'must');
  assert.ok(one.alt_group, 'it is in a family');
  assert.equal(one.pair_group, null);

  const logged = raw.prepare("SELECT detail FROM audit_log WHERE action = 'attendance.cover_map'").get();
  assert.match(logged.detail, /"changed":2/);
  assert.match(logged.detail, /Breakfast early/);
});

test('the map refuses nonsense rather than writing it', async () => {
  const { db } = setup();
  await assert.rejects(() => saveCoverMap(ctx(db, { body: { shifts: [] } })), /Nothing to save/);
  await assert.rejects(
    () => saveCoverMap(ctx(db, { body: { shifts: [{ id: 9999, cover: 'must' }] } })),
    /no longer exists/,
  );
});

test('an unknown level is read as wanted rather than stored as itself', async () => {
  const { raw, db } = setup();
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'whatever' }] } }));
  assert.equal(raw.prepare('SELECT cover FROM att_shifts WHERE id = 1').get().cover, 'wanted');
});

test('the shift list carries the level, so the map can draw it', async () => {
  const { raw, db } = setup();
  cover(raw, 1, 'must');
  const { shifts } = await (await listShifts(ctx(db))).json();
  assert.equal(shifts.find((s) => s.id === 1).cover, 'must');
});

test('the seeded first pass is a starting point, not a guess about hotels', () => {
  // Every shift the property had already given a "how many people" count to
  // is a must, because setting that number was them saying it needs a
  // person. Nothing else was promoted except the overnight watch.
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  const musts = raw.prepare("SELECT name, needed FROM att_shifts WHERE cover = 'must'").all();
  for (const row of musts) {
    assert.ok(row.needed != null || row.name === 'Security', `${row.name} was promoted on what basis?`);
  }
  assert.ok(musts.some((r) => r.name === 'Night shift'));
  assert.ok(musts.some((r) => r.name === 'Security'));

  // And the alternates only group names that differ by a + or a finish time.
  const families = raw.prepare(
    "SELECT alt_group, COUNT(*) n FROM att_shifts WHERE alt_group IS NOT NULL GROUP BY alt_group",
  ).all();
  assert.ok(families.every((f) => f.n > 1), 'a family of one is not a family');
  const numbered = raw.prepare(
    "SELECT name FROM att_shifts WHERE alt_group IS NOT NULL AND name LIKE '%aintenance%'",
  ).all();
  assert.equal(numbered.length, 0, 'numbered shifts mean a second person, not a second version');
});

// ---------------------------------------------------------------------------
// Picking shifts rather than naming a group
// ---------------------------------------------------------------------------

const family = (raw, column) => {
  const rows = raw.prepare(`SELECT id, ${column} AS g FROM att_shifts ORDER BY id`).all();
  const out = new Map();
  for (const r of rows) {
    if (!r.g) continue;
    if (!out.has(r.g)) out.set(r.g, []);
    out.get(r.g).push(r.id);
  }
  return [...out.values()].map((ids) => ids.sort((a, b) => a - b));
};

test('picking shifts makes them a family, both ways round', async () => {
  const { raw, db } = setup();
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'must', altWith: [2] }] } }));

  assert.deepEqual(family(raw, 'alt_group'), [[1, 2]],
    'the pick is mutual: shift 2 now says it too');
  const both = raw.prepare('SELECT alt_group FROM att_shifts WHERE id IN (1,2)').all();
  assert.equal(both[0].alt_group, both[1].alt_group);
});

test('a third shift joins the family, and dropping one lets it go', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO att_shifts (id, name, starts_at, ends_at) VALUES (9, 'Third', '06:00', '14:00')").run();

  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'wanted', altWith: [2, 9] }] } }));
  assert.deepEqual(family(raw, 'alt_group'), [[1, 2, 9]]);

  // Editing the same shift redefines the whole family, because the relation
  // is mutual and two rows cannot disagree about it.
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'wanted', altWith: [2] }] } }));
  assert.deepEqual(family(raw, 'alt_group'), [[1, 2]], 'the third one is out');
  assert.equal(raw.prepare('SELECT alt_group FROM att_shifts WHERE id = 9').get().alt_group, null);
});

test('picking nobody dissolves the family rather than leaving one behind', async () => {
  const { raw, db } = setup();
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'wanted', altWith: [2] }] } }));
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'wanted', altWith: [] }] } }));

  assert.deepEqual(family(raw, 'alt_group'), [], 'nobody is left holding a group of one');
  for (const id of [1, 2]) {
    assert.equal(raw.prepare('SELECT alt_group FROM att_shifts WHERE id = ?').get(id).alt_group, null);
  }
});

test('the two relations are kept apart', async () => {
  const { raw, db } = setup();
  await saveCoverMap(ctx(db, {
    body: { shifts: [{ id: 1, cover: 'must', altWith: [2], pairWith: [] }] },
  }));
  assert.deepEqual(family(raw, 'alt_group'), [[1, 2]]);
  assert.deepEqual(family(raw, 'pair_group'), []);

  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'must', pairWith: [2] }] } }));
  assert.deepEqual(family(raw, 'alt_group'), [[1, 2]], 'standing in for it is untouched');
  assert.deepEqual(family(raw, 'pair_group'), [[1, 2]]);
});

test('a row that only changes its level leaves both families alone', async () => {
  const { raw, db } = setup();
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'wanted', altWith: [2] }] } }));
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'optional' }] } }));

  assert.deepEqual(family(raw, 'alt_group'), [[1, 2]]);
  assert.equal(raw.prepare('SELECT cover FROM att_shifts WHERE id = 1').get().cover, 'optional');
});

test('an existing family keeps its name rather than being renamed for nothing', async () => {
  const { raw, db } = setup();
  raw.prepare("UPDATE att_shifts SET alt_group = 'morning' WHERE id IN (1, 2)").run();
  raw.prepare("INSERT INTO att_shifts (id, name, starts_at, ends_at) VALUES (9, 'Third', '06:00', '14:00')").run();

  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'wanted', altWith: [2, 9] }] } }));
  assert.equal(raw.prepare('SELECT alt_group FROM att_shifts WHERE id = 9').get().alt_group, 'morning');
});

test('a shift picked by nobody it does not know about is not invented', async () => {
  const { db } = setup();
  await saveCoverMap(ctx(db, { body: { shifts: [{ id: 1, cover: 'must', altWith: [4242] }] } }));
  // A pick that does not exist is dropped rather than stored as a family of
  // one, which would look like a rule and do nothing.
  const { shifts } = await (await listShifts(ctx(db))).json();
  assert.equal(shifts.find((s) => s.id === 1).alt_group, null);
});
