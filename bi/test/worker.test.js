import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import worker from '../src/index.js';
import { runEtl } from '../src/warehouse/etl.js';
import { analyse } from '../src/insight/engine.js';
import {
  createToken, sessionCookie, checkBootstrapPassword, readToken,
  getPepper, storedPassword,
} from '../src/lib/auth.js';
import { run } from '../src/lib/db.js';

/**
 * The Worker itself, driven the way a browser drives it.
 *
 * Every screen in the app is one of these endpoints, so a panel that throws on
 * an empty window or a route that answers 200 without a session is caught
 * here rather than by somebody opening the dashboard on a Monday.
 */

const SECRETS = { SESSION_SECRET: 'test-signing-secret', DASHBOARD_PASSWORD: 'let me in' };
const WINDOW = { from: '2026-03-01', to: '2026-07-15' };

async function app({ loaded = true } = {}) {
  const { raw, db } = freshDb('migrations');
  const env = { DB: db, ...SECRETS, ASSETS: { fetch: async () => new Response('index', { status: 200 }) } };
  if (loaded) {
    await runEtl(env, { ...WINDOW, trigger: 'test' });
    await analyse(db, WINDOW);
  }
  // An owner account, so the reports and the setup screens are reachable. The
  // shared password is a bootstrap route and is tested separately.
  await run(db, "INSERT INTO accounts (email, name, is_owner, password_hash) VALUES ('owner@nice.test','Owner',1,?1)",
    await storedPassword({ passwordKey: 'derived', salt: 'AAAAAAAAAAAAAAAAAAAAAA', iterations: 600000 },
      await getPepper(db)));
  const token = await createToken(env.SESSION_SECRET, { accountId: 1 });
  const call = (path, { method = 'GET', body, signedIn = true } = {}) => worker.fetch(new Request(
    `https://insight.test${path}`,
    {
      method,
      headers: {
        ...(signedIn ? { Cookie: sessionCookie(token).split(';')[0] } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  ), env, { waitUntil: () => {} });
  return { raw, db, env, call };
}

test('every panel answers, over a window with data', async () => {
  const { call } = await app();
  for (const path of ['/api/bootstrap', '/api/brief', '/api/pnl', '/api/labour', '/api/demand',
    '/api/cash', '/api/suppliers', '/api/service', '/api/findings', '/api/sources', '/api/runs']) {
    const response = await call(`${path}${path.includes('?') ? '&' : '?'}from=${WINDOW.from}&to=${WINDOW.to}`);
    assert.equal(response.status, 200, `${path} answered ${response.status}`);
    const body = await response.json();
    assert.ok(body && typeof body === 'object', `${path} returned nothing usable`);
  }
});

test('every panel answers over a window with nothing in it', async () => {
  const { call } = await app();
  // The commonest real failure: somebody picks a date range before the group
  // had any data. Not one of these screens may throw.
  for (const path of ['/api/brief', '/api/pnl', '/api/labour', '/api/demand',
    '/api/cash', '/api/suppliers', '/api/service']) {
    const response = await call(`${path}?from=2019-01-01&to=2019-01-31`);
    assert.equal(response.status, 200, `${path} fell over on an empty window`);
  }
});

test('a panel answers before anything has ever been loaded', async () => {
  const { call } = await app({ loaded: false });
  const response = await call('/api/bootstrap');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.lastRun, null);
  assert.equal(body.data.firstDay, null);

  const brief = await call('/api/brief');
  assert.equal(brief.status, 200, 'an empty warehouse must render, not error');
});

test('nothing but the sign-in endpoints answers without a session', async () => {
  const { call } = await app();
  for (const path of ['/api/bootstrap', '/api/brief', '/api/pnl', '/api/cash',
    '/api/findings', '/api/sources', '/api/runs', '/api/export']) {
    const response = await call(path, { signedIn: false });
    assert.equal(response.status, 401, `${path} let somebody in without a session`);
  }
  // The three that must work signed out, so the app can render a login screen.
  assert.equal((await call('/api/auth/me', { signedIn: false })).status, 200);
});

test('a forged or expired cookie is not a session', async () => {
  const { env } = await app();
  assert.equal(await readToken(env.SESSION_SECRET, 'not-a-token'), null);
  assert.equal(await readToken(env.SESSION_SECRET, '9999999999.deadbeef'), null);

  const expired = await createToken(env.SESSION_SECRET, { accountId: 1, ttl: -60 });
  assert.equal(await readToken(env.SESSION_SECRET, expired), null);

  const valid = await createToken(env.SESSION_SECRET, { accountId: 1 });
  assert.equal((await readToken(env.SESSION_SECRET, valid))?.sub, 1);
  assert.equal(await readToken('a different secret', valid), null,
    'a token signed with another key is not a session here');

  // The payload is only base64, not encrypted — so a tampered one must fail on
  // its signature rather than being believed.
  const [body] = valid.split('.');
  const forged = `${body}x.${valid.split('.')[1]}`;
  assert.equal(await readToken(env.SESSION_SECRET, forged), null);
});

test('the shared password is checked, and a Worker with none configured refuses everybody', async () => {
  assert.equal(await checkBootstrapPassword(SECRETS, 'let me in'), true);
  assert.equal(await checkBootstrapPassword(SECRETS, 'let me IN'), false);
  assert.equal(await checkBootstrapPassword(SECRETS, ''), false);
  await assert.rejects(() => checkBootstrapPassword({ SESSION_SECRET: 'x' }, 'anything'),
    /DASHBOARD_PASSWORD/, 'a misconfigured Worker must lock, not open');
});

test('signing in with an account, and with the shared password', async () => {
  const { call } = await app();

  const bad = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@nice.test', passwordKey: 'wrong' }, signedIn: false });
  assert.equal(bad.status, 401);

  const account = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@nice.test', passwordKey: 'derived' }, signedIn: false });
  assert.equal(account.status, 200);
  assert.match(account.headers.get('Set-Cookie'), /insight_session=.+HttpOnly/);
  assert.equal((await account.json()).account.email, 'owner@nice.test');

  const wrongPassword = await call('/api/auth/login', { method: 'POST', body: { password: 'wrong' }, signedIn: false });
  assert.equal(wrongPassword.status, 401);

  const good = await call('/api/auth/login', { method: 'POST', body: { password: 'let me in' }, signedIn: false });
  assert.equal(good.status, 200);
  assert.match(good.headers.get('Set-Cookie'), /insight_session=.+HttpOnly/);
  assert.match(good.headers.get('Set-Cookie'), /Secure/);

  const out = await call('/api/auth/logout', { method: 'POST' });
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('asking for a salt never reveals who has an account', async () => {
  const { call } = await app();
  const known = await (await call('/api/auth/salt', { method: 'POST', body: { email: 'owner@nice.test' }, signedIn: false })).json();
  const unknown = await (await call('/api/auth/salt', { method: 'POST', body: { email: 'nobody@nowhere.test' }, signedIn: false })).json();

  assert.ok(known.salt && known.iterations >= 100_000);
  assert.ok(unknown.salt && unknown.iterations >= 100_000);
  assert.equal(typeof unknown.salt, typeof known.salt,
    'an address with no account must get an answer of the same shape');

  // And the same address must get the same salt twice, or nobody could sign in.
  const again = await (await call('/api/auth/salt', { method: 'POST', body: { email: 'nobody@nowhere.test' }, signedIn: false })).json();
  assert.equal(again.salt, unknown.salt);
});

test('the export is a CSV with one row per day per line', async () => {
  const { call } = await app();
  const response = await call(`/api/export?from=${WINDOW.from}&to=${WINDOW.to}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/csv/);
  const text = await response.text();
  const lines = text.trim().split('\n');
  assert.match(lines[0], /day,weekday,line,guests_in_house,revenue_net/);
  assert.ok(lines.length > 100, 'the export should carry the whole window');
  // Money in a spreadsheet is written in whole units with two decimals; it is
  // for reading, and nothing downstream adds these up as floats.
  assert.match(lines[1].split(',')[4], /^-?\d+\.\d\d$/);
});

test('a finding can be put down, and stays down', async () => {
  const { call } = await app();
  const list = await (await call('/api/findings?state=live')).json();
  assert.ok(list.findings.length > 0);
  const target = list.findings[0];

  const bad = await call(`/api/findings/${target.id}`, { method: 'POST', body: { state: 'nonsense' } });
  assert.equal(bad.status, 400);

  const ok = await call(`/api/findings/${target.id}`, { method: 'POST', body: { state: 'dismissed' } });
  assert.equal(ok.status, 200);

  const after = await (await call('/api/findings?state=dismissed')).json();
  assert.ok(after.findings.some((f) => f.id === target.id));
});

test('a source address must be https, and a key is never accepted here', async () => {
  const { call } = await app();
  const bad = await call('/api/sources/pos', { method: 'POST', body: { base: 'http://reports.example.com' } });
  assert.equal(bad.status, 400);

  const nonsense = await call('/api/sources/pos', { method: 'POST', body: { base: 'not a url' } });
  assert.equal(nonsense.status, 400);

  const good = await call('/api/sources/pos', { method: 'POST', body: { base: 'https://reports.example.com/ignored/path' } });
  assert.equal(good.status, 200);
  const body = await good.json();
  const pos = body.sources.find((s) => s.id === 'pos');
  assert.equal(pos.config.base, 'https://reports.example.com', 'only the origin is kept');
  assert.ok(!JSON.stringify(body).includes(SECRETS.DASHBOARD_PASSWORD), 'no secret may reach a response');
});

test('an unknown endpoint is a 404, not a 500', async () => {
  const { call } = await app();
  assert.equal((await call('/api/nothing-here')).status, 404);
  assert.equal((await call('/api/brief', { method: 'POST' })).status, 404);
});

test('anything outside /api is handed to the static assets', async () => {
  const { call } = await app();
  const response = await call('/', { signedIn: false });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'index');
});

test('a refresh loads and then re-reads, in that order', async () => {
  const { call, raw } = await app({ loaded: false });
  const response = await call('/api/refresh', { method: 'POST', body: { to: '2026-06-30' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.etl.status, 'ok');
  assert.ok(body.etl.rows > 0);
  assert.ok(body.analysed.findings >= 0);
  assert.deepEqual(body.analysed.errors, []);
  assert.ok(raw.prepare('SELECT COUNT(*) AS n FROM findings').get().n > 0,
    'the findings must be computed over the days that were just loaded');
});
