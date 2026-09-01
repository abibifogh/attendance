import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { computeLine } from '../src/lib/payroll.js';
import { RATES } from '../src/lib/tax.js';
import { payroll, saveScheme, setProfiles, setScores } from '../src/routes/payroll.js';
import { addAdvance } from '../src/routes/advances.js';

/**
 * A take-home agreed with somebody, and the bonus worked back from it.
 *
 * What is actually agreed at this property is what lands in the hand: Linda is
 * on 2,480 a month. The bonus is whatever makes that true once the allowances
 * and the tax have had their say, and it was being worked out on a spreadsheet
 * and typed in by hand every month.
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

test('the bonus lands the person exactly on what was agreed', () => {
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

test('it is worked out and not searched for, so it is exact rather than close', () => {
  // A bonus agreed net passes straight through to the take-home, cedi for
  // cedi, because the grossing-up is defined as whatever covers the tax on it.
  // So there is a right answer rather than a nearest one.
  // Above what the salary alone comes to, so there is a bonus to work out.
  // Below it there is nothing to solve, which is its own test further down.
  for (const target of [1200, 1234.56, 2480, 3999.99, 12000]) {
    assert.equal(line({ basic: 800, allow: 500, takeHome: target }).net, target);
  }
});

test('the property carries the tax, so the bonus shows as a net promise', () => {
  const l = line({ basic: 800, allow: 1437.64, takeHome: 2480 });
  assert.equal(l.bonus.solved, true);
  assert.equal(l.bonus.isNet, true, 'a solved bonus is a net promise by definition');
  assert.equal(l.bonus.takeHome, 2480);
  assert.ok(l.bonus.tax > 0, 'and the property is carrying something');
  assert.equal(round(l.bonus.gross - l.bonus.tax), l.bonus.net);
});

const round = (n) => Math.round(n * 100) / 100;

test('nothing set means nothing changes: the scores still decide', () => {
  const scored = line({ basic: 800, allow: 500, bonus: 400 });
  assert.equal(scored.bonus.solved, false);
  assert.equal(scored.bonus.net, 400);
  assert.equal(scored.bonus.takeHome, null);
  assert.equal(scored.bonus.scored, 400);
});

test('a take-home of nought is a real answer and not the same as leaving it blank', () => {
  const blank = line({ basic: 800, allow: 500, bonus: 400, takeHome: null });
  assert.equal(blank.bonus.net, 400);
  const nought = line({ basic: 800, allow: 500, bonus: 400, takeHome: 0 });
  assert.equal(nought.bonus.net, 0, 'nought means no bonus, whatever they scored');
  assert.equal(nought.bonus.solved, true);
});

// ---------------------------------------------------------------------------
// What it is measured before
// ---------------------------------------------------------------------------

test('an advance still costs them, rather than being made up by a bigger bonus', () => {
  // Vivian: agreed 1,530 a month, repaying 1,200. She takes home 330, and the
  // property does not quietly hand back its own advance.
  const l = line({ basic: 587.80, allow: 491.47, takeHome: 1530, loan: 1200 });
  assert.equal(l.net, 330);
  assert.equal(l.loanTotal, 1200);

  const without = line({ basic: 587.80, allow: 491.47, takeHome: 1530 });
  assert.equal(without.bonus.net, l.bonus.net, 'the same bonus either way');
});

test('money docked off a bonus still costs them', () => {
  const clean = line({ basic: 800, allow: 500, takeHome: 2000 });
  const docked = line({ basic: 800, allow: 500, takeHome: 2000, docked: 100 });
  assert.equal(clean.net, 2000);
  assert.equal(docked.net, 1900, 'a hundred off is a hundred out of their hand');
});

test('a deduction bigger than the bonus is not taken out of their salary', () => {
  const l = line({ basic: 800, allow: 500, takeHome: 1400, docked: 5000 });
  assert.equal(l.bonus.net, 0);
  assert.ok(l.bonus.notTaken > 0, 'and what could not be taken is said');
  assert.ok(l.net > 0);
});

// ---------------------------------------------------------------------------
// When it cannot be met
// ---------------------------------------------------------------------------

test('somebody already past their figure gets no bonus, and no pay cut', () => {
  // Their salary and allowances alone take them past it. The app will not
  // claw money back to get down to the number.
  const l = line({ basic: 2000, allow: 2000, takeHome: 1000 });
  assert.equal(l.bonus.net, 0);
  assert.equal(l.bonus.overshoots, true, 'and the screen is told');
  assert.ok(l.net > 1000, 'they keep what their salary comes to');
});

test('a figure that is met to the penny does not read as overshooting', () => {
  const bare = line({ basic: 800, allow: 500 });
  const l = line({ basic: 800, allow: 500, takeHome: bare.net });
  assert.equal(l.bonus.net, 0);
  assert.equal(l.bonus.overshoots, false);
  assert.equal(l.net, bare.net);
});

// ---------------------------------------------------------------------------
// The score is not thrown away
// ---------------------------------------------------------------------------

test('what they scored is still reported, even where it no longer sets the money', () => {
  const l = line({ basic: 800, allow: 500, bonus: 400, score: 75, takeHome: 2000 });
  assert.equal(l.bonus.scored, 300, 'three quarters of a four hundred scheme');
  assert.notEqual(l.bonus.net, 300, 'but the take-home is what decides the money');
  assert.equal(l.net, 2000);
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
    body: {
      rows: [{
        staffId: 1, basic: 800, ssnit: true, bonusIsNet: false, takeHome: 2480,
        allowances: [{ name: 'Allowance', amount: 1437.64, taxable: true }],
      }],
    },
  }));

  for (const month of [MONTH, '2026-09', '2026-10']) {
    const data = await read(await payroll(ctx(db, { query: `?month=${month}` })));
    assert.equal(data.lines[0].net, 2480, `${month} lands on it too`);
    assert.equal(data.lines[0].bonus.solved, true);
  }
});

test('it holds when an allowance moves, which is the whole point', async () => {
  const { db } = setup();
  const save = (allow) => setProfiles(ctx(db, {
    body: {
      rows: [{
        staffId: 1, basic: 800, ssnit: true, bonusIsNet: false, takeHome: 2480,
        allowances: [{ name: 'Allowance', amount: allow, taxable: true }],
      }],
    },
  }));

  await save(1437.64);
  const before = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  await save(1800);
  const after = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));

  assert.equal(before.lines[0].net, 2480);
  assert.equal(after.lines[0].net, 2480, 'still exactly on it');
  assert.ok(after.lines[0].bonus.net < before.lines[0].bonus.net,
    'and the bonus came down by itself to make room for the bigger allowance');
});

test('the screen is told which lines were worked back, and what was agreed', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2480, allowances: [] }] },
  }));
  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.staff[0].takeHome, 2480);
  assert.equal(data.lines[0].bonus.takeHome, 2480);
});

test('emptying the box puts them back on their scores, and a silent form does not', async () => {
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
  assert.equal(data.lines[0].bonus.solved, false);
});

test('a scored bonus and a take-home together: the take-home wins and the score is kept', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 800, ssnit: true, takeHome: 2000, allowances: [] }] },
  }));
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Nkosoɔ', amount: 900, departments: [], staffIds: [1] },
  })));
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] },
  }));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.lines[0].net, 2000);
  assert.equal(data.lines[0].bonus.scored, 900, 'what they scored is still on the line');
  assert.notEqual(data.lines[0].bonus.net, 900);
});

test('an advance running against a take-home comes off after it, not out of it', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: {
      rows: [{
        staffId: 1, basic: 800, ssnit: true, takeHome: 2480,
        allowances: [{ name: 'Allowance', amount: 1437.64, taxable: true }],
      }],
    },
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
