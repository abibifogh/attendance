import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { addAdvance, advances, closeMonth, reopenMonth } from '../src/routes/advances.js';
import { closeRun, reopenRun, setProfiles } from '../src/routes/payroll.js';

/**
 * Taking the closed-off mark back off a month.
 *
 * A month gets closed off in a hurry on the last day of it and somebody then
 * finds a deduction that never happened. The mark used to be permanent, so the
 * only way on was to leave a wrong figure standing.
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

const WAGES = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/advances${query}`),
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

test('a month closed off can be opened back up', async () => {
  const { db } = setup();
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  await closeMonth(ctx(db, { body: { month: MONTH, rows: [{ advanceId: given.id, amount: 200 }] } }));

  const shut = await read(await advances(ctx(db, { query: `?month=${MONTH}` })));
  assert.ok(shut.closed, 'closed off to begin with');

  const out = await read(await reopenMonth(ctx(db, { body: { month: MONTH } })));
  assert.equal(out.ok, true);

  const open = await read(await advances(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(open.closed, null, 'and open again');
});

test('opening it back up takes nothing off the ledger', async () => {
  // The reasonable expectation of a button called "Open it back up" is that
  // everything goes back to how it was. Taking money back off a ledger as a
  // side effect of that would be the worst thing this could do.
  const { raw, db } = setup();
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  await closeMonth(ctx(db, { body: { month: MONTH, rows: [{ advanceId: given.id, amount: 200 }] } }));

  const out = await read(await reopenMonth(ctx(db, { body: { month: MONTH } })));
  assert.equal(out.kept, 1, 'and it says how many it left standing');

  const entries = raw.prepare('SELECT * FROM hr_advance_entry WHERE advance_id = ?').all(given.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 200);
  assert.equal(
    raw.prepare('SELECT amount FROM hr_advance WHERE id = ?').get(given.id).amount, 600,
  );
});

test('a month that was never closed off is refused rather than reported as done', async () => {
  const { db } = setup();
  await assert.rejects(
    () => reopenMonth(ctx(db, { body: { month: MONTH } })),
    (err) => /has not been closed off/i.test(err.message ?? String(err)),
  );
});

test('a month has to be named', async () => {
  const { db } = setup();
  await assert.rejects(
    () => reopenMonth(ctx(db, { body: {} })),
    (err) => /which month/i.test(err.message ?? String(err)),
  );
});

test('it goes on the audit log, because a period being unlocked is worth a trail', async () => {
  const { raw, db } = setup();
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  await closeMonth(ctx(db, { body: { month: MONTH, rows: [{ advanceId: given.id, amount: 200 }] } }));
  await reopenMonth(ctx(db, { body: { month: MONTH } }));

  const row = raw.prepare("SELECT * FROM audit_log WHERE action = 'advance.reopen_month'").get();
  assert.ok(row, 'the unlocking is on the log');
  assert.equal(row.entity, MONTH);
  assert.match(row.actor, /Yaa/);
});

// ---------------------------------------------------------------------------
// And the mark the payroll sets
// ---------------------------------------------------------------------------

test('reopening the payroll opens the advances month it closed off', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: true, bonusIsNet: false }] },
  }));
  await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));

  await closeRun(ctx(db, { body: { month: MONTH } }));
  assert.ok((await read(await advances(ctx(db, { query: `?month=${MONTH}` })))).closed);

  await reopenRun(ctx(db, { body: { month: MONTH } }));
  assert.equal(
    (await read(await advances(ctx(db, { query: `?month=${MONTH}` })))).closed,
    null,
    'the payroll takes its own mark back with it',
  );
});

test('but it leaves a month somebody closed off by hand alone', async () => {
  // Their answer, not the payroll's, and the same rule that leaves their
  // repayments alone leaves this alone too.
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: true, bonusIsNet: false }] },
  }));
  const given = await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-07-05', startMonth: '2026-07',
      purpose: 'other',
    },
  })));
  await closeMonth(ctx(db, {
    body: { month: MONTH, rows: [{ advanceId: given.id, amount: 200 }], note: 'Done by hand' },
  }));
  await closeRun(ctx(db, { body: { month: MONTH } }));
  await reopenRun(ctx(db, { body: { month: MONTH } }));

  const after = await read(await advances(ctx(db, { query: `?month=${MONTH}` })));
  assert.ok(after.closed, 'still closed off, because a person closed it');
  assert.equal(after.closed.note, 'Done by hand');
});
