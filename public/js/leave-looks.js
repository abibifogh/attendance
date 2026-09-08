/**
 * What kind of away it is, on a grid.
 *
 * The rota used to print the word "Leave" on every day somebody was off, in
 * flat grey, whatever the leave was for. Four cells side by side told a planner
 * nothing except that four cells were gone. Annual leave booked in March and a
 * week off sick starting this morning are not the same news, and the grid is
 * where the difference is worth seeing.
 *
 * A property can rename its reasons and add its own, so nothing here insists on
 * the seeded codes. The code is tried first, then the words of the label, and
 * anything unrecognised still gets a cell that says its own name.
 */

/** The looks a leave cell can wear. Anything else falls back to `away`. */
export const LOOKS = ['annual', 'sick', 'compassionate', 'parental', 'study', 'unpaid', 'away'];

const BY_CODE = new Map([
  ['annual_leave', 'annual'],
  ['sick_leave', 'sick'],
  ['compassionate', 'compassionate'],
  ['maternity', 'parental'],
  ['paternity', 'parental'],
  ['unpaid_leave', 'unpaid'],
]);

// Read in order, so "unpaid study leave" lands on study rather than on the
// first word that happens to match.
const BY_WORD = [
  [/(maternit|paternit|parental|adoption)/i, 'parental'],
  [/(compassion|bereave|funeral|sympath)/i, 'compassionate'],
  [/(sick|illness|ill health|medical)/i, 'sick'],
  [/(study|exam|course|training)/i, 'study'],
  [/(annual|holiday|vacation)/i, 'annual'],
  [/(unpaid|without pay|no pay)/i, 'unpaid'],
];

const MARKS = {
  annual: '\u{1F334}',
  sick: '\u{1F912}',
  compassionate: '\u{1F54A}️',
  parental: '\u{1F476}',
  study: '\u{1F4DA}',
  unpaid: '⏸️',
  away: '\u{1F33F}',
};

/** Which of the looks this leave wears. */
export function lookOf(leave) {
  if (!leave) return 'away';
  const byCode = BY_CODE.get(String(leave.code ?? ''));
  if (byCode) return byCode;
  const words = String(leave.label ?? '');
  for (const [pattern, look] of BY_WORD) if (pattern.test(words)) return look;
  return 'away';
}

/** The small mark that goes in front of the name. */
export function markFor(leave) {
  return MARKS[lookOf(leave)] ?? MARKS.away;
}

/** What the cell calls it. Its own label, or the plain word if it has none. */
export function nameOf(leave) {
  const label = String(leave?.label ?? '').trim();
  return label || 'Leave';
}

/**
 * Where in the stretch this day falls.
 *
 * The useful thing about a run of leave is its shape: a planner looking at
 * Wednesday wants to know whether it is the start of a fortnight or the last
 * day before somebody is back. One day off says so rather than "day 1 of 1".
 */
export function sayTheStretch(leave) {
  const outOf = Number(leave?.outOf ?? 0);
  const nth = Number(leave?.nth ?? 0);
  if (!(outOf > 0) || !(nth > 0)) return '';
  if (outOf === 1) return 'One day';
  if (nth === 1) return `First of ${outOf}`;
  if (nth === outOf) return `Last of ${outOf}`;
  return `Day ${nth} of ${outOf}`;
}

/**
 * The same thing in the width of a phone.
 *
 * A cell is a seventh of the screen there, which is not enough for "First of
 * 4". The mark and the colour say what the leave is; this says where in it.
 */
export function sayTheStretchShort(leave) {
  const outOf = Number(leave?.outOf ?? 0);
  const nth = Number(leave?.nth ?? 0);
  if (!(outOf > 1) || !(nth > 0)) return '';
  return `${nth}/${outOf}`;
}

/** The sentence behind the cell, for whoever hovers it. */
export function sayTheLeave(leave) {
  const bits = [nameOf(leave)];
  const stretch = sayTheStretch(leave);
  if (stretch) bits.push(stretch.toLowerCase());
  if (leave?.from && leave?.to && leave.from !== leave.to) {
    bits.push(`${leave.from} to ${leave.to}`);
  }
  return bits.join(', ');
}
