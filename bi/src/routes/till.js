import { all, first, run, getSettings, setSetting } from '../lib/db.js';
import { badRequest, forbidden, HttpError, str } from '../lib/http.js';
import { addDays, daysBetween } from '../lib/dates.js';
import { callLink } from '../lib/link.js';
import { listSources, secretNameFor } from '../connectors/index.js';
import { purchaseOrders } from '../connectors/odoo.js';
import { compare, issuesFor, readReport, withStatus, FINAL, KINDS } from '../shifts/till.js';
import { shifts as shiftsFor } from './shifts.js';

/**
 * Closing a shift in HIVE, as this app sees it.
 *
 * Three audiences. HIVE, over the till link, asks what the form should ask,
 * whether a PO exists, and what is on a person's list. An admin reads every
 * closing report beside ASSD, settles what staff answered, approves what a
 * supervisor corrected, and sets all of it up. A supervisor gets the parts the
 * admin chose for them.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** Ask HIVE something over the till link, with its refusal as this app's own. */
async function hiveCall(args) {
  try {
    return await callLink({ what: 'HIVE', ...args });
  } catch (err) {
    throw new HttpError(err.status && err.status < 600 ? err.status : 502, err.message);
  }
}
const today = () => new Date().toISOString().slice(0, 10);
const SLOT_ORDER = ['morning', 'afternoon', 'night'];
const who = (account) => account?.name || account?.email || 'Owner';

// ------------------------------------------------------------------ access --

/** Each part of the Shifts screen a supervisor may be given, and how far. */
export const AREAS = [
  { key: 'day', max: 1 }, { key: 'week', max: 1 }, { key: 'month', max: 1 },
  { key: 'reports', max: 1 }, { key: 'money', max: 1 }, { key: 'moves', max: 2 },
  { key: 'answers', max: 2 }, { key: 'money_out', max: 2 }, { key: 'reopen', max: 2 }, { key: 'net', max: 1 },
  { key: 'bank', max: 2 }, { key: 'odoo', max: 1 }, { key: 'files', max: 2 }, { key: 'unpaid', max: 2 },
];
const AREA_MAX = new Map(AREAS.map((a) => [a.key, a.max]));

/**
 * Admin, supervisor or uploader. An owner is an admin; so is anybody given the
 * reports without a role. A supervisor holds the reports grant with the role
 * `supervisor`, and sees only the Shifts screen. An uploader holds it with
 * `uploader`, and may load the three shift files and see nothing else.
 */
export function roleOf(account) {
  if (!account) return null;
  if (account.isOwner || account.bootstrap) return 'admin';
  const grant = (account.access || []).find((a) => a.systemId === 'insight');
  if (!grant) return null;
  if (grant.role === 'supervisor' || grant.role === 'uploader') return grant.role;
  return 'admin';
}

/** What this account may do with each area: 2 for an admin, as set for a supervisor. */
export async function accessOf(env, account) {
  const role = roleOf(account);
  const out = {};
  if (role === 'admin') {
    for (const a of AREAS) out[a.key] = a.max;
    return out;
  }
  if (role !== 'supervisor') {
    // An uploader loads files and nothing else; anybody else, nothing.
    for (const a of AREAS) out[a.key] = role === 'uploader' && a.key === 'files' ? 2 : 0;
    return out;
  }
  let rows = [];
  try {
    rows = await all(env.DB, 'SELECT account_id, area, level FROM till_access WHERE account_id IN (0, ?1)', account.id ?? -1);
  } catch { rows = []; }
  const own = rows.filter((r) => Number(r.account_id) === Number(account.id));
  const use = own.length ? own : rows.filter((r) => Number(r.account_id) === 0);
  for (const a of AREAS) {
    const row = use.find((r) => r.area === a.key);
    out[a.key] = Math.min(a.max, Math.max(0, Number(row?.level) || 0));
  }
  return out;
}

/** Refuse unless this account may do `level` with `area`. */
export async function requireArea(env, account, area, level = 1) {
  const access = await accessOf(env, account);
  if ((access[area] || 0) < level) {
    throw forbidden(level > 1 ? 'Your access lets you look at this, not change it.' : 'That part of Shifts has not been shared with you.');
  }
  return access;
}

export async function requireAdmin(account) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can do that.');
}

