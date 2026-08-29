import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { accountFor, finishesOn, unansweredMonths } from '../src/lib/advances.js';
import { addAdvance, addEntry, markSkipped, staffAdvances } from '../src/routes/advances.js';

/**
 * The statement, and the months nobody answered for.
 *
 * Two things that turn out to be one thing. A person wants their borrowing as
 * a running account rather than as a table per advance; and the reason the
 * account stops adding up is a month that went by with nothing recorded, which
 * every other screen hides because the balance is still right.
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
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Atsu Mensah', 'Kitchen', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

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

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

const RUNNING = {
  id: 1, status: 'approved', amount: 3000, months: 6, monthly: 500,
  taken_on: '2024-03-11', start_month: '2024-04',
};

test('every line balances against the one above it', () => {
  const entries = new Map([[1, [
    { month: '2024-04', kind: 'repayment', amount: 500 },
    { month: '2024-05', kind: 'repayment', amount: 500 },
  ]]]);

  const rows = accountFor([RUNNING], entries, { asOfMonth: '2024-06' });

  assert.equal(rows[0].month, '2024-03', 'it opens in the month the money was handed over');
  assert.equal(rows[0].additions, 3000);
  assert.equal(rows[0].repayment, 0, 'nothing comes off in the month somebody is given it');
  assert.equal(rows[0].closing, 3000);

  for (let i = 1; i < rows.length; i += 1) {
    assert.equal(rows[i].opening, rows[i - 1].closing, `${rows[i].month} opens where May closed`);
    assert.equal(
      rows[i].closing,
      Math.round((rows[i].opening + rows[i].additions - rows[i].repayment) * 100) / 100,
      `${rows[i].month} adds up`,
    );
  }
  assert.equal(rows[rows.length - 1].closing, 0, 'and it ends at nothing');
});

test('a second advance is an addition, not a second table', () => {
  const second = {
    id: 2, status: 'approved', amount: 400, months: 2, monthly: 200,
    taken_on: '2024-04-20', start_month: '2024-05',
  };
  const entries = new Map([
    [1, [
      { month: '2024-04', kind: 'repayment', amount: 500 },
      { month: '2024-05', kind: 'repayment', amount: 500 },
    ]],
    [2, [{ month: '2024-05', kind: 'repayment', amount: 200 }]],
  ]);

  const rows = accountFor([RUNNING, second], entries, { asOfMonth: '2024-06' });
  const at = (m) => rows.find((r) => r.month === m);

  assert.equal(at('2024-04').additions, 400, 'taken in April, while the first is being repaid');
  assert.equal(at('2024-05').repayment, 700, 'two deductions on one payslip is one figure here');
  assert.equal(at('2024-06').repayment, 700, 'and both are still running in June');
  assert.equal(at('2024-07').repayment, 500, 'the small one finishes and the figure drops back');
});

test('what was never handed over is not on a statement', () => {
  const asked = { ...RUNNING, id: 9, status: 'requested', amount: 5000 };
  const rows = accountFor([RUNNING, asked], new Map(), { asOfMonth: '2024-04' });
  const taken = rows.reduce((n, r) => n + r.additions, 0);
  assert.equal(taken, 3000, 'a request nobody has decided is not money in their hand');
});

test('a month behind us is a record and a month ahead is a forecast', () => {
  const entries = new Map([[1, [{ month: '2024-04', kind: 'repayment', amount: 500 }]]]);
  const rows = accountFor([RUNNING], entries, { asOfMonth: '2024-05' });

  assert.equal(rows.find((r) => r.month === '2024-04').done, true);
  assert.equal(rows.find((r) => r.month === '2024-06').done, false);
});

// ---------------------------------------------------------------------------
// The months nobody answered for
// ---------------------------------------------------------------------------

test('a month with nothing recorded at all is named', () => {
  const entries = [
    { month: '2024-04', kind: 'repayment', amount: 500 },
    { month: '2024-05', kind: 'skipped', amount: 0 },
  ];
  assert.deepEqual(
    unansweredMonths(RUNNING, entries, { asOfMonth: '2024-08' }),
    ['2024-06', '2024-07'],
    'a skip is an answer; nothing at all is not',
  );
});

test('the month running is not late yet', () => {
  assert.deepEqual(unansweredMonths(RUNNING, [], { asOfMonth: '2024-04' }), []);
  assert.deepEqual(unansweredMonths(RUNNING, [], { asOfMonth: '2024-05' }), ['2024-04']);
});

test('an advance already paid off has nothing outstanding to answer for', () => {
  const entries = [{ month: '2024-04', kind: 'repayment', amount: 3000 }];
  assert.deepEqual(unansweredMonths(RUNNING, entries, { asOfMonth: '2024-12' }), []);
});

test('the finish date stops counting on months that have gone', () => {
  const entries = [
    { month: '2024-04', kind: 'repayment', amount: 500 },
    { month: '2024-05', kind: 'repayment', amount: 500 },
  ];
  // Without the month it is being asked in, it plans instalments for June and
  // July even though it is already August, and never moves however long the
  // books go unanswered.
  assert.equal(finishesOn(RUNNING, entries), '2024-09');
  assert.equal(
    finishesOn(RUNNING, entries, { asOfMonth: '2024-08' }),
    '2024-11',
    'four instalments left, starting this month',
  );
});

// ---------------------------------------------------------------------------
// Catching them up
// ---------------------------------------------------------------------------

async function give(db) {
  const made = await read(await addAdvance(ctx(db, WAGES, {
    body: {
      staffId: 1, amount: 3000, months: 6, monthly: 500,
      takenOn: '2024-03-11', startMonth: '2024-04', reason: 'Rent',
    },
  })));
  return made.id;
}

const entriesOf = (raw, id) => raw.prepare(
  'SELECT month, kind, amount FROM hr_advance_entry WHERE advance_id = ? ORDER BY month',
).all(id);

test('ticking a month writes it as skipped and moves nothing else', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  const before = await read(await staffAdvances(ctx(db, WAGES), '1'));
  const owed = before.advances[0].balance;
  const behind = before.advances[0].unanswered;
  assert.ok(behind.length > 1, 'March 2024 was a while ago');

  const done = await read(await markSkipped(ctx(db, WAGES, {
    body: { months: [behind[0], behind[1]], note: 'Nobody closed the month off' },
  }), String(id)));

  assert.deepEqual(done.marked, [behind[0], behind[1]]);
  const written = entriesOf(raw, id);
  assert.equal(written.length, 2);
  assert.ok(written.every((e) => e.kind === 'skipped' && e.amount === 0));

  const after = await read(await staffAdvances(ctx(db, WAGES), '1'));
  assert.equal(after.advances[0].balance, owed, 'a skipped month owes exactly what it did');
});

test('letting the month running go pushes the last instalment out by one', () => {
  const entries = [
    { month: '2024-04', kind: 'repayment', amount: 500 },
    { month: '2024-05', kind: 'repayment', amount: 500 },
  ];
  const asOfMonth = '2024-06';
  assert.equal(finishesOn(RUNNING, entries, { asOfMonth }), '2024-09');

  const letGo = [...entries, { month: '2024-06', kind: 'skipped', amount: 0 }];
  assert.equal(finishesOn(RUNNING, letGo, { asOfMonth }), '2024-10', 'everything moves on by one');
});

test('catching up months long gone explains the gap without moving the date', async () => {
  const { db } = setup();
  const id = await give(db);

  const before = await read(await staffAdvances(ctx(db, WAGES), '1'));
  const was = before.advances[0].finishes;
  const behind = before.advances[0].unanswered;

  await markSkipped(ctx(db, WAGES, { body: { months: [behind[0], behind[1]] } }), String(id));

  const after = await read(await staffAdvances(ctx(db, WAGES), '1'));
  // The date is worked out from this month forward, so those months were
  // already counted as gone. What changes is that the books now say what
  // happened in them instead of leaving two holes.
  assert.equal(after.advances[0].finishes, was);
  assert.equal(after.advances[0].unanswered.length, behind.length - 2);
});

test('a month it is not behind on is refused rather than written', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  const done = await read(await markSkipped(ctx(db, WAGES, {
    body: { months: ['2099-01', '2024-03'] },
  }), String(id)));

  assert.deepEqual(done.marked, [], 'neither is a month this advance is behind on');
  assert.deepEqual(done.refused, ['2024-03', '2099-01']);
  assert.equal(entriesOf(raw, id).length, 0);
});

test('a month already answered cannot be answered twice', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'repayment', amount: 500 },
  }), String(id));

  const done = await read(await markSkipped(ctx(db, WAGES, {
    body: { months: ['2024-04'] },
  }), String(id)));

  assert.deepEqual(done.refused, ['2024-04']);
  assert.equal(entriesOf(raw, id).length, 1, 'the payment stands');
});

test('it will not say which months, so it will not guess', async () => {
  const { db } = setup();
  const id = await give(db);
  await assert.rejects(
    () => markSkipped(ctx(db, WAGES, { body: { months: [] } }), String(id)),
    /which months/i,
  );
});

test('the statement comes back with the person, for both sides to read', async () => {
  const { db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'repayment', amount: 500 },
  }), String(id));

  const data = await read(await staffAdvances(ctx(db, WAGES), '1'));
  assert.ok(Array.isArray(data.account));
  assert.equal(data.account[0].month, '2024-03');
  assert.equal(data.account[0].additions, 3000);
  assert.equal(data.account.find((r) => r.month === '2024-04').repayment, 500);
});
