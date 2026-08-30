import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { BANDS, RATES, bonusTaxOn, grossUpBonus, payeOn, ratesFrom, ssnitOn } from '../src/lib/tax.js';
import { computeLine, totalsOf } from '../src/lib/payroll.js';
import {
  addPenalty, closeRun, copyRun, payroll, payslip, reopenRun, saveScheme, setProfiles,
  setScores,
} from '../src/routes/payroll.js';
import { addAdvance, advances } from '../src/routes/advances.js';

/**
 * The payroll, against Ghana's tax law.
 *
 * Every figure below can be worked out on paper in a minute, because these are
 * the numbers that end up on a payslip somebody is handed. Where a case cannot
 * be checked by hand it is not worth asserting.
 *
 * The bands are the GRA's monthly graduated rates: 490 free, then 110 at 5%,
 * 130 at 10%, 3,166.67 at 17.5%, and so on. SSNIT is 5.5% from the worker and
 * 13% from the employer on basic salary. A bonus is taxed at 5% as a final tax
 * up to 15% of annual basic, and at the graduated rates above that.
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
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Ama', 'staff', 'x', 1, 1)",
  ).run();
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
const rates = ratesFrom({});

// ---------------------------------------------------------------------------
// The tax itself
// ---------------------------------------------------------------------------

test('PAYE is the graduated bands, added up', () => {
  assert.equal(payeOn(490).tax, 0, 'the first 490 is free');
  assert.equal(payeOn(600).tax, 5.5, 'the next 110 at 5%');
  assert.equal(payeOn(730).tax, 18.5, 'and the next 130 at 10%');
  // 490 free + 110 at 5% (5.50) + 130 at 10% (13) + 270 at 17.5% (47.25).
  assert.equal(payeOn(1000).tax, 65.75);
  assert.equal(payeOn(2390).tax, 309);
  assert.equal(payeOn(0).tax, 0);

  const steps = payeOn(1000).steps;
  assert.deepEqual(steps.map((s) => s.rate), [0, 0.05, 0.1, 0.175]);
  assert.equal(steps.at(-1).amount, 270, 'and the working can be shown');
});

test('SSNIT is 5.5 and 13 per cent of basic, or nothing at all', () => {
  assert.deepEqual(ssnitOn(2000, { rates: RATES }), { employee: 110, employer: 260 });
  assert.deepEqual(ssnitOn(2000, { qualifies: false, rates: RATES }), { employee: 0, employer: 0 });
});

test('a bonus inside the 15% ceiling is taxed at 5% and goes no further', () => {
  const context = { chargeable: 2390, annualBasic: 24000, alreadyPaid: 0, rates };
  const out = bonusTaxOn(1000, context);

  assert.equal(out.headroom, 3600, '15% of 24,000');
  assert.equal(out.atFinalRate, 1000);
  assert.equal(out.atGraduated, 0);
  assert.equal(out.tax, 50);
});

test('the part of a bonus above the ceiling joins the salary and is taxed with it', () => {
  const context = { chargeable: 2390, annualBasic: 24000, alreadyPaid: 3400, rates };
  const out = bonusTaxOn(1000, context);

  assert.equal(out.headroom, 200, 'most of the year’s allowance is gone');
  assert.equal(out.atFinalRate, 200);
  assert.equal(out.atGraduated, 800);
  // 200 at 5% is 10; 800 on top of 2,390 is all inside the 17.5% band, 140.
  assert.equal(out.final, 10);
  assert.equal(out.graduated, 140);
  assert.equal(out.tax, 150);
});

test('grossing up gives back exactly what was promised', () => {
  const context = { chargeable: 2390, annualBasic: 24000, alreadyPaid: 0, rates };
  const out = grossUpBonus(400, context);

  assert.equal(out.gross, 421.05, '400 ÷ 0.95');
  assert.equal(out.tax, 21.05);

  // And where the 5% rate has run out, at the marginal band instead.
  const spent = grossUpBonus(400, { ...context, alreadyPaid: 3600 });
  assert.equal(spent.gross, 484.85, '400 ÷ 0.825');
  assert.equal(Math.round((spent.gross - spent.tax) * 100) / 100, 400,
    'whatever the band, the person is left with what was agreed');
});

test('a bonus that crosses a band mid-way still grosses up exactly', () => {
  // Chargeable of 3,800 sits just under the 25% band, which starts at 3,896.67.
  const context = { chargeable: 3800, annualBasic: 12000, alreadyPaid: 1500, rates };
  const out = grossUpBonus(500, context);
  assert.equal(Math.round((out.gross - out.tax) * 100) / 100, 500);
  assert.ok(out.atGraduated > 0 && out.graduated > 0, 'part of it is at the graduated rates');
});

// ---------------------------------------------------------------------------
// One person's month
// ---------------------------------------------------------------------------

test('a month, worked out end to end', () => {
  const line = computeLine({
    staff: { id: 1, name: 'Ama' },
    basic: 2000,
    allowances: [{ name: 'Transport', amount: 300 }, { name: 'Meals', amount: 200 }],
    ssnit: true,
    schemes: [{ id: 1, name: 'Front office', amount: 500, score: 80 }],
    penalties: [{ amount: 100, reason: 'Late three times' }],
    loans: [{ advanceId: 3, amount: 200 }],
    rates,
  });

  // The bonus: 500 at 80% is 400, less 100 docked, is 300 in hand.
  assert.equal(line.bonus.earned, 400);
  assert.equal(line.bonus.docked, 100);
  assert.equal(line.bonus.net, 300);

  // The 5% rate reaches 15% of the month's basic, which is 300. Grossing 300
  // up puts a little of it over that line, so the last 18.18 goes through the
  // bands rather than at 5%.
  assert.equal(line.bonus.ceiling, 300);
  assert.equal(line.bonus.atFinalRate, 300);
  assert.equal(line.bonus.atGraduated, 18.18);
  assert.equal(line.bonus.gross, 318.18);

  // The salary: 2,500 gross, 110 to SSNIT, 309 of PAYE on it.
  assert.equal(line.gross, 2818.18);
  assert.equal(line.ssnit.employee, 110);
  assert.equal(line.chargeable, 2408.18, '2,390 of salary and the bonus over the ceiling');
  assert.equal(line.paye.onSalary, 309);
  assert.equal(line.paye.total, 327.18);

  // And what is left: salary net 2,081, plus the 300 bonus, less the advance.
  // The person gets what they were promised whatever the ceiling does; it is
  // the property's cost that moves.
  assert.equal(line.net, 2181);
  assert.equal(line.ssnit.employer, 260);
  assert.equal(line.employerCost, 3078.18);
});

test('the person gets the bonus they were promised, whatever the tax does', () => {
  const without = computeLine({ basic: 2000, allowances: [], ssnit: true, rates });
  const with400 = computeLine({
    basic: 2000,
    allowances: [],
    ssnit: true,
    schemes: [{ name: 'Service', amount: 400, score: 100 }],
    rates,
  });
  assert.equal(Math.round((with400.net - without.net) * 100) / 100, 400,
    'the whole point of grossing up');
});

test('a deduction bigger than the bonus does not eat into the salary', () => {
  const line = computeLine({
    basic: 1500,
    allowances: [],
    ssnit: true,
    schemes: [{ name: 'Service', amount: 200, score: 50 }],
    penalties: [{ amount: 400, reason: 'Broke a fridge' }],
    rates,
  });

  assert.equal(line.bonus.earned, 100);
  assert.equal(line.bonus.net, 0, 'nothing, and not less than nothing');
  assert.equal(line.bonus.notTaken, 300, 'and what could not be taken is said out loud');

  const plain = computeLine({ basic: 1500, allowances: [], ssnit: true, rates });
  assert.equal(line.net, plain.net, 'the salary is untouched');
});

test('somebody outside SSNIT pays no contribution and costs the property less', () => {
  const inside = computeLine({ basic: 2000, allowances: [], ssnit: true, rates });
  const outside = computeLine({ basic: 2000, allowances: [], ssnit: false, rates });

  assert.equal(outside.ssnit.employee, 0);
  assert.equal(outside.ssnit.employer, 0);
  assert.equal(outside.chargeable, 2000, 'nothing comes off before tax');
  assert.ok(outside.paye.total > inside.paye.total, 'so more of it is taxed');
  assert.equal(outside.employerCost, 2000);
});

test('an untaxed allowance is paid but not charged', () => {
  const line = computeLine({
    basic: 1000,
    allowances: [{ name: 'Fuel receipts', amount: 300, taxable: false }],
    ssnit: true,
    rates,
  });

  assert.equal(line.gross, 1300);
  assert.equal(line.chargeable, 945, '1,000 less 55 of SSNIT — the 300 is not in it');
  assert.equal(line.freeAllowance, 300);
});

test('what a run comes to is the sum of its lines', () => {
  const lines = [
    computeLine({ basic: 2000, allowances: [], ssnit: true, rates }),
    computeLine({ basic: 1000, allowances: [], ssnit: false, rates }),
  ];
  const totals = totalsOf(lines);
  assert.equal(totals.people, 2);
  assert.equal(totals.basic, 3000);
  assert.equal(totals.ssnitEmployer, 260);
  assert.equal(totals.cost, Math.round((lines[0].employerCost + lines[1].employerCost) * 100) / 100);
});

// ---------------------------------------------------------------------------
// The month, through the screens
// ---------------------------------------------------------------------------

async function onPayroll(db) {
  await setProfiles(ctx(db, WAGES, {
    body: {
      rows: [
        {
          staffId: 1,
          onPayroll: true,
          basic: 2000,
          ssnit: true,
          allowances: [{ name: 'Transport', amount: 300, taxable: true }],
        },
        { staffId: 2, onPayroll: true, basic: 1200, ssnit: false, allowances: [] },
      ],
    },
  }));
}

test('nobody is on the payroll until somebody says what they are paid', async () => {
  const { db } = setup();
  const empty = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(empty.lines.length, 0, 'a payroll never guesses at a salary');
  assert.equal(empty.staff.length, 2, 'but it knows who could be on it');

  await onPayroll(db);
  const out = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(out.lines.length, 2);
  assert.equal(out.totals.basic, 3200);
  assert.equal(out.lines.find((l) => l.staff.id === 2).ssnit.employee, 0);
});

test('a scheme is scored per person and paid as a share of what it is worth', async () => {
  const { db } = setup();
  await onPayroll(db);

  const scheme = await read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Guest scores', amount: 500, staffIds: [1, 2] },
  })));
  await setScores(ctx(db, WAGES, {
    body: {
      month: MONTH,
      rows: [
        { schemeId: scheme.id, staffId: 1, score: 80 },
        { schemeId: scheme.id, staffId: 2, score: 0 },
      ],
    },
  }));

  const out = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  const ama = out.lines.find((l) => l.staff.id === 1);
  const kofi = out.lines.find((l) => l.staff.id === 2);

  assert.equal(ama.bonus.earned, 400, '500 at 80 per cent');
  // A 2,000 basic reaches 300 at the 5% rate, so the rest of the 400 goes
  // through the bands and the grossing up costs more than a twentieth.
  assert.equal(ama.bonus.ceiling, 300);
  assert.equal(ama.bonus.gross, 439.39);
  assert.equal(kofi.bonus.earned, 0, 'a score of nothing pays nothing');
});

test('money off a bonus shows on the payslip with its reason, and the person is told', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const scheme = await read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Guest scores', amount: 500, staffIds: [1] },
  })));
  await setScores(ctx(db, WAGES, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] },
  }));

  await addPenalty(ctx(db, WAGES, {
    body: { month: MONTH, staffId: 1, amount: 150, reason: 'Left the store unlocked' },
  }));

  const told = raw.prepare('SELECT * FROM app_notices ORDER BY id').all().at(-1);
  assert.equal(told.user_id, 7, 'told the day it happens, not on payday');
  assert.match(told.body, /store unlocked/);

  const slip = await read(await payslip(ctx(db, WAGES, { query: `?month=${MONTH}` }), 1));
  assert.equal(slip.line.bonus.earned, 500);
  assert.equal(slip.line.bonus.docked, 150);
  assert.equal(slip.line.bonus.net, 350);
  assert.equal(slip.line.bonus.schemes[0].name, 'Guest scores');
});

test('closing the month writes the payslips down and records the advance deductions', async () => {
  const { raw, db } = setup();
  await onPayroll(db);

  // An advance running against Ama, 200 a month from September.
  const given = await read(await addAdvance(ctx(db, WAGES, {
    body: {
      staffId: 1, amount: 600, months: 3, takenOn: '2026-09-01', startMonth: MONTH,
      purpose: 'other',
    },
  })));

  const before = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(before.lines.find((l) => l.staff.id === 1).loanTotal, 200,
    'the deduction is on the draft before anybody closes anything');

  const closed = await read(await closeRun(ctx(db, WAGES, { body: { month: MONTH } })));
  assert.equal(closed.people, 2);

  const entry = raw.prepare('SELECT * FROM hr_advance_entry WHERE advance_id = ?').get(given.id);
  assert.equal(entry.amount, 200);
  assert.equal(entry.source, 'payroll', 'so reopening knows what it put there');
  assert.match(entry.note, /payroll for 2026-09/);

  // And the advances screen agrees, without being asked to record it twice.
  const ledger = await read(await advances(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(ledger.people[0].totals.owed, 400);
  assert.ok(ledger.due.every((row) => row.recorded), 'September has an answer against it');
  assert.ok(ledger.closed, 'and the month is closed off');
});

test('a closed month answers from what was written down, not from what is true today', async () => {
  const { db } = setup();
  await onPayroll(db);
  await closeRun(ctx(db, WAGES, { body: { month: MONTH } }));

  // A rise in October must not rewrite September.
  await setProfiles(ctx(db, WAGES, {
    body: { rows: [{ staffId: 1, onPayroll: true, basic: 5000, ssnit: true, allowances: [] }] },
  }));

  const out = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(out.status, 'final');
  assert.equal(out.lines.find((l) => l.staff.id === 1).basic, 2000, 'September is September');

  const october = await read(await payroll(ctx(db, WAGES, { query: '?month=2026-10' })));
  assert.equal(october.lines.find((l) => l.staff.id === 1).basic, 5000);
});

test('a closed month refuses to be edited until it is opened again', async () => {
  const { db } = setup();
  await onPayroll(db);
  await closeRun(ctx(db, WAGES, { body: { month: MONTH } }));

  await assert.rejects(
    () => addPenalty(ctx(db, WAGES, { body: { month: MONTH, staffId: 1, amount: 50, reason: 'x' } })),
    /closed/,
  );
  await assert.rejects(() => closeRun(ctx(db, WAGES, { body: { month: MONTH } })), /already closed/);
});

test('reopening takes back exactly what closing wrote', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const given = await read(await addAdvance(ctx(db, WAGES, {
    body: { staffId: 1, amount: 600, months: 3, takenOn: '2026-09-01', startMonth: MONTH },
  })));

  // Something entered by hand against a different month, which must survive.
  raw.prepare(
    `INSERT INTO hr_advance_entry (advance_id, month, kind, amount, actor)
     VALUES (?, '2026-08', 'adjustment', 50, 'Yaa')`,
  ).run(given.id);

  await closeRun(ctx(db, WAGES, { body: { month: MONTH } }));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hr_advance_entry').get().n, 2);

  await reopenRun(ctx(db, WAGES, { body: { month: MONTH } }));

  const left = raw.prepare('SELECT * FROM hr_advance_entry').all();
  assert.equal(left.length, 1, 'the payroll’s own entry is gone');
  assert.equal(left[0].month, '2026-08', 'and the hand-entered one is not');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_slip').get().n, 0);

  const out = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(out.status, 'draft');
});

test('the 15% ceiling is annual, so earlier months count against it', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, WAGES, {
    body: { rows: [{ staffId: 1, onPayroll: true, basic: 1000, ssnit: true, allowances: [] }] },
  }));
  const scheme = await read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Quarterly', amount: 1000, staffIds: [1] },
  })));

  // 15% of 12,000 a year is 1,800 of bonus at the 5% rate.
  await setScores(ctx(db, WAGES, {
    body: { month: '2026-01', rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] },
  }));
  await closeRun(ctx(db, WAGES, { body: { month: '2026-01' } }));

  await setScores(ctx(db, WAGES, {
    body: { month: '2026-02', rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] },
  }));
  const second = await read(await payroll(ctx(db, WAGES, { query: '?month=2026-02' })));
  const line = second.lines[0];

  assert.ok(line.bonus.headroom < 1800, 'January has used part of the year up');
  assert.ok(line.bonus.atGraduated > 0, 'so some of February is at the graduated rates');
  assert.equal(Math.round((line.bonus.gross - line.bonus.tax) * 100) / 100, 1000,
    'and the person still gets the thousand they were promised');
});

test('a scheme keeps the department it was filed under', async () => {
  const { db } = setup();
  await onPayroll(db);

  const made = await read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Covers', amount: 300, department: 'Housekeeping', staffIds: [1] },
  })));
  const wide = await read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Long service', amount: 100, staffIds: [1, 2] },
  })));

  const seen = await read(await payroll(ctx(db, WAGES, { url: `/api/payroll?month=${MONTH}` })));
  const byId = new Map(seen.schemes.map((s) => [s.id, s]));
  assert.equal(byId.get(made.id).department, 'Housekeeping');
  // Nothing typed means the whole property, and null is how that is said.
  assert.equal(byId.get(wide.id).department, null);

  // Moved to another department, and moved back out of one.
  await saveScheme(ctx(db, WAGES, {
    body: { id: made.id, name: 'Covers', amount: 300, department: 'F&B', staffIds: [1] },
  }));
  await saveScheme(ctx(db, WAGES, {
    body: { id: wide.id, name: 'Long service', amount: 100, department: 'Admin', staffIds: [1, 2] },
  }));

  const after = await read(await payroll(ctx(db, WAGES, { url: `/api/payroll?month=${MONTH}` })));
  const nowBy = new Map(after.schemes.map((s) => [s.id, s]));
  assert.equal(nowBy.get(made.id).department, 'F&B');
  assert.equal(nowBy.get(wide.id).department, 'Admin');

  await saveScheme(ctx(db, WAGES, {
    body: { id: made.id, name: 'Covers', amount: 300, department: '', staffIds: [1] },
  }));
  const back = await read(await payroll(ctx(db, WAGES, { url: `/api/payroll?month=${MONTH}` })));
  assert.equal(back.schemes.find((s) => s.id === made.id).department, null);
});


// ---------------------------------------------------------------------------
// Starting a month from the one before it
// ---------------------------------------------------------------------------

/** August scored and docked, ready to be carried into September. */
async function august(db) {
  await onPayroll(db);
  const scheme = await read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Guest scores', amount: 500, staffIds: [1, 2] },
  })));
  await setScores(ctx(db, WAGES, {
    body: {
      month: '2026-08',
      rows: [
        { schemeId: scheme.id, staffId: 1, score: 80 },
        { schemeId: scheme.id, staffId: 2, score: 40 },
      ],
    },
  }));
  await addPenalty(ctx(db, WAGES, {
    body: { month: '2026-08', staffId: 1, amount: 100, reason: 'Late three times' },
  }));
  return scheme;
}

