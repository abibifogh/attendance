import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import * as shifts from '../src/routes/shifts.js';
import * as revenue from '../src/routes/revenue.js';
import * as cashpo from '../src/routes/cashpo.js';
import * as todo from '../src/routes/todo.js';
import { pnl } from '../src/routes/panels.js';
import { chooseCostBasis } from '../src/insight/facts.js';

/**
 * Money from what the shifts know: the rooms' revenue out of the ASSD journal,
 * spending paid in cash against a PO, and the to-do list that comes of it.
 *
 * Everything here is invented: a made-up hotel, made-up guests, made-up POs
 * and a small made-up Odoo.
 */

const PAGE = ['EHC/XXX test hotel   01.09.26 05:00', 'Business Reports   Page: 1', 'Benefit Date:   01.08.26   02.08.26', 'Type of Report:   Detail Journal of every Transaction'];
const block = (kind, user, seq, date, register, lines, guest = '/') => [`${kind}   ${user}   ${guest}`, `01-104-${seq}   ${register}/9${seq}-   ${date}   /`, ...lines];
const cash = (d, a) => `${d}   CASH   CASH   ${a} GHS`;

/** Two nights in a room, a padlock deposit, a minibar charge and a laundry charge. */
function journal() {
  return [...PAGE,
    ...block('Beginn of Day Processing', 'ALPHA', 500100, '01.08.26', '001', []),
    ...block('Reservation', 'ALPHA', 500101, '01.08.26', '001', [
      '01.08.26   101   Double Room   1   300,00   300,00 GHS   19',
      '02.08.26   101   Double Room   1   300,00   300,00 GHS   19',
      '01.08.26   405   Padlock Deposit   1   30,00   30,00 GHS   0',
      '02.08.26   610   Minibar   1   25,00   25,00 GHS   0',
      '02.08.26   540   Laundry   1   40,00   40,00 GHS   0',
      cash('01.08.26', '695,00'), '695,00 GHS'], 'Test Guest / 1 Road'),
    ...block('Beginn of Day Processing', 'BRAVO', 500110, '02.08.26', '001', []),
  ];
}

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const SUP_A = { id: 21, name: 'Abena Sup', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const SUP_B = { id: 22, name: 'Yaw Sup', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };

/** A small Odoo: two POs paid in cash, P00412 for the restaurant. */
function odoo() {
  const state = {
    orders: [
      { id: 1, name: 'P00412', partner_id: [1, 'A Produce Seller'], amount_total: 30, state: 'purchase', date_order: '2026-08-01 09:00:00', invoice_ids: [] },
      { id: 2, name: 'P00433', partner_id: [2, 'A Gas Seller'], amount_total: 20, state: 'purchase', date_order: '2026-08-02 09:00:00', invoice_ids: [] },
    ],
    bills: [],
    lines: [
      { order_id: [1, 'P00412'], price_total: 30, analytic_distribution: { 3: 100 } },
      { order_id: [2, 'P00433'], price_total: 20, analytic_distribution: false },
    ],
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const model = url.split('/json/2/')[1].split('/')[0];
    let rows = { 'purchase.order': state.orders, 'account.move': state.bills, 'purchase.order.line': state.lines }[model] || [];
    for (const [field, op, value] of body.domain || []) {
      if (op !== 'in') continue;
      if (field === 'order_id') rows = rows.filter((r) => value.includes(r.order_id[0]));
      else rows = rows.filter((r) => value.includes(r[field]));
    }
    return new Response(JSON.stringify(rows.slice(body.offset || 0, (body.offset || 0) + (body.limit || 100))), { headers: { 'Content-Type': 'application/json' } });
  };
  return { state, fetchImpl };
}

async function setUp() {
  const { db, raw } = freshDb();
  const hive = freshDb('../migrations');
  const env = { DB: db, ATT_DB: hive.db, ODOO_KEY_ODOO: 'k' };
  await env.DB.prepare(`UPDATE sources SET config = '{"base":"https://odoo.example.test","lineMap":{"3":"restaurant"}}', enabled = 1 WHERE id = 'odoo'`).run();
  raw.exec(`INSERT INTO accounts (id, email, name) VALUES (21, 'a@example.test', 'Abena Sup'), (22, 'y@example.test', 'Yaw Sup');
    INSERT INTO account_access (account_id, system_id, role) VALUES (21, 'insight', 'supervisor'), (22, 'insight', 'supervisor');`);
  hive.raw.exec("INSERT INTO users (id, name, role, active) VALUES (8, 'Kofi Test', 'staff', 1)");
  // Paid from the drawer, as a closing report wrote it.
  hive.raw.prepare(`INSERT INTO till_po (po, user_id, day, slot, paid, total, vendor, state) VALUES ('P00412', 8, '2026-08-01', 'afternoon', 3000, 3000, 'A Produce Seller', 'purchase')`).run();
  // Paid from the safe: 25 left it, the PO says 20.
  raw.exec(`INSERT INTO safe_entry (kind, day, amount, po, vendor, po_state, po_total, by_name, at)
    VALUES ('po', '2026-08-02', 2500, 'P00433', 'A Gas Seller', 'purchase', 2000, 'Test Owner', '2026-08-02 10:00:00')`);
  // A bill with no PO behind it.
  raw.exec(`INSERT INTO dim_supplier (id, match_key, name) VALUES (5, 'a plumber', 'A Plumber');
    INSERT INTO fact_bill (source_id, external_id, day, supplier_id, line_id, state, total, from_order)
    VALUES ('odoo', '77', '2026-08-10', 5, 'maintenance', 'posted', 5000, 0);`);
  return { env, raw };
}

test('the rooms’ revenue is read from the journal; other articles once somebody says what they are', async () => {
  const { env } = await setUp();
  await shifts.uploadJournal(env, { lines: journal(), name: 'journal.pdf' }, OWNER);
  let view = await revenue.articlesView(env, { from: '2026-08-01', to: '2026-08-02' });
  assert.deepEqual(view.nights, { amount: 60000, count: 2 });
  const line = (code) => view.articles.find((a) => a.code === code)?.line;
  assert.equal(line('405'), 'none', 'a rental deposit is not revenue');
  assert.equal(line('540'), 'elsewhere', 'the laundry system reports the laundry');
  assert.equal(line('610'), null, 'nobody has said what the minibar is yet');
  assert.deepEqual(view.undecided, { count: 1, amount: 2500 });

  let money = await pnl(env, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(money.lines.find((l) => l.line === 'rooms')?.net, 60000);
  assert.equal(money.lines.find((l) => l.line === 'bar'), undefined);
  assert.match(money.caveats[0], /read from the ASSD journal/);

  await assert.rejects(revenue.saveArticle(env, { code: '610', line: 'bar' }, SUP_A), /Only an admin/);
  await assert.rejects(revenue.saveArticle(env, { code: '101', line: 'bar' }, OWNER), /always the rooms/);
  await revenue.saveArticle(env, { code: '610', line: 'bar' }, OWNER);
  view = await revenue.articlesView(env, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(view.undecided.count, 0);
  money = await pnl(env, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(money.lines.find((l) => l.line === 'bar')?.net, 2500);
  // Rebuilding again changes nothing: written, not added.
  await revenue.rebuildAssdRevenue(env, { from: '2026-08-01', to: '2026-08-02' });
  money = await pnl(env, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(money.lines.find((l) => l.line === 'rooms')?.net, 60000);
});

test('cash POs: unbilled spending counted until the bill comes, how it was paid, and a to-do shared among supervisors', async () => {
  const { env } = await setUp();
  const { state, fetchImpl } = odoo();
  const today = '2026-08-20';

  const first = await cashpo.refreshCashPos(env, { fetchImpl, today });
  assert.equal(first.pos, 2);
  assert.equal(first.unbilled, 2);
  assert.equal(first.unbilledAmount, 5500);

  // Unbilled cash is counted on the day it left, on the PO's own part of the business.
  const cost = await env.DB.prepare("SELECT day, line_id, amount FROM fact_cost WHERE source_id = 'odoo-cash' ORDER BY day").all();
  assert.deepEqual(cost.results.map((r) => [r.day, r.line_id, r.amount]), [['2026-08-01', 'restaurant', 3000], ['2026-08-02', 'admin', 2500]]);

  // How it was paid.
  const view = await cashpo.cashView(env, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(view.split, { spend: 10500, bills: 5000, unbilled: 5500, drawer: 3000, safe: 2500, other: 5000 });
  assert.deepEqual(view.differs.map((d) => [d.po, d.paid, d.poTotal]), [['P00433', 2500, 2000]]);
  assert.deepEqual(view.noPo.map((b) => b.supplier), ['A Plumber']);
  assert.equal(view.suppliers.find((s) => s.supplier === 'A Plumber').other, 5000);

  // The to-do: two unbilled, one that differs, one bill with no PO, shared two and two.
  let all = await todo.listTodos(env, OWNER);
  assert.deepEqual(all.items.map((t) => t.key).sort(), ['differs:P00433', 'nopo:77', 'unbilled:P00412', 'unbilled:P00433']);
  const load = {};
  for (const t of all.items) load[t.assignee.name] = (load[t.assignee.name] || 0) + 1;
  assert.deepEqual(load, { 'Abena Sup': 2, 'Yaw Sup': 2 });

  // A supervisor sees only their own.
  const mine = await todo.listTodos(env, SUP_A);
  assert.equal(mine.items.length, 2);
  assert.ok(mine.items.every((t) => t.assignee.id === 21));
  const theirs = all.items.find((t) => t.assignee.id === 22);
  await assert.rejects(todo.answerTodo(env, theirs.id, { answer: 'x' }, SUP_A), /somebody else/);

  // The payment that differs: answered, sent back, answered again, approved.
  const differs = all.items.find((t) => t.kind === 'differs');
  const holder = differs.assignee.id === 21 ? SUP_A : SUP_B;
  assert.equal((await todo.answerTodo(env, differs.id, { answer: 'Delivery charge paid on top' }, holder)).state, 'answered');
  await assert.rejects(todo.decideTodo(env, differs.id, { approve: true }, holder), /Only an admin/);
  assert.equal((await todo.decideTodo(env, differs.id, { approve: false, note: 'Ask for the receipt' }, OWNER)).state, 'open');
  assert.equal((await todo.answerTodo(env, differs.id, { answer: 'Receipt attached in Odoo' }, holder)).state, 'answered');
  assert.equal((await todo.decideTodo(env, differs.id, { approve: true }, OWNER)).state, 'closed');

  // A cash PO waiting for its bill only takes a note; the bill closes it.
  const unbilled = all.items.find((t) => t.key === 'unbilled:P00412');
  assert.equal((await todo.answerTodo(env, unbilled.id, { answer: 'Sent to the accountant' }, unbilled.assignee.id === 21 ? SUP_A : SUP_B)).state, 'open');
  state.bills.push({ id: 900, name: 'BILL/2026/0001', state: 'posted', invoice_date: '2026-08-15' });
  state.orders[0].invoice_ids = [900];
  const again = await cashpo.refreshCashPos(env, { fetchImpl, today });
  assert.equal(again.unbilled, 1);
  const closed = await todo.listTodos(env, OWNER, { closed: true });
  assert.equal(closed.items.find((t) => t.key === 'unbilled:P00412').closedWhy, 'The bill is posted in Odoo.');
  const left = await env.DB.prepare("SELECT line_id, amount FROM fact_cost WHERE source_id = 'odoo-cash'").all();
  assert.deepEqual(left.results.map((r) => [r.line_id, r.amount]), [['admin', 2500]], 'the billed PO is the bill’s now');

  // An admin can give an item to somebody else, and close one that needs nothing.
  all = await todo.listTodos(env, OWNER);
  const nopo = all.items.find((t) => t.kind === 'nopo');
  await todo.assignTodo(env, nopo.id, { accountId: 21 }, OWNER);
  await todo.dismissTodo(env, nopo.id, { note: 'Monthly service contract' }, OWNER);
  await cashpo.refreshCashPos(env, { fetchImpl, today });
  assert.equal((await todo.listTodos(env, OWNER)).items.find((t) => t.kind === 'nopo'), undefined, 'a dismissed item does not come back');
});

test('a cash PO not billed waits the days set before it is raised', async () => {
  const { env } = await setUp();
  const { fetchImpl } = odoo();
  await cashpo.refreshCashPos(env, { fetchImpl, today: '2026-08-05' });
  let keys = (await todo.listTodos(env, OWNER)).items.map((t) => t.key);
  assert.ok(!keys.some((k) => k.startsWith('unbilled:')), 'seven days have not passed');
  await todo.saveTodoSettings(env, { unbilledDays: 4 }, OWNER, { today: '2026-08-05' });
  await cashpo.refreshCashPos(env, { fetchImpl, today: '2026-08-05' });
  keys = (await todo.listTodos(env, OWNER)).items.map((t) => t.key);
  assert.deepEqual(keys.filter((k) => k.startsWith('unbilled:')).sort(), ['unbilled:P00412']);
});

test('cash not billed adds to the books, and never to a line an operating system already records', () => {
  const books = new Set(['odoo']);
  const basis = chooseCostBasis([
    { day: 'd', line_id: 'breakfast', source_id: 'odoo', amount: 100 },
    { day: 'd', line_id: 'breakfast', source_id: 'odoo-cash', amount: 30 },
    { day: 'd', line_id: 'restaurant', source_id: 'kitchen', amount: 200 },
    { day: 'd', line_id: 'restaurant', source_id: 'odoo-cash', amount: 40 },
    { day: 'd', line_id: 'maintenance', source_id: 'odoo-cash', amount: 50 },
  ], books);
  const kept = basis.rows.map((r) => `${r.line_id}:${r.source_id}`).sort();
  assert.deepEqual(kept, ['breakfast:odoo', 'breakfast:odoo-cash', 'maintenance:odoo-cash', 'restaurant:kitchen']);
  assert.equal(basis.byLine.get('maintenance'), 'books');
  assert.equal(basis.excluded, 40);
});

test('a PO typed on a shift and never looked up is still chased, and a draft bill does not close it', async () => {
  const { env, raw } = await setUp();
  const { state, fetchImpl } = odoo();
  // Typed as a bare number, saved, and nobody pressed the button that asks Odoo.
  raw.exec(`INSERT INTO shift_expense (day, slot, sheet_total, po_numbers, by_name, at)
    VALUES ('2026-08-03', 'morning', 4500, '2433', 'Test Owner', '2026-08-03 14:00:00')`);
  state.orders.push({ id: 3, name: 'P02433', partner_id: [3, 'A Water Seller'], amount_total: 45, state: 'purchase', date_order: '2026-08-03 08:00:00', invoice_ids: [901] });
  state.bills.push({ id: 901, name: 'BILL/2026/0002', state: 'draft', invoice_date: '2026-08-05' });
  state.lines.push({ order_id: [3, 'P02433'], price_total: 45, analytic_distribution: false });

  await cashpo.refreshCashPos(env, { fetchImpl, today: '2026-08-20' });
  const row = await env.DB.prepare("SELECT * FROM cash_po WHERE po = 'P02433'").first();
  assert.ok(row, 'the typed number is read and named as Odoo names it');
  assert.equal(row.paid, 4500, 'what left the drawer is the PO’s total');
  assert.equal(row.paid_from, 'drawer');
  assert.equal(row.billed, 1);
  assert.equal(row.posted, 0);

  // A draft bill already counts in the costs, so it is not counted again here…
  const cost = await env.DB.prepare("SELECT SUM(amount) AS n FROM fact_cost WHERE source_id = 'odoo-cash' AND day = '2026-08-03'").first();
  assert.equal(cost.n, null);
  // …but the bill is not finished, so the item is raised and says so.
  let item = (await todo.listTodos(env, OWNER)).items.find((t) => t.key === 'unbilled:P02433');
  assert.ok(item, 'raised for the shift’s PO');
  assert.deepEqual(item.detail.drafts, ['BILL/2026/0002']);
  const view = await cashpo.cashView(env, { from: '2026-08-01', to: '2026-08-31' });
  assert.ok(view.unbilled.find((u) => u.po === 'P02433' && u.draft));

  // Posted: closed.
  state.bills[0].state = 'posted';
  await cashpo.refreshCashPos(env, { fetchImpl, today: '2026-08-20' });
  item = (await todo.listTodos(env, OWNER, { closed: true })).items.find((t) => t.key === 'unbilled:P02433');
  assert.equal(item.closedWhy, 'The bill is posted in Odoo.');
});
