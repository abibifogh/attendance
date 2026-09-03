import { createNotice } from './notices.js';
import { computeRange, loadDataset, scheduleFor, toMinutes } from './attendance.js';
import { addDays, nowIn } from '../util/dates.js';

/**
 * The two alerts that save a shift rather than reporting on one.
 *
 * One at each end of it. Nobody arrived, and nobody tapped out on the way
 * home — the two ways a day ends up with a hole in it that somebody has to
 * fill in from memory a week later.
 *
 * THE START. Somebody is down for the early, the early started twenty minutes
 * ago, and the terminal has seen nothing. In a hotel that is almost always an
 * alarm that did not go off, and a phone buzzing at 06:20 gets somebody in for
 * 06:40 — where the same fact discovered at nine is a lost shift and a
 * conversation.
 *
 * It repeats every half hour until they clock in, because one notification at
 * 06:20 is one notification somebody asleep does not hear. The moment a
 * clock-in is recorded it stops, and it stops on its own when the shift they
 * were down for has ended: after that there is nothing left to arrive for, and
 * a phone still buzzing about it is not help, it is an accusation on a timer.
 *
 * TWO THINGS KEEP IT FROM BEING A NUISANCE, WHICH IS THE ONLY WAY A
 * NOTIFICATION SURVIVES ON A PHONE AT ALL.
 *
 *   It waits out the grace the shift already allows. A shift with fifteen
 *   minutes' grace is one where being twelve minutes late is not late, and
 *   saying otherwise would be the app disagreeing with its own rules.
 *
 *   It says a thing once per half hour and no more. The watcher runs every
 *   five minutes, and each half-hour slot is claimed in `att_nudge` before
 *   anything is sent, so a run that overlaps another cannot double up.
 *
 * THE END, and the one that costs the property quietly. Arriving feels like an
 * event, so people remember to tap. Leaving does not: the shift finishes,
 * somebody catches them on the way past the desk, and the tap never happens.
 * What is left is a day with one punch, held back rather than counted. So ten
 * minutes before the end, while they are still on the floor and still walking
 * past the terminal, their phone says it once.
 *
 * Neither records anything against the day. The terminal decides what
 * happened; these are messages and never evidence.
 */

/** How long before the end to remind somebody about the tap on the way out. */
const BEFORE_END_MINUTES = 10;

/** How long past the shift's own grace before it is worth saying anything. */
const AFTER_GRACE_MINUTES = 5;

/** And how often to say it again while they are still not here. */
const REPEAT_MINUTES = 30;