// --------------------------------------------------------------- settings --

async function checks(env, { active = false } = {}) {
  try {
    return await all(env.DB, `SELECT id, label, active, sort FROM till_check ${active ? 'WHERE active = 1' : ''} ORDER BY sort, id`);
  } catch { return []; }
}

async function rentals(env, { active = false } = {}) {
  try {
    return await all(env.DB, `SELECT * FROM till_rental ${active ? 'WHERE active = 1' : ''} ORDER BY sort, id`);
  } catch { return []; }
}

async function threshold(env) {
  const s = await getSettings(env.DB).catch(() => ({}));
  return Math.max(0, Number(s.till_threshold) || 0);
}

// ------------------------------------------------------------- HIVE's data --

/** Rows from HIVE's database, or nothing when it is not bound or not upgraded yet. */
async function hive(env, sql, ...binds) {
  if (!env.ATT_DB) return [];
  try { return await all(env.ATT_DB, sql, ...binds); } catch { return []; }
}

export async function hiveReports(env, from, to) {
  return (await hive(env, `SELECT * FROM till_report WHERE day BETWEEN ?1 AND ?2 AND reopened_at IS NULL ORDER BY signed_at`, from, to))
    .map(readReport);
}

async function hivePos(env, from, to) {
  return hive(env, 'SELECT * FROM till_po WHERE day BETWEEN ?1 AND ?2', from, to);
}

async function hiveAnswers(env, userId = null) {
  return userId == null
    ? hive(env, 'SELECT * FROM till_answer ORDER BY id')
    : hive(env, 'SELECT * FROM till_answer WHERE user_id = ?1 ORDER BY id', userId);
}

async function hiveUsers(env) {
  return hive(env, 'SELECT id, name, role, email, active FROM users WHERE active = 1 ORDER BY name');
}

/** The first day anybody closed a shift in HIVE: before it, a missing report is nobody's. */
async function goLive(env) {
  const row = (await hive(env, 'SELECT MIN(day) AS day FROM till_report'))[0];
  return row?.day || null;
}

async function people(env) {
  try {
    return new Map((await all(env.DB, 'SELECT assd_user, hive_user_id FROM till_people WHERE hive_user_id IS NOT NULL'))
      .map((r) => [r.assd_user, Number(r.hive_user_id)]));
  } catch { return new Map(); }
}

async function resolutions(env) {
  try { return await all(env.DB, 'SELECT * FROM till_resolution ORDER BY id'); } catch { return []; }
}

// ------------------------------------------------------------- the issues --

/** Shifts as the Shifts screen has them, flattened, for a window of days. */
async function shiftList(env, from, to) {
  const out = [];
  // The Shifts screen reads at most two months at a time.
  let start = from;
  while (start <= to) {
    const end = [addDays(start, 61), to].sort()[0];
    // eslint-disable-next-line no-await-in-loop
    const data = await shiftsFor(env, { from: start, to: end }, { isOwner: true });
    for (const d of data.days || []) out.push(...d.shifts);
    start = addDays(end, 1);
  }
  return out;
}

/** Everything that does not agree between `from` and `to`, with where each stands. */
export async function issuesBetween(env, from, to) {
  const [list, reports, pos, active, map, since, small, answers, decided] = await Promise.all([
    shiftList(env, from, to), hiveReports(env, from, to), hivePos(env, from, to), rentals(env, { active: true }),
    people(env), goLive(env), threshold(env), hiveAnswers(env), resolutions(env),
  ]);
  const issues = issuesFor({ shifts: list, reports, pos, rentals: active, people: map, since, threshold: small });
  return { shifts: list, reports, pos, rentals: active, issues: withStatus(issues, { answers, resolutions: decided }) };
}

const LOOKBACK = 60;

// ---------------------------------------------------------- the till link --

/** What HIVE's closing form should ask. */
export async function linkSetup(env) {
  return {
    checks: (await checks(env, { active: true })).map((c) => ({ id: c.id, label: c.label })),
    rentals: (await rentals(env, { active: true })).map((r) => ({ id: r.id, label: r.label, unit: r.unit })),
  };
}

/**
 * The names a PO might be under, from what somebody typed.
 *
 * Odoo numbers them `P00412`; people type `412`, `po412` or `PO00412`, and an
 * O and a nought look the same on a receipt.
 */
