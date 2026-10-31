import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie } from '../src/lib/auth.js';
import { run } from '../src/lib/db.js';
import * as lock from '../src/routes/lock.js';

/** Locked dates. Everybody is invented. */

const OWNER = { name: 'Ola Owner', isOwner: true };

test('a lock: only days that are over, moved back only with a reason, and kept in the history', async () => {
  const { db } = freshDb('migrations');
  const env = { DB: db };
  assert.equal((await lock.lockOf(env)).through, null);
  await assert.rejects(lock.setLock(env, { through: '2999-01-01' }, OWNER), /days that are over/);
  await assert.rejects(lock.setLock(env, { through: 'soon' }, OWNER), /last day to lock/);
  await lock.setLock(env, { through: '2026-08-02', note: 'August reconciled' }, OWNER, { seqThrough: 300541 });
  let l = await lock.lockOf(env);
  assert.deepEqual([l.through, l.seqThrough, l.by, l.note], ['2026-08-02', 300541, 'Ola Owner', 'August reconciled']);
  assert.equal(lock.isLocked(l, '2026-08-02'), true);
  assert.equal(lock.isLocked(l, '2026-08-03'), false);

  await assert.rejects(lock.setLock(env, { through: '2026-08-01' }, OWNER), /Say why/);
  await assert.rejects(lock.setLock(env, { through: null }, OWNER), /Say why/);
  await lock.setLock(env, { through: '2026-08-05' }, OWNER);
  await lock.setLock(env, { through: null, note: 'A late bank statement to load' }, OWNER);
  l = await lock.lockOf(env);
  assert.equal(l.through, null);
  assert.deepEqual(l.history.map((x) => [x.through, x.from]), [[null, '2026-08-05'], ['2026-08-05', '2026-08-02'], ['2026-08-02', null]]);
});

test('the days a change touches: named, by key, by ASSD number, by a reconciliation, a staff-account move or a closing report', async () => {
  const { db } = freshDb('migrations');
  const hive = freshDb('../migrations');
  const env = { DB: db, ATT_DB: hive.db };
  await run(db, "INSERT INTO assd_entry (seq, kind, staff, day, register, data, loaded_at) VALUES (400101, 'Cash Register', 'K', '2026-08-04', '001', '{}', 'now')");
  await run(db, `INSERT INTO shift_link (id, keys, note, by_name, at) VALUES (7, '["drawer:2026-08-06:night","refund:400101:2"]', '', 'x', 'now')`);
  await run(db, "INSERT INTO till_move (id, key, kind, day, slot, amount, shares, reason, at) VALUES (3, 'drawer:2026-08-07:morning', 'drawer-short', '2026-08-07', 'morning', -100, '[]', 'r', 'now')");
  await hive.db.prepare("INSERT INTO till_report (id, day, slot, user_id, name, float_ok, cash, to_safe, at) VALUES (9, '2026-08-08', 'night', 1, 'Kofi Test', 1, 0, 0, 'now')").run().catch(() => null);
  const dayOfKey = async (_env, k) => (/\d{4}-\d{2}-\d{2}/.exec(k) || [])[0] || (k.startsWith('refund:400101') ? '2026-08-04' : null);
  const days = async (body, ids) => (await lock.daysOf(env, body, { dayOfKey, ids })).sort();
  assert.deepEqual(await days({ day: '2026-08-01', toDay: '2026-08-02' }), ['2026-08-01', '2026-08-02']);
  assert.deepEqual(await days({ keys: ['drawer:2026-08-03:morning', 'notpair:laundry:2026-08-05:night|drawer:2026-08-03:morning'] }), ['2026-08-03', '2026-08-05']);
  assert.deepEqual(await days({ answer: 'Explained' }), [], 'an answer’s words are not a key');
  assert.deepEqual(await days({ answer: 'drawer:2026-08-03:morning' }), ['2026-08-03'], 'in an approval it is');
  assert.deepEqual(await days({ seq: 400101 }), ['2026-08-04']);
  assert.deepEqual(await days({ id: 7 }, { link: 'id' }), ['2026-08-04', '2026-08-06']);
  assert.deepEqual(await days({ id: 3 }, { move: 'id' }), ['2026-08-07']);
  assert.deepEqual(await days({ items: [{ day: '2026-08-09', slot: 'day' }] }), ['2026-08-09']);
  const report = await days({ reportId: 9 }, { report: 'reportId' });
  assert.ok(report.length === 0 || report[0] === '2026-08-08');

  await lock.setLock(env, { through: '2026-08-04' }, OWNER);
  await assert.rejects(lock.assertOpen(env, ['2026-08-05', '2026-08-04']), (err) => err.status === 423 && /locked by Ola Owner/.test(err.message));
  await lock.assertOpen(env, ['2026-08-05']);
});

