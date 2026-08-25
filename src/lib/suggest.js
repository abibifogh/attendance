// A first draft of a rota, from what this property actually does.
//
// The screen it feeds is the rota, unchanged: everything here lands as an
// ordinary unpublished cell, dashed like any other draft, counted by the same
// Publish button. NOTHING HERE PUBLISHES ANYTHING, and nothing here overwrites
// a decision. It fills the blanks, and blank is the only thing it touches.
//
// WHAT IT IS FOR. Most weeks are last week with two changes, and the two
// changes are the part worth a person's attention. Copying a week already
// handles the ordinary case; this is for the week where somebody has left, or
// three people are on leave, or a new month starts on a Thursday — the weeks
// where the pattern no longer answers and a planner is filling ninety cells by
// hand while trying to hold six rules in their head.
//
// WHAT IT WILL NOT DO.
//
//   It never touches a cell anybody decided. An explicit roster row and a
//   standing pattern are both decisions; only "nothing has ever been said
//   about this day" is fair game.
//
//   It never rosters somebody on approved leave, and never over a whole day
//   they have said they cannot work. A window inside a day only rules out the
//   shifts that overlap it, because somebody with a clinic appointment until
//   noon can still work the evening.
//
//   It never proposes a shift that would break one of the property's own
//   limits. The rota itself allows those, loudly, because a hotel has nights
//   when somebody has to cover — but a machine filling blanks has no business
//   making that call on anybody's behalf.
//
// WHAT IT AIMS AT. How many people this property usually puts on each shift on
// each weekday, read from what it did over the previous weeks. Not a target
// somebody typed: the rota is the record of what the place needs, and the
// weeks behind it are the only honest source for what the week ahead wants.

import { addDays, dow, rangeDays } from '../util/dates.js';
import { onRota, scheduleFor } from './attendance.js';
import { isNightShift, limitsFrom, shiftsInWindow } from './workload.js';

/** How far back to read the property's habits. Six weeks: long enough to see a
 *  rotation come round twice, short enough that a member of staff who changed
 *  departments in March is not still being rostered to the old one. */
export const HISTORY_WEEKS = 6;

/**
 * Where somebody is free, what they usually do, and what the place usually
 * needs — turned into a list of cells to fill.
 *
 * Pure. Everything it reads comes off the dataset, and everything it returns
 * is the same shape the grid's own Save posts, so the proposal goes through
 * exactly the validation a hand-typed change does.
 */
