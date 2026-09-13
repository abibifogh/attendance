import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  IDLE_MINUTES, IDLE_MS, lockOnOpening, ownTrip, whatToDo,
} from '../public/js/guard-rules.js';
import { hashPin, getPepper } from '../src/lib/auth.js';
import { unlock } from '../src/routes/auth-lock.js';

/**
 * Nobody is standing here any more.
 *
 * Half of what this app holds is somebody else's business: their pay, their
 * leave, who is off sick on Thursday. A phone put down on a bar with the rota
 * open is a screen the room can read.
 *
 * One trigger, and it is time. Five minutes with nobody touching the screen
 * and the PIN is asked, over the top of whatever was on it, so nothing anybody
 * had half written is thrown away.
 *
 * It used to ask on the way back from another app as well. That was wrong:
 * looking something up in WhatsApp and coming back is how people work, and an
 * app that demands six digits every time somebody answers a message is an app
 * they stop opening. Somebody who has really been away long enough for it to
 * matter has also been away long enough for the clock to say so.
 */

// ---------------------------------------------------------------------------
// When to ask
// ---------------------------------------------------------------------------

test('five minutes untouched asks for the PIN', () => {
  assert.equal(IDLE_MINUTES, 5);
  assert.equal(whatToDo({ idleMs: IDLE_MS }), 'lock');
  assert.equal(whatToDo({ idleMs: IDLE_MS + 1 }), 'lock');
  assert.equal(whatToDo({ idleMs: IDLE_MS - 1 }), 'nothing');
});

test('four minutes and fifty-nine seconds is somebody reading the screen', () => {
  assert.equal(whatToDo({ idleMs: 4 * 60_000 }), 'nothing');
  assert.equal(whatToDo(), 'nothing');
});

test('coming back from another app is not itself a reason to ask', () => {
  // The old rule locked on any return to the installed app, however brief.
  // Nothing about where the app has been is passed in any more, and passing
  // it makes no difference: the clock is the whole of the decision.
  assert.equal(whatToDo({ idleMs: 1000, awayMs: 4000, installed: true }), 'nothing');
  assert.equal(whatToDo({ idleMs: 1000, awayMs: 600_000, installed: true }), 'nothing');
});

test('but a long enough trip reaches the same answer by the clock', () => {
  // Away ten minutes with nobody touching it is five minutes untouched twice
  // over, and it locks for that reason rather than for having been away.
  assert.equal(whatToDo({ idleMs: 10 * 60_000 }), 'lock');
});

test('the limit is a number, so a property could be asked for another one', () => {
  assert.equal(whatToDo({ idleMs: 90_000, limitMs: 60_000 }), 'lock');
  assert.equal(whatToDo({ idleMs: 30_000, limitMs: 60_000 }), 'nothing');
});

test('a trip the app sent them on does not count', () => {
  const now = 1_000_000;
  assert.equal(ownTrip(now + 5_000, now), true, 'still out choosing a file');
  assert.equal(ownTrip(now - 1, now), false, 'that was a different trip, long ago');
  assert.equal(ownTrip(null, now), false, 'nobody said they were going anywhere');
});

