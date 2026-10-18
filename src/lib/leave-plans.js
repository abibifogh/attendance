import { leaveBalance, onClock } from './attendance.js';
import { createNotice } from './notices.js';
import { firstUsableEmail, isEmail } from './notify.js';
import { sayDate, sayRange } from './email-design.js';
import { addDays, diffDays, dow, nowIn } from '../util/dates.js';

/**
 * A leave plan for the year.
 *
 * At the start of the year everybody who earns annual leave is asked for the
 * weeks they want off, all at once. They plan around what they can see: busy
 * seasons when nobody goes, and weeks their department already has as many
 * people away as it can spare. The managers then approve the year in one
 * place, and what they approve becomes ordinary approved leave.
 *
 * This file is the rules. The screens and the answers are in
 * routes/leave-plans.js.
 */

/** How many from a department can be away at once, where nobody has said. */
export const DEFAULT_LIMIT = 1;

/** Ask each person to plan at least this many days, where nobody has said. */
export const DEFAULT_MIN_DAYS = 10;

/** The year a round is most likely for: next year from October on. */
export function defaultYear(today) {
  const year = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) >= 10 ? year + 1 : year;
}

/** The round's rules, read out of their columns. */
export function readRound(row) {
  if (!row) return null;
  const parse = (text, fallback) => {
    try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
  };
  const busy = parse(row.busy, []);
  const limits = parse(row.limits, {});
  return {
    id: row.id,
    year: Number(row.year),
    opensOn: row.opens_on,
    dueOn: row.due_on,
    minDays: Number(row.min_days ?? DEFAULT_MIN_DAYS),
    busy: Array.isArray(busy) ? busy : [],
    limits: limits && typeof limits === 'object' ? limits : {},
    remind: Boolean(row.remind),
    tellManagers: Boolean(row.tell_managers),
    status: row.status,
    invitedAt: row.invited_at,
  };
}

export const limitFor = (round, department) => {
  const n = Number(round?.limits?.[department ?? '']);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
};

/** The busy season a span runs into, if any. */
export function busyIn(round, from, to) {
  return (round?.busy ?? []).find((b) => b.from <= to && b.to >= from) ?? null;
}

/** Every day from one to another, inclusive. */
export function eachDay(from, to) {
  const out = [];
  for (let i = 0; i <= Math.max(0, diffDays(from, to)); i += 1) out.push(addDays(from, i));
  return out;
}

/**
 * Who is away on each day, by department.
 *
 * `spans` are approved leave and planned blocks alike, each with the person and
 * their department. Returns a map of "department|day" to the set of people.
 */
export function awayByDay(spans, { from, to } = {}) {
  const map = new Map();
  for (const s of spans) {
    const a = from && s.from < from ? from : s.from;
    const b = to && s.to > to ? to : s.to;
    if (a > b) continue;
    for (const day of eachDay(a, b)) {
      const key = `${s.department ?? ''}|${day}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(s.staffId);
    }
  }
  return map;
}

/**
 * The days a span would put its department over what it can spare.
 *
 * Counted with the person in, and anybody else away from the same department.
 */
export function overLimit(away, { staffId, department, from, to }, limit) {
  const days = [];
  for (const day of eachDay(from, to)) {
    const set = new Set(away.get(`${department ?? ''}|${day}`) ?? []);
    set.add(staffId);
    if (set.size > limit) days.push(day);
  }
  return days;
}

/** Days a department is already full, without this person, for their calendar. */
export function fullDays(away, { staffId, department, from, to }, limit) {
  const days = [];
  for (const day of eachDay(from, to)) {
    const set = new Set(away.get(`${department ?? ''}|${day}`) ?? []);
    set.delete(staffId);
    if (set.size >= limit) days.push(day);
  }
  return days;
}

/**
 * Everybody asked to plan, with what they have to plan.
 *
 * Active staff on the attendance side who earn annual leave and have
 * qualified for it. Casual staff, paid by the day, are left out, and so is
 * anybody whose entitlement comes to nothing.
 */
export async function eligiblePeople(db, round) {
  const [staff, settingsRows, reasons, leave, casual] = await Promise.all([
    db.prepare('SELECT * FROM att_staff WHERE active = 1 ORDER BY department, name').all(),
    db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM att_reasons').all().catch(() => ({ results: [] })),
    db.prepare("SELECT * FROM att_leave WHERE status IN ('approved', 'pending')").all().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT p.staff_id FROM hr_pay p
        WHERE p.basis = 'daily'
          AND p.id = (SELECT q.id FROM hr_pay q WHERE q.staff_id = p.staff_id ORDER BY q.from_day DESC, q.id DESC LIMIT 1)`,
    ).all().catch(() => ({ results: [] })),
  ]);
  const settings = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));
  const reasonBy = new Map((reasons.results ?? []).map((r) => [r.code, r]));
  const casualIds = new Set((casual.results ?? []).map((r) => Number(r.staff_id)));
  const requestsBy = new Map();
  for (const r of leave.results ?? []) {
    if (!requestsBy.has(r.staff_id)) requestsBy.set(r.staff_id, []);
    requestsBy.get(r.staff_id).push(r);
  }

  const yearStart = settings.att_leave_year_starts || '01-01';
  const asOf = `${round.year}-${yearStart}`;
  const out = [];
  for (const s of staff.results ?? []) {
    if (!onClock(s) || casualIds.has(Number(s.id))) continue;
    const balance = leaveBalance({
      staff: s, records: [], requests: requestsBy.get(s.id) ?? [], settings, asOf, reasons: reasonBy,
    });
    if (!balance.qualified || balance.available <= 0) continue;
    out.push({
      id: s.id,
      name: s.name,
      department: s.department || 'Other',
      balance: {
        entitlement: balance.entitlement,
        carryOver: balance.carryOver,
        available: balance.available,
        booked: balance.taken + balance.booked,
        remaining: balance.remaining,
        from: balance.from,
        to: balance.to,
      },
    });
  }
  return out;
}

