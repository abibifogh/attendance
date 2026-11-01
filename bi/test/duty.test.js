import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as duty from '../src/routes/duty.js';

/**
 * What supervisors are held to: the 07:00 digest of what waits on them, with
 * the admins copied, and the Saturday management report, with its reminders,
 * late notices and the bonus deduction in HIVE. Everybody is invented.
 */

const OWNER = { id: 1, name: 'Test Owner', isOwner: true, access: [] };
const KOFI = { id: 21, name: 'Kofi Test', access: [{ systemId: 'insight', role: 'supervisor' }] };
const AMA = { id: 22, name: 'Ama Test', access: [{ systemId: 'insight', role: 'supervisor' }] };
const at = (s) => Date.parse(s);
// Friday 6 and Saturday 7 November 2026; the week is Monday 2 to Friday 6.
const WEEK = '2026-11-02';

function setUp({ failDock = false } = {}) {
  const { db, raw } = freshDb();
  raw.exec(`INSERT INTO accounts (id, email, name, active, is_owner) VALUES (1, 'owner@example.test', 'Test Owner', 1, 1),
      (21, 'kofi@example.test', 'Kofi Test', 1, 0), (22, 'ama@example.test', 'Ama Test', 1, 0), (23, '', 'Esi Test', 1, 0);
    INSERT INTO account_access (account_id, system_id, role) VALUES (21, 'insight', 'supervisor'), (22, 'insight', 'supervisor'), (23, 'insight', 'supervisor');`);
  const sent = [];
  const fetchImpl = async (req) => {
    const path = new URL(req.url).pathname;
    const body = await req.json();
    sent.push({ path, body });
    if (path === '/api/link/pay/dock') {
      if (failDock) return new Response(JSON.stringify({ error: 'HIVE is down' }), { status: 503 });
      return Response.json({ ok: true, name: 'Kofi Test', id: 9, month: '2026-11' });
    }
    return Response.json({ ok: true });
  };
  return { env: { DB: db, HIVE: { fetch: fetchImpl }, SSO_SECRET_ATTENDANCE: 'test-secret' }, raw, sent };
}

test('an admin chooses who sends the Saturday report; it is shared with them; only they may send it to everybody, this week', async () => {
  const { env, raw } = setUp();
  await assert.rejects(duty.saveDuty(env, { on: true, accountId: 21 }, KOFI), /admin/i);
  await assert.rejects(duty.saveDuty(env, { on: true }, OWNER), /Choose the supervisor/);
  await assert.rejects(duty.saveDuty(env, { accountId: 99 }, OWNER), /one of the supervisors/);
  await assert.rejects(duty.saveDuty(env, { on: true, accountId: 23 }, OWNER), /no email address/);
  const v = await duty.saveDuty(env, { on: true, accountId: 21 }, OWNER);
  assert.deepEqual([v.on, v.accountId, v.amount, v.digest], [true, 21, 5000, true]);
  assert.deepEqual(v.supervisors.map((p) => p.name), ['Ama Test', 'Esi Test', 'Kofi Test']);
  assert.ok(raw.prepare("SELECT 1 FROM report_access WHERE account_id = 21 AND report = 'management'").get(), 'the report is shared with them');

  const friday = at('2026-11-06T15:00:00Z');
  assert.equal(await duty.maySendToEverybody(env, KOFI, { period: 'week', at: WEEK }, { now: friday }), true);
  assert.equal(await duty.maySendToEverybody(env, KOFI, { period: 'week', at: '2026-10-26' }, { now: friday }), false, 'not another week');
  assert.equal(await duty.maySendToEverybody(env, KOFI, { period: 'month', at: '2026-11' }, { now: friday }), false);
  assert.equal(await duty.maySendToEverybody(env, AMA, { period: 'week', at: WEEK }, { now: friday }), false, 'not another supervisor');
  const mine = await duty.dutyMine(env, KOFI, { now: friday });
  assert.deepEqual([mine.mine, mine.key, mine.due, mine.sent], [true, WEEK, '2026-11-07T10:00:00Z', null]);
});

test('the morning digest: each supervisor’s own list, the admins copied; nothing waiting, nothing sent', async () => {
  const { env, raw, sent } = setUp();
  raw.exec(`INSERT INTO money_todo (key, kind, ref, day, amount, assignee_id, assignee_name, state, sent_back, opened_at) VALUES
    ('nopo:1', 'nopo', 'B001', '2026-11-01', 50000, 21, 'Kofi Test', 'open', 'Which shift?', '2026-11-02 08:00:00')`);
  const out = await duty.sendDigests(env, { now: at('2026-11-05T07:00:00Z') });
  assert.equal(out.sent, 1);
  assert.deepEqual(out.quiet, ['Ama Test'], 'Ama has nothing waiting');
  assert.deepEqual(out.failed, ['Esi Test: no email address']);
  const mail = sent.find((x) => x.path === '/api/link/mail').body;
  assert.equal(mail.to, 'kofi@example.test');
  assert.deepEqual(mail.cc, ['owner@example.test']);
  assert.equal(mail.subject, 'Your table this morning: 1 thing, 1 first');
  assert.match(mail.html, /1 to-do sent back to you/);
  assert.equal(mail.kind, 'insight_digest');

  await duty.saveDuty(env, { digest: false }, OWNER);
  assert.equal((await duty.sendDigests(env, { now: at('2026-11-06T07:00:00Z') })).reason, 'switched off');
});

