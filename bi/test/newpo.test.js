import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as newpo from '../src/routes/newpo.js';

/**
 * Create PO: a draft purchase order in Odoo from three details, a sentence or
 * a receipt. Everything is invented: a made-up Odoo, made-up vendors.
 */

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const today = new Date().toISOString().slice(0, 10);

/** A made-up Odoo behind one fetch, keeping what was created. */
function odoo({ fail = null } = {}) {
  const made = { po: [], attachments: [] };
  const vendors = [{ id: 11, name: 'A Fuel Station' }, { id: 12, name: 'A Hardware Shop Ltd' }, { id: 13, name: 'Another Fuel Depot' }];
  const products = [{ id: 21, name: 'Fuel', display_name: 'Fuel' }, { id: 22, name: 'Maintenance supplies', display_name: 'Maintenance supplies' }];
  const pos = [{ id: 90, name: 'P02509', partner_id: [11, 'A Fuel Station'], amount_total: 800, state: 'draft', create_uid: [5, 'Kofi Test'], date_order: `${today} 09:00:00` }];
  const fetchImpl = async (url, init) => {
    const [, model, method] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    if (model === 'res.users' && method === 'context_get') return Response.json({ lang: 'en_GB', tz: 'Africa/Accra', uid: 7 });
    if (model === 'res.users') return Response.json([{ id: 7, name: 'Insight Robot', login: 'insight@example.test' }]);
    if (model === 'ir.model.access') return Response.json(fail !== 'refuse');
    if (model === 'res.partner') return Response.json(vendors);
    if (model === 'product.product') return Response.json(products);
    if (model === 'purchase.order.line') return Response.json([{ id: 1, partner_id: [11, 'A Fuel Station'] }]);
    if (model === 'purchase.order' && method === 'create') {
      if (fail === 'refuse') return Response.json({ name: 'odoo.exceptions.ValidationError', message: 'Incompatible companies on records: the product belongs to another company.' }, { status: 422 });
      const vals = body.vals_list[0];
      const id = 100 + made.po.length;
      made.po.push(vals);
      pos.push({ id, name: `P0${2517 + made.po.length - 1}`, partner_id: [vals.partner_id, 'x'], amount_total: vals.order_line[0][2].price_unit, state: 'draft', create_uid: [1, 'Insight'], date_order: vals.date_order, origin: vals.origin });
      // Made, and then no answer: as if the connection dropped.
      if (fail === 'silent') throw new Error('connection reset');
      return Response.json([id]);
    }
    if (model === 'purchase.order') {
      const idIs = body.domain.find((d) => d[0] === 'id');
      if (idIs) return Response.json(pos.filter((p) => p.id === idIs[2]));
      const partner = body.domain.find((d) => d[0] === 'partner_id')[2];
      const from = body.domain.find((d) => d[0] === 'date_order' && d[1] === '>=')[2];
      return Response.json(pos.filter((p) => p.partner_id[0] === partner && p.date_order.slice(0, 10) === from.slice(0, 10)));
    }
    if (model === 'ir.attachment') { made.attachments.push(body.vals_list[0]); return Response.json([500]); }
    return new Response('no', { status: 404 });
  };
  return { made, fetchImpl };
}

async function setUp(ai) {
  const { db } = freshDb();
  const env = { DB: db, ODOO_KEY_ODOO: 'k', ...(ai ? { AI: ai } : {}) };
  await db.prepare(`UPDATE sources SET config = '{"base":"https://odoo.example.test"}', enabled = 1 WHERE id = 'odoo'`).run();
  return env;
}

test('names matched to Odoo’s: the same words, one inside the other, or most words shared', () => {
  const list = [{ id: 1, name: 'A Fuel Station' }, { id: 2, name: 'A Hardware Shop Ltd' }, { id: 3, name: 'Fuel' }];
  assert.equal(newpo.closest('a hardware shop', list).id, 2, 'Ltd does not count');
  assert.equal(newpo.closest('FUEL', list).id, 3);
  assert.equal(newpo.closest('Fuel station', list).id, 1);
  assert.equal(newpo.closest('Plumber', list), null, 'nothing close: nothing guessed');
});

