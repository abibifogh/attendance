import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { run } from '../src/lib/db.js';
import * as book from '../src/routes/supplierbook.js';

/** Buying › Suppliers. A made-up Odoo; every name and figure is invented. */

const ADMIN = { id: 1, name: 'Test Owner', isOwner: true, access: [] };
const SUP = { id: 3, name: 'Sam Supervisor', access: [{ systemId: 'insight', role: 'supervisor' }] };
const GM = { id: 4, name: 'Gina Manager', access: [{ systemId: 'insight', role: 'reports' }] };

function odoo() {
  return async (url, init) => {
    const [, model] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    if (model === 'res.partner') {
      return Response.json([
        { id: 11, name: 'A Poultry Farm Ltd', phone: '0240000001', email: false, vat: 'C0001', street: '1 Test Road', city: 'Accra', is_company: true, user_ids: [], supplier_rank: 4, property_supplier_payment_term_id: [1, '30 Days'] },
        { id: 12, name: 'A Hardware Shop', phone: false, mobile: '0240000002', email: 'shop@example.test', vat: false, street: false, city: false, is_company: true, user_ids: [], supplier_rank: 2 },
        { id: 13, name: 'Kofi Test', phone: false, email: false, vat: false, street: false, city: false, is_company: false, user_ids: [7], supplier_rank: 1 },
      ].slice(0, body.offset ? 0 : 3));
    }
    if (model === 'res.partner.bank') return Response.json([{ partner_id: [11, 'A Poultry Farm Ltd'], acc_number: '1234567890', bank_id: [2, 'A Test Bank'], acc_holder_name: 'A Poultry Farm' }]);
    return new Response('no', { status: 404 });
  };
}

async function setUp() {
  const { db } = freshDb();
  const env = { DB: db, ODOO_KEY_ODOO: 'k' };
  await run(db, `UPDATE sources SET config = '{"base":"https://odoo.example.test"}', enabled = 1 WHERE id = 'odoo'`);
  // The warehouse: an Odoo bill (half owed), a breakfast purchase under another spelling, one under a name Odoo has not.
  await run(db, "INSERT INTO dim_supplier (id, match_key, name) VALUES (1, 'a poultry farm', 'A Poultry Farm Ltd'), (2, 'poultry farm a', 'Poultry Farm A'), (3, 'a market trader', 'A Market Trader')");
  await run(db, `INSERT INTO fact_bill (source_id, external_id, day, supplier_id, line_id, state, payment_state, total, residual)
    VALUES ('odoo', 'b1', '2026-10-10', 1, 'breakfast', 'posted', 'partial', 200000, 50000)`);
  await run(db, `INSERT INTO fact_purchase_line (day, source_id, external_id, line_id, supplier_id, qty, unit_cost, amount) VALUES
    ('2026-10-12', 'breakfast', 'p1', 'breakfast', 2, 10, 3000, 30000),
    ('2026-10-14', 'breakfast', 'p2', 'breakfast', 3, 1, 9000, 9000),
    ('2026-10-15', 'odoo', 'o1', 'breakfast', 1, 1, 200000, 200000)`);
  return env;
}

test('Odoo is the list: refreshed in, with details, staff-looking names, and bank accounts', async () => {
  const env = await setUp();
  await assert.rejects(book.refresh(env, GM, { fetchImpl: odoo() }), /admins and supervisors/);
  const out = await book.refresh(env, SUP, { fetchImpl: odoo() });
  assert.equal(out.count, 3);
  const b = await book.book(env, { from: '2026-10-01', to: '2026-10-31' }, ADMIN);
  const farm = b.suppliers.find((s) => s.id === 11);
  assert.deepEqual([farm.phone, farm.vat, farm.terms, farm.owed], ['0240000001', 'C0001', '30 Days', 50000]);
  assert.equal(farm.spend, 200000, 'the bill only: Odoo\'s own purchase lines are not counted twice');
  assert.equal(b.suppliers.find((s) => s.id === 13).staff, true, 'a login in Odoo');
  assert.equal(b.suppliers.find((s) => s.id === 12).phone, '0240000002', 'the mobile when there is no phone');
  assert.deepEqual(b.unlinked.map((u) => u.name).sort(), ['A Market Trader', 'Poultry Farm A']);
});

