// Attendance: turning taps on a terminal into days, and days into answers.
//
// Everything in this file is a pure function over plain rows. Nothing reads the
// database and nothing writes to it, which is what makes the rules testable —
// and these rules are the part that has to be right, because they decide
// whether somebody is paid for Tuesday.
//
// The order of the file follows the order of the reasoning: time arithmetic,
// then which shift a punch belongs to, then what a day was, then what to say
// about it, then what a month of them adds up to.

import { addDays, daysInMonth, diffDays, dow, nowIn, rangeDays, startOfWeek } from '../util/dates.js';

// A fixed point to count days from, so a punch at 23:50 on Monday and one at
// 00:10 on Tuesday are eight hundred and something and eight hundred and
// something-else, and comparing them is subtraction rather than calendar work.
const ANCHOR = '2000-01-01';

// The Monday every rotation is counted from. Kept here rather than passed
// around, because a rotation that means something different in two places is
// not a rotation. Overridable through the `att_rotation_anchor` setting, which
// is the lever for a cycle that has ended up a week out of step.
export const ROTATION_ANCHOR = '2024-01-01';

export const STATUSES = [
  'present', 'late', 'early_leave', 'late_early',
  'missing_out', 'missing_in', 'absent',
  'leave', 'holiday', 'rest', 'unscheduled',
  // Only ever true of today, and only until the clock passes. A shift at 22:00
  // is not an absence at nine in the morning, and somebody halfway through one
  // has not forgotten to clock out.
  'upcoming', 'working',
];

/** Statuses that mean the day is waiting on a person to say what happened. */
const OPEN_STATUSES = new Set(['missing_out', 'missing_in']);

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** 'HH:MM' or 'HH:MM:SS' to minutes past midnight. Null on anything else. */
export function toMinutes(time) {
  if (typeof time !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 47 || mins > 59) return null;
  return hours * 60 + mins;
}

/** Minutes past midnight to 'HH:MM', wrapping past midnight rather than showing 25:00. */
export function toClock(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Absolute minutes since the anchor date, from a local day and a time on it. */
export function absMinutes(day, time) {
  const mins = toMinutes(time);
  if (mins == null) return null;
  return diffDays(ANCHOR, day) * 1440 + mins;
}

/** The day and clock time an absolute minute count lands on. */
export function fromAbs(minutes) {
  const dayOffset = Math.floor(minutes / 1440);
  return { day: addDays(ANCHOR, dayOffset), time: toClock(minutes - dayOffset * 1440) };
}

/**
 * Hours and minutes, said the way a person would say it.
 *
 * Used in the notes staff read, where "1 hr 5 min late" lands and "65 minutes"
 * makes them do arithmetic about their own morning.
 */
export function humanDuration(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!mins) return `${hours} hr${hours === 1 ? '' : 's'}`;
  return `${hours} hr${hours === 1 ? '' : 's'} ${mins} min`;
}