test('the Saturday report: reminded Friday and Saturday, late notices with the admins copied, then GH₵50 off their bonus, each once', async () => {
  const { env, sent } = setUp();
  await duty.saveDuty(env, { on: true, accountId: 21 }, OWNER);
  const step = async (when) => {
    sent.length = 0;
    const out = await duty.saturdayDue(env, { now: at(when) });
    return { out, mail: sent.find((x) => x.path === '/api/link/mail')?.body, dock: sent.find((x) => x.path === '/api/link/pay/dock')?.body };
  };
  assert.equal((await step('2026-11-06T15:00:00Z')).out.step, null, 'nothing at 15:00 on Friday');

  let s = await step('2026-11-06T17:00:00Z');
  assert.equal(s.out.step, 'friday');
  assert.equal(s.mail.subject, 'Tomorrow by 10:00: the management report');
  assert.deepEqual(s.mail.cc, [], 'a reminder is theirs alone');
  assert.equal((await step('2026-11-06T17:00:00Z')).out.reason, 'already done', 'the same hour twice sends once');

  s = await step('2026-11-07T09:00:00Z');
  assert.equal(s.mail.subject, 'Due at 10:00 today: the management report');
  s = await step('2026-11-07T10:00:00Z');
  assert.equal(s.mail.subject, 'Late: the management report was due at 10:00');
  assert.deepEqual(s.mail.cc, ['owner@example.test'], 'late: the admins copied');
  assert.match(s.mail.text, /GH₵50\.00 comes off your bonus/);
  s = await step('2026-11-07T12:00:00Z');
  assert.equal(s.mail.subject, 'Still not sent: the management report');

  s = await step('2026-11-07T14:00:00Z');
  assert.deepEqual([s.dock.email, s.dock.amount, s.dock.key], ['kofi@example.test', 5000, `mgmt-late:${WEEK}`]);
  assert.match(s.dock.reason, /not sent by 14:00 on 2026-11-07, more than four hours late/);
  assert.equal(s.mail.subject, 'GH₵50.00 off your bonus: the management report is over four hours late');
  assert.deepEqual(s.mail.cc, ['owner@example.test']);
  assert.match(s.mail.text, /off your November bonus in HIVE/);
  s = await step('2026-11-07T15:00:00Z');
  assert.equal(s.dock, undefined, 'taken once');
  const view = await duty.dutyView(env, OWNER);
  assert.deepEqual([view.weeks[0].key, view.weeks[0].docked.amount, view.weeks[0].who], [WEEK, 5000, 'Kofi Test']);
});

test('sent in time, nothing more; sent late but within four hours, no deduction; HIVE down at 14:00, asked again the next hour', async () => {
  let { env, sent } = setUp();
  await duty.saveDuty(env, { on: true, accountId: 21 }, OWNER);
  await duty.recordSent(env, { key: WEEK, at: '2026-11-07T09:40:00Z', by: 'Kofi Test' });
  for (const h of ['2026-11-07T10:00:00Z', '2026-11-07T14:00:00Z']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await duty.saturdayDue(env, { now: at(h) })).reason, 'sent');
  }
  assert.equal(sent.length, 0);
  assert.equal((await duty.recordSent(env, { key: WEEK, at: '2026-11-07T11:00:00Z', by: 'Somebody Else' })).sent.by, 'Kofi Test', 'the first send counts');

  ({ env, sent } = setUp());
  await duty.saveDuty(env, { on: true, accountId: 21 }, OWNER);
  await duty.saturdayDue(env, { now: at('2026-11-07T10:00:00Z') });
  await duty.recordSent(env, { key: WEEK, at: '2026-11-07T11:30:00Z', by: 'Kofi Test' });
  sent.length = 0;
  assert.equal((await duty.saturdayDue(env, { now: at('2026-11-07T14:00:00Z') })).reason, 'sent');
  assert.equal(sent.length, 0, 'late, but not four hours late');

  ({ env, sent } = setUp({ failDock: true }));
  await duty.saveDuty(env, { on: true, accountId: 21 }, OWNER);
  await assert.rejects(duty.saturdayDue(env, { now: at('2026-11-07T14:00:00Z') }), /HIVE is down/);
  assert.equal(sent.filter((x) => x.path === '/api/link/mail').length, 0, 'nobody told of a deduction that did not happen');
  assert.equal(duty.stepAt(at('2026-11-07T15:00:00Z')).step, 'dock', 'asked again at 15:00');
  assert.equal(duty.stepAt(at('2026-11-08T14:00:00Z')), null, 'Sunday: nothing');
});

test('off, nothing at all', async () => {
  const { env, sent } = setUp();
  await duty.saveDuty(env, { accountId: 21 }, OWNER);
  assert.equal((await duty.saturdayDue(env, { now: at('2026-11-07T14:00:00Z') })).done, false);
  assert.equal(sent.length, 0);
});
