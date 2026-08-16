import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { digestHeader, isapiTime, parseChallenge } from '../scripts/hik-poller.mjs';

/**
 * The poller's two fiddly parts.
 *
 * Digest authentication and the timestamp format are where a terminal
 * integration goes wrong, and both fail the same way when they are wrong: a
 * 401 with no explanation, on a device with no useful log. Worth pinning down
 * here rather than in front of the terminal.
 */

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

const CHALLENGE = 'Digest qop="auth", realm="IP Camera(C2917)", '
  + 'nonce="4e5a3f4d6d3a2b1c0f9e8d7c6b5a4938", stale="FALSE", opaque="abc123"';

test('a digest challenge is picked apart', () => {
  const parsed = parseChallenge(CHALLENGE);
  assert.equal(parsed.realm, 'IP Camera(C2917)');
  assert.equal(parsed.nonce, '4e5a3f4d6d3a2b1c0f9e8d7c6b5a4938');
  assert.equal(parsed.qop, 'auth');
  assert.equal(parsed.opaque, 'abc123');
  assert.equal(parsed.stale, 'FALSE');
});

test('an unquoted value is read too', () => {
  const parsed = parseChallenge('Digest realm="x", nonce="y", algorithm=MD5, qop="auth"');
  assert.equal(parsed.algorithm, 'MD5');
});

test('the response hash follows RFC 2617', () => {
  const challenge = parseChallenge(CHALLENGE);
  const header = digestHeader(challenge, {
    method: 'POST',
    uri: '/ISAPI/AccessControl/AcsEvent?format=json',
    user: 'admin',
    password: 'secret',
  });

  const fields = parseChallenge(header);
  assert.equal(fields.username, 'admin');
  assert.equal(fields.uri, '/ISAPI/AccessControl/AcsEvent?format=json');
  assert.equal(fields.qop, 'auth');
  assert.match(fields.nc, /^\d{8}$/);

  // Recompute it the long way round and check the two agree.
  const ha1 = md5(`admin:${challenge.realm}:secret`);
  const ha2 = md5('POST:/ISAPI/AccessControl/AcsEvent?format=json');
  const expected = md5(
    `${ha1}:${challenge.nonce}:${fields.nc}:${fields.cnonce}:auth:${ha2}`,
  );
  assert.equal(fields.response, expected);
});

test('the opaque value is echoed back', () => {
  const header = digestHeader(parseChallenge(CHALLENGE), {
    method: 'GET', uri: '/ISAPI/System/deviceInfo', user: 'admin', password: 'secret',
  });
  assert.match(header, /opaque="abc123"/);
});

test('a challenge without qop falls back to the two-part hash', () => {
  const challenge = parseChallenge('Digest realm="r", nonce="n"');
  const header = digestHeader(challenge, {
    method: 'GET', uri: '/x', user: 'u', password: 'p',
  });
  const fields = parseChallenge(header);

  assert.equal(fields.qop, undefined);
  assert.equal(fields.response, md5(`${md5('u:r:p')}:n:${md5('GET:/x')}`));
});

test('the nonce count rises, so a replayed request is refused', () => {
  const challenge = parseChallenge(CHALLENGE);
  const args = { method: 'GET', uri: '/x', user: 'u', password: 'p' };
  const first = parseChallenge(digestHeader(challenge, args));
  const second = parseChallenge(digestHeader(challenge, args));
  assert.ok(Number(second.nc) > Number(first.nc));
});

test('ISAPI timestamps carry an explicit offset', () => {
  const stamp = isapiTime(new Date(2026, 5, 16, 6, 3, 12));
  assert.match(stamp, /^2026-06-16T06:03:12[+-]\d{2}:\d{2}$/);
});
