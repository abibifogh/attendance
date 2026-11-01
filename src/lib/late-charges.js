import { createNotice } from './notices.js';
import { computeRange, loadDataset, scheduleFor, toMinutes } from './attendance.js';
import { tillMonthFor } from './advances.js';
import { runningShift } from './shift-watch.js';
import { addDays, addMonths, nowIn } from '../util/dates.js';
import { sayDate, sayTime } from './email-design.js';
import { firstUsableEmail, isEmail } from './notify.js';

/**
 * Late charges.
 *
 * A fixed sum off salary for clocking in a set number of minutes or more after
 * a shift starts (GHS 20 at 15 minutes, from the shifts of 2 November 2026),
 * unless an administrator waives it.
 *
 * Found from the attendance record, never from a punch alone, so whatever the
 * record says the day was is what the charge follows: a clock-in corrected to
 * on time takes the charge away, an excused day takes it away, and a shift
 * moved later on the rota counts from its new start. A charge an
 * administrator waived stays waived.
 *
 * It comes off the first payroll still open from the day, the same as a till
 * shortage, and never takes anybody's take-home below nothing: what does not
 * fit waits for the month after.
 */

export const STATUSES = ['open', 'kept', 'waived', 'void'];
export const REASON_KINDS = ['transport', 'asked_later', 'clocked_late', 'other'];
export const REASON_LABELS = {
  transport: 'Transport',
  asked_later: 'Asked to come later',
  clocked_late: 'Clocked in late, was here',
  other: 'Other',
};

/** The rule, from the settings table's key/value rows (or a map of them). */
export function lateRule(settings = {}) {
  const map = Array.isArray(settings)
    ? Object.fromEntries(settings.map((r) => [r.key, r.value]))
    : settings;
  const amount = Number(map.late_charge_amount);
  const minutes = Number(map.late_charge_minutes);
  return {
    on: map.late_charge_on === '1' || map.late_charge_on === 1 || map.late_charge_on === true,
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 20,
    minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 15,
    from: /^\d{4}-\d{2}-\d{2}$/.test(String(map.late_charge_from ?? '')) ? map.late_charge_from : '2026-11-02',
    notify: map.late_charge_notify !== '0',
    currency: map.currency || 'GHS',
  };
}

export async function readRule(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
  return lateRule(rows.results ?? []);
}

/** "GHS 20" */
export const sayMoney = (rule, amount = rule.amount) => (
  `${rule.currency} ${Number.isInteger(Number(amount)) ? Number(amount) : Number(amount).toFixed(2)}`
);

/** The last clock time that is not a charge: 06:00 with 15 minutes is 06:14. */
export function clockInBy(startsAt, minutes) {
  const start = toMinutes(startsAt);
  if (start == null) return null;
  const at = (start + minutes - 1) % 1440;
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
}

/** "November" from "2026-11". */
export function monthName(month) {
  const m = /^(\d{4})-(\d{2})/.exec(String(month ?? ''));
  if (!m) return '';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
    .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}

/**
 * Whether somebody's day carries a charge, and what for. Null when it does
 * not: before the rule began, exempt, no published shift, not in at all, on
 * time enough, or a day somebody ruled on as anything but late.
 */
export function standingLateness(ds, staffId, day, rule) {
  if (!rule?.on || day < rule.from) return null;
  const staff = ds.staffById?.get(Number(staffId));
  if (!staff?.active || Number(staff.late_charge_exempt)) return null;
  if (ds.leaveBy?.get(`${staffId}|${day}`)?.status === 'approved') return null;

  const schedule = scheduleFor(ds, Number(staffId), day);
  const shift = schedule?.shift;
  if (!shift?.starts_at) return null;
  // A cell nobody has published is not something to be late for.
  if (schedule.source === 'roster' && !ds.rosterBy?.get(`${staffId}|${day}`)?.published) return null;

  const [record] = computeRange(ds, Number(staffId), day, day);
  if (!record?.first_in) return null;
  if (['leave', 'holiday'].includes(record.status)) return null;
  // Somebody ruled on the day. Only a ruling of late keeps the charge; an
  // excused day, or one put down as anything else, does not.
  if (record.resolution === 'resolved' && !['late', 'late_early'].includes(record.reason_code)) return null;

  const minutes = Math.round(Number(record.late_minutes) || 0);
  if (minutes < rule.minutes) return null;
  return { shift, record, minutes, clockIn: record.first_in };
}

