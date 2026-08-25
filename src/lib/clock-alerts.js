import { pushNotice } from './notify.js';
import { addDays, nowIn } from '../util/dates.js';

/**
 * Telling somebody their own clock-in landed.
 *
 * The terminal beeps and shows a name. That is all the feedback a member of
 * staff gets, and it answers none of the three questions they actually have:
 * what time went down, whether that counts as late, and — three weeks later at
 * sign-off, arguing about a Tuesday — whether it went down at all. A push to
 * their own phone at the moment it happens settles all three, and it settles
 * them in writing on a device they keep.
 *
 * WHAT IT IS NOT. It is not a report to a supervisor: the morning list already
 * does that, and a manager whose phone buzzes twenty-four times before eight
 * o'clock turns notifications off, taking the two that mattered with them. It
 * goes to the person who tapped and to nobody else.
 *
 * THREE THINGS KEEP IT HONEST.
 *
 *   It only speaks about a punch from the last hour. A terminal coming back
 *   from a day offline posts its whole backlog at once, and an import carries
 *   a year; neither is news.
 *
 *   It says a given clock-in once. The slot is claimed in `att_nudge` before
 *   anything is sent, so a poller re-offering an overlapping window, or two
 *   requests landing together, cannot double up.
 *
 *   It reads the day the app worked out rather than the punch. Whether a tap
 *   is an arrival or a departure is a question the pairing already answers,
 *   and answering it a second time here is how the notification ends up
 *   disagreeing with the record it is about.
 *
 * AND IT DOES NOT RING THE BELL. A push, and no row in the notice list. Two of
 * these a day for two dozen people is fourteen hundred rows a month, and the
 * bell holds the newest twenty: one property's clock-ins would bury every
 * notice that actually wants a decision. My shifts already shows somebody
 * their own clock-in, in the place they would go looking for it.
 */

/**
 * How recent a punch has to be to be worth telling somebody about.
 *
 * An hour, not the twenty-five minutes it was. The on-site poller reads the
 * terminal on its own schedule and the property's internet is not always
 * there: a punch at 06:04 that reached the app at 06:40 is still news to the
 * person who made it, and going quiet about it looks exactly like the app
 * having missed the tap. Anything older than an hour is a backlog rather than
 * a morning, and a phone that buzzes ninety times because the internet came
 * back is a phone whose owner never trusts it again.
 */
const FRESH_MINUTES = 60;

export async function notifyClockings(db, { punches, timezone = 'UTC' } = {}) {
  const rows = (punches ?? []).filter((p) => p && p.staff_id);
  if (!rows.length) return { sent: 0, reason: 'nothing new' };

  const settings = await db.prepare('SELECT key, value FROM settings').all()
    .catch(() => ({ results: [] }));
  const on = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));
  if (on.att_clock_push === '0') return { sent: 0, reason: 'switched off' };

  const now = nowIn(timezone);
  const recent = rows.filter((p) => minutesBetween(p.at_local, now) <= FRESH_MINUTES);
  if (!recent.length) return { sent: 0, reason: 'nothing recent enough' };

  // Only people with a login of their own and a phone on it. This is a message
  // to a person, not a record, so with nowhere to send it there is nothing to
  // do.
  const ids = [...new Set(recent.map((p) => Number(p.staff_id)))];
  const linked = await db.prepare(
    `SELECT u.id AS user_id, u.staff_id, s.name
       FROM users u JOIN att_staff s ON s.id = u.staff_id
      WHERE u.active = 1 AND s.active = 1
        AND u.staff_id IN (${ids.map(() => '?').join(',')})
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)`,
  ).bind(...ids).all().catch(() => ({ results: [] }));

  const userOf = new Map((linked.results ?? []).map((r) => [Number(r.staff_id), r]));
  if (!userOf.size) return { sent: 0, reason: 'nobody subscribed' };

  const said = [];
  for (const punch of recent) {
    const who = userOf.get(Number(punch.staff_id));
    if (!who) continue;

    const one = await sayIt(db, punch, who);
    if (one) said.push(one);
  }

  // What was said, so a caller can log it and a test can read it without
  // going near a push service.
  return { sent: said.length, said };
}

/**
 * One punch, and what the day it landed on now says about it.
 *
 * A punch carries a calendar day; a shift does not. Somebody clocking out of a
 * night shift at two in the morning taps on Tuesday against Monday's shift, so
 * both days are asked and whichever one claims the punch as its first arrival
 * or its last departure is the one that gets talked about.
 */
