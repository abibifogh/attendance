import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { payroll, setProfiles } from '../src/routes/payroll.js';
import { payeOn } from '../src/lib/tax.js';

/**
 * The PAYE bands from September 2026, under the Income Tax (Amendment) Act,
 * 2026 (Act 1178): first 588 nil, then 80 at 5%, 100 at 10%, 2,900 at 17.5%,
 * 16,000 at 25%, 30,332 at 30%, and 35% above 50,000.
 *
 * August is paid on the old bands and September on the new, whichever month
 * the payroll is opened in.
 */

const MIGRATION = '0116_the_september_2026_bands.sql';
const NEW = [
  { width: 588, rate: 0 }, { width: 80, rate: 0.05 }, { width: 100, rate: 0.1 },
  { width: 2900, rate: 0.175 }, { width: 16000, rate: 0.25 }, { width: 30332, rate: 0.3 },
  { width: null, rate: 0.35 },
];

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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

/** Everything up to the one before, some setup of the property's own, then the rest. */
function setup(before = () => {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const files = readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort();
  for (const f of files.filter((n) => n < MIGRATION)) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  before(raw);
  for (const f of files.filter((n) => n >= MIGRATION)) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(`INSERT INTO att_staff (id, employee_no, name, department, hired_on)
    VALUES (1, 'E1', 'Kofi Mensah', 'Kitchen', '2020-01-01')`).run();
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }),
});
const month = async (db, m) => (await payroll(ctx(db, { query: `?month=${m}` }))).json();

test('the new bands, worked through', () => {
  assert.equal(payeOn(3000, NEW).tax, 404.6, '4 + 10 + 2,232 at 17.5%');
  assert.equal(payeOn(700, NEW).tax, 7.2);
  assert.equal(payeOn(588, NEW).tax, 0, 'the first 588 is free');
  assert.equal(payeOn(60000, NEW).tax, 17121.1);
  assert.equal(NEW.slice(0, -1).reduce((n, b) => n + b.width, 0), 50000, 'the bands reach 50,000');
});

test('August is taxed on the old bands and September on the new', async () => {
  const { db } = setup();
  // No SSNIT, so the chargeable income is the basic itself.
  await setProfiles(ctx(db, { body: { rows: [{ staffId: 1, basic: 3000, ssnit: false, allowances: [] }] } }));

  const august = await month(db, '2026-08');
  const september = await month(db, '2026-09');
  const october = await month(db, '2026-10');
  assert.equal(august.lines[0].paye.total, 415.75, 'the bands August was worked on');
  assert.equal(september.lines[0].paye.total, 404.6);
  assert.equal(october.lines[0].paye.total, 404.6, 'and every month after');
});

test('the live figures show the bands in force', async () => {
  const { raw } = setup();
  const live = Object.fromEntries(raw.prepare(
    "SELECT key, value FROM settings WHERE key IN ('pay_bands', 'pay_bands_label')",
  ).all().map((r) => [r.key, r.value]));
  assert.deepEqual(JSON.parse(live.pay_bands), NEW);
  assert.match(live.pay_bands_label, /September 2026/);
});

test('figures the property set itself carry on into September, only the bands change', async () => {
  const { raw } = setup((db) => {
    db.exec(`INSERT INTO settings (key, value) VALUES ('pay_ssnit_employer', '0.14')
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  });
  const rows = raw.prepare('SELECT from_month, ssnit_employer, bands FROM pay_rates ORDER BY from_month').all();
  assert.deepEqual(rows.map((r) => r.from_month), ['0000-01', '2026-09']);
  assert.equal(rows[0].ssnit_employer, 0.14, 'what it was using is kept for every earlier month');
  assert.equal(rows[1].ssnit_employer, 0.14, 'and carries on');
  assert.equal(JSON.parse(rows[0].bands)[0].width, 490);
  assert.equal(JSON.parse(rows[1].bands)[0].width, 588);
});

test('a property that already dated a table keeps it, and the new one goes on after it', async () => {
  const { raw } = setup((db) => {
    db.exec(`INSERT INTO pay_rates (from_month, label, bands, ssnit_employee, ssnit_employer, tier1, tier2, bonus_rate, bonus_share)
      VALUES ('0000-01', 'Old', '[{"width":null,"rate":0.1}]', 0.055, 0.13, 0.135, 0.05, 0.05, 0.15),
             ('2026-01', 'January', '[{"width":490,"rate":0},{"width":null,"rate":0.2}]', 0.06, 0.13, 0.135, 0.05, 0.05, 0.15)`);
  });
  const rows = raw.prepare('SELECT from_month, label, ssnit_employee FROM pay_rates ORDER BY from_month').all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { from_month: '0000-01', label: 'Old', ssnit_employee: 0.055 },
    { from_month: '2026-01', label: 'January', ssnit_employee: 0.06 },
    { from_month: '2026-09', label: 'GRA monthly bands, from September 2026 (Act 1178)', ssnit_employee: 0.06 },
  ], 'nothing is captured twice, and September carries on from January');
});
