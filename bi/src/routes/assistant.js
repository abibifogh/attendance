import { all, first, getSettings, setSetting } from '../lib/db.js';
import { badRequest, forbidden } from '../lib/http.js';
import * as approvals from './approvals.js';
import * as panels from './panels.js';
import * as floats from './floats.js';
import * as receipts from './receipts.js';
import * as np from './niceplace.js';
import * as mgmt from './mgmt.js';
import { listTodos } from './todo.js';
import * as supplierbook from './supplierbook.js';
import { requireAdmin, roleOf, accessOf } from './till.js';
import { reportsOf } from './reportaccess.js';
import { envelopeLines } from './envelopes.js';
import * as proof from './proof.js';

/**
 * The Assistant: everything that needs you, from every system Insight reads,
 * in one list, each with what Insight would do about it. An admin's covers
 * everything; anybody else's only what their access lets them see (see
 * `sourcesFor`), so a supervisor, an uploader or somebody given only reports
 * has one too, about their own work.
 *
 * Four kinds:
 * - **decide**: waiting on a yes or a no (approvals in every system, drafts
 *   from receipts, counters nobody could read, answers to look at);
 * - **fix**: something going wrong, with how to put it right (the findings,
 *   money held in floats too long, bills overdue in Odoo (only when an admin
 *   turns them on), to-dos nobody has);
 * - **review**: worth a read (the week's report, names not linked to Odoo,
 *   files not loaded);
 * - **done**: what Insight did by itself lately, to check.
 *
 * Each source is read on its own: one that fails is said in "What I read",
 * and the rest still come. Nothing here changes anything; the actions are the
 * ones each system already has, or a link to where it is done.
 *
 * The morning summary and Ask are written by Workers AI from these items and
 * nothing else. Without it, the summary is plain counts and Ask says so.
 */

export const MODEL = np.READ_MODEL;
const DAY = 86_400_000;
const FLOAT_DAYS = 14;
/** How long one place may take to answer before the list goes without it: another system being slow must not hold the page. */
const SOURCE_MS = 6000;
const BILL_DAYS = 30;

