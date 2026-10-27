import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as floats from '../src/routes/floats.js';

/**
 * Floats: money given to people to spend, their receipts made into draft POs
 * carrying their reference, what they hold, and a statement. A made-up Odoo
 * and a made-up reader. Everybody is invented.
 */

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const b64 = (s) => Buffer.from(s).toString('base64');
const jpg = (s) => `data:image/jpeg;base64,${b64(s)}`;
const READS = {
  diesel: { vendor: 'A Fuel Station', amount: '300', description: 'Fuel', date: '2026-10-17', problem: '' },
  locks: { vendor: 'A Hardware Shop', amount: '120', description: 'Padlock', date: '2026-10-15', problem: '' },
  dark: { vendor: '', amount: '', description: '', date: '', problem: 'too dark' },
};
const ai = {
  run: async (model, input) => {
    const c = input.messages[0].content;
    if (typeof c === 'string') return { response: JSON.stringify({ number: 0, sure: false }) };
    const key = Buffer.from((c[1].image_url.url.split(',')[1]) || '', 'base64').toString();
    return { response: JSON.stringify(READS[key] || READS.dark) };
  },
};

function odoo() {
  const made = [];
  const pos = [];
  const fetchImpl = async (url, init) => {
    const [, model, method] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    if (model === 'res.partner') return Response.json([{ id: 11, name: 'A Fuel Station' }, { id: 12, name: 'A Hardware Shop' }]);
    if (model === 'product.product') return Response.json([{ id: 21, name: 'Fuel', display_name: 'Fuel' }, { id: 22, name: 'Padlock', display_name: 'Padlock' }]);
    if (model === 'purchase.order' && method === 'create') {
      const vals = body.vals_list[0];
      const id = 100 + made.length;
      made.push(vals);
      pos.push({ id, name: `P0${2530 + made.length}`, partner_id: [vals.partner_id, 'x'], amount_total: vals.order_line[0][2].price_unit, state: 'draft', date_order: vals.date_order, origin: vals.origin });
      return Response.json([id]);
    }
    if (model === 'purchase.order' && ['message_post', 'activity_schedule'].includes(method)) return Response.json([1]);
    if (model === 'purchase.order') {
      const byId = body.domain.find((d) => d[0] === 'id');
      if (byId) return Response.json(pos.filter((p) => p.id === byId[2]));
      const byName = body.domain.find((d) => d[0] === 'name');
      if (byName) return Response.json(pos.filter((p) => byName[2].includes(p.name)));
      return Response.json([]);
    }
    if (model === 'ir.attachment') return Response.json([500]);
    return new Response('no', { status: 404 });
  };
  return { made, pos, fetchImpl };
}

async function setUp() {
  const { db } = freshDb();
  const o = odoo();
  const env = { DB: db, ODOO_KEY_ODOO: 'k', AI: ai };
  await db.prepare(`UPDATE sources SET config = '{"base":"https://odoo.example.test"}', enabled = 1 WHERE id = 'odoo'`).run();
  globalThis.fetch = o.fetchImpl;
  return { env, ...o };
}

test('money given, receipts sent from their link become POs with their reference, and what they hold goes down', async () => {
  const { env, made, pos } = await setUp();
  const out = await floats.give(env, { name: 'Kofi Test', amount: '1,000.00', day: '2026-10-12', source: 'safe', note: 'Market runs' }, OWNER);
  await assert.rejects(floats.give(env, { name: 'Kofi Other', amount: '5', code: 'KOFI' }, OWNER), /somebody else’s already/);
  await assert.rejects(floats.give(env, { personId: out.personId, amount: '0' }, OWNER), /above nothing/);

  // Their link: a receipt, read and made into a draft PO carrying FLT/KOFI/001 in both fields.
  await assert.rejects(floats.linkSend(env, { t: 'wrong', file: jpg('diesel') }), /no longer in use/);
  const sent = await floats.linkSend(env, { t: out.token, file: jpg('diesel'), hint: 'Generator' });
  assert.equal(sent.ref, 'FLT/KOFI/001');
  assert.match(sent.said, /GH₵300\.00\. It is being checked/);
  assert.equal(made[0].partner_ref, 'FLT/KOFI/001');
  assert.equal(made[0].origin, 'FLT/KOFI/001 · Float · Kofi Test');
  assert.equal(made[0].order_line[0][2].name, "Fuel (Kofi Test's float)");

  // Two more: one read, one too dark (no PO, counts nothing until filled in).
  await floats.linkSend(env, { t: out.token, file: jpg('locks') });
  const dark = await floats.linkSend(env, { t: out.token, file: jpg('dark') });
  assert.equal(dark.ref, 'FLT/KOFI/003');
  assert.match(dark.said, /could not be read/);
  // The same picture again is counted once.
  const twice = await floats.linkSend(env, { t: out.token, file: jpg('locks') });
  assert.equal(twice.duplicate, true);

  let view = await floats.linkView(env, { t: out.token });
  assert.deepEqual([view.given, view.spent, view.held, view.sent.length], [100000, 42000, 58000, 3]);
  assert.deepEqual(view.sent.map((s) => s.status), ['checking', 'checking', 'checking']);

  // Confirmed in Odoo: accepted. Cancelled: refused, back on what he holds.
  pos[0].state = 'purchase';
  pos[1].state = 'cancel';
  view = await floats.linkView(env, { t: out.token });
  assert.deepEqual(view.sent.map((s) => [s.ref, s.status]), [['FLT/KOFI/003', 'checking'], ['FLT/KOFI/002', 'refused'], ['FLT/KOFI/001', 'accepted']]);
  assert.equal(view.held, 70000);

  // Some given back; the list and the detail agree.
  await floats.giveBack(env, { personId: out.personId, amount: '200', day: '2026-10-18' }, OWNER);
  const list = await floats.list(env);
  assert.deepEqual([list.people[0].held, list.people[0].toLookAt, list.tiles.held], [50000, 1, 50000]);
  const detail = await floats.detail(env, out.personId);
  assert.deepEqual([detail.given, detail.spent, detail.back, detail.held], [100000, 30000, 20000, 50000]);

  // An admin refuses one by hand, with a reason; or takes it back.
  const r1 = detail.receipts.find((r) => r.ref === 'FLT/KOFI/001');
  await assert.rejects(floats.decide(env, { id: r1.id, refuse: true }, OWNER), /Why/);
  await floats.decide(env, { id: r1.id, refuse: true, reason: 'Not ours' }, OWNER);
  assert.equal((await floats.detail(env, out.personId)).held, 80000);

  // A new link stops the old one; switched off, no link works.
  const fresh = await floats.setLink(env, { personId: out.personId });
  await assert.rejects(floats.linkView(env, { t: out.token }), /no longer in use/);
  await floats.setLink(env, { personId: out.personId, active: false });
  await assert.rejects(floats.linkView(env, { t: fresh.token }), /no longer in use/);
});

