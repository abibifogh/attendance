import { all } from '../lib/db.js';
import { badRequest, HttpError } from '../lib/http.js';
import { callLink, signLink } from '../lib/link.js';
import { listSources } from '../connectors/index.js';
import * as till from './till.js';
import * as newpo from './newpo.js';

/**
 * Approvals: everything waiting for an admin's decision, in every system, in
 * one list.
 *
 * Each system is asked for what waits for this person there, as the same
 * shape: a title, a line under it, the facts, and the decisions it allows,
 * each with any fields it takes (days charged, an amount, which changes to
 * accept). The page draws that without knowing what any of it means, and a
 * decision goes back to the system it came from, which makes it with its own
 * rules, as this person: "Michael Test via Insight".
 *
 * A system that cannot be reached is said, and its items simply are not in
 * the list this time; nothing is decided by default.
 */

const SYSTEMS = [
  { id: 'insight', label: 'Insight', list: insightList, decide: insightDecide },
  { id: 'hive', label: 'HIVE', list: hiveList, decide: hiveDecide, system: 'attendance' },
  // The POS, once its address and the shared secret are set (Setup › sources, SSO_SECRET_POS).
  { id: 'pos', label: 'POS', list: posList, decide: posDecide, system: 'pos', linked: async (env) => Boolean(env.SSO_SECRET_POS && await posBase(env)) },
  // Maintenance and Team Tasks: one database, one call; each item says which of the two it is.
  { id: 'maintenance', label: 'Maintenance', list: mxList, decide: mxDecide, linked: async (env) => Boolean(env.SSO_SECRET_MAINTENANCE && env.MAINTENANCE_APPROVALS_URL), also: { tasks: 'Team Tasks' } },
];

// ----------------------------------------------------------------- Insight --

const SLOT_WORDS = { morning: 'morning', afternoon: 'afternoon', night: 'night', t: '', b: '' };
const KEY_WORDS = {
  drawer: 'The drawer count', handover: 'The hand-over count', laundry: 'The laundry', nopo: 'Expenses with no PO',
  pogap: 'A PO total and its expenses', receipts: 'Receipts in the drawer', 'receipts-read': 'Receipts in the drawer',
  'receipts-carried': 'Receipts still in the count', movement: 'A cash movement', 'movement-twice': 'A cash movement made twice',
  'movement-reversal': 'A cash movement put back', moved: 'A cash movement', unlabelled: 'Cash moved with no label',
  labelled: 'A cash movement labelled', matched: 'A cash movement', stay: 'An unpaid stay', t: 'A card or MoMo payment', b: 'A bank payment',
  'not-recorded': 'A payment not in ASSD', 'not-found': 'A card or MoMo payment that never arrived', failed: 'A declined card payment',
  'double-charge': 'A card charged twice', 'paid-more': 'A guest who paid more than ASSD shows', 'paid-less': 'A guest who paid less than ASSD shows',
  'laundry-card': 'A laundry card payment not in ASSD', 'never-settled': 'A payment that never reached the bank', reversal: 'A payment the bank took back', refund: 'A card refund keyed in ASSD', nocash: 'Cash keyed while the drawer did not move',
  duplicate: 'A payment keyed twice in ASSD', zero: 'A card payment of nothing',
};
const dayWords = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** An exception's key, in words: what, which day, which shift. */
export function keyWords(key) {
  const [what, day, slot] = String(key).split(':');
  if (what === 'stay') return `An unpaid stay, reservation ${String(key).slice(5)}`;
  const words = KEY_WORDS[what] || 'A difference';
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(day || '');
  return dated ? `${words}, ${dayWords(day)}${SLOT_WORDS[slot] ? ` ${SLOT_WORDS[slot]}` : ''}` : words;
}

const MOVED = { duplicate: 'is keyed twice', reverses: 'puts back another movement' };

