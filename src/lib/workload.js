import { addDays, diffDays, dow, rangeDays } from '../util/dates.js';
import { absMinutes, calendarFor, daysPerWeekFor, scheduleFor, shiftWindow } from './attendance.js';

/**
 * How somebody is being worked, and whether it is sustainable.
 *
 * The rota screen answers "is anybody on Security on Sunday". It cannot answer
 * "has Kofi had a day off this fortnight", and that is the question that ends
 * with somebody handing in their notice. This does.
 *
 * Everything here is derived from the plan — the roster and the standing
 * patterns — because the point is to see it before it happens. Where the
 * record disagrees with the plan (somebody covered a shift nobody rostered)
 * the record wins, since that is what the body actually did.
 *
 * THE FLOOR IS THE LAW, NOT AN OPINION. Ghana's Labour Act 2003 (Act 651) sets
 * eight hours a day and forty a week (s.33, stretching to nine on a day where
 * another day is shorter, s.34), twelve consecutive hours of rest between
 * working days, and forty-eight consecutive hours of rest in every seven.
 * Those are the defaults, they are cited by section wherever they are shown,
 * and a property can tighten them but the app will always say when a rota goes
 * under them.
 *
 * NOTHING HERE BLOCKS ANYTHING. A hotel has nights when somebody has to cover,
 * and an app that refuses to record what actually happened just gets worked
 * around on paper. It says so loudly, names the rule, and leaves the decision
 * with the person whose name is on it.
 */

// --------------------------------------------------------------------------
// What "healthy" means here
// --------------------------------------------------------------------------

/**
 * The statutory floor, and the practice thresholds on top of it.
 *
 * Split deliberately. The first four are law and carry a section; the rest are
 * this trade's rules of thumb, which a property should be able to argue with.
 */
export const LIMITS = {
  // Act 651
  dailyRestHours: { value: 12, law: 'Act 651 s.35', label: 'Rest between shifts' },
  weeklyRestHours: { value: 48, law: 'Act 651 s.36', label: 'Unbroken rest each week' },
  weeklyHours: { value: 40, law: 'Act 651 s.33', label: 'Hours in a week' },
  dailyHours: { value: 9, law: 'Act 651 ss.33–34', label: 'Hours in a day' },

  // Practice
  consecutiveDays: { value: 6, label: 'Days in a row without one off' },
  nightsPerFortnight: { value: 7, label: 'Night shifts in a fortnight' },
  flipsPerFortnight: { value: 2, label: 'Swaps between nights and days' },
  weekendsPerMonth: { value: 3, label: 'Weekends worked in a month' },
  // A Sunday off is the one most people here plan the rest of their life
  // around, and it is the first thing a six-day rota quietly takes. Zero turns
  // the check off for a property that does not work that way.
  sundaysOffPerMonth: { value: 1, label: 'Sundays off in a month', zeroable: true },
  // A different question from the one above, and an earlier one. "Has anybody
  // been left without a Sunday at all" only fires once somebody has worked
  // every one of them, which is a month too late to do anything about. This
  // asks how many Sundays somebody may work before it is worth saying, so the
  // rota can say it while the rota can still be changed.
  sundaysWorkedPerMonth: { value: 2, label: 'Sundays worked in a month', zeroable: true },
};

/** Whatever the property has set, over the top of the defaults. */
export function limitsFrom(settings = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(LIMITS)) {
    const stored = Number(settings[`wl_${key}`]);
    // Zero is a real answer for the rules that can be switched off, and a
    // typing mistake for the ones that cannot: nobody means "no hours in a
    // week".
    const usable = Number.isFinite(stored) && (stored > 0 || (spec.zeroable && stored === 0));
    out[key] = {
      ...spec,
      value: usable ? stored : spec.value,
      changed: usable && stored !== spec.value,
    };
  }
  return out;
}

// --------------------------------------------------------------------------
// The shifts one person is down to work
// --------------------------------------------------------------------------

/**
 * A shift counts as a night when it runs through the small hours.
 *
 * Midnight to five is the window that costs sleep, and a shift touching any of
 * it is one the body treats as a night whatever it is called on the rota. Read
 * from the clock rather than from a flag somebody has to remember to set.
 */
