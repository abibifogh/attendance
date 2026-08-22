import { addDays, dow, startOfWeek } from '../util/dates.js';

/**
 * The weekly lunch list.
 *
 * The whole of the awkwardness in this feature is in the calendar, so it all
 * lives here where it can be tested against a fixed moment rather than against
 * whatever day the suite happens to run on.
 *
 * ONE LINK, FOREVER. The address on the noticeboard is made once and does not
 * change from week to week. What changes is whether it is taking answers, and
 * that runs off a standing weekly window: it opens at a time on a day and
 * shuts at a time on a day, the same two moments every week, without anybody
 * pressing anything.
 *
 * THE WEEK BEING ORDERED IS THE ONE BEGINNING WITH THE FIRST MONDAY AT OR
 * AFTER THE WINDOW SHUTS. Everybody inside one window therefore points at the
 * same Monday, which is what makes "the coming week" mean one thing to
 * everybody rather than shifting under them on Sunday night.
 *
 * SHUT IS A STATE WITH A TIME IN IT. A page that only says "come back later"
 * is a page somebody comes back to at the wrong time. It says when it opens,
 * to the hour, and which week that will be for.
 */

const MINUTES_IN_WEEK = 7 * 24 * 60;

/** 'HH:MM' to minutes since midnight, or null if it is not a time. */
export function readTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 24 || mm > 59) return null;
  // 24:00 is the end of a day, which is how somebody writes "midnight" when
  // they mean the far end rather than the near one.
  return Math.min(hh * 60 + mm, MINUTES_IN_WEEK);
}

export const showTime = (minutes) => {
  const m = Math.max(0, Math.min(24 * 60, Math.round(Number(minutes) || 0)));
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * When the list opens and shuts, out of the property's settings.
 *
 * Two moments in a week, each a day and a time. The default is the one the
 * property started with: open from the beginning of Thursday to the end of
 * Sunday.
 */
export function scheduleFrom(settings = {}) {
  const dayOf = (value, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 7 ? n : fallback;
  };
  const timeOf = (value, fallback) => {
    const t = readTime(value);
    return t == null ? fallback : t;
  };
  return {
    opensDow: dayOf(settings.lunch_opens_dow, 4),
    opensAt: timeOf(settings.lunch_opens_at, 0),
    closesDow: dayOf(settings.lunch_closes_dow, 1),
    closesAt: timeOf(settings.lunch_closes_at, 0),
  };
}

/** A day-of-week and a time, as one number of minutes into the week. */
const weekMinute = (day, minutes) => ((day - 1) * 24 * 60) + minutes;

/** Where a 'YYYY-MM-DD HH:MM' falls in its week, in minutes. */
function atOf(stamp) {
  const [date, time = '00:00'] = String(stamp ?? '').trim().split(/[ T]/);
  return {
    date,
    minutes: readTime(time) ?? 0,
    at: weekMinute(dow(date) + 1, readTime(time) ?? 0),
  };
}

/** A local 'YYYY-MM-DD HH:MM' n minutes on from another one. */
function plusMinutes(stamp, add) {
  const { date, minutes } = atOf(stamp);
  const total = minutes + add;
  const days = Math.floor(total / (24 * 60));
  const left = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  return `${addDays(date, days)} ${showTime(left)}`;
}

/**
 * Which week is being ordered, and whether the list is taking answers.
 *
 * `now` is 'YYYY-MM-DD HH:MM' in the property's own timezone. What comes back
 * describes the window in play: the one running now if it is open, otherwise
 * the one about to. A shut page can therefore still say when it opens and
 * which week that will be for, which is the only thing worth telling somebody
 * who has arrived too early.
 */
export function windowFor(now, schedule = {}) {
  const { opensDow, opensAt, closesDow, closesAt } = scheduleFrom({
    lunch_opens_dow: schedule.opensDow, lunch_opens_at: showTime(schedule.opensAt ?? 0),
    lunch_closes_dow: schedule.closesDow, lunch_closes_at: showTime(schedule.closesAt ?? 0),
  });

  // A date on its own means the beginning of that day, which is what a caller
  // with only a date in hand means by it.
  const stamp = /[ T]\d{1,2}:\d{2}/.test(String(now)) ? String(now) : `${now} 00:00`;
  const here = atOf(stamp);

  const opens = weekMinute(opensDow, opensAt);
  const closes = weekMinute(closesDow, closesAt);

  // Equal is a window with no end, which is how "open all week" is said.
  const allWeek = opens === closes;
  const wraps = closes < opens;
  const open = allWeek
    || (wraps ? (here.at >= opens || here.at < closes) : (here.at >= opens && here.at < closes));

  // How far from now to each edge, forwards round the week.
  const ahead = (target) => ((target - here.at) % MINUTES_IN_WEEK + MINUTES_IN_WEEK) % MINUTES_IN_WEEK;

  const closesOn = allWeek ? null : plusMinutes(stamp, ahead(closes) || MINUTES_IN_WEEK);
  const opensOn = open ? null : plusMinutes(stamp, ahead(opens) || MINUTES_IN_WEEK);

  // The week ordered for hangs off when this window shuts, so everybody inside
  // one window names the same Monday however long the window runs.
  const shutsAt = allWeek
    ? plusMinutes(stamp, ahead(weekMinute(1, 0)) || MINUTES_IN_WEEK)
    : (open ? closesOn : plusMinutes(opensOn, ((closes - opens) % MINUTES_IN_WEEK + MINUTES_IN_WEEK) % MINUTES_IN_WEEK || MINUTES_IN_WEEK));

  const monday = mondayAtOrAfter(shutsAt);

  return {
    open,
    monday,
    days: weekDays(monday),
    // The moment it opens, or the moment it shuts. Both carry the time,
    // because "Thursday" is not an answer to "when can I put my name down".
    opensOn,
    closesOn,
    // The date alone, for the screens that were written before there were
    // times in this and read better without one.
    opensDay: opensOn ? opensOn.slice(0, 10) : null,
    closesAfter: closesOn ? closesOn.slice(0, 10) : null,
    schedule: { opensDow, opensAt, closesDow, closesAt },
  };
}

/** The Monday of the week a moment belongs to, or the next one if it is later. */
function mondayAtOrAfter(stamp) {
  const { date, minutes } = atOf(stamp);
  if (dow(date) === 0 && minutes === 0) return date;
  return addDays(startOfWeek(date), 7);
}

/** Monday to Sunday, as dates. */
export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
      // The menu is a standing week, so it is looked up by which day of the
      // week this is rather than by the date.
      meal: menu.get(dow(day) + 1)?.meal ?? null,
      note: menu.get(dow(day) + 1)?.note ?? null,
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
      meal: menu.get(dow(day) + 1)?.meal ?? null,
      note: menu.get(dow(day) + 1)?.note ?? null,
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

/**
 * The standing week's meals, as seven rows in order.
 *
 * The same thing every Monday, the same thing every Tuesday. A kitchen sets
 * this once and it repeats, which is what a kitchen actually does: nobody
 * decides afresh every week what Wednesday is.
 */
export function menuWeek(rows = []) {
  const by = new Map(rows.map((r) => [Number(r.dow), r]));
  return DAY_NAMES.map((name, i) => {
    const found = by.get(i + 1);
    return {
      dow: i + 1,
      name,
      short: SHORT_DAYS[i],
      meal: found?.meal ?? null,
      note: found?.note ?? null,
    };
  });
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
