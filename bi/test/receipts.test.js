import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as receipts from '../src/routes/receipts.js';
import { signLink } from '../src/lib/link.js';

/**
 * Receipts into draft POs, several at once or by email. A made-up Odoo, a
 * made-up reader and a stand-in HIVE that keeps the replies. Everything is
 * invented.
 */

const OWNER = { name: 'Test Owner', email: 'owner@example.test', isOwner: true, access: [] };
const today = new Date().toISOString().slice(0, 10);
const b64 = (s) => Buffer.from(s).toString('base64');
const jpg = (s) => `data:image/jpeg;base64,${b64(s)}`;

function odoo() {
  const made = { po: [], attachments: [], notes: [], todos: [] };
  const vendors = [{ id: 11, name: 'A Fuel Station' }, { id: 12, name: 'A Hardware Shop Ltd' }, { id: 90, name: 'Vendor to confirm' }];
  const products = [{ id: 21, name: 'Fuel', display_name: 'Fuel' }, { id: 22, name: 'Padlock', display_name: 'Padlock' }, { id: 99, name: 'Item to classify', display_name: 'Item to classify' }];
  const pos = [{ id: 80, name: 'P02500', partner_id: [12, 'A Hardware Shop Ltd'], amount_total: 145, state: 'draft', date_order: `${today} 09:00:00`, origin: '' }];
  const fetchImpl = async (url, init) => {
    const [, model, method] = String(url).match(/\/json\/2\/([^/]+)\/([^/]+)$/);
    const body = JSON.parse(init.body);
    if (model === 'res.partner') return Response.json(vendors);
    if (model === 'product.product') return Response.json(products);
    if (model === 'res.users') return Response.json([{ id: 5, name: 'Ewurabena Test', login: 'e@example.test' }]);
    if (model === 'purchase.order' && method === 'create') {
      const vals = body.vals_list[0];
      const id = 100 + made.po.length;
      made.po.push(vals);
      pos.push({ id, name: `P0${2531 + made.po.length - 1}`, partner_id: [vals.partner_id, 'x'], amount_total: vals.order_line[0][2].price_unit, state: 'draft', date_order: vals.date_order, origin: vals.origin });
      return Response.json([id]);
    }
    if (model === 'purchase.order' && method === 'message_post') { made.notes.push(body); return Response.json([1]); }
    if (model === 'purchase.order' && method === 'activity_schedule') { made.todos.push(body); return Response.json([1]); }
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

/** The reader: what each picture "says", by its content. */
const READS = {
  fuel: { vendor: 'A Fuel Station', amount: '800', description: 'Fuel', date: '2026-10-16', problem: '' },
  gas: { vendor: 'Kofi Gas Ltd', amount: '420', description: 'Gas refill', date: '2026-10-17', problem: '' },
  hinge: { vendor: 'A Hardware Shop', amount: '145', description: 'Padlock', date: today, problem: '' },
  dark: { vendor: '', amount: '', description: '', date: '', problem: 'too dark' },
  diesel: { vendor: 'A Fuel Station', amount: '300', description: 'Diesel Excellium', date: '2026-10-12', problem: '' },
  pulley: { vendor: 'A Hardware Shop', amount: '50', description: '3 Grooves Pulley', date: '2026-10-10', problem: '' },
};
const ai = {
  run: async (model, input) => {
    const c = input.messages[0].content;
    // Picking the nearest product: diesel is plainly fuel; a pulley might be a padlock, the reader is not sure.
    if (typeof c === 'string' && c.includes('Which of the products below')) {
      const number = (name) => Number((c.match(new RegExp(`\\n(\\d+)\\. ${name}(\\n|$)`)) || [])[1] || 0);
      if (/Diesel/.test(c)) return { response: JSON.stringify({ number: number('Fuel'), sure: true }) };
      if (/Pulley/.test(c)) return { response: JSON.stringify({ number: number('Padlock'), sure: false }) };
      return { response: JSON.stringify({ number: 0, sure: false }) };
    }
    const url = Array.isArray(c) ? c[1].image_url.url : '';
    const key = Buffer.from(url.split(',')[1] || '', 'base64').toString();
    return { response: JSON.stringify(READS[key] || READS.dark) };
  },
};

async function setUp() {
  const { db, raw } = freshDb();
  const o = odoo();
  const mails = [];
  const env = {
    DB: db, ODOO_KEY_ODOO: 'k', AI: ai, SSO_SECRET_ATTENDANCE: 'secret',
    HIVE: { fetch: async (req) => { mails.push(JSON.parse(await req.text())); return Response.json({ ok: true }); } },
  };
  await db.prepare(`UPDATE sources SET config = '{"base":"https://odoo.example.test"}', enabled = 1 WHERE id = 'odoo'`).run();
  // fetch for the Odoo connector, which takes it from the source options.
  globalThis.fetch = o.fetchImpl;
  return { env, raw, ...o, mails };
}

test('a receipt with everything in Odoo becomes a complete draft, receipt attached, what was read noted', async () => {
  const { env, made, raw } = await setUp();
  const { receipt } = await receipts.upload(env, { file: jpg('fuel'), name: 'IMG_2041.jpg' }, OWNER);
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.po.name, 'P02531');
  assert.deepEqual([made.po[0].partner_id, made.po[0].order_line[0][2].product_id, made.po[0].order_line[0][2].price_unit], [11, 21, 800]);
  assert.match(made.po[0].origin, /receipt by upload · Test Owner/);
  assert.equal(made.attachments[0].name, 'Receipt P02531.jpg');
  assert.match(made.notes[0].body, /vendor “A Fuel Station”, total GH₵800\.00/);
  assert.equal(made.todos.length, 0, 'complete: no To-Do');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM receipt_file').get().n, 0, 'attached in Odoo: not kept here');
  assert.equal(raw.prepare("SELECT drawer_ok FROM po_created WHERE name = 'P02531'").get().drawer_ok, null, 'not from a drawer unless allowed');

  // The same picture again: said, and no second PO.
  const again = (await receipts.upload(env, { file: jpg('fuel') }, OWNER)).receipt;
  assert.equal(again.status, 'duplicate');
  assert.match(again.problem, /P02531/);
  assert.equal(made.po.length, 1);
});

test('a vendor not in Odoo: no PO without a placeholder; with one, a draft to check and a To-Do', async () => {
  const { env, made } = await setUp();
  const first = (await receipts.upload(env, { file: jpg('gas') }, OWNER)).receipt;
  assert.equal(first.status, 'unread');
  assert.match(first.problem, /“Kofi Gas Ltd”, which is not in Odoo.*no placeholder vendor is chosen/);
  assert.equal(first.hasFile, true, 'kept, to fill in');

  await receipts.saveSettings(env, { vendor: { id: 90, name: 'Vendor to confirm' }, product: { id: 99, name: 'Item to classify' }, todoUser: { id: 5, name: 'Ewurabena Test' } });
  await receipts.dismiss(env, { id: first.id }, OWNER);
  // A slightly different photo of the same receipt.
  READS['gas 2'] = READS.gas;
  const r = (await receipts.upload(env, { file: jpg('gas 2') }, OWNER)).receipt;
  assert.equal(r.status, 'check');
  assert.equal(r.vendorName, 'Vendor to confirm');
  assert.equal(r.productName, 'Item to classify');
  assert.equal(made.po[0].partner_id, 90);
  assert.equal(made.todos[0].user_id, 5);
  assert.match(made.todos[0].note, /Kofi Gas Ltd/);
  assert.equal(r.todo, true);
});

test('one already in Odoo for that vendor, day and amount is not made twice; one that cannot be read waits to be filled in', async () => {
  const { env, made, raw } = await setUp();
  const dup = (await receipts.upload(env, { file: jpg('hinge') }, OWNER)).receipt;
  assert.equal(dup.status, 'duplicate');
  assert.match(dup.problem, /P02500 is already in Odoo/);
  const dark = (await receipts.upload(env, { file: jpg('dark') }, OWNER)).receipt;
  assert.equal(dark.status, 'unread');
  assert.match(dark.problem, /too dark/);
  assert.equal(made.po.length, 0);
  const kept = await receipts.receiptFile(env, dark.id);
  assert.equal(kept.file, jpg('dark'));
  // Filled in by hand: it is that PO now, and the file is let go.
  await receipts.filled(env, dark.id, { id: 7, name: 'P02600', url: null, vendor: 'A Fuel Station', amount: 5000, date: today, description: 'Fuel' }, OWNER);
  const row = (await receipts.list(env)).items.find((x) => x.id === dark.id);
  assert.deepEqual([row.status, row.po.name, row.hasFile], ['filled', 'P02600', false]);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM receipt_file').get().n, 0);
  await assert.rejects(receipts.upload(env, { file: 'data:text/plain;base64,AA==' }, OWNER), /photo or a PDF/);
});

const emailOf = ({ from = 'owner@example.test', auth = 'mx.example; dkim=pass; spf=pass; dmarc=pass', files = ['fuel', 'dark'] } = {}) => ({
  from,
  raw: new TextEncoder().encode([
    `From: Test Owner <${from}>`, 'Subject: Fwd: fuel and the rest', `Authentication-Results: ${auth}`,
    'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/plain', '', 'fuel for the generator', '',
    ...files.flatMap((f, i) => ['--b', `Content-Type: image/jpeg; name="IMG_${i}.jpg"`, 'Content-Disposition: attachment', 'Content-Transfer-Encoding: base64', '', b64(f)]),
    '--b--', '',
  ].join('\r\n')),
});

test('by email: only from the list, each attachment a receipt, and a reply saying what became of each', async () => {
  const { env, made, mails, raw } = await setUp();
  // Nobody on the list yet: ignored, and logged so it can be seen.
  assert.equal((await receipts.fromEmail(env, emailOf())).why, 'sender');
  await receipts.saveSettings(env, { senders: 'Owner@Example.test, not-an-address' });
  assert.deepEqual((await receipts.receiptSettings(env)).senders, ['owner@example.test']);
  // On the list, but the receiving server says it is not really from there.
  assert.equal((await receipts.fromEmail(env, emailOf({ auth: 'mx.example; spf=fail; dmarc=fail' }))).why, 'checks');
  assert.equal(made.po.length, 0);

  const out = await receipts.fromEmail(env, emailOf());
  assert.deepEqual(out.results.map((x) => x.status), ['complete', 'unread']);
  assert.equal(out.results[0].hint, 'fuel for the generator');
  assert.equal(out.results[0].by, 'Test Owner');
  assert.match(made.po[0].origin, /receipt by email/);
  const reply = mails.at(-1);
  assert.equal(reply.to, 'owner@example.test');
  assert.equal(reply.subject, 'Re: Fwd: fuel and the rest');
  assert.match(reply.text, /2 receipts read:\n✓ P02531 · A Fuel Station · GH₵800\.00 · 2026-10-16\n✕ IMG_1\.jpg: no PO\. Could not be read: too dark\. It is kept/);
  assert.deepEqual(raw.prepare('SELECT outcome FROM receipt_mail ORDER BY id').all().map((r) => r.outcome), ['ignored', 'ignored', 'read']);
});

test('the reply is signed for HIVE like every other message', async () => {
  const { env } = await setUp();
  let ok = false;
  env.HIVE = { fetch: async (req) => { const text = await req.text(); const want = await signLink('secret', '/api/link/mail', text, Number(req.headers.get('X-Till-At'))); ok = want['X-Till-Sig'] === req.headers.get('X-Till-Sig'); return Response.json({ ok: true }); } };
  await receipts.saveSettings(env, { senders: 'owner@example.test' });
  await receipts.fromEmail(env, emailOf({ files: [] }));
  assert.equal(ok, true);
});

test('no placeholder yet: kept; chosen, Try again makes it, with the receipt’s words and the seller on the line', async () => {
  const { env, made, raw } = await setUp();
  const first = (await receipts.upload(env, { file: jpg('gas') }, OWNER)).receipt;
  assert.equal(first.status, 'unread');
  assert.match(first.problem, /^The vendor was read as “Kofi Gas Ltd”.*then Try again\.$/);
  await receipts.saveSettings(env, { vendor: { id: 90, name: 'Vendor to confirm' }, product: { id: 99, name: 'Item to classify' } });
  const again = (await receipts.retry(env, { id: first.id }, OWNER)).receipt;
  assert.equal(again.status, 'check');
  assert.equal(again.id, first.id, 'the same receipt, not a second one');
  assert.equal(made.po[0].order_line[0][2].name, 'Gas refill (from Kofi Gas Ltd)');
  assert.equal(made.po[0].order_line[0][2].product_id, 99);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM receipt_file').get().n, 0, 'a PO made: the file goes');
  await assert.rejects(receipts.retry(env, { id: first.id }, OWNER), /has a PO already/);
  assert.match(receipts.resultLine({ ...first, name: 'IMG_9.jpg' }), /^✕ IMG_9\.jpg: no PO\. The vendor/);
});

test('words do not match: the reader picks the nearest product, and an unsure pick is left to check', async () => {
  const { env, made } = await setUp();
  await receipts.saveSettings(env, { vendor: { id: 90, name: 'Vendor to confirm' }, product: { id: 99, name: 'Item to classify' }, todoUser: { id: 5, name: 'Ewurabena Test' } });
  const diesel = (await receipts.upload(env, { file: jpg('diesel') }, OWNER)).receipt;
  assert.deepEqual([diesel.status, diesel.productName, diesel.itemBy], ['complete', 'Fuel', 'reader']);
  assert.equal(made.po[0].order_line[0][2].product_id, 21, 'on Fuel, not the placeholder');
  assert.equal(made.po[0].order_line[0][2].name, 'Diesel Excellium', 'the receipt’s own words as the label');
  assert.match(made.notes[0].body, /picked by the reader as the nearest in Odoo: Fuel/);
  assert.equal(made.todos.length, 0);

  const pulley = (await receipts.upload(env, { file: jpg('pulley') }, OWNER)).receipt;
  assert.deepEqual([pulley.status, pulley.productName, pulley.itemBy], ['check', 'Padlock', 'reader']);
  assert.match(pulley.problem, /the reader put “3 Grooves Pulley” on “Padlock”, but was not sure/);
  assert.equal(made.todos.length, 1, 'the accountant is asked to check it');

  // Nothing near enough: the placeholder, as before.
  const gas = (await receipts.upload(env, { file: jpg('gas') }, OWNER)).receipt;
  assert.deepEqual([gas.productName, gas.itemBy], ['Item to classify', null]);
});
