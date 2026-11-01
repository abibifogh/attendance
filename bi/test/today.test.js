import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { run } from '../src/lib/db.js';
import { today, doneWords } from '../src/routes/today.js';
import { arrange } from '../src/routes/assistant.js';
import * as duty from '../src/routes/duty.js';

/** Today: each person's one list, by when it wants doing. Everybody and every figure is invented. */

const OWNER = { id: 1, name: 'Ama Test', email: 'ama@example.test', isOwner: true, access: [] };
const SAM = { id: 3, name: 'Sam Test', email: 'sam@example.test', access: [{ systemId: 'insight', role: 'supervisor' }] };
// Saturday 31 October 2026, 08:00: the week is Monday 26 to Friday 30.
const SAT = Date.parse('2026-10-31T08:00:00Z');

async function world() {
  const { db, raw } = freshDb();
  const env = { DB: db };
  raw.exec(`INSERT INTO accounts (id, email, name, active, is_owner) VALUES (1, 'ama@example.test', 'Ama Test', 1, 1), (3, 'sam@example.test', 'Sam Test', 1, 0);
    INSERT INTO account_access (account_id, system_id, role) VALUES (3, 'insight', 'supervisor');
    INSERT INTO till_access (account_id, area, level) VALUES (3, 'check', 2), (3, 'answers', 2);
    INSERT INTO shift_upload (kind, to_day, at) VALUES ('journal', '2026-10-30', '2026-10-31 06:00:00');`);
  // Every shift of the week checked but Friday's three.
  for (const d of ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']) {
    for (const slot of ['morning', 'afternoon', 'night']) raw.prepare('INSERT INTO shift_check (day, slot, by_name, at) VALUES (?, ?, ?, ?)').run(d, slot, 'Sam Test', `${d} 23:00:00`);
  }
  // Two to-dos for Sam (one two days late, one next week), one for somebody else.
  raw.exec(`INSERT INTO shift_task (key, about, day, slot, what, for_id, for_name, due, made_by_id, made_by, made_at) VALUES
    ('drawer:2026-10-27:night', 'Tue 27 Oct night', '2026-10-27', 'night', 'Call Kofi Test about the GH₵120 short', 3, 'Sam Test', '2026-10-29', 1, 'Ama Test', '2026-10-28 09:00:00'),
    ('drawer:2026-10-28:night', NULL, NULL, NULL, 'Count the laundry tokens', 3, 'Sam Test', '2026-11-04', 1, 'Ama Test', '2026-10-28 09:00:00'),
    ('drawer:2026-10-29:night', NULL, NULL, NULL, 'Not Sam’s', 1, 'Ama Test', '2026-10-30', 3, 'Sam Test', '2026-10-28 09:00:00');
    INSERT INTO proof_request (target, about, asked_account, asked_name, kinds, asked_by, asked_at) VALUES
    ('answer:drawer:2026-10-28:morning', 'Paid back to the guest', 3, 'Sam Test', '["receipt"]', 'Ama Test', '2026-10-30 10:00:00');
    INSERT INTO shift_answer (key, answer, note, by_name, at, status) VALUES ('drawer:2026-10-28:morning', 'Explained', 'Counted twice', 'Sam Test', '2026-10-30 16:10:00', 'pending');`);
  return { env, raw };
}

