import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api } from '../public/js/api.js';

/**
 * Telling a refusal from a failure.
 *
 * The app answers every refusal in JSON with a sentence in it — "a day that
 * has not finished cannot be signed off". So an error that is not JSON did not
 * come from the app: it came from Cloudflare, a proxy, an office firewall, or
 * whatever else sits in the way.
 *
 * The two have opposite answers, which is why the screen must not phrase them
 * the same way. A refusal means change something and try again. A failure
 * means change nothing and try again. "Request failed (503)" said neither, and
 * read like the app rejecting what somebody had just done.
 */

function serving(status, body, type) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, {
    status,
    headers: type ? { 'Content-Type': type } : {},
  });
  return () => { globalThis.fetch = original; };
}

test('a refusal from the app is repeated word for word', async () => {
  const restore = serving(400, JSON.stringify({
    error: 'A day that has not finished cannot be signed off. Leave today out of it.',
  }), 'application/json');

  try {
    await assert.rejects(
      api.attSignDays({ staffId: 1, days: ['2026-06-01'] }),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /^A day that has not finished/);
        return true;
      },
    );
  } finally { restore(); }
});

test('a 503 that is not from the app says so, and says to change nothing', async () => {
  const restore = serving(503, '<html><title>503 Service Unavailable</title><body>backend read error</body></html>', 'text/html');

  try {
    await assert.rejects(
      api.attSignDays({ staffId: 1, days: ['2026-06-01'] }),
      (err) => {
        assert.equal(err.status, 503);
        assert.match(err.message, /The site did not answer \(503\)/);
        assert.match(err.message, /rather than anything you did/);
        assert.match(err.message, /try again/i);
        // Whatever the page itself said, in case it names the real cause.
        assert.match(err.message, /backend read error/);
        // And it must not read like one of the app's own refusals.
        assert.doesNotMatch(err.message, /^Request failed/);
        return true;
      },
    );
  } finally { restore(); }
});

test('a non-gateway status that is not JSON names its number without blaming the reader', async () => {
  const restore = serving(418, 'nope', 'text/plain');
  try {
    await assert.rejects(
      api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }),
      /Something between your browser and the site returned an error \(418\)/,
    );
  } finally { restore(); }
});

test('a dropped connection is not confused with either', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(
      api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }),
      /No connection to the server/,
    );
  } finally { globalThis.fetch = original; }
});

// ---------------------------------------------------------------------------
// Whether the server is answering
// ---------------------------------------------------------------------------

const { onReachabilityChange, serverReachable } = await import('../public/js/api.js');

/**
 * Not `navigator.onLine`, which only reports whether the device has a network
 * interface: it stays true on a phone with two bars and no data, and true when
 * the site itself is down. The only honest test is whether a request came
 * back.
 *
 * It matters because the app is installable now. It opens from a home screen
 * whether or not anything can be reached, and a screen that opens is a screen
 * somebody believes — "nobody absent, all settled" is a reasonable-looking
 * morning and a dangerous thing to show when the truth is that nothing could
 * be fetched.
 */

/** Put reachability back to "answering", whatever an earlier test left it as. */
async function knownGood() {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  await api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }).catch(() => {});
  globalThis.fetch = original;
}

test('a dropped connection is noticed, and answering again clears it', async () => {
  await knownGood();
  const seen = [];
  const stop = onReachabilityChange((ok) => seen.push(ok));
  const original = globalThis.fetch;

  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }));
    assert.equal(serverReachable(), false, 'the server stopped answering');

    // Back again.
    globalThis.fetch = async () => new Response(JSON.stringify({ rows: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    await api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' });
    assert.equal(serverReachable(), true);
  } finally {
    globalThis.fetch = original;
    stop();
  }

  assert.deepEqual(seen, [false, true], 'told once each way, not once per request');
});

test('a refusal is not a dropped connection', async () => {
  await knownGood();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Not allowed' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }));
    // Something answered. That it said no is a different matter entirely, and
    // raising "no connection" over it would send somebody looking at their
    // signal for a permissions problem.
    assert.equal(serverReachable(), true);
  } finally { globalThis.fetch = original; }
});

test('the same verdict twice does not wake the watchers twice', async () => {
  await knownGood();
  let calls = 0;
  const stop = onReachabilityChange(() => { calls += 1; });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }));
    await assert.rejects(api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }));
    await assert.rejects(api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }));
    assert.equal(calls, 1, 'three failures, one change of state');
  } finally {
    globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    await api.attOutstanding({ from: '2026-06-01', to: '2026-06-07' }).catch(() => {});
    globalThis.fetch = original;
    stop();
  }
});
