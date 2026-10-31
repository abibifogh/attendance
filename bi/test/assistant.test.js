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

test('only an admin is shown it', async () => {
  const env = await world();
  await assert.rejects(assistant.gather(env, SUP, { now: NOW }), /admin/i);
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
