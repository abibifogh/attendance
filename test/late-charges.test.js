import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  clockInBy, lateRule, monthName, syncLateCharges, watchLateCharges,
} from '../src/lib/late-charges.js';
import { computeLine, fitLate } from '../src/lib/payroll.js';
import { ratesFrom } from '../src/lib/tax.js';
import { deductionRows, lateDays } from '../src/lib/payslip-pdf.js';
import { addDays, monthOf } from '../src/util/dates.js';

/**
 * Late charges: GHS 20 for clocking in 15 minutes or more after a shift
 * starts, unless an administrator waives it. Made-up people only.
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

const TODAY = new Date().toISOString().slice(0, 10);
const DAY = addDays(TODAY, -3);
const EARLIER = addDays(TODAY, -4);

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster; DELETE FROM att_patterns;
            DELETE FROM att_shifts; DELETE FROM att_staff; DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  // The rule began a week ago, for these tests.
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'late_charge_from'").run(addDays(TODAY, -7));
  raw.exec(`INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
              VALUES (1, 'Morning', '06:00', '14:00', 0, 5)`);
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES
              (1, 'T1', 'Kwame Asare', 'Front office', '2024-01-01'),
              (2, 'T2', 'Akosua Darko', 'Front office', '2024-01-01'),
              (3, 'T3', 'Kojo Antwi', 'F&B', '2024-01-01')`);
  for (const id of [1, 2, 3]) {
    for (const day of [DAY, EARLIER]) {
      raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, 1, 1)').run(id, day);
    }
  }
  return { raw, db: d1(raw) };
}

let serial = 0;
function punch(raw, staffId, day, clock, direction = 'in') {
  serial += 1;
  raw.prepare(
    `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, direction, dedupe_key, source)
     VALUES ('DEV1', ?, ?, ?, ?, ?, ?, ?, 'import')`,
  ).run(`T${staffId}`, staffId, `${day} ${clock}:00`, `${day} ${clock}:00`, day, direction, `k${serial}`);
}

const charges = (raw) => raw.prepare('SELECT * FROM late_charge ORDER BY staff_id, day').all();

test('the rule reads from settings, and says the last minute that is not a charge', () => {
  const rule = lateRule({ late_charge_on: '1', late_charge_amount: '20', late_charge_minutes: '15', late_charge_from: '2026-11-02' });
  assert.deepEqual([rule.on, rule.amount, rule.minutes, rule.from, rule.currency], [true, 20, 15, '2026-11-02', 'GHS']);
  assert.equal(clockInBy('06:00', 15), '06:14');
  assert.equal(clockInBy('23:50', 15), '00:04');
  assert.equal(monthName('2026-11'), 'November');
});

test('the migration switches it on at GHS 20 and 15 minutes from 2 November 2026', () => {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  const map = Object.fromEntries(raw.prepare("SELECT key, value FROM settings WHERE key LIKE 'late_charge_%'").all().map((r) => [r.key, r.value]));
  assert.deepEqual(map, {
    late_charge_on: '1', late_charge_amount: '20', late_charge_minutes: '15', late_charge_from: '2026-11-02', late_charge_notify: '1',
  });
});

test('15 minutes or more late is charged once; 14 is not; exempt people are not', async () => {
  const { raw, db } = setup();
  raw.exec('UPDATE att_staff SET late_charge_exempt = 1 WHERE id = 3');
  punch(raw, 1, DAY, '06:22');
  punch(raw, 1, DAY, '14:01', 'out');
  punch(raw, 2, DAY, '06:14');
  punch(raw, 2, DAY, '14:00', 'out');
  punch(raw, 3, DAY, '06:40');
  punch(raw, 3, DAY, '14:00', 'out');

  const out = await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  assert.equal(out.created, 1);
  const [c] = charges(raw);
  assert.deepEqual(
    [c.staff_id, c.day, c.minutes_late, c.clock_in, c.amount, c.currency, c.status, c.month, c.shift_name],
    [1, DAY, 22, '06:22', 20, 'GHS', 'open', monthOf(DAY), 'Morning'],
  );
  const again = await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  assert.equal(again.created, 0, 'once per shift');
});

test('exactly the minute counts', async () => {
  const { raw, db } = setup();
  punch(raw, 2, DAY, '06:15');
  punch(raw, 2, DAY, '14:00', 'out');
  await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  assert.equal(charges(raw).length, 1);
});

test('before the rule began, and on a shift nobody published, nothing is charged', async () => {
  const { raw, db } = setup();
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'late_charge_from'").run(DAY);
  punch(raw, 1, EARLIER, '06:30');
  raw.prepare('UPDATE att_roster SET published = 0 WHERE staff_id = 2 AND day = ?').run(DAY);
  punch(raw, 2, DAY, '06:30');
  await syncLateCharges(db, { timezone: 'UTC', days: [EARLIER, DAY] });
  assert.equal(charges(raw).length, 0);
});

test('a clock-in corrected to on time takes it away, and back if corrected again', async () => {
  const { raw, db } = setup();
  punch(raw, 1, DAY, '06:22');
  punch(raw, 1, DAY, '14:01', 'out');
  await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  raw.prepare(
    "INSERT INTO att_days (staff_id, day, status, resolution, corrected_in) VALUES (1, ?, 'present', 'resolved', '06:00')",
  ).run(DAY);
  const off = await syncLateCharges(db, { timezone: 'UTC', days: [] });
  assert.equal(off.voided, 1);
  assert.equal(charges(raw)[0].status, 'void');
  raw.prepare("UPDATE att_days SET corrected_in = '06:31' WHERE staff_id = 1 AND day = ?").run(DAY);
  const back = await syncLateCharges(db, { timezone: 'UTC', days: [] });
  assert.equal(back.reopened, 1);
  assert.deepEqual([charges(raw)[0].status, charges(raw)[0].minutes_late], ['open', 31]);
});

test('an excused day takes it away; a day ruled late keeps it; a waived one stays waived', async () => {
  const { raw, db } = setup();
  punch(raw, 1, DAY, '06:22');
  punch(raw, 1, DAY, '14:01', 'out');
  punch(raw, 2, DAY, '06:40');
  punch(raw, 2, DAY, '14:01', 'out');
  await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  raw.prepare("INSERT INTO att_days (staff_id, day, status, resolution, reason_code) VALUES (1, ?, 'present', 'resolved', 'present')").run(DAY);
  raw.prepare("INSERT INTO att_days (staff_id, day, status, resolution, reason_code) VALUES (2, ?, 'late', 'resolved', 'late')").run(DAY);
  await syncLateCharges(db, { timezone: 'UTC', days: [] });
  const [k, a] = charges(raw);
  assert.equal(k.status, 'void', 'excused');
  assert.equal(a.status, 'open', 'ruled late, still charged');

  raw.prepare("UPDATE late_charge SET status = 'waived' WHERE staff_id = 2").run();
  raw.prepare('DELETE FROM att_days WHERE staff_id = 1').run();
  await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  assert.deepEqual(charges(raw).map((c) => c.status), ['open', 'waived']);
});

test('a closed payroll month sends a new charge to the next open one', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO pay_run (month, status) VALUES (?, 'final')").run(monthOf(DAY));
  punch(raw, 1, DAY, '06:22');
  punch(raw, 1, DAY, '14:01', 'out');
  await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  const [y, m] = monthOf(DAY).split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  assert.equal(charges(raw)[0].month, next);
});

test('switched off, nothing is charged', async () => {
  const { raw, db } = setup();
  raw.exec("UPDATE settings SET value = '0' WHERE key = 'late_charge_on'");
  punch(raw, 1, DAY, '06:40');
  const out = await syncLateCharges(db, { timezone: 'UTC', days: [DAY] });
  assert.equal(out.created, 0);
});

test('the watcher stays quiet for anybody off shift or with no login', async () => {
  const { db } = setup();
  const out = await watchLateCharges(db, { timezone: 'UTC' });
  assert.deepEqual([out.warned, out.charged], [0, 0]);
});

test('payroll takes whole charges, oldest first, and never below nothing', () => {
  const three = [
    { chargeId: 3, day: '2026-11-08', amount: 20 },
    { chargeId: 1, day: '2026-11-02', amount: 20 },
    { chargeId: 2, day: '2026-11-05', amount: 20 },
  ];
  const fit = fitLate(three, 45);
  assert.deepEqual(fit.taken.map((c) => c.chargeId), [1, 2]);
  assert.deepEqual(fit.waiting.map((c) => c.chargeId), [3]);
  assert.equal(fit.total, 40);
  assert.equal(fitLate(three, -5).total, 0);
});

test('a payslip line carries the charges, off net pay, after tax', () => {
  const base = { basic: 1800, ssnit: true, allowances: [], schemes: [], penalties: [], loans: [], rates: ratesFrom({}) };
  const plain = computeLine(base);
  const late = computeLine({ ...base, lateCharges: [{ chargeId: 1, day: '2026-11-03', amount: 20 }, { chargeId: 2, day: '2026-11-09', amount: 20 }] });
  assert.equal(late.lateCharge, 40);
  assert.equal(late.paye.total, plain.paye.total, 'not before tax');
  assert.equal(Math.round((plain.net - late.net) * 100) / 100, 40);
  assert.equal(late.lateCharges.length, 2);
  const { rows, took } = deductionRows(late, (n) => `GHS ${n}`, late.rates);
  const row = rows.find((r) => String(r[0]).startsWith('Late arrivals'));
  assert.deepEqual(row, ['Late arrivals (2)', 'GHS 40', '3 and 9 Nov']);
  assert.ok(Math.abs(took - (late.ssnit.employee + late.paye.total + 40)) < 0.01);
  assert.equal(lateDays([{ day: '2026-11-02' }, { day: '2026-11-06' }, { day: '2026-11-08' }]), '2, 6 and 8 Nov');
});