test('a sentence read without the reader: the amount, the day and what to buy', () => {
  assert.deepEqual(newpo.plainRead('create PO for fuel 800ghs with today’s date', '2026-10-16'),
    { vendor: '', amount: 80000, description: 'Fuel', date: '2026-10-16', problem: '' });
  assert.deepEqual(newpo.plainRead('Gas GH₵ 1,250.50 yesterday', '2026-10-16').amount, 125050);
  assert.equal(newpo.plainRead('Gas GH₵ 1,250.50 yesterday', '2026-10-16').date, '2026-10-15');
  assert.deepEqual(newpo.parseAnswer({ response: 'Here: {"vendor":"A Hardware Shop","amount":"GH₵145.00","description":"2 padlocks","date":"2026-10-15","problem":""}' }),
    { vendor: 'A Hardware Shop', amount: 14500, description: '2 padlocks', date: '2026-10-15', problem: '', lines: [] });
  // Each thing bought, when the reader listed them: for a receipt going to the POS.
  assert.deepEqual(newpo.linesOf([{ name: 'Tonic water 330ml, crate of 24', qty: '4', amount: 'GH₵640.00' }, { name: '', qty: '1', amount: '5' }, { name: 'Limes', qty: '', amount: '' }]),
    [{ name: 'Tonic water 330ml, crate of 24', qty: 4, amount: 64000 }, { name: 'Limes', qty: 1, amount: null }]);
});

