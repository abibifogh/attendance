import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { myWeek, tellThemImLate } from '../src/routes/me.js';
import { publishRoster, saveRoster } from '../src/routes/attendance.js';
import { updateSettings } from '../src/routes/attendance-setup.js';
import { watchShifts } from '../src/lib/shift-watch.js';
import { b64urlEncode } from '../src/lib/push.js';

/**
 * The three things a phone in somebody's pocket is for.
 *
 * A balance the property may not want published yet, a countdown that only
 * appears when it changes what somebody does, and the two or three alerts
 * worth interrupting a person for.
 */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => st(sql),
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const shiftDay = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * A shift that started so many minutes ago and runs for eight hours.
 *
 * Returned with the day it belongs to, because a run just after midnight puts
 * "twenty minutes ago" on yesterday — which is the case the watcher itself had
 * wrong, so the test must be able to say which day it means.
 */
function startingAgo(minutes) {
  const at = new Date(Date.now() - minutes * 60000);
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  const ends = new Date(at.getTime() + 8 * 3600000);
  return {
    day: at.toISOString().slice(0, 10),
    starts_at: `${hh}:${mm}`,
    ends_at: `${String(ends.getUTCHours()).padStart(2, '0')}:${String(ends.getUTCMinutes()).padStart(2, '0')}`,
  };
}

/** Put that shift on the rota, published, on the day it actually starts. */
function rosterAgo(raw, minutes) {
  const at = startingAgo(minutes);
  raw.prepare('UPDATE att_shifts SET starts_at = ?, ends_at = ? WHERE id = 1')
    .run(at.starts_at, at.ends_at);
  raw.prepare('INSERT OR REPLACE INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(at.day);
  return at;
}

function setup({ graceIn = 5 } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM app_notices; DELETE FROM push_log;
            DELETE FROM push_subscriptions; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Early', '06:00', '14:00', 0, ?)`,
  ).run(graceIn);
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01')`,
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const KOFI = { user: { id: 7, name: 'Kofi', role: 'staff', staff_id: 1 } };
const ADMIN = {
  user: { id: 2, name: 'Ama', role: 'admin' },
  permissions: ['att_setup', 'att_rota', 'att_manage'],
};

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/x${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

// ---------------------------------------------------------------- balance --

test('the balance is shown by default and withheld when it is turned off', async () => {
  const { db } = setup();

  let out = await (await myWeek(ctx(db, KOFI))).json();
  assert.equal(out.showBalance, true);
  assert.ok(out.balance, 'shown unless somebody turns it off');
  assert.equal(typeof out.balance.remaining, 'number');

  await updateSettings(ctx(db, ADMIN, { body: { att_show_balance: '0' } }));

  out = await (await myWeek(ctx(db, KOFI))).json();
  assert.equal(out.showBalance, false);
  assert.equal(out.balance, null, 'not merely hidden: not in the answer at all');
  assert.ok(!/remaining/.test(JSON.stringify(out)), 'and nowhere else in it either');
});

test('with the balance off they can still ask for leave', async () => {
  const { db } = setup();
  await updateSettings(ctx(db, ADMIN, { body: { att_show_balance: '0' } }));

  const out = await (await myWeek(ctx(db, KOFI))).json();
  assert.ok(Array.isArray(out.reasons) && out.reasons.length, 'the kinds of leave still come');
});

// -------------------------------------------------------------- countdown --

test('the countdown names the next shift and how far off it is', async () => {
  const { db, raw } = setup();
  const tomorrow = shiftDay(today(), 1);
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(tomorrow);

  const out = await (await myWeek(ctx(db, KOFI, { query: `?from=${today()}` }))).json();
  assert.equal(out.next.day, tomorrow);
  assert.equal(out.next.shift.name, 'Early');
  assert.ok(out.next.seconds > 0);
});

test('a shift more than a day off is not a countdown', async () => {
  const { db, raw } = setup();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(shiftDay(today(), 5));

  const out = await (await myWeek(ctx(db, KOFI, { query: `?from=${today()}` }))).json();
  assert.equal(out.next.soon, false, '"in five days" is a calendar, not a countdown');
});

test('an unpublished shift is not counted down to either', async () => {
  const { db } = setup();
  await saveRoster(ctx(db, ADMIN, {
    body: { entries: [{ staffId: 1, day: shiftDay(today(), 1), shiftId: 1 }] },
  }));

  const out = await (await myWeek(ctx(db, KOFI, { query: `?from=${today()}` }))).json();
  assert.equal(out.next, null, 'a draft is not a promise to plan an evening around');
});

// ------------------------------------------------------------------ pushes --

/**
 * A real browser subscription, near enough.
 *
 * A genuine P-256 public point, because the payload is genuinely encrypted on
 * the way out: a made-up key fails inside WebCrypto and the test would then be
 * proving that the plumbing is broken rather than that the message was sent.
 */
async function subscriptionKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: b64urlEncode(raw), auth: b64urlEncode(auth) };
}

/** A subscription for one user, and a fetch that records what would go out. */
async function withPush(raw, { userId = 7, endpoint = 'https://push.example/1' } = {}) {
  const { p256dh, auth } = await subscriptionKeys();
  raw.prepare(
    'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
  ).run(userId, endpoint, p256dh, auth);

  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('', { status: 201 });
  };
  return sent;
}

test('publishing the rota buzzes the phones of the people it is about', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);

  await saveRoster(ctx(db, ADMIN, {
    body: { entries: [{ staffId: 1, day: shiftDay(today(), 2), shiftId: 1 }] },
  }));
  await publishRoster(ctx(db, ADMIN, {
    body: { from: today(), to: shiftDay(today(), 6), notify: 'staff' },
  }));

  assert.ok(sent.some((r) => r.url.startsWith('https://push.example/')), 'a push went out');
  const log = raw.prepare("SELECT * FROM push_log ORDER BY id DESC").get();
  assert.equal(log.status, 'sent');
  assert.equal(log.sent, 1);
});

