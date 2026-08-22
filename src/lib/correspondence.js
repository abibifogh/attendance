// The rules a letter register runs on.
//
// Pure, and small. Three things live here that are worth getting exactly
// right, and nothing else does: how a reference is made, how the event chain
// is linked, and what state a letter is actually in.

import { sha256Hex } from './files.js';

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * A reference, in the form a registry clerk would recognise.
 *
 *   SN/ADM/2026/0041
 *
 * The year is in it because that is how a filing cabinet is arranged and how
 * anybody looking for a letter from last March will look for it. The sequence
 * restarts each year and is never reused within one, so a gap is a question
 * worth asking rather than an artefact.
 */
export function referenceFor({ prefix, year, number }) {
  const clean = String(prefix ?? 'REF').replace(/\/+$/, '');
  return `${clean}/${year}/${String(number).padStart(4, '0')}`;
}

/** Pull a reference back apart, for sorting a register the way it reads. */
export function parseReference(reference) {
  const m = /^(.*)\/(\d{4})\/(\d+)$/.exec(String(reference ?? ''));
  if (!m) return null;
  return { prefix: m[1], year: Number(m[2]), number: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** The first link. A fixed value, so the chain has a defined beginning. */
export const CHAIN_ROOT = '0'.repeat(64);

/**
 * One link of the event chain.
 *
 * The hash covers the previous hash and everything recorded about this event.
 * Editing a row, or removing one, changes what the next link should have been,
 * and every hash after it stops matching — which is the whole property an
 * audit trail needs and the one an ordinary table does not have.
 *
 * Deliberately not a signature. This proves the log is internally consistent
 * with itself; it does not prove somebody with the database could not rewrite
 * the whole chain from scratch. What it stops is the realistic version of the
 * problem: one row quietly altered afterwards.
 */
export async function linkEvent(previousHash, event) {
  const line = [
    previousHash ?? CHAIN_ROOT,
    event.letterId, event.seq, event.kind,
    event.actor ?? '', event.detail ?? '', event.ip ?? '', event.at,
  ].join('␟');
  return sha256Hex(line);
}

/**
 * Walk a letter's events and say whether the chain holds.
 *
 * Returns the first sequence number that does not check out, so a screen can
 * say *where* rather than only *that* — "everything from the fourth event on
 * is in doubt" is actionable and "something is wrong" is not.
 */
export async function verifyChain(events) {
  let previous = CHAIN_ROOT;

  for (const event of events) {
    if (event.prev_hash !== previous) return { intact: false, brokenAt: event.seq };

    const expected = await linkEvent(previous, {
      letterId: event.letter_id,
      seq: event.seq,
      kind: event.kind,
      actor: event.actor,
      detail: event.detail,
      ip: event.ip,
      at: event.at_utc,
    });
    if (expected !== event.hash) return { intact: false, brokenAt: event.seq };
    previous = event.hash;
  }

  return { intact: true, brokenAt: null, head: previous };
}

// ---------------------------------------------------------------------------
// What state a letter is in
// ---------------------------------------------------------------------------

export const STATUSES = {
  draft: { label: 'Draft', colour: 'grey', detail: 'Not sent to anybody' },
  awaiting_signature: { label: 'Out for signature', colour: 'amber', detail: 'Waiting on somebody to sign' },
  signed: { label: 'Signed', colour: 'green', detail: 'Signed, not yet sent' },
  sent: { label: 'Sent', colour: 'green', detail: 'Gone out' },
  closed: { label: 'Closed', colour: 'grey', detail: 'Answered or finished with' },
  filed: { label: 'Filed', colour: 'grey', detail: 'Recorded after the event' },
  void: { label: 'Withdrawn', colour: 'grey', detail: 'Cancelled' },
};

/**
 * Which recipient's link is live.
 *
 * Signing is in order. A letter that could be counter-signed before it was
 * signed is one nobody can reason about afterwards, so the earliest signer who
 * has not dealt with it is the only one whose link opens — and the rest see
 * that it is not their turn rather than a broken link.
 */
export function currentSigner(recipients) {
  return [...(recipients ?? [])]
    .filter((r) => r.role !== 'copy')
    .sort((a, b) => a.seq - b.seq || a.id - b.id)
    .find((r) => r.status !== 'signed' && r.status !== 'declined' && r.status !== 'revoked') ?? null;
}

/**
 * Everybody still to sign, rather than only the next one.
 *
 * An envelope routed 'all' has no queue: the links open the day they are made
 * and the parties sign whenever they get to it. That is right for a contract,
 * where waiting for the other side to go first is a week nobody has, and
 * wrong for an approval chain, which is why it is a choice and not a change.
 */
export function whoCanSign(recipients, routing = 'order') {
  const waiting = [...(recipients ?? [])]
    .filter((r) => r.role !== 'copy')
    .sort((a, b) => a.seq - b.seq || a.id - b.id)
    .filter((r) => r.status !== 'signed' && r.status !== 'declined' && r.status !== 'revoked');

  return routing === 'all' ? waiting : waiting.slice(0, 1);
}

/** Where a letter has got to, worked out rather than stored twice. */
export function progressOf(letter, recipients = []) {
  const signers = recipients.filter((r) => r.role !== 'copy');
  const signed = signers.filter((r) => r.status === 'signed').length;
  const declined = signers.find((r) => r.status === 'declined') ?? null;

  return {
    signers: signers.length,
    signed,
    declined: declined ? declined.name : null,
    waitingOn: declined ? null : currentSigner(recipients)?.name ?? null,
    complete: signers.length > 0 && signed === signers.length,
    // A letter the property signed itself and sent to nobody for signature is
    // complete the moment it is signed; one with recipients is not.
    internallySigned: Boolean(letter?.signed_at),
  };
}

/**
 * What a register needs flagged, in the order somebody would act on it.
 *
 * Overdue replies first, because that is the one thing a register exists to
 * catch and the one thing a folder of Word documents never will.
 */
export function attentionOf(letters, today) {
  const day = today ?? new Date().toISOString().slice(0, 10);

  const overdue = letters.filter((l) => l.response_due
    && l.response_due < day
    && !['closed', 'void'].includes(l.status));

  const waiting = letters.filter((l) => l.status === 'awaiting_signature');
  const unsent = letters.filter((l) => l.status === 'signed');

  return { overdue, waiting, unsent };
}

// ---------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------

/**
 * What a letter template may refer to.
 *
 * Everything here is either known for certain or asked for at the moment the
 * letter is drafted, so a placeholder can never quietly produce an empty space
 * in the middle of a sentence somebody then signs.
 */
export const LETTER_PLACEHOLDERS = [
  { key: 'reference', label: 'Our reference' },
  { key: 'today', label: 'Today’s date' },
  { key: 'property', label: 'Property name' },
  { key: 'property_address', label: 'Property address' },
  { key: 'recipient', label: 'Addressed to' },
  { key: 'recipient_first', label: 'Their first name' },
  { key: 'organisation', label: 'Their organisation' },
  // Deliberately not `address`. A personnel template already uses that for the
  // worker's home address, and a key meaning two different things renders
  // correctly in one place and silently wrongly in the other — with no
  // unfilled marker to give it away, because the key exists in both.
  { key: 'recipient_address', label: 'Their address' },
  { key: 'subject', label: 'Subject' },
  { key: 'signatory', label: 'Who is signing' },
  { key: 'signatory_title', label: 'Their job title' },
  { key: 'your_reference', label: 'Their reference', ask: true, fallback: '' },
  { key: 'body', label: 'The letter itself', ask: true, fallback: '' },
];

/** How a letter should be addressed, from whatever is known about the party. */
export function salutationFor(party) {
  const name = String(party?.name ?? '').trim();
  if (!name) return 'Dear Sir or Madam';
  // "Dear Kwame" to a person; "Dear Sir or Madam" where only a company is
  // named, because "Dear Accra Brewery Limited" is how a circular reads.
  if (!/\s/.test(name) || /\b(ltd|limited|plc|company|authority|commission|bank|department)\b/i.test(name)) {
    return party?.organisation && party.organisation === name ? 'Dear Sir or Madam' : `Dear ${name}`;
  }
  return `Dear ${name.split(/\s+/)[0]}`;
}