async function insightList(env) {
  const [answers, moves, drawer] = await Promise.all([
    till.pendingAnswers(env), till.pendingMovements(env), newpo.drawerAsks(env),
  ]);
  const items = [];
  for (const a of answers) {
    items.push({
      kind: a.type, id: String(a.id), kindLabel: a.type === 'link' ? 'Reconciled together' : 'Answer',
      title: a.type === 'link' ? `Reconciled ${a.keys.length} together` : `Answered “${a.answer}”`,
      sub: `${keyWords(a.keys[0])}${a.keys.length > 1 ? ` and ${a.keys.length - 1} more` : ''} · by ${a.by}`,
      who: a.by, askedAt: a.at, amount: null,
      details: [
        ['About', a.keys.map(keyWords).join('; ')],
        ['Answer', a.answer], ['Note', a.note], ['By', a.by],
      ],
      decisions: [
        { key: 'approve', label: 'Approve', primary: true, note: 'none' },
        { key: 'refuse', label: 'Send back', note: 'none', hint: 'It goes back on the list, as if never answered.' },
      ],
      open: '#/shifts?tab=inbox',
    });
  }
  for (const m of moves) {
    items.push({
      kind: 'correction', id: String(m.seq), kindLabel: 'Correction',
      title: `Correction · ASSD ${m.seq}`,
      sub: `${m.by} says it ${MOVED[m.kind] || `was ${m.kind}`}${m.day ? ` · ${dayWords(m.day)}` : ''}`,
      who: m.by, askedAt: m.at, amount: Math.abs(Number(m.amount) || 0) || null,
      details: [
        ['Movement', `ASSD ${m.seq}${m.user ? `, keyed by ${m.user}` : ''}${m.day ? `, ${dayWords(m.day)}` : ''}`],
        ['Says', `It ${MOVED[m.kind] || `was ${m.kind}`}${m.pair ? ` (ASSD ${m.pair})` : ''}${m.expenses ? `, POs ${m.expenses}` : ''}`],
        ['Note', m.note], ['By', m.by],
      ],
      decisions: [
        { key: 'approve', label: 'Approve', primary: true, note: 'none' },
        { key: 'refuse', label: 'Refuse', note: 'none' },
      ],
      open: '#/shifts?tab=inbox',
    });
  }
  for (const p of drawer.items) {
    items.push({
      kind: 'drawer-po', id: p.name, kindLabel: 'PO from a drawer',
      title: `${p.askedBy || 'Somebody'} wants to pay ${p.name} from a drawer`,
      sub: `${p.vendor || 'A vendor'} · made in Insight by ${p.madeBy || 'an admin'}`,
      who: p.askedBy, askedAt: p.askedAt, amount: Number(p.total ?? p.amount) || null,
      details: [
        ['PO', `${p.name}${p.vendor ? `, ${p.vendor}` : ''}`], ['What', p.description],
        ['Made', `${p.madeBy || 'An admin'}, in Insight${p.day ? `, dated ${dayWords(p.day)}` : ''}`],
        ['Asked by', p.askedBy],
      ],
      decisions: [
        { key: 'approve', label: 'Allow on a shift', primary: true, note: 'none' },
        { key: 'refuse', label: 'Refuse', note: 'required' },
      ],
      open: '#/shifts?tab=inbox',
    });
  }
  return { items };
}

async function insightDecide(env, { kind, id, decision, note }, account) {
  const ok = decision === 'approve';
  if (kind === 'answer') await till.approve(env, { answer: id, ok }, account);
  else if (kind === 'link') await till.approve(env, { link: Number(id), ok }, account);
  else if (kind === 'correction') await till.approve(env, { seq: Number(id), ok }, account);
  else if (kind === 'drawer-po') await newpo.decideDrawer(env, { name: id, allow: ok, note }, account);
  else throw badRequest('Insight does not know that kind of approval.');
  return { said: ok ? 'Approved' : 'Refused' };
}

// -------------------------------------------------------------------- HIVE --

const hive = (env, path, body) => callLink({ binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, path, body });

async function hiveList(env, account) {
  const out = await hive(env, '/api/link/approvals/list', { email: account.email });
  // HIVE counts in cedis; the page, like the rest of Insight, in pesewas.
  const items = (out.items || []).map((i) => ({ ...i, amount: i.amount == null ? null : Math.round(Number(i.amount) * 100) }));
  return { items, failed: out.failed || [] };
}

async function hiveDecide(env, body, account) {
  const out = await hive(env, '/api/link/approvals/decide', { email: account.email, ...body });
  return { said: out.said, as: out.as };
}

// --------------------------------------------------------------------- POS --

/** Where the POS's notify function answers: the address its reports are read from. */
async function posBase(env) {
  const source = (await listSources(env.DB).catch(() => [])).find((x) => x.kind === 'snpos_http' && x.config?.base);
  return source ? String(source.config.base).trim().replace(/\/+$/, '') : null;
}

/**
 * One signed call to the POS, the same signature HIVE's link uses, with the
 * POS's own shared secret: the POS checks it before reading anything.
 */