export function poVariants(typed) {
  const t = String(typed || '').toUpperCase().replace(/\s+/g, '');
  if (!t) return [];
  const digits = t.replace(/^P[O0]?/, '').replace(/^0+(?=\d)/, '');
  const out = new Set([t]);
  if (/^\d+$/.test(digits)) {
    const five = digits.padStart(5, '0');
    out.add(`P${five}`);
    out.add(`PO${five}`);
    out.add(`P0${five}`);
  }
  return [...out];
}

/** Odoo's state names → whether the PO counts. */
const CONFIRMED = new Set(['purchase', 'done']);

/** Look POs up in Odoo, read-only. */
export async function linkPo(env, body, { fetchImpl } = {}) {
  const typed = (Array.isArray(body?.names) ? body.names : [body?.name]).map((n) => String(n || '').trim()).filter(Boolean).slice(0, 20);
  if (!typed.length) throw badRequest('Type the PO number first.');
  const sources = (await listSources(env.DB)).filter((s) => s.kind === 'odoo_json2' && s.config?.base);
  const source = sources.find((s) => s.enabled) || sources[0];
  if (!source) throw new HttpError(409, 'Odoo is not set up in Insight yet.');
  const secret = secretNameFor(source);
  const names = [...new Set(typed.flatMap(poVariants))];
  const result = await purchaseOrders({ config: source.config, token: secret ? env[secret] : null, names, ...(fetchImpl ? { fetchImpl } : {}) });
  // A PO already paid from the safe cannot be paid from a drawer too.
  const fromSafe = new Map((await all(env.DB, 'SELECT po, day FROM safe_entry WHERE po IS NOT NULL').catch(() => []))
    .map((r) => [String(r.po).toUpperCase(), r.day]));
  return {
    found: typed.map((t) => {
      const variants = new Set(poVariants(t));
      const order = result.orders.find((o) => variants.has(String(o.name).toUpperCase()));
      const safeDay = order ? fromSafe.get(String(order.name).toUpperCase()) : null;
      return order
        ? {
          typed: t, name: order.name, vendor: order.vendor, total: order.total, state: order.state, confirmed: CONFIRMED.has(order.state), orderedOn: order.orderedOn,
          ...(safeDay ? { safe: { day: safeDay } } : {}),
        }
        : { typed: t, name: null };
    }),
  };
}

/** One person's list, as HIVE shows it under "To sort out". */
export async function linkIssues(env, body) {
  const userId = Number(body?.userId);
  if (!Number.isInteger(userId)) throw badRequest('Whose list?');
  const to = today();
  const from = addDays(to, -LOOKBACK);
  const { issues } = await issuesBetween(env, from, to);
  const mine = issues.filter((i) => Number(i.userId) === userId);
  const month = to.slice(0, 7);
  return {
    issues: mine.filter((i) => i.status !== 'settled').map((i) => ({
      key: i.key, kind: i.kind, label: KINDS[i.kind], day: i.day, slot: i.slot, amount: i.amount, qty: i.qty ?? null,
      rental: i.rental ?? null, text: i.text, status: i.status, answer: i.answer,
      sentBack: i.decision?.outcome === 'back' ? { note: i.decision.note, by: i.decision.by, at: i.decision.at } : null,
    })),
    cleared: mine.filter((i) => i.status === 'settled' && String(i.decision?.at || '').startsWith(month)).length,
  };
}

/** Who HIVE should tell about something, and how. */
export async function linkRecipients(env, body) {
  const event = String(body?.event || '');
  const column = { closed: 'on_closed', answer: 'on_answer', approval: 'on_approval' }[event];
  if (!column) throw badRequest('Which event?');
  let rows = [];
  try { rows = await all(env.DB, `SELECT * FROM till_notify WHERE ${column} = 1`); } catch { rows = []; }
  return {
    to: rows.filter((r) => r.push || r.email).map((r) => ({
      userId: Number(r.hive_user_id), name: r.name, push: Boolean(r.push), email: Boolean(r.email), amounts: Boolean(r.amounts),
    })),
  };
}

// -------------------------------------------------- the screens' read side --

/**
 * Everything the admin's and supervisors' till views show, cut to what this
 * account may see.
 */
