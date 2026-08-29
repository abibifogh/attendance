import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { reconcilePlan } from '../src/lib/advances.js';
import {
  addAdvance, addEntry, bringHistoryAcross, staffAdvances,
} from '../src/routes/advances.js';

/**
 * Typing the old notebook in.
 *
 * The property was lending money for years before any of this existed, and
 * the months in the notebook do not agree with anything the app can work out.
 * Everything here is about one rule: what gets written is ordinary records, so
 * the closing balances and the finish date follow on their own rather than
 * being stored anywhere and having to be kept in step.
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
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Atsu', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 2, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const WAGES = { user: { id: 3, name: 'Esi', role: 'manager' }, permissions: ['hr_pay'] };

const ctx = (db, session, { body = null } = {}) => ({
  db,
  env: {},
  url: new URL('https://x/api/advances'),
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

// Old enough that every month of it has ended, whenever this test is run.
const OLD = {
  id: 1, status: 'approved', amount: 3000, months: 6, monthly: 500,
  taken_on: '2024-03-11', start_month: '2024-04',
};

// ---------------------------------------------------------------------------
// Working out what typing a month would mean
// ---------------------------------------------------------------------------

test('a repayment typed higher is a correction against what was running', () => {
  const entries = new Map([[1, [{ month: '2024-04', kind: 'repayment', amount: 500 }]]]);
  const { changes } = reconcilePlan([OLD], entries, [{ month: '2024-04', repaid: 700 }], {
    asOfMonth: '2024-09',
  });

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    month: '2024-04', kind: 'movement', advanceId: 1, amount: 200, was: 500, now: 700,
  }, 'the difference, not the whole figure again');
});

test('and typed lower is a correction the other way', () => {
  const entries = new Map([[1, [{ month: '2024-04', kind: 'repayment', amount: 500 }]]]);
  const { changes } = reconcilePlan([OLD], entries, [{ month: '2024-04', repaid: 200 }], {
    asOfMonth: '2024-09',
  });
  assert.equal(changes[0].amount, -300);
});

test('a nought against a month nobody answered is that month being let go', () => {
  const { changes } = reconcilePlan([OLD], new Map(), [{ month: '2024-05', repaid: 0 }], {
    asOfMonth: '2024-09',
  });
  assert.equal(changes[0].kind, 'letGo');
  assert.equal(changes[0].amount, 0);
});

test('an addition typed is an advance that month, for the difference', () => {
  const { changes } = reconcilePlan([OLD], new Map(), [{ month: '2024-06', taken: 400 }], {
    asOfMonth: '2024-09',
  });
  assert.deepEqual(changes[0], {
    month: '2024-06', kind: 'advance', amount: 400, was: 0, now: 400,
  });
});

test('money that was handed over cannot be un-handed', () => {
  const { changes, refused } = reconcilePlan([OLD], new Map(), [{ month: '2024-03', taken: 1000 }], {
    asOfMonth: '2024-09',
  });
  assert.equal(changes.length, 0);
  assert.match(refused[0].why, /cannot be un-handed/);
});

test('a month still running is not history yet', () => {
  const { changes, refused } = reconcilePlan([OLD], new Map(), [{ month: '2024-09', repaid: 100 }], {
    asOfMonth: '2024-09',
  });
  assert.equal(changes.length, 0);
  assert.match(refused[0].why, /has not finished/);
});

test('a repayment needs something to have come off', () => {
  const { changes, refused } = reconcilePlan([OLD], new Map(), [{ month: '2024-01', repaid: 500 }], {
    asOfMonth: '2024-09',
  });
  assert.equal(changes.length, 0);
  assert.match(refused[0].why, /nothing was running/);
});

test('a month typed exactly as it stands is left alone', () => {
  const entries = new Map([[1, [{ month: '2024-04', kind: 'repayment', amount: 500 }]]]);
  const { changes } = reconcilePlan([OLD], entries, [
    { month: '2024-04', taken: 0, repaid: 500 },
  ], { asOfMonth: '2024-09' });
  assert.deepEqual(changes, [], 'nothing to write');
});

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

async function give(db) {
  const made = await read(await addAdvance(ctx(db, ADMIN, {
    body: {
      staffId: 1, amount: 3000, months: 6, monthly: 500,
      takenOn: '2024-03-11', startMonth: '2024-04', reason: 'Rent',
    },
  })));
  return made.id;
}

const account = async (db) => (await read(await staffAdvances(ctx(db, ADMIN), '1'))).account;
const at = (rows, month) => rows.find((r) => r.month === month);

test('only an administrator may retype a month that has gone', async () => {
  const { db } = setup();
  await give(db);
  await assert.rejects(
    () => bringHistoryAcross(ctx(db, WAGES, {
      body: { rows: [{ month: '2024-04', repaid: 700 }] },
    }), '1'),
    /administrator/i,
  );
});

test('the closing balances follow the figures that were typed', async () => {
  const { db } = setup();
  await give(db);

  const done = await read(await bringHistoryAcross(ctx(db, ADMIN, {
    body: {
      rows: [
        { month: '2024-04', repaid: 700 },
        { month: '2024-05', repaid: 700 },
        { month: '2024-06', repaid: 0 },
        { month: '2024-07', taken: 400, repaid: 700 },
      ],
      monthly: 500,
      note: 'From the notebook',
    },
  }), '1'));

  assert.equal(done.made.length, 1, 'the July top-up had no record, so one was made');
  assert.equal(done.made[0].amount, 400);

  const rows = await account(db);
  assert.equal(at(rows, '2024-03').closing, 3000);
  assert.equal(at(rows, '2024-04').repayment, 700);
  assert.equal(at(rows, '2024-04').closing, 2300);
  assert.equal(at(rows, '2024-05').closing, 1600);
  assert.equal(at(rows, '2024-06').repayment, 0, 'the month that was let go');
  assert.equal(at(rows, '2024-06').closing, 1600);
  assert.equal(at(rows, '2024-07').additions, 400);
  assert.equal(at(rows, '2024-07').closing, 1300, '1,600 and 400 less the 700 that came off');
});

test('and so does when the last instalment falls', async () => {
  const { db } = setup();
  await give(db);

  const before = await read(await staffAdvances(ctx(db, ADMIN), '1'));
  const was = before.totals.finishes;

  // Twice the agreed instalment came off every month, so it runs out sooner.
  await bringHistoryAcross(ctx(db, ADMIN, {
    body: {
      rows: [
        { month: '2024-04', repaid: 1000 },
        { month: '2024-05', repaid: 1000 },
      ],
    },
  }), '1');

  const after = await read(await staffAdvances(ctx(db, ADMIN), '1'));
  assert.ok(after.totals.finishes < was, `${was} was later than it needed to be`);
  assert.equal(after.advances[0].balance, 1000, 'and a thousand is left rather than three');
});

test('a month left blank is not touched', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2024-04', kind: 'repayment', amount: 500, note: 'April payslip' },
  }), String(id));

  await bringHistoryAcross(ctx(db, ADMIN, {
    body: { rows: [{ month: '2024-04' }, { month: '2024-05', repaid: 600 }] },
  }), '1');

  const written = raw.prepare(
    "SELECT * FROM hr_advance_entry WHERE advance_id = ? AND month = '2024-04'",
  ).all(id);
  assert.equal(written.length, 1, 'April said nothing, so April stands');
  assert.equal(written[0].note, 'April payslip');
});

test('what it refused comes back, so nothing goes in quietly wrong', async () => {
  const { db } = setup();
  await give(db);

  const done = await read(await bringHistoryAcross(ctx(db, ADMIN, {
    body: { rows: [{ month: '2024-03', taken: 100 }, { month: '2099-01', repaid: 50 }] },
  }), '1'));

  assert.equal(done.changes.length, 0);
  assert.equal(done.refused.length, 2);
});

test('the person is told their record was retyped', async () => {
  const { raw, db } = setup();
  await give(db);
  const before = notices(raw).length;

  await bringHistoryAcross(ctx(db, ADMIN, {
    body: { rows: [{ month: '2024-04', repaid: 700 }], note: 'From the notebook' },
  }), '1');

  const told = notices(raw).slice(before);
  assert.equal(told.length, 1);
  assert.match(told[0].title, /brought into line/i);
});

test('and is not told where nothing was written', async () => {
  const { raw, db } = setup();
  await give(db);
  const before = notices(raw).length;

  await bringHistoryAcross(ctx(db, ADMIN, {
    body: { rows: [{ month: '2099-01', repaid: 50 }] },
  }), '1');

  assert.equal(notices(raw).length, before);
});

test('every line of it is in the log', async () => {
  const { raw, db } = setup();
  await give(db);

  await bringHistoryAcross(ctx(db, ADMIN, {
    body: { rows: [{ month: '2024-04', repaid: 700 }], note: 'From the notebook' },
  }), '1');

  const entry = raw.prepare("SELECT * FROM audit_log WHERE action = 'advance.history'").get();
  const detail = JSON.parse(entry.detail);
  assert.equal(detail.changes[0].was, 0);
  assert.equal(detail.changes[0].now, 700);
  assert.equal(detail.note, 'From the notebook');
  assert.match(entry.actor, /Yaa/);
});

test('a whole year of it comes out balancing, and never in credit', async () => {
  const { raw, db } = setup();
  // Johnson's book: five thousand in December, top-ups most months after, and
  // the deductions that were actually taken.
  await addAdvance(ctx(db, ADMIN, {
    body: {
      staffId: 1, amount: 5000, months: 20, monthly: 250,
      takenOn: '2025-12-04', startMonth: '2026-01', reason: 'The first one',
    },
  }));

  const done = await read(await bringHistoryAcross(ctx(db, ADMIN, {
    body: {
      monthly: 250,
      rows: [
        { month: '2026-01', taken: 200, repaid: 700 },
        { month: '2026-02', taken: 200, repaid: 700 },
        { month: '2026-03', taken: 900, repaid: 1400 },
        { month: '2026-04', taken: 700, repaid: 1200 },
        { month: '2026-05', taken: 800, repaid: 1300 },
        { month: '2026-06', taken: 900, repaid: 1400 },
        { month: '2026-07', taken: 2000, repaid: 0 },
      ],
    },
  }), '1'));
  assert.deepEqual(done.refused, []);

  const rows = await account(db);
  const upTo = (m) => at(rows, m);
  assert.equal(upTo('2025-12').closing, 5000);
  assert.equal(upTo('2026-01').closing, 4500);
  assert.equal(upTo('2026-04').closing, 3000);
  assert.equal(upTo('2026-07').closing, 4000, 'the July top-up puts it back up');

  // The whole point: nothing after July says the property owes them money.
  for (const row of rows) {
    assert.ok(row.closing >= 0, `${row.month} closes at ${row.closing}`);
  }
  assert.equal(rows[rows.length - 1].closing, 0, 'and it ends at nothing owed');

  // And no single advance has been paid off twice over.
  const each = raw.prepare(
    `SELECT a.id, a.amount, COALESCE(SUM(e.amount), 0) AS paid
       FROM hr_advance a LEFT JOIN hr_advance_entry e ON e.advance_id = a.id
      GROUP BY a.id`,
  ).all();
  for (const one of each) {
    assert.ok(one.paid <= one.amount + 0.009,
      `advance ${one.id} took ${one.paid} against ${one.amount}`);
  }
});

test('more repaid than anything owed is refused rather than hung on nothing', async () => {
  const { db } = setup();
  await give(db);

  const done = await read(await bringHistoryAcross(ctx(db, ADMIN, {
    body: { rows: [{ month: '2024-04', repaid: 99999 }] },
  }), '1'));

  assert.match(done.refused[0].why, /more than was owed/);
});

test('an empty form is refused rather than treated as a clean sheet', async () => {
  const { db } = setup();
  await give(db);
  await assert.rejects(
    () => bringHistoryAcross(ctx(db, ADMIN, { body: { rows: [] } }), '1'),
    /Nothing was typed/,
  );
});
