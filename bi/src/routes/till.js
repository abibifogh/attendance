import { all, first, run, getSettings, setSetting } from '../lib/db.js';
import { badRequest, forbidden, HttpError, str } from '../lib/http.js';
import { addDays, daysBetween } from '../lib/dates.js';
import { callLink } from '../lib/link.js';
import { lockOf, isLocked } from './lock.js';
import { listSources, secretNameFor } from '../connectors/index.js';
import { purchaseOrders } from '../connectors/odoo.js';
import { compare, issuesFor, readReport, withStatus, FINAL, KINDS } from '../shifts/till.js';
import { shifts as shiftsFor, setAside, dayOfKey, saveLink } from './shifts.js';
import { formLive, poExtras } from './advances.js';
import { openForHive } from './proof.js';
import { madeHere } from './newpo.js';
import { logEvent } from './notes.js';

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
  { key: 'advances', max: 2 }, { key: 'niceplace', max: 2 }, { key: 'proof', max: 2 }, { key: 'check', max: 2 },
  // Front desk › Safe › Envelopes received: see them, or mark them received.
  { key: 'envelopes', max: 2 },
  // Front desk › Nice Place › Pickups: see them, or make them (take the envelopes, add what was spent, count).
  { key: 'pickups', max: 2 },
];
const AREA_MAX = new Map(AREAS.map((a) => [a.key, a.max]));

/**
 * Ready-made sets of access, so most supervisors are one choice. Anything not
 * named is Hidden. Custom is any other mix, set area by area.
 */
export const PRESETS = [
  {
    key: 'frontdesk', label: 'Front desk supervisor',
    text: 'Sees shifts and closing reports without amounts. Acts on staff answers, unpaid stays and advances, and reopens a report.',
    levels: { day: 1, week: 1, month: 1, reports: 1, answers: 2, reopen: 2, unpaid: 2, advances: 2 },
  },
  {
    key: 'nppickups', label: 'Nice Place pickups',
    text: 'Takes Nice Place’s envelopes from the safe: adds what was paid out of them, with receipts, and counts what is left. Reads counters a picture could not.',
    levels: { pickups: 2, niceplace: 2 },
  },
  {
    key: 'accounts', label: 'Accounts',
    text: 'Sees amounts, the bank and Odoo. Acts on card and bank, cash movements, POs, staff answers, money out and advances, and loads files.',
    levels: {
      day: 1, week: 1, month: 1, reports: 1, money: 1, moves: 2, answers: 2, money_out: 2, net: 1, bank: 2, odoo: 1, files: 2, unpaid: 1, advances: 2,
    },
  },
];

/**
 * Admin, supervisor, uploader or reports only. An owner is an admin; so is
 * anybody given the reports without a role. Reports only holds the grant with
 * the role `reports`: the report pages an admin ticked for them
 * (reportaccess.js), nothing else. A supervisor holds the reports grant with the role
 * `supervisor`, and sees only the Shifts screen. An uploader holds it with
 * `uploader`, and may load the three shift files and see nothing else.
 */
export function roleOf(account) {
  if (!account) return null;
  if (account.isOwner || account.bootstrap) return 'admin';
  const grant = (account.access || []).find((a) => a.systemId === 'insight');
  if (!grant) return null;
  if (grant.role === 'supervisor' || grant.role === 'uploader' || grant.role === 'reports') return grant.role;
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

export async function threshold(env) {
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
  // Every difference found in these days, by key, answered or not: what a
  // supervisor's answer still waiting is about must still be among them.
  out.keys = new Set();
  // The Shifts screen reads at most two months at a time.
  let start = from;
  while (start <= to) {
    const end = [addDays(start, 61), to].sort()[0];
    // eslint-disable-next-line no-await-in-loop
    const data = await shiftsFor(env, { from: start, to: end }, { isOwner: true });
    for (const d of data.days || []) out.push(...d.shifts);
    for (const x of data.exceptions || []) out.keys.add(x.key);
    start = addDays(end, 1);
  }
  return out;
}

/** Everything that does not agree between `from` and `to`, with where each stands. */
export async function issuesBetween(env, from, to) {
  const [list, reports, pos, active, map, since, small, answers, decided, linked, moved, checks, chosen] = await Promise.all([
    shiftList(env, from, to), hiveReports(env, from, to), hivePos(env, from, to), rentals(env, { active: true }),
    people(env), goLive(env), threshold(env), hiveAnswers(env), resolutions(env), reconciled(env), moves(env), shiftChecks(env), owners(env),
  ]);
  // A drawer difference reconciled with others (and approved) is one story
  // told twice: it nets out, so it leaves its person's list. One an admin put
  // on staff accounts leaves its shift's person too, and goes, share by
  // share, on the people it was put on.
  const movedKeys = new Set(moved.map((m) => m.key));
  const issues = [
    ...issuesFor({ shifts: list, reports, pos, rentals: active, people: map, owners: chosen, since, threshold: small })
      .filter((i) => !(i.kind === 'drawer' && linked.has(i.key)) && !movedKeys.has(i.key)),
    ...moved.filter((m) => m.day >= from && m.day <= to).flatMap(movedIssues),
  ];
  return {
    shifts: list, reports, pos, rentals: active, checks, owners: chosen, people: map, present: { keys: list.keys || new Set(), from, to },
    issues: withStatus(issues, { answers, resolutions: decided }).map((i) => withCheck(i, checks)),
  };
}

// ------------------------------------------------------------ checked --

/**
 * A shift is checked when somebody has looked at it (its report, drawer and
 * payments) and said so. Until then its differences are "not checked yet" on
 * its person's list: the amounts may change. Each is confirmed only as it was
 * when checked, so one that changes afterwards (a journal loaded again, a
 * correction) is not checked again until the shift is checked again. Moved to
 * somebody's account is an admin's decision, so it counts as checked.
 */
const fingerprint = (i) => `${i.amount ?? ''}|${i.qty ?? ''}`;

async function shiftChecks(env) {
  const rows = await all(env.DB, 'SELECT * FROM shift_check').catch(() => []);
  return new Map(rows.map((r) => {
    let snapshot = {};
    try { snapshot = JSON.parse(r.snapshot || '{}'); } catch { snapshot = {}; }
    return [`${r.day}|${r.slot}`, { day: r.day, slot: r.slot, by: r.by_name, at: r.at, snapshot }];
  }));
}

function withCheck(issue, checks) {
  if (issue.kind === 'moved') return { ...issue, checked: true, checkedBy: issue.moved?.by || null, checkedAt: issue.moved?.at || null };
  const c = checks.get(`${issue.day}|${issue.slot}`);
  const ok = Boolean(c) && c.snapshot[issue.key] === fingerprint(issue);
  return { ...issue, checked: ok, checkedBy: ok ? c.by : null, checkedAt: ok ? c.at : null };
}

/**
 * Which of these shifts are checked, for HIVE. A till shortage comes off pay
 * only while its shift is checked, so HIVE asks about the shift behind each
 * one still being repaid.
 */
export async function linkChecks(env, body) {
  const shifts = (Array.isArray(body?.shifts) ? body.shifts : []).slice(0, 500)
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s?.day ?? '')) && ['morning', 'afternoon', 'night'].includes(String(s?.slot ?? '')));
  const checks = await shiftChecks(env);
  // A difference an admin put on staff accounts is decided, amount and all,
  // whether or not its shift was ever checked: it counts as checked for as
  // long as the move stands (as it does on the person's list).
  const keys = (Array.isArray(body?.keys) ? body.keys : []).slice(0, 500).map(String).filter((k) => /^moved:\d+:\d+$/.test(k));
  const standing = new Map((await moves(env)).map((m) => [Number(m.id), m]));
  return {
    checked: shifts.map((s) => {
      const c = checks.get(`${s.day}|${s.slot}`);
      return c ? { day: s.day, slot: s.slot, by: c.by || null, at: c.at || null } : null;
    }).filter(Boolean),
    keys: keys.map((key) => {
      const m = standing.get(Number(key.split(':')[1]));
      return m ? { key, by: m.by_name || null, at: m.at || null } : null;
    }).filter(Boolean),
  };
}

