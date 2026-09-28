import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { closeRun, payroll, setProfiles } from '../src/routes/payroll.js';

/**
 * The standing allowances cleared once everybody had a take-home.
 *
 * The one thing the clearing must not do is move July 2026, which was paid
 * with those allowances in it. A closed month reads its own payslips and so
 * stands whatever happens to them; an open one would be rewritten, so the
 * clearing waits for it.
 */

const CLEAR = 'migrations/0114_allowances_cleared_for_the_take_home.sql';

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
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, 'E1', 'Linda Attipoe', 'Housekeeping', '2020-01-01'),
            (2, 'E2', 'Bernard Owusu', 'Maintenance', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const WAGES = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session: WAGES,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const JULY = '2026-07';
const month = async (db, m) => (await payroll(ctx(db, { query: `?month=${m}` }))).json();

async function onTheBooks(db) {
  await setProfiles(ctx(db, {
    body: {
      rows: [
        { staffId: 1, basic: 800, ssnit: true, allowances: [{ name: 'Allowance', amount: 1437.64, taxable: true }] },
        { staffId: 2, basic: 600, ssnit: true, allowances: [{ name: 'Allowance', amount: 379.7, taxable: true }] },
      ],
    },
  }));
}

test('with July closed, every allowance is cleared and July reads exactly as it did', async () => {
  const { raw, db } = setup();
  await onTheBooks(db);
  await closeRun(ctx(db, { body: { month: JULY } }));
  const before = await month(db, JULY);

  raw.exec(readFileSync(CLEAR, 'utf8'));

  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_allowance').get().n, 0, 'all cleared');
  const after = await month(db, JULY);
  assert.deepEqual(after.lines, before.lines, 'July is the payslips it was closed with');
  assert.deepEqual(after.totals, before.totals);
  assert.equal(before.lines.length, 2);
  assert.ok(before.lines.every((l) => l.allowances.length > 0), 'July was paid with them in');
  assert.ok(after.lines.every((l) => l.allowances.length > 0), 'and still shows them');

  // And August, which is open, is worked out without them.
  const august = await month(db, '2026-08');
  assert.ok(august.lines.every((l) => !l.allowances.some((a) => !a.workedOut)),
    'no standing allowance left on an open month');
});

test('every cleared allowance is kept, so any of them can be put back', async () => {
  const { raw, db } = setup();
  await onTheBooks(db);
  await closeRun(ctx(db, { body: { month: JULY } }));
  raw.exec(readFileSync(CLEAR, 'utf8'));

  const kept = raw.prepare('SELECT staff_id, name, amount, taxable FROM pay_allowance_cleared ORDER BY staff_id').all()
    .map((r) => ({ ...r }));
  assert.deepEqual(kept, [
    { staff_id: 1, name: 'Allowance', amount: 1437.64, taxable: 1 },
    { staff_id: 2, name: 'Allowance', amount: 379.7, taxable: 1 },
  ]);
});

test('with July still open, nothing is cleared, because that would rewrite it', async () => {
  const { raw, db } = setup();
  await onTheBooks(db);
  const before = await month(db, JULY);   // opens July as a draft
  assert.equal(raw.prepare("SELECT status FROM pay_run WHERE month = ?").get(JULY).status, 'draft');

  raw.exec(readFileSync(CLEAR, 'utf8'));

  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_allowance').get().n, 2, 'both left where they were');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_allowance_cleared').get().n, 0);
  assert.deepEqual((await month(db, JULY)).totals, before.totals);
});

test('with no July at all there is nothing to protect, and they are cleared', async () => {
  const { raw, db } = setup();
  await onTheBooks(db);
  raw.exec(readFileSync(CLEAR, 'utf8'));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_allowance').get().n, 0);
});
