import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie } from '../src/lib/auth.js';
import { run } from '../src/lib/db.js';
import { accessOf, roleOf } from '../src/routes/till.js';

/**
 * An account that uploads the shift files and does nothing else.
 *
 * Driven through the Worker's front door, so the refusals are the real ones.
 * Everybody here is invented.
 */

const PAGE = ['EHC/XXX test hotel   02.08.26 05:00', 'Business Reports   Page: 1', 'Benefit Date:   01.08.26   01.08.26', 'Type of Report:   Detail Journal of every Transaction'];

async function setUp() {
  const { db } = freshDb('migrations');
  const env = { DB: db, SESSION_SECRET: 'insight-signing', DASHBOARD_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('x') } };
  await run(db, "INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES (5, 'files@example.test', 'Fiifi Files', 0, 1, 'x')");
  await run(db, "INSERT INTO account_access (account_id, system_id, role) VALUES (5, 'insight', 'uploader')");
  const cookie = sessionCookie(await createToken(env.SESSION_SECRET, { accountId: 5 })).split(';')[0];
  const call = async (method, path, body) => {
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { env, call };
}

test('an uploader may load the three files and see what has been loaded', async () => {
  const { call } = await setUp();
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.data.account.till.role, 'uploader');
  assert.equal(me.data.account.canSeeReports, false);

  const loaded = await call('POST', '/api/shifts/journal', {
    name: 'journal.pdf',
    lines: [...PAGE, 'Beginn of Day Processing   ALPHA', '01-104-700100   001/9700100-   01.08.26   /'],
  });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.data));

  const files = await call('GET', '/api/shifts/files');
  assert.equal(files.status, 200);
  assert.deepEqual(files.data.coverage.journal, { from: '2026-08-01', to: '2026-08-01' });
  assert.equal(files.data.uploads[0].by, 'Fiifi Files');
  assert.equal(files.data.canUpload, true);
  assert.deepEqual(Object.keys(files.data).sort(), ['canUpload', 'coverage', 'uploads'], 'nothing about what is in the files');
});

test('and nothing else', async () => {
  const { call } = await setUp();
  for (const [method, path] of [
    ['GET', '/api/shifts?from=2026-08-01&to=2026-08-01'], ['GET', '/api/brief'], ['GET', '/api/pnl'], ['GET', '/api/bootstrap'],
    ['GET', '/api/till'], ['GET', '/api/stays'], ['GET', '/api/safe'], ['POST', '/api/shifts/answer'],
    ['POST', '/api/shifts/movement'], ['GET', '/api/accounts'], ['GET', '/api/sources'],
  ]) {
    const out = await call(method, path, method === 'POST' ? { key: 'x', answer: 'y', seq: 1 } : undefined);
    assert.equal(out.status, 403, `${method} ${path} answered ${out.status}`);
  }
  // The hub still works: it is how they reach anything else they were given.
  assert.equal((await call('GET', '/api/hub')).status, 200);
});

test('the role and its access, on their own', () => {
  const account = { id: 5, isOwner: false, access: [{ systemId: 'insight', role: 'uploader' }] };
  assert.equal(roleOf(account), 'uploader');
  return accessOf({ DB: null }, account).then((access) => {
    assert.equal(access.files, 2);
    assert.ok(Object.entries(access).filter(([k]) => k !== 'files').every(([, v]) => v === 0));
  });
});
