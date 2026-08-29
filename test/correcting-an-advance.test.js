import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addAdvance, addEntry, advances, editAdvance, removeAdvance, staffAdvances,
} from '../src/routes/advances.js';

/**
 * Correcting an advance record.
 *
 * The everyday act on this screen is agreeing a change to what comes off each
 * month, and that is covered next door. This is the other one: the record was
 * written down wrong. The figures below are all round on purpose, because a
 * test about somebody's money that needs a calculator to read is no use.
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
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 2, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
// Everything the wages need, and not the role that may rewrite a record.
const WAGES = { user: { id: 3, name: 'Esi', role: 'manager' }, permissions: ['hr_pay'] };

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
const logs = (raw) => raw.prepare("SELECT * FROM audit_log WHERE action = 'advance.edit'").all();

/** A thousand cedis to Kofi, over four months. */
async function give(db, over = { amount: 1000, months: 4, monthly: 250 }) {
  const made = await read(await addAdvance(ctx(db, ADMIN, {
    body: {
      staffId: 1, takenOn: '2026-03-02', startMonth: '2026-04', purpose: 'rent', ...over,
    },
  })));
  return made.id;
}

const rowOf = (raw, id) => raw.prepare('SELECT * FROM hr_advance WHERE id = ?').get(id);

// ---------------------------------------------------------------------------

test('only an administrator may correct a record', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  await assert.rejects(
    () => editAdvance(ctx(db, WAGES, { body: { amount: 400 } }), String(id)),
    /administrator/i,
    'doing the wages is not the same as rewriting what was agreed',
  );
  assert.equal(rowOf(raw, id).amount, 1000, 'and nothing moved');
});

test('the screen says whether this pair of eyes may correct anything', async () => {
  const { db } = setup();
  await give(db);

  assert.equal((await read(await advances(ctx(db, ADMIN)))).canEdit, true);
  assert.equal((await read(await advances(ctx(db, WAGES)))).canEdit, false);
  assert.equal((await read(await staffAdvances(ctx(db, WAGES), '1'))).canEdit, false);
});

test('a mis-keyed amount is put right and what is owed follows it', async () => {
  const { raw, db } = setup();
  // Four thousand was handed over; four hundred was typed.
  const id = await give(db, { amount: 400, months: 4, monthly: 100 });

  const done = await read(await editAdvance(ctx(db, ADMIN, {
    body: { amount: 4000, monthly: 1000, note: 'A nought short.' },
  }), String(id)));

  assert.deepEqual(done.changed, ['amount', 'monthly']);
  const row = rowOf(raw, id);
  assert.equal(row.amount, 4000);
  assert.equal(row.monthly, 1000);

  const mine = await read(await staffAdvances(ctx(db, ADMIN), '1'));
  assert.equal(mine.advances[0].balance, 4000, 'the whole of it is owed again');
});

test('the date, the purpose and the note are all correctable', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  const done = await read(await editAdvance(ctx(db, ADMIN, {
    body: {
      takenOn: '2026-02-27', startMonth: '2026-03', purpose: 'school_fees',
      reason: 'Term two fees.',
    },
  }), String(id)));

  assert.deepEqual(done.changed.sort(), ['purpose', 'reason', 'startMonth', 'takenOn']);
  const row = rowOf(raw, id);
  assert.equal(row.taken_on, '2026-02-27');
  assert.equal(row.start_month, '2026-03');
  assert.equal(row.purpose, 'school_fees');
  assert.equal(row.reason, 'Term two fees.');
});

test('a purpose can be taken off as well as changed', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  await editAdvance(ctx(db, ADMIN, { body: { purpose: '' } }), String(id));
  assert.equal(rowOf(raw, id).purpose, null);
});

test('what is left out is left alone', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const before = rowOf(raw, id);

  const done = await read(await editAdvance(ctx(db, ADMIN, { body: {} }), String(id)));
  assert.deepEqual(done.changed, [], 'an empty form changes nothing');

  const after = rowOf(raw, id);
  for (const key of ['amount', 'months', 'monthly', 'taken_on', 'start_month', 'purpose', 'reason']) {
    assert.equal(after[key], before[key], key);
  }
});

test('it cannot be made worth less than what has already come back', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2026-04', kind: 'repayment', amount: 250 },
  }), String(id));

  await assert.rejects(
    () => editAdvance(ctx(db, ADMIN, { body: { amount: 100 } }), String(id)),
    /already come back/i,
    'the balance would go negative and this screen has nowhere to put one',
  );
  assert.equal(rowOf(raw, id).amount, 1000);
});

test('correcting the amount downwards can finish it, and upwards brings it back', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2026-04', kind: 'repayment', amount: 250 },
  }), String(id));

  // It was 250 all along, and that one payment cleared it.
  await editAdvance(ctx(db, ADMIN, { body: { amount: 250, monthly: 250, months: 1 } }), String(id));
  assert.equal(rowOf(raw, id).status, 'settled', 'nothing left to owe');

  await editAdvance(ctx(db, ADMIN, { body: { amount: 1000 } }), String(id));
  const back = rowOf(raw, id);
  assert.equal(back.status, 'approved', 'and it is running again');
  assert.equal(back.settled_at, null);
});

test('the movements against it are kept whatever changes', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2026-04', kind: 'repayment', amount: 250, note: 'April payslip' },
  }), String(id));

  await editAdvance(ctx(db, ADMIN, { body: { amount: 2000, monthly: 500 } }), String(id));

  const entries = raw.prepare('SELECT * FROM hr_advance_entry WHERE advance_id = ?').all(id);
  assert.equal(entries.length, 1, 'the whole point of correcting rather than re-keying');
  assert.equal(entries[0].note, 'April payslip');
});

