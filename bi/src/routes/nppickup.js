import { all, first, run } from '../lib/db.js';
import { badRequest, HttpError, notFound, str } from '../lib/http.js';
import { addDays, todayIn } from '../lib/dates.js';
import { addReceipt, pickupMarkFor } from './receipts.js';
import { requireAdmin, requireArea, roleOf } from './till.js';

/**
 * Nice Place pickups.
 *
 * The desk sends each shift's money with its counters (niceplace.js) and puts
 * the cash in an envelope in the safe. Now and then, once a week or more, a
 * supervisor given "Nice Place pickups" takes the envelopes:
 *
 * 1. A pickup is started: every shift sent since the last pickup is offered,
 *    each with its money; a shift with nothing sent is said, so it is chased.
 * 2. What was paid out of the money is added one at a time, with a picture of
 *    the receipt: each is read and made a draft PO in Odoo carrying its
 *    reference (NP/PU/014-1), the way a float's receipts are.
 * 3. The shifts taken are ticked, the cash in hand counted, and the pickup
 *    recorded: sales less spent is the net cash, against what was counted.
 *
 * An admin reviews each recorded pickup: Approve, or ask the supervisor. The
 * counted cash goes into the main safe's book on the day of the pickup, and
 * into the next count of the safe.
 */

const TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const FILE_MAX = 14_000_000;
/** How far back shifts are offered for a pickup when there has never been one. */
const FIRST_DAYS = 31;

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const order = (day, shift) => `${day}|${shift === 'day' ? 0 : 1}`;
export const refOf = (id, seq) => `NP/PU/${String(id).padStart(3, '0')}-${seq}`;

const cedis = (value, label) => {
  const text = String(value ?? '').replace(/[\s,]/g, '').replace(/^GH₵|^GHS/i, '');
  const n = Number(text);
  if (text === '' || !Number.isFinite(n) || n < 0 || n > 1_000_000) throw badRequest(`${label}: an amount in cedis, e.g. 240 or 65.50.`);
  return Math.round(n * 100);
};

/** Whoever may look (1) or make pickups (2): admins, and supervisors given Nice Place pickups. */
const may = (env, account, level) => requireArea(env, account, 'pickups', level);

/** Every shift's money still in the safe: sent from the desk (or the workbook), not yet picked up. */
async function inSafe(env, today) {
  const last = await first(env.DB, "SELECT MAX(day) AS day FROM np_pickup_shift");
  const from = last?.day ? addDays(last.day, -7) : addDays(today, -FIRST_DAYS);
  const rows = await all(env.DB, `SELECT r.day, r.shift, COALESCE(r.toilet_total, 0) + COALESCE(r.shower_total, 0) AS amount, r.staff
    FROM np_revenue r LEFT JOIN np_pickup_shift p ON p.day = r.day AND p.shift = r.shift
    WHERE r.day >= ?1 AND r.day <= ?2 AND p.pickup_id IS NULL ORDER BY r.day, CASE r.shift WHEN 'night' THEN 1 ELSE 0 END`, from, today);
  // Shifts after the last one picked up with no money sent: to chase.
  const sent = new Set(rows.map((r) => `${r.day}|${r.shift}`));
  const picked = new Set((await all(env.DB, 'SELECT day, shift FROM np_pickup_shift WHERE day >= ?1', from)).map((r) => `${r.day}|${r.shift}`));
  const missing = [];
  const start = last?.day || (rows[0]?.day ?? today);
  for (let d = start; d < today; d = addDays(d, 1)) {
    for (const shift of ['day', 'night']) {
      const key = `${d}|${shift}`;
      if (!sent.has(key) && !picked.has(key)) missing.push({ day: d, shift });
    }
  }
  return {
    shifts: rows.map((r) => ({ day: r.day, shift: r.shift, key: `${r.day}|${r.shift}`, amount: Number(r.amount) || 0, staff: r.staff || null })),
    missing,
  };
}

function view(p, shifts, expenses) {
  const net = p.sales - p.spent;
  return {
    id: p.id, day: p.day, by: p.by_name, byId: p.by_id, status: p.status,
    sales: p.sales, spent: p.spent, net, counted: p.counted, difference: p.counted == null ? null : p.counted - net,
    note: p.note, recordedAt: p.recorded_at, reviewedBy: p.reviewed_by, reviewedAt: p.reviewed_at, reviewNote: p.review_note,
    inSafeCount: Boolean(p.closure_id),
    shifts: shifts.map((s) => ({ day: s.day, shift: s.shift, amount: s.amount })),
    expenses: expenses.map((e) => ({ id: e.id, what: e.what, amount: e.amount, supplier: e.supplier, ref: e.ref, po: e.po_name || null, poUrl: e.po_url || null, status: e.status || null, problem: e.problem || null })),
  };
}

