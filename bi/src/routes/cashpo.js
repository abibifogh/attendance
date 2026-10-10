import { all, first, getSettings, run, writeAll } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { addDays, dow, dowLabel, isoWeek, month } from '../lib/dates.js';
import { cashPoDetails, confirmedPoBills } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { requireAdmin, roleOf } from './till.js';
import { syncTodos, todoCounts, lookbackDays } from './todo.js';

/**
 * Spending paid in cash, against a PO.
 *
 * Insight already knows every PO paid in cash: a closing report's expenses
 * (HIVE), the drawer expenses typed against a shift, and the safe book. Odoo
 * knows whether each has been billed. Together they answer three things the
 * Money page could not:
 *
 * - what was spent in cash and has no bill yet, so is in no cost figure at
 *   all. Until the bill arrives it is counted here, on the day the cash left,
 *   under the source `odoo-cash`; once Odoo has the bill, the bill counts and
 *   this stops, so nothing is counted twice;
 * - how each cost was paid: from the drawer, from the safe, or anything else
 *   (by bank, or on credit);
 * - what to chase: see todo.js.
 */

export const CASH_SOURCE = 'odoo-cash';

/** A PO number as Odoo names it: `2433` and `p2433` are `P02433`. */
export function poName(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (/^\d+$/.test(text)) return `P${text.padStart(5, '0')}`;
  if (/^P\d+$/.test(text)) return `P${text.slice(1).padStart(5, '0')}`;
  return text;
}
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const SLOT = { morning: 'morning', afternoon: 'afternoon', night: 'night' };

/** Every PO paid in cash, by name. A closing report's own figure wins, then the safe, then a shift's expenses. */
export async function gatherCashPos(env) {
  const out = new Map();
  const up = (n) => poName(n);
  const put = (po, row) => { if (po && !out.has(up(po))) out.set(up(po), { po: up(po), ...row }); };
  if (env.ATT_DB) {
    try {
      for (const r of await all(env.ATT_DB, 'SELECT po, day, slot, paid, total, vendor FROM till_po ORDER BY day, slot')) {
        put(r.po, { paidFrom: 'drawer', paidDay: r.day, paid: Number(r.paid) || 0, vendor: r.vendor || null, source: `closing report, ${r.day} ${SLOT[r.slot] || r.slot}` });
      }
    } catch { /* HIVE not upgraded */ }
  }
  try {
    for (const r of await all(env.DB, "SELECT po, day, amount, vendor FROM safe_entry WHERE kind = 'po' AND po IS NOT NULL ORDER BY day")) {
      put(r.po, { paidFrom: 'safe', paidDay: r.day, paid: Number(r.amount) || 0, vendor: r.vendor || null, source: `the safe, ${r.day}` });
    }
  } catch { /* no safe book yet */ }
  // The drawer's expenses on a shift: every PO number typed, whether or not
  // anybody has pressed the button that looks them up in Odoo. What left the
  // drawer is the PO's total, which Odoo is asked for when it is not known yet.
  for (const r of await all(env.DB, `SELECT day, slot, po_numbers, odoo FROM shift_expense
      WHERE po_numbers IS NOT NULL OR odoo IS NOT NULL ORDER BY day, slot`)) {
    let orders = [];
    try { orders = JSON.parse(r.odoo || '{}').orders || []; } catch { orders = []; }
    const found = new Map(orders.map((o) => [up(o.name), o]));
    const names = new Set([...String(r.po_numbers || '').split(/[\s,;]+/).filter(Boolean).map(up), ...found.keys()]);
    for (const name of names) {
      const o = found.get(name);
      put(name, {
        paidFrom: 'drawer', paidDay: r.day, paid: o ? Number(o.total) || 0 : null, vendor: o?.vendor || null,
        source: `drawer expenses, ${r.day} ${SLOT[r.slot] || r.slot}`,
      });
    }
  }
  return out;
}

/**
 * Ask Odoo about every cash PO, keep what it says, and put the cost of those
 * not billed yet where the Money page reads cost. Then bring the to-do list up
 * to date.
 */
