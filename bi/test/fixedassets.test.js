import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as fa from '../src/routes/fixedassets.js';

/**
 * Fixed assets: found in Odoo (a made-up one), confirmed by an admin, sent to
 * Maintenance's register (a made-up one). Everybody and everything is invented.
 */

const ADMIN = { id: 1, name: 'Ama Test', isOwner: true, access: [] };
const SUP = { id: 3, name: 'Sam Test', access: [{ systemId: 'insight', role: 'supervisor' }] };
const RULES = fa.DEFAULT_RULES;

test('what looks like a fixed asset: the words, and the money', () => {
  const l = (name, unitCost, amount = unitCost, label = '') => ({ name, label, unitCost, amount });
  assert.deepEqual(fa.looksLikeAsset(l('Chest freezer 300L', 650000), RULES), ['“freezer”', 'over GH₵ 2,000 each']);
  assert.deepEqual(fa.looksLikeAsset(l('Mattress, double', 145000, 1450000), RULES), ['“mattress”', 'GH₵ 14,500 on one line'], 'ten of them');
  assert.equal(fa.looksLikeAsset(l('Mattress, double', 145000, 290000), RULES), null, 'two of them: under both amounts');
  assert.deepEqual(fa.looksLikeAsset(l('Split AC 1.5HP', 480000), RULES)[0], '“AC”');
  assert.equal(fa.looksLikeAsset(l('Vacuum cleaner', 300000), RULES), null, '“AC” is not in “vacuum”');
  assert.deepEqual(fa.looksLikeAsset(l('Beds, bunk', 300000), RULES)[0], '“bed”', 'plurals count');
  assert.equal(fa.looksLikeAsset(l('Generator service', 300000), RULES), null, 'a service is never an asset');
  assert.equal(fa.looksLikeAsset(l('Pump', 300000, 300000, 'repair of borehole pump'), RULES), null, 'nor a repair, whatever the product');
  assert.equal(fa.looksLikeAsset(l('Office rent', 900000), RULES), null);
});

/** A made-up Odoo, answering the four reads. */
function odoo({ assetsApp = true } = {}) {
  const asked = [];
  const accounts = [{ id: 40, code: '1220', name: 'Furniture & equipment' }, { id: 41, code: '1230', name: 'Office equipment' }];
  const assets = [{ id: 7, name: 'Delivery van', original_value: 85000, acquisition_date: '2025-05-02', state: 'open', account_asset_id: [42, '1240 Vehicles'], original_move_line_ids: [500] }];
  const accountLines = [
    { id: 500, move_id: [9, 'BILL/2025/05/0001'], name: 'Van', product_id: false, quantity: 1, price_unit: 85000, debit: 85000, date: '2025-05-02', partner_id: [3, 'A Car Dealer'], account_id: [42, '1240 Vehicles'] },
    { id: 501, move_id: [10, 'MISC/2026/03/0004'], name: 'Office desktop computer', product_id: false, quantity: 1, price_unit: 0, debit: 7900, date: '2026-03-12', partner_id: false, account_id: [41, '1230 Office equipment'] },
    { id: 502, move_id: [11, 'BILL/2026/10/0051'], name: 'Split AC', product_id: [8, 'Split AC 1.5HP inverter'], quantity: 3, price_unit: 4800, debit: 14400, date: '2026-10-22', partner_id: [4, 'A Cool Air Shop'], account_id: [40, '1220 Furniture & equipment'] },
  ];
  const billLines = [
    { id: 502, move_id: [11, 'BILL/2026/10/0051'], name: 'Split AC', product_id: [8, 'Split AC 1.5HP inverter'], quantity: 3, price_unit: 4800, price_subtotal: 14400, date: '2026-10-22', partner_id: [4, 'A Cool Air Shop'], account_id: [40, '1220 Furniture & equipment'] },
    { id: 601, move_id: [12, 'BILL/2026/10/0042'], name: 'Chest freezer', product_id: [9, 'Chest freezer 300L'], quantity: 2, price_unit: 6500, price_subtotal: 13000, date: '2026-10-14', partner_id: [5, 'A Cold Store Ltd'], account_id: [60, '6200 Repairs & maintenance'] },
    { id: 602, move_id: [13, 'BILL/2026/10/0060'], name: 'Generator service', product_id: [10, 'Generator service'], quantity: 1, price_unit: 3000, price_subtotal: 3000, date: '2026-10-25', partner_id: [6, 'A Power Shop'], account_id: [60, '6200 Repairs & maintenance'] },
    { id: 603, move_id: [14, 'BILL/2026/10/0061'], name: 'Paint', product_id: [11, 'Paint, 20L'], quantity: 10, price_unit: 2500, price_subtotal: 25000, date: '2026-10-26', partner_id: [6, 'A Hardware Shop'], account_id: [60, '6200 Repairs & maintenance'] },
  ];
  const fetchImpl = async (url, init) => {
    const [, model] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    asked.push({ model, domain: body.domain });
    if (model === 'account.account') return Response.json(accounts);
    if (model === 'account.asset') return assetsApp ? Response.json(assets) : new Response('no', { status: 404 });
    if (model === 'account.move.line') {
      return Response.json(body.domain.some((d) => d[0] === 'account_id') ? accountLines : billLines);
    }
    return new Response('no', { status: 404 });
  };
  return { fetchImpl, asked };
}