/**
 * Which shifts between `from` and `to` are checked, by whom and when, read
 * straight from the checks. A checked shift is locked, so this is all the
 * padlocks and the check card need to show at once; whether anything changed
 * since comes later, with the full overview.
 */
export async function checkList(env, query, account) {
  const access = await accessOf(env, account);
  if (!access.reports && !access.answers && !access.check && roleOf(account) !== 'admin') throw forbidden('Closing reports have not been shared with you.');
  const to = /^\d{4}-\d\d-\d\d$/.test(query?.to || '') ? query.to : today();
  const from = /^\d{4}-\d\d-\d\d$/.test(query?.from || '') ? query.from : addDays(to, -6);
  if (daysBetween(from, to).length > 62) throw badRequest('Two months at a time at most.');
  const rows = await all(env.DB, 'SELECT day, slot, by_name, at FROM shift_check WHERE day BETWEEN ?1 AND ?2', from, to).catch(() => []);
  return { checks: rows.map((r) => ({ day: r.day, slot: r.slot, by: r.by_name, at: r.at })) };
}

/** Where one shift stands: checked by whom, and whether anything changed since. */
function checkOf(checks, issues, day, slot) {
  const c = checks.get(`${day}|${slot}`);
  if (!c) return null;
  const changed = issues.filter((i) => i.day === day && i.slot === slot && i.kind !== 'moved' && !i.checked);
  return { by: c.by, at: c.at, changed: changed.length > 0 };
}

/** Mark a shift checked: its differences, as they stand, are confirmed to its people. */
export async function checkShift(env, body, account, { fetchImpl } = {}) {
  await requireArea(env, account, 'check', 2);
  const day = String(body?.day || '');
  const slot = String(body?.slot || '');
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !SLOT_ORDER.includes(slot)) throw badRequest('Which shift?');
  if (day >= today()) throw badRequest('A shift can be checked once its day is over.');
  const from = [addDays(today(), -LOOKBACK), day].sort()[0];
  const { issues } = await issuesBetween(env, from, today());
  const mine = issues.filter((i) => i.day === day && i.slot === slot && i.kind !== 'moved');
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await run(env.DB, `INSERT INTO shift_check (day, slot, by_name, at, snapshot) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (day, slot) DO UPDATE SET by_name = ?3, at = ?4, snapshot = ?5`,
  day, slot, who(account), at, JSON.stringify(Object.fromEntries(mine.map((i) => [i.key, fingerprint(i)]))));
  // Whoever has something on this shift still to sort out is told it is checked now.
  const open = mine.filter((i) => i.status !== 'settled' && i.userId != null);
  const ids = [...new Set(open.map((i) => Number(i.userId)))];
  let told = false;
  if (ids.length) {
    const n = open.length;
    told = await tell(env, ids, `Your ${slotWord(slot)} shift on ${sayDay(day)} has been checked`,
      `${n === 1 ? 'One thing' : `${n} things`} on it to sort out. The amounts are final now. See My till › To sort out.`, fetchImpl, 'till.checked');
  }
  return { ok: true, check: { by: who(account), at, changed: false }, open: open.length, told };
}

/** Take a check back: the shift's differences are "not checked yet" again. */
export async function uncheckShift(env, body, account) {
  await requireArea(env, account, 'check', 2);
  const day = String(body?.day || '');
  const slot = String(body?.slot || '');
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !SLOT_ORDER.includes(slot)) throw badRequest('Which shift?');
  await run(env.DB, 'DELETE FROM shift_check WHERE day = ?1 AND slot = ?2', day, slot);
  return { ok: true };
}