test('it can be put against the right person while nothing has come off', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  await editAdvance(ctx(db, ADMIN, { body: { staffId: 2 } }), String(id));
  assert.equal(rowOf(raw, id).staff_id, 2, 'it was Ama who took it');
});

test('and cannot be once a payment is recorded', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2026-04', kind: 'repayment', amount: 250 },
  }), String(id));

  await assert.rejects(
    () => editAdvance(ctx(db, ADMIN, { body: { staffId: 2 } }), String(id)),
    /movements recorded/i,
    'that 250 came off a real payslip belonging to Kofi',
  );
  assert.equal(rowOf(raw, id).staff_id, 1);
});

test('they are told when their money moves, and not when a spelling does', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const before = notices(raw).length;

  await editAdvance(ctx(db, ADMIN, { body: { reason: 'Rent, February.' } }), String(id));
  assert.equal(notices(raw).length, before, 'a corrected note is not news');

  await editAdvance(ctx(db, ADMIN, { body: { amount: 2000 } }), String(id));
  const told = notices(raw).slice(before);
  assert.equal(told.length, 1);
  assert.match(told[0].title, /corrected/i);
  assert.match(told[0].body, /GHS 2,000 in all/);
});

test('what it was and what it is now both go in the log', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  await editAdvance(ctx(db, ADMIN, {
    body: { amount: 4000, note: 'A nought short.' },
  }), String(id));

  const entry = logs(raw).at(-1);
  const detail = JSON.parse(entry.detail);
  assert.equal(detail.was.amount, 1000);
  assert.equal(detail.now.amount, 4000);
  assert.equal(detail.note, 'A nought short.');
  assert.match(entry.actor, /Yaa/);
});

test('a record nobody has is not correctable', async () => {
  const { db } = setup();
  await assert.rejects(
    () => editAdvance(ctx(db, ADMIN, { body: { amount: 100 } }), '999'),
    /No such advance/,
  );
});

// ---------------------------------------------------------------------------
// Taking one off the books entirely
// ---------------------------------------------------------------------------

const ctxWith = (db, session, { note = null } = {}) => ({
  ...ctx(db, session),
  request: new Request(`https://x/api/advances/1${note ? `?note=${encodeURIComponent(note)}` : ''}`, {
    method: 'DELETE',
  }),
});

test('only an administrator may delete a record', async () => {
  const { raw, db } = setup();
  const id = await give(db);

  await assert.rejects(
    () => removeAdvance(ctxWith(db, WAGES), String(id)),
    /administrator/i,
  );
  assert.ok(rowOf(raw, id), 'and it is still there');
});

test('the record goes, and its movements with it', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2026-04', kind: 'repayment', amount: 250 },
  }), String(id));

  const done = await read(await removeAdvance(ctxWith(db, ADMIN, { note: 'Keyed twice' }), String(id)));
  assert.equal(done.movements, 1);
  assert.equal(done.owed, 750);

  assert.equal(rowOf(raw, id), undefined);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM hr_advance_entry WHERE advance_id = ?').get(id).n,
    0,
    'payments left behind would be rows pointing at nothing',
  );
});

test('the whole of it is written down before it goes', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2026-04', kind: 'repayment', amount: 250, note: 'April payslip' },
  }), String(id));

  await removeAdvance(ctxWith(db, ADMIN, { note: 'Keyed twice' }), String(id));

  const log = raw.prepare("SELECT * FROM audit_log WHERE action = 'advance.delete'").get();
  const detail = JSON.parse(log.detail);
  assert.equal(detail.advance.amount, 1000);
  assert.equal(detail.advance.startMonth, '2026-04');
  assert.equal(detail.owed, 750);
  assert.equal(detail.note, 'Keyed twice');
  assert.deepEqual(detail.entries.map((e) => `${e.month}:${e.amount}:${e.note}`),
    ['2026-04:250:April payslip'],
    'so a deletion made in error can be read back and keyed again');
  assert.match(log.actor, /Yaa/);
});

test('they are told where money was still coming off', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  const before = notices(raw).length;

  await removeAdvance(ctxWith(db, ADMIN, { note: 'Already in the ledger' }), String(id));

  const told = notices(raw).slice(before);
  assert.equal(told.length, 1);
  assert.match(told[0].title, /taken off your record/i);
  assert.match(told[0].body, /Nothing more comes off/);
});

test('and not where it was already paid off', async () => {
  const { raw, db } = setup();
  const id = await give(db);
  await addEntry(ctx(db, ADMIN, {
    body: { month: '2026-04', kind: 'repayment', amount: 1000 },
  }), String(id));
  const before = notices(raw).length;

  await removeAdvance(ctxWith(db, ADMIN), String(id));
  assert.equal(notices(raw).length, before, 'nothing was coming off, so there is no news');
});

test('a record nobody has cannot be deleted', async () => {
  const { db } = setup();
  await assert.rejects(() => removeAdvance(ctxWith(db, ADMIN), '999'), /No such advance/);
});

test('deleting one leaves the rest of the person\u2019s account alone', async () => {
  const { db } = setup();
  const first = await give(db);
  const second = await read(await addAdvance(ctx(db, ADMIN, {
    body: { staffId: 1, amount: 400, months: 2, monthly: 200, takenOn: '2026-05-02' },
  })));

  await removeAdvance(ctxWith(db, ADMIN, { note: 'Duplicate' }), String(first));

  const mine = await read(await staffAdvances(ctx(db, ADMIN), '1'));
  assert.equal(mine.advances.length, 1);
  assert.equal(mine.advances[0].id, second.id);
  assert.equal(mine.totals.owed, 400);
});
