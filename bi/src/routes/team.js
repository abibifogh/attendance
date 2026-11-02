import { all, first, getSettings, run, setSetting } from '../lib/db.js';
import { badRequest, forbidden, notFound, str } from '../lib/http.js';
import { addDays, todayIn } from '../lib/dates.js';
import { roleOf } from './till.js';
import * as mgmt from './mgmt.js';
import { pos } from './approvals.js';

/**
 * Team: what is on each person's table, and how they are doing.
 *
 * Everybody in HIVE (its staff list), matched to the other apps by their
 * email, as Today matches them. For each, in one shape whatever the app:
 * what they are doing now, what is coming up, what is overdue, what they did,
 * what they asked for, and what is holding them back (anything of theirs
 * waiting on somebody else). Read from:
 *
 *  - HIVE (its database, bound as ATT_DB): shifts on the rota and worked,
 *    lateness, leave, sick notes owed, swaps, advances, medical claims,
 *    attendance queries;
 *  - Insight: to-dos given, POs to chase and store requests given to them,
 *    proof asked of them, float receipts;
 *  - the breakfast app (BREAKFAST_DB): what they asked the store room for;
 *  - Maintenance and Team Tasks: the `tasks` function's `activity`;
 *  - the POS: its notify function's `/team/activity`.
 *  An app not linked, or not answering, is left out and said so; the rest
 *  still shows.
 *
 * The evaluation: eight measures, each 1 to 5, over the last three months,
 * each person against the others in the same role and against themselves.
 * Time held back by somebody else is taken out before anything counts as
 * late; a measure with too little to go on is not scored (a dash, not a low
 * mark). An admin weights them, adds measures of their own (scored by hand),
 * and keeps notes. Admins only, unless an admin lets people see their own.
 */

const DAY_MS = 86_400_000;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const isDay = (d) => /^\d{4}-\d\d-\d\d$/.test(String(d || ''));
const dayOf = (iso) => (iso ? String(iso).replace(' ', 'T').slice(0, 10) : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);
const hoursBetween = (a, b) => (Date.parse(String(b).replace(' ', 'T').replace(/Z?$/, 'Z')) - Date.parse(String(a).replace(' ', 'T').replace(/Z?$/, 'Z'))) / 3_600_000;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const round1 = (x) => Math.round(x * 10) / 10;
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const EVAL_DAYS = 91;
/** Fewer than this many things to go on: the measure is not scored. */
const ENOUGH = 3;

export const APPS = {
  hive: 'HIVE', insight: 'Insight', breakfast: 'Breakfast', maintenance: 'Maintenance', teamtasks: 'Team Tasks', pos: 'POS',
};

/** The eight measures, in the order they are shown. */
export const MEASURES = [
  { id: 'turns_up', label: 'Turns up', what: 'shifts worked, absences, sick days' },
  { id: 'on_time', label: 'On time', what: 'clock-ins against the rota' },
  { id: 'gets_done', label: 'Gets it done', what: 'done by the due date' },
  { id: 'throughput', label: 'Gets through work', what: 'done per shift, against others in the same role' },
  { id: 'answers', label: 'Answers', what: 'to-dos, proof asked, attendance queries' },
  { id: 'first_time', label: 'Done right first time', what: 'reopened or sent back' },
  { id: 'routine', label: 'Follows the routine', what: 'rounds, week plans, counts, shifts closed' },
  { id: 'money', label: 'Money and stock', what: 'float receipts, counts and charges' },
];

// ------------------------------------------------------------ settings --

const SETTING = 'team_settings';

/** Weights (0 to 3, 1 by default), the admin's own measures, and whether people see their own. */
export async function settingsOf(env) {
  let s = {};
  try { s = JSON.parse((await getSettings(env.DB).catch(() => ({})))[SETTING] || '{}'); } catch { s = {}; }
  const weights = {};
  for (const m of MEASURES) weights[m.id] = Number.isFinite(Number(s.weights?.[m.id])) ? clamp(Number(s.weights[m.id]), 0, 3) : 1;
  const custom = (Array.isArray(s.custom) ? s.custom : []).filter((c) => c && c.id && c.label)
    .map((c) => ({ id: String(c.id), label: String(c.label).slice(0, 60), what: String(c.what || 'scored by an admin').slice(0, 120), weight: Number.isFinite(Number(c.weight)) ? clamp(Number(c.weight), 0, 3) : 1 }));
  return { weights, custom, showOwn: Boolean(s.showOwn) };
}

/** An admin changes weights, adds or takes off a measure of their own, or lets people see their own. */
export async function saveSettings(env, body, account) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can do that.');
  const s = await settingsOf(env);
  if (body?.weights && typeof body.weights === 'object') {
    for (const [k, v] of Object.entries(body.weights)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 3) throw badRequest('A weight is 0 (not counted) to 3 (counts three times).');
      if (s.weights[k] !== undefined) s.weights[k] = n;
      const c = s.custom.find((x) => x.id === k);
      if (c) c.weight = n;
    }
  }
  if (body?.add) {
    const label = str(body.add.label, 'The measure’s name', { required: true, max: 60 });
    const id = `c_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)}_${Date.now().toString(36)}`;
    s.custom.push({ id, label, what: str(body.add.what, 'What it is about', { max: 120 }) || 'scored by an admin', weight: 1 });
  }
  if (body?.remove) s.custom = s.custom.filter((c) => c.id !== body.remove);
  if (body?.showOwn !== undefined) s.showOwn = Boolean(body.showOwn);
  await setSetting(env.DB, SETTING, JSON.stringify(s));
  return settingsOf(env);
}

// ------------------------------------------------------------ people --

/** Everybody in HIVE still working here: name, role, email, and their Insight account if they have one. */
export async function members(env) {
  if (!env.ATT_DB) return [];
  const rows = await all(env.ATT_DB, `SELECT s.id, s.name, s.department, s.job_title, s.employee_no, u.id AS user_id, LOWER(u.email) AS email
    FROM att_staff s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.active = 1 AND (s.left_on IS NULL OR s.left_on = '' OR s.left_on > date('now')) ORDER BY s.name`).catch(() => []);
  const accounts = await all(env.DB, 'SELECT id, LOWER(email) AS email FROM accounts WHERE active = 1 AND email IS NOT NULL').catch(() => []);
  const byEmail = new Map(accounts.map((a) => [a.email, a.id]));
  return rows.map((r) => ({
    id: Number(r.id), name: r.name, role: r.job_title || r.department || 'Staff', department: r.department || null,
    email: r.email || null, hiveUser: r.user_id ? Number(r.user_id) : null, accountId: r.email ? byEmail.get(r.email) ?? null : null,
  }));
}

