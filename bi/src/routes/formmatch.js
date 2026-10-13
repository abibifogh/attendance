import { all } from '../lib/db.js';
import { badRequest } from '../lib/http.js';
import { addDays, todayIn } from '../lib/dates.js';
import { shifts as shiftsFor, linkPos, poList } from './shifts.js';

/**
 * The expense form against the shifts, for a month of backlog: which POs on
 * the form clearly belong to which shift's expenses.
 *
 * A shift's expenses with no PO, or the part of them its POs do not cover,
 * are matched with form responses paid from the cash register, dated that day
 * (a night shift: that day or the next) or, with no date on the response,
 * sent during the shift or within six hours of its end. A set of POs that adds up to exactly
 * what is missing is clear when it is the only such set, or the only one sent
 * during the shift or by the person on it. Failing that, a single PO that is
 * exactly one of the shift's receipts is clear on its own. A PO two shifts
 * could each claim goes to neither. What is not clear is listed with the
 * POs that could be it, for a person to decide.
 */

const START = { morning: 6, afternoon: 14, night: 22 };

/** Minutes since 1970 of a UTC 'yyyy-mm-dd hh:mm'. */
const minutes = (at) => Math.floor(Date.parse(`${String(at).replace(' ', 'T').slice(0, 16)}:00Z`) / 60000);

function windowOf(day, slot) {
  const start = minutes(`${day} 00:00`) + (START[slot] ?? 6) * 60;
  return { start, end: start + 8 * 60 };
}

const firstName = (s) => String(s || '').trim().split(/\s+/)[0].toLowerCase();

/** Every set of up to `most` candidates whose values add up to `target` (at most 40 sets). */
export function setsAdding(list, target, most = 6) {
  const out = [];
  const pick = [];
  const walk = (i, left) => {
    if (out.length >= 40) return;
    if (left === 0 && pick.length) { out.push([...pick]); return; }
    if (i >= list.length || pick.length >= most || left < 0) return;
    pick.push(list[i]);
    walk(i + 1, left - list[i].value);
    pick.pop();
    walk(i + 1, left);
  };
  walk(0, target);
  return out;
}

/**
 * The matching itself, on plain data, so it can be tested.
 *
 * `needs`: [{ day, slot, user, target, pieces: [amount] }]
 * `groups`: [{ po, value, days: [day], submitted, by: [name] }]
 */
export function matchForm(needs, groups) {
  const fits = (n, g) => {
    if (g.days.length) return g.days.includes(n.day) || (n.slot === 'night' && g.days.includes(addDays(n.day, 1)));
    // No date on it: sent during the shift or within six hours of its end.
    const w = windowOf(n.day, n.slot);
    const at = minutes(g.submitted);
    return at >= w.start && at <= w.end + 6 * 60;
  };
  const near = (n, g) => {
    const w = windowOf(n.day, n.slot);
    const at = minutes(g.submitted);
    return at >= w.start - 60 && at <= w.end + 3 * 60;
  };
  const named = (n, g) => g.by.some((b) => firstName(b) && firstName(b) === firstName(n.user));

  const taken = new Set();
  const settled = new Map();
  for (let round = 0; round < 6; round += 1) {
    const offers = [];
    for (const n of needs) {
      if (settled.has(n)) continue;
      const cands = groups.filter((g) => !taken.has(g.po) && g.value > 0 && fits(n, g)).slice(0, 18);
      const sets = setsAdding(cands, n.target);
      let chosen = null;
      let why = '';
      if (sets.length === 1) { chosen = sets[0]; why = 'adds up to what the shift is missing'; } else if (sets.length > 1) {
        const sure = sets.filter((s) => s.every((g) => near(n, g) || named(n, g)));
        if (sure.length === 1) { chosen = sure[0]; why = 'adds up to what the shift is missing, and was sent during the shift or by the person on it'; }
      }
      if (!chosen && !sets.length) {
        // One receipt at a time: a PO that is exactly one of them.
        const part = [];
        for (const p of n.pieces) {
          const same = cands.filter((g) => g.value === p && !part.includes(g));
          if (same.length === 1) part.push(same[0]);
        }
        if (part.length) { chosen = part; why = 'each is exactly one of the shift’s receipts'; }
      }
      if (chosen) offers.push({ n, chosen, why, part: chosen.reduce((t, g) => t + g.value, 0) !== n.target });
    }
    // A PO two shifts could each claim goes to neither.
    const claims = new Map();
    for (const o of offers) for (const g of o.chosen) claims.set(g.po, (claims.get(g.po) || 0) + 1);
    const won = offers.filter((o) => o.chosen.every((g) => claims.get(g.po) === 1));
    if (!won.length) break;
    for (const o of won) {
      settled.set(o.n, o);
      for (const g of o.chosen) taken.add(g.po);
    }
  }

  const clear = [];
  const unsure = [];
  for (const n of needs) {
    const o = settled.get(n);
    if (o) {
      clear.push({ day: n.day, slot: n.slot, user: n.user, target: n.target, part: o.part, why: o.why, pos: o.chosen.map(view) });
    } else {
      const could = groups.filter((g) => !taken.has(g.po) && g.value > 0 && fits(n, g));
      unsure.push({ day: n.day, slot: n.slot, user: n.user, target: n.target, could: could.slice(0, 12).map(view) });
    }
  }
  return { clear, unsure, leftOver: groups.filter((g) => !taken.has(g.po)).length };
}