export function suggestRota({
  ds, history, from, to, availabilityBy = new Map(), staffIds = null, limits = null,
}) {
  const rules = limits ?? limitsFrom(ds.settings ?? {});
  const days = rangeDays(from, to);
  const shifts = (ds.shifts ?? []).filter((s) => s.active);
  const people = (ds.staff ?? []).filter((s) => onRota(s)
    && (!staffIds || staffIds.includes(s.id)));

  if (!days.length || !shifts.length || !people.length) {
    return { entries: [], gaps: [], filled: 0, considered: 0, habits: [] };
  }

  const wanted = usualCover(history, shifts);
  const habit = whoUsuallyWorks(history);

  // Every proposal made so far, so the second day of the run can see what the
  // first one did. Without this the suggester would happily give somebody
  // eight days straight, one blameless decision at a time.
  const proposed = new Map();
  const entries = [];
  const gaps = [];
  let considered = 0;

  for (const day of days) {
    const weekday = dow(day);

    for (const shift of shifts) {
      // Three things can say how many people a shift wants, and the largest
      // of them wins. What the shift itself asks for is the plain answer; the
      // last few weeks are the fallback for a shift that has never said; and
      // empty slots already sitting on the day are a request in their own
      // right, because somebody put three reception cards there on purpose.
      const usual = wanted.get(`${shift.id}|${weekday}`) ?? 0;
      const asked = shift.needed == null ? null : Number(shift.needed);
      const openRows = (ds.slotsByDay?.get(day) ?? [])
        .filter((row) => Number(row.shift_id) === Number(shift.id));
      const open = openRows.length;

      const already = people.filter((p) => onThisShift(ds, proposed, p.id, day, shift.id)).length;
      const target = Math.max(asked == null ? usual : asked, already + open);
      if (!target) continue;

      let short = target - already;
      if (short <= 0) continue;
      considered += short;

      const ranked = people
        .map((person) => ({
          person,
          why: canTake(ds, proposed, person, day, shift, rules, availabilityBy),
        }))
        .filter((c) => c.why.ok)
        .map((c) => ({
          ...c,
          // Two keys, not one sum. Habit decides it: a rota should look to the
          // people on it like the rota they know, and somebody who has worked
          // the early on four of the last four Mondays is who works it. Load
          // only breaks a tie — which is most of the grid, and is exactly
          // where it matters that the same three names do not carry every gap.
          habit: habit.get(`${c.person.id}|${shift.id}|${weekday}`) ?? 0,
          load: loadOf(ds, proposed, c.person.id, day),
        }))
        .sort((a, b) => b.habit - a.habit
          || a.load - b.load
          || String(a.person.name).localeCompare(String(b.person.name)));

      // An empty slot standing on the day is filled rather than added
      // alongside, or three reception cards would come back as six.
      const toFill = [...openRows];

      for (const candidate of ranked) {
        if (short <= 0) break;
        const slot = toFill.shift();
        entries.push({
          staffId: candidate.person.id,
          day,
          shiftId: shift.id,
          rowId: slot ? Number(slot.id) : null,
          why: candidate.habit
            ? `Usually works ${shift.name} on this day`
            : 'Free, and the lightest fortnight of anybody who is',
        });
        proposed.set(`${candidate.person.id}|${day}`, shift.id);
        short -= 1;
      }

      if (short > 0) {
        gaps.push({
          day,
          shiftId: shift.id,
          shift: shift.name,
          short,
          wanted: target,
          why: reasonNobodyIsFree(ds, proposed, people, day, shift, rules, availabilityBy),
        });
      }
    }
  }

  return {
    entries,
    gaps,
    filled: entries.length,
    considered,
    habits: [...wanted.entries()]
      .map(([key, n]) => {
        const [shiftId, weekday] = key.split('|');
        return { shiftId: Number(shiftId), dow: Number(weekday), usually: n };
      })
      .filter((row) => row.usually),
  };
}

// --------------------------------------------------------------------------
// What the place usually does
// --------------------------------------------------------------------------

/**
 * How many people this property usually puts on each shift on each weekday.
 *
 * The median of the weeks behind it rather than the average, so one Saturday
 * with a wedding on does not raise every Saturday for a month, and one week
 * with the flu going round does not lower them.
 */
export function usualCover(history, shifts) {
  const byKey = new Map();
  const ids = new Set(shifts.map((s) => s.id));

  for (const week of history) {
    for (const [key, n] of week) {
      if (!ids.has(Number(String(key).split('|')[0]))) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(n);
    }
  }

  const out = new Map();
  for (const [key, counts] of byKey) {
    // Weeks where a shift ran nobody at all still count: a Sunday nobody works
    // is information, and leaving it out would turn "usually closed" into
    // "usually one person".
    const padded = [...counts];
    while (padded.length < history.length) padded.push(0);
    padded.sort((a, b) => a - b);
    const median = padded[Math.floor(padded.length / 2)];
    if (median > 0) out.set(key, median);
  }
  return out;
}

/**
 * Who works what, counted over the weeks behind.
 *
 * A count rather than a proportion: somebody who has worked the early on
 * fourteen Mondays out of the last six weeks is more of a fixture than
 * somebody who has done it twice, and the ranking should say so.
 */
export function whoUsuallyWorks(history) {
  const out = new Map();
  for (const week of history) {
    for (const [key, n] of (week.people ?? [])) {
      out.set(key, (out.get(key) ?? 0) + n);
    }
  }
  return out;
}

