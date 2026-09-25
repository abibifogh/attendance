import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import worker from '../src/index.js';
import { createToken, sessionCookie, getPepper, storedPassword } from '../src/lib/auth.js';
import { run } from '../src/lib/db.js';

/**
 * A report published behind a PIN, driven the way a browser drives it.
 *
 * The ways this can be quietly wrong are the ones worth a test:
 *
 *   the report served to somebody with no PIN, or the door page served to a
 *   script tag that wanted JavaScript;
 *
 *   a byte changed on the way through — "do not change anything" is the
 *   whole of the promise;
 *
 *   the lock only slowing a guesser down until the guess that happens to be
 *   right, instead of refusing that one too;
 *
 *   a taken-away PIN still opening the report for the rest of the day
 *   because its cookie had not run out;
 *
 *   a report published to an address the app itself uses.
 */

const SECRETS = { SESSION_SECRET: 'test-signing-secret', DASHBOARD_PASSWORD: 'let me in' };
const PAGE = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Money Map</title></head>'
  + '<body><h1>Sir Tobys — FY2025 v FY2024</h1><script src="chart.umd.js"></script>'
  + '<p>Snowman ☃ and a euro € to prove the bytes.</p></body></html>\n';
const LIB = '/* chart */ window.Chart = function () {};\n';