const slotWord = (slot) => ({ morning: 'morning', afternoon: 'afternoon', night: 'night' })[slot] || slot;
const sayDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Every exception reconciled together with others, once applied. */
async function reconciled(env) {
  const out = new Set();
  const rows = await all(env.DB, "SELECT keys FROM shift_link WHERE COALESCE(status, 'applied') = 'applied'").catch(() => []);
  for (const row of rows) {
    try { for (const k of JSON.parse(row.keys)) out.add(String(k)); } catch { /* a broken row reconciles nothing */ }
  }
  return out;
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
  // What the expense form says about each, and anything an admin decided.
  const extras = await poExtras(env, result.orders.map((o) => o.name));
  // Made in Insight: on a shift only once an admin allows it.
  const made = await madeHere(env, result.orders.map((o) => o.name));
  return {
    formLive: formLive(env),
    found: typed.map((t) => {
      const variants = new Set(poVariants(t));
      const order = result.orders.find((o) => variants.has(String(o.name).toUpperCase()));
      const safeDay = order ? fromSafe.get(String(order.name).toUpperCase()) : null;
      return order
        ? {
          typed: t, name: order.name, vendor: order.vendor, total: order.total, state: order.state, confirmed: CONFIRMED.has(order.state), orderedOn: order.orderedOn,
          ...(safeDay ? { safe: { day: safeDay } } : {}),
          ...extras(order.name),
          ...(made.has(String(order.name).toUpperCase()) ? { madeInInsight: made.get(String(order.name).toUpperCase()) } : {}),
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
  // Proof an admin asked for, on something they answered.
  const asked = await openForHive(env, userId).catch(() => new Map());
  const lock = await lockOf(env);
  // Settled leaves the list, except what was recovered from pay: that stays,
  // marked as recovered through payroll, so the person can see where it went.
  const recovered = (i) => i.status === 'settled' && ['recover', 'pay'].includes(i.decision?.outcome);
  return {
    lockedThrough: lock.through,
    issues: mine.filter((i) => i.status !== 'settled' || recovered(i)).map((i) => ({
      key: i.key, kind: i.kind, label: i.kind === 'moved' ? 'Moved to you' : KINDS[i.kind], day: i.day, slot: i.slot, amount: i.amount, qty: i.qty ?? null,
      rental: i.rental ?? null, text: i.text, status: i.status, answer: i.answer,
      moved: i.moved ? { reason: i.moved.reason, by: i.moved.by, at: i.moved.at, from: i.moved.ownerName } : null,
      sentBack: i.decision?.outcome === 'back' ? { note: i.decision.note, by: i.decision.by, at: i.decision.at } : null,
      proof: asked.get(i.key) || null,
      // Checked: the amount is final. Not checked yet: it may change, and only a note can be added.
      checked: i.checked, checkedBy: i.checkedBy, checkedAt: i.checkedAt, note: i.note || null,
      // A locked day: nothing more can be sent on it.
      locked: isLocked(lock, i.day),
      recovered: recovered(i)
        ? {
          how: i.decision.outcome, amount: i.decision.amount ?? null, at: i.decision.at, by: i.decision.by,
          ...(i.decision.outcome === 'pay' ? { creditId: i.decision.advanceId ?? null } : { advanceId: i.decision.advanceId ?? null }),
        }
        : null,
    })),
    cleared: mine.filter((i) => i.status === 'settled' && !recovered(i) && String(i.decision?.at || '').startsWith(month)).length,
  };
}

/**
 * Every shortage on a checked shift still waiting for a decision, for HIVE's
 * Till shortages view, where whoever runs the pay chooses: recover it from pay,
 * or not. Somebody's answer, if they gave one, goes with it.
 */
export async function linkToDecide(env) {
  const to = today();
  const { issues } = await issuesBetween(env, addDays(to, -LOOKBACK), to);
  return {
    issues: issues
      // Shortages to recover or not, and surpluses to pay or not.
      .filter((i) => i.checked && i.status !== 'settled' && i.userId != null && Number(i.amount) !== 0 && i.amount != null)
      .map((i) => ({
        key: i.key, userId: Number(i.userId), kind: i.kind, label: i.kind === 'moved' ? 'Put on their account' : KINDS[i.kind],
        day: i.day, slot: i.slot, amount: Math.abs(Number(i.amount)), surplus: Number(i.amount) > 0, text: i.text,
        answer: i.answer ? { how: i.answer.how, text: i.answer.text, at: i.answer.at } : null,
        checkedBy: i.checkedBy || null, checkedAt: i.checkedAt || null,
        moved: i.moved ? { reason: i.moved.reason, by: i.moved.by } : null,
      }))
      .sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.slot).localeCompare(String(b.slot))),
  };
}

/**
 * HIVE's decision on one of them: recover it from pay, or not. Settled the
 * same way as from Insight's own screen, in the name of whoever decided in
 * HIVE; HIVE has already checked they may.
 */
export async function linkDecide(env, body, { fetchImpl } = {}) {
  const outcome = ['recover', 'writeoff', 'pay'].includes(body?.outcome) ? body.outcome : null;
  if (!outcome) throw badRequest('Recover it, pay it, or not?');
  const by = str(body?.by, 'Who', { max: 120 }) || 'HIVE';
  const note = str(body?.note, 'Note', { max: 600 })
    || ({ writeoff: 'Not through pay, decided in HIVE.', recover: 'Recovered from pay, decided in HIVE.', pay: 'Paid with salary, decided in HIVE.' })[outcome];
  return resolve(env, { key: body?.key, userId: body?.userId, outcome, note }, { name: by, isOwner: true }, { fetchImpl });
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
  if (!access.reports && !access.answers && !access.check && role !== 'admin') throw forbidden('Closing reports have not been shared with you.');
  const to = /^\d{4}-\d\d-\d\d$/.test(query?.to || '') ? query.to : today();
  const from = /^\d{4}-\d\d-\d\d$/.test(query?.from || '') ? query.from : addDays(to, -6);
  if (daysBetween(from, to).length > 62) throw badRequest('Two months at a time at most.');

  const { shifts, reports, pos, rentals: active, issues, checks, owners: chosen, present } = await issuesBetween(env, addDays(to, -LOOKBACK), to);
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
        rentals: report.rentals, checks: report.checks, note: report.note, moved: report.moved,
      },
      compare: money ? c : {
        ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'number' ? null : v])),
        unexplainedSign: c.unexplained == null ? null : Math.sign(c.unexplained),
        varianceSign: c.variance == null ? null : Math.sign(c.variance),
        rentals: c.rentals.map((x) => ({ ...x, deposit: null })),
      },
      issues: issues.filter((i) => i.day === day && i.slot === slot).length,
      // Chosen as its person, when ASSD and HIVE named different people.
      owner: chosen.get(key) || null,
      // Checked by whom, or not yet; and what its people said before the check.
      check: checkOf(checks, issues, day, slot),
      notes: issues.filter((i) => i.day === day && i.slot === slot && i.note).map((i) => ({ name: nameOf.get(Number(i.userId)) || null, text: i.note.text, at: i.note.at })),
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
  // Whether ASSD has the report's writer on the shift it is on: one where ASSD
  // has somebody else may be on the wrong shift.
  for (const row of reportRows) {
    if (!row.report || !row.assdUser) continue;
    const owner = mapped.get(row.assdUser);
    const writer = reports.find((r) => r.id === row.report.id);
    // Not known (no login mapped, and the names do not match) is not a mismatch.
    row.assdMatches = owner != null ? Number(writer?.userId) === Number(owner) : sameName(row.assdUser, row.report.name) || null;
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
    out.answerApprovals = await pendingAnswers(env, present);
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
    if (!i.day.startsWith(month) || i.userId == null || !i.amount || !['drawer', 'unexplained', 'rental', 'moved'].includes(i.kind)) continue;
    const p = out.get(i.userId) || { userId: i.userId, name: nameOf.get(Number(i.userId)) || null, net: 0, short: 0, over: 0, count: 0 };
    p.net += i.amount;
    if (i.amount < 0) p.short += i.amount; else p.over += i.amount;
    p.count += 1;
    out.set(i.userId, p);
  }
  return [...out.values()].sort((a, b) => a.net - b.net);
}