// ------------------------------------------------------------ reading --

/** One thing, in the one shape every app gives. */
const item = (x) => ({
  id: x.id, app: x.app, kind: x.kind, title: x.title, status: x.status || 'open', routine: Boolean(x.routine), asked: Boolean(x.asked),
  decision: x.decision || null, due: x.due || null, created_at: x.created_at || null, started_at: x.started_at || null, done_at: x.done_at || null,
  waiting_on: x.waiting_on || null, waiting_since: x.waiting_since || null, waited_days: Number(x.waited_days) || 0, reopened: Number(x.reopened) || 0,
  category: x.category || null, money_issue: Boolean(x.money_issue), amount: x.amount ?? null, link: x.link || null,
  late_minutes: x.late_minutes ?? null, weekday: x.weekday ?? null,
  // Something they were asked to answer (a to-do, proof, a query): how fast they answered counts.
  answered: Boolean(x.answered),
  // Something with money in it (a float receipt, a count, a charge): for "Money and stock".
  money: Boolean(x.money) || ['count', 'shop_count', 'charge', 'spend'].includes(x.kind),
});

/** HIVE: shifts, lateness, leave, sick notes, swaps, advances, medical claims, queries. */
async function fromHive(env, people, from, to, today) {
  const out = new Map(people.map((p) => [p.id, []]));
  if (!env.ATT_DB || !people.length) return { out, ok: Boolean(env.ATT_DB) };
  const ids = people.map((p) => p.id);
  const inList = ids.map((_, i) => `?${i + 3}`).join(', ');
  const db = env.ATT_DB;
  const shifts = await all(db, `SELECT d.staff_id, d.day, d.scheduled, d.first_in, d.last_out, d.late_minutes, d.status, d.leave_id, sh.name AS shift, sh.starts_at
    FROM att_days d LEFT JOIN att_shifts sh ON sh.id = d.shift_id WHERE d.day BETWEEN ?1 AND ?2 AND d.staff_id IN (${inList})`, from, to, ...ids).catch(() => []);
  for (const d of shifts) {
    if (!d.scheduled && !d.first_in) continue;
    if (['leave', 'holiday', 'rest'].includes(d.status)) continue;
    const worked = Boolean(d.first_in);
    const doing = worked && !d.last_out && d.day === today;
    out.get(d.staff_id)?.push(item({
      id: `shift:${d.staff_id}:${d.day}`, app: 'hive', kind: 'shift', routine: true, due: d.day,
      title: `${d.shift || 'Shift'}${d.starts_at ? ` from ${String(d.starts_at).slice(0, 5)}` : ''}`,
      status: doing ? 'doing' : worked ? 'done' : d.day < today ? 'missed' : 'open',
      started_at: d.first_in ? `${d.day}T${String(d.first_in).slice(-8)}` : null, done_at: worked ? `${d.day}T${String(d.last_out || d.first_in).slice(-8)}` : null,
      late_minutes: worked ? Number(d.late_minutes) || 0 : null, weekday: new Date(`${d.day}T12:00:00Z`).getUTCDay(),
    }));
  }
  // The rota ahead: coming up.
  const ahead = await all(db, `SELECT r.staff_id, r.day, sh.name AS shift, sh.starts_at FROM att_roster r LEFT JOIN att_shifts sh ON sh.id = r.shift_id
    WHERE r.day > ?1 AND r.day <= ?2 AND r.shift_id IS NOT NULL AND r.staff_id IN (${inList})`, today, to, ...ids).catch(() => []);
  for (const r of ahead) {
    if ((out.get(r.staff_id) || []).some((x) => x.id === `shift:${r.staff_id}:${r.day}`)) continue;
    out.get(r.staff_id)?.push(item({ id: `shift:${r.staff_id}:${r.day}`, app: 'hive', kind: 'shift', routine: true, due: r.day, status: 'open',
      title: `${r.shift || 'Shift'}${r.starts_at ? ` from ${String(r.starts_at).slice(0, 5)}` : ''}` }));
  }
  const asked = (id, x) => out.get(id)?.push(item({ app: 'hive', asked: true, ...x }));
  const decided = (status, waiting, yes) => (waiting.includes(status) ? 'waiting' : yes.includes(status) ? 'approved' : 'refused');
  // Leave (not sick leave, which is not asked for).
  for (const l of await all(db, `SELECT * FROM att_leave WHERE staff_id IN (${inList}) AND (status = 'pending' OR requested_at >= ?1 OR to_day >= ?1) AND requested_at <= ?2 || ' 23:59:59'`, from, to, ...ids).catch(() => [])) {
    if (l.status === 'withdrawn' || l.status === 'cancelled') continue;
    asked(l.staff_id, { id: `leave:${l.id}`, kind: 'leave', title: `Leave ${shortDay(l.from_day)}${l.to_day !== l.from_day ? ` to ${shortDay(l.to_day)}` : ''}`, created_at: l.requested_at,
      decision: decided(l.status, ['pending'], ['approved']), status: l.status === 'pending' ? 'open' : 'done', done_at: l.decided_at,
      waiting_on: l.status === 'pending' ? 'An admin to decide the leave' : null, waiting_since: l.status === 'pending' ? l.requested_at : null });
  }
  for (const a of await all(db, `SELECT * FROM hr_advance WHERE staff_id IN (${inList}) AND (status = 'requested' OR asked_at >= ?1) AND asked_at <= ?2 || ' 23:59:59'`, from, to, ...ids).catch(() => [])) {
    if (a.status === 'withdrawn') continue;
    asked(a.staff_id, { id: `advance:${a.id}`, kind: 'advance', title: `Advance GH₵ ${Number(a.amount).toLocaleString('en-GB')}`, created_at: a.asked_at,
      decision: decided(a.status, ['requested'], ['approved', 'settled']), status: a.status === 'requested' ? 'open' : 'done', done_at: a.decided_at,
      waiting_on: a.status === 'requested' ? 'An admin to decide the advance' : null, waiting_since: a.status === 'requested' ? a.asked_at : null });
  }
  for (const c of await all(db, `SELECT * FROM hr_medical_claim WHERE staff_id IN (${inList}) AND (status = 'requested' OR asked_at >= ?1) AND asked_at <= ?2 || ' 23:59:59'`, from, to, ...ids).catch(() => [])) {
    if (c.status === 'withdrawn') continue;
    asked(c.staff_id, { id: `medical:${c.id}`, kind: 'medical', title: `Medical claim GH₵ ${Number(c.amount).toLocaleString('en-GB')}${c.what ? `, ${c.what}` : ''}`, created_at: c.asked_at,
      decision: decided(c.status, ['requested'], ['approved', 'paid']), status: c.status === 'requested' ? 'open' : 'done', done_at: c.decided_at,
      waiting_on: c.status === 'requested' ? 'An admin to decide the claim' : null, waiting_since: c.status === 'requested' ? c.asked_at : null });
  }
  for (const s of await all(db, `SELECT * FROM att_swap WHERE from_staff IN (${inList.replace(/\?(\d+)/g, (_, n) => `?${Number(n) - 2}`)}) AND day >= ?${ids.length + 1}`, ...ids, from).catch(() => [])) {
    if (['withdrawn', 'cancelled'].includes(s.status)) continue;
    asked(s.from_staff, { id: `swap:${s.id}`, kind: 'swap', title: `Swap the ${s.day} shift`, created_at: s.created_at || null,
      decision: decided(s.status, ['open', 'claimed'], ['approved', 'done']), status: ['open', 'claimed'].includes(s.status) ? 'open' : 'done',
      waiting_on: ['open', 'claimed'].includes(s.status) ? (s.status === 'claimed' ? 'An admin to approve the swap' : 'Somebody to take the shift') : null });
  }
  // What they owe: a sick note, an answer to an attendance query.
  for (const n of await all(db, `SELECT * FROM att_sick_note WHERE staff_id IN (${inList}) AND (status = 'owed' OR due_on >= ?1) AND due_on <= ?2`, from, to, ...ids).catch(() => [])) {
    out.get(n.staff_id)?.push(item({ id: `sicknote:${n.leave_id}`, app: 'hive', kind: 'sick_note', title: 'Send the sick note', due: n.due_on,
      status: n.status === 'owed' ? 'open' : 'done', created_at: n.created_at, done_at: n.sent_at }));
  }
  for (const q of await all(db, `SELECT * FROM att_query WHERE staff_id IN (${inList}) AND (status = 'open' OR raised_at >= ?1) AND raised_at <= ?2 || ' 23:59:59'`, from, to, ...ids).catch(() => [])) {
    out.get(q.staff_id)?.push(item({ id: `query:${q.id}`, app: 'hive', kind: 'query', title: `Answer the attendance query, ${q.from_day} to ${q.to_day}`,
      status: q.status === 'open' ? 'open' : 'done', created_at: q.raised_at, done_at: q.closed_at, due: addDays(dayOf(q.raised_at), 3), answered: true }));
  }
  return { out, ok: true };
}