test('a supervisor’s Today: their own things, by when they want doing, each with its button', async () => {
  const { env, raw } = await world();
  // What Sam did, from the audit trail: two checks today, a to-do earlier in the week, and one refused.
  const ev = (id, at, path, stage = 'done') => {
    raw.prepare("INSERT INTO audit_event (request_id, at, stage, method, path, account_id) VALUES (?, ?, 'asked', 'POST', ?, 3)").run(id, at, path);
    raw.prepare("INSERT INTO audit_event (request_id, at, stage, method, path) VALUES (?, ?, ?, 'POST', ?)").run(id, at, stage, path);
  };
  ev('a', '2026-10-31 07:10:00', '/api/till/check');
  ev('b', '2026-10-31 07:40:00', '/api/till/check');
  ev('c', '2026-10-28 12:00:00', '/api/shifts/tasks/:id/done');
  ev('d', '2026-10-31 07:50:00', '/api/shifts/answer', 'refused');
  ev('e', '2026-10-31 07:55:00', '/api/shifts/notes');

  const t = await today(env, SAM, { now: SAT });
  const by = (key) => t.items.find((x) => x.key === key);
  const late = by('task:1');
  assert.deepEqual([late.when, late.late, late.from, late.area, late.tag], ['overdue', 2, 'Ama Test', 'given', 'To-do']);
  assert.deepEqual(late.actions.map((a) => a.label), ['Open shift', 'Done']);
  assert.deepEqual(late.actions[0].shift, { day: '2026-10-27', slot: 'night' });
  assert.equal(late.actions[1].task, 1);
  assert.equal(by('task:2').when, 'later');
  assert.equal(t.items.some((x) => x.title === 'Not Sam’s'), false, 'only their own');
  const asked = by('proof:1');
  assert.deepEqual([asked.title, asked.when, asked.late, asked.from], ['Send proof for “Paid back to the guest”', 'overdue', 1, 'Ama Test']);
  const fri = by('check:2026-10-30|night');
  assert.deepEqual([fri.when, fri.title], ['today', 'Check Fri 30 Oct night shift']);
  assert.deepEqual(t.items.filter((x) => x.when).map((x) => x.when), [...t.items.filter((x) => x.when)].map((x) => x.when).sort((a, b) => ['overdue', 'today', 'later'].indexOf(a) - ['overdue', 'today', 'later'].indexOf(b)), 'overdue first, then today, then later');
  assert.deepEqual([t.counts.overdue, t.counts.today, t.counts.later], [2, 3, 1]);
  assert.equal(t.areas.given, 3);
  // Sent up: Sam's answer waits for an admin.
  assert.deepEqual(t.waiting.map((w) => w.title), ['Answered “Explained”']);
  // The week: what Sam did since Monday (refused ones not counted), Friday's three shifts not checked yet.
  assert.equal(t.week.did, 4);
  assert.deepEqual(t.week.checks, { checked: 18, of: 21 });
  assert.equal(t.week.overdue, 2);
  assert.deepEqual(t.doneToday.lines, [{ what: 'Checked a shift', n: 2, at: '07:40' }]);
  assert.equal(t.doneToday.other, 1, 'a note is a change with no words of its own');
  assert.equal(t.duty, null, 'nobody holds the Saturday report');
});

test('the Saturday report on Today: all week for whoever sends it, for an admin from Friday’s reminder', async () => {
  const { env } = await world();
  await duty.saveDuty(env, { on: true, accountId: 3 }, OWNER);
  const card = async (who, when) => (await today(env, who, { now: Date.parse(when) })).duty;
  let c = await card(SAM, '2026-10-28T09:00:00Z');
  assert.deepEqual([c.mine, c.stage, c.from, c.to, c.due, c.dock, c.amount], [true, 'ahead', '2026-10-26', '2026-10-30', '2026-10-31T10:00:00.000Z', '2026-10-31T14:00:00.000Z', 5000]);
  assert.equal(await card(OWNER, '2026-10-28T09:00:00Z'), null, 'an admin is not shown it midweek');
  assert.equal((await card(SAM, '2026-10-30T18:00:00Z')).stage, 'soon');
  c = await card(OWNER, '2026-10-30T18:00:00Z');
  assert.deepEqual([c.mine, c.who, c.stage], [false, 'Sam Test', 'soon']);
  assert.equal((await card(SAM, '2026-10-31T11:00:00Z')).stage, 'late');
  await duty.recordSent(env, { key: '2026-10-26', at: '2026-10-31T09:41:00Z', by: 'Sam Test' });
  assert.equal((await card(SAM, '2026-10-31T11:00:00Z')).stage, 'sent');
  assert.equal(await card(OWNER, '2026-10-31T11:00:00Z'), null, 'sent: nothing for an admin to watch');
  // The next week, last week's send is on Sam's week box.
  const t = await today(env, SAM, { now: Date.parse('2026-11-03T08:00:00Z') });
  assert.equal(t.week.report.sent.at, '2026-10-31T09:41:00Z');
});

test('an admin’s Today has their own to-dos too, and nothing sent up', async () => {
  const { env } = await world();
  const t = await today(env, OWNER, { now: SAT });
  assert.deepEqual(t.items.filter((x) => x.area === 'given').map((x) => [x.title, x.when, x.from]), [['Not Sam’s', 'overdue', 'Sam Test']]);
  assert.deepEqual(t.waiting, []);
  assert.equal(t.admin, true);
});

