import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAIN_ROOT, attentionOf, currentSigner, linkEvent, parseReference,
  progressOf, referenceFor, salutationFor, verifyChain,
} from '../src/lib/correspondence.js';
import {
  CHUNK, joinChunks, partsFor, sha256Hex, sizeOf, splitIntoChunks,
} from '../src/lib/files.js';

/**
 * The rules the letter register runs on.
 *
 * Two of these carry real weight. A reference must be unique, readable and
 * sortable, because it is what somebody quotes down a telephone six months
 * later. And the event chain must break loudly when a row is altered, because
 * an audit trail that can be quietly rewritten is not one.
 */

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

test('a reference reads the way a filing cabinet is arranged', () => {
  assert.equal(referenceFor({ prefix: 'SN/ADM', year: 2026, number: 41 }), 'SN/ADM/2026/0041');
  assert.equal(referenceFor({ prefix: 'SN/HR/', year: 2026, number: 7 }), 'SN/HR/2026/0007');
  // Past four figures it simply grows rather than wrapping or truncating.
  assert.equal(referenceFor({ prefix: 'SN/GST', year: 2026, number: 12345 }), 'SN/GST/2026/12345');
});

test('a reference can be read back apart', () => {
  assert.deepEqual(parseReference('SN/ADM/2026/0041'), { prefix: 'SN/ADM', year: 2026, number: 41 });
  assert.equal(parseReference('not a reference'), null);
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** Build a chain the way the route does, so the test exercises the real link. */
async function chainOf(events) {
  const out = [];
  let previous = CHAIN_ROOT;

  for (const [i, event] of events.entries()) {
    const row = {
      letter_id: 1, seq: i + 1, kind: event.kind, actor: event.actor ?? null,
      detail: event.detail ?? null, ip: event.ip ?? null,
      at_utc: `2026-08-18 09:0${i}:00`, prev_hash: previous,
    };
    row.hash = await linkEvent(previous, {
      letterId: row.letter_id, seq: row.seq, kind: row.kind, actor: row.actor,
      detail: row.detail, ip: row.ip, at: row.at_utc,
    });
    previous = row.hash;
    out.push(row);
  }
  return out;
}

test('an untouched chain checks out', async () => {
  const chain = await chainOf([
    { kind: 'created', actor: 'Ama' },
    { kind: 'sent_for_signature', actor: 'Ama', detail: '1. Accra Brewery' },
    { kind: 'signed', actor: 'Accra Brewery', ip: '41.66.1.9' },
  ]);

  const result = await verifyChain(chain);
  assert.equal(result.intact, true);
  assert.equal(result.brokenAt, null);
});

test('editing one row breaks the chain, and it says where', async () => {
  // The whole reason the log is hashed. Somebody changing what an event said,
  // after the fact, is the realistic version of tampering — and an ordinary
  // table would show no sign of it whatsoever.
  const chain = await chainOf([
    { kind: 'created', actor: 'Ama' },
    { kind: 'signed', actor: 'Accra Brewery', ip: '41.66.1.9' },
    { kind: 'dispatched', actor: 'Ama' },
  ]);

  chain[1].detail = 'signed under protest';

  const result = await verifyChain(chain);
  assert.equal(result.intact, false);
  assert.equal(result.brokenAt, 2, 'and names the event, not just the fact');
});

test('removing a row breaks it too', async () => {
  const chain = await chainOf([
    { kind: 'created', actor: 'Ama' },
    { kind: 'access_code_failed', actor: 'Somebody' },
    { kind: 'signed', actor: 'Accra Brewery' },
  ]);

  const withoutTheAwkwardOne = [chain[0], chain[2]];
  const result = await verifyChain(withoutTheAwkwardOne);
  assert.equal(result.intact, false);
  assert.equal(result.brokenAt, 3);
});

test('an empty chain is intact, and starts from a known root', async () => {
  const result = await verifyChain([]);
  assert.equal(result.intact, true);
  assert.equal(result.head, CHAIN_ROOT);
});

test('the same event twice hashes the same, and a different one does not', async () => {
  const a = await linkEvent(CHAIN_ROOT, { letterId: 1, seq: 1, kind: 'signed', actor: 'A', detail: '', ip: '', at: 'x' });
  const b = await linkEvent(CHAIN_ROOT, { letterId: 1, seq: 1, kind: 'signed', actor: 'A', detail: '', ip: '', at: 'x' });
  const c = await linkEvent(CHAIN_ROOT, { letterId: 1, seq: 1, kind: 'signed', actor: 'B', detail: '', ip: '', at: 'x' });

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

// ---------------------------------------------------------------------------
// Whose turn it is
// ---------------------------------------------------------------------------

const people = (...statuses) => statuses.map((status, i) => ({
  id: i + 1, seq: i + 1, name: `Person ${i + 1}`, role: 'signer', status,
}));

test('signing goes in order', () => {
  assert.equal(currentSigner(people('pending', 'pending')).name, 'Person 1');
  assert.equal(currentSigner(people('signed', 'pending')).name, 'Person 2');
  assert.equal(currentSigner(people('signed', 'signed')), null);
});

test('somebody copied in is never the one being waited on', () => {
  const list = [
    { id: 1, seq: 1, name: 'For information', role: 'copy', status: 'pending' },
    { id: 2, seq: 2, name: 'The signer', role: 'signer', status: 'pending' },
  ];
  assert.equal(currentSigner(list).name, 'The signer');
});

test('a refusal stops the queue rather than skipping past it', () => {
  const list = people('declined', 'pending');
  // The declined one is no longer waiting, so the next is — but the letter as
  // a whole reports the refusal, which is what somebody has to act on.
  assert.equal(currentSigner(list).name, 'Person 2');
  assert.equal(progressOf({}, list).declined, 'Person 1');
  assert.equal(progressOf({}, list).waitingOn, null, 'a refused letter is not merely waiting');
});

test('progress counts only the people who have to sign', () => {
  const list = [
    { id: 1, seq: 1, name: 'A', role: 'signer', status: 'signed' },
    { id: 2, seq: 2, name: 'B', role: 'signer', status: 'pending' },
    { id: 3, seq: 3, name: 'C', role: 'copy', status: 'pending' },
  ];
  const p = progressOf({}, list);
  assert.equal(p.signers, 2);
  assert.equal(p.signed, 1);
  assert.equal(p.complete, false);
  assert.equal(p.waitingOn, 'B');
});

// ---------------------------------------------------------------------------
// What the register should shout about
// ---------------------------------------------------------------------------

test('an overdue reply is the thing a register exists to catch', () => {
  const letters = [
    { id: 1, status: 'sent', response_due: '2026-08-01' },
    { id: 2, status: 'sent', response_due: '2026-09-01' },
    { id: 3, status: 'closed', response_due: '2026-08-01' },
    { id: 4, status: 'awaiting_signature', response_due: null },
    { id: 5, status: 'signed', response_due: null },
  ];

  const out = attentionOf(letters, '2026-08-18');
  assert.deepEqual(out.overdue.map((l) => l.id), [1], 'closed ones are finished with');
  assert.deepEqual(out.waiting.map((l) => l.id), [4]);
  assert.deepEqual(out.unsent.map((l) => l.id), [5], 'signed and still sitting here');
});

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

test('a person is addressed by name and a company is not', () => {
  assert.equal(salutationFor({ name: 'Kwame Mensah' }), 'Dear Kwame');
  assert.equal(salutationFor({ name: 'Accra Brewery Limited' }), 'Dear Accra Brewery Limited');
  assert.equal(salutationFor({}), 'Dear Sir or Madam');
  assert.equal(
    salutationFor({ name: 'Ghana Revenue Authority', organisation: 'Ghana Revenue Authority' }),
    'Dear Sir or Madam',
  );
});

// ---------------------------------------------------------------------------
// Files in pieces
// ---------------------------------------------------------------------------

test('a file splits and rejoins as exactly itself', () => {
  const bytes = new Uint8Array(CHUNK * 2 + 1234);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37) % 251;

  const chunks = splitIntoChunks(bytes);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.length, partsFor(bytes.length));
  assert.deepEqual(joinChunks(chunks), bytes);
});

test('a file that fits in one piece is one piece', () => {
  const bytes = new Uint8Array(10);
  assert.equal(partsFor(bytes.length), 1);
  assert.equal(splitIntoChunks(bytes).length, 1);
});

test('an empty file is still one piece rather than none', () => {
  // Nothing should ever be stored with zero pieces: the read path would return
  // an empty array and the caller would not be able to tell that from a
  // missing file.
  assert.equal(splitIntoChunks(new Uint8Array(0)).length, 1);
  assert.equal(partsFor(0), 1);
});

test('a size is written the way somebody would say it', () => {
  assert.equal(sizeOf(400), '400 bytes');
  assert.equal(sizeOf(45_000), '45 KB');
  assert.equal(sizeOf(2_400_000), '2.4 MB');
});

test('a fingerprint is stable and 64 characters', async () => {
  const a = await sha256Hex('Dear Sir or Madam');
  assert.equal(a.length, 64);
  assert.equal(a, await sha256Hex('Dear Sir or Madam'));
  assert.notEqual(a, await sha256Hex('Dear Sir or Madam.'));
});
