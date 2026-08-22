import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createUser, updateUser } from '../src/routes/admin.js';
import { getPepper, hashPin, readToken, userForPin } from '../src/lib/auth.js';

/**
 * An administrator signing in with a PIN.
 *
 * The password does not go away: an administrator must still have one, and it
 * is the only thing that will set the PIN that guards the payroll. What the
 * login PIN buys is the tablet in the kitchen, where a long password on a wet
 * screen is the reason somebody props the office laptop open instead.
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

const asAdmin = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: [], via: 'password' };

const ctx = (db, body) => ({
  db,
  env: {},
  url: new URL('https://x/api/admin/users'),
  session: asAdmin,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
});

const read = async (r) => r.json();

const newAdmin = (over = {}) => ({
  name: 'Adjoa',
  role: 'admin',
  email: 'adjoa@example.com',
  passwordKey: 'derived-key',
  passwordSalt: 'AAAAAAAAAAAAAAAAAAAAAA',
  passwordIterations: 600000,
  ...over,
});

// ---------------------------------------------------------------------------
// Giving one out
// ---------------------------------------------------------------------------

test('an administrator can be given a PIN alongside their password', async () => {
  const { db, raw } = setup();
  const made = await read(await createUser(ctx(db, newAdmin({ pin: '135790' }))));

  assert.equal(made.user.role, 'admin');
  assert.equal(made.user.hasPin, true);
  assert.equal(made.user.signsInWith, 'password or PIN');

  const row = raw.prepare('SELECT * FROM users WHERE name = ?').get('Adjoa');
  assert.ok(row.pin_hash, 'the PIN is stored');
  assert.ok(row.password_hash, 'and so is the password');
});

test('an administrator still needs an email address and a password', async () => {
  const { db } = setup();
  await assert.rejects(
    () => createUser(ctx(db, { name: 'Adjoa', role: 'admin', pin: '135790' })),
    /needs an email address/,
  );
  await assert.rejects(
    () => createUser(ctx(db, { name: 'Adjoa', role: 'admin', email: 'a@b.com', pin: '135790' })),
    /needs a password/,
  );
});

test('an administrator PIN has the same shape as everybody else’s', async () => {
  const { db } = setup();
  for (const bad of ['12', 'abcd', '1 234']) {
    await assert.rejects(
      () => createUser(ctx(db, newAdmin({ pin: bad }))),
      /4 to 10 digits/,
      String(bad),
    );
  }
  // Too long is caught a step earlier, by the same length check everybody
  // else's PIN goes through.
  await assert.rejects(
    () => createUser(ctx(db, newAdmin({ pin: '12345678901' }))),
    /10 characters or fewer/,
  );
});

test('a PIN can be taken away again without touching the password', async () => {
  const { db, raw } = setup();
  const made = await read(await createUser(ctx(db, newAdmin({ pin: '135790' }))));
  const before = raw.prepare('SELECT password_hash FROM users WHERE id = ?').get(made.user.id);

  const after = await read(await updateUser(
    ctx(db, { name: 'Adjoa', role: 'admin', email: 'adjoa@example.com', clearPin: true }),
    made.user.id,
  ));
  assert.equal(after.user.hasPin, false);
  assert.equal(after.user.signsInWith, 'password');

  const row = raw.prepare('SELECT * FROM users WHERE id = ?').get(made.user.id);
  assert.equal(row.pin_hash, null);
  assert.equal(row.password_hash, before.password_hash, 'the password is untouched');
});

test('promoting somebody still retires the PIN they already had', async () => {
  // A supervisor's four digits have been on a sticky note since opening day.
  // Becoming an administrator must not quietly turn them into the keys to the
  // property; a new one, typed deliberately, is a different matter.
  const { db, raw } = setup();
  const made = await read(await createUser(ctx(db, {
    name: 'Yaw', role: 'supervisor', pin: '246810',
  })));
  assert.equal(made.user.hasPin, true);

  const promoted = await read(await updateUser(ctx(db, {
    name: 'Yaw',
    role: 'admin',
    email: 'yaw@example.com',
    passwordKey: 'k',
    passwordSalt: 'AAAAAAAAAAAAAAAAAAAAAA',
    passwordIterations: 600000,
  }), made.user.id));
  assert.equal(promoted.user.hasPin, false);
  assert.equal(raw.prepare('SELECT pin_hash FROM users WHERE id = ?').get(made.user.id).pin_hash, null);

  const again = await read(await updateUser(ctx(db, {
    name: 'Yaw', role: 'admin', email: 'yaw@example.com', pin: '975310',
  }), made.user.id));
  assert.equal(again.user.hasPin, true);
});

test('an administrator PIN cannot shadow the server’s recovery PIN', async () => {
  const { db } = setup();
  const withEnv = (body) => ({ ...ctx(db, body), env: { MANAGER_PIN: '999888' } });
  await assert.rejects(
    () => createUser(withEnv(newAdmin({ pin: '999888' }))),
    /not available/,
  );
});

// ---------------------------------------------------------------------------
// Using one
// ---------------------------------------------------------------------------

test('the PIN finds the administrator behind it', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE users SET pin_hash = ? WHERE id = 1')
    .run(await hashPin('135790', await getPepper(db)));

  const found = await userForPin(db, '135790', {});
  assert.ok(found, 'an administrator PIN is a way in now');
  assert.equal(found.role, 'admin');
  assert.equal(found.name, 'Kwame');

  // And a deactivated one still is not.
  raw.prepare('UPDATE users SET active = 0 WHERE id = 1').run();
  assert.equal(await userForPin(db, '135790', {}), null);
});

test('through the front door, the PIN signs an administrator in and says so', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE users SET pin_hash = ? WHERE id = 1')
    .run(await hashPin('135790', await getPepper(db)));

  const env = {
    DB: db,
    SESSION_SECRET: 'x'.repeat(40),
    ASSETS: { fetch: async () => new Response('asset') },
  };
  const res = await worker.fetch(new Request('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '135790' }),
  }), env, null);

  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.role, 'admin');
  assert.equal(out.name, 'Kwame');

  // The token records which credential opened the session, because a PIN one
  // may not choose the payroll PIN.
  const cookie = res.headers.get('Set-Cookie');
  const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
  const payload = await readToken(token, env.SESSION_SECRET);
  assert.equal(payload.via, 'pin');
  assert.equal(payload.role, 'admin');
});

test('a wrong PIN is still a wrong PIN, and says nothing about who has one', async () => {
  const { db } = setup();
  const env = {
    DB: db,
    SESSION_SECRET: 'x'.repeat(40),
    ASSETS: { fetch: async () => new Response('asset') },
  };
  const res = await worker.fetch(new Request('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ pin: '000001' }),
  }), env, null);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not recognised/);
});
