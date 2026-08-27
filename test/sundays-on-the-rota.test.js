import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster } from '../src/routes/attendance.js';
import { sundaysOwedOff, sundaysWorkedCap } from '../src/lib/workload.js';

/**
 * The Sunday mark on the rota.
 *
 * The rota is read a week at a time, and one Sunday on screen says nothing
 * about the other three, so anybody being given too many of them was invisible
 * on the one screen where somebody could still move them.
 *
 * Every Sunday cell now carries the running count, full or empty, because "this
 * is their second of four" is what somebody about to fill one needs. Whether
 * they are at the line is a separate flag on the same answer, so the screen can
 * say the count quietly and the warning loudly. What is pinned down here is
 * that the count is taken over the whole calendar month whatever window is
 * open, that the line is Sundays worked rather than Sundays lost — two in a
 * month, not the last one gone — that a standing pattern counts the same as a
 * rostered day, and that leave is a Sunday off.
 *
 * September 2026 has four Sundays: the 6th, 13th, 20th and 27th. The window
 * used throughout is Monday the 7th to Sunday the 13th, so exactly one of
 * those four is on screen.
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
            DELETE FROM att_leave; DELETE FROM users; DELETE FROM audit_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Adjoa', 'Front', '2020-01-01'),
            (2, '2', 'Kwesi', 'Front', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };

const ctx = (db, query) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/roster${query}`),
  session: PLANNER,
  executionContext: null,
  request: new Request('https://x/'),
});

const SUNDAYS = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'];
const SHOWN = '2026-09-13';
const WEEK = '?from=2026-09-07&to=2026-09-13';

const roster = (raw, staffId, days) => {
  for (const day of days) {
    raw.prepare(
      'INSERT INTO att_roster (staff_id, day, shift_id) VALUES (?, ?, 1)',
    ).run(staffId, day);
  }
};

const cellOn = (data, name, day) => data.rows
  .find((r) => r.staff.name === name)
  .days.find((d) => d.day === day);

/** The count on a cell, and whether it is at the line this property draws. */
const countOn = (data, name, day) => cellOn(data, name, day).sundays;
const isLoud = (data, name, day) => Boolean(countOn(data, name, day)?.over);

const look = async (db, query = WEEK) => (await getRoster(ctx(db, query))).json();

// ---------------------------------------------------------------------------
// The arithmetic on its own
// ---------------------------------------------------------------------------

test('a month of Sundays owes one off, a week of them owes none', () => {
  assert.equal(sundaysOwedOff(4), 1);
  assert.equal(sundaysOwedOff(5), 1);
  assert.equal(sundaysOwedOff(1), 0);
  assert.equal(sundaysOwedOff(8), 2);
});

test('a house that has switched the rule off is owed nothing', () => {
  assert.equal(sundaysOwedOff(4, { sundaysOffPerMonth: { value: 0 } }), 0);
});

test('the mark trips on Sundays worked, and two is the default', () => {
  // The older rule only had anything to say once every Sunday was gone, which
  // is a month too late to move anybody.
  assert.equal(sundaysWorkedCap(), 2);
  assert.equal(sundaysWorkedCap({ sundaysWorkedPerMonth: { value: 3 } }), 3);
  assert.equal(sundaysWorkedCap({ sundaysWorkedPerMonth: { value: 0 } }), 0);
});

// ---------------------------------------------------------------------------
// The mark on the grid
// ---------------------------------------------------------------------------

test('working every Sunday of the month marks the one on screen', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);

  assert.deepEqual(countOn(await look(db), 'Adjoa', SHOWN),
    { worked: 4, of: 4, cap: 2, over: true });
});

test('two in a month is where it goes loud, and one is said quietly', async () => {
  const { db, raw } = setup();
  roster(raw, 1, [SHOWN]);
  assert.deepEqual(countOn(await look(db), 'Adjoa', SHOWN),
    { worked: 1, of: 4, cap: 2, over: false },
    'one Sunday is a count, not a warning');

  roster(raw, 1, ['2026-09-20']);
  assert.deepEqual(countOn(await look(db), 'Adjoa', SHOWN),
    { worked: 2, of: 4, cap: 2, over: true },
    'the second one is, and it says so while there is still time to move them');
});

test('the count is the month, not the week on screen', async () => {
  const { db, raw } = setup();
  // The only Sunday the planner can see is one she is on, and on its own it
  // says nothing. The three behind it are what make it a warning.
  roster(raw, 1, [SHOWN]);
  assert.equal(isLoud(await look(db), 'Adjoa', SHOWN), false);

  roster(raw, 1, ['2026-09-06', '2026-09-20', '2026-09-27']);
  assert.equal(countOn(await look(db), 'Adjoa', SHOWN).worked, 4);
});

test('a month with one Sunday on it counts but does not warn', async () => {
  const { db, raw } = setup();
  roster(raw, 1, [SHOWN]);
  assert.equal(isLoud(await look(db), 'Adjoa', SHOWN), false);
});

