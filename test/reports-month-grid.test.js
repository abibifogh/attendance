import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { overview, week } from '../src/routes/attendance.js';

/**
 * What the redesigned Reports page reads off the month and the week: a slim
 * record per day for the squares, and the hours a person was due over the
 * month, worked out from the same hours a week the rota uses.
 */

function d1(db) {
  const statement = (sql, binds = []) => ({
    sql,
    binds,
    bind(...args) { return statement(sql, args); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

const MANAGER = {
  user: { id: 1, name: 'Test Manager', role: 'manager' },
  permissions: ['att_view', 'att_reports', 'att_manage'],
};
const PLANNER = {
  user: { id: 2, name: 'Test Planner', role: 'planner' },
  permissions: ['att_view', 'att_rota'],
};

function ctx(db, query, session = MANAGER) {
  const url = new URL(`https://example.test/api/att/x${query}`);
  return { db, env: {}, url, session, executionContext: null, request: new Request(url) };
}

/** Two made-up people on a Monday-to-Friday morning shift. */
function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec('DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster; DELETE FROM att_leave;');
  raw.exec('DELETE FROM att_shifts; DELETE FROM att_staff;');
  raw.exec(`INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes)
            VALUES (1, 'Morning', '06:00', '14:00', 0, 5, 5)`);
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on, weekly_hours, days_per_week)
            VALUES (1, 'T1', 'Tester Onefold', 'Kitchen', '2024-01-01', 40, NULL),
                   (2, 'T2', 'Tester Twofold', 'Kitchen', '2024-01-01', NULL, 4)`);
  for (const staffId of [1, 2]) {
    for (const dow of [0, 1, 2, 3, 4]) {
      raw.prepare('INSERT INTO att_patterns (staff_id, dow, shift_id) VALUES (?, ?, 1)').run(staffId, dow);
    }
  }
  const punch = raw.prepare(`INSERT INTO att_punches
    (device_serial, employee_no, staff_id, at_utc, at_local, day, direction, dedupe_key)
    VALUES ('T', ?, ?, ?, ?, ?, ?, ?)`);
  const clock = (staffId, day, time, direction) => {
    const at = `${day} ${time}:00`;
    punch.run(`T${staffId}`, staffId, at, at, day, direction, `${staffId}-${at}`);
  };
  // Monday on time, Tuesday twenty minutes late, Wednesday nothing at all.
  clock(1, '2026-03-02', '05:58', 'in'); clock(1, '2026-03-02', '14:01', 'out');
  clock(1, '2026-03-03', '06:20', 'in'); clock(1, '2026-03-03', '14:00', 'out');
  raw.exec(`INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
            VALUES (1, 'annual_leave', '2026-03-09', '2026-03-10', 2, 'approved')`);
  return d1(raw);
}

test('the month sends a slim day for every square, coloured on the server', async () => {
  const db = setup();
  const data = await (await overview(ctx(db, '?month=2026-03'))).json();
  const row = data.rows.find((r) => r.staff.id === 1);

  assert.equal(row.days.length, 31, 'a day for every date in March');
  const on = (day) => row.days.find((d) => d.day === day);
  assert.equal(on('2026-03-02').status, 'present');
  assert.equal(on('2026-03-02').colour, 'green');
  assert.equal(on('2026-03-03').status, 'late');
  assert.ok(on('2026-03-03').late_minutes >= 20);
  assert.equal(on('2026-03-04').status, 'absent');
  assert.equal(on('2026-03-04').colour, 'red');
  assert.equal(on('2026-03-07').status, 'rest');
  assert.equal(on('2026-03-09').status, 'leave');
  assert.equal(typeof on('2026-03-02').label, 'string');
  assert.equal(on('2026-03-02').scheduled, 1);
  assert.ok(on('2026-03-02').worked_minutes > 400);
  assert.equal(on('2026-03-02').note, undefined, 'only what colours a square, not the whole record');
});

test('hours against their month come from their hours a week, less leave', async () => {
  const db = setup();
  const data = await (await overview(ctx(db, '?month=2026-03'))).json();
  const one = data.rows.find((r) => r.staff.id === 1);
  const two = data.rows.find((r) => r.staff.id === 2);

  assert.equal(one.staff.weeklyHours, 40, 'their own figure where one is set');
  assert.equal(two.staff.weeklyHours, 32, 'otherwise their days a week at eight hours');
  // 40 hours a week over 31 days, less two eight-hour days of annual leave.
  assert.equal(one.targetMinutes, Math.round(((40 * 31) / 7 - 16) * 60));
  assert.equal(two.targetMinutes, Math.round(((32 * 31) / 7) * 60));
});

test('a planner gets the squares and the hours, and still no balance', async () => {
  const db = setup();
  const data = await (await overview(ctx(db, '?month=2026-03', PLANNER))).json();
  assert.equal(data.rows[0].days.length, 31);
  assert.ok(Number.isFinite(data.rows[0].targetMinutes));
  assert.equal(data.rows[0].leave, null);
  assert.ok(!JSON.stringify(data).includes('remaining'));
});

test('the week sends each person\'s hours a week too', async () => {
  const db = setup();
  const data = await (await week(ctx(db, '?from=2026-03-02'))).json();
  assert.equal(data.rows.find((r) => r.staff.id === 1).staff.weeklyHours, 40);
  assert.equal(data.rows.find((r) => r.staff.id === 2).staff.weeklyHours, 32);
});
