import { all, first, run } from '../lib/db.js';
import { badRequest, forbidden, HttpError, str } from '../lib/http.js';
import { addDays } from '../lib/dates.js';
import { callLink } from '../lib/link.js';
import { listSources, secretNameFor } from '../connectors/index.js';
import { purchaseOrders } from '../connectors/odoo.js';
import { poName } from './cashpo.js';
import { linkRecipients, requireArea, roleOf } from './till.js';
import { shifts as shiftsFor } from './shifts.js';

/**
 * Advances: cash given out of a drawer before a purchase, and what happens to
 * a PO's money after its shift.
 *
 * A receptionist closing a shift adds a requisition (a PO in Odoo still a
 * draft or waiting for approval) as an ADVANCE. It is settled once its PO is
 * approved in Odoo and on the expense form (the Google Form, sent here by a
 * script on the form). Until then the next shift cannot close; an admin can
 * give it more time or close it.
 *
 * Once approved, the PO's total may not be what left the drawer: a REFUND
 * (bought for less) comes back into a drawer and shows in ASSD as a surplus; a
 * DEFICIT (bought for more) shows as a shortage. Within five days of the shift
 * that paid it, HIVE asks the next shift to record it, and a refund is told to
 * whoever is on the rota for the next reception shift. Older than that, only
 * the admins are told.
 *
 * Only POs paid on a HIVE shift are followed. One on the expense form that no
 * shift paid was paid some other way and is never chased.
 */

const CONFIRMED = new Set(['purchase', 'done']);
/** How long after its shift a difference is still the desk's to record. */
export const STAFF_DAYS = 5;
/** How far back advances and differences are followed. */
const LOOKBACK_DAYS = 60;
const today = () => new Date().toISOString().slice(0, 10);
const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const SLOT_ORDER = ['morning', 'afternoon', 'night'];

// ------------------------------------------------------- the expense form --

/** Whether the expense form is connected. Until it is, nothing waits for it. */
export const formLive = (env) => Boolean(env?.EXPENSE_FORM_SECRET);

/** GH₵ 1,200.50, "1200.5", 1200.5 → 120050 pesewas; anything else (words, nothing) → null. */
export function toMinor(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  const text = String(value).replace(/GH[S₵C]?|₵|cedis?|,|\s/gi, '');
  return /^-?\d+(\.\d+)?$/.test(text) ? Math.round(Number(text) * 100) : null;
}

/**
 * The POs a response names, as Odoo names them. Typed every which way on the
 * form: 4123, 4123.0, P04123, p04123, PO4123, POO123 (a letter O for a nought),
 * P004123, two at once ("4123 & 4124"). Anything that is not a number (N/A,
 * a name, "Bolt") names no PO.
 */
