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
function odoo() {
  const made = { po: [], attachments: [] };
  const vendors = [{ id: 11, name: 'A Fuel Station' }, { id: 12, name: 'A Hardware Shop Ltd' }, { id: 13, name: 'Another Fuel Depot' }];
  const products = [{ id: 21, name: 'Fuel', display_name: 'Fuel' }, { id: 22, name: 'Maintenance supplies', display_name: 'Maintenance supplies' }];
  const pos = [{ id: 90, name: 'P02509', partner_id: [11, 'A Fuel Station'], amount_total: 800, state: 'draft', create_uid: [5, 'Kofi Test'], date_order: `${today} 09:00:00` }];
  const fetchImpl = async (url, init) => {
    const [, model, method] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    if (model === 'res.partner') return Response.json(vendors);
    if (model === 'product.product') return Response.json(products);
    if (model === 'purchase.order.line') return Response.json([{ id: 1, partner_id: [11, 'A Fuel Station'] }]);
    if (model === 'purchase.order' && method === 'create') {
      const vals = body.vals_list[0];
      const id = 100 + made.po.length;
      made.po.push(vals);
      pos.push({ id, name: `P0${2517 + made.po.length - 1}`, partner_id: [vals.partner_id, 'x'], amount_total: vals.order_line[0][2].price_unit, state: 'draft', create_uid: [1, 'Insight'], date_order: vals.date_order });
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
    { vendor: 'A Hardware Shop', amount: 14500, description: '2 padlocks', date: '2026-10-15', problem: '' });
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
