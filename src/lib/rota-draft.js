import { createNotice } from './notices.js';
import { effectivePermissions } from './permissions.js';
import { addDays, nowIn, startOfWeek } from '../util/dates.js';
import { sayDate } from './email-design.js';

/**
 * The weekly deadline for the draft rota.
 *
 * Whoever plans the rota is reminded to have next week's draft in by a set
 * day and time (Monday 17:00 to start with): once a few days before, once a
 * few hours before, and once at the deadline if it still has not been sent
 * for review. The administrators get a copy of each. Sending it for review
 * stops the reminders for that week.
 *
 * Every time here is the property's own clock, written 'YYYY-MM-DD HH:MM', so
 * comparing two of them is comparing two strings.
 */

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEYS = ['rota_draft_on', 'rota_draft_due_dow', 'rota_draft_due_time', 'rota_draft_first_days',
  'rota_draft_first_time', 'rota_draft_last_hours', 'rota_draft_weeks_ahead', 'rota_draft_cc_admins', 'rota_review_by'];

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};

/** The rule, from the settings table's rows, with every gap filled. */
export function draftRule(m = {}) {
  let reviewers = [];
  try {
    const parsed = JSON.parse(m.rota_review_by ?? '[]');
    if (Array.isArray(parsed)) reviewers = parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { /* nobody named: every administrator */ }
  return {
    on: String(m.rota_draft_on ?? '1') !== '0',
    dueDow: clampInt(m.rota_draft_due_dow, 0, 6, 0),
    dueTime: CLOCK.test(String(m.rota_draft_due_time ?? '')) ? m.rota_draft_due_time : '17:00',
    firstDays: clampInt(m.rota_draft_first_days, 0, 6, 3),
    firstTime: CLOCK.test(String(m.rota_draft_first_time ?? '')) ? m.rota_draft_first_time : '10:00',
    lastHours: clampInt(m.rota_draft_last_hours, 0, 48, 3),
    weeksAhead: clampInt(m.rota_draft_weeks_ahead, 1, 3, 1),
    ccAdmins: String(m.rota_draft_cc_admins ?? '1') !== '0',
    reviewers,
  };
}

export async function readDraftRule(db) {
  const rows = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => '?').join(', ')}) OR key = 'timezone'`,
  ).bind(...KEYS).all().catch(() => ({ results: [] }));
  const m = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return { ...draftRule(m), timezone: m.timezone || 'UTC' };
}

/** 'YYYY-MM-DD HH:MM' moved by a number of minutes, either way. */
export function shiftClock(at, minutes) {
  const [day, time] = at.split(' ');
  const [hh, mm] = time.split(':').map(Number);
  let total = hh * 60 + mm + minutes;
  let d = day;
  while (total < 0) { total += 1440; d = addDays(d, -1); }
  while (total >= 1440) { total -= 1440; d = addDays(d, 1); }
  return `${d} ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The deadline for the draft of the week starting `weekStart`, and its reminders. */
export function deadlineFor(rule, weekStart) {
  const dueDay = addDays(weekStart, rule.dueDow - 7 * rule.weeksAhead);
  const due = `${dueDay} ${rule.dueTime}`;
  const first = `${addDays(dueDay, -rule.firstDays)} ${rule.firstTime}`;
  const last = rule.lastHours > 0 ? shiftClock(due, -rule.lastHours * 60) : null;
  const steps = [{ step: 'first', at: first < due ? first : null }];
  if (last && last < due && (!steps[0].at || last > steps[0].at)) steps.push({ step: 'last', at: last });
  steps.push({ step: 'due', at: due });
  return { weekStart, due, dueDay, steps: steps.filter((s) => s.at) };
}

/** Which reminders are owed right now: due, not stale, for weeks not yet sent. */
export function owedNow(rule, now) {
  if (!rule.on) return [];
  const today = now.slice(0, 10);
  const out = [];
  for (let k = 0; k <= 4; k += 1) {
    const week = addDays(startOfWeek(today), 7 * k);
    const d = deadlineFor(rule, week);
    for (const s of d.steps) {
      // Before the deadline a reminder is still worth sending late; the one at
      // the deadline goes stale after half a day.
      const until = s.step === 'due' ? shiftClock(d.due, 12 * 60) : d.due;
      if (s.at <= now && now < until) out.push({ ...d, step: s.step, at: s.at });
    }
  }
  return out;
}

/** "9 – 15 November". */
export function weekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const fmt = (d, o) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  return weekStart.slice(0, 7) === end.slice(0, 7)
    ? `${Number(weekStart.slice(8))} – ${fmt(end, { day: 'numeric', month: 'long' })}`
    : `${fmt(weekStart, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short' })}`;
}

/** "Monday 17:00", or "today at 17:00". */
export function sayDue(due, now) {
  const [day, time] = due.split(' ');
  if (now && day === now.slice(0, 10)) return `today at ${time}`;
  return `${sayDate(day)} at ${time}`;
}

/** Active logins, sorted into who plans and who administers. */
export async function draftPeople(db) {
  const rows = ((await db.prepare(
    'SELECT id, name, role, permissions, staff_id FROM users WHERE active = 1 ORDER BY name',
  ).all().catch(() => ({ results: [] }))).results ?? []);
  const admins = rows.filter((u) => u.role === 'admin');
  const planners = rows.filter((u) => u.role !== 'admin' && effectivePermissions(u).includes('att_rota'));
  return { admins, planners };
}

