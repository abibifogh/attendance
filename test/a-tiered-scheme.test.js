import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { hasTiers, readTiers, sayTiers, tierAmount, tierScores } from '../src/lib/pay-tiers.js';
import {
  applyInput, copyRun, payroll, readInput, saveScheme, setProfiles, setScores,
} from '../src/routes/payroll.js';

/**
 * A bonus scheme paid by tier.
 *
 * Nkosoɔ is scored one to ten and every score is worth a stated amount: a 1 is
 * seventy cedis, a 4 is a hundred and thirty, a 10 is two hundred and fifty.
 * Neither of the two shapes already here fits it, and forcing it through the
 * scored one meant working out what per cent of 250 comes to 130 every month
 * for everybody.
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

const WAGES = { user: { id: 3, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (response) => response.json();
const MONTH = '2026-09';

/** The table from the picture: one to ten, seventy up to two hundred and fifty. */
const NKOSOO = [...Array(10)].map((_, i) => ({ score: i + 1, amount: 70 + i * 20 }));

// ---------------------------------------------------------------------------
// The ladder itself
// ---------------------------------------------------------------------------

test('a table is read in order, with nothing said twice', () => {
  const table = readTiers([
    { score: 3, amount: 110 }, { score: 1, amount: 70 },
    { score: 3, amount: 999 }, { score: 2, amount: 90 },
  ]);
  assert.deepEqual(table, [
    { score: 1, amount: 70 }, { score: 2, amount: 90 }, { score: 3, amount: 999 },
  ], 'sorted, and the later row for a 3 is the one that stands');
});

test('rubbish in a table is dropped rather than stored as nought', () => {
  assert.deepEqual(readTiers([
    { score: 1, amount: 70 }, { score: 'x', amount: 90 }, { score: 2, amount: 'y' },
    { score: -1, amount: 50 }, null,
  ]), [{ score: 1, amount: 70 }]);
  assert.deepEqual(readTiers('not json'), []);
  assert.deepEqual(readTiers(null), []);
});

test('a score is worth what its rung says, and nothing between rungs', () => {
  assert.equal(tierAmount(NKOSOO, 1), 70);
  assert.equal(tierAmount(NKOSOO, 4), 130);
  assert.equal(tierAmount(NKOSOO, 10), 250);
  assert.equal(tierAmount(NKOSOO, 11), null, 'a score the table has never heard of');
  assert.equal(tierAmount(NKOSOO, 4.5), null, 'and no inventing a figure between two of them');
  assert.equal(tierAmount([], 1), null);
});

test('the table says itself in a line', () => {
  assert.equal(sayTiers(NKOSOO), '10 scores, 1 at 70 up to 10 at 250');
  assert.equal(sayTiers([{ score: 3, amount: 500 }]), 'one score, 3, worth 500');
  assert.equal(sayTiers([]), 'no scores set yet');
  assert.deepEqual(tierScores(NKOSOO), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(hasTiers(NKOSOO), true);
  assert.equal(hasTiers([]), false);
});

// ---------------------------------------------------------------------------
// Setting one up
// ---------------------------------------------------------------------------

async function nkosoo(db, tiers = NKOSOO) {
  const made = await read(await saveScheme(ctx(db, WAGES, {
    body: {
      name: 'Nkosoɔ', amount: 250, kind: 'tier', tiers,
      departments: [], staffIds: [1, 2],
    },
  })));
  return made.id;
}

const onPayroll = (db) => setProfiles(ctx(db, WAGES, {
  body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }, { staffId: 2, basic: 2000, ssnit: true }] },
}));

test('a tiered scheme keeps its table', async () => {
  const { db } = setup();
  await nkosoo(db);
  const data = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  const scheme = data.schemes[0];
  assert.equal(scheme.kind, 'tier');
  assert.deepEqual(scheme.tiers, NKOSOO);
});

test('and one with no table is refused rather than saved empty', async () => {
  const { db } = setup();
  await assert.rejects(
    () => saveScheme(ctx(db, WAGES, {
      body: { name: 'Empty', amount: 100, kind: 'tier', tiers: [], departments: [], staffIds: [] },
    })),
    /scores and what each one is worth/i,
  );
});

// ---------------------------------------------------------------------------
// Scoring somebody on it
// ---------------------------------------------------------------------------

test('a score picks a rung and the rung says the money', async () => {
  const { raw, db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);

  await setScores(ctx(db, WAGES, {
    body: { month: MONTH, rows: [{ schemeId: id, staffId: 1, score: 4 }] },
  }));

  const row = raw.prepare('SELECT score, amount, tier FROM pay_score').get();
  assert.equal(row.tier, 4, 'the rung is kept, not worked back out of the money');
  assert.equal(row.amount, 130);
  assert.equal(row.score, 100, 'and the award lands the same way every other kind does');
});

test('the bonus on the payslip is what that rung is worth', async () => {
  const { db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);
  await setScores(ctx(db, WAGES, {
    body: { month: MONTH, rows: [{ schemeId: id, staffId: 1, score: 4 }] },
  }));

  const data = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  const line = data.lines.find((l) => l.staff.id === 1);
  assert.equal(line.bonus.earned, 130);
  assert.equal(line.bonus.schemes[0].amount, 130);
});