export function formPos(typed) {
  const out = [];
  for (const raw of String(typed ?? '').toUpperCase().split(/[,&/;+]|\bAND\b|\s+/)) {
    let t = raw.replace(/[^A-Z0-9.]/g, '').replace(/\.0+$/, '');
    if (!/^P?O*\d/.test(t) && !/^PO/.test(t)) continue;
    t = t.replace(/^P/, '').replace(/O/g, '0');
    if (!/^\d+$/.test(t)) continue;
    const digits = t.replace(/^0+(?=\d)/, '');
    // Nought, or a phone number: not a PO.
    if (digits === '0' || digits.length > 6) continue;
    const name = `P${digits.padStart(5, '0')}`;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The form's date of the expense, as yyyy-mm-dd, whatever way it came. */
function formDay(value) {
  const s = String(value ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return dmy ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}` : null;
}

/** "Cash Register" or "Big Safe", as the form's answer has it. */
function paidFrom(value) {
  const s = String(value ?? '');
  if (/safe/i.test(s)) return 'safe';
  if (/register|till|drawer/i.test(s)) return 'register';
  return null;
}

/**
 * Responses from the form. Each is { responseId, po, amount, tnt, tntIncluded,
 * by, submittedAt, expenseDate, paidFrom }; sending one twice keeps one copy. Up to 500 at once, for
 * the script's "send past responses".
 *
 * TnT counts on top of the amount, unless the form says the transport was
 * included in the invoice: then the amount has it already. A response naming
 * two POs marks both reported, with no amount, since it cannot be split.
 */
export async function ingestForm(env, body) {
  const list = Array.isArray(body?.responses) ? body.responses : [body];
  if (!list.length || list.length > 500) throw badRequest('Send between 1 and 500 responses.');
  const ids = [];
  const rows = [];
  for (const r of list) {
    const id = String(r?.responseId ?? '').trim().slice(0, 120);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    const typed = String(r?.po ?? '').trim().slice(0, 60);
    const pos = formPos(typed);
    const one = pos.length <= 1;
    const tnt = r?.tntIncluded ? 0 : toMinor(r?.tnt) ?? 0;
    const rest = [typed || null, one ? toMinor(r?.amount) : null, one ? tnt : null,
      String(r?.by ?? '').slice(0, 120) || null, String(r?.submittedAt ?? '').slice(0, 30) || null,
      formDay(r?.expenseDate), paidFrom(r?.paidFrom)];
    for (const [i, po] of (pos.length ? pos : [null]).entries()) rows.push([i ? `${id}#${i + 1}` : id, po, ...rest]);
  }
  if (!ids.length) return { ok: true, saved: 0 };

  // A few statements in one batch, not two per response: a Worker may only
  // make so many database calls in one request, and D1 takes at most a
  // hundred values in one statement.
  const statements = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(', ');
    statements.push(env.DB.prepare(`DELETE FROM expense_report WHERE response_id IN (${marks})
        OR (instr(response_id, '#') > 0 AND substr(response_id, 1, instr(response_id, '#') - 1) IN (${marks}))`).bind(...chunk));
  }
  for (let i = 0; i < rows.length; i += 11) {
    const chunk = rows.slice(i, i + 11);
    const values = chunk.map((_, j) => `(${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `?${j * 9 + k}`).join(', ')})`).join(', ');
    statements.push(env.DB.prepare(`INSERT INTO expense_report (response_id, po, po_typed, amount, tnt, by_name, submitted_at, expense_day, paid_from)
        VALUES ${values}`).bind(...chunk.flat()));
  }
  await env.DB.batch(statements);
  return { ok: true, saved: ids.length };
}

/** What the form says about each PO: amount and TnT added up over its responses. */
export async function reportedFor(env, names) {
  const wanted = [...new Set(names.filter(Boolean).map((n) => poName(n)))];
  const out = new Map();
  if (!wanted.length) return out;
  const rows = await all(env.DB, `SELECT po, SUM(COALESCE(amount, 0)) AS amount, SUM(COALESCE(tnt, 0)) AS tnt, COUNT(*) AS n,
        SUM(amount IS NULL) AS together
      FROM expense_report WHERE po IN (${wanted.map((_, i) => `?${i + 1}`).join(', ')}) GROUP BY po`, ...wanted).catch(() => []);
  for (const r of rows) {
    out.set(r.po, {
      amount: Number(r.amount) || 0, tnt: Number(r.tnt) || 0, total: (Number(r.amount) || 0) + (Number(r.tnt) || 0), count: Number(r.n) || 0,
      // Reported on one response with other POs: reported, the amount not its own.
      ...(Number(r.together) ? { together: true } : {}),
    });
  }
  return out;
}

/** An admin's more time or close, by PO. */
export async function decisionsFor(env, names) {
  const wanted = [...new Set(names.filter(Boolean).map((n) => poName(n)))];
  if (!wanted.length) return new Map();
  const rows = await all(env.DB, `SELECT * FROM advance_decision WHERE po IN (${wanted.map((_, i) => `?${i + 1}`).join(', ')})`, ...wanted).catch(() => []);
  return new Map(rows.map((r) => [r.po, { until: r.until_day || null, closed: Boolean(r.closed_at), reason: r.reason || null, by: r.by_name || null }]));
}

/** What HIVE needs to know about a PO besides Odoo: reported, and any decision. */
export async function poExtras(env, names) {
  const [reported, decisions] = await Promise.all([reportedFor(env, names), decisionsFor(env, names)]);
  return (name) => ({
    reported: reported.get(poName(name)) || null,
    decision: decisions.get(poName(name)) || null,
  });
}

// ------------------------------------------------------ the advances list --

