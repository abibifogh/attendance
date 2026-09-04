import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { IDLE_MINUTES, IDLE_MS, ownTrip, whatToDo } from '../public/js/guard-rules.js';
import { hashPin, getPepper } from '../src/lib/auth.js';
import { unlock } from '../src/routes/auth-lock.js';

/**
 * Nobody is standing here any more.
 *
 * Half of what this app holds is somebody else's business: their pay, their
 * leave, who is off sick on Thursday. A phone put down on a bar with the rota
 * open is a screen the room can read.
 *
 * Two answers, because there are two situations, and the difference matters:
 * untouched for five minutes and whoever was here has gone, so the session
 * ends; away behind another app and back again and they are standing right
 * there, so the PIN is asked and the session kept.
 */

// ---------------------------------------------------------------------------
// When to lock, and when to end it
// ---------------------------------------------------------------------------

test('five minutes untouched ends the session', () => {
  assert.equal(IDLE_MINUTES, 5);
  assert.equal(whatToDo({ idleMs: IDLE_MS }), 'out');
  assert.equal(whatToDo({ idleMs: IDLE_MS + 1 }), 'out');
  assert.equal(whatToDo({ idleMs: IDLE_MS - 1 }), 'nothing');
});

test('coming back to the installed app asks for the PIN', () => {
  assert.equal(whatToDo({ idleMs: 1000, awayMs: 4000, installed: true }), 'lock');
  // However briefly. Handing somebody a phone for ten seconds is the case this
  // is for, and ten seconds is long enough to read a payslip.
  assert.equal(whatToDo({ idleMs: 1000, awayMs: 200, installed: true }), 'lock');
});

test('a browser tab is not asked, because that is how people work', () => {
  // Looking something up in another tab and coming back is not a reason to
  // ask anybody for anything, and an app that did it would be switched off by
  // lunchtime.
  assert.equal(whatToDo({ idleMs: 1000, awayMs: 60_000, installed: false }), 'nothing');
});

test('being away too long ends it rather than locking it', () => {
  // Somebody away for an hour is gone whether or not they came back to the app
  // themselves. A lock screen on a session that should have ended is a session
  // that has not ended.
  assert.equal(
    whatToDo({ idleMs: IDLE_MS + 60_000, awayMs: IDLE_MS + 60_000, installed: true }),
    'out',
  );
});

test('nothing at all is quiet', () => {
  assert.equal(whatToDo(), 'nothing');
  assert.equal(whatToDo({ idleMs: 0, awayMs: null, installed: true }), 'nothing');
});

test('a trip the app sent them on does not count', () => {
  const now = 1_000_000;
  assert.equal(ownTrip(now + 5_000, now), true, 'still out choosing a file');
  assert.equal(ownTrip(now - 1, now), false, 'that was a different trip, long ago');
  assert.equal(ownTrip(null, now), false, 'nobody said they were going anywhere');
});

// ---------------------------------------------------------------------------
// The PIN that opens it again
// ---------------------------------------------------------------------------

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

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users;');
  const db = d1(raw);
  const pepper = await getPepper(db);

  // Two people, so "is this PIN yours" can be told from "is this PIN
  // anybody's", which is the whole point of the route.
  raw.prepare("INSERT INTO users (id, name, role, active, pin_hash) VALUES (1, 'Ama', 'staff', 1, ?)")
    .run(await hashPin('481920', pepper));
  raw.prepare("INSERT INTO users (id, name, role, active, pin_hash) VALUES (2, 'Kofi', 'staff', 1, ?)")
    .run(await hashPin('550011', pepper));
  return { raw, db };
}

const asUser = (id, extra = {}) => ({
  user: { id, name: 'Them', role: 'staff', ...extra },
  permissions: ['att_me'],
});

const ctx = (db, body, session, env = {}) => ({
  db,
  env,
  url: new URL('https://x/api/auth/unlock'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

/** The route, and what it answered. */
const unlockFor = async (db, body, session, env = {}) =>
  (await unlock(ctx(db, body, session, env))).json();

test('their own PIN opens it', async () => {
  const { db } = await setup();
  const out = await unlockFor(db, { pin: '481920' }, asUser(1));
  assert.equal(out.ok, true);
});

test('somebody else’s PIN does not, however valid it is', async () => {
  const { db } = await setup();
  // Kofi's PIN is a real PIN and it signs Kofi in. It must not open Ama's
  // locked phone, or the lock is a lock anybody in the building can pick.
  await assert.rejects(() => unlockFor(db, { pin: '550011' }, asUser(1)), /not your PIN/);
});

test('a wrong PIN is refused and a missing one too', async () => {
  const { db } = await setup();
  await assert.rejects(() => unlockFor(db, { pin: '000000' }, asUser(1)), /not your PIN/);
  await assert.rejects(() => unlockFor(db, {}, asUser(1)), /not your PIN/);
});

test('a login switched off since cannot be unlocked back into', async () => {
  const { db, raw } = await setup();
  raw.prepare('UPDATE users SET active = 0 WHERE id = 1').run();
  await assert.rejects(() => unlockFor(db, { pin: '481920' }, asUser(1)), /no longer active/);
});

test('the break-glass sign-in is opened by the secret it came in on', async () => {
  const { db } = await setup();
  const session = asUser(0, { isRecovery: true });
  const env = { MANAGER_PIN: '9182736' };

  assert.equal((await unlockFor(db, { pin: '9182736' }, session, env)).ok, true);
  await assert.rejects(() => unlockFor(db, { pin: '481920' }, session, env), /not your PIN/);
});