export async function refreshCashPos(env, { fetchImpl, today } = {}) {
  const paid = await gatherCashPos(env);
  const source = await odooSource(env);
  if (!source) return { ok: false, error: 'Odoo is not set up in Insight yet.', pos: paid.size };
  const { orders, unknown } = await cashPoDetails({ ...source, names: [...paid.values()].map((p) => p.po), ...(fetchImpl ? { fetchImpl } : {}) });
  const byName = new Map(orders.map((o) => [o.name.toUpperCase(), o]));
  const at = now();
  const rows = [...paid.entries()].map(([key, p]) => {
    const o = byName.get(key);
    return {
      po: o?.name || p.po,
      vendor: o?.vendor || p.vendor,
      paidFrom: p.paidFrom,
      paidDay: p.paidDay,
      // Typed on a shift and never looked up: what left is the PO's total.
      paid: p.paid ?? (o ? o.total : 0),
      source: p.source,
      poTotal: o ? o.total : null,
      poState: o ? o.state : null,
      orderedOn: o ? o.orderedOn : null,
      inOdoo: o ? 1 : 0,
      billed: o?.billed ? 1 : 0,
      posted: o?.posted ? 1 : 0,
      bills: o ? o.bills : [],
      lines: o ? o.lines : [],
    };
  });

  await run(env.DB, 'DELETE FROM cash_po');
  await writeAll(env.DB, rows.map((r) => env.DB.prepare(`INSERT INTO cash_po
    (po, vendor, paid_from, paid_day, paid, source, po_total, po_state, ordered_on, in_odoo, billed, bills, lines, checked_at, posted)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`).bind(
    r.po, r.vendor, r.paidFrom, r.paidDay, r.paid, r.source, r.poTotal, r.poState, r.orderedOn,
    r.inOdoo, r.billed, JSON.stringify(r.bills), JSON.stringify(r.lines), at, r.posted,
  )));
  const cost = await writeCashCost(env, rows);

  // Every PO confirmed in Odoo lately, however it was paid: one with no posted
  // bill is a to-do item too.
  const back = lookbackDays(await getSettings(env.DB).catch(() => ({})));
  const since = addDays(today || new Date().toISOString().slice(0, 10), -back);
  const recent = await confirmedPoBills({ ...source, since, ...(fetchImpl ? { fetchImpl } : {}) });
  await run(env.DB, 'DELETE FROM odoo_po');
  await writeAll(env.DB, recent.filter((o) => o.name).map((o) => env.DB.prepare(`INSERT INTO odoo_po
    (po, vendor, total, state, ordered_on, billed, posted, drafts, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT (po) DO NOTHING`).bind(
    o.name, o.vendor, o.total, o.state, o.orderedOn, o.billed ? 1 : 0, o.posted ? 1 : 0, JSON.stringify(o.drafts), at,
  )));

  const todos = await syncTodos(env, { today });
  return { ok: true, pos: rows.length, billed: rows.filter((r) => r.billed).length, unbilled: cost.pos, unbilledAmount: cost.amount, unknown, todos };
}

/**
 * The cost of cash POs not billed yet, by day and part of the business. What
 * left the cash is spread over the PO's lines in proportion to what each cost;
 * a PO with no lines to go by is put under admin.
 */
