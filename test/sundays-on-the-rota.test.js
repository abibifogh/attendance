import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster } from '../src/routes/attendance.js';
import { sundaysOwedOff } from '../src/lib/workload.js';

/**
 * The Sunday mark on the rota.
 *
 * The house rule is one Sunday off a month, and the rota is read a week at a
 * time. One Sunday on screen says nothing about the other three, so a breach
 * of the rule was invisible on the one screen where somebody could still do
 * something about it. What is pinned down here is that the count is taken over
 * the whole calendar month whatever window is open, that a standing pattern
 * counts the same as a rostered day, and that leave is a Sunday off rather
 * than a Sunday worked.
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

// ---------------------------------------------------------------------------
// The mark on the grid
// ---------------------------------------------------------------------------

test('working every Sunday of the month marks the one on screen', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);

  const cell = cellOn(await look(db), 'Adjoa', SHOWN);
  assert.deepEqual(cell.sundayOver, { worked: 4, of: 4, owed: 1 });
});

test('the count is the month, not the week on screen', async () => {
  const { db, raw } = setup();
  // The only Sunday the planner can see is one she is on, and on its own it
  // says nothing. The three behind it are what make it a breach.
  roster(raw, 1, [SHOWN]);
  assert.equal(cellOn(await look(db), 'Adjoa', SHOWN).sundayOver, null);

  roster(raw, 1, ['2026-09-06', '2026-09-20', '2026-09-27']);
  assert.equal(cellOn(await look(db), 'Adjoa', SHOWN).sundayOver.worked, 4);
});

test('one Sunday off in the month is the rule kept', async () => {
  const { db, raw } = setup();
  roster(raw, 1, ['2026-09-06', SHOWN, '2026-09-20']);
  assert.equal(cellOn(await look(db), 'Adjoa', SHOWN).sundayOver, null);
});

test('a standing pattern counts the same as a rostered day', async () => {
  const { db, raw } = setup();
  // Nobody has touched the roster table for this person at all. Working every
  // Sunday by pattern is the plainest case of the rule being broken and the
  // one a count that read only the roster would miss.
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 6, 1)',
  ).run();

  const cell = cellOn(await look(db), 'Adjoa', SHOWN);
  assert.deepEqual(cell.sundayOver, { worked: 4, of: 4, owed: 1 });
});

test('leave on a Sunday is a Sunday off', async () => {
  const { db, raw } = setup();
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 6, 1)',
  ).run();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', '2026-09-19', '2026-09-21', 3, 'approved')`,
  ).run();

  assert.equal(cellOn(await look(db), 'Adjoa', SHOWN).sundayOver, null);
});

test('a Sunday somebody is off is never marked', async () => {
  const { db, raw } = setup();
  // Kwesi is on three Sundays and off the one on screen, so the month is short
  // of nothing and there is nothing on his cell either way.
  roster(raw, 2, ['2026-09-06', '2026-09-20', '2026-09-27']);
  const cell = cellOn(await look(db), 'Kwesi', SHOWN);
  assert.equal(cell.sundayOver, null);
  assert.equal(cell.shift_id, null);
});

test('the mark is only ever on a Sunday', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);
  roster(raw, 1, ['2026-09-07', '2026-09-08', '2026-09-09']);

  const marked = (await look(db)).rows
    .flatMap((r) => r.days).filter((d) => d.sundayOver).map((d) => d.day);
  assert.deepEqual(marked, [SHOWN]);
});

test('a window with no Sunday in it asks nothing and marks nothing', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);

  const data = await look(db, '?from=2026-09-07&to=2026-09-11');
  assert.equal(data.days.length, 5);
  assert.equal(data.rows.flatMap((r) => r.days).some((d) => d.sundayOver), false);
});

test('switching the rule off takes the mark away', async () => {
  const { db, raw } = setup();
  roster(raw, 1, SUNDAYS);
  raw.prepare(
    "INSERT INTO settings (key, value) VALUES ('wl_sundaysOffPerMonth', '0')"
    + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run();

  assert.equal(cellOn(await look(db), 'Adjoa', SHOWN).sundayOver, null);
});

test('a fortnight spanning two months counts each month on its own', async () => {
  const { db, raw } = setup();
  // Every Sunday in September, none in October. The September Sundays on
  // screen are marked and the October one is not.
  roster(raw, 1, SUNDAYS);

  const data = await look(db, '?from=2026-09-21&to=2026-10-04');
  assert.equal(cellOn(data, 'Adjoa', '2026-09-27').sundayOver.worked, 4);
  assert.equal(cellOn(data, 'Adjoa', '2026-10-04').sundayOver, null);
});
