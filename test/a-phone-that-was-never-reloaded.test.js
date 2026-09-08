import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isBehind, versionOf } from '../src/lib/version.js';
import { checkVersion, takeTheNewOne, versionLoaded, waitingToRefresh } from '../public/js/fresh.js';

/**
 * The app on a home screen that nobody ever reloads.
 *
 * A browser tab takes a deploy the next time it loads. A phone with the app
 * installed does not: closing it and opening it again hands back the page that
 * was already there. So a screen can be days and several deploys behind, and
 * what somebody says about it is that the app looks wrong.
 *
 * What is pinned down here is that it only ever moves on a real change, and
 * only when the screen is free.
 */

test('the version is whatever the deploy says, and null where nothing says', () => {
  assert.equal(versionOf({ CF_VERSION_METADATA: { id: 'abc-123' } }), 'abc-123');
  assert.equal(versionOf({ CF_VERSION_METADATA: { tag: 'v9' } }), 'v9');
  // A local run, or a deploy made before the binding existed. Null rather than
  // a guess: a stamp that changes on its own would reload the app for nothing.
  assert.equal(versionOf({}), null);
  assert.equal(versionOf(undefined), null);
  assert.equal(versionOf({ CF_VERSION_METADATA: {} }), null);
});

test('a screen is only behind when both ends know what they are', () => {
  assert.equal(isBehind('one', 'two'), true);
  assert.equal(isBehind('one', 'one'), false);
  assert.equal(isBehind(null, 'two'), false, 'a screen that never learned its own');
  assert.equal(isBehind('one', null), false, 'a server that cannot say');
});

test('the first answer is remembered rather than acted on', async () => {
  const ask = async () => ({ version: 'first' });
  assert.equal(await checkVersion(ask, { force: true }), false);
  assert.equal(versionLoaded(), 'first');
  assert.equal(waitingToRefresh(), false);
});

test('the same answer again changes nothing', async () => {
  assert.equal(await checkVersion(async () => ({ version: 'first' }), { force: true }), false);
  assert.equal(waitingToRefresh(), false);
});

test('nothing is decided off a failed ask or an answer with no version in it', async () => {
  assert.equal(await checkVersion(async () => { throw new Error('no signal'); }, { force: true }), false);
  assert.equal(await checkVersion(async () => ({}), { force: true }), false);
  assert.equal(waitingToRefresh(), false, 'a phone with no signal is not a phone on an old version');
});

test('it does not ask again straight away', async () => {
  let asked = 0;
  const ask = async () => { asked += 1; return { version: 'first' }; };
  await checkVersion(ask);
  await checkVersion(ask);
  await checkVersion(ask);
  assert.equal(asked, 0, 'a phone in a pocket asking every minute all night is somebody’s data');
});

test('a different answer puts the screen behind, and it stays behind', async () => {
  assert.equal(await checkVersion(async () => ({ version: 'second' }), { force: true }), true);
  assert.equal(waitingToRefresh(), true);
  // Even if the next ask happens to come back with the old one: the app has
  // seen a newer deploy and is not going to unsee it.
  await checkVersion(async () => ({ version: 'first' }), { force: true });
  assert.equal(waitingToRefresh(), true);
});

test('taking the new one empties the shell cache before it reloads', async () => {
  const deleted = [];
  let reloaded = false;
  globalThis.caches = {
    keys: async () => ['hive-shell-v2', 'something-old'],
    delete: async (n) => { deleted.push(n); return true; },
  };
  await takeTheNewOne(() => { reloaded = true; });
  // Filled a file at a time, so after a deploy it can hold a stylesheet from
  // one version beside a script from another.
  assert.deepEqual(deleted.sort(), ['hive-shell-v2', 'something-old']);
  assert.equal(reloaded, true);
  delete globalThis.caches;
});

test('a browser that will not let us near its caches still reloads', async () => {
  let reloaded = false;
  globalThis.caches = { keys: async () => { throw new Error('denied'); } };
  await takeTheNewOne(() => { reloaded = true; });
  assert.equal(reloaded, true);
  delete globalThis.caches;
});

test('the refresh waits for a free screen, the same as the data one does', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  const guard = app.slice(app.indexOf('async function catchUp()'));
  const body = guard.slice(0, guard.indexOf('\n}'));

  assert.match(body, /waitingToRefresh\(\)/);
  // Losing what somebody had half filled in because a deploy happened is its
  // own small disaster.
  for (const held of ['document.hidden', 'busy()', 'wouldBeLost()', 'serverReachable()']) {
    assert.ok(body.includes(held), `a reload waits on ${held}`);
  }
});

test('it asks when somebody comes back to the screen, and at no other time', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  const at = app.indexOf("document.addEventListener('visibilitychange'");
  assert.ok(at > 0, 'the app has to be listening for somebody coming back');
  const handler = app.slice(at, app.indexOf('\n});', at));
  assert.match(handler, /checkVersion\(api\.version\)/);
  // No timer of its own. The only interval it rides on is the one that was
  // already there for a held data refresh.
  const asks = app.match(/checkVersion\(/g) ?? [];
  assert.equal(asks.length, 3, 'boot, signing in, and coming back to the screen');
  assert.equal(/setInterval\([^)]*checkVersion/.test(app), false);
});

test('the worker says which deploy is answering, and asks for nothing but a session', () => {
  const index = readFileSync('src/index.js', 'utf8');
  assert.match(index, /\['GET', '\/api\/version', null, appVersion\]/);

  const toml = readFileSync('wrangler.toml', 'utf8');
  assert.match(toml, /\[version_metadata\]/);
  assert.match(toml, /binding = "CF_VERSION_METADATA"/);
});
