import { all, first } from '../lib/db.js';
import { addDays } from '../lib/dates.js';
import { callLink } from '../lib/link.js';
import { shifts as shiftsFor, SMALL_BY } from './shifts.js';
import { gatherAdvances } from './advances.js';

/**
 * The daily till summary: one message a morning to the people chosen under
 * Settings → Who is told, in place of one for every shift closed.
 *
 * Yesterday's three shifts with how each drawer came out, and what is waiting
 * for an admin: corrections and answers to approve, money to-do answered,
 * advances overdue, and the small corrections that counted straight away.
 * Things that need a decision are still told the moment they happen; this is
 * the round-up.
 */

const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const cedis = (minor) => `GH₵${(Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const sayDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** What the summary for one day says, with and without amounts. */
export async function summaryFor(env, { day = addDays(today(), -1), on = today(), fetchImpl } = {}) {
  let payload = null;
  try { payload = await shiftsFor(env, { from: day, to: day }, null); } catch { payload = null; }
  const shifts = (payload?.days || []).flatMap((d) => d.shifts || []);
  const reports = env.ATT_DB
    ? await all(env.ATT_DB, 'SELECT slot, name FROM till_report WHERE day = ?1 AND reopened_at IS NULL', day).catch(() => [])
    : [];
  const closedBy = new Map(reports.map((r) => [r.slot, r.name]));

  const lines = ['morning', 'afternoon', 'night'].map((slot) => {
    const s = shifts.find((x) => x.slot === slot);
    const who = closedBy.get(slot) || s?.user || null;
    const label = `${SLOT_LABEL[slot]}${who ? ` · ${who}` : ''}`;
    if (!s) return { label, tone: 'none', with: 'Not in the journal yet', without: 'Not in the journal yet' };
    const v = s.register?.variance;
    if (!closedBy.has(slot)) return { label, tone: 'bad', with: 'No closing report', without: 'No closing report' };
    if (v == null) return { label, tone: 'none', with: 'No count', without: 'No count' };
    if (v === 0) return { label, tone: 'good', with: 'Agrees', without: 'Agrees' };
    return { label, tone: v < 0 ? 'bad' : 'warn', with: `${v < 0 ? 'Short' : 'Over'} ${cedis(v)}`, without: v < 0 ? 'Short' : 'Over' };
  });
  const agree = lines.filter((l) => l.tone === 'good').length;
  const off = lines.filter((l) => l.tone === 'bad' || l.tone === 'warn');

  const count = async (sql, ...binds) => Number((await first(env.DB, sql, ...binds).catch(() => null))?.n ?? 0);
  const [corrections, answers, links, todo, small] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM shift_movement WHERE status = 'pending'"),
    count("SELECT COUNT(*) AS n FROM shift_answer WHERE status = 'pending'"),
    count("SELECT COUNT(*) AS n FROM shift_link WHERE status = 'pending'"),
    count("SELECT COUNT(*) AS n FROM money_todo WHERE state = 'answered'"),
    count('SELECT COUNT(*) AS n FROM shift_movement WHERE decided_by = ?1 AND substr(decided_at, 1, 10) = ?2', SMALL_BY, day),
  ]);
  let overdue = [];
  try { overdue = (await gatherAdvances(env, { fetchImpl, on })).items.filter((x) => x.overdue); } catch { overdue = []; }

  const needs = [
    corrections ? ['Corrections to approve', String(corrections)] : null,
    answers + links ? ['Supervisor answers to approve', String(answers + links)] : null,
    todo ? ['Money to-do answered, waiting for you', String(todo)] : null,
    ...overdue.slice(0, 5).map((x) => [`Advance ${x.po} overdue${x.by ? ` (${x.by})` : ''}`, cedis(x.advanced)]),
    overdue.length > 5 ? [`And ${overdue.length - 5} more advances overdue`, ''] : null,
    small ? ['Small corrections that counted straight away', String(small)] : null,
  ].filter(Boolean);

  const closed = closedBy.size;
  return {
    day,
    title: `${sayDay(day)}: ${closed} shift${closed === 1 ? '' : 's'} closed`,
    sub: off.length ? `${agree} agree · ${off.map((l) => `${l.label.split(' · ')[0].toLowerCase()} ${l.without.toLowerCase()}`).join(' · ')}` : `${agree} of 3 agree`,
    subWith: off.length ? `${agree} agree · ${off.map((l) => `${l.label.split(' · ')[0].toLowerCase()} ${l.with.toLowerCase()}`).join(' · ')}` : `${agree} of 3 agree`,
    lines,
    needs,
  };
}

/** Send yesterday's summary through HIVE to everybody who gets it. Never throws. */
export async function sendDailySummary(env, { fetchImpl, day, on } = {}) {
  try {
    const rows = await all(env.DB, 'SELECT * FROM till_notify WHERE on_closed = 1').catch(() => []);
    const recipients = rows.filter((r) => r.push || r.email).map((r) => ({
      userId: Number(r.hive_user_id), name: r.name, push: Boolean(r.push), email: Boolean(r.email), amounts: Boolean(r.amounts),
    }));
    if (!recipients.length) return { sent: 0, reason: 'nobody gets the daily summary' };
    const summary = await summaryFor(env, { day, on, fetchImpl });
    const out = await callLink({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/summary', what: 'HIVE',
      body: { ...summary, recipients },
    });
    return { sent: recipients.length, ...(out?.ok ? {} : { error: 'HIVE did not take it' }) };
  } catch (err) {
    return { sent: 0, error: String(err?.message || err) };
  }
}
