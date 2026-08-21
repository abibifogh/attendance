import { createNotice } from './notices.js';
import { loadDataset, scheduleFor, toMinutes } from './attendance.js';
import { nowIn } from '../util/dates.js';

/**
 * The one push that saves a shift rather than reporting on one.
 *
 * Somebody is down for the early, the early started twenty minutes ago, and
 * the terminal has seen nothing. In a hotel that is almost always an alarm
 * that did not go off, and a phone buzzing at 06:20 gets somebody in for 06:40
 * — where the same fact discovered at nine in the morning is a lost shift and
 * a conversation.
 *
 * THREE THINGS KEEP IT FROM BEING A NUISANCE, WHICH IS THE ONLY WAY A
 * NOTIFICATION SURVIVES.
 *
 *   It goes once. The watcher runs every quarter of an hour, and one row per
 *   person per day in `att_nudge` is what stops it saying the same thing four
 *   times an hour until somebody clocks in.
 *
 *   It waits out the grace the shift already allows. A shift with fifteen
 *   minutes' grace is a shift where being twelve minutes late is not late, and
 *   telling somebody off for it would be the app disagreeing with its own
 *   rules.
 *
 *   It gives up. Ninety minutes past the start, whatever happened has happened
 *   and this is not news to anybody. A push then is not help, it is an
 *   accusation delivered by telephone.
 *
 * It records nothing against the day. The terminal decides what happened;
 * this is a message and never evidence.
 */

/** How long past the shift's own grace before it is worth saying anything. */
const AFTER_GRACE_MINUTES = 5;

/** And how long past the start it stops being worth saying at all. */
const GIVE_UP_MINUTES = 90;

export async function watchShifts(db, { timezone = 'UTC', ctx = null } = {}) {
  const settings = await db.prepare('SELECT key, value FROM settings').all()
    .catch(() => ({ results: [] }));
  const on = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));
  if (on.att_late_nudge === '0') return { checked: 0, nudged: 0, reason: 'switched off' };

  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const minutesNow = toMinutes(clock) ?? 0;

  // Only people with a login of their own: a push has nowhere to go otherwise,
  // and this is a message to the person rather than a report about them.
  const linked = await db.prepare(
    `SELECT u.id AS user_id, u.staff_id
       FROM users u
      WHERE u.active = 1 AND u.staff_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)`,
  ).all().catch(() => ({ results: [] }));

  const people = linked.results ?? [];
  if (!people.length) return { checked: 0, nudged: 0, reason: 'nobody subscribed' };

  const [ds, punches, already] = await Promise.all([
    loadDataset(db, { from: today, to: today }),
    db.prepare(
      "SELECT DISTINCT staff_id FROM att_punches WHERE day = ? AND direction != 'out'",
    ).bind(today).all().catch(() => ({ results: [] })),
    db.prepare(
      "SELECT staff_id FROM att_nudge WHERE day = ? AND kind = 'late'",
    ).bind(today).all().catch(() => ({ results: [] })),
  ]);

  const clockedIn = new Set((punches.results ?? []).map((r) => Number(r.staff_id)));
  const told = new Set((already.results ?? []).map((r) => Number(r.staff_id)));

  let checked = 0;
  let nudged = 0;

  for (const row of people) {
    const staffId = Number(row.staff_id);
    if (told.has(staffId) || clockedIn.has(staffId)) continue;

    const staff = ds.staffById.get(staffId);
    if (!staff?.active) continue;

    // On leave is not late. Neither is a rest day, and neither is a shift
    // somebody has not published yet.
    if (ds.leaveBy.get(`${staffId}|${today}`)) continue;

    const schedule = scheduleFor(ds, staffId, today);
    const shift = schedule.shift;
    if (!shift?.starts_at) continue;
    if (schedule.source === 'roster'
      && !ds.rosterBy.get(`${staffId}|${today}`)?.published) continue;

    checked += 1;

    const start = toMinutes(shift.starts_at);
    if (start == null) continue;
    const late = minutesNow - start;
    const grace = Number(shift.grace_in_minutes ?? 0) + AFTER_GRACE_MINUTES;
    if (late < grace || late > GIVE_UP_MINUTES) continue;

    // Written before the push, so a send that half works cannot turn into the
    // same message every quarter of an hour for the rest of the morning.
    const claimed = await db.prepare(
      "INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?, ?, 'late')",
    ).bind(staffId, today).run().catch(() => null);
    if (!Number(claimed?.meta?.changes ?? 0)) continue;

    await createNotice(db, {
      kind: 'attendance.not_clocked_in',
      level: 'warn',
      title: `Your ${shift.name} started at ${shift.starts_at}`,
      body: 'Nothing has been recorded for you yet. If you are on your way, press '
        + '"I am running late" so the floor knows. If you have clocked in, this will '
        + 'sort itself out when the terminal catches up.',
      link: '#/att-me',
      day: today,
      actor: 'HIVE',
      // To them and nobody else. Their supervisor already has the morning list.
      userId: row.user_id,
      // A bell they will not see for hours is not the point of this one.
      push: true,
      email: false,
    }, ctx);

    nudged += 1;
  }

  return { checked, nudged, day: today };
}
