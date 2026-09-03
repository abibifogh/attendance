import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import * as push from '../src/routes/push.js';
import {
  auditTrail, createUser, deleteUser, eraseData, getNotifications, listNoticesRoute,
  listUsers, markNoticesSeen, updateNotifications, updateUser,
} from '../src/routes/admin.js';
import { createNotice } from '../src/lib/notices.js';

/**
 * The routes behind the phone alerts and the Users & data screen.
 *
 * Neither had a test of its own. The logic under them did; the wiring, which
 * is what a person actually presses, did not.
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
  raw.exec('DELETE FROM users; DELETE FROM audit_log; DELETE FROM app_notices;');
  raw.prepare(
    `INSERT INTO users (id, name, role, email, password_hash, active)
     VALUES (1, 'Kwame', 'admin', 'kwame@example.com', 'pbkdf2c$1$1$AAAA$x', 1)`,
  ).run();
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, active) VALUES (2, 'Yaa', 'supervisor', 'h2', 1)").run();
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['users', 'att_manage'] };
const ctx = (db, { body = null, query = '', session = ADMIN, env = {} } = {}) => ({
  db,
  env,
  url: new URL(`https://x/api/x${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = (r) => r.json();

const ENDPOINT = 'https://push.example.com/send/abc';
const sub = (db, extra = {}) => push.subscribe(ctx(db, {
  body: { endpoint: ENDPOINT, p256dh: 'p', auth: 'a', label: 'Office laptop', ...extra },
}));

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

test('the public key is made once and then handed back the same every time', async () => {
  const { raw, db } = setup();
  const first = await read(await push.publicKey(ctx(db)));
  const again = await read(await push.publicKey(ctx(db)));
  assert.ok(first.key.length > 40);
  assert.equal(again.key, first.key);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM settings WHERE key IN ('vapid_public','vapid_private')").get().n, 2);
});

test('a browser subscribes under the person signed in, and again replaces rather than duplicates', async () => {
  const { raw, db } = setup();
  await sub(db);
  await sub(db, { label: 'Office laptop, renamed' });
  const rows = raw.prepare('SELECT user_id, label FROM push_subscriptions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 1);
  assert.equal(rows[0].label, 'Office laptop, renamed');
});

test('only an https push address is accepted', async () => {
  const { db } = setup();
  await assert.rejects(sub(db, { endpoint: 'http://push.example.com/x' }), /not a valid push address/);
  await assert.rejects(sub(db, { endpoint: '' }), /Endpoint/);
});

test('status says whether this browser is set up, and who else is', async () => {
  const { db } = setup();
  const before = await read(await push.status(ctx(db, { query: `?endpoint=${encodeURIComponent(ENDPOINT)}` })));
  assert.equal(before.subscribedHere, false);
  assert.equal(before.enabled, true, 'on by default');

  await sub(db);
  const after = await read(await push.status(ctx(db, { query: `?endpoint=${encodeURIComponent(ENDPOINT)}` })));
  assert.equal(after.subscribedHere, true);
  assert.equal(after.devices.length, 1);
  assert.equal(after.devices[0].name, 'Kwame');
  assert.equal(after.devices[0].label, 'Office laptop');
});

test('unsubscribing forgets the browser, and an administrator can retire a lost phone', async () => {
  const { raw, db } = setup();
  await sub(db);
  await push.unsubscribe(ctx(db, { body: { endpoint: ENDPOINT } }));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0);

  await sub(db);
  const { id } = raw.prepare('SELECT id FROM push_subscriptions').get();
  await push.removeDevice(ctx(db), id);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0);
  await assert.rejects(push.removeDevice(ctx(db), id), /no longer on the list/);
});

test('a test alert to a browser that never subscribed is refused before anything is sent', async () => {
  const { db } = setup();
  await assert.rejects(push.test(ctx(db, { body: { endpoint: ENDPOINT } })), /not set up for alerts yet/);
});

// ---------------------------------------------------------------------------
// Users & data
// ---------------------------------------------------------------------------

test('the users list carries the roles, the permissions and the staff to link to', async () => {
  const { db } = setup();
  const out = await read(await listUsers(ctx(db)));
  assert.equal(out.users.length, 2);
  const kwame = out.users.find((u) => u.id === 1);
  assert.equal(kwame.signsInWith, 'password');
  assert.equal(kwame.hasPassword, true);
  assert.ok(kwame.permissions.includes('users'));
  assert.ok(out.roles.some((r) => r.key === 'admin'));
  assert.ok(out.permissions.some((p) => p.key === 'att_view'));
  assert.ok(Array.isArray(out.staff));
});

test('the only administrator cannot be removed; anybody else can, and their staff link is cut', async () => {
  const { raw, db } = setup();
  await assert.rejects(deleteUser(ctx(db), 1), /only administrator/);

  const staffId = raw.prepare('SELECT id FROM att_staff LIMIT 1').get().id;
  raw.prepare('UPDATE att_staff SET user_id = 2 WHERE id = ?').run(staffId);
  await deleteUser(ctx(db), 2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM users WHERE id = 2').get().n, 0);
  assert.equal(raw.prepare('SELECT user_id FROM att_staff WHERE id = ?').get(staffId).user_id, null,
    'the attendance record stands on its own');
  assert.ok(raw.prepare("SELECT 1 FROM audit_log WHERE action = 'user.delete'").get());
  await assert.rejects(deleteUser(ctx(db), 99), /not found/i);
});

test('the notifications screen reads its settings, and saves what is valid', async () => {
  const { raw, db } = setup();
  const before = await read(await getNotifications(ctx(db)));
  assert.equal(before.emailEnabled, false);
  assert.equal(before.pushEnabled, true);
  assert.equal(before.providerConfigured, false);
  assert.deepEqual(before.recipients, []);

  await assert.rejects(
    updateNotifications(ctx(db, { body: { recipients: ['not an address'] } })),
    /Not a valid email address/,
  );
  await assert.rejects(
    updateNotifications(ctx(db, { body: { siteUrl: 'ftp://x' } })),
    /should start with https/,
  );

  const saved = await read(await updateNotifications(ctx(db, {
    body: {
      emailEnabled: true,
      recipients: ['owner@example.com', 'manager@example.com'],
      senderName: 'Somewhere Nice',
      siteUrl: 'https://staff.example.com/#/att-today',
    },
    env: { RESEND_API_KEY: 'k' },
  })));
  assert.equal(saved.emailEnabled, true);
  assert.deepEqual(saved.recipients, ['owner@example.com', 'manager@example.com']);
  assert.equal(saved.senderName, 'Somewhere Nice');
  assert.equal(saved.siteUrl, 'https://staff.example.com', 'kept as the origin, not the path');
  assert.equal(saved.providerConfigured, true);
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'att_email_enabled'").get().value, '1');
});

test('erasing needs the phrase, and inside dates it leaves the rest alone', async () => {
  const { raw, db } = setup();
  const staffId = raw.prepare('SELECT id FROM att_staff LIMIT 1').get().id;
  // The seeds carry a demo month of punches; the test wants a clean slate.
  raw.exec('DELETE FROM att_roster; DELETE FROM att_punches; DELETE FROM att_days; DELETE FROM att_leave;');
  for (const day of ['2026-06-10', '2026-07-10', '2026-08-10']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, set_by) VALUES (?, ?, 1, \'t\')').run(staffId, day);
    raw.prepare(
      `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, dedupe_key)
       VALUES ('D', '1', ?, ?, ?, ?, ?)`,
    ).run(staffId, `${day}T06:00:00Z`, `${day} 06:00`, day, `k${day}`);
  }

  await assert.rejects(eraseData(ctx(db, { body: { confirm: 'erase' } })), /Type ERASE/);
  await assert.rejects(
    eraseData(ctx(db, { body: { confirm: 'ERASE', from: '2026-08-01', to: '2026-07-01' } })),
    /after the end date/,
  );

  const out = await read(await eraseData(ctx(db, { body: { confirm: 'ERASE', from: '2026-07-01', to: '2026-07-31' } })));
  assert.equal(out.from, '2026-07-01');
  assert.deepEqual(raw.prepare('SELECT day FROM att_punches ORDER BY day').all().map((r) => r.day),
    ['2026-06-10', '2026-08-10']);
  assert.deepEqual(raw.prepare('SELECT day FROM att_roster ORDER BY day').all().map((r) => r.day),
    ['2026-06-10', '2026-08-10']);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n > 0, true, 'people are never touched');

  const trail = await read(await auditTrail(ctx(db, { query: '?limit=5' })));
  assert.equal(trail.entries[0].action, 'data.erase');
  assert.ok(trail.entries.length <= 5);
});

test('the bell lists what is new to this person and stops once it is marked seen', async () => {
  const { db } = setup();
  await createNotice(db, { kind: 'x', title: 'For everybody', body: null, email: false });
  await createNotice(db, { kind: 'x', title: 'For administrators', audience: 'users', email: false });
  await createNotice(db, { kind: 'x', title: 'For the rota', audience: 'att_rota', email: false });

  const mine = await read(await listNoticesRoute(ctx(db)));
  assert.deepEqual(mine.notices.map((n) => n.title), ['For administrators', 'For everybody'],
    'newest first, and only what this person may see');
  assert.equal(mine.unread, 2);

  await markNoticesSeen(ctx(db, { body: { lastId: mine.latestId } }));
  const after = await read(await listNoticesRoute(ctx(db)));
  assert.equal(after.unread, 0);
  assert.equal(after.notices.length, 2, 'still listed, no longer new');
});

// ---------------------------------------------------------------------------
// Why a login was refused
// ---------------------------------------------------------------------------

test('a clash says which thing clashed, not whichever one the role suggests', async () => {
  const { raw, db } = setup();
  const staff = raw.prepare('SELECT id FROM att_staff ORDER BY id LIMIT 2').all();
  const [one, two] = staff.map((s) => s.id);

  await createUser(ctx(db, { body: { name: 'Ama', role: 'staff', pin: '111222', staffId: one } }));

  // The one that was reported as a PIN problem for years. SQLite names the
  // column, not the index, so the old check for the index name never matched.
  await assert.rejects(
    () => createUser(ctx(db, { body: { name: 'Kofi', role: 'staff', pin: '333444', staffId: one } })),
    /member of staff already has a login/,
  );

  // A PIN really in use still says so.
  await assert.rejects(
    () => createUser(ctx(db, { body: { name: 'Yaw', role: 'staff', pin: '111222' } })),
    /PIN is not available/,
  );

  // And an administrator with somebody else's PIN is told about the PIN,
  // where the old guess-by-role would have blamed their email address.
  await assert.rejects(
    () => createUser(ctx(db, {
      body: {
        name: 'Efua', role: 'admin', email: 'efua@example.com', pin: '111222',
        passwordKey: 'k', passwordSalt: 'AAAA', passwordIterations: 1,
      },
    })),
    /PIN is not available/,
  );

  // A duplicate email is still a duplicate email.
  await createUser(ctx(db, {
    body: {
      name: 'Efua', role: 'admin', email: 'efua@example.com', pin: '555666',
      passwordKey: 'k', passwordSalt: 'AAAA', passwordIterations: 1,
    },
  }));
  await assert.rejects(
    () => createUser(ctx(db, {
      body: {
        name: 'Adjoa', role: 'admin', email: 'efua@example.com', pin: '777888',
        passwordKey: 'k', passwordSalt: 'AAAA', passwordIterations: 1,
      },
    })),
    /email address is already in use/,
  );

  // Editing somebody onto a taken staff record says the same thing.
  const yaw = await (await createUser(ctx(db, { body: { name: 'Yaw', role: 'staff', pin: '999000', staffId: two } }))).json();
  await assert.rejects(
    () => updateUser(ctx(db, { body: { name: 'Yaw', role: 'staff', staffId: one } }), yaw.user.id),
    /member of staff already has a login/,
  );
});

test('the picker says who is already spoken for, so the clash is avoidable', async () => {
  const { raw, db } = setup();
  const one = raw.prepare('SELECT id FROM att_staff ORDER BY id LIMIT 1').get().id;
  await createUser(ctx(db, { body: { name: 'Ama', role: 'staff', pin: '111222', staffId: one } }));

  const list = await read(await listUsers(ctx(db)));
  const taken = list.staff.find((s) => s.id === one);
  assert.equal(taken.has_login, 1, 'the picker can grey this one out');
  assert.ok(list.staff.some((s) => !s.has_login), 'and leave the rest alone');
});
