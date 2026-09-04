import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getNotifications, updateNotifications, whoCanBeReached } from '../src/routes/admin.js';
import { createNotice } from '../src/lib/notices.js';
import {
  CHANNELS_KEY, KINDS, goesOut, readChannels, tidyChannels,
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

test('anything nobody has touched is on', () => {
  assert.equal(goesOut({}, 'rota.published.mine', 'push'), true);
  assert.equal(goesOut(null, 'anything.at.all', 'email'), true);
  assert.equal(goesOut({ 'rota.published.mine': {} }, 'rota.published.mine', 'push'), true);
  assert.equal(goesOut({ 'rota.published.mine': { push: 0 } }, 'rota.published.mine', 'push'), false);
  // And an off for one way says nothing about the others.
  assert.equal(goesOut({ 'rota.published.mine': { push: 0 } }, 'rota.published.mine', 'email'), true);
});

test('only the offs are stored, so today’s default is not frozen in', () => {
  const tidy = tidyChannels({
    // One off among two ons: only the off survives.
    'rota.published.mine': { push: 1, email: 0, text: 1 },
    // All on, so nothing to say about it at all.
    'attendance.query': { push: 1 },
    // A kind the app does not have.
    'not.a.real.kind': { push: 0 },
    // A kind that never goes out by push, so push cannot be switched off.
    'rota.published': { push: 0 },
  });
  assert.deepEqual(tidy, { 'rota.published.mine': { email: 0 } });
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
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Ama', 'Kitchen', '2020-01-01')`,
  ).run();
  raw.prepare('UPDATE users SET staff_id = 1 WHERE id = 7').run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (2, '2', 'Esi', 'Kitchen', '2020-01-01')`,
  ).run();

  const out = await read(await whoCanBeReached(ctx(db)));
  const ama = out.people.find((p) => p.name === 'Ama');
  const esi = out.people.find((p) => p.name === 'Esi');

  assert.equal(ama.devices, 1);
  assert.equal(ama.ways, 1);
  assert.equal(esi.ways, 0);
  assert.equal(out.unreachable, 1, 'Esi, and only Esi');
});

test('somebody kept off the rota is not counted as a gap', async () => {
  const { raw, db } = await setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on, on_rota)
     VALUES (1, '1', 'Kojo', '2020-01-01', 0)`,
  ).run();

  const out = await read(await whoCanBeReached(ctx(db)));
  assert.equal(out.people[0].ways, 0);
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
