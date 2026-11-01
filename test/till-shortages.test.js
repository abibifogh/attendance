import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { dueThisMonth, tillMonthFor, whyNotDue, NOT_DUE } from '../src/lib/advances.js';
import { shiftOf, syncTillChecks } from '../src/lib/till-checks.js';
import { advances, closeMonth, tillDecide, tillShortages, tillToDecide } from '../src/routes/advances.js';
import { myIssues } from '../src/routes/till.js';

/**
 * Till shortages: their own line on the payslip, and off pay only while their
 * shift is checked in Insight. Made-up people only.
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

function setup({ stopBefore = null } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const files = readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort();
  for (const f of files) {
    if (stopBefore && f >= stopBefore) break;
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM hr_advance;');
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Desk One', 'Front office', '2020-01-01')").run();
  return { raw, db: d1(raw), files };
}

const TILL = {
  id: 1, staff_id: 1, amount: 50, months: 1, monthly: 50, status: 'approved', purpose: 'till',
  start_month: '2026-10', taken_on: '2026-10-07', reason: 'Till: the drawer did not agree, 2026-10-06 afternoon',
};

test('a till shortage whose shift is not checked comes off nothing, and the payroll says why', () => {
  assert.equal(whyNotDue(TILL, [], '2026-10'), 'not_checked');
  assert.equal(dueThisMonth(TILL, [], '2026-10'), 0);
  assert.match(NOT_DUE.not_checked, /not checked in Insight/);
  const checked = { ...TILL, till_checked_at: '2026-10-07 09:00:00' };
  assert.equal(whyNotDue(checked, [], '2026-10'), null);
  assert.equal(dueThisMonth(checked, [], '2026-10'), 50);
  // A salary advance is not held by any of this.
  assert.equal(dueThisMonth({ ...TILL, purpose: 'other' }, [], '2026-10'), 50);
});

test('its shift is read from its columns, or from the reason it was written with', () => {
  assert.deepEqual(shiftOf({ till_day: '2026-10-06', till_slot: 'night' }), { day: '2026-10-06', slot: 'night' });
  assert.deepEqual(shiftOf({ reason: 'Till: Cash left the drawer with no envelope or PO, 2026-08-01 afternoon' }), { day: '2026-08-01', slot: 'afternoon' });
  assert.equal(shiftOf({ reason: 'School fees' }), null);
});

test('the sync asks Insight about each open shortage, and holds one whose check was taken back', async () => {
  const { raw, db } = setup();
  const insert = raw.prepare(`INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, purpose, start_month, taken_on, reason, till_day, till_slot, till_checked_at, till_checked_by, currency)
    VALUES (?, 1, ?, 1, ?, 'approved', 'till', '2026-10', '2026-10-07', ?, ?, ?, ?, ?, 'GHS')`);
  insert.run(1, 50, 50, 'Till: drawer, 2026-10-06 afternoon', '2026-10-06', 'afternoon', null, null);
  // Recovered before the rule: no shift columns, only the reason.
  insert.run(2, 20, 20, 'Till: drawer, 2026-10-05 morning', null, null, null, null);
  // Checked when sent, check taken back since.
  insert.run(3, 30, 30, 'Till: drawer, 2026-10-04 night', '2026-10-04', 'night', '2026-10-05 08:00:00', 'Test Owner');
  // Paid off already: not asked about.
  insert.run(4, 10, 10, 'Till: drawer, 2026-09-01 night', '2026-09-01', 'night', null, null);
  raw.prepare("INSERT INTO hr_advance_entry (advance_id, month, kind, amount, actor) VALUES (4, '2026-09', 'repayment', 10, 'x')").run();

  let asked = null;
  const fetchImpl = async (request) => {
    asked = JSON.parse(await request.text());
    return Response.json({ checked: [
      { day: '2026-10-06', slot: 'afternoon', by: 'Test Owner', at: '2026-10-07 10:00:00' },
      { day: '2026-10-05', slot: 'morning', by: 'Test Owner', at: '2026-10-06 10:00:00' },
    ] });
  };
  const out = await syncTillChecks(db, { INSIGHT_SSO_SECRET: 'secret' }, { fetchImpl });
  assert.deepEqual(asked.shifts.map((s) => `${s.day} ${s.slot}`).sort(), ['2026-10-04 night', '2026-10-05 morning', '2026-10-06 afternoon']);
  assert.deepEqual(out, { asked: 3, checked: 2, held: 1 });
  const rows = raw.prepare('SELECT id, till_day, till_slot, till_checked_at FROM hr_advance ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.id, r.till_day, r.till_slot, r.till_checked_at]), [
    [1, '2026-10-06', 'afternoon', '2026-10-07 10:00:00'],
    [2, '2026-10-05', 'morning', '2026-10-06 10:00:00'],
    [3, '2026-10-04', 'night', null],
    [4, '2026-09-01', 'night', null],
  ]);

  // Insight out of reach: the last answer stands.
  const down = await syncTillChecks(db, { INSIGHT_SSO_SECRET: 'secret' }, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(down.checked, null);
  assert.equal(raw.prepare('SELECT till_checked_at FROM hr_advance WHERE id = 1').get().till_checked_at, '2026-10-07 10:00:00');
});

test('shortages already recovered are marked as till shortages, and nothing else is', () => {
  const { raw } = setup({ stopBefore: '0141' });
  raw.exec(`INSERT INTO hr_advance (staff_id, amount, months, monthly, status, purpose, decision, currency) VALUES
    (1, 50, 1, 50, 'approved', 'other', 'A till shortage, recovered from pay as agreed under My till', 'GHS'),
    (1, 500, 5, 100, 'approved', 'other', 'Recorded by the office', 'GHS');`);
  raw.exec(readFileSync('migrations/0141_till_shortages.sql', 'utf8'));
  assert.deepEqual(raw.prepare('SELECT purpose FROM hr_advance ORDER BY id').all().map((r) => r.purpose), ['till', 'other']);
});

test('the payslip gives till shortages a line of their own', () => {
  const view = readFileSync('public/js/views/payslip.js', 'utf8');
  assert.match(view, /'Till shortages' : 'Till shortage'/);
  assert.match(view, /l\.what === 'till'/);
});

test('the till shortages list: shift, check, who recovered it, and where it stands', async () => {
  const { raw, db } = setup();
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  const insert = raw.prepare(`INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, purpose, start_month, taken_on, reason,
      asked_by, decided_by, till_day, till_slot, till_checked_at, till_checked_by, currency)
    VALUES (?, 1, ?, 1, ?, 'approved', ?, '2026-10', '2026-10-07', ?, 'Test Owner (Insight)', 'Test Owner (Insight)', ?, ?, ?, ?, 'GHS')`);
  insert.run(1, 50, 50, 'till', 'Till: Cash left the drawer with no envelope or PO, 2026-10-06 afternoon', '2026-10-06', 'afternoon', '2026-10-07 09:00:00', 'Check Er');
  insert.run(2, 20, 20, 'till', 'Till: The drawer did not agree, 2026-10-05 morning', '2026-10-05', 'morning', null, null);
  insert.run(3, 30, 30, 'till', 'Till: The drawer did not agree, 2026-09-04 night', '2026-09-04', 'night', '2026-09-05 08:00:00', 'Check Er');
  insert.run(4, 500, 500, 'other', 'School shoes', null, null, null, null);
  raw.prepare("INSERT INTO hr_advance_entry (advance_id, month, kind, amount, actor) VALUES (3, '2026-09', 'repayment', 30, 'x')").run();

  const ctx = { db, url: new URL('https://x/api/advances/till'), session: { user: { id: 1, name: 'Pay Roll', role: 'admin' }, permissions: ['hr_pay'] } };
  const data = await (await tillShortages(ctx)).json();
  assert.deepEqual(data.items.map((i) => i.id).sort(), [1, 2, 3], 'salary advances are not on it');
  const by = Object.fromEntries(data.items.map((i) => [i.id, i]));
  assert.equal(by[1].status, 'coming');
  assert.equal(by[1].what, 'Cash left the drawer with no envelope or PO');
  assert.deepEqual([by[1].day, by[1].slot, by[1].checkedBy, by[1].decidedBy], ['2026-10-06', 'afternoon', 'Check Er', 'Test Owner']);
  assert.equal(by[2].status, 'held');
  assert.equal(by[3].status, 'deducted');
  assert.deepEqual(by[3].deducted, [{ month: '2026-09', amount: 30 }]);
  assert.deepEqual(data.totals, { coming: 50, held: 20, deducted: 30, surplus: 0 });
});

test('closing off the month on Advances leaves a held till shortage alone, as the payroll does', async () => {
  const { raw, db } = setup();
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  const insert = raw.prepare(`INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, purpose, start_month, taken_on, reason, till_checked_at, currency)
    VALUES (?, 1, ?, 1, ?, 'approved', 'till', '2026-10', '2026-10-07', 'Till: drawer, 2026-10-06 afternoon', ?, 'GHS')`);
  insert.run(1, 50, 50, '2026-10-07 09:00:00');
  insert.run(2, 20, 20, null);
  const session = { user: { id: 1, name: 'Pay Roll', role: 'admin' }, permissions: ['hr_pay'] };
  const list = await (await advances({ db, url: new URL('https://x/api/advances?month=2026-10'), session })).json();
  const due = list.due ?? list.month?.due ?? [];
  assert.deepEqual(due.map((d) => d.advanceId), [1], 'the held one is not offered');

  const body = { month: '2026-10', rows: [{ advanceId: 1, paid: true }, { advanceId: 2, paid: true }] };
  await closeMonth({ db, url: new URL('https://x/api/advances/close'), session, request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const entries = raw.prepare('SELECT advance_id, amount FROM hr_advance_entry ORDER BY advance_id').all();
  assert.deepEqual(entries.map((e) => [e.advance_id, e.amount]), [[1, 50]]);
});

test('shortages on checked shifts wait in HIVE to be recovered or not, with who each person is', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO users (id, name, role, active, staff_id) VALUES (7, 'desk.one', 'staff', 1, 1)").run();
  const asked = [];
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const body = JSON.parse(await request.text());
    asked.push([url.pathname, body]);
    if (url.pathname.endsWith('/to-decide')) {
      return Response.json({ issues: [{ key: 'k1', userId: 7, label: 'The drawer did not agree', day: '2026-10-06', slot: 'afternoon', amount: 2500, checkedBy: 'Check Er', answer: null }] });
    }
    return Response.json({ ok: true, advanceId: body.outcome === 'recover' ? 9 : null });
  };
  const session = { user: { id: 1, name: 'Pay Roll', role: 'admin' }, permissions: ['hr_pay'] };
  const env = { INSIGHT_SSO_SECRET: 'secret' };
  const list = await (await tillToDecide({ db, env, session, fetchImpl, url: new URL('https://x/') })).json();
  assert.deepEqual(list.issues.map((i) => [i.name, i.department, i.amount]), [['Desk One', 'Front office', 25]]);
  assert.equal(list.canDecide, true);

  // Somebody who handles pay but is not an administrator sees them and decides nothing.
  const payClerk = { user: { id: 2, name: 'Pay Clerk', role: 'manager' }, permissions: ['hr_pay'] };
  const seen = await (await tillToDecide({ db, env, session: payClerk, fetchImpl, url: new URL('https://x/') })).json();
  assert.equal(seen.canDecide, false);
  assert.equal(seen.issues.length, 1);
  const before = asked.length;
  await assert.rejects(tillDecide({ db, env, session: payClerk, fetchImpl, request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'k1', userId: 7, outcome: 'recover' }) }) }),
    /Only an administrator/);
  assert.equal(asked.length, before, 'Insight is not asked');

  const send = (body) => tillDecide({ db, env, session, fetchImpl, request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  await assert.rejects(send({ key: 'k1', userId: 7, outcome: 'maybe' }), /Recover it, pay it, or not/);
  const out = await (await send({ key: 'k1', userId: 7, outcome: 'recover' })).json();
  assert.equal(out.advanceId, 9);
  assert.deepEqual(asked.at(-1), ['/api/link/till/decide', { key: 'k1', userId: 7, outcome: 'recover', by: 'Pay Roll', note: null }]);
  await send({ key: 'k1', userId: 7, outcome: 'writeoff' });
  assert.equal(asked.at(-1)[1].outcome, 'writeoff');
  // A surplus: paid with salary.
  await send({ key: 'k2', userId: 7, outcome: 'pay' });
  assert.equal(asked.at(-1)[1].outcome, 'pay');

  // Insight out of reach: said, not a broken page.
  const down = await (await tillToDecide({ db, env, session, fetchImpl: async () => { throw new Error('down'); }, url: new URL('https://x/') })).json();
  assert.deepEqual(down.issues, []);
  assert.ok(down.error);
});

test('a staff member sees a recovered shortage with the pay it comes off', async () => {
  const { raw, db } = setup();
  raw.prepare(`INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, purpose, start_month, taken_on, till_checked_at, currency)
    VALUES (9, 1, 25, 1, 25, 'approved', 'till', '2026-11', '2026-11-02', '2026-11-01 09:00:00', 'GHS')`).run();
  const binding = { fetch: async () => Response.json({ issues: [
    { key: 'k1', day: '2026-10-06', slot: 'afternoon', amount: -2500, recovered: { amount: 2500, at: '2026-11-02 10:00:00', by: 'Pay Roll', advanceId: 9 } },
    { key: 'k2', day: '2026-10-07', slot: 'night', amount: -500, recovered: null },
  ], cleared: 0 }) };
  const ctx = { db, env: { INSIGHT: binding, INSIGHT_SSO_SECRET: 'secret' }, session: { user: { id: 7, name: 'Desk One', role: 'staff', staff_id: 1 }, permissions: ['att_me'] } };
  let out = await (await myIssues(ctx)).json();
  assert.deepEqual(out.issues[0].recovered, { amount: 2500, at: '2026-11-02 10:00:00', by: 'Pay Roll', advanceId: 9, month: '2026-11', taken: false, held: false });
  assert.equal(out.issues[1].recovered, null);
  raw.prepare("INSERT INTO hr_advance_entry (advance_id, month, kind, amount, actor) VALUES (9, '2026-11', 'repayment', 25, 'x')").run();
  out = await (await myIssues(ctx)).json();
  assert.equal(out.issues[0].recovered.taken, true);
});

test('a till shortage decided in the last week of a month comes off that month, unless its payroll is closed', async () => {
  const { raw, db } = setup();
  // The open draft: on the 31st, still October.
  assert.equal(await tillMonthFor(db, '2026-10-31', 1), '2026-10');
  // October's payroll closed: the next one.
  raw.prepare("INSERT INTO pay_run (month, status, company_id) VALUES ('2026-10', 'final', 1)").run();
  assert.equal(await tillMonthFor(db, '2026-10-31', 1), '2026-11');
  // November closed too: the next one still open.
  raw.prepare("INSERT INTO pay_run (month, status, company_id) VALUES ('2026-11', 'final', 1)").run();
  assert.equal(await tillMonthFor(db, '2026-10-31', 1), '2026-12');
  raw.prepare("DELETE FROM pay_run WHERE month = '2026-11'").run();
  // Another company's closed payroll does not move it.
  raw.exec("UPDATE att_staff SET company_id = (SELECT MAX(id) FROM company WHERE main = 0) WHERE id = 1;");
  assert.equal(await tillMonthFor(db, '2026-10-31', 1), '2026-10');
  // Advances confirmed for the month on the Advances page: the payroll is
  // still a draft, so it still comes off October.
  raw.prepare("INSERT INTO hr_advance_month (month, closed_by) VALUES ('2026-10', 'Pat Pay')").run();
  assert.equal(await tillMonthFor(db, '2026-10-31', 1), '2026-10');
});

test('till shortages already pushed to the next month come back to the open one', () => {
  const { raw, files } = setup({ stopBefore: '0142' });
  // October confirmed on the Advances page; its payroll still a draft.
  raw.prepare("INSERT INTO hr_advance_month (month, closed_by) VALUES ('2026-10', 'Pat Pay')").run();
  const add = (id, takenOn, start, purpose = 'till') => raw.prepare(`INSERT INTO hr_advance (id, staff_id, amount, months, monthly, currency, reason, status, taken_on, start_month, purpose)
    VALUES (?, 1, 20, 1, 20, 'GHS', 'Till', 'approved', ?, ?, ?)`).run(id, takenOn, start, purpose);
  add(1, '2026-10-30', '2026-11');
  add(2, '2026-10-30', '2026-11', 'other');
  add(3, '2026-09-28', '2026-10');
  raw.prepare("INSERT INTO pay_run (month, status, company_id) VALUES ('2026-09', 'final', 1)").run();
  for (const f of files.filter((n) => n >= '0142')) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  const start = (id) => raw.prepare('SELECT start_month FROM hr_advance WHERE id = ?').get(id).start_month;
  assert.equal(start(1), '2026-10');
  // A salary advance keeps the last-week rule.
  assert.equal(start(2), '2026-11');
  // September's payroll is closed: it stays on October.
  assert.equal(start(3), '2026-10');
});

test('a shortage put on a staff account stays checked while the move stands, though its shift was never checked', async () => {
  const { raw, db } = setup();
  raw.prepare(`INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, purpose, start_month, taken_on, reason, till_key, till_day, till_slot, till_checked_at, till_checked_by, currency)
    VALUES (1, 1, 40, 1, 40, 'approved', 'till', '2026-10', '2026-10-30', 'Till: put on your account, 2026-10-20 night', 'moved:7:3', '2026-10-20', 'night', '2026-10-21 09:00:00', 'Test Owner', 'GHS')`).run();
  let asked = null;
  // Insight: the shift has no check, but the move stands.
  const standing = async (request) => {
    asked = JSON.parse(await request.text());
    return Response.json({ checked: [], keys: [{ key: 'moved:7:3', by: 'Test Owner', at: '2026-10-21 09:00:00' }] });
  };
  const out = await syncTillChecks(db, { INSIGHT_SSO_SECRET: 'secret' }, { fetchImpl: standing });
  assert.deepEqual(asked.keys, ['moved:7:3']);
  assert.deepEqual(out, { asked: 1, checked: 1, held: 0 });
  const row = () => raw.prepare('SELECT till_checked_at FROM hr_advance WHERE id = 1').get();
  assert.equal(row().till_checked_at, '2026-10-21 09:00:00');
  assert.equal(dueThisMonth(raw.prepare('SELECT * FROM hr_advance WHERE id = 1').get(), [], '2026-10'), 40);
  // The move undone in Insight: held.
  await syncTillChecks(db, { INSIGHT_SSO_SECRET: 'secret' }, { fetchImpl: async () => Response.json({ checked: [], keys: [] }) });
  assert.equal(row().till_checked_at, null);
});
