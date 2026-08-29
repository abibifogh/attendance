import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { readAdvanceSheet, readMonth, readPurpose, tallyOf } from '../src/lib/advance-import.js';
import { advanceTemplate, applyAdvanceImport, readAdvanceImport } from '../src/routes/advances.js';

/**
 * Advances that were already running, brought in as a sheet.
 *
 * A property arriving with eleven of them has them on a spreadsheet. Typing
 * those into a dialog one at a time is an afternoon and eleven chances to
 * mistype a balance, and getting a balance wrong means deducting money
 * somebody has already paid back.
 */

const staff = [
  { id: 1, employee_no: '1', name: 'Kofi', active: 1 },
  { id: 2, employee_no: '2', name: 'Ama', active: 1 },
  { id: 3, employee_no: '3', name: 'Gone', active: 0 },
];

const HEAD = 'Employee no,Name,Amount,Months,Monthly,Taken on,Starts,Purpose,Already repaid';

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

test('a month is read however it was written', () => {
  assert.equal(readMonth('2026-04'), '2026-04');
  assert.equal(readMonth('04/2026'), '2026-04');
  assert.equal(readMonth('April 2026'), '2026-04');
  assert.equal(readMonth('2026-04-15'), '2026-04');
  assert.equal(readMonth(''), null);
  assert.ok(Number.isNaN(readMonth('soon')));
  assert.ok(Number.isNaN(readMonth('2026-13')));
});