async function sayIt(db, punch, who) {
  const clock = String(punch.at_local).slice(11, 16);

  const days = await db.prepare(
    `SELECT d.*, s.name AS shift_name, s.starts_at, s.ends_at
       FROM att_days d LEFT JOIN att_shifts s ON s.id = d.shift_id
      WHERE d.staff_id = ?1 AND d.day IN (?2, ?3)`,
  ).bind(punch.staff_id, punch.day, addDays(punch.day, -1)).all().catch(() => ({ results: [] }));

  let record = null;
  let way = null;
  for (const row of days.results ?? []) {
    // Arrival first. A day with one punch on it has the same time in both
    // columns, and that punch is somebody arriving.
    if (row.first_in === clock) { record = row; way = 'in'; break; }
    if (row.last_out === clock) { record = row; way = 'out'; }
  }
  // A tap that is neither the first arrival nor the last departure is somebody
  // going for lunch and coming back. Their phone does not need to hear it.
  if (!record) return false;

  // Claimed before anything is sent, so the same clock-in cannot be announced
  // twice however many times the punch is re-offered.
  const claimed = await db.prepare(
    'INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, ?3)',
  ).bind(punch.staff_id, record.day, `clock:${way}:${clock}`).run().catch(() => null);
  if (!Number(claimed?.meta?.changes ?? 0)) return false;

  const said = way === 'in' ? wordsForIn(record, clock) : wordsForOut(record, clock);

  // Straight to the phone. No notice row, no email: see the note at the top
  // about what two of these a day would do to a shared list of twenty.
  const out = await pushNotice(db, {
    kind: `attendance.clock_${way}`,
    title: said.title,
    body: said.body,
    link: '#/att-me',
    day: record.day,
    // Theirs and nobody else's.
    userId: who.user_id,
  });

  return { way, userId: who.user_id, ...said, pushed: Number(out?.sent ?? 0) };
}

function wordsForIn(record, clock) {
  const late = Number(record.late_minutes) || 0;
  const shift = record.shift_name
    ? `${record.shift_name}, ${record.starts_at} to ${record.ends_at}.`
    : 'Nothing was on the rota for you today, so this is recorded as extra.';

  const how = late > 0
    ? `That is ${duration(late)} after your ${record.starts_at} start.`
    : record.starts_at && earlyBy(record.starts_at, clock) > 0
      ? `That is ${duration(earlyBy(record.starts_at, clock))} before your ${record.starts_at} start.`
      : record.starts_at ? 'Bang on time.' : '';

  return {
    title: `Clocked in at ${clock}`,
    body: `${shift} ${how}`.trim(),
  };
}

function wordsForOut(record, clock) {
  const early = Number(record.early_minutes) || 0;
  const worked = Number(record.worked_minutes) || 0;

  const how = early > 0
    ? `${duration(early)} before your ${record.ends_at} finish.`
    : record.ends_at ? `Your shift finished at ${record.ends_at}.` : '';

  return {
    title: `Clocked out at ${clock}`,
    body: [worked ? `${duration(worked)} recorded today.` : null, how].filter(Boolean).join(' '),
  };
}

/** "40 minutes", "1h 20m". Minutes up to an hour, because that is how it is said. */
function duration(minutes) {
  const m = Math.round(Math.abs(minutes));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h} hour${h === 1 ? '' : 's'}`;
}

const asMinutes = (clock) => {
  const [h, m] = String(clock).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** How far before the start they walked in, allowing for a night shift. */
function earlyBy(startsAt, clock) {
  const start = asMinutes(startsAt);
  const at = asMinutes(clock);
  if (start == null || at == null) return 0;
  const gap = start - at;
  // Half a day apart means the two are either side of midnight, and the
  // difference is not what somebody means by "early".
  return Math.abs(gap) > 12 * 60 ? 0 : Math.max(0, gap);
}

/** Minutes from a local 'YYYY-MM-DD HH:MM(:SS)' stamp to another. */
function minutesBetween(from, to) {
  const at = (text) => {
    const [day, time] = String(text ?? '').split(' ');
    const [y, mo, d] = String(day).split('-').map(Number);
    const [h, mi] = String(time ?? '00:00').split(':').map(Number);
    if (![y, mo, d].every(Number.isFinite)) return null;
    return Date.UTC(y, mo - 1, d, h || 0, mi || 0) / 60000;
  };
  const a = at(from);
  const b = at(to);
  if (a == null || b == null) return Infinity;
  return b - a;
}