/** A supervisor's answers and reconciliations, waiting for an admin. */
export async function pendingAnswers(env, present = null) {
  if (present) await setAsideGone(env, present).catch((err) => console.error('Waiting answers', err));
  // Anything decided another way meanwhile (put on a staff account, or in a
  // reconciliation an admin made) is done with, not waiting.
  const decided = await all(env.DB, `SELECT a.key FROM shift_answer a WHERE a.status = 'pending'
      AND EXISTS (SELECT 1 FROM till_move m WHERE m.key = a.key AND m.undone_at IS NULL)`).catch(() => []);
  const linked = await all(env.DB, "SELECT keys FROM shift_link WHERE COALESCE(status, 'applied') = 'applied'").catch(() => []);
  const inLinks = new Set(linked.flatMap((l) => { try { return JSON.parse(l.keys); } catch { return []; } }));
  const waiting = await all(env.DB, "SELECT key FROM shift_answer WHERE status = 'pending'").catch(() => []);
  const moved = decided.map((r) => r.key);
  if (moved.length) await setAside(env, moved, 'put on a staff account', { name: 'Insight' }).catch(() => 0);
  const done = waiting.map((r) => r.key).filter((k) => inLinks.has(k));
  if (done.length) await setAside(env, done, 'reconciled together by an admin', { name: 'Insight' }).catch(() => 0);
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

/**
 * Answers and reconciliations waiting for an admin whose difference is no
 * longer there (a payment found since, a recount, a later file): nothing is
 * left to approve. Judged only for days well inside those just read, so a
 * difference on a day not read is never taken for gone.
 */
async function setAsideGone(env, { keys, from, to }) {
  const inside = (d) => Boolean(d) && d >= addDays(from, 2) && d <= addDays(to, -1);
  const gone = async (key) => !keys.has(key) && inside(await dayOfKey(env, key));
  const how = 'the difference is no longer on its shift (it agrees now)';
  const answers = await all(env.DB, "SELECT key FROM shift_answer WHERE status = 'pending'").catch(() => []);
  const away = [];
  // eslint-disable-next-line no-await-in-loop
  for (const a of answers) if (await gone(a.key)) away.push(a.key);
  if (away.length) await setAside(env, away, how, { name: 'Insight' });
  const links = await all(env.DB, "SELECT keys FROM shift_link WHERE status = 'pending'").catch(() => []);
  for (const l of links) {
    let lk = [];
    try { lk = JSON.parse(l.keys); } catch { lk = []; }
    let allGone = lk.length > 0;
    // eslint-disable-next-line no-await-in-loop
    for (const k of lk) if (!(await gone(k))) { allGone = false; break; }
    // eslint-disable-next-line no-await-in-loop
    if (allGone) await setAside(env, lk, how, { name: 'Insight' });
  }
}

export async function pendingMovements(env) {
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
    presets: PRESETS,
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
  if (!['accept', 'recover', 'pay', 'cash', 'writeoff', 'back'].includes(outcome)) throw badRequest('Accept, recover, pay, cash, write off or send back?');
  const note = str(body?.note, 'Note', { max: 600 });
  await requireArea(env, account, ['recover', 'pay', 'writeoff', 'cash'].includes(outcome) ? 'money_out' : 'answers', 2);
  // Whether a shortage comes off somebody's pay, or is let go, is an admin's
  // decision, here and in HIVE. Recording cash handed back is not.
  if (['recover', 'pay', 'writeoff'].includes(outcome) && roleOf(account) !== 'admin') {
    throw forbidden('Only an admin decides whether a difference goes through pay or is written off.');
  }

  const to = today();
  const { issues } = await issuesBetween(env, addDays(to, -LOOKBACK), to);
  const issue = issues.find((i) => i.key === key && Number(i.userId) === userId);
  if (!issue) throw badRequest('That is no longer on their list. It may have been settled, or the shift now agrees.');
  if (issue.status === 'settled') throw badRequest('That has already been settled.');

  let advanceId = null;
  const amount = issue.amount < 0 ? -issue.amount : 0;
  if (outcome === 'recover') {
    if (!amount) throw badRequest('There is nothing to recover: this was not a shortage.');
    // Only a figure somebody has confirmed comes off pay. Until the shift is
    // checked its amounts may still change, and a payslip is not the place to
    // find out they did.
    if (!issue.checked) throw badRequest('That shift has not been checked yet. Check it first: a shortage comes off pay only once its amount is final.');
    const done = await hiveCall({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/recover',
      body: {
        userId, amount, key, reason: `Till: ${KINDS[issue.kind]}, ${issue.day} ${issue.slot}`, by: who(account),
        day: issue.day, slot: issue.slot, checked: true, checkedBy: issue.checkedBy || null, checkedAt: issue.checkedAt || null,
      },
    });
    advanceId = done.advanceId ?? null;
  }
  // A surplus (money over, owed to them) paid with their pay. In HIVE it
  // meets any till shortage on the same payslip first; the rest is added.
  const over = issue.amount > 0 ? issue.amount : 0;
  if (outcome === 'pay') {
    if (!over) throw badRequest('There is nothing to pay: this was not a surplus.');
    if (!issue.checked) throw badRequest('That shift has not been checked yet. Check it first: a surplus is paid only once its amount is final.');
    const done = await hiveCall({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/credit',
      body: {
        userId, amount: over, key, reason: `Till: ${KINDS[issue.kind]}, ${issue.day} ${issue.slot}`, by: who(account),
        day: issue.day, slot: issue.slot, checked: true, checkedBy: issue.checkedBy || null, checkedAt: issue.checkedAt || null,
      },
    });
    // Kept in the same column: the outcome says which kind of record it is.
    advanceId = done.creditId ?? null;
  }
  await run(env.DB, `INSERT INTO till_resolution (key, hive_user_id, outcome, amount, note, advance_id, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`, key, userId, outcome, outcome === 'recover' ? amount : outcome === 'pay' ? over : null, note, advanceId, who(account), now());
  // Settled on their list: nothing a supervisor proposed for it still waits.
  if (FINAL.has(outcome)) await setAside(env, [key], `settled on the person’s list instead (${SETTLED_WORDS[outcome]})`, account).catch(() => 0);

  // Tell them. Never fails the decision: it has been made either way.
  const words = {
    back: ['Sent back to you', `${note || 'The supervisor needs more from you.'} Open To sort out in HIVE.`],
    accept: ['Settled', 'Your answer was accepted.'],
    recover: ['Settled from your pay', 'It will come off your next payslip.'],
    pay: ['Paid through your pay', 'It goes on your next payslip, after any till shortage that month.'],
    cash: ['Settled', 'Your repayment was recorded.'],
    writeoff: ['Settled', 'It has been written off.'],
  }[outcome];
  await hiveCall({
    binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/tell',
    body: { userIds: [userId], kind: 'till.settled', title: `${words[0]}: ${issue.day} ${issue.slot}`, body: words[1] },
  }).catch(() => null);
  return { ok: true, outcome, advanceId };
}

// ------------------------------------------------------- staff accounts --

/** The differences an admin may put on staff accounts, as said to the people. */
const MOVABLE = {
  'drawer-short': 'The drawer was short', 'drawer-over': 'The drawer was over', 'handover-gap': 'The hand-over count did not match',
};
const ghs = (minor) => `GH₵${(Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayWords = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const shiftWords = (day, slot) => `${dayWords(day)} ${slot}`;
const nameCase = (user) => (user ? user.charAt(0) + user.slice(1).toLowerCase() : null);

function readMove(row) {
  let shares = [];
  try { shares = JSON.parse(row.shares); } catch { shares = []; }
  return {
    ...row, amount: Number(row.amount), owner_id: row.owner_id == null ? null : Number(row.owner_id),
    shares: shares.map((x) => ({ userId: Number(x.userId), name: x.name || null, amount: Number(x.amount) })),
  };
}

/** Differences on staff accounts, not undone. */
export async function moves(env) {
  try { return (await all(env.DB, 'SELECT * FROM till_move WHERE undone_at IS NULL ORDER BY id')).map(readMove); } catch { return []; }
}

/** Short or over for the drawer; deficit or surplus for anything else put on an account. */
const moveWord = (kind, amount) => (MOVABLE[kind] ? (amount < 0 ? 'short' : 'over') : (amount < 0 ? 'deficit' : 'surplus'));

/** One move's shares as items on each person's list. */
export function movedIssues(m) {
  const whose = m.owner_name ? `${m.owner_name}'s shift` : 'the shift';
  const said = MOVABLE[m.kind] ? `${MOVABLE[m.kind]} by ${ghs(m.amount)}` : `A ${moveWord(m.kind, m.amount)} of ${ghs(m.amount)}`;
  return m.shares.map((x) => ({
    day: m.day, slot: m.slot, assdUser: m.assd_user, userId: x.userId, reportId: null,
    key: `moved:${m.id}:${x.userId}`, kind: 'moved', amount: x.amount,
    text: `${said} on ${whose}.${m.shares.length > 1 ? ` ${ghs(x.amount)} of it is on your account.` : ''}`,
    moved: { id: m.id, reason: m.reason, by: m.by_name, at: m.at, ownerName: m.owner_name, total: m.amount },
  }));
}

