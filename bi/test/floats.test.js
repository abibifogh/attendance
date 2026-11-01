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
    // The same receipt sent by two people: "tonic#2" reads as "tonic", in another file.
    return { response: JSON.stringify(READS[key] || READS[key.split('#')[0]] || READS.dark) };
  },
};

function odoo() {
  const made = [];
  const pos = [];
  const fetchImpl = async (url, init) => {
    const [, model, method] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    if (model === 'res.partner') return Response.json([{ id: 11, name: 'A Fuel Station' }, { id: 12, name: 'A Hardware Shop' }, { id: 13, name: 'A Drinks Depot' }]);
    if (model === 'product.product') return Response.json([{ id: 21, name: 'Fuel', display_name: 'Fuel' }, { id: 22, name: 'Padlock', display_name: 'Padlock' }, { id: 23, name: 'Tonic water', display_name: 'Tonic water' }]);
    if (model === 'purchase.order' && method === 'create') {
      const vals = body.vals_list[0];
      const id = 100 + made.length;
      made.push(vals);
      pos.push({ id, name: `P0${2530 + made.length}`, partner_id: [vals.partner_id, 'x'], amount_total: vals.order_line[0][2].price_unit, state: 'draft', date_order: vals.date_order, origin: vals.origin });
      return Response.json([id]);
    }
    if (model === 'purchase.order' && ['message_post', 'activity_schedule'].includes(method)) return Response.json([1]);
    if (model === 'purchase.order' && method === 'button_cancel') {
      for (const p of pos) if (body.ids.includes(p.id)) p.state = 'cancel';
      return Response.json(true);
    }
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
  await floats.give(env, { personId, amount: '300', day: '2026-10-12', source: 'safe', moveNote: 'For the generator repair' }, OWNER);
  await floats.linkSend(env, { t: token, file: jpg('locks') });
  await floats.giveBack(env, { personId, amount: '80', day: '2026-10-18' }, OWNER);

  const csv = await (await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31', format: 'csv' })).text();
  assert.match(csv, /Float statement: Ama Test \(FLT\/AMA\)/);
  assert.match(csv, /Date,What,Note,Reference/);
  assert.match(csv, /,Held at the start,,,,,,,500\.00/);
  assert.match(csv, /2026-10-12,Given from the safe by Test Owner,For the generator repair,,,,300\.00,,800\.00/);
  assert.match(csv, /2026-10-15,"Receipt: A Hardware Shop, Padlock",,FLT\/AMA\/001,P02531,Being checked,,120\.00,680\.00/);
  assert.match(csv, /2026-10-18,Given back,,,,,,80\.00,600\.00/);
  assert.match(csv, /,Held at the end,,,,,300\.00,200\.00,600\.00/);

  const res = await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31' });
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<h1>Float statement<\/h1><p>Ama Test · <span class="mono">FLT\/AMA<\/span>/);
  assert.match(html, /Download PDF/);
  assert.match(html, /href="\?from=2026-10-01&amp;to=2026-10-31&amp;format=pdf"/, 'its PDF, for the same dates');
  assert.match(html, /<a class="back" href="\/#\/floats"[^>]*>← Back<\/a>/, 'back to Insight’s floats when there is nothing to go back to');
  assert.match(html, /<tr class="month"><td colspan="6">October 2026<\/td><\/tr>/, 'grouped by month');
  assert.match(html, /<b>Given<\/b> · from the safe by Test Owner<div class="note">For the generator repair<\/div>/);
  assert.match(html, /<b>A Hardware Shop<\/b> · Padlock<div class="st checking">Being checked · PO P02531<\/div>/);
  assert.match(html, /href="\?from=2026-10-01&amp;to=2026-10-31&amp;format=csv"/, 'its spreadsheet, for the same dates');

  // As a PDF: one the phone's own viewer opens, shares and prints.
  const file = await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31', format: 'pdf' });
  assert.equal(file.headers.get('Content-Type'), 'application/pdf');
  assert.match(file.headers.get('Content-Disposition'), /^inline; filename="Float statement AMA 2026-10-01 to 2026-10-31\.pdf"$/);
  const text = Buffer.from(await file.arrayBuffer()).toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /\(Float statement\) Tj/);
  assert.match(text, /\(Ama Test \\267 FLT\/AMA\) Tj/, 'the middle dot in Latin-1');
  assert.match(text, /\(GHS 600\.00\) Tj/, 'still with them');
  assert.match(text, /\(A Hardware Shop\) Tj/);
  assert.match(text, /\(Being checked \\267 PO P02531\) Tj/);
  assert.match(text, /\(Page 1 of 1\) Tj/);
  // Every object where the cross-reference table says it is.
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  const offsets = text.slice(xref).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
  assert.ok(offsets.length > 5);
  offsets.forEach((o, i) => assert.equal(text.slice(o, o + String(i + 1).length + 6), `${i + 1} 0 obj`));

  // Just the totals, for their page; and from the very start.
  assert.deepEqual(await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31', format: 'json' }),
    { from: '2026-10-01', to: '2026-10-31', opening: 50000, given: 30000, spent: 12000, back: 8000, closing: 60000, lines: 3 });
  assert.equal((await floats.statement(env, personId, { from: 'start', to: '2026-10-31', format: 'json' })).from, '2026-09-28');
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

test('a note on every amount given: when it is given, or added and changed later, and on the statement', async () => {
  const { env } = await setUp();
  const { personId } = await floats.give(env, { name: 'Kofi Test', note: 'Market runs', amount: '200', day: '2026-10-05' }, OWNER);
  await floats.give(env, { personId, amount: '150', day: '2026-10-09', moveNote: 'Extra for the plumber' }, OWNER);
  await floats.give(env, { personId, amount: '100', day: '2026-10-11' }, OWNER);
  let d = await floats.detail(env, personId);
  const byDay = (day) => d.moves.find((m) => m.day === day);
  assert.equal(byDay('2026-10-05').note, 'Market runs', 'somebody new: what it is for is the note on the first money');
  assert.deepEqual([byDay('2026-10-09').note, byDay('2026-10-09').noteBy], ['Extra for the plumber', 'Test Owner']);
  assert.equal(byDay('2026-10-11').note, null);

  await floats.noteMove(env, { id: byDay('2026-10-11').id, note: 'Asked for by Ama Test, for the gate lock' }, { name: 'Ade Admin' });
  await floats.noteMove(env, { id: byDay('2026-10-05').id, note: '' }, OWNER);
  await assert.rejects(floats.noteMove(env, { id: 9999, note: 'x' }, OWNER), /No such entry/);
  await assert.rejects(floats.noteMove(env, { id: byDay('2026-10-11').id, note: 'x'.repeat(301) }, OWNER), /300 characters/);
  d = await floats.detail(env, personId);
  assert.deepEqual([byDay('2026-10-11').note, byDay('2026-10-11').noteBy], ['Asked for by Ama Test, for the gate lock', 'Ade Admin']);
  assert.deepEqual([byDay('2026-10-05').note, byDay('2026-10-05').noteBy], [null, null], 'emptied: taken off');

  const csv = await (await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31', format: 'csv' })).text();
  assert.match(csv, /2026-10-09,Given from somewhere else by Test Owner,Extra for the plumber,/);
  assert.match(csv, /2026-10-11,Given from somewhere else by Test Owner,"Asked for by Ama Test, for the gate lock",/);
  const html = await (await floats.statement(env, personId, { from: '2026-10-01', to: '2026-10-31' })).text();
  assert.match(html, /<div class="note">Asked for by Ama Test, for the gate lock<\/div>/);

  // They see the same on their own link: each amount with its note, and their statement.
  const { token } = (await floats.detail(env, personId)).person;
  const mine = await floats.linkView(env, { t: token });
  assert.deepEqual(mine.moves.map((m) => [m.day, m.amount, m.note]), [['2026-10-11', 10000, 'Asked for by Ama Test, for the gate lock'], ['2026-10-09', 15000, 'Extra for the plumber'], ['2026-10-05', 20000, null]]);
  const theirs = await (await floats.linkStatement(env, { t: token, from: '2026-10-01', to: '2026-10-31', format: 'csv' })).text();
  assert.equal(theirs, csv, 'the same statement the office downloads');
  await assert.rejects(floats.linkStatement(env, { t: 'not-their-link', from: '2026-10-01', to: '2026-10-31' }), /no longer in use/);
});

test('a PO changed to another total in Odoo: they and an admin are asked, and the new amount counts once accepted', async () => {
  const { env, pos } = await setUp();
  const out = await floats.give(env, { name: 'Kofi Test', amount: '1000', day: '2026-10-12' }, OWNER);
  await floats.linkSend(env, { t: out.token, file: jpg('diesel') });
  // Confirmed in Odoo at 350 where the receipt said 300.
  Object.assign(pos[0], { state: 'purchase', amount_total: 350 });
  let view = await floats.linkView(env, { t: out.token });
  const r = view.sent[0];
  assert.deepEqual([r.status, r.amount, r.change.was, r.change.now, r.change.holder], ['accepted', 30000, 30000, 35000, null], 'the receipt’s amount counts until it is accepted');
  assert.equal(view.held, 70000);
  assert.equal((await floats.list(env)).people[0].toLookAt, 1, 'an admin is asked');

  await assert.rejects(floats.linkAmount(env, { t: out.token, id: r.id, answer: 'maybe' }), /Accept the new amount/);
  await assert.rejects(floats.linkAmount(env, { t: out.token, id: r.id, answer: 'accept' }), /Say why the amount changed/);
  await floats.linkAmount(env, { t: out.token, id: r.id, answer: 'accept', note: 'The shop added a filter after the receipt' });
  view = await floats.linkView(env, { t: out.token });
  assert.deepEqual([view.sent[0].amount, view.held, view.sent[0].change.holderNote], [35000, 65000, 'The shop added a filter after the receipt'], 'accepted by them, with why: the new amount counts');

  // An admin's answer stands over theirs.
  await floats.decideAmount(env, { id: r.id, answer: 'keep' }, OWNER);
  view = await floats.linkView(env, { t: out.token });
  assert.deepEqual([view.sent[0].amount, view.sent[0].change.admin, view.held], [30000, 'keep', 70000]);
  assert.equal((await floats.list(env)).people[0].toLookAt, 0);

  // Changed again in Odoo: asked again.
  pos[0].amount_total = 320;
  view = await floats.linkView(env, { t: out.token });
  assert.deepEqual([view.sent[0].change.now, view.sent[0].change.holder, view.sent[0].change.admin], [32000, null, null]);
  // Put back to the receipt's amount: nothing to ask.
  pos[0].amount_total = 300;
  view = await floats.linkView(env, { t: out.token });
  assert.equal(view.sent[0].change, null);

  // Changed more than 30 days after it was sent: only an admin is asked, and their answer would not count.
  await env.DB.prepare("UPDATE float_receipt SET at = '2026-01-05 09:00:00'").run();
  pos[0].amount_total = 330;
  view = await floats.linkView(env, { t: out.token });
  assert.deepEqual([view.sent[0].change.now, view.sent[0].change.asksHolder], [33000, false]);
  await assert.rejects(floats.linkAmount(env, { t: out.token, id: r.id, answer: 'accept' }), /office decides/);
  assert.equal((await floats.list(env)).people[0].toLookAt, 1, 'the admin is asked');
  await floats.decideAmount(env, { id: r.id, answer: 'accept' }, OWNER);
  assert.equal((await floats.linkView(env, { t: out.token })).sent[0].amount, 33000);
});

test('an item to check on a PO whose total was changed in Odoo: looked at once an admin answers the new total', async () => {
  const { env, pos } = await setUp();
  // The item is not in Odoo: the PO uses the placeholder, and there is something to check.
  READS.polish = { vendor: 'A Hardware Shop', amount: '152', description: '10 Polish', date: '2026-10-27', problem: '' };
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('receipts_product', '{"id":22,"name":"Padlock"}')`).run();
  const out = await floats.give(env, { name: 'Kofi Test', amount: '1000', day: '2026-10-12' }, OWNER);
  await floats.linkSend(env, { t: out.token, file: jpg('polish') });
  let r = (await floats.detail(env, out.personId)).receipts[0];
  assert.equal(r.read, 'check');
  assert.equal(r.toLookAt, true, 'an item to check');
  // Still a draft, changed in Odoo to 150: an admin accepts it, which is looking at it.
  pos[0].amount_total = 150;
  r = (await floats.detail(env, out.personId)).receipts[0];
  assert.equal(r.change.now, 15000);
  assert.equal(r.toLookAt, true);
  await floats.decideAmount(env, { id: r.id, answer: 'accept' }, OWNER);
  r = (await floats.detail(env, out.personId)).receipts[0];
  assert.equal(r.toLookAt, false);
  assert.equal((await floats.list(env)).tiles.toLookAt, 0);
  // Answer taken off: to look at again.
  await floats.decideAmount(env, { id: r.id, answer: '' }, OWNER);
  assert.equal((await floats.detail(env, out.personId)).receipts[0].toLookAt, true);
});

// ------------------------------------------------- where receipts go: the POS --

/** A made-up POS: the three signed paths Insight calls, and the orders it holds. */
function posFake(o) {
  const orders = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (!u.startsWith('https://pos-fn.example.test')) return o.fetchImpl(url, init);
    const path = new URL(u).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, signed: Boolean(init.headers['X-Till-Sig']) });
    if (path === '/floats/po') {
      const had = orders.find((x) => x.key === body.key && x.status !== 'cancelled');
      if (had) return Response.json({ ok: true, ...had });
      const made = { id: `ord${orders.length + 1}`, poNo: `PO-${String(142 + orders.length).padStart(4, '0')}`, status: 'draft', total: body.total, module: body.module, url: 'https://pos.example.test/#/purchase-orders', key: body.key, body };
      orders.push(made);
      return Response.json({ ok: true, ...made });
    }
    if (path === '/floats/po/status') return Response.json({ ok: true, orders: orders.filter((x) => body.ids.includes(x.id)).map(({ id, poNo, status, total, module }) => ({ id, poNo, status, total, module })) });
    if (path === '/floats/po/cancel') {
      const x = orders.find((y) => y.id === body.id);
      if (x.status !== 'draft') return Response.json({ ok: false, error: `${x.poNo} is already being received in the POS: cancel it there first.` }, { status: 409 });
      x.status = 'cancelled';
      return Response.json({ ok: true, status: 'cancelled' });
    }
    return new Response('no', { status: 404 });
  };
  return { orders, calls, fetchImpl };
}

async function withPos() {
  const s = await setUp();
  s.env.SSO_SECRET_POS = 'pos-secret';
  await s.env.DB.prepare(`UPDATE sources SET config = '{"base":"https://pos-fn.example.test/"}', enabled = 1 WHERE id = 'pos'`).run();
  const p = posFake(s);
  globalThis.fetch = p.fetchImpl;
  READS.tonic = {
    vendor: 'A Drinks Depot', amount: '640', description: 'Tonic water', date: '2026-10-31', problem: '',
    lines: [{ name: 'Tonic water 330ml, crate of 24', qty: '4', amount: '640' }],
  };
  return { ...s, pos: p };
}

test('where receipts go: Odoo only to start; ticked by an admin; one place is used, several are chosen, none waits', async () => {
  const { env, made, pos } = await withPos();
  const kofi = await floats.give(env, { name: 'Kofi Test', amount: '500', source: 'safe' }, OWNER);
  const esi = await floats.give(env, { name: 'Esi Test', amount: '3000', source: 'safe' }, OWNER);
  const yaw = await floats.give(env, { name: 'Yaw Test', amount: '800', source: 'safe' }, OWNER);
  const kwame = await floats.give(env, { name: 'Kwame Test', amount: '200', source: 'safe' }, OWNER);

  // Somebody new: Odoo only.
  assert.deepEqual((await floats.list(env)).people.find((p) => p.name === 'Kofi Test').dests, ['odoo']);
  await assert.rejects(floats.saveDests(env, { people: [{ id: esi.personId }] }), /tick where/);
  const saved = await floats.saveDests(env, { people: [
    { id: kofi.personId, dests: ['odoo'] },
    { id: esi.personId, dests: ['craft', 'odoo', 'bar', 'nonsense'] },
    { id: yaw.personId, dests: ['kitchen'] },
    { id: kwame.personId, dests: [] },
  ] });
  assert.equal(saved.changed, 3);
  const people = (await floats.list(env)).people;
  assert.deepEqual(people.find((p) => p.name === 'Esi Test').dests, ['odoo', 'bar', 'craft']);
  assert.deepEqual(people.find((p) => p.name === 'Kwame Test').dests, []);

  // Esi has three places: she must say which; the one she says is used.
  const esiLink = await floats.linkView(env, { t: esi.token });
  assert.deepEqual(esiLink.places.map((x) => x.key), ['odoo', 'bar', 'craft']);
  await assert.rejects(floats.linkSend(env, { t: esi.token, file: jpg('tonic') }), /Say what it was for: The hotel \(Odoo\), Bar, Craft/);
  await assert.rejects(floats.linkSend(env, { t: esi.token, file: jpg('tonic'), dest: 'kitchen' }), /can go to The hotel \(Odoo\) or Bar or Craft/);
  const sent = await floats.linkSend(env, { t: esi.token, file: jpg('tonic'), dest: 'bar' });
  assert.match(sent.said, /GH₵640\.00\. It is being checked\. It goes to the bar, in the POS\./);
  // Not in Odoo; a draft order in the POS for the bar, with what was read, signed.
  assert.equal(made.length, 0);
  assert.equal(pos.orders.length, 1);
  const call = pos.calls.find((c) => c.path === '/floats/po');
  assert.ok(call.signed);
  assert.equal(call.body.module, 'bar');
  assert.equal(call.body.ref, 'FLT/ESI/001');
  assert.equal(call.body.holder, 'Esi Test');
  assert.equal(call.body.supplier, 'A Drinks Depot');
  assert.equal(call.body.total, 64000);
  assert.deepEqual(call.body.lines, [{ name: 'Tonic water 330ml, crate of 24', qty: 4, amount: 64000 }]);
  assert.equal(call.body.receipt.mime, 'image/jpeg');
  assert.equal(call.body.key.startsWith('insight-float:'), true);

  // Yaw: one place, never asked.
  const yawSent = await floats.linkSend(env, { t: yaw.token, file: jpg('tonic#2') });
  assert.match(yawSent.said, /bistro, in the POS/);
  assert.equal(pos.orders[1].module, 'kitchen');
  // Kwame: none ticked, so it waits, and is to look at.
  const kwameSent = await floats.linkSend(env, { t: kwame.token, file: jpg('diesel') });
  assert.match(kwameSent.said, /office will say where it goes/);
  assert.equal(made.length, 0);
  // Kofi: Odoo, as before.
  await floats.linkSend(env, { t: kofi.token, file: jpg('diesel#2') });
  assert.equal(made.length, 1);

  const kw = await floats.detail(env, kwame.personId);
  assert.equal(kw.receipts[0].dest, 'wait');
  assert.equal(kw.receipts[0].toLookAt, true);
  // Nothing ticked: an admin may place it anywhere.
  assert.deepEqual(kw.receipts[0].moves.map((m) => m.key), ['odoo', 'kitchen', 'bar', 'craft']);
  // Counts against what they hold while it waits.
  assert.equal(kw.spent, 30000);

  // Esi's page and Insight say where it went.
  const e = await floats.detail(env, esi.personId);
  assert.equal(e.receipts[0].where, 'POS · Bar');
  assert.deepEqual(e.receipts[0].pos, { id: 'ord1', no: 'PO-0142', status: 'draft', url: 'https://pos.example.test/#/purchase-orders' });
  assert.equal(e.receipts[0].po, null);
  assert.equal(e.receipts[0].toLookAt, false);
  assert.deepEqual(e.receipts[0].moves.map((m) => m.key), ['odoo', 'craft']);
  assert.equal((await floats.linkView(env, { t: esi.token })).sent[0].where, 'Bar, in the POS · PO-0142');
});

test('received in the POS is accepted; cancelled there is refused; a draft can go to Odoo instead, and back', async () => {
  const { env, made, pos } = await withPos();
  const esi = await floats.give(env, { name: 'Esi Test', amount: '3000', source: 'safe' }, OWNER);
  await floats.saveDests(env, { people: [{ id: esi.personId, dests: ['odoo', 'bar', 'craft'] }] });
  await floats.linkSend(env, { t: esi.token, file: jpg('tonic'), dest: 'bar' });
  await floats.linkSend(env, { t: esi.token, file: jpg('locks'), dest: 'craft' });
  let d = await floats.detail(env, esi.personId);
  const [locks, tonic] = d.receipts;

  // Wrong place: the bar's draft is cancelled in the POS and a draft PO made in Odoo, with her reference.
  await assert.rejects(floats.moveReceipt(env, { id: tonic.id, dest: 'bar' }, OWNER), /already there/);
  await assert.rejects(floats.moveReceipt(env, { id: tonic.id, dest: 'kitchen' }, OWNER), /may go to The hotel \(Odoo\) or Bar or Craft/);
  const moved = await floats.moveReceipt(env, { id: tonic.id, dest: 'odoo' }, OWNER);
  assert.equal(moved.dest, 'odoo');
  assert.equal(pos.orders[0].status, 'cancelled');
  assert.equal(made.length, 1);
  assert.equal(made[0].partner_ref, 'FLT/ESI/001');
  d = await floats.detail(env, esi.personId);
  const nowOdoo = d.receipts.find((r) => r.id === tonic.id);
  assert.equal(nowOdoo.where, 'Odoo');
  assert.equal(nowOdoo.pos, null);
  assert.ok(nowOdoo.po.name);

  // And back to the bar while the Odoo PO is a draft: cancelled there, a new draft order in the POS.
  const back = await floats.moveReceipt(env, { id: tonic.id, dest: 'bar' }, OWNER);
  assert.equal(back.dest, 'bar');
  assert.equal(pos.orders.length, 3);
  assert.equal(pos.orders[2].module, 'bar');
  d = await floats.detail(env, esi.personId);
  assert.equal(d.receipts.find((r) => r.id === tonic.id).po, null);

  // The craft shop received the padlock: accepted. The bar cancelled the tonic: refused, back on what she holds.
  pos.orders[1].status = 'received';
  pos.orders[2].status = 'cancelled';
  d = await floats.detail(env, esi.personId);
  assert.equal(d.receipts.find((r) => r.id === locks.id).status, 'accepted');
  assert.equal(d.receipts.find((r) => r.id === locks.id).decidedBy, 'POS');
  const refused = d.receipts.find((r) => r.id === tonic.id);
  assert.equal(refused.status, 'refused');
  assert.match(refused.reason, /PO-0144 was cancelled in the POS/);
  assert.equal(d.spent, 12000);
  // Accepted: nowhere else to send it.
  assert.deepEqual(d.receipts.find((r) => r.id === locks.id).moves, []);
  await assert.rejects(floats.moveReceipt(env, { id: locks.id, dest: 'odoo' }, OWNER), /already accepted/);
});

test('the POS not answering, or a receipt that could not be read: said on the receipt, then typed in and sent', async () => {
  const { env, pos } = await withPos();
  const yaw = await floats.give(env, { name: 'Yaw Test', amount: '800', source: 'safe' }, OWNER);
  await floats.saveDests(env, { people: [{ id: yaw.personId, dests: ['kitchen'] }] });
  // Too dark to read: kept, nothing sent to the POS, to look at.
  await floats.linkSend(env, { t: yaw.token, file: jpg('dark') });
  let r = (await floats.detail(env, yaw.personId)).receipts[0];
  assert.equal(pos.orders.length, 0);
  assert.equal(r.toLookAt, true);
  assert.match(r.posProblem, /could not be read/);
  assert.deepEqual(r.moves.map((m) => m.key), ['kitchen']);
  // Typed in by an admin: sent to the bistro as one line.
  await assert.rejects(floats.moveReceipt(env, { id: r.id, dest: 'kitchen', typed: { amount: '0' } }, OWNER), /above nothing/);
  const out = await floats.moveReceipt(env, { id: r.id, dest: 'kitchen', typed: { vendor: 'A Market Stall', amount: '85', description: 'Tomatoes' } }, OWNER);
  assert.equal(out.pos.no, 'PO-0142');
  assert.deepEqual(pos.orders[0].body.lines, [{ name: 'Tomatoes', qty: 1, amount: 8500 }]);
  r = (await floats.detail(env, yaw.personId)).receipts[0];
  assert.equal(r.amount, 8500);
  assert.equal(r.toLookAt, false);

  // The POS down: the receipt says so, and Try again (the same place) sends it once it answers.
  const down = pos.fetchImpl;
  globalThis.fetch = async (url, init) => (String(url).includes('pos-fn') ? Promise.reject(new Error('offline')) : down(url, init));
  await floats.linkSend(env, { t: yaw.token, file: jpg('tonic') });
  r = (await floats.detail(env, yaw.personId)).receipts[0];
  assert.match(r.posProblem, /The POS did not take it: The POS could not be reached/);
  assert.equal(r.toLookAt, true);
  globalThis.fetch = down;
  const again = await floats.moveReceipt(env, { id: r.id, dest: 'kitchen' }, OWNER);
  assert.equal(again.pos.no, 'PO-0143');
  assert.equal((await floats.detail(env, yaw.personId)).receipts[0].posProblem, null);
});
