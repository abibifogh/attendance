import { all, first } from '../lib/db.js';
import { badRequest } from '../lib/http.js';
import * as approvals from './approvals.js';
import * as panels from './panels.js';
import * as floats from './floats.js';
import * as receipts from './receipts.js';
import * as np from './niceplace.js';
import * as mgmt from './mgmt.js';
import { listTodos } from './todo.js';
import * as supplierbook from './supplierbook.js';
import { requireAdmin } from './till.js';

/**
 * The Assistant: everything that needs an admin, from every system Insight
 * reads, in one list, each with what Insight would do about it.
 *
 * Four kinds:
 * - **decide**: waiting on a yes or a no (approvals in every system, drafts
 *   from receipts, counters nobody could read, answers to look at);
 * - **fix**: something going wrong, with how to put it right (the findings,
 *   money held in floats too long, bills overdue in Odoo, to-dos nobody has);
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
const BILL_DAYS = 30;

const daysSince = (at, now) => (at ? Math.max(0, Math.floor((now - Date.parse(String(at).length <= 10 ? `${at}T12:00:00Z` : at)) / DAY)) : null);
const ageWords = (n) => (n == null ? '' : n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days`);
const cedi = (minor) => `GH₵ ${(Math.round(Number(minor) || 0) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;

/** Each source: its label, the kind of items it gives, and how they are read. */
const SOURCES = [
  { id: 'approvals', label: 'Approvals in every system', read: readApprovals },
  { id: 'findings', label: 'Insight’s checks', read: readFindings },
  { id: 'receipts', label: 'Receipts', read: readReceipts },
  { id: 'floats', label: 'Floats', read: readFloats },
  { id: 'bills', label: 'Odoo bills', read: readBills },
  { id: 'todos', label: 'The to-do list', read: readTodos },
  { id: 'niceplace', label: 'Nice Place counters', read: readNicePlace },
  { id: 'files', label: 'Shift files', read: readFiles },
  { id: 'suppliers', label: 'Suppliers', read: readSuppliers },
  { id: 'report', label: 'Management report', read: readReport },
];

/** Everything, for an admin. */
export async function gather(env, account, { now = Date.now(), sources = SOURCES } = {}) {
  await requireAdmin(account);
  const read = [];
  const items = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const got = await s.read(env, account, now);
      for (const item of got) items.push({ source: s.label, ...item });
      read.push({ id: s.id, label: s.label, ok: true, count: got.length });
    } catch (err) {
      read.push({ id: s.id, label: s.label, ok: false, error: err.message });
    }
  }));
  read.sort((a, b) => sources.findIndex((s) => s.id === a.id) - sources.findIndex((s) => s.id === b.id));
  const RANK = { crit: 0, warn: 1, info: 2, good: 3 };
  items.sort((a, b) => RANK[a.sev] - RANK[b.sev] || (b.amount || 0) - (a.amount || 0) || (b.age || 0) - (a.age || 0));
  const done = await doneLately(env, now).catch(() => []);
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
  if (answered.length) out.push({ tab: 'decide', key: 'todos:answered', sev: 'info', title: `${answered.length} answer${answered.length === 1 ? '' : 's'} on the to-do list to decide`, advice: 'A supervisor said what happened; accept it, or send it back.', actions: [{ label: 'Open To sort out', href: '#/inbox', primary: true }] });
  if (nobody.length) out.push({ tab: 'fix', key: 'todos:nobody', sev: 'warn', title: `${nobody.length} to-do${nobody.length === 1 ? '' : 's'} nobody has been given`, advice: 'Give each to a supervisor so somebody chases it.', actions: [{ label: 'Open To sort out', href: '#/inbox', primary: true }] });
  return out;
}

/** Counters a picture could not be read for. */
async function readNicePlace(env, account, now) {
  const { items } = await np.pendingReadings(env);
  if (!items.length) return [];
  return [{
    tab: 'decide', key: 'np:pending', sev: 'info', title: `${items.length} Nice Place reading${items.length === 1 ? '' : 's'} with a counter to read`,
    why: items.slice(0, 3).map((x) => `${x.day} ${x.shift}${x.problem ? `: ${x.problem}` : ''}`).join(' · '),
    age: daysSince(items[0].sentAt || items[0].day, now),
    advice: 'Read the number off the picture; the reading before is beside it, so a number far off stands out.',
    actions: [{ label: 'Open Nice Place', href: '#/niceplace', primary: true }],
  }];
}

/** The ASSD journal not loaded lately: every front desk check stops there. */
async function readFiles(env, account, now) {
  const row = await first(env.DB, "SELECT MAX(to_day) AS to_day FROM shift_upload WHERE kind = 'journal'");
  const last = row?.to_day || null;
  const age = daysSince(last, now);
  if (last && age <= 2) return [];
  return [{
    tab: 'fix', key: 'files:journal', sev: last ? 'warn' : 'info',
    title: last ? `The ASSD journal has not been loaded since ${last}` : 'No ASSD journal loaded yet',
    why: 'Shifts, drawers, card and MoMo checks and room revenue all stop at the last day loaded.', age,
    advice: 'Ask the night auditor to load it, or load it under Settings › Connections & files › Shift files.',
    actions: [{ label: 'Shift files', href: '#/files', primary: true }],
  }];
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

const VOICE = 'You are Insight, the assistant of the admin of a hotel group in Ghana (rooms, front desk, breakfast, restaurant, laundry, a public washroom). '
  + 'Write in plain, short British English sentences, as a calm personal assistant. Money is in Ghana cedis, written GH₵. '
  + 'Use only the facts given; never invent a figure, a name or a cause. If the facts do not answer, say so and say where to look.';

/** The morning summary: three short paragraphs from the items. */
export async function briefing(env, account, { now = Date.now() } = {}) {
  const data = await gather(env, account, { now });
  let text = null;
  let by = 'plain';
  try {
    text = await askModel(env, VOICE,
      `Write the admin's morning summary in at most three short paragraphs: what is urgent (name each), what is waiting on them, and anything going well. No headings, no lists. Facts:\n${JSON.stringify(factsOf(data))}`, 350);
    if (text) by = 'ai';
  } catch { text = null; }
  return { text: text || plainBrief(data), by, data };
}

/** A question about any of it, answered from the items. */
export async function ask(env, body, account, { now = Date.now() } = {}) {
  const question = String(body?.question || '').trim().slice(0, 400);
  if (!question) throw badRequest('Ask a question.');
  // Read only: the Brief's figures would re-save Insight's checks, which a question must not do.
  const data = await gather(env, account, { now });
  if (!env.AI) return { answer: 'Questions need the reader (Workers AI), which is not available just now. Everything I know is in the list.', by: 'plain' };
  const answer = await askModel(env, VOICE,
    `Question: ${question}\n\nWhat needs the admin now: ${JSON.stringify(factsOf(data))}\n\nAnswer in at most four sentences. If these facts do not answer it, say which page of Insight would: Reports › Money for revenue and costs, Reports › Guests for occupancy, Reports › Staff costs for wages, Front desk › Shifts for drawers, Buying › Suppliers for what is owed.`, 300);
  return { answer: answer || 'I could not answer that just now. Try again in a moment.', by: answer ? 'ai' : 'plain' };
}
