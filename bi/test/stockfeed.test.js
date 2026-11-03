import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as sf from '../src/routes/stockfeed.js';

/**
 * Stock from Odoo: confirmed POs read from a made-up Odoo, each line offered
 * to a made-up breakfast store and Maintenance store, which answer as the
 * contract says; "Which store?" asked once and answered; short, late and
 * cancelled deliveries. Everybody and everything is invented.
 */

const OWNER = { id: 1, name: 'Test Owner', isOwner: true, access: [] };
const GINA = { id: 31, name: 'Gina Test', email: 'gina@example.test', access: [{ systemId: 'insight', role: 'supervisor' }] };
const NOBODY = { id: 40, name: 'Kofi Test', access: [{ systemId: 'insight', role: 'uploader' }] };
const at = (day, time = '10:00:00') => Date.parse(`${day}T${time}Z`);

function world() {
  const orders = [];
  const lines = [];
  const po = (id, name, approved, state = 'purchase', supplier = 'A Farm Supplies') => orders.push({ id, name, state, date_approve: `${approved} 09:00:00`, date_order: `${approved} 08:00:00`, partner_id: [id + 100, supplier] });
  const line = (id, order, product, uom, qty, price, received = 0) => lines.push({ id, order_id: [order, ''], product_id: product, product_uom: uom, product_qty: qty, qty_received: received, price_unit: price, name: product[1], display_type: false });
  // Each store: its Odoo product list (an item and factor, or ignore), and what it holds.
  const stores = {
    breakfast: { map: new Map([['1:1', { item: { id: 11, name: 'Eggs', unit: 'each' }, factor: 30 }], ['4:1', 'ignore']]), lines: new Map(), locked: false, items: [{ id: 11, name: 'Eggs', unit: 'each', group: 'food' }], up: true },
    maintenance: { map: new Map([['2:1', { item: { id: 'p2', name: 'PVC pipe 1/2in', unit: 'lengths' }, factor: 1 }], ['4:1', 'ignore']]), lines: new Map(), locked: false, items: [{ id: 'p2', name: 'PVC pipe 1/2in', unit: 'lengths' }, { id: 'p9', name: 'Sealant, silicone', unit: 'tubes' }], up: true },
  };
  const calls = [];
  const answer = (store, body) => {
    const s = stores[store];
    if (body.action === 'offer') {
      const out = {};
      for (const l of body.lines) {
        const had = s.lines.get(l.lineId);
        if (had) { out[l.lineId] = { state: 'already', current: had.state, item: had.item, qty: had.qty }; continue; }
        const m = s.map.get(`${l.productId}:${l.uomId}`);
        if (m === 'ignore') { out[l.lineId] = { state: 'ignored' }; continue; }
        if (s.closed && body.mode !== 'store') { out[l.lineId] = { state: 'refused', reason: 'That period is closed.' }; continue; }
        if (!m) { out[l.lineId] = { state: 'unknown' }; continue; }
        const state = body.mode === 'store' ? 'expected' : 'recorded';
        const rec = { state, item: m.item, qty: l.qty * m.factor, unitCost: Math.round((l.priceUnit / m.factor) * 10000) / 10000 };
        s.lines.set(l.lineId, rec);
        out[l.lineId] = { ...rec };
      }
      return { ok: true, lines: out };
    }
    if (body.action === 'status') return { ok: true, lines: Object.fromEntries(body.lineIds.map((id) => [id, s.lines.get(id) ? { ...s.lines.get(id) } : { state: 'missing' }])) };
    if (body.action === 'cancel') {
      return { ok: true, lines: Object.fromEntries(body.lineIds.map((id) => {
        const rec = s.lines.get(id);
        if (rec && rec.state !== 'expected' && s.locked) return [id, { state: 'kept', reason: 'That day is locked: correct the count by hand.' }];
        s.lines.delete(id);
        return [id, { state: 'removed' }];
      })) };
    }
    if (body.action === 'items') return { ok: true, items: s.items };
    if (body.action === 'map') {
      const key = `${body.productId}:${body.uomId}`;
      if (body.ignore) { if (!s.map.has(key)) s.map.set(key, 'ignore'); return { ok: true, item: null }; }
      const item = s.items.find((i) => String(i.id) === String(body.itemId));
      s.map.set(key, { item, factor: Number(body.factor) || 1 });
      return { ok: true, item };
    }
    return { ok: false, error: 'no such action' };
  };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init.body || '{}');
    const m = u.match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    if (m) {
      const [, model, method] = m;
      if (method === 'fields_get') return Response.json({ order_id: {}, product_id: {}, product_uom: {}, product_qty: {}, qty_received: {}, price_unit: {}, name: {}, display_type: {} });
      if (model === 'purchase.order') {
        const byIds = body.domain.find((d) => d[0] === 'id');
        if (byIds) return Response.json(orders.filter((o) => byIds[2].includes(o.id)));
        const since = body.domain.find((d) => d[0] === 'date_approve')[2];
        const states = body.domain.find((d) => d[0] === 'state')[2];
        return Response.json(orders.filter((o) => o.date_approve >= since && states.includes(o.state)));
      }
      if (model === 'purchase.order.line') {
        const ids = body.domain.find((d) => d[0] === 'order_id')[2];
        return Response.json(lines.filter((l) => ids.includes(l.order_id[0])));
      }
    }
    const store = u.includes('breakfast.example') ? 'breakfast' : u.includes('mx.example') ? 'maintenance' : null;
    if (store) {
      calls.push({ store, path: new URL(u).pathname, body, signed: Boolean(init.headers['X-Till-Sig']) });
      if (!stores[store].up) return new Response('down', { status: 503 });
      if (stores[store].old) return Response.json({ ok: false, error: 'Rooms, register or add?' }, { status: 400 });
      return Response.json(answer(store, body));
    }
    return new Response('no', { status: 404 });
  };
  return { orders, lines, po, line, stores, calls, fetchImpl };
}