test('a month starts from the one before it, scores and all', async () => {
  const { db } = setup();
  const scheme = await august(db);

  const out = await read(await copyRun(ctx(db, WAGES, { body: { month: MONTH } })));
  assert.equal(out.from, '2026-08');
  assert.equal(out.scores, 2);
  assert.equal(out.penalties, 0, 'misconduct does not follow somebody into the next month');

  const now = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  const carried = now.schemes.find((s) => s.id === scheme.id).scores;
  assert.deepEqual(
    carried.sort((a, b) => a.staffId - b.staffId),
    // `award` is what a scheme paying a set figure carries; a scored one
    // forgets it, so the scheme's worth today is what applies.
    [{ staffId: 1, score: 80, award: null, tier: null },
      { staffId: 2, score: 40, award: null, tier: null }],
  );
  assert.deepEqual(now.penalties, []);
});

test('misconduct comes across only when it is asked for', async () => {
  const { db } = setup();
  await august(db);

  const out = await read(await copyRun(ctx(db, WAGES, {
    body: { month: MONTH, penalties: true },
  })));
  assert.equal(out.penalties, 1);

  const now = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(now.penalties.length, 1);
  assert.equal(now.penalties[0].amount, 100);
  assert.equal(now.penalties[0].reason, 'Late three times');

  // Twice does not mean twice the money.
  await copyRun(ctx(db, WAGES, { body: { month: MONTH, penalties: true } }));
  const again = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.equal(again.penalties.length, 1);
});

