import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  balanceOf, finishesOn, firstMonthFor, instalmentFor, isMonthEnd, monthsLeft, scheduleFor,
  summarise,
} from '../src/lib/advances.js';
import {
  addAdvance, addEntry, adjustAdvance, advances, askAboutTheMonth, askForAdvance, closeMonth,
  decideAdvance, myAdvances, removeEntry, withdrawMyAdvance,
} from '../src/routes/advances.js';

/**
 * Salary advances.
 *
 * The figures here end up on somebody's payslip, so every one of them is
 * checkable by hand: a thousand cedis over three months, four hundred over
 * four. Nothing in this file needs a calculator, which is the only kind of
 * test worth having about money.
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
  for (const [id, name] of [[1, 'Kofi Mensah'], [2, 'Ama Boateng']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
    ).run(id, String(id), name);
  }
  // Kofi has a login and can be told things; Ama has none, which must not stop
  // anything being recorded about her.
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const KOFI = { user: { id: 7, name: 'Kofi Mensah', role: 'staff', staff_id: 1 } };
const WAGES = { user: { id: 2, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/advances${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const read = async (response) => response.json();
const notices = (raw) => raw.prepare('SELECT * FROM app_notices ORDER BY id').all();

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test('the instalment rounds up, so the last month is the short one', () => {
  assert.equal(instalmentFor(1200, 6), 200, 'the easy one');
  assert.equal(instalmentFor(1000, 3), 333.34, 'not 333.33, which would leave a cedi in month four');

  const advance = { amount: 1000, months: 3, monthly: 333.34, start_month: '2026-09' };
  const schedule = scheduleFor(advance, []);
  assert.equal(schedule.length, 3, 'three months and not a fourth');
  assert.equal(schedule[2].paid, 333.32, 'and the last one is what is left');
  assert.equal(schedule[2].balance, 0);
});

test('what is owed comes from the movements, never from a stored figure', () => {
  const advance = { amount: 400, months: 4, monthly: 100, start_month: '2026-09' };
  const entries = [
    { month: '2026-09', kind: 'repayment', amount: 100 },
    { month: '2026-10', kind: 'skipped', amount: 0 },
    { month: '2026-11', kind: 'repayment', amount: 150 },
  ];

  assert.equal(balanceOf(advance, entries), 150);
  assert.equal(monthsLeft(150, 100), 2, 'fifty left over is still one more payday');

  const schedule = scheduleFor(advance, entries);
  assert.equal(schedule.find((r) => r.month === '2026-10').skipped, true,
    'a month let go is a decision, not a gap');
  assert.equal(finishesOn(advance, entries), '2027-01');
});

test('money handed over at the end of a month is paid back from the next one', () => {
  assert.equal(firstMonthFor('2026-08-05'), '2026-08', 'early enough to catch this payroll');
  assert.equal(firstMonthFor('2026-08-28'), '2026-09', 'the payroll is already worked out');
  assert.equal(firstMonthFor('nonsense'), null);
});

test('the month end is read from the calendar, February and all', () => {
  assert.equal(isMonthEnd('2026-08-31'), true);
  assert.equal(isMonthEnd('2026-08-30'), false);
  assert.equal(isMonthEnd('2026-02-28'), true, '2026 is not a leap year');
  assert.equal(isMonthEnd('2028-02-28'), false, 'but 2028 is');
});

test('two advances at once are two agreements and one deduction', () => {
  const rows = [
    { id: 1, amount: 600, months: 3, monthly: 200, status: 'approved', start_month: '2026-09' },
    { id: 2, amount: 300, months: 3, monthly: 100, status: 'approved', start_month: '2026-10' },
  ];
  const entries = new Map([[1, [{ month: '2026-09', kind: 'repayment', amount: 200 }]], [2, []]]);
  const out = summarise(rows, entries);

  assert.equal(out.owed, 700);
  assert.equal(out.monthly, 300, 'both come off the same payslip');
  assert.equal(out.taken, 900);
});

// ---------------------------------------------------------------------------
// Asking, deciding, paying back
// ---------------------------------------------------------------------------

test('somebody asks, somebody decides, and both are told', async () => {
  const { raw, db } = setup();

  const asked = await read(await askForAdvance(ctx(db, KOFI, {
    body: { amount: 900, months: 3, reason: 'School fees' },
  })));
  assert.equal(asked.status, 'requested');

  // Whoever does the wages hears about it, held against the permission rather
  // than a person, so it still reaches whoever does the job next month.
  const first = notices(raw);
  assert.equal(first.length, 1);
  assert.equal(first[0].audience, 'hr_pay');
  assert.match(first[0].title, /Kofi Mensah has asked/);

  // And nothing is owed yet: a request is not money.
  let mine = await read(await myAdvances(ctx(db, KOFI)));
  assert.equal(mine.totals.owed, 0);
  assert.equal(mine.advances[0].status, 'requested');

  await decideAdvance(ctx(db, WAGES, {
    body: { approve: true, amount: 900, months: 3, takenOn: '2026-09-02', startMonth: '2026-09' },
  }), asked.id);

  mine = await read(await myAdvances(ctx(db, KOFI)));
  assert.equal(mine.totals.owed, 900);
  assert.equal(mine.advances[0].monthly, 300);
  assert.equal(mine.advances[0].finishes, '2026-11');
  assert.equal(mine.advances[0].schedule.length, 3);

  const told = notices(raw).at(-1);
  assert.equal(told.user_id, 7, 'the person who asked is told, and only them');
  assert.match(told.title, /approved/i);
});

test('a request nobody has decided can be taken back, and only by the person who made it', async () => {
  const { db } = setup();
  const asked = await read(await askForAdvance(ctx(db, KOFI, { body: { amount: 200, months: 2 } })));

  await assert.rejects(
    () => withdrawMyAdvance(ctx(db, { user: { id: 9, name: 'Ama', staff_id: 2 } }), asked.id),
    /not one of yours/,
  );

  await withdrawMyAdvance(ctx(db, KOFI), asked.id);
  const mine = await read(await myAdvances(ctx(db, KOFI)));
  assert.equal(mine.advances[0].status, 'withdrawn');

  // And a second request is allowed once the first is out of the way.
  await askForAdvance(ctx(db, KOFI, { body: { amount: 200, months: 2 } }));
});

test('one request at a time', async () => {
  const { db } = setup();
  await askForAdvance(ctx(db, KOFI, { body: { amount: 200, months: 2 } }));
  await assert.rejects(
    () => askForAdvance(ctx(db, KOFI, { body: { amount: 300, months: 2 } })),
    /already asked/,
  );
});

test('an advance recorded by the office tells the person it is for', async () => {
  const { raw, db } = setup();
  await addAdvance(ctx(db, WAGES, {
    body: { staffId: 1, amount: 400, months: 4, takenOn: '2026-09-01', reason: 'Rent' },
  }));

  const told = notices(raw).at(-1);
  assert.equal(told.user_id, 7);
  assert.match(told.title, /recorded for you/);
  assert.match(told.body, /GHS 100 a month/);

  const mine = await read(await myAdvances(ctx(db, KOFI)));
  assert.equal(mine.advances[0].status, 'approved', 'the office deciding is the decision');
  assert.equal(mine.advances[0].monthly, 100);
});

test('somebody with no login is still recorded, and nothing throws', async () => {
  const { raw, db } = setup();
  await addAdvance(ctx(db, WAGES, {
    body: { staffId: 2, amount: 500, months: 5, takenOn: '2026-09-01' },
  }));
  assert.equal(notices(raw).length, 0, 'nowhere to send it, so nothing is sent');

  const out = await read(await advances(ctx(db, WAGES, { query: '?month=2026-09' })));
  assert.equal(out.totals.owed, 500);
});

// ---------------------------------------------------------------------------
// The end of the month
// ---------------------------------------------------------------------------

async function running(db, { amount = 600, months = 3, staffId = 1, start = '2026-09' } = {}) {
  const out = await read(await addAdvance(ctx(db, WAGES, {
    body: { staffId, amount, months, takenOn: '2026-09-01', startMonth: start },
  })));
  return out.id;
}

test('closing a month records what came off, person by person', async () => {
  const { db } = setup();
  const kofi = await running(db);
  const ama = await running(db, { staffId: 2, amount: 300, months: 3 });

  let out = await read(await advances(ctx(db, WAGES, { query: '?month=2026-09' })));
  assert.equal(out.due.length, 2, 'both are due in September');
  assert.equal(out.due.find((row) => row.staffId === 1).expected, 200);
  assert.equal(out.due.find((row) => row.staffId === 2).expected, 100);

  await closeMonth(ctx(db, WAGES, {
    body: {
      month: '2026-09',
      rows: [
        { advanceId: kofi, paid: true },
        { advanceId: ama, paid: false, note: 'Away all month' },
      ],
    },
  }));

  out = await read(await advances(ctx(db, WAGES, { query: '?month=2026-09' })));
  assert.equal(out.due.length, 2, 'still listed');
  assert.ok(out.due.every((row) => row.recorded), 'but both answered');
  assert.equal(out.closed.by, 'Yaa (admin)');

  const kofiRow = out.people.find((p) => p.staff.id === 1);
  const amaRow = out.people.find((p) => p.staff.id === 2);
  assert.equal(kofiRow.totals.owed, 400, 'two hundred came off');
  assert.equal(amaRow.totals.owed, 300, 'and nothing came off Ama');
});

test('a month cannot be closed twice, however many times the button is pressed', async () => {
  const { raw, db } = setup();
  const id = await running(db);

  const close = () => closeMonth(ctx(db, WAGES, {
    body: { month: '2026-09', rows: [{ advanceId: id, paid: true }] },
  }));
  await close();
  await close();
  await close();

  const rows = raw.prepare('SELECT * FROM hr_advance_entry WHERE advance_id = ?').all(id);
  assert.equal(rows.length, 1, 'one deduction, not three');

  const out = await read(await advances(ctx(db, WAGES, { query: '?month=2026-09' })));
  assert.equal(out.people[0].totals.owed, 400);
});

test('the last instalment is what is left, and the advance settles itself', async () => {
  const { raw, db } = setup();
  const id = await running(db, { amount: 500, months: 3 });   // 166.67 a month

  for (const month of ['2026-09', '2026-10', '2026-11']) {
    await closeMonth(ctx(db, WAGES, { body: { month, rows: [{ advanceId: id, paid: true }] } }));
  }

  const out = await read(await advances(ctx(db, WAGES, { query: '?month=2026-11' })));
  assert.equal(out.totals.owed, 0);

  const advance = raw.prepare('SELECT * FROM hr_advance WHERE id = ?').get(id);
  assert.equal(advance.status, 'settled', 'nothing left means nothing more comes off');

  const paid = raw.prepare('SELECT SUM(amount) AS n FROM hr_advance_entry WHERE advance_id = ?').get(id);
  assert.equal(Math.round(paid.n * 100) / 100, 500, 'never a pesewa more than was lent');

  const told = notices(raw).at(-1);
  assert.match(told.title, /paid off/);
});

test('a movement entered wrongly can be taken back off', async () => {
  const { raw, db } = setup();
  const id = await running(db);
  await closeMonth(ctx(db, WAGES, { body: { month: '2026-09', rows: [{ advanceId: id, paid: true }] } }));

  const entry = raw.prepare('SELECT id FROM hr_advance_entry WHERE advance_id = ?').get(id);
  await removeEntry(ctx(db, WAGES), id, entry.id);

  const out = await read(await advances(ctx(db, WAGES, { query: '?month=2026-09' })));
  assert.equal(out.people[0].totals.owed, 600, 'back where it was');
  assert.equal(out.due[0].recorded, null, 'and September is open to be answered again');
});

test('taking back the last payment reopens a settled advance', async () => {
  const { raw, db } = setup();
  const id = await running(db, { amount: 200, months: 1 });
  await closeMonth(ctx(db, WAGES, { body: { month: '2026-09', rows: [{ advanceId: id, paid: true }] } }));
  assert.equal(raw.prepare('SELECT status FROM hr_advance WHERE id = ?').get(id).status, 'settled');

  const entry = raw.prepare('SELECT id FROM hr_advance_entry WHERE advance_id = ?').get(id);
  await removeEntry(ctx(db, WAGES), id, entry.id);
  assert.equal(raw.prepare('SELECT status FROM hr_advance WHERE id = ?').get(id).status, 'approved');
});

test('the instalment can be changed, and the person is told', async () => {
  const { raw, db } = setup();
  const id = await running(db);

  await adjustAdvance(ctx(db, WAGES, {
    body: { monthly: 100, months: 6, note: 'He asked for smaller deductions' },
  }), id);

  const mine = await read(await myAdvances(ctx(db, KOFI)));
  assert.equal(mine.advances[0].monthly, 100);
  assert.equal(mine.advances[0].balance, 600, 'what is owed has not changed');
  assert.equal(mine.advances[0].left, 6, 'only how long it takes');

  assert.match(notices(raw).at(-1).title, /comes off your pay .* has changed/);
});

test('a payment made outside the payroll counts the same', async () => {
  const { db } = setup();
  const id = await running(db);
  await addEntry(ctx(db, WAGES, {
    body: { month: '2026-09', kind: 'adjustment', amount: 250, note: 'Paid in cash' },
  }), id);

  const out = await read(await advances(ctx(db, WAGES, { query: '?month=2026-09' })));
  assert.equal(out.people[0].totals.owed, 350);
  assert.equal(out.due[0].recorded, null,
    'and the payroll question for September is still open, because it is a different question');
});

// ---------------------------------------------------------------------------
// The asking
// ---------------------------------------------------------------------------

test('the month-end prompt asks on the last day, once, and stops when answered', async () => {
  const { raw, db } = setup();
  const id = await running(db);

  // Not in the middle of the month.
  assert.equal((await askAboutTheMonth(db, { timezone: 'UTC', now: '2026-09-20' })).asked, 0,
    'nothing to say on the twentieth');
  assert.equal(notices(raw).length, 1, 'only the one from recording the advance');

  const asked = await askAboutTheMonth(db, { timezone: 'UTC', now: '2026-09-30' });
  assert.equal(asked.asked, 1);
  assert.equal(asked.month, '2026-09');

  const prompt = notices(raw).at(-1);
  assert.equal(prompt.audience, 'hr_pay');
  assert.match(prompt.title, /Close off 2026-09/);
  assert.equal(prompt.slot, 'advance-month:2026-09');

  // Once the month is closed off, the asking stops.
  await closeMonth(ctx(db, WAGES, { body: { month: '2026-09', rows: [{ advanceId: id, paid: true }] } }));
  assert.equal((await askAboutTheMonth(db, { timezone: 'UTC', now: '2026-10-07' })).asked, 0);
});

test('nobody is asked about a month where nothing was due', async () => {
  const { db } = setup();
  await running(db, { start: '2026-11' });
  assert.equal((await askAboutTheMonth(db, { timezone: 'UTC', now: '2026-09-30' })).asked, 0,
    'the first deduction is not until November');
});
