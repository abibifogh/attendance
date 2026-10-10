import { createNotice } from './notices.js';
import { loadDataset, scheduleFor, toMinutes } from './attendance.js';
import { addDays, nowIn } from '../util/dates.js';
import { allows, effectivePermissions } from './permissions.js';
import { firstUsableEmail, isEmail } from './notify.js';
import { sayDate, sayHours, sayTime } from './email-design.js';

/**
 * Close your till: said twice, at the two moments it is still easy.
 *
 * TWENTY MINUTES BEFORE THE END of a reception shift, while the person is
 * still at the desk with the drawer in front of them. Counting the cash and
 * writing up the expenses takes a few minutes, and the time to start is before
 * the next shift walks in, not after.
 *
 * TWENTY MINUTES AFTER THE END, only if the report is still not in. By then
 * they have handed over and may be on their way home, which is exactly when a
 * closing report is forgotten until the morning, and a report written from
 * memory the next day is the one that does not add up.
 *
 * Both by phone alert and by email, to the person and nobody else. Once the
 * report is in, nothing more is said; a report reopened from Insight counts as
 * not in, so they are reminded to close it again.
 *
 * WHO IS ON DUTY. Somebody with a login that may close a till, on a published
 * rota for a reception shift, and not on leave. "Reception" is the shift's own
 * department when the shift has one, so a receptionist rostered on a
 * housekeeping shift that day is left alone and a housekeeper covering the
 * front desk is reminded. A shift with no department falls back to its name,
 * then to the person's department.
 *
 * WHICH REPORT. Insight names a shift by the day it began and morning,
 * afternoon or night, starting 6 am, 2 pm and 10 pm. A rota shift is matched to
 * whichever of those its start is nearest, so a 7 am start is the morning and a
 * night shift belongs to the evening it began.
 *
 * Each reminder is claimed in `att_nudge` before it is sent, so the five-minute
 * watcher cannot send the same one twice.
 */

/** How long before the end of the shift to say it first. */
export const BEFORE_END_MINUTES = 20;

/** How long after the end to say it again, if the report is still not in. */
export const AFTER_END_MINUTES = 20;

/** How long after that the second reminder is still worth sending, for a watcher that missed a beat. */
const AFTER_WINDOW_MINUTES = 100;

const SLOT_START = { morning: 6 * 60, afternoon: 14 * 60, night: 22 * 60 };
const SLOT_WORD = { morning: 'morning', afternoon: 'afternoon', night: 'night' };

/** A reception shift, by the shift's department first and the person's last. */
export function isReceptionShift(shift, staff) {
  const reception = (v) => /reception|front\s*(office|desk)/i.test(String(v ?? ''));
  if (shift?.department) return reception(shift.department);
  if (reception(shift?.position) || reception(shift?.name)) return true;
  return reception(staff?.department);
}

/** The closing report a rota shift belongs to: the day Insight files it under, and the slot. */
export function reportSlotFor(day, startsAt) {
  const start = toMinutes(startsAt);
  if (start == null) return null;
  const distance = (a, b) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b));
  let best = 'morning';
  for (const slot of Object.keys(SLOT_START)) {
    if (distance(start, SLOT_START[slot]) < distance(start, SLOT_START[best])) best = slot;
  }
  // A night shift that starts after midnight began, as far as Insight is
  // concerned, the evening before.
  const reportDay = best === 'night' && start < 12 * 60 ? addDays(day, -1) : day;
  return { day: reportDay, slot: best };
}