test('placing: by the day it is due; without one, by how urgent it is', () => {
  const day = '2026-10-31';
  const got = arrange([
    { key: 'a', sev: 'info', due: '2026-11-02' },
    { key: 'b', sev: 'info', due: '2026-10-31' },
    { key: 'c', sev: 'crit' },
    { key: 'd', sev: 'info', age: 9 },
    { key: 'e', sev: 'warn' },
    { key: 'f', sev: 'info' },
    { key: 'g', sev: 'info', due: '2026-10-28' },
  ], day);
  assert.deepEqual(got.map((x) => [x.key, x.when, x.late]), [
    ['g', 'overdue', 3], ['d', 'overdue', 2], ['b', 'today', null], ['c', 'today', null], ['e', 'today', null], ['a', 'later', null], ['f', 'later', null]]);
  assert.deepEqual(doneWords([{ path: '/api/till/check', at: '2026-10-31 08:12:00' }, { path: '/api/x', at: '2026-10-31 08:13:00' }]),
    { lines: [{ what: 'Checked a shift', n: 1, at: '08:12' }], other: 1 });
});

test('their Maintenance jobs and Team Tasks on Today, with Done sent to the app as them', async () => {
  const { env } = await world();
  const assistant = await import('../src/routes/assistant.js');
  env.MAINTENANCE_APPROVALS_URL = 'https://mx.example.test/functions/v1/approvals';
  env.SSO_SECRET_MAINTENANCE = 'test-secret';
  const asked = [];
  const J = 'aaaaaaaa-0000-0000-0000-000000000001';
  const T = 'bbbbbbbb-0000-0000-0000-000000000001';
  const R = 'bbbbbbbb-0000-0000-0000-000000000002';
  const had = assistant.io.fetch;
  assistant.io.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url, body, signed: Boolean(init.headers['X-Till-Sig'] || init.headers['x-till-sig']) });
    if (body.action === 'list') {
      return Response.json({ ok: true, items: [
        { system: 'maintenance', id: J, title: 'Plumbing — R1', why: 'Tap drips', due: '2026-10-30', urgent: true, at: '2026-10-29T09:00:00Z', canDone: true, link: `https://tasks.example.test/maintenance/?task=${J}` },
        { system: 'teamtasks', id: T, title: 'Send the stock sheet', due: '2026-11-03', from: 'Ama Test', at: '2026-10-30T09:00:00Z', canDone: true, link: `https://tasks.example.test/teamtasks/?task=${T}` },
        { system: 'teamtasks', id: R, title: 'Weekly fridge check', due: '2026-10-31', canDone: false, whyNot: 'It repeats: tick it in Team Tasks, which sets the next one.', link: `https://tasks.example.test/teamtasks/?task=${R}` },
      ] });
    }
    return Response.json({ ok: true, said: 'Done in Team Tasks' });
  };
  try {
    const t = await today(env, SAM, { now: SAT });
    assert.equal(asked[0].url, 'https://mx.example.test/functions/v1/tasks', 'next to the approvals function');
    assert.deepEqual([asked[0].body, asked[0].signed], [{ action: 'list', email: 'sam@example.test' }, true]);
    const by = (k) => t.items.find((x) => x.key === k);
    const job = by(`app:maintenance:${J}`);
    assert.deepEqual([job.area, job.tag, job.when, job.late, job.sev], ['maintenance', 'Maintenance', 'overdue', 1, 'warn']);
    assert.deepEqual(job.actions.map((a) => a.label), ['Done', 'Open in Maintenance']);
    const task = by(`app:teamtasks:${T}`);
    assert.deepEqual([task.area, task.from, task.when], ['teamtasks', 'Ama Test', 'later']);
    const rep = by(`app:teamtasks:${R}`);
    assert.deepEqual(rep.actions.map((a) => [a.label, a.primary]), [['Open in Team Tasks', true]], 'a repeating one is opened, not done');
    assert.equal(rep.blocked, 'It repeats: tick it in Team Tasks, which sets the next one.');
    assert.equal(t.areas.teamtasks, 2);

    const out = await assistant.appDone(env, { system: 'teamtasks', id: T }, SAM);
    assert.deepEqual(out, { ok: true, said: 'Done in Team Tasks' });
    assert.deepEqual(asked.at(-1).body, { action: 'done', email: 'sam@example.test', system: 'teamtasks', id: T }, 'as the person, by their email');
    await assert.rejects(assistant.appDone(env, { system: 'other', id: T }, SAM), /Which app/);
    await assert.rejects(assistant.appDone(env, { system: 'teamtasks', id: 'x' }, SAM), /Which one/);
    await assert.rejects(assistant.appDone({ DB: env.DB }, { system: 'teamtasks', id: T }, SAM), /not linked/);
  } finally { assistant.io.fetch = had; }
  // Not linked: not asked at all.
  asked.length = 0;
  await today({ DB: env.DB }, SAM, { now: SAT });
  assert.equal(asked.length, 0);
});

