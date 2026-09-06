import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pull, check, lineFor, analyticName, odooConfig, accountKind } from '../src/connectors/odoo.js';

/**
 * Reading Odoo.
 *
 * Three things here would be wrong in a way nobody catches for a quarter.
 *
 * The money. Odoo hands out floats in the company currency; this warehouse is
 * whole pesewas. `toMinor`, never `minor` — the same trap HIVE, breakfast and
 * the laundry all carry, and the POS does not.
 *
 * The sign. A credit note is stored with positive amounts and distinguished
 * only by `move_type`. Read as written, every return inflates the supplier it
 * came from instead of reducing it.
 *
 * The lines. A vendor bill carries tax lines and a balancing payable line as
 * well as product lines. Counting those as purchases doubles every total and
 * invents a supplier called "Accounts Payable".
 */

const SOURCE = {
  id: 'odoo',
  kind: 'odoo_json2',
  config: {
    base: 'https://nice.odoo.com/',
    db: 'nice',
    secretName: 'ODOO_KEY_ODOO',
    lineBy: 'analytic',
    lineMap: { 12: 'restaurant', 13: 'laundry', 'Vendor Bills': 'admin' },
  },
};
const ENV = { ODOO_KEY_ODOO: 'a-key' };

/**
 * Call the connector the way the registry calls it: `{ config, token }`.
 *
 * These tests used to pass `{ source, env }`, which is the shape the connector
 * was written to take and the shape nothing else in the app uses. Every test
 * passed and Odoo could never connect — it read an empty address and reported
 * "No Odoo address is configured" whatever was typed into Setup. Going through
 * the same door the app goes through is the only thing that would have caught
 * it, and `test/connectors.test.js` now does that for every connector.
 */
const asRegistry = ({ source = SOURCE, env = ENV, ...rest }) => ({
  config: source.config,
  token: env[source.config.secretName],
  ...rest,
});

/**
 * An Odoo that answers from a script, and records what it was asked.
 *
 * Keyed by `model/method`, so a test says what each model returns without
 * caring about the order the connector reads them in.
 */
function fakeOdoo(byModel) {
  const seen = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;                 // /json/2/<model>/<method>
    const key = path.replace('/json/2/', '');
    seen.push({ url, path, key, headers: init.headers, body: JSON.parse(init.body) });
    const answer = byModel[key];
    if (answer === undefined) return { ok: true, status: 200, json: async () => [] };
    if (typeof answer === 'number') {
      return { ok: false, status: answer, json: async () => ({ error: 'no' }) };
    }
    // Honour paging, so a test can exercise it without writing 500 rows.
    const { offset = 0, limit = 500 } = seen[seen.length - 1].body;
    return { ok: true, status: 200, json: async () => answer.slice(offset, offset + limit) };
  };
  impl.seen = seen;
  return impl;
}

const move = (over) => ({
  id: 1, name: 'BILL/2026/0001', ref: 'INV-4471',
  invoice_date: '2026-05-04', invoice_date_due: '2026-06-03',
  partner_id: [7, 'Adom Foods'], move_type: 'in_invoice',
  state: 'posted', payment_state: 'not_paid',
  amount_untaxed: 2450.75, amount_tax: 0, amount_total: 2450.75, amount_residual: 2450.75,
  currency_id: [1, 'GHS'], journal_id: [3, 'Vendor Bills'], ...over,
});

const moveLine = (over) => ({
  id: 100, move_id: [1, 'BILL/2026/0001'], product_id: [55, 'Eggs'],
  name: 'Eggs', quantity: 10, price_unit: 245.075,
  price_subtotal: 2450.75, price_total: 2450.75,
  account_id: [40, '6010 Food purchases'], product_uom_id: [2, 'crate'],
  analytic_distribution: { 12: 100 }, purchase_line_id: [9, 'PO/001'],
  date: '2026-05-04', ...over,
});

