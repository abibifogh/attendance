import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { loadDataset, makeDataset, onClock } from '../src/lib/attendance.js';
import { createStaff, listStaff, updateStaff } from '../src/routes/attendance-setup.js';
import { day as attDay } from '../src/routes/attendance.js';

/**
 * A director is on the payroll and nowhere else.
 *
 * They never touch the terminal, so every day the app worked out for them came
 * back an absence: on Today every morning, on the sign-off list every week,
 * and in the year's report as somebody who has not worked a day. Off the clock
 * takes them out of all of it and leaves the payslip alone.
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
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0, 5, 5)`,
  ).run();
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['att_setup'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/staff${query}`),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

// ---------------------------------------------------------------------------
// The flag itself
// ---------------------------------------------------------------------------

test('everybody is on the clock until somebody says otherwise', () => {
  assert.equal(onClock({ name: 'Kofi' }), true);
  assert.equal(onClock({ on_clock: 1 }), true);
  assert.equal(onClock({ on_clock: 0 }), false);
});

test('the dataset leaves them out, but can still say who they are', () => {
  const ds = makeDataset({
    staff: [
      { id: 1, employee_no: '1', name: 'Kofi', active: 1, on_clock: 1, on_rota: 1 },
      { id: 2, employee_no: '2', name: 'The director', active: 1, on_clock: 0, on_rota: 0 },
    ],
  });

  assert.deepEqual(ds.staff.map((s) => s.name), ['Kofi'], 'attendance is about Kofi');
  assert.equal(ds.staffById.get(2)?.name, 'The director',
    'an old record of theirs still has to be able to say whose it is');
  assert.equal(ds.staffByEmployeeNo.get('2'), undefined,
    'and their invented number cannot claim a punch');
});

// ---------------------------------------------------------------------------
// Adding one
// ---------------------------------------------------------------------------

test('adding somebody for the payroll takes them off the rota too', async () => {
  const { raw, db } = setup();
  await createStaff(ctx(db, {
    body: {
      name: 'The director', employeeNo: 'D1', department: 'Office',
      onClock: false, onRota: true,
    },
  }));

  const row = raw.prepare("SELECT * FROM att_staff WHERE name = 'The director'").get();
  assert.equal(row.on_clock, 0);
  assert.equal(row.on_rota, 0, 'a rota means nothing for somebody who is only paid');
});

test('an invented staff number does not swallow somebody else’s punches', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_punches
       (device_serial, employee_no, at_utc, at_local, day, direction, source, dedupe_key)
     VALUES ('T1', 'D1', '2026-06-02T06:00:00Z', '2026-06-02 06:00', '2026-06-02', 'in', 'device', 'k1')`,
  ).run();

  const out = await (await createStaff(ctx(db, {
    body: { name: 'The director', employeeNo: 'D1', onClock: false },
  }))).json();

  assert.equal(out.claimedPunches, 0);
  assert.equal(
    raw.prepare('SELECT staff_id FROM att_punches').get().staff_id, null,
    'the punch still belongs to whoever really holds that card',
  );
});

test('the ordinary way round still claims them', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_punches
       (device_serial, employee_no, at_utc, at_local, day, direction, source, dedupe_key)
     VALUES ('T1', '7', '2026-06-02T06:00:00Z', '2026-06-02 06:00', '2026-06-02', 'in', 'device', 'k1')`,
  ).run();

  const out = await (await createStaff(ctx(db, {
    body: { name: 'Kofi', employeeNo: '7' },
  }))).json();
  assert.equal(out.claimedPunches, 1);
});

// ---------------------------------------------------------------------------
// Switching somebody over
// ---------------------------------------------------------------------------

test('taking somebody off the clock clears the rota ahead of them', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Ama', 'Office', '2020-01-01')`,
  ).run();
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  raw.prepare(
    "INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)",
  ).run(soon);

  const out = await (await updateStaff(ctx(db, {
    body: { name: 'Ama', employeeNo: '1', onClock: false },
  }), 1)).json();

  assert.equal(out.clearedFromRota, 1);
  assert.equal(out.offClock, true);
  assert.equal(raw.prepare('SELECT on_clock, on_rota FROM att_staff WHERE id = 1').get().on_clock, 0);
});

test('what was already worked out is kept, not deleted', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Ama', '2020-01-01')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_days (staff_id, day, status, worked_minutes, punches)
     VALUES (1, '2026-03-02', 'present', 480, 2)`,
  ).run();

  await updateStaff(ctx(db, { body: { name: 'Ama', employeeNo: '1', onClock: false } }), 1);

  assert.equal(
    raw.prepare('SELECT COUNT(*) n FROM att_days WHERE staff_id = 1').get().n, 1,
    'putting them back on the clock should give them their March back',
  );
});

test('putting them back on the clock is one change, not a rebuild', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on, on_clock, on_rota)
     VALUES (1, '1', 'Ama', '2020-01-01', 0, 0)`,
  ).run();

  await updateStaff(ctx(db, {
    body: { name: 'Ama', employeeNo: '1', onClock: true, onRota: true },
  }), 1);

  const row = raw.prepare('SELECT on_clock, on_rota FROM att_staff WHERE id = 1').get();
  assert.equal(row.on_clock, 1);
  assert.equal(row.on_rota, 1);
});

// ---------------------------------------------------------------------------
// What the screens do
// ---------------------------------------------------------------------------

test('they never appear on Today, however absent they look', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, on_clock, on_rota)
     VALUES (2, 'D1', 'The director', 'Office', '2020-01-01', 0, 0)`,
  ).run();

  const today = new Date().toISOString().slice(0, 10);
  const out = await (await attDay({
    ...ctx(db, { query: `?day=${today}` }),
    session: { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['att_view'] },
  })).json();

  const names = (out.rows ?? []).map((r) => r.staff?.name ?? r.name);
  assert.ok(names.includes('Kofi'));
  assert.ok(!names.includes('The director'), 'nobody is expecting them at the terminal');
});

test('the setup list still shows them, marked for what they are', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on, on_clock, on_rota)
     VALUES (1, 'D1', 'The director', '2020-01-01', 0, 0)`,
  ).run();

  const out = await (await listStaff(ctx(db))).json();
  assert.equal(out.staff.length, 1);
  assert.equal(out.staff[0].on_clock, 0, 'the screen has to be able to say so');
});

test('the payroll does not care about the clock', async () => {
  const { raw } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on, on_clock, on_rota)
     VALUES (1, 'D1', 'The director', '2020-01-01', 0, 0)`,
  ).run();
  raw.prepare('INSERT INTO pay_profile (staff_id, basic) VALUES (1, 6000)').run();

  // Read the way payroll reads it: straight from the table, not the dataset.
  const rows = raw.prepare(
    'SELECT s.name, p.basic FROM att_staff s JOIN pay_profile p ON p.staff_id = s.id',
  ).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'The director');
  assert.equal(rows[0].basic, 6000);
});

test('a dataset loaded from the database leaves them out as well', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on, on_clock, on_rota)
     VALUES (2, 'D1', 'The director', '2020-01-01', 0, 0)`,
  ).run();

  const ds = await loadDataset(db, { from: '2026-06-01', to: '2026-06-07' });
  assert.deepEqual(ds.staff.map((s) => s.name), ['Kofi']);
});
