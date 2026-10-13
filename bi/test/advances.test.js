import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import * as advances from '../src/routes/advances.js';
import { verifyForm, verifyLink } from '../src/lib/link.js';
import { AREAS, saveSettings } from '../src/routes/till.js';
import worker from '../src/index.js';

/**
 * Advances: cash given out before a purchase, the expense form, and what is
 * said when a PO's final price is not what the drawer paid.
 *
 * Everything is invented: a made-up Odoo, made-up people and POs.
 */

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const SUP = { id: 21, name: 'Abena Sup', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const LINK = 'link-secret-for-the-test';
const FORM = 'form-secret-for-the-test';

async function hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Odoo, and HIVE's end of the link, behind one fetch. */
function world() {
  const orders = new Map([
    ['P00420', { id: 1, name: 'P00420', partner_id: [1, 'A Hardware Shop'], amount_total: 65, state: 'draft', date_order: '2026-10-01 09:00:00' }],
    ['P00412', { id: 2, name: 'P00412', partner_id: [2, 'A Produce Seller'], amount_total: 44, state: 'purchase', date_order: '2026-09-20 09:00:00' }],
  ]);
  const hive = [];
  const fetchImpl = async (input, init) => {
    if (input instanceof Request) {
      const url = new URL(input.url);
      const text = await input.text();
      assert.ok(await verifyLink(LINK, { at: input.headers.get('X-Till-At'), sig: input.headers.get('X-Till-Sig'), path: url.pathname, bodyText: text }));
      hive.push([url.pathname, JSON.parse(text)]);
      return Response.json({ ok: true, sentTo: 'Kofi Test' });
    }
    const body = JSON.parse(init.body);
    let rows = [...orders.values()];
    for (const [field, op, value] of body.domain || []) if (op === 'in') rows = rows.filter((r) => value.includes(r[field]));
    return Response.json(rows);
  };
  return { orders, hive, fetchImpl };
}

async function setUp({ form = true } = {}) {
  const { db, raw } = freshDb();
  const hive = freshDb('../migrations');
  const env = { DB: db, ATT_DB: hive.db, ODOO_KEY_ODOO: 'k', SSO_SECRET_ATTENDANCE: LINK, ...(form ? { EXPENSE_FORM_SECRET: FORM } : {}) };
  await env.DB.prepare(`UPDATE sources SET config = '{"base":"https://odoo.example.test"}', enabled = 1 WHERE id = 'odoo'`).run();
  raw.exec(`INSERT INTO accounts (id, email, name) VALUES (21, 'a@example.test', 'Abena Sup');
    INSERT INTO account_access (account_id, system_id, role) VALUES (21, 'insight', 'supervisor');
    INSERT INTO till_notify (hive_user_id, name, push, email, on_closed, on_answer, on_approval) VALUES (3, 'Boss', 1, 1, 1, 1, 1);`);
  hive.raw.exec("DELETE FROM users; INSERT INTO users (id, name, role, active) VALUES (7, 'Ama Test', 'staff', 1), (3, 'Boss', 'admin', 1);");
  const paid = (po, { day, slot = 'morning', amount, kind = 'claim', advance = 0 }) => hive.raw.prepare(
    `INSERT INTO till_po (po, kind, user_id, day, slot, paid, total, vendor, state, via, advance) VALUES (?, ?, 7, ?, ?, ?, ?, NULL, 'draft', 'report', ?)`,
  ).run(po, kind, day, slot, amount, amount, advance);
  return { env, raw, hive, paid };
}

test('AREAS has Advances, see or see and act', () => {
  assert.deepEqual(AREAS.find((a) => a.key === 'advances'), { key: 'advances', max: 2 });
});

test('the expense form: only its own script, signed and recent', async () => {
  const body = JSON.stringify({ responseId: 'r1' });
  const at = String(Date.now());
  const sig = await hex(FORM, `expense-form\n${at}\n${body}`);
  assert.equal(await verifyForm(FORM, { at, sig, bodyText: body }), true);
  assert.equal(await verifyForm(FORM, { at, sig: sig.toUpperCase(), bodyText: body }), true, 'hex in either case');
  assert.equal(await verifyForm('wrong', { at, sig, bodyText: body }), false);
  assert.equal(await verifyForm(FORM, { at, sig, bodyText: `${body} ` }), false, 'changed on the way');
  const old = String(Date.now() - 6 * 60_000);
  assert.equal(await verifyForm(FORM, { at: old, sig: await hex(FORM, `expense-form\n${old}\n${body}`), bodyText: body }), false, 'too old');
  assert.equal(await verifyForm(LINK, { at, sig: await hex(LINK, `till-link\n${at}\n/x\n${body}`), bodyText: body }), false, 'a link signature is not a form one');
});

test('responses are kept once each, PO numbers tidied, amount and TnT apart', async () => {
  const { env } = await setUp();
  await advances.ingestForm(env, { responses: [
    { responseId: 'r1', po: 'po 420', amount: 'GH₵ 60.00', tnt: '5', by: 'Ama Test', submittedAt: '2026-10-02 10:00' },
    { responseId: 'r2', po: 'P00412', amount: '44', tnt: '' },
  ] });
  await advances.ingestForm(env, { responseId: 'r1', po: '420', amount: '60', tnt: '5' });
  const rows = await env.DB.prepare('SELECT response_id, po, amount, tnt FROM expense_report ORDER BY response_id').all();
  assert.deepEqual(rows.results.map((r) => ({ ...r })), [
    { response_id: 'r1', po: 'P00420', amount: 6000, tnt: 500 },
    { response_id: 'r2', po: 'P00412', amount: 4400, tnt: 0 },
  ]);
  const got = await advances.reportedFor(env, ['P00420']);
  assert.deepEqual(got.get('P00420'), { amount: 6000, tnt: 500, total: 6500, count: 1 });
  await assert.rejects(advances.ingestForm(env, { responses: [] }), /between 1 and 500/);
});

test('an advance, from requisition to settled, and the price difference after', async () => {
  const { env, paid } = await setUp();
  const { orders, fetchImpl } = world();
  paid('P00420', { day: '2026-10-08', amount: 6500, advance: 1 });
  const one = async (on = '2026-10-08') => (await advances.gatherAdvances(env, { fetchImpl, on })).items.find((x) => x.po === 'P00420');

  let x = await one();
  assert.deepEqual([x.status, x.advanced, x.by, x.vendor, x.overdue], ['approve', 6500, 'Ama Test', 'A Hardware Shop', false]);
  assert.deepEqual(x.due, { day: '2026-10-08', slot: 'afternoon' });
  assert.equal((await one('2026-10-09')).overdue, true, 'the next shift has come and gone');

  orders.get('P00420').state = 'purchase';
  assert.equal((await one()).status, 'report', 'approved, not on the form');
  await advances.ingestForm(env, { responseId: 'r1', po: 'P00420', amount: '60', tnt: '5' });
  x = await one();
  assert.deepEqual([x.status, x.settled, x.diff], ['settled', true, 0]);

  // Bought for less: GH₵ 5 comes back.
  orders.get('P00420').amount_total = 60;
  await advances.ingestForm(env, { responseId: 'r1', po: 'P00420', amount: '55', tnt: '5' });
  x = await one();
  assert.deepEqual([x.status, x.diff, x.old], ['refund', -500, false]);
  orders.get('P00420').amount_total = 70;
  x = await one();
  assert.deepEqual([x.status, x.diff], ['deficit', 500]);

  // Without the form connected, approved counts as reported.
  delete env.EXPENSE_FORM_SECRET;
  await env.DB.prepare('DELETE FROM expense_report').run();
  orders.get('P00420').amount_total = 65;
  assert.equal((await one()).status, 'settled');
});

test('who sees Advances, and who may give more time or close one', async () => {
  const { env, paid } = await setUp();
  const { fetchImpl } = world();
  paid('P00420', { day: '2026-10-08', amount: 6500, advance: 1 });
  await assert.rejects(advances.advancesView(env, SUP, { fetchImpl }), /not been shared/);
  await saveSettings(env, { access: { accountId: 21, area: 'advances', level: 1 } }, OWNER);
  const seen = await advances.advancesView(env, SUP, { fetchImpl });
  assert.deepEqual([seen.canAct, seen.items.length, seen.outstanding], [false, 1, 6500]);
  await assert.rejects(advances.decide(env, { po: 'P00420', action: 'close', reason: 'x' }, SUP), /look at this, not change it/);

  await saveSettings(env, { access: { accountId: 21, area: 'advances', level: 2 } }, OWNER);
  assert.equal((await advances.advancesView(env, SUP, { fetchImpl })).canAct, true);
  await assert.rejects(advances.decide(env, { po: '420', action: 'more', until: '2020-01-01' }, SUP), /from today on/);
  await advances.decide(env, { po: '420', action: 'more', until: '2999-01-01', reason: 'Supplier late' }, SUP);
  let x = (await advances.gatherAdvances(env, { fetchImpl, on: '2026-10-20' })).items[0];
  assert.deepEqual([x.decision.until, x.decision.by, x.overdue], ['2999-01-01', 'Abena Sup', false]);
  await assert.rejects(advances.decide(env, { po: '420', action: 'close' }, SUP), /Reason/);
  await advances.decide(env, { po: '420', action: 'close', reason: 'Cash returned in full' }, SUP);
  x = (await advances.gatherAdvances(env, { fetchImpl, on: '2026-10-20' })).items[0];
  assert.equal(x.status, 'closed');
  await advances.decide(env, { po: '420', action: 'reopen' }, OWNER);
  assert.equal((await advances.gatherAdvances(env, { fetchImpl, on: '2026-10-20' })).items[0].status, 'approve');
});

test('a refund is told once to the next shift; old differences only to the admins; deficits never to the desk', async () => {
  const { env, paid } = await setUp();
  const { orders, hive, fetchImpl } = world();
  orders.get('P00420').state = 'purchase';
  orders.get('P00420').amount_total = 60;
  paid('P00420', { day: '2026-10-08', amount: 6500, advance: 1 });
  await advances.ingestForm(env, { responseId: 'r1', po: 'P00420', amount: '55', tnt: '5' });
  // Paid in full long ago, then the price went up.
  orders.get('P00412').amount_total = 50;
  paid('P00412', { day: '2026-09-20', amount: 4400 });
  await advances.ingestForm(env, { responseId: 'r2', po: 'P00412', amount: '50', tnt: '0' });
  // A PO on the form that no drawer paid: never chased.
  await advances.ingestForm(env, { responseId: 'r3', po: 'P00999', amount: '10', tnt: '0' });

  const out = await advances.tellDifferences(env, { fetchImpl, on: '2026-10-09' });
  assert.equal(out.told, 2);
  const expect = hive.find(([p]) => p === '/api/link/till/expect');
  assert.deepEqual([expect[1].po, expect[1].amount, expect[1].paid, expect[1].total, expect[1].by], ['P00420', 500, 6500, 6000, 'Ama Test']);
  assert.deepEqual(expect[1].reported, { amount: 5500, tnt: 500 });
  const tell = hive.find(([p]) => p === '/api/link/till/tell');
  assert.equal(tell[1].kind, 'till.approval');
  assert.deepEqual(tell[1].recipients.map((r) => r.userId), [3]);
  assert.match(tell[1].title, /P00412: deficit of GH₵ 6\.00/);

  hive.length = 0;
  assert.equal((await advances.tellDifferences(env, { fetchImpl, on: '2026-10-09' })).told, 0, 'said once');
  assert.equal(hive.length, 0);

  // A recent deficit is the desk's to record on Close shift, not to be told about.
  orders.get('P00420').amount_total = 70;
  await advances.ingestForm(env, { responseId: 'r1', po: 'P00420', amount: '65', tnt: '5' });
  await advances.tellDifferences(env, { fetchImpl, on: '2026-10-09' });
  assert.equal(hive.length, 0);

  const view = await advances.advancesView(env, OWNER, { fetchImpl });
  assert.deepEqual(view.elsewhere.list.map((e) => e.po), ['P00999']);
  assert.equal(view.canClear, true);

  // An admin clears it once looked at; a supervisor may not; Undo puts it back.
  await assert.rejects(advances.clearElsewhere(env, { pos: ['P00999'] }, SUP), /Only an admin/);
  await advances.clearElsewhere(env, { pos: ['999'] }, OWNER);
  assert.deepEqual((await advances.advancesView(env, OWNER, { fetchImpl })).elsewhere, { list: [], count: 0 });
  await advances.clearElsewhere(env, { pos: ['P00999'], restore: true }, OWNER);
  assert.equal((await advances.advancesView(env, OWNER, { fetchImpl })).elsewhere.count, 1);
});

test('the form endpoint takes only what its script signed, and nothing until the secret is set', async () => {
  const { env } = await setUp();
  const post = async (body, { secret = FORM, at = String(Date.now()), on = env } = {}) => worker.fetch(new Request('https://insight.test/api/link/expense-form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Form-At': at, 'X-Form-Sig': await hex(secret, `expense-form\n${at}\n${body}`) },
    body,
  }), on, { waitUntil: () => {} });
  const body = JSON.stringify({ responses: [{ responseId: 'r9', po: '412', amount: '44', tnt: '0' }] });
  assert.equal((await post(body, { secret: 'wrong' })).status, 401);
  const ok = await post(body);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, saved: 1 });
  const off = { ...env };
  delete off.EXPENSE_FORM_SECRET;
  assert.equal((await post(body, { on: off })).status, 503);
});

