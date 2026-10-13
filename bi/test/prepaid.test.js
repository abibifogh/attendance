import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import {
  reservationOf, viaOf, totalsOf, prepaidView, csvOf, saveMailSettings, sendSummary, lastOf, shiftMonth, coverageOf,
} from '../src/routes/prepaid.js';
import { verifyLink } from '../src/lib/link.js';

const LINK = 'link-secret';
const night = (date, amount = 45000, code = '121', name = 'Double Room') => ({ date, code, name, amount });
const pay = (method, label, amount, date) => ({ method, label, amount, date });

async function loaded() {
  const { db, raw } = freshDb();
  const insert = raw.prepare("INSERT INTO assd_entry (seq, kind, staff, day, register, data, loaded_at) VALUES (?, 'Reservation', ?, ?, '001', ?, '2026-10-01')");
  const add = (seq, day, ref, charges, payments) => insert.run(seq, 'ALPHA', day, JSON.stringify({ ref, charges, payments }));
  // September: one prepaid in full by bank, one part by card online, one at the desk.
  add(1, '2026-09-04', '70412-60412', [night('2026-09-01'), night('2026-09-02'), night('2026-09-03')], [pay('prepaid', 'PRE-BANBANK PREPAID', 135000, '2026-09-01')]);
  add(2, '2026-09-09', '70455-60455', [night('2026-09-05', 90000), night('2026-09-06', 90000)], [pay('prepaid', 'PREPAID CC PREPAID', 90000, '2026-09-05'), pay('card', 'CR. CREDIT CARD', 90000, '2026-09-07')]);
  add(3, '2026-09-21', '70470-60470', [night('2026-09-20')], [pay('cash', 'CASH', 40000, '2026-09-21')]);
  // August, for the month before.
  add(4, '2026-08-11', '70300-60300', [night('2026-08-10')], [pay('prepaid', 'PRE-BANBANK PREPAID', 45000, '2026-08-10')]);
  return { db, raw, env: { DB: db, SSO_SECRET_ATTENDANCE: LINK } };
}

test('a reservation: its nights, what was prepaid and how, and what was paid at the desk', () => {
  assert.equal(viaOf('PRE-BANBANK PREPAID'), 'bank');
  assert.equal(viaOf('PREPAID CC PREPAID'), 'online');
  const r = reservationOf({ seq: 2, staff: 'ALPHA', day: '2026-09-09', data: JSON.stringify({
    ref: 'X', charges: [night('2026-09-05', 90000), night('2026-09-06', 90000), { date: '2026-09-06', code: '718', name: 'Water', amount: 1000 }],
    payments: [pay('prepaid', 'PREPAID CC PREPAID', 90000, '2026-09-05'), pay('cash', 'CASH', 1000, '2026-09-07')],
  }) });
  assert.deepEqual([r.arrival, r.checkout, r.nights, r.charged], ['2026-09-05', '2026-09-07', 2, 181000]);
  assert.deepEqual([r.prepaid.online, r.prepaid.bank, r.desk.cash, r.balance, r.status], [90000, 0, 1000, 90000, 'part']);
  assert.equal(lastOf('2026-02'), '2026-02-28');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});

test('a month of stays by arrival, its totals and the six months to it', async () => {
  const { env } = await loaded();
  const out = await prepaidView(env, { month: '2026-09' });
  assert.deepEqual(out.reservations.map((r) => [r.ref, r.status]), [['70412-60412', 'full'], ['70455-60455', 'part'], ['70470-60470', 'none']]);
  const t = out.totals;
  assert.deepEqual([t.count, t.charged, t.prepaid, t.bank, t.online, t.desk, t.full, t.part, t.none], [3, 360000, 225000, 135000, 90000, 130000, 1, 1, 1]);
  assert.equal(t.owing, 5000, 'the desk stay paid GH₵400 of GH₵450');
  assert.equal(t.share, 225000 / 360000);
  assert.deepEqual(out.months.map((m) => m.month), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(out.months[4].prepaid, 45000);
  const csv = csvOf(out.reservations).split('\r\n');
  assert.match(csv[0], /^Reservation,ASSD number,Rooms,Arrival/);
  assert.match(csv[1], /^70412-60412,1,Double Room,2026-09-01,2026-09-04,3,1350\.00,1350\.00,0\.00,1350\.00,0\.00,0\.00,Prepaid in full/);
  assert.equal(totalsOf([]).share, null);
});

const journal = (raw, from, to) => raw.prepare("INSERT INTO shift_upload (kind, name, from_day, to_day, rows, at) VALUES ('journal', 'j.pdf', ?, ?, 10, '2026-10-01')").run(from, to);

function hive() {
  const calls = [];
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const text = await request.text();
    assert.ok(await verifyLink(LINK, { at: request.headers.get('X-Till-At'), sig: request.headers.get('X-Till-Sig'), path: url.pathname, bodyText: text }));
    calls.push([url.pathname, JSON.parse(text)]);
    return Response.json({ ok: true });
  };
  return { calls, fetchImpl };
}