/** The latest decision on something on somebody's list, when it settled it for good. */
async function settledAs(env, key, userId = null) {
  const row = await first(env.DB, `SELECT outcome, by_name FROM till_resolution WHERE key = ?1 ${userId == null ? '' : 'AND hive_user_id = ?2'} ORDER BY id DESC LIMIT 1`,
    ...(userId == null ? [key] : [key, userId])).catch(() => null);
  return row && FINAL.has(row.outcome) ? row : null;
}

const SETTLED_WORDS = { accept: 'accepted', recover: 'recovered from pay', pay: 'paid with salary', cash: 'paid in cash', writeoff: 'written off' };

/** Who may carry a difference: the front desk first, then everybody else in HIVE. */
export async function staffList(env, account) {
  await requireAdmin(account);
  return deskStaff(env);
}

/** HIVE's active people: those who close shifts at the desk first, then everybody else. */
export async function deskStaff(env) {
  const users = await hiveUsers(env);
  const mapped = new Set([...(await people(env)).values()].map(Number));
  const closed = new Set((await hive(env, 'SELECT DISTINCT user_id FROM till_report UNION SELECT DISTINCT user_id FROM till_po')).map((r) => Number(r.user_id)));
  const desk = (u) => mapped.has(Number(u.id)) || closed.has(Number(u.id));
  const row = (u) => ({ id: Number(u.id), name: u.name });
  return { frontDesk: users.filter(desk).map(row), others: users.filter((u) => !desk(u)).map(row) };
}

/**
 * Put a difference on one or more people's accounts. A drawer short, over or
 * hand-over difference carries its own direction; any other difference with
 * an amount (a payment not in ASSD, a card declined…) is put on as a deficit
 * (they owe it) or a surplus (owed to them), which the admin says. All of it
 * is placed; the reason is required. A supervisor's answer still waiting for
 * approval is replaced by it. Each person is told and finds it on their list;
 * the shift's own person, if not among them, is told it has left theirs.
 */
export async function moveToStaff(env, body, account, { fetchImpl } = {}) {
  await requireAdmin(account);
  const key = str(body?.key, 'Which difference', { required: true, max: 200 });
  const parts = /^(drawer|handover):(\d{4}-\d{2}-\d{2}):(morning|afternoon|night)$/.exec(key);
  const dayAsked = parts ? parts[2] : String(body?.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayAsked)) throw badRequest('Which day is that difference on?');
  const reason = str(body?.reason, 'The reason', { required: true, max: 600 });

  const data = await shiftsFor(env, { from: dayAsked, to: dayAsked }, { isOwner: true });
  const x = (data.exceptions || []).find((e) => e.key === key);
  if (!x || !x.amount) throw badRequest('That difference is not there any more: the shift may agree now.');
  const day = x.day || dayAsked;
  const slot = parts ? parts[3] : x.slot;
  if (!slot) throw badRequest('That difference is not on one shift, so it cannot be put on a staff account.');
  if ((await moves(env)).some((m) => m.key === key)) throw badRequest('That is on a staff account already. Undo that first.');
  if (x.answer || x.link) throw badRequest('That has an answer already. Take the answer back first.');
  const settled = await settledAs(env, key);
  if (settled) throw badRequest(`That was settled on its person's list already (${SETTLED_WORDS[settled.outcome]} by ${settled.by_name || 'an admin'}), so it cannot be moved.`);
  // A drawer or hand-over difference says which way it goes; anything else is said by the admin.
  let sign = Math.sign(x.amount);
  if (!MOVABLE[x.kind]) {
    if (!['deficit', 'surplus'].includes(body?.direction)) throw badRequest('Say whether it is a deficit (they owe it) or a surplus (owed to them).');
    sign = body.direction === 'deficit' ? -1 : 1;
  }
  const amount = sign * Math.abs(x.amount);
  return placeOnAccounts(env, { key, kind: x.kind, day, slot, user: x.user, amount, given: body?.shares, reason, account, fetchImpl });
}

/**
 * Which way an exception's money goes, in minor units: plus is money in that
 * ASSD does not show, minus is money ASSD shows that is not there. Null when
 * its kind has no amount that nets against others. As the Shifts screen has it.
 */
export function flowOf(x) {
  if (x?.amount == null) return null;
  const a = Math.abs(x.amount);
  if (['not-recorded', 'bank-only', 'double-charge', 'paid-more', 'refund'].includes(x.kind)) return a;
  if (['not-found', 'failed', 'zero', 'never-settled', 'reversal', 'duplicate', 'paid-less'].includes(x.kind)) return -a;
  if (['drawer-over', 'drawer-short', 'handover-gap', 'laundry-mismatch'].includes(x.kind)) return x.amount;
  // A slip of the finger: ASSD has more (or less) than the terminal took.
  if (['keying', 'transposition', 'decimal'].includes(x.kind)) return x.difference == null ? null : -x.difference;
  if (x.kind === 'movement-twice') return a;
  return null;
}

/**
 * Reconcile differences that are one story together, and put what they do
 * not net to on staff accounts: an admin's. The leftover is worked out here,
 * from the differences as they stand, and goes on the shift of the first.
 */
