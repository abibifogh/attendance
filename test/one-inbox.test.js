import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { getPepper, hashPin } from '../src/lib/auth.js';

/**
 * One Inbox for every decision.
 *
 * Leave, clock times, swaps, advances, claims, lunch changes and documents
 * used to wait on eight screens. The Inbox lists them for whoever is signed
 * in and decides each through the route its own screen uses, as that person,
 * so the checks and the record are exactly the same. Every name is made up.
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
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Ama Test', 'Front office', '2020-01-01')").run();
  raw.prepare("INSERT INTO users (id, name, role, active, pin_hash, pin_ok) VALUES (3, 'Boss Test', 'admin', 1, ?, 1)").run(await hashPin('481920', pepper));
  raw.prepare("INSERT INTO users (id, name, role, active, staff_id, permissions, pin_hash, pin_ok) VALUES (7, 'Ama Test', 'staff', 1, 1, '[\"att_me\"]', ?, 1)").run(await hashPin('550011', pepper));
  raw.prepare("INSERT INTO att_leave (id, staff_id, reason_code, from_day, to_day, days, status, reason, requested_by, requested_by_id, requested_at) VALUES (11, 1, 'annual_leave', '2026-11-02', '2026-11-04', 3, 'pending', 'A family visit', 'Ama Test (staff)', 7, '2026-10-10 09:00:00')").run();
  raw.prepare("INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, reason, purpose, asked_at) VALUES (21, 1, 600, 3, 200, 'requested', 'Rent', 'other', '2026-10-12 09:00:00')").run();
  return { raw, env };
}

async function signIn(env, pin) {
  const res = await worker.fetch(new Request('https://hive.test/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  }), env, { waitUntil() {} });
  assert.equal(res.status, 200, await res.clone().text());
  return (res.headers.get('Set-Cookie') ?? '').split(';')[0];
}

async function call(env, cookie, method, path, body) {
  const res = await worker.fetch(new Request(`https://hive.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
}

test('the inbox lists what this person may decide, oldest first', async () => {
  const { env } = await setup();
  const cookie = await signIn(env, '481920');
  const { status, data } = await call(env, cookie, 'GET', '/api/inbox');
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual(data.failed, []);
  assert.deepEqual(data.items.map((i) => i.kind), ['leave', 'advance'], 'oldest first');
  assert.equal(data.items[0].link, '#/att-leave', 'an address inside HIVE, not a whole website');
  assert.equal(data.items[0].who, 'Ama Test');
});

test('a decision from the inbox goes through the leave route, under the person’s own name', async () => {
  const { raw, env } = await setup();
  const cookie = await signIn(env, '481920');
  const out = await call(env, cookie, 'POST', '/api/inbox/decide', {
    kind: 'leave', id: '11', decision: 'approve', fields: { daysCharged: 3 },
  });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const row = raw.prepare('SELECT status, decided_by FROM att_leave WHERE id = 11').get();
  assert.equal(row.status, 'approved');
  assert.match(row.decided_by, /^Boss Test/);
  assert.doesNotMatch(row.decided_by, /Insight/, 'pressed in HIVE, so it says nothing about Insight');
  const after = await call(env, cookie, 'GET', '/api/inbox');
  assert.deepEqual(after.data.items.map((i) => i.kind), ['advance']);
});

test('somebody who decides nothing has an empty inbox and cannot decide through it', async () => {
  const { raw, env } = await setup();
  const cookie = await signIn(env, '550011');
  const list = await call(env, cookie, 'GET', '/api/inbox');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.items, []);
  const refused = await call(env, cookie, 'POST', '/api/inbox/decide', { kind: 'leave', id: '11', decision: 'approve' });
  assert.equal(refused.status, 403);
  assert.equal(raw.prepare('SELECT status FROM att_leave WHERE id = 11').get().status, 'pending');
});

test('a decision HIVE does not know is refused rather than guessed at', async () => {
  const { env } = await setup();
  const cookie = await signIn(env, '481920');
  assert.equal((await call(env, cookie, 'POST', '/api/inbox/decide', { kind: 'nonsense', id: '1', decision: 'approve' })).status, 400);
  assert.equal((await call(env, cookie, 'POST', '/api/inbox/decide', { kind: 'leave', id: '11', decision: 'maybe' })).status, 400);
});
