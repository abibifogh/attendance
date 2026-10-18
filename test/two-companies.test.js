import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { runKey, monthOfRun } from '../src/lib/companies.js';
import {
  closeRun, myPayslips, payroll, payslip, reopenRun, returns, setProfiles,
} from '../src/routes/payroll.js';
import {
  createCompany, listCompanies, removeCompany, updateCompany,
} from '../src/routes/companies.js';
import { updateStaff } from '../src/routes/attendance-setup.js';

/**
 * Two companies, each with its own payroll.
 *
 * Most of the property is employed by the main company; a second company,
 * Abibifo crafts and More, employs people of its own. Nobody works for both.
 * Each has its own month, closed on its own, its own payslips under its own
 * name, and its own GRA and SSNIT returns. Every person here is made up.
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

const MONTH = '2026-07';

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [key, value] of [['company_legal_name', 'Main Test Ltd'], ['company_tin', 'C0000000001']]) {
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2')
      .run(key, value);
  }
  for (const [id, name, dept] of [[1, 'Ama Boateng', 'Kitchen'], [2, 'Kofi Mensah', 'Workshop']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, ?, '2020-01-01')`,
    ).run(id, String(id), name, dept);
  }
  raw.prepare("INSERT INTO users (id, name, role, active, staff_id, permissions) VALUES (7, 'Kofi Mensah', 'staff', 1, 2, '[\"att_me\"]')").run();
  const db = d1(raw);
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }, { staffId: 2, basic: 1500, ssnit: true }] },
  }));
  return { raw, db };
}

const ADMIN = { user: { id: 3, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay', 'att_setup'] };
const ctx = (db, { body = null, query = '', session = ADMIN, method = 'POST' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (response) => response.json();

const abibifo = (raw) => raw.prepare("SELECT id FROM company WHERE main = 0").get().id;

test('the second company is there, and run keys keep the months apart', async () => {
  const { db } = await setup();
  const { companies } = await read(await listCompanies(ctx(db)));
  assert.deepEqual(companies.map((c) => c.legalName), ['Main Test Ltd', 'Abibifo crafts and More']);
  assert.equal(runKey('2026-07', 1), '2026-07');
  assert.equal(runKey('2026-07', 2), '2026-07@2');
  assert.equal(monthOfRun('2026-07@2'), '2026-07');
});

test('each company’s payroll has only its own people', async () => {
  const { raw, db } = await setup();
  const two = abibifo(raw);
  await updateStaff(ctx(db, {
    body: { name: 'Kofi Mensah', employeeNo: '2', department: 'Workshop', companyId: two },
  }), 2);
  assert.equal(raw.prepare('SELECT company_id FROM att_staff WHERE id = 2').get().company_id, two);

  const main = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.deepEqual(main.lines.map((l) => l.staff.name), ['Ama Boateng']);
  assert.equal(main.companies.length, 2);
  assert.equal(main.company.id, 1);

  const other = await read(await payroll(ctx(db, { query: `?month=${MONTH}&company=${two}` })));
  assert.deepEqual(other.lines.map((l) => l.staff.name), ['Kofi Mensah']);
  assert.equal(other.company.legalName, 'Abibifo crafts and More');
});

test('a company that does not exist is refused', async () => {
  const { db } = await setup();
  await assert.rejects(() => payroll(ctx(db, { query: `?month=${MONTH}&company=99` })), /no such company/);
});

test('each return is headed with its own company', async () => {
  const { raw, db } = await setup();
  const two = abibifo(raw);
  raw.prepare('UPDATE att_staff SET company_id = ? WHERE id = 2').run(two);
  await updateCompany(ctx(db, {
    body: { legalName: 'Abibifo crafts and More', tin: 'C0000000002', ssnit: 'E-22', taxOfficeKind: 'TSC', taxOffice: 'OSU' },
  }), two);

  const main = await read(await returns(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(main.employer.name, 'Main Test Ltd');
  assert.equal(main.employer.tin, 'C0000000001');
  assert.deepEqual(main.schedule.rows.map((r) => r.name), ['Ama Boateng']);

  const other = await read(await returns(ctx(db, { query: `?month=${MONTH}&company=${two}` })));
  assert.equal(other.employer.name, 'Abibifo crafts and More');
  assert.equal(other.employer.tin, 'C0000000002');
  assert.deepEqual(other.employer.taxOffice, { kind: 'TSC', name: 'OSU' });
  assert.deepEqual(other.schedule.rows.map((r) => r.name), ['Kofi Mensah']);
  assert.deepEqual(other.ssnit.rows.map((r) => r.name), ['Kofi Mensah']);
});

test('closing one company’s month leaves the other open, and reopening takes back only its own', async () => {
  const { raw, db } = await setup();
  const two = abibifo(raw);
  raw.prepare('UPDATE att_staff SET company_id = ? WHERE id = 2').run(two);
  // An advance each, both due in July.
  raw.prepare(`INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, start_month)
               VALUES (31, 1, 300, 3, 100, 'approved', ?1), (32, 2, 300, 3, 100, 'approved', ?1)`).run(MONTH);

  await closeRun(ctx(db, { body: { month: MONTH, company: two } }));
  const runs = raw.prepare('SELECT month, company_id, status FROM pay_run ORDER BY id').all();
  assert.deepEqual(runs.map((r) => [r.month, r.company_id, r.status]).find((r) => r[1] === two), [`${MONTH}@${two}`, two, 'final']);
  const mainNow = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(mainNow.status, 'draft');

  await closeRun(ctx(db, { body: { month: MONTH } }));
  const entries = () => raw.prepare("SELECT advance_id FROM hr_advance_entry WHERE source = 'payroll' ORDER BY advance_id").all().map((r) => r.advance_id);
  assert.deepEqual(entries(), [31, 32]);

  await reopenRun(ctx(db, { body: { month: MONTH } }));
  assert.deepEqual(entries(), [32], 'the other company’s repayment stays where its payroll put it');
  const otherNow = await read(await payroll(ctx(db, { query: `?month=${MONTH}&company=${two}` })));
  assert.equal(otherNow.status, 'final');
});

test('a payslip carries the company that paid it, and the month without its key', async () => {
  const { raw, db } = await setup();
  const two = abibifo(raw);
  raw.prepare('UPDATE att_staff SET company_id = ? WHERE id = 2').run(two);
  await closeRun(ctx(db, { body: { month: MONTH, company: two } }));

  const slip = await read(await payslip(ctx(db, { query: `?month=${MONTH}` }), '2'));
  assert.equal(slip.company.id, two);
  assert.equal(slip.status, 'final');

  const KOFI = { user: { id: 7, name: 'Kofi Mensah', role: 'staff', staff_id: 2 }, permissions: ['att_me'] };
  const mine = await read(await myPayslips(ctx(db, { session: KOFI, query: '' })));
  assert.deepEqual(mine.months.map((m) => m.month), [MONTH]);
  assert.equal(mine.company.legalName, 'Abibifo crafts and More');
});

test('a company somebody works for cannot be removed; an empty one can', async () => {
  const { raw, db } = await setup();
  const two = abibifo(raw);
  raw.prepare('UPDATE att_staff SET company_id = ? WHERE id = 2').run(two);
  await assert.rejects(() => removeCompany(ctx(db), String(two)), /still employed/);
  await assert.rejects(() => removeCompany(ctx(db), '1'), /main company/);

  const made = await read(await createCompany(ctx(db, { body: { legalName: 'Spare Test Co' } })));
  await removeCompany(ctx(db), String(made.id));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM company WHERE id = ?').get(made.id).n, 0);
});