async function setUp({ mode = 'confirmed' } = {}) {
  const { db, raw } = freshDb();
  const env = {
    DB: db, ODOO_KEY_ODOO: 'k', SSO_SECRET_BREAKFAST: 'bf', BREAKFAST_URL: 'https://breakfast.example.test',
    SSO_SECRET_MAINTENANCE: 'mx', MAINTENANCE_APPROVALS_URL: 'https://mx.example.test/functions/v1/approvals',
  };
  await db.prepare(`UPDATE sources SET config = '{"base":"https://odoo.example.test"}', enabled = 1 WHERE id = 'odoo'`).run();
  raw.exec(`INSERT INTO accounts (id, email, name, active) VALUES (31, 'gina@example.test', 'Gina Test', 1);
    INSERT INTO account_access (account_id, system_id, role) VALUES (31, 'insight', 'supervisor');`);
  const w = world();
  sf.io.fetch = w.fetchImpl;
  await sf.saveFeedSettings(env, { mode, askTo: 31 }, OWNER);
  return { env, raw, w };
}

const todos = (raw) => raw.prepare("SELECT key, kind, state, assignee_id, ref FROM money_todo WHERE kind LIKE 'stock%' ORDER BY key").all().map((r) => ({ ...r }));
const line = (raw, id) => raw.prepare('SELECT * FROM stock_line WHERE line_id = ?').get(id);