test('somebody taken off a scheme since is not scored on it again', async () => {
  const { db } = setup();
  const scheme = await august(db);

  // Kofi comes off the scheme in September.
  await saveScheme(ctx(db, WAGES, {
    body: { id: scheme.id, name: 'Guest scores', amount: 500, staffIds: [1] },
  }));

  const out = await read(await copyRun(ctx(db, WAGES, { body: { month: MONTH } })));
  assert.equal(out.scores, 1);

  const now = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  assert.deepEqual(now.schemes.find((s) => s.id === scheme.id).scores,
    [{ staffId: 1, score: 80, award: null, tier: null }]);
});

test('what is already scored this month is replaced, not added to', async () => {
  const { db } = setup();
  const scheme = await august(db);

  await setScores(ctx(db, WAGES, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 10 }] },
  }));
  await copyRun(ctx(db, WAGES, { body: { month: MONTH } }));

  const now = await read(await payroll(ctx(db, WAGES, { query: `?month=${MONTH}` })));
  const scores = now.schemes.find((s) => s.id === scheme.id).scores;
  assert.equal(scores.find((x) => x.staffId === 1).score, 80, 'last month wins over the stale 10');
});

test('a month cannot be started from itself or from a later one', async () => {
  const { db } = setup();
  await august(db);

  await assert.rejects(
    () => copyRun(ctx(db, WAGES, { body: { month: MONTH, from: MONTH } })),
    /earlier one/,
  );
  await assert.rejects(
    () => copyRun(ctx(db, WAGES, { body: { month: '2026-08', from: MONTH } })),
    /earlier one/,
  );
});