test('files loaded later leave locked days as they were', () => {
  const l = { through: '2026-08-02', seqThrough: 300541 };
  const journal = lock.keepLocked(l, 'journal', [{ seq: 300540, date: '2026-08-02' }, { seq: 300541, date: '2026-08-03' }, { seq: 300542, date: '2026-08-03' }]);
  assert.deepEqual([journal.rows.map((r) => r.seq), journal.left], [[300542], 2], 'the night past midnight goes with its locked shift');
  const card = lock.keepLocked(l, 'terminal', [{ at: '2026-08-02 23:00:00' }, { at: '2026-08-03 05:59:00' }, { at: '2026-08-03 06:00:00' }]);
  assert.deepEqual(card.rows.map((r) => r.at), ['2026-08-03 06:00:00'], 'the locked night runs to six the next morning');
  const bank = lock.keepLocked(l, 'bank', [{ day: '2026-08-02' }, { day: '2026-08-05', cardDay: '2026-08-01' }]);
  assert.deepEqual(bank.rows, [{ day: '2026-08-05', cardDay: '2026-08-01' }], 'a credit for a locked day arriving later still loads');
  assert.deepEqual(lock.keepLocked({ through: null }, 'bank', [{ day: '2026-08-02' }]).left, 0);
});

test('through the front door: an admin locks; nobody changes a locked day, admins included; a supervisor cannot lock', async () => {
  const { db } = freshDb('migrations');
  const env = { DB: db, SESSION_SECRET: 'insight-signing', DASHBOARD_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('x') } };
  await run(db, `INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES
    (1, 'owner@example.test', 'Ola Owner', 1, 1, 'x'), (3, 'sup@example.test', 'Sam Supervisor', 0, 1, 'x')`);
  await run(db, "INSERT INTO account_access (account_id, system_id, role) VALUES (3, 'insight', 'supervisor')");
  const call = async (id, method, path, body) => {
    const cookie = sessionCookie(await createToken(env.SESSION_SECRET, { accountId: id })).split(';')[0];
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const set = await call(1, 'POST', '/api/shifts/lock', { through: '2026-08-02', note: 'August' });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal((await call(1, 'GET', '/api/shifts/lock')).data.through, '2026-08-02');
  assert.equal((await call(3, 'POST', '/api/shifts/lock', { through: null, note: 'x' })).status, 403);

  const refused = await call(1, 'POST', '/api/shifts/answer', { key: 'drawer:2026-08-02:morning', answer: 'Explained' });
  assert.equal(refused.status, 423);
  assert.match(refused.data.error, /locked by Ola Owner/);
  assert.equal((await call(1, 'POST', '/api/shifts/count', { day: '2026-08-01', slot: 'night', closing: '10' })).status, 423);
  assert.equal((await call(1, 'POST', '/api/np/move', { day: '2026-08-05', shift: 'day', toDay: '2026-08-02', toShift: 'night' })).status, 423, 'nor onto a locked day');
  const open = await call(1, 'POST', '/api/shifts/answer', { key: 'drawer:2026-08-03:morning', answer: 'Explained' });
  assert.notEqual(open.status, 423, 'the day after is open');
});

test('a checked shift is locked on its own: by its day and slot, a key naming it, or one of its ASSD lines; unchecked, it opens', async () => {
  const { db } = freshDb('migrations');
  const env = { DB: db };
  const open = (body, ids) => lock.assertShiftsOpen(env, body, { ids });
  await open({ day: '2026-10-01', slot: 'morning' });
  await run(db, "INSERT INTO shift_check (day, slot, by_name, at, snapshot, start_seq, end_seq) VALUES ('2026-10-01', 'morning', 'Ola Owner', 'now', '{}', 216000, 216040)");
  await assert.rejects(open({ day: '2026-10-01', slot: 'morning' }), /morning shift of Thu, 1 Oct 2026 is checked \(Ola Owner\), so it is locked/);
  await assert.rejects(open({ key: 'drawer:2026-10-01:morning', answer: 'Explained' }), /checked/);
  await assert.rejects(open({ keys: ['laundry:2026-10-01:afternoon', 'laundry:2026-10-01:morning'] }), /checked/, 'one of those reconciled together');
  await assert.rejects(open({ key: 'unlabelled:216020' }), /checked/, 'one of its ASSD lines');
  await assert.rejects(open({ fromDay: '2026-10-01', fromSlot: 'morning', day: '2026-09-30', slot: 'night' }), /checked/, 'moving it');
  // The same day's other shifts, and lines outside it, stay open.
  await open({ day: '2026-10-01', slot: 'afternoon' });
  await open({ key: 'drawer:2026-10-01:afternoon' });
  await open({ key: 'unlabelled:216053' });
  await run(db, "DELETE FROM shift_check");
  await open({ day: '2026-10-01', slot: 'morning' });
});
