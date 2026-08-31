import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { NOT_DUE, dueThisMonth, startsOn, scheduleFor, whyNotDue } from '../src/lib/advances.js';
import { addAdvance, closeMonth } from '../src/routes/advances.js';
import { closeRun, payroll, reopenRun, setProfiles } from '../src/routes/payroll.js';

/**
 * Nought in the Advance column, and what it means.
 *
 * The bug this was written for: an approved advance with no start month on it
 * showed a deduction due in August on the Advances screen and deducted nothing
 * on the payroll. The schedule fell back to the day the money was handed over;
 * the payroll read a missing start month as "not until the year 9999" and
 * quietly took nothing off, for ever.
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
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, 'E1', 'Ama Boateng', 'Kitchen', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const WAGES = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay', 'hr_manage'] };
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
const MONTH = '2026-08';

const onPayroll = (db) => setProfiles(ctx(db, {
  body: { rows: [{ staffId: 1, basic: 2000, ssnit: true, bonusIsNet: false }] },
}));

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test('an advance with no start month falls back to the day it was handed over', () => {
  const advance = {
    status: 'approved', amount: 600, monthly: 200,
    taken_on: '2026-07-05', start_month: null, asked_at: '2026-07-01',
  };
  assert.equal(startsOn(advance), '2026-07');
  // Which is the thing that was broken: the schedule said August was due and
  // the payroll took nothing off.
  assert.equal(scheduleFor(advance, [], { asOfMonth: MONTH })[0].month, MONTH);
  assert.equal(dueThisMonth(advance, [], MONTH), 200, 'and now the payroll agrees');
});

test('money handed over at the end of a month is still paid back from the next one', () => {
  // Deliberate, and not the bug above. The payroll for the month it was taken
  // in has usually been worked out already.
  const advance = {
    status: 'approved', amount: 600, monthly: 200, taken_on: '2026-08-27', start_month: null,
  };
  assert.equal(startsOn(advance), '2026-09');
  assert.equal(dueThisMonth(advance, [], MONTH), 0);
  assert.equal(whyNotDue(advance, [], MONTH), 'not_yet');
});

test('each way of coming to nothing says which one it is', () => {
  const open = {
    status: 'approved', amount: 600, monthly: 200, taken_on: '2026-06-05', start_month: '2026-07',
  };
  assert.equal(whyNotDue(open, [], MONTH), null, 'nothing to explain when it is due');

  assert.equal(whyNotDue({ ...open, status: 'settled' }, [], MONTH), 'closed');
  assert.equal(whyNotDue(open, [{ month: MONTH, kind: 'skipped', amount: 0 }], MONTH), 'let_go');
  assert.equal(
    whyNotDue(open, [{ month: '2026-07', kind: 'repayment', amount: 600 }], MONTH),
    'paid_off',
  );
  // And every one of them has words to go with it.
  for (const code of ['closed', 'no_start', 'not_yet', 'let_go', 'paid_off']) {
    assert.ok(NOT_DUE[code], `${code} says something`);
  }
});

test('a start month nobody set and no day to fall back on is said rather than hidden', () => {
  const advance = { status: 'approved', amount: 600, monthly: 200 };
  assert.equal(startsOn(advance), null);
  assert.equal(whyNotDue(advance, [], MONTH), 'no_start');
  assert.equal(dueThisMonth(advance, [], MONTH), 0, 'and nothing is guessed at');
});

// ---------------------------------------------------------------------------
// On the payroll itself
// ---------------------------------------------------------------------------

test('an advance with no start month is deducted rather than silently ignored', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  // A row from before anybody set one, which is what the live books hold.
  raw.exec('UPDATE hr_advance SET start_month = NULL');

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 200);
  assert.deepEqual(data.advancesNotDue, [], 'so there is nothing to explain');
});

test('the payroll says why nothing is coming off an advance that is running', async () => {
  const { db } = setup();
  await onPayroll(db);
  await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-09-02', startMonth: '2026-09',
      purpose: 'other',
    },
  })));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 0);
  assert.equal(data.advancesNotDue.length, 1);
  assert.equal(data.advancesNotDue[0].name, 'Ama Boateng');
  assert.equal(data.advancesNotDue[0].why, 'not_yet');
  assert.equal(data.advancesNotDue[0].from, '2026-09', 'so the screen can write the month out');
  assert.equal(data.advancesNotDue[0].left, 600);
});

test('an advance that is simply being paid off is not explained at all', async () => {
  const { db } = setup();
  await onPayroll(db);
  await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 200);
  assert.deepEqual(data.advancesNotDue, []);
});

test('somebody not on the payroll is not listed here, because that is a different problem', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on)
     VALUES (2, 'E2', 'Kofi Mensah', '2020-01-01')`,
  ).run();
  await read(await addAdvance(ctx(db, {
    body: {
      staffId: 2, amount: 600, months: 3, takenOn: '2026-09-02', startMonth: '2026-09',
      purpose: 'other',
    },
  })));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  // Kofi has no pay profile, so he is not on the month at all and naming him
  // under a table he is not in would only puzzle somebody.
  assert.deepEqual(data.advancesNotDue.map((r) => r.name), []);
});

// ---------------------------------------------------------------------------
// Answered on the Advances page, and what the payroll does about it
// ---------------------------------------------------------------------------

test('a repayment recorded on the Advances page is what comes off the pay', async () => {
  // The bug this was written for. Somebody worked down the month-end list on
  // Advances and ticked nine people off. The payroll then read "there is
  // already an answer for August" as "so deduct nothing", and nine people were
  // paid their full salary while their balances went down anyway.
  const { db } = setup();
  await onPayroll(db);
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));

  await read(await closeMonth(ctx(db, {
    body: { month: MONTH, rows: [{ advanceId: given.id, amount: 200 }] },
  })));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 200, 'it comes off the payslip, not just the ledger');
  assert.deepEqual(data.advancesNotDue, [], 'and there is nothing to explain');
});

test('what was recorded wins over the instalment, because it is what came off', async () => {
  const { db } = setup();
  await onPayroll(db);
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));

  // Half an instalment, because that is what the person could manage.
  await read(await closeMonth(ctx(db, {
    body: { month: MONTH, rows: [{ advanceId: given.id, amount: 100 }] },
  })));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 100);
});

test('a month let go on the Advances page takes nothing off, and says so', async () => {
  const { db } = setup();
  await onPayroll(db);
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));

  await read(await closeMonth(ctx(db, {
    body: { month: MONTH, rows: [{ advanceId: given.id, paid: false, note: 'Sick all month' }] },
  })));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 0, 'letting a month go is meant to take nothing off');
  assert.equal(data.advancesNotDue.length, 1);
  assert.equal(data.advancesNotDue[0].why, 'let_go');
});

test('closing the payroll after the Advances page does not deduct it twice', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  await read(await closeMonth(ctx(db, {
    body: { month: MONTH, rows: [{ advanceId: given.id, amount: 200 }] },
  })));

  await closeRun(ctx(db, { body: { month: MONTH } }));

  const entries = raw.prepare('SELECT * FROM hr_advance_entry WHERE advance_id = ?').all(given.id);
  assert.equal(entries.length, 1, 'one answer for the month, not two');
  assert.equal(entries[0].amount, 200);
  const slip = raw.prepare('SELECT loans FROM pay_slip WHERE staff_id = 1').get();
  assert.equal(slip.loans, 200, 'and the payslip carries it');
});

test('money handed back in cash does not excuse the month deduction', async () => {
  // An adjustment is money that moved some other way. It brings the balance
  // down and has nothing to do with what comes off a payslip, so the
  // instalment is still due.
  const { raw, db } = setup();
  await onPayroll(db);
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  raw.prepare(
    `INSERT INTO hr_advance_entry (advance_id, month, kind, amount, note, actor)
     VALUES (?, ?, 'adjustment', 300, 'Handed back over the counter', 'Yaa')`,
  ).run(given.id, MONTH);

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 200);
});

test('a month closed before the fix picks the deduction up when it is reopened', async () => {
  // What the property has to do to correct August: reopen it and close it
  // again. The answer recorded on the Advances page must survive that, because
  // reopening only takes back what the payroll itself wrote.
  const { raw, db } = setup();
  await onPayroll(db);
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  await read(await closeMonth(ctx(db, {
    body: { month: MONTH, rows: [{ advanceId: given.id, amount: 200 }] },
  })));

  // A slip written the way the old rule wrote it: nothing off for the advance.
  await closeRun(ctx(db, { body: { month: MONTH } }));
  raw.prepare('UPDATE pay_slip SET loans = 0').run();

  await reopenRun(ctx(db, { body: { month: MONTH } }));
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM hr_advance_entry WHERE advance_id = ?").get(given.id).n,
    1,
    'the answer given on the Advances page is still there',
  );

  await closeRun(ctx(db, { body: { month: MONTH } }));
  assert.equal(raw.prepare('SELECT loans FROM pay_slip WHERE staff_id = 1').get().loans, 200);
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM hr_advance_entry WHERE advance_id = ?").get(given.id).n,
    1,
    'and still only one answer for the month',
  );
});