test('the settings: stock when the PO is confirmed, from 4 November, set by an admin only', async () => {
  const { env } = await setUp();
  const s = await sf.feedSettings(env);
  assert.deepEqual(s, { mode: 'confirmed', askTo: 31, from: '2026-11-04' }, 'from tomorrow, as asked');
  await assert.rejects(sf.saveFeedSettings(env, { mode: 'store' }, GINA), /for admins/);
  await assert.rejects(sf.saveFeedSettings(env, { mode: 'whenever' }, OWNER), /Choose when/);
  await assert.rejects(sf.saveFeedSettings(env, { askTo: 40 }, OWNER), /supervisor or admin/);
  await assert.rejects(sf.saveFeedSettings(env, { from: '4 Nov' }, OWNER), /YYYY-MM-DD/);
  const out = await sf.saveFeedSettings(env, { mode: 'store' }, OWNER);
  assert.equal(out.settings.mode, 'store');
  // Before the first day, nothing is read.
  const early = await sf.syncStock(env, { now: at('2026-11-03') });
  assert.match(early.skipped, /2026-11-04/);
});

test('confirmed: each line goes to the store that knows it; new products asked once; not stock left alone', async () => {
  const { env, raw, w } = await setUp();
  w.po(1, 'P04131', '2026-11-04');
  w.line(901, 1, [1, 'Eggs, crate of 30'], [1, 'Units'], 6, 95);
  w.line(902, 1, [2, '[PVC12] PVC pipe 1/2in'], [1, 'Units'], 10, 40);
  w.line(903, 1, [3, 'Silicone sealant, clear'], [1, 'Units'], 6, 38);
  w.line(904, 1, [4, 'Delivery charge'], [1, 'Units'], 1, 50);
  w.lines.push({ id: 905, order_id: [1, ''], product_id: false, product_uom: false, product_qty: 0, qty_received: 0, price_unit: 0, name: 'A note', display_type: 'line_note' });
  w.po(2, 'P04100', '2026-11-03');
  w.line(906, 2, [1, 'Eggs, crate of 30'], [1, 'Units'], 2, 95);

  const out = await sf.syncStock(env, { now: at('2026-11-05') });
  assert.deepEqual(out.said, { breakfast: 'ok', maintenance: 'ok' });
  assert.ok(w.calls.every((c) => c.signed), 'every call is signed');
  assert.ok(w.calls.some((c) => c.store === 'breakfast' && c.path === '/api/link/stock' && c.body.action === 'offer' && c.body.mode === 'confirmed'));
  assert.ok(w.calls.some((c) => c.store === 'maintenance' && c.path === '/functions/v1/assets' && c.body.action === 'offer'));
  const toMx = w.calls.find((c) => c.store === 'maintenance' && c.body.action === 'offer').body.lines.map((l) => l.lineId);
  assert.deepEqual(toMx.sort(), [902, 903, 904], 'what breakfast took is not offered to Maintenance');

  assert.equal(line(raw, 901).app, 'breakfast');
  assert.equal(line(raw, 901).state, 'recorded');
  assert.equal(line(raw, 901).store_qty, 180, 'six crates of thirty');
  assert.equal(line(raw, 901).unit_cost, 3.1667);
  assert.equal(line(raw, 902).app, 'maintenance');
  assert.equal(line(raw, 903).state, 'ask');
  assert.equal(line(raw, 904).state, 'none', 'neither store: not stock');
  assert.equal(line(raw, 905), undefined, 'a note is not a line');
  assert.equal(line(raw, 906), undefined, 'confirmed before the first day');

  assert.deepEqual(todos(raw), [{ key: 'stockmatch:3:1', kind: 'stockmatch', state: 'open', assignee_id: 31, ref: 'Silicone sealant, clear' }]);
  const told = raw.prepare("SELECT title FROM notice WHERE account_id = 31 AND kind = 'insight_stock'").all();
  assert.deepEqual(told.map((t) => t.title), ['Which store is Silicone sealant, clear?']);

  // Read again: nothing twice.
  await sf.syncStock(env, { now: at('2026-11-05', '10:15:00') });
  assert.equal(w.stores.breakfast.lines.size, 1);
  assert.equal(todos(raw).length, 1);

  // Which store? Maintenance, as its sealant. Breakfast is told it is not theirs.
  await assert.rejects(sf.matchProduct(env, { productId: 3, uomId: 1, app: 'maintenance', itemId: 'p9' }, NOBODY), /supervisor or an admin/);
  const items = await sf.storeItems(env, 'maintenance', GINA);
  assert.ok(items.items.some((i) => i.name === 'Sealant, silicone'));
  const m = await sf.matchProduct(env, { productId: 3, uomId: 1, app: 'maintenance', itemId: 'p9', factor: 1 }, GINA);
  assert.equal(m.placed, 1);
  assert.equal(line(raw, 903).app, 'maintenance');
  assert.equal(line(raw, 903).item, 'Sealant, silicone');
  assert.equal(w.stores.breakfast.map.get('3:1'), 'ignore');
  assert.equal(todos(raw)[0].state, 'closed');

  // The page.
  const page = await sf.overview(env, OWNER, { now: at('2026-11-05') });
  assert.equal(page.tiles.breakfast.lines, 1);
  assert.equal(page.tiles.maintenance.lines, 2);
  assert.equal(page.tiles.none, 1);
  assert.equal(page.pos[0].po, 'P04131');
  assert.equal(page.askTo.name, 'Gina Test');
  await assert.rejects(sf.overview(env, GINA), /for admins/);
});