test('a statement for a period: held at the start, every line, held at the end, as a spreadsheet or a page', async () => {
  const { env } = await setUp();
  const { personId, token } = await floats.give(env, { name: 'Ama Test', amount: '500', day: '2026-09-28', source: 'bank' }, OWNER);
  await floats.give(env, { personId, amount: '300', day: '2026-10-12', source: 'safe' }, OWNER);
  await floats.linkSend(env, { t: token, file: jpg('locks') });
  await floats.giveBack(env, { personId, amount: '80', day: '2026-10-18' }, OWNER);

  const csv = await (await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31', format: 'csv' })).text();
  assert.match(csv, /Float statement: Ama Test \(FLT\/AMA\)/);
  assert.match(csv, /,Held at the start,,,,,,500\.00/);
  assert.match(csv, /2026-10-12,Given from the safe by Test Owner,,,,300\.00,,800\.00/);
  assert.match(csv, /2026-10-15,"Receipt: A Hardware Shop, Padlock",FLT\/AMA\/001,P02531,Being checked,,120\.00,680\.00/);
  assert.match(csv, /2026-10-18,Given back,,,,,80\.00,600\.00/);
  assert.match(csv, /,Held at the end,,,,300\.00,200\.00,600\.00/);

  const res = await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31' });
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Float statement · Ama Test/);
  assert.match(html, /Print or save as PDF/);
  await assert.rejects(floats.statement(env, personId, { from: '2026-11-01', to: '2026-10-01' }), /start is after the end/);
});

test('short links: the first four letters of their name, a number when taken, and an ending an admin can change', async () => {
  const { env } = await setUp();
  assert.equal(floats.slugFrom('Ignacio Test'), 'igna');
  assert.equal(floats.slugFrom('Éfua Test'), 'efua', 'accents dropped');
  assert.equal(floats.slugFrom('Yé', 'YE1'), 'ye');
  const a = await floats.give(env, { name: 'Ignacio Test', amount: '100' }, OWNER);
  const b = await floats.give(env, { name: 'Ignatius Test', code: 'IGNT', amount: '100' }, OWNER);
  assert.deepEqual([a.slug, b.slug], ['igna', 'igna2']);
  assert.equal((await floats.linkView(env, { s: 'IGNA' })).name, 'Ignacio Test', 'any case');
  assert.equal((await floats.linkView(env, { t: a.token })).name, 'Ignacio Test', 'the long link still works');

  await assert.rejects(floats.setLink(env, { personId: b.personId, slug: 'igna' }), /somebody else/);
  await assert.rejects(floats.setLink(env, { personId: b.personId, slug: 'no/way' }), /letters, numbers or dashes/);
  const changed = await floats.setLink(env, { personId: a.personId, slug: 'Nacho K' });
  assert.equal(changed.slug, 'nacho-k');
  await assert.rejects(floats.linkView(env, { s: 'igna' }), /no longer in use/, 'the old short link stops');
  await assert.rejects(floats.linkView(env, { t: a.token }), /no longer in use/, 'and the old long one');
  assert.equal((await floats.linkView(env, { s: 'nacho-k' })).name, 'Ignacio Test');

  // Somebody added before short links gets one the first time they are opened.
  await env.DB.prepare('UPDATE float_person SET slug = NULL WHERE id = ?1').bind(b.personId).run();
  assert.equal((await floats.detail(env, b.personId)).person.slug, 'igna');
});

test('/float/igna opens the float page, even when the files answer /float.html with a redirect', async () => {
  const { default: insight } = await import('../src/index.js');
  const asked = [];
  const ASSETS = { fetch: async (req) => {
    const path = new URL(req.url).pathname;
    asked.push(path);
    if (path === '/float.html') return new Response(null, { status: 307, headers: { Location: '/float' } });
    if (path === '/float') return new Response('<title>float</title>', { headers: { 'Content-Type': 'text/html' } });
    return new Response('index');
  } };
  const res = await insight.fetch(new Request('https://insight.example.test/float/igna'), { ASSETS }, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /float/);
  assert.deepEqual(asked, ['/float.html', '/float']);
});
