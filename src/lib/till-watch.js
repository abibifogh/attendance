import { createNotice } from './notices.js';
import { computeRange, loadDataset, scheduleFor, toMinutes } from './attendance.js';
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
 * AND THEN EVERY DAY UNTIL IT IS IN. A report still missing the morning after
 * is said again each day from eight o'clock, one message listing every report
 * the person still owes, until the last of them is submitted. A shift they did
 * not actually work — no clock-in, or on leave — owes nothing.
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

/** When the daily reminder about reports still owed goes out, local time. */
export const OWED_FROM_MINUTES = 8 * 60;

/** How far back a missing report is still chased. */
export const OWED_LOOKBACK_DAYS = 31;

const SLOT_START = { morning: 6 * 60, afternoon: 14 * 60, night: 22 * 60 };
const SLOT_ORDER = ['morning', 'afternoon', 'night'];

/** Earlier reports sort first: by the day Insight files them under, then the slot. */
export const reportKey = ({ day, slot }) => `${day}|${SLOT_ORDER.indexOf(slot)}`;
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

  // ---- every day, the reports still owed ---------------------------------
  let owed = 0;
  if (minutesNow >= OWED_FROM_MINUTES) {
    for (const person of people) {
      const staffId = Number(person.staff_id);
      const said = await db.prepare(
        "SELECT 1 FROM att_nudge WHERE staff_id = ?1 AND day = ?2 AND kind = 'till:owed'",
      ).bind(staffId, today).first().catch(() => null);
      if (said) continue;
      const list = await owedReports(db, { userId: person.user_id, staffId, timezone });
      if (!list.length) continue;
      if (!await claim(db, staffId, today, 'till:owed')) continue;
      await createNotice(db, owedNotice({
        list, day: today, userId: person.user_id,
        emailTo: isEmail(String(person.login_email ?? '').trim()) ? null : firstUsableEmail(person.personal_email),
      }), ctx);
      owed += 1;
    }
  }

  return { checked, before, after, owed, day: today };
}

/**
 * The closing reports somebody still owes, oldest first.
 *
 * A published reception shift of theirs that has ended, that they actually
 * clocked in for, from the last month, whose report is not in (a report
 * reopened from Insight counts as not in). Nothing before the property's very
 * first closing report counts, so shifts worked before closing reports existed
 * are never asked for.
 */
export async function owedReports(db, { userId, staffId, timezone = 'UTC' }) {
  if (!userId || !staffId) return [];
  const first = await db.prepare('SELECT MIN(day) AS day FROM till_report').first().catch(() => null);
  if (!first?.day) return [];

  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const minutesNow = toMinutes(clock) ?? 0;
  const from = [addDays(today, -OWED_LOOKBACK_DAYS), first.day].sort().pop();
  if (from > today) return [];

  const ds = await loadDataset(db, { from: addDays(from, -1), to: today });
  const staff = ds.staffById.get(Number(staffId));
  if (!staff?.active) return [];

  const worked = new Map(computeRange(ds, Number(staffId), from, today).map((r) => [r.day, r]));
  const done = await db.prepare(
    'SELECT day, slot FROM till_report WHERE user_id = ?1 AND day >= ?2 AND reopened_at IS NULL',
  ).bind(userId, addDays(from, -1)).all().catch(() => ({ results: [] }));
  const closed = new Set((done.results ?? []).map((r) => reportKey(r)));

  const out = [];
  for (let day = from; day <= today; day = addDays(day, 1)) {
    const shift = publishedShift(ds, Number(staffId), day);
    if (!shift || !isReceptionShift(shift, staff)) continue;
    const start = toMinutes(shift.starts_at);
    const end = toMinutes(shift.ends_at);
    if (start == null || end == null) continue;
    // Still running, or not started: nothing is owed for it yet. Minutes are
    // counted from the start of the shift's own day, so a night shift ends the
    // next morning.
    const endedAgo = minutesNow + 1440 * daysBetween(day, today) - (end > start ? end : end + 1440);
    if (endedAgo <= 0) continue;
    // A day they never clocked in for is a shift they did not work.
    const record = worked.get(day);
    if (!record?.first_in && !record?.corrected_in) continue;
    const report = reportSlotFor(day, shift.starts_at);
    if (!report || closed.has(reportKey(report))) continue;
    out.push({ ...report, shiftDay: day, shift: { name: shift.name, starts_at: shift.starts_at, ends_at: shift.ends_at } });
  }
  return out.sort((a, b) => reportKey(a).localeCompare(reportKey(b)));
}

/**
 * Every closing report there should have been between two days, and every one
 * that came in.
 *
 * One row per person per reception shift they were rostered on: the report if
 * it is in, whether they clocked in at all (a shift not worked owes nothing),
 * and whether it has ended yet. Reports that came in for a shift nobody was
 * rostered on are listed too, because a report is a fact whatever the rota
 * said. For the manager's screen, which keeps track and chases.
 */
