import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { run } from '../src/lib/db.js';
import * as assistant from '../src/routes/assistant.js';

/** The Assistant. Everybody and every figure is invented. */

const OWNER = { id: 1, name: 'Test Owner', email: 'owner@example.test', isOwner: true, access: [] };
const SUP = { id: 3, name: 'Sam Supervisor', email: 'sam@example.test', access: [{ systemId: 'insight', role: 'supervisor' }] };
const NOW = Date.parse('2026-10-30T08:00:00Z');

async function world() {
  const { db } = freshDb();
  const env = { DB: db };
  // A float given six weeks ago, nothing sent since.
  await run(db, `INSERT INTO float_person (id, name, code, token, active, created_at) VALUES (1, 'Efua Test', 'EFUA', 't', 1, '2026-09-01')`);
  await run(db, `INSERT INTO float_move (person_id, kind, amount, day, at) VALUES (1, 'given', 150000, '2026-09-15', '2026-09-15T09:00:00Z')`);
  // A bill owed for two months.
  await run(db, "INSERT INTO dim_supplier (id, match_key, name) VALUES (1, 'a hardware shop', 'A Hardware Shop')");
  await run(db, `INSERT INTO fact_bill (source_id, external_id, day, supplier_id, line_id, state, payment_state, total, residual)
    VALUES ('odoo', 'b1', '2026-08-20', 1, 'maintenance', 'posted', 'not_paid', 128000, 128000)`);
  // One of Insight's own checks.
  await run(db, `INSERT INTO findings (fingerprint, rule_id, severity, headline, detail, action, impact_monthly, sources, first_seen_at)
    VALUES ('f1', 'drawer', 'critical', 'Kofi Test''s drawer was short three afternoons', 'GH₵ 412 in all.', 'Count the drawer at 17:00 for a week.', 41200, '["shifts"]', '2026-10-28 08:00:00')`);
  return env;
}

const UPLOADER = { id: 4, name: 'Uma Uploader', email: 'uma@example.test', access: [{ systemId: 'insight', role: 'uploader' }] };
const READER = { id: 5, name: 'Rita Reports', email: 'rita@example.test', access: [{ systemId: 'insight', role: 'reports' }] };
const NOBODY = { id: 6, name: 'Hive Only', email: 'h@example.test', access: [{ systemId: 'hive', role: 'staff' }] };

test('only somebody given Insight has one', async () => {
  const env = await world();
  await assert.rejects(assistant.gather(env, NOBODY, { now: NOW }), /not been shared/);
  await assert.rejects(assistant.gather(env, null, { now: NOW }), /not been shared/);
});

