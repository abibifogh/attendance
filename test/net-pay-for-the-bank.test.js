import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  BANK_COLUMNS, WHY, bankFile, howPaid, referenceFor, tidyAccount,
} from '../src/lib/bank-file.js';
import { bankPayments, payroll, saveScheme, setProfiles, setScores } from '../src/routes/payroll.js';

/**
 * The net pays, on their own, in the shape a bank will take.
 *
 * The thing under test is not really the file, it is who is on it. A payroll
 * screen where every figure is right and one person's account number was never
 * filled in looks exactly like a payroll screen where everybody is going to be
 * paid, and the first anybody hears otherwise is on the second of the month.
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
  raw.prepare("INSERT INTO settings (key, value) VALUES ('company_legal_name', ?) "
    + 'ON CONFLICT (key) DO UPDATE SET value = ?1').run('Sir Tobys Ghana LTD');

  for (const [id, name, dept] of [
    [1, 'Ama Boateng', 'Kitchen'],
    [2, 'Kofi Mensah', 'Reception'],
    [3, 'Yaa Asantewaa', 'Housekeeping'],
    [4, 'Kwesi Appiah', 'Security'],
  ]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, ?, '2020-01-01')`,
    ).run(id, `E${id}`, name, dept);
  }

  // One paid into a bank, one on mobile money, one down for the bank with no
  // account number at all, and one nobody has answered for.
  raw.prepare(
    `INSERT INTO hr_profile (staff_id, pay_method, bank_name, bank_branch, account_name,
                             account_number)
     VALUES (1, 'bank', 'GCB Bank', 'Osu', 'Ama Boateng', '1234567890123')`,
  ).run();
  raw.prepare(
    "INSERT INTO hr_profile (staff_id, pay_method, momo_network, momo_number) "
    + "VALUES (2, 'momo', 'MTN', '0244000111')",
  ).run();
  raw.prepare("INSERT INTO hr_profile (staff_id, pay_method) VALUES (3, 'bank')").run();

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
const read = async (response) => response.json();
const MONTH = '2026-07';

async function aMonth(db) {
  await setProfiles(ctx(db, {
    body: {
      rows: [
        { staffId: 1, basic: 2000, ssnit: true, bonusIsNet: false },
        { staffId: 2, basic: 800, ssnit: false, bonusIsNet: false },
        { staffId: 3, basic: 1200, ssnit: false, bonusIsNet: false },
        { staffId: 4, basic: 900, ssnit: false, bonusIsNet: false },
      ],
    },
  }));
}

/**
 * One sheet out of a stored zip, as text.
 *
 * The entries go in uncompressed, so the XML is there to be read. Cut at the
 * closing tag rather than a length, or sheet one runs on into sheet two and a
 * name on the wrong sheet reads as being on the right one.
 */