const window = { from: '2026-05-01', to: '2026-05-31' };

/* ------------------------------------------------------------- the money -- */

test('a bill arrives in pesewas, not in cedis', async () => {
  const fetchImpl = fakeOdoo({
    'account.move/search_read': [move({})],
    'account.move.line/search_read': [moveLine({})],
  });
  const bundle = await pull(asRegistry({ ...window, fetchImpl }));

  const bill = bundle.bills[0];
  // GH₵2,450.75. Written out because the entire risk is a factor of a hundred.
  assert.equal(bill.total, 245_075);
  assert.equal(bill.untaxed, 245_075);
  assert.equal(bill.residual, 245_075);
  // What `minor()` would have produced, and what nothing downstream would
  // have complained about.
  assert.notEqual(bill.total, 2_451);

  const line = bundle.purchaseLines[0];
  assert.equal(line.amount, 245_075);
  // 245.075 cedis a crate rounds to 24,508 pesewas — the half-pesewa is the
  // sort of thing that only shows up as a reconciliation that will not close.
  assert.equal(line.unitCost, 24_508);
});

test('every money field is a whole number of pesewas', async () => {
  const fetchImpl = fakeOdoo({
    'account.move/search_read': [move({ amount_untaxed: 33.333, amount_tax: 5.0, amount_total: 38.333, amount_residual: 12.005 })],
    'account.move.line/search_read': [moveLine({ price_unit: 3.3333, price_subtotal: 33.333, price_total: 38.333 })],
  });
  const bundle = await pull(asRegistry({ ...window, fetchImpl }));
  for (const row of [...bundle.bills, ...bundle.purchaseLines]) {
    for (const [field, value] of Object.entries(row)) {
      if (typeof value !== 'number') continue;
      assert.ok(Number.isInteger(value), `${field} is ${value}`);
    }
  }
});

test('a credit note reduces a supplier rather than inflating it', async () => {
  const fetchImpl = fakeOdoo({
    'account.move/search_read': [
      move({}),
      move({ id: 2, move_type: 'in_refund', ref: 'CN-9', amount_untaxed: 500, amount_total: 500, amount_residual: 0 }),
    ],
    'account.move.line/search_read': [
      moveLine({}),
      moveLine({ id: 101, move_id: [2, 'CN/9'], quantity: 2, price_subtotal: 500, price_total: 500 }),
    ],
  });
  const bundle = await pull(asRegistry({ ...window, fetchImpl }));

  const credit = bundle.bills.find((b) => b.externalId === '2');
  assert.equal(credit.total, -50_000, 'a return is a negative purchase');

  const creditLine = bundle.purchaseLines.find((l) => l.billId === '2');
  assert.equal(creditLine.qty, -2, 'and negative quantity, so it is not read as a price');
  assert.equal(creditLine.amount, -50_000);
});

/* ------------------------------------------------------------- the lines -- */

test('only product lines are read, never tax or the payable', async () => {
  const fetchImpl = fakeOdoo({
    'account.move/search_read': [move({})],
    'account.move.line/search_read': [moveLine({})],
  });
  await pull(asRegistry({ ...window, fetchImpl }));

  const ask = fetchImpl.seen.find((s) => s.key === 'account.move.line/search_read');
  const domain = JSON.stringify(ask.body.domain);
  assert.match(domain, /"display_type","=",false/, 'section and note lines are not purchases');
  assert.match(domain, /"product_id","!=",false/, 'the tax and payable lines carry no product');
});

test('a line records which account it hit, and whether an order was behind it', async () => {
  const fetchImpl = fakeOdoo({
    'account.move/search_read': [move({}), move({ id: 2, ref: 'INV-2' })],
    'account.move.line/search_read': [
      moveLine({}),
      moveLine({ id: 101, move_id: [2, 'BILL/2'], purchase_line_id: false }),
    ],
  });
  const bundle = await pull(asRegistry({ ...window, fetchImpl }));

  assert.equal(bundle.purchaseLines[0].accountCode, '6010');
  assert.equal(bundle.bills.find((b) => b.externalId === '1').fromOrder, true);
  assert.equal(bundle.bills.find((b) => b.externalId === '2').fromOrder, false,
    'spend nobody agreed to first is only visible if this is right');
  assert.deepEqual(bundle.accounts, [{ code: '6010', name: '6010 Food purchases', kind: '' }]);
});

