import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { computeLine } from '../src/lib/payroll.js';
import { RATES } from '../src/lib/tax.js';
import { payroll, saveScheme, setProfiles, setScores } from '../src/routes/payroll.js';
import { addAdvance } from '../src/routes/advances.js';

/**
 * A take-home agreed with somebody, and the allowance worked out from it.
 *
 * TWO MEANINGS, AND THIS FILE ONCE ASSUMED THERE WAS ONE. It used to say that
 * what is agreed at this property is what lands in the hand, bonus included:
 * "Linda is on 2,480 a month and scores what she scores". That was the mistake.
 * 2,480 was Linda's August — 1,850 fixed and a 630 bonus — and in a month she
 * scores 589 she takes home 2,439. Built on the first reading, the scores
 * could not change anybody's pay, and by August sixteen people were being paid
 * whatever bonus their figure had been typed in with.
 *
 * So a take-home says which it is. 'fixed' is the part before the bonus, with
 * the month's scored bonus on top, which is how most of the property is paid.
 * The whole amount, bonus included, is still right for a flat rate where the
 * bonus is a way of arranging the money: the casuals on 600, the managers. The
 * tests near the top are about the whole amount, because that is what every
 * figure stored before this change means; the ones at the bottom are the fixed
 * part.
 */

const TIERS = { tier1: 0.135, tier2: 0.05 };
const line = (o) => computeLine({
  takeHomeBasis: o.basis ?? 'total',
  staff: { id: 1, name: o.name ?? 'Ama' },
  basic: o.basic,
  allowances: o.allow ? [{ name: 'Allowance', amount: o.allow, taxable: true }] : [],
  ssnit: o.ssnit ?? true,
  schemes: o.bonus ? [{ id: 1, name: 'Scheme', amount: o.bonus, score: o.score ?? 100 }] : [],
  penalties: o.docked ? [{ id: 1, amount: o.docked }] : [],
  loans: o.loan ? [{ advanceId: 1, amount: o.loan, left: 0 }] : [],
  annualBasic: o.basic * 12,
  bonusPaidThisYear: 0,
  bonusIsNet: o.bonusIsNet ?? false,
  takeHome: o.takeHome ?? null,
  relief: 0,
  rates: RATES,
  tiers: TIERS,
});

// ---------------------------------------------------------------------------
// The sum itself
// ---------------------------------------------------------------------------

test('the allowance lands the person exactly on what was agreed', () => {
  // Every one of these is somebody real off the August payroll, with the
  // take-home the property actually agreed with them.
  for (const [name, basic, allow, ssnit, target] of [
    ['Linda Attipoe', 800, 1437.64, true, 2480],
    ['Abdul Hamid Iddrisu', 800, 411.58, true, 1610],
    ['Patience Torto', 800, 261.51, false, 1230],
    ['Douglas Eshun Sekyi', 800, 2261.58, true, 3260],
    ['Michael Kesseh', 2000, 2161.34, true, 5000],
    ['Rebecca Aborehey', 587.80, 0, false, 600],
  ]) {
    const l = line({ name, basic, allow, ssnit, takeHome: target });
    assert.equal(l.net, target, `${name} lands on ${target}`);
  }
});

test('it is walked to the pesewa, so it is exact rather than close', () => {
  // An extra cedi of allowance is taxable and so yields less than a cedi of
  // take-home, which is why there is no formula to invert. Above what the
  // basic alone comes to, so there is an allowance to find; below it there is
  // nothing to solve, which is its own test further down.
  for (const target of [1200, 1234.56, 2480, 3999.99, 12000]) {
    assert.equal(line({ basic: 800, takeHome: target }).net, target);
  }
});

test('the worked-out allowance is a real allowance line, and says it was worked out', () => {
  const l = line({ basic: 800, takeHome: 2480 });
  assert.equal(l.takeHome, 2480);
  assert.ok(l.workedOut > 0);
  const added = l.allowances.find((a) => a.workedOut);
  assert.ok(added, 'it appears on the line like any other allowance');
  assert.equal(added.amount, l.workedOut);
  assert.equal(added.taxable, true, 'it is cash pay and is taxed like it');
  assert.equal(l.allowanceTotal, l.workedOut);
});

test('an allowance somebody did agree is kept, and the worked-out one tops it up', () => {
  const l = line({ basic: 800, allow: 300, takeHome: 2480 });
  assert.equal(l.net, 2480);
  const agreed = l.allowances.find((a) => !a.workedOut);
  assert.equal(agreed.amount, 300, 'the agreed one is untouched');
  assert.equal(round(l.allowanceTotal - 300), l.workedOut);
});

const round = (n) => Math.round(n * 100) / 100;