/** Insight: to-dos given, POs to chase and store requests given, proof asked, float receipts (by name). */
async function fromInsight(env, people, from, to) {
  const out = new Map(people.map((p) => [p.id, []]));
  const byAccount = new Map(people.filter((p) => p.accountId).map((p) => [p.accountId, p.id]));
  const byHive = new Map(people.filter((p) => p.hiveUser).map((p) => [p.hiveUser, p.id]));
  const accounts = [...byAccount.keys()];
  const end = `${to} 23:59:59`;
  if (accounts.length) {
    const inA = accounts.map((_, i) => `?${i + 3}`).join(', ');
    for (const t of await all(env.DB, `SELECT * FROM shift_task WHERE for_id IN (${inA}) AND state != 'removed' AND (state = 'open' OR made_at >= ?1 OR done_at >= ?1) AND made_at <= ?2`, from, end, ...accounts).catch(() => [])) {
      out.get(byAccount.get(t.for_id))?.push(item({ id: `todo:${t.id}`, app: 'insight', kind: 'todo', title: t.what, due: t.due, status: t.state === 'done' ? 'done' : 'open',
        created_at: t.made_at, done_at: t.done_at, link: '#/inbox', answered: true }));
    }
    for (const t of await all(env.DB, `SELECT * FROM money_todo WHERE assignee_id IN (${inA}) AND (state != 'closed' OR opened_at >= ?1 OR closed_at >= ?1) AND opened_at <= ?2`, from, end, ...accounts).catch(() => [])) {
      let d = {};
      try { d = JSON.parse(t.detail || '{}'); } catch { d = {}; }
      out.get(byAccount.get(t.assignee_id))?.push(item({
        id: `money:${t.id}`, app: 'insight', kind: t.kind === 'store' ? 'store_issue' : 'po_todo',
        title: t.kind === 'store' ? `Issue ${t.ref} for ${d.department || 'the kitchen'}` : `${t.ref}: ${({ unbilled: 'get the bill posted', differs: 'paid is not the PO', placeholder: 'put in the real vendor or item' })[t.kind] || 'to chase'}`,
        status: t.state === 'closed' ? 'done' : 'open', created_at: t.opened_at, done_at: t.closed_at,
        due: t.kind === 'store' ? dayOf(t.opened_at) : addDays(dayOf(t.opened_at), 7),
        waiting_on: t.state === 'answered' ? 'An admin to decide the answer' : null, waiting_since: t.state === 'answered' ? t.answered_at : null,
        reopened: t.sent_back ? 1 : 0, link: '#/inbox',
      }));
    }
    for (const r of await all(env.DB, `SELECT * FROM proof_request WHERE asked_account IN (${inA}) AND (status = 'asked' OR asked_at >= ?1) AND asked_at <= ?2`, from, end, ...accounts).catch(() => [])) {
      out.get(byAccount.get(r.asked_account))?.push(item({ id: `proof:${r.id}`, app: 'insight', kind: 'proof', title: `Send proof: ${r.about || 'an answer'}`,
        status: r.status === 'asked' ? 'open' : 'done', created_at: r.asked_at, done_at: r.replied_at, due: addDays(dayOf(r.asked_at), 2), link: '#/inbox', answered: true }));
    }
  }
  // Proof asked of a HIVE user directly (a staff answer from My till).
  const hiveUsers = [...byHive.keys()];
  if (hiveUsers.length) {
    const inH = hiveUsers.map((_, i) => `?${i + 3}`).join(', ');
    for (const r of await all(env.DB, `SELECT * FROM proof_request WHERE asked_hive IN (${inH}) AND (status = 'asked' OR asked_at >= ?1) AND asked_at <= ?2`, from, end, ...hiveUsers).catch(() => [])) {
      out.get(byHive.get(r.asked_hive))?.push(item({ id: `proof:${r.id}`, app: 'insight', kind: 'proof', title: `Send proof: ${r.about || 'an answer'}`,
        status: r.status === 'asked' ? 'open' : 'done', created_at: r.asked_at, done_at: r.replied_at, due: addDays(dayOf(r.asked_at), 2), answered: true }));
    }
  }
  // Float receipts, by the float holder's name matching theirs exactly.
  const names = new Map(people.map((p) => [String(p.name).trim().toLowerCase(), p.id]));
  for (const r of await all(env.DB, `SELECT f.id, f.ref, f.status, f.at, f.decided_at, p.name FROM float_receipt f JOIN float_person p ON p.id = f.person_id
    WHERE f.at BETWEEN ?1 AND ?2`, from, end).catch(() => [])) {
    const id = names.get(String(r.name).trim().toLowerCase());
    if (!id) continue;
    out.get(id).push(item({ id: `float:${r.id}`, app: 'insight', kind: 'float_receipt', title: `Float receipt ${r.ref}`, status: r.status === 'checking' ? 'open' : 'done',
      created_at: r.at, done_at: r.decided_at, money_issue: r.status === 'refused', money: true,
      waiting_on: r.status === 'checking' ? 'The office to check the receipt' : null, waiting_since: r.status === 'checking' ? r.at : null }));
  }
  return { out, ok: true };
}