export async function overview(env, query, account) {
  const role = roleOf(account);
  const access = await accessOf(env, account);
  if (!access.reports && !access.answers && role !== 'admin') throw forbidden('Closing reports have not been shared with you.');
  const to = /^\d{4}-\d\d-\d\d$/.test(query?.to || '') ? query.to : today();
  const from = /^\d{4}-\d\d-\d\d$/.test(query?.from || '') ? query.from : addDays(to, -6);
  if (daysBetween(from, to).length > 62) throw badRequest('Two months at a time at most.');

  const { shifts, reports, pos, rentals: active, issues } = await issuesBetween(env, addDays(to, -LOOKBACK), to);
  const users = await hiveUsers(env);
  const nameOf = new Map(users.map((u) => [Number(u.id), u.name]));
  const money = access.money > 0;
  const odoo = access.odoo > 0;
  const hide = (minor) => (money ? minor : null);

  const inWindow = (d) => d >= from && d <= to;
  const reportRows = [];
  const byShift = new Map(shifts.map((s) => [`${s.day}|${s.slot}`, s]));
  const keys = new Set([...shifts.filter((s) => inWindow(s.day)).map((s) => `${s.day}|${s.slot}`),
    ...reports.filter((r) => inWindow(r.day)).map((r) => `${r.day}|${r.slot}`)]);
  for (const key of keys) {
    const [day, slot] = key.split('|');
    const shift = byShift.get(key) || { day, slot, register: {}, items: {}, open: false, user: null };
    const report = reports.find((r) => r.day === day && r.slot === slot) || null;
    const c = compare(shift, report, { pos, rentals: active });
    reportRows.push({
      day, slot, assdUser: shift.user || null, inJournal: byShift.has(key), open: Boolean(shift.open),
      report: report && {
        id: report.id, name: report.name, signedAt: report.signedAt, device: report.device,
        floatOk: report.floatOk, floatDiff: hide(report.floatDiff), floatNote: report.floatNote,
        cash: hide(report.cash), toSafe: report.toSafe,
        envelopes: report.envelopes.map((e) => ({ no: e.no, amount: hide(e.amount) })),
        expenses: report.expenses.map((e) => ({
          po: e.po, name: e.name || null, paid: hide(e.paid), state: e.state || null, counted: Boolean(e.counted),
          ...(odoo ? { vendor: e.vendor || null, total: hide(e.total) } : {}),
        })),
        rentals: report.rentals, checks: report.checks, note: report.note,
      },
      compare: money ? c : {
        ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'number' ? null : v])),
        unexplainedSign: c.unexplained == null ? null : Math.sign(c.unexplained),
        varianceSign: c.variance == null ? null : Math.sign(c.variance),
        rentals: c.rentals.map((x) => ({ ...x, deposit: null })),
      },
      issues: issues.filter((i) => i.day === day && i.slot === slot).length,
    });
  }
  reportRows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : ['morning', 'afternoon', 'night'].indexOf(a.slot) - ['morning', 'afternoon', 'night'].indexOf(b.slot)));

  // A shift ASSD has somebody on with no report, beside a report of theirs on
  // the next or previous shift (one ASSD has somebody else on, or nobody):
  // most likely one report on the wrong row, closed after eleven so the clock
  // offered the night. Said on both rows, and an admin can move it.
  const mapped = await people(env).catch(() => new Map());
  const sameName = (assd, name) => {
    const a = String(assd || '').trim().toLowerCase();
    const n = String(name || '').trim().toLowerCase();
    return Boolean(a && n && (n === a || n.split(/\s+/).includes(a) || n.startsWith(`${a} `)));
  };
  const neighbours = ({ day, slot }) => {
    const i = SLOT_ORDER.indexOf(slot);
    const before = i > 0 ? { day, slot: SLOT_ORDER[i - 1] } : { day: addDays(day, -1), slot: 'night' };
    const after = i < 2 ? { day, slot: SLOT_ORDER[i + 1] } : { day: addDays(day, 1), slot: 'morning' };
    return [before, after];
  };
  for (const row of reportRows) {
    if (row.report || !row.inJournal) continue;
    const owner = mapped.get(row.assdUser);
    for (const n of neighbours(row)) {
      // The same person on both shifts in ASSD is a double shift, not a slip.
      const there = byShift.get(`${n.day}|${n.slot}`);
      if (there && there.user === row.assdUser) continue;
      const theirs = reports.find((r) => r.day === n.day && r.slot === n.slot
        && (owner != null ? Number(r.userId) === Number(owner) : sameName(row.assdUser, r.name)));
      if (!theirs) continue;
      row.nearby = { id: theirs.id, day: n.day, slot: n.slot, name: theirs.name, signedAt: theirs.signedAt };
      const other = reportRows.find((x) => x.day === n.day && x.slot === n.slot);
      if (other) other.belongs = { day: row.day, slot: row.slot, assdUser: row.assdUser };
      break;
    }
  }

  const list = issues.map((i) => ({
    ...i, name: nameOf.get(Number(i.userId)) || null, amount: money ? i.amount : Math.sign(i.amount),
  }));

  const net = access.net > 0 ? netByPerson(issues, nameOf) : null;

  const out = {
    role, access, range: { from, to },
    reports: reportRows,
    issues: access.answers > 0 || role === 'admin' ? list : [],
    net,
    kinds: KINDS,
    linked: Boolean(env.HIVE && env.SSO_SECRET_ATTENDANCE),
  };
  if (role === 'admin') {
    out.approvals = await pendingMovements(env);
    out.answerApprovals = await pendingAnswers(env);
    out.settings = await settingsView(env, users, shifts);
  }
  return out;
}

