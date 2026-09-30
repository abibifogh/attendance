import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { balances, requestLeave, setLeaveDays } from '../src/routes/attendance.js';
import { leaveBalance } from '../src/lib/attendance.js';

/**
 * Leave costs what it was recorded or approved at.
 *
 * Approved leave marks every day it spans as leave, rest days included, so a
 * planner can see the person is away on the Saturday. The balance used to
 * count those marked days once they had passed, so a week off charged at five
 * came to seven, and a weekend charged at nothing came to two. And the figure
 * on a leave, taken from the rota the day it went in, could not be put right
 * when the rota turned out not to be finished.
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
            DELETE FROM att_leave; DELETE FROM att_holidays; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0)`,
  ).run();
  // Kofi has no standing pattern at all. Ama works Monday to Friday.
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01'),
            (2, '2', 'Ama', 'Kitchen', '2020-01-01')`,
  ).run();
  for (const d of [0, 1, 2, 3, 4]) {
    raw.prepare('INSERT INTO att_patterns (staff_id, dow, shift_id) VALUES (2, ?, 1)').run(d);
  }
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 9, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const MANAGER = { user: { id: 3, name: 'Esi', role: 'manager' }, permissions: ['att_manage', 'att_rota', 'att_reports'] };

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/leave${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const read = async (r) => r.json();
const balanceOf = async (db, id, asOf) => (await read(await balances(ctx(db, MANAGER, { query: `?asOf=${asOf}` }))))
  .rows.find((r) => r.staff.id === id).balance;

test('a week off charged at five is five taken, not seven, once it is over', async () => {
  const { db } = setup();
  // Ama works Monday to Friday. Monday 14 to Sunday 20 September.
  const week = await read(await requestLeave(ctx(db, MANAGER, {
    body: { staffId: 2, reason: 'annual_leave', from: '2026-09-14', to: '2026-09-20' },
  })));
  assert.equal(week.days, 5);
  const after = await balanceOf(db, 2, '2026-09-30');
  assert.equal(after.taken, 5);
  assert.equal(after.remaining, 10);
});

test('a weekend of leave charged at nothing costs nothing, before and after', async () => {
  const { db } = setup();
  await requestLeave(ctx(db, MANAGER, {
    body: { staffId: 2, reason: 'annual_leave', from: '2026-09-05', to: '2026-09-06' },
  }));
  const before = await balanceOf(db, 2, '2026-09-01');
  const after = await balanceOf(db, 2, '2026-09-30');
  assert.equal(before.booked, 0);
  assert.equal(after.taken, 0);
  assert.equal(after.remaining, 15);
});

test('what is left does not move on the day the leave starts', async () => {
  const { db } = setup();
  await requestLeave(ctx(db, MANAGER, {
    body: { staffId: 2, reason: 'annual_leave', from: '2026-10-12', to: '2026-10-16' },
  }));
  const ahead = await balanceOf(db, 2, '2026-10-01');
  const during = await balanceOf(db, 2, '2026-10-14');
  const after = await balanceOf(db, 2, '2026-10-30');
  assert.deepEqual([ahead.booked, ahead.taken], [5, 0]);
  assert.deepEqual([during.booked, during.taken], [0, 5]);
  assert.equal(ahead.remaining, during.remaining);
  assert.equal(during.remaining, after.remaining);
});

test('a day ruled as leave outside any approved leave still counts, a day each', () => {
  const reasons = new Map([['annual_leave', { deducts_leave: 1 }]]);
  const b = leaveBalance({
    staff: { hired_on: '2020-01-01' },
    records: [{ day: '2026-03-02', reason_code: 'annual_leave' }, { day: '2026-04-10', reason_code: 'annual_leave' }],
    requests: [{ status: 'approved', reason_code: 'annual_leave', from_day: '2026-04-06', to_day: '2026-04-12', days: 5 }],
    settings: {},
    asOf: '2026-06-01',
    reasons,
  });
  assert.equal(b.taken, 6, 'five for the week, one for the March day; the April day is inside the week');
});

test('the office can set the days as it records the leave; a planner gets the rota\u2019s figure', async () => {
  const { db, raw } = setup();
  const set = await read(await requestLeave(ctx(db, MANAGER, {
    body: { staffId: 2, reason: 'annual_leave', from: '2026-10-10', to: '2026-10-11', daysCharged: 1 },
  })));
  assert.deepEqual([set.days, set.status], [1, 'approved']);

  const asked = await read(await requestLeave(ctx(db, PLANNER, {
    body: { staffId: 1, reason: 'annual_leave', from: '2026-10-10', to: '2026-10-11', daysCharged: 2 },
  })));
  assert.equal(asked.status, 'pending');
  assert.notEqual(raw.prepare('SELECT days FROM att_leave WHERE id = ?').get(asked.id).days, 2,
    'somebody who only asks does not set what it costs');

  await assert.rejects(requestLeave(ctx(db, MANAGER, {
    body: { staffId: 2, reason: 'annual_leave', from: '2026-11-02', to: '2026-11-03', daysCharged: 3 },
  })), /between 0 and 2/);
});

test('recorded leave can be corrected, with a reason, and the balance follows', async () => {
  const { db, raw } = setup();
  const leave = await read(await requestLeave(ctx(db, MANAGER, {
    body: { staffId: 2, reason: 'annual_leave', from: '2026-10-10', to: '2026-10-11' },
  })));
  assert.equal(leave.days, 0, 'the rota had the weekend as rest days');

  const fixed = await read(await setLeaveDays(ctx(db, MANAGER, { body: { days: 1, note: 'Working the Sunday' } }), leave.id));
  assert.deepEqual([fixed.days, fixed.was], [1, 0]);
  assert.equal(raw.prepare('SELECT days FROM att_leave WHERE id = ?').get(leave.id).days, 1);
  assert.equal((await balanceOf(db, 2, '2026-10-01')).booked, 1);
  assert.ok(raw.prepare("SELECT 1 FROM audit_log WHERE action = 'attendance.leave_days'").get());

  await assert.rejects(setLeaveDays(ctx(db, MANAGER, { body: { days: 1.3 } }), leave.id), /halves/);
  await assert.rejects(setLeaveDays(ctx(db, MANAGER, { body: { days: 3 } }), leave.id), /between 0 and 2/);
  raw.prepare("UPDATE att_leave SET status = 'rejected' WHERE id = ?").run(leave.id);
  await assert.rejects(setLeaveDays(ctx(db, MANAGER, { body: { days: 1 } }), leave.id), /not approved/);
});