export async function moveLeftToStaff(env, body, account, { fetchImpl } = {}) {
  await requireAdmin(account);
  const keys = [...new Set((Array.isArray(body?.keys) ? body.keys : []).map((k) => String(k ?? '').trim()).filter(Boolean))];
  if (keys.length < 2) throw badRequest('Choose at least two differences to reconcile together.');
  const reason = str(body?.reason, 'The reason', { required: true, max: 600 });
  const days = (Array.isArray(body?.days) ? body.days : []).map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) throw badRequest('Which days are they on?');
  const from = days[0];
  const to = days[days.length - 1];
  if (daysBetween(from, to).length > 62) throw badRequest('Two months apart at most.');
  const data = await shiftsFor(env, { from, to }, { isOwner: true });
  const chosen = keys.map((k) => (data.exceptions || []).find((e) => e.key === k));
  if (chosen.some((x) => !x)) throw badRequest('One of those is not there any more: the shift may agree now. Reload and try again.');
  if (chosen.some((x) => x.answer || x.link || x.moved)) throw badRequest('One of those has an answer already. Take it back first.');
  const flows = chosen.map(flowOf);
  if (flows.some((f) => f == null)) throw badRequest('What one of those comes to cannot be netted against the others.');
  const net = flows.reduce((t, f) => t + f, 0);
  if (!net) throw badRequest('They net to nothing: reconcile them together, nothing is left to put on anybody.');
  if (body?.amount != null && Number(body.amount) !== net) throw badRequest(`What is left has changed: it is ${net < 0 ? '−' : '+'}${ghs(net)} now. Reload and try again.`);
  const home = chosen.find((x) => x.day && x.slot);
  if (!home) throw badRequest('None of those is on one shift, so what is left cannot go on a staff account.');
  return placeOnAccounts(env, {
    key: null, kind: 'left', day: home.day, slot: home.slot, user: home.user, amount: net, given: body?.shares, reason, account, fetchImpl,
    // Reconciled once the shares are good, and the leftover is keyed by the reconciliation.
    before: async (shares) => {
      await saveLink(env, { keys, note: `${net < 0 ? '−' : '+'}${ghs(net)} left, put on ${shares.map((y) => y.name).join(' and ')}: ${reason}`.slice(0, 600) }, account);
      const link = await first(env.DB, "SELECT id FROM shift_link WHERE keys = ?1 AND COALESCE(status, 'applied') = 'applied' ORDER BY id DESC LIMIT 1", JSON.stringify(keys));
      return `left:${link?.id ?? keys[0]}`;
    },
  });
}

/**
 * Shares the difference among the people chosen, all of it, on each of their
 * lists, and tells them in HIVE. `before` runs once the shares are good and
 * before anything is written: a reconciliation the leftover comes from.
 */
