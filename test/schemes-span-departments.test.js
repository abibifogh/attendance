import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { payroll, saveScheme } from '../src/routes/payroll.js';

/**
 * A bonus scheme can cover more than one department.
 *
 * The kitchen and the bistro share a service bonus. Filing it under one of
 * them left the other half of the staff ticked in as strays, and making it
 * General made a property-wide scheme most of the property is not on.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_scheme;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, name, dept] of [[1, 'Kofi', 'Kitchen'], [2, 'Ama', 'Bistro'], [3, 'Yaw', 'Front']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, ?, '2020-01-01')`,
    ).run(id, String(id), name, dept);
    raw.prepare('INSERT INTO pay_profile (staff_id, basic) VALUES (?, 1500)').run(id);
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

test('a scheme can be saved against two departments', async () => {
  const { raw, db } = setup();
  await saveScheme(ctx(db, {
    body: {
      name: 'Service', amount: 400, departments: ['Kitchen', 'Bistro'], staffIds: [1, 2],
    },
  }));

  const row = raw.prepare('SELECT * FROM pay_scheme').get();
  assert.deepEqual(JSON.parse(row.departments), ['Bistro', 'Kitchen'], 'stored in order');
  assert.equal(row.department, null, 'two departments have no single answer to give');

  const out = await (await payroll(ctx(db, { query: '?month=2026-06' }))).json();
  assert.deepEqual(out.schemes[0].departments, ['Bistro', 'Kitchen']);
});

test('one department still reads back both ways', async () => {
  const { raw, db } = setup();
  await saveScheme(ctx(db, { body: { name: 'Kitchen bonus', amount: 200, departments: ['Kitchen'] } }));

  const row = raw.prepare('SELECT * FROM pay_scheme').get();
  assert.equal(row.department, 'Kitchen');
  assert.deepEqual(JSON.parse(row.departments), ['Kitchen']);
});

test('ticking nothing is the whole property, and says so', async () => {
  const { raw, db } = setup();
  await saveScheme(ctx(db, { body: { name: 'The year', amount: 900, departments: [] } }));

  const row = raw.prepare('SELECT * FROM pay_scheme').get();
  assert.equal(row.department, null);
  assert.equal(row.departments, null, 'not an empty list, which would read as a gap');

  const out = await (await payroll(ctx(db, { query: '?month=2026-06' }))).json();
  assert.deepEqual(out.schemes[0].departments, []);
});

test('a scheme written before this reads as the one department it named', async () => {
  const { raw, db } = setup();
  raw.prepare(
    "INSERT INTO pay_scheme (id, name, amount, department) VALUES (1, 'Old', 300, 'Front')",
  ).run();

  const out = await (await payroll(ctx(db, { query: '?month=2026-06' }))).json();
  assert.deepEqual(out.schemes[0].departments, ['Front']);
});

test('the same department twice is one department', async () => {
  const { raw, db } = setup();
  await saveScheme(ctx(db, {
    body: { name: 'Service', amount: 400, departments: ['Kitchen', ' Kitchen ', ''] },
  }));
  assert.deepEqual(JSON.parse(raw.prepare('SELECT * FROM pay_scheme').get().departments), ['Kitchen']);
});

test('changing a scheme to span two takes the single name off', async () => {
  const { raw, db } = setup();
  const made = await (await saveScheme(
    ctx(db, { body: { name: 'Service', amount: 400, departments: ['Kitchen'] } }),
  )).json();

  await saveScheme(ctx(db, {
    body: { id: made.id, name: 'Service', amount: 400, departments: ['Kitchen', 'Bistro'] },
  }));

  const row = raw.prepare('SELECT * FROM pay_scheme').get();
  assert.equal(row.department, null);
  assert.deepEqual(JSON.parse(row.departments), ['Bistro', 'Kitchen']);
});

test('who is under it is still whoever was ticked, department or not', async () => {
  const { raw, db } = setup();
  await saveScheme(ctx(db, {
    body: { name: 'Service', amount: 400, departments: ['Kitchen', 'Bistro'], staffIds: [1, 2, 3] },
  }));
  const under = raw.prepare('SELECT staff_id FROM pay_scheme_staff ORDER BY staff_id').all();
  assert.deepEqual(under.map((r) => r.staff_id), [1, 2, 3],
    'somebody ticked in from elsewhere stays under it');
});

// ---------------------------------------------------------------------------
// How the screen groups them
// ---------------------------------------------------------------------------

const { sayDepartments, schemeDepartments, schemesByDepartment } = await import('../public/js/views/att-shared.js');

test('the departments read out however the row stores them', () => {
  assert.deepEqual(schemeDepartments({ departments: '["Kitchen","Bistro"]' }), ['Bistro', 'Kitchen']);
  assert.deepEqual(schemeDepartments({ departments: ['Front'] }), ['Front']);
  assert.deepEqual(schemeDepartments({ department: 'Front' }), ['Front'], 'a row written before');
  assert.deepEqual(schemeDepartments({}), []);
  assert.deepEqual(schemeDepartments({ departments: 'not json' }), []);
});

test('a set of departments reads as a sentence', () => {
  assert.equal(sayDepartments([]), 'General');
  assert.equal(sayDepartments(['Kitchen']), 'Kitchen');
  assert.equal(sayDepartments(['Kitchen', 'Bistro']), 'Kitchen and Bistro');
  assert.equal(sayDepartments(['Kitchen', 'Bistro', 'Bar']), 'Kitchen, Bistro and Bar');
});

test('a scheme spanning two sits under one heading, not under each', () => {
  const groups = schemesByDepartment([
    { id: 1, name: 'Service', departments: ['Kitchen', 'Bistro'] },
    { id: 2, name: 'Kitchen only', departments: ['Kitchen'] },
    { id: 3, name: 'The year', departments: [] },
  ]);

  assert.deepEqual(groups.map((g) => g.name), ['Bistro and Kitchen', 'Kitchen', 'General']);
  // One card per scheme. Two would be two sets of score boxes for one scheme,
  // and whichever was typed into last would win without anybody being told.
  assert.equal(groups.reduce((n, g) => n + g.schemes.length, 0), 3);
});

test('two schemes over the same pair share a heading', () => {
  const groups = schemesByDepartment([
    { id: 1, name: 'Service', departments: ['Kitchen', 'Bistro'] },
    { id: 2, name: 'Covers', departments: ['Bistro', 'Kitchen'] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].schemes.length, 2);
});

test('General is always last', () => {
  const groups = schemesByDepartment([
    { id: 1, name: 'Everyone', departments: [] },
    { id: 2, name: 'Aardvark', departments: ['Aardvark'] },
  ]);
  assert.equal(groups[groups.length - 1].name, 'General');
});
