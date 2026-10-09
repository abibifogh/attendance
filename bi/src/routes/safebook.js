import { all, first, run } from '../lib/db.js';
import { badRequest, HttpError, notFound, str } from '../lib/http.js';
import { addDays } from '../lib/dates.js';
import { listSources, secretNameFor } from '../connectors/index.js';
import { purchaseOrders, purchaseOrdersSince } from '../connectors/odoo.js';
import { requireAdmin } from './till.js';
import { shiftsToSafe } from './safe.js';

/**
 * The safe book.
 *
 * A page runs from one count of the safe to the next. Cash comes in from the
 * shifts' envelopes, as ASSD moved it to the safe; nobody types it. Cash goes
 * out as it is written here: a PO paid from the safe, cash banked or handed
 * over, or a payment still waiting for its PO. The book's balance is what the
 * safe should hold.
 *
 * Beside the book, the POs confirmed in Odoo since the last count that nobody
 * has claimed (no shift's closing report, no drawer expense, not the safe
 * already), offered one by one: paid from the safe, or not. When the safe is
 * counted, a difference from the book is shown with the waiting POs that add
 * up to it exactly.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toISOString().slice(0, 10);
const who = (account) => account?.name || account?.email || 'Owner';
const CONFIRMED = new Set(['purchase', 'done']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function cedis(value, field, { required = false } = {}) {
  const text = String(value ?? '').replace(/[,\s]/g, '').replace(/^GH₵|^GHS/i, '');
  if (text === '') {
    if (required) throw badRequest(`${field} is needed.`);
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw badRequest(`${field} is not an amount of money.`);
  return Math.round(Number(text) * 100);
}

function dayOf(value, field = 'The day') {
  const day = String(value ?? '').trim() || today();
  if (!DAY.test(day)) throw badRequest(`${field} is not a date.`);
  return day;
}

/** Odoo, as Insight is set up to read it. */
async function odoo(env) {
  const sources = (await listSources(env.DB)).filter((s) => s.kind === 'odoo_json2' && s.config?.base);
  const source = sources.find((s) => s.enabled) || sources[0];
  if (!source) return null;
  const secret = secretNameFor(source);
  return { config: source.config, token: secret ? env[secret] : null };
}

/** Every PO already accounted for somewhere: a closing report, a drawer expense, the safe. */
async function claimedPos(env) {
  const out = new Map();
  const up = (n) => String(n || '').trim().toUpperCase();
  if (env.ATT_DB) {
    try {
      for (const r of await all(env.ATT_DB, 'SELECT po, day, slot FROM till_po')) out.set(up(r.po), `a closing report (${r.day} ${r.slot})`);
    } catch { /* HIVE not upgraded */ }
  }
  for (const r of await all(env.DB, 'SELECT day, slot, po_numbers, odoo FROM shift_expense')) {
    let names = [];
    try { names = (JSON.parse(r.odoo || '{}').orders || []).map((o) => o.name); } catch { names = []; }
    names.push(...String(r.po_numbers || '').split(/[\s,;]+/));
    for (const n of names.filter(Boolean)) if (!out.has(up(n))) out.set(up(n), `the drawer's expenses (${r.day} ${r.slot})`);
  }
  for (const r of await all(env.DB, 'SELECT po, day FROM safe_entry WHERE po IS NOT NULL')) out.set(up(r.po), `the safe (${r.day})`);
  return out;
}

/** The last count, or null before the book is started. */
const lastCount = (env) => first(env.DB, 'SELECT * FROM safe_closure WHERE counted IS NOT NULL ORDER BY id DESC LIMIT 1');

