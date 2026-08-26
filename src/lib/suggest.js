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

import { addDays, dow, rangeDays, startOfWeek } from '../util/dates.js';
import {
  alternatesOf, altScope, alwaysOff, everyDays, maxDaysPerWeekFor, mayWork, onRota, runsOnDay,
  scheduleFor,
} from './attendance.js';
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

  // Every day each shift is already down to run, whoever is on it and whether
  // anybody is. Read once and added to as proposals are made, so a shift with
  // a day's break in between can see both what the rota says and what this
  // draft has just decided.
  const ran = new Set();
  for (const list of ds.rosterAllBy?.values() ?? []) {
    for (const row of list) if (row.shift_id) ran.add(`${row.day}|${row.shift_id}`);
  }
  for (const [slotDay, rows] of ds.slotsByDay ?? []) {
    for (const row of rows) if (row.shift_id) ran.add(`${slotDay}|${row.shift_id}`);
  }

  const entries = [];
  const gaps = [];
  // Shifts left alone because an alternative is already covering the day.
  // Reported rather than dropped: a planner who expected the late breakfast
  // and got the early one should be told which, not left comparing grids.
  const instead = [];
  let considered = 0;

  // Two passes over the whole window, not two passes over each day. A shift
  // that only runs when somebody is spare must not take a person on Monday who
  // is needed on Thursday, and it would if each day were finished in turn.
  //
  // Within a pass, the shifts nobody else can work go first. A shift belonging
  // to one person loses every race against a shift anybody can take: by the
  // time it is reached its one person has been given something else, and it
  // reads as unfillable when it was merely asked last.
  const tightestFirst = (list) => [
    ...list.filter((shift) => shift.only_staff_id != null),
    ...list.filter((shift) => shift.only_staff_id == null),
  ];

  const passes = [
    tightestFirst(shifts.filter((shift) => !shift.optional)),
    tightestFirst(shifts.filter((shift) => shift.optional)),
  ].filter((list) => list.length);

  for (const pass of passes) {
    for (const day of days) {
      const weekday = dow(day);

      for (const shift of pass) {
        // A shift that does not run today is not short of anybody. The craft
        // shop being shut on Sunday is not a gap to be filled, and saying so
        // here keeps it out of both the proposals and the list of what could
        // not be covered.
        if (!runsOnDay(shift, day)) continue;

        // A day's break in between, counted both ways. Backwards catches what
        // this run has just proposed; forwards catches a day somebody already
        // pinned by hand, and without it a deep clean fixed for Tuesday would
        // still be offered the Monday beside it.
        if (tooClose(ran, shift, day)) continue;

        // One of a group of alternatives, and one only. Five breakfast shifts
        // that differ by half an hour are five ways of saying the same morning,
        // so once the day has settled on one the rest are not wanted at all.
        //
        // Over a day or over the week, depending what the group says. A pair
        // that each run once a week rule each other out for the whole week,
        // not merely for the Tuesday one of them happened to land on.
        const span = altScope(shift) === 'week'
          ? rangeDays(startOfWeek(day), addDays(startOfWeek(day), 6))
          : [day];
        const insteadOf = alternatesOf(shift, shifts)
          .find((other) => span.some((d) => ran.has(`${d}|${other.id}`)
            || running(ds, proposed, people, d, other.id)));
        if (insteadOf) {
          instead.push({ day, shiftId: shift.id, shift: shift.name, ranAs: insteadOf.name });
          continue;
        }

        // Four things can say how many people a shift wants, and the largest
        // of them wins. What the shift itself asks for is the plain answer; the
        // last few weeks are the fallback for a shift that has never said;
        // empty slots already sitting on the day are a request in their own
        // right, because somebody put three reception cards there on purpose;
        // and a shift on the rota at all wants at least somebody.
        //
        // THAT LAST ONE IS WHY EVERY SHIFT GETS CREATED. A shift with nothing
        // asked for, no history and no cards used to come out at nought and be
        // skipped in silence, which is how a shift added last week never
        // appeared on a draft. Being on the rota is itself the instruction.
        // What keeps this from covering the grid is the rest of the rules: the
        // days it runs, the gap in between, and the alternative already
        // covering the day.
        //
        // Optional is not an exception to it. Optional decides *when* a shift
        // is filled, not whether it is wanted: it waits for the second pass
        // and takes whoever is left, and going without is not a failure.
        const usual = wanted.get(`${shift.id}|${weekday}`) ?? 0;
        const asked = shift.needed == null ? null : Number(shift.needed);
        const openRows = (ds.slotsByDay?.get(day) ?? [])
          .filter((row) => Number(row.shift_id) === Number(shift.id));
        const open = openRows.length;

        const already = people.filter((p) => onThisShift(ds, proposed, p.id, day, shift.id)).length;
        const target = Math.max(asked == null ? usual : asked, already + open, 1);
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

        const place = (personId, note, breach = null) => {
          const slot = toFill.shift();
          const key = `${personId}|${day}`;
          const held = proposed.get(key) ?? [];
          entries.push({
            staffId: personId,
            day,
            shiftId: shift.id,
            rowId: slot ? Number(slot.id) : null,
            why: note,
            breach,
            // A day they are already down for: this goes beside what they
            // hold rather than over it, which is what the grid means by a
            // second shift and what Save has to be told.
            second: held.length > 0,
          });
          proposed.set(key, [...held, shift.id]);
          ran.add(`${day}|${shift.id}`);
          short -= 1;
        };

        for (const candidate of ranked) {
          if (short <= 0) break;
          place(candidate.person.id, candidate.habit
            ? `Usually works ${shift.name} on this day`
            : 'Free, and the lightest fortnight of anybody who is');
        }

        // NOBODY WAS FREE. Before this shift is written off, two more goes.
        //
        // The first costs nothing: somebody who could work it is already down
        // for something else today, and that something else has a spare pair
        // of hands nobody has used. Move them across. A greedy pass hands the
        // first shift of the day whoever is best and leaves the last with
        // nobody, and that is not the property being short: it is the order
        // the shifts happened to be asked in.
        while (short > 0) {
          const moved = shuffleSomebodyOut(
            { ds, proposed, people, day, shift, rules, availabilityBy, entries },
          );
          if (!moved) break;
          place(moved.staffId, `Moved off ${moved.from} so this is covered`);
        }

        // STILL EMPTY, AND IT IS NOT AN OPTIONAL SHIFT. The last resort: fill
        // it by going past a limit, and say out loud which one and what it
        // costs. Four of the limits are the Labour Act and the rest are the
        // property's own practice, so the practice ones are spent first and
        // the law only where there is nothing else left.
        //
        // Never silently. Every one of these arrives on the grid marked, is
        // counted in its own red block on the draft, and names the section it
        // goes against. The decision is the employer's to make and theirs to
        // see.
        //
        // ONE SHIFT A PERSON A DAY IS NOT ON THAT LIST AND WILL NOT BE.
        // Whatever the arithmetic says, asking somebody back the same day is
        // not a limit to be spent: a shift nobody is left for is reported
        // empty rather than covered by writing the same person down twice.
        if (short > 0 && !shift.optional) {
          const stretched = people
            .map((person) => ({
              person,
              verdict: canTake(ds, proposed, person, day, shift, rules, availabilityBy),
            }))
            // Never the same shift twice. A second shift in a day means a
            // different one; writing somebody down for this one again is not
            // covering it, it is counting it twice.
            .filter((c) => STRETCHABLE.has(c.verdict.rule))
            .sort((a, b) => cost(a.verdict.rule) - cost(b.verdict.rule)
              || loadOf(ds, proposed, a.person.id, day) - loadOf(ds, proposed, b.person.id, day)
              || String(a.person.name).localeCompare(String(b.person.name)));

          for (const candidate of stretched) {
            if (short <= 0) break;
            // Every rule this placement goes past, not merely the first one
            // that refused it. A sixth day in a row is often a sixth day in
            // the week as well, and reporting only whichever check ran first
            // means one of the two is never named at all.
            const broken = whatItBreaks(
              ds, proposed, candidate.person, day, shift, rules,
            );
            const worst = broken[broken.length - 1] ?? {
              rule: candidate.verdict.rule,
              label: candidate.verdict.rule,
              law: null,
              detail: candidate.verdict.why,
            };
            place(
              candidate.person.id,
              `Nobody was left, so ${candidate.verdict.why}`,
              { ...worst, all: broken },
            );
          }
        }

        if (short > 0) {
          // A shift that belongs to one person, on a day that person is off,
          // does not run. Nobody else can work it, so calling it a gap is
          // asking a planner to solve something with no solution, every week,
          // until they stop reading the list.
          const theirs = shift.only_staff_id == null
            ? null
            : (people.find((p) => Number(p.id) === Number(shift.only_staff_id))?.name
              ?? 'the person it belongs to');

          gaps.push({
            day,
            shiftId: shift.id,
            shift: shift.name,
            short,
            wanted: target,
            onlyPerson: theirs,
            // An optional shift nobody was spare for is not a gap, it is the
            // answer. Reported all the same, under its own heading, because
            // "nobody was free for the extra porter" is worth knowing.
            optional: Boolean(shift.optional),
            why: reasonNobodyIsFree(ds, proposed, people, day, shift, rules, availabilityBy),
          });
        }
      }
    }
  }

  return {
    entries,
    gaps,
    instead,
    // Every shift that could only be covered by going past a limit, so the
    // screen can say so once rather than the reader counting them.
    stretched: entries.filter((e) => e.breach),
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

/**
 * Every stretchable rule a placement would go past, mildest last-but-one and
 * the most serious at the end.
 *
 * `canTake` stops at the first refusal, which is right for deciding whether
 * somebody may work and wrong for saying what it costs. A sixth day in a row
 * is usually a sixth day in the week too, and a planner who is shown only one
 * of the two is being told half of it.
 */
function whatItBreaks(ds, proposed, person, day, shift, limits) {
  const found = [];
  const seen = new Map();

  // Run the checks one at a time by turning the others off, so each answers
  // for itself rather than for whichever happened to be tested first.
  for (const rule of STRETCHABLE) {
    const only = { ...limits };
    for (const other of STRETCHABLE) {
      if (other === rule) continue;
      // Most of these are ceilings and are switched off by raising them. Rest
      // between shifts is a floor: raising it would make every shift too close
      // to the last, which is the opposite of ignoring it.
      only[other] = {
        ...(limits[other] ?? {}),
        value: other === 'dailyRestHours' ? 0 : Number.MAX_SAFE_INTEGER,
      };
    }
    const verdict = canTake(ds, proposed, person, day, shift, only);
    if (verdict.rule === rule) seen.set(rule, verdict.why);
  }

  for (const [rule, detail] of seen) {
    const spec = limits[rule] ?? EXTRA_RULES[rule] ?? {};
    found.push({ rule, label: spec.label ?? rule, law: spec.law ?? null, detail });
  }

  return found.sort((a, b) => cost(a.rule) - cost(b.rule));
}

/**
 * The refusals that may be overridden to keep a shift covered, cheapest first.
 *
 * Everything not in here is a fact rather than a limit: somebody on leave is
 * not at work, somebody who never works Sundays does not work Sundays, and a
 * housekeeper is not a security guard. Overriding those would not be trying
 * harder, it would be writing down something untrue.
 */
const STRETCHABLE = new Set([
  'daysPerWeek', 'consecutiveDays', 'nightsPerFortnight', 'dailyRestHours', 'weeklyHours',
]);

/** What a rule is called and what it goes against, where the limits do not say. */
const EXTRA_RULES = {
  // The property's own answer, not the Act's. It has no section against it,
  // and saying so is the point: a planner reading the list should be able to
  // tell what they may decide from what they may not.
  daysPerWeek: { label: 'Days worked in a week', law: null },
};

/**
 * What breaking a rule costs, low first.
 *
 * The property's own practice before the Labour Act, and within the Act the
 * one that can be made good with a payment before the one that cannot. A sixth
 * day in a row is a conversation; twelve hours' rest is the law.
 */
function cost(rule) {
  return {
    // Spent first. It is the property's own rule rather than the Act's, and a
    // sixth day is the smallest thing on this list to ask of anybody.
    daysPerWeek: 0,
    consecutiveDays: 1,
    nightsPerFortnight: 2,
    weeklyHours: 3,
    dailyRestHours: 4,
  }[rule] ?? 9;
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
  if (staged !== undefined) return staged.includes(shiftId);
  return scheduleFor(ds, staffId, day).shift?.id === shiftId;
}

/**
 * Free somebody up for a shift nobody is left for.
 *
 * The one thing a greedy pass cannot see. Reception is asked first and takes
 * Kofi, who is the only person set up for the bar; the bar is asked last and
 * finds nobody. Reception had three other people who could have covered it,
 * so the property was never short: the shifts were merely asked in an unlucky
 * order.
 *
 * So: for each person who could work the shift standing empty, look at what
 * they are down for today and ask whether anybody else could take that
 * instead. If somebody can, the two are swapped and both shifts are covered.
 * Nothing here bends a rule — every move is checked by the same `canTake` as
 * a first choice — which is why it is tried before anything that does.
 *
 * One level deep on purpose. Chains of three and four swaps are hard to read
 * on a grid, and a planner who cannot see why the rota moved will not trust
 * the next one.
 */
function shuffleSomebodyOut({
  ds, proposed, people, day, shift, rules, availabilityBy, entries,
}) {
  for (const person of people) {
    // Only somebody the shift itself would take. Whatever is in their way, it
    // must be that they are already busy rather than that they are wrong for
    // the work or away.
    const verdict = canTake(ds, proposed, person, day, shift, rules, availabilityBy);
    if (verdict.ok || verdict.rule !== 'busy') continue;

    // What this run proposed for them today. A day that came from the rota or
    // a standing pattern is somebody's decision and is left alone; only this
    // draft's own choices are moved.
    const held = proposed.get(`${person.id}|${day}`) ?? [];
    if (held.length !== 1) continue;
    const holding = held[0];

    const mine = entries.find((e) => e.staffId === person.id && e.day === day);
    if (!mine) continue;

    // Somebody else to take what they were on.
    for (const other of people) {
      if (other.id === person.id) continue;
      const heldShift = { ...ds.shiftById?.get(holding) ?? {}, id: holding };
      const swap = canTake(ds, proposed, other, day, heldShift, rules, availabilityBy);
      if (!swap.ok) continue;

      // Do it: the stand-in takes the old shift, and the person is freed.
      mine.staffId = other.id;
      mine.why = `Covering for ${person.name}, who is needed on ${shift.name}`;
      proposed.set(`${other.id}|${day}`, [holding]);
      proposed.delete(`${person.id}|${day}`);

      const stillOk = canTake(ds, proposed, person, day, shift, rules, availabilityBy);
      if (stillOk.ok) {
        return { staffId: person.id, from: ds.shiftById?.get(holding)?.name ?? 'another shift' };
      }

      // Freeing them was not enough after all. Put it back exactly as it was
      // rather than leaving the grid half-swapped.
      mine.staffId = person.id;
      proposed.set(`${person.id}|${day}`, [holding]);
      proposed.delete(`${other.id}|${day}`);
      break;
    }
  }

  return null;
}

/**
 * Would putting this shift on this day break its day's-break-in-between rule?
 *
 * Looked at in both directions. A rule about the gap between two runnings is
 * symmetric, and checking only backwards let a day already pinned for Tuesday
 * sit next to a Monday the draft had just added.
 */
function tooClose(ran, shift, day) {
  const gap = everyDays(shift);
  if (gap <= 1) return false;
  for (let step = 1; step < gap; step++) {
    if (ran.has(`${addDays(day, -step)}|${shift.id}`)) return true;
    if (ran.has(`${addDays(day, step)}|${shift.id}`)) return true;
  }
  return false;
}

/**
 * Is this shift covered on this day at all: by somebody already down for it,
 * by a proposal made a moment ago, or by an empty card standing on the day?
 *
 * The empty card counts. A slot somebody put on Tuesday for the late breakfast
 * is the day saying which breakfast it wants, and the early one should not be
 * drafted alongside it just because nobody is standing on it yet.
 */
function running(ds, proposed, people, day, shiftId) {
  if (people.some((p) => onThisShift(ds, proposed, p.id, day, shiftId))) return true;
  return (ds.slotsByDay?.get(day) ?? [])
    .some((row) => Number(row.shift_id) === Number(shiftId));
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
  // Every refusal says which rule it was, not only how it reads. Some of them
  // can be stretched to fill a shift that would otherwise stand empty and some
  // of them cannot, and a sentence is no way to tell the two apart.
  const no = (rule, why) => ({ ok: false, rule, why });

  if (person.hired_on && day < person.hired_on) return no('hired', 'had not started');
  if (person.left_on && day > person.left_on) return no('left', 'has left');

  // A weekday they never work. Standing, so it needs no ✕ on the grid every
  // fortnight, and checked before anything about the shift because it rules
  // out the whole day rather than this shift on it.
  if (alwaysOff(person, day)) return no('weekday', 'never works this weekday');

  // Where somebody may be put on at all. Checked before anything about the
  // day, because it is not a fact about this Tuesday: it is a fact about them,
  // and no amount of being free makes a housekeeper right for Security.
  if (!mayWork(person, shift)) return no('department', `not set up for ${shift.department}`);

  if (ds.leaveBy?.get(`${person.id}|${day}`)) return no('leave', 'on leave');
  if (busyOn(ds, proposed, person.id, day)) return no('busy', 'already has that day');

  const avail = availabilityBy.get(`${person.id}|${day}`);
  if (avail && avail.status === 'unavailable') {
    // A window inside the day only rules out the shifts that overlap it.
    if (!avail.from_time || !avail.to_time) return no('availability', 'cannot work that day');
    if (overlaps(shift, avail.from_time, avail.to_time)) {
      return no('availability', `cannot work ${avail.from_time}–${avail.to_time}`);
    }
  }

  // The property's own limits, measured over the fortnight around the day so a
  // run that started last week is visible.
  const worked = withProposals(ds, proposed, person.id, addDays(day, -13), addDays(day, 6));
  const withThis = [...worked, madeUp(shift, day)].sort((a, b) => a.day.localeCompare(b.day));

  if (runEndingOn(withThis, day) > limits.consecutiveDays.value) {
    return no('consecutiveDays', `would be ${runEndingOn(withThis, day)} days in a row`);
  }
  if (tooCloseTogether(withThis, limits.dailyRestHours.value)) {
    return no('dailyRestHours', `under ${limits.dailyRestHours.value} hours' rest either side`);
  }
  if (hoursInWeekOf(withThis, day) > limits.weeklyHours.value) {
    return no('weeklyHours', `over ${limits.weeklyHours.value} hours that week`);
  }

  // Days in the week, as against hours in it. Five days of eight hours is
  // forty and passes the hours rule exactly, so a sixth day has to be refused
  // on its own terms or it never gets refused at all.
  //
  // Last of the four on purpose. Only one rule is reported per person, and it
  // should be the most serious one that applies: where a sixth day is also the
  // forty-first hour, the Act is what a planner needs to read, not the
  // property's own preference about days.
  const cap = maxDaysPerWeekFor(person, ds.settings ?? {});
  if (daysInWeekOf(withThis, day) > cap) {
    return no('daysPerWeek', `over ${cap} days that week`);
  }
  if (isNightShift(shift)
    && withThis.filter((w) => w.night).length > limits.nightsPerFortnight.value) {
    return no('nightsPerFortnight', `over ${limits.nightsPerFortnight.value} nights in the fortnight`);
  }

  return { ok: true, rule: null, why: null };
}

/** What they are down to work, with anything proposed folded in. */
function withProposals(ds, proposed, staffId, from, to) {
  const real = shiftsInWindow(ds, staffId, from, to).filter((w) => !w.leave);
  const extra = [];
  for (const [key, shiftIds] of proposed) {
    const [who, day] = key.split('|');
    if (String(who) !== String(staffId)) continue;
    if (day < from || day > to) continue;
    // Every shift proposed for that day, not the first. A second one taken on
    // to keep a shift covered is hours worked, and the limits have to see it
    // or the next decision is made on a false total.
    for (const shiftId of shiftIds) {
      const shift = ds.shiftById?.get(shiftId);
      if (shift) extra.push(madeUp(shift, day));
    }
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

/**
 * Days worked in the Monday-to-Sunday week around a date.
 *
 * Days, not shifts. Somebody with two shifts on one Tuesday has worked one
 * day, however the hours add up, and counting it as two would refuse them a
 * Wednesday they are perfectly free for.
 */
function daysInWeekOf(worked, day) {
  const monday = addDays(day, -dow(day));
  const sunday = addDays(monday, 6);
  return new Set(
    worked.filter((w) => w.day >= monday && w.day <= sunday).map((w) => w.day),
  ).size;
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

  // Where the department itself rules everybody out, the count is beside the
  // point: the answer is that nobody is set up for this work, and a planner
  // fixes that under Setup rather than by moving days around.
  const shut = `not set up for ${shift.department}`;
  if (counts.get(shut) === people.length) {
    return `nobody is set up to work in ${shift.department}`;
  }

  return ranked.slice(0, 2).map(([why, n]) => `${n} ${why}`).join(', ');
}