const isClosed = async (db, month, staffId, cache) => {
  const key = `${month}|${staffId}`;
  if (cache.has(key)) return cache.get(key);
  const staff = await db.prepare('SELECT company_id FROM att_staff WHERE id = ?1').bind(staffId).first().catch(() => null);
  const company = Number(staff?.company_id) || 1;
  const run = await db.prepare(
    "SELECT 1 AS shut FROM pay_run WHERE substr(month, 1, 7) = ?1 AND COALESCE(company_id, 1) = ?2 AND status = 'final'",
  ).bind(month, company).first().catch(() => null);
  cache.set(key, Boolean(run));
  return Boolean(run);
};

const userFor = async (db, staffId) => db.prepare(
  `SELECT u.id AS user_id, u.email AS login_email, hp.personal_email
     FROM users u LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id
    WHERE u.staff_id = ?1 AND u.active = 1 ORDER BY u.id LIMIT 1`,
).bind(staffId).first().catch(() => null);

const recordEmail = (row) => (isEmail(String(row?.login_email ?? '').trim()) ? null : firstUsableEmail(row?.personal_email));

const shiftLabel = (name) => (/\bshift\s*$/i.test(String(name ?? '')) ? String(name) : `${name} shift`);

/**
 * Bring the charges up to date with the attendance record.
 *
 * New ones for the days scanned (yesterday and today unless told otherwise),
 * and every charge still in an open payroll checked again, so a corrected
 * clock-in or an excused day takes it away and a correction the other way
 * brings it back. Waived ones are left alone.
 */
