import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { EARLIEST, ratesOn, tableToRates } from '../src/lib/tax-tables.js';
import { computeLine } from '../src/lib/payroll.js';
import { journalFor } from '../src/lib/statutory.js';
import { BANDS, RATES } from '../src/lib/tax.js';
import { listTaxTables, removeTaxTable, saveTaxTable } from '../src/routes/attendance-setup.js';
import { closeRun, payroll, reopenRun, setProfiles } from '../src/routes/payroll.js';

/**
 * A tax table is a fact about a period, not about the property.
 *
 * The bands that applied in January are the January bands however many budgets
 * have happened since. A closed month was always safe — closing writes the
 * payslips out in full — but an open one, and one reopened in July to fix a
 * single allowance, used to come back retaxed at today's figures.
 */

const OLD = {
  from_month: EARLIEST,
  label: 'Old table',
  bands: JSON.stringify([{ width: 400, rate: 0 }, { width: null, rate: 0.2 }]),
  ssnit_employee: 0.05,
  ssnit_employer: 0.12,
  tier1: 0.13,
  tier2: 0.05,
  bonus_rate: 0.05,
  bonus_share: 0.15,
};

const NEW = {
  ...OLD,
  from_month: '2026-04',
  label: 'New table',
  bands: JSON.stringify([{ width: 600, rate: 0 }, { width: null, rate: 0.3 }]),
  ssnit_employee: 0.055,
  ssnit_employer: 0.13,
};

// ---------------------------------------------------------------------------
// Picking the table
// ---------------------------------------------------------------------------

test('a month takes the newest table that had started by then', () => {
  assert.equal(ratesOn('2026-03', [OLD, NEW]).rates.label, 'Old table');
  assert.equal(ratesOn('2026-04', [OLD, NEW]).rates.label, 'New table');
  assert.equal(ratesOn('2027-01', [OLD, NEW]).rates.label, 'New table');
});

test('the captured table answers for everything behind the first change', () => {
  const answer = ratesOn('2019-06', [OLD, NEW]);
  assert.equal(answer.rates.label, 'Old table');
  assert.equal(answer.from, EARLIEST);
});

test('a property that has never dated one gets the figures it is using', () => {
  const answer = ratesOn('2026-03', [], { pay_bands_label: 'What we use', pay_ssnit_employee: '0.06' });
  assert.equal(answer.rates.label, 'What we use');
  assert.equal(answer.rates.ssnitEmployee, 0.06);
  assert.equal(answer.from, null, 'nothing dated, so no date to report');
});

test('a stored table nobody can parse falls back rather than taxing at nothing', () => {
  const broken = { ...OLD, bands: 'not json at all' };
  const answer = ratesOn('2026-03', [broken], {});
  assert.deepEqual(answer.rates.bands, BANDS);
});

test('a row reads back as the figures it holds', () => {
  const { rates, tiers } = tableToRates(NEW);
  assert.equal(rates.ssnitEmployee, 0.055);
  assert.equal(rates.bonusFinalRate, RATES.bonusFinalRate);
  assert.equal(tiers.tier1, 0.13);
  assert.deepEqual(rates.bands, [{ width: 600, rate: 0 }, { width: null, rate: 0.3 }]);
});

// ---------------------------------------------------------------------------
// The journal, and the split that must not move
// ---------------------------------------------------------------------------

test('the pension split is kept with the line rather than worked out again', () => {
  const line = computeLine({
    staff: { id: 1, name: 'Kofi' },
    basic: 2000,
    rates: { ...RATES, bands: BANDS, label: 'x' },
    tiers: { tier1: 0.135, tier2: 0.05 },
  });
  assert.equal(line.ssnit.tier1, 270);
  assert.equal(line.ssnit.tier2, 100);
  assert.equal(line.ssnit.unallocated, 0, '5.5 and 13 add up to 13.5 and 5');
});

test('a closed month’s journal reads the split it was closed on', () => {
  const line = computeLine({
    staff: { id: 1, name: 'Kofi' },
    basic: 2000,
    rates: { ...RATES, bands: BANDS, label: 'x' },
    tiers: { tier1: 0.135, tier2: 0.05 },
  });

  // The property changes SSNIT afterwards. The journal must still say what was
  // actually paid over, not what today's percentages come to.
  const journal = journalFor({
    lines: [line],
    totals: { basic: 2000, allowances: 0, paye: 100 },
    rates: { ssnitEmployee: 0.09, ssnitEmployer: 0.2 },
    tiers: { tier1: 0.2, tier2: 0.09 },
  });

  const tier1 = journal.credits.find((r) => r.account.includes('tier 1'));
  assert.equal(tier1.amount, 270, 'the split the month was closed on');
});