const NIGHT_FROM = 0;        // midnight
const NIGHT_TO = 5 * 60;     // five in the morning

/** Monday is 0 here, so Sunday is 6. Four Sundays is what a month is worth. */
const SUNDAY = 6;
const SUNDAYS_IN_A_MONTH = 4;

/** Sunday, in the same numbering the rest of the app counts weekdays in. */
export const SUNDAY_DOW = SUNDAY;

/**
 * How many Sundays off a stretch of `count` Sundays is owed.
 *
 * The house rule is written per month, so a shorter stretch gets its share of
 * it and a week owes nothing. That is the right answer for a report on a week,
 * and the reason anything asking "has this person had their Sunday" has to ask
 * it a calendar month at a time rather than over whatever period is on screen.
 */
export function sundaysOwedOff(count, limits = LIMITS) {
  const rule = Number(limits?.sundaysOffPerMonth?.value ?? 0);
  if (!(rule > 0)) return 0;
  return Math.floor((count / SUNDAYS_IN_A_MONTH) * rule);
}

/**
 * How many Sundays somebody may work in a month before it is worth saying.
 *
 * Not pro-rated, because it is already written per month and the rota asks it
 * a month at a time. Zero switches the mark off for a property where Sunday is
 * a day like any other.
 */
export function sundaysWorkedCap(limits = LIMITS) {
  const rule = Number(limits?.sundaysWorkedPerMonth?.value ?? 0);
  return rule > 0 ? rule : 0;
}

export function isNightShift(shift) {
  const probe = '2000-01-03';
  const w = shiftWindow(shift, probe);
  if (!w) return false;

  // Relative to the shift's own midnight, so a 22:00–06:15 shift reads as
  // 1320 → 1815 and a 06:00–14:00 one as 360 → 840.
  const base = absMinutes(probe, '00:00');
  const start = w.start - base;
  const end = w.end - base;

  // The small hours of its own day, and the small hours of the next for
  // anything that runs over midnight.
  const touches = (a, b) => start < b && end > a;
  return touches(NIGHT_FROM, NIGHT_TO) || touches(1440 + NIGHT_FROM, 1440 + NIGHT_TO);
}

/**
 * Every stretch of work in the window, in order, as absolute minutes.
 *
 * One entry per day somebody is down to work — from the roster, from their
 * standing pattern, or from a day they actually worked that nobody planned.
 * Leave and public holidays are not work, and a day on leave is rest.
 */
