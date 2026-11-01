import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as notes from '../src/routes/notes.js';
import * as routes from '../src/routes/shifts.js';

/**
 * Notes and history on a difference: written by admins and supervisors, the
 * people tagged emailed (not the writer, not whoever answered), and what
 * happened to the difference kept beside them. Everything is invented.
 */

const OWNER = { id: 1, name: 'Test Owner', isOwner: true, access: [] };
const SUP = { id: 21, name: 'Sup Kofi', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const UPLOADER = { id: 23, name: 'Up Abena', isOwner: false, access: [{ systemId: 'insight', role: 'uploader' }] };
const KEY = 'not-recorded:t:610031901239';

function setUp() {
  const { db, raw } = freshDb();
  raw.exec(`INSERT INTO accounts (id, email, name, active, is_owner) VALUES (1, 'owner@example.test', 'Test Owner', 1, 1),
      (21, 'kofi@example.test', 'Sup Kofi', 1, 0), (22, 'ama@example.test', 'Sup Ama', 1, 0), (23, 'abena@example.test', 'Up Abena', 1, 0);
    INSERT INTO account_access (account_id, system_id, role) VALUES (21, 'insight', 'supervisor'), (22, 'insight', 'supervisor'), (23, 'insight', 'uploader');`);
  const sent = [];
  const fetchImpl = async (req) => { sent.push(await req.json()); return new Response('{"ok":true}', { status: 200 }); };
  return { env: { DB: db, HIVE: { fetch: fetchImpl }, SSO_SECRET_ATTENDANCE: 'test-secret' }, sent, fetchImpl };
}

test('only admins and supervisors write or read notes, and only they can be tagged', async () => {
  const { env } = setUp();
  await assert.rejects(notes.addNote(env, { key: KEY, text: 'Hello' }, UPLOADER), /admins and supervisors/);
  await assert.rejects(notes.history(env, { key: KEY }, UPLOADER), /admins and supervisors/);
  await assert.rejects(notes.addNote(env, { key: KEY, text: '' }, SUP), /Note/);
  await assert.rejects(notes.addNote(env, { key: 'no spaces allowed', text: 'Hi' }, SUP), /Which difference/);
  const names = (await notes.people(env, SUP)).people.map((p) => p.name);
  assert.deepEqual(names, ['Sup Ama', 'Sup Kofi', 'Test Owner']);
});

test('a note emails whoever is tagged, not the writer', async () => {
  const { env, sent, fetchImpl } = setUp();
  const out = await notes.addNote(env, { key: KEY, text: 'Check the MoMo message', tags: [22, 21, 23, 99], about: 'Paid, but not in ASSD' }, SUP, { fetchImpl });
  assert.equal(out.told, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ama@example.test');
  assert.match(sent[0].subject, /Sup Kofi tagged you on Paid, but not in ASSD/);
  const { items } = await notes.history(env, { key: KEY }, OWNER);
  assert.deepEqual(items[0].tags.map((t) => t.name), ['Sup Ama', 'Sup Kofi']);
});

test('history keeps what happened to an answer, beside the notes, oldest first', async () => {
  const { env, fetchImpl } = setUp();
  await routes.saveAnswer(env, { key: KEY, answer: 'Keyed short in ASSD', note: 'The 9:51pm one' }, SUP, { pending: true });
  await notes.addNote(env, { key: KEY, text: 'Looks right to me' }, OWNER, { fetchImpl });
  await routes.saveAnswer(env, { key: KEY, answer: 'Not the same payment' }, OWNER);
  await routes.saveAnswer(env, { key: KEY, answer: '' }, OWNER);
  const { items } = await notes.history(env, { key: KEY }, SUP);
  assert.deepEqual(items.map((i) => [i.type, i.by]), [['event', 'Sup Kofi'], ['note', 'Test Owner'], ['event', 'Test Owner'], ['event', 'Test Owner'], ['event', 'Test Owner']]);
  assert.match(items[0].text, /^Answered “Keyed short in ASSD”: “The 9:51pm one” \(waiting for an admin\)/);
  // The owner answering instead sets Kofi's waiting answer aside, and says so.
  assert.equal(items[2].text, 'Sup Kofi’s answer “Keyed short in ASSD” set aside: answered by an admin instead');
  assert.match(items[3].text, /^Answered “Not the same payment”/);
  assert.match(items[4].text, /taken back/);
  assert.deepEqual((await notes.counts(env, { keys: [KEY, 'drawer:2026-10-14:night', 'bad key'] }, SUP)).counts, { [KEY]: 5 });
});

test('moving a payment is in its history', async () => {
  const { env } = setUp();
  await routes.movePayment(env, { eventId: 't:610031901239', day: '2026-10-08', slot: 'afternoon', why: 'Took it at 9pm', key: KEY }, OWNER);
  await routes.movePayment(env, { eventId: 't:610031901239', back: true, key: KEY }, OWNER);
  const { items } = await notes.history(env, { key: KEY }, OWNER);
  assert.match(items[0].text, /Moved to the afternoon shift of 2026-10-08/);
  assert.match(items[1].text, /Put back/);
});

test('what staff said in HIVE shows in the history, even on a placement since undone', async () => {
  const { env } = setUp();
  const { raw: hraw, db: hdb } = freshDb('../migrations');
  hraw.exec(`INSERT INTO users (id, name, role, active) VALUES (8, 'Kofi Test', 'staff', 1), (7, 'Ama Test', 'staff', 1)`);
  env.ATT_DB = hdb;
  const key = 'not-found:t:900001';
  // Put on Kofi's account, he answers, it is undone and put on again.
  await env.DB.prepare(`INSERT INTO till_move (id, key, kind, day, slot, amount, shares, reason, by_name, at, undone_by, undone_at)
    VALUES (3, ?1, 'not-found', '2026-10-02', 'morning', -7000, '[]', 'Unpaid laundry', 'Test Owner', '2026-10-05 10:00:00', 'Test Owner', '2026-10-20 17:55:00'),
           (4, ?1, 'not-found', '2026-10-02', 'morning', -7000, '[]', 'Unpaid laundry', 'Test Owner', '2026-10-20 18:01:00', NULL, NULL),
           (30, 'other:key', 'not-found', '2026-10-02', 'morning', -100, '[]', 'x', 'Test Owner', '2026-10-05 10:00:00', NULL, NULL)`).bind(key).run();
  hraw.exec(`INSERT INTO till_answer (key, user_id, how, text, at) VALUES
    ('moved:3:8', 8, 'explain', 'The guest paid at the laundry by card, slip in the drawer.', '2026-10-06 09:00:00'),
    ('moved:30:8', 8, 'explain', 'Not about this one.', '2026-10-06 09:00:00'),
    ('drawer:2026-10-02:morning', 7, 'repay', 'I will pay the 20 back.', '2026-10-03 08:00:00'),
    ('drawer:2026-10-09:morning', 7, 'repay', 'Another day.', '2026-10-10 08:00:00')`);
  await notes.addNote(env, { key, text: 'Asked Kofi for the slip' }, OWNER, { fetchImpl: async () => new Response('{}') });
  const { items } = await notes.history(env, { key, day: '2026-10-02', slot: 'morning' }, SUP);
  const staff = items.filter((x) => x.type === 'staff');
  assert.deepEqual(staff.map((x) => [x.by, x.about, x.text]), [
    ['Ama Test', 'about the shift’s drawer', 'Will pay it back: I will pay the 20 back.'],
    ['Kofi Test', 'on an earlier placement on their account, undone 2026-10-20', 'Their explanation: The guest paid at the laundry by card, slip in the drawer.'],
  ]);
  assert.equal(items[items.length - 1].type, 'note', 'oldest first, the note written today last');
  const { counts } = await notes.counts(env, { keys: [key] }, SUP);
  assert.equal(counts[key], 2, 'the note and Kofi’s answer on its placement');
  assert.deepEqual((await notes.history(env, { key }, SUP)).items.filter((x) => x.type === 'staff').length, 1, 'without the shift, only its own');
});