test('a purpose has to be one the property offers', () => {
  assert.equal(readPurpose('School fees'), 'school_fees');
  assert.equal(readPurpose('rent'), 'rent');
  assert.equal(readPurpose('Something else'), 'other');
  assert.equal(readPurpose(''), null);
  assert.ok(Number.isNaN(readPurpose('a car')));
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('an advance reads out with its terms and what is left', () => {
  const read = readAdvanceSheet(
    `${HEAD}\n1,Kofi,1200,6,200,2026-03-01,2026-04,Rent,400`, { staff },
  );

  const [line] = read.lines;
  assert.equal(line.staffId, 1);
  assert.equal(line.amount, 1200);
  assert.equal(line.months, 6);
  assert.equal(line.monthly, 200);
  assert.equal(line.takenOn, '2026-03-01');
  assert.equal(line.startMonth, '2026-04');
  assert.equal(line.purpose, 'rent');
  assert.equal(line.repaid, 400);
  assert.equal(line.outstanding, 800);
});

test('the instalment is worked out where the sheet does not say', () => {
  const read = readAdvanceSheet('Employee no,Amount,Months\n1,1200,6', { staff });
  assert.equal(read.lines[0].monthly, 200);
});

test('the months come from the purpose where the sheet does not say', () => {
  const read = readAdvanceSheet('Employee no,Amount,Purpose\n1,3000,School fees', { staff });
  assert.equal(read.lines[0].months, 10, 'ten, which is what school fees are repaid over');
});

test('a number nobody here has is skipped and named', () => {
  const read = readAdvanceSheet('Employee no,Amount\n99,500', { staff });
  assert.equal(read.lines.length, 0);
  assert.match(read.skipped[0].why, /nobody of that number/);
});

test('somebody who has left is skipped', () => {
  const read = readAdvanceSheet('Employee no,Amount\n3,500', { staff });
  assert.match(read.skipped[0].why, /no longer here/);
});

test('a line with no amount is skipped rather than recorded as nothing', () => {
  const read = readAdvanceSheet('Employee no,Name,Amount\n1,Kofi,', { staff });
  assert.equal(read.lines.length, 0);
  assert.match(read.skipped[0].why, /no amount/);
});

test('a cell that cannot be read is a note, and the line still stands', () => {
  const read = readAdvanceSheet(
    `${HEAD}\n1,Kofi,1200,6,200,2026-03-01,whenever,A yacht,`, { staff },
  );
  const [line] = read.lines;
  assert.equal(line.amount, 1200);
  assert.deepEqual(line.notes.map((n) => n.what).sort(), ['Purpose', 'Starts']);
});

test('repaid more than the advance is refused rather than believed', () => {
  const read = readAdvanceSheet(`${HEAD}\n1,Kofi,1200,6,200,2026-03-01,2026-04,Rent,5000`, { staff });
  assert.equal(read.lines[0].repaid, 0);
  assert.match(read.lines[0].notes[0].why, /more than the advance/);
});

test('the same advance twice in one file is caught', () => {
  const read = readAdvanceSheet(
    'Employee no,Amount,Taken on\n1,1200,2026-03-01\n1,1200,2026-03-01', { staff },
  );
  assert.equal(read.lines.length, 1);
  assert.match(read.skipped[0].why, /already on the books/);
});

test('one already on the books is left alone', () => {
  const read = readAdvanceSheet('Employee no,Amount,Taken on\n1,1200,2026-03-01', {
    staff,
    open: [{ staff_id: 1, amount: 1200, taken_on: '2026-03-01' }],
  });
  assert.equal(read.lines.length, 0);
  assert.equal(tallyOf(read).nothing, true);
});

test('a different amount on the same day is a different advance', () => {
  const read = readAdvanceSheet('Employee no,Amount,Taken on\n1,900,2026-03-01', {
    staff,
    open: [{ staff_id: 1, amount: 1200, taken_on: '2026-03-01' }],
  });
  assert.equal(read.lines.length, 1);
});

test('a sheet with no amount column says what it needs', () => {
  const read = readAdvanceSheet('Employee no,Name\n1,Kofi', { staff });
  assert.deepEqual(read.missingColumns, ['an amount column']);
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
  raw.exec('DELETE FROM att_staff; DELETE FROM hr_advance;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, name] of [[1, 'Kofi'], [2, 'Ama']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, '2020-01-01')`,
    ).run(id, String(id), name);
  }
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 9, name: 'Kwame', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/advances/import'),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const SHEET = `${HEAD}
1,Kofi,1200,6,200,2026-03-01,2026-04,Rent,400
2,Ama,600,3,200,2026-05-10,2026-06,Something else,`;

test('a sheet of advances lands on the books', async () => {
  const { raw, db } = setup();
  const out = await (await applyAdvanceImport(ctx(db, { text: SHEET }))).json();

  assert.equal(out.added, 2);
  assert.equal(out.opened, 2);
  assert.deepEqual(out.failed, []);

  const rows = raw.prepare('SELECT * FROM hr_advance ORDER BY staff_id').all();
  assert.equal(rows[0].amount, 1200);
  assert.equal(rows[0].status, 'approved');
  assert.equal(rows[0].start_month, '2026-04');
  assert.equal(rows[0].purpose, 'rent');
  assert.match(rows[0].decision, /spreadsheet/, 'the books say where it came from');
});

test('what was already repaid goes on as one adjustment, not invented months', async () => {
  const { raw, db } = setup();
  await applyAdvanceImport(ctx(db, { text: SHEET }));

  const entries = raw.prepare('SELECT * FROM hr_advance_entry').all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'adjustment');
  assert.equal(entries[0].amount, 400);
  assert.equal(entries[0].source, 'import');
  assert.match(entries[0].note, /before this was brought into HIVE/);
});

test('one repaid in full arrives settled rather than owing nothing forever', async () => {
  const { raw, db } = setup();
  await applyAdvanceImport(ctx(db, {
    text: `${HEAD}\n1,Kofi,1200,6,200,2026-03-01,2026-04,Rent,1200`,
  }));
  assert.equal(raw.prepare('SELECT status FROM hr_advance').get().status, 'settled');
});

test('running the same sheet twice records nothing twice', async () => {
  const { raw, db } = setup();
  await applyAdvanceImport(ctx(db, { text: SHEET }));
  const again = await (await applyAdvanceImport(ctx(db, { text: SHEET }))).json();

  assert.equal(again.added, 0);
  assert.equal(again.skipped.length, 2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_advance').get().n, 2);
});

test('nobody is told, whatever the sheet holds', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO users (id, name, role, active, staff_id) VALUES (5, 'Kofi', 'staff', 1, 1)")
    .run();
  await applyAdvanceImport(ctx(db, { text: SHEET }));

  const notices = raw.prepare("SELECT COUNT(*) n FROM app_notices WHERE kind LIKE 'advance%'").get();
  assert.equal(notices.n, 0, 'an advance running since March is not news to anybody');
});

test('the preview writes nothing', async () => {
  const { raw, db } = setup();
  const out = await (await readAdvanceImport(ctx(db, { text: SHEET }))).json();
  assert.equal(out.tally.adding, 2);
  assert.equal(out.tally.outstanding, 1400);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_advance').get().n, 0);
});

test('an empty file is refused', async () => {
  const { db } = setup();
  await assert.rejects(() => applyAdvanceImport(ctx(db, { text: '  ' })), /nothing in that file/i);
});

test('a sheet with no amount column is refused at the write too', async () => {
  const { db } = setup();
  await assert.rejects(
    () => applyAdvanceImport(ctx(db, { text: 'Employee no,Name\n1,Kofi' })),
    /amount/i,
  );
});

test('the template carries the property’s own running advances', async () => {
  const { db } = setup();
  await applyAdvanceImport(ctx(db, { text: SHEET }));

  const body = await (await advanceTemplate(ctx(db))).text();
  const lines = body.trim().split('\n');
  assert.match(lines[0], /Employee no,Name,Amount/);
  assert.equal(lines.length, 3);
  assert.match(lines.join(' '), /400\.00/, 'what has already come off is on it');
});

test('a property with none yet is shown an example', async () => {
  const { db } = setup();
  const body = await (await advanceTemplate(ctx(db))).text();
  assert.equal(body.trim().split('\n').length, 2);
  assert.match(body, /example/i);
});

test('a round trip through the template records nothing new', async () => {
  const { db } = setup();
  await applyAdvanceImport(ctx(db, { text: SHEET }));

  const sheet = await (await advanceTemplate(ctx(db))).text();
  const read = await (await readAdvanceImport(ctx(db, { text: sheet }))).json();
  assert.equal(read.tally.nothing, true, 'what came down is what is already here');
});