test('a month with no payroll behind it has nothing to give', async () => {
  const { db } = setup();
  await onPayroll(db);

  await assert.rejects(
    () => copyRun(ctx(db, WAGES, { body: { month: MONTH, from: '2025-01' } })),
    /no payroll for 2025-01/,
  );
});

test('a closed month refuses to have anything copied into it', async () => {
  const { db } = setup();
  await august(db);
  await closeRun(ctx(db, WAGES, { body: { month: MONTH } }));

  await assert.rejects(
    () => copyRun(ctx(db, WAGES, { body: { month: MONTH } })),
    /closed/,
  );
});

// ---------------------------------------------------------------------------
// How a grossed-up bonus reads on a payslip
// ---------------------------------------------------------------------------

/**
 * A bonus is agreed net: somebody is promised four hundred and gets four
 * hundred, and the property carries the tax that makes that true. So the
 * grossed-up figure is not a number anybody was offered, and a payslip saying
 * it invites the one question it cannot answer.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const withBonus = (allowances, over = {}) => computeLine({
  staff: { id: 1, name: 'Kofi Mensah' },
  basic: 2000,
  allowances,
  schemes: [{ id: 1, name: 'Nkosoɔ', amount: 400, score: 100 }],
  ssnit: true,
  rates,
  ...over,
});

const addsUp = (line) => round2(
  line.basic
  + line.slip.allowances.reduce((n, a) => n + a.amount, 0)
  + line.slip.bonus,
);

test('the bonus on a payslip is the figure that was agreed', () => {
  const line = withBonus([{ name: 'Allowance', amount: 500, taxable: 1 }]);
  assert.equal(line.slip.bonus, 400, 'not the 421.05 it had to be grossed to');
  assert.equal(line.bonus.net, 400);
  assert.ok(line.bonus.gross > 400, 'the grossing up still happens');
});

test('and the tax carried on it goes in with the allowance', () => {
  const line = withBonus([{ name: 'Allowance', amount: 500, taxable: 1 }]);
  const carried = round2(line.bonus.gross - line.bonus.net);

  assert.equal(line.slip.carried, carried);
  assert.deepEqual(line.slip.allowances, [
    { name: 'Allowance', amount: round2(500 + carried), taxable: true, carries: carried },
  ]);
  assert.deepEqual(line.allowances, [{ name: 'Allowance', amount: 500, taxable: true }],
    'and what the property agreed to pay is left as it is');
});

test('the earnings column still adds to the same gross', () => {
  for (const allowances of [
    [{ name: 'Allowance', amount: 500, taxable: 1 }],
    [{ name: 'Transport', amount: 500, taxable: 1 }],
    [{ name: 'Transport', amount: 300, taxable: 1 }, { name: 'Allowance', amount: 200, taxable: 1 }],
    [{ name: 'Transport', amount: 300, taxable: 1 }, { name: 'Housing', amount: 200, taxable: 1 }],
    [{ name: 'Lunch', amount: 200, taxable: 0 }],
    [],
  ]) {
    const line = withBonus(allowances);
    assert.equal(addsUp(line), line.gross, JSON.stringify(allowances));
  }
});

test('it joins the one called Allowance where there are several', () => {
  const line = withBonus([
    { name: 'Transport', amount: 300, taxable: 1 },
    { name: 'Allowance', amount: 200, taxable: 1 },
  ]);
  assert.equal(line.slip.allowances.find((a) => a.name === 'Transport').amount, 300);
  assert.ok(line.slip.allowances.find((a) => a.name === 'Allowance').carries > 0);
});

test('and the only one where none of them is called that', () => {
  const line = withBonus([{ name: 'Transport', amount: 500, taxable: 1 }]);
  assert.ok(line.slip.allowances[0].carries > 0, 'one allowance is the one it belongs to');
});

test('but never onto whichever happened to be first', () => {
  const line = withBonus([
    { name: 'Transport', amount: 300, taxable: 1 },
    { name: 'Housing', amount: 200, taxable: 1 },
  ]);
  assert.equal(line.slip.allowances[0].amount, 300);
  assert.equal(line.slip.allowances[1].amount, 200);
  assert.equal(line.slip.allowances[2].name, 'Allowance', 'it gets a line of its own instead');
  assert.equal(line.slip.allowances[2].amount, line.slip.carried);
});

test('a month with no bonus reads exactly as it always did', () => {
  const line = computeLine({
    staff: { id: 1, name: 'Kofi Mensah' },
    basic: 2000,
    allowances: [{ name: 'Allowance', amount: 500, taxable: 1 }],
    schemes: [],
    ssnit: true,
    rates,
  });
  assert.equal(line.slip.carried, 0);
  assert.equal(line.slip.bonus, 0);
  assert.deepEqual(line.slip.allowances, [{ name: 'Allowance', amount: 500, taxable: true }]);
});

test('net pay is untouched by any of this', () => {
  const line = withBonus([{ name: 'Allowance', amount: 500, taxable: 1 }]);
  // Gross less SSNIT less PAYE. The rearranging is a payslip reading the same
  // money differently, not a different amount of money.
  assert.equal(
    line.net,
    round2(line.gross - line.ssnit.employee - line.paye.total),
  );
});

// ---------------------------------------------------------------------------
// How far the 5% final rate reaches
// ---------------------------------------------------------------------------

/**
 * The Act frames the cap as 15% of the annual basic salary. Salaries are paid
 * monthly, and the practice here is to read the same share against the month
 * being paid. Read against the month there is no running total to keep, and so
 * nothing that can be out of date; read against the year the ceiling is only
 * as good as the months this app has actually closed.
 */