async function load(env, id) {
  const p = await first(env.DB, 'SELECT * FROM np_pickup WHERE id = ?1', Number(id));
  if (!p) throw notFound('No such pickup.');
  const shifts = await all(env.DB, "SELECT * FROM np_pickup_shift WHERE pickup_id = ?1 ORDER BY day, CASE shift WHEN 'night' THEN 1 ELSE 0 END", p.id);
  const expenses = await all(env.DB, `SELECT e.*, r.po_name, r.po_url, r.status, r.problem FROM np_pickup_expense e LEFT JOIN receipt r ON r.id = e.receipt_id
    WHERE e.pickup_id = ?1 ORDER BY e.id`, p.id);
  return view(p, shifts, expenses);
}

/** The page: the pickup being made, what is in the safe, and the pickups before. */
export async function pickupsView(env, account) {
  await may(env, account, 1);
  const today = todayIn('UTC');
  const admin = roleOf(account) === 'admin';
  const open = await first(env.DB, "SELECT id FROM np_pickup WHERE status = 'open' ORDER BY id DESC LIMIT 1");
  const rows = await all(env.DB, "SELECT id FROM np_pickup WHERE status != 'open' ORDER BY day DESC, id DESC LIMIT 30");
  const list = [];
  for (const r of rows) list.push(await load(env, r.id)); // eslint-disable-line no-await-in-loop
  const safe = await inSafe(env, today);
  const month = today.slice(0, 7);
  const ofMonth = list.filter((p) => p.day.startsWith(month));
  return {
    admin,
    open: open ? await load(env, open.id) : null,
    inSafe: safe.shifts,
    missing: safe.missing,
    pickups: list,
    tiles: {
      sales: ofMonth.reduce((t, p) => t + p.sales, 0),
      spent: ofMonth.reduce((t, p) => t + p.spent, 0),
      counted: ofMonth.reduce((t, p) => t + (p.counted || 0), 0),
      inSafe: safe.shifts.reduce((t, s) => t + s.amount, 0),
      inSafeShifts: safe.shifts.length,
      toReview: list.filter((p) => p.status === 'review').length,
    },
  };
}

/** Start a pickup, or carry on with the one already started. */
export async function startPickup(env, account) {
  await may(env, account, 2);
  const open = await first(env.DB, "SELECT id, by_name FROM np_pickup WHERE status = 'open' ORDER BY id DESC LIMIT 1");
  if (open) return load(env, open.id);
  const made = await first(env.DB, 'INSERT INTO np_pickup (day, by_id, by_name, at) VALUES (?1, ?2, ?3, ?4) RETURNING id', todayIn('UTC'), account?.id ?? null, who(account), now());
  return load(env, made.id);
}

async function openPickup(env, id) {
  const p = await first(env.DB, 'SELECT * FROM np_pickup WHERE id = ?1', Number(id));
  if (!p) throw notFound('No such pickup.');
  if (p.status !== 'open') throw new HttpError(409, 'That pickup is recorded already.');
  return p;
}

/** Something paid out of the money, with its receipt: read and made a draft PO with the pickup's reference. */
export async function addExpense(env, body, account, { fetchImpl } = {}) {
  await may(env, account, 2);
  const p = await openPickup(env, body?.pickupId);
  const what = str(body?.what, 'What it was', { required: true, max: 200 });
  const amount = cedis(body?.amount, 'The amount');
  if (!amount) throw badRequest('The amount: more than nothing.');
  const supplier = str(body?.supplier, 'From whom', { max: 120 }) || null;
  const file = String(body?.file || '');
  const m = file.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !TYPES.test(m[1])) throw badRequest('A picture of the receipt.');
  if (m[2].length > FILE_MAX) throw badRequest('That file is too large: a photo, or a PDF under 7 MB.');
  // The next number is taken before reading, so two sent at once never share one.
  const taken = await first(env.DB, 'UPDATE np_pickup SET next_seq = next_seq + 1 WHERE id = ?1 RETURNING next_seq - 1 AS seq', p.id);
  const ref = refOf(p.id, taken.seq);
  const thumb = String(body?.thumb || '');
  const receipt = await addReceipt(env, {
    mime: m[1], data: m[2], name: body?.name, came: 'pickup', byName: who(account),
    thumb: /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(thumb) && thumb.length < 60_000 ? thumb : null,
    hint: [what, supplier ? `from ${supplier}` : null, `GH₵ ${(amount / 100).toFixed(2)}`].filter(Boolean).join(', '),
  }, { fetchImpl, mark: pickupMarkFor({ ref, day: p.day, by: p.by_name }) });
  await run(env.DB, 'INSERT INTO np_pickup_expense (pickup_id, what, amount, supplier, ref, receipt_id, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    p.id, what, amount, supplier, ref, receipt.id ?? null, who(account), now());
  await run(env.DB, 'UPDATE np_pickup SET spent = (SELECT COALESCE(SUM(amount), 0) FROM np_pickup_expense WHERE pickup_id = ?1) WHERE id = ?1', p.id);
  return load(env, p.id);
}

