import { addDays, diffDays } from '../util/dates.js';

/**
 * How many people may be off on one day.
 *
 * A property can survive two or three people being away at once and cannot
 * survive eight, and nothing in the app knew that. Leave was answered one
 * request at a time, on whether that person could spare the days, with no
 * view of who else had already asked for the same Friday. The first anybody
 * heard about a Friday with nine people off was the Friday.
 *
 * So the ceiling is a rule the app holds rather than a thing somebody has to
 * remember, and it is a number the property sets rather than one built in.
 *
 * WHAT IT DOES NOT DO is override a person. A planner or a manager writing
 * leave or unavailability on somebody's behalf is not asking permission: they
 * can see the whole week and they are the ones who would have said yes. The
 * ceiling holds against requests coming the other way, which is where a person
 * cannot see who else has asked.
 */
export const AWAY_CAP_KEY = 'att_away_cap';
export const AWAY_CAP_DEFAULT = 3;

/** The ceiling this property has set, or the one it starts with. */
export async function awayCap(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(AWAY_CAP_KEY).first().catch(() => null);
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : AWAY_CAP_DEFAULT;
}

/** Every day from one to another, inclusive. */
export function daysBetween(from, to) {
  const out = [];
  for (let i = 0; i <= Math.max(0, diffDays(from, to)); i += 1) out.push(addDays(from, i));
  return out;
}

/**
 * Who is already down as away, day by day.
 *
 * Both kinds count, because both mean the same thing to whoever has to build
 * the week: this person will not be here. Leave that has been asked for counts
 * as much as leave that has been agreed, or the fourth, fifth and sixth
 * requests would all be accepted while the first three were still waiting and
 * the answer would come too late to matter.
 *
 * Turned down and taken back do not count, and neither does "would like to
 * work", which is somebody offering rather than somebody leaving.
 */
export async function whoIsAway(db, { from, to, exceptStaffId = null }) {
  const byDay = new Map();
  const add = (day, name) => {
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day).add(name);
  };

  const leave = await db.prepare(
    `SELECT l.staff_id, l.from_day, l.to_day, s.name
       FROM att_leave l JOIN att_staff s ON s.id = l.staff_id
      WHERE l.status IN ('pending', 'approved')
        AND l.from_day <= ?2 AND l.to_day >= ?1`,
  ).bind(from, to).all().catch(() => ({ results: [] }));

  for (const row of leave.results ?? []) {
    if (exceptStaffId != null && Number(row.staff_id) === Number(exceptStaffId)) continue;
    for (const day of daysBetween(row.from_day, row.to_day)) {
      if (day >= from && day <= to) add(day, row.name);
    }
  }

  const marked = await db.prepare(
    `SELECT a.staff_id, a.day, s.name
       FROM att_availability a JOIN att_staff s ON s.id = a.staff_id
      WHERE a.status = 'unavailable'
        AND a.decision IN ('waiting', 'approved')
        AND a.day BETWEEN ?1 AND ?2`,
  ).bind(from, to).all().catch(() => ({ results: [] }));

  for (const row of marked.results ?? []) {
    if (exceptStaffId != null && Number(row.staff_id) === Number(exceptStaffId)) continue;
    add(row.day, row.name);
  }

  return byDay;
}

/** The first of these days that is already full, if any of them is. */
export function firstDayFull(days, away, cap) {
  if (!Number.isFinite(cap)) return null;
  for (const day of [...days].sort()) {
    const names = [...(away.get(day) ?? [])];
    if (names.length >= cap) return { day, names: names.sort() };
  }
  return null;
}

/** A list of names, said the way a person would say it. */
export function listNames(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why this cannot be asked for, in words that say what to do next.
 *
 * The point of the sentence is that it is not about them. Being told "no" with
 * no reason reads as a judgement on the person asking; being told the day is
 * already full is a fact they can work with, and usually they move themselves
 * to the Thursday without anybody being involved.
 *
 * NO NAMES. This screen belongs to a member of staff, and the app does not
 * show one member of staff anybody else's rota: My shifts is their own week
 * and nobody else's, deliberately. Saying "Ama, Kofi and Yaw are off that day"
 * here would hand out exactly what the rest of the app withholds, and the
 * reason is complete without it. Whoever plans the rota can see the names,
 * because seeing the names is their job.
 */
export function dayFullMessage({ day }, cap, what = 'off') {
  const when = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  return `${cap === 1 ? 'Only one person' : `Only ${cap} people`} can be ${what} on any one `
    + `day, and ${when} is already full. Try another day, or speak to whoever plans the rota `
    + 'if it has to be that one.';
}
