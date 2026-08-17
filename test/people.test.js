import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELDS, LISTS, SELF_FIELDS, cleanSubmission, diffSubmission, hashBody,
  mask, maskProfile, missingFor, placeholdersIn, renderTemplate, shortHash,
} from '../src/lib/people.js';

/**
 * The rules an employee record runs on.
 *
 * Three of these are load-bearing in a way the others are not, and they are
 * the ones with the longest comments: a blank answer must never delete what is
 * on file, a masked value must never be written back over the real one, and
 * the words somebody signed must be provable afterwards. The rest of the file
 * would survive being wrong for a week. Those three would not.
 */

// ---------------------------------------------------------------------------
// The declaration everything else reads
// ---------------------------------------------------------------------------

test('every field is asked for exactly once', () => {
  const keys = FIELDS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, keys.join(', '));
});

test('the things a person may not set about themselves are not on their form', () => {
  const selfKeys = new Set(SELF_FIELDS.map((f) => f.key));
  // Their job, their department and their start date are the property's
  // answers. A self-service form offering them is one that will eventually be
  // used to change them.
  for (const key of ['job_title', 'department', 'hired_on', 'employee_no']) {
    assert.ok(!selfKeys.has(key), `${key} must not be self-service`);
  }
});

// ---------------------------------------------------------------------------
// What is still missing
// ---------------------------------------------------------------------------

test('an empty record is missing the handful that matter', () => {
  const gaps = missingFor(null, {}).map((g) => g.label);
  assert.ok(gaps.includes('Emergency contacts'), gaps.join(', '));
  assert.ok(gaps.includes('Mobile'));
  assert.ok(gaps.length <= 8, 'a list somebody can finish, not an audit');
});

test('a filled record is missing nothing', () => {
  const profile = {
    date_of_birth: '1994-03-02', personal_phone: '0241234567',
    address_line: 'House 12, Kokrobite', id_type: 'Ghana Card', id_number: 'GHA-123456789-0',
  };
  assert.deepEqual(missingFor(profile, { contacts: [{ name: 'Ama' }] }), []);
});

// ---------------------------------------------------------------------------
// Who may read what
// ---------------------------------------------------------------------------

test('a private number is masked rather than hidden', () => {
  // Hiding it would have a supervisor chasing a field that is already filled
  // in. Masking says "this is on file and not for you".
  const masked = maskProfile({ account_number: '1234567890123', personal_phone: '0241234567' });
  assert.equal(masked.account_number, '•••• 0123');
  assert.equal(masked.account_number__masked, true);
  assert.equal(masked.personal_phone, '0241234567', 'and an ordinary field is left alone');
});

test('whoever manages records sees the real thing', () => {
  const full = maskProfile({ account_number: '1234567890123' }, { full: true });
  assert.equal(full.account_number, '1234567890123');
  assert.equal(full.account_number__masked, undefined);
});

test('masking never leaks the length of a short value', () => {
  assert.equal(mask('123'), '••••');
  assert.equal(mask('1234', 'tail4'), '••••', 'a four-digit value is not its own tail');
});

// ---------------------------------------------------------------------------
// What somebody sent, against what is on file
// ---------------------------------------------------------------------------

const onFile = {
  profile: { personal_phone: '0241111111', town: 'Kokrobite', id_number: 'GHA-1-0' },
  lists: { contacts: [{ kind: 'emergency', name: 'Ama', relationship: 'Sister', phone: '0555', alt_phone: '', email: '', address: '' }] },
};

test('a blank answer is never a request to delete', () => {
  // The single most destructive thing a self-service form can do. Somebody who
  // skipped a question is not asking for the answer already on file to go.
  const changes = diffSubmission({ profile: { personal_phone: '', town: '' } }, onFile);
  assert.deepEqual(changes, []);
});

