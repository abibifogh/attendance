import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELDS, LISTS, PLACEHOLDERS, SELF_FIELDS, cleanSubmission, diffSubmission,
  hashBody, mask, maskProfile, missingFor, placeholdersIn, renderTemplate, shortHash,
} from '../src/lib/people.js';
import {
  REQUIRED_DOCUMENTS, STANDARD_TEMPLATES, fileStatus, requiredDocumentsFor,
} from '../src/lib/ghana-templates.js';
import { LETTER_PLACEHOLDERS } from '../src/lib/correspondence.js';

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

// ---------------------------------------------------------------------------
// The standard Ghana set
// ---------------------------------------------------------------------------

test('every placeholder in the standard set is one its own renderer knows', () => {
  // The failure this catches is quiet and expensive: an unknown placeholder is
  // left exactly as written, so a contract goes out to be signed with the
  // characters "{{leave_days}}" in the middle of the annual leave clause.
  //
  // Two renderers, two bags of values. A personnel document is filled from
  // somebody's record; a letter is filled from the register — the reference,
  // the addressee, the subject. A template rendered against the wrong one
  // produces exactly the failure above, so which set applies is decided by the
  // template's kind and checked here.
  const forPersonnel = new Set(PLACEHOLDERS.map((p) => p.key));
  const forLetters = new Set(LETTER_PLACEHOLDERS.map((p) => p.key));
  const unknown = [];

  for (const template of STANDARD_TEMPLATES) {
    const known = template.kind === 'correspondence' ? forLetters : forPersonnel;
    for (const [, key] of template.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
      if (!known.has(key)) unknown.push(`${template.code} (${template.kind}): {{${key}}}`);
    }
  }

  assert.deepEqual(unknown, []);
});

test('the two placeholder sets do not quietly disagree about a shared name', () => {
  // `property` and `today` mean the same thing in both, and must. A key that
  // existed in both with different meanings would render correctly in one
  // place and wrongly in the other, which is the worst of the three outcomes.
  const shared = LETTER_PLACEHOLDERS.filter((l) => PLACEHOLDERS.some((p) => p.key === l.key));
  for (const key of shared) {
    const personnel = PLACEHOLDERS.find((p) => p.key === key.key);
    assert.equal(key.label, personnel.label, `${key.key} means two different things`);
  }
});

test('every asked-for placeholder has a lawful fallback, or is plainly optional', () => {
  // A contract issued in a hurry with the boxes left empty must still say
  // something true. The two without a fallback are the ones where a guess
  // would be worse than a visible gap.
  const withoutFallback = PLACEHOLDERS
    .filter((p) => p.ask && p.fallback === undefined)
    .map((p) => p.key);

  assert.deepEqual(withoutFallback.sort(), ['effective_date', 'end_date', 'salary']);
});

test('every personnel template names the statutes it is built from', () => {
  // An ordinary letter cites nothing, and should not — a reply to a guest
  // complaint quoting the Labour Act would be absurd. Everything a member of
  // staff is asked to sign is a different matter.
  for (const template of STANDARD_TEMPLATES) {
    if (template.kind === 'correspondence') continue;
    assert.match(template.body, /Act 651|Act 766|Act 851|Act 843|Act 772/,
      `${template.code} cites nothing`);
  }
});

test('every letter template leaves room for the letter itself', () => {
  // A correspondence template is a shape, not a script. One without {{body}}
  // in it is a form letter nobody can say anything in.
  for (const template of STANDARD_TEMPLATES) {
    if (template.kind !== 'correspondence') continue;
    assert.match(template.body, /\{\{body\}\}/, `${template.code} has nowhere to write`);
    assert.match(template.body, /\{\{reference\}\}/, `${template.code} quotes no reference`);
    assert.match(template.body, /\{\{signatory\}\}/, `${template.code} nobody signs`);
  }
});

test('every standard template has a unique code and a name', () => {
  const codes = STANDARD_TEMPLATES.map((t) => t.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const t of STANDARD_TEMPLATES) {
    assert.ok(t.name && t.body && t.kind, `${t.code} is incomplete`);
  }
});

test('a template that satisfies a file requirement names a real one', () => {
  const codes = new Set(REQUIRED_DOCUMENTS.map((d) => d.code));
  for (const t of STANDARD_TEMPLATES) {
    if (!t.satisfies) continue;
    assert.ok(codes.has(t.satisfies), `${t.code} satisfies "${t.satisfies}", which is not a requirement`);
  }
});

// ---------------------------------------------------------------------------
// What each person's file must contain
// ---------------------------------------------------------------------------

test('a food handler is asked for a health certificate and nobody else is', () => {
  // Public Health Act 2012: anybody handling food must be screened yearly. A
  // checklist that asked it of the whole property would be one people scroll
  // past, and one that never asked would leave a kitchen open to being closed.
  const kitchen = requiredDocumentsFor({ department: 'F&B' }, {}).map((d) => d.code);
  const desk = requiredDocumentsFor({ department: 'Reception' }, {}).map((d) => d.code);

  assert.ok(kitchen.includes('food_health'));
  assert.ok(!desk.includes('food_health'));
});

test('a work permit is asked of a foreign worker and never assumed from a blank', () => {
  const blank = requiredDocumentsFor({ department: 'Reception' }, {}).map((d) => d.code);
  const ghanaian = requiredDocumentsFor({ department: 'Reception' }, { nationality: 'Ghanaian' })
    .map((d) => d.code);
  const foreign = requiredDocumentsFor({ department: 'Reception' }, { nationality: 'Nigerian' })
    .map((d) => d.code);

  assert.ok(foreign.includes('work_permit'));
  assert.ok(!ghanaian.includes('work_permit'));
  // Treating an unanswered question as "probably foreign" is exactly the wrong
  // default, and the sort of thing somebody would rightly complain about.
  assert.ok(!blank.includes('work_permit'), 'a blank nationality demands nothing');
});

test('an expired certificate counts as missing', () => {
  const person = { department: 'Kitchen' };
  const documents = [{ id: 1, kind: 'food_health', expires_on: '2026-01-31' }];

  const status = fileStatus(person, {}, { documents, today: '2026-08-18' });
  assert.equal(status.find((d) => d.code === 'food_health').state, 'expired');
});

test('one about to run out is flagged before it does', () => {
  const documents = [{ id: 1, kind: 'food_health', expires_on: '2026-09-05' }];
  const status = fileStatus({ department: 'Kitchen' }, {}, { documents, today: '2026-08-18' });

  assert.equal(status.find((d) => d.code === 'food_health').state, 'expiring');
});

test('a signed contract answers the requirement a document cannot', () => {
  // Nobody uploads a scan of a handbook acknowledgement they signed on screen.
  // The signed copy is the evidence, so it ticks the box itself.
  const contracts = [{ status: 'signed', satisfies: 'handbook' }];
  const status = fileStatus({ department: 'Reception' }, {}, { documents: [], contracts });

  assert.equal(status.find((d) => d.code === 'handbook').state, 'held');
  assert.equal(status.find((d) => d.code === 'ghana_card').state, 'missing');
});

test('a contract still waiting to be signed answers nothing', () => {
  const contracts = [{ status: 'sent', satisfies: 'contract' }];
  const status = fileStatus({ department: 'Reception' }, {}, { documents: [], contracts });

  assert.equal(status.find((d) => d.code === 'contract').state, 'missing');
});
