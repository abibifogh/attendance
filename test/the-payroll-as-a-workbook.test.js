import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { PAYE_COLUMNS, payeSchedule } from '../src/lib/statutory.js';
import { cellRef, colName, workbook } from '../src/lib/xlsx.js';
import {
  exportBook, payroll, returns, saveScheme, setProfiles, setScores,
} from '../src/routes/payroll.js';

/**
 * The month as a spreadsheet, and the return on the GRA's own form.
 *
 * The schedule used to be Hive's own fourteen columns, which meant whoever
 * filed it rearranged them by hand every month. It is now the form: the same
 * heading block, the same numbers along the top, the same twenty-seven columns
 * in the same order.
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

test('cells are named the way a spreadsheet names them', () => {
  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(cellRef(25, 4), 'Z5');
  assert.equal(cellRef(26, 0), 'AA1');
  assert.equal(cellRef(27, 0), 'AB1');
  assert.equal(colName(27), 'AB');
});

test('a workbook is a zip, and it says so in its first two bytes', () => {
  const bytes = workbook([{ name: 'One', rows: [['a']] }]);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.ok(bytes.length > 500);
});

test('the parts a spreadsheet program looks for are all in it', () => {
  const bytes = workbook([{ name: 'One', rows: [['a']] }, { name: 'Two', rows: [] }]);
  const text = new TextDecoder('latin1').decode(bytes);
  for (const part of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
  ]) assert.ok(text.includes(part), `${part} is in the archive`);
});

test('a name a spreadsheet cannot take is made into one it can', () => {
  const text = new TextDecoder().decode(workbook([
    { name: 'A very long sheet name that goes well past the limit', rows: [] },
    { name: 'Bad/Name:Here', rows: [] },
    { name: '', rows: [] },
  ]));
  assert.ok(text.includes('A very long sheet name that goe'), 'cut to 31');
  assert.ok(text.includes('Bad Name Here'));
  assert.ok(text.includes('Sheet3'), 'and one with no name gets a number');
});

test('markup in somebody name does not break the file open', () => {
  const text = new TextDecoder().decode(workbook([
    { name: 'One', rows: [['Ama & <Kofi>']] },
  ]));
  assert.ok(text.includes('Ama &amp; &lt;Kofi&gt;'));
});

test('a number stays a number and a TIN stays text', () => {
  const text = new TextDecoder().decode(workbook([
    { name: 'One', rows: [[1200.5, { v: '0123456', text: true }]] },
  ]));
  assert.ok(text.includes('<v>1200.5</v>'), 'the figure is a figure');
  assert.ok(text.includes('>0123456<'), 'and the leading nought survives');
});

// ---------------------------------------------------------------------------
// The GRA form
// ---------------------------------------------------------------------------

test('the schedule has the form twenty-seven columns, in order', () => {
  assert.equal(PAYE_COLUMNS.length, 28, 'the form prints 27 numbers over 28 columns');
  assert.deepEqual(PAYE_COLUMNS.map((c) => c.no).slice(0, 3), ['1', '2', '3']);
  assert.deepEqual(
    PAYE_COLUMNS.map((c) => c.label).slice(0, 6),
    ['Ser. No', 'TIN / GH. CARD NO.', 'Name Of Employee', 'Position',
      'Residency/ Part-Time/ Casual', 'Basic Salary'],
  );
  // The form numbers two of its columns 26, which is why the position and the
  // number are not the same thing.
  assert.deepEqual(PAYE_COLUMNS.slice(-3).map((c) => c.no), ['26', '26', '27']);
  assert.equal(PAYE_COLUMNS.at(-1).label, 'Remarks');
});

test('column 15 is 6 plus 11 plus 14, and 19 21 and 22 follow the form', () => {
  const line = {
    staff: { id: 1, name: 'Ama' },
    basic: 800,
    allowanceTotal: 105.52,
    chargeable: 1547.58,
    ssnit: { qualifies: true, employee: 44 },
    bonus: { atFinalRate: 120, atGraduated: 686.06 },
    paye: { total: 167.58, finalOnBonus: 6 },
  };
  const [row] = payeSchedule({ lines: [line] }).rows;

  assert.equal(row.totalCash, 1591.58, '800 + 105.52 + 686.06');
  assert.equal(row.assessable, row.totalCash, 'nothing non-cash, so 19 is 15');
  assert.equal(row.reliefs, 44, '9 + 10 + 20');
  assert.equal(row.chargeable, 1547.58, '19 - 21');
  assert.equal(row.tax, 161.58, 'the graduated part on its own');
  assert.equal(row.bonusTax, 6, 'and the 5% beside it');
  assert.equal(row.total, 167.58, '13 + 23 + 25');
});

test('a Ghana Card answers the column that asks for a TIN or a card', async () => {
  const { db } = setup();
  await aMonth(db);
  const data = await read(await returns(ctx(db, { query: `?month=${MONTH}` })));
  const by = new Map(data.schedule.rows.map((r) => [r.name, r]));

  assert.equal(by.get('Ama Boateng').tin, 'P0012345678', 'a TIN is used where there is one');
  assert.equal(by.get('Kofi Mensah').tin, 'GHA-713059920-2', 'and the card where there is not');
  assert.deepEqual(data.missing, [], 'so nobody is reported as missing a number');
});

test('the grade on the form comes from the job title, and the department after it', async () => {
  const { db } = setup();
  await aMonth(db);
  const data = await read(await returns(ctx(db, { query: `?month=${MONTH}` })));
  const by = new Map(data.schedule.rows.map((r) => [r.name, r]));
  assert.equal(by.get('Ama Boateng').position, 'SENIOR');
  assert.equal(by.get('Ama Boateng').residency, 'Resident-Full-Time');
  assert.equal(by.get('Ama Boateng').paidSsnit, 'Y');
  assert.equal(by.get('Kofi Mensah').paidSsnit, 'N', 'and whoever is not on SSNIT says so');
});

// ---------------------------------------------------------------------------
// The download
// ---------------------------------------------------------------------------

test('the month comes out as a workbook of three sheets', async () => {
  const { db } = setup();
  await aMonth(db);
  const res = await exportBook(ctx(db, { query: `?month=${MONTH}` }));

  assert.equal(
    res.headers.get('Content-Type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(res.headers.get('Content-Disposition'), /attachment; filename="Sir-Tobys-Ghana-LTD-payroll-2026-07\.xlsx"/);

  const text = new TextDecoder('latin1').decode(new Uint8Array(await res.arrayBuffer()));
  assert.ok(text.includes('name="Payroll"'));
  assert.ok(text.includes('name="Journal"'));
  assert.ok(text.includes('name="PAYE schedule"'));
});

test('the schedule sheet is headed the way the form is headed', async () => {
  const { db } = setup();
  await aMonth(db);
  const res = await exportBook(ctx(db, { query: `?month=${MONTH}` }));
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));

  assert.ok(text.includes('GHANA REVENUE AUTHORITY'));
  assert.ok(text.includes('DOMESTIC TAX REVENUE DIVISION'));
  assert.ok(text.includes("EMPLOYER'S MONTHLY TAX DEDUCTIONS SCHEDULE (P. A. Y. E.)"));
  assert.ok(text.includes('Sir Tobys Ghana LTD'));
  assert.ok(text.includes('C000490916X'));
  assert.ok(text.includes('>07/2026<'), 'the month as MM/YYYY, the way the form asks');
  assert.ok(text.includes('PENSIONS'));
  assert.ok(text.includes('Bonus Income(up to 15% of Annual Basic salary)'));
});

test('the figures on the sheet are the figures on the screen', async () => {
  const { db } = setup();
  await aMonth(db);
  const shown = await read(await returns(ctx(db, { query: `?month=${MONTH}` })));
  const res = await exportBook(ctx(db, { query: `?month=${MONTH}` }));
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));

  for (const row of shown.schedule.rows) {
    assert.ok(text.includes(`>${row.name}<`), `${row.name} is on the sheet`);
    assert.ok(text.includes(`<v>${row.total}</v>`), `and so is their ${row.total} of tax`);
  }
  assert.ok(text.includes(`<v>${shown.totals.net}</v>`), 'and the month nets to the same');
});

test('a month nobody has touched still makes a workbook', async () => {
  const { db } = setup();
  await payroll(ctx(db, { query: '?month=2026-11' }));
  const res = await exportBook(ctx(db, { query: '?month=2026-11' }));
  assert.equal(res.status, 200);
  assert.ok((await res.arrayBuffer()).byteLength > 500);
});
