import { addDays, dow, startOfWeek } from '../util/dates.js';

/**
 * The weekly lunch list.
 *
 * The whole of the awkwardness in this feature is in the calendar, so it all
 * lives here where it can be tested against a fixed date rather than against
 * whatever day the suite happens to run on.
 *
 * THE WEEK BEING ORDERED IS ALWAYS THE NEXT ONE. The kitchen orders on a
 * Thursday for the week beginning the following Monday, and carries on taking
 * answers over the weekend. Thursday, Friday, Saturday and Sunday all point at
 * the same Monday, which is what makes "the coming week" mean one thing to
 * everybody rather than shifting under them on Sunday night.
 *
 * ORDERING IS SHUT THE REST OF THE TIME, and shut is a state with a date in
 * it: a page that only says "come back later" is a page somebody comes back to
 * at the wrong time. It says which day it opens and which week that will be
 * for.
 */

/** Monday to Sunday, as dates. */
export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The days of the week ordering is open on, as 1 (Monday) to 7 (Sunday). */
export function openDaysFrom(setting) {
  const wanted = String(setting ?? '4,5,6,7')
    .split(',')
    .map((part) => Number(String(part).trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return wanted.length ? [...new Set(wanted)].sort((a, b) => a - b) : [4, 5, 6, 7];
}

/**
 * Which week is being ordered, and whether the list is open for it.
 *
 * `today` is a date in the property's own timezone. The week returned is the
 * one the ordering window points at, open or shut, so a closed page can still
 * say what it will be for when it opens.
 */
export function windowFor(today, { openDays = [4, 5, 6, 7] } = {}) {
  const days = openDaysFrom(openDays.join ? openDays.join(',') : openDays);
  const weekday = dow(today) + 1; // 1 = Monday
  const open = days.includes(weekday);

  // The Monday after the one this week began on. From Thursday onwards that
  // is the week being cooked for; before then it is still the week that will
  // be, which is the right thing for a shut page to name.
  const nextMonday = addDays(startOfWeek(today), 7);

  return {
    open,
    monday: nextMonday,
    days: weekDays(nextMonday),
    // When it opens, and how long there is. Said as a date rather than as
    // "Thursday", because the person reading it wants to know whether that is
    // tomorrow.
    opensOn: open ? null : nextOpenDay(today, days),
    closesAfter: open ? lastOpenDay(today, days) : null,
  };
}

/** The next date on which ordering opens, from today forwards. */
function nextOpenDay(today, days) {
  for (let i = 1; i <= 7; i += 1) {
    const day = addDays(today, i);
    if (days.includes(dow(day) + 1)) return day;
  }
  return null;
}

/** The last date of the run of open days today belongs to. */
function lastOpenDay(today, days) {
  let last = today;
  for (let i = 1; i <= 7; i += 1) {
    const day = addDays(today, i);
    if (!days.includes(dow(day) + 1)) break;
    last = day;
  }
  return last;
}

/**
 * One person's page: the days they are on next week, and what is being served.
 *
 * Rostered days only. Asking somebody which days they want lunch invites an
 * answer about days they are not working, and the kitchen then cooks for a
 * person who is at home.
 */
export function daysFor({ week, rostered = [], menu = new Map(), answers = new Map() }) {
  const on = new Set(rostered);
  return week
    .filter((day) => on.has(day))
    .map((day) => ({
      day,
      name: DAY_NAMES[dow(day)],
      meal: menu.get(day)?.meal ?? null,
      note: menu.get(day)?.note ?? null,
      // Null is "has not said", which is not the same as no and is what the
      // chase list is built from.
      taking: answers.has(day) ? Boolean(answers.get(day)) : null,
    }));
}

/**
 * The week, as the kitchen reads it.
 *
 * Seven columns and a head count under each, because the count is the number
 * the order is placed on and everything else on the page is there to let
 * somebody check it.
 */
export function summarise({ week, menu = new Map(), orders = [], staff = [] }) {
  const byId = new Map(staff.map((s) => [Number(s.id), s]));

  const columns = week.map((day) => {
    const taking = orders
      .filter((o) => o.day === day && o.taking)
      .map((o) => byId.get(Number(o.staff_id)))
      .filter(Boolean)
      .sort((a, b) => first(a.name).localeCompare(first(b.name)) || a.name.localeCompare(b.name));

    return {
      day,
      name: DAY_NAMES[dow(day)],
      short: SHORT_DAYS[dow(day)],
      meal: menu.get(day)?.meal ?? null,
      note: menu.get(day)?.note ?? null,
      // First names, because that is what goes on a list pinned in a kitchen
      // and a surname adds nothing to a count of plates.
      names: taking.map((s) => first(s.name)),
      heads: taking.length,
      staffIds: taking.map((s) => Number(s.id)),
    };
  });

  return {
    monday: week[0],
    columns,
    // The whole week's plates. Not a count of people: somebody in five days is
    // five lunches, and it is lunches that get ordered.
    plates: columns.reduce((n, c) => n + c.heads, 0),
    busiest: columns.reduce((best, c) => (c.heads > (best?.heads ?? -1) ? c : best), null),
  };
}

/** The first name, which is what a kitchen list is written in. */
export const first = (name) => String(name ?? '').trim().split(/\s+/)[0] ?? '';

/**
 * Who has not answered for a day they are down to work.
 *
 * The one number worth chasing. A person who said no is dealt with; a person
 * who said nothing is the one the kitchen guesses about.
 */
export function unanswered({ week, rosteredBy = new Map(), orders = [], staff = [] }) {
  const said = new Set(orders.map((o) => `${o.staff_id}|${o.day}`));
  const out = [];

  for (const person of staff) {
    const days = (rosteredBy.get(Number(person.id)) ?? [])
      .filter((day) => week.includes(day) && !said.has(`${person.id}|${day}`));
    if (days.length) out.push({ id: Number(person.id), name: person.name, days });
  }

  return out.sort((a, b) => b.days.length - a.days.length || a.name.localeCompare(b.name));
}