test('publishing quietly buzzes nobody', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);

  await saveRoster(ctx(db, ADMIN, {
    body: { entries: [{ staffId: 1, day: shiftDay(today(), 2), shiftId: 1 }] },
  }));
  await publishRoster(ctx(db, ADMIN, {
    body: { from: today(), to: shiftDay(today(), 6), notify: 'none' },
  }));

  assert.equal(sent.length, 0, 'quiet means quiet on every channel');
});

test('running late reaches the floor rather than the person who said it', async () => {
  const { db, raw } = setup();
  // Two phones: Kofi's, and a supervisor's. Only one of them should buzz.
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, active) VALUES (8, 'Yaa', 'supervisor', 'y', 1)",
  ).run();
  await withPush(raw, { userId: 7, endpoint: 'https://push.example/kofi' });
  const sent = await withPush(raw, { userId: 8, endpoint: 'https://push.example/floor' });

  await tellThemImLate(ctx(db, KOFI, { body: { minutes: 30 } }));
  assert.deepEqual(sent.map((r) => r.url), ['https://push.example/floor'],
    'the person who pressed it already knows');
});

// ------------------------------------------------------------ shift watch --

test('a started shift with nothing recorded tells that one person', async () => {
  const { db, raw } = setup({ graceIn: 5 });
  const sent = await withPush(raw);
  const on = rosterAgo(raw, 20);

  const first = await watchShifts(db, { timezone: 'UTC' });
  assert.equal(first.nudged, 1);
  assert.equal(sent.length, 1);

  const notice = raw.prepare(
    "SELECT * FROM app_notices WHERE kind = 'attendance.not_clocked_in'",
  ).get();
  assert.equal(notice.user_id, 7, 'to them, and to nobody else');

  // A quarter of an hour later, still inside the same half hour, and it does
  // not say it again.
  const second = await watchShifts(db, { timezone: 'UTC' });
  assert.equal(second.nudged, 0);
  assert.equal(sent.length, 1);
});

test('it waits out the grace the shift already allows', async () => {
  const { db, raw } = setup({ graceIn: 30 });
  const sent = await withPush(raw);
  const on = rosterAgo(raw, 20);

  const out = await watchShifts(db, { timezone: 'UTC' });
  assert.equal(out.nudged, 0, 'twenty minutes into thirty minutes of grace is not late');
  assert.equal(sent.length, 0);
});

test('it keeps going every half hour while the shift is still running', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);
  rosterAgo(raw, 20);

  // Twenty minutes in: the first one.
  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 1);
  // A quarter of an hour later, still inside the same half hour: nothing.
  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 0);

  // Now fifty minutes in, which is the next half hour.
  rosterAgo(raw, 50);
  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 1);
  rosterAgo(raw, 80);
  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 1);

  assert.equal(sent.length, 3, 'three half hours, three messages');
});

test('it stops the moment they clock in', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);
  const on = rosterAgo(raw, 20);
  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 1);

  raw.prepare(
    `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                              direction, dedupe_key)
     VALUES ('D1', '1', 1, ?, ?, ?, 'in', 'k9')`,
  ).run(`${on.day} ${on.starts_at}:00`, `${on.day} ${on.starts_at}:00`, on.day);

  rosterAgo(raw, 50);
  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 0, 'they are here now');
  assert.equal(sent.length, 1);
});

test('it stops when the shift they were down for has ended', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);
  const at = startingAgo(600);
  // Started ten hours ago and only ran for two. There is nothing left to
  // arrive for, and a phone still buzzing about it is an accusation on a timer.
  const ends = new Date(Date.now() - 8 * 3600000);
  raw.prepare('UPDATE att_shifts SET starts_at = ?, ends_at = ? WHERE id = 1').run(
    at.starts_at,
    `${String(ends.getUTCHours()).padStart(2, '0')}:${String(ends.getUTCMinutes()).padStart(2, '0')}`,
  );
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(at.day);

  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 0);
  assert.equal(sent.length, 0);
});

test('somebody who has clocked in is left alone, and so is somebody on leave', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);
  const on = rosterAgo(raw, 20);
  raw.prepare(
    `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                              direction, dedupe_key)
     VALUES ('D1', '1', 1, ?, ?, ?, 'in', 'k1')`,
  ).run(`${on.day} 06:00:00`, `${on.day} 06:00:00`, on.day);

  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 0);

  raw.exec('DELETE FROM att_punches');
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', ?, ?, 1, 'approved')`,
  ).run(on.day, on.day);
  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 0);
  assert.equal(sent.length, 0);
});

test('an unpublished shift is nobody’s fault for not turning up to', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);
  const at = startingAgo(20);
  raw.prepare('UPDATE att_shifts SET starts_at = ?, ends_at = ? WHERE id = 1')
    .run(at.starts_at, at.ends_at);
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 0)')
    .run(at.day);

  assert.equal((await watchShifts(db, { timezone: 'UTC' })).nudged, 0);
  assert.equal(sent.length, 0);
});

test('turning the nudge off turns it off', async () => {
  const { db, raw } = setup();
  const sent = await withPush(raw);
  const on = rosterAgo(raw, 20);
  raw.prepare("UPDATE settings SET value = '0' WHERE key = 'att_late_nudge'").run();

  const out = await watchShifts(db, { timezone: 'UTC' });
  assert.equal(out.nudged, 0);
  assert.equal(out.reason, 'switched off');
  assert.equal(sent.length, 0);
});
