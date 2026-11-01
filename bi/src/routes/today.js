import { all } from '../lib/db.js';
import { gatherOnce, arrange } from './assistant.js';
import { insightList } from './approvals.js';
import { dutyCard, mondayOf } from './duty.js';
import { roleOf, accessOf } from './till.js';

/**
 * Today: each person's one list. Everything that is theirs, from every page
 * Insight has (to-dos given to them, proof asked, shifts to check, staff
 * answers, envelopes, Nice Place, POs to chase and, for an admin, approvals
 * and the rest), placed by when it wants doing: overdue, today, later. Each
 * line has the button that does it, or opens where it is done.
 *
 * Beside it: the Saturday report's clock (for whoever sends it, and for an
 * admin once it is close), what this person sent up that waits for an
 * admin, their week, and what they did today, read from the audit trail.
 */

const DAY = 86_400_000;
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const plusDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** What each change is called on "Done today". Anything not here counts as another change. */
export const DID = {
  '/api/till/check': 'Checked a shift',
  '/api/till/check/undo': 'Took back a check',
  '/api/shifts/answer': 'Answered a difference',
  '/api/shifts/answer-many': 'Answered differences',
  '/api/shifts/link': 'Reconciled differences together',
  '/api/till/resolve': 'Decided a staff answer',
  '/api/till/approve': 'Approved or sent back an answer',
  '/api/approvals/decide': 'Decided an approval',
  '/api/shifts/tasks': 'Gave a to-do',
  '/api/shifts/tasks/:id/done': 'Finished a to-do',
  '/api/shifts/movement': 'Corrected a cash movement',
  '/api/safe/envelopes/receive': 'Marked envelopes received',
  '/api/np/pickups/record': 'Made a Nice Place pickup',
  '/api/np/reading': 'Read a Nice Place counter',
  '/api/proof/send': 'Sent proof',
  '/api/proof/ask': 'Asked for proof',
  '/api/todo/:id/answer': 'Answered a PO item',
  '/api/till/charge': 'Put a difference on a staff account',
  '/api/suspense/add': 'Put a difference in suspense',
  '/api/shifts/journal': 'Loaded the journal',
  '/api/shifts/terminal': 'Loaded the terminal report',
  '/api/shifts/bank': 'Loaded the bank statement',
  '/api/reports/management/send': 'Sent the management report',
};

/** The changes this account made that went through, since a moment, from the audit trail. */
async function didSince(env, account, since) {
  if (account?.id == null) return [];
  return all(env.DB, `SELECT a.path, d.at FROM audit_event a
      JOIN audit_event d ON d.request_id = a.request_id AND d.stage = 'done'
      WHERE a.stage = 'asked' AND a.account_id = ?1 AND a.at >= ?2 ORDER BY d.at`,
  Number(account.id), since).catch(() => []);
}

/** Today's changes in words: the same kind once, with how many and the last time. */
export function doneWords(rows) {
  const by = new Map();
  let other = 0;
  for (const r of rows) {
    const words = DID[r.path];
    if (!words) { other += 1; continue; }
    const had = by.get(words) || { what: words, n: 0, at: null };
    had.n += 1;
    had.at = String(r.at).slice(11, 16);
    by.set(words, had);
  }
  return { lines: [...by.values()], other };
}

/** Shifts of the last seven days, up to yesterday and the last day loaded, and how many are checked. */
async function checkedLately(env, now) {
  const last = (await all(env.DB, "SELECT MAX(to_day) AS to_day FROM shift_upload WHERE kind = 'journal'").catch(() => []))[0]?.to_day;
  if (!last) return null;
  const today = dayOf(now);
  const to = [plusDay(today, -1), last].sort()[0];
  const from = plusDay(today, -7);
  if (to < from) return null;
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY) + 1;
  const done = (await all(env.DB, 'SELECT COUNT(*) AS n FROM shift_check WHERE day BETWEEN ?1 AND ?2', from, to).catch(() => []))[0]?.n || 0;
  return { checked: Number(done), of: days * 3 };
}

/** What this person sent up that waits for an admin: a supervisor's answers, reconciliations, accepts and corrections. */
async function sentUp(env, account) {
  const name = account?.name || account?.email;
  if (!name) return [];
  const { items } = await insightList(env).catch(() => ({ items: [] }));
  return items.filter((x) => x.who === name).map((x) => ({ key: `${x.kind}:${x.id}`, title: x.title, why: x.sub, at: x.askedAt, kind: x.kindLabel }));
}

/** The whole page. */
export async function today(env, account, { now = Date.now() } = {}) {
  const day = dayOf(now);
  const role = roleOf(account);
  const admin = role === 'admin';
  // Kept a minute, so the summary and Ask that follow the page use the same list.
  const data = await gatherOnce(env, account, { fresh: true, now });
  const items = arrange(data.items.filter((x) => x.tab !== 'done'), day);
  const done = data.items.filter((x) => x.tab === 'done');
  const access = admin || role !== 'supervisor' ? {} : await accessOf(env, account).catch(() => ({}));
  const [duty, waiting, week, todayRows, checks] = await Promise.all([
    dutyCard(env, account, { now, admin }).catch(() => null),
    admin ? [] : sentUp(env, account),
    didSince(env, account, `${mondayOf(day)} 00:00:00`),
    didSince(env, account, `${day} 00:00:00`),
    admin || (access.check || 0) >= 1 ? checkedLately(env, now) : null,
  ]);
  const counts = { overdue: 0, today: 0, later: 0 };
  for (const x of items) counts[x.when] += 1;
  const areas = {};
  for (const x of items) areas[x.area] = (areas[x.area] || 0) + 1;
  return {
    ...data,
    day,
    items: [...items, ...done],
    counts: { ...data.counts, ...counts, all: items.length },
    areas,
    duty,
    waiting,
    week: {
      did: week.length,
      overdue: counts.overdue,
      checks,
      report: duty?.mine || admin ? duty?.last || null : null,
    },
    doneToday: { ...doneWords(todayRows), byInsight: done },
  };
}