/** Take one off before the pickup is recorded. Its draft PO stays in Odoo, to cancel there. */
export async function removeExpense(env, body, account) {
  await may(env, account, 2);
  const e = await first(env.DB, 'SELECT * FROM np_pickup_expense WHERE id = ?1', Number(body?.id));
  if (!e) throw notFound('No such expense.');
  await openPickup(env, e.pickup_id);
  await run(env.DB, 'DELETE FROM np_pickup_expense WHERE id = ?1', e.id);
  await run(env.DB, 'UPDATE np_pickup SET spent = (SELECT COALESCE(SUM(amount), 0) FROM np_pickup_expense WHERE pickup_id = ?1) WHERE id = ?1', e.pickup_id);
  return load(env, e.pickup_id);
}

/** The shifts taken, the cash counted: recorded, for an admin to review, and into the safe. */
export async function recordPickup(env, body, account) {
  await may(env, account, 2);
  const p = await openPickup(env, body?.pickupId);
  const keys = [...new Set((Array.isArray(body?.shifts) ? body.shifts : []).map(String))];
  if (!keys.length) throw badRequest('Tick the shifts whose envelopes you took.');
  const { shifts } = await inSafe(env, todayIn('UTC'));
  const byKey = new Map(shifts.map((s) => [s.key, s]));
  const chosen = keys.map((k) => byKey.get(k));
  if (chosen.some((s) => !s)) throw new HttpError(409, 'One of those shifts is picked up already, or has no money sent. Reload and tick again.');
  const counted = cedis(body?.counted, 'What you counted');
  const sales = chosen.reduce((t, s) => t + s.amount, 0);
  const net = sales - p.spent;
  const note = str(body?.note, 'Why it is different', { max: 400 }) || null;
  if (counted !== net && !note) throw badRequest(`You counted GH₵ ${(counted / 100).toFixed(2)}, and the net cash is GH₵ ${(net / 100).toFixed(2)}. Say why they are not the same.`);
  chosen.sort((a, b) => order(a.day, a.shift).localeCompare(order(b.day, b.shift)));
  await env.DB.batch([
    ...chosen.map((s) => env.DB.prepare('INSERT INTO np_pickup_shift (day, shift, pickup_id, amount) VALUES (?1, ?2, ?3, ?4)').bind(s.day, s.shift, p.id, s.amount)),
    env.DB.prepare("UPDATE np_pickup SET status = 'review', sales = ?2, counted = ?3, note = ?4, recorded_at = ?5, day = ?6 WHERE id = ?1")
      .bind(p.id, sales, counted, note, now(), todayIn('UTC')),
  ]);
  return load(env, p.id);
}

/** Admin: approve a pickup, or ask its supervisor about it. */
export async function reviewPickup(env, body, account) {
  await requireAdmin(account);
  const p = await first(env.DB, 'SELECT * FROM np_pickup WHERE id = ?1', Number(body?.id));
  if (!p) throw notFound('No such pickup.');
  if (p.status === 'open') throw badRequest('That pickup is not recorded yet.');
  const decision = String(body?.decision || '');
  if (!['approve', 'ask'].includes(decision)) throw badRequest('Approve, or ask.');
  const note = str(body?.note, 'What to ask', { max: 400, required: decision === 'ask' }) || null;
  await run(env.DB, 'UPDATE np_pickup SET status = ?2, reviewed_by = ?3, reviewed_at = ?4, review_note = ?5 WHERE id = ?1',
    p.id, decision === 'approve' ? 'approved' : 'asked', who(account), now(), note);
  return load(env, p.id);
}

/** Pickups whose cash is in the safe and not yet in a count of it: the safe book's ins. */
export async function safeIns(env) {
  const rows = await all(env.DB, "SELECT * FROM np_pickup WHERE status != 'open' AND counted > 0 AND closure_id IS NULL ORDER BY day, id").catch(() => []);
  return rows.map((p) => ({ id: p.id, day: p.day, amount: p.counted, by: p.by_name, status: p.status }));
}

/** The pickups a count of the safe takes in. */
export async function closeInto(env, ids, closureId) {
  for (const id of ids) await run(env.DB, 'UPDATE np_pickup SET closure_id = ?2 WHERE id = ?1', id, closureId); // eslint-disable-line no-await-in-loop
}
