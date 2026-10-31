import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { RATES } from '../src/lib/tax.js';
import { computeLine } from '../src/lib/payroll.js';
import { payslipFilename, payslipPdf } from '../src/lib/payslip-pdf.js';
import { sendSlipMail, slipMailList } from '../src/routes/payroll.js';

/**
 * Payslips by email: each person their own closed-month payslip as a PDF,
 * nobody else's, and the list saying where each stands. Made-up people only.
 */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { const r = db.prepare(sql).run(...binds); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

const line = (id, name) => computeLine({
  staff: { id, name, department: 'Front office', employeeNo: `T00${id}` }, basic: 2000,
  allowances: [{ name: 'Allowance', amount: 500, taxable: 1 }], ssnit: true, rates: RATES,
});

function setup(status = 'final') {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES
    (1, 'T001', 'Desk One', 'Front office', '2020-01-01'), (2, 'T002', 'Desk Two', 'Front office', '2020-01-01'), (3, 'T003', 'Desk Three', 'Front office', '2020-01-01')`);
  raw.exec("INSERT INTO hr_profile (staff_id, personal_email) VALUES (1, 'one@example.com')");
  raw.exec("INSERT INTO users (id, name, role, active, staff_id, email) VALUES (12, 'Desk Two', 'staff', 1, 2, 'two@example.com')");
  raw.prepare('INSERT INTO pay_run (id, month, status, company_id) VALUES (5, ?, ?, 1)').run('2026-10', status);
  for (const [id, name] of [[1, 'Desk One'], [2, 'Desk Two'], [3, 'Desk Three']]) {
    const l = line(id, name);
    raw.prepare('INSERT INTO pay_slip (run_id, staff_id, detail, gross, bonus_gross, ssf_employee, ssf_employer, paye, loans, net, cost) VALUES (5, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)')
      .run(id, JSON.stringify(l), l.gross, l.ssnit.employee, l.ssnit.employer, l.paye.total, l.net, l.employerCost);
  }
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 1, name: 'Pay Admin', role: 'admin', email: 'payadmin@example.com' }, permissions: ['hr_pay'] };
const CLERK = { user: { id: 2, name: 'Pay Clerk', role: 'manager' }, permissions: ['hr_pay'] };
const post = (db, session, body) => ({
  db, env: {}, session, url: new URL('https://x/api/payroll/mail'),
  request: new Request('https://x/api/payroll/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const get = (db, session) => ({ db, env: {}, session, url: new URL('https://x/api/payroll/mail?month=2026-10') });

test('a payslip PDF is one page with the person, the month and the net pay', async () => {
  const bytes = await payslipPdf({ line: line(1, 'Desk One'), company: { legalName: 'Made Up Ltd' }, month: '2026-10' });
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.startsWith('%PDF'));
  assert.match(text, /Desk One/);
  assert.match(text, /October 2026/);
  assert.match(text, /NET PAY/);
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 1, 'one page');
  assert.equal(payslipFilename('2026-10', 'Desk One'), 'Payslip-October-2026-Desk-One.pdf');
});

test('each person gets their own payslip, attached, at the address on their record', async () => {
  const { raw, db } = setup();
  const sent = [];
  const send = async (_db, _env, mail) => { sent.push(mail); return { sent: 1 }; };
  const out = await (await sendSlipMail(post(db, ADMIN, { month: '2026-10', staffIds: [1, 2, 3], note: 'Thank you', copy: true }), { send })).json();
  assert.deepEqual(out.results.map((r) => [r.staffId, r.status]), [[1, 'sent'], [2, 'sent'], [3, 'no_email']]);
  assert.deepEqual(sent.map((m) => m.to), ['one@example.com', 'two@example.com'], 'personal email first, else the sign-in one');
  assert.equal(sent[0].attachments[0].filename, 'Payslip-October-2026-Desk-One.pdf');
  const pdf = atob(sent[0].attachments[0].content);
  assert.ok(pdf.startsWith('%PDF') && pdf.includes('Desk One') && !pdf.includes('Desk Two'), 'theirs and nobody else\'s');
  assert.deepEqual(sent[0].copyTo, ['payadmin@example.com']);
  assert.equal(sent[0].mail.subject, 'Your payslip for October 2026');
  assert.doesNotMatch(JSON.stringify(sent[0].mail), /GHS|\d{3,}\.\d{2}/, 'no amounts in the email');

  // The list: sent, sent, no email; a failure says why.
  const failing = async () => ({ sent: 0, reason: 'not configured' });
  await sendSlipMail(post(db, ADMIN, { month: '2026-10', staffIds: [2] }), { send: failing });
  let list = await (await slipMailList(get(db, ADMIN))).json();
  assert.deepEqual(list.people.map((p) => [p.name, p.status]), [['Desk One', 'sent'], ['Desk Three', 'no_email'], ['Desk Two', 'failed']]);
  assert.equal(list.people.find((p) => p.name === 'Desk Two').error, 'not configured');

  // The month reopened and closed with a different figure: changed since sent.
  raw.prepare('UPDATE pay_slip SET detail = ? WHERE staff_id = 1').run(JSON.stringify({ ...line(1, 'Desk One'), net: 1 }));
  list = await (await slipMailList(get(db, ADMIN))).json();
  assert.equal(list.people.find((p) => p.name === 'Desk One').changed, true);
});

test('only an administrator sends them, and only for a closed month', async () => {
  const send = async () => ({ sent: 1 });
  await assert.rejects(sendSlipMail(post(setup().db, CLERK, { month: '2026-10', staffIds: [1] }), { send }), /administrator/);
  await assert.rejects(sendSlipMail(post(setup('draft').db, ADMIN, { month: '2026-10', staffIds: [1] }), { send }), /Only a closed month/);
  const draft = await (await slipMailList(get(setup('draft').db, ADMIN))).json();
  assert.equal(draft.closed, false);
});