test('nothing signs anybody out on its own any more', () => {
  const guard = readFileSync('public/js/guard.js', 'utf8');
  // The lock goes over the top of what was there, so what somebody had half
  // written is still underneath it. Signing them out threw that away.
  assert.equal(/answer === 'out'/.test(guard), false);
  assert.match(guard, /showLock\(\)/);
  // And the door out is still on the lock screen, for whoever really is done.
  assert.match(guard, /Sign out instead/);
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

// ---------------------------------------------------------------------------
// Opening the app is the same question
// ---------------------------------------------------------------------------

/**
 * Closing the app and opening it again is not a reload.
 *
 * A staff session lasts two months, so a phone that was signed in once opened
 * straight on somebody's pay for the rest of it, with nobody having proved
 * they were the person who put it down. The clock that answers this has to
 * survive the app being shut, which means it has to be written down, and this
 * is the rule that reads it back.
 */

const MINUTE = 60 * 1000;

test('a phone put down an hour ago is asked for the PIN on opening', () => {
  const now = 1_000_000_000_000;
  assert.equal(lockOnOpening({ lastSeen: now - 60 * MINUTE, now }), true);
  assert.equal(lockOnOpening({ lastSeen: now - (IDLE_MINUTES + 1) * MINUTE, now }), true);
});

test('and a reload thirty seconds later is not', () => {
  const now = 1_000_000_000_000;
  assert.equal(lockOnOpening({ lastSeen: now - 30_000, now }), false);
  assert.equal(lockOnOpening({ lastSeen: now, now }), false);
  // Exactly on the limit locks, the same way the idle clock does.
  assert.equal(lockOnOpening({ lastSeen: now - IDLE_MS, now }), true);
});

test('nothing written down means nobody has opened it, which means ask', () => {
  const now = 1_000_000_000_000;
  // A session still good on a phone with no record of anybody using it. The
  // sign-in writes the stamp itself, so this is never a fresh sign-in.
  assert.equal(lockOnOpening({ lastSeen: null, now }), true);
  assert.equal(lockOnOpening({ lastSeen: '', now }), true);
  assert.equal(lockOnOpening({ lastSeen: 'yesterday', now }), true);
  assert.equal(lockOnOpening({ lastSeen: 0, now }), true);
});

test('a clock that has been put back is not a way through', () => {
  const now = 1_000_000_000_000;
  assert.equal(lockOnOpening({ lastSeen: now + 60 * MINUTE, now }), true);
});

test('a phone that cannot remember anything is not locked out of the app', () => {
  const now = 1_000_000_000_000;
  // A private window refuses storage, so every load looks like a session
  // nobody has opened. Nothing was written down, so nothing can be concluded,
  // and the clock in memory is left to do the work.
  assert.equal(lockOnOpening({ lastSeen: null, now, remembers: false }), false);
  assert.equal(lockOnOpening({ lastSeen: now - 60 * MINUTE, now, remembers: false }), false);
});

test('the screen writes the clock down, and takes it away on the way out', () => {
  const guard = readFileSync('public/js/guard.js', 'utf8');
  assert.match(guard, /localStorage\.setItem\(SEEN_KEY/);
  assert.match(guard, /lockOnOpening\(\{ lastSeen: seen, remembers: remembers\(\) \}\)/);
  // Leaving is worth writing down on its own: a phone locked with the app on
  // screen fires pagehide and nothing else.
  assert.match(guard, /'pagehide', 'blur'/);
  assert.match(guard, /export function forgetSeen/);
  assert.match(guard, /forgetSeen\(\);/);

  // And signing in says so, before the watch starts, or somebody would be
  // asked for the PIN they had just typed.
  const app = readFileSync('public/js/app.js', 'utf8');
  assert.match(app, /justProved\(\);\n\s+startLive\(\);/);
});

// ---------------------------------------------------------------------------
// A PIN from before the rule changed
// ---------------------------------------------------------------------------

test('unlocking with four digits asks them to lengthen it', async () => {
  const { raw, db } = await setup();
  const pepper = await getPepper(db);
  raw.prepare('UPDATE users SET pin_hash = ?, pin_ok = 0 WHERE id = 1')
    .run(await hashPin('1234', pepper));

  const out = await unlockFor(db, { pin: '1234' }, asUser(1));
  assert.equal(out.ok, true, 'it is still their PIN and still opens the app');
  assert.equal(out.mustChangePin, true);
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = 1').get().pin_ok, 0);
});

test('unlocking with six settles the account without asking anything', async () => {
  const { raw, db } = await setup();
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = 1').get().pin_ok, 0);

  const out = await unlockFor(db, { pin: '481920' }, asUser(1));
  assert.equal(out.mustChangePin, false);
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = 1').get().pin_ok, 1,
    'signing the account off as long enough, so it is never asked again');
});

test('an account already settled is not asked, whatever it types', async () => {
  const { raw, db } = await setup();
  const pepper = await getPepper(db);
  // Somebody who lengthened their PIN elsewhere and whose row says so. A short
  // PIN cannot open it anyway, but the flag is the thing being tested.
  raw.prepare('UPDATE users SET pin_hash = ?, pin_ok = 1 WHERE id = 1')
    .run(await hashPin('1234', pepper));

  const out = await unlockFor(db, { pin: '1234' }, asUser(1));
  assert.equal(out.mustChangePin, false);
});