export async function watchTills(db, { timezone = 'UTC', ctx = null } = {}) {
  const setting = await db.prepare("SELECT value FROM settings WHERE key = 'att_till_nudge'")
    .first().catch(() => null);
  if (setting?.value === '0') return { checked: 0, before: 0, after: 0, reason: 'switched off' };

  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const minutesNow = toMinutes(clock) ?? 0;
  const yesterday = addDays(today, -1);

  const logins = await db.prepare(
    `SELECT u.id AS user_id, u.staff_id, u.role, u.permissions, u.email AS login_email,
            hp.personal_email
       FROM users u
       LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id
      WHERE u.active = 1 AND u.staff_id IS NOT NULL`,
  ).all().catch(() => ({ results: [] }));

  const people = (logins.results ?? []).filter((u) => allows('till', effectivePermissions(u)));
  if (!people.length) return { checked: 0, before: 0, after: 0, reason: 'nobody closes a till' };

  const ds = await loadDataset(db, { from: yesterday, to: today });

  let checked = 0;
  let before = 0;
  let after = 0;

  for (const person of people) {
    const staffId = Number(person.staff_id);
    const staff = ds.staffById.get(staffId);
    if (!staff?.active) continue;

    // Today's shift, and yesterday's for one that ran past midnight or ended
    // late last night.
    for (const day of [today, yesterday]) {
      const shift = publishedShift(ds, staffId, day);
      if (!shift || !isReceptionShift(shift, staff)) continue;

      const start = toMinutes(shift.starts_at);
      const end = toMinutes(shift.ends_at);
      if (start == null || end == null) continue;
      const finish = end > start ? end : end + 1440;
      const nowOnThatDay = minutesNow + (day === today ? 0 : 1440);
      const left = finish - nowOnThatDay;
      const since = nowOnThatDay - finish;

      let phase = null;
      if (left > 0 && left <= BEFORE_END_MINUTES) phase = 'before';
      else if (since >= AFTER_END_MINUTES && since <= AFTER_END_MINUTES + AFTER_WINDOW_MINUTES) phase = 'after';
      if (!phase) continue;

      const report = reportSlotFor(day, shift.starts_at);
      if (!report) continue;
      checked += 1;

      const done = await db.prepare(
        `SELECT 1 FROM till_report
          WHERE user_id = ?1 AND day = ?2 AND slot = ?3 AND reopened_at IS NULL LIMIT 1`,
      ).bind(person.user_id, report.day, report.slot).first().catch(() => null);
      if (done) continue;

      if (!await claim(db, staffId, day, `till:${phase}`)) continue;

      await createNotice(db, closeDueNotice({
        phase, shift, report, day, userId: person.user_id,
        emailTo: isEmail(String(person.login_email ?? '').trim()) ? null : firstUsableEmail(person.personal_email),
      }), ctx);
      if (phase === 'before') before += 1; else after += 1;
    }
  }

  return { checked, before, after, day: today };
}

/** The notice itself, for either reminder. */
export function closeDueNotice({ phase, shift, report, day, userId, emailTo = null }) {
  const word = SLOT_WORD[report.slot] ?? 'shift';
  const ends = sayTime(shift.ends_at);
  const facts = [
    ['Shift', `${shift.name}, ${sayHours(shift.starts_at, shift.ends_at)}`],
    [phase === 'before' ? 'Ends' : 'Ended', ends],
    ['Closing report', 'Not submitted yet', { tone: phase === 'before' ? 'warn' : 'bad', strong: true }],
  ];

  if (phase === 'before') {
    return {
      kind: 'till.close_due',
      level: 'info',
      title: `Close your till: your ${word} shift ends at ${shift.ends_at}`,
      body: 'Your closing report for this shift is not in yet. Count the drawer and submit it '
        + 'under Close shift before you hand over.',
      link: '#/att-my-till',
      day,
      actor: 'HIVE',
      userId,
      emailTo,
      push: true,
      email: true,
      mail: {
        status: 'Reminder',
        tone: 'info',
        eyebrow: 'Till',
        subject: `Close your till: your ${word} shift ends at ${ends}`,
        preheader: 'Count the drawer and submit your closing report before you hand over.',
        headline: 'Time to close your till',
        sub: `${capital(word)} shift · ${sayDate(report.day)} · ends at ${ends}`,
        facts,
        note: 'Count the drawer, write up any expenses with their PO numbers, and sign it with '
          + 'your PIN under Close shift. Doing it before the next shift arrives is the easiest '
          + 'time to get it right.',
        button: 'Close my shift',
        why: 'You get this because you are on a reception shift today.',
      },
    };
  }

  return {
    kind: 'till.close_due',
    level: 'warn',
    title: `Your closing report for the ${word} shift is still not in`,
    body: `Your shift ended at ${shift.ends_at}. Submit the closing report under Close shift `
      + 'now, while it is fresh.',
    link: '#/att-my-till',
    day,
    actor: 'HIVE',
    userId,
    emailTo,
    push: true,
    email: true,
    mail: {
      status: 'Still not in',
      tone: 'warn',
      eyebrow: 'Till',
      subject: `Your ${word} shift closing report is still not in`,
      preheader: `Your shift ended at ${ends}. Submit it now, while it is fresh.`,
      headline: `Your closing report for the ${word} shift is still not in`,
      sub: `${capital(word)} shift · ${sayDate(report.day)} · ended at ${ends}`,
      facts,
      note: 'Submit it now under Close shift, while the figures are fresh. A report written up '
        + 'the next morning is the one that does not add up.',
      button: 'Close my shift',
      why: 'You get this because you were on a reception shift and the report is not in.',
    },
  };
}

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The published, not-on-leave shift somebody has on a day, or null. */
function publishedShift(ds, staffId, day) {
  if (ds.leaveBy?.get(`${staffId}|${day}`)) return null;
  const schedule = scheduleFor(ds, staffId, day);
  const shift = schedule?.shift;
  if (!shift?.starts_at || !shift?.ends_at) return null;
  if (schedule.source === 'roster' && !ds.rosterBy.get(`${staffId}|${day}`)?.published) return null;
  return shift;
}

async function claim(db, staffId, day, kind) {
  const done = await db.prepare(
    'INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, ?3)',
  ).bind(staffId, day, kind).run().catch(() => null);
  return Number(done?.meta?.changes ?? 0) > 0;
}
