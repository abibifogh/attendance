import { absMinutes, mayWork, shiftWindow } from './attendance.js';
import {
  consecutiveRuns, limitsFrom, shiftsInWindow, turnarounds, weeklyLoad, weeklyRest,
} from './workload.js';
import { addDays, dow, rangeDays } from '../util/dates.js';

/**
 * Giving up a shift, and taking one.
 *
 * The rules live here rather than in the route, for one reason: every one of
 * them has to be asked twice. Once when somebody takes a shift, because
 * offering them something they cannot do is a waste of everybody's evening,
 * and again when a manager approves it, because a fortnight can change between
 * the two and the rota is what the second answer writes to.
 *
 * NOTHING IN THIS FILE TOUCHES THE DATABASE. It reads the dataset the rest of
 * the app already loads, so the answer here and the answer the rota gives are
 * the same answer.
 */

/** The property's rules, over the top of the safe defaults. */
export function swapRules(settings = {}) {
  const hours = Number(settings.swap_notice_hours);
  const cap = Number(settings.swap_monthly_cap);
  return {
    on: String(settings.swaps_on ?? '0') === '1',
    // How close to the start a shift can still be given up. Zero is a real
    // answer: a property that lets somebody give away a shift starting in ten
    // minutes has said so on purpose.
    noticeHours: Number.isFinite(hours) && hours >= 0 ? Math.min(hours, 24 * 14) : 24,
    // 'always' or 'clean'. Anything else is a typo, and a typo must not be the
    // thing that stops a manager seeing a swap.
    approval: settings.swap_approval === 'clean' ? 'clean' : 'always',
    crossDepartment: String(settings.swap_cross_department ?? '0') === '1',
    monthlyCap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0,
  };
}

/** Every state an offer can be in, and whether it is still going. */
export const LIVE = new Set(['open', 'claimed']);
export const OVER = new Set(['approved', 'declined', 'withdrawn', 'expired']);

/**
 * Is it too late to give this shift away?
 *
 * Measured from the start of the shift, not from midnight on the day: a night
 * porter's Friday starts at ten at night, and a rule counted off the date
 * would close his offer a day early.
 */
export function tooLate(day, shift, now, noticeHours) {
  const window = shiftWindow(shift, day);
  if (!window) return false;
  const at = absOfNow(now);
  if (at == null) return false;
  return window.start - at < Number(noticeHours) * 60;
}

/** 'YYYY-MM-DD HH:MM' as the same absolute minutes everything else counts in. */
function absOfNow(now) {
  const stamp = String(now ?? '');
  if (stamp.length < 16) return null;
  return absMinutes(stamp.slice(0, 10), stamp.slice(11, 16));
}

/**
 * What is in the way of this person working this shift on this day.
 *
 * Returns a reason, or null when there is nothing in the way. A reason is
 * written to be read by the person it is about, because it is: the board says
 * why a shift on it is not theirs to take, rather than hiding it and leaving
 * them to wonder.
 */
export function whyNot(ds, staff, day, shift, {
  rules, exceptRosterId = null, away = null,
} = {}) {
  if (!staff?.active) return 'They are not on the staff list.';
  if (staff.on_rota === 0) return 'They are not on the rota.';

  if (!mayWork(staff, shift)) {
    return rules?.crossDepartment
      ? `${shift.name} is not one of the shifts they are down to work.`
      : `They do not work in ${shift.department || 'that department'}.`;
  }

  if (ds.leaveBy?.get(`${staff.id}|${day}`)) return 'They are on leave that day.';

  // The ✕ on the rota: a date somebody has said they cannot work. Passed in
  // rather than read off the dataset, which does not carry it.
  if (away?.has(`${staff.id}|${day}`)) return 'They have said they cannot work that day.';

  // Already working, on this day or across midnight into it. Compared as
  // windows rather than as days, because a night that finishes at six in the
  // morning is in the way of a breakfast that starts at five.
  const wanted = shiftWindow(shift, day);
  for (const near of [addDays(day, -1), day, addDays(day, 1)]) {
    for (const row of ds.rosterAllBy?.get(`${staff.id}|${near}`) ?? []) {
      if (exceptRosterId != null && Number(row.id) === Number(exceptRosterId)) continue;
      if (!row.shift_id) continue;
      const theirs = ds.shiftById?.get(row.shift_id);
      const window = theirs ? shiftWindow(theirs, near) : null;
      if (!window || !wanted) continue;
      if (window.start < wanted.end && window.end > wanted.start) {
        return near === day
          ? `They are already on ${theirs.name} that day.`
          : `They are on ${theirs.name} that runs into it.`;
      }
    }
  }

  return null;
}

/**
 * Everybody who could actually take this shift.
 *
 * The same question the offer dialog asks before anything is sent, so the
 * person giving up a Saturday knows whether they are asking six people or
 * nobody.
 */
