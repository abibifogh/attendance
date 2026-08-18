import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { runEtl } from '../src/warehouse/etl.js';
import { nameKey, orgKey, itemKey, Register } from '../src/warehouse/identity.js';
import { all, first, groupConfig, setSetting } from '../src/lib/db.js';
import { loadFacts, totals } from '../src/insight/facts.js';

/**
 * The loader, against a real database.
 *
 * Everything interesting about an ETL is a property of its SQL — that a reload
 * replaces rather than doubles, that a failed source does not blank a week,
 * that a person known to three systems ends up as one row. None of those can
 * be caught by a stub, so this runs the migrations into SQLite and drives the
 * real code with the demonstration connectors behind it.
 */

const WINDOW = { from: '2026-05-01', to: '2026-06-15' };

async function loaded() {
  const { raw, db } = freshDb('migrations');
  const env = { DB: db };
  const run = await runEtl(env, { ...WINDOW, trigger: 'test' });
  return { raw, db, env, run };
}

test('a run loads every fact table from all four sources', async () => {
  const { raw, run } = await loaded();
  assert.equal(run.status, 'ok');
  assert.equal(run.sources.length, 4);
  for (const source of run.sources) assert.equal(source.status, 'demo');

  const counts = {};
  for (const table of ['fact_revenue', 'fact_labour', 'fact_cost', 'fact_demand',
    'fact_service', 'fact_cash_control', 'fact_person_day', 'fact_usage', 'fact_purchase_line']) {
    counts[table] = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.ok(counts[table] > 0, `${table} should have rows`);
  }
  // Every fact must fall inside the window it was asked for. A connector that
  // hands back a stray day would otherwise quietly corrupt a month.
  for (const table of ['fact_revenue', 'fact_labour', 'fact_demand', 'fact_person_day']) {
    const stray = raw.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE day < ? OR day > ?`).get(WINDOW.from, WINDOW.to).n;
    assert.equal(stray, 0, `${table} has rows outside the window`);
  }
});

test('running twice over the same window does not double anything', async () => {
  const { raw, env } = await loaded();
  const before = raw.prepare('SELECT SUM(net) AS net, COUNT(*) AS n FROM fact_revenue').get();

  await runEtl(env, { ...WINDOW, trigger: 'test' });
  const after = raw.prepare('SELECT SUM(net) AS net, COUNT(*) AS n FROM fact_revenue').get();

  assert.equal(after.n, before.n);
  assert.equal(after.net, before.net);
});

test('a window with no source that answers leaves the existing facts alone', async () => {
  const { raw, db, env } = await loaded();
  const before = raw.prepare('SELECT COUNT(*) AS n FROM fact_revenue').get().n;

  // Demonstration mode off and nothing configured: every source skips.
  await setSetting(db, 'demo_mode', '0');
  const run = await runEtl(env, { ...WINDOW, trigger: 'test' });

  assert.equal(run.status, 'no-sources');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM fact_revenue').get().n, before,
    'a night when nothing answered must not read as a business that stopped trading');
});

test('money is whole pesewas everywhere it lands', async () => {
  const { raw } = await loaded();
  for (const column of ['net', 'collected', 'cash', 'card']) {
    const fractional = raw.prepare(
      `SELECT COUNT(*) AS n FROM fact_revenue WHERE ${column} <> CAST(${column} AS INTEGER)`).get().n;
    assert.equal(fractional, 0, `${column} must be whole minor units`);
  }
  const labour = raw.prepare(
    'SELECT COUNT(*) AS n FROM fact_labour WHERE labour_cost <> CAST(labour_cost AS INTEGER)').get().n;
  assert.equal(labour, 0);
});

test('labour is rolled up from the person-day rows it came from', async () => {
  const { raw } = await loaded();
  const person = raw.prepare('SELECT SUM(worked_minutes) AS m FROM fact_person_day').get().m;
  const rolled = raw.prepare('SELECT SUM(worked_minutes) AS m FROM fact_labour').get().m;
  assert.equal(rolled, person, 'the aggregate must not invent or lose minutes');
});

test('a person known to two systems becomes one row', async () => {
  const { raw, db } = await loaded();
  const register = new Register(db);
  await register.load();

  // Attendance meets her first, with an employee number. The laundry knows
  // only a name, and writes it the other way round.
  const byNumber = await register.person('attendance', {
    externalId: 'S900', name: 'Yaa Kusi', employeeNo: 'E900', department: 'Housekeeping',
  });
  const byName = await register.person('laundry', {
    externalId: 'yaa kusi', name: 'Kusi  Yaa',
  });
  assert.equal(byNumber, byName, 'the same person must not be two rows');

  await register.flush();
  const links = raw.prepare('SELECT * FROM person_link WHERE person_id = ?').all(byNumber);
  assert.equal(links.length, 2);
  assert.equal(links.find((l) => l.source_id === 'attendance').confidence, 'exact');
  assert.equal(links.find((l) => l.source_id === 'laundry').confidence, 'name',
    'a name-only match must be recorded as the weaker claim it is');
});

test('two people with the same name and different numbers stay two people', async () => {
  const { db } = await loaded();
  const register = new Register(db);
  await register.load();

  const first = await register.person('attendance', {
    externalId: 'S901', name: 'Kofi Asare', employeeNo: 'E901',
  });
  const second = await register.person('attendance', {
    externalId: 'S902', name: 'Kofi Asare', employeeNo: 'E902',
  });

  assert.notEqual(first, second,
    'merging two employee numbers would put one person\'s record on another');
});

test('the same system asking twice about the same person is answered from the link', async () => {
  const { db } = await loaded();
  const register = new Register(db);
  await register.load();
  const once = await register.person('pos', { externalId: 'p-1', name: 'Efua Addo' });
  const twice = await register.person('pos', { externalId: 'p-1', name: 'Efua Addo' });
  assert.equal(once, twice);
});

test('name, supplier and item keys normalise the way two systems actually differ', () => {
  assert.equal(nameKey('Mr. Kofi  Asare'), nameKey('asare kofi'));
  assert.equal(nameKey('Adwoa Sarpong'), 'adwoa sarpong');
  assert.notEqual(nameKey('Kofi Asare'), nameKey('Kofi Asante'),
    'two different people must never be merged');

  assert.equal(orgKey('Adom Foods Ltd.'), orgKey('ADOM FOODS'));
  assert.equal(orgKey('Silver Star Enterprises'), orgKey('Silver Star'));

  assert.equal(itemKey('Tomatoes (5kg crate)'), itemKey('tomato'));
  assert.equal(itemKey('Fresh Local Onions'), itemKey('onion'));
  assert.notEqual(itemKey('Cooking oil'), itemKey('Olive oil'));
});

test('the group totals add up from the rows underneath them', async () => {
  const { raw, db } = await loaded();
  const facts = await loadFacts(db, WINDOW.from, WINDOW.to);
  const t = totals(facts);

  const net = raw.prepare('SELECT SUM(net) AS n FROM fact_revenue').get().n;
  const labour = raw.prepare('SELECT SUM(labour_cost) AS n FROM fact_labour').get().n;
  const cost = raw.prepare('SELECT SUM(amount) AS n FROM fact_cost').get().n;

  assert.equal(t.net, net);
  assert.equal(t.labourCost, labour);
  assert.equal(t.cost, cost);
  assert.equal(t.contribution, net - cost - labour);
});

test('the run log records what each source did', async () => {
  const { db, run } = await loaded();
  const rows = await all(db, 'SELECT * FROM etl_source_run WHERE run_id = ?1', run.runId);
  assert.equal(rows.length, 4);
  const etl = await first(db, 'SELECT * FROM etl_run WHERE id = ?1', run.runId);
  assert.equal(etl.status, 'ok');
  assert.ok(etl.finished_at, 'a finished run must say when it finished');
});
