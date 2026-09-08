import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  DAYS_TO_JOIN, howItStands, isARun, mayChoose, readChoice, waysFor, whyNotOpen,
} from '../src/lib/joining.js';
import { cancelInvitation, inviteToJoin, joinHead, joinSet } from '../src/routes/joining.js';
import { createUser, listUsers } from '../src/routes/admin.js';

/**
 * Somebody being invited into a login, and choosing how they will get in.
 *
 * A login used to be made with its way in already decided: somebody typed a
 * PIN and then had to get that PIN to the person. Both halves of that are the
 * same problem — the thing that opens the account travels through a third
 * party's hands, and it is a thing the person never chose and will not
 * remember.
 *
 * What is pinned down here is that the choice is really theirs, that the link
 * is spent when it is used, and that nothing about it can be recovered from
 * the database afterwards.
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
  raw.exec('DELETE FROM users; DELETE FROM user_invite;');
  return { raw, db: d1(raw) };
}

const ctx = (db, body = null, { permissions = ['users'], env = {} } = {}) => ({
  db,
  env: { SESSION_SECRET: 'a-secret-for-the-test', ...env },
  url: new URL('https://staff.example/api/users'),
  session: { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions },
  executionContext: null,
  request: new Request('https://staff.example/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const read = async (res) => JSON.parse(await res.text());

const aLogin = async (db, over = {}) => read(await createUser(ctx(db, {
  name: 'Ama Mensah',
  role: 'staff',
  byInvitation: true,
  email: 'ama@example.com',
  staffId: null,
  ...over,
})));

const invite = async (db, userId, over = {}) => read(await inviteToJoin(
  ctx(db, { email: 'ama@example.com', ...over }), userId,
));

const tokenOf = (url) => String(url).split('/j/')[1];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

test('everybody but an administrator picks, and an administrator keeps a password', () => {
  assert.deepEqual(waysFor('staff'), ['pin', 'password']);
  assert.deepEqual(waysFor('manager'), ['pin', 'password']);
  assert.deepEqual(waysFor('rota_reader'), ['pin', 'password']);
  // The password is what authorises changing a PIN, granting the payroll and
  // everything else an administrator does. Six digits cannot stand for that.
  assert.deepEqual(waysFor('admin'), ['password']);
  assert.equal(mayChoose('admin', 'pin'), false);
  assert.equal(mayChoose('staff', 'pin'), true);
});

test('a PIN nobody should be allowed is refused with the reason', () => {
  assert.match(readChoice({ way: 'pin', pin: '111111' }).error, /same digit/);
  assert.match(readChoice({ way: 'pin', pin: '123456' }).error, /straight run/);
  assert.match(readChoice({ way: 'pin', pin: '654321' }).error, /straight run/);
  assert.match(readChoice({ way: 'pin', pin: '1234' }).error, /digits/);
  assert.match(readChoice({ way: 'pin', pin: 'abcdef' }).error, /digits/);
  assert.deepEqual(readChoice({ way: 'pin', pin: '481907' }), { way: 'pin', pin: '481907' });
});

test('a straight run is a run in either direction and nothing else', () => {
  assert.equal(isARun('123456'), true);
  assert.equal(isARun('987654'), true);
  assert.equal(isARun('481907'), false);
  assert.equal(isARun('112233'), false);
});

test('a way nobody offered is refused rather than corrected', () => {
  assert.match(readChoice({ way: '' }).error, /Choose a PIN or a password/);
  assert.match(readChoice({ way: 'fingerprint' }).error, /Choose a PIN or a password/);
  assert.match(readChoice({ way: 'pin', pin: '481907' }, 'admin').error, /email address and a password/);
});

test('why a link will not open says which of the four it is', () => {
  assert.match(whyNotOpen(null), /does not work/);
  assert.match(whyNotOpen({ revoked_at: '2026-01-01' }), /cancelled/);
  assert.match(whyNotOpen({ used_at: '2026-01-01' }), /already been used/);
  assert.match(
    whyNotOpen({ expires_at: '2026-01-01 00:00:00' }, { now: '2026-02-01 00:00:00' }),
    /expired/,
  );
  assert.equal(
    whyNotOpen({ expires_at: '2026-03-01 00:00:00' }, { now: '2026-02-01 00:00:00' }),
    null,
  );
});

test('the accounts list says which of the three states somebody is in', () => {
  assert.equal(howItStands(null, { hasCredentials: true }), null);
  assert.equal(howItStands(null, {}), 'no way in yet');
  assert.equal(howItStands({ sent_at: null }, {}), 'invitation made, not sent');
  assert.equal(howItStands({ sent_at: 'x' }, {}), 'invitation sent');
  assert.equal(howItStands({ sent_at: 'x', opened_at: 'y' }, {}), 'opened the invitation, not finished');
  assert.equal(howItStands({ used_at: 'z' }, {}), null);
});

// ---------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------

test('a login can be made with no way into it at all', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);

  const row = raw.prepare('SELECT * FROM users WHERE id = ?').get(made.user.id);
  assert.equal(row.pin_hash, null);
  assert.equal(row.password_hash, null);
  assert.equal(made.user.signsInWith, 'nothing yet');
});

test('a login made the old way still needs its PIN', async () => {
  const { db } = setup();
  await assert.rejects(
    () => createUser(ctx(db, { name: 'Yaw', role: 'staff' })),
    /PIN of/,
  );
});

test('the link is stored as a fingerprint and nowhere as itself', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  const token = tokenOf(out.url);
  assert.ok(token && token.length >= 32, 'a token nobody guesses');
  const stored = raw.prepare('SELECT * FROM user_invite').get();
  assert.equal(String(stored.token_hash).includes(token), false,
    'a copy of the database opens nothing');
  assert.equal(stored.email, 'ama@example.com');
  assert.equal(stored.used_at, null);
});

test('making another cancels the one before it', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);
  const first = await invite(db, made.user.id);
  await invite(db, made.user.id);

  // Two live links into one login is one more than anybody can keep track of.
  const rows = raw.prepare('SELECT revoked_at FROM user_invite ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].revoked_at, 'the first one is off');
  assert.equal(rows[1].revoked_at, null);

  await assert.rejects(() => joinHead(ctx(db), tokenOf(first.url)), /cancelled/);
});

test('with no email set up the link still comes back, to be passed on by hand', async () => {
  const { db } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  assert.equal(out.sent, false);
  assert.match(out.whyNot, /has not set up email/);
  assert.match(out.url, /\/j\//, 'and there is still a link to send');
});

test('an invitation needs somewhere to go', async () => {
  const { db } = setup();
  const made = await aLogin(db, { email: null, name: 'Kofi' });
  await assert.rejects(() => inviteToJoin(ctx(db, {}), made.user.id), /email address to go to/);
});

// ---------------------------------------------------------------------------
// Opening it
// ---------------------------------------------------------------------------

test('the page behind the link says almost nothing about the property', async () => {
  const { db } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  const head = await read(await joinHead(ctx(db), tokenOf(out.url)));
  assert.equal(head.name, 'Ama', 'their own first name, so they know it is theirs');
  assert.deepEqual(head.ways, ['pin', 'password']);
  assert.equal(head.email, 'ama@example.com');
  // Not the role, not the permissions, not who else works here.
  assert.equal(head.role, undefined);
  assert.equal(head.permissions, undefined);
});

test('opening it is recorded, so somebody who stopped halfway can be helped', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  assert.equal(raw.prepare('SELECT opened_at FROM user_invite').get().opened_at, null);
  await joinHead(ctx(db), tokenOf(out.url));
  assert.ok(raw.prepare('SELECT opened_at FROM user_invite').get().opened_at);
});

test('choosing a PIN sets it, spends the link and signs them in', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);
  const token = tokenOf(out.url);

  const response = await joinSet(ctx(db, { way: 'pin', pin: '481907' }), token);
  const said = await read(response);
  assert.equal(said.way, 'pin');
  assert.equal(said.name, 'Ama Mensah');
  assert.match(response.headers.get('Set-Cookie') ?? '', /bf_session=/,
    'straight in, rather than out to a login screen');

  const row = raw.prepare('SELECT * FROM users WHERE id = ?').get(made.user.id);
  assert.ok(row.pin_hash);
  assert.equal(row.password_hash, null);
  assert.equal(raw.prepare('SELECT chose FROM user_invite').get().chose, 'pin');

  await assert.rejects(() => joinSet(ctx(db, { way: 'pin', pin: '481907' }), token),
    /already been used/);
});

test('choosing a password sets that instead, against the address it was sent to', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  await joinSet(ctx(db, {
    way: 'password', passwordKey: 'a-derived-key', passwordSalt: 'some-salt',
    passwordIterations: 600000,
  }), tokenOf(out.url));

  const row = raw.prepare('SELECT * FROM users WHERE id = ?').get(made.user.id);
  assert.equal(row.pin_hash, null);
  assert.ok(String(row.password_hash).startsWith('pbkdf2c$'));
  assert.equal(row.email, 'ama@example.com');
  assert.equal(raw.prepare('SELECT chose FROM user_invite').get().chose, 'password');
});

test('an administrator invited in cannot settle for six digits', async () => {
  const { db } = setup();
  const made = await aLogin(db, { role: 'admin', name: 'Efua', email: 'efua@example.com' });
  const out = await invite(db, made.user.id, { email: 'efua@example.com' });

  const head = await read(await joinHead(ctx(db), tokenOf(out.url)));
  assert.deepEqual(head.ways, ['password']);
  await assert.rejects(() => joinSet(ctx(db, { way: 'pin', pin: '481907' }), tokenOf(out.url)),
    /email address and a password/);
});

test('a PIN somebody else already uses is refused, with the link still good', async () => {
  const { db } = setup();
  await createUser(ctx(db, { name: 'Yaw', role: 'staff', pin: '481907' }));
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  await assert.rejects(() => joinSet(ctx(db, { way: 'pin', pin: '481907' }), tokenOf(out.url)),
    /already in use/);
  // Not spent by a refusal: they are still standing there with the page open.
  const head = await read(await joinHead(ctx(db), tokenOf(out.url)));
  assert.equal(head.name, 'Ama');
});

test('a cancelled invitation stops working straight away', async () => {
  const { db } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  await cancelInvitation(ctx(db), made.user.id);
  await assert.rejects(() => joinHead(ctx(db), tokenOf(out.url)), /cancelled/);
  await assert.rejects(() => joinSet(ctx(db, { way: 'pin', pin: '481907' }), tokenOf(out.url)),
    /cancelled/);
});

test('a token nobody issued is a 404 and says nothing else', async () => {
  const { db } = setup();
  await assert.rejects(() => joinHead(ctx(db), 'a'.repeat(48)), /does not work/);
});

test('a login switched off cannot be joined', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);
  raw.prepare('UPDATE users SET active = 0 WHERE id = ?').run(made.user.id);

  await assert.rejects(() => joinHead(ctx(db), tokenOf(out.url)), /no longer open/);
});

// ---------------------------------------------------------------------------
// What the office sees
// ---------------------------------------------------------------------------

test('the accounts list shows where an invitation has got to, and never the link', async () => {
  const { db } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);

  let list = await read(await listUsers(ctx(db)));
  let row = list.users.find((u) => u.id === made.user.id);
  assert.equal(row.waiting, 'invitation made, not sent');
  assert.equal(row.invited.email, 'ama@example.com');
  assert.equal(JSON.stringify(list).includes(tokenOf(out.url)), false,
    'nothing here can recover a link');

  await joinHead(ctx(db), tokenOf(out.url));
  list = await read(await listUsers(ctx(db)));
  row = list.users.find((u) => u.id === made.user.id);
  assert.equal(row.waiting, 'opened the invitation, not finished');

  await joinSet(ctx(db, { way: 'pin', pin: '481907' }), tokenOf(out.url));
  list = await read(await listUsers(ctx(db)));
  row = list.users.find((u) => u.id === made.user.id);
  assert.equal(row.waiting, null);
  assert.equal(row.invited, null);
  assert.equal(row.signsInWith, 'pin');
});

test('the list says how somebody really signs in, not how their role usually does', async () => {
  const { db } = setup();
  const made = await aLogin(db);
  const out = await invite(db, made.user.id);
  await joinSet(ctx(db, {
    way: 'password', passwordKey: 'k', passwordSalt: 's', passwordIterations: 600000,
  }), tokenOf(out.url));

  const list = await read(await listUsers(ctx(db)));
  const row = list.users.find((u) => u.id === made.user.id);
  // A member of staff who chose a password. "pin" here would send whoever
  // reads it to the wrong answer when she rings up unable to get in.
  assert.equal(row.signsInWith, 'password');
  assert.equal(row.hasPassword, true);
  assert.equal(row.hasPin, false);
});

test('a link lasts three days unless somebody says otherwise', async () => {
  const { db, raw } = setup();
  const made = await aLogin(db);
  await invite(db, made.user.id);
  const row = raw.prepare("SELECT julianday(expires_at) - julianday('now') AS days FROM user_invite").get();
  assert.ok(Math.abs(Number(row.days) - DAYS_TO_JOIN) < 0.01, `${row.days} days`);
});
