import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { readColumns, readSheet, tallyOf } from '../src/lib/pay-import.js';
import { applyInput, payroll, readInput, saveScheme, setProfiles } from '../src/routes/payroll.js';

/**
 * An allowance or a bonus scheme the property has not got yet.
 *
 * A file naming one is the ordinary way a property that already runs it gets
 * it in, so refusing outright sent somebody to a dialog to type what the sheet
 * already said. But making one is a decision, so it is named on the screen and
 * nothing happens until somebody ticks it.
 */

const ONE = [{ id: 1, employee_no: '1', name: 'Kofi', active: 1 }];
const PAID = new Map([[1, { staff_id: 1, basic: 2000, ssnit: 1 }]]);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('a money column names a scheme the file would make', () => {
  const { columns, unknown } = readColumns(['Employee no', 'Bonus: Housing'], { schemes: [] });
  assert.equal(columns[1].kind, 'score');
  assert.equal(columns[1].isNew, true);
  assert.equal(columns[1].scheme.kind, 'amount');
  assert.deepEqual(unknown, []);
});

test('a score column cannot make one, because nothing says what it is worth', () => {
  const { columns, unknown } = readColumns(['Employee no', 'Score: Cleanliness'], { schemes: [] });
  assert.equal(columns.length, 1, 'only the employee number');
  assert.deepEqual(unknown, ['Score: Cleanliness'], 'named back whole, as written');
});

test('what the file would make is listed once, not per line', () => {
  const read = readSheet(
    'Employee no,Bonus: Housing,Allowance: Transport\n1,350,200', { staff: ONE, profiles: PAID },
  );
  assert.deepEqual(read.willCreate.allowances, ['Transport']);
  assert.deepEqual(read.willCreate.schemes, [{ name: 'Housing', kind: 'amount' }]);
  assert.equal(tallyOf(read).creating, 2);
});

test('a figure for a scheme that would be made is a change against its name', () => {
  const read = readSheet('Employee no,Bonus: Housing\n1,350', { staff: ONE, profiles: PAID });
  const [change] = read.lines[0].changes;
  assert.equal(change.schemeId, null);
  assert.equal(change.schemeName, 'Housing');
  assert.equal(change.isNew, true);
  assert.equal(change.to, 350);
});

test('membership is not asked about for a scheme nobody is under yet', () => {
  const read = readSheet('Employee no,Bonus: Housing\n1,350', {
    staff: ONE, profiles: PAID, memberOf: new Map(),
  });
  assert.deepEqual(read.lines[0].notes, [], 'a scheme that does not exist has nobody under it');
});

test('a retired scheme is matched rather than made a second time', () => {
  const read = readSheet('Employee no,Bonus: Housing\n1,350', {
    staff: ONE,
    profiles: PAID,
    schemes: [{ id: 3, name: 'Housing', kind: 'amount', active: false }],
    memberOf: new Map([[1, [3]]]),
  });
  assert.deepEqual(read.willCreate.schemes, []);
  assert.deepEqual(read.lines[0].changes, []);
  assert.match(read.lines[0].notes[0].why, /retired/);
});

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

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
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_scheme; DELETE FROM pay_run;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, name] of [[1, 'Kofi'], [2, 'Ama']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, '2020-01-01')`,
    ).run(id, String(id), name);
  }
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 9, name: 'Kwame', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const MONTH = '2026-09';
const read = async (res) => res.json();
const onPayroll = (db) => setProfiles(ctx(db, {
  body: { rows: [1, 2].map((id) => ({ staffId: id, basic: 2000, ssnit: true })) },
}));

const SHEET = 'Employee no,Bonus: Housing,Allowance: Transport\n1,350,200\n2,500,';

test('without the tick, nothing is made and it says what it left', async () => {
  const { raw, db } = setup();
  await onPayroll(db);

  const out = await read(await applyInput(ctx(db, { body: { month: MONTH, text: SHEET } })));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM pay_scheme').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM pay_allowance').get().n, 0);
  assert.deepEqual(out.notMade.sort(), ['Housing', 'Transport']);
  assert.equal(out.scores, 0);
});

test('with the tick, the scheme is made and everybody named is under it', async () => {
  const { raw, db } = setup();
  await onPayroll(db);

  const out = await read(await applyInput(
    ctx(db, { body: { month: MONTH, text: SHEET, create: true } }),
  ));

  const scheme = raw.prepare('SELECT * FROM pay_scheme').get();
  assert.equal(scheme.name, 'Housing');
  assert.equal(scheme.kind, 'amount');
  assert.match(scheme.note, /spreadsheet/);

  const under = raw.prepare('SELECT staff_id FROM pay_scheme_staff ORDER BY staff_id').all();
  assert.deepEqual(under.map((r) => r.staff_id), [1, 2], 'everybody the file gave a figure for');

  const scores = raw.prepare('SELECT staff_id, score, amount FROM pay_score ORDER BY staff_id').all();
  assert.deepEqual(scores.map((r) => [r.staff_id, r.score, r.amount]), [[1, 100, 350], [2, 100, 500]]);
  assert.deepEqual(out.made.schemes, [{ name: 'Housing', people: 2 }]);
});

test('and the allowance with it', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  await applyInput(ctx(db, { body: { month: MONTH, text: SHEET, create: true } }));

  const rows = raw.prepare('SELECT staff_id, name, amount FROM pay_allowance').all();
  assert.deepEqual(rows.map((r) => [r.staff_id, r.name, r.amount]), [[1, 'Transport', 200]]);
});

test('the money lands on the payslip', async () => {
  const { db } = setup();
  await onPayroll(db);
  await applyInput(ctx(db, { body: { month: MONTH, text: SHEET, create: true } }));

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(out.lines.find((l) => l.staff.name === 'Kofi').bonus.earned, 350);
  assert.equal(out.lines.find((l) => l.staff.name === 'Ama').bonus.earned, 500);
});

test('running it again makes nothing a second time', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  await applyInput(ctx(db, { body: { month: MONTH, text: SHEET, create: true } }));
  const again = await read(await applyInput(
    ctx(db, { body: { month: MONTH, text: SHEET, create: true } }),
  ));

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM pay_scheme').get().n, 1);
  assert.deepEqual(again.made.schemes, [], 'it exists now, so there is nothing to make');
});

test('a scheme that already exists is never made again, tick or no tick', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  await saveScheme(ctx(db, {
    body: { name: 'Housing', amount: 300, kind: 'amount', staffIds: [1] },
  }));

  await applyInput(ctx(db, {
    body: { month: MONTH, text: 'Employee no,Bonus: Housing\n1,350', create: true },
  }));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM pay_scheme').get().n, 1);
  assert.equal(raw.prepare('SELECT amount FROM pay_score').get().amount, 350);
});

test('the preview says what would be made without making it', async () => {
  const { raw, db } = setup();
  await onPayroll(db);

  const out = await read(await readInput(ctx(db, { body: { month: MONTH, text: SHEET } })));
  assert.equal(out.tally.creating, 2);
  assert.deepEqual(out.willCreate.schemes, [{ name: 'Housing', kind: 'amount' }]);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM pay_scheme').get().n, 0);
});