async function pos(env, path, body, { fetchImpl = fetch } = {}) {
  const base = await posBase(env);
  if (!base || !env.SSO_SECRET_POS) throw new Error('The POS is not linked: it needs its reports address in Setup and SSO_SECRET_POS.');
  const text = JSON.stringify(body ?? {});
  const headers = { 'Content-Type': 'application/json', ...(await signLink(env.SSO_SECRET_POS, path, text)) };
  let response;
  try { response = await fetchImpl(`${base}${path}`, { method: 'POST', headers, body: text }); } catch (err) { throw new Error(`The POS could not be reached: ${err.message}`); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 && !data?.error) throw new Error('The POS does not take approvals from Insight yet: its notify function needs updating.');
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || `The POS answered ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function posList(env, account) {
  const out = await pos(env, '/approvals/list', { email: account.email });
  return { items: out.items || [], failed: out.failed || [] };
}

async function posDecide(env, body, account) {
  const out = await pos(env, '/approvals/decide', { email: account.email, ...body });
  return { said: out.said, as: out.as };
}

// ------------------------------------------------- Maintenance, Team Tasks --

/**
 * The Maintenance database's `approvals` function, which answers for Team
 * Tasks too (it lives in the same database). Signed like the others, with
 * its own secret; the action rides in the body, so the signature does not
 * depend on how the function's address is spelled.
 */
async function mx(env, body, { fetchImpl = fetch } = {}) {
  const url = env.MAINTENANCE_APPROVALS_URL;
  if (!url || !env.SSO_SECRET_MAINTENANCE) throw new Error('Maintenance is not linked: it needs MAINTENANCE_APPROVALS_URL and SSO_SECRET_MAINTENANCE.');
  const text = JSON.stringify(body ?? {});
  const headers = { 'Content-Type': 'application/json', ...(await signLink(env.SSO_SECRET_MAINTENANCE, '/approvals', text)) };
  let response;
  try { response = await fetchImpl(url, { method: 'POST', headers, body: text }); } catch (err) { throw new Error(`Maintenance could not be reached: ${err.message}`); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 && !data?.error) throw new Error('Maintenance does not take approvals from Insight yet: its approvals function is not deployed.');
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || `Maintenance answered ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function mxList(env, account) {
  const out = await mx(env, { action: 'list', email: account.email });
  return { items: out.items || [], failed: out.failed || [] };
}

async function mxDecide(env, body, account) {
  const out = await mx(env, { action: 'decide', email: account.email, ...body });
  return { said: out.said, as: out.as };
}

// ----------------------------------------------------------------- the page --

/** Where each system's own screens are, from Setup › Systems. */
async function homes(env) {
  const rows = await all(env.DB, 'SELECT id, home_url FROM systems').catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.id, r.home_url || null]));
}

/** Everything waiting, from every system, oldest first. Admins only. */
export async function list(env, account) {
  await till.requireAdmin(account);
  const home = await homes(env);
  const systems = [];
  const items = [];
  const linked = await Promise.all(SYSTEMS.map((s) => (s.linked ? s.linked(env).catch(() => false) : true)));
  await Promise.all(SYSTEMS.filter((_, i) => linked[i]).map(async (s) => {
    try {
      if (s.id !== 'insight' && !account.email) throw new Error('Your Insight account has no email, so the other systems cannot tell who you are.');
      const got = await s.list(env, account);
      // One call can answer for two systems (Maintenance and Team Tasks): each item says which.
      const ids = [s.id, ...Object.keys(s.also || {})];
      const labelOf = (id) => (id === s.id ? s.label : s.also[id]);
      for (const item of got.items) {
        const id = ids.includes(item.system) ? item.system : s.id;
        items.push({ ...item, system: id, via: s.id, systemLabel: labelOf(id) });
      }
      for (const id of ids) {
        const count = got.items.filter((i) => (ids.includes(i.system) ? i.system : s.id) === id).length;
        if (id === s.id || count) systems.push({ id, label: labelOf(id), ok: true, count, home: s.system ? home[s.system] : null, partly: id === s.id ? got.failed || [] : [] });
      }
    } catch (err) {
      systems.push({ id: s.id, label: s.label, ok: false, count: 0, error: err.message });
    }
  }));
  const order = SYSTEMS.flatMap((s) => [s.id, ...Object.keys(s.also || {})]);
  systems.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  items.sort((a, b) => String(a.askedAt || '').localeCompare(String(b.askedAt || '')));
  return { systems, items, count: items.length };
}

/** One decision, sent to the system the item came from. */
export async function decide(env, body, account) {
  await till.requireAdmin(account);
  const system = SYSTEMS.find((s) => s.id === body?.system || Object.keys(s.also || {}).includes(body?.system));
  if (!system) throw badRequest('Which system?');
  const kind = String(body?.kind || '');
  const id = String(body?.id ?? '');
  const decision = String(body?.decision || '');
  if (!kind || !id || !decision) throw badRequest('Which one, and what is decided?');
  const note = body?.note == null ? '' : String(body.note).trim().slice(0, 500);
  const fields = body?.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : {};
  try {
    const out = await system.decide(env, { kind, id, decision, note: note || undefined, fields }, account);
    return { ok: true, system: system.id, said: out.said, as: out.as || null };
  } catch (err) {
    // The other system's own words, with its own status: a refusal there is a refusal here.
    if (err instanceof HttpError) throw err;
    throw new HttpError(err.status && err.status < 500 ? err.status : 502, `${system.label}: ${err.message}`);
  }
}