async function setUp() {
  const { db, raw } = freshDb();
  const env = { DB: db, ODOO_KEY_ODOO: 'k' };
  await db.prepare(`UPDATE sources SET config = '{"base":"https://odoo.example.test"}', enabled = 1 WHERE id = 'odoo'`).run();
  return { env, raw };
}

test('read from Odoo: the assets app, the asset accounts, and purchases that look like assets', async () => {
  const { env, raw } = await setUp();
  const o = odoo();
  const out = await fa.scan(env, { fetchImpl: o.fetchImpl, today: '2026-11-02' });
  assert.equal(out.assetsApp, true);
  assert.deepEqual(out.accounts, ['1220 Furniture & equipment', '1230 Office equipment']);
  const bills = o.asked.find((a) => a.model === 'account.move.line' && a.domain.some((d) => d[0] === 'move_id.move_type'));
  assert.deepEqual(bills.domain.filter((d) => Array.isArray(d) && ['price_unit', 'price_subtotal', 'date'].includes(d[0])),
    [['date', '>=', '2024-11-02'], ['price_unit', '>=', 2000], ['price_subtotal', '>=', 10000]], 'Odoo filters by amount; two years back');
  const rows = raw.prepare('SELECT key, kind, name, qty, unit_cost, amount, account_code, on_asset_account, state, why FROM fa_item ORDER BY key').all();
  assert.deepEqual(rows.map((r) => [r.key, r.kind, r.name, r.state]), [
    ['asset:7', 'odoo_asset', 'Delivery van', 'review'],
    ['line:501', 'account', 'Office desktop computer', 'review'],
    ['line:502', 'account', 'Split AC 1.5HP inverter', 'review'],
    ['line:601', 'purchase', 'Chest freezer 300L', 'review'],
  ], 'the van once (its own asset, not its bill line too); the AC once, as capitalised; no service, no paint');
  const freezer = rows.find((r) => r.key === 'line:601');
  assert.deepEqual([freezer.qty, freezer.unit_cost, freezer.amount, freezer.account_code, freezer.on_asset_account, JSON.parse(freezer.why)],
    [2, 650000, 1300000, '6200', 0, ['“freezer”', 'over GH₵ 2,000 each']]);
  assert.equal(rows.find((r) => r.key === 'line:501').unit_cost, 790000, 'a journal entry with no price: its debit');

  // Read again: nothing doubled, decisions kept.
  raw.exec("UPDATE fa_item SET state = 'not_asset' WHERE key = 'line:501'");
  const again = await fa.scan(env, { fetchImpl: odoo().fetchImpl, today: '2026-11-02' });
  assert.equal(again.fresh, 0);
  assert.equal(raw.prepare("SELECT state FROM fa_item WHERE key = 'line:501'").get().state, 'not_asset');

  // No Assets app in this Odoo: not a failure, the van's bill line is then read from the account.
  const { env: env2, raw: raw2 } = await setUp();
  const plain = await fa.scan(env2, { fetchImpl: odoo({ assetsApp: false }).fetchImpl, today: '2026-11-02' });
  assert.equal(plain.assetsApp, false);
  assert.ok(raw2.prepare("SELECT 1 FROM fa_item WHERE key = 'line:500'").get());
});

/** A made-up Maintenance: its rooms, its register, and what was added. */
function maintenance(env) {
  env.MAINTENANCE_APPROVALS_URL = 'https://mx.example.test/functions/v1/approvals';
  env.SSO_SECRET_MAINTENANCE = 'test-secret';
  const added = [];
  const register = [{ name: 'Gas cooker', tag: 'NCA-0011', room: 'Kitchen', cost: 9200, overdue_since: '2026-10-27', next_service: '2027-01-27' },
    { name: 'Split AC 12', tag: 'NCA-0012', room: 'Room 12', cost: 4800, next_service: '2026-11-15' }];
  fa.io.fetch = async (url, init) => {
    assert.equal(url, 'https://mx.example.test/functions/v1/assets');
    const body = JSON.parse(init.body);
    if (body.action === 'rooms') return Response.json({ ok: true, rooms: ['Room 12'], areas: ['Kitchen', 'Store room'] });
    if (body.action === 'register') return Response.json({ ok: true, assets: [...register, ...added.flatMap((a) => a.units)] });
    if (body.action === 'add') { added.push(body); return Response.json({ ok: true, added: body.units.map((u) => u.name), skipped: [] }); }
    return Response.json({ ok: false, error: 'what?' }, { status: 400 });
  };
  return { added };
}

