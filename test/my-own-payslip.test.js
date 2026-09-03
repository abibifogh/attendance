import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  closeRun, myPayslips, payslip, reopenRun, saveScheme, setProfiles, setScores,
} from '../src/routes/payroll.js';
import { PAGE_W, widthScale } from '../public/js/views/letter-paper.js';

/**
 * Somebody's own payslips.
 *
 * There was no way for a member of staff to see one. The only route to a
 * payslip wanted the payroll permission, a PIN and an administrator on top,
 * which is right for reading a colleague's and the wrong end of the building
 * for reading your own.
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
  for (const [id, name] of [[1, 'Ama Boateng'], [2, 'Kofi Mensah']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
    ).run(id, String(id), name);
  }
  return { raw, db: d1(raw) };
}

const WAGES = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
/** A member of staff, signed in as themselves and nothing more. */
const asStaff = (staffId) => ({
  user: { id: 20 + staffId, name: 'Them', role: 'staff', staff_id: staffId },
  permissions: ['att_me'],
});
const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/payslips${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (response) => response.json();

/** Everybody on the payroll, under one scheme. Done once per database. */
async function onThePayroll(db) {
  await setProfiles(ctx(db, WAGES, {
    body: {
      rows: [
        { staffId: 1, basic: 2000, ssnit: true },
        { staffId: 2, basic: 1200, ssnit: true },
      ],
    },
  }));
  return read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Nkosoɔ', amount: 400, departments: [], staffIds: [1, 2] },
  })));
}

async function closeMonth(db, month, scheme) {
  await setScores(ctx(db, WAGES, {
    body: { month, rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] },
  }));
  await closeRun(ctx(db, WAGES, { body: { month } }));
}

async function aClosedMonth(db, month) {
  await closeMonth(db, month, await onThePayroll(db));
}

test('a login that is nobody in particular is told so', async () => {
  const { db } = setup();
  const data = await read(await myPayslips(ctx(db, {
    user: { id: 5, name: 'Nobody', role: 'staff' }, permissions: ['att_me'],
  })));
  assert.equal(data.linked, false);
  assert.deepEqual(data.months, []);
  assert.equal(data.line, null);
});

test('nothing shows before a month has been closed', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, WAGES, { body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }] } }));
  const data = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.equal(data.linked, true);
  assert.deepEqual(data.months, [], 'a draft moves, so it is not shown');
  assert.equal(data.line, null);
});

test('a closed month is there, with the working behind it', async () => {
  const { db } = setup();
  await aClosedMonth(db, '2026-07');

  const data = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.equal(data.months.length, 1);
  assert.equal(data.months[0].month, '2026-07');
  assert.equal(data.month, '2026-07');
  assert.equal(data.line.staff.name, 'Ama Boateng');
  assert.equal(data.line.basic, 2000);
  assert.ok(data.line.bonus.net > 0);
  assert.equal(data.months[0].net, data.line.net);
});

test('the newest is the one that opens, and another can be asked for', async () => {
  const { db } = setup();
  const scheme = await onThePayroll(db);
  await closeMonth(db, '2026-06', scheme);
  await closeMonth(db, '2026-07', scheme);

  const latest = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.deepEqual(latest.months.map((m) => m.month), ['2026-07', '2026-06'], 'newest first');
  assert.equal(latest.month, '2026-07');

  const older = await read(await myPayslips(ctx(db, asStaff(1), { query: '?month=2026-06' })));
  assert.equal(older.month, '2026-06');
  assert.equal(older.line.staff.name, 'Ama Boateng');
});

test('a month asked for that is not theirs falls back to their own newest', async () => {
  const { db } = setup();
  await aClosedMonth(db, '2026-07');
  const data = await read(await myPayslips(ctx(db, asStaff(1), { query: '?month=2019-01' })));
  assert.equal(data.month, '2026-07', 'not an error, and not somebody else’s month');
});

test('nobody sees anybody else, whatever is in the address', async () => {
  const { db } = setup();
  await aClosedMonth(db, '2026-07');

  const mine = await read(await myPayslips(ctx(db, asStaff(2), { query: '?staffId=1&month=2026-07' })));
  assert.equal(mine.line.staff.name, 'Kofi Mensah');
  assert.equal(mine.line.basic, 1200, 'their own basic, not the one they asked for');
});