async function placeOnAccounts(env, { key, kind, day, slot, user, amount, given: asked, reason, account, fetchImpl, before = null }) {
  const sign = Math.sign(amount);
  const users = await hiveUsers(env);
  const nameOf = new Map(users.map((u) => [Number(u.id), u.name]));
  const given = Array.isArray(asked) ? asked : [];
  if (!given.length) throw badRequest('Choose who carries it.');
  if (given.length > 10) throw badRequest('Ten people at most.');
  const shares = [];
  for (const g of given) {
    const userId = Number(g?.userId);
    const name = nameOf.get(userId);
    if (!name) throw badRequest('Choose each person from the list.');
    if (shares.some((y) => y.userId === userId)) throw badRequest(`${name} is chosen twice.`);
    const amount = Number(g?.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest(`How much for ${name}?`);
    shares.push({ userId, name, amount: sign * amount });
  }
  const placed = shares.reduce((t, y) => t + Math.abs(y.amount), 0);
  if (placed !== Math.abs(amount)) {
    throw badRequest(`The shares come to ${ghs(placed)} and the difference is ${ghs(amount)}. Place all of it.`);
  }

  // The shift's own person: whoever signed its closing report, else the HIVE
  // login its ASSD user is mapped to.
  const report = (await hiveReports(env, day, day)).find((r) => r.slot === slot) || null;
  const ownerId = report ? Number(report.userId) : ((await people(env)).get(user) ?? null);
  const ownerName = report?.name || nameOf.get(Number(ownerId)) || nameCase(user);
  if (before) key = await before(shares);

  await run(env.DB, `INSERT INTO till_move (key, kind, day, slot, assd_user, owner_id, owner_name, amount, shares, reason, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  key, kind, day, slot, user || null, ownerId, ownerName, amount, JSON.stringify(shares), reason, who(account), now());
  const id = (await first(env.DB, 'SELECT id FROM till_move WHERE key = ?1 AND undone_at IS NULL ORDER BY id DESC LIMIT 1', key))?.id ?? null;
  // A supervisor's answer or reconciliation waiting for approval: this decides it instead.
  await setAside(env, [key], 'put on a staff account instead', account).catch(() => 0);
  await logEvent(env, key, `Put on staff accounts: ${shares.map((y) => `${y.name} ${ghs(y.amount)}`).join(', ')}: “${reason}”`, who(account));

  const what = moveWord(kind, amount);
  const whose = ownerName ? ` (${ownerName}'s shift)` : '';
  const told = [];
  for (const y of shares) {
    // eslint-disable-next-line no-await-in-loop
    if (await tell(env, [y.userId], `Moved to your account: ${ghs(y.amount)} ${what}`, `${shiftWords(day, slot)}${whose}. Why: ${reason}`, fetchImpl)) told.push(y.userId);
  }
  if (ownerId != null && !shares.some((y) => y.userId === Number(ownerId))) {
    const names = shares.map((y) => y.name).join(' and ');
    if (await tell(env, [ownerId], `Moved off your list: ${ghs(amount)} ${what}`, `${shiftWords(day, slot)}. It is now on ${names}'s account. Why: ${reason}`, fetchImpl)) told.push(Number(ownerId));
  }
  return { ok: true, id, told: told.length };
}

/** Take a difference back off staff accounts, unless a share of it has been settled. */
export async function undoMove(env, body, account, { fetchImpl } = {}) {
  await requireAdmin(account);
  const id = Number(body?.id);
  if (!Number.isInteger(id)) throw badRequest('Which one?');
  const row = await first(env.DB, 'SELECT * FROM till_move WHERE id = ?1 AND undone_at IS NULL', id).catch(() => null);
  if (!row) throw badRequest('That has been undone already.');
  const m = readMove(row);
  for (const y of m.shares) {
    // eslint-disable-next-line no-await-in-loop
    const settled = await settledAs(env, `moved:${m.id}:${y.userId}`, y.userId);
    if (settled) throw badRequest(`${y.name}'s share was ${SETTLED_WORDS[settled.outcome]} already, so it cannot be undone.`);
  }
  await run(env.DB, 'UPDATE till_move SET undone_by = ?1, undone_at = ?2 WHERE id = ?3', who(account), now(), id);
  // What was left after reconciling: the reconciliation it came from is undone too, so each is open again.
  const linkId = /^left:(\d+)$/.exec(m.key)?.[1];
  if (linkId) await run(env.DB, 'DELETE FROM shift_link WHERE id = ?1', Number(linkId));
  await logEvent(env, m.key, linkId ? 'Taken off staff accounts, and no longer reconciled together' : 'Taken off staff accounts: back on its shift', who(account));
  const what = moveWord(m.kind, m.amount);
  for (const y of m.shares) {
    // eslint-disable-next-line no-await-in-loop
    await tell(env, [y.userId], `Taken off your account: ${ghs(y.amount)} ${what}`, `${shiftWords(m.day, m.slot)}. ${who(account)} undid the move.`, fetchImpl);
  }
  if (m.owner_id != null && !m.shares.some((y) => y.userId === m.owner_id)) {
    await tell(env, [m.owner_id], `Back on your list: ${ghs(m.amount)} ${what}`, `${shiftWords(m.day, m.slot)}. ${who(account)} undid moving it to somebody else.`, fetchImpl);
  }
  return { ok: true };
}

/** What was left over after a reconciliation, on staff accounts: taken off, so the reconciliation can be undone. */
export async function undoLeftOf(env, linkId, account, { fetchImpl } = {}) {
  if (!Number.isInteger(Number(linkId))) return false;
  const row = await first(env.DB, 'SELECT id FROM till_move WHERE key = ?1 AND undone_at IS NULL', `left:${Number(linkId)}`).catch(() => null);
  if (!row) return false;
  await undoMove(env, { id: row.id }, account, { fetchImpl });
  return true;
}

/** A message in HIVE. Never fails what was done: true when it went. */
export async function tell(env, userIds, title, text, fetchImpl, kind = 'till.moved') {
  try {
    await hiveCall({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/tell',
      body: { userIds, kind, title, body: text },
    });
    return true;
  } catch { return false; }
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
  const reason = str(body?.reason, 'Why', { max: 300 });
  if (!reason || reason.length < 3) throw badRequest('Say why it is being moved: it is kept with the report.');
  // Two days either side of when it was signed: a slip of the clock, not a
  // report written for some other week.
  const report = (await hive(env, 'SELECT id, day, slot, signed_at FROM till_report WHERE id = ?1 AND reopened_at IS NULL', id))[0];
  if (report) {
    const signed = String(report.signed_at || report.day).slice(0, 10);
    if (day < addDays(signed, -MOVE_DAYS) || day > addDays(signed, MOVE_DAYS)) {
      throw badRequest(`A report can go on a shift up to two days either side of when it was signed (${signed}).`);
    }
  }
  return hiveCall({
    binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/move',
    body: { reportId: id, day, slot, by: who(account), reason },
  });
}

// --------------------------------------------------- whose shift it was --

/** Shifts somebody chose a person for: `day|slot` → { userId, name, why, by, at }. */
async function owners(env) {
  const rows = await all(env.DB, 'SELECT * FROM shift_owner').catch(() => []);
  return new Map(rows.map((r) => [`${r.day}|${r.slot}`, { userId: Number(r.hive_user_id), name: r.name || null, why: r.why, by: r.by_name, at: r.at }]));
}

/**
 * Who could have held a shift: whoever closed it in HIVE, the person the ASSD
 * login belongs to, and everybody else in HIVE, for "Somebody else".
 */
export async function ownerChoices(env, query, account) {
  await requireArea(env, account, 'reopen', 2);
  const day = String(query?.day || '');
  const slot = String(query?.slot || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !SLOT_ORDER.includes(slot)) throw badRequest('Which shift?');
  const [list, reports, map, chosen, users] = await Promise.all([
    shiftList(env, day, day).catch(() => []), hiveReports(env, day, day), people(env), owners(env), hiveUsers(env),
  ]);
  const shift = list.find((x) => x.day === day && x.slot === slot) || null;
  const report = reports.find((r) => r.slot === slot) || null;
  const assdPerson = shift?.user ? map.get(shift.user) ?? null : null;
  const nameOf = new Map(users.map((u) => [Number(u.id), u.name]));
  return {
    day, slot, assdUser: shift?.user || null,
    assdPerson: assdPerson != null ? { userId: assdPerson, name: nameOf.get(assdPerson) || null } : null,
    closedBy: report ? { userId: report.userId, name: report.name, signedAt: report.signedAt } : null,
    chosen: chosen.get(`${day}|${slot}`) || null,
    people: users.filter((u) => u.role !== 'admin').map((u) => ({ userId: Number(u.id), name: u.name })),
  };
}

/**
 * Say whose shift it was. Its differences, and its list in HIVE, follow the
 * person chosen; both the person it leaves and the person it goes to are
 * told. `userId: null` goes back to whoever closed it in HIVE.
 */
export async function setOwner(env, body, account, { fetchImpl } = {}) {
  await requireArea(env, account, 'reopen', 2);
  const day = String(body?.day || '');
  const slot = String(body?.slot || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !SLOT_ORDER.includes(slot)) throw badRequest('Which shift?');
  const c = await ownerChoices(env, { day, slot }, account);
  const before = c.chosen?.userId ?? c.closedBy?.userId ?? c.assdPerson?.userId ?? null;
  const label = `the ${slot} shift of ${day}`;
  if (body?.userId == null || body.userId === '') {
    await run(env.DB, 'DELETE FROM shift_owner WHERE day = ?1 AND slot = ?2', day, slot);
  } else {
    const userId = Number(body.userId);
    const person = c.people.find((p) => p.userId === userId);
    if (!person) throw badRequest('Choose whose shift it was.');
    const why = str(body?.why, 'Why', { max: 300 });
    if (!why || why.length < 3) throw badRequest('Say why: it is kept with the shift.');
    await run(env.DB, `INSERT INTO shift_owner (day, slot, hive_user_id, name, why, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (day, slot) DO UPDATE SET hive_user_id = ?3, name = ?4, why = ?5, by_name = ?6, at = ?7`,
    day, slot, userId, person.name, why, who(account), new Date().toISOString().slice(0, 19).replace('T', ' '));
  }
  const after = body?.userId == null || body.userId === '' ? (c.closedBy?.userId ?? c.assdPerson?.userId ?? null) : Number(body.userId);
  let told = false;
  if (before !== after) {
    const words = (body?.why ? ` “${String(body.why).trim()}”` : '');
    if (after != null) told = await tell(env, [after], `${label[0].toUpperCase()}${label.slice(1)} is now yours`, `${who(account)} said it was your shift.${words} What is on it to sort out is on your till list.`, fetchImpl, 'till.owner');
    if (before != null) await tell(env, [before], `${label[0].toUpperCase()}${label.slice(1)} is no longer yours`, `${who(account)} said it was somebody else's shift.${words} It has left your till list.`, fetchImpl, 'till.owner');
  }
  return { ok: true, changed: before !== after, told };
}

/** How far a report may be moved, in days either side of when it was signed. */
const MOVE_DAYS = 2;

/**
 * A day's three shifts, for choosing where a report goes: who ASSD has on
 * each, and the report already there, if any.
 */
export async function slotsFor(env, query, account) {
  await requireArea(env, account, 'reopen', 2);
  const day = String(query?.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('Which day?');
  const [list, reports] = await Promise.all([shiftList(env, day, day).catch(() => []), hiveReports(env, day, day)]);
  return {
    day,
    slots: SLOT_ORDER.map((slot) => {
      const r = reports.find((x) => x.slot === slot);
      return { slot, assdUser: list.find((x) => x.day === day && x.slot === slot)?.user || null, report: r ? { id: r.id, name: r.name } : null };
    }),
  };
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
    if (!row) throw badRequest(await decidedAs(env, table, col, id));
    if (body.ok) await run(env.DB, `UPDATE ${table} SET status = 'applied', decided_by = ?2, decided_at = ?3 WHERE ${col} = ?1`, id, who(account), now());
    else await run(env.DB, `DELETE FROM ${table} WHERE ${col} = ?1`, id);
    if (!isLink) await logEvent(env, id, body.ok ? `Answer “${row.answer}” approved` : `Answer “${row.answer}” rejected: back on the list`, who(account));
    return { ok: true };
  }
  const seq = Number(body?.seq);
  if (!Number.isInteger(seq)) throw badRequest('Which movement?');
  const row = await first(env.DB, "SELECT * FROM shift_movement WHERE seq = ?1 AND status = 'pending'", seq);
  if (!row) {
    const was = await first(env.DB, 'SELECT status, decided_by, decided_at FROM shift_movement WHERE seq = ?1', seq).catch(() => null);
    throw badRequest(was ? `That correction was already ${was.status === 'applied' ? 'approved' : 'rejected'}${was.decided_by ? ` by ${was.decided_by}` : ''}${was.decided_at ? `, ${String(was.decided_at).slice(0, 16)}` : ''}.`
      : 'That correction is no longer waiting: it was taken back.');
  }
  if (body?.ok) {
    await run(env.DB, "UPDATE shift_movement SET status = 'applied', decided_by = ?2, decided_at = ?3 WHERE seq = ?1", seq, who(account), now());
  } else {
    await run(env.DB, "UPDATE shift_movement SET status = 'rejected', decided_by = ?2, decided_at = ?3 WHERE seq = ?1", seq, who(account), now());
  }
  return { ok: true };
}

/**
 * Why an answer is no longer waiting, in words: approved by whom, put on a
 * staff account instead, or rejected or taken back (which leave nothing).
 */
async function decidedAs(env, table, col, id) {
  const row = await first(env.DB, `SELECT * FROM ${table} WHERE ${col} = ?1`, id).catch(() => null);
  if (row && (row.status || 'applied') === 'applied') {
    return `That was already approved${row.decided_by ? ` by ${row.decided_by}` : ''}${row.decided_at ? `, ${String(row.decided_at).slice(0, 16)}` : ''}.`;
  }
  if (table === 'shift_answer') {
    const moved = await first(env.DB, 'SELECT shares, by_name, at FROM till_move WHERE key = ?1 AND undone_at IS NULL ORDER BY id DESC LIMIT 1', id).catch(() => null);
    if (moved) {
      let names = '';
      try { names = JSON.parse(moved.shares).map((x) => x.name).filter(Boolean).join(' and '); } catch { names = ''; }
      return `That was already decided: put on ${names ? `${names}'s` : 'a staff'} account${moved.by_name ? ` by ${moved.by_name}` : ''}${moved.at ? `, ${String(moved.at).slice(0, 16)}` : ''}.`;
    }
  }
  return 'That is no longer waiting: it was rejected, or taken back by whoever answered.';
}

/** How long after one approval email the next waits: answers come in runs. */
const APPROVAL_QUIET_MS = 15 * 60 * 1000;

/**
 * Tell the admins that a supervisor's answer or correction is waiting.
 * Never throws.
 *
 * Once per quarter of an hour at most. A supervisor going down a list sends
 * five answers in five minutes, and five emails that each read alike are
 * noise; the first says what it is and how many are waiting in all, and
 * Approvals shows every one of them. One that comes in after the quiet
 * spell is told again, with the count as it then stands.
 */
export async function tellApprovers(env, { seq, kind, by, text = null }, { fetchImpl, now = Date.now() } = {}) {
  try {
    const s = await getSettings(env.DB).catch(() => ({}));
    const last = Date.parse(String(s.approval_told_at || '').replace(' ', 'T'));
    if (Number.isFinite(last) && now - last < APPROVAL_QUIET_MS) return false;
    const { to } = await linkRecipients(env, { event: 'approval' });
    if (!to.length) return false;
    const said = text || `${by} says ASSD ${seq} ${kind === 'duplicate' ? 'is a duplicate' : kind === 'reverses' ? 'puts back another movement' : `was ${kind}`}.`;
    const [answers, moves, drawer] = await Promise.all([pendingAnswers(env), pendingMovements(env), drawerAsksCount(env)]);
    const waiting = answers.length + moves.length + drawer;
    await hiveCall({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/tell',
      body: {
        recipients: to, kind: 'till.approval',
        title: waiting > 1 ? `${waiting} things waiting for your approval` : 'Waiting for your approval',
        body: `${said}${waiting > 1 ? ` ${waiting} are waiting in all.` : ''} Decide in Insight → ✓ Approvals.`,
      },
    });
    await setSetting(env.DB, 'approval_told_at', new Date(now).toISOString());
    return true;
  } catch { return false; /* the answer or correction is saved either way */ }
}

/** POs made in Insight that staff want to pay from a drawer, waiting for an admin. */
async function drawerAsksCount(env) {
  const row = await first(env.DB, 'SELECT COUNT(*) AS n FROM po_created WHERE drawer_ok IS NULL AND asked_at IS NOT NULL').catch(() => null);
  return Number(row?.n) || 0;
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
      await run(env.DB, `INSERT INTO till_notify (hive_user_id, name, push, email, amounts, on_closed, on_answer, on_approval, on_summary)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT (hive_user_id) DO UPDATE SET name = ?2, push = ?3, email = ?4, amounts = ?5, on_closed = ?6, on_answer = ?7, on_approval = ?8, on_summary = ?9`,
      id, str(n.name, 'Name', { max: 120 }) || old?.name || `HIVE ${id}`,
      flag(n.push, old?.push ?? 1), flag(n.email, old?.email ?? 1), flag(n.amounts, old?.amounts ?? 1),
      flag(n.onClosed, old?.on_closed ?? 1), flag(n.onAnswer, old?.on_answer ?? 1), flag(n.onApproval, old?.on_approval ?? 0),
      flag(n.onSummary, old?.on_summary ?? 1));
    }
  }

  if (body?.access) {
    const a = body.access;
    const accountId = Number(a.accountId ?? 0);
    if (!Number.isInteger(accountId) || accountId < 0) throw badRequest('Whose access?');
    if (a.reset) {
      await run(env.DB, 'DELETE FROM till_access WHERE account_id = ?1 AND account_id <> 0', accountId);
    } else if (a.preset) {
      const preset = PRESETS.find((x) => x.key === a.preset);
      if (!preset) throw badRequest('Which preset?');
      await env.DB.batch(AREAS.map((x) => env.DB.prepare(`INSERT INTO till_access (account_id, area, level) VALUES (?1, ?2, ?3)
        ON CONFLICT (account_id, area) DO UPDATE SET level = ?3`).bind(accountId, x.key, Math.min(x.max, preset.levels[x.key] || 0))));
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