const capped = (over = {}) => computeLine({
  staff: { id: 1, name: 'Ama' },
  basic: 2000,
  allowances: [],
  ssnit: true,
  schemes: [{ id: 1, name: 'Service', amount: 400, score: 100 }],
  rates,
  ...over,
});

test('the 5% rate reaches 15% of the month being paid', () => {
  const line = capped();
  assert.equal(line.bonus.capBasis, 'monthly');
  assert.equal(line.bonus.ceiling, 300, '15% of a 2,000 basic');
});

test('and anything over it goes through the graduated bands', () => {
  const line = capped();
  assert.equal(line.bonus.atFinalRate, 300);
  assert.equal(line.bonus.atGraduated, round2(line.bonus.gross - 300));
  assert.ok(line.bonus.atGraduated > 0, 'a 400 net bonus does not fit inside 300');
  assert.equal(line.bonus.finalTax, 15, '5% of the 300');
  assert.ok(line.bonus.graduatedTax > 0);
});

test('a bonus that fits inside the month is all at the final rate', () => {
  const line = capped({ schemes: [{ id: 1, name: 'Service', amount: 200, score: 100 }] });
  assert.equal(line.bonus.atGraduated, 0);
  assert.equal(line.bonus.tax, round2(line.bonus.gross * 0.05));
});

