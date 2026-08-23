import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { copyRoster, getRoster, publishRoster, saveRoster } from '../src/routes/attendance.js';
import { deleteShift } from '../src/routes/attendance-setup.js';

/**
 * Two shifts on one day, and a shift with nobody on it.
 *
 * Both used to be impossible for the same reason: a rota cell was one row per
 * person per day, so a second shift silently deleted the first and a slot only
 * existed while somebody was standing in it. What is pinned down here is that
 * neither disappears quietly — the double is kept and marked until somebody
 * clears it, and the empty slot stays on the day until somebody takes it or
 * deletes it.
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
            (2, 'Dinner', '14:00', '22:00', 0, 5),
            (3, 'Nights', '22:00', '06:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01'),
            (2, '2', 'Ama', 'Kitchen', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const ADMIN = { user: { id: 3, name: 'Kwame', role: 'admin' }, permissions: ['att_setup'] };

const ctx = (db, { body = null, query = '', session = PLANNER } = {}) => ({
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

const DAY = '2026-06-02';
const WINDOW = '?from=2026-06-01&to=2026-06-14';

const save = (db, entries) => saveRoster(ctx(db, { body: { entries } }));
const look = async (db) => (await getRoster(ctx(db, { query: WINDOW }))).json();
const cellOf = (data, staffId, day = DAY) => data.rows.find((r) => r.staff.id === staffId)
  .days.find((d) => d.day === day);

// ---------------------------------------------------------------------------
// Two shifts on one day
// ---------------------------------------------------------------------------

test('a second shift is kept beside the first rather than replacing it', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2, add: true }]);

  const cell = cellOf(await look(db), 1);
  assert.equal(cell.shift_id, 1, 'the one they already had is still the day');
  assert.equal(cell.extra.length, 1, 'and the new one is beside it');
  assert.equal(cell.extra[0].shift_id, 2);
});

test('the first shift of the day is the earliest, whichever was typed first', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1, add: true }]);

  const cell = cellOf(await look(db), 1);
  assert.equal(cell.shift_id, 1, 'breakfast comes before dinner however they were entered');
  assert.equal(cell.extra[0].shift_id, 2);
});

test('the same shift twice is not a double', async () => {
  const { db, raw } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1, add: true }]);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster').get().n, 1,
    'the same promise written down twice is one promise');
  assert.equal(cellOf(await look(db), 1).extra.length, 0);
});

test('the database itself refuses the same shift twice', async () => {
  const { raw } = setup();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(DAY);
  assert.throws(
    () => raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(DAY),
    /UNIQUE/,
  );
  // And a rostered day off is one row too, nulls or no nulls.
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (2, ?, NULL)').run(DAY);
  assert.throws(
    () => raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (2, ?, NULL)').run(DAY),
    /UNIQUE/,
  );
});

test('changing one of the two leaves the other alone', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2, add: true }]);

  const before = cellOf(await look(db), 1);
  await save(db, [{ id: before.id, day: DAY, shiftId: 3 }]);

  const after = cellOf(await look(db), 1);
  // Dinner starts before nights, so the day's first shift is now dinner and
  // the one that moved is the extra. Both are still there, which is the point.
  assert.deepEqual(
    [after.shift_id, ...after.extra.map((x) => x.shift_id)].sort(),
    [2, 3],
  );
});

test('taking the second one off leaves the first standing', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2, add: true }]);

  const cell = cellOf(await look(db), 1);
  await save(db, [{ id: cell.extra[0].id, day: DAY, remove: true }]);

  const after = cellOf(await look(db), 1);
  assert.equal(after.shift_id, 1);
  assert.equal(after.extra.length, 0, 'nothing left to warn about');
});

test('a rostered day off clears the day, second shift and all', async () => {
  // Somebody given Thursday off is not also working the evening.
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2, add: true }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: null }]);

  const cell = cellOf(await look(db), 1);
  assert.equal(cell.shift_id, null);
  assert.equal(cell.extra.length, 0);
  assert.equal(cell.explicit, true, 'a day off is a decision, not the absence of one');
});

test('handing the day back to the pattern takes both', async () => {
  const { db, raw } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2, add: true }]);
  await save(db, [{ staffId: 1, day: DAY, clear: true }]);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster').get().n, 0);
});

test('both shifts count towards cover, and a double is one person twice', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2, add: true }]);

  const data = await look(db);
  const cover = data.coverage.find((c) => c.day === DAY);
  assert.equal(cover.counts[1], 1);
  assert.equal(cover.counts[2], 1, 'the evening has somebody on it, and it is the same somebody');
});

test('copying a week says what the day is, so a double on the target goes', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: '2026-06-01', shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: '2026-06-08', shiftId: 2 }]);
  await save(db, [{ staffId: 1, day: '2026-06-08', shiftId: 3, add: true }]);

  await copyRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-08' } }));

  const cell = cellOf(await look(db), 1, '2026-06-08');
  assert.equal(cell.shift_id, 1);
  assert.equal(cell.extra.length, 0, 'a copied week is the week, not the week plus what was there');
});

// ---------------------------------------------------------------------------
// A shift with nobody on it
// ---------------------------------------------------------------------------

test('a slot can be made with nobody on it', async () => {
  const { db } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 1 }]);

  const data = await look(db);
  assert.equal(data.slots.length, 1);
  assert.equal(data.slots[0].day, DAY);
  assert.equal(data.slots[0].shift_id, 1);
  assert.equal(data.coverage.find((c) => c.day === DAY).unfilled[1], 1);
  assert.equal(data.coverage.find((c) => c.day === DAY).counts[1], 0,
    'wanting somebody is not having somebody');
});

test('a shift needing two people is two slots', async () => {
  const { db } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 1 }, { slot: true, day: DAY, shiftId: 1 }]);
  assert.equal((await look(db)).coverage.find((c) => c.day === DAY).unfilled[1], 2);
});

test('taking the person off leaves the shift on the day', async () => {
  // The whole of the second half of this: the shift was put on the day
  // because the day needs covering, and that is still true when the person
  // walks away from it.
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  const cell = cellOf(await look(db), 1);

  await save(db, [{ id: cell.id, day: DAY, staffId: null }]);

  const data = await look(db);
  assert.equal(cellOf(data, 1).shift_id, null, 'off their row');
  assert.equal(data.slots.length, 1, 'and still on the day');
  assert.equal(data.slots[0].shift_id, 1);
});

test('filling a slot takes it off the unfilled list and puts it on a person', async () => {
  const { db } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 1 }]);
  const slot = (await look(db)).slots[0];

  await save(db, [{ id: slot.id, day: DAY, staffId: 2 }]);

  const data = await look(db);
  assert.equal(data.slots.length, 0);
  assert.equal(cellOf(data, 2).shift_id, 1);
  assert.equal(cellOf(data, 2).id, slot.id, 'the same row, handed over');
});

test('a slot only goes when somebody says so', async () => {
  const { db } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 1 }]);
  const slot = (await look(db)).slots[0];

  // Everything else that touches the day leaves it alone.
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2 }]);
  await save(db, [{ staffId: 1, day: DAY, clear: true }]);
  assert.equal((await look(db)).slots.length, 1);

  await save(db, [{ id: slot.id, day: DAY, remove: true }]);
  assert.equal((await look(db)).slots.length, 0);
});

test('deleting the shift is the one thing that takes its empty slots', async () => {
  const { db, raw } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 1 }]);

  await deleteShift(ctx(db, { session: ADMIN }), '1');

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_shifts WHERE id = 1').get().n, 0);
});

test('a shift somebody is actually on still cannot be deleted', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await assert.rejects(
    () => deleteShift(ctx(db, { session: ADMIN }), '1'),
    /rostered day/,
  );
});

test('a slot is a draft until the rota is published, like anything else', async () => {
  const { db } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 1 }]);

  let data = await look(db);
  assert.equal(data.slots[0].published, false);
  assert.equal(data.publish.fresh, 1, 'it is a change waiting to be published');

  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14', notify: 'none' } }));
  data = await look(db);
  assert.equal(data.slots[0].published, true);
});

// ---------------------------------------------------------------------------
// What the day is still worked out against
// ---------------------------------------------------------------------------

test('a day still computes against one shift, which is why the mark matters', async () => {
  // The engine writes one day record per person per day, so a double has to
  // resolve to one shift somewhere. It resolves to the earliest, and the rota
  // says something is wrong until somebody makes it true.
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1, add: true }]);

  const cell = cellOf(await look(db), 1);
  assert.equal(cell.shift_id, 1);
  assert.equal(cell.source, 'roster');
  assert.equal(cell.extra.length, 1);
});

test('every change needs a date, and says so rather than falling over', async () => {
  const { db } = setup();
  await assert.rejects(
    () => save(db, [{ staffId: 1, shiftId: 1 }]),
    /needs a date/,
  );
});