test('a line written before the split was kept still works out', () => {
  const older = { basic: 2000, ssnit: { qualifies: true, employee: 110, employer: 260 } };
  const journal = journalFor({
    lines: [older],
    totals: { basic: 2000, allowances: 0, paye: 100 },
    rates: { ssnitEmployee: 0.055, ssnitEmployer: 0.13 },
    tiers: { tier1: 0.13, tier2: 0.05 },
  });
  const tier1 = journal.credits.find((r) => r.account.includes('tier 1'));
  assert.equal(tier1.amount, 260);
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
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_rates;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')",
  ).run();
  for (const [key, value] of Object.entries({
    pay_bands: JSON.stringify([{ width: 400, rate: 0 }, { width: null, rate: 0.2 }]),
    pay_bands_label: 'Old table',
    pay_ssnit_employee: '0.05',
    pay_ssnit_employer: '0.12',
  })) {
    raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['att_setup', 'hr_pay'] };
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

const NEW_TABLE = {
  fromMonth: '2026-04',
  label: 'New table',
  bands: [{ width: 600, rate: 0 }, { width: null, rate: 0.3 }],
  ssnitEmployee: 0.055,
  ssnitEmployer: 0.13,
};

test('the first dated table keeps what the property was using', async () => {
  const { raw, db } = setup();
  const out = await (await saveTaxTable(ctx(db, { body: NEW_TABLE }))).json();

  assert.equal(out.tables.length, 2);
  const kept = out.tables.find((t) => t.fromMonth === EARLIEST);
  assert.ok(kept, 'the old figures are kept as their own table');
  assert.equal(kept.label, 'Old table');
  assert.equal(kept.ssnitEmployee, 0.05);

  // And the live settings follow the newest, so every screen still shows what
  // is in force today.
  const live = raw.prepare("SELECT value FROM settings WHERE key = 'pay_bands_label'").get();
  assert.equal(live.value, 'New table');
});

test('saving twice does not capture the old figures twice', async () => {
  const { db } = setup();
  await saveTaxTable(ctx(db, { body: NEW_TABLE }));
  const out = await (await saveTaxTable(
    ctx(db, { body: { ...NEW_TABLE, fromMonth: '2026-07', label: 'Third' } }),
  )).json();

  assert.equal(out.tables.filter((t) => t.fromMonth === EARLIEST).length, 1);
  assert.equal(out.tables.length, 3);
});

test('a month before the change is worked out on the old figures', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, { body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }] } }));
  await saveTaxTable(ctx(db, { body: NEW_TABLE }));

  const march = await (await payroll(ctx(db, { query: '?month=2026-03' }))).json();
  const april = await (await payroll(ctx(db, { query: '?month=2026-04' }))).json();

  assert.equal(march.rates.label, 'Old table');
  assert.equal(march.rates.ssnitEmployee, 0.05);
  assert.equal(april.rates.label, 'New table');
  assert.equal(april.rates.ssnitEmployee, 0.055);
  assert.ok(april.lines[0].paye.total > march.lines[0].paye.total,
    'the new table taxes more, and only April feels it');
});

test('closing March then changing the table leaves March alone', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, { body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }] } }));
  await closeRun(ctx(db, { body: { month: '2026-03' } }));

  const before = await (await payroll(ctx(db, { query: '?month=2026-03' }))).json();
  await saveTaxTable(ctx(db, { body: { ...NEW_TABLE, fromMonth: '2026-01' } }));
  const after = await (await payroll(ctx(db, { query: '?month=2026-03' }))).json();

  assert.equal(after.lines[0].paye.total, before.lines[0].paye.total,
    'a closed month reads its payslips, whatever the table says now');
});

test('reopening a month gives it the table that was in force then', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, { body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }] } }));
  const before = await (await payroll(ctx(db, { query: '?month=2026-03' }))).json();

  await closeRun(ctx(db, { body: { month: '2026-03' } }));
  await saveTaxTable(ctx(db, { body: NEW_TABLE }));
  await reopenRun(ctx(db, { body: { month: '2026-03' } }));

  const after = await (await payroll(ctx(db, { query: '?month=2026-03' }))).json();
  assert.equal(after.rates.label, 'Old table');
  assert.equal(after.lines[0].paye.total, before.lines[0].paye.total,
    'reopening January in July must not retax it at July rates');
});

test('the captured table cannot be taken off', async () => {
  const { db } = setup();
  const out = await (await saveTaxTable(ctx(db, { body: NEW_TABLE }))).json();
  const kept = out.tables.find((t) => t.fromMonth === EARLIEST);
  await assert.rejects(() => removeTaxTable(ctx(db), kept.id), /every earlier month/i);
});

test('a dated table can be taken off, and the months go back', async () => {
  const { db } = setup();
  const saved = await (await saveTaxTable(ctx(db, { body: NEW_TABLE }))).json();
  const dated = saved.tables.find((t) => t.fromMonth === '2026-04');

  const out = await (await removeTaxTable(ctx(db), dated.id)).json();
  assert.equal(out.tables.length, 1);

  const april = await (await payroll(ctx(db, { query: '?month=2026-04' }))).json();
  assert.equal(april.rates.label, 'Old table');
});

test('a month has to be a month', async () => {
  const { db } = setup();
  await assert.rejects(
    () => saveTaxTable(ctx(db, { body: { ...NEW_TABLE, fromMonth: 'April' } })),
    /YYYY-MM/,
  );
});

test('the list says what is in force now as well', async () => {
  const { db } = setup();
  const out = await (await listTaxTables(ctx(db))).json();
  assert.equal(out.tables.length, 0);
  assert.equal(out.current.label, 'Old table');
  assert.equal(out.current.tier1 > 0, true);
});
