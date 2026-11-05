import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie, mayViewAs } from '../src/lib/auth.js';
import { run } from '../src/lib/db.js';
import { accessOf, roleOf } from '../src/routes/till.js';

/**
 * Nice Place cash: an account that sees Nice Place's counters and money and
 * picks up its cash, and nothing else. Driven through the Worker's front door,
 * so the refusals are the real ones. Everybody here is invented.
 */

async function setUp() {
  const { db } = freshDb('migrations');
  const env = { DB: db, SESSION_SECRET: 'insight-signing', DASHBOARD_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('x') } };
  await run(db, "INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES (7, 'cash@example.test', 'Kwesi Test', 0, 1, 'x')");
  await run(db, "INSERT INTO account_access (account_id, system_id, role) VALUES (7, 'insight', 'npcash')");
  const cookie = sessionCookie(await createToken(env.SESSION_SECRET, { accountId: 7 })).split(';')[0];
  const call = async (method, path, body) => {
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { env, db, call };
}

test('Nice Place cash is its own level: never an admin, Nice Place to see and pickups to make', async () => {
  const { env } = await setUp();
  const account = { id: 7, access: [{ systemId: 'insight', role: 'npcash' }] };
  assert.equal(roleOf(account), 'npcash');
  const access = await accessOf(env, account);
  assert.equal(access.pickups, 2);
  assert.equal(access.niceplace, 1, 'sees the counters; does not read them for others');
  assert.equal(Object.entries(access).filter(([k, v]) => v > 0 && !['pickups', 'niceplace'].includes(k)).length, 0, 'nothing else');
  assert.equal(mayViewAs(account), false);
});

test('opens Nice Place and its pickups', async () => {
  const { call } = await setUp();
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.data.account.till.role, 'npcash');
  assert.equal(me.data.account.canSeeReports, false);
  const page = await call('GET', '/api/np');
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.equal(page.data.admin, false);
  assert.equal(page.data.link, null, 'not the desk link');
  const pickups = await call('GET', '/api/np/pickups');
  assert.equal(pickups.status, 200, JSON.stringify(pickups.data));
  const start = await call('POST', '/api/np/pickups/start', {});
  assert.notEqual(start.status, 403, JSON.stringify(start.data));
});

test('and nothing else', async () => {
  const { call } = await setUp();
  for (const [method, path] of [
    ['GET', '/api/shifts?from=2026-08-01&to=2026-08-01'], ['GET', '/api/pnl'], ['GET', '/api/labour'], ['GET', '/api/bootstrap'],
    ['GET', '/api/till'], ['GET', '/api/safe'], ['GET', '/api/todo'], ['GET', '/api/accounts'], ['GET', '/api/team'],
    ['POST', '/api/np/answer'], ['POST', '/api/np/check'], ['POST', '/api/np/review'], ['POST', '/api/np/settings'], ['POST', '/api/np/pickups/review'],
    ['GET', '/api/stock'], ['GET', '/api/approvals'],
  ]) {
    const out = await call(method, path, method === 'POST' ? { day: '2026-11-01', shift: 'day' } : undefined);
    assert.equal(out.status, 403, `${method} ${path} answered ${out.status}`);
  }
});
