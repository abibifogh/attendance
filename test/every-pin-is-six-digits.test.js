import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createUser, listUsers, updateUser } from '../src/routes/admin.js';
import { getPepper, hashPin, pinLooksRight, readToken, storedPassword } from '../src/lib/auth.js';

/**
 * Six digits for everybody, and what happens to the PINs that are shorter.
 *
 * The PINs already in use cannot be measured — only a hash of each is kept —
 * so the rule is applied where the PIN itself is: at sign-in. A short one
 * signs in perfectly well and is met by the screen asking for a longer one,
 * every time, and nothing is ever switched off for it.
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

const SECRET = 'x'.repeat(40);
const env = (db) => ({ DB: db, SESSION_SECRET: SECRET });

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

const user = (raw, id = 5) => raw.prepare('SELECT active FROM users WHERE id = ?').get(id);
const cookieOf = (res) => res.headers.get('Set-Cookie').split(';')[0];
const tokenIn = (res) => decodeURIComponent(cookieOf(res).split('=').slice(1).join('='));

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
// A PIN that is already too short
// ---------------------------------------------------------------------------

test('it signs in every time, is asked every time, and is never switched off', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');

  // Ten sign-ins, well past where a three-strike lockout would have bitten.
  for (let i = 0; i < 10; i += 1) {
    const res = await signIn(db, '1234');
    assert.equal(res.status, 200, `sign-in ${i + 1}`);
    assert.equal((await res.json()).mustChangePin, true);
    assert.equal(user(raw).active, 1, 'nothing is ever switched off for this');
  }
});

test('the session says so too, so a browser that comes back is sent to the same screen', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');
  const res = await signIn(db, '1234');

  const payload = await readToken(tokenIn(res), SECRET);
  assert.equal(payload.shortPin, 1);

  const me = await worker.fetch(
    new Request('https://x/api/auth/me', { headers: { Cookie: cookieOf(res) } }),
    env(db), null,
  );
  assert.equal((await me.json()).mustChangePin, true);
});

test('a PIN long enough is nobody’s business', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '123456');
  const res = await signIn(db, '123456');
  assert.equal((await res.json()).mustChangePin, false);
  assert.equal((await readToken(tokenIn(res), SECRET)).shortPin, undefined);
});

// ---------------------------------------------------------------------------
// The way out, which is always open
// ---------------------------------------------------------------------------

test('lengthening the PIN clears it, and hands back a session that agrees', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');
  const cookie = cookieOf(await signIn(db, '1234'));

  const changed = await worker.fetch(new Request('https://x/api/auth/change-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPin: '1234', newPin: '987654' }),
  }), env(db), null);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).changed, 'pin');

  // The replacement cookie no longer says anything is owed, so they are not
  // sent back to the same screen for the life of the old one.
  assert.equal((await readToken(tokenIn(changed), SECRET)).shortPin, undefined);
  assert.equal((await (await signIn(db, '987654')).json()).mustChangePin, false);
});

test('a short new PIN is refused, so the way out is not another four digits', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');
  const cookie = cookieOf(await signIn(db, '1234'));

  const res = await worker.fetch(new Request('https://x/api/auth/change-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPin: '1234', newPin: '4321' }),
  }), env(db), null);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /6 to 10 digits/);
});

test('an administrator never has to rescue anybody from this', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO users (id, name, role, email, password_hash, active)
     VALUES (1, 'Kwame', 'admin', 'k@x.com', 'pbkdf2c$1$1$AAAA$x', 1)`,
  ).run();
  const id = await withPin(raw, db, '1234');
  for (let i = 0; i < 6; i += 1) await signIn(db, '1234');

  // The account is untouched, so the Users screen has nothing to explain and
  // an administrator has nothing to undo.
  assert.equal(user(raw, id).active, 1);
  const list = await (await listUsers(ctx(db, {}))).json();
  assert.equal(list.users.find((u) => u.id === id).active, true);

  // They can still be given a longer one from here if they ask for help, and
  // then the screen stops appearing.
  await updateUser(ctx(db, { name: 'Ama', role: 'staff', pin: '246810', active: true }), id);
  assert.equal((await (await signIn(db, '246810')).json()).mustChangePin, false);
});

/** An administrator with a real password and a PIN that is too short. */
async function anAdmin(raw, db, { pin = '4321', password = 'key-of-the-password' } = {}) {
  const pepper = await getPepper(db);
  const hash = await storedPassword({ passwordKey: password, salt: 'AAAA', iterations: 1 }, pepper);
  raw.prepare(
    `INSERT INTO users (id, name, role, email, password_hash, pin_hash, active)
     VALUES (9, 'Kwame', 'admin', 'k@x.com', ?, ?, 1)`,
  ).run(hash, await hashPin(pin, pepper));
  return password;
}