/** The breakfast app: what they asked the store room for, by their email there. */
async function fromBreakfast(env, people, from, to) {
  const out = new Map(people.map((p) => [p.id, []]));
  if (!env.BREAKFAST_DB) return { out, ok: false };
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email, p.id]));
  const users = await all(env.BREAKFAST_DB, 'SELECT id, LOWER(email) AS email FROM users WHERE email IS NOT NULL').catch(() => []);
  const userTo = new Map(users.filter((u) => byEmail.has(u.email)).map((u) => [Number(u.id), byEmail.get(u.email)]));
  if (!userTo.size) return { out, ok: true };
  const rows = await all(env.BREAKFAST_DB, `SELECT * FROM store_requests WHERE (status = 'waiting' OR created_at >= ?1) AND created_at <= ?2`, from, `${to} 23:59:59`).catch(() => null);
  if (!rows) return { out, ok: false };
  for (const r of rows) {
    const id = userTo.get(Number(r.requested_by_id));
    if (!id) continue;
    const waiting = r.status === 'waiting';
    out.get(id).push(item({ id: `store:${r.id}`, app: 'breakfast', kind: 'store_request', title: `Store request R-${String(r.id).padStart(4, '0')} (${r.department || 'Kitchen'})`,
      asked: true, decision: waiting ? 'waiting' : ['issued', 'received'].includes(r.status) ? 'approved' : 'refused',
      status: waiting ? 'open' : 'done', created_at: r.created_at, done_at: r.issued_at || r.closed_at,
      waiting_on: waiting ? 'The store room to issue it' : null, waiting_since: waiting ? r.created_at : null }));
  }
  return { out, ok: true };
}

/** Maintenance and Team Tasks, and the POS: their `activity`, for everybody with an email, in one call each. */
export const io = { fetch: (...a) => fetch(...a) };
const tasksUrl = (env) => env.MAINTENANCE_TASKS_URL
  || (env.MAINTENANCE_APPROVALS_URL ? String(env.MAINTENANCE_APPROVALS_URL).replace(/\/approvals\/?$/, '/tasks') : null);

async function fromApps(env, people, from, to) {
  const emails = [...new Set(people.map((p) => p.email).filter(Boolean))].slice(0, 200);
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email, p.id]));
  const out = new Map(people.map((p) => [p.id, []]));
  const said = {};
  const take = (answer, app) => {
    for (const [email, v] of Object.entries(answer?.people || {})) {
      const id = byEmail.get(String(email).toLowerCase());
      if (!id) continue;
      for (const x of v.items || []) out.get(id).push(item({ ...x, app: x.app || app }));
    }
  };
  const jobs = [];
  if (emails.length && env.SSO_SECRET_MAINTENANCE && tasksUrl(env)) {
    jobs.push(mgmt.ask({ url: tasksUrl(env), secret: env.SSO_SECRET_MAINTENANCE, path: '/tasks', body: { action: 'activity', emails, from, to }, fetchImpl: io.fetch, what: 'Maintenance' })
      .then((a) => { take(a, 'maintenance'); said.maintenance = 'ok'; }).catch((err) => { said.maintenance = String(err?.message || err).slice(0, 200); }));
  } else said.maintenance = 'not linked';
  if (emails.length) {
    jobs.push(pos(env, '/team/activity', { emails, from, to }, { fetchImpl: io.fetch })
      .then((a) => { take(a, 'pos'); said.pos = 'ok'; }).catch((err) => { said.pos = String(err?.message || err).slice(0, 200); }));
  }
  await Promise.all(jobs);
  return { out, said };
}

/** Each person and everything of theirs, for one period, from every app. Kept for two minutes. */
const kept = new Map();
export async function gatherTeam(env, { from, to, today }) {
  const key = `${from}|${to}|${today}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < 120_000 && hit.env === env) return hit.value;
  const people = await members(env);
  const [hive, ins, bf, apps] = await Promise.all([
    fromHive(env, people, from, to, today), fromInsight(env, people, from, to), fromBreakfast(env, people, from, to), fromApps(env, people, from, to),
  ]);
  const value = {
    people: people.map((p) => ({ ...p, items: [hive, ins, bf, apps].flatMap((s) => s.out.get(p.id) || []) })),
    sources: { hive: hive.ok ? 'ok' : 'not linked', insight: 'ok', breakfast: bf.ok ? 'ok' : 'not linked', ...apps.said },
  };
  kept.set(key, { at: Date.now(), env, value });
  if (kept.size > 20) kept.delete(kept.keys().next().value);
  return value;
}

// ------------------------------------------------------------ sorting --

/** Where a thing stands on a day: doing, overdue, due, done, or nowhere. */
export function placeOf(x, today) {
  if (x.status === 'doing') return 'doing';
  if (x.status === 'cancelled') return null;
  if (x.status === 'done') return 'done';
  if (x.status === 'missed') return 'missed';
  if (x.due && x.due < today) return 'overdue';
  return 'due';
}

/** What a period is: a day, the week (Monday to Sunday) or the month it is in. */
export function periodOf(period, day) {
  const d = isDay(day) ? day : todayIn('UTC');
  if (period === 'day') return { period: 'day', from: d, to: d };
  if (period === 'month') {
    const from = `${d.slice(0, 7)}-01`;
    const next = new Date(`${from}T12:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    return { period: 'month', from, to: addDays(next.toISOString().slice(0, 10), -1) };
  }
  const dow = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
  const from = addDays(d, -dow);
  return { period: 'week', from, to: addDays(from, 6) };
}

