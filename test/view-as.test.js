import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { getPepper, hashPin } from '../src/lib/auth.js';

/**
 * An administrator viewing HIVE as somebody else.
 *
 * Every screen is answered as that person, so what the administrator sees is
 * exactly what they see; nothing can be changed while it lasts; only an
 * administrator can start it, only for themselves, and the lock screen still
 * wants the administrator's own PIN. Every name is made up.
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
    async raw() { return db.prepare(sql).all(...binds).map((r) => Object.values(r)); },
  });
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec("DELETE FROM users; DELETE FROM att_staff; UPDATE settings SET value = 'UTC' WHERE key = 'timezone';");
  const env = { DB: d1(raw), SESSION_SECRET: 'x'.repeat(40) };
  const pepper = await getPepper(env.DB);
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Ama Test', 'Reception', '2020-01-01')").run();
  raw.prepare("INSERT INTO users (id, name, role, active, pin_hash, pin_ok) VALUES (3, 'Boss Test', 'admin', 1, ?, 1)").run(await hashPin('481920', pepper));
  raw.prepare("INSERT INTO users (id, name, role, active, pin_hash, pin_ok) VALUES (4, 'Other Boss', 'admin', 1, ?, 1)").run(await hashPin('592031', pepper));
  raw.prepare("INSERT INTO users (id, name, role, active, staff_id, permissions, pin_hash, pin_ok) VALUES (7, 'Ama Test', 'staff', 1, 1, '[\"att_me\",\"till\"]', ?, 1)").run(await hashPin('550011', pepper));
  return { raw, env };
}

async function fetchAs(env, cookies, method, path, body) {
  const res = await worker.fetch(new Request(`https://hive.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookies.join('; ') },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, data: await res.json().catch(() => ({})), setCookies };
}

async function signIn(env, pin) {
  const out = await fetchAs(env, [], 'POST', '/api/auth/login', { pin });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  return out.setCookies.map((c) => c.split(';')[0]);
}

test('an administrator views as a member of staff and sees what they see', async () => {
  const { env, raw } = await setup();
  const boss = await signIn(env, '481920');

  const people = await fetchAs(env, boss, 'GET', '/api/view-as/people');
  assert.equal(people.status, 200);
  const ama = people.data.people.find((p) => p.id === 7);
  assert.equal(ama.frontDesk, true, 'a member of staff who closes a till is the front desk');
  assert.ok(!people.data.people.some((p) => p.id === 3), 'not themselves');

  const start = await fetchAs(env, boss, 'POST', '/api/view-as', { userId: 7 });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const viewing = [...boss, ...start.setCookies.map((c) => c.split(';')[0])];

  const me = await fetchAs(env, viewing, 'GET', '/api/auth/me');
  assert.equal(me.data.name, 'Ama Test');
  assert.equal(me.data.role, 'staff');
  assert.ok(me.data.permissions.includes('till'));
  assert.ok(!me.data.permissions.includes('users'), 'their permissions, not the administrator’s');
  assert.deepEqual(me.data.viewAs, { name: 'Ama Test', roleLabel: 'Member of staff', by: 'Boss Test' });

  const week = await fetchAs(env, viewing, 'GET', '/api/me/week');
  assert.equal(week.status, 200, 'their own week opens');
  const refused = await fetchAs(env, viewing, 'GET', '/api/att/staff');
  assert.equal(refused.status, 403, 'and what they cannot open, the administrator cannot either while viewing');

  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'view_as.start'").get().n, 1);
});

test('nothing can be changed while viewing as somebody', async () => {
  const { env } = await setup();
  const boss = await signIn(env, '481920');
  const start = await fetchAs(env, boss, 'POST', '/api/view-as', { userId: 7 });
  const viewing = [...boss, ...start.setCookies.map((c) => c.split(';')[0])];

  const save = await fetchAs(env, viewing, 'POST', '/api/me/till', { day: '2026-10-18', slot: 'morning' });
  assert.equal(save.status, 403);
  assert.match(save.data.error, /viewing HIVE as Ama Test, so nothing can be changed/);

  // Their own PIN still opens a locked screen, and stopping works.
  const unlock = await fetchAs(env, viewing, 'POST', '/api/auth/unlock', { pin: '481920' });
  assert.equal(unlock.status, 200, JSON.stringify(unlock.data));
  const stop = await fetchAs(env, viewing, 'POST', '/api/view-as/stop', {});
  assert.equal(stop.status, 200);
  assert.ok(stop.setCookies.some((c) => /^hive_view_as=;/.test(c)), 'the view is cleared');
});

test('only an administrator can start it, and only their own view counts', async () => {
  const { env } = await setup();
  const ama = await signIn(env, '550011');
  assert.equal((await fetchAs(env, ama, 'POST', '/api/view-as', { userId: 3 })).status, 403);

  const boss = await signIn(env, '481920');
  const start = await fetchAs(env, boss, 'POST', '/api/view-as', { userId: 7 });
  const token = start.setCookies.map((c) => c.split(';')[0]);
  // Another administrator holding the first one's view cookie is still themselves.
  const other = await signIn(env, '592031');
  const me = await fetchAs(env, [...other, ...token], 'GET', '/api/auth/me');
  assert.equal(me.data.name, 'Other Boss');
  assert.equal(me.data.viewAs, null);
  // And a member of staff holding it is still themselves.
  const amaMe = await fetchAs(env, [...ama, ...token], 'GET', '/api/auth/me');
  assert.equal(amaMe.data.name, 'Ama Test');
  assert.equal(amaMe.data.viewAs, null);
});