test('the ceiling moves with the basic, not with the calendar', () => {
  assert.equal(capped({ basic: 1000 }).bonus.ceiling, 150);
  assert.equal(capped({ basic: 4000 }).bonus.ceiling, 600);
});

test('nothing is carried between months, so a month cannot be out of date', () => {
  const fresh = capped();
  const later = capped({ bonusPaidThisYear: 9999 });
  assert.equal(later.bonus.ceiling, fresh.bonus.ceiling);
  assert.equal(later.bonus.atFinalRate, fresh.bonus.atFinalRate,
    'what was paid in June is June’s business');
  assert.equal(later.bonus.paidThisYear, 0);
});

test('the annual reading is still there for a property that wants it', () => {
  const yearly = ratesFrom({ pay_bonus_cap_basis: 'annual' });
  const line = capped({ rates: yearly });
  assert.equal(line.bonus.capBasis, 'annual');
  assert.equal(line.bonus.ceiling, 3600, '15% of 24,000');
  assert.equal(line.bonus.atGraduated, 0, 'a 400 bonus is well inside a year’s worth');

  // And it still counts what has gone before.
  const late = capped({ rates: yearly, bonusPaidThisYear: 3400 });
  assert.equal(late.bonus.headroom, 200);
  assert.ok(late.bonus.atGraduated > 0);
});