async function writeCashCost(env, rows) {
  const bucket = new Map();
  let pos = 0;
  let amount = 0;
  for (const r of rows) {
    if (!r.inOdoo || r.billed || !(r.paid > 0)) continue;
    pos += 1;
    amount += r.paid;
    const parts = (r.lines || []).filter((l) => l.amount > 0);
    const whole = parts.reduce((t, l) => t + l.amount, 0);
    const shares = whole > 0 ? parts.map((l) => ({ line: l.line, amount: Math.round((r.paid * l.amount) / whole) })) : [{ line: 'admin', amount: r.paid }];
    // Whatever rounding left over goes to the largest share.
    const drift = r.paid - shares.reduce((t, s) => t + s.amount, 0);
    if (drift) shares.sort((a, b) => b.amount - a.amount)[0].amount += drift;
    for (const s of shares) {
      const key = `${r.paidDay}|${s.line}`;
      bucket.set(key, { day: r.paidDay, line: s.line, amount: (bucket.get(key)?.amount || 0) + s.amount });
    }
  }
  const lines = new Set((await all(env.DB, 'SELECT id FROM dim_line')).map((x) => x.id));
  await run(env.DB, 'DELETE FROM fact_cost WHERE source_id = ?1', CASH_SOURCE);
  const list = [...bucket.values()].map((b) => ({ ...b, line: lines.has(b.line) ? b.line : 'admin' }));
  await writeAll(env.DB, [...new Set(list.map((b) => b.day))].map((day) => env.DB.prepare(
    `INSERT INTO dim_day (day, dow, dow_label, iso_week, month, is_weekend) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (day) DO NOTHING`,
  ).bind(day, dow(day), dowLabel(day), isoWeek(day), month(day), dow(day) >= 6 ? 1 : 0)));
  await writeAll(env.DB, list.map((b) => env.DB.prepare(
    `INSERT INTO fact_cost (day, line_id, source_id, category, supplier_id, amount) VALUES (?1, ?2, ?3, 'purchases', 0, ?4)
     ON CONFLICT (day, line_id, source_id, category, supplier_id) DO UPDATE SET amount = amount + ?4`,
  ).bind(b.day, b.line, CASH_SOURCE, b.amount)));
  return { pos, amount };
}

/** Put the cash cost back after the nightly load has cleared its window. Odoo is not asked. */
export async function restoreCashCost(env) {
  const rows = (await all(env.DB, 'SELECT * FROM cash_po')).map((r) => ({
    paidDay: r.paid_day, paid: r.paid, inOdoo: r.in_odoo, billed: r.billed, lines: parse(r.lines, []),
  }));
  return writeCashCost(env, rows);
}

const parse = (text, fallback) => { try { return JSON.parse(text || ''); } catch { return fallback; } };
const key = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The Money page's view of how things were paid, for a window: bills by their
 * date, cash by the day it left.
 */