test('key suppliers in groups, hidden ones, and another spelling counting as the Odoo supplier', async () => {
  const env = await setUp();
  await book.refresh(env, ADMIN, { fetchImpl: odoo() });
  await book.save(env, { id: 11, key: true }, SUP);
  await book.save(env, { id: 11, group: 'Food & breakfast' }, SUP);
  await book.save(env, { id: 13, hidden: true }, ADMIN);
  await book.link(env, { id: 11, name: 'Poultry Farm A' }, SUP);
  let b = await book.book(env, { from: '2026-10-01', to: '2026-10-31' }, GM);
  const farm = b.suppliers.find((s) => s.id === 11);
  assert.deepEqual([farm.key, farm.group, farm.spend, farm.aliases], [true, 'Food & breakfast', 230000, ['Poultry Farm A']]);
  assert.equal(b.tiles.key, 1);
  assert.equal(b.suppliers.find((s) => s.id === 13).hidden, true);
  assert.deepEqual(b.unlinked.map((u) => u.name), ['A Market Trader']);
  assert.equal(farm.hasPay, null, 'nobody but admins and supervisors learns even whether payment details exist');

  // Hiding a key supplier unmarks it; a reports-only person changes nothing.
  await book.save(env, { id: 11, hidden: true }, ADMIN);
  b = await book.book(env, {}, ADMIN);
  assert.equal(b.suppliers.find((s) => s.id === 11).key, false);
  await assert.rejects(book.save(env, { id: 12, key: true }, GM), /admins and supervisors/);
  await assert.rejects(book.link(env, { id: 12, name: 'x' }, GM), /admins and supervisors/);

  await book.link(env, { unlink: 'poultry farm a' }, ADMIN);
  b = await book.book(env, { from: '2026-10-01', to: '2026-10-31' }, ADMIN);
  assert.ok(b.unlinked.some((u) => u.name === 'Poultry Farm A'));
});

test('how a supplier is paid: admins and supervisors only, and every change kept with the number masked', async () => {
  const env = await setUp();
  await book.refresh(env, ADMIN, { fetchImpl: odoo() });
  await assert.rejects(book.save(env, { id: 11, pay: { momoNumber: 'not a number' } }, SUP), /MoMo number/);
  await book.save(env, { id: 11, pay: { momoNumber: '024 555 1234', momoName: 'A Poultry Farm', momoNetwork: 'MTN' } }, SUP);
  const seen = await book.one(env, { id: 11 }, ADMIN);
  assert.equal(seen.supplier.pay.momoNumber, '024 555 1234');
  assert.deepEqual(seen.supplier.pay.odooBanks, [{ bank: 'A Test Bank', number: '1234567890', holder: 'A Poultry Farm' }]);
  assert.match(seen.history[0].what, /MoMo number: …1234/);
  assert.doesNotMatch(seen.history[0].what, /555/);
  assert.equal(seen.history[0].by_name, 'Sam Supervisor');
  const gm = await book.one(env, { id: 11 }, GM);
  assert.equal(gm.supplier.pay, null);
  assert.deepEqual(gm.history, []);
  assert.equal(gm.canEdit, false);
  assert.equal(gm.byMonth.length, 6);
});

test('the list goes to the breakfast app and the maintenance store, signed, key suppliers first, hidden ones left out', async () => {
  const { verifyLink } = await import('../src/lib/link.js');
  const env = { ...(await setUp()), BREAKFAST_URL: 'https://bf.example.test', SSO_SECRET_BREAKFAST: 'bf', SSO_SECRET_MAINTENANCE: 'mx', MAINTENANCE_APPROVALS_URL: 'https://mx.example.test/functions/v1/approvals' };
  const sent = [];
  const fromOdoo = odoo();
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.host === 'odoo.example.test') return fromOdoo(url, init);
    const secret = u.host === 'bf.example.test' ? 'bf' : 'mx';
    const path = u.host === 'bf.example.test' ? '/api/link/suppliers' : '/suppliers';
    assert.equal(u.pathname, u.host === 'bf.example.test' ? '/api/link/suppliers' : '/functions/v1/suppliers');
    assert.ok(await verifyLink(secret, { at: init.headers['X-Till-At'], sig: init.headers['X-Till-Sig'], path, bodyText: init.body }), `${u.host}: signed`);
    const body = JSON.parse(init.body);
    sent.push([u.host, body.suppliers.map((s) => `${s.key ? '★' : ''}${s.name}`)]);
    return Response.json({ ok: true, count: body.suppliers.length });
  };
  await book.refresh(env, ADMIN, { fetchImpl });
  await book.save(env, { id: 12, key: true }, ADMIN, { fetchImpl });
  sent.length = 0;
  await book.save(env, { id: 13, hidden: true }, ADMIN, { fetchImpl });
  assert.equal(sent.length, 2, 'hiding somebody sends the list again');
  await book.save(env, { id: 12, note: 'Delivers on Tuesdays' }, ADMIN, { fetchImpl });
  assert.equal(sent.length, 2, 'a note does not');
  const out = await book.pushSuppliers(env, { fetchImpl });
  assert.deepEqual(out, { breakfast: 'sent 2', maintenance: 'sent 2' });
  assert.deepEqual(sent.at(-1), ['mx.example.test', ['★A Hardware Shop', 'A Poultry Farm Ltd']]);
  const unlinked = await book.pushSuppliers({ DB: env.DB }, { fetchImpl });
  assert.deepEqual(unlinked, { breakfast: 'not linked', maintenance: 'not linked' });
});