test('a supervisor’s is their own work: to-dos, shifts to check, staff answers; no money unless given it', async () => {
  const env = await world();
  const { raw: hraw, db: hdb } = freshDb('../migrations');
  hraw.exec(`INSERT INTO users (id, name, role, active) VALUES (8, 'Kofi Test', 'staff', 1);
    INSERT INTO till_answer (key, user_id, how, text, at) VALUES ('drawer:2026-10-27:morning', 8, 'explain', 'A guest paid by MoMo.', '2026-10-28 09:00:00')`);
  env.ATT_DB = hdb;
  await run(env.DB, `INSERT INTO till_access (account_id, area, level) VALUES (3, 'check', 2), (3, 'answers', 2), (3, 'files', 0), (3, 'money', 0)`);
  await run(env.DB, `INSERT INTO money_todo (key, kind, ref, day, amount, assignee_id, assignee_name, state, sent_back, opened_at) VALUES
    ('nopo:1', 'nopo', 'B001', '2026-10-20', 50000, 3, 'Sam Supervisor', 'open', NULL, '2026-10-21 08:00:00'),
    ('nopo:2', 'nopo', 'B002', '2026-10-22', 7000, 3, 'Sam Supervisor', 'open', 'Which shift?', '2026-10-23 08:00:00'),
    ('nopo:3', 'nopo', 'B003', '2026-10-22', 9000, 99, 'Somebody Else', 'open', NULL, '2026-10-23 08:00:00')`);
  await run(env.DB, "INSERT INTO shift_upload (kind, to_day, at) VALUES ('journal', '2026-10-29', '2026-10-29 07:00:00')");
  await run(env.DB, "INSERT INTO shift_check (day, slot, by_name, at) VALUES ('2026-10-23', 'morning', 'Sam Supervisor', '2026-10-24 08:00:00')");
  const d = await assistant.gather(env, SUP, { now: NOW });
  assert.equal(d.admin, false);
  assert.equal(d.money, false);
  assert.deepEqual(d.read.map((r) => r.id), ['given', 'proof', 'mytodos', 'checks', 'staffanswers'], 'nothing an admin alone sees');
  const keys = d.items.map((x) => x.key);
  assert.ok(!keys.some((k) => /^(finding|floats|bill|approval|receipts|suppliers|report)/.test(k)), 'no admin items');
  assert.equal(d.items.find((x) => x.key === 'mytodos:back').title, '1 PO item sent back to you');
  assert.equal(d.items.find((x) => x.key === 'mytodos:open').title, '1 PO to chase in Odoo', 'only their own');
  const checks = d.items.filter((x) => x.key.startsWith('check:'));
  assert.equal(checks.length, 20, '23 to 29 Oct, three a day, less the one checked: one line each');
  const fri = checks.find((x) => x.key === 'check:2026-10-23|afternoon');
  assert.deepEqual([fri.title, fri.due, fri.area, fri.actions[0].shift], ['Check Fri 23 Oct afternoon shift', '2026-10-24', 'shifts', { day: '2026-10-23', slot: 'afternoon' }]);
  const answer = d.items.find((x) => x.key.startsWith('staffanswer:'));
  assert.deepEqual([answer.title, answer.why, answer.due], ['Kofi Test answered: “A guest paid by MoMo.”', 'Tue 27 Oct morning', '2026-10-29']);
  assert.ok(d.items.every((x) => x.amount == null), 'no amounts without money');
  assert.equal(d.tiles.atStake, 0);
  assert.deepEqual(d.items.filter((x) => x.tab === 'done'), [], 'done for you is an admin’s');
});

test('an uploader’s is the files; somebody given the Brief sees its findings', async () => {
  const env = await world();
  const u = await assistant.gather(env, UPLOADER, { now: NOW });
  assert.deepEqual(u.read.map((r) => r.id), ['files']);
  assert.equal(u.items[0].key, 'files:journal');
  assert.equal(u.items[0].actions[0].href, '#/upload', 'to their own page');
  let r = await assistant.gather(env, READER, { now: NOW });
  assert.deepEqual(r.items, [], 'nothing shared, nothing shown');
  await run(env.DB, "INSERT INTO report_access (account_id, report) VALUES (5, 'brief')");
  r = await assistant.gather(env, READER, { now: NOW });
  assert.deepEqual(r.read.map((x) => x.id), ['findings']);
  assert.equal(r.items[0].title, 'Kofi Test\'s drawer was short three afternoons');
  assert.equal(r.items[0].amount, 41200, 'the Brief shows its own amounts');
});

test('every source in one list: what is going wrong, with what to do, the worst first', async () => {
  const env = await world();
  await assistant.setBills(env, { on: true }, OWNER);
  const d = await assistant.gather(env, OWNER, { now: NOW });
  const titles = d.items.map((x) => x.title);
  assert.equal(d.items[0].title, 'Kofi Test\'s drawer was short three afternoons', 'urgent first');
  assert.equal(d.items[0].advice, 'Count the drawer at 17:00 for a week.');
  const float = d.items.find((x) => x.key === 'floats:quiet');
  assert.match(float.title, /GH₵ 1,500 in floats/);
  assert.match(float.why, /Efua Test/);
  assert.equal(float.tab, 'fix');
  const bill = d.items.find((x) => x.key.startsWith('bill:'));
  assert.equal(bill.title, 'A Hardware Shop is owed GH₵ 1,280');
  assert.ok(titles.includes('No ASSD journal loaded yet'));
  assert.equal(d.tiles.urgent, 1);
  assert.equal(d.tiles.atStake, 41200 + 150000 + 128000);
  assert.ok(d.read.every((r) => typeof r.ok === 'boolean'), 'each source says whether it was read');
  assert.equal(d.counts.fix, d.items.filter((x) => x.tab === 'fix').length);
});

