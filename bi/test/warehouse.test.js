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

/**
 * Payroll, from HIVE to the warehouse.
 *
 * Kept at its own grain and outside the daily window-replace cycle, which is
 * the part most likely to be got wrong: a payslip belongs to the month it was
 * run for, and a loader that treated it like everything else would either
 * delete it on the next daily reload or double it.
 */
test('a run loads payslips at their own grain', async () => {
  const { raw } = await loaded();
  const slips = raw.prepare('SELECT * FROM fact_payroll').all();
  assert.ok(slips.length > 0, 'the demonstration runs payroll');

  for (const slip of slips) {
    assert.match(slip.month, /^\d{4}-\d{2}$/, 'a payslip is a month, not a day');
    // Every column is pesewas. A cedis figure would be small enough to look
    // like a plausible daily amount, which is why it is worth asserting.
    for (const field of ['gross', 'ssf_employee', 'ssf_employer', 'paye', 'net', 'cost']) {
      assert.ok(Number.isInteger(slip[field]), `${field} is ${slip[field]}`);
      assert.ok(slip[field] >= 0, `${field} is negative`);
    }
    assert.equal(slip.cost, slip.gross + slip.ssf_employer,
      'employer cost is gross plus the employer\'s pension');
    assert.ok(slip.net <= slip.gross, 'net cannot exceed gross');
  }
});

test('reloading rewrites a month\'s payslips rather than doubling them', async () => {
  const { raw, env } = await loaded();
  const before = raw.prepare('SELECT month, person_id, cost FROM fact_payroll ORDER BY month, person_id').all();
  assert.ok(before.length > 0);

  await runEtl(env, { ...WINDOW, trigger: 'test' });
  const after = raw.prepare('SELECT month, person_id, cost FROM fact_payroll ORDER BY month, person_id').all();

  assert.deepEqual(after, before, 'a second run must change nothing at all');
});

test('what people were down to work is stored, not assumed to be eight hours', async () => {
  const { raw } = await loaded();
  const shifts = raw.prepare(`
    SELECT DISTINCT expected_minutes FROM fact_person_day WHERE scheduled = 1`).all();
  assert.ok(shifts.length > 0);
  // The old code wrote scheduled_count * 480 into fact_labour and threw the
  // real figure away. Whatever the roster says now, it comes from the roster.
  // Aggregated on both sides before comparing. `fact_labour` is keyed by day,
  // line AND department, so one line can carry several rows; summing the
  // roster for a whole line and setting it against a single labour row counts
  // the same people more than once.
  const labour = raw.prepare(`
    SELECT day, line_id, SUM(expected_minutes) AS rolled
      FROM fact_labour GROUP BY day, line_id HAVING rolled > 0 LIMIT 20`).all();
  assert.ok(labour.length > 0, 'somebody was rostered');

  const roster = raw.prepare(`
    SELECT day, line_id, SUM(expected_minutes) AS summed
      FROM fact_person_day GROUP BY day, line_id`).all();
  const rosterBy = new Map(roster.map((r) => [`${r.day}|${r.line_id}`, r.summed]));

  for (const row of labour) {
    assert.equal(row.rolled, rosterBy.get(`${row.day}|${row.line_id}`),
      `${row.day} ${row.line_id}: the roll-up must sum the roster, not invent it`);
  }
});

test('a labour cost says which of the three it was built from', async () => {
  const { raw } = await loaded();
  const bases = raw.prepare('SELECT DISTINCT cost_basis FROM fact_labour').all().map((r) => r.cost_basis);
  assert.ok(bases.length > 0);
  for (const basis of bases) {
    assert.ok(['payslip', 'rate', 'default'].includes(basis), `unknown basis ${basis}`);
  }
  // The demonstration gives everybody a rate, so nothing should be falling
  // back to the property-wide guess. If this ever fails, the connector has
  // stopped sending rates and every wage figure has quietly become an
  // assumption again.
  assert.ok(!bases.includes('default'),
    `some labour is still costed at the flat default: ${bases.join(', ')}`);
});

test('the page says whether the wage bill was measured or assumed', async () => {
  const { db } = await loaded();
  const { loadFacts: load } = await import('../src/insight/facts.js');
  const { wageBasisNote } = await import('../src/routes/panels.js');
  const config = { currencySymbol: 'GH₵', defaultHourCost: 1200 };
  const facts = await load(db, WINDOW.from, WINDOW.to);

  // Everybody in the demonstration has a rate, so this must not describe
  // itself as an estimate.
  const measured = wageBasisNote(facts, config);
  assert.match(measured, /own rate/);
  assert.doesNotMatch(measured, /assumed|guess/);
  // And it must not overclaim: a rate priced against hours is still not what a
  // payslip says, and the sentence has to admit that.
  assert.match(measured, /not the payroll figure/);

  // With nobody's rate known, it says so plainly rather than quietly reporting
  // a flat figure as though it were measured.
  const guessed = wageBasisNote(
    { labour: facts.labour.map((r) => ({ ...r, cost_basis: 'default' })) }, config);
  assert.match(guessed, /nobody has a rate recorded/);
  assert.match(guessed, /guess/);

  // And a mixture reports how much of the bill is which, rather than picking
  // whichever description flatters.
  const half = facts.labour.map((r, i) => ({ ...r, cost_basis: i % 2 ? 'default' : 'rate' }));
  assert.match(wageBasisNote({ labour: half }, config), /\d+% of the bill/);

  assert.match(wageBasisNote({ labour: [] }, config), /No wage cost is recorded/);
});
