import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie } from '../src/lib/auth.js';
import { run } from '../src/lib/db.js';

/**
 * View as: an admin sees Insight as somebody else does, look only. Driven
 * through the Worker's front door, cookies and all. Everybody is invented.
 */

async function setUp() {
  const { db } = freshDb('migrations');
  const env = { DB: db, SESSION_SECRET: 'insight-signing', DASHBOARD_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('x') } };
  await run(db, `INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES
    (1, 'owner@example.test', 'Ola Owner', 1, 1, 'x'), (2, 'admin@example.test', 'Ama Admin', 0, 1, 'x'),
    (3, 'sup@example.test', 'Sam Supervisor', 0, 1, 'x'), (4, 'files@example.test', 'Uma Uploader', 0, 1, 'x'),
    (5, 'gone@example.test', 'Gone Person', 0, 0, 'x'), (6, 'owner2@example.test', 'Second Owner', 1, 1, 'x')`);
  await run(db, `INSERT INTO account_access (account_id, system_id, role) VALUES
    (2, 'insight', ''), (3, 'insight', 'supervisor'), (4, 'insight', 'uploader')`);
  const jar = new Map();
  const as = async (id) => {
    jar.clear();
    jar.set('insight_session', sessionCookie(await createToken(env.SESSION_SECRET, { accountId: id })).split(';')[0].split('=').slice(1).join('='));
  };
  const call = async (method, path, body) => {
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    // Keep what the server sets, as a browser would.
    for (const set of response.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = set.split(';');
      const [name, ...rest] = pair.split('=');
      if (attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name.trim()); else jar.set(name.trim(), rest.join('='));
    }
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { env, db, as, call, jar };
}

test('an admin looks as a supervisor: answered as them, and nothing can be changed', async () => {
  const { as, call, db } = await setUp();
  await as(2);
  const me0 = await call('GET', '/api/auth/me');
  assert.equal(me0.data.account.mayViewAs, true);
  assert.equal(me0.data.account.viewedBy, null);

  // Whom: active people other than me, no owner (I am not one), each with what they are.
  const choices = await call('GET', '/api/view-as');
  assert.deepEqual(choices.data.accounts.map((a) => [a.name, a.role.split(':')[0]]), [['Sam Supervisor', 'Supervisor'], ['Uma Uploader', 'Uploader']]);

  const started = await call('POST', '/api/view-as', { accountId: 3 });
  assert.equal(started.status, 200, JSON.stringify(started.data));

  const me = await call('GET', '/api/auth/me');
  assert.equal(me.data.account.name, 'Sam Supervisor');
  assert.equal(me.data.account.till.role, 'supervisor');
  assert.deepEqual(me.data.account.viewedBy, { id: 2, name: 'Ama Admin' });
  assert.equal(me.data.account.mayViewAs, true, 'the admin can still switch to somebody else');

  // What Sam cannot open, the admin cannot open while looking as Sam.
  assert.equal((await call('GET', '/api/brief')).status, 403);
  // Every change is refused, saying why.
  const refused = await call('POST', '/api/shifts/answer', { key: 'x', answer: 'Explained' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /viewing as Sam Supervisor: nothing can be changed/);
  assert.equal((await call('POST', '/api/sso/start', { system: 'attendance' })).status, 403, 'no opening another system as them');
  assert.equal((await call('POST', '/api/auth/change-password', {})).status, 403);

  // Switch, then stop: back to being the admin. Each time is logged.
  assert.equal((await call('POST', '/api/view-as', { accountId: 4 })).status, 200);
  assert.equal((await call('GET', '/api/auth/me')).data.account.till.role, 'uploader');
  assert.equal((await call('POST', '/api/view-as/stop')).status, 200);
  const back = await call('GET', '/api/auth/me');
  assert.equal(back.data.account.name, 'Ama Admin');
  assert.equal(back.data.account.viewedBy, null);
  const log = (await db.prepare('SELECT as_name, ended_at FROM view_as_log ORDER BY id').all()).results;
  assert.deepEqual(log.map((r) => [r.as_name, Boolean(r.ended_at)]), [['Sam Supervisor', true], ['Uma Uploader', true]]);
});

test('who may look as whom', async () => {
  const { as, call, jar } = await setUp();
  // A supervisor and an uploader may not.
  await as(3);
  assert.equal((await call('GET', '/api/auth/me')).data.account.mayViewAs, false);
  assert.equal((await call('GET', '/api/view-as')).status, 403);
  assert.equal((await call('POST', '/api/view-as', { accountId: 4 })).status, 403);

  // An admin may not look as an owner, themself, or somebody switched off.
  await as(2);
  assert.match((await call('POST', '/api/view-as', { accountId: 1 })).data.error, /Only an owner/);
  assert.match((await call('POST', '/api/view-as', { accountId: 2 })).data.error, /That is you/);
  assert.match((await call('POST', '/api/view-as', { accountId: 5 })).data.error, /switched off/);

  // An owner may look as anybody active, another owner and admins included.
  await as(1);
  const names = (await call('GET', '/api/view-as')).data.accounts.map((a) => a.name);
  assert.deepEqual(names, ['Ama Admin', 'Sam Supervisor', 'Second Owner', 'Uma Uploader']);

  // The cookie is the admin's own: handed to somebody else's session, it does nothing.
  assert.equal((await call('POST', '/api/view-as', { accountId: 3 })).status, 200);
  const cookie = jar.get('insight_view_as');
  await as(2);
  jar.set('insight_view_as', cookie);
  assert.equal((await call('GET', '/api/auth/me')).data.account.name, 'Ama Admin');

  // Signing out ends it too.
  await as(1);
  jar.set('insight_view_as', cookie);
  assert.equal((await call('GET', '/api/auth/me')).data.account.name, 'Sam Supervisor');
  await call('POST', '/api/auth/logout');
  assert.equal(jar.has('insight_view_as'), false);
});

test('an admin who loses admin stops looking at once', async () => {
  const { as, call, db } = await setUp();
  await as(2);
  await call('POST', '/api/view-as', { accountId: 3 });
  await run(db, "UPDATE account_access SET role = 'supervisor' WHERE account_id = 2");
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.data.account.name, 'Ama Admin');
  assert.equal(me.data.account.viewedBy, null);
});