async function odooOrders(env, names, fetchImpl) {
  if (!names.length) return new Map();
  const sources = (await listSources(env.DB)).filter((s) => s.kind === 'odoo_json2' && s.config?.base);
  const source = sources.find((s) => s.enabled) || sources[0];
  if (!source) return null;
  const secret = secretNameFor(source);
  const out = new Map();
  for (let i = 0; i < names.length; i += 80) {
    // eslint-disable-next-line no-await-in-loop
    const result = await purchaseOrders({ config: source.config, token: secret ? env[secret] : null, names: names.slice(i, i + 80), ...(fetchImpl ? { fetchImpl } : {}) });
    for (const o of result.orders || []) out.set(String(o.name).toUpperCase(), o);
  }
  return out;
}

/** The end of the shift after this one, as the day and slot it is. */
export function nextShift(day, slot) {
  const i = SLOT_ORDER.indexOf(slot);
  return i < 2 ? { day, slot: SLOT_ORDER[i + 1] } : { day: addDays(day, 1), slot: 'morning' };
}

/**
 * Every PO paid from a HIVE drawer in the last two months that is an
 * advance, or whose payments do not add up to its total in Odoo now: with what
 * Odoo, the form and any admin decision say, and one status.
 */
export async function gatherAdvances(env, { fetchImpl, on = today() } = {}) {
  if (!env.ATT_DB) return { items: [], formLive: formLive(env) };
  const since = addDays(on, -LOOKBACK_DAYS);
  const rows = await all(env.ATT_DB, `SELECT t.*, u.name AS who FROM till_po t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.po IN (SELECT DISTINCT po FROM till_po WHERE day >= ?1) ORDER BY t.id`, since).catch(() => []);
  const byPo = new Map();
  for (const r of rows) {
    const po = String(r.po).toUpperCase();
    if (!byPo.has(po)) byPo.set(po, []);
    byPo.get(po).push(r);
  }
  const names = [...byPo.keys()];
  const orders = await odooOrders(env, names, fetchImpl).catch(() => null);
  const extras = await poExtras(env, names);
  const live = formLive(env);
  const items = [];
  for (const [po, list] of byPo) {
    const claim = list.find((r) => (r.kind || 'claim') === 'claim') || list[0];
    const advance = list.some((r) => Number(r.advance) === 1);
    const paid = list.reduce((t, r) => t + (Number(r.paid) || 0), 0);
    const order = orders?.get(po) || null;
    const confirmed = order ? CONFIRMED.has(order.state) : null;
    const total = order ? Number(order.total) || 0 : null;
    const { reported, decision } = extras(po);
    const isReported = !live || Boolean(reported);
    const diff = confirmed && isReported && total != null ? total - paid : 0;
    const moves = list.filter((r) => (r.kind || 'claim') !== 'claim').map((r) => ({ kind: r.kind, day: r.day, slot: r.slot, paid: Number(r.paid) || 0, who: r.who || null }));
    if (!advance && !diff && !moves.length) continue;
    const settled = Boolean(confirmed && isReported);
    const due = nextShift(claim.day, claim.slot);
    const old = claim.day < addDays(on, -STAFF_DAYS);
    let status;
    if (decision?.closed) status = 'closed';
    else if (advance && confirmed === false && order && order.state === 'cancel') status = 'cancelled';
    else if (advance && confirmed === false) status = 'approve';
    else if (confirmed && !isReported) status = 'report';
    else if (diff < 0) status = 'refund';
    else if (diff > 0) status = 'deficit';
    else status = 'settled';
    items.push({
      po, vendor: order?.vendor ?? claim.vendor ?? null, advance, advanced: Number(claim.paid) || 0, paid, total, confirmed, state: order?.state ?? null,
      reported, amountDiffers: Boolean(reported && !reported.together && total != null && reported.total !== total),
      by: claim.who || null, userId: claim.user_id, day: claim.day, slot: claim.slot, due, old,
      diff, moves, decision, status, settled,
      // Past the day of the shift it was due by, with no more time given.
      overdue: advance && !settled && !decision?.closed && (decision?.until ? decision.until < on : due.day < on),
    });
  }
  return { items, formLive: live, odoo: Boolean(orders) };
}

/**
 * Whether each refund or deficit a shift recorded reached ASSD: a refund as a
 * surplus of that amount when the shift closed, a deficit as a shortage.
 */