/* ---------------------------------------------------------- the protocol -- */

test('it speaks JSON-2, at the endpoint that will still exist', async () => {
  const fetchImpl = fakeOdoo({ 'account.move/search_read': [move({})] });
  await pull(asRegistry({ ...window, fetchImpl }));

  const ask = fetchImpl.seen[0];
  // The old /jsonrpc and /xmlrpc/2 endpoints go away in Odoo Online 21.1.
  assert.equal(ask.path, '/json/2/account.move/search_read');
  assert.equal(ask.headers.Authorization, 'bearer a-key');
  assert.match(ask.headers['Content-Type'], /application\/json/);
  assert.equal(ask.headers['X-Odoo-Database'], 'nice');

  // Named arguments. JSON-2 has no positional form, which is the one thing
  // every older example on the internet gets wrong.
  assert.ok(Array.isArray(ask.body.domain));
  assert.ok(Array.isArray(ask.body.fields));
  assert.equal(ask.body.order, 'id');
  assert.equal(typeof ask.body.limit, 'number');
});

test('the database header is sent only when a database was named', async () => {
  const fetchImpl = fakeOdoo({ 'account.move/search_read': [] });
  await pull(asRegistry({
    source: { ...SOURCE, config: { ...SOURCE.config, db: '' } }, ...window, fetchImpl,
  }));
  assert.equal(fetchImpl.seen[0].headers['X-Odoo-Database'], undefined);
});

test('paging is ordered by id, so nothing appears twice or not at all', async () => {
  // 600 bills: two pages, and the second must not repeat the first.
  const many = Array.from({ length: 600 }, (_, i) => move({ id: i + 1, ref: `INV-${i}` }));
  const fetchImpl = fakeOdoo({ 'account.move/search_read': many });
  const bundle = await pull(asRegistry({ ...window, fetchImpl }));

  assert.equal(bundle.bills.length, 600);
  assert.equal(new Set(bundle.bills.map((b) => b.externalId)).size, 600, 'no bill read twice');
  const asks = fetchImpl.seen.filter((s) => s.key === 'account.move/search_read');
  assert.deepEqual(asks.map((a) => a.body.offset), [0, 500]);
  // A date order with ties lets a record slide between pages. An id does not.
  assert.ok(asks.every((a) => a.body.order === 'id'));
});

test('the window is asked for by accounting date, and drafts are not excluded', async () => {
  const fetchImpl = fakeOdoo({ 'account.move/search_read': [] });
  await pull(asRegistry({ ...window, fetchImpl }));
  const domain = JSON.stringify(fetchImpl.seen[0].body.domain);

  assert.match(domain, /"invoice_date",">=","2026-05-01"/);
  assert.match(domain, /"invoice_date","<=","2026-05-31"/);
  // A bill keyed in three weeks late still belongs to its own month.
  assert.doesNotMatch(domain, /create_date/);
  // Cancelled moves are dropped at the source; drafts come through and are
  // filtered by the analysis, which needs to be able to count them.
  assert.match(domain, /"state","!=","cancel"/);
  assert.match(domain, /"move_type","in",\["in_invoice","in_refund"\]/);
});

/* ------------------------------------------------------------- failures -- */

test('a refused key is a sentence somebody can act on', async () => {
  const fetchImpl = fakeOdoo({ 'account.move/search_read': 401 });
  await assert.rejects(
    () => pull(asRegistry({ ...window, fetchImpl })),
    /refused the API key/,
  );
});

