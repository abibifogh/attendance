import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { readAllowanceHeading, readColumns, readSheet } from '../src/lib/pay-import.js';
import { readStaffSheet } from '../src/lib/staff-import.js';
import { applyStaffImport, readStaffImport, staffTemplate } from '../src/routes/attendance-setup.js';
import { applyInput, setProfiles } from '../src/routes/payroll.js';

/**
 * Allowances, out of a spreadsheet.
 *
 * A property setting up has twenty people on a transport allowance and a
 * housing one, and typing them into a dialog one person at a time is an
 * afternoon. But an allowance is money on a payslip, so a column can only
 * become one by saying outright that it is.
 */

// ---------------------------------------------------------------------------
// The heading
// ---------------------------------------------------------------------------

test('a heading has to say it is an allowance', () => {
  assert.deepEqual(readAllowanceHeading('Allowance: Transport'), { name: 'Transport', taxable: true });
  assert.deepEqual(readAllowanceHeading('allowance - Housing'), { name: 'Housing', taxable: true });
  assert.equal(readAllowanceHeading('Transport'), null, 'a bare name is not an allowance');
  assert.equal(readAllowanceHeading('Blood group'), null);
  assert.equal(readAllowanceHeading('Allowance:'), null, 'and it has to name one');
});

test('brackets say whether it is taxed', () => {
  assert.deepEqual(readAllowanceHeading('Allowance: Transport (not taxable)'),
    { name: 'Transport', taxable: false });
  assert.deepEqual(readAllowanceHeading('Allowance: Fuel (tax free)'),
    { name: 'Fuel', taxable: false });
  assert.deepEqual(readAllowanceHeading('Allowance: Housing (taxable)'),
    { name: 'Housing', taxable: true });
  assert.deepEqual(readAllowanceHeading('Allowance: Site (Accra)'),
    { name: 'Site (Accra)', taxable: true }, 'brackets that say something else are the name');
});

test('a bare column the property does not know stays unknown', () => {
  const { columns, unknown } = readColumns(['Employee no', 'Transport'], { allowances: [] });
  assert.deepEqual(columns.map((c) => c.kind), ['employeeNo']);
  assert.deepEqual(unknown, ['Transport']);
});

test('a named one the property does not use yet is an allowance to be made', () => {
  const { columns, unknown } = readColumns(['Employee no', 'Allowance: Transport'], { allowances: [] });
  const [, allowance] = columns;
  assert.equal(allowance.kind, 'allowance');
  assert.equal(allowance.name, 'Transport');
  assert.equal(allowance.isNew, true);
  assert.deepEqual(unknown, []);
});

// ---------------------------------------------------------------------------
// The payroll sheet
// ---------------------------------------------------------------------------

const person = { id: 1, name: 'Kofi', employee_no: '1', active: 1 };
const onPayroll = new Map([[1, { staff_id: 1, basic: 2000, ssnit: 1 }]]);

test('a new allowance is set, and the line says it is new', () => {
  const read = readSheet('Employee no,Allowance: Transport\n1,250', {
    staff: [person], profiles: onPayroll, allowances: [],
  });

  const [change] = read.lines[0].changes;
  assert.equal(change.kind, 'allowance');
  assert.equal(change.name, 'Transport');
  assert.equal(change.from, null);
  assert.equal(change.to, 250);
  assert.equal(change.taxable, true);
  assert.equal(change.isNew, true);
  assert.match(read.lines[0].notes[0].why, /not used before/);
});

test('a heading that says untaxed carries that through', () => {
  const read = readSheet('Employee no,Allowance: Fuel (not taxable)\n1,300', {
    staff: [person], profiles: onPayroll, allowances: [],
  });
  assert.equal(read.lines[0].changes[0].taxable, false);
});

test('an allowance for somebody not on the payroll is reported, not set', () => {
  const read = readSheet('Employee no,Allowance: Transport\n1,250', {
    staff: [person], profiles: new Map(), allowances: [],
  });
  assert.deepEqual(read.lines[0].changes, []);
  assert.match(read.lines[0].notes[0].why, /not on the payroll yet/);
});

test('changing only whether it is taxed still counts as a change', () => {
  const read = readSheet('Employee no,Allowance: Transport (not taxable)\n1,250', {
    staff: [person],
    profiles: onPayroll,
    allowances: ['Transport'],
    allowanceBy: new Map([[1, [{ name: 'Transport', amount: 250, taxable: 1 }]]]),
  });
  const [change] = read.lines[0].changes;
  assert.equal(change.to, 250);
  assert.equal(change.taxable, false);
});

