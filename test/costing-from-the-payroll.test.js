import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { labourCost } from '../src/routes/pay.js';
import { setProfiles } from '../src/routes/payroll.js';

/**
 * What the rota costs, when the only figures the property has are the
 * payroll's.
 *
 * This report read hr_pay and nothing else. hr_pay is a table only this report
 * writes to, so a property that set everybody up under Payroll had every
 * single person come back as having no rate, and the card said nothing at all.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
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
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/pay/cost${query}`),
  session: WAGES,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (response) => response.json();
const WINDOW = '?from=2026-08-01&to=2026-08-14';

test('nobody set up anywhere is still reported as missing', async () => {
  const { db } = setup();
  const data = await read(await labourCost(ctx(db, { query: WINDOW })));
  assert.equal(data.rows.length, 0);
  assert.deepEqual(data.missing.map((m) => m.name), ['Ama Boateng', 'Kofi Mensah']);
  assert.equal(data.totals.total, 0);
});

test('somebody on the payroll is costed from the payroll', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: {
      rows: [{
        staffId: 1,
        basic: 2000,
        ssnit: true,
        allowances: [{ name: 'Transport', amount: 300, taxable: true }],
      }],
    },
  }));

  const data = await read(await labourCost(ctx(db, { query: WINDOW })));
  const [row] = data.rows;

  assert.equal(row.staff.name, 'Ama Boateng');
  assert.equal(row.source, 'payroll');
  assert.equal(data.fromPayroll, 1);
  // 2,000 basic, 300 of allowances, and 13% of the basic as the property's own
  // pension contribution: 2,560 a month.
  assert.equal(row.cost.rate, 2560);
  assert.equal(row.cost.basis, 'monthly');
  assert.ok(row.cost.total > 0, 'and it costs something, which is the whole point');
  assert.deepEqual(data.missing.map((m) => m.name), ['Kofi Mensah']);
});

test('the property own contribution is left out for anybody not on SSNIT', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: false, allowances: [] }] },
  }));
  const data = await read(await labourCost(ctx(db, { query: WINDOW })));
  assert.equal(data.rows[0].cost.rate, 2000);
});

test('a dated rate is used ahead of the payroll, because it says when', async () => {
  const { raw, db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: false, allowances: [] }] },
  }));
  raw.prepare(
    `INSERT INTO hr_pay (staff_id, basis, amount, currency, from_day)
     VALUES (1, 'monthly', 1500, 'GHS', '2026-01-01')`,
  ).run();

  const data = await read(await labourCost(ctx(db, { query: WINDOW })));
  assert.equal(data.rows[0].source, 'rate');
  assert.equal(data.rows[0].cost.rate, 1500, 'what they were on, not what they are on');
  assert.equal(data.fromPayroll, 0);
});

test('a rate that starts after the window falls back rather than showing nothing', async () => {
  const { raw, db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: false, allowances: [] }] },
  }));
  // Somebody typed a rise that starts in September while looking at August.
  raw.prepare(
    `INSERT INTO hr_pay (staff_id, basis, amount, currency, from_day)
     VALUES (1, 'monthly', 2600, 'GHS', '2026-09-01')`,
  ).run();

  const data = await read(await labourCost(ctx(db, { query: WINDOW })));
  assert.equal(data.rows.length, 1, 'still costed');
  assert.equal(data.rows[0].source, 'payroll');
  assert.equal(data.rows[0].cost.rate, 2000);
});

test('a profile with nothing in it is not a rate of nought', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: { rows: [{ staffId: 1, basic: 0, ssnit: false, allowances: [] }] },
  }));
  const data = await read(await labourCost(ctx(db, { query: WINDOW })));
  assert.equal(data.rows.length, 0, 'a zero would read as an answer');
  assert.deepEqual(data.missing.map((m) => m.name), ['Ama Boateng', 'Kofi Mensah']);
});

test('the whole month adds up across everybody on the payroll', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, {
    body: {
      rows: [
        { staffId: 1, basic: 2000, ssnit: true, allowances: [] },
        { staffId: 2, basic: 1000, ssnit: true, allowances: [] },
      ],
    },
  }));
  const data = await read(await labourCost(ctx(db, { query: WINDOW })));
  assert.equal(data.rows.length, 2);
  assert.equal(data.fromPayroll, 2);
  assert.deepEqual(data.missing, []);
  assert.ok(data.totals.total > 0);
  assert.equal(
    data.totals.total,
    Math.round(data.rows.reduce((n, r) => n + r.cost.total, 0) * 100) / 100,
  );
});
