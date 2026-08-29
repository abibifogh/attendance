import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { closeRun, movement, payroll, setProfiles } from '../src/routes/payroll.js';

/**
 * Each net beside what it was in another month.
 *
 * A column of net figures says what everybody is being paid and nothing about
 * which of them is worth a second look. Somebody's net moves for a dozen
 * reasons, and a per cent against last month is what finds the lines to check
 * before the month is closed.
 */

test('a rise and a fall, as a per cent', () => {
  assert.deepEqual(movement(1100, 1000), { was: 1000, change: 100, percent: 10, from: null });
  assert.deepEqual(movement(900, 1000), { was: 1000, change: -100, percent: -10, from: null });
  assert.deepEqual(movement(1000, 1000), { was: 1000, change: 0, percent: 0, from: null });
});

test('no figure to compare against is not a movement', () => {
  assert.equal(movement(1000, null), null);
  assert.equal(movement(1000, undefined), null);
});

test('somebody who was paid nothing is new, not an infinite rise', () => {
  const out = movement(1000, 0);
  assert.equal(out.percent, null, 'a number nobody can act on is not shown as one');
  assert.equal(out.from, 'nothing');
  assert.equal(out.change, 1000);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

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
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_run;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')",
  ).run();
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const pay = (db, basic) => setProfiles(ctx(db, {
  body: { rows: [{ staffId: 1, basic, ssnit: true }] },
}));

test('this month is read against the one before it', async () => {
  const { db } = setup();
  await pay(db, 2000);
  await closeRun(ctx(db, { body: { month: '2026-05' } }));

  await pay(db, 2200);
  const june = await (await payroll(ctx(db, { query: '?month=2026-06' }))).json();

  assert.equal(june.compare.month, '2026-05');
  assert.equal(june.compare.status, 'final');
  const [line] = june.lines;
  assert.ok(line.against, 'the line carries the movement');
  assert.ok(line.against.percent > 0, 'a rise');
  assert.ok(Math.abs(line.against.was - 2000) < 400, 'against what May actually paid');
});

test('a month with nothing behind it has nothing to compare', async () => {
  const { db } = setup();
  await pay(db, 2000);
  const june = await (await payroll(ctx(db, { query: '?month=2026-06' }))).json();
  assert.equal(june.lines[0].against, null);
  assert.equal(june.compare.people, 0);
});

test('reading a month against another does not open a run for it', async () => {
  const { raw, db } = setup();
  await pay(db, 2000);
  await payroll(ctx(db, { query: '?month=2026-06' }));

  const months = raw.prepare('SELECT month FROM pay_run ORDER BY month').all().map((r) => r.month);
  assert.deepEqual(months, ['2026-06'],
    'looking at June must not put a draft May on the books');
});

test('admin can ask for a different month', async () => {
  const { db } = setup();
  await pay(db, 1000);
  await closeRun(ctx(db, { body: { month: '2026-01' } }));
  await pay(db, 2000);
  await closeRun(ctx(db, { body: { month: '2026-05' } }));
  await pay(db, 2000);

  const against = await (await payroll(
    ctx(db, { query: '?month=2026-06&compare=2026-01' }),
  )).json();

  assert.equal(against.compare.month, '2026-01');
  assert.ok(against.lines[0].against.percent > 50, 'January was half the salary');
});

test('a month asked for that nobody has run is simply empty', async () => {
  const { db } = setup();
  await pay(db, 2000);
  const out = await (await payroll(
    ctx(db, { query: '?month=2026-06&compare=2024-02' }),
  )).json();

  assert.equal(out.compare.month, '2024-02');
  assert.equal(out.compare.status, 'none');
  assert.equal(out.lines[0].against, null);
});

test('comparing a month with itself is refused rather than reading zero', async () => {
  const { db } = setup();
  await pay(db, 2000);
  const out = await (await payroll(
    ctx(db, { query: '?month=2026-06&compare=2026-06' }),
  )).json();
  assert.equal(out.lines[0].against, null);
});

test('nonsense for a month falls back to the one before', async () => {
  const { db } = setup();
  await pay(db, 2000);
  const out = await (await payroll(
    ctx(db, { query: '?month=2026-06&compare=last%20year' }),
  )).json();
  assert.equal(out.compare.month, '2026-05');
});

test('a closed month is compared on what was written down, not on today', async () => {
  const { raw, db } = setup();
  await pay(db, 2000);
  await closeRun(ctx(db, { body: { month: '2026-05' } }));
  const wasPaid = raw.prepare('SELECT net FROM pay_slip').get().net;

  // The salary changes afterwards. May's payslip does not.
  await pay(db, 5000);
  const june = await (await payroll(ctx(db, { query: '?month=2026-06' }))).json();
  assert.equal(june.lines[0].against.was, Math.round(wasPaid * 100) / 100);
});

test('somebody who was not on the payroll last month reads as new', async () => {
  const { raw, db } = setup();
  await pay(db, 2000);
  await closeRun(ctx(db, { body: { month: '2026-05' } }));

  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (2, '2', 'Ama', '2026-06-01')",
  ).run();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }, { staffId: 2, basic: 1500, ssnit: true }] },
  }));

  const june = await (await payroll(ctx(db, { query: '?month=2026-06' }))).json();
  const ama = june.lines.find((l) => l.staff.name === 'Ama');
  assert.equal(ama.against, null, 'nothing to read her against, rather than a rise from nought');
});