export async function syncLateCharges(db, { timezone = 'UTC', ctx = null, days = null, staffId = null } = {}) {
  const rule = await readRule(db);
  if (!rule.on) return { created: 0, voided: 0, reopened: 0, reason: 'switched off' };

  const today = nowIn(timezone).split(' ')[0];
  const scan = (days ?? [addDays(today, -1), today]).filter((d) => d >= rule.from && d <= today);

  const since = addDays(today, -62);
  const standing = await db.prepare(
    `SELECT * FROM late_charge
      WHERE status IN ('open', 'kept', 'void') AND day >= ?1
        ${staffId ? 'AND staff_id = ?2' : ''}`,
  ).bind(...(staffId ? [since, staffId] : [since])).all().catch(() => ({ results: [] }));
  const rows = standing.results ?? [];

  const allDays = [...scan, ...rows.map((r) => r.day)].sort();
  if (!allDays.length) return { created: 0, voided: 0, reopened: 0 };
  const ds = await loadDataset(db, { from: allDays[0], to: allDays[allDays.length - 1] });

  const closed = new Map();
  const known = new Set();
  const all = await db.prepare(
    `SELECT staff_id, day FROM late_charge WHERE day BETWEEN ?1 AND ?2`,
  ).bind(allDays[0], allDays[allDays.length - 1]).all().catch(() => ({ results: [] }));
  for (const r of all.results ?? []) known.add(`${r.staff_id}|${r.day}`);

  let created = 0;
  let voided = 0;
  let reopened = 0;
  const fresh = [];

  // Every day already charged, looked at again.
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await isClosed(db, row.month, row.staff_id, closed)) continue;
    const now = standingLateness(ds, row.staff_id, row.day, rule);
    if (!now && row.status !== 'void') {
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(
        "UPDATE late_charge SET status = 'void', updated_at = datetime('now') WHERE id = ?1",
      ).bind(row.id).run();
      voided += 1;
    } else if (now && (row.status === 'void' || Number(row.minutes_late) !== now.minutes || row.clock_in !== now.clockIn)) {
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(
        `UPDATE late_charge
            SET status = CASE WHEN status = 'void' THEN 'open' ELSE status END,
                minutes_late = ?2, clock_in = ?3, updated_at = datetime('now')
          WHERE id = ?1`,
      ).bind(row.id, now.minutes, now.clockIn).run();
      if (row.status === 'void') reopened += 1;
    }
  }

  // And the days scanned, for anybody not charged on them yet.
  const people = staffId ? [ds.staffById.get(Number(staffId))].filter(Boolean) : (ds.staff ?? [...ds.staffById.values()]);
  for (const staff of people) {
    for (const day of scan) {
      if (known.has(`${staff.id}|${day}`)) continue;
      const found = standingLateness(ds, staff.id, day, rule);
      if (!found) continue;
      // eslint-disable-next-line no-await-in-loop
      const month = await tillMonthFor(db, day, staff.id);
      // eslint-disable-next-line no-await-in-loop
      const done = await db.prepare(
        `INSERT OR IGNORE INTO late_charge
           (staff_id, day, shift_id, shift_name, starts_at, ends_at, clock_in, minutes_late, amount, currency, month)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(staff.id, day, found.shift.id ?? null, found.shift.name ?? null, found.shift.starts_at ?? null,
        found.shift.ends_at ?? null, found.clockIn, found.minutes, rule.amount, rule.currency, month).run();
      if (!Number(done?.meta?.changes ?? 0)) continue;
      known.add(`${staff.id}|${day}`);
      created += 1;
      fresh.push({ staff, day, found, month });
    }
  }

  if (rule.notify) {
    for (const c of fresh) {
      // eslint-disable-next-line no-await-in-loop
      await tellCharged(db, rule, c, ctx).catch((err) => console.error('late charge notice failed', err));
    }
  }

  return { created, voided, reopened };
}

async function tellCharged(db, rule, { staff, day, found, month }, ctx) {
  const who = await userFor(db, staff.id);
  if (!who?.user_id) return;
  const money = sayMoney(rule);
  const title = `In at ${sayTime(found.clockIn)}, ${found.minutes} minutes late: ${money} off your pay`;
  const body = `Clocking in ${rule.minutes} minutes or more after your shift starts costs ${money}. `
    + `It comes off your ${monthName(month)} pay unless a manager waives it. `
    + 'If there was a reason, tell your manager in My day.';
  await createNotice(db, {
    kind: 'attendance.late_charge',
    level: 'warn',
    title,
    body,
    link: '#/att-me',
    day,
    actor: 'HIVE',
    userId: who.user_id,
    emailTo: recordEmail(who),
    push: true,
    email: true,
    cc: false,
    mail: {
      status: 'Late charge',
      tone: 'warn',
      eyebrow: 'Clocking',
      subject: title,
      preheader: `${money} comes off your ${monthName(month)} pay unless a manager waives it.`,
      headline: `${money} late charge`,
      sub: `${shiftLabel(found.shift.name)} · ${sayDate(day)}`,
      facts: [
        ['Shift started', sayTime(found.shift.starts_at)],
        ['Clocked in', `${sayTime(found.clockIn)}, ${found.minutes} minutes late`, { tone: 'warn' }],
        ['Charge', `${money}, ${monthName(month)} pay`],
      ],
      note: body,
      button: 'Open My day',
      why: 'You get this because you clocked in late for a shift on the rota.',
    },
  }, ctx);
}

/**
 * Warn somebody while they can still avoid it, and tell them when they no
 * longer can.
 *
 * Five minutes into a shift with nothing recorded: "clock in by 06:14". At
 * the charge's own minute with still nothing: "you are now 15 minutes late".
 * Each is said once a day, claimed in `att_nudge` before it is sent.
 */
export async function watchLateCharges(db, { timezone = 'UTC', ctx = null } = {}) {
  const rule = await readRule(db);
  if (!rule.on || !rule.notify) return { warned: 0, charged: 0, reason: 'switched off' };

  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const minutesNow = toMinutes(clock) ?? 0;
  const yesterday = addDays(today, -1);
  if (today < rule.from && yesterday < rule.from) return { warned: 0, charged: 0 };

  const linked = await db.prepare(
    `SELECT u.id AS user_id, u.staff_id, u.email AS login_email, hp.personal_email
       FROM users u
       LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id
      WHERE u.active = 1 AND u.staff_id IS NOT NULL`,
  ).all().catch(() => ({ results: [] }));
  const people = linked.results ?? [];
  if (!people.length) return { warned: 0, charged: 0 };

  const [ds, punches] = await Promise.all([
    loadDataset(db, { from: yesterday, to: today }),
    db.prepare('SELECT DISTINCT staff_id, day FROM att_punches WHERE day IN (?1, ?2)')
      .bind(yesterday, today).all().catch(() => ({ results: [] })),
  ]);
  const seen = new Set((punches.results ?? []).map((r) => `${Number(r.staff_id)}|${r.day}`));

  let warned = 0;
  let charged = 0;
  const money = sayMoney(rule);

  for (const row of people) {
    const staffId = Number(row.staff_id);
    const staff = ds.staffById.get(staffId);
    if (!staff?.active || Number(staff.late_charge_exempt)) continue;
    const found = runningShift(ds, staffId, today, minutesNow)
      ?? runningShift(ds, staffId, yesterday, minutesNow + 24 * 60);
    if (!found || found.day < rule.from) continue;
    const here = seen.has(`${staffId}|${found.day}`) || (found.day !== today && seen.has(`${staffId}|${today}`));
    if (here) continue;

    const late = Math.floor(found.minutesIn);
    const by = clockInBy(found.shift.starts_at, rule.minutes);
    let title;
    let body;
    let kind;
    if (late >= rule.minutes) {
      kind = 'charge:late';
      // eslint-disable-next-line no-await-in-loop
      const month = await tillMonthFor(db, found.day, staffId);
      title = `You are now ${rule.minutes} minutes late: ${money} comes off your pay`;
      body = `Your ${shiftLabel(found.shift.name)} started at ${sayTime(found.shift.starts_at)} and nothing has been recorded. `
        + `${money} will come off your ${monthName(month)} pay unless a manager waives it. `
        + 'If there is a reason, tell your manager in My day.';
    } else if (late >= 5) {
      kind = 'charge:warn';
      title = `Clock in by ${sayTime(by)} to avoid the ${money} late charge`;
      body = `Your ${shiftLabel(found.shift.name)} started at ${sayTime(found.shift.starts_at)} and nothing has been recorded yet. `
        + `Clocking in ${rule.minutes} minutes or more after the start costs ${money}.`;
    } else {
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const claimed = await db.prepare(
      'INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, ?3)',
    ).bind(staffId, found.day, kind).run().catch(() => null);
    if (!Number(claimed?.meta?.changes ?? 0)) continue;

    // eslint-disable-next-line no-await-in-loop
    await createNotice(db, {
      kind: 'attendance.late_charge_warning',
      level: 'warn',
      title,
      body,
      link: '#/att-me',
      day: found.day,
      actor: 'HIVE',
      userId: row.user_id,
      emailTo: recordEmail(row),
      push: true,
      email: false,
      cc: false,
    }, ctx).catch((err) => console.error('late charge warning failed', err));
    if (kind === 'charge:late') charged += 1;
    else warned += 1;
  }
  return { warned, charged };
}

/** The month after, for a charge that did not fit this month's take-home. */
export async function deferLateCharges(db, ids, month) {
  if (!ids?.length) return 0;
  const next = addMonths(month, 1);
  let moved = 0;
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const done = await db.prepare(
      "UPDATE late_charge SET month = ?2, updated_at = datetime('now') WHERE id = ?1 AND status IN ('open', 'kept')",
    ).bind(id, next).run();
    moved += Number(done?.meta?.changes ?? 0);
  }
  return moved;
}

/**
 * Which of somebody's charges fit this month's take-home, oldest first, and
 * which wait. `room` is what the payslip would pay without them.
 */
export function fitCharges(charges = [], room = 0) {
  const sorted = [...charges].sort((a, b) => String(a.day).localeCompare(String(b.day)) || (a.id - b.id));
  const taken = [];
  const waiting = [];
  let used = 0;
  for (const c of sorted) {
    const amount = Math.round((Number(c.amount) || 0) * 100) / 100;
    if (used + amount <= Math.max(0, room) + 1e-9) {
      taken.push({ ...c, amount });
      used = Math.round((used + amount) * 100) / 100;
    } else {
      waiting.push({ ...c, amount });
    }
  }
  return { taken, waiting, total: used };
}
