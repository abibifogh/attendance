import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as tasks from '../src/routes/tasks.js';
import * as notes from '../src/routes/notes.js';

/**
 * To-dos made from a difference: for an Insight user, emailed when made and
 * each morning until done, separate from the difference. Everything is invented.
 */

const OWNER = { id: 1, name: 'Test Owner', isOwner: true, access: [] };
const SUP = { id: 21, name: 'Sup Kofi', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const AMA = { id: 22, name: 'Sup Ama', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const UPLOADER = { id: 23, name: 'Up Abena', isOwner: false, access: [{ systemId: 'insight', role: 'uploader' }] };
const KEY = 'drawer:2026-10-19:night';

function setUp() {
  const { db, raw } = freshDb();
  raw.exec(`INSERT INTO accounts (id, email, name, active, is_owner) VALUES (1, 'owner@example.test', 'Test Owner', 1, 1),
      (21, 'kofi@example.test', 'Sup Kofi', 1, 0), (22, 'ama@example.test', 'Sup Ama', 1, 0), (23, 'abena@example.test', 'Up Abena', 1, 0);
    INSERT INTO account_access (account_id, system_id, role) VALUES (21, 'insight', 'supervisor'), (22, 'insight', 'supervisor'), (23, 'insight', 'uploader');
    INSERT INTO shift_answer (key, answer, note, by_name, at, status) VALUES ('${KEY}', 'Explained', 'Counted twice', 'Sup Kofi', '2026-10-20 08:00:00', 'applied');`);
  const sent = [];
  const fetchImpl = async (req) => { sent.push(await req.json()); return new Response('{"ok":true}', { status: 200 }); };
  return { env: { DB: db, HIVE: { fetch: fetchImpl }, SSO_SECRET_ATTENDANCE: 'test-secret' }, raw, sent, fetchImpl };
}
const body = (extra = {}) => ({ key: KEY, what: 'Count the night envelopes with Kofi Test', forId: 22, due: '2026-10-22', about: 'the drawer was short, Mon 19 Oct night', day: '2026-10-19', slot: 'night', ...extra });

test('only for Insight admins and supervisors, made by them', async () => {
  const { env, fetchImpl } = setUp();
  await assert.rejects(tasks.make(env, body(), UPLOADER, { fetchImpl }), /admins and supervisors/);
  await assert.rejects(tasks.make(env, body({ forId: 23 }), SUP, { fetchImpl }), /Who is it for/);
  await assert.rejects(tasks.make(env, body({ forId: 99 }), SUP, { fetchImpl }), /Who is it for/);
  await assert.rejects(tasks.make(env, body({ what: '' }), SUP, { fetchImpl }), /What to do/);
  await assert.rejects(tasks.make(env, body({ due: 'soon' }), SUP, { fetchImpl }), /when it is due/);
});

test('made: emailed to whoever it is for, kept apart from the answer, in the history', async () => {
  const { env, raw, sent, fetchImpl } = setUp();
  const out = await tasks.make(env, body(), SUP, { fetchImpl });
  assert.equal(out.told, true);
  assert.equal(sent[0].to, 'ama@example.test');
  assert.match(sent[0].subject, /Sup Kofi gave you a to-do/);
  // For oneself: nobody emailed.
  assert.equal((await tasks.make(env, body({ forId: 21 }), SUP, { fetchImpl })).told, false);
  assert.equal(sent.length, 1);

  // Who sees what: Ama hers, Kofi what he made, the owner all; a third supervisor nothing.
  raw.exec("INSERT INTO accounts (id, email, name, active) VALUES (24, 'yaw@example.test', 'Sup Yaw', 1); INSERT INTO account_access (account_id, system_id, role) VALUES (24, 'insight', 'supervisor');");
  const YAW = { id: 24, name: 'Sup Yaw', access: [{ systemId: 'insight', role: 'supervisor' }] };
  assert.equal((await tasks.list(env, {}, AMA)).tasks.length, 1);
  assert.equal((await tasks.list(env, {}, SUP)).tasks.length, 2);
  assert.equal((await tasks.list(env, {}, OWNER)).tasks.length, 2);
  assert.equal((await tasks.list(env, {}, YAW)).tasks.length, 0);
  assert.equal((await tasks.forKeys(env, { keys: [KEY] }, OWNER)).tasks[KEY].length, 2);

  // Ama can mark hers done but not change it; Yaw can do neither.
  const id = out.task.id;
  await assert.rejects(tasks.change(env, id, { due: '2026-10-25' }, AMA), /whoever made it/);
  await assert.rejects(tasks.done(env, id, YAW), /Only whoever/);
  await tasks.done(env, id, AMA);
  await assert.rejects(tasks.done(env, id, AMA), /done already/);
  // Done on the to-do leaves the difference's answer as it was.
  assert.equal(raw.prepare('SELECT answer FROM shift_answer WHERE key = ?').get(KEY).answer, 'Explained');

  const h = (await notes.history(env, { key: KEY }, OWNER)).items.map((i) => i.text);
  assert.match(h[0], /^To-do for Sup Ama, due Thu 22 Oct: “Count the night envelopes/);
  assert.match(h[2], /^To-do done/);
});

test('changed to somebody else: they are told; removed: gone from the lists', async () => {
  const { env, sent, fetchImpl } = setUp();
  const { task } = await tasks.make(env, body({ forId: 21 }), OWNER, { fetchImpl });
  sent.length = 0;
  const out = await tasks.change(env, task.id, { forId: 22, due: '2026-10-23' }, OWNER, { fetchImpl });
  assert.equal(out.task.forName, 'Sup Ama');
  assert.equal(sent[0].to, 'ama@example.test');
  await tasks.change(env, task.id, { remove: true }, OWNER);
  assert.equal((await tasks.list(env, {}, OWNER)).tasks.length, 0);
  await assert.rejects(tasks.done(env, task.id, OWNER), /not there/);
});

test('reminded each morning until done, once a day', async () => {
  const { env, raw, sent, fetchImpl } = setUp();
  const { task } = await tasks.make(env, body(), OWNER, { fetchImpl });
  raw.exec(`UPDATE shift_task SET made_at = '2026-10-20 10:00:00', reminded_at = '2026-10-20 10:00:00'`);
  sent.length = 0;
  // The same day it was made: nothing.
  assert.equal((await tasks.remindDue(env, { fetchImpl, at: new Date('2026-10-20T18:00:00Z') })).sent, 0);
  // Next morning, and the morning after (now overdue); twice on one morning is once.
  assert.equal((await tasks.remindDue(env, { fetchImpl, at: new Date('2026-10-21T06:45:00Z') })).sent, 1);
  assert.equal((await tasks.remindDue(env, { fetchImpl, at: new Date('2026-10-21T07:45:00Z') })).sent, 0);
  assert.equal((await tasks.remindDue(env, { fetchImpl, at: new Date('2026-10-23T06:45:00Z') })).sent, 1);
  assert.match(sent[0].subject, /^To-do due Thu 22 Oct/);
  assert.match(sent[1].subject, /^To-do overdue/);
  await tasks.done(env, task.id, OWNER);
  assert.equal((await tasks.remindDue(env, { fetchImpl, at: new Date('2026-10-24T06:45:00Z') })).sent, 0);
  assert.equal((await tasks.list(env, {}, OWNER)).tasks.length, 0);
  assert.equal((await tasks.list(env, { done: '1' }, OWNER)).tasks.length, 1);
});