test('typed: filled in, the vendor last used for the item suggested; checked for one like it; created as a draft', async () => {
  const asked = [];
  const env = await setUp({ run: async (model, input) => { asked.push(input); return { response: JSON.stringify({ vendor: '', amount: '800', description: 'Fuel', date: today, problem: '' }) }; } });
  const { made, fetchImpl } = odoo();
  const form = await newpo.poForm(env, { fetchImpl });
  assert.deepEqual(form.vendors.map((x) => x.name), ['A Fuel Station', 'A Hardware Shop Ltd', 'Another Fuel Depot']);

  const out = await newpo.readPo(env, { text: 'create PO for fuel 800ghs with today’s date' }, { fetchImpl });
  assert.match(asked[0].messages[0].content, new RegExp(`Today is ${today}`));
  assert.deepEqual([out.read.amount, out.read.description, out.read.date, out.read.product.id, out.read.vendor.id, out.read.vendorFrom], [80000, 'Fuel', today, 21, 11, 'last']);

  const body = { vendorId: 11, productId: 21, amount: '800', description: 'Fuel', date: today };
  await assert.rejects(newpo.checkPo(env, { ...body, vendorId: 99 }, { fetchImpl }), /vendor from Odoo/);
  await assert.rejects(newpo.checkPo(env, { ...body, amount: '0' }, { fetchImpl }), /Amount/);
  const check = await newpo.checkPo(env, body, { fetchImpl });
  assert.deepEqual(check.alike.map((p) => p.name), ['P02509'], 'the same vendor, day and amount: said');

  const done = await newpo.createPo(env, body, OWNER, { fetchImpl });
  assert.deepEqual(made.po[0], {
    partner_id: 11, date_order: `${today} 12:00:00`, origin: 'Insight · Test Owner',
    order_line: [[0, 0, { product_id: 21, name: 'Fuel', product_qty: 1, price_unit: 800 }]],
  });
  assert.deepEqual([done.po.name, done.po.total, done.attached], ['P02517', 80000, false]);
  assert.match(done.po.url, /odoo\.example\.test\/web#model=purchase\.order&id=100/);
  const kept = await env.DB.prepare('SELECT * FROM po_created').first();
  assert.deepEqual([kept.name, kept.vendor, kept.amount, kept.by_name], ['P02517', 'A Fuel Station', 80000, 'Test Owner']);
});

test('a receipt: read off the photo, the vendor found, and the photo attached to the PO', async () => {
  const env = await setUp({ run: async () => ({ response: '{"vendor":"A Hardware Shop","amount":"145.00","description":"2 padlocks, 1 hinge","date":"2026-10-15","problem":""}' }) });
  const { made, fetchImpl } = odoo();
  const photo = `data:image/jpeg;base64,${Buffer.from('receipt').toString('base64')}`;
  const out = await newpo.readPo(env, { file: photo }, { fetchImpl });
  assert.deepEqual([out.read.vendor.id, out.read.vendorFrom, out.read.amount, out.read.date, out.read.dateFrom], [12, 'read', 14500, '2026-10-15', 'read']);
  assert.equal(out.read.product, null, 'nothing in Odoo like it: chosen by hand');
  const done = await newpo.createPo(env, { vendorId: 12, productId: 22, amount: '145', description: '2 padlocks, 1 hinge', date: '2026-10-15', file: photo }, OWNER, { fetchImpl });
  assert.equal(done.attached, true);
  assert.deepEqual([made.attachments[0].res_model, made.attachments[0].res_id, made.attachments[0].mimetype, made.attachments[0].name], ['purchase.order', 100, 'image/jpeg', 'Receipt P02517.jpg']);
  await assert.rejects(newpo.readPo(env, { file: 'data:text/plain;base64,AA==' }, { fetchImpl }), /photo or a PDF/);
});

test('a PDF: its text read; a scan with no text says to take a photo instead', async () => {
  let text = '# A Hardware Shop\nPadlock x2  100.00\nTotal GHS 145.00\nDate 15/10/2026';
  const seen = [];
  const env = await setUp({
    run: async (model, input) => { seen.push(input.messages[0].content); return { response: '{"vendor":"A Hardware Shop","amount":"145","description":"Padlocks","date":"2026-10-15","problem":""}' }; },
    toMarkdown: async (file) => ({ format: 'markdown', data: text, name: file.name }),
  });
  const { fetchImpl } = odoo();
  const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`;
  const out = await newpo.readPo(env, { file: pdf, name: 'r.pdf' }, { fetchImpl });
  assert.match(seen[0], /Total GHS 145\.00/, 'the PDF’s text goes to the reader');
  assert.equal(out.read.amount, 14500);
  text = '';
  const scan = await newpo.readPo(env, { file: pdf }, { fetchImpl });
  assert.equal(scan.read, null);
  assert.match(scan.said, /no text in it .* Take a photo/);
});

test('without the reader, a sentence is still read plainly; a receipt says to fill it in by hand', async () => {
  const env = await setUp(null);
  const { fetchImpl } = odoo();
  const out = await newpo.readPo(env, { text: 'fuel 800 cedis today' }, { fetchImpl });
  assert.deepEqual([out.read.amount, out.read.description, out.read.product.id], [80000, 'Fuel', 21]);
  await assert.rejects(newpo.readPo(env, { file: `data:image/png;base64,${Buffer.from('x').toString('base64')}` }, { fetchImpl }), /by hand/);
});

test('when Odoo will not create it, its own words are shown; when it made it but did not answer, the PO is found, not made twice', async () => {
  const env = await setUp(null);
  const body = { vendorId: 12, productId: 22, amount: '145', description: 'Padlocks', date: today };
  let o = odoo({ fail: 'refuse' });
  await assert.rejects(newpo.createPo(env, body, OWNER, { fetchImpl: o.fetchImpl }),
    (err) => err.status === 502 && /Odoo did not create the PO\. Odoo answered 422 creating purchase\.order: Incompatible companies/.test(err.message));
  // Refused for want of rights: which login Odoo refused, and the form warns before anything is typed.
  o = odoo({ fail: 'refuse' });
  const denied = async (url, init) => (/purchase\.order\/create$/.test(String(url))
    ? Response.json({ name: 'odoo.exceptions.AccessError', message: "You are not allowed to create 'Purchase Order Line' (purchase.order.line) records." }, { status: 403 })
    : o.fetchImpl(url, init));
  await assert.rejects(newpo.createPo(env, body, OWNER, { fetchImpl: denied }),
    /Odoo did not allow creating purchase\.order: You are not allowed .* Insight's Odoo key signs in as Insight Robot \(insight@example\.test\) on odoo\.example\.test\./);
  const form = await newpo.poForm(env, { fetchImpl: denied });
  assert.deepEqual(form.as, { uid: 7, name: 'Insight Robot', login: 'insight@example.test', db: null, host: 'odoo.example.test', canCreate: false });
  assert.equal((await newpo.poForm(env, { fetchImpl: odoo().fetchImpl })).as.canCreate, true);

  o = odoo({ fail: 'silent' });
  const found = await newpo.createPo(env, body, OWNER, { fetchImpl: o.fetchImpl });
  assert.deepEqual([found.ok, found.po.name, o.made.po.length], [true, 'P02517', 1], 'the one Odoo made, found');
  // Pressed again: the PO already made from Insight is said, not made twice...
  const again = await newpo.createPo(env, body, OWNER, { fetchImpl: o.fetchImpl });
  assert.deepEqual([again.ok, again.already.name, again.already.origin, o.made.po.length], [false, 'P02517', 'Insight · Test Owner', 1]);
  // ...unless it was on the last look, or it is a second purchase.
  assert.equal((await newpo.createPo(env, { ...body, seen: ['P02517'] }, OWNER, { fetchImpl: odoo().fetchImpl })).ok, true);
  const second = odoo({ fail: null });
  assert.equal((await newpo.createPo(env, { ...body, again: true }, OWNER, { fetchImpl: second.fetchImpl })).ok, true);
});

test('a PO made here is a shift’s expense only once an admin allows it: ticked when made, or when staff ask', async () => {
  const env = await setUp(null);
  const { fetchImpl } = odoo();
  const body = { vendorId: 11, productId: 21, amount: '800', description: 'Fuel', date: today };
  await newpo.createPo(env, { ...body, drawer: true }, OWNER, { fetchImpl });
  await newpo.createPo(env, { ...body, vendorId: 12, amount: '145', description: 'Padlocks' }, OWNER, { fetchImpl });
  let made = await newpo.madeHere(env, ['p02517', 'P02518', 'P99999']);
  assert.deepEqual([made.get('P02517').allowed, made.get('P02518').allowed, made.get('P02518').refused, made.has('P99999')], [true, false, false, false]);

  // Staff try P02518 on a shift: the admins are asked, once.
  await newpo.askForDrawer(env, { name: 'P02518', by: 'Kofi Test' });
  await newpo.askForDrawer(env, { name: 'P02518', by: 'Ama Test' });
  let asks = (await newpo.drawerAsks(env)).items;
  assert.deepEqual(asks.map((a) => [a.name, a.askedBy, a.madeBy]), [['P02518', 'Kofi Test', 'Test Owner']]);
  await assert.rejects(newpo.decideDrawer(env, { name: 'P02518', allow: false }, OWNER), /Why/);
  await newpo.decideDrawer(env, { name: 'P02518', allow: false, note: 'Paid by MoMo from the office' }, OWNER);
  made = await newpo.madeHere(env, ['P02518']);
  assert.deepEqual([made.get('P02518').refused, made.get('P02518').note, made.get('P02518').decidedBy], [true, 'Paid by MoMo from the office', 'Test Owner']);
  assert.equal((await newpo.drawerAsks(env)).items.length, 0, 'decided: off the Inbox');
  await newpo.decideDrawer(env, { name: 'P02518', allow: true }, OWNER);
  assert.equal((await newpo.madeHere(env, ['P02518'])).get('P02518').allowed, true);
  await assert.rejects(newpo.decideDrawer(env, { name: 'P00001', allow: true }, OWNER), /not made in Insight/);
  asks = (await newpo.drawerAsks(env)).items;
  assert.equal(asks.length, 0);
});

test('the nearest product: by its words first, else picked by the reader, with how sure it is', async () => {
  const products = [{ id: 21, name: 'Fuel' }, { id: 22, name: 'Maintenance supplies' }];
  const asked = [];
  const env = { AI: { run: async (model, input) => { asked.push(input.messages[0].content); return { response: '{"number": 1, "sure": true}' }; } } };
  assert.deepEqual(await newpo.matchProduct(env, 'fuel', products), { product: products[0], by: 'words', sure: true });
  assert.equal(asked.length, 0, 'words found it: the reader is not asked');
  assert.deepEqual(await newpo.matchProduct(env, 'Diesel Excellium', products, { vendor: 'A Fuel Station' }), { product: products[0], by: 'reader', sure: true });
  assert.match(asked[0], /bought: "Diesel Excellium" from "A Fuel Station"/);
  assert.match(asked[0], /\n1\. Fuel\n2\. Maintenance supplies$/);
  const none = { AI: { run: async () => ({ response: '{"number": 0, "sure": false}' }) } };
  assert.equal(await newpo.matchProduct(none, 'A birthday cake', products), null, 'none fits: none chosen');
  const silly = { AI: { run: async () => ({ response: '{"number": 9, "sure": true}' }) } };
  assert.equal(await newpo.matchProduct(silly, 'A birthday cake', products), null, 'a number not on the list is not trusted');
  assert.equal(await newpo.matchProduct({}, 'Diesel Excellium', products), null, 'no reader: nothing guessed');
});

test('a contact made in Odoo just now: found by name, and accepted on a PO though Odoo does not list it as a vendor yet', async () => {
  const env = await setUp();
  const seen = [];
  const fetchImpl = async (url, init) => {
    const [, model] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    seen.push([model, body.domain]);
    if (model === 'res.partner' && body.domain?.[0]?.[0] === 'supplier_rank') return Response.json([{ id: 11, name: 'A Fuel Station' }]);
    if (model === 'res.partner' && body.domain?.[0]?.[0] === 'name') return Response.json([{ id: 90, name: 'Vendor to confirm', supplier_rank: 0 }]);
    if (model === 'res.partner') return Response.json(body.domain?.[0]?.[2] === 90 ? [{ id: 90, name: 'Vendor to confirm' }] : []);
    if (model === 'product.product' && body.domain?.[0]?.[0] === 'name') return Response.json([{ id: 99, name: 'Item to classify', display_name: 'Item to classify', purchase_ok: true }, { id: 98, name: 'Item for sale', display_name: 'Item for sale', purchase_ok: false }]);
    if (model === 'product.product' && body.domain?.[0]?.[0] === 'id') return Response.json(body.domain[0][2] === 98 ? [{ id: 98, name: 'Item for sale', purchase_ok: false }] : [{ id: 99, name: 'Item to classify', purchase_ok: true }]);
    if (model === 'product.product') return Response.json([{ id: 21, name: 'Fuel', display_name: 'Fuel' }]);
    if (model === 'purchase.order') return Response.json([]);
    return new Response('no', { status: 404 });
  };
  const found = await newpo.findPo(env, { kind: 'vendor', q: 'vendor to' }, { fetchImpl });
  assert.deepEqual(found.items, [{ id: 90, name: 'Vendor to confirm', vendor: false }]);
  const items = (await newpo.findPo(env, { kind: 'product', q: 'item' }, { fetchImpl })).items;
  assert.deepEqual(items.map((x) => [x.name, x.purchaseOk]), [['Item to classify', true], ['Item for sale', false]]);
  const body = { vendorId: 90, productId: 99, amount: '50', description: 'Gas refill', date: today };
  const out = await newpo.checkPo(env, body, { fetchImpl });
  assert.deepEqual([out.po.vendor.name, out.po.product.name], ['Vendor to confirm', 'Item to classify']);
  await assert.rejects(newpo.checkPo(env, { ...body, productId: 98 }, { fetchImpl }), /not marked “Can be purchased”/);
  assert.deepEqual(await newpo.findPo(env, { kind: 'vendor', q: 'v' }, { fetchImpl }), { kind: 'vendor', items: [] }, 'one letter asks nothing');
});
