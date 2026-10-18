import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as proof from '../src/routes/proof.js';
import { linkIssues, saveSettings } from '../src/routes/till.js';

/**
 * Proof for an answer: asked by an admin (or whoever an admin allows), sent
 * by whoever gave the answer, in Insight or in HIVE; reminded each morning,
 * three times at most. Everything is invented.
 */

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const SUP = { id: 21, name: 'Sup Kofi', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const OTHER = { id: 22, name: 'Sup Ama', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const pic = `data:image/jpeg;base64,${Buffer.from('a picture').toString('base64')}`;
const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`;

async function setUp() {
  const { db, raw } = freshDb();
  const hive = freshDb('../migrations');
  const env = { DB: db, ATT_DB: hive.db };
  raw.exec(`INSERT INTO accounts (id, email, name, active) VALUES (21, 'kofi@example.test', 'Sup Kofi', 1), (22, 'ama@example.test', 'Sup Ama', 1);
    INSERT INTO account_access (account_id, system_id, role) VALUES (21, 'insight', 'supervisor'), (22, 'insight', 'supervisor');
    INSERT INTO shift_answer (key, answer, note, by_name, at, status) VALUES ('not-recorded:t:610031901239', 'Explained', 'The payment declined', 'Sup Kofi', '2026-10-15 13:13:00', 'pending');`);
  hive.raw.exec(`DELETE FROM users; INSERT INTO users (id, name, role, active) VALUES (7, 'Ama Test', 'staff', 1);
    INSERT INTO till_answer (key, user_id, how, text) VALUES ('drawer:2026-10-14:night', 7, 'explain', 'A guest paid by MoMo, not cash');`);
  return { env, raw };
}

test('a supervisor’s answer: asked by an admin, sent from their Inbox, shown on the answer', async () => {
  const { env } = await setUp();
  const target = 'answer:not-recorded:t:610031901239';
  await assert.rejects(proof.ask(env, { target, kinds: [] }, OWNER), /what to send/);
  const out = await proof.ask(env, { target, kinds: ['momo', 'nonsense'], note: 'The MoMo message of the 9:51pm decline' }, OWNER);
  assert.deepEqual([out.request.askedOf, out.request.kinds, out.request.about, out.request.toHive], ['Sup Kofi', ['momo'], 'Explained: The payment declined', false]);
  await assert.rejects(proof.ask(env, { target, kinds: ['momo'] }, OWNER), /already asked/);

  // On his own answer's card too, marked his, so he can send it there; the admin's view is not.
  assert.equal((await proof.forTargets(env, { targets: target }, SUP)).requests[0].mine, true);
  assert.equal((await proof.forTargets(env, { targets: target }, OWNER)).requests[0].mine, false);
  // In Kofi's Inbox, and only Kofi's.
  assert.equal((await proof.mine(env, SUP)).requests.length, 1);
  assert.equal((await proof.mine(env, OTHER)).requests.length, 0);
  const id = out.request.id;
  await assert.rejects(proof.send(env, { id, files: [{ name: 'momo.jpg', data: pic }] }, OTHER), /not yours/);
  await assert.rejects(proof.send(env, { id }, SUP), /Add a picture or a PDF/);
  await assert.rejects(proof.send(env, { id, files: [{ name: 'x.txt', data: 'data:text/plain;base64,AA==' }] }, SUP), /pictures and PDFs/);
  await proof.send(env, { id, files: [{ name: 'momo.jpg', data: pic }, { name: 'statement.pdf', data: pdf }], note: 'Statement attached' }, SUP);
  await assert.rejects(proof.send(env, { id, files: [{ name: 'm.jpg', data: pic }] }, SUP), /closed/);

  // On the answer, for the admin: sent, with both files, which open.
  const seen = await proof.forTargets(env, { targets: target }, OWNER);
  const r = seen.requests[0];
  assert.deepEqual([seen.canAsk, r.status, r.reply, r.files.map((f) => f.name)], [true, 'sent', 'Statement attached', ['momo.jpg', 'statement.pdf']]);
  const res = await proof.file(env, r.files[1].id, OWNER);
  assert.equal(res.headers.get('Content-Type'), 'application/pdf');
  assert.equal(await res.text(), '%PDF-1.4');
  await proof.file(env, r.files[0].id, SUP); // the one asked sees what they sent
  await assert.rejects(proof.file(env, r.files[0].id, OTHER), /not yours to see/);
  // Asked again, for more.
  assert.equal((await proof.ask(env, { target, kinds: ['bank'] }, OWNER)).request.status, 'asked');
});

test('who may ask: admins, and whoever an admin gives “Ask for proof”', async () => {
  const { env } = await setUp();
  const target = 'answer:not-recorded:t:610031901239';
  await assert.rejects(proof.ask(env, { target, kinds: ['momo'] }, OTHER));
  assert.equal((await proof.forTargets(env, { targets: target }, OTHER)).canAsk, false);
  await saveSettings(env, { access: { accountId: 22, area: 'proof', level: 2 } }, OWNER);
  const out = await proof.ask(env, { target, kinds: ['slip'] }, OTHER);
  assert.equal(out.request.askedBy, 'Sup Ama');
  await proof.cancel(env, { id: out.request.id }, OTHER);
  assert.equal((await proof.mine(env, SUP)).requests.length, 0, 'cancelled: off their list');
});

test('an answer decided without the proof: the request closes, off their list, never reminded', async () => {
  const { env } = await setUp();
  await proof.ask(env, { target: 'answer:not-recorded:t:610031901239', kinds: ['momo'] }, OWNER);
  assert.equal((await proof.mine(env, SUP)).requests.length, 1);
  await env.DB.prepare("UPDATE shift_answer SET status = 'applied'").run();
  assert.equal((await proof.mine(env, SUP)).requests.length, 0);
  assert.equal((await proof.remindDue(env, { at: new Date(Date.now() + 48 * 3600_000) })).sent, 0);
  assert.equal((await env.DB.prepare('SELECT reply FROM proof_request').first()).reply, 'Decided without it');
});

test('a staff answer from HIVE: asked of them in HIVE, shown on their list, sent over the link', async () => {
  const { env } = await setUp();
  const target = 'issue:drawer:2026-10-14:night';
  const out = await proof.ask(env, { target, kinds: ['momo'], note: 'The guest’s MoMo payment' }, OWNER);
  assert.deepEqual([out.request.askedOf, out.request.toHive, out.request.about], ['Ama Test', true, 'A guest paid by MoMo, not cash']);
  const open = await proof.openForHive(env, 7);
  assert.deepEqual(open.get('drawer:2026-10-14:night'), { id: out.request.id, kinds: ['MoMo screenshot or statement'], note: 'The guest’s MoMo payment', by: 'Test Owner', at: out.request.askedAt });
  // linkIssues carries it to HIVE (nothing else is on her list here, so the list itself is empty).
  assert.deepEqual((await linkIssues(env, { userId: 7 })).issues, []);
  await assert.rejects(proof.linkSend(env, { id: out.request.id, userId: 8, cannot: true, note: 'x' }), /not yours/);
  await proof.linkSend(env, { id: out.request.id, userId: 7, cannot: true, note: 'The guest has not sent it yet' });
  const r = (await proof.forTargets(env, { targets: target }, OWNER)).requests[0];
  assert.deepEqual([r.status, r.reply], ['cannot', 'The guest has not sent it yet']);
});

test('reminders: the next morning and each morning after, three at most, and none once sent', async () => {
  const { env } = await setUp();
  const out = await proof.ask(env, { target: 'answer:not-recorded:t:610031901239', kinds: ['momo'] }, OWNER);
  const asked = new Date(`${out.request.askedAt.replace(' ', 'T')}Z`);
  const later = (h) => new Date(asked.getTime() + h * 3600_000);
  assert.equal((await proof.remindDue(env, { at: later(5) })).sent, 0, 'not the same day');
  assert.equal((await proof.remindDue(env, { at: later(21) })).sent, 1);
  // The reminder's time is now, so the next is a day after it.
  await env.DB.prepare("UPDATE proof_request SET reminded_at = datetime('now', '-25 hours')").run();
  assert.equal((await proof.remindDue(env)).sent, 1);
  await env.DB.prepare("UPDATE proof_request SET reminded_at = datetime('now', '-25 hours')").run();
  assert.equal((await proof.remindDue(env)).sent, 1);
  await env.DB.prepare("UPDATE proof_request SET reminded_at = datetime('now', '-25 hours')").run();
  assert.equal((await proof.remindDue(env)).sent, 0, 'three at most');
  assert.equal((await env.DB.prepare('SELECT reminders FROM proof_request').first()).reminders, 3);
});