test('not stock, said once: later lines of it are left alone without asking the stores', async () => {
  const { env, raw, w } = await setUp();
  w.po(1, 'P04131', '2026-11-04');
  w.line(903, 1, [3, 'Generator service'], [1, 'Units'], 1, 300);
  await sf.syncStock(env, { now: at('2026-11-05') });
  await sf.matchProduct(env, { productId: 3, uomId: 1, app: 'none' }, GINA);
  assert.equal(line(raw, 903).state, 'none');
  w.po(2, 'P04140', '2026-11-06');
  w.line(910, 2, [3, 'Generator service'], [1, 'Units'], 1, 300);
  const before = w.calls.length;
  await sf.syncStock(env, { now: at('2026-11-06', '12:00:00') });
  assert.equal(line(raw, 910).state, 'none');
  assert.equal(w.calls.filter((c, i) => i >= before && c.body.action === 'offer').length, 0);
});

test('when the storekeeper says Received: on its way, short, and not received after three days', async () => {
  const { env, raw, w } = await setUp({ mode: 'store' });
  w.po(1, 'P04131', '2026-11-04');
  w.line(901, 1, [1, 'Eggs, crate of 30'], [1, 'Units'], 6, 95);
  w.po(2, 'P04136', '2026-11-04', 'purchase', 'A Hardware Shop');
  w.line(902, 2, [2, 'PVC pipe'], [1, 'Units'], 10, 40);
  await sf.syncStock(env, { now: at('2026-11-04', '12:00:00') });
  assert.equal(line(raw, 901).state, 'expected');
  // The storekeeper received 150 eggs of 180.
  w.stores.breakfast.lines.set(901, { state: 'received', item: { name: 'Eggs', unit: 'each' }, qty: 180, unitCost: 3.1667, received: 150, receivedBy: 'Ama Test', receivedAt: '2026-11-05 08:40:00' });
  await sf.syncStock(env, { now: at('2026-11-05') });
  assert.equal(line(raw, 901).state, 'received');
  assert.equal(line(raw, 901).received, 150);
  assert.equal(line(raw, 901).received_by, 'Ama Test');
  assert.ok(todos(raw).some((t) => t.key === 'stockshort:901' && t.ref === 'P04131'));
  // The PVC still on its way three days on.
  await sf.syncStock(env, { now: at('2026-11-07', '12:00:00') });
  assert.ok(todos(raw).some((t) => t.key === 'stocklate:2:maintenance' && t.state === 'open'));
  // Received: the late one closes by itself.
  w.stores.maintenance.lines.get(902).state = 'received';
  w.stores.maintenance.lines.get(902).received = 10;
  await sf.syncStock(env, { now: at('2026-11-07', '12:15:00') });
  assert.equal(todos(raw).find((t) => t.key === 'stocklate:2:maintenance').state, 'closed');
});