test('somebody’s own answers in HIVE are not theirs to decide: they are on their list as sent up', async () => {
  const { env } = await world();
  const { raw: hraw, db: hdb } = freshDb('../migrations');
  hraw.exec(`INSERT INTO users (id, name, role, active, email) VALUES (8, 'Kofi Test', 'staff', 1, 'kofi@example.test'), (9, 'Sam Test', 'staff', 1, 'SAM@example.test');
    INSERT INTO till_answer (key, user_id, how, text, at) VALUES
      ('drawer:2026-10-27:morning', 8, 'explain', 'A guest paid by MoMo.', '2026-10-28 09:00:00'),
      ('drawer:2026-10-29:night', 9, 'explain', 'An expense of 1125 was moved twice.', '2026-10-30 09:00:00')`);
  env.ATT_DB = hdb;
  const t = await today(env, SAM, { now: SAT });
  const decide = t.items.filter((x) => x.key.startsWith('staffanswer:')).map((x) => x.title);
  assert.deepEqual(decide, ['Kofi Test answered: “A guest paid by MoMo.”'], 'Kofi’s to decide; Sam’s own not');
  assert.deepEqual(t.waiting.map((w) => [w.title, w.why]), [
    ['Your answer in HIVE: “An expense of 1125 was moved twice.”', 'Thu 29 Oct night'],
    ['Answered “Explained”', 'The drawer count, Wed 28 Oct morning · by Sam Test'],
  ], 'their own answer waiting for a decision, and what they sent up, oldest first');
});

test('a warning when somebody’s emails do not match Maintenance or Team Tasks', async () => {
  const { env, raw } = await world();
  const assistant = await import('../src/routes/assistant.js');
  env.MAINTENANCE_APPROVALS_URL = 'https://mx.example.test/functions/v1/approvals';
  env.SSO_SECRET_MAINTENANCE = 'test-secret';
  raw.exec("INSERT INTO accounts (id, email, name, active, is_owner) VALUES (4, 'kofi@example.test', 'Kofi Test', 1, 0), (5, '', 'Efua Test', 1, 0); INSERT INTO account_access (account_id, system_id, role) VALUES (4, 'insight', 'supervisor'), (5, 'insight', 'supervisor')");
  const people = [
    { app: 'maintenance', name: 'Sam Test', email: 'sam@example.test' },
    { app: 'teamtasks', name: 'Sam Kwame Test', email: 'sam.test@other.test' },
    { app: 'teamtasks', name: 'Kofi Test', email: 'kofi@example.test' },
    { app: 'teamtasks', name: 'Efua Test', email: 'efua@example.test' },
    { app: 'maintenance', name: 'Ama Test', email: 'ama@example.test' },
  ];
  const had = assistant.io.fetch;
  assistant.io.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'people') return Response.json({ ok: true, people });
    return Response.json({ ok: true, items: [], found: { maintenance: body.email === 'sam@example.test' || body.email === 'ama@example.test', teamtasks: body.email === 'kofi@example.test' } });
  };
  try {
    // Sam: found in Maintenance; in Team Tasks somebody of his name has another email.
    let t = await today(env, SAM, { now: SAT });
    const mine = t.items.find((x) => x.key === 'emails:teamtasks');
    assert.deepEqual([mine.title, mine.why, mine.when, mine.area], ['Your email doesn’t match Team Tasks',
      'Insight has sam@example.test; Team Tasks has sa•••@other.test. Your Team Tasks tasks can’t show here until they are the same.', 'today', 'people']);
    assert.equal(t.items.some((x) => x.key === 'emails:maintenance'), false, 'matched there');
    // An admin: everybody's, with both addresses.
    t = await today(env, OWNER, { now: SAT });
    const all = t.items.filter((x) => x.key.startsWith('emails:')).map((x) => [x.title, x.why]);
    assert.deepEqual(all, [
      ['Efua Test’s email doesn’t match Team Tasks', 'Insight: no email · Team Tasks: Efua Test efua@example.test'],
      ['Sam Test’s email doesn’t match Team Tasks', 'Insight: sam@example.test · Team Tasks: Sam Kwame Test sam.test@other.test'],
    ], 'Kofi matches; Ama is not in Insight; nobody of Ama Test’s (the owner’s) name in Team Tasks');
  } finally { assistant.io.fetch = had; }
  assert.equal(assistant.sameName('Godfred', 'Godfred Mensah'), true);
  assert.equal(assistant.sameName('Ama Test', 'Ama B. Test'), true);
  assert.equal(assistant.sameName('Ama Test', 'Ama Other'), false);
});
