// Signing a period off, when part of it is fine and part of it is not.
//
// Pure. Three ideas live here and everything else on the sign-off screen is
// arithmetic on top of them.
//
//   A sign-off covers a span *minus* the days it deliberately left out. The
//   effective set, not the raw dates, is what any rule about it has to work on.
//
//   Two sign-offs conflict only where their effective sets touch. A month that
//   left three days out does not stop those three being dealt with afterwards,
//   and the old rule — no two spans may share a date — would have.
//
//   An issue is something a person should look at before charging it against
//   somebody's leave. Naming them is the whole point; a count of "3 problems"
//   is not something anybody can act on.

import { addDays, diffDays } from '../util/dates.js';

/** Every date from one to the other, inclusive. */
export function daysBetween(from, to) {
  const out = [];
  const span = diffDays(from, to);
  if (span < 0 || span > 400) return out;
  for (let i = 0; i <= span; i += 1) out.push(addDays(from, i));
  return out;
}

/** What a stored sign-off actually signed. */
export function effectiveDays(review) {
  const excluded = new Set(parseDays(review.excluded_days));
  return daysBetween(review.from_day, review.to_day).filter((d) => !excluded.has(d));
}

export function parseDays(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Which existing sign-off, if any, already covers a day this one would sign.
 *
 * Returns the clashing row and the first shared date, so the refusal can name
 * both — "the week of the 3rd already covers the 5th" is actionable and
 * "overlaps an existing sign-off" is not.
 */
export function findClash(wanted, existing) {
  const want = new Set(wanted);

  for (const review of existing) {
    for (const day of effectiveDays(review)) {
      if (want.has(day)) return { review, day };
    }
  }
  return null;
}

/**
 * Days in a span that nothing has signed off yet.
 *
 * The question the whole screen is built around: show me what is still
 * outstanding between these two dates.
 */
export function unsignedDays(from, to, existing) {
  const signed = new Set();
  for (const review of existing) for (const day of effectiveDays(review)) signed.add(day);
  return daysBetween(from, to).filter((d) => !signed.has(d));
}

// ---------------------------------------------------------------------------
// What is wrong with a period
// ---------------------------------------------------------------------------

/**
 * Every kind of thing worth pausing over, in the order somebody would act.
 *
 * `blocking` marks the ones that ought to stop a sign-off going through
 * without a deliberate second press. A day nobody has settled is genuinely not
 * ready to be charged against anybody's leave; three minutes' lateness is
 * worth seeing and not worth stopping for.
 */
export const ISSUES = [
  {
    key: 'open',
    label: 'Not settled',
    detail: 'A day still waiting for somebody to say what happened',
    blocking: true,
  },
  {
    key: 'absent',
    label: 'Absent',
    detail: 'Rostered and not worked',
    blocking: true,
  },
  {
    key: 'under',
    label: 'Whole shift missed',
    detail: 'Counts against them when the period is signed',
    blocking: true,
  },
  {
    key: 'over',
    label: 'Worked unrostered',
    detail: 'A day the rota did not ask for',
    blocking: false,
  },
  {
    key: 'late',
    label: 'Late',
    detail: 'Arrived after the grace period',
    blocking: false,
  },
  {
    key: 'early',
    label: 'Left early',
    detail: 'Went before the shift ended',
    blocking: false,
  },
  {
    key: 'noshift',
    label: 'Worked with no shift',
    detail: 'Clocked in on a day the rota says nothing about',
    blocking: false,
  },
];

export const ISSUE_MAP = new Map(ISSUES.map((i) => [i.key, i]));
const BLOCKING = new Set(ISSUES.filter((i) => i.blocking).map((i) => i.key));

/**
 * What is wrong with one day, if anything.
 *
 * A day can carry more than one — somebody late who then left early — so this
 * returns a list rather than a verdict.
 */
export function issuesOnDay(record, { counted = null } = {}) {
  const found = [];
  if (!record) return found;

  if (record.status === 'open' || record.resolution === 'open') found.push('open');
  if (record.status === 'absent' && !record.resolved_by) found.push('absent');
  if (counted === 'under') found.push('under');
  if (counted === 'over') found.push('over');

  // The rules' own verdict, not the raw minutes. Grace exists precisely so
  // that somebody due at 06:00 who arrives at 06:01 is not late, and a screen
  // that flagged them anyway would put a warning beside half the property
  // every morning — which is how a list of warnings stops being read.
  if (record.status === 'late' || record.status === 'late_early') found.push('late');
  if (record.status === 'early_leave' || record.status === 'late_early') found.push('early');
  if (!record.scheduled && Number(record.worked_minutes) > 0 && counted !== 'over') {
    found.push('noshift');
  }

  return found;
}

/** The same question about a run of days: what, and how many of each. */
export function issuesInPeriod(days) {
  const counts = {};
  for (const day of days) {
    for (const issue of day.issues ?? []) counts[issue] = (counts[issue] ?? 0) + 1;
  }

  const list = ISSUES
    .filter((i) => counts[i.key])
    .map((i) => ({ ...i, count: counts[i.key] }));

  return {
    counts,
    list,
    total: list.reduce((n, i) => n + i.count, 0),
    // Whether anything here ought to make somebody stop and think before
    // pressing sign. Not a veto — the screen offers "sign it anyway" beside
    // "ask somebody" — but the difference has to be visible.
    blocking: list.some((i) => BLOCKING.has(i.key)),
  };
}

/**
 * A period as a line in a queue.
 *
 * Deliberately a sentence rather than a row of numbers: this is read by
 * somebody scanning twenty of them to find the two that need them.
 */
export function describePeriod({ name, unsigned, issues }) {
  if (!unsigned.length) return `${name} — nothing outstanding`;

  const span = unsigned.length === 1
    ? '1 day'
    : `${unsigned.length} days`;

  if (!issues.list.length) return `${name} — ${span}, nothing wrong`;

  const worst = issues.list.slice(0, 2).map((i) => `${i.count} ${i.label.toLowerCase()}`);
  return `${name} — ${span}, ${worst.join(', ')}`
    + (issues.list.length > 2 ? ` and ${issues.list.length - 2} more` : '');
}