test('a missing key is caught before a request is made', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(
    () => pull(asRegistry({ env: {}, ...window, fetchImpl })),
    /No Odoo API key/,
  );
  assert.equal(called, false);
});

test('a wrong address says which thing to check', async () => {
  const fetchImpl = fakeOdoo({ 'account.move/search_read': 404 });
  await assert.rejects(
    () => pull(asRegistry({ ...window, fetchImpl })),
    /address is wrong/,
  );
});

test('the check reports what it connected to, or why it did not', async () => {
  const ok = await check(asRegistry({
    fetchImpl: fakeOdoo({ 'res.company/search_read': [{ id: 1, name: 'Nice Operation', currency_id: [1, 'GHS'] }] }),
  }));
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /Nice Operation/);
  assert.match(ok.detail, /GHS/);

  const bad = await check(asRegistry({ fetchImpl: fakeOdoo({ 'res.company/search_read': 401 }) }));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /refused the API key/);
});

/* --------------------------------------------------------------- lines -- */

test('an analytic account maps to a part of the business', () => {
  const config = odooConfig(SOURCE.config, ENV[SOURCE.config.secretName]);
  assert.equal(lineFor(config, { analytic: '12' }), 'restaurant');
  assert.equal(lineFor(config, { analytic: '13' }), 'laundry');
  // Unmapped lands in admin on purpose: an unexplained lump is a prompt to fix
  // the map. Spreading it quietly across the lines that earn flatters them all.
  assert.equal(lineFor(config, { analytic: '99' }), 'admin');
  assert.equal(lineFor(config, {}), 'admin');
});

test('the journal is the fallback when a line carries no analytic account', () => {
  const config = odooConfig(SOURCE.config, ENV[SOURCE.config.secretName]);
  assert.equal(lineFor(config, { journal: 'Vendor Bills' }), 'admin');
  assert.equal(lineFor(config, { journal: 'vendor bills' }), 'admin', 'a chart is typed by people');
});

test('an analytic distribution takes the largest share, not the first', () => {
  // Odoo 17 onward splits a line across accounts. Splitting the purchase would
  // be more faithful and would make its unit price incomparable with anything.
  assert.equal(analyticName({ 12: 30, 13: 70 }), '13');
  assert.equal(analyticName({ 12: 100 }), '12');
  assert.equal(analyticName({}), '');
  assert.equal(analyticName(false), '', 'Odoo says false, not null, for an unset field');
  assert.equal(analyticName(null), '');
});

test('Odoo account types reduce to the five the warehouse knows', () => {
  assert.equal(accountKind('expense_direct_cost'), 'expense');
  assert.equal(accountKind('income_other'), 'income');
  assert.equal(accountKind('asset_current'), 'asset');
  assert.equal(accountKind('liability_payable'), 'liability');
  assert.equal(accountKind('equity_unaffected'), 'equity');
  assert.equal(accountKind('something_new'), '');
  assert.equal(accountKind(false), '');
});

test('a bill with no lines is still a bill', async () => {
  const fetchImpl = fakeOdoo({
    'account.move/search_read': [move({})],
    'account.move.line/search_read': [],
  });
  const bundle = await pull(asRegistry({ ...window, fetchImpl }));
  assert.equal(bundle.bills.length, 1);
  assert.equal(bundle.purchaseLines.length, 0);
  assert.equal(bundle.bills[0].fromOrder, false, 'no lines means nothing traced to an order');
});

test('nothing in the window is nothing, not an error', async () => {
  const fetchImpl = fakeOdoo({ 'account.move/search_read': [] });
  const bundle = await pull(asRegistry({ ...window, fetchImpl }));
  assert.deepEqual(bundle.bills, []);
  assert.deepEqual(bundle.purchaseLines, []);
  // And no second call: there are no move ids to ask about.
  assert.equal(fetchImpl.seen.filter((s) => s.key === 'account.move.line/search_read').length, 0);
});
