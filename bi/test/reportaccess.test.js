import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie } from '../src/lib/auth.js';
import { all, run } from '../src/lib/db.js';
import * as access from '../src/routes/reportaccess.js';

/** Who sees which reports. Everybody is invented. */

async function world() {
  const { db } = freshDb('migrations');
  const env = { DB: db, SESSION_SECRET: 'insight-signing', DASHBOARD_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('x') } };
  await run(db, `INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES
    (1, 'owner@example.test', 'Ola Owner', 1, 1, 'x'),
    (2, 'admin@example.test', 'Ade Admin', 0, 1, 'x'),
    (3, 'sup@example.test', 'Sam Supervisor', 0, 1, 'x'),
    (4, 'gm@example.test', 'Gina Manager', 0, 1, 'x'),
    (5, 'up@example.test', 'Uche Uploader', 0, 1, 'x')`);
  await run(db, `INSERT INTO account_access (account_id, system_id, role) VALUES
    (2, 'insight', ''), (3, 'insight', 'supervisor'), (5, 'insight', 'uploader')`);
  const call = async (id, method, path, body) => {
    const cookie = sessionCookie(await createToken(env.SESSION_SECRET, { accountId: id })).split(';')[0];
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { env, db, call };
}

test('only an admin chooses; admins see every report and cannot be narrowed', async () => {
  const { call } = await world();
  assert.equal((await call(3, 'GET', '/api/report-access')).status, 403);
  const listed = await call(2, 'GET', '/api/report-access');
  assert.equal(listed.status, 200);
  const level = Object.fromEntries(listed.data.people.map((p) => [p.name, p.levelWords]));
  assert.deepEqual(level, { 'Ade Admin': 'Admin', 'Gina Manager': 'Hub only', 'Ola Owner': 'Owner', 'Sam Supervisor': 'Supervisor', 'Uche Uploader': 'Uploads only' });
  const refused = await call(2, 'POST', '/api/report-access', { accountId: 2, reports: ['brief'] });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /every report already/);
  assert.equal((await call(2, 'POST', '/api/report-access', { accountId: 3, reports: ['nope'] })).status, 400);
});

test('a supervisor given Labour opens Labour and nothing else of the reports', async () => {
  const { call } = await world();
  assert.equal((await call(3, 'GET', '/api/labour')).status, 403, 'nothing before it is shared');
  const saved = await call(1, 'POST', '/api/report-access', { accountId: 3, reports: ['labour'] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.notEqual((await call(3, 'GET', '/api/labour')).status, 403);
  const pnl = await call(3, 'GET', '/api/pnl');
  assert.equal(pnl.status, 403);
  assert.match(pnl.data.error, /Profit & loss has not been shared with you/);
  assert.equal((await call(3, 'POST', '/api/findings/1', {})).status, 403, 'what only an admin does stays an admin\'s');
  const me = await call(3, 'GET', '/api/auth/me');
  assert.deepEqual(me.data.account.reports, ['labour']);
  assert.equal(me.data.account.till.role, 'supervisor', 'still a supervisor for Shifts');
});

test('somebody with only the hub, given a report, gets Insight as Reports only; the last one taken away takes it back', async () => {
  const { db, call } = await world();
  await call(2, 'POST', '/api/report-access', { accountId: 4, reports: ['management', 'brief'] });
  const grant = async () => (await all(db, "SELECT role FROM account_access WHERE account_id = 4 AND system_id = 'insight'"))[0]?.role ?? null;
  assert.equal(await grant(), 'reports');
  const me = await call(4, 'GET', '/api/auth/me');
  assert.deepEqual(me.data.account.reports.sort(), ['brief', 'management']);
  assert.equal(me.data.account.canSeeReports, false, 'not an admin');
  assert.notEqual((await call(4, 'GET', '/api/brief')).status, 403);
  assert.notEqual((await call(4, 'GET', '/api/bootstrap')).status, 403, 'the reports\' bootstrap');
  assert.equal((await call(4, 'GET', '/api/labour')).status, 403);
  assert.equal((await call(4, 'GET', '/api/shifts')).status, 403, 'no Shifts');
  assert.equal((await call(4, 'GET', '/api/approvals')).status, 403);
  assert.equal(me.data.account.mayViewAs, false, 'cannot look as others');

  await call(2, 'POST', '/api/report-access', { accountId: 4, reports: [] });
  assert.equal(await grant(), null);
  assert.equal((await call(4, 'GET', '/api/brief')).status, 403);
});

test('an uploader given a report keeps the files and reads that report', async () => {
  const { call } = await world();
  await call(1, 'POST', '/api/report-access', { accountId: 5, reports: ['cash'] });
  assert.notEqual((await call(5, 'GET', '/api/cash')).status, 403);
  assert.notEqual((await call(5, 'GET', '/api/bootstrap')).status, 403);
  assert.equal((await call(5, 'GET', '/api/brief')).status, 403);
  assert.notEqual((await call(5, 'GET', '/api/shifts/files')).status, 403);
  assert.equal((await call(5, 'GET', '/api/shifts')).status, 403);
});

test('every report page reads only endpoints named with its report', () => {
  assert.equal(new Set(access.REPORTS.map((r) => r.key)).size, 10);
  assert.equal(access.reportOfEndpoint('GET', '/api/pnl'), 'money');
  assert.equal(access.reportOfEndpoint('GET', '/api/money/cash'), 'money');
  assert.equal(access.reportOfEndpoint('POST', '/api/money/cash/refresh'), null, 'refreshing stays an admin\'s');
  assert.equal(access.reportOfEndpoint('GET', '/api/np'), 'niceplace');
});