test('nothing set means nothing changes: they are paid what is entered', () => {
  const l = line({ basic: 800, allow: 500, bonus: 400 });
  assert.equal(l.takeHome, undefined);
  assert.equal(l.bonus.net, 400);
  assert.equal(l.allowanceTotal, 500, 'no allowance is invented');
});

test('the score still sets the bonus, and the allowance moves around it', () => {
  const full = line({ basic: 800, bonus: 400, score: 100, takeHome: 2000 });
  const half = line({ basic: 800, bonus: 400, score: 50, takeHome: 2000 });
  assert.equal(full.bonus.net, 400);
  assert.equal(half.bonus.net, 200, 'half a scheme is half the money, as always');
  assert.equal(full.net, 2000);
  assert.equal(half.net, 2000, 'and the take-home holds either way');
  assert.ok(half.workedOut > full.workedOut, 'the allowance made up the difference');
});

// ---------------------------------------------------------------------------
// What it is measured before
// ---------------------------------------------------------------------------

test('an advance still costs them, rather than being made up by a bigger allowance', () => {
  // Vivian: agreed 1,530 a month, repaying 1,200. She takes home 330, and the
  // property does not quietly hand back its own advance.
  const l = line({ basic: 587.80, bonus: 520, takeHome: 1530, loan: 1200 });
  assert.equal(l.net, 330);
  assert.equal(l.loanTotal, 1200);

  const without = line({ basic: 587.80, bonus: 520, takeHome: 1530 });
  assert.equal(without.workedOut, l.workedOut, 'the same allowance either way');
});

test('money docked off a bonus still costs them', () => {
  const clean = line({ basic: 800, bonus: 600, takeHome: 2000 });
  const docked = line({ basic: 800, bonus: 600, takeHome: 2000, docked: 100 });
  assert.equal(clean.net, 2000);
  assert.ok(docked.net < 2000, 'a penalty is not made up by a bigger allowance');
  assert.equal(docked.workedOut, clean.workedOut, 'the same allowance either way');
});

test('a deduction bigger than the bonus is not taken out of their salary', () => {
  const l = line({ basic: 800, bonus: 300, takeHome: 1400, docked: 5000 });
  assert.equal(l.bonus.net, 0);
  assert.ok(l.bonus.notTaken > 0, 'and what could not be taken is said');
  assert.ok(l.net > 0);
});

// ---------------------------------------------------------------------------
// When it cannot be met
// ---------------------------------------------------------------------------

test('somebody already past their figure gets no allowance, and no pay cut', () => {
  // Their basic and their bonus alone take them past it. The app will not
  // claw money back to get down to the number.
  const l = line({ basic: 2000, bonus: 2000, takeHome: 1000 });
  assert.equal(l.workedOut, 0);
  assert.equal(l.allowanceTotal, 0);
  assert.equal(l.overshoots, true, 'and the screen is told');
  assert.ok(l.net > 1000, 'they keep what their basic and bonus come to');
});

test('a figure already met to the penny needs no allowance and is not a fault', () => {
  const bare = line({ basic: 800, bonus: 400 });
  const l = line({ basic: 800, bonus: 400, takeHome: bare.net });
  assert.equal(l.workedOut, 0);
  assert.equal(l.net, bare.net);
});

// ---------------------------------------------------------------------------
// The score is not thrown away
// ---------------------------------------------------------------------------

test('what they scored is what they are paid as bonus, take-home or no take-home', () => {
  const l = line({ basic: 800, bonus: 400, score: 75, takeHome: 2000 });
  assert.equal(l.bonus.scored, 300, 'three quarters of a four hundred scheme');
  assert.equal(l.bonus.net, 300, 'and that is the bonus, unchanged');
  assert.equal(l.net, 2000, 'the allowance is what moved');
});

// ---------------------------------------------------------------------------
// Through the app
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, 'E1', 'Linda Attipoe', 'Housekeeping', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const WAGES = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session: WAGES,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (r) => r.json();
const MONTH = '2026-08';

test('a take-home set once is used every month without anybody typing it again', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2480, allowances: [] }] },
  }));

  for (const month of [MONTH, '2026-09', '2026-10']) {
    const data = await read(await payroll(ctx(db, { query: `?month=${month}` })));
    assert.equal(data.lines[0].net, 2480, `${month} lands on it too`);
    assert.equal(data.lines[0].takeHome, 2480);
    assert.ok(data.lines[0].workedOut > 0);
  }
});