/** Approved leave and live planned blocks in a year, as spans for awayByDay. */
export async function spansFor(db, round) {
  const from = `${round.year}-01-01`;
  const to = `${round.year + 1}-01-31`;
  const [leave, blocks] = await Promise.all([
    db.prepare(
      `SELECT l.staff_id, l.from_day, l.to_day, s.department
         FROM att_leave l JOIN att_staff s ON s.id = l.staff_id
        WHERE l.status = 'approved' AND l.reason_code <> 'sick_leave'
          AND l.to_day >= ?1 AND l.from_day <= ?2`,
    ).bind(from, to).all().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT b.*, p.staff_id, p.status AS plan_status, p.sent_at, s.department, s.name
         FROM leave_plan_block b
         JOIN leave_plan p ON p.id = b.plan_id
         JOIN att_staff s ON s.id = p.staff_id
        WHERE p.round_id = ?1`,
    ).bind(round.id).all().catch(() => ({ results: [] })),
  ]);
  const spans = (leave.results ?? []).map((l) => ({
    staffId: l.staff_id, department: l.department || 'Other', from: l.from_day, to: l.to_day, kind: 'leave',
  }));
  for (const b of blocks.results ?? []) {
    // Approved blocks are already approved leave above; declined ones are not
    // time away; drafts nobody has sent are not a claim on a week yet.
    if (b.leave_id || b.status === 'declined' || b.status === 'approved') continue;
    if (b.plan_status === 'draft') continue;
    spans.push({
      staffId: b.staff_id, department: b.department || 'Other', from: b.from_day, to: b.to_day,
      kind: 'block', blockId: b.id,
    });
  }
  return { spans, blocks: blocks.results ?? [] };
}

const recordEmail = (row) => (isEmail(String(row?.login_email ?? '').trim()) ? null : firstUsableEmail(row?.personal_email));

/** Logins and addresses for a set of people. */
export async function contactsFor(db, staffIds) {
  if (!staffIds.length) return new Map();
  const rows = await db.prepare(
    `SELECT s.id AS staff_id, s.name, u.id AS user_id, u.email AS login_email, hp.personal_email
       FROM att_staff s
       LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
       LEFT JOIN hr_profile hp ON hp.staff_id = s.id
      WHERE s.id IN (${staffIds.map(() => '?').join(',')})`,
  ).bind(...staffIds).all().catch(() => ({ results: [] }));
  const map = new Map();
  for (const r of rows.results ?? []) if (!map.has(r.staff_id)) map.set(r.staff_id, r);
  return map;
}

/** The invitation, or a reminder, to one person. */
export async function askForPlan(db, { round, person, contact, reminder = false, chased = null }, ctx) {
  if (!contact?.user_id && !recordEmail(contact)) return false;
  const first = String(person.name ?? '').split(/\s+/)[0];
  const left = Math.max(0, person.balance?.remaining ?? 0);
  const busy = round.busy[0];
  const title = reminder ? `Your ${round.year} leave plan is not in yet` : `Send your leave plan for ${round.year}`;
  await createNotice(db, {
    kind: 'leave.plan_asked',
    level: reminder ? 'warn' : 'info',
    title,
    body: `${left} days to plan, by ${sayDate(round.dueOn)}. Tap to choose your weeks.`,
    link: '#/my-leave-plan',
    actor: chased || 'HIVE',
    userId: contact.user_id ?? null,
    emailTo: recordEmail(contact),
    push: true,
    email: true,
    cc: false,
    text: false,
    mail: {
      status: reminder ? 'Reminder' : 'Plan your leave',
      tone: reminder ? 'warn' : 'info',
      eyebrow: 'Leave',
      subject: title,
      preheader: `${left} days to plan, by ${sayDate(round.dueOn)}.`,
      headline: `${first}, send your leave plan for ${round.year}`,
      sub: `By ${sayDate(round.dueOn)} · about five minutes on your phone`,
      facts: [
        ['Days to plan', person.balance?.carryOver
          ? `${left} (${person.balance.entitlement} for ${round.year}, ${person.balance.carryOver} carried over)`
          : String(left), { strong: true }],
        busy ? ['Busy season, no leave', sayRange(busy.from, busy.to)] : null,
        [`${person.department} away at once`, `${limitFor(round, person.department)} ${limitFor(round, person.department) === 1 ? 'person' : 'people'}`],
        ['Your plan', 'Not sent yet', { tone: 'warn' }],
      ].filter(Boolean),
      note: 'Choose the weeks you want off this year, all in one go. HIVE shows you which weeks your '
        + 'department is already full, so you can pick around them. Your manager approves the whole '
        + 'year at once, and approved days go straight onto the rota.',
      button: 'Plan my leave',
      why: 'You get this because you earn annual leave. A reminder comes every Monday until your plan '
        + 'is in, then every day in the last week.',
    },
  }, ctx);
  return true;
}

/**
 * The frequent tick: open a round on its day, and remind anybody whose plan is
 * not in, on Mondays and every day of the last week.
 */
export async function watchLeavePlans(db, { timezone = 'UTC', ctx = null } = {}) {
  const now = nowIn(timezone);
  const today = now.slice(0, 10);
  const hour = Number(now.slice(11, 13));
  if (hour < 9) return { invited: 0, reminded: 0 };

  const rows = await db.prepare("SELECT * FROM leave_plan_round WHERE status = 'open'")
    .all().catch(() => ({ results: [] }));
  let invited = 0;
  let reminded = 0;
  for (const row of rows.results ?? []) {
    const round = readRound(row);
    if (today < round.opensOn) continue;

    if (!round.invitedAt) {
      const claim = await db.prepare(
        "UPDATE leave_plan_round SET invited_at = datetime('now') WHERE id = ?1 AND invited_at IS NULL",
      ).bind(round.id).run();
      if (Number(claim?.meta?.changes ?? 0)) invited += await inviteEverybody(db, round, ctx, today);
      continue;
    }

    if (!round.remind || today > round.dueOn) continue;
    const lastWeek = diffDays(today, round.dueOn) < 7;
    // dow() counts from Monday as 0.
    if (!lastWeek && dow(today) !== 0) continue;

    const people = await eligiblePeople(db, round);
    const sent = await db.prepare(
      "SELECT staff_id, reminded_on FROM leave_plan WHERE round_id = ?1 AND status <> 'draft'",
    ).bind(round.id).all().catch(() => ({ results: [] }));
    const done = new Set((sent.results ?? []).map((r) => Number(r.staff_id)));
    const waiting = people.filter((p) => !done.has(Number(p.id)));
    const contacts = await contactsFor(db, waiting.map((p) => p.id));
    for (const person of waiting) {
      await db.prepare(
        'INSERT OR IGNORE INTO leave_plan (round_id, staff_id) VALUES (?1, ?2)',
      ).bind(round.id, person.id).run();
      const claim = await db.prepare(
        `UPDATE leave_plan SET reminded_on = ?1
          WHERE round_id = ?2 AND staff_id = ?3 AND COALESCE(reminded_on, '') < ?1`,
      ).bind(today, round.id, person.id).run();
      if (!Number(claim?.meta?.changes ?? 0)) continue;
      if (await askForPlan(db, { round, person, contact: contacts.get(person.id), reminder: true }, ctx)) reminded += 1;
    }
  }
  return { invited, reminded };
}

/**
 * What a block of planned time off costs.
 *
 * Counted against the rota where the rota reaches that far. A plan made in
 * January for August is ahead of any rota, and the rota's own estimate for
 * that, five sevenths of the calendar, is no figure to show somebody planning
 * a fortnight off. So ahead of the rota it is the weekdays, less public
 * holidays: what a week off costs most people here.
 */
export async function planDays(db, ds, { staffId, from, to }, leaveDaysFor) {
  const count = leaveDaysFor({ from, to, staffId, ds, halfDay: null });
  if (!count.estimated) return count.allSettled ? 0 : count.days;
  const holidays = await db.prepare(
    'SELECT COALESCE(observed_on, day) AS day FROM att_holidays WHERE active = 1 AND COALESCE(observed_on, day) BETWEEN ?1 AND ?2',
  ).bind(from, to).all().catch(() => ({ results: [] }));
  const off = new Set((holidays.results ?? []).map((r) => r.day));
  return eachDay(from, to).filter((d) => dow(d) < 5 && !off.has(d)).length;
}

/** Tell everybody asked to plan that the round is open. */
export async function inviteEverybody(db, round, ctx, today = null) {
  const people = await eligiblePeople(db, round);
  const contacts = await contactsFor(db, people.map((p) => p.id));
  let n = 0;
  for (const person of people) {
    // Written down as reminded today, so a Monday opening is not followed by
    // a Monday reminder an hour later.
    await db.prepare('INSERT OR IGNORE INTO leave_plan (round_id, staff_id) VALUES (?1, ?2)')
      .bind(round.id, person.id).run();
    if (!await askForPlan(db, { round, person, contact: contacts.get(person.id) }, ctx)) continue;
    n += 1;
    if (today) {
      await db.prepare('UPDATE leave_plan SET reminded_on = ?1 WHERE round_id = ?2 AND staff_id = ?3')
        .bind(today, round.id, person.id).run();
    }
  }
  return n;
}