test('an administrator on a short PIN is treated the same, and still has the password door', async () => {
  const { raw, db } = setup();
  await anAdmin(raw, db);

  const body = await (await signIn(db, '4321')).json();
  assert.equal(body.mustChangePin, true);
  assert.equal(body.role, 'admin');
  assert.equal(user(raw, 9).active, 1);
});

test('an administrator lengthens their PIN with their password, not with the old PIN', async () => {
  const { raw, db } = setup();
  const password = await anAdmin(raw, db);
  const cookie = cookieOf(await signIn(db, '4321'));

  const change = (body) => worker.fetch(new Request('https://x/api/auth/change-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  }), env(db), null);

  // The PIN cannot authorise its own replacement for an administrator. This
  // is what the forced screen was sending, and what it got back.
  const withPinOnly = await change({ currentPin: '4321', newPin: '654321' });
  assert.equal(withPinOnly.status, 400);
  assert.match((await withPinOnly.json()).error, /current password is not correct/);

  // The password does authorise it, which is what the screen sends now.
  const withPassword = await change({ currentPasswordKey: password, newPin: '654321' });
  assert.equal(withPassword.status, 200);
  assert.equal((await withPassword.json()).changed, 'pin');
  assert.equal((await readToken(tokenIn(withPassword), SECRET)).shortPin, undefined);

  assert.equal((await (await signIn(db, '654321')).json()).mustChangePin, false);

  // And a short one is refused down this path too.
  const short = await change({ currentPasswordKey: password, newPin: '1111' });
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /6 to 10 digits/);
});

// ---------------------------------------------------------------------------
// A PIN that is already long enough is nobody's business, on any device
// ---------------------------------------------------------------------------

test('lengthening it on one device stops every other session asking', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');

  // Their phone and the tablet by the door, both signed in on the old PIN.
  const phone = cookieOf(await signIn(db, '1234'));
  const tablet = cookieOf(await signIn(db, '1234'));
  const asks = async (cookie) => (await (await worker.fetch(
    new Request('https://x/api/auth/me', { headers: { Cookie: cookie } }), env(db), null,
  )).json()).mustChangePin;

  assert.equal(await asks(phone), true);
  assert.equal(await asks(tablet), true);

  await worker.fetch(new Request('https://x/api/auth/change-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: phone },
    body: JSON.stringify({ currentPin: '1234', newPin: '987654' }),
  }), env(db), null);

  // The tablet's token still says the PIN is short, because it was when that
  // token was made. The row knows better. Without this the person is asked to
  // change a PIN that already meets the rule, and the PIN they just chose is
  // refused as the same as the current one, so they cannot answer it at all.
  assert.equal(await asks(tablet), false, 'the tablet stops asking');
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = 5').get().pin_ok, 1);
});

test('signing in with a PIN that is long enough settles it without asking anything', async () => {
  const { raw, db } = setup();
  // A legacy account whose PIN already met the rule: nothing has ever
  // recorded that, and nothing should need to.
  await withPin(raw, db, '246810');
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = 5').get().pin_ok, 0);

  assert.equal((await (await signIn(db, '246810')).json()).mustChangePin, false);
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = 5').get().pin_ok, 1,
    'signing in with six digits is proof they are theirs');
});

test('a PIN an administrator sets is never questioned afterwards', async () => {
  const { raw, db } = setup();
  const made = await (await createUser(ctx(db, { name: 'Kojo', role: 'staff', pin: '135790' }))).json();
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = ?').get(made.user.id).pin_ok, 1);

  await updateUser(ctx(db, { name: 'Kojo', role: 'staff', pin: '246802', active: true }), made.user.id);
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = ?').get(made.user.id).pin_ok, 1);
});

test('a short PIN is still asked about, and the row does not pretend otherwise', async () => {
  const { raw, db } = setup();
  await withPin(raw, db, '1234');
  assert.equal((await (await signIn(db, '1234')).json()).mustChangePin, true);
  assert.equal(raw.prepare('SELECT pin_ok FROM users WHERE id = 5').get().pin_ok, 0,
    'nothing has proved this PIN is long enough, because it is not');
});