async function withAssd(env, items) {
  const moves = items.flatMap((x) => x.moves.map((m) => ({ item: x, m })));
  if (!moves.length) return items;
  const days = moves.map(({ m }) => m.day).sort();
  let payload = null;
  try { payload = await shiftsFor(env, { from: days[0], to: days[days.length - 1] }, null); } catch { payload = null; }
  const variance = new Map();
  for (const d of payload?.days || []) for (const s of d.shifts || []) variance.set(`${s.day}|${s.slot}`, s.register?.variance ?? null);
  for (const { m } of moves) {
    const v = variance.get(`${m.day}|${m.slot}`);
    // Money back in (a change row is negative) is a surplus; more paid out a
    // shortage. The shift's variance holds everything else on it too, so one
    // the other way, or none, is what says it is missing.
    const want = -m.paid;
    m.assd = v == null ? 'unread' : v === want ? 'matched' : Math.sign(v) === Math.sign(want) ? 'differs' : 'missing';
    m.variance = v ?? null;
  }
  for (const x of items) {
    if (x.status !== 'settled' && x.status !== 'refund' && x.status !== 'deficit') continue;
    if (x.moves.some((m) => m.kind === 'change' && m.assd === 'missing')) x.status = 'refund_not_in_assd';
  }
  return items;
}

/** Shifts → Inbox → Advances. Admin, or whoever an admin gave "Advances". */
export async function advancesView(env, account, { fetchImpl } = {}) {
  const access = await requireArea(env, account, 'advances', 1);
  const { items, formLive: live, odoo } = await gatherAdvances(env, { fetchImpl });
  await withAssd(env, items);
  // A shift's variance is the drawer's money: only for whoever sees amounts.
  if (!access.money) for (const x of items) for (const m of x.moves) m.variance = null;
  const open = items.filter((x) => !['settled', 'closed'].includes(x.status));
  return {
    canAct: (access.advances || 0) >= 2,
    canClear: roleOf(account) === 'admin',
    formLive: live,
    odoo,
    items: items.sort((a, b) => Number(['settled', 'closed'].includes(a.status)) - Number(['settled', 'closed'].includes(b.status)) || (a.day < b.day ? 1 : -1)),
    outstanding: open.filter((x) => x.advance && !x.settled).reduce((t, x) => t + x.advanced, 0),
    needsYou: items.filter((x) => x.status === 'refund_not_in_assd' || x.overdue || (x.old && (x.status === 'refund' || x.status === 'deficit'))).length,
    elsewhere: await reportedElsewhere(env),
  };
}

/**
 * Responses on the form for a PO no HIVE shift paid: paid some other way,
 * listed, never chased. An admin clears each once looked at.
 */
async function reportedElsewhere(env) {
  const rows = await all(env.DB, `SELECT e.po, SUM(COALESCE(e.amount, 0) + COALESCE(e.tnt, 0)) AS total, MAX(e.submitted_at) AS at
      FROM expense_report e
     WHERE e.po IS NOT NULL AND e.received_at >= datetime('now', '-60 days')
       AND e.po NOT IN (SELECT po FROM expense_cleared)
     GROUP BY e.po ORDER BY at DESC LIMIT 500`).catch(() => []);
  if (!rows.length || !env.ATT_DB) return { list: [], count: 0 };
  const paid = new Set((await all(env.ATT_DB, 'SELECT DISTINCT po FROM till_po').catch(() => [])).map((r) => String(r.po).toUpperCase()));
  const left = rows.filter((r) => !paid.has(r.po));
  return { list: left.slice(0, 100).map((r) => ({ po: r.po, total: Number(r.total) || 0, at: r.at })), count: left.length };
}

