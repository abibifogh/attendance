import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { changeDaysApplied, leaveAdjustments } from '../src/routes/signoff.js';

/**
 * What is behind "Days given back".
 *
 * A figure with no visible cause is a figure people argue with. It is the sum
 * of what every closed period in the leave year moved, and until now the only
 * way to find out which ones was to read the sign-off screen month by month
 * and add them up.
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
  raw.exec(`DELETE FROM att_staff; DELETE FROM att_period_review; DELETE FROM app_notices;
            DELETE FROM audit_log; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')`,
  ).run();

  const review = (from, to, days, by) => raw.prepare(
    `INSERT INTO att_period_review
       (staff_id, kind, from_day, to_day, scheduled_days, worked_days, difference,
        decision, days_applied, decided_by, decided_at)
     VALUES (1, 'month', ?, ?, 22, 23, 1, 'approved', ?, ?, '2026-04-02 09:00:00')`,
  ).run(from, to, days, by);

  return { raw, db: d1(raw), review };
}

const SIGNER = {
  user: { id: 3, name: 'Ama', role: 'manager' },
  permissions: ['att_signoff', 'att_reports', 'att_manage'],
};
const READER = { user: { id: 4, name: 'Yaw', role: 'viewer' }, permissions: ['att_reports'] };

const ctx = (db, session, { body = null, query = '' } = {}) => ({
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

test('it itemises the leave year, and the parts add up to the figure', async () => {
  const { db, review } = setup();
  review('2026-01-01', '2026-01-31', -2, 'Ama (manager)');
  review('2026-02-01', '2026-02-28', 0, 'Ama (manager)');
  review('2026-03-01', '2026-03-31', 3, 'Yaa (planner)');
  // Last year, which must not count towards this one.
  review('2025-11-01', '2025-11-30', 5, 'Ama (manager)');

  const out = await (await leaveAdjustments(
    ctx(db, SIGNER, { query: '?asOf=2026-06-15' }), 1,
  )).json();

  assert.equal(out.year.label, '2026');
  assert.equal(out.periods.length, 3, 'a month that moved nothing is part of the answer');
  assert.equal(out.adjusted, 1, '-2 and 0 and +3');
  assert.equal(out.canChange, true);
});

test('somebody who reads balances cannot change one', async () => {
  const { db, review } = setup();
  review('2026-01-01', '2026-01-31', -2, 'Ama (manager)');

  const out = await (await leaveAdjustments(
    ctx(db, READER, { query: '?asOf=2026-06-15' }), 1,
  )).json();
  assert.equal(out.canChange, false);
});

test('changing one moves the figure and keeps the days signed', async () => {
  const { db, raw, review } = setup();
  review('2026-01-01', '2026-01-31', -4, 'Ama (manager)');
  const id = raw.prepare('SELECT id FROM att_period_review').get().id;

  const out = await (await changeDaysApplied(ctx(db, SIGNER, {
    body: { daysApplied: -1, note: 'Meant minus one.' },
  }), id)).json();

  assert.equal(out.changed, true);
  assert.equal(out.was, -4);
  assert.equal(out.daysApplied, -1);

  const row = raw.prepare('SELECT * FROM att_period_review WHERE id = ?').get(id);
  assert.equal(row.days_applied, -1);
  assert.equal(row.from_day, '2026-01-01', 'the days it signed are untouched');
  assert.equal(row.to_day, '2026-01-31');
  assert.equal(row.decision, 'approved');
  assert.match(row.note, /Meant minus one/);
  assert.match(row.decided_by, /Ama/);

  // The old figure is on the record, because a balance that moved with no
  // account of what moved it is the thing this screen exists to prevent.
  const line = raw.prepare(
    "SELECT * FROM audit_log WHERE action = 'attendance.days_applied'",
  ).get();
  assert.match(line.detail, /"was":-4/);
  assert.match(line.detail, /"now":-1/);
});

test('a figure that is not a whole number of days is refused', async () => {
  const { db, raw, review } = setup();
  review('2026-01-01', '2026-01-31', -4, 'Ama (manager)');
  const id = raw.prepare('SELECT id FROM att_period_review').get().id;

  await assert.rejects(
    () => changeDaysApplied(ctx(db, SIGNER, { body: { daysApplied: 1.5 } }), id),
    /whole number/,
  );
  await assert.rejects(
    () => changeDaysApplied(ctx(db, SIGNER, { body: { daysApplied: 900 } }), id),
    /between -60 and 60/,
  );
  assert.equal(raw.prepare('SELECT days_applied FROM att_period_review WHERE id = ?').get(id).days_applied, -4);
});

test('changing it to what it already was does nothing and says so', async () => {
  const { db, raw, review } = setup();
  review('2026-01-01', '2026-01-31', -4, 'Ama (manager)');
  const id = raw.prepare('SELECT id FROM att_period_review').get().id;

  const out = await (await changeDaysApplied(ctx(db, SIGNER, {
    body: { daysApplied: -4 },
  }), id)).json();
  assert.equal(out.changed, false);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'attendance.days_applied'").get().n, 0);
});