export async function watchShifts(db, { timezone = 'UTC', ctx = null } = {}) {
  const settings = await db.prepare('SELECT key, value FROM settings').all()
    .catch(() => ({ results: [] }));
  const on = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));
  const chaseLate = on.att_late_nudge !== '0';
  const remindOut = on.att_clockout_nudge !== '0';
  if (!chaseLate && !remindOut) {
    return { checked: 0, nudged: 0, reminded: 0, reason: 'switched off' };
  }

  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const minutesNow = toMinutes(clock) ?? 0;
  const yesterday = addDays(today, -1);

  // Only people with a login of their own: a push has nowhere to go otherwise,
  // and this is a message to the person rather than a report about them.
  const linked = await db.prepare(
    `SELECT u.id AS user_id, u.staff_id
       FROM users u
      WHERE u.active = 1 AND u.staff_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)`,
  ).all().catch(() => ({ results: [] }));

  const people = linked.results ?? [];
  if (!people.length) return { checked: 0, nudged: 0, reminded: 0, reason: 'nobody subscribed' };

  // Yesterday as well as today, for the shift that started at ten last night.
  // Its roster row is on the day it began, so at ten past midnight the only
  // place to find it is the day before.
  const [ds, punches] = await Promise.all([
    loadDataset(db, { from: yesterday, to: today }),
    // ANY TAP AT ALL, not only one the terminal labelled 'in'.
    //
    // `direction` is null whenever the device has no attendance mode
    // configured, which is the ordinary case on a plain access terminal — and
    // `direction != 'out'` is false for a null in SQL, not true. So somebody
    // who tapped at 06:04 on a terminal that does not label its events was
    // invisible here, and the app chased them every half hour all morning
    // telling them nothing had been recorded. Something had.
    //
    // The question this answers is "has anything been recorded for them
    // today", and the honest test for that is whether there is a punch.
    db.prepare(
      'SELECT DISTINCT staff_id, day FROM att_punches WHERE day IN (?1, ?2)',
    ).bind(yesterday, today).all().catch(() => ({ results: [] })),
  ]);

  const seen = new Set(
    (punches.results ?? []).map((r) => `${Number(r.staff_id)}|${r.day}`),
  );

  let checked = 0;
  let nudged = 0;
  let reminded = 0;

  for (const row of people) {
    const staffId = Number(row.staff_id);
    const staff = ds.staffById.get(staffId);
    if (!staff?.active) continue;

    // The shift they are inside right now, if any. Today's first, because
    // that is nearly always the answer; yesterday's only for one that is still
    // running past midnight.
    const found = runningShift(ds, staffId, today, minutesNow)
      ?? runningShift(ds, staffId, yesterday, minutesNow + 24 * 60);
    if (!found) continue;

    checked += 1;

    // A punch that landed on the calendar day either side of an overnight
    // shift still means they are here.
    const here = seen.has(`${staffId}|${found.day}`)
      || (found.day !== today && seen.has(`${staffId}|${today}`));

    if (here) {
      // They are in, and the shift is nearly over. The only thing left to say
      // is the thing they are about to forget.
      if (!remindOut) continue;
      if (found.minutesLeft > BEFORE_END_MINUTES) continue;

      // "Working" is the app's own word for clocked in with no clock-out yet,
      // and it is the right question here rather than "is there an out punch
      // anywhere today": somebody who tapped out for lunch and back in still
      // has the last tap to make.
      const [record] = computeRange(ds, staffId, found.day, found.day);
      if (record?.status !== 'working') continue;

      if (!await claim(db, staffId, found.day, 'leaving')) continue;

      await createNotice(db, {
        kind: 'attendance.clock_out_due',
        level: 'info',
        title: `Your ${found.shift.name} ends at ${found.shift.ends_at}`,
        body: 'Clock out at the terminal before you leave. A day with only one tap is held '
          + 'back rather than counted, and somebody has to work out afterwards what time you '
          + 'went home.',
        link: '#/att-me',
        day: found.day,
        actor: 'HIVE',
        userId: row.user_id,
        push: true,
        email: false,
      }, ctx);

      reminded += 1;
      continue;
    }

    if (!chaseLate) continue;

    const grace = Number(found.shift.grace_in_minutes ?? 0) + AFTER_GRACE_MINUTES;
    const overdue = found.minutesIn - grace;
    if (overdue < 0) continue;

    // Which half hour of being overdue this is. Claimed before anything is
    // sent, so two runs of the watcher cannot both send the same one.
    const slot = Math.floor(overdue / REPEAT_MINUTES);
    if (!await claim(db, staffId, found.day, `late:${slot}`)) continue;

    const late = Math.round(found.minutesIn);
    await createNotice(db, {
      kind: 'attendance.not_clocked_in',
      level: 'warn',
      title: slot === 0
        ? `Your ${found.shift.name} started at ${found.shift.starts_at}`
        : `Still nothing recorded — ${describe(late)} into your ${found.shift.name}`,
      body: 'Nothing has been recorded for you yet. If you are on your way, tell your '
        + 'manager so somebody can cover you in the meantime. Once you clock in this '
        + 'stops.',
      link: '#/att-me',
      day: found.day,
      actor: 'HIVE',
      // To them and nobody else. Their supervisor already has the morning list.
      userId: row.user_id,
      // A bell they will not see for hours is not the point of this one.
      push: true,
      email: false,
    }, ctx);

    nudged += 1;
  }

  return { checked, nudged, reminded, day: today };
}

/**
 * Say a thing once.
 *
 * Claimed before anything is sent, so two runs of the watcher that overlap
 * cannot both send the same message. The table's primary key is the whole
 * rule; this only reports whether the row was ours to write.
 */
async function claim(db, staffId, day, kind) {
  const done = await db.prepare(
    'INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, ?3)',
  ).bind(staffId, day, kind).run().catch(() => null);
  return Number(done?.meta?.changes ?? 0) > 0;
}

/**
 * The shift somebody is inside at this moment on a given day, if any.
 *
 * `minutesNow` is the local clock as minutes since midnight of `day`, so a
 * caller asking about yesterday passes today's clock plus a day. Returns how
 * far into the shift we are, which is the number every rule here is about.
 */
function runningShift(ds, staffId, day, minutesNow) {
  // On leave is not late, and neither is a rest day.
  if (ds.leaveBy?.get(`${staffId}|${day}`)) return null;

  const schedule = scheduleFor(ds, staffId, day);
  const shift = schedule.shift;
  if (!shift?.starts_at) return null;

  // A cell nobody has published is not something to be late for.
  if (schedule.source === 'roster' && !ds.rosterBy.get(`${staffId}|${day}`)?.published) return null;

  const start = toMinutes(shift.starts_at);
  const end = toMinutes(shift.ends_at);
  if (start == null || end == null) return null;

  // An overnight shift ends on the far side of midnight.
  const finish = end > start ? end : end + 24 * 60;
  const minutesIn = minutesNow - start;
  if (minutesIn < 0 || minutesNow >= finish) return null;

  return { day, shift, minutesIn, minutesLeft: finish - minutesNow };
}

/** "20 minutes", "an hour and a half" — as somebody would say it. */
function describe(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hh = hours === 1 ? 'an hour' : `${hours} hours`;
  if (rest < 8) return hh;
  if (rest > 52) return hours === 0 ? 'an hour' : `nearly ${hours + 1} hours`;
  return `${hh} and ${rest} minutes`;
}
