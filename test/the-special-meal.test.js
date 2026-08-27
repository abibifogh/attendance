import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster } from '../src/routes/attendance.js';
import { isLastFriday, lastFridayOf } from '../src/util/dates.js';

/**
 * The special meal, and who missed the last one.
 *
 * It falls on the last Friday of every month, which makes it the one day of
 * the month worth knowing somebody was off. Marked on this month's meal for
 * anybody who was off last month's, so the planner puts them on this one
 * rather than the same people eating together every month.
 *
 * The mark stays after they have been rostered. It is a fact about last month
 * rather than a gap: on a cell with a shift in it, it is the reason they are
 * on it.
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
            DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Dinner', '14:00', '22:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on)
     VALUES (1, '1', 'Adjoa', '2020-01-01'), (2, '2', 'Kwesi', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const ctx = (db, query) => ({
  db, env: {}, url: new URL(`https://x/api/att/roster${query}`),
  session: PLANNER, executionContext: null, request: new Request('https://x/'),
});

// August 2026: the last Friday is the 28th. July's is the 31st.
const MEAL = '2026-08-28';
const BEFORE = '2026-07-31';
const WEEK = '?from=2026-08-24&to=2026-08-30';

const look = async (db, q = WEEK) => (await getRoster(ctx(db, q))).json();
const cellOn = (data, name, day) => data.rows
  .find((r) => r.staff.name === name).days.find((d) => d.day === day);

const roster = (raw, staffId, days, shiftId = 1) => {
  for (const day of days) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (?, ?, ?)')
      .run(staffId, day, shiftId);
  }
};

// ---------------------------------------------------------------------------
// Which day it is
// ---------------------------------------------------------------------------

test('the last Friday is counted back from the end of the month', () => {
  assert.equal(lastFridayOf('2026-08'), '2026-08-28');
  assert.equal(lastFridayOf('2026-07'), '2026-07-31', 'a month ending on a Friday');
  assert.equal(lastFridayOf('2026-02'), '2026-02-27');
  assert.equal(lastFridayOf('2026-05'), '2026-05-29', 'a month with five Fridays');
  assert.equal(isLastFriday('2026-08-28'), true);
  assert.equal(isLastFriday('2026-08-21'), false, 'the Friday before is not the last one');
  assert.equal(isLastFriday('2026-08-27'), false, 'nor the Thursday');
});

// ---------------------------------------------------------------------------
// Who missed the last one
// ---------------------------------------------------------------------------

test('somebody off last month’s meal is marked on this one', async () => {
  const { db, raw } = setup();
  roster(raw, 2, [BEFORE]);

  const data = await look(db);
  const adjoa = cellOn(data, 'Adjoa', MEAL);
  assert.equal(adjoa.shift_id, null,
    'nobody has put her on this one yet, which is when the mark is worth having');
  assert.deepEqual(adjoa.missedMeal, { was: BEFORE });
  assert.equal(cellOn(data, 'Kwesi', MEAL).missedMeal, null, 'Kwesi was there');
});

test('a draft day counts as having been there', async () => {
  const { db, raw } = setup();
  roster(raw, 1, [BEFORE]);
  raw.prepare('UPDATE att_roster SET published = 0').run();

  assert.equal(cellOn(await look(db), 'Adjoa', MEAL).missedMeal, null,
    'nothing here waits for Publish');
});

test('the mark stays once they have been put on this one', async () => {
  const { db, raw } = setup();
  roster(raw, 1, [MEAL]);

  const cell = cellOn(await look(db), 'Adjoa', MEAL);
  assert.equal(cell.shift_id, 1);
  assert.deepEqual(cell.missedMeal, { was: BEFORE },
    'on a rostered cell it is the reason they are on it');
});

test('a standing pattern counts as having been there', async () => {
  const { db, raw } = setup();
  // 31 July 2026 is a Friday, which is weekday 4 counting Monday as 0.
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 4, 1)',
  ).run();

  assert.equal(cellOn(await look(db), 'Adjoa', MEAL).missedMeal, null);
});

test('leave on the day is being off it', async () => {
  const { db, raw } = setup();
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 4, 1)',
  ).run();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', '2026-07-27', '2026-08-02', 5, 'approved')`,
  ).run();

  assert.deepEqual(cellOn(await look(db), 'Adjoa', MEAL).missedMeal, { was: BEFORE });
});

test('a rostered day off is being off it', async () => {
  const { db, raw } = setup();
  raw.prepare(
    "INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, '2026-07-31', NULL)",
  ).run();

  assert.deepEqual(cellOn(await look(db), 'Adjoa', MEAL).missedMeal, { was: BEFORE });
});

test('the mark is only ever on the meal day itself', async () => {
  const { db } = setup();
  const marked = (await look(db)).rows
    .flatMap((r) => r.days).filter((d) => d.missedMeal).map((d) => d.day);
  assert.deepEqual([...new Set(marked)], [MEAL]);
});

test('a week with no last Friday in it is asked nothing', async () => {
  const { db } = setup();
  // 17 to 23 August: the last Friday is the 28th, outside this window.
  const data = await look(db, '?from=2026-08-17&to=2026-08-23');
  assert.equal(data.rows.flatMap((r) => r.days).some((d) => d.missedMeal), false);
});

test('somebody not yet hired last month has missed nothing', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_staff SET hired_on = '2026-08-10' WHERE id = 1").run();

  assert.equal(cellOn(await look(db), 'Adjoa', MEAL).missedMeal, null);
});

test('somebody off the rota is not asked about at all', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET on_rota = 0 WHERE id = 1').run();

  const data = await look(db);
  assert.equal(data.rows.some((r) => r.staff.name === 'Adjoa'), false);
});

test('a fortnight spanning two months marks each meal against its own', async () => {
  const { db, raw } = setup();
  // On July's meal but off August's-previous is the same question asked twice
  // over a window that holds only one meal, so this checks the window that
  // holds August's while July's is behind it.
  roster(raw, 1, [BEFORE]);
  const data = await look(db, '?from=2026-08-24&to=2026-09-06');
  assert.equal(cellOn(data, 'Adjoa', MEAL).missedMeal, null, 'Adjoa was at July’s');
  assert.equal(cellOn(data, 'Kwesi', MEAL).missedMeal.was, BEFORE);
});