/** Each person's money issues this month, net, settled or not. */
function netByPerson(issues, nameOf) {
  const month = today().slice(0, 7);
  const out = new Map();
  for (const i of issues) {
    // Money short or over, and a rental's deposit. Not envelopes that claim
    // more than moved, which is a question about the safe, not a surplus.
    if (!i.day.startsWith(month) || i.userId == null || !i.amount || !['drawer', 'unexplained', 'rental'].includes(i.kind)) continue;
    const p = out.get(i.userId) || { userId: i.userId, name: nameOf.get(Number(i.userId)) || null, net: 0, short: 0, over: 0, count: 0 };
    p.net += i.amount;
    if (i.amount < 0) p.short += i.amount; else p.over += i.amount;
    p.count += 1;
    out.set(i.userId, p);
  }
  return [...out.values()].sort((a, b) => a.net - b.net);
}

/** A supervisor's answers and reconciliations, waiting for an admin. */
async function pendingAnswers(env) {
  const answers = await all(env.DB, "SELECT * FROM shift_answer WHERE status = 'pending' ORDER BY at").catch(() => []);
  const links = await all(env.DB, "SELECT * FROM shift_link WHERE status = 'pending' ORDER BY at").catch(() => []);
  return [
    ...answers.map((a) => ({ type: 'answer', id: a.key, keys: [a.key], answer: a.answer, note: a.note, by: a.by_name, at: a.at })),
    ...links.map((l) => {
      let keys = [];
      try { keys = JSON.parse(l.keys); } catch { keys = []; }
      return { type: 'link', id: l.id, keys, answer: 'Reconciled together', note: l.note, by: l.by_name, at: l.at };
    }),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

async function pendingMovements(env) {
  try {
    return await all(env.DB, `SELECT m.*, e.day, e.staff, e.data FROM shift_movement m
      LEFT JOIN assd_entry e ON e.seq = m.seq WHERE m.status = 'pending' ORDER BY m.at`)
      .then((rows) => rows.map((r) => {
        let data = {};
        try { data = JSON.parse(r.data || '{}'); } catch { data = {}; }
        return { seq: r.seq, kind: r.kind, expenses: r.expenses, pair: r.pair, note: r.note, by: r.by_name, at: r.at, day: r.day, user: r.staff, amount: -(data.movement || 0) };
      }));
  } catch { return []; }
}

async function settingsView(env, users, shifts) {
  let notify = [];
  let accessRows = [];
  let mapped = [];
  try { notify = await all(env.DB, 'SELECT * FROM till_notify ORDER BY name'); } catch { notify = []; }
  try { accessRows = await all(env.DB, 'SELECT * FROM till_access ORDER BY account_id, area'); } catch { accessRows = []; }
  try { mapped = await all(env.DB, 'SELECT * FROM till_people ORDER BY assd_user'); } catch { mapped = []; }
  let supervisors = [];
  try {
    supervisors = await all(env.DB, `SELECT a.id, a.name, a.email FROM accounts a JOIN account_access g ON g.account_id = a.id
      WHERE g.system_id = 'insight' AND g.role = 'supervisor' AND a.active = 1 ORDER BY a.name`);
  } catch { supervisors = []; }
  const assdUsers = [...new Set([...shifts.map((s) => s.user).filter(Boolean), ...mapped.map((m) => m.assd_user)])].sort();
  const s = await getSettings(env.DB).catch(() => ({}));
  return {
    checks: await checks(env),
    rentals: await rentals(env),
    notify: notify.map((n) => ({ ...n, hive_user_id: Number(n.hive_user_id) })),
    access: accessRows,
    areas: AREAS,
    supervisors,
    hiveUsers: users.map((u) => ({ id: Number(u.id), name: u.name, role: u.role, hasEmail: Boolean(u.email) })),
    people: assdUsers.map((u) => ({ assdUser: u, hiveUserId: mapped.find((m) => m.assd_user === u)?.hive_user_id ?? null })),
    threshold: Math.max(0, Number(s.till_threshold) || 0),
    checkoutTime: s.checkout_time || '12:00',
  };
}

// ------------------------------------------------------------- settling --

/**
 * Settle something on a person's list.
 *
 * `accept` takes their explanation; `recover` takes it from their pay, as an
 * advance in HIVE that comes off the next payslip; `cash` records that they
 * paid it back; `writeoff` lets it go; `back` returns it to them.
 */
export async function resolve(env, body, account, { fetchImpl } = {}) {
  const key = str(body?.key, 'Which issue', { required: true, max: 200 });
  const userId = Number(body?.userId);
  if (!Number.isInteger(userId)) throw badRequest('Whose issue?');
  const outcome = String(body?.outcome || '');
  if (!['accept', 'recover', 'cash', 'writeoff', 'back'].includes(outcome)) throw badRequest('Accept, recover, cash, write off or send back?');
  const note = str(body?.note, 'Note', { max: 600 });
  await requireArea(env, account, ['recover', 'writeoff', 'cash'].includes(outcome) ? 'money_out' : 'answers', 2);

  const to = today();
  const { issues } = await issuesBetween(env, addDays(to, -LOOKBACK), to);
  const issue = issues.find((i) => i.key === key && Number(i.userId) === userId);
  if (!issue) throw badRequest('That is no longer on their list. It may have been settled, or the shift now agrees.');
  if (issue.status === 'settled') throw badRequest('That has already been settled.');

  let advanceId = null;
  const amount = issue.amount < 0 ? -issue.amount : 0;
  if (outcome === 'recover') {
    if (!amount) throw badRequest('There is nothing to recover: this was not a shortage.');
    const done = await hiveCall({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/recover',
      body: { userId, amount, key, reason: `Till: ${KINDS[issue.kind]}, ${issue.day} ${issue.slot}`, by: who(account) },
    });
    advanceId = done.advanceId ?? null;
  }
  await run(env.DB, `INSERT INTO till_resolution (key, hive_user_id, outcome, amount, note, advance_id, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`, key, userId, outcome, outcome === 'recover' ? amount : null, note, advanceId, who(account), now());

  // Tell them. Never fails the decision: it has been made either way.
  const words = {
    back: ['Sent back to you', `${note || 'The supervisor needs more from you.'} Open To sort out in HIVE.`],
    accept: ['Settled', 'Your answer was accepted.'],
    recover: ['Settled from your pay', 'It will come off your next payslip.'],
    cash: ['Settled', 'Your repayment was recorded.'],
    writeoff: ['Settled', 'It has been written off.'],
  }[outcome];
  await hiveCall({
    binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/tell',
    body: { userIds: [userId], kind: 'till.settled', title: `${words[0]}: ${issue.day} ${issue.slot}`, body: words[1] },
  }).catch(() => null);
  return { ok: true, outcome, advanceId };
}

/** Reopen a signed report so its person can send it again. */
export async function reopen(env, body, account, { fetchImpl } = {}) {
  await requireArea(env, account, 'reopen', 2);
  const id = Number(body?.reportId);
  if (!Number.isInteger(id)) throw badRequest('Which report?');
  const reason = str(body?.reason, 'Reason', { required: true, max: 400 });
  return hiveCall({
    binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/reopen',
    body: { reportId: id, reason, by: who(account) },
  });
}

/** Move a report onto the shift it belongs to, through HIVE. */
export async function moveReport(env, body, account, { fetchImpl } = {}) {
  await requireArea(env, account, 'reopen', 2);
  const id = Number(body?.reportId);
  if (!Number.isInteger(id)) throw badRequest('Which report?');
  const day = String(body?.day || '');
  const slot = String(body?.slot || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !SLOT_ORDER.includes(slot)) throw badRequest('Which shift?');
  return hiveCall({
    binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/move',
    body: { reportId: id, day, slot, by: who(account) },
  });
}

/** Approve or reject a supervisor's correction to a cash movement. */
export async function approve(env, body, account) {
  await requireAdmin(account);
  // An answer, or a set reconciled together: approving clears the exceptions;
  // rejecting puts them back on the list, as if never answered.
  if (body?.answer != null || body?.link != null) {
    const isLink = body.link != null;
    const table = isLink ? 'shift_link' : 'shift_answer';
    const col = isLink ? 'id' : 'key';
    const id = isLink ? Number(body.link) : String(body.answer);
    const row = await first(env.DB, `SELECT * FROM ${table} WHERE ${col} = ?1 AND status = 'pending'`, id);
    if (!row) throw badRequest('That is no longer waiting.');
    if (body.ok) await run(env.DB, `UPDATE ${table} SET status = 'applied', decided_by = ?2, decided_at = ?3 WHERE ${col} = ?1`, id, who(account), now());
    else await run(env.DB, `DELETE FROM ${table} WHERE ${col} = ?1`, id);
    return { ok: true };
  }
  const seq = Number(body?.seq);
  if (!Number.isInteger(seq)) throw badRequest('Which movement?');
  const row = await first(env.DB, "SELECT * FROM shift_movement WHERE seq = ?1 AND status = 'pending'", seq);
  if (!row) throw badRequest('That correction is no longer waiting.');
  if (body?.ok) {
    await run(env.DB, "UPDATE shift_movement SET status = 'applied', decided_by = ?2, decided_at = ?3 WHERE seq = ?1", seq, who(account), now());
  } else {
    await run(env.DB, "UPDATE shift_movement SET status = 'rejected', decided_by = ?2, decided_at = ?3 WHERE seq = ?1", seq, who(account), now());
  }
  return { ok: true };
}

/** Tell the admins that a supervisor's correction is waiting. Never throws. */
export async function tellApprovers(env, { seq, kind, by, text = null }, { fetchImpl } = {}) {
  try {
    const { to } = await linkRecipients(env, { event: 'approval' });
    if (!to.length) return;
    const said = text || `${by} says ASSD ${seq} ${kind === 'duplicate' ? 'is a duplicate' : kind === 'reverses' ? 'puts back another movement' : `was ${kind}`}.`;
    await hiveCall({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/tell',
      body: { recipients: to, kind: 'till.approval', title: 'Waiting for your approval', body: `${said} Approve it in Insight → Shifts → Approvals.` },
    });
  } catch { /* the correction is saved either way */ }
}

// ---------------------------------------------------------- the settings --

/** Save any of the till settings. Admin only. */
export async function saveSettings(env, body, account) {
  await requireAdmin(account);
  const at = now();

  if (body?.check) {
    const c = body.check;
    if (c.id == null) {
      const label = str(c.label, 'The item', { required: true, max: 60 });
      await run(env.DB, 'INSERT INTO till_check (label, active, sort, created_by) VALUES (?1, 1, (SELECT COALESCE(MAX(sort), 0) + 10 FROM till_check), ?2)', label, who(account));
    } else {
      await run(env.DB, 'UPDATE till_check SET active = ?2 WHERE id = ?1', Number(c.id), c.active ? 1 : 0);
    }
  }

  if (body?.rental) {
    const r = body.rental;
    const row = await first(env.DB, 'SELECT * FROM till_rental WHERE id = ?1', String(r.id || ''));
    if (!row) throw badRequest('Which rental?');
    const pesewas = (v, field) => {
      if (v == null || v === '') return null;
      const n = Math.round(Number(v) * 100);
      if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be an amount.`);
      return n;
    };
    const deposit = pesewas(r.deposit, 'The deposit') ?? row.deposit;
    const refund = pesewas(r.refund, 'The refund') ?? row.refund;
    if (refund > deposit) throw badRequest('The refund cannot be more than the deposit.');
    const article = r.article == null ? row.article : String(r.article).trim();
    if (!/^\d{3}$/.test(article)) throw badRequest('The ASSD article number has three digits, like 405.');
    await run(env.DB, 'UPDATE till_rental SET active = ?2, deposit = ?3, refund = ?4, article = ?5 WHERE id = ?1',
      row.id, r.active == null ? row.active : (r.active ? 1 : 0), deposit, refund, article);
  }

  if (body?.notify) {
    const n = body.notify;
    const id = Number(n.hiveUserId);
    if (!Number.isInteger(id)) throw badRequest('Who should be told?');
    if (n.remove) await run(env.DB, 'DELETE FROM till_notify WHERE hive_user_id = ?1', id);
    else {
      const flag = (v, d) => (v == null ? d : v ? 1 : 0);
      const old = await first(env.DB, 'SELECT * FROM till_notify WHERE hive_user_id = ?1', id);
      await run(env.DB, `INSERT INTO till_notify (hive_user_id, name, push, email, amounts, on_closed, on_answer, on_approval)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT (hive_user_id) DO UPDATE SET name = ?2, push = ?3, email = ?4, amounts = ?5, on_closed = ?6, on_answer = ?7, on_approval = ?8`,
      id, str(n.name, 'Name', { max: 120 }) || old?.name || `HIVE ${id}`,
      flag(n.push, old?.push ?? 1), flag(n.email, old?.email ?? 1), flag(n.amounts, old?.amounts ?? 1),
      flag(n.onClosed, old?.on_closed ?? 1), flag(n.onAnswer, old?.on_answer ?? 1), flag(n.onApproval, old?.on_approval ?? 0));
    }
  }

  if (body?.access) {
    const a = body.access;
    const accountId = Number(a.accountId ?? 0);
    if (!Number.isInteger(accountId) || accountId < 0) throw badRequest('Whose access?');
    if (a.reset) {
      await run(env.DB, 'DELETE FROM till_access WHERE account_id = ?1 AND account_id <> 0', accountId);
    } else {
      const max = AREA_MAX.get(String(a.area));
      if (max == null) throw badRequest('Which part of Shifts?');
      const level = Math.min(max, Math.max(0, Number(a.level) || 0));
      if (accountId !== 0) {
        // A person's own settings start as a copy of everybody's.
        const own = await first(env.DB, 'SELECT 1 AS n FROM till_access WHERE account_id = ?1', accountId);
        if (!own) await run(env.DB, 'INSERT INTO till_access (account_id, area, level) SELECT ?1, area, level FROM till_access WHERE account_id = 0', accountId);
      }
      await run(env.DB, `INSERT INTO till_access (account_id, area, level) VALUES (?1, ?2, ?3)
        ON CONFLICT (account_id, area) DO UPDATE SET level = ?3`, accountId, a.area, level);
    }
  }

  if (body?.person) {
    const p = body.person;
    const assd = str(p.assdUser, 'ASSD login', { required: true, max: 60 });
    const id = p.hiveUserId == null || p.hiveUserId === '' ? null : Number(p.hiveUserId);
    await run(env.DB, `INSERT INTO till_people (assd_user, hive_user_id, by_name, at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (assd_user) DO UPDATE SET hive_user_id = ?2, by_name = ?3, at = ?4`, assd, id, who(account), at);
  }

  if (body?.checkoutTime != null) {
    const t = String(body.checkoutTime).trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw badRequest('The check-out time is a time of day, like 12:00.');
    await setSetting(env.DB, 'checkout_time', t);
  }
  if (body?.threshold != null) {
    const n = Math.round(Number(body.threshold) * 100);
    if (!Number.isFinite(n) || n < 0) throw badRequest('The amount to ignore must be zero or more.');
    await setSetting(env.DB, 'till_threshold', n);
  }
  return { ok: true };
}

export { FINAL };