/** The open page: where it starts, what came in, what went out, and the balance. */
async function openPage(env, account) {
  const start = await lastCount(env);
  const from = start ? addDays(start.closed_on, -14) : addDays(today(), -30);
  // The shifts are read at most 60 days at a time; a page can stay open longer.
  const rows = [];
  for (let a = from; a <= today(); a = addDays(a, 60)) {
    const b = addDays(a, 59) < today() ? addDays(a, 59) : today();
    // eslint-disable-next-line no-await-in-loop
    rows.push(...(await shiftsToSafe(env, { from: a, to: b }, account)).rows);
  }
  const ins = rows.filter((r) => !r.closure && r.assd > 0);
  const outs = await all(env.DB, 'SELECT * FROM safe_entry WHERE closure_id IS NULL ORDER BY day, id');
  const lines = [];
  for (const r of ins) {
    lines.push({
      type: 'in', day: r.day, slot: r.slot, user: r.user, amount: r.assd, envelopes: r.envelopes, list: r.list, agrees: r.agrees,
    });
  }
  for (const e of outs) lines.push({ type: 'out', ...entryView(e) });
  // In the order things happened: by day, envelopes before payments.
  lines.sort((a, b) => (a.day === b.day ? (a.type === b.type ? 0 : a.type === 'in' ? -1 : 1) : a.day < b.day ? -1 : 1));
  let balance = start ? start.counted : 0;
  for (const l of lines) {
    balance += l.type === 'in' ? l.amount : -l.amount;
    l.balance = balance;
  }
  return { start, lines, balance, ins, outs };
}

function entryView(e) {
  return {
    id: e.id, kind: e.kind, day: e.day, amount: e.amount, po: e.po, vendor: e.vendor, poState: e.po_state,
    poTotal: e.po_total, orderedOn: e.ordered_on, ref: e.ref, description: e.description, note: e.note,
    by: e.by_name, at: e.at, settledBy: e.settled_by,
    // A PO whose total is not what left the safe.
    differs: e.po_total != null && e.po_total !== e.amount,
  };
}

/** The first set of `list` (by `amount`) that adds up to exactly `target`, up to 14 to choose from. */
export function addingUpTo(list, target) {
  if (!(target > 0)) return [];
  const pool = list.slice(0, 14);
  for (let mask = 1; mask < (1 << pool.length); mask += 1) {
    let sum = 0;
    for (let i = 0; i < pool.length; i += 1) if (mask & (1 << i)) sum += pool[i].amount;
    if (sum === target) return pool.filter((_, i) => mask & (1 << i));
  }
  return [];
}

export async function bookView(env, account, { counted = null, fetchImpl } = {}) {
  await requireAdmin(account);
  const page = await openPage(env, account);
  const closures = await all(env.DB, `
    SELECT c.*, (SELECT COUNT(*) FROM safe_closure_shift x WHERE x.closure_id = c.id) AS shifts,
           (SELECT COUNT(*) FROM safe_entry e WHERE e.closure_id = c.id) AS entries
      FROM safe_closure c ORDER BY c.id DESC LIMIT 60`);

  // What Odoo has that nobody has claimed, since the page began.
  let suggestions = [];
  let odooError = null;
  const source = await odoo(env);
  if (!source) odooError = 'Odoo is not set up in Insight yet, so nothing can be offered.';
  else {
    try {
      const since = page.start ? page.start.closed_on : addDays(today(), -30);
      const [orders, claimed, dismissed] = await Promise.all([
        purchaseOrdersSince({ ...source, since, ...(fetchImpl ? { fetchImpl } : {}) }),
        claimedPos(env),
        all(env.DB, 'SELECT po FROM safe_po_dismissed'),
      ]);
      const gone = new Set(dismissed.map((d) => String(d.po).toUpperCase()));
      const pending = page.outs.filter((e) => e.kind === 'pending');
      suggestions = orders
        .filter((o) => CONFIRMED.has(o.state) && !claimed.has(o.name.toUpperCase()) && !gone.has(o.name.toUpperCase()))
        .sort((a, b) => String(a.orderedOn).localeCompare(String(b.orderedOn)))
        .map((o) => ({
          name: o.name, vendor: o.vendor, amount: o.total, orderedOn: o.orderedOn,
          // A payment waiting for its PO, of the same amount.
          pending: pending.find((e) => e.amount === o.total)?.id ?? null,
        }));
    } catch (err) {
      odooError = `Odoo did not answer: ${err.message}`;
    }
  }

  const want = counted == null ? null : page.balance - counted;
  return {
    started: Boolean(page.start),
    start: page.start ? { day: page.start.closed_on, counted: page.start.counted, with: page.start.with_name } : null,
    lines: page.lines,
    balance: page.balance,
    pending: page.outs.filter((e) => e.kind === 'pending').length,
    suggestions,
    odooError,
    // When a count is being typed: the waiting POs that make up the difference.
    explains: want != null ? addingUpTo(suggestions, want).map((s) => s.name) : [],
    closures: closures.map((c) => ({
      id: c.id, closedOn: c.closed_on, with: c.with_name, counted: c.counted, book: c.book,
      difference: c.counted != null && c.book != null ? c.counted - c.book : null,
      assd: c.assd, envelopes: c.envelopes, taken: c.taken, note: c.note, by: c.by_name,
      shifts: Number(c.shifts) || 0, entries: Number(c.entries) || 0,
    })),
  };
}

