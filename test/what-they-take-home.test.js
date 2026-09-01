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
 * What is agreed at this property is what lands in the hand, bonus included:
 * Linda is on 2,480 a month and scores what she scores. The allowance is
 * simply whatever is left to make that figure come out, and it was being
 * worked out on a spreadsheet and typed in by hand every month.
 */

const TIERS = { tier1: 0.135, tier2: 0.05 };
const line = (o) => computeLine({
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

test('it holds when a score moves, which is the whole point', async () => {
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
