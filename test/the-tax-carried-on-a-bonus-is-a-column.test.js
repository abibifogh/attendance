import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { exportBook, saveScheme, setProfiles, setScores } from '../src/routes/payroll.js';

/**
 * The tax the property carries on a net bonus has a column of its own on
 * the exported month. It still sits inside the allowances on the payslip;
 * the column is so an outside sheet can be reconciled without detective
 * work.
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

/** The sheet's cells, in order, from the shared-strings table and the sheet. */
function payrollSheet(text) {
  const sheet = text.slice(text.indexOf('<worksheet'), text.indexOf('</worksheet>'));
  const strings = [...text.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
  return { sheet, strings };
}

test('a net bonus puts its carried tax in a column beside the bonus, and the totals add', async () => {
  const { db } = setup();
  // Ama's bonus is a promise of 900 in hand, so the property carries the tax.
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: true, bonusIsNet: true }] },
  }));
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Nkosoɔ', amount: 900, departments: [], staffIds: [1] },
  })));
  await setScores(ctx(db, { body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] } }));

  const res = await exportBook(ctx(db, { query: `?month=${MONTH}` }));
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
  const { strings } = payrollSheet(text);

  const at = strings.indexOf('Bonus');
  assert.ok(at > 0, 'the payroll sheet has its Bonus heading');
  assert.equal(strings[at + 1], 'Tax carried on bonus', 'and the carried tax is the next column');
  assert.equal(strings[at + 2], 'Gross');
});

test('with every bonus agreed gross the column is there and reads nought', async () => {
  const { db } = setup();
  await aMonth(db);
  const res = await exportBook(ctx(db, { query: `?month=${MONTH}` }));
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
  assert.ok(text.includes('Tax carried on bonus'));
});
