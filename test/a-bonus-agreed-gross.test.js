import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { RATES } from '../src/lib/tax.js';
import { computeLine } from '../src/lib/payroll.js';
import { payroll, saveScheme, setProfiles, setScores } from '../src/routes/payroll.js';

/**
 * A bonus agreed gross rather than net.
 *
 * The normal case here is a net promise: five hundred agreed, five hundred in
 * the hand, and the property carries the tax that makes it true. Some figures
 * were never that. They were worked back out of a take-home somebody had
 * already settled on, so the tax is already inside them, and grossing one up
 * again pays the same tax twice and hands the person more than was agreed.
 *
 * Which it is belongs to the person, not to the scheme: the same Nkosoo tier
 * can be a net promise to one of them and a gross figure for the next.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rates = RATES;

const line = (over = {}) => computeLine({
  staff: { id: 1, name: 'Kofi Mensah' },
  basic: 2000,
  allowances: [{ name: 'Allowance', amount: 500, taxable: 1 }],
  schemes: [{ id: 1, name: 'Nkosoɔ', amount: 400, score: 100 }],
  ssnit: true,
  rates,
  ...over,
});

// ---------------------------------------------------------------------------
// What it does to one line
// ---------------------------------------------------------------------------

test('a bonus agreed gross is taxed as it stands', () => {
  const gross = line({ bonusIsNet: false });
  assert.equal(gross.bonus.gross, 400, 'the figure agreed, not a grossed-up one');
  assert.equal(gross.bonus.net, 400);
  assert.equal(gross.bonus.isNet, false);
});

test('and the property carries nothing on top of it', () => {
  const gross = line({ bonusIsNet: false });
  assert.equal(gross.bonus.tax, 0);
  assert.equal(gross.slip.carried, 0);
  assert.deepEqual(gross.slip.allowances, [
    { name: 'Allowance', amount: 500, taxable: true },
  ], 'the allowance is the allowance, with nothing folded into it');
});

test('the tax on it is still worked out, it just comes out of the bonus', () => {
  const gross = line({ bonusIsNet: false });
  // 400 is inside 15% of a 2,000 basic, so all of it takes the 5% final rate.
  assert.equal(gross.bonus.ceiling, 300);
  assert.equal(gross.bonus.atFinalRate, 300);
  assert.equal(gross.bonus.atGraduated, 100);
  assert.equal(gross.bonus.finalTax, 15);
  assert.ok(gross.bonus.graduatedTax > 0, 'and the hundred over the cap goes through the bands');
});

test('the person takes home less than they would on a net promise', () => {
  const net = line();
  const gross = line({ bonusIsNet: false });

  assert.ok(net.gross > gross.gross, 'a net promise costs the property more');
  assert.ok(net.net > gross.net, 'and puts more in the hand');
  assert.equal(round2(net.gross - gross.gross), net.slip.carried,
    'and the whole of the difference is what was carried');
});

test('the earnings column still adds to the gross either way', () => {
  for (const isNet of [true, false]) {
    const l = line({ bonusIsNet: isNet });
    const shown = round2(
      l.basic + l.slip.allowances.reduce((n, a) => n + a.amount, 0) + l.slip.bonus,
    );
    assert.equal(shown, l.gross, `adds up with bonusIsNet ${isNet}`);
  }
});

test('the cap still bites on a bonus agreed gross', () => {
  // 900 against a 2,000 basic: 300 at the 5% final rate, 600 through the bands.
  const l = line({ bonusIsNet: false, schemes: [{ id: 1, name: 'N', amount: 900, score: 100 }] });
  assert.equal(l.bonus.atFinalRate, 300);
  assert.equal(l.bonus.atGraduated, 600);
  assert.equal(l.bonus.finalTax, 15);
});

test('a bonus of nothing behaves the same both ways', () => {
  const net = line({ schemes: [] });
  const gross = line({ bonusIsNet: false, schemes: [] });
  assert.equal(net.gross, gross.gross);
  assert.equal(net.net, gross.net);
  assert.equal(gross.bonus.gross, 0);
});

test('saying nothing about it means net, which is what everything already was', () => {
  const said = line({ bonusIsNet: true });
  const unsaid = line();
  assert.equal(unsaid.bonus.isNet, true);
  assert.equal(unsaid.gross, said.gross);
  assert.ok(unsaid.slip.carried > 0);
});

test('a deduction for misconduct still comes off before the tax', () => {
  const l = line({ bonusIsNet: false, penalties: [{ amount: 100 }] });
  assert.equal(l.bonus.earned, 400);
  assert.equal(l.bonus.docked, 100);
  assert.equal(l.bonus.gross, 300, 'three hundred is what is taxed');
});

// ---------------------------------------------------------------------------
// Setting it, one person at a time
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
const read = async (response) => response.json();
const MONTH = '2026-07';

const both = (db, rows) => setProfiles(ctx(db, { body: { rows } }));

test('the tick is kept against the person and comes back', async () => {
  const { db } = setup();
  await both(db, [
    { staffId: 1, basic: 2000, ssnit: true, bonusIsNet: true },
    { staffId: 2, basic: 2000, ssnit: true, bonusIsNet: false },
  ]);

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  const by = new Map(data.staff.map((s) => [s.id, s]));
  assert.equal(by.get(1).bonusIsNet, true);
  assert.equal(by.get(2).bonusIsNet, false);
});

test('and a save that does not ask about it leaves it where it was', async () => {
  const { db } = setup();
  await both(db, [{ staffId: 2, basic: 2000, ssnit: true, bonusIsNet: false }]);
  // What a spreadsheet upload sends: a basic and nothing else.
  await both(db, [{ staffId: 2, basic: 2200, ssnit: true }]);

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  const mine = data.staff.find((s) => s.id === 2);
  assert.equal(mine.basic, 2200);
  assert.equal(mine.bonusIsNet, false, 'still gross, not quietly put back to net');
});

test('somebody new is net, because that is what every figure here was', async () => {
  const { db } = setup();
  await both(db, [{ staffId: 1, basic: 2000, ssnit: true }]);
  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(data.staff.find((s) => s.id === 1).bonusIsNet, true);
});

test('two people on the same scheme are paid by their own tick', async () => {
  const { db } = setup();
  await both(db, [
    { staffId: 1, basic: 2000, ssnit: true, bonusIsNet: true },
    { staffId: 2, basic: 2000, ssnit: true, bonusIsNet: false },
  ]);
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Nkosoɔ', amount: 400, departments: [], staffIds: [1, 2] },
  })));
  await setScores(ctx(db, {
    body: {
      month: MONTH,
      rows: [
        { schemeId: scheme.id, staffId: 1, score: 100 },
        { schemeId: scheme.id, staffId: 2, score: 100 },
      ],
    },
  }));

  const data = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  const by = new Map(data.lines.map((l) => [l.staff.id, l]));

  assert.equal(by.get(1).bonus.isNet, true);
  assert.equal(by.get(2).bonus.isNet, false);
  assert.equal(by.get(2).bonus.gross, 400, 'the figure as it stands');
  assert.ok(by.get(1).bonus.gross > 400, 'and the other one grossed up');
  assert.ok(by.get(1).net > by.get(2).net, 'so the net promise takes home more');
});