test('a score the table does not pay for is refused, not rounded', async () => {
  const { db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);

  await assert.rejects(
    () => setScores(ctx(db, WAGES, {
      body: { month: MONTH, rows: [{ schemeId: id, staffId: 1, score: 11 }] },
    })),
    /not one of the scores/i,
  );
  await assert.rejects(
    () => setScores(ctx(db, WAGES, {
      body: { month: MONTH, rows: [{ schemeId: id, staffId: 1, score: 4.5 }] },
    })),
    /not one of the scores/i,
    'a 5 paid what a 6 was promised is worse than being told to look again',
  );
});

test('the screen is sent the rung as well as the money', async () => {
  const { db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);
  await setScores(ctx(db, WAGES, {
    body: { month: MONTH, rows: [{ schemeId: id, staffId: 1, score: 7 }] },
  }));

  const data = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  const mine = data.schemes[0].scores.find((s) => s.staffId === 1);
  assert.equal(mine.tier, 7);
  assert.equal(mine.award, 190);
  const theirs = data.schemes[0].scores.find((s) => s.staffId === 2);
  assert.equal(theirs.tier, null, 'and nought is told apart from not scored yet');
});

// ---------------------------------------------------------------------------
// Next month
// ---------------------------------------------------------------------------

test('starting a month from the one before carries the rung', async () => {
  const { db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);
  await setScores(ctx(db, WAGES, {
    body: { month: '2026-09', rows: [{ schemeId: id, staffId: 1, score: 4 }] },
  }));

  await copyRun(ctx(db, WAGES, { body: { month: '2026-10', from: '2026-09' } }));

  const data = await read(await payroll(ctx(db, WAGES, { query: '?month=2026-10' })));
  const mine = data.schemes[0].scores.find((s) => s.staffId === 1);
  assert.equal(mine.tier, 4);
  assert.equal(mine.award, 130);
});

test('and looks the money up again, so a table moved since pays the new figure', async () => {
  const { db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);
  await setScores(ctx(db, WAGES, {
    body: { month: '2026-09', rows: [{ schemeId: id, staffId: 1, score: 4 }] },
  }));

  // Every rung goes up by fifty from now on.
  await saveScheme(ctx(db, WAGES, {
    body: {
      id, name: 'Nkosoɔ', amount: 300, kind: 'tier',
      tiers: NKOSOO.map((t) => ({ ...t, amount: t.amount + 50 })),
      departments: [], staffIds: [1, 2],
    },
  }));
  await copyRun(ctx(db, WAGES, { body: { month: '2026-10', from: '2026-09' } }));

  const now = await read(await payroll(ctx(db, WAGES, { query: '?month=2026-10' })));
  assert.equal(now.schemes[0].scores.find((s) => s.staffId === 1).award, 180);

  const then = await read(await payroll(ctx(db, WAGES, { query: '?month=2026-09' })));
  assert.equal(then.schemes[0].scores.find((s) => s.staffId === 1).award, 130,
    'and September still says what September paid');
});

// ---------------------------------------------------------------------------
// Out of a spreadsheet
// ---------------------------------------------------------------------------

test('a column of rungs goes in from a sheet', async () => {
  const { raw, db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);

  const text = 'Employee no,Score: Nkosoɔ\n1,4\n2,9';
  const preview = await read(await readInput(ctx(db, WAGES, { body: { month: MONTH, text } })));
  assert.deepEqual(preview.unknown, []);
  assert.equal(preview.lines[0].changes[0].to, 4);
  assert.equal(preview.lines[0].changes[0].worth, 130, 'the preview says the money, not just a 4');

  await applyInput(ctx(db, WAGES, { body: { month: MONTH, text } }));
  const rows = raw.prepare('SELECT staff_id, tier, amount FROM pay_score ORDER BY staff_id').all();
  assert.deepEqual(rows.map((r) => `${r.staff_id}:${r.tier}:${r.amount}`), ['1:4:130', '2:9:230']);
});

test('a rung the table does not pay for is named rather than applied', async () => {
  const { db } = setup();
  await nkosoo(db);
  await onPayroll(db);

  const preview = await read(await readInput(ctx(db, WAGES, {
    body: { month: MONTH, text: 'Employee no,Score: Nkosoɔ\n1,12' },
  })));
  assert.deepEqual(preview.lines[0].changes, []);
  assert.match(preview.lines[0].notes[0].why, /not one of its scores/);
  assert.match(preview.lines[0].notes[0].why, /1, 2, 3/, 'and says which ones it does pay for');
});

test('the template writes the rung, blank where nobody has picked one', async () => {
  const { db } = setup();
  const id = await nkosoo(db);
  await onPayroll(db);
  await setScores(ctx(db, WAGES, {
    body: { month: MONTH, rows: [{ schemeId: id, staffId: 1, score: 6 }] },
  }));

  const { inputTemplate } = await import('../src/routes/payroll.js');
  const csv = await (await inputTemplate(ctx(db, WAGES, { query: `?month=${MONTH}` }))).text();
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /Score: Nkoso/);
  assert.match(lines[1], /,6$|,6,/, 'Ama is on a 6');
  assert.match(lines[2], /,,|,$/, 'and Kofi has not been scored');
});