/** Look a PO up for the safe: confirmed in Odoo, and not claimed anywhere else. */
async function safePo(env, typed, { fetchImpl } = {}) {
  const source = await odoo(env);
  if (!source) throw new HttpError(409, 'Odoo is not set up in Insight yet.');
  const raw = String(typed || '').trim().toUpperCase();
  if (!raw) throw badRequest('Type the PO number.');
  const name = /^\d+$/.test(raw) ? `P${raw.padStart(5, '0')}` : raw;
  const { orders } = await purchaseOrders({ ...source, names: [name, raw], ...(fetchImpl ? { fetchImpl } : {}) });
  const order = orders.find((o) => o.name.toUpperCase() === name || o.name.toUpperCase() === raw);
  if (!order) throw badRequest(`${name} is not in Odoo.`);
  if (!CONFIRMED.has(order.state)) throw badRequest(`${order.name} is ${order.state} in Odoo, not confirmed. Confirm it first.`);
  const claimed = (await claimedPos(env)).get(order.name.toUpperCase());
  if (claimed) throw badRequest(`${order.name} is already accounted for in ${claimed}.`);
  return order;
}

/** Write something that left the safe. */
export async function addEntry(env, body, account, opts = {}) {
  await requireAdmin(account);
  const kind = String(body?.kind || '');
  const day = dayOf(body?.day);
  const note = str(body?.note, 'Note', { max: 400 }) || null;
  const start = await lastCount(env);
  if (start && day < start.closed_on) throw badRequest(`That day is before the last count (${start.closed_on}). It is already in that count.`);
  if (kind === 'po') {
    const order = await safePo(env, body?.po, opts);
    await run(env.DB, `INSERT INTO safe_entry (kind, day, amount, po, vendor, po_state, po_total, ordered_on, note, by_name, at)
      VALUES ('po', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    day, order.total, order.name, order.vendor, order.state, order.total, order.orderedOn, note, who(account), now());
    return { ok: true, po: order.name, amount: order.total };
  }
  if (kind === 'banked') {
    const amount = cedis(body?.amount, 'The amount', { required: true });
    const ref = str(body?.ref, 'Where it went', { required: true, max: 200 });
    await run(env.DB, `INSERT INTO safe_entry (kind, day, amount, ref, note, by_name, at) VALUES ('banked', ?1, ?2, ?3, ?4, ?5, ?6)`,
      day, amount, ref, note, who(account), now());
    return { ok: true };
  }
  if (kind === 'pending') {
    const amount = cedis(body?.amount, 'The amount', { required: true });
    const description = str(body?.description, 'What it paid for', { required: true, max: 200 });
    await run(env.DB, `INSERT INTO safe_entry (kind, day, amount, description, note, by_name, at) VALUES ('pending', ?1, ?2, ?3, ?4, ?5, ?6)`,
      day, amount, description, note, who(account), now());
    return { ok: true };
  }
  throw badRequest('Say what left the safe: a PO, cash banked or handed over, or a payment waiting for its PO.');
}

/** Give a payment that was waiting its PO. What left the safe stays; the PO's total is set beside it. */
export async function settleEntry(env, id, body, account, opts = {}) {
  await requireAdmin(account);
  const row = await first(env.DB, "SELECT * FROM safe_entry WHERE id = ?1 AND kind = 'pending'", Number(id));
  if (!row) throw notFound('That payment is not waiting for a PO.');
  const order = await safePo(env, body?.po, opts);
  await run(env.DB, `UPDATE safe_entry SET kind = 'po', po = ?2, vendor = ?3, po_state = ?4, po_total = ?5, ordered_on = ?6,
    settled_by = ?7, settled_at = ?8 WHERE id = ?1`, row.id, order.name, order.vendor, order.state, order.total, order.orderedOn, who(account), now());
  return { ok: true, po: order.name, differs: order.total !== row.amount, poTotal: order.total, amount: row.amount };
}

/** Take back something written in the open page. */
export async function removeEntry(env, id, account) {
  await requireAdmin(account);
  const row = await first(env.DB, 'SELECT * FROM safe_entry WHERE id = ?1', Number(id));
  if (!row) throw notFound('No such payment.');
  if (row.closure_id) throw badRequest('That is on a counted page. Undo the count first.');
  await run(env.DB, 'DELETE FROM safe_entry WHERE id = ?1', row.id);
  return { ok: true };
}

/** "Not from the safe": stop offering a PO. */
export async function dismissPo(env, body, account) {
  await requireAdmin(account);
  const po = str(body?.po, 'PO', { required: true, max: 40 }).toUpperCase();
  await run(env.DB, 'INSERT INTO safe_po_dismissed (po, by_name, at) VALUES (?1, ?2, ?3) ON CONFLICT (po) DO NOTHING', po, who(account), now());
  return { ok: true };
}

/**
 * Count the safe, closing the page. The first count starts the book: what is
 * counted then is where it begins, and the shifts before it are taken as in it.
 */
export async function countSafe(env, body, account) {
  await requireAdmin(account);
  const counted = cedis(body?.counted, 'What you counted', { required: true });
  const closedOn = dayOf(body?.closedOn, 'The day of the count');
  const withName = str(body?.with, 'Counted with', { max: 120 }) || null;
  const note = str(body?.note, 'Note', { max: 600 }) || null;
  const page = await openPage(env, account);
  if (page.start && closedOn < page.start.closed_on) throw badRequest(`The last count was on ${page.start.closed_on}. A new count cannot be before it.`);
  const skip = new Set((Array.isArray(body?.leaveOut) ? body.leaveOut : []).map((k) => String(k)));
  const shifts = page.ins.filter((r) => r.day <= closedOn && !skip.has(`${r.day}|${r.slot}`));
  const left = page.ins.filter((r) => !shifts.includes(r));
  const outs = page.outs.filter((e) => e.day <= closedOn);
  // The book as it stands for what this count takes in.
  const book = page.start
    ? page.start.counted + shifts.reduce((t, r) => t + r.assd, 0) - outs.reduce((t, e) => t + e.amount, 0)
    : counted;
  const made = await first(env.DB, `INSERT INTO safe_closure (closed_on, with_name, assd, envelopes, counted, book, note, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id`,
  closedOn, withName, shifts.reduce((t, r) => t + r.assd, 0), shifts.reduce((t, r) => t + (r.envelopes || 0), 0),
  counted, book, note || (page.start ? null : 'The book starts here.'), who(account), now());
  for (const r of shifts) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'INSERT INTO safe_closure_shift (day, slot, closure_id, assd, envelopes) VALUES (?1, ?2, ?3, ?4, ?5)',
      r.day, r.slot, made.id, r.assd, r.envelopes || 0);
  }
  for (const e of outs) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'UPDATE safe_entry SET closure_id = ?2 WHERE id = ?1', e.id, made.id);
  }
  return { ok: true, id: made.id, counted, book, difference: counted - book, started: !page.start, carried: left.length };
}
