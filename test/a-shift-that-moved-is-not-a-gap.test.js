import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster, rosterHistory, saveRoster } from '../src/routes/attendance.js';

/**
 * A shift handed to somebody else is not a shift nobody is doing.
 *
 * Setting a cell to Off leaves the shift standing on the day as an empty slot,
 * and that is right: the breakfast still has to be cooked, and what changed is
 * only who is cooking it. But a planner dragging Ama's breakfast onto Kofi was
 * getting the slot as well. The grid sends a move as two changes in one save —
 * Kofi is on it, Ama's cell is Off — and the second was being read on its own,
 * so the day came back reading "1 unfilled" about a shift that had just been
 * filled in front of them.
 *
 * The save now knows the difference: a shift somebody else in the same batch
 * is taking up was moved, and only what nobody picks up leaves a hole.
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
            DELETE FROM att_availability; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Breakfast', '06:00', '14:00', 0, 5),
            (2, 'Dinner', '14:00', '22:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01'),
            (2, '2', 'Ama', 'Kitchen', '2020-01-01'),
            (3, '3', 'Efua', 'Kitchen', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 9, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };

const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/roster${query}`),
  session: PLANNER,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const DAY = '2026-06-02';
const NEXT = '2026-06-03';

const save = (db, entries) => saveRoster(ctx(db, { body: { entries } }));
const look = async (db) => (await getRoster(ctx(db, { query: '?from=2026-06-01&to=2026-06-14' }))).json();
const cellOf = (data, staffId, day = DAY) => data.rows.find((r) => r.staff.id === staffId)
  .days.find((d) => d.day === day);
const unfilledOn = (data, day = DAY) => data.coverage.find((c) => c.day === day).unfilled;

/** What the grid sends when a shift is dragged from one row onto another. */
const dragged = (from, to, { day = DAY, onto = day, shiftId = 1 } = {}) => [
  { staffId: to, day: onto, shiftId, title: null },
  { staffId: from, day, shiftId: null, title: null },
];

// ---------------------------------------------------------------------------
// The move itself
// ---------------------------------------------------------------------------

test('a shift dragged onto somebody else leaves no hole behind it', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);

  await save(db, dragged(2, 1));

  const data = await look(db);
  assert.equal(cellOf(data, 1).shift_id, 1, 'Kofi has it');
  assert.equal(cellOf(data, 2).shift_id, null, 'and Ama does not');
  assert.deepEqual(data.slots, [], 'and nobody is short of a breakfast');
  assert.deepEqual(unfilledOn(data), {});
});

test('the day is still covered once, not covered once and wanting once', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);
  await save(db, dragged(2, 1));

  const cover = (await look(db)).coverage.find((c) => c.day === DAY);
  assert.equal(cover.counts[1], 1);
  assert.equal(cover.unfilled[1], undefined);
});

test('the person it came off reads Off, which is a decision somebody made', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);
  await save(db, dragged(2, 1));

  const cell = cellOf(await look(db), 2);
  assert.equal(cell.shift_id, null);
  assert.equal(cell.explicit, true, 'not handed back to the standing pattern');
});

test('the trail still says the shift changed hands', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);
  await save(db, dragged(2, 1));

  const out = await (await rosterHistory(ctx(db, {
    query: '?from=2026-06-01&to=2026-06-14',
  }))).json();
  const here = out.entries.filter((e) => e.day === DAY);
  assert.ok(here.some((e) => e.staff?.id === 1 && e.shift?.id === 1), 'Kofi got it');
  assert.ok(here.some((e) => e.wasStaff?.id === 2 && e.wasShift?.id === 1), 'Ama had it');
  // And nothing about a slot appearing, which is the row that used to turn up
  // out of nowhere with nobody having asked for it.
  assert.equal(here.some((e) => /left empty/i.test(e.detail ?? '')), false);
  assert.equal(here.some((e) => /empty .* card/i.test(e.said ?? '')), false);
});

// ---------------------------------------------------------------------------
// What a move is not
// ---------------------------------------------------------------------------