/** One person's things for a period, sorted into the lists the page shows. */
export function sortOut(items, { from, to, today }) {
  const lists = { doing: [], due: [], overdue: [], done: [], asked: [], held: [] };
  const inPeriod = (d) => d && d >= from && d <= to;
  for (const x of items) {
    if (x.asked) {
      if (x.decision === 'waiting' || inPeriod(dayOf(x.created_at)) || inPeriod(dayOf(x.done_at))) lists.asked.push(x);
      if (x.decision === 'waiting') lists.held.push({ ...x, why: x.waiting_on || 'Waiting for a decision' });
      continue;
    }
    const at = placeOf(x, today);
    // On shift now is said under Today, not as something they are doing.
    if (at === 'doing' && x.kind === 'shift') continue;
    if (at === 'doing') lists.doing.push(x);
    else if (at === 'overdue') lists.overdue.push(x);
    else if (at === 'missed') { if (inPeriod(x.due)) lists.overdue.push({ ...x, missed: true }); }
    else if (at === 'due') { if (!x.due || x.due <= to) lists.due.push(x); }
    else if (at === 'done' && inPeriod(dayOf(x.done_at))) lists.done.push({ ...x, onTime: onTime(x) });
    if (x.waiting_on && ['open', 'doing'].includes(x.status)) lists.held.push({ ...x, why: x.waiting_on });
  }
  const byDue = (a, b) => String(a.due || '9').localeCompare(String(b.due || '9'));
  lists.overdue.sort(byDue); lists.due.sort(byDue);
  lists.done.sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  lists.held.sort((a, b) => String(a.waiting_since || '9').localeCompare(String(b.waiting_since || '9')));
  return lists;
}

/** Done by its due date, allowing for days it was held by somebody else. No due date: done. */
export function onTime(x) {
  if (!x.due || !x.done_at) return x.status === 'done';
  const late = daysBetween(x.due, dayOf(x.done_at));
  return late - (Number(x.waited_days) || 0) <= 0;
}

/** Today in HIVE: on shift (and when they came), late, off, or on leave. */
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Each person's items for today, when the period being looked at is another one: for the Today column. */
async function todayItems(env, p, today, people) {
  if (p.from <= today && today <= p.to) return new Map(people.map((m) => [m.id, m.items]));
  const now = await gatherTeam(env, { ...periodOf('day', today), today });
  return new Map(now.people.map((m) => [m.id, m.items]));
}

function todayOf(items, today) {
  const s = items.find((x) => x.kind === 'shift' && x.due === today);
  if (!s) return { state: 'off', words: 'Off today' };
  if (s.status === 'missed') return { state: 'late', words: 'Not in' };
  if (!s.started_at) return { state: 'off', words: `Due ${s.title.replace(/^.* from /, '')}` };
  const t = String(s.started_at).slice(11, 16);
  if (s.status === 'doing') return { state: (s.late_minutes || 0) > 0 ? 'late' : 'on', words: `${(s.late_minutes || 0) > 0 ? 'Late' : 'On shift'} · ${t}` };
  return { state: 'done', words: `Worked · in ${t}` };
}

// ------------------------------------------------------------ the pages --

function mustAdmin(account) {
  if (roleOf(account) !== 'admin') throw forbidden('Team is for admins.');
}

const brief = (x) => ({
  id: x.id, app: x.app, appLabel: APPS[x.app] || x.app, kind: x.kind, title: x.title, status: x.status, due: x.due, doneAt: x.done_at, createdAt: x.created_at,
  startedAt: x.started_at, waitingOn: x.waiting_on || x.why || null, waitingSince: x.waiting_since, decision: x.decision, onTime: x.onTime ?? null, missed: Boolean(x.missed),
  link: x.link, lateMinutes: x.late_minutes,
});

/** Everybody, for a period: their counts, today, the first thing holding them back, and their rating. */
export async function overview(env, query, account) {
  mustAdmin(account);
  const p = periodOf(query?.period, query?.day);
  const today = todayIn('UTC');
  const { people, sources } = await gatherTeam(env, { ...p, today });
  const evals = await evaluateAll(env, today);
  const nowItems = await todayItems(env, p, today, people);
  const rows = people.map((m) => {
    const l = sortOut(m.items, { ...p, today });
    const done = l.done.filter((x) => x.kind !== 'shift');
    const ev = evals.get(m.id);
    return {
      id: m.id, name: m.name, role: m.role, department: m.department, email: m.email, today: todayOf(nowItems.get(m.id) || [], today),
      doing: l.doing.length, due: l.due.filter((x) => x.kind !== 'shift').length, overdue: l.overdue.length, done: done.length,
      doneOnTime: done.filter((x) => x.onTime).length, asked: l.asked.length,
      held: l.held.slice(0, 2).map((x) => ({ title: x.title, why: x.why, since: x.waiting_since, days: x.waiting_since ? Math.max(0, daysBetween(dayOf(x.waiting_since), today)) : null })),
      heldCount: l.held.length, rating: ev ? { score: ev.score, trend: ev.trend } : null,
    };
  }).sort((a, b) => (b.overdue + b.heldCount) - (a.overdue + a.heldCount) || a.name.localeCompare(b.name));
  const all_ = rows.reduce((t, r) => ({ overdue: t.overdue + r.overdue, due: t.due + r.due, done: t.done + r.done, onTime: t.onTime + r.doneOnTime }), { overdue: 0, due: 0, done: 0, onTime: 0 });
  const waitingAdmin = people.reduce((t, m) => t + sortOut(m.items, { ...p, today }).held.filter((x) => /admin/i.test(x.why || '')).length, 0);
  return {
    ...p, today, rows, sources,
    tiles: {
      overdue: all_.overdue, overduePeople: rows.filter((r) => r.overdue).length, waitingAdmin, due: all_.due, done: all_.done,
      onTimePct: all_.done ? Math.round((all_.onTime / all_.done) * 100) : null,
      away: rows.filter((r) => ['off'].includes(r.today.state) && /leave/i.test(r.today.words)).map((r) => r.name),
    },
    departments: [...new Set(rows.map((r) => r.department).filter(Boolean))].sort(),
  };
}