export async function tillLedger(db, { from, to, timezone = 'UTC' }) {
  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const minutesNow = toMinutes(clock) ?? 0;

  const logins = await db.prepare(
    `SELECT u.id AS user_id, u.name, u.staff_id, u.role, u.permissions
       FROM users u WHERE u.active = 1 AND u.staff_id IS NOT NULL`,
  ).all().catch(() => ({ results: [] }));
  const people = (logins.results ?? []).filter((u) => allows('till', effectivePermissions(u)));

  const ds = await loadDataset(db, { from: addDays(from, -1), to: [to, today].sort()[0] });
  const reports = await db.prepare(
    'SELECT * FROM till_report WHERE day BETWEEN ?1 AND ?2 ORDER BY day, signed_at',
  ).bind(addDays(from, -1), to).all().catch(() => ({ results: [] }));
  const reportBy = new Map();
  for (const r of reports.results ?? []) {
    // The live one wins over one that was reopened and closed again.
    const key = `${r.user_id}|${reportKey(r)}`;
    const had = reportBy.get(key);
    if (!had || (had.reopened_at && !r.reopened_at)) reportBy.set(key, r);
  }

  const rows = [];
  const used = new Set();
  for (const person of people) {
    const staffId = Number(person.staff_id);
    const staff = ds.staffById.get(staffId);
    if (!staff) continue;
    const worked = new Map(computeRange(ds, staffId, from, [to, today].sort()[0]).map((r) => [r.day, r]));
    for (let day = from; day <= to && day <= today; day = addDays(day, 1)) {
      const shift = publishedShift(ds, staffId, day);
      if (!shift || !isReceptionShift(shift, staff)) continue;
      const start = toMinutes(shift.starts_at);
      const end = toMinutes(shift.ends_at);
      if (start == null || end == null) continue;
      const slot = reportSlotFor(day, shift.starts_at);
      if (!slot) continue;
      const endedAgo = minutesNow + 1440 * daysBetween(day, today) - (end > start ? end : end + 1440);
      const record = worked.get(day);
      const key = `${person.user_id}|${reportKey(slot)}`;
      const report = reportBy.get(key) ?? null;
      if (report) used.add(key);
      rows.push({
        userId: Number(person.user_id),
        staffId,
        name: staff.name || person.name,
        day: slot.day,
        slot: slot.slot,
        shiftDay: day,
        shift: { name: shift.name, starts_at: shift.starts_at, ends_at: shift.ends_at },
        ended: endedAgo > 0,
        worked: Boolean(record?.first_in || record?.corrected_in),
        report,
      });
    }
  }
  for (const [key, report] of reportBy) {
    if (used.has(key) || report.day < from) continue;
    rows.push({
      userId: Number(report.user_id), staffId: null, name: report.name,
      day: report.day, slot: report.slot, shiftDay: report.day, shift: null,
      ended: true, worked: true, report,
    });
  }
  return rows.sort((a, b) => reportKey(b).localeCompare(reportKey(a)) || a.name.localeCompare(b.name));
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** The daily reminder: every report still owed, oldest first. */
export function owedNotice({ list, day, userId, emailTo = null }) {
  const [oldest] = list;
  const word = (r) => SLOT_WORD[r.slot] ?? 'shift';
  const many = list.length > 1;
  const title = many
    ? `${list.length} closing reports are still not in`
    : `Your closing report for the ${word(oldest)} shift on ${sayDate(oldest.day)} is still not in`;
  return {
    kind: 'till.close_owed',
    level: 'warn',
    title,
    body: `Submit it under Close till. ${many ? 'Start with the oldest: ' : ''}`
      + `the ${word(oldest)} shift on ${sayDate(oldest.day)}. A later shift cannot be closed until it is in.`,
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
      subject: title,
      preheader: `Start with the ${word(oldest)} shift on ${sayDate(oldest.day)}. This reminder comes every day until it is in.`,
      headline: title,
      sub: many ? `The oldest is the ${word(oldest)} shift on ${sayDate(oldest.day)}` : `${capital(word(oldest))} shift · ${sayDate(oldest.day)}`,
      facts: list.slice(0, 8).map((r) => [
        `${capital(word(r))} · ${sayDate(r.day)}`,
        `${r.shift.name}, ${sayHours(r.shift.starts_at, r.shift.ends_at)}`,
      ]),
      note: 'Submit them under Close till, oldest first. HIVE takes closing reports in order, so a '
        + 'later shift cannot be closed while an earlier one is missing. This reminder comes every '
        + 'day until they are all in.',
      button: 'Close my till',
      why: 'You get this because a closing report from a reception shift you worked is not in.',
    },
  };
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

/**
 * Whoever is on the rota for the next reception shift to start: the people
 * who may close a till, on a published reception shift starting after now,
 * today or tomorrow, not on leave. Everybody on that same earliest start, so
 * two people sharing a shift both hear. Empty when nobody is rostered.
 */
export async function nextOnReception(db, { timezone = 'UTC' } = {}) {
  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const minutesNow = toMinutes(clock) ?? 0;
  const tomorrow = addDays(today, 1);

  const logins = await db.prepare(
    `SELECT u.id AS user_id, u.name, u.staff_id, u.role, u.permissions, u.email AS login_email, hp.personal_email
       FROM users u LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id
      WHERE u.active = 1 AND u.staff_id IS NOT NULL`,
  ).all().catch(() => ({ results: [] }));
  const people = (logins.results ?? []).filter((u) => allows('till', effectivePermissions(u)));
  if (!people.length) return [];
  const ds = await loadDataset(db, { from: today, to: tomorrow });

  let best = null;
  const found = [];
  for (const person of people) {
    const staffId = Number(person.staff_id);
    const staff = ds.staffById.get(staffId);
    if (!staff?.active) continue;
    for (const [day, offset] of [[today, 0], [tomorrow, 1440]]) {
      const shift = publishedShift(ds, staffId, day);
      if (!shift || !isReceptionShift(shift, staff)) continue;
      const start = toMinutes(shift.starts_at);
      if (start == null || start + offset <= minutesNow) continue;
      const at = start + offset;
      if (best == null || at < best) { best = at; found.length = 0; }
      if (at === best) {
        found.push({
          userId: Number(person.user_id), name: staff.name || person.name, day, shift,
          emailTo: isEmail(String(person.login_email ?? '').trim()) ? null : firstUsableEmail(person.personal_email),
        });
      }
      break;
    }
  }
  return found;
}