test('when the receipt is validated in Odoo: only lines Odoo has received, by what it received', async () => {
  const { env, raw, w } = await setUp({ mode: 'odoo' });
  w.po(1, 'P04131', '2026-11-04');
  w.line(901, 1, [1, 'Eggs, crate of 30'], [1, 'Units'], 6, 95, 0);
  await sf.syncStock(env, { now: at('2026-11-05') });
  assert.equal(line(raw, 901).state, 'waiting');
  assert.equal(w.stores.breakfast.lines.size, 0);
  w.lines[0].qty_received = 6;
  await sf.syncStock(env, { now: at('2026-11-05', '11:00:00') });
  assert.equal(line(raw, 901).state, 'recorded');
  assert.equal(w.calls.find((c) => c.body.action === 'offer').body.mode, 'odoo');
});

test('a PO cancelled in Odoo: each store takes it back, or says why it cannot', async () => {
  const { env, raw, w } = await setUp();
  w.po(1, 'P04131', '2026-11-04');
  w.line(901, 1, [1, 'Eggs, crate of 30'], [1, 'Units'], 6, 95);
  w.line(902, 1, [2, 'PVC pipe'], [1, 'Units'], 10, 40);
  await sf.syncStock(env, { now: at('2026-11-05') });
  w.orders[0].state = 'cancel';
  w.stores.breakfast.locked = true;
  await sf.syncStock(env, { now: at('2026-11-06') });
  assert.equal(line(raw, 901).state, 'kept');
  assert.match(line(raw, 901).note, /locked/);
  assert.equal(line(raw, 902).state, 'cancelled');
  assert.ok(todos(raw).some((t) => t.key === 'stockkept:901'));
});

test('a store not answering: its lines wait and are tried again, nobody is asked', async () => {
  const { env, raw, w } = await setUp();
  w.stores.breakfast.up = false;
  w.po(1, 'P04131', '2026-11-04');
  w.line(903, 1, [3, 'Something new'], [1, 'Units'], 1, 10);
  const out = await sf.syncStock(env, { now: at('2026-11-05') });
  assert.notEqual(out.said.breakfast, 'ok');
  assert.equal(line(raw, 903).state, 'waiting');
  assert.equal(todos(raw).length, 0);
  w.stores.breakfast.up = true;
  await sf.syncStock(env, { now: at('2026-11-05', '10:15:00') });
  assert.equal(line(raw, 903).state, 'ask');
});

test('Maintenance not updated yet: said plainly, and its lines wait', async () => {
  const { env, raw, w } = await setUp();
  w.stores.maintenance.old = true;
  w.po(1, 'P04131', '2026-11-04');
  w.line(902, 1, [2, 'PVC pipe'], [1, 'Units'], 10, 40);
  const out = await sf.syncStock(env, { now: at('2026-11-05') });
  assert.match(out.said.maintenance, /does not take stock from Odoo yet/);
  assert.equal(line(raw, 902).state, 'waiting');
});

test('a closed period in the store: the line waits there, and is not offered to the other store', async () => {
  const { env, raw, w } = await setUp();
  w.stores.breakfast.closed = true;
  w.po(1, 'P04131', '2026-11-04');
  w.line(901, 1, [1, 'Eggs, crate of 30'], [1, 'Units'], 6, 95);
  await sf.syncStock(env, { now: at('2026-11-05') });
  assert.equal(line(raw, 901).state, 'waiting');
  assert.equal(line(raw, 901).app, 'breakfast');
  assert.match(line(raw, 901).note, /closed/);
  assert.equal(w.calls.filter((c) => c.store === 'maintenance' && c.body.action === 'offer').length, 0);
  assert.equal(todos(raw).length, 0);
  w.stores.breakfast.closed = false;
  await sf.syncStock(env, { now: at('2026-11-05', '10:15:00') });
  assert.equal(line(raw, 901).state, 'recorded');
});