const view = (g) => ({ po: g.po, value: g.value, days: g.days, submitted: g.submitted, by: g.by });

/** What each shift of the month is missing a PO for. */
function needsOf(data) {
  const out = [];
  for (const d of data.days || []) {
    for (const s of d.shifts || []) {
      const r = s.register || {};
      if (!(r.expenses > 0)) continue;
      const orders = s.expense?.odoo?.orders || [];
      const typed = poList(s.expense?.poNumbers);
      // POs typed and not yet read from Odoo: what they cover is not known.
      if (typed.some((n) => !orders.some((o) => String(o.name).toUpperCase() === n))) continue;
      const covered = Math.round(orders.reduce((t, o) => t + (Number(o.total) || 0), 0));
      const target = r.expenses - covered;
      if (target <= 0) continue;
      const pieces = [...(r.receipts?.list || []).map((x) => x.amount), ...(s.moves || []).filter((m) => m.direct > 0).map((m) => m.direct)];
      out.push({ day: s.day, slot: s.slot, user: s.user, target, expenses: r.expenses, pieces });
    }
  }
  return out;
}

/** The form's responses near the month, as POs not yet tied to anything. */
async function groupsFor(env, from, to) {
  const rows = await all(env.DB, `SELECT po, amount, tnt, by_name, submitted_at, expense_day, paid_from FROM expense_report
    WHERE po IS NOT NULL AND amount IS NOT NULL
      AND ((expense_day BETWEEN ?1 AND ?2) OR (expense_day IS NULL AND submitted_at BETWEEN ?3 AND ?4))`,
  addDays(from, -1), addDays(to, 1), from, `${addDays(to, 2)} 23:59`);
  // Already somewhere: on a closing report, linked to a shift, or paid from the safe.
  const used = new Set();
  if (env.ATT_DB) for (const r of await all(env.ATT_DB, 'SELECT po FROM till_po').catch(() => [])) used.add(String(r.po).toUpperCase());
  for (const r of await all(env.DB, 'SELECT po_numbers FROM shift_expense WHERE po_numbers IS NOT NULL').catch(() => [])) for (const n of poList(r.po_numbers)) used.add(n);
  for (const r of await all(env.DB, 'SELECT po FROM safe_entry WHERE po IS NOT NULL').catch(() => [])) used.add(String(r.po).toUpperCase());

  const byPo = new Map();
  let safe = 0;
  for (const r of rows) {
    const po = String(r.po).toUpperCase();
    if (used.has(po)) continue;
    const g = byPo.get(po) || { po, value: 0, days: [], submitted: null, by: [], safe: false, dated: true };
    g.value += (r.amount || 0) + (r.tnt || 0);
    if (r.expense_day && !g.days.includes(r.expense_day)) g.days.push(r.expense_day);
    if (!r.expense_day) g.dated = false;
    if (!g.submitted || r.submitted_at < g.submitted) g.submitted = r.submitted_at;
    if (r.by_name && !g.by.includes(r.by_name)) g.by.push(r.by_name);
    if (r.paid_from === 'safe') g.safe = true;
    byPo.set(po, g);
  }
  const groups = [];
  for (const g of byPo.values()) {
    if (g.safe) { safe += 1; continue; }
    // Only some of its responses dated: go by the time it was sent.
    if (!g.dated) g.days = [];
    groups.push(g);
  }
  groups.sort((a, b) => String(a.submitted).localeCompare(String(b.submitted)));
  return { groups, safe, undated: rows.filter((r) => !r.expense_day).length, responses: rows.length };
}

/** The month's proposals. */
export async function formMatches(env, query, account) {
  const month = /^\d{4}-\d{2}$/.test(String(query?.month || '')) ? query.month : todayIn('UTC').slice(0, 7);
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
  const yesterday = addDays(todayIn('UTC'), -1);
  const to = end < yesterday ? end : yesterday;
  if (to < from) return { month, from, to, clear: [], unsure: [], form: { responses: 0, undated: 0, safe: 0, open: 0 } };
  const data = await shiftsFor(env, { from, to }, account);
  const needs = needsOf(data);
  const { groups, safe, undated, responses } = await groupsFor(env, from, to);
  const out = matchForm(needs, groups);
  const exp = new Map(needs.map((n) => [`${n.day}|${n.slot}`, n.expenses]));
  for (const x of [...out.clear, ...out.unsure]) x.expenses = exp.get(`${x.day}|${x.slot}`) ?? null;
  return { month, from, to, ...out, form: { responses, undated, safe, open: groups.length } };
}

/** Link the POs chosen, a few shifts at a time. */
export async function applyMatches(env, body, account) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length || items.length > 6) throw badRequest('Send between 1 and 6 shifts at a time.');
  const done = [];
  for (const it of items) {
    const pos = (Array.isArray(it?.pos) ? it.pos : []).map((p) => String(p).toUpperCase()).filter((p) => /^P\d{3,6}$/.test(p));
    if (!pos.length) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await linkPos(env, { day: it.day, slot: it.slot, add: pos.join(', ') }, account);
      done.push({ day: it.day, slot: it.slot, pos, ok: true, warning: out.warning || null });
    } catch (err) {
      done.push({ day: it.day, slot: it.slot, pos, ok: false, error: String(err?.message || err) });
    }
  }
  return { ok: true, done };
}