/**
 * Read the weeks behind into the two shapes above.
 *
 * One pass over a plain list of `{ staff_id, day, shift_id }`, which is what
 * both the roster and the days actually worked look like. Worked days are
 * included on purpose: a shift somebody covered without it ever reaching the
 * rota is still what this property does on a Tuesday.
 */
export function readHistory(rows, { weeks = HISTORY_WEEKS } = {}) {
  const usable = rows.filter((r) => r.shift_id && r.day);
  if (!usable.length) return [];

  // Weeks counted from the Monday of the earliest row, so the buckets line up
  // with weeks as everybody else in the app means them.
  let earliest = usable[0].day;
  for (const row of usable) if (row.day < earliest) earliest = row.day;
  const anchor = addDays(earliest, -dow(earliest));

  const byWeek = new Map();
  for (const row of usable) {
    const bucket = Math.floor(daysApart(anchor, row.day) / 7);
    if (!byWeek.has(bucket)) byWeek.set(bucket, { cover: new Map(), people: new Map() });

    const held = byWeek.get(bucket);
    const weekday = dow(row.day);
    const coverKey = `${row.shift_id}|${weekday}`;
    held.cover.set(coverKey, (held.cover.get(coverKey) ?? 0) + 1);

    const personKey = `${row.staff_id}|${row.shift_id}|${weekday}`;
    held.people.set(personKey, (held.people.get(personKey) ?? 0) + 1);
  }

  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-weeks)
    .map(([, held]) => Object.assign(held.cover, { people: held.people }));
}