export function whoCanCover(ds, {
  day, shift, exceptStaffId = null, rules = null, away = null,
}) {
  const out = [];
  for (const person of ds.staff ?? []) {
    if (Number(person.id) === Number(exceptStaffId)) continue;
    if (whyNot(ds, person, day, shift, { rules, away })) continue;
    out.push(person);
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// --------------------------------------------------------------------------
// What it would do to the two people's fortnight
// --------------------------------------------------------------------------

/**
 * The shifts somebody is down to work, with one taken off and one put on.
 *
 * Synthesised rather than written, because nothing is written until a manager
 * says yes and the whole point of the findings is to be read before that.
 */
function workedWith(ds, staffId, from, to, { drop = null, add = null }) {
  const worked = shiftsInWindow(ds, staffId, from, to)
    .filter((w) => !(drop && w.day === drop.day && w.shift?.id === drop.shift?.id));

  if (add) {
    const window = shiftWindow(add.shift, add.day);
    if (window) {
      worked.push({
        day: add.day,
        shift: add.shift,
        start: window.start,
        end: window.end,
        hours: Math.max(0, (window.end - window.start) - (add.shift.break_minutes ?? 0)) / 60,
        night: false,
        weekend: dow(add.day) >= 5,
        holiday: Boolean(ds.holidayBy?.get(add.day)),
        source: 'swap',
        leave: false,
      });
    }
  }
  return worked.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** A finding, in the shape the screens already draw. */
const finding = (level, text) => ({ level, text });

/**
 * What a fortnight looks like for one person once the shift has moved.
 *
 * Read for whoever is taking the shift on, and for whoever is giving it up:
 * giving one away is how somebody ends up owed hours, and the manager
 * approving it is the only person who can see both sides.
 */
export function findingsFor(ds, staff, { day, from = null, to = null, drop = null, add = null }) {
  const limits = limitsFrom(ds?.settings ?? {});
  const start = from ?? addDays(day, -6);
  const end = to ?? addDays(day, 6);

  const worked = workedWith(ds, staff.id, start, end, { drop, add });
  const out = [];

  const short = turnarounds(worked, limits.dailyRestHours.value);
  for (const gap of short) {
    out.push(finding('high',
      `${staff.name} would finish ${gap.after} and start ${gap.before} `
      + `${gap.hours} hours later, under the ${limits.dailyRestHours.value} `
      + `${limits.dailyRestHours.law} asks for.`));
  }

  const weekOf = addDays(day, -dow(day));
  for (const week of weeklyLoad(worked)) {
    if (week.week !== weekOf) continue;
    if (week.hours > limits.weeklyHours.value) {
      out.push(finding('warn',
        `That week takes ${staff.name} to ${week.hours} hours, over the `
        + `${limits.weeklyHours.value} the property counts as a week.`));
    }
  }

  const rest = weeklyRest(worked, weekOf, addDays(weekOf, 6));
  if (rest && rest.hours < limits.weeklyRestHours.value) {
    out.push(finding('high',
      `${staff.name} would have ${Math.round(rest.hours)} hours off that week, `
      + `under the ${limits.weeklyRestHours.value} the property asks for.`));
  }

  const runs = consecutiveRuns(worked, start, end);
  if (runs.longest > limits.consecutiveDays.value) {
    out.push(finding('warn',
      `${runs.longest} days in a row without one off, over the `
      + `${limits.consecutiveDays.value} the property allows.`));
  }

  return out;
}

/**
 * Everything a manager should see before approving, both people at once.
 *
 * Ordered loudest first, because the first line is the one that gets read.
 */
export function findingsForSwap(ds, {
  from, to, day, shift, backDay = null, backShift = null,
}) {
  const out = [];

  if (to) {
    out.push(...findingsFor(ds, to, {
      day,
      add: { day, shift },
      drop: backShift ? { day: backDay, shift: backShift } : null,
    }));
  }
  if (from) {
    out.push(...findingsFor(ds, from, {
      day,
      drop: { day, shift },
      add: backShift ? { day: backDay, shift: backShift } : null,
    }));
  }

  const rank = { high: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
}

/** Nothing to say, which is a thing worth saying on a screen full of warnings. */
export const nothingFlagged = (findings) => !findings.some((f) => f.level === 'high' || f.level === 'warn');

/**
 * May this go through without a manager?
 *
 * Only where the property has said so, and only where there is genuinely
 * nothing to look at. "Clean" is not "no red": an amber finding is a thing
 * somebody decided was worth a person's eye.
 */
export function goesStraightThrough(rules, findings) {
  return rules.approval === 'clean' && nothingFlagged(findings);
}

/**
 * The shifts somebody may offer.
 *
 * Published, in the future, far enough ahead, and not already on the board.
 * A draft is not a promise and cannot be given away; a signed-off day has been
 * counted and is not a shift any more, it is a record.
 */
export function offerable(ds, staffId, { from, to, now, rules, alreadyOffered = new Set() }) {
  const out = [];
  for (const day of rangeDays(from, to)) {
    for (const row of ds.rosterAllBy?.get(`${staffId}|${day}`) ?? []) {
      if (!row.shift_id || !row.published) continue;
      if (alreadyOffered.has(Number(row.id))) continue;
      const shift = ds.shiftById?.get(row.shift_id);
      if (!shift) continue;
      if (tooLate(day, shift, now, rules.noticeHours)) continue;
      if (ds.leaveBy?.get(`${staffId}|${day}`)) continue;
      out.push({ row, day, shift });
    }
  }
  return out;
}