async function app() {
  const { raw, db } = freshDb('migrations');
  const env = { DB: db, ...SECRETS, ASSETS: { fetch: async () => new Response('the app', { status: 200 }) } };
  await run(db, "INSERT INTO accounts (email, name, is_owner, password_hash) VALUES ('owner@nice.test','Owner',1,?1)",
    await storedPassword({ passwordKey: 'derived', salt: 'AAAAAAAAAAAAAAAAAAAAAA', iterations: 600000 },
      await getPepper(db)));
  const owner = await createToken(env.SESSION_SECRET, { accountId: 1 });

  const call = (path, { method = 'GET', body, headers = {}, signedIn = true, ip = '10.0.0.1' } = {}) =>
    worker.fetch(new Request(`https://insight.test${path}`, {
      method,
      headers: {
        'CF-Connecting-IP': ip,
        ...(signedIn ? { Cookie: sessionCookie(owner).split(';')[0] } : {}),
        ...(body && !(body instanceof FormData) && !(body instanceof URLSearchParams)
          ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body instanceof FormData || body instanceof URLSearchParams ? body
        : body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });

  const publish = async ({ slug = '2025v2024analysis', title = 'Sir Tobys Money Map', files = null } = {}) => {
    const form = new FormData();
    form.append('title', title);
    form.append('slug', slug);
    for (const [name, text, type] of files || [['index.html', PAGE, 'text/html'], ['chart.umd.js', LIB, 'text/javascript']]) {
      form.append('files', new File([text], name, { type }), name);
    }
    return call('/api/reports', { method: 'POST', body: form });
  };

  const makePin = async (label, pin) => {
    const r = await call('/api/report-pins', { method: 'POST', body: { label, pin } });
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()).made;
  };

  const enter = (pin, { ip = '10.0.0.1', slug = '2025v2024analysis' } = {}) =>
    call(`/${slug}/pin`, { method: 'POST', body: new URLSearchParams({ pin }), signedIn: false, ip });

  const readerCookie = (response) => (response.headers.get('Set-Cookie') || '').split(';')[0];

  return { raw, db, env, call, publish, makePin, enter, readerCookie };
}

// ------------------------------------------------------------ publishing --

test('an owner can publish, and the screen lists it without the bodies', async () => {
  const { publish, call } = await app();
  const r = await publish();
  assert.equal(r.status, 200, await r.clone().text());
  const data = await r.json();
  assert.deepEqual(data.published, { slug: '2025v2024analysis', files: ['index.html', 'chart.umd.js'] });

  const listed = await (await call('/api/reports')).json();
  assert.equal(listed.reports[0].slug, '2025v2024analysis');
  assert.equal(listed.reports[0].files.length, 2);
  assert.ok(!JSON.stringify(listed).includes('Snowman'), 'the listing must never carry the report itself');
});

test('nobody but an owner can publish, list, or hand out a PIN', async () => {
  const { call } = await app();
  for (const [path, method, body] of [
    ['/api/reports', 'GET'], ['/api/reports', 'POST', new FormData()],
    ['/api/report-pins', 'POST', { label: 'x' }],
  ]) {
    const r = await call(path, { method, body, signedIn: false });
    assert.equal(r.status, 401, `${method} ${path} answered ${r.status} to a stranger`);
  }
});

test('a report cannot take an address the app uses, and an address is lower-cased', async () => {
  const { publish, call } = await app();
  assert.equal((await publish({ slug: 'api' })).status, 400);
  assert.equal((await publish({ slug: 'Index.HTML' })).status, 400);
  assert.equal((await publish({ slug: 'a' })).status, 400, 'too short');
  assert.equal((await publish({ slug: 'has space' })).status, 400);

  const ok = await publish({ slug: 'FY2025-Review' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).published.slug, 'fy2025-review');
  const door = await call('/FY2025-Review', { signedIn: false });
  assert.equal(door.status, 200, 'the address is found whatever case it is typed in');
});

test('a report with no page in it is refused', async () => {
  const { publish } = await app();
  const r = await publish({ files: [['chart.umd.js', LIB, 'text/javascript']] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /html/i);
});

// -------------------------------------------------------------- the door --

test('without a PIN, the page is the door and a file is a refusal', async () => {
  const { publish, call } = await app();
  await publish();

  const page = await call('/2025v2024analysis', { signedIn: false });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="pin"/, 'it is the door');
  assert.ok(!html.includes('Snowman'), 'and not a word of the report');
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.match(page.headers.get('Cache-Control'), /no-store/);

  // A script tag does not want a login form back in place of JavaScript.
  const lib = await call('/2025v2024analysis/chart.umd.js', { signedIn: false });
  assert.equal(lib.status, 401);
  assert.ok(!(await lib.text()).includes('window.Chart'));
});

test('an address that is not a report falls through to the app as before', async () => {
  const { call } = await app();
  const r = await call('/nothing-here', { signedIn: false });
  assert.equal(await r.text(), 'the app');
  // The dashboard's own session is not a reader session.
  const r2 = await call('/2025v2024analysis', { signedIn: true });
  assert.equal(await r2.text(), 'the app');
});

test('the right PIN opens it, and what comes back is byte for byte what went in', async () => {
  const { publish, makePin, enter, call, readerCookie } = await app();
  await publish();
  const { pin } = await makePin('Kwame');

  const opened = await enter(pin);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('Location'), '/2025v2024analysis');
  const cookie = readerCookie(opened);
  assert.match(opened.headers.get('Set-Cookie'), /HttpOnly/);
  assert.match(opened.headers.get('Set-Cookie'), /Secure/);

  const page = await call('/2025v2024analysis', { signedIn: false, headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const got = new Uint8Array(await page.arrayBuffer());
  const sent = new TextEncoder().encode(PAGE);
  assert.deepEqual(got, sent, 'every byte, including the snowman');

  const lib = await call('/2025v2024analysis/chart.umd.js', { signedIn: false, headers: { Cookie: cookie } });
  assert.equal(lib.status, 200);
  assert.equal(lib.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  assert.equal(await lib.text(), LIB);

  const missing = await call('/2025v2024analysis/nope.png', { signedIn: false, headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
});

test('a wrong PIN is refused and counted', async () => {
  const { publish, makePin, enter } = await app();
  await publish();
  await makePin('Kwame', '4321');
  const r = await enter('1234');
  assert.equal(r.status, 401);
  assert.match(await r.text(), /not a PIN that opens this/);
  assert.equal(r.headers.get('Set-Cookie'), null);
  for (const bad of ['', '12', '12345', 'abcd', '12 34']) {
    assert.equal((await enter(bad, { ip: '10.0.0.9' })).status, 401, `"${bad}" must not open anything`);
  }
});

test('five wrong guesses lock the door — and the right PIN does not open a locked door', async () => {
  const { publish, makePin, enter } = await app();
  await publish();
  const { pin } = await makePin('Kwame');

  for (let i = 0; i < 5; i += 1) assert.equal((await enter('0000')).status, 401);
  const locked = await enter('0000');
  assert.equal(locked.status, 429);

  // This is the whole point of the lock. A lock that opens for the correct
  // guess only slows a guesser down until the guess that is correct.
  const correctButLocked = await enter(pin);
  assert.equal(correctButLocked.status, 429, 'the right PIN must not open a locked door');
  assert.equal(correctButLocked.headers.get('Set-Cookie'), null);

  // Somebody else, somewhere else, is not locked out by one guesser.
  const other = await enter(pin, { ip: '10.0.0.2' });
  assert.equal(other.status, 303);
});

test('enough wrong guesses from everywhere lock the door for everybody', async () => {
  const { publish, makePin, enter } = await app();
  await publish();
  const { pin } = await makePin('Kwame');
  // Four wrong guesses each from ten addresses: nobody is individually
  // locked, but the group as a whole is being tried.
  for (let a = 0; a < 10; a += 1) {
    for (let i = 0; i < 4; i += 1) await enter('0000', { ip: `10.1.0.${a}` });
  }
  const r = await enter(pin, { ip: '10.9.9.9' });
  assert.equal(r.status, 429);
});

test('a lock expires', async () => {
  const { publish, makePin, enter, raw } = await app();
  await publish();
  const { pin } = await makePin('Kwame');
  for (let i = 0; i < 5; i += 1) await enter('0000');
  assert.equal((await enter(pin)).status, 429);
  // Sixteen minutes later.
  raw.prepare("UPDATE report_pin_attempts SET at = datetime('now', '-16 minutes')").run();
  assert.equal((await enter(pin)).status, 303);
});

// --------------------------------------------------------------- readers --

test('taking a PIN away works on that reader’s very next click', async () => {
  const { publish, makePin, enter, call, readerCookie } = await app();
  await publish();
  const { id, pin } = await makePin('Ama');
  const cookie = readerCookie(await enter(pin));
  assert.equal((await call('/2025v2024analysis', { signedIn: false, headers: { Cookie: cookie } })).status, 200);

  const revoked = await call(`/api/report-pins/${id}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 200);

  const after = await call('/2025v2024analysis', { signedIn: false, headers: { Cookie: cookie } });
  assert.match(await after.text(), /name="pin"/, 'the door again, cookie or no cookie');
  assert.equal((await enter(pin)).status, 401, 'and the PIN itself no longer opens anything');
});

test('the PIN is shown once and kept only as a hash', async () => {
  const { makePin, raw } = await app();
  const { pin } = await makePin('Ama', '7351');
  assert.equal(pin, '7351');
  const row = raw.prepare('SELECT * FROM report_pins').get();
  assert.ok(!Object.values(row).some((v) => String(v).includes('7351')), 'nothing in the row is the PIN');
});

test('two readers cannot share a PIN, and a PIN is four digits', async () => {
  const { call, makePin } = await app();
  await makePin('Ama', '2468');
  const dup = await call('/api/report-pins', { method: 'POST', body: { label: 'Kofi', pin: '2468' } });
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /already has that PIN/);
  for (const bad of ['246', '24680', 'abcd', '24 6']) {
    const r = await call('/api/report-pins', { method: 'POST', body: { label: 'Kofi', pin: bad } });
    assert.equal(r.status, 400, `"${bad}" must be refused`);
  }
  const noName = await call('/api/report-pins', { method: 'POST', body: { pin: '1111' } });
  assert.equal(noName.status, 400);
});

test('a reader token signed with the wrong secret, or for a PIN that does not exist, is nothing', async () => {
  const { publish, call, env } = await app();
  await publish();
  const forged = await createToken('some-other-secret', { accountId: 1 });
  const r = await call('/2025v2024analysis', { signedIn: false, headers: { Cookie: `report_reader=${forged}` } });
  assert.match(await r.text(), /name="pin"/);
  // A dashboard session token pasted into the reader cookie is not a reader
  // either: same secret, different label.
  const dashboard = await createToken(env.SESSION_SECRET, { accountId: 1 });
  const r2 = await call('/2025v2024analysis', { signedIn: false, headers: { Cookie: `report_reader=${dashboard}` } });
  assert.match(await r2.text(), /name="pin"/);
});

test('leaving clears the reader cookie', async () => {
  const { publish, makePin, enter, call, readerCookie } = await app();
  await publish();
  const { pin } = await makePin('Ama');
  const cookie = readerCookie(await enter(pin));
  const left = await call('/2025v2024analysis/leave', { signedIn: false, headers: { Cookie: cookie } });
  assert.equal(left.status, 303);
  assert.match(left.headers.get('Set-Cookie'), /Max-Age=0/);
});

// ---------------------------------------------------------- housekeeping --

test('republishing replaces same-named files and keeps the rest', async () => {
  const { publish, makePin, enter, call, readerCookie } = await app();
  await publish();
  const r = await publish({ files: [['index.html', PAGE.replace('FY2025', 'FY2026'), 'text/html']] });
  assert.equal(r.status, 200);
  const { pin } = await makePin('Ama');
  const cookie = readerCookie(await enter(pin));
  assert.match(await (await call('/2025v2024analysis', { signedIn: false, headers: { Cookie: cookie } })).text(), /FY2026/);
  assert.equal((await call('/2025v2024analysis/chart.umd.js', { signedIn: false, headers: { Cookie: cookie } })).status, 200,
    'the chart library uploaded the first time is still there');
});

test('taking a report down leaves nothing at its address', async () => {
  const { publish, makePin, enter, call, readerCookie } = await app();
  await publish();
  const { pin } = await makePin('Ama');
  const cookie = readerCookie(await enter(pin));
  assert.equal((await call('/api/reports/2025v2024analysis/remove', { method: 'POST' })).status, 200);
  const gone = await call('/2025v2024analysis', { signedIn: false, headers: { Cookie: cookie } });
  assert.equal(await gone.text(), 'the app', 'not the report, not the door — the address is simply not a report');
});