/** One person, for a period: the four lists, what they asked for, and what is holding them back. A month adds its days. */
export async function person(env, id, query, account) {
  mustAdmin(account);
  const p = periodOf(query?.period, query?.day);
  const today = todayIn('UTC');
  const { people, sources } = await gatherTeam(env, { ...p, today });
  const m = people.find((x) => x.id === Number(id));
  if (!m) throw notFound('Nobody by that number in HIVE.');
  const l = sortOut(m.items, { ...p, today });
  const nowItems = await todayItems(env, p, today, [m]);
  const done = l.done.filter((x) => x.kind !== 'shift');
  const shifts = l.done.filter((x) => x.kind === 'shift');
  const out = {
    ...p, today, sources,
    person: { id: m.id, name: m.name, role: m.role, department: m.department, email: m.email, today: todayOf(nowItems.get(m.id) || [], today), matched: { insight: Boolean(m.accountId), email: Boolean(m.email) } },
    counts: { doing: l.doing.length, due: l.due.filter((x) => x.kind !== 'shift').length, overdue: l.overdue.length, done: done.length, onTime: done.length ? Math.round((done.filter((x) => x.onTime).length / done.length) * 100) : null, asked: l.asked.length },
    lists: {
      doing: l.doing.map(brief), due: l.due.map(brief), overdue: l.overdue.map(brief), done: done.map(brief), asked: l.asked.map((x) => ({ ...brief(x), waited: x.created_at ? Math.max(0, daysBetween(dayOf(x.created_at), today)) : null })),
      held: l.held.map((x) => ({ ...brief(x), days: x.waiting_since ? Math.max(0, daysBetween(dayOf(x.waiting_since), today)) : null })),
    },
    shifts: { worked: shifts.length, late: shifts.filter((x) => (x.late_minutes || 0) > 0).length },
  };
  if (p.period === 'month') out.days = monthDays(m.items, p, today);
  return out;
}

/** Each day of a month: done on time, done late, missed or still open, and whether they were off. */
function monthDays(items, { from, to }, today) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const shift = items.find((x) => x.kind === 'shift' && x.due === d);
    const things = items.filter((x) => x.kind !== 'shift' && !x.asked && x.due === d);
    days.push({
      day: d, off: !shift, future: d > today,
      onTime: things.filter((x) => x.status === 'done' && onTime(x)).length,
      late: things.filter((x) => x.status === 'done' && !onTime(x)).length,
      missed: things.filter((x) => ['open', 'doing'].includes(x.status) && d < today).length,
    });
  }
  return days;
}

// ------------------------------------------------------------ evaluation --

/** A share (0..1) as a mark (1..5): `low` or under is 1, `high` or over is 5. */
const mark = (share, low, high) => round1(1 + 4 * clamp((share - low) / (high - low)));

/** The eight measures for one person's things over a window, and the facts behind each. */
export function measure(items, { from, to, today }, peers = null) {
  const inWin = (d) => d && d >= from && d <= to && d < today;
  const shifts = items.filter((x) => x.kind === 'shift' && inWin(x.due) && x.status !== 'open');
  const worked = shifts.filter((x) => x.status === 'done' || x.status === 'doing');
  const late = worked.filter((x) => (x.late_minutes || 0) > 0);
  const work = items.filter((x) => x.kind !== 'shift' && !x.asked);
  const dueIn = work.filter((x) => inWin(x.due) && x.status !== 'cancelled');
  const doneIn = work.filter((x) => x.status === 'done' && inWin(dayOf(x.done_at)));
  const answered = work.filter((x) => x.answered && x.created_at && inWin(dayOf(x.created_at)));
  const routine = dueIn.filter((x) => x.routine);
  const moneyThings = items.filter((x) => (x.money || x.money_issue || x.kind === 'count' || x.kind === 'charge') && inWin(dayOf(x.created_at || x.done_at) || x.due));
  const r = {};
  r.turns_up = shifts.length >= ENOUGH ? { score: mark(worked.length / shifts.length, 0.7, 0.98), facts: `${worked.length} of ${shifts.length} shifts worked`, n: shifts.length } : null;
  r.on_time = worked.length >= ENOUGH ? { score: mark(1 - late.length / worked.length, 0.6, 0.97), facts: `late ${late.length} of ${worked.length} times`, n: worked.length } : null;
  const doneByDue = dueIn.filter((x) => x.status === 'done' && onTime(x)).length;
  r.gets_done = dueIn.length >= ENOUGH ? { score: mark(doneByDue / dueIn.length, 0.5, 0.95), facts: `${doneByDue} of ${dueIn.length} done by their due date`, n: dueIn.length } : null;
  const perShift = worked.length ? doneIn.length / worked.length : null;
  if (perShift != null && peers?.length >= 1 && doneIn.length >= ENOUGH) {
    const sorted = [...peers].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    r.throughput = median > 0 ? { score: round1(clamp(3 + (perShift / median - 1) * 4, 1, 5)), facts: `${round1(perShift)} done a shift; others in the role ${round1(median)}`, n: doneIn.length } : null;
  } else r.throughput = null;
  const waits = answered.filter((x) => x.done_at).map((x) => Math.max(0, hoursBetween(x.created_at, x.done_at) / 24));
  const openOld = answered.filter((x) => !x.done_at).map((x) => Math.max(0, daysBetween(dayOf(x.created_at), today)));
  const allWaits = [...waits, ...openOld].sort((a, b) => a - b);
  const mid = allWaits.length ? allWaits[Math.floor(allWaits.length / 2)] : null;
  r.answers = allWaits.length >= ENOUGH ? { score: round1(clamp(5 - (mid - 0.5) * (4 / 3.5), 1, 5)), facts: `answered in ${round1(mid)} days, middle of ${allWaits.length}`, n: allWaits.length, days: mid } : null;
  const reopened = doneIn.filter((x) => x.reopened > 0).length;
  r.first_time = doneIn.length >= ENOUGH ? { score: mark(1 - reopened / doneIn.length, 0.7, 0.98), facts: `${reopened} of ${doneIn.length} reopened or sent back`, n: doneIn.length } : null;
  const routineOk = routine.filter((x) => x.status === 'done' && onTime(x)).length;
  r.routine = routine.length >= ENOUGH ? { score: mark(routineOk / routine.length, 0.6, 0.97), facts: `${routineOk} of ${routine.length} on their day`, n: routine.length } : null;
  const issues = moneyThings.filter((x) => x.money_issue).length;
  r.money = moneyThings.length >= ENOUGH ? { score: mark(1 - issues / moneyThings.length, 0.7, 1), facts: `${issues} of ${moneyThings.length} refused, short or charged`, n: moneyThings.length } : null;
  return { measures: r, perShift, worked: worked.length, done: doneIn.length };
}

/** The weighted rating from the measures (and an admin's own, scored by hand). */
function rate(measures, settings, manual = {}) {
  let sum = 0;
  let weight = 0;
  for (const m of MEASURES) {
    const v = measures[m.id];
    const w = settings.weights[m.id] ?? 1;
    if (v && w > 0) { sum += v.score * w; weight += w; }
  }
  for (const c of settings.custom) {
    const v = Number(manual[c.id]);
    if (Number.isFinite(v) && v >= 1 && v <= 5 && c.weight > 0) { sum += v * c.weight; weight += c.weight; }
  }
  return weight ? round1(sum / weight) : null;
}

