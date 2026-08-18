// Days are 'YYYY-MM-DD' in the group's local timezone, parsed at UTC noon so
// that no offset can roll the date. Same rule as the attendance app, for the
// same reason: a punch at 23:50 in Accra must belong to the day it felt like.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function isDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayIn(timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every day from `from` to `to` inclusive. Capped so a typo cannot hang a run. */
export function daysBetween(from, to, cap = 800) {
  const out = [];
  let cursor = from;
  while (cursor <= to && out.length < cap) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** 1 = Monday .. 7 = Sunday. The week starts on Monday because the rota does. */
export function dow(day) {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export const dowLabel = (day) => DOW_LABELS[dow(day) - 1];

export const month = (day) => day.slice(0, 7);

/** ISO week, 'YYYY-Www'. Used for grouping, never for arithmetic. */
export function isoWeek(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const target = new Date(d.getTime());
  target.setUTCDate(target.getUTCDate() + 4 - dow(day));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The window a report is being asked for, defaulted and bounded.
 *
 * Defaults to the last 30 days ending yesterday. Yesterday rather than today
 * because today is always half-finished: a dashboard that includes it shows
 * every line falling every morning and rising every evening, and people learn
 * to ignore it.
 */
export function resolveRange(query, timezone = 'UTC', { days = 30 } = {}) {
  const today = todayIn(timezone);
  const to = isDay(query?.to) ? query.to : addDays(today, -1);
  const from = isDay(query?.from) ? query.from : addDays(to, -(days - 1));
  return from <= to ? { from, to } : { from: to, to: from };
}