test('a whole amount holds when a score moves', async () => {
  // Right for a flat rate, where the bonus is part of how the figure is
  // arranged. Exactly wrong for a performance bonus, which is what the fixed
  // take-home at the bottom of this file is for.
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2480, allowances: [] }] },
  }));
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Nkosoɔ', amount: 900, departments: [], staffIds: [1] },
  })));

  const scoreThem = (score) => setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score }] },
  }));
  const month = () => read(payroll(ctx(db, { query: `?month=${MONTH}` })).then((r) => r));

  await scoreThem(100);
  const full = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  await scoreThem(50);
  const half = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));

  assert.equal(full.lines[0].net, 2480);
  assert.equal(half.lines[0].net, 2480, 'still exactly on it');
  assert.equal(full.lines[0].bonus.net, 900);
  assert.equal(half.lines[0].bonus.net, 450, 'the score still sets the bonus');
  assert.ok(half.lines[0].workedOut > full.lines[0].workedOut,
    'and the allowance grew to make up the difference');
});

test('the screen is told what was agreed and what was worked out', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2480, allowances: [] }] },
  }));
  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.staff[0].takeHome, 2480);
  assert.equal(data.lines[0].takeHome, 2480);
  const added = data.lines[0].allowances.find((a) => a.workedOut);
  assert.ok(added, 'and the allowance says it was worked out rather than agreed');
});

test('emptying the box pays them what is entered, and a silent form changes nothing', async () => {
  const { raw, db } = setup();
  const save = (row) => setProfiles(ctx(db, { body: { rows: [{ staffId: 1, basic: 800, ...row }] } }));

  await save({ takeHome: 2480 });
  assert.equal(raw.prepare('SELECT take_home FROM pay_profile WHERE staff_id = 1').get().take_home, 2480);

  // A spreadsheet upload that never asks about it must not wipe it.
  await save({});
  assert.equal(raw.prepare('SELECT take_home FROM pay_profile WHERE staff_id = 1').get().take_home, 2480);

  await save({ takeHome: '' });
  assert.equal(raw.prepare('SELECT take_home FROM pay_profile WHERE staff_id = 1').get().take_home, null);

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].takeHome, undefined);
  assert.equal(data.lines[0].allowanceTotal, 0, 'and no allowance is invented');
});

test('an advance running against a take-home comes off after it, not out of it', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2480, allowances: [] }] },
  }));
  await read(await addAdvance(ctx(db, {
    body: {
      staffId: 1, amount: 1500, months: 3, monthly: 500, takenOn: '2026-07-05',
      startMonth: '2026-07', purpose: 'other',
    },
  })));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].loanTotal, 500);
  assert.equal(data.lines[0].net, 1980, '2,480 agreed, 500 going back');
});

test('the whole August payroll lands on the sheet, with nothing entered but a take-home', async () => {
  // The reconciliation this was built to end. Basic and the agreed take-home
  // for each person, no allowances typed anywhere, and every net comes out.
  const { raw, db } = setup();
  const people = [
    ['Linda Attipoe', 800, true, 2480, 2480],
    ['Abdul Hamid Iddrisu', 800, true, 1610, 1610],
    ['Patience Naa Torshie Torto', 800, false, 1230, 1230],
    ['Michael Kesseh', 2000, true, 5000, 5000],
    ['Rebecca Aborehey', 587.80, false, 600, 600],
  ];
  people.forEach(([name], at) => {
    if (at === 0) return;
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, hired_on)
       VALUES (?, ?, ?, '2020-01-01')`,
    ).run(at + 1, `E${at + 1}`, name);
  });

  await setProfiles(ctx(db, {
    body: {
      rows: people.map(([, basic, ssnit, target], at) => ({
        staffId: at + 1, basic, ssnit, takeHome: target, allowances: [],
      })),
    },
  }));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  for (const [name, , , , want] of people) {
    const line = data.lines.find((l) => l.staff.name === name);
    assert.equal(line.net, want, `${name} lands on ${want}`);
  }
});

// ---------------------------------------------------------------------------
// A fixed take-home, with the month's bonus on top
// ---------------------------------------------------------------------------

test('a fixed take-home plus the month’s bonus reproduces the property’s own sheet', () => {
  // Off the August sheet: fixed salary, the month's bonus, the advance, and
  // what the sheet says they were paid. The sheet carries four decimals and
  // this pays in pesewas, so a pesewa either way is the sheet's rounding.
  for (const [name, basic, ssnit, fixed, bonus, loan, sheetNet] of [
    ['Linda Attipoe', 800, true, 1850, 630, 500, 1980.0045],
    ['Abdul Hamid Iddrisu', 800, true, 1000, 610, 0, 1609.996625],
    ['Patience Torto', 800, false, 1000, 230, 0, 1229.9975],
    ['Douglas Eshun Sekyi', 800, true, 2500, 760, 0, 3260.00075],
    ['Robert Dotse', 587.8, true, 800, 260, 0, 1060.004825],
    ['Vivian Ahiadorme', 587.8, true, 900, 630, 1200, 329.999075],
  ]) {
    const l = line({
      name, basic, ssnit, basis: 'fixed', takeHome: fixed, bonus, bonusIsNet: true, loan,
    });
    assert.ok(Math.abs(l.net - sheetNet) <= 0.01, `${name}: ${l.net} against the sheet's ${sheetNet}`);
  }
});