const verdict = (score, trend) => (score == null ? 'Not enough to go on yet' : `${score >= 4.3 ? 'Strong' : score >= 3.7 ? 'Good' : score >= 3 ? 'Solid' : score >= 2.3 ? 'Needs support' : 'Struggling'}, ${trend === 'up' ? 'improving' : trend === 'down' ? 'slipping' : 'steady'}`);

/** Everybody's rating, for the last three months and the three before, against others in the same role. */
async function evaluateAll(env, today, { withDetail = false } = {}) {
  const settings = await settingsOf(env);
  const cur = { from: addDays(today, -EVAL_DAYS), to: addDays(today, -1), today };
  const prev = { from: addDays(today, -2 * EVAL_DAYS), to: addDays(today, -EVAL_DAYS - 1), today };
  // Six months, asked for in two windows of three: the other apps answer at most 100 days at a time.
  const [a, b] = await Promise.all([gatherTeam(env, { from: prev.from, to: prev.to, today }), gatherTeam(env, { from: cur.from, to: today, today })]);
  const data = {
    people: b.people.map((m) => {
      const older = a.people.find((x) => x.id === m.id)?.items || [];
      const seen = new Set(m.items.map((x) => x.id));
      return { ...m, items: [...m.items, ...older.filter((x) => !seen.has(x.id))] };
    }),
  };
  const manual = await manualScores(env);
  const pre = data.people.map((m) => ({ m, now: measure(m.items, cur), before: measure(m.items, prev) }));
  const roleOfM = (x) => String(x.m.role || '').toLowerCase();
  const out = new Map();
  for (const x of pre) {
    const peers = pre.filter((y) => y !== x && roleOfM(y) === roleOfM(x));
    const nowM = measure(x.m.items, cur, peers.map((y) => y.now.perShift).filter((v) => v != null));
    const beforeM = measure(x.m.items, prev, peers.map((y) => y.before.perShift).filter((v) => v != null));
    const score = rate(nowM.measures, settings, manual.get(x.m.id) || {});
    const was = rate(beforeM.measures, settings, manual.get(x.m.id) || {});
    const trend = score == null || was == null ? 'same' : score - was >= 0.2 ? 'up' : was - score >= 0.2 ? 'down' : 'same';
    out.set(x.m.id, { score, was, trend, measures: nowM.measures, done: nowM.done, worked: nowM.worked, peers: peers.length + 1, role: x.m.role, ...(withDetail ? { items: x.m.items } : {}) });
  }
  // Their place among the same role.
  for (const [id, e] of out) {
    const same = [...out.entries()].filter(([, f]) => String(f.role).toLowerCase() === String(e.role).toLowerCase() && f.score != null);
    e.rank = e.score == null ? null : 1 + same.filter(([oid, f]) => oid !== id && f.score > e.score).length;
  }
  return out;
}

async function manualScores(env) {
  const rows = await all(env.DB, 'SELECT staff_id, measure_id, score FROM team_score').catch(() => []);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.staff_id)) out.set(r.staff_id, {});
    out.get(r.staff_id)[r.measure_id] = Number(r.score);
  }
  return out;
}

