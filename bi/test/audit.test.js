import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie } from '../src/lib/auth.js';
import { all, run } from '../src/lib/db.js';
import { redact, subjectOf } from '../src/lib/audit.js';

/**
 * The audit trail: every change recorded at the front door before it runs,
 * how it ended after, and nothing in it ever changed or deleted. Everybody
 * is invented.
 */

async function setUp() {
  const { db, raw } = freshDb('migrations');
  const env = { DB: db, SESSION_SECRET: 'insight-signing', DASHBOARD_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('x') } };
  await run(db, `INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES
    (1, 'owner@example.test', 'Ola Owner', 1, 1, 'x'), (3, 'sup@example.test', 'Sam Supervisor', 0, 1, 'x')`);
  await run(db, "INSERT INTO account_access (account_id, system_id, role) VALUES (3, 'insight', 'supervisor')");
  const call = async (id, method, path, body) => {
    const cookie = `insight_session=${sessionCookie(await createToken(env.SESSION_SECRET, { accountId: id })).split(';')[0].split('=').slice(1).join('=')}`;
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { env, db, raw, call };
}

test('a change is recorded before it runs and after: who, what, about what, and how it ended', async () => {
  const { db, call } = await setUp();
  const ok = await call(1, 'POST', '/api/shifts/answer', { key: 'drawer:2026-08-01:morning', answer: 'Explained', note: 'Counted again' });
  assert.equal(ok.status, 200);
  const rows = await all(db, 'SELECT * FROM audit_event ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.stage, r.path, r.actor, r.via, r.subject]), [
    ['asked', '/api/shifts/answer', 'Ola Owner', 'session', 'drawer:2026-08-01:morning'],
    ['done', '/api/shifts/answer', null, null, null],
  ]);
  assert.equal(rows[0].request_id, rows[1].request_id);
  assert.match(rows[0].detail, /"note":"Counted again"/);

  // Refused: kept too, with why.
  const no = await call(3, 'POST', '/api/till/settings', { threshold: 0 });
  assert.notEqual(no.status, 200);
  const refused = (await all(db, "SELECT * FROM audit_event WHERE stage = 'refused'"))[0];
  assert.match(refused.detail, /"status":403/);

  // Reading is not a change.
  await call(1, 'GET', '/api/audit');
  assert.equal((await all(db, "SELECT * FROM audit_event WHERE path = '/api/audit'")).length, 0);
  const seen = await call(1, 'GET', '/api/audit?subject=drawer:2026-08-01:morning');
  assert.equal(seen.data.events.length, 2);
  assert.equal((await call(3, 'GET', '/api/audit')).status, 403, 'an admin’s to read');
});

test('nothing in the trail can be changed or deleted, by anybody', async () => {
  const { raw, call } = await setUp();
  await call(1, 'POST', '/api/shifts/answer', { key: 'drawer:2026-08-01:morning', answer: 'Explained' });
  assert.throws(() => raw.exec("UPDATE audit_event SET actor = 'Somebody Else'"), /cannot be changed/);
  assert.throws(() => raw.exec('DELETE FROM audit_event'), /cannot be deleted/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM audit_event').get().n, 2);
});

test('secrets and files are never kept; what a change is about is read from the request', () => {
  const kept = redact({ password: 'hunter2', newPassword: 'x', pin: '1234', token: 't', key: 'drawer:x', file: `data:image/jpeg;base64,${'A'.repeat(500)}`, lines: Array.from({ length: 100 }, (_, i) => i) });
  assert.deepEqual(kept, { password: '[hidden]', newPassword: '[hidden]', pin: '[hidden]', token: '[hidden]', key: 'drawer:x', file: '[file, 523 characters]', lines: '[100 items]' });
  assert.equal(subjectOf({}, { keys: ['a', 'b'] }), 'a,b');
  assert.equal(subjectOf({}, { day: '2026-08-01', slot: 'night' }), '2026-08-01|night');
  assert.equal(subjectOf({ id: '7' }, {}), '7');
});