/** An admin clears form entries no drawer paid, once looked at; or puts them back. */
export async function clearElsewhere(env, body, account) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can clear these.');
  const pos = [...new Set((Array.isArray(body?.pos) ? body.pos : []).map((p) => poName(String(p ?? '').trim())).filter(Boolean))];
  if (!pos.length) throw badRequest('Choose at least one.');
  if (pos.length > 500) throw badRequest('500 at most at once.');
  const statements = [];
  for (let i = 0; i < pos.length; i += 90) {
    const chunk = pos.slice(i, i + 90);
    if (body?.restore) {
      statements.push(env.DB.prepare(`DELETE FROM expense_cleared WHERE po IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`).bind(...chunk));
    } else {
      const rows = chunk.map((_, j) => `(?${j + 2}, ?1)`).join(', ');
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO expense_cleared (po, by_name) VALUES ${rows}`).bind(who(account), ...chunk));
    }
  }
  await env.DB.batch(statements);
  return { ok: true, pos, restored: Boolean(body?.restore) };
}

/** More time until a day, or close with a reason. */
export async function decide(env, body, account) {
  await requireArea(env, account, 'advances', 2);
  const po = poName(str(body?.po, 'PO', { required: true, max: 30 }));
  if (body?.action === 'more') {
    const until = str(body?.until, 'Until', { required: true, max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < today()) throw badRequest('Choose a day from today on.');
    const reason = str(body?.reason, 'Reason', { max: 300 });
    await run(env.DB, `INSERT INTO advance_decision (po, until_day, closed_at, reason, by_name, at) VALUES (?1, ?2, NULL, ?3, ?4, ?5)
        ON CONFLICT (po) DO UPDATE SET until_day = ?2, closed_at = NULL, reason = ?3, by_name = ?4, at = ?5`, po, until, reason || null, who(account), nowText());
    return { ok: true };
  }
  if (body?.action === 'close') {
    const reason = str(body?.reason, 'Reason', { required: true, max: 300 });
    await run(env.DB, `INSERT INTO advance_decision (po, until_day, closed_at, reason, by_name, at) VALUES (?1, NULL, ?2, ?3, ?4, ?2)
        ON CONFLICT (po) DO UPDATE SET until_day = NULL, closed_at = ?2, reason = ?3, by_name = ?4, at = ?2`, po, nowText(), reason, who(account));
    return { ok: true };
  }
  if (body?.action === 'reopen') {
    await run(env.DB, 'DELETE FROM advance_decision WHERE po = ?1', po);
    return { ok: true };
  }
  throw badRequest('More time, close, or reopen.');
}

// ------------------------------------------------------------- telling --

/**
 * Say each new difference once. A refund within five days of its shift goes
 * to whoever is on the rota for the next reception shift (HIVE works out who);
 * anything older goes to the admins. Deficits are only said when old.
 * Never throws: nothing here may stop the form or the nightly run.
 */
export async function tellDifferences(env, { fetchImpl, on = today() } = {}) {
  let told = 0;
  try {
    const { items } = await gatherAdvances(env, { fetchImpl, on });
    for (const x of items) {
      if (!x.diff || x.decision?.closed) continue;
      // eslint-disable-next-line no-await-in-loop
      const said = await first(env.DB, 'SELECT 1 FROM advance_notice WHERE po = ?1 AND total = ?2', x.po, x.total).catch(() => null);
      if (said) continue;
      const amount = Math.abs(x.diff);
      const cedis = (m) => `GH₵ ${(Math.abs(m) / 100).toFixed(2)}`;
      let sentTo = 'nobody';
      if (!x.old && x.diff < 0) {
        // eslint-disable-next-line no-await-in-loop
        const out = await callLink({
          binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/expect', what: 'HIVE',
          body: {
            po: x.po, vendor: x.vendor, amount, paid: x.paid, total: x.total,
            reported: x.reported ? { amount: x.reported.amount, tnt: x.reported.tnt } : null,
            by: x.by, day: x.day, slot: x.slot,
          },
        }).catch(() => null);
        sentTo = out?.sentTo || 'not sent';
      } else if (x.old) {
        // eslint-disable-next-line no-await-in-loop
        const { to } = await linkRecipients(env, { event: 'approval' }).catch(() => ({ to: [] }));
        if (to.length) {
          // eslint-disable-next-line no-await-in-loop
          await callLink({
            binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/till/tell', what: 'HIVE',
            body: {
              recipients: to, kind: 'till.approval',
              title: `${x.po}: ${x.diff < 0 ? `refund of ${cedis(amount)}` : `deficit of ${cedis(amount)}`}`,
              body: `Final price ${cedis(x.total)}; ${cedis(x.paid)} was paid from the drawer on ${x.day} ${x.slot}${x.by ? ` (${x.by})` : ''}. `
                + 'More than five days ago, so only admins are told. See Insight → Shifts → Inbox → Advances.',
            },
          }).catch(() => null);
          sentTo = 'admins';
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'INSERT OR IGNORE INTO advance_notice (po, total, sent_to) VALUES (?1, ?2, ?3)', x.po, x.total, sentTo).catch(() => {});
      if (sentTo !== 'nobody' && sentTo !== 'not sent') told += 1;
    }
  } catch (err) {
    if (err instanceof HttpError) return { told, error: err.message };
    return { told, error: String(err?.message || err) };
  }
  return { told };
}