test('a standing pattern counts the same as a rostered day', async () => {
  const { db, raw } = setup();
  // Nobody has touched the roster table for this person at all. Working every
  // Sunday by pattern is the plainest case of the rule being broken and the
  // one a count that read only the roster would miss.
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 6, 1)',
  ).run();

  assert.deepEqual(countOn(await look(db), 'Adjoa', SHOWN),
    { worked: 4, of: 4, cap: 2, over: true });
});

test('leave on a Sunday is a Sunday off', async () => {
  const { db, raw } = setup();
  // The first Sunday of the month, so the leave that follows it can take the
  // other three without taking the cell being looked at.
  const FIRST = '2026-09-06';
  const ITS_WEEK = '?from=2026-08-31&to=2026-09-06';

  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 6, 1)',
  ).run();
  assert.equal(countOn(await look(db, ITS_WEEK), 'Adjoa', FIRST).worked, 4,
    'down for all four by pattern');

  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', '2026-09-08', '2026-09-30', 17, 'approved')`,
  ).run();

  assert.deepEqual(countOn(await look(db, ITS_WEEK), 'Adjoa', FIRST),
    { worked: 1, of: 4, cap: 2, over: false },
    'one Sunday actually worked, so it counts but does not warn');
});

test('a Sunday they are off is marked too, which is the point of it', async () => {
  const { db, raw } = setup();
  // Kwesi is on three of September's Sundays and off the one on screen. The
  // empty cell is exactly where a planner is about to put him on a fourth, so
  // it is where the count is worth saying.
  roster(raw, 2, ['2026-09-06', '2026-09-20', '2026-09-27']);

  const cell = cellOn(await look(db), 'Kwesi', SHOWN);
  assert.equal(cell.shift_id, null, 'nobody has put him on this one');
  assert.deepEqual(cell.sundays, { worked: 3, of: 4, cap: 2, over: true });
});

test('a draft Sunday counts the same as a published one', async () => {
  const { db, raw } = setup();
  // Nothing here waits for Publish. A rota is decided when it is saved, and a
  // count that only saw published days would say a planner had done nothing
  // all afternoon.
  roster(raw, 1, ['2026-09-06', '2026-09-20']);
  raw.prepare('UPDATE att_roster SET published = 0').run();

  assert.deepEqual(countOn(await look(db), 'Adjoa', SHOWN),
    { worked: 2, of: 4, cap: 2, over: true });
});

test('somebody under the line still gets their count, quietly', async () => {
  const { db, raw } = setup();
  roster(raw, 2, ['2026-09-06']);
  const loud = (await look(db)).rows
    .flatMap((r) => r.days).filter((d) => d.sundays?.over);
  assert.deepEqual(loud, [], 'nobody is at the line');
  assert.equal(countOn(await look(db), 'Kwesi', SHOWN).worked, 1, 'but the count is there');
});

test('the mark is only ever on a Sunday', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);
  roster(raw, 1, ['2026-09-07', '2026-09-08', '2026-09-09']);

  const counted = [...new Set((await look(db)).rows
    .flatMap((r) => r.days).filter((d) => d.sundays).map((d) => d.day))];
  assert.deepEqual(counted, [SHOWN], 'the weekdays they are on carry nothing');
});

test('a window with no Sunday in it asks nothing and marks nothing', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);

  const data = await look(db, '?from=2026-09-07&to=2026-09-11');
  assert.equal(data.days.length, 5);
  assert.equal(data.rows.flatMap((r) => r.days).some((d) => d.sundays), false);
});

test('switching the rule off takes the mark away', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);
  raw.prepare(
    "INSERT INTO settings (key, value) VALUES ('wl_sundaysWorkedPerMonth', '0')"
    + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run();

  assert.equal(cellOn(await look(db), 'Adjoa', SHOWN).sundays, null,
    'the rule is off, so there is no count either');
});

test('a property that draws the line elsewhere gets its own line', async () => {
  const { db, raw } = setup();
  roster(raw, 1, ['2026-09-06', SHOWN, '2026-09-20']);
  raw.prepare(
    "INSERT INTO settings (key, value) VALUES ('wl_sundaysWorkedPerMonth', '4')"
    + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run();

  assert.equal(isLoud(await look(db), 'Adjoa', SHOWN), false,
    'three is under a cap of four');

  roster(raw, 1, ['2026-09-27']);
  assert.equal(isLoud(await look(db), 'Adjoa', SHOWN), true);
});

test('a fortnight spanning two months counts each month on its own', async () => {
  const { db, raw } = setup();
  // Every Sunday in September, none in October. The September Sundays on
  // screen are marked and the October one is not.
  roster(raw, 1, SUNDAYS);

  const data = await look(db, '?from=2026-09-21&to=2026-10-04');
  assert.equal(countOn(data, 'Adjoa', '2026-09-27').worked, 4, 'September, all four');
  assert.deepEqual(countOn(data, 'Adjoa', '2026-10-04'),
    { worked: 0, of: 4, cap: 2, over: false },
    'October starts again at nothing, which is the point of counting by month');
});
