import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { ssnitSchedule } from '../src/lib/statutory.js';
import { exportBook, returns, saveScheme, setProfiles, setScores } from '../src/routes/payroll.js';

/**
 * The SSNIT contribution return, beside the PAYE one.
 *
 * Who contributed, on what basic, what came from whom, and how it is paid
 * across the two tiers. One row per member and nobody at nought.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec("UPDATE settings SET value = 'GHS' WHERE key = 'currency'");
  for (const [key, value] of [
    ['company_legal_name', 'Sir Tobys Ghana LTD'], ['company_tin', 'C000490916X'],
  ]) {
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2')
      .run(key, value);
  }
  for (const [id, name, dept, title] of [
    [1, 'Ama Boateng', 'Kitchen', 'SENIOR'],
    [2, 'Kofi Mensah', 'Reception', 'JUNIOR'],
  ]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, job_title, hired_on)
       VALUES (?, ?, ?, ?, ?, '2020-01-01')`,
    ).run(id, String(id), name, dept, title);
  }
  // One person with a TIN, one with only a Ghana Card.
  raw.prepare('INSERT INTO hr_profile (staff_id, tin_number, ssnit_number) VALUES (1, ?, ?)')
    .run('P0012345678', 'SS-11');
  raw.prepare('INSERT INTO hr_profile (staff_id, id_type, id_number, ssnit_number) VALUES (2, ?, ?, ?)')
    .run('Ghana Card', 'GHA-713059920-2', 'SS-22');
  return { raw, db: d1(raw) };
}

const WAGES = { user: { id: 3, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
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
const read = async (response) => response.json();
const MONTH = '2026-07';

async function aMonth(db) {
  await setProfiles(ctx(db, {
    body: {
      rows: [
        { staffId: 1, basic: 2000, ssnit: true, bonusIsNet: false },
        { staffId: 2, basic: 800, ssnit: false, bonusIsNet: false },
      ],
    },
  }));
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Nkosoɔ', amount: 900, departments: [], staffIds: [1, 2] },
  })));
  await setScores(ctx(db, {
    body: {
      month: MONTH,
      rows: [
        { schemeId: scheme.id, staffId: 1, score: 100 },
        { schemeId: scheme.id, staffId: 2, score: 100 },
      ],
    },
  }));
}

// ---------------------------------------------------------------------------
// The workbook writer itself
// ---------------------------------------------------------------------------

test('one row per contributing member, and nobody at nought', async () => {
  const { db } = setup();
  await aMonth(db);
  const data = await read(await returns(ctx(db, { query: `?month=${MONTH}` })));

  assert.ok(data.ssnit, 'the return is on the payload');
  assert.equal(data.ssnit.members, 1, 'Kofi does not contribute, so he is not on it');
  const [ama] = data.ssnit.rows;
  assert.equal(ama.name, 'Ama Boateng');
  assert.equal(ama.ssnitNumber, 'SS-11');
  assert.equal(ama.basic, 2000);
  assert.equal(ama.employee, 110, '5.5% of 2000');
  assert.equal(ama.employer, 260, '13% of 2000');
  assert.equal(ama.total, 370);
  assert.equal(ama.tier1, 270, '13.5% to SSNIT');
  assert.equal(ama.tier2, 100, '5% to the trustee');

  assert.equal(data.ssnit.totals.total, 370);
  assert.equal(data.ssnit.totals.tier1 + data.ssnit.totals.tier2, data.ssnit.totals.total,
    'the two tiers are the whole contribution');

  const labels = data.ssnit.columns.map((c) => c.label);
  assert.ok(labels.includes('Worker 5.5%'));
  assert.ok(labels.includes('Employer 13%'));
  assert.ok(labels.includes('Tier 1 to SSNIT 13.5%'));
});

test('the workbook has a fourth sheet headed as the SSNIT form is', async () => {
  const { db, raw } = setup();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('company_ssnit', 'ER-0099') ON CONFLICT (key) DO UPDATE SET value = 'ER-0099'").run();
  await aMonth(db);
  const res = await exportBook(ctx(db, { query: `?month=${MONTH}` }));
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));

  assert.ok(text.includes('name="SSNIT return"'));
  assert.ok(text.includes('SOCIAL SECURITY AND NATIONAL INSURANCE TRUST'));
  assert.ok(text.includes('MONTHLY CONTRIBUTION REPORT'));
  assert.ok(text.includes('ER-0099'), 'the employer SSNIT number from Setup');
  assert.ok(text.includes('SS-11'));
  assert.ok(!text.includes('SS-22') || text.indexOf('SS-22') < text.indexOf('name="SSNIT return"'),
    'the non-member is not on the SSNIT sheet');
});

test('the builder on its own leaves off anybody not contributing and totals the rest', () => {
  const lines = [
    { staff: { id: 1, name: 'A' }, basic: 1000, ssnit: { qualifies: true, employee: 55, employer: 130, tier1: 135, tier2: 50 } },
    { staff: { id: 2, name: 'B' }, basic: 500, ssnit: { qualifies: false, employee: 0, employer: 0, tier1: 0, tier2: 0 } },
    { staff: { id: 3, name: 'C' }, basic: 3000, ssnit: { qualifies: true, employee: 165, employer: 390, tier1: 405, tier2: 150 } },
  ];
  const people = new Map([[1, { ssnit_number: 'X1' }], [3, {}]]);
  const out = ssnitSchedule({ lines, people, rates: { ssnitEmployee: 0.055, ssnitEmployer: 0.13 }, tiers: { tier1: 0.135, tier2: 0.05 } });
  assert.equal(out.members, 2);
  assert.deepEqual(out.rows.map((r) => r.name), ['A', 'C']);
  assert.equal(out.rows[1].ssnitNumber, '', 'missing number is blank, not undefined');
  assert.equal(out.totals.employee, 220);
  assert.equal(out.totals.employer, 520);
  assert.equal(out.totals.total, 740);
  assert.equal(out.totals.tier1, 540);
  assert.equal(out.totals.tier2, 200);
});