const daysSince = (at, now) => (at ? Math.max(0, Math.floor((now - Date.parse(String(at).length <= 10 ? `${at}T12:00:00Z` : at)) / DAY)) : null);
const ageWords = (n) => (n == null ? '' : n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days`);
const cedi = (minor) => `GH₵ ${(Math.round(Number(minor) || 0) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;

/** Each source: its label, the kind of items it gives, and how they are read. */
const SOURCES = [
  { id: 'approvals', label: 'Approvals in every system', read: readApprovals, area: 'approvals', tag: 'Approval' },
  { id: 'findings', label: 'Insight’s checks', read: readFindings, area: 'checks', tag: 'Check' },
  { id: 'receipts', label: 'Receipts', read: readReceipts, area: 'buying', tag: 'Receipts' },
  { id: 'floats', label: 'Floats', read: readFloats, area: 'buying', tag: 'Floats' },
  { id: 'bills', label: 'Odoo bills', read: readBills, area: 'buying', tag: 'Odoo' },
  { id: 'todos', label: 'POs to chase', read: readTodos, area: 'buying', tag: 'POs' },
  { id: 'niceplace', label: 'Nice Place', read: readNicePlace, area: 'niceplace', tag: 'Nice Place' },
  { id: 'files', label: 'Shift files', read: readFiles, area: 'shifts', tag: 'Files' },
  { id: 'suppliers', label: 'Suppliers', read: readSuppliers, area: 'buying', tag: 'Suppliers' },
  { id: 'report', label: 'Management report', read: readReport, area: 'report', tag: 'Report' },
];

/** What anybody who works shifts has of their own: to-dos given to them, and proof asked of them. */
const GIVEN = { id: 'given', label: 'To-dos given to you', read: readGiven, area: 'given', tag: 'To-do' };
const PROOF = { id: 'proof', label: 'Proof asked of you', read: readProofAsked, area: 'given', tag: 'Proof asked' };
const ENVELOPES = { id: 'envelopes', label: 'Envelopes to receive', read: readEnvelopes, area: 'safe', tag: 'Safe' };

/**
 * The last list read for each admin, for a minute: the summary and Ask come
 * a moment after the page and use it, rather than asking every system again.
 */
const recent = new Map();
const RECENT_MS = 60_000;

/** Anybody with Insight access of any kind; somebody given only other systems is not. */
async function requireMember(account) {
  if (!roleOf(account)) throw forbidden('Insight has not been shared with you.');
}

/**
 * What this person's Assistant reads: an admin, every source; anybody else,
 * only what their access already shows them elsewhere in Insight.
 *
 * - Insight's checks: the Brief's findings, for whoever the Brief is shared with.
 * - To-dos given to them, for a supervisor.
 * - Shifts not checked yet, for a supervisor who may check shifts.
 * - Staff answers from HIVE waiting for a decision, for a supervisor who acts on answers.
 * - Nice Place: shifts with no sales sent, for whoever sees Nice Place; counters to read, for whoever reads them.
 * - The ASSD journal not loaded, for whoever loads the shift files (an uploader too).
 *
 * Approvals, receipts, floats, bills, suppliers, the management report and the
 * Nice Place pickups to approve stay an admin's.
 */
export async function sourcesFor(env, account) {
  const role = roleOf(account);
  if (role === 'admin') return [GIVEN, PROOF, ...SOURCES, ENVELOPES];
  const access = await accessOf(env, account);
  const reports = await reportsOf(env, account).catch(() => []);
  const out = [];
  if (reports.includes('brief')) out.push(SOURCES.find((x) => x.id === 'findings'));
  if (role === 'supervisor') {
    out.push(GIVEN, PROOF);
    out.push({ id: 'mytodos', label: 'POs to chase', read: readMyTodos, area: 'buying', tag: 'POs' });
    if ((access.check || 0) >= 2) out.push({ id: 'checks', label: 'Shifts to check', read: readUnchecked, area: 'shifts', tag: 'Shift' });
    if ((access.answers || 0) >= 2) out.push({ id: 'staffanswers', label: 'Staff answers from HIVE', read: readStaffAnswers, area: 'shifts', tag: 'Staff answer' });
    if ((access.envelopes || 0) >= 2) out.push(ENVELOPES);
  }
  // Shifts with no sales sent, for whoever can open the Nice Place page; counters to read, for
  // whoever reads them (a supervisor does it in To sort out).
  const npPage = reports.includes('niceplace');
  const npRead = role === 'supervisor' && (access.niceplace || 0) >= 2;
  if (npPage || npRead) {
    out.push({ id: 'niceplace', label: 'Nice Place', area: 'niceplace', tag: 'Nice Place', read: (e, a, n) => readNicePlace(e, a, n, { pickups: false, missing: npPage, readings: npRead, href: '#/inbox' }) });
  }
  if ((access.files || 0) >= 2) out.push({ id: 'files', label: 'Shift files', area: 'shifts', tag: 'Files', read: (e, a, n) => readFiles(e, a, n, { href: role === 'uploader' ? '#/upload' : '#/files' }) });
  return out;
}

/** May this person see money figures: an admin, or a supervisor given amounts. */
async function seesMoney(env, account) {
  if (roleOf(account) === 'admin') return true;
  return ((await accessOf(env, account)).money || 0) >= 1;
}

/** The list as just read for this page, or read now. Opening the page always reads it fresh. */
export async function gatherOnce(env, account, { fresh = false, now = Date.now() } = {}) {
  await requireMember(account);
  const key = account?.id ?? 'owner';
  const had = recent.get(key);
  if (!fresh && had && Date.now() - had.at < RECENT_MS) return had.data;
  const data = await gather(env, account, { now });
  recent.set(key, { at: Date.now(), data });
  return data;
}

/**
 * Bills owed in Odoo are left out of what the Assistant flags unless an admin
 * turns them on: what is owed to suppliers is paid on its own rhythm, and a
 * big balance would otherwise sit at the top of the list and the summary.
 * Buying › Suppliers still shows every bill.
 */
export const BILLS_SETTING = 'assistant_bills';
export async function billsOn(env) {
  const s = await getSettings(env.DB).catch(() => ({}));
  return s[BILLS_SETTING] === '1';
}

/** An admin's: whether bills owed in Odoo are flagged. */
export async function setBills(env, body, account) {
  await requireAdmin(account);
  if (typeof body?.on !== 'boolean') throw badRequest('Say on or off.');
  await setSetting(env.DB, BILLS_SETTING, body.on ? '1' : '0');
  recent.clear();
  return { ok: true, on: body.on };
}

/** Everything this person may see: all of it for an admin. */
export async function gather(env, account, { now = Date.now(), sources = null } = {}) {
  await requireMember(account);
  const admin = roleOf(account) === 'admin';
  if (!sources) sources = await sourcesFor(env, account);
  const money = await seesMoney(env, account);
  const read = [];
  const items = [];
  const bills = admin && await billsOn(env);
  // Bills turned off: not read, and said so where the places read are listed.
  if (!bills && sources.some((s) => s.id === 'bills')) read.push({ id: 'bills', label: 'Odoo bills', ok: true, off: true, count: 0 });
  await Promise.all(sources.filter((s) => bills || s.id !== 'bills').map(async (s) => {
    try {
      let timer;
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Took too long to answer; it is read again next time.')), SOURCE_MS); });
      const got = await Promise.race([s.read(env, account, now), late]).finally(() => clearTimeout(timer));
      // Amounts only for whoever may see money; the Brief's own findings show theirs on the Brief.
      for (const item of got) items.push({ source: s.label, area: s.area || 'other', tag: s.tag || s.label, ...item, ...(money || s.id === 'findings' ? {} : { amount: null, amountNote: null }) });
      read.push({ id: s.id, label: s.label, ok: true, count: got.length });
    } catch (err) {
      read.push({ id: s.id, label: s.label, ok: false, error: err.message });
    }
  }));
  read.sort((a, b) => sources.findIndex((s) => s.id === a.id) - sources.findIndex((s) => s.id === b.id));
  const RANK = { crit: 0, warn: 1, info: 2, good: 3 };
  items.sort((a, b) => RANK[a.sev] - RANK[b.sev] || (b.amount || 0) - (a.amount || 0) || (b.age || 0) - (a.age || 0));
  const done = admin ? await doneLately(env, now).catch(() => []) : [];
  const open = items.filter((x) => x.tab !== 'done');
  const counts = Object.fromEntries(['decide', 'fix', 'review'].map((t) => [t, open.filter((x) => x.tab === t).length]));
  return {
    at: new Date(now).toISOString(),
    items: [...open, ...done],
    counts: { ...counts, done: done.length },
    tiles: {
      needYou: open.length,
      urgent: open.filter((x) => x.sev === 'crit').length,
      atStake: open.reduce((t, x) => t + (x.amount || 0), 0),
      oldest: open.reduce((m, x) => Math.max(m, x.age || 0), 0),
      done: done.length,
    },
    read,
    billsOn: bills,
    admin,
    money,
  };
}

// ---------------------------------------------------------------- sources --

/** Approvals in every system: each with the choices that need nothing typed, done from here. */
async function readApprovals(env, account, now) {
  const { items, systems } = await approvals.list(env, account);
  const down = systems.filter((s) => !s.ok);
  const out = items.map((x) => {
    const age = daysSince(x.askedAt, now);
    const quick = (x.decisions || []).filter((d) => d.note === 'none' && !(d.fields || []).length);
    return {
      tab: 'decide', key: `approval:${x.system}:${x.kind}:${x.id}`, sev: age >= 7 ? 'warn' : 'info',
      title: x.title, why: x.sub, system: x.systemLabel, age, amount: x.amount || null,
      // Decided the day after it was asked, like a staff answer.
      due: x.askedAt ? plusDay(String(x.askedAt).slice(0, 10), 1) : null,
      advice: age >= 7 ? `It has waited ${age} days: decide it today, or ask ${x.who || 'whoever asked'} what is missing.` : 'Check the details, then decide it here.',
      actions: [
        ...quick.map((d) => ({ label: d.label, primary: Boolean(d.primary), decide: { system: x.system, kind: x.kind, id: x.id, decision: d.key } })),
        { label: quick.length < (x.decisions || []).length ? 'More choices' : 'Open', href: '#/approvals' },
      ],
    };
  });
  for (const s of down) {
    out.push({ tab: 'review', key: `approvals-down:${s.id}`, sev: 'warn', title: `${s.label} could not be read for approvals`, why: s.error, advice: 'Its approvals are missing from this list until it answers. Try again later, or check the link under Settings › Connections & files.', actions: [{ label: 'Approvals', href: '#/approvals' }] });
  }
  return out;
}

/** Insight's own checks, worth the most money first. */
async function readFindings(env, account, now) {
  const { findings } = await panels.findings(env, { state: 'live' });
  return findings.slice(0, 12).map((f) => ({
    tab: 'fix', key: `finding:${f.id}`, sev: f.severity === 'critical' ? 'crit' : f.severity === 'warning' ? 'warn' : 'info',
    title: f.headline, why: f.detail, advice: f.action || null, system: (f.sources || []).join(' · ') || 'Insight',
    amount: f.impactMonthly ? Math.round(f.impactMonthly) : null, amountNote: f.impactMonthly ? 'a month' : null,
    age: daysSince(f.firstSeenAt, now),
    actions: [{ label: 'Open the Brief', href: '#/brief' }],
  }));
}

/** Receipts with no PO yet, or a draft to check. */
async function readReceipts(env) {
  const { items } = await receipts.list(env);
  const open = items.filter((x) => ['unread', 'failed'].includes(x.status));
  const check = items.filter((x) => x.status === 'check');
  const out = [];
  if (open.length) {
    out.push({
      tab: 'decide', key: 'receipts:open', sev: 'warn', title: `${open.length} receipt${open.length === 1 ? '' : 's'} with no PO yet`,
      why: open.slice(0, 3).map((x) => `${x.vendorText || x.name || 'A receipt'}${x.problem ? `: ${x.problem}` : ''}`).join(' · '),
      amount: open.reduce((t, x) => t + (Number(x.amount) || 0), 0) || null,
      advice: 'Try reading them again, or fill them in by hand: the receipt is already attached.',
      actions: [{ label: 'Open receipts', href: '#/receipts', primary: true }],
    });
  }
  if (check.length) {
    out.push({
      tab: 'decide', key: 'receipts:check', sev: 'info', title: `${check.length} draft PO${check.length === 1 ? '' : 's'} from receipts to check`,
      why: check.slice(0, 3).map((x) => `${x.po?.name || ''} ${x.vendorName || x.vendorText || ''}`.trim()).join(' · '),
      amount: check.reduce((t, x) => t + (Number(x.amount) || 0), 0) || null,
      advice: 'Each has a vendor or an item on a placeholder. Change it to the real one in Odoo, then confirm.',
      actions: [{ label: 'Open receipts', href: '#/receipts', primary: true }],
    });
  }
  return out;
}

/** Money held in floats with nothing sent for a while. */
async function readFloats(env) {
  const { people } = await floats.list(env);
  const quiet = people.filter((p) => p.active && p.held > 0 && p.quiet >= FLOAT_DAYS);
  const look = people.reduce((t, p) => t + (p.toLookAt || 0), 0);
  const out = [];
  if (quiet.length) {
    out.push({
      tab: 'fix', key: 'floats:quiet', sev: 'warn',
      title: `${cedi(quiet.reduce((t, p) => t + p.held, 0))} in floats with nothing sent for over ${FLOAT_DAYS} days`,
      why: quiet.map((p) => `${p.name} ${cedi(p.held)} (${p.quiet} days)`).join(', '),
      amount: quiet.reduce((t, p) => t + p.held, 0), age: Math.max(...quiet.map((p) => p.quiet)),
      advice: `Ask ${quiet.length === 1 ? quiet[0].name : 'each of them'} for the receipts, or the money back, by a set day. Their link sends receipts straight in.`,
      actions: [{ label: 'Open floats', href: '#/floats', primary: true }],
    });
  }
  if (look) {
    out.push({ tab: 'decide', key: 'floats:look', sev: 'info', title: `${look} float receipt${look === 1 ? '' : 's'} to look at`, advice: 'A receipt sent from a float link that could not be made into a PO by itself.', actions: [{ label: 'Open floats', href: '#/floats', primary: true }] });
  }
  return out;
}

/** Odoo bills still owed long after their day, by supplier. */
async function readBills(env, account, now) {
  const before = new Date(now - BILL_DAYS * DAY).toISOString().slice(0, 10);
  const rows = await all(env.DB, `SELECT s.name AS supplier, COUNT(*) AS n, SUM(b.residual) AS owed, MIN(b.day) AS oldest
    FROM fact_bill b LEFT JOIN dim_supplier s ON s.id = b.supplier_id
    WHERE b.state = 'posted' AND b.residual > 0 AND b.day < ?1
    GROUP BY b.supplier_id ORDER BY owed DESC LIMIT 5`, before);
  return rows.map((r) => {
    const age = daysSince(r.oldest, now);
    return {
      tab: 'fix', key: `bill:${r.supplier}`, sev: age > 60 ? 'warn' : 'info',
      title: `${r.supplier || 'A supplier'} is owed ${cedi(r.owed)}`,
      why: `${r.n} bill${r.n === 1 ? '' : 's'} in Odoo, the oldest from ${r.oldest}.`, amount: Number(r.owed) || 0, age, system: 'Odoo',
      advice: 'Pay it, or tell them when. How they are paid is on their supplier card.',
      actions: [{ label: 'Open suppliers', href: '#/suppliers', primary: true }],
    };
  });
}

/** Answers waiting for an admin, and to-dos nobody has been given. */
async function readTodos(env, account) {
  const { items } = await listTodos(env, account);
  const answered = items.filter((t) => t.state === 'answered');
  const nobody = items.filter((t) => t.state === 'open' && !t.assignee);
  const out = [];
  if (answered.length) out.push({ tab: 'decide', key: 'todos:answered', sev: 'info', title: `${answered.length} answer${answered.length === 1 ? '' : 's'} on POs to chase to decide`, advice: 'A supervisor said what happened; accept it, or send it back.', actions: [{ label: 'Open To sort out', href: '#/inbox', primary: true }] });
  if (nobody.length) out.push({ tab: 'fix', key: 'todos:nobody', sev: 'warn', title: `${nobody.length} PO${nobody.length === 1 ? '' : 's'} to chase that nobody has been given`, advice: 'Give each to a supervisor so somebody chases it.', actions: [{ label: 'Open To sort out', href: '#/inbox', primary: true }] });
  return out;
}

/** Counters a picture could not be read for; pickups to review; shifts with no sales sent. */
async function readNicePlace(env, account, now, { pickups: withPickups = true, missing: withMissing = true, readings = true, href = '#/niceplace' } = {}) {
  const out = [];
  const pickups = withPickups ? await all(env.DB, "SELECT * FROM np_pickup WHERE status = 'review' ORDER BY day").catch(() => []) : [];
  for (const p of pickups) {
    const net = p.sales - p.spent;
    const diff = p.counted - net;
    out.push({
      tab: 'decide', key: `np:pickup:${p.id}`, sev: diff < 0 ? 'warn' : 'info',
      title: `Nice Place pickup of ${new Date(`${p.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} by ${p.by_name}: ${cedi(p.counted)} counted`,
      why: `Sales ${cedi(p.sales)}, spent ${cedi(p.spent)}, net cash ${cedi(net)}.${diff ? ` ${cedi(Math.abs(diff))} ${diff < 0 ? 'short' : 'over'}${p.note ? `: “${p.note}”` : ''}.` : ''}`,
      // At stake is only what is short; the rest is in the safe.
      amount: diff < 0 ? -diff : null, age: daysSince(p.recorded_at || p.day, now),
      advice: diff < 0 ? `Ask ${p.by_name} about the ${cedi(-diff)}, or approve it if the reason holds.` : 'The count matches: approve it.',
      actions: [{ label: 'Open pickups', href: '#/np-pickups', primary: true }],
    });
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - 3 * DAY).toISOString().slice(0, 10);
  const sent = new Set((await all(env.DB, 'SELECT day, shift FROM np_revenue WHERE day >= ?1', from).catch(() => [])).map((r) => `${r.day}|${r.shift}`));
  const started = withMissing && await first(env.DB, "SELECT 1 AS yes FROM np_revenue WHERE uploaded_by LIKE 'Desk:%' LIMIT 1").catch(() => null);
  if (started) {
    const missing = [];
    for (let d = from; d < today; d = new Date(Date.parse(`${d}T12:00:00Z`) + DAY).toISOString().slice(0, 10)) {
      for (const shift of np.SHIFTS) if (!sent.has(`${d}|${shift}`)) missing.push(`${d} ${shift}`);
    }
    if (missing.length) out.push({ tab: 'fix', key: 'np:missing', sev: 'warn', title: `Nice Place: ${missing.length} shift${missing.length === 1 ? '' : 's'} with no sales sent`, why: missing.join(', '), advice: 'Ask whoever was on to send it from the Nice Place link; until then the counters cannot be checked against the money.', actions: [{ label: 'Open Nice Place', href: '#/niceplace', primary: true }] });
  }
  if (!readings) return out;
  const { items } = await np.pendingReadings(env);
  if (!items.length) return out;
  return [...out, {
    tab: 'decide', key: 'np:pending', sev: 'info', title: `${items.length} Nice Place reading${items.length === 1 ? '' : 's'} with a counter to read`,
    why: items.slice(0, 3).map((x) => `${x.day} ${x.shift}${x.problem ? `: ${x.problem}` : ''}`).join(' · '),
    age: daysSince(items[0].sentAt || items[0].day, now),
    advice: 'Read the number off the picture; the reading before is beside it, so a number far off stands out.',
    actions: [{ label: href === '#/inbox' ? 'Open To sort out' : 'Open Nice Place', href, primary: true }],
  }];
}

/** The ASSD journal not loaded lately: every front desk check stops there. */
async function readFiles(env, account, now, { href = '#/files' } = {}) {
  const row = await first(env.DB, "SELECT MAX(to_day) AS to_day FROM shift_upload WHERE kind = 'journal'");
  const last = row?.to_day || null;
  const age = daysSince(last, now);
  if (last && age <= 2) return [];
  return [{
    tab: 'fix', key: 'files:journal', sev: last ? 'warn' : 'info',
    title: last ? `The ASSD journal has not been loaded since ${last}` : 'No ASSD journal loaded yet',
    why: 'Shifts, drawers, card and MoMo checks and room revenue all stop at the last day loaded.', age,
    advice: href === '#/upload' ? 'Load the journal, with the terminal and MoMo files, on the Upload files page.' : 'Ask the night auditor to load it, or load it under Settings › Connections & files › Shift files.',
    actions: [{ label: href === '#/upload' ? 'Upload files' : 'Shift files', href, primary: true }],
  }];
}

/** A supervisor's own to-dos: given to them, and sent back. */
async function readMyTodos(env, account, now) {
  const { items } = await listTodos(env, account);
  const open = items.filter((t) => t.state === 'open');
  const back = open.filter((t) => t.sentBack);
  const out = [];
  if (back.length) {
    out.push({ tab: 'fix', key: 'mytodos:back', sev: 'warn', title: `${back.length} PO item${back.length === 1 ? '' : 's'} sent back to you`, why: back.slice(0, 3).map((t) => `${t.kindLabel}${t.ref ? ` ${t.ref}` : ''}: ${t.sentBack}`).join(' · '), advice: 'An admin asked for more: say what happened, or what you found.', actions: [{ label: 'Open To sort out', href: '#/inbox', primary: true }] });
  }
  const fresh = open.filter((t) => !t.sentBack);
  if (fresh.length) {
    const oldest = Math.max(...fresh.map((t) => daysSince(t.openedAt || t.day, now) || 0));
    out.push({ tab: 'fix', key: 'mytodos:open', sev: oldest >= 3 ? 'warn' : 'info', title: `${fresh.length} PO${fresh.length === 1 ? '' : 's'} to chase in Odoo`, why: fresh.slice(0, 3).map((t) => `${t.kindLabel}${t.ref ? ` ${t.ref}` : ''}${t.day ? `, ${t.day}` : ''}`).join(' · '), age: oldest, advice: 'Find out what happened to each, and answer it.', actions: [{ label: 'Open To sort out', href: '#/inbox', primary: true }] });
  }
  return out;
}

/** To-dos made from a difference for this person, one line each, by the day they are due. */
async function readGiven(env, account, now) {
  if (account?.id == null) return [];
  const today = new Date(now).toISOString().slice(0, 10);
  const rows = await all(env.DB, "SELECT * FROM shift_task WHERE state = 'open' AND for_id = ?1 ORDER BY due, id", Number(account.id)).catch(() => []);
  return rows.map((t) => ({
    tab: 'fix', key: `task:${t.id}`, sev: t.due < today ? 'warn' : 'info',
    title: t.what, why: t.about ? `About ${t.about}` : null,
    from: t.made_by_id != null && Number(t.made_by_id) === Number(account.id) ? null : t.made_by,
    due: t.due, age: daysSince(t.made_at, now),
    actions: [
      t.day && t.slot ? { label: 'Open shift', shift: { day: t.day, slot: t.slot } } : null,
      { label: 'Done', task: t.id, primary: true },
    ].filter(Boolean),
  }));
}

/** Proof an admin asked of this person's answers, due the day it was asked. */
async function readProofAsked(env, account, now) {
  const { requests } = await proof.mine(env, account);
  return requests.map((r) => ({
    tab: 'fix', key: `proof:${r.id}`, sev: 'warn',
    title: `Send proof for “${String(r.about || 'your answer').slice(0, 90)}”`,
    why: r.note ? `“${r.note}”` : null, from: r.askedBy,
    due: String(r.askedAt || '').slice(0, 10) || null, age: daysSince(r.askedAt, now),
    actions: [{ label: 'Send proof', href: '#/inbox', primary: true }],
  }));
}

/** Envelopes moved to the safe in the last month that nobody has marked received. */
async function readEnvelopes(env, account, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const lines = (await envelopeLines(env, { from: plusDay(today, -30), to: today }, account)).filter((l) => !l.received);
  if (!lines.length) return [];
  const oldest = lines.map((l) => l.day).sort()[0];
  const shifts = [...new Set(lines.map((l) => `${dayWords(l.day)} ${l.slot}`))];
  const numbers = lines.map((l) => l.no).filter(Boolean);
  return [{
    tab: 'fix', key: 'envelopes:open', sev: 'info',
    title: `${lines.length} envelope${lines.length === 1 ? '' : 's'} moved to the safe, not marked received`,
    why: `${shifts.slice(0, 3).join(', ')}${shifts.length > 3 ? ' and more' : ''}${numbers.length ? ` · ${numbers.slice(0, 4).join(', ')}${numbers.length > 4 ? '…' : ''}` : ''}`,
    amount: lines.reduce((t, l) => t + (l.expected || 0), 0) || null,
    due: plusDay(oldest, 1), age: daysSince(oldest, now),
    actions: [{ label: 'Open safe', href: '#/safe', primary: true }],
  }];
}

const plusDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayWords = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
/** "Tue 27 Oct night" from a difference's key, when it names its shift. */
function shiftOfKey(key) {
  const m = /(\d{4}-\d{2}-\d{2})[:|](morning|afternoon|night)/.exec(String(key || ''));
  return m ? `${dayWords(m[1])} ${m[2]}` : null;
}

/**
 * Each item placed by when it wants doing: `overdue` (its day has passed),
 * `today`, or `later`. An item with a day is placed by it. One without is
 * placed by how urgent it is: urgent, or waiting a week, is overdue; "soon"
 * is today; the rest later. `late` is how many days past its day.
 */
export function arrange(items, today) {
  const span = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
  return items.map((x) => {
    if (x.tab === 'done') return x;
    let when;
    let late = null;
    if (x.due) {
      when = x.due < today ? 'overdue' : x.due === today ? 'today' : 'later';
      if (when === 'overdue') late = span(x.due, today);
    } else if (x.sev === 'crit') when = 'today';
    else if ((x.age || 0) >= 7) { when = 'overdue'; late = x.age - 7 || null; }
    else when = x.sev === 'warn' ? 'today' : 'later';
    return { ...x, when, late };
  }).sort((a, b) => WHEN_RANK[a.when] - WHEN_RANK[b.when] || String(a.due || '9').localeCompare(String(b.due || '9')) || RANK_SEV[a.sev] - RANK_SEV[b.sev] || (b.age || 0) - (a.age || 0));
}
const WHEN_RANK = { overdue: 0, today: 1, later: 2, undefined: 3 };
const RANK_SEV = { crit: 0, warn: 1, info: 2, good: 3 };

const SLOT_NAMES = ['morning', 'afternoon', 'night'];
const CHECK_DAYS = 7;

/** Shifts of the last week, up to the last day loaded, that nobody has checked. */
async function readUnchecked(env, account, now) {
  const last = (await first(env.DB, "SELECT MAX(to_day) AS to_day FROM shift_upload WHERE kind = 'journal'").catch(() => null))?.to_day;
  if (!last) return [];
  const today = new Date(now).toISOString().slice(0, 10);
  const dayOf = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);
  const from = dayOf(CHECK_DAYS);
  const to = [dayOf(1), last].sort()[0];
  if (to < from) return [];
  const done = new Set((await all(env.DB, 'SELECT day, slot FROM shift_check WHERE day BETWEEN ?1 AND ?2', from, to).catch(() => [])).map((r) => `${r.day}|${r.slot}`));
  const left = [];
  for (let d = from; d <= to && d < today; d = new Date(Date.parse(`${d}T12:00:00Z`) + DAY).toISOString().slice(0, 10)) {
    for (const slot of SLOT_NAMES) if (!done.has(`${d}|${slot}`)) left.push({ day: d, slot });
  }
  // One line each, due the day after the shift: a shift is checked the next day.
  return left.map((x) => ({
    tab: 'fix', key: `check:${x.day}|${x.slot}`, sev: 'info',
    title: `Check ${dayWords(x.day)} ${x.slot} shift`,
    due: plusDay(x.day, 1), age: daysSince(x.day, now),
    advice: 'Look at its report, drawer and payments, and mark it checked: until then its people see their differences as not final.',
    actions: [{ label: 'Open shift', shift: { day: x.day, slot: x.slot }, primary: true }],
  }));
}

/** Answers staff gave in HIVE in the last month that nobody has decided yet. */
async function readStaffAnswers(env, account, now) {
  if (!env.ATT_DB) return [];
  const since = new Date(now - 30 * DAY).toISOString().slice(0, 19).replace('T', ' ');
  const answers = await all(env.ATT_DB, `SELECT a.key, a.user_id, a.at, a.text, u.name FROM till_answer a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.how <> 'note' AND a.at >= ?1 ORDER BY a.id`, since).catch(() => []);
  if (!answers.length) return [];
  const decided = await all(env.DB, 'SELECT key, hive_user_id, at FROM till_resolution WHERE at >= ?1', since).catch(() => []);
  const latest = new Map();
  for (const a of answers) latest.set(`${a.key}|${a.user_id}`, a);
  const waiting = [...latest.values()].filter((a) => !decided.some((d) => d.key === a.key && Number(d.hive_user_id) === Number(a.user_id) && String(d.at) >= String(a.at)));
  // One line each, due the day after it was given.
  return waiting.map((a) => ({
    tab: 'decide', key: `staffanswer:${a.key}|${a.user_id}`, sev: 'info',
    title: `${a.name || 'Somebody'} answered${a.text ? `: “${String(a.text).slice(0, 90)}${String(a.text).length > 90 ? '…' : ''}”` : ''}`,
    why: shiftOfKey(a.key), due: plusDay(String(a.at).slice(0, 10), 1), age: daysSince(a.at, now),
    advice: 'Read what they said: accept it, ask for proof, or send it back.',
    actions: [{ label: 'Decide', href: '#/inbox', primary: true }],
  }));
}

/** Names typed in the other apps that match no Odoo supplier. */
async function readSuppliers(env, account) {
  const { unlinked } = await supplierbook.book(env, {}, account);
  const n = unlinked.length;
  if (!n) return [];
  return [{ tab: 'review', key: 'suppliers:unlinked', sev: 'info', title: `${n} supplier name${n === 1 ? '' : 's'} not linked to Odoo`, advice: 'Most are other spellings of an Odoo supplier: link each once and its spending counts there.', actions: [{ label: 'Open suppliers', href: '#/suppliers', primary: true }] }];
}

/** Last week's management report, when nobody has sent it. */
async function readReport(env, account, now) {
  const mail = await mgmt.mailSettings(env);
  const today = new Date(now).toISOString().slice(0, 10);
  const { key, label } = mgmt.periodOf({ period: 'week', at: new Date(now - 7 * DAY).toISOString().slice(0, 10) }, today);
  if (mail.lastSent?.week && mail.lastSent.week >= key) return [];
  return [{ tab: 'review', key: `report:${key}`, sev: 'info', title: `The management report for ${label}`, advice: mail.auto ? 'It goes by itself on Monday morning; read it first if you like.' : 'Read it, then press Send: sending by itself is off.', actions: [{ label: 'Open it', href: '#/management', primary: true }] }];
}

/** What Insight did by itself in the last day. */
async function doneLately(env, now) {
  const since = new Date(now - DAY).toISOString().replace('T', ' ').slice(0, 19);
  const out = [];
  const runs = await first(env.DB, "SELECT COUNT(*) AS n, MAX(finished_at) AS at FROM etl_run WHERE status = 'ok' AND finished_at >= ?1", since).catch(() => null);
  if (Number(runs?.n)) out.push({ title: `Read the systems ${runs.n} time${Number(runs.n) === 1 ? '' : 's'}`, system: 'Insight', at: runs.at });
  const made = await first(env.DB, "SELECT COUNT(*) AS n FROM receipt WHERE po_name IS NOT NULL AND at >= ?1", since).catch(() => null);
  if (Number(made?.n)) out.push({ title: `Made ${made.n} draft PO${Number(made.n) === 1 ? '' : 's'} from receipts`, system: 'Receipts' });
  return out.map((x, i) => ({ tab: 'done', key: `done:${i}`, sev: 'good', source: x.system, ...x }));
}

// ------------------------------------------------------------ the writing --

/** The facts the AI is given: titles, amounts, ages and advice, nothing else. */
function factsOf(data) {
  return data.items.filter((x) => x.tab !== 'done').slice(0, 30).map((x) => ({
    kind: x.tab, urgency: x.sev, what: x.title, why: x.why || undefined, from: x.source,
    amount: x.amount ? cedi(x.amount) : undefined, waiting: x.age != null ? ageWords(x.age) : undefined, advice: x.advice || undefined,
  }));
}

/** Plain words from the counts, for when the AI cannot be asked. */
export function plainBrief(data) {
  const { tiles, counts } = data;
  if (!tiles.needYou) return 'Nothing needs you right now. Everything Insight reads agrees, or has an answer.';
  const parts = [];
  if (tiles.urgent) parts.push(`${tiles.urgent} urgent`);
  if (counts.decide) parts.push(`${counts.decide} to decide`);
  if (counts.fix) parts.push(`${counts.fix} going wrong`);
  if (counts.review) parts.push(`${counts.review} to look at`);
  const top = data.items.find((x) => x.tab !== 'done');
  return `${parts.join(', ')}. ${top ? `First: ${top.title}.` : ''}${tiles.atStake ? ` ${cedi(tiles.atStake)} is at stake in all.` : ''}`;
}

async function askModel(env, system, user, maxTokens) {
  if (!env.AI) return null;
  const out = await env.AI.run(MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.2 });
  const text = String(out?.response ?? out?.result?.response ?? '').trim();
  return text || null;
}

/** How the AI speaks, to an admin or to somebody whose list is only their own part. */
const voiceFor = (admin) => `You are Insight, the assistant of ${admin ? 'the admin' : 'a member of staff (a supervisor or a back-office helper)'} of a hotel group in Ghana (rooms, front desk, breakfast, restaurant, laundry, a public washroom). `
  + 'Write in plain, short British English sentences, as a calm personal assistant. Money is in Ghana cedis, written GH₵. '
  + 'Use only the facts given; never invent a figure, a name or a cause. If the facts do not answer, say so and say where to look.'
  + (admin ? '' : ' The facts are only what this person may see: never guess at anything beyond them, and never mention amounts that are not given.');

/** The morning summary: three short paragraphs from the items. */
export async function briefing(env, account, { now = Date.now(), once = false } = {}) {
  const data = once ? await gatherOnce(env, account) : await gather(env, account, { now });
  let text = null;
  let by = 'plain';
  try {
    text = await askModel(env, voiceFor(data.admin),
      `Write ${data.admin ? 'the admin' : 'this person'}'s morning summary in at most three short paragraphs: what is urgent (name each), what is waiting on them, and anything going well. No headings, no lists. Facts:\n${JSON.stringify(factsOf(data))}`, 350);
    if (text) by = 'ai';
  } catch { text = null; }
  return { text: text || plainBrief(data), by, data };
}

/** A question about any of it, answered from the items. */
export async function ask(env, body, account, { now = Date.now(), once = false } = {}) {
  const question = String(body?.question || '').trim().slice(0, 400);
  if (!question) throw badRequest('Ask a question.');
  // Read only: the Brief's figures would re-save Insight's checks, which a question must not do.
  const data = once ? await gatherOnce(env, account) : await gather(env, account, { now });
  if (!env.AI) return { answer: 'Questions need the reader (Workers AI), which is not available just now. Everything I know is in the list.', by: 'plain' };
  // Bills turned off are not flagged, but an admin's question about them is still answered.
  const bills = !data.admin || data.billsOn ? [] : await readBills(env, account, now).catch(() => []);
  const owed = bills.length ? `\n\nBills owed in Odoo (not flagged, for questions only): ${JSON.stringify(factsOf({ items: bills.map((x) => ({ ...x, source: 'Odoo bills' })) }))}` : '';
  const where = data.admin
    ? 'say which page of Insight would: Reports › Money for revenue and costs, Reports › Guests for occupancy, Reports › Staff costs for wages, Front desk › Shifts for drawers, Buying › Suppliers for what is owed.'
    : 'say so, and that an admin can answer it.';
  const answer = await askModel(env, voiceFor(data.admin),
    `Question: ${question}\n\nWhat needs ${data.admin ? 'the admin' : 'this person'} now: ${JSON.stringify(factsOf(data))}${owed}\n\nAnswer in at most four sentences. If these facts do not answer it, ${where}`, 300);
  return { answer: answer || 'I could not answer that just now. Try again in a moment.', by: answer ? 'ai' : 'plain' };
}