/** Patterns that repeat (three times or more), each saying what it is based on. */
export function patterns(items, { from, to, today }, peerItems = []) {
  const out = [];
  const inWin = (d) => d && d >= from && d <= to && d < today;
  // Late on one day of the week.
  const late = items.filter((x) => x.kind === 'shift' && inWin(x.due) && (x.late_minutes || 0) > 0);
  if (late.length >= 3) {
    const byDay = new Map();
    for (const x of late) byDay.set(x.weekday, [...(byDay.get(x.weekday) || []), x]);
    const [wd, xs] = [...byDay.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (xs.length >= 3 && xs.length / late.length >= 0.5) {
      const mins = xs.map((x) => x.late_minutes).sort((a, b) => a - b);
      out.push({ tone: 'bad', icon: '⏰', title: `Late on ${WEEKDAYS[wd]}`, why: `${xs.length} of ${late.length} late clock-ins were ${WEEKDAYS[wd]}, ${mins[0] === mins.at(-1) ? mins[0] : `${mins[0]}–${mins.at(-1)}`} min`, talk: `${WEEKDAYS[wd]}: is there a reason they are late (transport, the rota the day before)?` });
    }
  }
  // A kind of work that takes much longer than it does for others.
  const took = (x) => (x.done_at && (x.started_at || x.created_at) ? Math.max(0, hoursBetween(x.started_at || x.created_at, x.done_at) / 24 - (x.waited_days || 0)) : null);
  const doneIn = items.filter((x) => x.status === 'done' && x.category && inWin(dayOf(x.done_at)) && took(x) != null);
  const cats = new Map();
  for (const x of doneIn) cats.set(x.category, [...(cats.get(x.category) || []), took(x)]);
  for (const [cat, ds] of cats) {
    if (ds.length < 3) continue;
    const theirs = ds.reduce((t, v) => t + v, 0) / ds.length;
    const others = peerItems.filter((x) => x.category === cat && x.status === 'done' && inWin(dayOf(x.done_at)) && took(x) != null).map(took);
    if (others.length < 3) continue;
    const them = others.reduce((t, v) => t + v, 0) / others.length;
    if (theirs >= 1.8 * them && theirs - them >= 0.5) {
      out.push({ tone: 'bad', icon: '🐢', title: `${cat} takes them long`, why: `${round1(theirs)} days to finish, against ${round1(them)} for others (${ds.length} done)`, talk: `${cat}: training, or should it go to somebody else?` });
    }
  }
  // Routine work late at the end of the month, three months or more.
  const routineLate = items.filter((x) => x.routine && x.kind !== 'shift' && inWin(x.due) && Number(x.due.slice(8)) >= 24 && !(x.status === 'done' && onTime(x)));
  const months = new Set(routineLate.map((x) => x.due.slice(0, 7)));
  if (months.size >= 3) out.push({ tone: 'bad', icon: '📆', title: 'Routine work late in the last week of the month', why: `${routineLate.length} times, in ${months.size} months`, talk: 'Month end: a reminder a few days before?' });
  // Routine never missed.
  const routine = items.filter((x) => x.routine && x.kind !== 'shift' && inWin(x.due));
  if (routine.length >= 20 && routine.every((x) => x.status === 'done' && onTime(x))) {
    out.push({ tone: 'good', icon: '✅', title: 'Routine never missed', why: `${routine.length} of ${routine.length} on their day`, talk: 'Thank them for the routine work: none missed.' });
  }
  // More (or less) done each month, three months running.
  const monthsDone = [];
  for (let i = 2; i >= 0; i -= 1) {
    const end = addDays(to, -30 * i);
    const start = addDays(end, -29);
    monthsDone.push(items.filter((x) => x.status === 'done' && x.kind !== 'shift' && !x.asked && dayOf(x.done_at) >= start && dayOf(x.done_at) <= end).length);
  }
  if (monthsDone[2] > monthsDone[1] && monthsDone[1] > monthsDone[0] && monthsDone[0] >= 3) out.push({ tone: 'good', icon: '📈', title: 'More done each month', why: monthsDone.join(' → ') });
  if (monthsDone[2] < monthsDone[1] && monthsDone[1] < monthsDone[0] && monthsDone[2] >= 0 && monthsDone[0] >= 6) out.push({ tone: 'bad', icon: '📉', title: 'Less done each month', why: monthsDone.join(' → '), talk: 'Less done lately: too much else on, or something in the way?' });
  // Most of what is overdue waits on somebody else.
  const overdue = items.filter((x) => ['open', 'doing'].includes(x.status) && x.due && x.due < today && !x.asked);
  const waiting = overdue.filter((x) => x.waiting_on);
  if (waiting.length >= 3 && waiting.length / overdue.length >= 0.5) out.push({ tone: 'info', icon: '🔗', title: 'Most of their overdue waits on somebody else', why: `${waiting.length} of ${overdue.length}: ${[...new Set(waiting.map((x) => x.waiting_on))].slice(0, 2).join('; ')}` });
  return out;
}

/** One person's evaluation: the rating, each measure, patterns, strengths and things to watch, points to talk about, the notes. */
export async function evaluation(env, id, account, { own = false } = {}) {
  if (!own) mustAdmin(account);
  const today = todayIn('UTC');
  const settings = await settingsOf(env);
  const evals = await evaluateAll(env, today, { withDetail: true });
  const e = evals.get(Number(id));
  if (!e) throw notFound('Nobody by that number in HIVE.');
  const people = await members(env);
  const m = people.find((x) => x.id === Number(id));
  const win = { from: addDays(today, -EVAL_DAYS), to: addDays(today, -1), today };
  const peerItems = [...evals.entries()].filter(([pid, f]) => pid !== Number(id) && String(f.role).toLowerCase() === String(e.role).toLowerCase()).flatMap(([, f]) => f.items);
  const pats = patterns(e.items, win, peerItems);
  const manual = (await manualScores(env)).get(Number(id)) || {};
  const measures = [
    ...MEASURES.map((x) => ({ ...x, weight: settings.weights[x.id], ...(e.measures[x.id] || { score: null, facts: 'too little to judge' }) })),
    ...settings.custom.map((c) => ({ id: c.id, label: c.label, what: c.what, weight: c.weight, custom: true, score: Number.isFinite(Number(manual[c.id])) ? Number(manual[c.id]) : null, facts: 'scored by an admin' })),
  ];
  const scored = measures.filter((x) => x.score != null && x.weight > 0);
  const strengths = scored.filter((x) => x.score >= 4).sort((a, b) => b.score - a.score).slice(0, 3).map((x) => ({ title: x.label, why: x.facts }));
  const watch = scored.filter((x) => x.score < 3).sort((a, b) => a.score - b.score).slice(0, 3).map((x) => ({ title: x.label, why: x.facts }));
  // Time held back by others in the window, which is not counted against them.
  const held = e.items.filter((x) => x.waited_days > 0 && dayOf(x.done_at || x.created_at) >= win.from).reduce((t, x) => t + x.waited_days, 0);
  const notes = own ? [] : await all(env.DB, 'SELECT * FROM team_note WHERE staff_id = ?1 ORDER BY at DESC LIMIT 50', Number(id)).catch(() => []);
  // Done each month, for the last six.
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i);
    const ym = d.toISOString().slice(0, 7);
    const xs = e.items.filter((x) => x.kind !== 'shift' && !x.asked && x.status === 'done' && String(x.done_at || '').slice(0, 7) === ym);
    months.push({ month: ym, done: xs.length, onTime: xs.filter(onTime).length });
  }
  return {
    person: { id: m.id, name: m.name, role: m.role, department: m.department },
    from: win.from, to: win.to, score: e.score, was: e.was, trend: e.trend, verdict: verdict(e.score, e.trend),
    rank: e.rank, peers: e.peers, things: e.items.filter((x) => dayOf(x.done_at || x.created_at || x.due) >= win.from).length,
    measures, patterns: pats, strengths, watch,
    talk: [...pats.filter((x) => x.tone === 'bad' && x.talk).map((x) => x.talk), ...watch.map((x) => `${x.title}: ${x.why}. What would help?`), ...pats.filter((x) => x.tone === 'good' && x.talk).map((x) => x.talk)].slice(0, 5),
    heldDays: round1(held), months, settings: own ? null : settings,
    notes: notes.map((n) => ({ id: n.id, text: n.text, by: n.by_name, at: n.at })),
  };
}

/** An admin's note on a person, kept with their evaluation. */
export async function addNote(env, id, body, account) {
  mustAdmin(account);
  const text = str(body?.text, 'The note', { required: true, max: 1000 });
  await run(env.DB, 'INSERT INTO team_note (staff_id, text, by_name, at) VALUES (?1, ?2, ?3, ?4)', Number(id), text, who(account), now());
  return { ok: true };
}

/** An admin scores a person on a measure of their own: 1 to 5, or empty to take it off. */
export async function scoreCustom(env, id, body, account) {
  mustAdmin(account);
  const s = await settingsOf(env);
  if (!s.custom.some((c) => c.id === body?.measure)) throw badRequest('That measure is not one of yours.');
  if (body?.score === '' || body?.score == null) {
    await run(env.DB, 'DELETE FROM team_score WHERE staff_id = ?1 AND measure_id = ?2', Number(id), body.measure);
    return { ok: true };
  }
  const n = Number(body.score);
  if (!Number.isFinite(n) || n < 1 || n > 5) throw badRequest('A score from 1 to 5.');
  await run(env.DB, `INSERT INTO team_score (staff_id, measure_id, score, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (staff_id, measure_id) DO UPDATE SET score = ?3, by_name = ?4, at = ?5`, Number(id), body.measure, Math.round(n * 10) / 10, who(account), now());
  return { ok: true };
}

/** Their own evaluation, when an admin lets people see it: found by their email in HIVE. No notes. */
export async function own(env, account) {
  const s = await settingsOf(env);
  if (!s.showOwn) throw forbidden('Evaluations are not shown to people yet.');
  const email = String(account?.email || '').toLowerCase();
  const m = email ? (await members(env)).find((x) => x.email === email) : null;
  if (!m) throw notFound('Your email in Insight is not the one HIVE has for you.');
  return evaluation(env, m.id, account, { own: true });
}
