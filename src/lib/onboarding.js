import { parseList } from './attendance.js';

/**
 * The first week.
 *
 * Who a step is for, what proves it done, and how far somebody has got. Pure,
 * because every one of these is a question the property will want to argue
 * with later — "she was never shown the fire exits" — and the answer has to
 * come off the record rather than out of a screen.
 */

/**
 * Where the proof of a step lives.
 *
 * The four derived ones read an answer that already exists somewhere else in
 * this app. Nothing is copied: a contract signed on the Contracts tab ticks
 * itself off here, and cannot be ticked off here while it is unsigned, which
 * is the point. `manual` is everything a person has to witness.
 */
export const SOURCES = [
  {
    key: 'manual',
    label: 'Somebody ticks it',
    detail: 'A person saw it happen and puts their name against it.',
  },
  {
    key: 'details',
    label: 'Their own details are in',
    detail: 'Ticks itself when they have sent their particulars and the office accepted them.',
  },
  {
    key: 'contract',
    label: 'A contract is signed',
    detail: 'Ticks itself when a contract issued to them comes back signed.',
  },
  {
    key: 'handbook',
    label: 'The handbook is answered',
    detail: 'Ticks itself when nothing in the handbook is still waiting on them.',
  },
  {
    key: 'documents',
    label: 'Their file is complete',
    detail: 'Ticks itself when every document their file requires is held and unexpired.',
  },
];

export const SOURCE_MAP = new Map(SOURCES.map((s) => [s.key, s]));

/** Anything unrecognised is manual, which is the harmless answer. */
export const sourceOf = (step) => (SOURCE_MAP.has(step?.source) ? step.source : 'manual');

/** Whose list a manual step sits at the top of. It says nothing about who may tick it. */
export const ownerOf = (step) => (step?.owner === 'staff' ? 'staff' : 'office');

/**
 * Is this step for this person?
 *
 * Nothing named means everybody, which is most of a first week. A department
 * for the food hygiene certificate, a tag for whatever a team lead is shown
 * that nobody else is. Deliberately the same rule as a handbook chapter.
 */
export function isFor(step, staff) {
  const departments = parseList(step?.departments);
  const tags = parseList(step?.tags);
  if (!departments.length && !tags.length) return true;

  if (departments.includes(staff?.department || '')) return true;
  const theirs = new Set(parseList(staff?.tags));
  return tags.some((tag) => theirs.has(tag));
}

/** Said in words, for the line under a step. */
export function whoFor(step) {
  const departments = parseList(step?.departments);
  const tags = parseList(step?.tags);
  if (!departments.length && !tags.length) return 'Everybody';
  return [...departments, ...tags].join(', ');
}

/** The steps that apply to somebody, in the order a first week happens in. */
export function stepsFor(steps, staff) {
  return (steps ?? [])
    .filter((s) => s.active)
    .filter((s) => isFor(s, staff))
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.title).localeCompare(String(b.title)));
}

/**
 * Whether one step is done, and how it is known.
 *
 * `settled` is what the rest of the app already knows: whether a contract is
 * signed, whether the handbook is answered, and so on. A manual step is done
 * when somebody ticked it, and only then.
 */
export function isDone(step, { ticked = new Set(), settled = {} } = {}) {
  const source = sourceOf(step);
  if (source === 'manual') return ticked.has(Number(step.id));
  return Boolean(settled[source]);
}

/**
 * How far somebody has got.
 *
 * The denominator is the point. "Four things done" says nothing; "four of
 * nine" is a first week somebody can see the end of, and the five are what a
 * supervisor chases.
 */
export function progressOf(steps, staff, state = {}) {
  const mine = stepsFor(steps, staff);
  const done = mine.filter((s) => isDone(s, state));
  const waiting = mine.filter((s) => !isDone(s, state));
  return {
    of: mine.length,
    done: done.length,
    waiting,
    // Nought steps is a finished first week rather than a division by zero: a
    // property that has not written a checklist has not left anybody halfway
    // through one.
    percent: mine.length ? Math.round((done.length / mine.length) * 100) : 100,
    complete: waiting.length === 0,
  };
}

/**
 * The next thing to do, from the person's own side.
 *
 * Theirs first, because a list that opens on something only the office can do
 * teaches somebody that the list is not for them. Within that, the order the
 * steps are written in.
 */
export function nextForThem(steps, staff, state = {}) {
  const waiting = progressOf(steps, staff, state).waiting;
  return waiting.find((s) => sourceOf(s) !== 'manual' || ownerOf(s) === 'staff')
    ?? waiting[0]
    ?? null;
}

/**
 * Whether an onboarding is over.
 *
 * Somebody the office has settled in early is finished whatever the checklist
 * says: a first week that will not close because a certificate is still with
 * the printer is a first week that follows somebody into their second year.
 */
export const isFinished = (state, progress) => Boolean(state?.finished_at) || Boolean(progress?.complete);