export async function cashView(env, { from, to }) {
  const [bills, cash, lines, last] = await Promise.all([
    all(env.DB, `SELECT b.external_id, b.day, b.total, b.from_order, b.line_id, b.vendor_ref, s.name AS supplier
                   FROM fact_bill b LEFT JOIN dim_supplier s ON s.id = b.supplier_id
                  WHERE b.day BETWEEN ?1 AND ?2 AND b.state != 'cancel'`, from, to),
    all(env.DB, 'SELECT * FROM cash_po WHERE paid_day BETWEEN ?1 AND ?2 ORDER BY paid_day, po', from, to),
    all(env.DB, 'SELECT id, label FROM dim_line ORDER BY sort_order'),
    first(env.DB, 'SELECT MAX(checked_at) AS at, COUNT(*) AS n FROM cash_po'),
  ]);
  const pos = cash.map((r) => ({
    po: r.po, vendor: r.vendor, paidFrom: r.paid_from, paidDay: r.paid_day, paid: r.paid, source: r.source,
    poTotal: r.po_total, poState: r.po_state, inOdoo: Boolean(r.in_odoo), billed: Boolean(r.billed), posted: Boolean(r.posted),
    bills: parse(r.bills, []), lines: parse(r.lines, []),
  }));

  const billTotal = bills.reduce((t, b) => t + (b.total || 0), 0);
  const unbilled = pos.filter((p) => p.inOdoo && !p.billed);
  const unbilledTotal = unbilled.reduce((t, p) => t + p.paid, 0);
  const drawer = pos.filter((p) => p.paidFrom === 'drawer').reduce((t, p) => t + p.paid, 0);
  const safe = pos.filter((p) => p.paidFrom === 'safe').reduce((t, p) => t + p.paid, 0);
  const spend = billTotal + unbilledTotal;

  // By supplier: bills, and cash by where it came from.
  const sup = new Map();
  const row = (name) => {
    const k = key(name) || '(no supplier)';
    if (!sup.has(k)) sup.set(k, { supplier: name || '(no supplier)', billed: 0, unbilled: 0, drawer: 0, safe: 0 });
    return sup.get(k);
  };
  for (const b of bills) row(b.supplier).billed += b.total || 0;
  for (const p of pos) {
    const r = row(p.vendor);
    r[p.paidFrom] += p.paid;
    if (p.inOdoo && !p.billed) r.unbilled += p.paid;
  }
  const suppliers = [...sup.values()].map((r) => {
    const total = r.billed + r.unbilled;
    return { ...r, total, other: Math.max(0, total - r.drawer - r.safe) };
  }).sort((a, b) => b.total - a.total);

  const label = new Map(lines.map((l) => [l.id, l.label]));
  const byLine = new Map();
  const lineRow = (id) => {
    if (!byLine.has(id)) byLine.set(id, { line: id, label: label.get(id) || id, billed: 0, unbilled: 0 });
    return byLine.get(id);
  };
  for (const b of bills) lineRow(b.line_id).billed += b.total || 0;
  for (const p of unbilled) {
    const parts = p.lines.filter((l) => l.amount > 0);
    const whole = parts.reduce((t, l) => t + l.amount, 0);
    if (!whole) lineRow('admin').unbilled += p.paid;
    else for (const l of parts) lineRow(l.line).unbilled += Math.round((p.paid * l.amount) / whole);
  }

  return {
    range: { from, to },
    checkedAt: last?.at || null,
    known: Number(last?.n) || 0,
    split: { spend, bills: billTotal, unbilled: unbilledTotal, drawer, safe, other: Math.max(0, spend - drawer - safe) },
    suppliers: suppliers.slice(0, 40),
    lines: [...byLine.values()].map((l) => ({ ...l, total: l.billed + l.unbilled })).sort((a, b) => b.total - a.total),
    // Still to chase: no bill, or a bill only in draft.
    unbilled: pos.filter((p) => p.inOdoo && !p.posted)
      .map((p) => ({ po: p.po, vendor: p.vendor, paidFrom: p.paidFrom, paidDay: p.paidDay, paid: p.paid, source: p.source, draft: p.billed })),
    differs: pos.filter((p) => p.inOdoo && p.poTotal != null && p.poTotal !== p.paid)
      .map((p) => ({ po: p.po, vendor: p.vendor, paidFrom: p.paidFrom, paidDay: p.paidDay, paid: p.paid, poTotal: p.poTotal, source: p.source })),
    notInOdoo: pos.filter((p) => !p.inOdoo).map((p) => ({ po: p.po, paidFrom: p.paidFrom, paidDay: p.paidDay, paid: p.paid, source: p.source })),
    // POs ordered in these days, not paid in cash, with no posted bill in Odoo.
    noBill: await all(env.DB, `SELECT po, vendor, total, ordered_on, billed FROM odoo_po
        WHERE posted = 0 AND total > 0 AND ordered_on BETWEEN ?1 AND ?2 AND po NOT IN (SELECT po FROM cash_po)
        ORDER BY ordered_on`, from, to)
      .then((rows) => rows.map((r) => ({ po: r.po, vendor: r.vendor, total: r.total, orderedOn: r.ordered_on, draft: Boolean(r.billed) })))
      .catch(() => []),
    todo: await todoCounts(env),
  };
}

/**
 * "Check Odoo now", from the Money page (admins) or the to-do list (admins
 * and supervisors: a supervisor chasing a bill wants to see it clear).
 */
export async function refreshNow(env, account, opts = {}) {
  const role = roleOf(account);
  if (role !== 'admin' && !(opts.fromTodo && role === 'supervisor')) await requireAdmin(account);
  const result = await refreshCashPos(env, opts);
  if (!result.ok) throw new HttpError(409, result.error);
  return result;
}