test('it’s an asset: each unit tagged NCA, with its room and servicing, to Maintenance', async () => {
  const { env, raw } = await setUp();
  await fa.scan(env, { fetchImpl: odoo().fetchImpl, today: '2026-11-02' });
  const mx = maintenance(env);
  await assert.rejects(fa.register(env, { key: 'line:601', units: [] }, SUP), /admin/i, 'admins only');
  await assert.rejects(fa.register(env, { key: 'line:601', units: [{ name: 'A', room: 'Kitchen' }], serviceMonths: 6 }, ADMIN), /first serviced/);
  const out = await fa.register(env, {
    key: 'line:601', serviceMonths: 6, firstService: '2027-04-14', servicedBy: 'in_house',
    units: [{ name: 'Chest freezer 1', room: 'Kitchen' }, { name: 'Chest freezer 2', room: 'Store room' }],
  }, ADMIN);
  assert.deepEqual(out.tags, ['NCA-0013', 'NCA-0014'], 'one higher than any on the register');
  const sent = mx.added[0];
  assert.equal(sent.by, 'Ama Test');
  assert.deepEqual(sent.units.map((u) => [u.name, u.tag, u.room, u.cost, u.supplier, u.bought, u.odoo_ref, u.odoo_key, u.service_months, u.first_service]), [
    ['Chest freezer 1', 'NCA-0013', 'Kitchen', 6500, 'A Cold Store Ltd', '2026-10-14', 'BILL/2026/10/0042', 'line:601#1', 6, '2027-04-14'],
    ['Chest freezer 2', 'NCA-0014', 'Store room', 6500, 'A Cold Store Ltd', '2026-10-14', 'BILL/2026/10/0042', 'line:601#2', 6, '2027-04-14'],
  ], 'the cost shared out per unit, in cedis');
  assert.equal(raw.prepare("SELECT state FROM fa_item WHERE key = 'line:601'").get().state, 'registered');
  await assert.rejects(fa.register(env, { key: 'line:601', units: [{ name: 'X', room: 'Kitchen' }] }, ADMIN), /on the register already/);
  // The next one carries on from the tags given here.
  const next = await fa.register(env, { key: 'line:501', units: [{ name: 'Office desktop', room: 'Kitchen' }] }, ADMIN);
  assert.deepEqual(next.tags, ['NCA-0015']);
  assert.equal(mx.added[1].units[0].service_months, null, 'not serviced');

  const page = await fa.faView(env, ADMIN);
  assert.deepEqual([page.totals.review, page.totals.register, page.totals.late, page.totals.dueSoon >= 0, page.nextTag], [2, 5, 1, true, 'NCA-0016']);
  assert.deepEqual(page.rooms, ['Room 12', 'Kitchen', 'Store room']);
  assert.equal(page.totals.atCost, (9200 + 4800 + 6500 + 6500 + 7900) * 100);
});

test('not an asset: remembered for that product, and can be put back', async () => {
  const { env, raw } = await setUp();
  await fa.scan(env, { fetchImpl: odoo().fetchImpl, today: '2026-11-02' });
  await fa.decide(env, { key: 'line:601' }, ADMIN);
  assert.ok(raw.prepare("SELECT 1 FROM fa_not_asset WHERE product = 'chest freezer 300l'").get());
  // A new bill for the same product is kept, as not an asset, and not asked about.
  raw.exec("DELETE FROM fa_item WHERE key = 'line:601'");
  await fa.scan(env, { fetchImpl: odoo().fetchImpl, today: '2026-11-02' });
  assert.deepEqual({ ...raw.prepare("SELECT state, decided_by FROM fa_item WHERE key = 'line:601'").get() }, { state: 'not_asset', decided_by: 'Remembered: not an asset' });
  await fa.decide(env, { key: 'line:601', undo: true }, ADMIN);
  assert.equal(raw.prepare("SELECT state FROM fa_item WHERE key = 'line:601'").get().state, 'review');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM fa_not_asset").get().n, 0);
});

test('the rules are an admin’s, in cedis; Today says what waits', async () => {
  const { env } = await setUp();
  await assert.rejects(fa.saveRules(env, { minEach: 3000 }, SUP), /admin/i);
  await assert.rejects(fa.saveRules(env, { minEach: 'lots' }, ADMIN), /not an amount/);
  const { rules } = await fa.saveRules(env, { minEach: 3000, words: 'freezer, generator ,freezer', since: '2026-01-01' }, ADMIN);
  assert.deepEqual([rules.minEach, rules.minLine, rules.words, rules.since], [300000, 1000000, ['freezer', 'generator'], '2026-01-01']);
  await fa.scan(env, { fetchImpl: odoo().fetchImpl, today: '2026-11-02' });
  maintenance(env);
  const items = await fa.todayItems(env);
  assert.deepEqual(items.map((x) => x.title), ['4 possible fixed assets from Odoo to review', '1 asset overdue for service']);
  assert.equal(items[1].why, 'Gas cooker (NCA-0011), Kitchen, since 2026-10-27');
});
