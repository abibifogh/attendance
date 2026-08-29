import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addAdvance, addEntry, editEntry, staffAdvances,
} from '../src/routes/advances.js';

/**
 * A movement over several months, and a figure put right afterwards.
 *
 * Both are about the same habit: somebody catching a ledger up in one sitting.
 * Doing it a month at a time is three dialogs, and the third one is the one
 * that gets a month wrong or never happens.
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

const WAGES = { user: { id: 2, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };

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
const moves = (raw, id) => raw.prepare(
  'SELECT month, kind, amount, note FROM hr_advance_entry WHERE advance_id = ? ORDER BY month',
).all(id);
const rowOf = (raw, id) => raw.prepare('SELECT * FROM hr_advance WHERE id = ?').get(id);

/** 3,000 over six months at 500, first deduction April 2024. */
async function give(db, over = {}) {
  const made = await read(await addAdvance(ctx(db, WAGES, {
    body: {
      staffId: 1, amount: 3000, months: 6, monthly: 500,
      takenOn: '2024-03-11', startMonth: '2024-04', reason: 'Rent', ...over,
    },
  })));
  return made.id;
}

// ---------------------------------------------------------------------------
// The same figure, month after month
// ---------------------------------------------------------------------------

test('one figure goes in for each of the months asked for', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  const done = await read(await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'repayment', amount: 500, months: 3, note: 'Caught up' },
  }), String(id)));

  assert.equal(done.written.length, 3);
  assert.deepEqual(done.written.map((w) => w.month), ['2024-04', '2024-05', '2024-06']);
  assert.deepEqual(moves(raw, id).map((m) => `${m.month}:${m.amount}`),
    ['2024-04:500', '2024-05:500', '2024-06:500']);
  assert.equal(moves(raw, id)[2].note, 'Caught up', 'the note goes on every one of them');
});

test('leaving it out is one month, the way it always was', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'repayment', amount: 500 },
  }), String(id));
  assert.equal(moves(raw, id).length, 1);
});

test('a month already answered is left as it is, not answered twice', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, WAGES, {
    body: { month: '2024-05', kind: 'repayment', amount: 500, note: 'May payslip' },
  }), String(id));

  const done = await read(await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'repayment', amount: 500, months: 3 },
  }), String(id)));

  assert.deepEqual(done.already, ['2024-05'], 'and it says which');
  assert.deepEqual(done.written.map((w) => w.month), ['2024-04', '2024-06']);
  const may = moves(raw, id).find((m) => m.month === '2024-05');
  assert.equal(may.note, 'May payslip', 'the one that was already there stands');
});

test('it stops at the month the advance is paid off', async () => {
  const { raw, db } = setup();
  const id = await give(db, { amount: 1200, months: 6, monthly: 500 });

  const done = await read(await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'repayment', amount: 500, months: 6 },
  }), String(id)));

  assert.deepEqual(done.written, [
    { month: '2024-04', amount: 500 },
    { month: '2024-05', amount: 500 },
    { month: '2024-06', amount: 200 },
  ], 'two payments and a short one, exactly as it would be on the payslips');
  assert.equal(done.cleared, '2024-07', 'and it says where it stopped');
  assert.equal(rowOf(raw, id).status, 'settled');
});

test('nothing taken this month can run for several months too', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'skipped', months: 3, note: 'On leave' },
  }), String(id));

  const written = moves(raw, id);
  assert.equal(written.length, 3);
  assert.ok(written.every((m) => m.kind === 'skipped' && m.amount === 0));
  assert.equal(rowOf(raw, id).status, 'approved', 'letting months go owes exactly what it did');
});

// ---------------------------------------------------------------------------
// Putting a figure right
// ---------------------------------------------------------------------------

async function oneMovement(db, id, body = {}) {
  await addEntry(ctx(db, WAGES, {
    body: { month: '2024-04', kind: 'repayment', amount: 500, note: 'April payslip', ...body },
  }), String(id));
  const data = await read(await staffAdvances(ctx(db, WAGES), '1'));
  return data.advances.find((a) => a.id === id).entries[0];
}

test('a figure typed wrong is put right where it stands', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id);

  const done = await read(await editEntry(ctx(db, WAGES, {
    body: { amount: 700 },
  }), String(id), String(entry.id)));

  assert.equal(done.amount, 700);
  assert.equal(done.balance, 2300);
  const written = moves(raw, id);
  assert.equal(written.length, 1, 'put right, not taken off and added again');
  assert.equal(written[0].note, 'April payslip', 'and the note explaining it survives');
});

test('putting one up can pay the advance off', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id);

  const done = await read(await editEntry(ctx(db, WAGES, {
    body: { amount: 3000 },
  }), String(id), String(entry.id)));

  assert.equal(done.settled, true);
  assert.equal(rowOf(raw, id).status, 'settled');
});

test('and putting one down brings back one that was finished', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id, { amount: 3000 });
  assert.equal(rowOf(raw, id).status, 'settled');

  await editEntry(ctx(db, WAGES, { body: { amount: 500 } }), String(id), String(entry.id));

  const back = rowOf(raw, id);
  assert.equal(back.status, 'approved');
  assert.equal(back.settled_at, null);
});

test('a movement can be moved to the month it really belongs to', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id);

  await editEntry(ctx(db, WAGES, { body: { month: '2024-05' } }), String(id), String(entry.id));
  assert.equal(moves(raw, id)[0].month, '2024-05');
});

test('but not onto a month that already has an answer', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id);
  await addEntry(ctx(db, WAGES, {
    body: { month: '2024-05', kind: 'repayment', amount: 500 },
  }), String(id));

  await assert.rejects(
    () => editEntry(ctx(db, WAGES, { body: { month: '2024-05' } }), String(id), String(entry.id)),
    /already has an answer/i,
  );
  assert.equal(moves(raw, id).length, 2, 'and neither of them moved');
});

test('what is left out is left alone', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id);

  await editEntry(ctx(db, WAGES, { body: {} }), String(id), String(entry.id));

  assert.deepEqual({ ...moves(raw, id)[0] },
    { month: '2024-04', kind: 'repayment', amount: 500, note: 'April payslip' });
});

test('they are told when the figure moves, and not when a note does', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id);
  const before = notices(raw).length;

  await editEntry(ctx(db, WAGES, { body: { note: 'April payslip, corrected' } }),
    String(id), String(entry.id));
  assert.equal(notices(raw).length, before);

  await editEntry(ctx(db, WAGES, { body: { amount: 700 } }), String(id), String(entry.id));
  const told = notices(raw).slice(before);
  assert.equal(told.length, 1);
  assert.match(told[0].body, /700/);
});

test('what it was and what it is now go in the log', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const entry = await oneMovement(db, id);

  await editEntry(ctx(db, WAGES, { body: { amount: 700 } }), String(id), String(entry.id));

  const log = raw.prepare("SELECT * FROM audit_log WHERE action = 'advance.entry_edit'").get();
  const detail = JSON.parse(log.detail);
  assert.equal(detail.was.amount, 500);
  assert.equal(detail.now.amount, 700);
  assert.match(log.actor, /Yaa/);
});

test('a movement belonging to another advance is not reachable', async () => {
  const { db } = setup();
  const id = await give(db);
  const other = await give(db);
  const entry = await oneMovement(db, id);

  await assert.rejects(
    () => editEntry(ctx(db, WAGES, { body: { amount: 1 } }), String(other), String(entry.id)),
    /No such movement/,
  );
});
