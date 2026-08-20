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

// ---------------------------------------------------------------------------
// Lateness in the morning digest
// ---------------------------------------------------------------------------

const { lateness, renderDigest } = await import('../src/lib/notify.js');

test('how late somebody was, in words rather than arithmetic', () => {
  assert.equal(lateness(0), '0 min late');
  assert.equal(lateness(12), '12 min late');
  assert.equal(lateness(59), '59 min late');
  assert.equal(lateness(60), '1 hr late');
  assert.equal(lateness(83), '1 hr 23 min late');
  assert.equal(lateness(125), '2 hr 5 min late');
  assert.equal(lateness(-5), '0 min late', 'never negative');
  assert.equal(lateness(null), '0 min late');
});

test('the digest names who was late and by how much, worst first', () => {
  const { html, subject } = renderDigest({
    day: '2026-08-18',
    propertyName: 'Somewhere Nice',
    siteUrl: 'https://staff.niceoperation.com',
    open: 1,
    absent: 1,
    escalated: [],
    rows: [
      { name: 'Kofi', status: 'late', resolution: 'closed', late_minutes: 12 },
      { name: 'Ama', status: 'late', resolution: 'closed', late_minutes: 83 },
      { name: 'Yaa', status: 'late_early', resolution: 'closed', late_minutes: 47 },
      { name: 'Esi', status: 'absent', resolution: 'open' },
      { name: 'Kwame', status: 'present', resolution: 'closed', late_minutes: 0 },
    ],
  });

  assert.match(html, /Ama — 1 hr 23 min late/);
  assert.match(html, /Yaa — 47 min late/);
  assert.match(html, /Kofi — 12 min late/);

  // Worst first: the person to speak to is the one at the top.
  assert.ok(html.indexOf('Ama —') < html.indexOf('Yaa —'));
  assert.ok(html.indexOf('Yaa —') < html.indexOf('Kofi —'));

  // Somebody on time is not in the list.
  assert.ok(!/Kwame — /.test(html), 'the punctual are not news');

  // And the count is on the summary line.
  assert.match(html, /1 day waiting on a decision, 1 absent, 3 late\./);
  assert.match(subject, /Somewhere Nice: 1 attendance day to confirm/);
});

test('a minute inside grace is not lateness', () => {
  // The rules decide, not the raw minutes: 4 minutes past a 5-minute grace is
  // status 'present', and a digest that flagged it would flag half the
  // property every morning.
  const { html } = renderDigest({
    day: '2026-08-18',
    propertyName: 'Somewhere Nice',
    siteUrl: null,
    open: 1,
    absent: 0,
    escalated: [],
    rows: [
      { name: 'Kofi', status: 'present', resolution: 'open', late_minutes: 4 },
    ],
  });
  assert.ok(!/Late/.test(html.replace(/<title>[\s\S]*?<\/title>/, '')), 'no Late heading at all');
});

test('a morning with nobody late has no Late section', () => {
  const { html } = renderDigest({
    day: '2026-08-18',
    propertyName: 'Somewhere Nice',
    siteUrl: null,
    open: 1,
    absent: 0,
    escalated: [],
    rows: [{ name: 'Esi', status: 'missing_out', resolution: 'open' }],
  });
  assert.ok(!/min late/.test(html));
  assert.match(html, /1 day waiting on a decision\./);
});
