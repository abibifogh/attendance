import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createNotice, listNotices, markSeen } from '../src/lib/notices.js';
import { TABS, iconFor } from '../public/js/views/notices.js';

/**
 * The bell, and the phone in somebody's pocket.
 *
 * Three things are pinned down here, and all three came from the same
 * complaint: a panel full of things that had happened, none of which had
 * reached anybody.
 *
 * Push used to be opt in, and eighteen kinds of notice never opted. Reading
 * used to happen by opening the panel, so a list of six became a list of none
 * before anybody had dealt with them. And every notice at the ordinary level
 * carried the same mark, which was a bed, because somebody typed one emoji
 * meaning another and nothing was looking.
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
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

/**
 * A subscription with keys a browser would actually have sent.
 *
 * Made-up keys fail inside the encryption before anything is sent, so a test
 * built on those proves only that the code got as far as trying. A real P-256
 * pair gets the message all the way to the endpoint, which is the part worth
 * knowing about.
 */
async function realKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const b64 = (bytes) => Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users; DELETE FROM app_notices; DELETE FROM push_log;');
  raw.prepare(
    "INSERT INTO users (id, name, role, active) VALUES (1, 'Kwame', 'admin', 1)",
  ).run();
  return { raw, db: d1(raw) };
}

/** The device that has said yes, with keys the encryption will accept. */
async function withDevice(raw) {
  const keys = await realKeys();
  raw.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (1, 'https://push.example.test/x', ?, ?)`,
  ).run(keys.p256dh, keys.auth);
}

/** Whatever the push tried to do, said out loud. */
const attempts = (raw) => raw.prepare('SELECT * FROM push_log ORDER BY id').all();

/** Push goes over the network; nothing here should. */
function offline() {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 201 });
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------
// Reaching the phone
// ---------------------------------------------------------------------------

test('a notice reaches the phone without being asked to', async () => {
  const { raw, db } = setup();
  await withDevice(raw);
  const back = offline();
  try {
    await createNotice(db, {
      kind: 'attendance.availability_asked',
      title: 'Stephanie asked about 2 days',
      audience: 'att_rota',
      email: false,
    });
  } finally { back(); }

  const log = attempts(raw);
  assert.equal(log.length, 1, 'it tried');
  assert.equal(log[0].status, 'sent', 'and it got there');
  assert.equal(log[0].sent, 1);
});

test('two of the same kind arrive as two notifications, not one on top of the other', async () => {
  const { raw, db } = setup();
  await withDevice(raw);
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // The body is encrypted on the way out, so what is asserted here is that
    // two sends were two. What the tag says is checked where it is set.
    seen.push(String(url));
    return new Response('', { status: 201 });
  };
  try {
    await createNotice(db, { kind: 'attendance.availability_asked', title: 'Stephanie asked', email: false });
    await createNotice(db, { kind: 'attendance.availability_asked', title: 'Angela asked', email: false });
  } finally { globalThis.fetch = original; }

  assert.equal(seen.length, 2, 'both were sent');

  // A tag is what a phone replaces. Shared by kind, the second of these would
  // rub out the first before anybody read it.
  const source = readFileSync('src/lib/notify.js', 'utf8');
  assert.match(source, /tag: notice\.id \? `notice-\$\{notice\.id\}`/);
});

test('a notice that says not to does not', async () => {
  const { raw, db } = setup();
  await withDevice(raw);
  const back = offline();
  try {
    await createNotice(db, {
      kind: 'att_exceptions',
      title: 'Yesterday: 3 days need confirming',
      email: false,
      push: false,
    });
  } finally { back(); }

  assert.equal(attempts(raw).length, 0);
});

test('the morning digest is not sent to the same phone twice', () => {
  // It has its own push, gated on its own setting, and the notice must not
  // add a second one on top.
  const source = readFileSync('src/routes/attendance.js', 'utf8');
  assert.match(source, /createNotice\(db, \{ \.\.\.notice, push: false \}\)/);
});

// ---------------------------------------------------------------------------
// Read, unread and all
// ---------------------------------------------------------------------------

const ring = (db, n) => createNotice(db, {
  kind: 'attendance.leave_asked', title: `Something ${n}`, email: false, push: false,
});

test('what is unread is what has arrived since the last time somebody said so', async () => {
  const { db } = setup();
  await ring(db, 1);
  await ring(db, 2);

  let seen = await listNotices(db, 1, 20, null);
  assert.equal(seen.unread, 2, 'nothing has been read yet');

  await markSeen(db, 1, seen.latestId);
  await ring(db, 3);

  seen = await listNotices(db, 1, 20, null);
  assert.equal(seen.unread, 1, 'only the one that came after');
  assert.equal(seen.notices.filter((n) => n.unread).length, 1);
  assert.equal(seen.notices.filter((n) => !n.unread).length, 2);
});

test('marking all as read clears the count and fills the other pile', async () => {
  const { db } = setup();
  await ring(db, 1);
  await ring(db, 2);
  await ring(db, 3);

  const before = await listNotices(db, 1, 20, null);
  await markSeen(db, 1, before.latestId);

  const after = await listNotices(db, 1, 20, null);
  assert.equal(after.unread, 0);
  assert.equal(after.notices.filter((n) => !n.unread).length, 3);
});

test('the three tabs split the list and All holds every one of them', async () => {
  const { db } = setup();
  await ring(db, 1);
  await ring(db, 2);
  const first = await listNotices(db, 1, 20, null);
  await markSeen(db, 1, first.notices[first.notices.length - 1].id);
  await ring(db, 3);

  const { notices } = await listNotices(db, 1, 20, null);
  const of = (key) => notices.filter(TABS.find(([k]) => k === key)[2]);

  assert.equal(of('all').length, 3);
  assert.equal(of('unread').length + of('read').length, of('all').length,
    'every notice is in exactly one of the two');
  assert.equal(of('read').length, 1, 'the one acknowledged');
});

// ---------------------------------------------------------------------------
// The mark beside it
// ---------------------------------------------------------------------------

test('the mark says what the notice is about', () => {
  assert.equal(iconFor({ kind: 'recruitment.booked', level: 'info' }), '💼');
  assert.equal(iconFor({ kind: 'attendance.availability_asked', level: 'info' }), '📆');
  assert.equal(iconFor({ kind: 'attendance.leave_decided', level: 'info' }), '🌴');
  assert.equal(iconFor({ kind: 'advance.asked', level: 'info' }), '💵');
  assert.equal(iconFor({ kind: 'medical.claimed', level: 'info' }), '🩺');
  assert.equal(iconFor({ kind: 'birthday.today', level: 'info' }), '🎂');
  assert.equal(iconFor({ kind: 'rota.published.mine', level: 'info' }), '🗓');
});

test('a warning is a warning whatever it is about', () => {
  assert.equal(iconFor({ kind: 'attendance.terminal_quiet', level: 'warn' }), '⚠️');
  assert.equal(iconFor({ kind: 'advance.declined', level: 'high' }), '⛔');
});

test('a kind nothing knows about gets a bell, and never a bed', () => {
  assert.equal(iconFor({ kind: 'something.new', level: 'info' }), '🔔');
  assert.equal(iconFor({}), '🔔');
  assert.equal(iconFor(null), '🔔');
  const source = readFileSync('public/js/views/notices.js', 'utf8');
  assert.equal(source.includes('🛏'), false, 'the bed is gone');
});

// ---------------------------------------------------------------------------
// Reaching a phone that is locked
// ---------------------------------------------------------------------------

/**
 * The bell filled in and the lock screen stayed dark and silent.
 *
 * Web Push sends at "normal" urgency unless it is told otherwise, and normal
 * is a message the push service may sit on until the device next stirs by
 * itself. On a phone in somebody's pocket that can be hours. Everything sent
 * from here is worth waking somebody for, which is the whole test for whether
 * a notice is a push rather than only a bell.
 */
test('a push is sent at high urgency, so the phone is woken for it', async () => {
  const { raw, db } = setup();
  await withDevice(raw);

  let sent = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), headers: init.headers };
    return new Response('', { status: 201 });
  };
  try {
    await createNotice(db, { kind: 'rota.published.mine', title: 'Your rota', email: false });
  } finally { globalThis.fetch = original; }

  assert.ok(sent, 'it went');
  assert.equal(sent.headers.Urgency, 'high');
  assert.equal(sent.headers.TTL, '86400', 'and it is still kept for a day if the phone is off');
});

test('the notification carries a mark and a buzz', () => {
  // Left unsaid, an Android phone shows a grey dot in the status bar and
  // follows whatever its channel is set to, which for a phone somebody has
  // quietened is nothing at all.
  const sw = readFileSync('public/sw.js', 'utf8');
  assert.match(sw, /icon: '\/icons\/hive-192\.png'/);
  assert.match(sw, /badge: '\/icons\/hive-192\.png'/);
  assert.match(sw, /vibrate: \[/);
  assert.match(sw, /silent: false/);
});

test('the worker itself is fetched from the network, not the browser’s cache', () => {
  // Without this a phone can run last week's worker for a day after a deploy,
  // which is how a fix to what a notification looks like reaches nobody.
  for (const file of ['public/js/install.js', 'public/js/push.js']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /register\('\/sw\.js', \{ updateViaCache: 'none' \}\)/, file);
  }
});