function sheetIn(bytes, name) {
  const text = new TextDecoder('latin1').decode(bytes);
  // The name appears in the content types and in the relationships as well as
  // on the entry itself, so take the one the data follows immediately.
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const start = at + name.length;
    if (!text.startsWith('<?xml', start)) continue;
    const end = text.indexOf('</worksheet>', start);
    return end === -1 ? text.slice(start) : text.slice(start, end);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Who is on it
// ---------------------------------------------------------------------------

test('an account number is read the way a bank reads one', () => {
  assert.equal(tidyAccount(' 1234-5678 9012 '), '123456789012');
  assert.equal(tidyAccount(null), '');
  // Some banks number an account with a letter in it, which survives.
  assert.equal(tidyAccount('gh01x-449'), 'GH01X449');
});

test("the property's own answer about how somebody is paid is the one that counts", () => {
  assert.equal(howPaid({ payMethod: 'momo', accountNumber: '123456789' }), 'momo');
  assert.equal(howPaid({ payMethod: 'cash', accountNumber: '123456789' }), 'cash');
  assert.equal(howPaid({ payMethod: 'bank', accountNumber: '123456789' }), 'bank');
});

test('where nobody has answered, an account number is the answer', () => {
  assert.equal(howPaid({ accountNumber: '123456789' }), 'bank');
  assert.equal(howPaid({}), 'not-said');
});

test('somebody down for the bank with no account number is its own case', () => {
  // Not "paid another way". They are not being paid at all, and calling it
  // anything softer is how it goes unnoticed.
  assert.equal(howPaid({ payMethod: 'bank', accountNumber: '  ' }), 'no-account');
  assert.equal(WHY['no-account'], 'Set to be paid by bank, but no account number');
});

test('the narration says the month, because that is what shows on a statement', () => {
  assert.equal(referenceFor('2026-08'), 'Salary Aug 2026');
  assert.equal(referenceFor('2026-08', 'July arrears'), 'July arrears');
  assert.equal(referenceFor(''), 'Salary');
});

test('the month splits into what the bank can take and what it cannot', () => {
  const people = new Map([
    [1, { payMethod: 'bank', accountNumber: '111', bankName: 'GCB', accountName: 'A B' }],
    [2, { payMethod: 'momo', momoNetwork: 'MTN', momoNumber: '0244000111' }],
    [3, { payMethod: 'bank' }],
  ]);
  const lines = [
    { staff: { id: 1, name: 'Ama Boateng', employeeNo: 'E1' }, net: 1500 },
    { staff: { id: 2, name: 'Kofi Mensah', employeeNo: 'E2' }, net: 700 },
    { staff: { id: 3, name: 'Yaa Asantewaa', employeeNo: 'E3' }, net: 1100 },
  ];

  const file = bankFile(lines, people, { month: '2026-07' });
  assert.deepEqual(file.rows.map((r) => r.name), ['Ama Boateng']);
  assert.equal(file.total, 1500);
  assert.deepEqual(file.byHand.map((r) => r.name), ['Kofi Mensah', 'Yaa Asantewaa']);
  assert.equal(file.byHandTotal, 1800);
  assert.equal(file.missingAccounts, 1);
});

test('somebody with nothing to be paid is on neither list', () => {
  // A nought on a bank file is a line the bank rejects, and a nought on the
  // by-hand list is somebody chased for nothing.
  const file = bankFile(
    [{ staff: { id: 1, name: 'Ama' }, net: 0 }, { staff: { id: 2, name: 'Kofi' }, net: -5 }],
    new Map([[1, { accountNumber: '111' }]]),
    { month: '2026-07' },
  );
  assert.equal(file.rows.length, 0);
  assert.equal(file.byHand.length, 0);
});

test('the account name falls back to their own name rather than coming out blank', () => {
  const file = bankFile(
    [{ staff: { id: 1, name: 'Ama Boateng' }, net: 100 }],
    new Map([[1, { accountNumber: '111', accountName: '' }]]),
    { month: '2026-07' },
  );
  assert.equal(file.rows[0].accountName, 'Ama Boateng');
});

test('the mobile money number comes out beside somebody paid that way', () => {
  const file = bankFile(
    [{ staff: { id: 2, name: 'Kofi' }, net: 100 }],
    new Map([[2, { payMethod: 'momo', momoNetwork: 'MTN', momoNumber: '0244000111' }]]),
    { month: '2026-07' },
  );
  assert.equal(file.byHand[0].reach, 'MTN 0244000111');
  assert.equal(file.byHand[0].why, 'Paid by mobile money');
});

test('both lists are in name order, because that is how they are checked', () => {
  const file = bankFile(
    [
      { staff: { id: 1, name: 'Yaa' }, net: 10 },
      { staff: { id: 2, name: 'Ama' }, net: 10 },
      { staff: { id: 3, name: 'Kofi' }, net: 10 },
    ],
    new Map([[1, { accountNumber: '1' }], [2, { accountNumber: '2' }], [3, { accountNumber: '3' }]]),
    { month: '2026-07' },
  );
  assert.deepEqual(file.rows.map((r) => r.name), ['Ama', 'Kofi', 'Yaa']);
});

// ---------------------------------------------------------------------------
// The files themselves
// ---------------------------------------------------------------------------

test('the CSV is the transfers alone, bare, with nothing a bank would try to pay', async () => {
  const { db } = setup();
  await aMonth(db);

  const response = await bankPayments(ctx(db, { query: `?month=${MONTH}&as=csv` }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/csv/);
  assert.match(response.headers.get('Content-Disposition'), /net-pay-2026-07\.csv/);

  const text = await response.text();
  // No byte order mark: a portal reads it as a first column it does not know.
  assert.ok(!text.startsWith('﻿'), 'no BOM on a file a bank parses');

  const rows = text.split('\n');
  assert.equal(rows[0], BANK_COLUMNS.map((c) => c.label).join(','));
  // Only Ama has an account number, so only Ama is on it.
  assert.equal(rows.length, 2);
  assert.ok(rows[1].startsWith('Ama Boateng,1234567890123,GCB Bank,Osu,'));
  assert.ok(rows[1].includes('Salary Jul 2026'));
  // And no total, which the bank would read as one more person to pay.
  assert.ok(!text.toLowerCase().includes('total'));
});

test('the spreadsheet has the transfers on one sheet and the rest on another', async () => {
  const { db } = setup();
  await aMonth(db);

  const response = await bankPayments(ctx(db, { query: `?month=${MONTH}` }));
  assert.match(response.headers.get('Content-Type'), /spreadsheetml/);
  assert.match(response.headers.get('Content-Disposition'), /net-pay-2026-07\.xlsx/);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.includes('Bank transfer'));
  assert.ok(text.includes('Paid another way'));

  const first = sheetIn(bytes, 'xl/worksheets/sheet1.xml');
  assert.ok(first.includes('Ama Boateng'));
  assert.ok(first.includes('1234567890123'));
  // The people paid by hand are on the other sheet, not this one.
  assert.ok(!first.includes('Kofi Mensah'));

  const second = sheetIn(bytes, 'xl/worksheets/sheet2.xml');
  assert.ok(second.includes('Kofi Mensah'));
  assert.ok(second.includes('Paid by mobile money'));
  assert.ok(second.includes('Yaa Asantewaa'));
  // And it counts in words a person would use rather than "1 of them are".
  assert.ok(second.includes('One of them is down to be paid by bank and has no account number'));
});

test('nothing about anybody’s pay beyond the net figure leaves the building', async () => {
  const { db } = setup();
  await aMonth(db);
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Nkosoɔ', amount: 900, departments: [], staffIds: [1] },
  })));
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] },
  }));

  const text = await (await bankPayments(ctx(db, { query: `?month=${MONTH}&as=csv` }))).text();
  for (const word of ['Basic', 'PAYE', 'SSNIT', 'Bonus', 'Gross', 'Allowance', 'Nkosoɔ']) {
    assert.ok(!text.includes(word), `${word} has no business on a file going to a bank`);
  }
});