test('only what actually differs is offered as a decision', () => {
  const changes = diffSubmission({
    profile: { personal_phone: '0241111111', town: 'Kasoa', nationality: 'Ghanaian' },
  }, onFile);

  assert.deepEqual(changes.map((c) => c.key).sort(), ['nationality', 'town']);
  const town = changes.find((c) => c.key === 'town');
  assert.equal(town.from, 'Kokrobite');
  assert.equal(town.to, 'Kasoa');
  assert.equal(town.isNew, false);
  assert.equal(changes.find((c) => c.key === 'nationality').isNew, true);
});

test('a field the form never offered is dropped on the way in', () => {
  const cleaned = cleanSubmission({
    profile: { town: 'Kasoa', job_title: 'General Manager', hired_on: '2020-01-01' },
  });
  assert.equal(cleaned.profile.town, 'Kasoa');
  assert.equal(cleaned.profile.job_title, undefined, 'not an error to report — a thing to ignore');
  assert.equal(cleaned.profile.hired_on, undefined);
});

test('an unchanged list of contacts raises no question', () => {
  const changes = diffSubmission({
    lists: { contacts: [{ kind: 'emergency', name: 'Ama', relationship: 'Sister', phone: '0555' }] },
  }, onFile);
  assert.deepEqual(changes, []);
});

test('a changed list is one decision, not one per row', () => {
  const changes = diffSubmission({
    lists: {
      contacts: [
        { kind: 'emergency', name: 'Kofi', relationship: 'Brother', phone: '0244' },
        { kind: 'next_of_kin', name: 'Ama', relationship: 'Sister', phone: '0555' },
      ],
    },
  }, onFile);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'list');
  assert.equal(changes[0].rows.length, 2);
  // Merging two versions of "who to ring in an emergency" by hand is how you
  // end up ringing a number that was replaced for a reason.
  assert.ok(changes[0].to[0].startsWith('Kofi'));
});

test('an empty list is not a proposal to delete the contacts on file', () => {
  const changes = diffSubmission({ lists: { contacts: [] } }, onFile);
  assert.deepEqual(changes, []);
});

test('a submission is capped so one form cannot fill the database', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `Person ${i}`, phone: '024' }));
  const cleaned = cleanSubmission({ lists: { contacts: many } });
  assert.equal(cleaned.lists.contacts.length, 12);
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

test('a template is filled in from what the property knows', () => {
  const out = renderTemplate('{{name}} of {{address}} starts on {{start_date}}.', {
    name: 'Angela Asare Ayima', address: 'Kokrobite', start_date: '2026-09-01',
  });
  assert.equal(out, 'Angela Asare Ayima of Kokrobite starts on 2026-09-01.');
});

test('a placeholder with nothing behind it is left visibly unfilled', () => {
  // A contract reading "a notice period of" followed by nothing is obviously
  // wrong but says nothing about what is missing. This says which word.
  const out = renderTemplate('Notice: {{notice}}.', {});
  assert.equal(out, 'Notice: ⟨notice period⟩.');
});

test('a template says which placeholders it uses', () => {
  const uses = placeholdersIn('{{name}} — {{salary}} — {{name}}').map((p) => p.key);
  assert.deepEqual(uses.sort(), ['name', 'salary']);
  assert.equal(placeholdersIn('No placeholders here.').length, 0);
});

test('the words signed have a fingerprint that changes with them', async () => {
  // Everything about proving what somebody agreed to rests on this.
  const a = await hashBody('One month’s notice.');
  const b = await hashBody('One week’s notice.');

  assert.equal(a.length, 64);
  assert.notEqual(a, b);
  assert.equal(a, await hashBody('One month’s notice.'), 'and the same words always hash the same');
});

test('a fingerprint can be read back over the phone', () => {
  assert.equal(shortHash('abcdef0123456789ffff'), 'ABCD EF01 2345 6789');
});

// ---------------------------------------------------------------------------
// The lists themselves
// ---------------------------------------------------------------------------

test('every list describes a row in a way a person can read', () => {
  for (const list of LISTS) {
    const row = Object.fromEntries(list.columns.map((c) => [c, c]));
    assert.ok(list.describe(row).length, `${list.key} describes nothing`);
  }
});