test('taking somebody off with nobody to take it on still leaves the shift standing', async () => {
  // The whole point of the slot, and it has to survive the fix.
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);

  await save(db, [{ staffId: 2, day: DAY, shiftId: null }]);

  const data = await look(db);
  assert.equal(data.slots.length, 1);
  assert.equal(data.slots[0].shift_id, 1);
  assert.equal(unfilledOn(data)[1], 1);
});

test('two off the same shift and one taking it up leaves one hole, not none and not two', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }, { staffId: 3, day: DAY, shiftId: 1 }]);

  await save(db, [
    { staffId: 1, day: DAY, shiftId: 1 },
    { staffId: 2, day: DAY, shiftId: null },
    { staffId: 3, day: DAY, shiftId: null },
  ]);

  const data = await look(db);
  assert.equal(cellOf(data, 1).shift_id, 1);
  assert.equal(data.slots.length, 1, 'one of the two was handed on, the other was let go');
  assert.equal(unfilledOn(data)[1], 1);
});

test('dragged onto another day, the day it left is short of it', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);

  await save(db, dragged(2, 1, { day: DAY, onto: NEXT }));

  const data = await look(db);
  assert.equal(cellOf(data, 1, NEXT).shift_id, 1, 'Tuesday has it');
  assert.equal(data.slots.length, 1, 'and Monday has lost it');
  assert.equal(data.slots[0].day, DAY);
});

test('dropped on somebody already down for it, the one let go is a real hole', async () => {
  // Nothing was taken up: Kofi was already on the breakfast. So Ama coming off
  // it is exactly the plain case, and the day is one breakfast short.
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }, { staffId: 2, day: DAY, shiftId: 1 }]);

  await save(db, dragged(2, 1));

  const data = await look(db);
  assert.equal(cellOf(data, 1).shift_id, 1);
  assert.equal(data.slots.length, 1);
  assert.equal(unfilledOn(data)[1], 1);
});

test('a copy leaves both of them on it and invents nothing', async () => {
  // Copy sends the landing alone: the shift is still on the person it came
  // from, so there was never anything to give up.
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);

  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);

  const data = await look(db);
  assert.equal(cellOf(data, 1).shift_id, 1);
  assert.equal(cellOf(data, 2).shift_id, 1);
  assert.deepEqual(data.slots, []);
  assert.equal(data.coverage.find((c) => c.day === DAY).counts[1], 2);
});

test('a different shift moving does not soak up the one being let go', async () => {
  // Ama gives up the breakfast; Kofi is put on the dinner. Two unrelated
  // changes in one save, and the breakfast is still nobody's.
  const { db } = setup();
  await save(db, [{ staffId: 2, day: DAY, shiftId: 1 }]);

  await save(db, [
    { staffId: 1, day: DAY, shiftId: 2 },
    { staffId: 2, day: DAY, shiftId: null },
  ]);

  const data = await look(db);
  assert.equal(data.slots.length, 1);
  assert.equal(data.slots[0].shift_id, 1, 'the breakfast, not the dinner');
});

test('filling the slot by hand is unaffected: a slot is still a slot', async () => {
  const { db } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 1 }]);
  const slot = (await look(db)).slots[0];

  await save(db, [{ id: slot.id, day: DAY, staffId: 2 }]);

  const data = await look(db);
  assert.deepEqual(data.slots, []);
  assert.equal(cellOf(data, 2).shift_id, 1);
});

// ---------------------------------------------------------------------------
// The grid's end of it
// ---------------------------------------------------------------------------

test('the grid sends a move as the landing and the clearing together', () => {
  // Both halves in one save is what lets the server tell a move from a
  // let-go. Split across two requests it could not, and would be right to
  // leave the slot.
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  assert.match(view, /if \(answer === 'move'\) putShift\(load\.staffId, load\.day, null, null\);/);
  assert.match(view, /refreshSaveBar\(\);\n\s*\/\/[\s\S]*?await saveNow\(\);/);
});