test('reopening a month takes it back off their screen', async () => {
  const { db } = setup();
  await aClosedMonth(db, '2026-07');
  assert.equal((await read(await myPayslips(ctx(db, asStaff(1))))).months.length, 1);

  await reopenRun(ctx(db, WAGES, { body: { month: '2026-07' } }));
  const data = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.deepEqual(data.months, [], 'it is being worked on again, so it is not a payslip yet');
});

test('it is the same slip the payroll would print', async () => {
  const { db } = setup();
  await aClosedMonth(db, '2026-07');

  const theirs = await read(await myPayslips(ctx(db, asStaff(1))));
  const ours = await read(await payslip(ctx(db, WAGES, { query: '?month=2026-07' }), 1));

  assert.equal(theirs.line.gross, ours.line.gross);
  assert.equal(theirs.line.net, ours.line.net);
  assert.equal(theirs.line.paye.total, ours.line.paye.total);
  assert.deepEqual(theirs.line.slip, ours.line.slip);
});

test('the slip carries the table it was worked out on', async () => {
  const { db } = setup();
  await aClosedMonth(db, '2026-07');
  const data = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.ok(data.rates, 'so a slip read next year shows last year’s percentages');
  assert.equal(data.rates.ssnitEmployee, data.line.rates.ssnitEmployee);
});

test('a slip from here is never stamped draft', async () => {
  const { db } = setup();
  await aClosedMonth(db, '2026-07');
  const data = await read(await myPayslips(ctx(db, asStaff(1))));
  // The paper reads this to decide whether to stamp itself and to warn that
  // the figures can still move. Only closed months are ever returned here,
  // and unsaid it defaulted to draft.
  assert.equal(data.status, 'final');
  assert.ok(data.closedAt, 'and it says when it was closed');
});

// ---------------------------------------------------------------------------
// And it has to fit the screen it is read on
// ---------------------------------------------------------------------------

/**
 * A payslip is a sheet of A4, 794 pixels across, and a phone is not.
 *
 * Shown at full size in a box a third as wide, what a reader got was the
 * left-hand third of the document: every label with no figure beside it, and
 * "NET PAY" with nothing after it. The one number the whole page exists to say
 * was off the right-hand edge, and the only way to it was to drag the paper
 * sideways. So the sheet is scaled to whatever room there is.
 */
test('the sheet is scaled to the room, and never past full size', () => {
  // A handset, and the third of the document a reader used to be left with.
  assert.ok(widthScale(358) < 0.5);
  assert.equal(Math.round(PAGE_W * widthScale(358)), 358, 'it comes out exactly the width there is');
  assert.equal(Math.round(PAGE_W * widthScale(288)), 288);

  // A desk is the size the sheet already is, and anything wider leaves it
  // alone: a payslip blown up stops matching the paper it prints on.
  assert.equal(widthScale(PAGE_W), 1);
  assert.equal(widthScale(2000), 1);

  // Asked before the box is in the document, or in a print stylesheet that has
  // taken the width off, the answer is full size rather than nothing.
  assert.equal(widthScale(0), 1);
  assert.equal(widthScale(undefined), 1);
  assert.equal(widthScale(Number.NaN), 1);
});

test('my payslips scales the sheet rather than scrolling it', () => {
  const view = readFileSync('public/js/views/att-my-payslips.js', 'utf8');
  assert.match(view, /fitToWidth\(page\)/, 'the page is wrapped in something that scales');
  assert.match(view, /paper\.fit\(\)/, 'and fitted once it is in the document');
  assert.match(view, /'div\.slip-mine-paper', paper\.box/, 'the wrapper is what goes on the screen');

  const paper = readFileSync('public/js/views/payslip.js', 'utf8');
  // Turning the phone changes the room, and the listener has to let go once
  // the page is gone or every month chosen leaves another one behind.
  assert.match(paper, /addEventListener\('resize', again\)/);
  assert.match(paper, /if \(!box\.isConnected\)/);
});