test('on a fixed take-home the score changes the pay, which is what a score is for', () => {
  const at = (bonus) => line({ basic: 800, basis: 'fixed', takeHome: 1850, bonus, bonusIsNet: true });
  assert.equal(at(630).net, 2480, 'a 630 month');
  assert.equal(at(589).net, 2439, 'a 589 month');
  assert.equal(at(0).net, 1850, 'a month with nothing scored is the fixed part');
});

test('the same figures on the whole-amount reading do not move, which was the fault', () => {
  const at = (bonus) => line({ basic: 800, takeHome: 2439, bonus, bonusIsNet: true });
  assert.equal(at(630).net, 2439);
  assert.equal(at(520).net, 2439, 'a lower score, the same pay');
});

test('the line says which it was, and what the bonus added', () => {
  const l = line({ basic: 800, basis: 'fixed', takeHome: 1850, bonus: 630, bonusIsNet: true });
  assert.equal(l.takeHomeBasis, 'fixed');
  assert.equal(l.takeHome, 1850, 'the fixed part, as agreed');
  assert.equal(l.bonusOnTop, 630);
  assert.equal(l.takeHomeTarget, 2480, 'and what that came to this month');
});

test('money docked off a bonus still costs them on a fixed take-home', () => {
  // The target is reached on a clean month and the penalty applied after it,
  // so the allowance cannot grow to cancel what was docked.
  const clean = line({ basic: 800, basis: 'fixed', takeHome: 1850, bonus: 630, bonusIsNet: true });
  const docked = line({
    basic: 800, basis: 'fixed', takeHome: 1850, bonus: 630, bonusIsNet: true, docked: 100,
  });
  assert.equal(clean.net, 2480);
  assert.equal(docked.net, 2380);
});

test('an advance still comes off after a fixed take-home, not out of it', () => {
  const l = line({ basic: 800, basis: 'fixed', takeHome: 1850, bonus: 630, bonusIsNet: true, loan: 500 });
  assert.equal(l.net, 1980);
});

test('a gross bonus on a fixed take-home lands in full, as the sheet has it', () => {
  // Joshua is on a gross bonus. His sheet pays him fixed plus the whole of it:
  // 1,500 and 295.83, and 1,795.82 in his hand. The gross setting then says
  // only which column carries the tax.
  const l = line({ basic: 800, ssnit: false, basis: 'fixed', takeHome: 1500, bonus: 295.83, bonusIsNet: false });
  assert.ok(Math.abs(l.net - 1795.82) <= 0.01, `${l.net}`);
});

// ---------------------------------------------------------------------------
// Saying which it is
// ---------------------------------------------------------------------------

const basisOf = (raw) => raw.prepare('SELECT take_home, take_home_basis FROM pay_profile WHERE staff_id = 1').get();

test('a figure saved as fixed is paid as fixed, month after month', async () => {
  const { db, raw } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 1850, takeHomeFixed: true, allowances: [] }] },
  }));
  assert.equal(basisOf(raw).take_home_basis, 'fixed');

  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Housekeeping', amount: 630, departments: [], staffIds: [1] },
  })));
  await setScores(ctx(db, { body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] } }));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].net, 2480);
  assert.equal(data.lines[0].takeHomeBasis, 'fixed');
  assert.equal(data.staff[0].takeHomeFixed, true, 'and the screen is told');
});

test('a figure already stored keeps its meaning when nothing says otherwise', async () => {
  // Every take-home in the database before this change includes an old bonus.
  // An upload, or a screen from before this, that does not mention the
  // meaning must not quietly turn 2,439 into a fixed salary and pay the bonus
  // twice.
  const { db, raw } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2439, allowances: [] }] },
  }));
  assert.equal(basisOf(raw).take_home_basis, null, 'the whole amount');

  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2439, allowances: [] }] },
  }));
  assert.equal(basisOf(raw).take_home_basis, null, 'still the whole amount');
});

test('it can be switched back to the whole amount, for a flat rate', async () => {
  const { db, raw } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 587.8, ssnit: true, takeHome: 549.68, takeHomeFixed: true, allowances: [] }] },
  }));
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 587.8, ssnit: true, takeHome: 600, takeHomeFixed: false, allowances: [] }] },
  }));
  assert.deepEqual({ ...basisOf(raw) }, { take_home: 600, take_home_basis: null });
});

test('emptying the figure clears its meaning with it', async () => {
  const { db, raw } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 1850, takeHomeFixed: true, allowances: [] }] },
  }));
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: '', takeHomeFixed: true, allowances: [] }] },
  }));
  assert.deepEqual({ ...basisOf(raw) }, { take_home: null, take_home_basis: null });
});
