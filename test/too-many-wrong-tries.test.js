import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createUser } from '../src/routes/admin.js';
import {
  getPepper, hashPin, pinLooksRight, throttleCheck, throttleFail, throttleReset,
  THROTTLE_MAX_FOR_EVERYBODY, THROTTLE_MAX_PER_ADDRESS,
} from '../src/lib/auth.js';

/**
 * Guessing a PIN is counted, and the count survives the isolate.
 *
 * Login is by PIN alone. The brake used to live in the memory of whichever
 * Worker took the request, which is to say nowhere in particular. Now it is
 * a row per address in the database, and one for everybody, so ten wrong
 * tries are ten wrong tries whichever machine heard them.
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

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users;');
  raw.prepare(
    `INSERT INTO users (id, name, role, email, password_hash, active)
     VALUES (1, 'Kwame', 'admin', 'kwame@example.com', 'pbkdf2c$1$1$AAAA$x', 1)`,
  ).run();
  return { raw, db: d1(raw) };
}

const envFor = (db) => ({
  DB: db,
  SESSION_SECRET: 'x'.repeat(40),
  ASSETS: { fetch: async () => new Response('asset') },
});

const tryPin = (env, pin, ip = '10.0.0.1') => worker.fetch(new Request('https://x/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  body: JSON.stringify({ pin }),
}), env, null);

test('ten wrong PINs from one address and the eleventh is refused, right or wrong', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE users SET pin_hash = ? WHERE id = 1')
    .run(await hashPin('135790', await getPepper(db)));
  const env = envFor(db);

  for (let i = 0; i < THROTTLE_MAX_PER_ADDRESS; i += 1) {
    const res = await tryPin(env, '000000');
    assert.equal(res.status, 400);
  }

  const refused = await tryPin(env, '135790');
  assert.equal(refused.status, 429);
  assert.ok(refused.headers.get('Retry-After'));
  const body = await refused.json();
  assert.match(body.error, /Too many wrong tries/);

  // Another address is not their problem.
  const elsewhere = await tryPin(env, '135790', '10.0.0.2');
  assert.equal(elsewhere.status, 200);

  // And the count is in the database, not in memory: a fresh isolate would
  // read the same row.
  const row = raw.prepare("SELECT count FROM login_attempts WHERE key = 'ip:10.0.0.1'").get();
  assert.equal(row.count, THROTTLE_MAX_PER_ADDRESS);
});

test('a right PIN clears the address, so a mistyped one earlier is forgiven', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE users SET pin_hash = ? WHERE id = 1')
    .run(await hashPin('135790', await getPepper(db)));
  const env = envFor(db);

  await tryPin(env, '000000');
  await tryPin(env, '000001');
  assert.equal((await tryPin(env, '135790')).status, 200);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM login_attempts WHERE key = 'ip:10.0.0.1'").get().n, 0);
});

test('the window forgives: ten minutes on, the address may try again', async () => {
  const { db, raw } = setup();
  for (let i = 0; i < THROTTLE_MAX_PER_ADDRESS; i += 1) await throttleFail(db, '10.0.0.1');
  assert.equal((await throttleCheck(db, '10.0.0.1')).allowed, false);
  raw.prepare("UPDATE login_attempts SET first_at = first_at - 601").run();
  assert.equal((await throttleCheck(db, '10.0.0.1')).allowed, true);
});

test('too many wrong tries from everywhere closes the keypad, and the password door stays open', async () => {
  const { db } = setup();
  for (let i = 0; i < THROTTLE_MAX_FOR_EVERYBODY; i += 1) {
    await throttleFail(db, `10.0.${Math.floor(i / 200)}.${i % 200}`);
  }
  const fresh = await throttleCheck(db, '192.168.1.1');
  assert.equal(fresh.allowed, false);
  assert.equal(fresh.scope, 'everybody');

  const password = await throttleCheck(db, '192.168.1.1', { pin: false });
  assert.equal(password.allowed, true);

  // A success on one address does not reopen the keypad for everybody.
  await throttleReset(db, '192.168.1.1');
  assert.equal((await throttleCheck(db, '192.168.1.2')).allowed, false);
});

test('the sweep keeps only the last ten minutes', async () => {
  const { db, raw } = setup();
  await throttleFail(db, '10.0.0.1');
  raw.prepare("UPDATE login_attempts SET first_at = first_at - 700").run();
  await throttleFail(db, '10.0.0.2');
  const keys = raw.prepare('SELECT key FROM login_attempts ORDER BY key').all().map((r) => r.key);
  assert.deepEqual(keys, ['all', 'ip:10.0.0.2']);
});

test('a database not yet upgraded has no brake rather than no way in', async () => {
  const { db, raw } = setup();
  raw.exec('DROP TABLE login_attempts');
  await throttleFail(db, '10.0.0.1');
  assert.equal((await throttleCheck(db, '10.0.0.1')).allowed, true);
  await throttleReset(db, '10.0.0.1');
});

// ---------------------------------------------------------------------------
// How long a PIN has to be
// ---------------------------------------------------------------------------

test('six digits, whatever the person does here', () => {
  // A member of staff used to be allowed four, on the grounds that they hold
  // only their own shifts. The same keypad opens records and pay for
  // everybody else, and a door is only as good as its shortest key.
  assert.equal(pinLooksRight('1234'), false);
  assert.equal(pinLooksRight('12345'), false);
  assert.equal(pinLooksRight('123456'), true);
  assert.equal(pinLooksRight('1234567890'), true);
  assert.equal(pinLooksRight('12345678901'), false, 'ten at most');
  assert.equal(pinLooksRight('12a456'), false, 'digits only');
});

const asAdmin = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: [], via: 'password' };
const ctx = (db, body) => ({
  db,
  env: {},
  url: new URL('https://x/api/users'),
  session: asAdmin,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
});

test('adding a login holds the rule, for a member of staff as much as anybody', async () => {
  const { db } = setup();
  for (const role of ['supervisor', 'staff']) {
    await assert.rejects(
      () => createUser(ctx(db, { name: 'Efua', role, pin: '2468' })),
      /6 to 10 digits/,
      role,
    );
  }
  assert.equal((await createUser(ctx(db, { name: 'Efua', role: 'supervisor', pin: '246810' }))).status, 201);
  assert.equal((await createUser(ctx(db, { name: 'Kojo', role: 'staff', pin: '135790' }))).status, 201);
});