test('a month is complete only when the journals cover every day of it', async () => {
  const { env, raw } = await loaded();
  assert.deepEqual(await coverageOf(env, '2026-09'), { complete: false, within: [], through: null, loaded: null });
  journal(raw, '2026-08-25', '2026-09-12');
  journal(raw, '2026-09-14', '2026-10-02');
  let c = await coverageOf(env, '2026-09');
  assert.deepEqual([c.complete, c.through], [false, '2026-09-12'], 'the 13th is missing');
  assert.deepEqual(c.within, [{ from: '2026-09-01', to: '2026-09-12' }, { from: '2026-09-14', to: '2026-09-30' }]);
  journal(raw, '2026-09-12', '2026-09-20');
  c = await coverageOf(env, '2026-09');
  assert.deepEqual([c.complete, c.through], [true, '2026-09-30']);
});

test('who gets the summary: real addresses only, and the 5th sends each month once, with the CSV', async () => {
  const { env, raw } = await loaded();
  journal(raw, '2026-08-01', '2026-10-01');
  await assert.rejects(saveMailSettings(env, { emails: ['not an address'] }), /not an email address/);
  const saved = await saveMailSettings(env, { emails: ['Accounts@Example.test', 'gm@example.test', 'gm@example.test'] }, { origin: 'https://insight.example.test' });
  assert.deepEqual(saved.emails, ['accounts@example.test', 'gm@example.test']);

  const { calls, fetchImpl } = hive();
  const now = new Date('2026-10-05T06:45:00Z');
  const out = await sendSummary(env, { auto: true, fetchImpl, now });
  assert.deepEqual([out.sent, out.month], [2, '2026-09']);
  assert.deepEqual(calls.map(([p, b]) => [p, b.to]), [['/api/link/mail', 'accounts@example.test'], ['/api/link/mail', 'gm@example.test']]);
  const mail = calls[0][1];
  assert.match(mail.subject, /^Prepaid stays, September 2026: GH₵2,250\.00 \(62\.5%\)$/);
  assert.match(mail.html, /70455-60455/);
  assert.doesNotMatch(mail.html, /70470-60470/, 'the email lists the prepaid ones; the CSV has them all');
  assert.match(mail.html, /https:\/\/insight\.example\.test\/#\/prepaid\?month=2026-09/);
  assert.equal(mail.attachments[0].filename, 'prepaid-stays-2026-09.csv');
  assert.match(atob(mail.attachments[0].content), /70470-60470/);

  const again = await sendSummary(env, { auto: true, fetchImpl, now });
  assert.equal(again.sent, 0, 'not twice for the same month');
  const mine = await sendSummary(env, { fetchImpl, now, to: 'me@example.test', month: '2026-09' });
  assert.equal(mine.sent, 1, 'trying it, to yourself, always goes');
  const byHand = await sendSummary(env, { fetchImpl, now, month: '2026-09' });
  assert.equal(byHand.sent, 2, 'an admin can send it to everyone again by hand');
});

test('a month the journals do not cover whole is held on the 5th, the admins asked once, and sent by hand', async () => {
  const { env, raw } = await loaded();
  journal(raw, '2026-08-01', '2026-09-27');
  raw.exec(`INSERT INTO accounts (email, name, is_owner, active) VALUES ('owner@example.test', 'Owner', 1, 1), ('sup@example.test', 'Sup', 0, 1);
    INSERT INTO account_access (account_id, system_id, role) VALUES (2, 'insight', 'supervisor');`);
  await saveMailSettings(env, { emails: ['accounts@example.test'] }, { origin: 'https://insight.example.test' });
  const { calls, fetchImpl } = hive();
  const now = new Date('2026-10-05T06:45:00Z');

  const held = await sendSummary(env, { auto: true, fetchImpl, now });
  assert.deepEqual([held.sent, held.held, held.coverage.through], [0, true, '2026-09-27']);
  assert.deepEqual(calls.map(([, b]) => b.to), ['owner@example.test'], 'only the admins are asked, not the recipients nor a supervisor');
  assert.match(calls[0][1].subject, /September 2026’s prepaid summary is waiting for you/);
  assert.match(calls[0][1].html, /The journals loaded cover 1 Sept? to 27 Sept? only/);
  await sendSummary(env, { auto: true, fetchImpl, now });
  assert.equal(calls.length, 1, 'asked once for the month');
  assert.equal((await prepaidView(env, { month: '2026-09' })).mail.held.month, '2026-09');

  const refused = await sendSummary(env, { fetchImpl, now, month: '2026-09' });
  assert.deepEqual([refused.sent, refused.incomplete], [0, true], 'by hand, the page asks first');
  const sent = await sendSummary(env, { fetchImpl, now, month: '2026-09', anyway: true });
  assert.equal(sent.sent, 1);
  const after = (await prepaidView(env, { month: '2026-09' })).mail;
  assert.deepEqual([after.held, after.lastSent.month, after.lastSent.by], [null, '2026-09', 'by hand']);
});
