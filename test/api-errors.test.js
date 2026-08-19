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
