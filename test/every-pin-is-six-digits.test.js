import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createUser, listUsers, updateUser } from '../src/routes/admin.js';
import { getPepper, hashPin, pinLooksRight, readToken } from '../src/lib/auth.js';

/**
 * Six digits for everybody, and what happens to the PINs that are shorter.
 *
 * The PINs already in use cannot be measured, so the rule is applied where
 * the PIN itself is: at sign-in. Three sign-ins of being told, and then the
 * login is switched off until an administrator sets a new one.
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
  raw.exec('DELETE FROM users; DELETE FROM audit_log;');
  return { raw, db: d1(raw) };
}

const env = (db) => ({ DB: db, SESSION_SECRET: 'x'.repeat(40) });

/** Somebody already on the books, with whatever PIN they were given. */
async function withPin(raw, db, pin, { role = 'staff', id = 5, name = 'Ama' } = {}) {
  const pepper = await getPepper(db);
  raw.prepare(
    'INSERT INTO users (id, name, role, pin_hash, active) VALUES (?, ?, ?, ?, 1)',
  ).run(id, name, role, await hashPin(pin, pepper));
  return id;
}

const signIn = (db, pin) => worker.fetch(new Request('https://x/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin }),
}), env(db), null);

const user = (raw, id = 5) => raw.prepare('SELECT active, pin_grace_left, pin_locked_at FROM users WHERE id = ?').get(id);

const ADMIN = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['users'], via: 'password' };
const ctx = (db, body, session = ADMIN) => ({
  db,
  env: {},
  url: new URL('https://x/api/users'),
  session,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('six digits, whoever it is', () => {
  for (const bad of ['', '1', '12345', 'abcdef', '12 3456', '12345678901']) {
    assert.equal(pinLooksRight(bad), false, String(bad));
  }
  for (const good of ['123456', '1234567890']) assert.equal(pinLooksRight(good), true, good);
});

test('a new login of any role is refused a short PIN', async () => {
  const { db } = setup();
  for (const role of ['staff', 'supervisor', 'manager']) {
    await assert.rejects(
      () => createUser(ctx(db, { name: 'Kofi', role, pin: '1234' })),
      /6 to 10 digits/,
      role,
    );
  }
  const made = await (await createUser(ctx(db, { name: 'Kofi', role: 'staff', pin: '123456' }))).json();
  assert.ok(made.user?.id, 'six digits is accepted');
  assert.equal(made.user.hasPin, true);
});

// ---------------------------------------------------------------------------
// The allowance
// ---------------------------------------------------------------------------

test('a short PIN opens the app three more times and then stops', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');

  for (const expected of [2, 1, 0]) {
    const res = await signIn(db, '1234');
    assert.equal(res.status, 200, `chance with ${expected} to follow`);
    const body = await res.json();
    assert.equal(body.mustChangePin, true);
    assert.equal(body.pinChancesLeft, expected);
    assert.equal(user(raw).pin_grace_left, expected);
    assert.equal(user(raw).active, 1, 'still allowed in while the allowance lasts');
  }

  // The fourth is refused, and the login is switched off.
  const out = await signIn(db, '1234');
  assert.equal(out.status, 403);
  const refused = await out.json();
  assert.equal(refused.pinLocked, true);
  assert.match(refused.error, /switched off/);
  assert.equal(user(raw).active, 0);
  assert.ok(user(raw).pin_locked_at);

  // And it stays refused, with the reason rather than "not recognised".
  const again = await signIn(db, '1234');
  assert.equal(again.status, 403);
  assert.match((await again.json()).error, /administrator can set you a new one/);
});

test('the session says so too, so a browser that comes back is still sent to change it', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');
  const res = await signIn(db, '1234');
  const cookie = res.headers.get('Set-Cookie');
  assert.ok(cookie);

  const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
  const payload = await readToken(token, 'x'.repeat(40));
  assert.equal(payload.shortPin, 1);

  const me = await worker.fetch(
    new Request('https://x/api/auth/me', { headers: { Cookie: cookie.split(';')[0] } }),
    env(db), null,
  );
  const body = await me.json();
  assert.equal(body.mustChangePin, true);
  assert.equal(body.pinChancesLeft, 2);
});

test('a PIN long enough is nobody’s business and touches nothing', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '123456');
  const body = await (await signIn(db, '123456')).json();
  assert.equal(body.mustChangePin, false);
  assert.equal(body.pinChancesLeft, null);
  assert.equal(user(raw).pin_grace_left, null, 'the allowance is never opened');
});

// ---------------------------------------------------------------------------
// The ways out
// ---------------------------------------------------------------------------

test('lengthening the PIN puts the allowance away and hands back a clean session', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');
  const first = await signIn(db, '1234');
  const cookie = first.headers.get('Set-Cookie').split(';')[0];

  const changed = await worker.fetch(new Request('https://x/api/auth/change-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPin: '1234', newPin: '987654' }),
  }), env(db), null);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).changed, 'pin');
  assert.equal(user(raw).pin_grace_left, null);

  // The replacement cookie no longer says anything is owed, so they are not
  // sent back to the same screen for the life of the old one.
  const fresh = changed.headers.get('Set-Cookie');
  assert.ok(fresh, 'a new session comes back with it');
  const payload = await readToken(
    decodeURIComponent(fresh.split(';')[0].split('=').slice(1).join('=')), 'x'.repeat(40),
  );
  assert.equal(payload.shortPin, undefined);

  const back = await signIn(db, '987654');
  assert.equal((await back.json()).mustChangePin, false);
});

test('a short new PIN is refused, so the way out is not another four digits', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');
  const cookie = (await signIn(db, '1234')).headers.get('Set-Cookie').split(';')[0];

  const res = await worker.fetch(new Request('https://x/api/auth/change-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPin: '1234', newPin: '4321' }),
  }), env(db), null);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /6 to 10 digits/);
});

test('an administrator setting a new PIN is the way back from a lockout', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO users (id, name, role, email, password_hash, active)
     VALUES (1, 'Kwame', 'admin', 'k@x.com', 'pbkdf2c$1$1$AAAA$x', 1)`,
  ).run();
  const id = await withPin(raw, db, '1234');
  for (let i = 0; i < 4; i += 1) await signIn(db, '1234');
  assert.equal(user(raw, id).active, 0);

  // The screen says why, so nobody just ticks Active and wonders.
  const list = await (await listUsers(ctx(db, {}))).json();
  assert.equal(list.users.find((u) => u.id === id).pinLocked, true);

  await updateUser(ctx(db, { name: 'Ama', role: 'staff', pin: '246810', active: true }), id);
  const after = user(raw, id);
  assert.equal(after.active, 1);
  assert.equal(after.pin_locked_at, null);
  assert.equal(after.pin_grace_left, null);

  const back = await signIn(db, '246810');
  assert.equal(back.status, 200);
  assert.equal((await back.json()).mustChangePin, false);
});

test('an administrator on a short PIN is treated the same, and still has the password door', async () => {
  const { raw, db } = setup();
  const pepper = await getPepper(db);
  raw.prepare(
    `INSERT INTO users (id, name, role, email, password_hash, pin_hash, active)
     VALUES (9, 'Kwame', 'admin', 'k@x.com', 'pbkdf2c$1$1$AAAA$x', ?, 1)`,
  ).run(await hashPin('4321', pepper));

  const body = await (await signIn(db, '4321')).json();
  assert.equal(body.mustChangePin, true);
  assert.equal(body.role, 'admin');
  assert.equal(user(raw, 9).pin_grace_left, 2);
});
