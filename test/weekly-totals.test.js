import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { weekTotals } from '../src/routes/attendance.js';
import { allows, effectivePermissions } from '../src/lib/permissions.js';

/**
 * The week as totals, for somebody who may see nothing else.
 *
 * Whoever checks that a week adds up does not need to know who was eleven
 * minutes late on Tuesday, and a permission that hides a column while sending
 * the whole week down the wire is a curtain rather than a permission. What is
 * pinned down here is that the answer carries four numbers a person and no
 * days at all, and that holding this one permission opens this and nothing
 * else.
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
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Adjoa', 'Front', '2020-01-01'),
            (2, '2', 'Kwesi', 'Kitchen', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const ctx = (db, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/totals${query}`),
  session: { user: { id: 5, name: 'Ama', role: 'totals' }, permissions: ['att_totals'] },
  executionContext: null,
  request: new Request('https://x/'),
});

const WEEK = '?from=2026-06-01';

/**
 * A day on the record: down for the Reception shift, and two taps against it.
 *
 * The report recomputes from the punches rather than trusting whatever is in
 * `att_days`, so the punches are what a test has to put there.
 */
const worked = (raw, staffId, day, from, to) => {
  raw.prepare(
    'INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, 1, 1)',
  ).run(staffId, day);
  const tap = (at, direction) => raw.prepare(
    `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                              direction, device_status, dedupe_key)
     VALUES ('DS-1', ?, ?, ?, ?, ?, ?, 'checkIn', ?)`,
  ).run(
    String(staffId), staffId, `${day} ${at}:00`, `${day} ${at}:00`, day, direction,
    `${staffId}-${day}-${at}`,
  );
  tap(from, 'in');
  tap(to, 'out');
};

test('it adds the week up per person, and says what the week came to', async () => {
  const { db, raw } = setup();
  worked(raw, 1, '2026-06-01', '06:00', '14:00');   // the eight hours asked for
  worked(raw, 1, '2026-06-02', '06:00', '13:30');   // half an hour short of them
  worked(raw, 2, '2026-06-03', '06:00', '14:20');   // twenty minutes over

  const out = await (await weekTotals(ctx(db, WEEK))).json();

  assert.equal(out.from, '2026-06-01');
  assert.equal(out.to, '2026-06-07');

  const adjoa = out.rows.find((r) => r.staff.name === 'Adjoa');
  assert.deepEqual(
    { d: adjoa.daysRostered, w: adjoa.daysWorked, e: adjoa.expectedMinutes, m: adjoa.workedMinutes },
    { d: 2, w: 2, e: 960, m: 930 },
    'two days down for, two worked, sixteen hours asked for and fifteen and a half recorded',
  );

  assert.deepEqual(out.totals, {
    people: 2,
    daysRostered: 3,
    daysWorked: 3,
    expectedMinutes: 1440,
    workedMinutes: 1430,
  });
});

test('it carries no day, no clock time and no reason for anything', async () => {
  const { db, raw } = setup();
  worked(raw, 1, '2026-06-01', '06:14', '14:02');

  const out = await (await weekTotals(ctx(db, WEEK))).json();
  const [row] = out.rows;

  assert.deepEqual(Object.keys(row).sort(), [
    'daysRostered', 'daysWorked', 'expectedMinutes', 'staff', 'workedMinutes',
  ]);
  assert.deepEqual(Object.keys(row.staff).sort(), ['department', 'employee_no', 'id', 'name']);
  assert.equal(JSON.stringify(out).includes('06:14'), false, 'no clock times went out');
  assert.equal(JSON.stringify(out).includes('late'), false, 'and nothing about lateness');
});

test('somebody who had not started that week is not a row on it', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_staff SET hired_on = '2026-07-01' WHERE id = 2").run();
  worked(raw, 1, '2026-06-01', '06:00', '14:00');

  const out = await (await weekTotals(ctx(db, WEEK))).json();
  assert.deepEqual(out.rows.map((r) => r.staff.name), ['Adjoa']);
});

test('a week nobody is on says so rather than adding nothing up', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_staff SET hired_on = '2027-01-01'").run();

  const out = await (await weekTotals(ctx(db, WEEK))).json();
  assert.deepEqual(out.rows, []);
  assert.equal(out.totals.people, 0);
});

test('the permission opens the totals and nothing else', () => {
  const held = effectivePermissions({ role: 'totals', permissions: null });

  assert.deepEqual(held, ['att_totals'],
    'and it does not drag the attendance screen along with it');
  assert.equal(allows(['att_totals', 'att_reports'], held), true, 'the totals are theirs');

  for (const shut of ['att_view', 'att_reports', 'att_rota', 'att_manage', 'hr_view', 'hr_pay']) {
    assert.equal(allows(shut, held), false, `${shut} is not`);
  }
});

test('anybody who can read the reports can read the totals as well', () => {
  const manager = effectivePermissions({ role: 'manager', permissions: null });
  assert.equal(allows(['att_totals', 'att_reports'], manager), true);
});