test('bills owed are not flagged until an admin turns them on, and can be turned off again', async () => {
  const env = await world();
  let d = await assistant.gather(env, OWNER, { now: NOW });
  assert.equal(d.billsOn, false, 'off at first');
  assert.equal(d.items.some((x) => x.key.startsWith('bill:')), false, 'no bill on the list');
  assert.equal(d.tiles.atStake, 41200 + 150000, 'nor in the money at stake');
  assert.deepEqual(d.read.find((r) => r.id === 'bills'), { id: 'bills', label: 'Odoo bills', ok: true, off: true, count: 0 });
  await assert.rejects(assistant.setBills(env, { on: true }, SUP), /admin/i, 'only an admin turns it on');
  await assert.rejects(assistant.setBills(env, { on: 'yes' }, OWNER), /on or off/);
  await assistant.setBills(env, { on: true }, OWNER);
  d = await assistant.gather(env, OWNER, { now: NOW });
  assert.equal(d.billsOn, true);
  assert.equal(d.items.find((x) => x.key.startsWith('bill:')).title, 'A Hardware Shop is owed GH₵ 1,280');
  await assistant.setBills(env, { on: false }, OWNER);
  d = await assistant.gather(env, OWNER, { now: NOW });
  assert.equal(d.items.some((x) => x.key.startsWith('bill:')), false, 'off again');
});

test('a source that fails is said, and the rest still come', async () => {
  const env = await world();
  const broken = { id: 'x', label: 'A broken one', read: async () => { throw new Error('it is down'); } };
  const fine = { id: 'y', label: 'A fine one', read: async () => [{ tab: 'decide', key: 'y', sev: 'info', title: 'Something to decide' }] };
  const d = await assistant.gather(env, OWNER, { now: NOW, sources: [broken, fine] });
  assert.deepEqual(d.read.map((r) => [r.label, r.ok, r.error || r.count]), [['A broken one', false, 'it is down'], ['A fine one', true, 1]]);
  assert.equal(d.items.filter((x) => x.tab !== 'done')[0].title, 'Something to decide');
});

test('the morning summary: written by the AI from the items, or plain words without it', async () => {
  const env = await world();
  const plain = await assistant.briefing(env, OWNER, { now: NOW });
  assert.equal(plain.by, 'plain');
  assert.match(plain.text, /1 urgent/);
  let asked = null;
  env.AI = { run: async (model, input) => { asked = input; return { response: 'Kofi Test’s drawer needs you first.' }; } };
  const ai = await assistant.briefing(env, OWNER, { now: NOW });
  assert.deepEqual([ai.by, ai.text], ['ai', 'Kofi Test’s drawer needs you first.']);
  assert.match(asked.messages[1].content, /Kofi Test/, 'the AI is given the items');
  assert.match(asked.messages[0].content, /never invent/);
});

test('a question is answered from the facts, and needs a question', async () => {
  const env = await world();
  await assert.rejects(assistant.ask(env, { question: ' ' }, OWNER, { now: NOW }), /Ask a question/);
  const none = await assistant.ask(env, { question: 'Who owes most?' }, OWNER, { now: NOW });
  assert.equal(none.by, 'plain');
  env.AI = { run: async (model, input) => ({ response: input.messages[1].content.includes('A Hardware Shop') ? 'A Hardware Shop, GH₵ 1,280.' : 'I do not know.' }) };
  const out = await assistant.ask(env, { question: 'Who are we owing most?' }, OWNER, { now: NOW });
  assert.equal(out.answer, 'A Hardware Shop, GH₵ 1,280.', 'bills off are not flagged, but a question about them is answered');
  await assistant.setBills(env, { on: true }, OWNER);
  assert.equal((await assistant.ask(env, { question: 'Who are we owing most?' }, OWNER, { now: NOW })).answer, 'A Hardware Shop, GH₵ 1,280.');
});