// ---------------------------------------------------------------------------
// Writing it
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
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_allowance;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['att_setup', 'hr_pay'] };
const ctx = (db, body = null, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/x${query}`),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const HEAD = 'Employee no,Name,Basic salary,Allowance: Transport,Allowance: Fuel (not taxable)';

test('a staff sheet brings allowances in with the people', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, { text: `${HEAD}\n1,Kofi Mensah,2000,250,300` }));

  const rows = raw.prepare('SELECT * FROM pay_allowance ORDER BY name').all();
  assert.deepEqual(rows.map((r) => [r.name, r.amount, r.taxable]), [
    ['Fuel', 300, 0],
    ['Transport', 250, 1],
  ]);
  assert.equal(raw.prepare('SELECT basic FROM pay_profile').get().basic, 2000);
});

test('running the same staff sheet twice leaves one of each', async () => {
  const { raw, db } = setup();
  const sheet = `${HEAD}\n1,Kofi Mensah,2000,250,300`;
  await applyStaffImport(ctx(db, { text: sheet }));
  await applyStaffImport(ctx(db, { text: sheet }));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM pay_allowance').get().n, 2);
});

test('nought takes an allowance off', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, { text: `${HEAD}\n1,Kofi Mensah,2000,250,300` }));
  await applyStaffImport(ctx(db, { text: `${HEAD}\n1,Kofi Mensah,2000,0,300` }));

  const names = raw.prepare('SELECT name FROM pay_allowance').all().map((r) => r.name);
  assert.deepEqual(names, ['Fuel']);
});

test('a blank cell leaves the allowance where it is', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, { text: `${HEAD}\n1,Kofi Mensah,2000,250,300` }));
  await applyStaffImport(ctx(db, { text: 'Employee no,Name,Department\n1,Kofi Mensah,Kitchen' }));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM pay_allowance').get().n, 2);
});

test('two columns of the same allowance is a sheet pasted badly', () => {
  const read = readStaffSheet(
    'Employee no,Name,Allowance: Transport,Allowance: Transport\n1,Kofi,250,400', {},
  );
  assert.deepEqual(read.unknown, ['Allowance: Transport']);
});

test('the month sheet can introduce one too', async () => {
  const { raw, db } = setup();
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')",
  ).run();
  await setProfiles(ctx(db, { rows: [{ staffId: 1, basic: 2000, ssnit: true }] }));

  await applyInput(ctx(db, {
    month: '2026-06',
    text: 'Employee no,Allowance: Transport\n1,250',
  }));

  const row = raw.prepare('SELECT * FROM pay_allowance').get();
  assert.equal(row.name, 'Transport');
  assert.equal(row.amount, 250);
});

test('the staff template offers the property’s own allowance columns', async () => {
  const { raw, db } = setup();
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')",
  ).run();
  raw.prepare('INSERT INTO pay_profile (staff_id, basic) VALUES (1, 2000)').run();
  raw.prepare(
    "INSERT INTO pay_allowance (staff_id, name, amount, taxable) VALUES (1, 'Fuel', 300, 0)",
  ).run();

  const body = await (await staffTemplate(ctx(db))).text();
  const [head, row] = body.trim().split('\n');
  assert.match(head, /Allowance: Fuel \(not taxable\)/);
  assert.match(row, /300\.00/);
});

test('a property with no allowances yet is shown the column rather than told about it', async () => {
  const { db } = setup();
  const body = await (await staffTemplate(ctx(db))).text();
  assert.match(body, /Allowance: Transport/);
});

test('a round trip through the staff template changes nothing', async () => {
  const { db } = setup();
  await applyStaffImport(ctx(db, { text: `${HEAD}\n1,Kofi Mensah,2000,250,300` }));

  const sheet = await (await staffTemplate(ctx(db))).text();
  const read = await (await readStaffImport(ctx(db, { text: sheet }))).json();
  assert.equal(read.tally.nothing, true, 'what came down is what is already here');
});

test('somebody whose salary moved counts as changed, record or no record', async () => {
  const { raw, db } = setup();
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')",
  ).run();

  const out = await (await applyStaffImport(
    ctx(db, { text: `${HEAD}\n1,Kofi,2000,250,300` }),
  )).json();

  assert.equal(out.added, 0);
  assert.equal(out.changed, 1, 'nothing on their record moved, but three figures did');
});
