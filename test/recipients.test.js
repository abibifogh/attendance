import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEmail, parseRecipients } from '../src/lib/notify.js';

/**
 * Reading back the list of people the morning email goes to.
 *
 * The list is stored as JSON and used to be read by splitting on commas — a
 * different format that happens to look similar. One address came back as
 * `["a@b.com"]` with the brackets and quotes still attached; two came back cut
 * in half down the middle of the comma. The old address check only excluded
 * spaces and stray @s, so the mangled version passed as valid and went to the
 * provider, which rejected the send with a 422 naming the `to` field.
 *
 * Which reads like nonsense to whoever pressed Send: the address on the screen
 * was perfectly good. What left the building was not.
 */

test('the JSON the app itself writes reads back as addresses', () => {
  assert.deepEqual(
    parseRecipients(JSON.stringify(['kwame@niceoperation.com'])),
    ['kwame@niceoperation.com'],
  );
  assert.deepEqual(
    parseRecipients(JSON.stringify(['a@b.com', 'c@d.com'])),
    ['a@b.com', 'c@d.com'],
  );
});

test('a list somebody typed by hand still works', () => {
  assert.deepEqual(parseRecipients('a@b.com, c@d.com'), ['a@b.com', 'c@d.com']);
  assert.deepEqual(parseRecipients('a@b.com; c@d.com'), ['a@b.com', 'c@d.com']);
  assert.deepEqual(parseRecipients('a@b.com\nc@d.com'), ['a@b.com', 'c@d.com']);
});

test('nothing stored means nobody to send to', () => {
  for (const empty of ['', null, undefined, '[]', '   ']) {
    assert.deepEqual(parseRecipients(empty), [], `for ${JSON.stringify(empty)}`);
  }
});

test('the punctuation of a mangled list is not part of an address', () => {
  // The exact string that reached the provider and came back a 422.
  assert.equal(isEmail('["kwame@niceoperation.com"]'), false);
  assert.equal(isEmail('"a@b.com"'), false);
  assert.equal(isEmail('["a@b.com"'), false);
  assert.equal(isEmail('a@b.com]'), false);
  assert.equal(isEmail('<a@b.com>'), false);
  assert.equal(isEmail('a@b.com, c@d.com'), false);
});

test('an ordinary address is still an ordinary address', () => {
  for (const good of [
    'kwame@niceoperation.com',
    'hive@niceoperation.com',
    'first.last+tag@sub.example.co.uk',
    '  spaced@example.com  ',
  ]) {
    assert.equal(isEmail(good), true, good);
  }
});

test('things that are not addresses are refused', () => {
  for (const bad of ['', null, 'no-at-sign', 'a@b', 'a b@c.com', '@b.com', 'a@']) {
    assert.equal(isEmail(bad), false, JSON.stringify(bad));
  }
});

test('what is stored survives a round trip through both halves', () => {
  // The whole failure in one line: store it the way the app stores it, read it
  // the way the app reads it, and what comes out must be sendable.
  const typed = ['kwame@niceoperation.com', 'jessica@niceoperation.com'];
  const stored = JSON.stringify(typed);
  assert.deepEqual(parseRecipients(stored).filter(isEmail), typed);
});