test('a property can word its own narration', async () => {
  const { db } = setup();
  await aMonth(db);
  const text = await (await bankPayments(ctx(db, {
    query: `?month=${MONTH}&as=csv&reference=${encodeURIComponent('June arrears')}`,
  }))).text();
  assert.ok(text.includes('June arrears'));
  assert.ok(!text.includes('Salary Jul'));
});

// ---------------------------------------------------------------------------
// What the screen is told before the file is made
// ---------------------------------------------------------------------------

test('the payroll says how the month splits, and names who cannot be paid', async () => {
  const { db } = setup();
  await aMonth(db);

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.bank.toBank, 1);
  assert.equal(data.bank.byHand, 3);
  assert.equal(data.bank.missingAccounts, 1);
  // Named, because a count does not tell anybody whose record to open.
  assert.deepEqual(data.bank.missing, ['Yaa Asantewaa']);
  assert.equal(data.bank.reference, 'Salary Jul 2026');
  // And the two halves come to the whole, so the note cannot disagree with
  // the figure above it.
  assert.equal(
    Math.round((data.bank.toBankTotal + data.bank.byHandTotal) * 100) / 100,
    Math.round(data.totals.net * 100) / 100,
  );
});

test('filling the account number in takes the warning off', async () => {
  const { raw, db } = setup();
  await aMonth(db);
  raw.prepare("UPDATE hr_profile SET account_number = '9988776655', bank_name = 'Absa' "
    + 'WHERE staff_id = 3').run();

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.bank.missingAccounts, 0);
  assert.deepEqual(data.bank.missing, []);
  assert.equal(data.bank.toBank, 2);

  const text = await (await bankPayments(ctx(db, { query: `?month=${MONTH}&as=csv` }))).text();
  assert.ok(text.includes('9988776655'));
});