export function shiftsInWindow(ds, staffId, from, to) {
  const out = [];
  // A day either side, so a rest gap at the edge is measured against the shift
  // that actually sits next to it rather than against nothing.
  for (const day of rangeDays(addDays(from, -1), addDays(to, 1))) {
    const leave = ds.leaveBy?.get(`${staffId}|${day}`) ?? null;
    if (leave) { out.push({ day, leave: true, shift: null }); continue; }

    const schedule = scheduleFor(ds, staffId, day);
    const shift = schedule?.shift ?? null;
    if (!shift) continue;

    const window = shiftWindow(shift, day);
    if (!window) continue;

    out.push({
      day,
      shift,
      start: window.start,
      end: window.end,
      hours: Math.max(0, (window.end - window.start) - (shift.break_minutes ?? 0)) / 60,
      night: isNightShift(shift),
      weekend: dow(day) >= 5,
      holiday: Boolean(ds.holidayBy?.get(day)),
      source: schedule.source,
      leave: false,
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// The signals
// --------------------------------------------------------------------------

/** The longest run of days worked with no day off, and the run in progress. */
export function consecutiveRuns(worked, from, to) {
  const days = rangeDays(from, to);
  const on = new Set(worked.filter((w) => !w.leave).map((w) => w.day));

  let longest = 0;
  let current = 0;
  let longestEnd = null;

  for (const day of days) {
    if (on.has(day)) {
      current += 1;
      if (current > longest) { longest = current; longestEnd = day; }
    } else {
      current = 0;
    }
  }
  return { longest, longestEnd, current };
}

/**
 * Turnarounds shorter than the law allows between one shift and the next.
 *
 * Closing at ten and opening at six is eight hours between clocking out and
 * clocking in, of which maybe five are sleep once the journey home is counted.
 * It is the single most complained-about thing in shift work and the easiest
 * to build by accident.
 */
export function turnarounds(worked, limitHours) {
  const shifts = worked.filter((w) => !w.leave && w.shift).sort((a, b) => a.start - b.start);
  const short = [];

  for (let i = 1; i < shifts.length; i += 1) {
    const gapHours = (shifts[i].start - shifts[i - 1].end) / 60;
    if (gapHours < 0) continue;                    // overlapping cover, not a gap
    if (gapHours < limitHours) {
      short.push({
        from: shifts[i - 1].day,
        to: shifts[i].day,
        hours: Math.round(gapHours * 10) / 10,
        after: shifts[i - 1].shift.name,
        before: shifts[i].shift.name,
      });
    }
  }
  return short;
}

/**
 * The longest unbroken stretch off duty around every rolling seven days.
 *
 * The gaps are measured between actual shifts, not clipped at the edge of the
 * window being asked about. That distinction is the whole thing: an ordinary
 * Monday-to-Friday week gives 64 hours off from Friday afternoon to Monday
 * morning, and a window that happens to end on the Saturday would call the
 * same weekend 34 hours and report a property breaking the law every week of
 * its life. A warning that cries wolf on a normal rota is worse than no
 * warning, because it is the one people switch off.
 *
 * So: find every gap between consecutive shifts across the whole timeline,
 * then ask of each seven-day stretch which of those gaps it touches, and how
 * long the best of them was.
 */
export function weeklyRest(worked, from, to) {
  const shifts = worked.filter((w) => !w.leave && w.shift).sort((a, b) => a.start - b.start);

  // Every stretch of time nobody was at work, as [start, end) — including the
  // open ends. Somebody whose rota stops on Friday is resting from Friday, and
  // a gap that only counts when a later shift closes it would miss exactly the
  // people who have been taken off the rota altogether.
  const edgeFrom = absMinutes(addDays(from, -1), '00:00');
  const edgeTo = absMinutes(addDays(to, 2), '00:00');

  const gaps = [];
  let cursor = edgeFrom;
  for (const s of shifts) {
    if (s.start > cursor) gaps.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (edgeTo > cursor) gaps.push({ start: cursor, end: edgeTo });

  const weeks = [];
  for (let start = from; start <= addDays(to, -6); start = addDays(start, 1)) {
    const end = addDays(start, 6);
    const windowStart = absMinutes(start, '00:00');
    const windowEnd = windowStart + 7 * 1440;

    // Any rest that overlaps these seven days counts for them, however far
    // either side of the boundary it runs.
    let best = 0;
    for (const gap of gaps) {
      if (gap.end <= windowStart || gap.start >= windowEnd) continue;
      best = Math.max(best, gap.end - gap.start);
    }
    weeks.push({ from: start, to: end, hours: Math.round((best / 60) * 10) / 10 });
  }
  return weeks;
}

/** Hours per calendar week, and the days in each. */
export function weeklyLoad(worked) {
  const weeks = new Map();
  for (const w of worked) {
    if (w.leave || !w.shift) continue;
    // Weeks run Monday to Sunday, the way the rota is built.
    const monday = addDays(w.day, -dow(w.day));
    if (!weeks.has(monday)) weeks.set(monday, { week: monday, hours: 0, days: 0, nights: 0 });
    const week = weeks.get(monday);
    week.hours += w.hours;
    week.days += 1;
    if (w.night) week.nights += 1;
  }
  return [...weeks.values()]
    .map((w) => ({ ...w, hours: Math.round(w.hours * 10) / 10 }))
    .sort((a, b) => (a.week < b.week ? -1 : 1));
}

/**
 * How often somebody is turned around between nights and days.
 *
 * Harder on the body than the nights themselves: a settled night worker sleeps
 * badly and adapts, and somebody flipped twice a week never gets the chance.
 */
export function nightFlips(worked) {
  const shifts = worked.filter((w) => !w.leave && w.shift).sort((a, b) => a.start - b.start);
  let flips = 0;
  let last = null;
  for (const s of shifts) {
    if (last !== null && s.night !== last) flips += 1;
    last = s.night;
  }
  return flips;
}

// --------------------------------------------------------------------------
// One person, assessed
// --------------------------------------------------------------------------

/**
 * How heavily a finding weighs.
 *
 * "high" is a rule broken — the law's, or one the property set. "warn" is a
 * pattern worth a conversation before it becomes one. Nothing here is ever
 * "error": a rota is a plan a person made, and the app's job is to tell them
 * what is in it, not to tell them they are wrong.
 */
const HIGH = 'high';
const WARN = 'warn';

function finding(level, key, title, detail, law = null) {
  return { level, key, title, detail, law };
}

/**
 * Everything the plan says about one person over one window.
 *
 * Returns the raw figures as well as the findings, because a number somebody
 * can check is worth more than a verdict they have to take on trust — and the
 * first thing anybody does with a warning like this is ask where it came from.
 */
export function assessPerson(ds, staff, from, to, limits = limitsFrom(ds?.settings ?? {})) {
  const worked = shiftsInWindow(ds, staff.id, from, to);
  const inWindow = worked.filter((w) => w.day >= from && w.day <= to);
  const onDuty = inWindow.filter((w) => !w.leave && w.shift);

  const runs = consecutiveRuns(inWindow, from, to);
  const short = turnarounds(worked, limits.dailyRestHours.value);
  const rest = weeklyRest(worked, from, to);
  const weeks = weeklyLoad(inWindow);
  const flips = nightFlips(inWindow);

  const nights = onDuty.filter((w) => w.night).length;
  const weekends = onDuty.filter((w) => w.weekend).length;

  // Sundays, counted from the calendar rather than from the rota: the question
  // is how many of the Sundays that went past were theirs, so the ones nobody
  // put them down for are the whole point. A Sunday on leave is a Sunday at
  // home and counts as one they got.
  const sundays = rangeDays(from, to).filter((day) => dow(day) === SUNDAY);
  const sundaysWorked = onDuty.filter((w) => dow(w.day) === SUNDAY).length;
  const sundaysOff = sundays.length - sundaysWorked;
  const holidays = onDuty.filter((w) => w.holiday).length;
  const leaveDays = inWindow.filter((w) => w.leave).length;
  const hours = Math.round(onDuty.reduce((n, w) => n + w.hours, 0) * 10) / 10;
  const longDays = onDuty.filter((w) => w.hours > limits.dailyHours.value);

  // How many days the month expected of them, so "under-scheduled" is measured
  // against what was agreed rather than against whoever works hardest.
  const calendar = calendarFor(ds, staff.id);
  const perWeek = daysPerWeekFor(staff, ds?.settings ?? {});
  const span = diffDays(from, to) + 1;
  const expected = calendar?.total
    ? Math.round(calendar.total * (span / Math.max(1, calendar.days ?? span)))
    : Math.round((span / 7) * perWeek);

  const findings = [];

  // ---- the law -----------------------------------------------------------
  if (short.length) {
    const worst = short.reduce((a, b) => (a.hours <= b.hours ? a : b));
    findings.push(finding(HIGH, 'turnaround',
      `${short.length} turnaround${short.length === 1 ? '' : 's'} under ${limits.dailyRestHours.value} hours`,
      `Shortest is ${worst.hours} h — off after ${worst.after} on ${worst.from}, back on ${worst.before} the next day.`,
      limits.dailyRestHours.law));
  }

  // Every seven-day stretch, not every calendar week: the law asks for a
  // 48-hour break in *any* seven days, so a fortnight is eight overlapping
  // questions rather than two. Reported as the worst one, because eight counts
  // of the same run of shifts reads as eight problems.
  const thinWeeks = rest.filter((w) => w.hours < limits.weeklyRestHours.value);
  if (thinWeeks.length) {
    const worst = thinWeeks.reduce((a, b) => (a.hours <= b.hours ? a : b));
    const all = thinWeeks.length === rest.length;
    findings.push(finding(HIGH, 'weekly-rest',
      all
        ? `Never a ${limits.weeklyRestHours.value}-hour break in this whole period`
        : `${thinWeeks.length} seven-day stretch${thinWeeks.length === 1 ? '' : 'es'} with no `
          + `${limits.weeklyRestHours.value}-hour break`,
      `The longest unbroken rest is ${worst.hours} h, in the seven days from ${worst.from}.`,
      limits.weeklyRestHours.law));
  }

  const overWeeks = weeks.filter((w) => w.hours > limits.weeklyHours.value);
  if (overWeeks.length) {
    const worst = overWeeks.reduce((a, b) => (a.hours >= b.hours ? a : b));
    findings.push(finding(HIGH, 'weekly-hours',
      `${overWeeks.length} week${overWeeks.length === 1 ? '' : 's'} over ${limits.weeklyHours.value} hours`,
      `Heaviest is the week of ${worst.week} at ${worst.hours} h across ${worst.days} days.`,
      limits.weeklyHours.law));
  }

  if (longDays.length) {
    findings.push(finding(WARN, 'long-days',
      `${longDays.length} shift${longDays.length === 1 ? '' : 's'} longer than ${limits.dailyHours.value} hours`,
      `Longest is ${Math.round(Math.max(...longDays.map((d) => d.hours)) * 10) / 10} h.`,
      limits.dailyHours.law));
  }

  // ---- the practice ------------------------------------------------------
  if (runs.longest > limits.consecutiveDays.value) {
    findings.push(finding(HIGH, 'consecutive',
      `${runs.longest} days in a row without one off`,
      `Ending ${runs.longestEnd}. The house rule here is ${limits.consecutiveDays.value}.`));
  }

  if (nights > limits.nightsPerFortnight.value) {
    findings.push(finding(WARN, 'nights',
      `${nights} night shifts`,
      `More than the ${limits.nightsPerFortnight.value} this property counts as a heavy fortnight.`));
  }

  // Pro-rated from the house rule, so it only has anything to say about a
  // window long enough to have an opinion: one Sunday a month over a fortnight
  // works out at none owed, and the check stays quiet.
  const sundaysOwed = sundaysOwedOff(sundays.length, limits);
  if (sundaysOwed > 0 && sundaysOff < sundaysOwed) {
    findings.push(finding(WARN, 'sundays',
      sundaysOff === 0
        ? `Worked every one of the ${sundays.length} Sundays`
        : `Only ${sundaysOff} Sunday${sundaysOff === 1 ? '' : 's'} off out of ${sundays.length}`,
      `The house rule is ${limits.sundaysOffPerMonth.value} a month, which comes to `
      + `${sundaysOwed} over this period.`));
  }

  if (flips > limits.flipsPerFortnight.value) {
    findings.push(finding(WARN, 'flips',
      `Turned around between nights and days ${flips} times`,
      'Flipping is harder on sleep than nights are. A settled run of nights costs less than '
      + 'the same nights scattered.'));
  }

  return {
    staff: {
      id: staff.id, name: staff.name, department: staff.department ?? null,
      employee_no: staff.employee_no ?? null,
    },
    from,
    to,
    figures: {
      daysOn: onDuty.length,
      expected,
      hours,
      nights,
      weekends,
      sundays: sundays.length,
      sundaysWorked,
      sundaysOff,
      holidays,
      leaveDays,
      flips,
      longestRun: runs.longest,
      openRun: runs.current,
      shortestTurnaround: short.length
        ? Math.min(...short.map((s) => s.hours))
        : null,
      leanestWeekRest: rest.length ? Math.min(...rest.map((w) => w.hours)) : null,
      heaviestWeek: weeks.length ? Math.max(...weeks.map((w) => w.hours)) : 0,
    },
    weeks,
    turnarounds: short,
    findings,
  };
}

// --------------------------------------------------------------------------
// The team, compared with itself
// --------------------------------------------------------------------------

/** The middle value, which a single heroic worker cannot drag around. */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One number for how hard a person is being worked.
 *
 * Zero is a quiet fortnight. Anything at or above 60 is somebody to look at
 * this week. It is a sum of what was actually found rather than a formula with
 * opinions buried in it, so every point on it can be pointed at: the findings
 * list beside it says where each one came from.
 */
export function strainScore(person, limits) {
  const f = person.figures;
  let score = 0;

  for (const found of person.findings) score += found.level === HIGH ? 25 : 10;

  // Load on top of rule-breaking, so two people who break nothing are still
  // ordered by how heavy their fortnight actually is.
  if (f.expected > 0) score += Math.max(0, (f.daysOn - f.expected)) * 6;
  if (f.leanestWeekRest != null) {
    score += Math.max(0, (limits.weeklyRestHours.value - f.leanestWeekRest) / 4);
  }
  score += Math.max(0, f.nights - 2) * 2;

  return Math.round(Math.min(100, score));
}

/**
 * Who is being left out, which is the other half of the same question.
 *
 * Rest is not automatically a kindness. Somebody rostered well under what was
 * agreed is being paid for days nobody scheduled; somebody who never gets a
 * weekend while their colleagues get every other one is being carried by them;
 * and leave that never gets taken is a bill the property is quietly running
 * up. All three read as "resting" on any screen that only counts overwork.
 */
export function restFindings(person, peers, limits, leave = null) {
  const f = person.figures;
  const out = [];

  // 1. Under what the month expected of them.
  if (f.expected > 0 && f.daysOn < f.expected - 1) {
    const short = f.expected - f.daysOn;
    out.push(finding(WARN, 'under-scheduled',
      `${short} day${short === 1 ? '' : 's'} fewer than expected`,
      `Down for ${f.daysOn} where the calendar says ${f.expected}.`));
  }

  // 2. A lighter share of the unsocial work than the people beside them.
  const sameDept = peers.filter((p) => (p.staff.department ?? '') === (person.staff.department ?? '')
    && p.staff.id !== person.staff.id);
  if (sameDept.length >= 2) {
    const midWeekends = median(sameDept.map((p) => p.figures.weekends));
    const midNights = median(sameDept.map((p) => p.figures.nights));

    if (midWeekends >= 2 && f.weekends * 2 <= midWeekends) {
      out.push(finding(WARN, 'few-weekends',
        `${f.weekends} weekend day${f.weekends === 1 ? '' : 's'} against ${midWeekends} for the rest of ${person.staff.department || 'the team'}`,
        'Somebody else is covering those.'));
    }
    if (midNights >= 2 && f.nights * 2 <= midNights) {
      out.push(finding(WARN, 'few-nights',
        `${f.nights} night${f.nights === 1 ? '' : 's'} against ${midNights} for the rest of ${person.staff.department || 'the team'}`,
        'Somebody else is covering those.'));
    }
  }

  // 3. Off the rota altogether for a stretch.
  if (f.daysOn === 0) {
    out.push(finding(WARN, 'off-the-rota',
      'Not on the rota at all in this period',
      'Either they are away and it is not recorded as leave, or they have been missed.'));
  }

  // 4. Leave stacking up unused — but only once it is late enough for that to
  //    mean something. In January everybody has their whole entitlement and
  //    saying so about all twenty-four of them is noise; in October the same
  //    fact is a person nobody can spare and a bill coming due.
  if (leave && Number(leave.available) > 0) {
    // What is still owed them, against what they had to spend. `remaining`
    // already has whatever they took or booked knocked off it, so a person who
    // has had their holiday does not appear here.
    const banked = Number(leave.remaining ?? leave.available);
    const entitlement = Number(leave.available) || 1;
    const throughYear = Number(leave.yearElapsed ?? 0);

    if (throughYear >= 0.6 && banked >= entitlement * 0.75) {
      out.push(finding(WARN, 'leave-unused',
        `${banked} days of leave still untaken`,
        `${Math.round(throughYear * 100)}% through the leave year with `
        + `${Math.round((banked / entitlement) * 100)}% of the entitlement banked. Usually it `
        + 'means nobody can be spared to release them.'));
    }
  }

  return out;
}