test('PO numbers read however they were typed on the form, and TnT the way the form says', async () => {
  assert.deepEqual(advances.formPos('4123'), ['P04123']);
  assert.deepEqual(advances.formPos('4123.0'), ['P04123']);
  assert.deepEqual(advances.formPos('p04123'), ['P04123']);
  assert.deepEqual(advances.formPos('PO4123'), ['P04123']);
  assert.deepEqual(advances.formPos('POO123'), ['P00123']);
  assert.deepEqual(advances.formPos('P004123'), ['P04123']);
  assert.deepEqual(advances.formPos('P04123`'), ['P04123']);
  assert.deepEqual(advances.formPos('4123 & 4124'), ['P04123', 'P04124']);
  for (const none of ['N/A', 'NA', 'Some Name', 'Bolt (Some Name)', 'mtn', '24123456', '', null]) assert.deepEqual(advances.formPos(none), [], String(none));
  assert.equal(advances.toMinor('row 12'), null, 'words are not an amount');
  assert.equal(advances.toMinor('GHS 1,200.50'), 120050);

  const { env } = await setUp();
  await advances.ingestForm(env, { responses: [
    { responseId: 'a', po: '4123', amount: '100', tnt: '20', tntIncluded: false },
    { responseId: 'b', po: '4124', amount: '100', tnt: '20', tntIncluded: true },
    { responseId: 'c', po: '4125 & 4126', amount: '300', tnt: '10' },
    { responseId: 'd', po: 'N/A', amount: '50' },
  ] });
  const got = await advances.reportedFor(env, ['P04123', 'P04124', 'P04125', 'P04126']);
  assert.equal(got.get('P04123').total, 12000, 'TnT on top');
  assert.equal(got.get('P04124').total, 10000, 'TnT already in the invoice');
  assert.equal(got.get('P04125').together, true);
  assert.equal(got.get('P04126').together, true);
  // Sent again with one PO fewer: the other is no longer reported by it.
  await advances.ingestForm(env, { responseId: 'c', po: '4125', amount: '300', tnt: '10' });
  const again = await advances.reportedFor(env, ['P04125', 'P04126']);
  assert.deepEqual([again.get('P04125').total, again.has('P04126')], [31000, false]);
});

test('a big batch from the form is saved in a handful of database calls', async () => {
  const { env } = await setUp();
  let calls = 0;
  const counted = { ...env.DB, prepare: (sql) => env.DB.prepare(sql), batch: async (list) => { calls += 1; return env.DB.batch(list); } };
  const realPrepare = env.DB.prepare.bind(env.DB);
  let prepared = 0;
  counted.prepare = (sql) => { prepared += 1; return realPrepare(sql); };
  const responses = Array.from({ length: 500 }, (_, i) => ({ responseId: `r${i}`, po: i % 50 ? String(1000 + i) : `${1000 + i} & ${2000 + i}`, amount: '10', tnt: '1' }));
  const out = await advances.ingestForm({ ...env, DB: counted }, { responses });
  assert.deepEqual([out.saved, calls], [500, 1]);
  // Nine values a row, at most a hundred a statement: eleven rows to one.
  assert.ok(prepared < 60, `${prepared} statements`);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_report').first()).n, 510);
  // Sent again: still one copy each.
  await advances.ingestForm({ ...env, DB: counted }, { responses });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_report').first()).n, 510);
});