test('the person receives what was agreed under either reading', () => {
  for (const basis of ['monthly', 'annual']) {
    const at = ratesFrom({ pay_bonus_cap_basis: basis });
    const without = computeLine({ basic: 2000, allowances: [], ssnit: true, rates: at });
    const with400 = capped({ rates: at });
    assert.equal(round2(with400.net - without.net), 400, basis);
  }
});

test('the cost is compared to the month before, as well as the net', async () => {
  const { db } = setup();
  const pay = (basic) => setProfiles(ctx(db, WAGES, {
    body: { rows: [{ staffId: 1, onPayroll: true, basic, ssnit: true, allowances: [] }] } },
  ));
  await pay(2000);
  await closeRun(ctx(db, WAGES, { body: { month: '2026-06' } }));

  // A rise in basic moves both, and by different per cents: the employer's
  // 13% rides on the basic while the tax rides on the whole.
  await pay(2400);
  const data = await read(await payroll(ctx(db, WAGES, { query: '?month=2026-07&compare=2026-06' })));
  const [line] = data.lines;

  assert.ok(line.against, 'the net still has one');
  assert.ok(line.againstCost, 'and the cost now has one too');
  assert.equal(line.againstCost.was, 2260, '2,000 and 13% of it');
  assert.equal(line.againstCost.change, Math.round((line.employerCost - 2260) * 100) / 100);
  assert.ok(line.againstCost.percent > 0, 'it cost more');
});

test('a month with nothing to read against leaves both empty', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, WAGES, {
    body: { rows: [{ staffId: 1, onPayroll: true, basic: 2000, ssnit: true, allowances: [] }] },
  }));
  const data = await read(await payroll(ctx(db, WAGES, { query: '?month=2026-07&compare=2026-01' })));
  assert.equal(data.lines[0].against, null);
  assert.equal(data.lines[0].againstCost, null);
});
