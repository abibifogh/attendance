import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  clearRoster, copyRoster, getRoster, publishRoster, saveRoster,
} from '../src/routes/attendance.js';

/**
 * A shift standing on a day with nobody on it does not quietly go.
 *
 * It is the shape of the week — the record of what a day still needs — and
 * losing one is losing the fact that Saturday needs a third receptionist. It
 * has gone missing twice now, so every ordinary thing a planner does to a rota
 * is run here and the slot counted afterwards.
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
            DELETE FROM att_leave; DELETE FROM users; DELETE FROM app_notices;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5),
            (2, 'Dinner', '14:00', '22:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Adjoa', 'Front', '2020-01-01'),
            (2, '2', 'Kwesi', 'Front', '2020-01-01')`,
  ).run();

  // The thing being protected: Reception wanted on the Tuesday, nobody on it.
  raw.prepare(
    "INSERT INTO att_roster (staff_id, day, shift_id) VALUES (NULL, '2026-09-08', 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = {
  user: { id: 2, name: 'Yaa', role: 'planner' },
  permissions: ['att_rota', 'att_view'],
};

const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session: PLANNER,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

/** How many shifts are standing on a day with nobody on them. */
const slots = (raw) => raw.prepare(
  'SELECT * FROM att_roster WHERE staff_id IS NULL ORDER BY day',
).all();

const WEEK = '?from=2026-09-07&to=2026-09-13';
const seen = async (db) => ((await (await getRoster(ctx(db, { query: WEEK }))).json()).slots ?? []);

test('the grid shows it in the first place', async () => {
  const { db } = setup();
  const showing = await seen(db);
  assert.equal(showing.length, 1);
  assert.equal(showing[0].day, '2026-09-08');
});

test('saving somebody onto another day leaves it alone', async () => {
  const { db, raw } = setup();
  await saveRoster(ctx(db, {
    body: { entries: [{ staffId: 1, day: '2026-09-09', shiftId: 1 }] },
  }));
  assert.equal(slots(raw).length, 1);
});

test('saving somebody onto the same day leaves it alone', async () => {
  const { db, raw } = setup();
  // The day the slot is on. A change addressed by person and day replaces that
  // person's day, and a slot belongs to no person.
  await saveRoster(ctx(db, {
    body: { entries: [{ staffId: 1, day: '2026-09-08', shiftId: 2 }] },
  }));
  assert.equal(slots(raw).length, 1, 'the slot is nobody’s day to replace');
});

test('giving somebody a rest day on that day leaves it alone', async () => {
  const { db, raw } = setup();
  await saveRoster(ctx(db, {
    body: { entries: [{ staffId: 1, day: '2026-09-08', shiftId: null }] },
  }));
  assert.equal(slots(raw).length, 1);
});

test('clearing somebody back to the pattern on that day leaves it alone', async () => {
  const { db, raw } = setup();
  await saveRoster(ctx(db, {
    body: { entries: [{ staffId: 1, day: '2026-09-08', clear: true }] },
  }));
  assert.equal(slots(raw).length, 1);
});

test('publishing leaves it alone', async () => {
  const { db, raw } = setup();
  await publishRoster(ctx(db, { body: { from: '2026-09-07', to: '2026-09-13' } }));
  assert.equal(slots(raw).length, 1, 'a shift nobody is on is still a shift the day needs');
});

test('copying a week onto another leaves the one already there alone', async () => {
  const { db, raw } = setup();
  await saveRoster(ctx(db, {
    body: { entries: [{ staffId: 1, day: '2026-09-01', shiftId: 1 }] },
  }));
  await copyRoster(ctx(db, { body: { from: '2026-08-31', to: '2026-09-07', weeks: 1 } }));
  assert.equal(slots(raw).filter((s) => s.day === '2026-09-08').length, 1);
});

test('copying a week brings its unfilled shifts with it', async () => {
  const { db, raw } = setup();
  // The week beginning 31 August wants a Dinner on the Tuesday that nobody is
  // on. Copying that week onto the next has to bring the shape of it, or the
  // copy is a week that has stopped needing anybody.
  raw.prepare(
    "INSERT INTO att_roster (staff_id, day, shift_id) VALUES (NULL, '2026-09-01', 2)",
  ).run();

  await copyRoster(ctx(db, { body: { from: '2026-08-31', to: '2026-09-07', weeks: 1 } }));

  const onward = slots(raw).filter((s) => s.day === '2026-09-08');
  assert.equal(onward.length, 2, 'the Reception already there, and the Dinner copied across');
  assert.deepEqual(onward.map((s) => s.shift_id).sort(), [1, 2]);
});

test('copying the same week twice does not stack the empty shifts up', async () => {
  const { db, raw } = setup();
  raw.prepare(
    "INSERT INTO att_roster (staff_id, day, shift_id) VALUES (NULL, '2026-09-01', 2)",
  ).run();

  const press = () => copyRoster(ctx(db, {
    body: { from: '2026-08-31', to: '2026-09-07', weeks: 1 },
  }));
  await press();
  await press();

  const onward = slots(raw).filter((s) => s.day === '2026-09-08');
  assert.equal(onward.length, 2, 'the second press had nothing left to add');
});

test('clearing a period leaves it alone unless it is asked for', async () => {
  const { db, raw } = setup();
  await clearRoster(ctx(db, { body: { from: '2026-09-07', to: '2026-09-13' } }));
  assert.equal(slots(raw).length, 1);

  await clearRoster(ctx(db, {
    body: { from: '2026-09-07', to: '2026-09-13', includeSlots: true },
  }));
  assert.equal(slots(raw).length, 0);
});

test('somebody put on it fills it rather than leaving two', async () => {
  const { db, raw } = setup();
  const showing = await seen(db);

  // The one way a slot is meant to stop being a slot: somebody stands in it.
  await saveRoster(ctx(db, {
    body: { entries: [{ id: showing[0].id, day: '2026-09-08', staffId: 2 }] },
  }));

  assert.equal(slots(raw).length, 0, 'it is not empty any more');
  const filled = raw.prepare(
    "SELECT * FROM att_roster WHERE day = '2026-09-08' AND staff_id = 2",
  ).all();
  assert.equal(filled.length, 1, 'and it is the same row, not a second one');
  assert.equal(filled[0].shift_id, 1);
});