const daysApart = (from, to) => Math.round(
  (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000,
);

// --------------------------------------------------------------------------
// Whether one person can take one shift
// --------------------------------------------------------------------------

/** Whether somebody is already down for this shift on this day. */
function onThisShift(ds, proposed, staffId, day, shiftId) {
  const staged = proposed.get(`${staffId}|${day}`);
  if (staged !== undefined) return staged === shiftId;
  return scheduleFor(ds, staffId, day).shift?.id === shiftId;
}

/** Whether anything at all is on their day already, proposed or decided. */
function busyOn(ds, proposed, staffId, day) {
  if (proposed.has(`${staffId}|${day}`)) return true;
  const schedule = scheduleFor(ds, staffId, day);
  // A cell somebody set to a rest day is a decision, and so is one that came
  // from a standing pattern. Only "nothing has ever been said" is a blank.
  return schedule.explicit;
}

/**
 * Every reason one person cannot take one shift on one day, or that they can.
 *
 * Returns the first reason it finds rather than all of them, because the list
 * is only ever read to explain a gap and one honest reason is worth four.
 */
export function canTake(ds, proposed, person, day, shift, limits, availabilityBy = new Map()) {
  const no = (why) => ({ ok: false, why });

  if (person.hired_on && day < person.hired_on) return no('had not started');
  if (person.left_on && day > person.left_on) return no('has left');

  if (ds.leaveBy?.get(`${person.id}|${day}`)) return no('on leave');
  if (busyOn(ds, proposed, person.id, day)) return no('already has that day');

  const avail = availabilityBy.get(`${person.id}|${day}`);
  if (avail && avail.status === 'unavailable') {
    // A window inside the day only rules out the shifts that overlap it.
    if (!avail.from_time || !avail.to_time) return no('cannot work that day');
    if (overlaps(shift, avail.from_time, avail.to_time)) {
      return no(`cannot work ${avail.from_time}–${avail.to_time}`);
    }
  }

  // The property's own limits, measured over the fortnight around the day so a
  // run that started last week is visible.
  const worked = withProposals(ds, proposed, person.id, addDays(day, -13), addDays(day, 6));
  const withThis = [...worked, madeUp(shift, day)].sort((a, b) => a.day.localeCompare(b.day));

  if (runEndingOn(withThis, day) > limits.consecutiveDays.value) {
    return no(`would be ${runEndingOn(withThis, day)} days in a row`);
  }
  if (tooCloseTogether(withThis, limits.dailyRestHours.value)) {
    return no(`under ${limits.dailyRestHours.value} hours' rest either side`);
  }
  if (hoursInWeekOf(withThis, day) > limits.weeklyHours.value) {
    return no(`over ${limits.weeklyHours.value} hours that week`);
  }
  if (isNightShift(shift)
    && withThis.filter((w) => w.night).length > limits.nightsPerFortnight.value) {
    return no(`over ${limits.nightsPerFortnight.value} nights in the fortnight`);
  }

  return { ok: true, why: null };
}

/** What they are down to work, with anything proposed folded in. */
function withProposals(ds, proposed, staffId, from, to) {
  const real = shiftsInWindow(ds, staffId, from, to).filter((w) => !w.leave);
  const extra = [];
  for (const [key, shiftId] of proposed) {
    const [who, day] = key.split('|');
    if (String(who) !== String(staffId)) continue;
    if (day < from || day > to) continue;
    const shift = ds.shiftById?.get(shiftId);
    if (shift) extra.push(madeUp(shift, day));
  }
  return [...real, ...extra].sort((a, b) => a.day.localeCompare(b.day));
}

/** One proposed shift, in the shape the workload rules read. */
function madeUp(shift, day) {
  const start = minutesOf(shift.starts_at);
  const end = minutesOf(shift.ends_at);
  const span = end > start ? end - start : (24 * 60) - start + end;
  const base = Date.parse(`${day}T00:00:00Z`) / 60000;
  return {
    day,
    shift,
    start: base + start,
    end: base + start + span,
    hours: Math.max(0, span - (shift.break_minutes ?? 0)) / 60,
    night: isNightShift(shift),
    weekend: dow(day) >= 5,
    leave: false,
    source: 'suggested',
  };
}

const minutesOf = (clock) => {
  const [hh, mm] = String(clock ?? '').split(':').map(Number);
  return (Number(hh) || 0) * 60 + (Number(mm) || 0);
};

/** Whether a shift touches a window inside the day it is on. */
export function overlaps(shift, fromTime, toTime) {
  const start = minutesOf(shift.starts_at);
  const end = minutesOf(shift.ends_at);
  const blockFrom = minutesOf(fromTime);
  const blockTo = minutesOf(toTime);
  // An overnight shift covers the rest of its own day, and any window in it.
  if (end <= start) return blockTo > start || blockFrom < end;
  return start < blockTo && end > blockFrom;
}

/** How many days in a row this one would make, counting backwards. */
function runEndingOn(worked, day) {
  const on = new Set(worked.map((w) => w.day));
  let n = 0;
  let cursor = day;
  while (on.has(cursor)) { n += 1; cursor = addDays(cursor, -1); }
  return n;
}

/** Whether any two of them leave less than the required rest between. */
function tooCloseTogether(worked, restHours) {
  const sorted = [...worked].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i].start - sorted[i - 1].end) / 60;
    if (gap >= 0 && gap < restHours) return true;
  }
  return false;
}

/** Hours in the Monday-to-Sunday week the day falls in. */
function hoursInWeekOf(worked, day) {
  const monday = addDays(day, -dow(day));
  const sunday = addDays(monday, 6);
  return worked
    .filter((w) => w.day >= monday && w.day <= sunday)
    .reduce((n, w) => n + w.hours, 0);
}

/** How loaded somebody's fortnight already is, for breaking a tie. */
function loadOf(ds, proposed, staffId, day) {
  return withProposals(ds, proposed, staffId, addDays(day, -13), addDays(day, 0))
    .reduce((n, w) => n + w.hours, 0);
}

/**
 * Why nobody could take a shift, in the words a planner would use.
 *
 * A gap with no explanation is a gap somebody has to work out for themselves,
 * and the answer is usually one of four things.
 */
function reasonNobodyIsFree(ds, proposed, people, day, shift, limits, availabilityBy) {
  const counts = new Map();
  for (const person of people) {
    const { ok, why } = canTake(ds, proposed, person, day, shift, limits, availabilityBy);
    if (ok) continue;
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return 'nobody at all on the books';
  return ranked.slice(0, 2).map(([why, n]) => `${n} ${why}`).join(', ');
}