/** Hours to one decimal, for the columns that show a number rather than prose. */
export function hours(minutes) {
  return Math.round((Math.max(0, minutes || 0) / 60) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

/**
 * A shift's window on a particular day, in absolute minutes.
 *
 * A shift whose end is at or before its start runs into tomorrow — 22:00 to
 * 06:00 — and the whole of it, both sides of midnight, belongs to the day it
 * started. Getting this wrong is how a night porter ends up absent every day
 * and doing a double every night.
 */
export function shiftWindow(shift, day) {
  const start = toMinutes(shift.starts_at);
  const end = toMinutes(shift.ends_at);
  if (start == null || end == null) return null;

  const base = diffDays(ANCHOR, day) * 1440;
  const overnight = end <= start;
  return {
    start: base + start,
    end: base + end + (overnight ? 1440 : 0),
    overnight,
    // What the shift is worth before anybody turns up: its length, less the
    // unpaid break.
    expected: Math.max(0, (end + (overnight ? 1440 : 0)) - start - (shift.break_minutes || 0)),
  };
}

/** True when this shift crosses midnight. */
export function isOvernight(shift) {
  const start = toMinutes(shift.starts_at);
  const end = toMinutes(shift.ends_at);
  return start != null && end != null && end <= start;
}

/**
 * What a person is meant to be working on a given day.
 *
 * The rota wins over the pattern, and both can say "nothing" — which is not the
 * same as saying nothing at all. An explicit rest day is a decision somebody
 * made and it stops the day being an absence; the absence of any row means the
 * person simply is not scheduled, which stops it too but for a different reason
 * and with a different colour.
 */
/**
 * Which week of somebody's cycle a date falls in.
 *
 * Counted from a fixed Monday rather than from anything about the person, so
 * the answer for a given date never changes — not when a screen is opened, not
 * when somebody is added, not when a rotation is lengthened. A rota that
 * reshuffles itself retrospectively is worse than no rota.
 *
 * Somebody on a one-week cycle is always in week zero, which costs nothing and
 * keeps every caller free of special cases.
 */
export function rotationWeekOf(day, rotationWeeks = 1, anchor = ROTATION_ANCHOR) {
  const weeks = Math.max(1, Math.round(Number(rotationWeeks) || 1));
  if (weeks === 1) return 0;

  const elapsed = Math.floor(diffDays(startOfWeek(anchor), startOfWeek(day)) / 7);
  // Remainder, made safe for dates before the anchor.
  return ((elapsed % weeks) + weeks) % weeks;
}

/**
 * Somebody the rota is about.
 *
 * A property has people who are paid, clock in, take leave and never appear on
 * a rota: the manager, the accountant, the owner's driver. They are staff in
 * every other sense — their attendance is recorded, their leave is counted,
 * they are on the payroll — and on the rota they were a name with twenty-eight
 * blank cells after it, counted by every screen built on the grid as somebody
 * with nothing on.
 */
export const onRota = (staff) => Boolean(staff?.active) && staff?.on_rota !== 0;

/** A JSON array kept in a text column, read back without ever throwing. */
export function parseList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((t) => String(t).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * The departments somebody may be put on.
 *
 * Their own department answers for them until somebody says otherwise, which
 * is the truth for most of the staff and was the assumption every screen made
 * anyway. Naming departments explicitly is for the people it is not true of:
 * a supervisor who covers reception and the bar, a porter who does nights on
 * security.
 */
export function worksIn(staff) {
  const listed = parseList(staff?.works_in);
  if (listed.length) return listed;
  // Named shifts are an answer in their own right. Where somebody has been
  // picked out shift by shift, their department does not get to widen it back
  // to everything in the department.
  if (parseList(staff?.works_shifts).length) return [];
  return staff?.department ? [staff.department] : [];
}

/**
 * The weekdays a shift runs, Monday as 0, or null for every day.
 *
 * Null and a full week mean the same thing to every caller, but they are kept
 * apart on the way in: a shift nobody has said anything about is not the same
 * as one somebody deliberately ticked all seven days for, and the form should
 * show the difference back to them.
 */
export function runsOn(shift) {
  const listed = parseList(shift?.runs_on)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return listed.length ? [...new Set(listed)].sort((a, b) => a - b) : null;
}

/**
 * The weekdays somebody never works, Monday as 0, or null for no standing
 * rule.
 *
 * Different from the ✕ on the rota, which is a fact about one named date.
 * Somebody at church every Sunday is not going to be told a fortnight at a
 * time, and was being asked to be.
 */
export function offDays(staff) {
  const listed = parseList(staff?.off_days)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return listed.length ? [...new Set(listed)].sort((a, b) => a - b) : null;
}

/** Is this a day they never work? */
export function alwaysOff(staff, day) {
  const days = offDays(staff);
  return Boolean(days && days.includes(dow(day)));
}

/** Does this shift run on this date? */
export function runsOnDay(shift, day) {
  const days = runsOn(shift);
  return !days || days.includes(dow(day));
}

/**
 * How many days apart this shift is allowed to run, or 1 for no rule.
 *
 * Two means every other day: a day's break in between. Read as a gap rather
 * than a cadence counted from some anchor date, because an anchor is a thing
 * somebody has to maintain and it goes wrong the first time a day is skipped.
 */
export function everyDays(shift) {
  const n = Number(shift?.every_days);
  return Number.isInteger(n) && n > 1 ? Math.min(n, 30) : 1;
}

/**
 * The shifts that stand in for this one.
 *
 * Alternatives, not merely similar: exactly one of a group runs on a day, so
 * finding two of them on one Tuesday is a mistake rather than a busy Tuesday.
 */
export function alternatesOf(shift, shifts) {
  const group = shift?.alt_group || null;
  if (!group) return [];
  const pair = pairGroup(shift);
  return (shifts ?? []).filter((s) => s.alt_group === group
    && s.id !== shift.id
    // Somebody this shift runs *with* is never somebody it runs *instead of*.
    // Bistro shift 1 and Bistro shift 2 are one service cut in two and share a
    // group with the single Bistro that replaces the pair; without this they
    // would rule each other out, which is exactly backwards.
    && !(pair && pairGroup(s) === pair));
}

/**
 * The name of the set of shifts that run together, or null.
 *
 * A service split in two is two shifts and one decision: either both of them
 * are on the day or neither is. Different from alternates, which is the
 * opposite arrangement, and the two are meant to be used together — a pair
 * standing in one alternates group against the single shift it replaces.
 */
export function pairGroup(shift) {
  const group = shift?.pair_group;
  return typeof group === 'string' && group.trim() ? group.trim() : null;
}

/** The other shifts this one always runs beside. */
export function partnersOf(shift, shifts) {
  const group = pairGroup(shift);
  if (!group) return [];
  return (shifts ?? []).filter((s) => pairGroup(s) === group && s.id !== shift.id);
}

/**
 * Over what stretch a group's alternatives rule each other out: one day, or
 * the whole Monday-to-Sunday week.
 */
export function altScope(shift) {
  return shift?.alt_scope === 'week' ? 'week' : 'day';
}

/** The individual shifts somebody has been picked out for, as numbers. */
export function worksShifts(staff) {
  return parseList(staff?.works_shifts).map(Number).filter(Number.isFinite);
}

/**
 * May this person be put on this shift?
 *
 * Two deliberate yeses. A shift belonging to no department is anybody's, and
 * somebody with no department and nothing listed is unrestricted, because
 * refusing on the strength of a blank field is refusing on no evidence.
 */
/**
 * The people a shift belongs to, first choice first.
 *
 * "Nii, and Dorcas when Nii is not there" is one instruction, not two facts,
 * and it is the order that carries it. Empty means the shift belongs to
 * nobody in particular and its department answers instead.
 */
export function onlyStaff(shift) {
  const listed = parseList(shift?.only_staff).map(Number).filter(Number.isFinite);
  if (listed.length) return [...new Set(listed)];
  const single = Number(shift?.only_staff_id);
  return Number.isFinite(single) && single > 0 ? [single] : [];
}

/**
 * Where somebody stands in the queue for a shift that names its people.
 *
 * Nought is first choice. Anybody the shift does not name is last, which is
 * only ever reached for a shift that names nobody at all.
 */
export function standingFor(staff, shift) {
  const named = onlyStaff(shift);
  const at = named.indexOf(Number(staff?.id));
  return at === -1 ? named.length : at;
}

export function mayWork(staff, shift) {
  // A shift belonging to named people answers before anything else does, in
  // both directions: it is theirs whatever their department says, and it is
  // nobody else's however free they are.
  const theirs = onlyStaff(shift);
  if (theirs.length) return theirs.includes(Number(staff?.id));

  const department = shift?.department || null;
  if (!department) return true;

  const areas = worksIn(staff);
  const named = worksShifts(staff);
  if (!areas.length && !named.length) return true;

  return areas.includes(department) || named.includes(Number(shift.id));
}

export function scheduleFor(ds, staffId, day) {
  const rostered = ds.rosterBy.get(`${staffId}|${day}`);
  if (rostered) {
    return {
      shift: rostered.shift_id ? ds.shiftById.get(rostered.shift_id) ?? null : null,
      source: 'roster',
      note: rostered.note ?? null,
      explicit: true,
    };
  }

  const week = rotationWeekOf(
    day,
    ds.staffById?.get(staffId)?.rotation_weeks ?? 1,
    ds.rotationAnchor ?? ROTATION_ANCHOR,
  );
  const pattern = ds.patternBy.get(`${staffId}|${week}|${dow(day)}`);
  if (pattern) {
    return {
      shift: pattern.shift_id ? ds.shiftById.get(pattern.shift_id) ?? null : null,
      source: 'pattern',
      note: null,
      explicit: true,
    };
  }

  return { shift: null, source: 'none', note: null, explicit: false };
}

// ---------------------------------------------------------------------------
// Punches
// ---------------------------------------------------------------------------

/**
 * Drop the double taps.
 *
 * People tap twice. The face terminal reads a face, the person is not sure it
 * took, they lean in again, and two events land four seconds apart. Left alone
 * that is a clock-in and a clock-out with a four-second shift, so anything
 * inside the gap is folded into the punch before it.
 *
 * Expects punches already sorted by time.
 */
export function collapsePunches(punches, minGapMinutes = 2) {
  const out = [];
  for (const punch of punches) {
    const previous = out[out.length - 1];
    if (previous && Math.abs(punch.abs - previous.abs) < minGapMinutes) {
      // Keep the one that says something. A terminal in attendance mode labels
      // its events; a bare duplicate does not, and the label is worth more than
      // the four seconds.
      if (!previous.direction && punch.direction) out[out.length - 1] = punch;
      continue;
    }
    out.push(punch);
  }
  return out;
}

/**
 * Which of a day's shifts a punch belongs to.
 *
 * A punch is claimed by a window it falls inside, and when two windows overlap
 * — the tail of last night's shift and the head of this morning's — it goes to
 * whichever shift starts nearest to it. That is the rule that stops a night
 * porter clocking out at 06:05 from being recorded as the breakfast cook
 * arriving five minutes late.
 */
export function claimPunch(punch, windows) {
  let best = null;
  let bestDistance = Infinity;
  for (const window of windows) {
    if (punch.abs < window.from || punch.abs > window.to) continue;
    const distance = Math.min(
      Math.abs(punch.abs - window.start),
      Math.abs(punch.abs - window.end),
    );
    if (distance < bestDistance) {
      best = window;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Decide which punch was the arrival and which the departure.
 *
 * Three cases, in descending order of how much the device is telling us. A
 * terminal configured for attendance labels every event and we simply believe
 * it. One that is not gives us bare times, and the first and last of them are
 * the arrival and the departure. A single unlabelled punch is the hard case: it
 * is an arrival or a departure and nothing about it says which, so it is judged
 * by which end of the shift it is nearer to — somebody who taps once at 07:02
 * on a 07:00 shift arrived, and somebody who taps once at 16:58 on a shift
 * ending at 17:00 left.
 */
export function pairPunches(punches, window) {
  if (!punches.length) return { in: null, out: null, ambiguous: false };

  const labelled = punches.filter((p) => p.direction === 'in' || p.direction === 'out');
  if (labelled.length) {
    const ins = labelled.filter((p) => p.direction === 'in');
    const outs = labelled.filter((p) => p.direction === 'out');
    return {
      in: ins[0] ?? null,
      out: outs[outs.length - 1] ?? null,
      ambiguous: false,
    };
  }

  if (punches.length === 1) {
    const only = punches[0];
    if (!window) return { in: only, out: null, ambiguous: true };
    const nearStart = Math.abs(only.abs - window.start) <= Math.abs(only.abs - window.end);
    return nearStart
      ? { in: only, out: null, ambiguous: true }
      : { in: null, out: only, ambiguous: true };
  }

  return { in: punches[0], out: punches[punches.length - 1], ambiguous: false };
}

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

/**
 * What one person's one day was.
 *
 * The single most important function here. Everything a report says about
 * lateness, hours, absence and leave is this, aggregated.
 *
 * Precedence is deliberate and worth stating, because most of the arguments a
 * system like this causes are really arguments about precedence:
 *
 *   1. A decision a supervisor recorded. A human who has looked at the case
 *      outranks every rule below.
 *   2. Approved leave. Somebody who was granted the day off is not absent, and
 *      is not late if they happen to walk past the terminal.
 *   3. A public holiday with no punches.
 *   4. No shift scheduled — a rest day, or a person not on the rota at all.
 *   5. The punches, against the shift.
 *
 * `policy.missingPunch` decides the one genuinely ambiguous case: a day with an
 * arrival and no departure. 'incomplete' leaves it open for a human, 'absent'
 * reproduces what the terminal's own reports do, and 'auto_close' credits the
 * scheduled end and says so.
 */
export function computeDay({
  staff, day, schedule, punches = [], holiday = null, leave = null,
  override = null, policy = {},
}) {
  const shift = schedule?.shift ?? null;
  const window = shift ? shiftWindow(shift, day) : null;
  const scheduled = Boolean(shift);

  const base = {
    staff_id: staff.id,
    day,
    shift_id: shift?.id ?? null,
    scheduled: scheduled ? 1 : 0,
    expected_minutes: window?.expected ?? 0,
    first_in: null,
    last_out: null,
    punches: punches.length,
    worked_minutes: 0,
    late_minutes: 0,
    early_minutes: 0,
    overtime_minutes: 0,
    status: 'absent',
    reason_code: 'absent',
    leave_id: null,
    resolution: 'settled',
  };

  // A clock time somebody put right, without ruling on the day.
  //
  // Told apart from a ruling by having no reason attached. The rota planner
  // saying "they left at 21:00, not 17:02" is a statement about the clock, not
  // a decision about what the day should be charged to — so the corrected
  // times go in and the verdict is worked out from them, the same way it would
  // have been worked out from the punches. Lateness, hours and overtime all
  // follow on their own, which is the point: a correction that also had to
  // name a status would make the planner guess at the answer the rules already
  // know.
  const correction = override && !override.reason_code
    && (override.corrected_in || override.corrected_out)
    ? override
    : null;

  // 1. A human already ruled on this day.
  //
  // When they supplied the times the terminal never saw, those times are what
  // the day is worth. The observed punches are still measured and still shown —
  // a report that hides what the device saw next to what a supervisor decided
  // is a report nobody can audit — but the hours come from the decision.
  if (override?.reason_code) {
    const observed = measure(punches, window, shift);
    return {
      ...base,
      ...observed,
      ...correctedMeasure(override, window, shift, observed),
      punches: punches.length,
      status: override.status || statusForReason(override.reason_code, override.reasonKind),
      reason_code: override.reason_code,
      resolution: 'resolved',
    };
  }

  // 2. Approved leave.
  if (leave) {
    return {
      ...base,
      status: 'leave',
      reason_code: leave.reason_code,
      leave_id: leave.id,
      // Leave is what the day was worth, so a person on annual leave shows the
      // shift's hours rather than nothing. Without this, a fortnight off reads
      // as a fortnight of zero and every hours total is wrong.
      expected_minutes: window?.expected ?? 0,
    };
  }

  // 3. A public holiday nobody worked.
  if (holiday && !punches.length) {
    return { ...base, status: 'holiday', reason_code: 'public_holiday' };
  }

  // 4. Nothing scheduled. Somebody who turns up anyway is recorded as having
  //    worked an unscheduled day — that is a favour done on a day off, and it
  //    should be visible rather than silently discarded.
  if (!scheduled) {
    if (!punches.length && !correction) {
      return {
        ...base,
        status: 'rest',
        reason_code: holiday ? 'public_holiday' : 'rest_day',
      };
    }
    const pair = correctedPair(pairPunches(punches, null), correction, dayBase(day));
    const worked = pair.in && pair.out ? Math.max(0, pair.out.abs - pair.in.abs) : 0;
    return {
      ...base,
      first_in: pair.in ? toClock(pair.in.abs) : null,
      last_out: pair.out ? toClock(pair.out.abs) : null,
      corrected_in: correction?.corrected_in ?? null,
      corrected_out: correction?.corrected_out ?? null,
      worked_minutes: worked,
      overtime_minutes: worked,
      status: 'unscheduled',
      reason_code: 'present',
      resolution: pair.out ? 'settled' : 'open',
    };
  }

  // How far through the day it is, when the caller knows. Absent for any day in
  // the past, which is the whole point: history is settled and only today is
  // still happening.
  const nowAbs = Number.isFinite(policy.nowAbs) ? policy.nowAbs : null;

  // 5. The ordinary case: a shift, and whatever the terminal saw — with any
  //    corrected time standing in for the punch it replaces.
  if (!punches.length && !correction) {
    // A shift that has not started is not an absence. Marking the night porter
    // absent from midnight until ten at night makes the morning screen a page
    // of red that means nothing, and the one real absence on it goes unread.
    //
    // Grace is included: somebody due at 06:00 with five minutes' grace is not
    // late at 06:03, so the screen should not say so before 06:05 either.
    if (nowAbs != null && window && nowAbs < window.start + (shift.grace_in_minutes ?? 0)) {
      return { ...base, status: 'upcoming', reason_code: null };
    }
    return { ...base, status: 'absent', reason_code: 'absent' };
  }

  const pair = correctedPair(pairPunches(punches, window), correction, dayBase(day), window);
  const measured = measure(punches, window, shift, pair);
  if (correction) {
    measured.corrected_in = correction.corrected_in ?? null;
    measured.corrected_out = correction.corrected_out ?? null;
  }

  if (pair.in && pair.out) {
    const late = measured.late_minutes > (shift.grace_in_minutes ?? 0);
    const early = measured.early_minutes > (shift.grace_out_minutes ?? 0);
    const status = late && early ? 'late_early' : late ? 'late' : early ? 'early_leave' : 'present';
    return { ...base, ...measured, status, reason_code: status === 'present' ? 'present' : status };
  }

  // Still at work. A clock-in with no clock-out is only a missing punch once
  // the shift has finished; before that it is the most ordinary thing on the
  // screen, and putting it in "waiting on a decision" all afternoon teaches
  // people that the list is noise.
  if (pair.in && !pair.out && nowAbs != null && window && nowAbs < window.end) {
    return {
      ...base,
      ...measured,
      worked_minutes: 0,
      early_minutes: 0,
      status: 'working',
      reason_code: measured.late_minutes > (shift.grace_in_minutes ?? 0) ? 'late' : null,
    };
  }

  // One half of the day is missing. Which half, and what the property has said
  // to do about it.
  const missing = pair.in ? 'missing_out' : 'missing_in';
  const mode = policy.missingPunch || 'incomplete';

  if (mode === 'absent') {
    return {
      ...base, ...measured, worked_minutes: 0, status: missing, reason_code: 'absent',
    };
  }

  if (mode === 'auto_close' && pair.in && window) {
    // Credit the scheduled end, never more. Somebody who forgot to clock out
    // gets their shift, not the overtime they might have worked, because an
    // absent punch is not evidence of anything.
    const closed = Math.min(window.end, Math.max(pair.in.abs, window.end));
    const worked = Math.max(0, closed - pair.in.abs - (shift.break_minutes || 0));
    return {
      ...base,
      ...measured,
      last_out: toClock(window.end),
      worked_minutes: worked,
      early_minutes: 0,
      status: missing,
      reason_code: measured.late_minutes > (shift.grace_in_minutes ?? 0) ? 'late' : 'present',
      resolution: 'auto',
    };
  }

  return {
    ...base, ...measured, worked_minutes: 0, status: missing, reason_code: 'incomplete', resolution: 'open',
  };
}

/**
 * The arithmetic, separated from the judgement.
 *
 * Late and early are measured from the scheduled edges without regard to grace;
 * grace decides whether anybody is told about it, which is a different
 * question. Keeping the raw minutes means a property can loosen its grace
 * period next year without every past report changing its mind.
 */
function measure(punches, window, shift, pair = null) {
  const found = pair ?? pairPunches(punches, window);
  const out = {
    first_in: found.in ? toClock(found.in.abs) : null,
    last_out: found.out ? toClock(found.out.abs) : null,
    punches: punches.length,
    worked_minutes: 0,
    late_minutes: 0,
    early_minutes: 0,
    overtime_minutes: 0,
  };
  if (!window) return out;

  if (found.in) out.late_minutes = Math.max(0, found.in.abs - window.start);
  if (found.out) out.early_minutes = Math.max(0, window.end - found.out.abs);

  if (found.in && found.out) {
    out.worked_minutes = Math.max(0, found.out.abs - found.in.abs - (shift?.break_minutes || 0));
    const past = found.out.abs - window.end;
    const threshold = shift?.overtime_after ?? 0;
    out.overtime_minutes = past > threshold ? past - threshold : 0;
  }
  return out;
}

/**
 * The hours a supervisor's correction is worth.
 *
 * Returns nothing when they only chose a reason — marking a day as sick leave
 * says nothing about clock times and must not invent any.
 *
 * Only the missing half is usually supplied: the terminal saw the arrival and
 * the supervisor is confirming what time the person left. So whichever side was
 * not corrected falls back to what was observed, and the day is measured across
 * the pair.
 */
/** Minute zero of a calendar day, on the same scale every punch is measured on. */
function dayBase(day) {
  return diffDays(ANCHOR, day) * 1440;
}

/**
 * The pair of times the day should actually be measured across.
 *
 * A correction replaces one side or both; whichever side was not corrected
 * stays exactly as the terminal read it, because the usual case is a person
 * whose arrival was recorded perfectly and whose departure was not.
 *
 * A corrected departure earlier than the arrival is the far side of midnight,
 * which is ordinary on a night shift and would otherwise read as a negative
 * day.
 */
function correctedPair(pair, correction, base, window = null) {
  if (!correction) return pair;

  let inAbs = pair.in?.abs ?? null;
  let outAbs = pair.out?.abs ?? null;
  if (correction.corrected_in) inAbs = base + toMinutes(correction.corrected_in);
  if (correction.corrected_out) {
    outAbs = base + toMinutes(correction.corrected_out);
    if (outAbs < (inAbs ?? window?.start ?? outAbs)) outAbs += 1440;
  }

  return {
    in: inAbs == null ? null : { ...(pair.in ?? {}), abs: inAbs },
    out: outAbs == null ? null : { ...(pair.out ?? {}), abs: outAbs },
    ambiguous: false,
  };
}

function correctedMeasure(override, window, shift, observed = {}) {
  const inAt = override.corrected_in ?? null;
  const outAt = override.corrected_out ?? null;
  if (!inAt && !outAt) return {};
  if (!window) return { corrected_in: inAt, corrected_out: outAt };

  const base = Math.floor(window.start / 1440) * 1440;
  const startClock = inAt ?? observed.first_in ?? null;
  const outClock = outAt ?? observed.last_out ?? null;

  const startAbs = startClock ? base + toMinutes(startClock) : null;
  // A time before the shift start belongs to the far side of midnight, which is
  // ordinary on a night shift.
  let endAbs = outClock ? base + toMinutes(outClock) : null;
  if (endAbs != null && endAbs < (startAbs ?? window.start)) endAbs += 1440;

  const out = { corrected_in: inAt, corrected_out: outAt };
  if (startAbs != null) out.first_in = toClock(startAbs);
  if (endAbs != null) out.last_out = toClock(endAbs);
  if (startAbs != null) out.late_minutes = Math.max(0, startAbs - window.start);
  if (endAbs != null) out.early_minutes = Math.max(0, window.end - endAbs);
  if (startAbs != null && endAbs != null) {
    out.worked_minutes = Math.max(0, endAbs - startAbs - (shift?.break_minutes || 0));
    const past = endAbs - window.end;
    out.overtime_minutes = past > (shift?.overtime_after ?? 0) ? past - (shift?.overtime_after ?? 0) : 0;
  }
  return out;
}

function statusForReason(code, kind) {
  if (kind === 'leave') return 'leave';
  if (kind === 'holiday') return 'holiday';
  if (kind === 'rest') return 'rest';
  if (kind === 'absent') return 'absent';
  return code === 'present' ? 'present' : code;
}

/** Is this day waiting on somebody? */
export function isOpen(record) {
  return record.resolution === 'open' || (record.resolution !== 'resolved' && OPEN_STATUSES.has(record.status));
}

/**
 * Green, amber, red or grey.
 *
 * Deliberately four and not more. A colour that has to be explained is not
 * doing its job, and the only three things a manager needs to pick out of a
 * page of names are "fine", "worth a word" and "deal with this".
 */
export function colourFor(record, reasons) {
  const reason = reasons?.get?.(record.reason_code);
  if (reason?.colour) return reason.colour;
  switch (record.status) {
    case 'present': case 'unscheduled': return 'green';
    case 'late': case 'early_leave': case 'late_early': return 'amber';
    case 'missing_in': case 'missing_out': return record.resolution === 'auto' ? 'amber' : 'red';
    case 'absent': return 'red';
    // Green for somebody at work; grey for a shift that has not come round yet.
    case 'working': return record.late_minutes > 0 ? 'amber' : 'green';
    case 'upcoming': return 'grey';
    default: return 'grey';
  }
}

/**
 * How a day should be labelled on a report.
 *
 * The wording follows what the terminal's own reports say, because staff have
 * been reading those for months and a system that renames everything on day one
 * spends its first fortnight being explained.
 */
export function labelFor(record, reasons) {
  const reason = reasons?.get?.(record.reason_code);
  switch (record.status) {
    case 'present': return 'Present';
    case 'upcoming': return 'Not due yet';
    case 'working': return record.first_in ? `On shift since ${record.first_in}` : 'On shift';
    case 'late': return 'Late';
    case 'early_leave': return record.early_minutes <= 1 ? 'Left early — minor' : 'Left early';
    case 'late_early': return 'Late and left early';
    case 'missing_out':
      if (record.resolution === 'auto') return 'No clock-out — shift credited';
      return record.late_minutes > 0 && record.reason_code === 'absent'
        ? 'Absent (late in, no clock-out)'
        : record.reason_code === 'absent' ? 'Absent (no clock-out)' : 'No clock-out — to check';
    case 'missing_in':
      if (record.resolution === 'auto') return 'No clock-in — shift credited';
      return record.reason_code === 'absent' ? 'Absent (no clock-in)' : 'No clock-in — to check';
    case 'absent': return reason?.label ?? 'Absent';
    case 'leave': return reason?.label ?? 'Leave';
    case 'holiday': return reason?.label ?? 'Public holiday';
    case 'rest': return reason?.label ?? 'Rest day';
    case 'unscheduled': return 'Worked — not scheduled';
    default: return reason?.label ?? record.status;
  }
}

// ---------------------------------------------------------------------------
// What to say about it
// ---------------------------------------------------------------------------

/**
 * The line the staff member reads.
 *
 * Written to be handed to somebody who was not in the room when the rule was
 * explained, which is the situation nearly everybody receiving one of these is
 * in. So: what the system saw, why it was recorded the way it was, and the one
 * thing to do differently. Never more than three sentences, and no vocabulary
 * that only exists inside this app.
 *
 * `streak` is how many days in a row this has now happened. It is the only
 * thing that changes the tone, and it changes it because the third identical
 * note in a week reads as a system nobody is watching.
 */
export function noteFor(record, { shift = null, streak = 0, weekCount = 0, reasons = null } = {}) {
  const start = shift ? shift.starts_at : null;
  const end = shift ? shift.ends_at : null;
  const again = repetition(streak, weekCount);

  switch (record.status) {
    case 'present': {
      if (record.overtime_minutes > 15) {
        return `You clocked in at ${record.first_in} and out at ${record.last_out} — `
          + `${humanDuration(record.overtime_minutes)} past your ${end} finish. Thank you.`;
      }
      return `You clocked in at ${record.first_in} and out at ${record.last_out}. Nothing to deal with.`;
    }

    case 'late': {
      const stayed = record.overtime_minutes > 5
        ? ` You did stay ${humanDuration(record.overtime_minutes)} past the end of your shift.`
        : '';
      return `You clocked in at ${record.first_in}, ${humanDuration(record.late_minutes)} after your `
        + `${start} start.${stayed} Your shift starts at ${start}${again}`;
    }

    case 'early_leave': {
      if (record.early_minutes <= 1) {
        return `You clocked out at ${record.last_out}, a minute before your ${end} finish. `
          + 'That is close enough to be the clock rather than you — nothing to deal with.';
      }
      return `You clocked out at ${record.last_out}, ${humanDuration(record.early_minutes)} before your `
        + `${end} finish. If you need to leave early, agree it with your supervisor first${again}`;
    }

    case 'late_early': {
      return `You clocked in at ${record.first_in} (${humanDuration(record.late_minutes)} late) and out at `
        + `${record.last_out} (${humanDuration(record.early_minutes)} early). Your shift is ${start} to ${end}${again}`;
    }

    case 'missing_out': {
      const lateBit = record.late_minutes > (shift?.grace_in_minutes ?? 5)
        ? ` You also clocked in ${humanDuration(record.late_minutes)} after your ${start} start.`
        : '';
      if (record.resolution === 'auto') {
        return `You clocked in at ${record.first_in} but never clocked out, so the system has credited you `
          + `to your ${end} finish.${lateBit} Please always clock out — a credited shift is a guess, not a record.`;
      }
      if (record.reason_code === 'absent') {
        return `You clocked in at ${record.first_in} but never clocked out.${lateBit} `
          + 'With one of the two taps missing the day is marked absent, so no hours are counted. '
          + 'Speak to your supervisor, and always clock out before you leave.';
      }
      return `You clocked in at ${record.first_in} but there is no clock-out.${lateBit} `
        + 'The day is being held until your supervisor confirms what time you left. '
        + 'Always clock out — it is what turns your morning into paid hours.';
    }

    case 'missing_in': {
      if (record.resolution === 'auto') {
        return `There is no clock-in for you, but you clocked out at ${record.last_out}, so the system has `
          + `credited you from your ${start} start. Please always clock in when you arrive.`;
      }
      if (record.reason_code === 'absent') {
        return `You clocked out at ${record.last_out} but there is no clock-in. `
          + 'With one of the two taps missing the day is marked absent, so no hours are counted. '
          + 'Speak to your supervisor, and always clock in when you arrive.';
      }
      return `You clocked out at ${record.last_out} but there is no clock-in for you. `
        + 'The day is being held until your supervisor confirms what time you arrived. '
        + 'Always clock in when you get here.';
    }

    case 'upcoming': {
      return start
        ? `Due on shift at ${start}. Nothing to deal with yet.`
        : 'Due on shift later today. Nothing to deal with yet.';
    }

    case 'working': {
      return record.first_in
        ? `Clocked in at ${record.first_in} and still on shift. Nothing to deal with yet.`
        : 'On shift now. Nothing to deal with yet.';
    }

    case 'absent': {
      const reason = reasons?.get?.(record.reason_code);
      if (reason && record.reason_code !== 'absent') {
        return `Recorded as ${reason.label.toLowerCase()}${record.resolved_note ? ` — ${record.resolved_note}` : ''}. `
          + `${reason.paid ? 'This is a paid day.' : 'This day is unpaid.'}`;
      }
      if (streak >= 3) {
        return `No clock-in and no clock-out. This is ${ordinal(streak)} day in a row with nothing recorded — `
          + 'your supervisor needs to hear from you today.';
      }
      return 'You did not clock in and did not clock out, so the full shift is marked absent. '
        + 'If you were at work, speak to your supervisor today so it can be corrected.';
    }

    case 'leave': {
      const reason = reasons?.get?.(record.reason_code);
      return `${reason?.label ?? 'Leave'} — approved. `
        + `${reason?.paid ? 'Paid.' : 'Unpaid.'}${reason?.deducts_leave ? ' Comes off your annual leave.' : ''}`;
    }

    case 'holiday':
      return 'Public holiday. Nothing expected of you.';

    case 'rest':
      return 'Rest day. Nothing expected of you.';

    case 'unscheduled': {
      if (!record.last_out) {
        return `You were not on the rota but clocked in at ${record.first_in}. There is no clock-out, `
          + 'so your supervisor needs to confirm the hours before they count.';
      }
      return `You were not on the rota today but worked ${humanDuration(record.worked_minutes)} `
        + `(${record.first_in} to ${record.last_out}). It has been recorded as extra time.`;
    }

    default:
      return '';
  }
}

/** The escalating tail. Blank on a first offence, pointed by the third. */
function repetition(streak, weekCount) {
  if (streak >= 3) return `. This is ${ordinal(streak)} day in a row — your supervisor has been notified.`;
  if (streak === 2) return '. This is the second day running.';
  if (weekCount >= 2) return `. That is ${weekCount} times this week.`;
  return '.';
}

function ordinal(n) {
  const words = ['', 'the first', 'the second', 'the third', 'the fourth', 'the fifth', 'the sixth'];
  return words[n] || `the ${n}th`;
}

// ---------------------------------------------------------------------------
// Adding days up
// ---------------------------------------------------------------------------

/**
 * How much of a day was worked, for the purpose of counting days.
 *
 * A number an accountant will use, so the thresholds are explicit rather than
 * implied: a full day at or above the shift's `full_day_minutes`, half a day at
 * or above `half_day_minutes`, and nothing below that. A day charged to a
 * reason that counts as worked — training, working off site — is a whole day
 * regardless of what the terminal saw, because the terminal was not there.
 */
export function dayCredit(record, { shift = null, reason = null } = {}) {
  if (reason && !reason.counts_as_worked) return 0;
  if (reason?.counts_as_worked && record.status !== 'present' && !record.worked_minutes) return 1;

  const full = shift?.full_day_minutes ?? 420;
  const half = shift?.half_day_minutes ?? 240;
  if (record.worked_minutes >= full) return 1;
  if (record.worked_minutes >= half) return 0.5;
  // An auto-closed day was credited to the shift end on purpose; refusing it a
  // day here would undo the decision the policy just made.
  if (record.resolution === 'auto' && record.worked_minutes > 0) return 1;
  return 0;
}

/**
 * A period, summed.
 *
 * The shape every report leans on — the day report for one person, the week for
 * a department, the month for payroll. One function so the week cannot disagree
 * with the sum of its days, which is the classic way a report loses its
 * audience.
 */
export function summarise(records, { shifts = new Map(), reasons = new Map() } = {}) {
  const totals = {
    days: records.length,
    scheduled: 0,
    daysWorked: 0,
    daysAbsent: 0,
    daysLeave: 0,
    daysHoliday: 0,
    daysRest: 0,
    workedMinutes: 0,
    expectedMinutes: 0,
    overtimeMinutes: 0,
    lateCount: 0,
    lateMinutes: 0,
    earlyCount: 0,
    earlyMinutes: 0,
    absences: 0,
    openCount: 0,
    unscheduledCount: 0,
    leaveDeducted: 0,
    byReason: new Map(),
  };

  for (const record of records) {
    const shift = record.shift_id ? shifts.get(record.shift_id) ?? null : null;
    const reason = reasons.get(record.reason_code) ?? null;

    if (record.scheduled) totals.scheduled += 1;
    totals.workedMinutes += record.worked_minutes || 0;
    totals.overtimeMinutes += record.overtime_minutes || 0;
    if (record.scheduled || record.status === 'leave') {
      totals.expectedMinutes += record.expected_minutes || 0;
    }

    totals.daysWorked += dayCredit(record, { shift, reason });

    if (record.late_minutes > (shift?.grace_in_minutes ?? 5)) {
      totals.lateCount += 1;
      totals.lateMinutes += record.late_minutes;
    }
    if (record.early_minutes > (shift?.grace_out_minutes ?? 5)) {
      totals.earlyCount += 1;
      totals.earlyMinutes += record.early_minutes;
    }

    switch (reason?.kind ?? kindOf(record.status)) {
      case 'absent': totals.daysAbsent += 1; totals.absences += 1; break;
      // Neither worked nor missed: the day has not finished having its say.
      case 'upcoming': case 'working': break;
      case 'leave':
        totals.daysLeave += 1;
        if (reason?.deducts_leave) totals.leaveDeducted += 1;
        break;
      case 'holiday': totals.daysHoliday += 1; break;
      case 'rest': totals.daysRest += 1; break;
      default: break;
    }

    if (record.status === 'unscheduled') totals.unscheduledCount += 1;
    if (isOpen(record)) totals.openCount += 1;

    const key = record.reason_code || record.status;
    totals.byReason.set(key, (totals.byReason.get(key) ?? 0) + 1);
  }

  totals.attendanceRate = totals.scheduled
    ? Math.round(((totals.scheduled - totals.absences) / totals.scheduled) * 1000) / 10
    : null;
  totals.punctualityRate = totals.scheduled
    ? Math.round(((totals.scheduled - totals.lateCount) / totals.scheduled) * 1000) / 10
    : null;

  return totals;
}

function kindOf(status) {
  switch (status) {
    case 'absent': case 'missing_in': case 'missing_out': return 'absent';
    // Their own kind, so a shift still to come is never counted as one missed.
    case 'upcoming': case 'working': return status;
    case 'leave': return 'leave';
    case 'holiday': return 'holiday';
    case 'rest': return 'rest';
    default: return 'worked';
  }
}

/**
 * How many days in a row, up to and including this one, have gone the same way.
 *
 * Rest days and public holidays do not break a run — somebody absent Friday and
 * Monday over a weekend off is absent twice running, and telling them it is a
 * first offence because Sunday intervened is how a rule stops being taken
 * seriously. Working, or being on approved leave, breaks it.
 */
export function streakOf(records, index, predicate) {
  if (!predicate(records[index])) return 0;
  let streak = 1;
  for (let i = index - 1; i >= 0; i--) {
    const record = records[i];
    if (predicate(record)) { streak += 1; continue; }
    if (record.status === 'rest' || record.status === 'holiday') continue;
    break;
  }
  return streak;
}

/** How many times in this record's week the predicate has held, up to and including it. */
export function weekCountOf(records, index, predicate) {
  const week = startOfWeek(records[index].day);
  let count = 0;
  for (let i = 0; i <= index; i++) {
    if (startOfWeek(records[i].day) !== week) continue;
    if (predicate(records[i])) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

/**
 * The leave year a date falls in.
 *
 * Held as 'MM-DD' in settings so a property running April to March is a setting
 * rather than a code change. The year is named for the calendar year it starts
 * in, which is what people say out loud.
 */
export function leaveYearOf(day, startsAt = '01-01') {
  const [month, date] = String(startsAt).split('-').map(Number);
  const year = Number(day.slice(0, 4));
  const boundary = `${year}-${String(month || 1).padStart(2, '0')}-${String(date || 1).padStart(2, '0')}`;
  const start = day >= boundary ? boundary : `${year - 1}-${String(month || 1).padStart(2, '0')}-${String(date || 1).padStart(2, '0')}`;
  const [sy] = start.split('-').map(Number);
  const end = addDays(`${sy + 1}-${String(month || 1).padStart(2, '0')}-${String(date || 1).padStart(2, '0')}`, -1);
  return { start, end, label: `${start.slice(0, 4)}` };
}

/** Whole months of service completed between two dates. */
export function monthsBetween(from, to) {
  if (!from || !to || from > to) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}

/**
 * What one person is entitled to this leave year, and what is left of it.
 *
 * The default follows the Labour Act 2003 (Act 651): fifteen working days of
 * paid annual leave after twelve months' continuous service. Both numbers are
 * settings, because a property may be more generous and several are.
 *
 * Somebody who has not yet completed the qualifying service is shown a
 * pro-rated figure with `qualified: false` rather than a bare zero. A zero is
 * technically correct on the day and useless to the manager deciding whether to
 * approve three days in November — what they want to know is what the person is
 * on course for.
 */
export function leaveBalance({
  staff, records = [], requests = [], settings = {}, asOf, reasons = new Map(),
  adjustments = [],
}) {
  const yearStart = settings.att_leave_year_starts || '01-01';
  const year = leaveYearOf(asOf, yearStart);

  const entitlementDays = Number(staff.leave_days ?? settings.att_leave_days ?? 15);
  const qualifyMonths = Number(settings.att_leave_qualify_months ?? 12);
  const carryOver = Number(settings.att_leave_carryover_days ?? 0);

  const service = staff.hired_on ? monthsBetween(staff.hired_on, year.end) : qualifyMonths;
  const qualified = service >= qualifyMonths;

  // Pro-rata for anybody who joined part way through the year, qualified or
  // not, rounded to the half day people actually take.
  //
  // Counted in days rather than whole months on purpose. Somebody who started
  // on the first of July has worked half the year, and a month count that only
  // credits completed months makes it five twelfths — an argument nobody should
  // have to have with a member of staff over half a day's leave.
  const partYear = staff.hired_on && staff.hired_on > year.start;
  const entitlement = partYear
    ? Math.round((entitlementDays
      * (diffDays(staff.hired_on, year.end) + 1)
      / (diffDays(year.start, year.end) + 1)) * 2) / 2
    : entitlementDays;

  // Taken: days already charged to a leave reason that comes off the balance.
  let taken = 0;
  for (const record of records) {
    if (record.day < year.start || record.day > year.end) continue;
    const reason = reasons.get(record.reason_code);
    if (reason?.deducts_leave) taken += 1;
  }

  // Booked: approved requests whose days have not been charged yet, plus
  // anything still waiting on a decision. Shown apart from `taken` so a manager
  // can see the difference between spent and committed.
  let booked = 0;
  let pending = 0;
  for (const request of requests) {
    const reason = reasons.get(request.reason_code);
    if (!reason?.deducts_leave) continue;
    if (request.from_day > year.end || request.to_day < year.start) continue;
    if (request.status === 'pending') pending += request.days;
    else if (request.status === 'approved' && request.from_day > asOf) booked += request.days;
  }

  // Signed-off months, in days. Negative is a shortfall charged to the
  // entitlement; positive is time given back for covering more than was
  // rostered. Only months inside this leave year count, so signing off last
  // December cannot move this year's balance.
  let adjusted = 0;
  for (const row of adjustments) {
    // A signed span belongs to the leave year its first day falls in. Keyed on
    // the start rather than the end so a span crossing New Year lands in one
    // year rather than being counted, or lost, by both.
    const start = String(row.from_day ?? row.from ?? (row.month ? `${row.month}-01` : ''));
    if (!start) continue;
    if (start < year.start || start > year.end) continue;
    adjusted += Number(row.days_applied ?? row.daysApplied ?? 0) || 0;
  }
  adjusted = Math.round(adjusted);

  const available = entitlement + carryOver + adjusted;
  return {
    year: year.label,
    from: year.start,
    to: year.end,
    entitlement,
    carryOver,
    adjusted,
    available,
    taken,
    booked,
    pending,
    remaining: Math.round((available - taken - booked) * 2) / 2,
    qualified,
    serviceMonths: service,
    proRated: Boolean(partYear),
  };
}

/**
 * How many days of leave a request actually costs.
 *
 * Counted against the rota, not the calendar. A request covering a rest day or
 * a public holiday does not spend leave on it — nobody was going to be at work
 * — and a system that charges for those is one staff learn to game by asking
 * for Friday to Monday.
 */
export function leaveDaysIn(args) {
  return leaveDaysFor(args).days;
}

/**
 * The same count, and how much of it is known rather than guessed.
 *
 * LEAVE IS ASKED FOR BEFORE THE ROTA EXISTS. Somebody books a week in December
 * in August, and in August the rota reaches a fortnight out. If the count came
 * only from days the rota knows about, every request more than a fortnight
 * ahead would be nought days — and the app used to refuse those outright,
 * which is exactly backwards: asking early is the behaviour a property wants.
 *
 * So each day in the span is one of three things.
 *
 *   Known and working — the rota says so, or the standing pattern does. It
 *   counts, and it is not a guess.
 *
 *   Known and not working — a rest day the pattern gives them, or a public
 *   holiday. It counts for nothing, and that is not a guess either.
 *
 *   Unknown — nobody has said, because nobody has built that far ahead and
 *   this person has no standing pattern at all. Guessed at from what the
 *   property expects of a week, and marked as a guess so the figure can be
 *   settled when somebody approves it and the rota is real. Somebody who does
 *   have a pattern is never unknown: a pattern listing Monday to Friday has no
 *   row for Saturday, and that silence is the answer.
 *
 * The guess is deliberately the crude one: a share of the calendar days, at
 * the property's days per week. A whole week off comes to five, which is
 * right; a Monday-to-Friday comes to three and a half, which is low, and
 * whoever approves it sees the number with the rota in front of them.
 */
export function leaveDaysFor({ from, to, staffId, ds, halfDay = null }) {
  let known = 0;
  let unknown = 0;
  let settled = 0;
  let fromRota = 0;

  for (const day of rangeDays(from, to)) {
    if (ds.holidayBy.has(day)) { settled += 1; continue; }
    const schedule = scheduleFor(ds, staffId, day);
    if (schedule.source === 'none') {
      // Their pattern already answered by not mentioning this weekday.
      if (ds.patternStaff?.has(staffId)) settled += 1;
      else unknown += 1;
      continue;
    }
    if (schedule.source === 'roster') fromRota += 1;
    if (schedule.shift) known += 1;
    else settled += 1;
  }

  // Somebody has built part of this span by hand, so the blanks in it are
  // their decision rather than a gap in the calendar. Only a span nobody has
  // touched at all gets guessed at.
  if (fromRota > 0 && unknown > 0) {
    settled += unknown;
    unknown = 0;
  }

  const perWeek = daysPerWeekFor(ds.staffById?.get(staffId), ds.settings ?? {});
  // Half days, because that is the smallest unit anything else here charges in.
  const guessed = unknown ? Math.round((unknown * perWeek) / 7 * 2) / 2 : 0;

  let days = known + guessed;
  if (halfDay === 'start' || halfDay === 'end') days -= 0.5;
  else if (halfDay === 'both') days -= 1;

  return {
    days: Math.max(0, days),
    known,
    unknown,
    // Every day in the span had an answer, and none of them was a working day.
    // The only case where "there is no leave to take" is a true thing to say.
    allSettled: unknown === 0 && known === 0 && settled > 0,
    estimated: unknown > 0,
  };
}

// ---------------------------------------------------------------------------
// Over and under, counted in days
// ---------------------------------------------------------------------------

/**
 * What a month owes, or is owed, in whole days.
 *
 * Subtracting hours worked from hours rostered gives a decimal, and a decimal
 * is unusable here: nobody is charged 1.3 days of leave. Worse, it counts
 * things nobody would count. Somebody who left twenty minutes early four times
 * has not worked a day and a half less than they should have — they have had
 * four slightly short days, which is a conversation, not a deduction.
 *
 * So both sides are counted as events rather than measured as quantities, and
 * each side has a threshold that has to be crossed before it counts at all:
 *
 *   An **over** is a day worked that the rota never asked for, and only when
 *   more than six hours were actually worked on it. Coming in for two hours to
 *   cover a gap is a favour worth thanking somebody for; it is not a day off in
 *   lieu, and treating it as a fraction of one is how the balance stops meaning
 *   anything.
 *
 *   An **under** is a whole rostered shift missed, and only once somebody has
 *   ruled on it. A part-day is not an under at any length. An absence nobody
 *   has confirmed is not one either — the record may be a forgotten tap, and
 *   charging leave against a maybe is the one mistake here that costs a person
 *   real money.
 *
 * The difference is therefore always a whole number, and every day behind it
 * can be named — which is what makes it arguable rather than merely asserted.
 */
/** What the property expects of somebody in a week, where nothing says otherwise. */
export const DEFAULT_DAYS_PER_WEEK = 5;

/**
 * What one calendar day is worth as an expectation.
 *
 * Five days out of every seven, not Monday to Friday. The distinction matters
 * in a hotel, where the rota runs across all seven and a Saturday is an
 * ordinary working day for half the staff: counting only weekdays would leave
 * the night porter permanently over and the office permanently square for
 * doing the same amount of work.
 *
 * So every day of the week carries the same fraction of the expectation, and
 * over a week it comes to five. A public holiday carries none — it is a day
 * the property does not expect anybody in, whichever day of the week it falls
 * on.
 *
 * Fractional on purpose. Keeping the expectation per day is what lets a
 * sign-off cover three days out of a month and still come to the same answer
 * the whole month would; a period figure rounded first and divided afterwards
 * does not add up, and this is arithmetic that ends in somebody's leave.
 */
export function dayQuota(day, holidays = null, perWeek = DEFAULT_DAYS_PER_WEEK) {
  const share = Math.max(0, Number(perWeek) || 0) / 7;
  const isHoliday = holidays ? Boolean(holidays.has ? holidays.has(day) : holidays[day]) : false;
  // A public holiday takes a whole day off the expectation, not its seventh of
  // one: a week with a holiday in it expects four days, not four and a third.
  // The day still carries its own share, so the arithmetic stays a sum over
  // days and a single holiday reads as slightly negative on its own — which is
  // exactly right, since it is a day off that the rest of the week pays for.
  return isHoliday ? share - 1 : share;
}

/** Whether this day counts towards the expectation at all. */
export function isWorkingDay(day, holidays = null) {
  return dayQuota(day, holidays) > 0;
}

/**
 * What one day is worth on each side of the ledger.
 *
 * `credit` is a day the person delivered: one they actually clocked in and out
 * of, or one they were on leave for. `quota` is a day the property expected of
 * them. The difference between the two sums is the whole of the over-or-under,
 * and keeping it per day is what lets a sign-off cover three days out of a
 * fortnight and still come to the right number.
 */
export function dayLedger(record, {
  holidays = null, perWeek = DEFAULT_DAYS_PER_WEEK, calendar = null,
} = {}) {
  const worked = Boolean(record.first_in && record.last_out);
  const onLeave = record.status === 'leave';
  return {
    // Named `owed` rather than `credit` on purpose: `credit` already means the
    // half-a-day-for-a-short-shift figure everywhere else in this file, and two
    // things called credit that differ on a five-hour Wednesday is a bug
    // waiting to be written.
    owed: worked || onLeave ? 1 : 0,
    // A month somebody has been told what it expected is that, spread evenly
    // across its days so a part of it still adds up. The five-in-seven rule
    // only answers for the months nobody has said anything about — which is
    // almost all of them.
    quota: calendar
      ? calendar.share(record.day) ?? dayQuota(record.day, holidays, perWeek)
      : dayQuota(record.day, holidays, perWeek),
    worked,
    onLeave,
  };
}

/** What this person's week is, falling back to the property's answer. */
/** The months this person has been given a figure for, ready to divide. */
export function calendarFor(ds, staffId) {
  return monthCalendar(ds?.calendarBy?.get(staffId) ?? new Map(), daysInMonth);
}

/**
 * The most days in a week this person may be rostered.
 *
 * The same figure as their contracted week: one number rather than two, which
 * is what the property asked for. It is worth knowing that it is also the
 * divisor behind their day rate, so raising somebody to a six-day week to let
 * the rota use them changes what a day of theirs is worth on a payslip.
 */
export function maxDaysPerWeekFor(staff, settings = {}) {
  return Math.min(daysPerWeekFor(staff, settings), 7);
}

export function daysPerWeekFor(staff, settings = {}) {
  const own = Number(staff?.days_per_week);
  if (Number.isFinite(own) && own > 0) return own;
  const property = Number(settings.att_days_per_week);
  return Number.isFinite(property) && property > 0 ? property : DEFAULT_DAYS_PER_WEEK;
}

/**
 * Days owed, and days owing.
 *
 * `worked + on leave − working days in the period`, per day and then summed.
 *
 * It replaced a narrower rule that counted an extra day only past six hours on
 * an unrostered day, and a missed day only once a supervisor had ruled on it.
 * That was defensible and it was also unusable: a property that has never got
 * round to settling its absences read "square" every single month, which is
 * the one thing it was not. This asks a simpler question — how many days did
 * we get, against how many we expected — and answers it the same way whether
 * anybody has been round to settle anything.
 *
 * A day is worked when there is a clock-in *and* a clock-out, which includes
 * the times a supervisor supplied where the terminal missed them. A tap in with
 * no tap out is not a day worked; it is a day somebody still has to look at.
 */
/**
 * The months somebody has been given a figure for, ready to divide.
 *
 * `set` is a map of `YYYY-MM` to the number of days that month expected. What
 * comes back knows how to hand one day its share of it, which is what keeps
 * the arithmetic a sum over days: a month told it expected twenty-four gives
 * every one of its dates twenty-four thirty-firsts, and any handful of those
 * dates still comes to what the whole month would.
 *
 * A month with a figure of its own ignores public holidays, because whoever
 * typed the figure has already accounted for them — that is what typing it
 * means.
 */
export function monthCalendar(set, daysInMonth) {
  const byMonth = set instanceof Map ? set : new Map(Object.entries(set ?? {}));
  if (!byMonth.size) return null;

  return {
    has: (month) => byMonth.has(month),
    total: (month) => byMonth.get(month) ?? null,
    share(day) {
      const month = String(day).slice(0, 7);
      if (!byMonth.has(month)) return null;
      const held = daysInMonth(month);
      return held > 0 ? Number(byMonth.get(month)) / held : 0;
    },
  };
}

export function overUnder(records, {
  holidays = null, expected = true, perWeek = DEFAULT_DAYS_PER_WEEK, calendar = null,
} = {}) {
  const overs = [];
  const unders = [];
  let delivered = 0;
  let quota = 0;

  for (const record of records ?? []) {
    const led = dayLedger(record, { holidays, perWeek, calendar });
    delivered += led.owed;
    // `expected` is false for somebody the rota did not ask for at all in this
    // period — a new starter whose first week is next week, somebody who has
    // left, a casual with nothing booked. The month's working days are not a
    // debt they owe: they were never asked. Anything they *did* work still
    // counts, which is the right way round.
    quota += expected ? led.quota : 0;

    // The two lists behind the figure, and they answer a different question
    // from the arithmetic above. The sum is days delivered against days
    // expected, spread evenly across the week; these are the days a person
    // would point at — worked when nothing was asked, or asked for and not
    // worked. Listing every quiet Sunday as a "day missed" because it carries
    // five sevenths of an expectation would be arithmetically consistent and
    // completely useless to read.
    if (led.owed && !record.scheduled) {
      overs.push({
        day: record.day,
        minutes: record.worked_minutes || 0,
        why: led.onLeave ? 'On leave on a day off' : 'Worked a day the rota did not ask for',
      });
    }
    if (!led.owed && record.scheduled && expected) {
      unders.push({
        day: record.day,
        minutes: record.worked_minutes || 0,
        why: record.resolved_note || (record.first_in && !record.last_out
          ? 'Clocked in and never out'
          : 'Rostered, and nothing recorded'),
      });
    }
  }

  // Rounded once, to whole days, and the difference taken from the rounded
  // figure. Two reasons. Leave is charged in whole days, so a proposal of
  // "-1.4 days against their leave" is not a proposal anybody can act on. And
  // the columns have to reconcile on screen: Worked plus On leave less
  // Calendar must be exactly what the Over / under column says, or nobody
  // believes any of the five.
  //
  // The cost is that two halves of a period can each round to a whole day and
  // come to one more or one less than the whole would. That is a day at the
  // very worst, on a figure a person types over before it charges anything,
  // and it is a better trade than fractions in front of somebody arguing about
  // their leave.
  const expects = Math.round(quota);

  return {
    overs,
    unders,
    overDays: overs.length,
    underDays: unders.length,
    delivered,
    quota: expects,
    difference: delivered - expects,
  };
}

const ABSENT_STATUSES = new Set(['absent']);

// ---------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------

/**
 * Easter Sunday, by the Gregorian computus (Meeus/Jones/Butcher).
 *
 * Here because two of Ghana's public holidays hang off it and typing them in
 * every year is exactly the kind of chore that gets forgotten until the Friday
 * everybody is absent.
 */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const dayOfMonth = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
}

/** The first Friday of a month — how Ghana dates Farmers' Day. */
export function firstFriday(year, month) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  // dow() is Monday-based, so Friday is 4.
  return addDays(first, (4 - dow(first) + 7) % 7);
}

/**
 * Ghana's public holidays for a year, less the two that cannot be calculated.
 *
 * Eid al-Fitr and Eid al-Adha follow the lunar calendar and are confirmed
 * locally a few days ahead, so they are left to be typed in — offering a
 * computed date for them would be offering a guess that lands in a payroll.
 */
export function ghanaHolidays(year) {
  const easter = easterSunday(year);
  const list = [
    { day: `${year}-01-01`, name: "New Year's Day" },
    { day: `${year}-01-07`, name: 'Constitution Day' },
    { day: `${year}-03-06`, name: 'Independence Day' },
    { day: addDays(easter, -2), name: 'Good Friday' },
    { day: addDays(easter, 1), name: 'Easter Monday' },
    { day: `${year}-05-01`, name: 'May Day' },
    { day: `${year}-08-04`, name: "Founders' Day" },
    { day: `${year}-09-21`, name: 'Kwame Nkrumah Memorial Day' },
    { day: firstFriday(year, 12), name: "Farmers' Day" },
    { day: `${year}-12-25`, name: 'Christmas Day' },
    { day: `${year}-12-26`, name: 'Boxing Day' },
  ];
  return withObservedDays(list);
}

/**
 * Move weekend holidays to the next working day.
 *
 * Ghana observes a public holiday falling on a Saturday or Sunday on the
 * following Monday. Christmas and Boxing Day are the pair that makes this
 * fiddly: when both fall at a weekend they cannot both be observed on the same
 * Monday, so each takes the next free weekday.
 */
export function withObservedDays(holidays) {
  const taken = new Set();
  const sorted = [...holidays].sort((a, b) => a.day.localeCompare(b.day));
  return sorted.map((holiday) => {
    let observed = holiday.day;
    while (dow(observed) >= 5 || taken.has(observed)) observed = addDays(observed, 1);
    taken.add(observed);
    return { ...holiday, observed_on: observed === holiday.day ? null : observed };
  });
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

/**
 * Everything the attendance reports read, indexed once.
 *
 * Loaded for a date range rather than wholesale: punches are the one table here
 * that grows without limit — a hundred staff tapping twice a day is seventy
 * thousand rows a year — and a report on last week has no business reading them
 * all.
 */
export async function loadDataset(db, { from, to, now } = {}) {
  const [staff, shifts, patterns, roster, punches, days, reasons, holidays, leave, settings, calendars] = await Promise.all([
    db.prepare('SELECT * FROM att_staff ORDER BY name').all(),
    db.prepare('SELECT * FROM att_shifts ORDER BY sort_order, name').all(),
    db.prepare('SELECT * FROM att_patterns').all(),
    from
      ? db.prepare('SELECT * FROM att_roster WHERE day BETWEEN ? AND ?').bind(from, to).all()
      : db.prepare('SELECT * FROM att_roster').all(),
    from
      // A day either side, so an overnight shift can reach the punches that
      // belong to it on the far side of midnight.
      ? db.prepare('SELECT * FROM att_punches WHERE day BETWEEN ? AND ? ORDER BY at_utc')
        .bind(addDays(from, -1), addDays(to, 1)).all()
      : db.prepare('SELECT * FROM att_punches ORDER BY at_utc').all(),
    from
      ? db.prepare('SELECT * FROM att_days WHERE day BETWEEN ? AND ?').bind(from, to).all()
      : db.prepare('SELECT * FROM att_days').all(),
    db.prepare('SELECT * FROM att_reasons ORDER BY sort_order, label').all(),
    db.prepare('SELECT * FROM att_holidays WHERE active = 1').all(),
    db.prepare("SELECT * FROM att_leave WHERE status IN ('pending','approved')").all(),
    db.prepare('SELECT key, value FROM settings').all(),
    // The months somebody has been told what they expected. Tiny — nothing at
    // all for a property that has never varied one — so it is read whole
    // rather than windowed.
    db.prepare('SELECT staff_id, month, days FROM att_calendar').all().catch(() => ({ results: [] })),
  ]);

  return makeDataset({
    now,
    staff: staff.results ?? [],
    shifts: shifts.results ?? [],
    patterns: patterns.results ?? [],
    roster: roster.results ?? [],
    punches: punches.results ?? [],
    days: days.results ?? [],
    reasons: reasons.results ?? [],
    holidays: holidays.results ?? [],
    leave: leave.results ?? [],
    settings: settings.results ?? [],
    calendars: calendars.results ?? [],
  });
}

export function makeDataset(raw) {
  const settings = Object.fromEntries((raw.settings ?? []).map((r) => [r.key, r.value]));
  const staff = raw.staff ?? [];
  const shifts = raw.shifts ?? [];

  const staffById = new Map(staff.map((s) => [s.id, s]));
  const staffByEmployeeNo = new Map(staff.map((s) => [String(s.employee_no), s]));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const reasonBy = new Map((raw.reasons ?? []).map((r) => [r.code, r]));

  // The rota, three ways.
  //
  // A person may hold two shifts on one day now — usually by mistake, and the
  // rota screen marks it as one — but a day still computes against one shift,
  // because a day record is one row and one verdict. So `rosterBy` hands back
  // the first shift of the day and everything downstream carries on exactly as
  // it did; `rosterAllBy` is for the screens that have to show the clash and
  // let somebody clear it.
  //
  // First means earliest by the clock. It is the one somebody turns up for,
  // and picking it by row id would mean the day changed meaning depending on
  // which shift was typed in first.
  const rosterAllBy = new Map();
  const slotsByDay = new Map();
  for (const row of raw.roster ?? []) {
    // A slot nobody is on yet. It belongs to the day, not to a person.
    if (row.staff_id == null) {
      if (!slotsByDay.has(row.day)) slotsByDay.set(row.day, []);
      slotsByDay.get(row.day).push(row);
      continue;
    }
    const key = `${row.staff_id}|${row.day}`;
    if (!rosterAllBy.has(key)) rosterAllBy.set(key, []);
    rosterAllBy.get(key).push(row);
  }

  const startsAt = (row) => {
    const at = row.shift_id ? toMinutes(shiftById.get(row.shift_id)?.starts_at) : null;
    // A rostered day off sorts last: it is not a shift anybody arrives for.
    return at == null ? 24 * 60 + 1 : at;
  };
  for (const list of rosterAllBy.values()) {
    list.sort((a, b) => startsAt(a) - startsAt(b) || Number(a.id ?? 0) - Number(b.id ?? 0));
  }
  for (const list of slotsByDay.values()) {
    list.sort((a, b) => startsAt(a) - startsAt(b) || Number(a.id ?? 0) - Number(b.id ?? 0));
  }

  const rosterBy = new Map([...rosterAllBy].map(([key, list]) => [key, list[0]]));
  // Keyed by week as well as weekday. A person who does not rotate has one
  // week, numbered zero, and behaves exactly as before.
  const patternBy = new Map((raw.patterns ?? []).map((p) => [`${p.staff_id}|${p.week ?? 0}|${p.dow}`, p]));
  // Who has a standing pattern at all, which is a different question from what
  // it says on a given day. A pattern that lists Monday to Friday has no row
  // for Saturday, and that silence is an answer: they do not work Saturdays.
  // Somebody with no pattern whatsoever is the only person the app genuinely
  // knows nothing about, and the only one whose future leave has to be guessed.
  const patternStaff = new Set((raw.patterns ?? []).map((p) => p.staff_id));
  const holidayBy = new Map((raw.holidays ?? []).map((h) => [h.observed_on || h.day, h]));

  // Months somebody has been told what they expected, per person. Almost
  // always empty: the ordinary rule answers for nearly every month, and this
  // holds only the ones it did not.
  const calendarBy = new Map();
  for (const row of raw.calendars ?? []) {
    if (!calendarBy.has(row.staff_id)) calendarBy.set(row.staff_id, new Map());
    calendarBy.get(row.staff_id).set(row.month, Number(row.days));
  }
  const dayBy = new Map((raw.days ?? []).map((d) => [`${d.staff_id}|${d.day}`, d]));

  // Punches, per person, pre-converted to absolute minutes and sorted. Every
  // shift computation below is arithmetic on `abs`, so doing the parsing here
  // means doing it once rather than once per candidate shift.
  const punchesByStaff = new Map();
  for (const punch of raw.punches ?? []) {
    if (!punch.staff_id) continue;
    const time = String(punch.at_local).slice(11, 16);
    const day = String(punch.at_local).slice(0, 10);
    const entry = { ...punch, abs: absMinutes(day, time) };
    if (entry.abs == null) continue;
    if (!punchesByStaff.has(punch.staff_id)) punchesByStaff.set(punch.staff_id, []);
    punchesByStaff.get(punch.staff_id).push(entry);
  }
  for (const list of punchesByStaff.values()) list.sort((a, b) => a.abs - b.abs);

  // Approved leave, expanded to a lookup per person per day. Ranges are short
  // and few; expanding is cheaper than scanning them for every day of a report.
  const leaveBy = new Map();
  const requestsByStaff = new Map();
  for (const request of raw.leave ?? []) {
    if (!requestsByStaff.has(request.staff_id)) requestsByStaff.set(request.staff_id, []);
    requestsByStaff.get(request.staff_id).push(request);
    if (request.status !== 'approved') continue;
    for (const day of rangeDays(request.from_day, request.to_day)) {
      leaveBy.set(`${request.staff_id}|${day}`, request);
    }
  }

  return {
    settings,
    timezone: settings.timezone || 'UTC',
    rosterAllBy,
    slotsByDay,
    patternStaff,
    rotationAnchor: settings.att_rotation_anchor || ROTATION_ANCHOR,
    // 'YYYY-MM-DD HH:MM' in the property's own time. Its only job is to stop
    // today's later shifts being read as absences before they have begun, and
    // that is true on every screen, so it is taken from the clock here rather
    // than left to each caller to remember. A caller that wants time frozen
    // still passes its own.
    now: raw.now === undefined ? nowIn(settings.timezone || 'UTC') : raw.now,
    staff,
    shifts,
    reasons: raw.reasons ?? [],
    holidays: raw.holidays ?? [],
    staffById,
    staffByEmployeeNo,
    shiftById,
    reasonBy,
    rosterBy,
    patternBy,
    holidayBy,
    calendarBy,
    dayBy,
    punchesByStaff,
    leaveBy,
    requestsByStaff,
    policy: {
      missingPunch: settings.att_missing_punch || 'incomplete',
      minGap: Number(settings.att_min_gap_minutes ?? 2),
      windowBefore: Number(settings.att_window_before ?? 180),
      windowAfter: Number(settings.att_window_after ?? 240),
      escalateAfter: Number(settings.att_escalate_after ?? 3),
    },
  };
}

/**
 * Rebuild one person's days across a range, from the punches up.
 *
 * This is the function the ingest calls after new punches land and the reports
 * call when they find a day that was never computed. It is deliberately
 * idempotent and deliberately whole-range: computing a day in isolation cannot
 * see that the punch at 00:40 belongs to yesterday's night shift.
 */
export function computeRange(ds, staffId, from, to) {
  const staff = ds.staffById.get(staffId);
  if (!staff) return [];

  const days = rangeDays(from, to);
  const punches = collapsePunches(ds.punchesByStaff.get(staffId) ?? [], ds.policy.minGap);

  // The clock, when the dataset was given one. Only today's shifts can be
  // ahead of it, so every earlier day computes exactly as it always has.
  const nowAbs = ds.now ? absMinutes(ds.now.slice(0, 10), ds.now.slice(11, 16)) : null;

  // Build every candidate window first — including the day before the range, so
  // a night shift starting on the 31st can claim a punch at 02:00 on the 1st.
  const windows = [];
  for (const day of [addDays(from, -1), ...days]) {
    const schedule = scheduleFor(ds, staffId, day);
    if (!schedule.shift) continue;
    const window = shiftWindow(schedule.shift, day);
    if (!window) continue;
    windows.push({
      day,
      shift: schedule.shift,
      ...window,
      from: window.start - ds.policy.windowBefore,
      to: window.end + ds.policy.windowAfter,
      punches: [],
    });
  }

  // Punches with no window fall back to their own calendar day, which is what
  // makes an unscheduled day visible instead of silently dropping the evidence
  // that somebody came in.
  const loose = new Map();
  for (const punch of punches) {
    const claimed = claimPunch(punch, windows);
    if (claimed) { claimed.punches.push(punch); continue; }
    const day = String(punch.at_local).slice(0, 10);
    if (!loose.has(day)) loose.set(day, []);
    loose.get(day).push(punch);
  }

  const windowByDay = new Map(windows.map((w) => [w.day, w]));
  const out = [];

  for (const day of days) {
    const schedule = scheduleFor(ds, staffId, day);
    const window = windowByDay.get(day);
    const existing = ds.dayBy.get(`${staffId}|${day}`);

    const record = computeDay({
      staff,
      day,
      schedule,
      punches: window ? window.punches : loose.get(day) ?? [],
      holiday: ds.holidayBy.get(day) ?? null,
      leave: ds.leaveBy.get(`${staffId}|${day}`) ?? null,
      // A supervisor's ruling survives recomputation. Punches arriving later
      // must not quietly overturn a decision somebody signed their name to.
      //
      // A corrected clock time survives too, but on its own it carries no
      // reason and so no ruling: the day is recomputed from the corrected
      // times rather than frozen at whatever it was called when they were
      // typed in. That is the difference between "they left at 21:00" and
      // "this day is present", and only the second one is a decision.
      override: existing?.resolution === 'resolved'
        ? {
          reason_code: existing.reason_code,
          status: existing.status,
          reasonKind: ds.reasonBy.get(existing.reason_code)?.kind,
          corrected_in: existing.corrected_in ?? null,
          corrected_out: existing.corrected_out ?? null,
        }
        : (existing?.corrected_in || existing?.corrected_out)
          ? {
            reason_code: null,
            corrected_in: existing.corrected_in ?? null,
            corrected_out: existing.corrected_out ?? null,
          }
          : null,
      policy: { ...ds.policy, nowAbs },
    });

    out.push({
      ...record,
      corrected_in: existing?.corrected_in ?? null,
      corrected_out: existing?.corrected_out ?? null,
      resolved_by: existing?.resolved_by ?? null,
      resolved_at: existing?.resolved_at ?? null,
      resolved_note: existing?.resolved_note ?? null,
    });
  }

  // Notes last, because the tone of one depends on the days before it.
  const isAbsent = (r) => r && (r.status === 'absent' || r.reason_code === 'absent');
  const isLate = (r) => r && (r.status === 'late' || r.status === 'late_early');

  return out.map((record, index) => ({
    ...record,
    note: noteFor(record, {
      shift: record.shift_id ? ds.shiftById.get(record.shift_id) : null,
      streak: isAbsent(record)
        ? streakOf(out, index, isAbsent)
        : isLate(record) ? streakOf(out, index, isLate) : 0,
      weekCount: isLate(record) ? weekCountOf(out, index, isLate) : 0,
      reasons: ds.reasonBy,
    }),
  }));
}