/** Who reviews: the administrators chosen, or every administrator if none is. */
export function reviewersOf(rule, admins) {
  const chosen = admins.filter((a) => rule.reviewers.includes(Number(a.id)));
  return chosen.length ? chosen : admins;
}

/** A review that covers the week and still stands. */
export async function reviewFor(db, weekStart) {
  return db.prepare(
    `SELECT * FROM rota_review WHERE day_from <= ?1 AND day_to >= ?1 AND status IN ('sent', 'approved', 'returned')
      ORDER BY id DESC LIMIT 1`,
  ).bind(weekStart).first().catch(() => null);
}

const WORDS = {
  first: (w, due) => ({
    title: `Draft the rota for ${w} by ${due}`,
    body: 'Put the shifts in as a draft, then press Send for review on the rota.',
  }),
  last: (w, due) => ({
    title: `Due ${due}: the draft rota for ${w}`,
    body: 'Not sent for review yet. Finish the draft and press Send for review on the rota.',
  }),
  due: (w) => ({
    title: `The draft rota for ${w} is late`,
    body: 'It was due now and has not been sent for review. Send it as soon as it is ready.',
  }),
};

/**
 * Every five minutes, from the cron: send whatever reminder is owed, once.
 * Quiet for any week whose draft has been sent for review.
 */
export async function watchRotaDraft(db, { ctx = null } = {}) {
  const rule = await readDraftRule(db);
  if (!rule.on) return { sent: 0 };
  const now = nowIn(rule.timezone);
  const owed = owedNow(rule, now);
  if (!owed.length) return { sent: 0 };
  const { admins, planners } = await draftPeople(db);
  let sent = 0;
  for (const o of owed) {
    // eslint-disable-next-line no-await-in-loop
    const done = await reviewFor(db, o.weekStart);
    if (done && done.status !== 'returned') continue;
    // eslint-disable-next-line no-await-in-loop
    const claim = await db.prepare('INSERT OR IGNORE INTO rota_draft_nudge (week_start, step) VALUES (?1, ?2)')
      .bind(o.weekStart, o.step).run();
    if (!Number(claim?.meta?.changes ?? 0)) continue;
    const week = weekLabel(o.weekStart);
    const words = WORDS[o.step](week, sayDue(o.due, now));
    const link = `#/att-rota?from=${o.weekStart}`;
    // Nobody but administrators plans: they get the reminder itself, once.
    const to = planners.length ? planners : admins;
    for (const u of to) {
      // eslint-disable-next-line no-await-in-loop
      await createNotice(db, {
        kind: 'rota.draft_due', level: o.step === 'due' ? 'warn' : 'info',
        title: words.title, body: words.body, link, userId: u.id, push: true, email: true,
      }, ctx).catch((err) => console.error('rota draft notice failed', err));
      sent += 1;
    }
    if (planners.length && rule.ccAdmins) {
      const names = planners.map((p) => p.name).join(', ');
      const copy = o.step === 'due'
        ? { title: `Not sent for review: the rota for ${week}`, body: `It was due ${sayDue(o.due, now)}. ${names} ${planners.length === 1 ? 'has' : 'have'} been told.` }
        : { title: `Copy: ${words.title}`, body: `Sent to ${names}.` };
      for (const a of admins) {
        // eslint-disable-next-line no-await-in-loop
        await createNotice(db, {
          kind: 'rota.draft_due_copy', level: o.step === 'due' ? 'warn' : 'info',
          ...copy, link, userId: a.id, push: true, email: true,
        }, ctx).catch((err) => console.error('rota draft copy failed', err));
        sent += 1;
      }
    }
  }
  return { sent };
}

/**
 * May a planner publish these days? Only once every day with something
 * waiting to go out is covered by an approved review, and nothing on that
 * day has been changed since it was approved. Administrators always may, and
 * so may everybody when the property has switched the rule off.
 */
export async function publishGate(db, { from, to, role }) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'rota_publish_needs_review'").first().catch(() => null);
  const needed = String(row?.value ?? '1') !== '0' && role !== 'admin';
  if (!needed) return { needed: false, ok: true, waiting: [], changed: [] };
  const days = ((await db.prepare(
    'SELECT DISTINCT day FROM att_roster WHERE day BETWEEN ?1 AND ?2 AND published = 0 ORDER BY day',
  ).bind(from, to).all().catch(() => ({ results: [] }))).results ?? []).map((r) => r.day);
  if (!days.length) return { needed: true, ok: true, waiting: [], changed: [] };
  const approved = ((await db.prepare(
    `SELECT * FROM rota_review WHERE status = 'approved' AND day_from <= ?2 AND day_to >= ?1 ORDER BY decided_at DESC`,
  ).bind(from, to).all().catch(() => ({ results: [] }))).results ?? []);
  const waiting = [];
  const changed = [];
  for (const day of days) {
    const r = approved.find((a) => a.day_from <= day && a.day_to >= day);
    if (!r) { waiting.push(day); continue; }
    // eslint-disable-next-line no-await-in-loop
    const since = await db.prepare(
      "SELECT 1 AS x FROM att_roster_log WHERE day = ?1 AND action != 'published' AND at > ?2 LIMIT 1",
    ).bind(day, r.decided_at).first().catch(() => null);
    if (since) changed.push(day);
  }
  return { needed: true, ok: !waiting.length && !changed.length, waiting, changed };
}
