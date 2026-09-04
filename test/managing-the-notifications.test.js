import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getNotifications, updateNotifications, whoCanBeReached } from '../src/routes/admin.js';
import { createNotice, listNotices } from '../src/lib/notices.js';
import {
  CHANNELS_KEY, KINDS, goesOut, notTurnedOff, readChannels, tidyChannels,
} from '../src/lib/notice-kinds.js';

/**
 * Managing the notifications.
 *
 * They had grown up one at a time, each with its own judgement baked in about
 * whether it was worth a phone buzzing, and the only way to see the whole set
 * was to read the source. A property that cannot see what it sends cannot
 * decide what it sends, and the two ways that ends are both bad: nothing is
 * ever turned off, or somebody turns the lot off.
 *
 * What is pinned down here is that a switch actually stops the sending, that
 * the bell keeps its record either way, and that only the offs are stored so
 * tomorrow's default is not frozen by today's Save.
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

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
async function realKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { p256dh: b64(new Uint8Array(raw)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
}
let KEYS = null;

async function setup() {
  KEYS = KEYS ?? await realKeys();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;');
  raw.prepare("INSERT INTO users (id, name, role, active) VALUES (7, 'Ama', 'staff', 1)").run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Ama', '2020-01-01')`,
  ).run();
  raw.prepare('UPDATE users SET staff_id = 1 WHERE id = 7').run();
  raw.prepare('INSERT INTO hr_profile (staff_id, personal_phone) VALUES (1, ?)')
    .run('0241234567');
  // Somebody who signs periods off, so "also send to" has a real person to
  // reach rather than an empty group.
  raw.prepare(
    "INSERT INTO users (id, name, role, active, permissions, email) VALUES (8, 'Yaa', 'manager', 1, ?, ?)",
  ).run(JSON.stringify(['att_signoff']), 'yaa@example.test');
  raw.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (8, 'https://push.example/8', ?, ?)`,
  ).run(KEYS.p256dh, KEYS.auth);
  raw.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (7, 'https://push.example/7', ?, ?)`,
  ).run(KEYS.p256dh, KEYS.auth);
  return { raw, db: d1(raw) };
}

const BOSS = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['users'] };
const ctx = (db, body = null, env = {}) => ({
  db,
  env,
  url: new URL('https://x/api/notifications'),
  session: BOSS,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (r) => r.json();

function pretend() {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('{}', { status: 200 }); };
  return { seen, stop() { globalThis.fetch = real; } };
}

const raise = (db, kind) => createNotice(db, {
  kind, title: 'Something happened', body: 'A body', userId: 7, report: true,
}, { env: {}, executionContext: null });

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test('every kind is named, grouped and says who it goes to', () => {
  assert.ok(KINDS.length >= 30, `only ${KINDS.length} kinds listed`);
  for (const kind of KINDS) {
    assert.ok(kind.label && !kind.label.includes('.'), `${kind.key} needs a readable label`);
    assert.ok(kind.who, `${kind.key} does not say who it goes to`);
    assert.ok(kind.when, `${kind.key} does not say when it fires`);
    assert.ok(kind.ways.length, `${kind.key} has no way out at all`);
    for (const way of kind.ways) {
      assert.ok(['push', 'email', 'text'].includes(way), `${kind.key}: ${way}`);
    }
  }
  // No two rows for one kind, or a screen would draw two sets of switches for
  // it and only one of them would be read.
  const keys = KINDS.map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('anything nobody has touched follows the app’s own default', () => {
  assert.equal(goesOut({}, 'rota.published.mine', 'push'), true);
  assert.equal(goesOut({ 'rota.published.mine': {} }, 'rota.published.mine', 'push'), true);
  assert.equal(goesOut({ 'rota.published.mine': { push: 0 } }, 'rota.published.mine', 'push'), false);
  // And an off for one way says nothing about the others.
  assert.equal(goesOut({ 'rota.published.mine': { push: 0 } }, 'rota.published.mine', 'email'), true);

  // A kind that has never gone out that way stays off until somebody says so.
  assert.equal(goesOut({}, 'attendance.not_clocked_in', 'email'), false);
  assert.equal(goesOut({}, 'attendance.not_clocked_in', 'text'), false);
});

test('a way that was never on can be ticked on, and then it goes out', () => {
  const on = { 'attendance.not_clocked_in': { email: 1, text: 1 } };
  assert.equal(goesOut(on, 'attendance.not_clocked_in', 'email'), true);
  assert.equal(goesOut(on, 'attendance.not_clocked_in', 'text'), true);
  // And the one it always had is untouched by that.
  assert.equal(goesOut(on, 'attendance.not_clocked_in', 'push'), true);
});

test('the raising code may keep quiet but may not overrule a tick', () => {
  // The house rota announcement carries no alert of its own, because the
  // people it is about have already had one. That judgement stands...
  assert.equal(goesOut({}, 'rota.published', 'push', false), false);
  // ...until somebody ticks it on purpose, and then it is their call.
  assert.equal(goesOut({ 'rota.published': { push: 1 } }, 'rota.published', 'push', false), true);
  // A default in the code can never switch something on that the screen says
  // is off, or the screen would be a decoration.
  assert.equal(goesOut({ 'attendance.query': { push: 0 } }, 'attendance.query', 'push', true), false);
});

test('a caller that means to send only asks whether somebody switched it off', () => {
  assert.equal(notTurnedOff({}, 'anything.new', 'text'), true);
  assert.equal(notTurnedOff({ 'anything.new': { text: 0 } }, 'anything.new', 'text'), false);
  assert.equal(notTurnedOff({ 'anything.new': { text: 1 } }, 'anything.new', 'text'), true);
});

test('something new in the code rings a bell and does not spend money', () => {
  assert.equal(goesOut({}, 'not.in.the.catalogue', 'push'), true);
  assert.equal(goesOut({}, 'not.in.the.catalogue', 'email'), true);
  assert.equal(goesOut({}, 'not.in.the.catalogue', 'text'), false);
});

test('only a disagreement with the default is stored', () => {
  const tidy = tidyChannels({
    // Two agreements and one disagreement: only the disagreement survives.
    'rota.published.mine': { push: 1, email: 0, text: 1 },
    // Everything as it already was, so there is nothing to say about it.
    'attendance.query': { push: 1, email: 1 },
    // A kind the app does not have.
    'not.a.real.kind': { push: 0 },
    // Turning on two that were never on.
    'attendance.not_clocked_in': { push: 1, email: 1, text: 1 },
  });
  assert.deepEqual(tidy, {
    'rota.published.mine': { email: 0 },
    'attendance.not_clocked_in': { email: 1, text: 1 },
  });
});

test('who else it goes to is kept, and only real permissions', () => {
  const tidy = tidyChannels({
    'attendance.leave_asked': { also: ['att_signoff', 'made_up', 'att_signoff'] },
  }, ['att_signoff', 'hr_pay']);
  assert.deepEqual(tidy, { 'attendance.leave_asked': { also: ['att_signoff'] } });
});

test('a broken setting reads as nothing switched off rather than failing', () => {
  assert.deepEqual(readChannels('not json at all'), {});
  assert.deepEqual(readChannels(null), {});
  assert.deepEqual(readChannels(''), {});
  assert.deepEqual(readChannels('[1,2,3]'), {}, 'a list is not a map of switches');
  // And a rubbish setting must not switch anything off on its way past.
  assert.equal(goesOut(readChannels('rubbish'), 'rota.published.mine', 'push'), true);
});

// ---------------------------------------------------------------------------
// A switch that actually switches
// ---------------------------------------------------------------------------

test('turning a kind off stops the alert and keeps the record', async () => {
  const { raw, db } = await setup();

  const spy = pretend();
  let before;
  try { before = await raise(db, 'attendance.query'); } finally { spy.stop(); }
  assert.equal(before.buzzed, 1, 'it buzzes to begin with');

  await updateNotifications(ctx(db, { channels: { 'attendance.query': { push: 0 } } }));

  const spy2 = pretend();
  let after;
  try { after = await raise(db, 'attendance.query'); } finally { spy2.stop(); }

  assert.equal(after.buzzed, 0, 'no alert, and not counted as a failure either');
  assert.equal(spy2.seen.length, 0, 'nothing left the building');
  // The bell still has both, because the list in it is the record of what
  // happened and a record with holes in it is worse than none.
  assert.equal(raw.prepare(
    "SELECT COUNT(*) n FROM app_notices WHERE kind = 'attendance.query'",
  ).get().n, 2);
});

test('one kind switched off leaves every other one alone', async () => {
  const { db } = await setup();
  await updateNotifications(ctx(db, { channels: { 'attendance.query': { push: 0 } } }));

  const spy = pretend();
  let other;
  try { other = await raise(db, 'attendance.leave_asked'); } finally { spy.stop(); }
  assert.equal(other.buzzed, 1);
});

test('saving one tab does not empty the boxes on another', async () => {
  const { db } = await setup();

  // The Setup tab fills these in.
  await updateNotifications(ctx(db, {
    from: 'HIVE <hive@example.test>',
    replyTo: 'someone@example.test',
    senderName: 'HIVE',
    siteUrl: 'https://staff.example.test',
    recipients: ['boss@example.test'],
  }));

  // And the What goes out tab saves, sending nothing but switches. Everything
  // it did not mention has to survive: an endpoint that blanks the From
  // address here is a property whose mail stops arriving on Monday and nobody
  // knows why.
  await updateNotifications(ctx(db, { channels: { 'attendance.query': { push: 0 } } }));

  const out = await read(await getNotifications(ctx(db)));
  assert.equal(out.from, 'HIVE <hive@example.test>');
  assert.equal(out.replyTo, 'someone@example.test');
  assert.equal(out.senderName, 'HIVE');
  assert.equal(out.siteUrl, 'https://staff.example.test');
  assert.deepEqual(out.recipients, ['boss@example.test']);
  assert.deepEqual(out.channels, { 'attendance.query': { push: 0 } });
});

test('saving the email card does not quietly turn the switches back on', async () => {
  const { db } = await setup();
  await updateNotifications(ctx(db, { channels: { 'attendance.query': { push: 0 } } }));
  // The setup tab sends no channels at all, and must leave them as they were.
  await updateNotifications(ctx(db, { from: 'HIVE <a@b.test>' }));

  const out = await read(await getNotifications(ctx(db)));
  assert.deepEqual(out.channels, { 'attendance.query': { push: 0 } });
});

// ---------------------------------------------------------------------------
// Who can be reached
// ---------------------------------------------------------------------------

test('the gaps are counted before the morning they matter', async () => {
  const { raw, db } = await setup();
  // Ama comes with the fixture: a device with alerts on and a mobile number.
  // Esi has neither, and no login either.
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (2, '2', 'Esi', 'Kitchen', '2020-01-01')`,
  ).run();

  const out = await read(await whoCanBeReached(ctx(db)));
  const ama = out.people.find((p) => p.name === 'Ama');
  const esi = out.people.find((p) => p.name === 'Esi');

  assert.equal(ama.devices, 1);
  assert.equal(ama.phone, true);
  assert.equal(ama.email, false);
  assert.equal(ama.ways, 2);
  assert.equal(esi.ways, 0);
  assert.equal(out.unreachable, 1, 'Esi, and only Esi');
});

test('somebody kept off the rota is not counted as a gap', async () => {
  const { raw, db } = await setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on, on_rota)
     VALUES (3, '3', 'Kojo', '2020-01-01', 0)`,
  ).run();

  const out = await read(await whoCanBeReached(ctx(db)));
  const kojo = out.people.find((p) => p.name === 'Kojo');
  assert.equal(kojo.ways, 0);
  assert.equal(kojo.onRota, false);
  assert.equal(out.unreachable, 0, 'not on the rota, so not a gap');
});

test('the catalogue and the switches come back together', async () => {
  const { db } = await setup();
  const out = await read(await getNotifications(ctx(db)));
  assert.equal(out.kinds.length, KINDS.length);
  assert.ok(out.groups.length >= 5);
  assert.deepEqual(out.channels, {});
  assert.ok(out.kinds.every((k) => out.groups.some((g) => g.key === k.group)),
    'every kind belongs to a group the screen will draw');
});

test('the settings row holds the switches, not forty rows', async () => {
  const { raw, db } = await setup();
  await updateNotifications(ctx(db, { channels: { 'attendance.query': { push: 0 } } }));
  const row = raw.prepare('SELECT value FROM settings WHERE key = ?').get(CHANNELS_KEY);
  assert.deepEqual(JSON.parse(row.value), { 'attendance.query': { push: 0 } });
});

// ---------------------------------------------------------------------------
// A tick that was never there before
// ---------------------------------------------------------------------------

test('ticking text on a kind that never texted makes it text', async () => {
  const { raw, db } = await setup();
  for (const [key, value] of Object.entries({
    sms_enabled: '1', sms_provider: 'arkesel', sms_sender: 'HIVE',
    site_url: 'https://staff.niceoperation.com',
  })) {
    raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  const quiet = pretend();
  try { await raise(db, 'attendance.not_clocked_in'); } finally { quiet.stop(); }
  assert.equal(quiet.seen.filter((u) => u.includes('arkesel')).length, 0,
    'it does not text to begin with');

  await updateNotifications(ctx(db, {
    channels: { 'attendance.not_clocked_in': { text: 1 } },
  }));

  const spy = pretend();
  try {
    await createNotice(db, {
      kind: 'attendance.not_clocked_in',
      title: 'Your shift started at 06:00',
      body: 'Nothing has been recorded for you yet.',
      userId: 7,
      push: true,
      email: false,
    }, { env: { SMS_API_KEY: 'k' }, executionContext: null });
  } finally {
    spy.stop();
  }

  assert.equal(spy.seen.filter((u) => u.includes('arkesel')).length, 1, 'now it does');
  const logged = raw.prepare("SELECT * FROM sms_log WHERE kind = 'attendance.not_clocked_in'").get();
  assert.equal(logged.sent, 1);
});

test('a text carries the notice and fits one segment', async () => {
  const { raw, db } = await setup();
  for (const [key, value] of Object.entries({
    sms_enabled: '1', sms_provider: 'arkesel', sms_sender: 'HIVE',
    site_url: 'https://staff.niceoperation.com',
  })) {
    raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
  await updateNotifications(ctx(db, { channels: { 'attendance.query': { text: 1 } } }));

  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('arkesel')) bodies.push(JSON.parse(options.body));
    return new Response('{}', { status: 200 });
  };
  try {
    await createNotice(db, {
      kind: 'attendance.query',
      title: 'A day is being queried',
      body: 'Kofi disputes Tuesday.',
      userId: 7,
    }, { env: { SMS_API_KEY: 'k' }, executionContext: null });
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(bodies.length, 1);
  const { message } = bodies[0];
  assert.match(message, /A day is being queried/);
  assert.match(message, /staff\.niceoperation\.com/);
  assert.ok(!message.includes('https://'), 'the phone puts that back itself');
  assert.ok(message.length <= 160, `one segment, not ${message.length} characters`);
});

test('unticking a way that was on stops it', async () => {
  const { db } = await setup();
  await updateNotifications(ctx(db, {
    channels: { 'attendance.query': { push: 0 } },
  }));

  const spy = pretend();
  let out;
  try { out = await raise(db, 'attendance.query'); } finally { spy.stop(); }
  assert.equal(out.buzzed, 0);
  assert.equal(spy.seen.length, 0);
});

// ---------------------------------------------------------------------------
// Who else hears about it
// ---------------------------------------------------------------------------

test('a group added to a kind is alerted alongside the person it is about', async () => {
  const { db } = await setup();
  await updateNotifications(ctx(db, {
    channels: { 'attendance.query': { also: ['att_signoff'] } },
  }));

  const spy = pretend();
  try { await raise(db, 'attendance.query'); } finally { spy.stop(); }

  // Ama's own device and Yaa's, which is the whole point: the person it is
  // about keeps it, and the manager is copied in.
  assert.equal(spy.seen.filter((u) => u.includes('push.example/8')).length, 1, 'Yaa');
});

test('and it reaches their bell too', async () => {
  const { db } = await setup();
  await updateNotifications(ctx(db, {
    channels: { 'attendance.query': { also: ['att_signoff'] } },
  }));

  const spy = pretend();
  try { await raise(db, 'attendance.query'); } finally { spy.stop(); }

  const hers = await listNotices(db, 8, 20, ['att_signoff']);
  assert.equal(hers.notices.length, 1, 'a notice addressed to somebody else entirely');
  assert.equal(hers.notices[0].kind, 'attendance.query');
});

test('somebody outside the group still sees nothing', async () => {
  const { db } = await setup();
  await updateNotifications(ctx(db, {
    channels: { 'attendance.query': { also: ['att_signoff'] } },
  }));

  const spy = pretend();
  try { await raise(db, 'attendance.query'); } finally { spy.stop(); }

  const theirs = await listNotices(db, 99, 20, ['att_view']);
  assert.equal(theirs.notices.length, 0);
});

test('the person it is about is never taken off it', async () => {
  const { db } = await setup();
  await updateNotifications(ctx(db, {
    channels: { 'attendance.query': { also: ['att_signoff'] } },
  }));

  const spy = pretend();
  try { await raise(db, 'attendance.query'); } finally { spy.stop(); }

  const mine = await listNotices(db, 7, 20, ['att_me']);
  assert.equal(mine.notices.length, 1);
});

test('what was added is written on the notice, not looked up later', async () => {
  const { raw, db } = await setup();
  await updateNotifications(ctx(db, {
    channels: { 'attendance.query': { also: ['att_signoff'] } },
  }));

  const spy = pretend();
  try { await raise(db, 'attendance.query'); } finally { spy.stop(); }

  // Taken off again afterwards. What somebody was already told about must not
  // vanish out of their bell because a setting moved.
  await updateNotifications(ctx(db, { channels: { 'attendance.query': {} } }));

  const row = raw.prepare("SELECT also FROM app_notices WHERE kind = 'attendance.query'").get();
  assert.deepEqual(JSON.parse(row.also), ['att_signoff']);
  const hers = await listNotices(db, 8, 20, ['att_signoff']);
  assert.equal(hers.notices.length, 1);
});
