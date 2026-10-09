import { all, first, run, writeAll } from '../lib/db.js';
import { badRequest, HttpError, str } from '../lib/http.js';
import { addDays, isDay, resolveRange, daysBetween } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { parseJournal, journalWindow, mergeEntry, segment, DRAWER } from '../shifts/assd.js';
import { parseStatement } from '../shifts/bank.js';
import { parseTerminalCsv } from '../shifts/terminal.js';
import { reconcile, settlement, GROUPS, SLOTS } from '../shifts/reconcile.js';
import { listSources, secretNameFor } from '../connectors/index.js';
import { purchaseOrders } from '../connectors/odoo.js';

/**
 * The Shifts screen's server side.
 *
 * Uploading is an owner's job; typing a count, an expense or an answer is
 * anybody's who can read the numbers, and every one of those is signed with
 * the name of whoever typed it.
 */

const MARKER = 'Beginn of Day Processing';
const MAX_DAYS = 62;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';

// ---------------------------------------------------------------- uploads --

/** ASSD's detail journal, as the lines the browser read out of the PDF. */
export async function uploadJournal(env, body, account) {
  const lines = Array.isArray(body?.lines) ? body.lines.map((l) => String(l ?? '')) : null;
  if (!lines?.length) throw badRequest('No lines came with the journal. Choose the PDF again.');
  if (lines.length > 200000) throw badRequest('That journal is too long for one upload. Export a month at a time.');

  const window = journalWindow(lines);
  const entries = parseJournal(lines);
  if (!entries.length) {
    throw badRequest('Nothing in that file reads as an ASSD detail journal. It should be "Detail Journal of every Transaction", printed to PDF.');
  }
  const markers = entries.filter((e) => e.kind === MARKER);

  const lo = entries[0].seq;
  const hi = entries[entries.length - 1].seq;
  const stored = new Map();
  for (const row of await all(env.DB, 'SELECT seq, data FROM assd_entry WHERE seq BETWEEN ?1 AND ?2', lo, hi)) {
    try { stored.set(row.seq, JSON.parse(row.data)); } catch { /* replaced below */ }
  }

  const at = now();
  await upsertMany(env.DB, 'assd_entry', ['seq', 'kind', 'staff', 'day', 'register', 'data', 'loaded_at'], 'seq',
    entries.map((e) => {
      const merged = mergeEntry(stored.get(e.seq), e, window);
      const data = JSON.stringify({
        payments: merged.payments,
        laundry: merged.laundry,
        items: merged.items || [],
        stock: merged.stock || null,
        expensesCounted: merged.expensesCounted,
        counted: merged.counted,
        movement: merged.movement,
        booked: merged.booked,
      });
      return [e.seq, e.kind, e.user, e.date, e.register, data, at];
    }));

  const note = `${entries.length} transactions, ${markers.length} hand-overs`
    + (window ? '' : '. No benefit-date header was found, so this file replaced what was there for these transactions.');
  await logUpload(env, 'journal', body?.name, window?.from ?? entries[0].date, window?.to ?? entries[entries.length - 1].date, entries.length, note, account);
  return { ok: true, kind: 'journal', window, entries: entries.length, handovers: markers.length, note };
}

/** The bank statement, as rows under its own header. */
export async function uploadBank(env, body, account) {
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows?.length) throw badRequest('No rows came with the statement. Choose the file again.');
  const parsed = parseStatement(rows);
  if (parsed.error) throw badRequest(parsed.error);

  const at = now();
  await upsertMany(env.DB, 'bank_card_txn',
    ['id', 'kind', 'day', 'at', 'at_exact', 'posted_at', 'amount', 'card_day', 'first6', 'last4', 'approval', 'terminal', 'reference', 'loaded_at'], 'id',
    parsed.rows.map((r) => [r.id, r.kind, r.day, r.at, r.atExact ? 1 : 0, r.postedAt, r.amount, r.cardDay, r.first6, r.last4,
      r.approval, r.terminal, r.reference, at]));

  const days = parsed.rows.map((r) => r.day).sort();
  const kinds = {};
  for (const r of parsed.rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  const note = `${kinds.card || 0} card credits, ${kinds.momo || 0} MoMo, ${kinds['card-reversal'] || 0} reversals, `
    + `${kinds.commission || 0} commission rows.`
    + (parsed.counts.flagged
      ? ` ${parsed.counts.flagged} rows the bank itself marked deleted or unposted were ignored (${(parsed.flaggedAmount / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}).`
      : '')
    + ` ${parsed.counts.other + (Number(body?.leftOut) || 0)} other rows (salaries, suppliers, transfers) were not kept.`;
  await logUpload(env, 'bank', body?.name, days[0] ?? null, days[days.length - 1] ?? null, parsed.rows.length, note, account);
  return { ok: true, kind: 'bank', rows: parsed.rows.length, from: days[0] ?? null, to: days[days.length - 1] ?? null, note };
}

/** The card terminal report, as the CSV text the portal exports. */
export async function uploadTerminal(env, body, account) {
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) throw badRequest('The terminal report was empty. Choose the CSV again.');
  const parsed = parseTerminalCsv(text);
  if (parsed.error) throw badRequest(parsed.error);
  if (!parsed.rows.length) throw badRequest('No transactions could be read from that file.');

  const at = now();
  await upsertMany(env.DB, 'terminal_txn',
    ['rrn', 'at', 'day', 'terminal', 'type', 'kind', 'amount', 'first6', 'last4', 'stan', 'code', 'status', 'approval', 'approved', 'loaded_at'], 'rrn',
    parsed.rows.map((r) => [r.rrn, r.at, r.day, r.terminal, r.type, r.kind, r.amount, r.first6, r.last4, r.stan, r.code, r.status,
      r.approval, r.approved ? 1 : 0, at]));

  const days = parsed.rows.map((r) => r.day).sort();
  const approved = parsed.rows.filter((r) => r.approved).length;
  const note = `${approved} approved, ${parsed.rows.length - approved} declined or incomplete`
    + (parsed.skipped ? `, ${parsed.skipped} unreadable rows skipped` : '');
  await logUpload(env, 'terminal', body?.name, days[0], days[days.length - 1], parsed.rows.length, note, account);
  return { ok: true, kind: 'terminal', rows: parsed.rows.length, from: days[0], to: days[days.length - 1], note };
}

/**
 * Insert or replace many rows, several to a statement.
 *
 * D1 allows 100 bound values per statement; a year's bank statement is some
 * six thousand rows. One row per statement would be six thousand statements
 * and a hundred round trips; this packs as many rows into each as the limit
 * allows and sends them in batches.
 */
async function upsertMany(db, tableName, columns, key, rows) {
  if (!rows.length) return;
  const per = Math.max(1, Math.floor(100 / columns.length));
  const update = columns.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ');
  const statements = [];
  for (let i = 0; i < rows.length; i += per) {
    const slice = rows.slice(i, i + per);
    const values = slice.map((_, r) => `(${columns.map((__, c) => `?${r * columns.length + c + 1}`).join(', ')})`).join(', ');
    statements.push(db.prepare(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${values}
      ON CONFLICT (${key}) DO UPDATE SET ${update}`).bind(...slice.flat()));
  }
  await writeAll(db, statements);
}

async function logUpload(env, kind, name, from, to, rows, note, account) {
  await run(env.DB, `INSERT INTO shift_upload (kind, name, from_day, to_day, rows, note, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  kind, str(name, 'File name', { max: 200 }), from, to, rows, note, who(account), now());
}

// ------------------------------------------------------------ typed input --

const slotOf = (value) => {
  const slot = String(value || '');
  if (!SLOTS.includes(slot)) throw badRequest('Which shift? morning, afternoon or night.');
  return slot;
};
const dayOf = (value) => {
  if (!isDay(value)) throw badRequest('A day is needed, as YYYY-MM-DD.');
  return value;
};
/** A typed amount in cedis → pesewas, or null for an empty box. */
function cedis(value, field) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10000000) throw badRequest(`${field} must be an amount in cedis.`);
  return toMinor(n);
}

export async function saveCount(env, body, account) {
  const day = dayOf(body?.day);
  const slot = slotOf(body?.slot);
  const opening = cedis(body?.opening, 'Opening');
  const closing = cedis(body?.closing, 'Counted closing');
  const note = str(body?.note, 'Note', { max: 400 });
  await run(env.DB, `INSERT INTO shift_count (day, slot, opening, closing, note, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (day, slot) DO UPDATE SET opening = ?3, closing = ?4, note = ?5, by_name = ?6, at = ?7`,
  day, slot, opening, closing, note, who(account), now());
  return { ok: true };
}

export async function saveExpense(env, body, account) {
  const day = dayOf(body?.day);
  const slot = slotOf(body?.slot);
  const sheetTotal = cedis(body?.sheetTotal, 'Expense-sheet total');
  const poNumbers = poList(body?.poNumbers).join(', ') || null;
  await run(env.DB, `INSERT INTO shift_expense (day, slot, sheet_total, po_numbers, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (day, slot) DO UPDATE SET sheet_total = ?3, po_numbers = ?4, by_name = ?5, at = ?6`,
  day, slot, sheetTotal, poNumbers, who(account), now());
  if (poNumbers && body?.pull) return pullOrders(env, { day, slot });
  return { ok: true };
}

/** PO numbers typed any old way: `P00412, P00413 p417`. */
export function poList(value) {
  return [...new Set(String(value || '').toUpperCase().split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))].slice(0, 40);
}

export async function pullOrders(env, body) {
  const day = dayOf(body?.day);
  const slot = slotOf(body?.slot);
  const row = await first(env.DB, 'SELECT po_numbers FROM shift_expense WHERE day = ?1 AND slot = ?2', day, slot);
  const names = poList(row?.po_numbers);
  if (!names.length) throw badRequest('Type the PO numbers first.');

  const sources = (await listSources(env.DB)).filter((s) => s.kind === 'odoo_json2' && s.config?.base);
  const source = sources.find((s) => s.enabled) || sources[0];
  if (!source) throw new HttpError(409, 'Odoo is not set up yet. Setup → Odoo (books) first.');
  const secret = secretNameFor(source);
  const result = await purchaseOrders({ config: source.config, token: secret ? env[secret] : null, names });
  await run(env.DB, 'UPDATE shift_expense SET odoo = ?3, pulled_at = ?4 WHERE day = ?1 AND slot = ?2',
    day, slot, JSON.stringify(result), now());
  return { ok: true, ...result };
}

/**
 * The corrections people have made to Cash Movements in a run of the journal,
 * as `summarise` wants them: a movement that is left out is listed under both
 * of a reversed pair's numbers.
 */
async function correctionsFor(env, lo, hi) {
  let rows = [];
  try {
    // Only what counts: a supervisor's correction waits for an admin's yes.
    rows = await all(env.DB, `SELECT * FROM shift_movement WHERE ((seq BETWEEN ?1 AND ?2) OR (pair BETWEEN ?1 AND ?2))
      AND COALESCE(status, 'applied') = 'applied'`, lo, hi);
  } catch (err) {
    if (!/no such table/i.test(String(err?.message))) throw err;
  }
  const out = new Map();
  for (const r of rows) {
    const who = { note: r.note, by: r.by_name, at: r.at };
    if (r.kind === 'duplicate') out.set(r.seq, { kind: 'excluded', reason: 'duplicate', pair: r.pair, ...who });
    else if (r.kind === 'reverses') {
      out.set(r.seq, { kind: 'excluded', reason: 'reverses', pair: r.pair, ...who });
      out.set(r.pair, { kind: 'excluded', reason: 'reversed-by', pair: r.seq, ...who });
    } else out.set(r.seq, { kind: r.kind, expenses: r.expenses, ...who });
  }
  return out;
}

/** A Cash Movement on the front drawer, with the amount it took out (negative: put back). */
async function drawerMovement(env, seq) {
  const row = await first(env.DB, 'SELECT seq, kind, register, data FROM assd_entry WHERE seq = ?1', seq);
  if (!row || row.kind !== 'Cash Movement' || row.register !== DRAWER) return null;
  let data = {};
  try { data = JSON.parse(row.data); } catch { data = {}; }
  return { seq: row.seq, amount: -(data.movement || 0) };
}

/**
 * Correct what a Cash Movement was.
 *
 * `kind` is one of: `expenses`, `safe`, `split` (with `expenses`, the part
 * that was expenses), `duplicate` (with `pair`, the movement it repeats),
 * `reverses` (with `pair`, the movement it puts back, which may be on
 * another shift), or `clear` to undo whatever was said about this movement.
 */
export async function saveMovement(env, body, account, { pending = false } = {}) {
  const seq = Number(body?.seq);
  if (!Number.isInteger(seq)) throw badRequest('Which movement? Its ASSD number is needed.');
  const kind = String(body?.kind || '');
  const note = str(body?.note, 'Note', { max: 400 });

  // A supervisor proposes; an admin decides. What has already been decided is
  // the admin's to change, and a supervisor may only take back their own.
  const existing = await first(env.DB, "SELECT * FROM shift_movement WHERE (seq = ?1 OR (kind = 'reverses' AND pair = ?1)) AND COALESCE(status, 'applied') <> 'rejected'", seq);
  if (pending && existing && (existing.status || 'applied') === 'applied') {
    throw badRequest('That movement has already been corrected. Ask an admin to change it.');
  }
  if (kind === 'clear') {
    if (pending && existing && existing.by_name !== who(account)) throw badRequest('Only the person who proposed it, or an admin, can take it back.');
    await run(env.DB, "DELETE FROM shift_movement WHERE seq = ?1 OR (kind = 'reverses' AND pair = ?1)", seq);
    return { ok: true };
  }
  if (!['expenses', 'safe', 'split', 'duplicate', 'reverses'].includes(kind)) {
    throw badRequest('Say what the movement was: expenses, safe, split, duplicate or reverses.');
  }
  const move = await drawerMovement(env, seq);
  if (!move) throw badRequest(`ASSD ${seq} is not a Cash Movement out of the front drawer.`);

  let expenses = null;
  let pair = null;
  let rowSeq = seq;
  if (kind === 'expenses' || kind === 'safe' || kind === 'split') {
    if (move.amount <= 0) throw badRequest('That movement put money back into the drawer; only one taken out can be expenses or the safe.');
    if (kind === 'split') {
      expenses = cedis(body?.expenses, 'The expenses part');
      if (expenses == null || expenses <= 0 || expenses >= move.amount) {
        throw badRequest('The expenses part must be more than nothing and less than the whole movement.');
      }
    }
  } else {
    const other = await drawerMovement(env, Number(body?.pair));
    if (!other || other.seq === seq) throw badRequest('Choose the other movement it goes with.');
    if (kind === 'duplicate') {
      if (move.amount <= 0 || other.amount !== move.amount) throw badRequest('A duplicate has to be the same amount taken out.');
      pair = other.seq;
    } else {
      if (other.amount !== -move.amount) throw badRequest('A reversal has to be the same amount the other way.');
      // Stored on the movement that put money back, pointing at the one it undoes.
      rowSeq = move.amount < 0 ? seq : other.seq;
      pair = move.amount < 0 ? other.seq : seq;
    }
    const taken = await first(env.DB, `SELECT seq FROM shift_movement
      WHERE kind IN ('duplicate', 'reverses') AND seq <> ?1 AND (seq IN (?2, ?3) OR pair IN (?2, ?3))
        AND COALESCE(status, 'applied') <> 'rejected'`, rowSeq, rowSeq, pair);
    if (taken) throw badRequest(`One of those movements is already matched (ASSD ${taken.seq}). Undo that first.`);
  }

  const status = pending ? 'pending' : 'applied';
  await run(env.DB, `INSERT INTO shift_movement (seq, kind, expenses, pair, note, by_name, at, status, decided_by, decided_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL)
    ON CONFLICT (seq) DO UPDATE SET kind = ?2, expenses = ?3, pair = ?4, note = ?5, by_name = ?6, at = ?7, status = ?8,
      decided_by = NULL, decided_at = NULL`,
  rowSeq, kind, expenses, pair, note, who(account), now(), status);
  return { ok: true, pending, seq: rowSeq, kind };
}

/**
 * Reconcile two or more exceptions together: one story that showed up as
 * several differences. Each of them counts as answered while the group stands.
 */
export async function saveLink(env, body, account, { pending = false } = {}) {
  const keys = [...new Set((Array.isArray(body?.keys) ? body.keys : []).map((k) => String(k ?? '').trim()).filter(Boolean))];
  if (keys.length < 2) throw badRequest('Choose at least two exceptions to reconcile together.');
  if (keys.length > 30) throw badRequest('Thirty at most in one reconciliation.');
  if (keys.some((k) => k.length > 200)) throw badRequest('That is not an exception.');
  const note = str(body?.note, 'Note', { max: 600 });
  for (const row of await all(env.DB, "SELECT id, keys FROM shift_link WHERE COALESCE(status, 'applied') <> 'rejected'")) {
    let taken = [];
    try { taken = JSON.parse(row.keys); } catch { taken = []; }
    if (keys.some((k) => taken.includes(k))) throw badRequest('One of those is already reconciled with others. Undo that first.');
  }
  // A supervisor's reconciliation waits for an admin before it clears anything.
  await run(env.DB, 'INSERT INTO shift_link (keys, note, by_name, at, status) VALUES (?1, ?2, ?3, ?4, ?5)',
    JSON.stringify(keys), note, who(account), now(), pending ? 'pending' : 'applied');
  return { ok: true, pending };
}

/** Undo a reconciliation: each exception in it is open again. A supervisor may only take back their own, still waiting. */
export async function removeLink(env, body, account, { pending = false } = {}) {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) throw badRequest('Which reconciliation?');
  if (pending) {
    const row = await first(env.DB, 'SELECT * FROM shift_link WHERE id = ?1', id);
    if (!row || row.status !== 'pending' || row.by_name !== who(account)) throw badRequest('Only an admin can undo that.');
  }
  await run(env.DB, 'DELETE FROM shift_link WHERE id = ?1', id);
  return { ok: true };
}

export async function saveAnswer(env, body, account, { pending = false } = {}) {
  const key = str(body?.key, 'Exception', { required: true, max: 200 });
  const answer = str(body?.answer, 'Answer', { max: 60 });
  const note = str(body?.note, 'Note', { max: 600 });
  const existing = await first(env.DB, 'SELECT * FROM shift_answer WHERE key = ?1', key);
  // What an admin settled is the admin's to change; a supervisor may change
  // or take back only their own answer, while it is still waiting.
  if (pending && existing && ((existing.status || 'applied') === 'applied' || existing.by_name !== who(account))) {
    throw badRequest('That has already been answered. Ask an admin to change it.');
  }
  if (!answer) {
    await run(env.DB, 'DELETE FROM shift_answer WHERE key = ?1', key);
    return { ok: true };
  }
  const status = pending ? 'pending' : 'applied';
  await run(env.DB, `INSERT INTO shift_answer (key, answer, note, by_name, at, status, decided_by, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)
    ON CONFLICT (key) DO UPDATE SET answer = ?2, note = ?3, by_name = ?4, at = ?5, status = ?6, decided_by = NULL, decided_at = NULL`,
  key, answer, note, who(account), now(), status);
  return { ok: true, pending };
}

// ------------------------------------------------------------------ read --

/**
 * Everything the Shifts screen shows for a window of days.
 */
export async function shifts(env, query, account) {
  let { from, to } = resolveRange(query, 'UTC', { days: 7 });
  if (daysBetween(from, to).length > MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  const canUpload = Boolean(account?.isOwner || account?.bootstrap);

  // Everything that depends only on the days asked for, read at once. Each
  // query is a round trip to D1, and fourteen of them one after another was
  // most of the wait when switching between Day, Week and Month.
  const lo3 = addDays(from, -3);
  const hi3 = addDays(to, 3);
  const optional = (promise) => promise.catch(() => []);
  const [uploads, markers, lastMarker, terminal, bank, counts, expenses, answers, links, laundrySystem, laundryTxns, laundryThrough] = await Promise.all([
    all(env.DB, 'SELECT kind, name, from_day, to_day, rows, note, by_name, at FROM shift_upload ORDER BY id DESC LIMIT 40'),
    all(env.DB, `SELECT seq, day FROM assd_entry WHERE kind = ?1 AND day BETWEEN ?2 AND ?3 ORDER BY seq`, MARKER, addDays(from, -2), addDays(to, 2)),
    first(env.DB, 'SELECT MAX(seq) AS seq FROM assd_entry WHERE kind = ?1', MARKER),
    all(env.DB, 'SELECT * FROM terminal_txn WHERE day BETWEEN ?1 AND ?2', lo3, hi3),
    all(env.DB, `SELECT * FROM bank_card_txn WHERE (day BETWEEN ?1 AND ?2) OR (card_day BETWEEN ?1 AND ?2)`, lo3, addDays(to, 10)),
    all(env.DB, 'SELECT * FROM shift_count WHERE day BETWEEN ?1 AND ?2', addDays(from, -3), to),
    all(env.DB, 'SELECT * FROM shift_expense WHERE day BETWEEN ?1 AND ?2', from, to),
    all(env.DB, 'SELECT * FROM shift_answer'),
    optional(all(env.DB, 'SELECT * FROM shift_link ORDER BY id')),
    optional(all(env.DB, `SELECT day, SUM(net) AS net, SUM(cash) AS cash FROM fact_revenue
      WHERE line_id = 'laundry' AND day BETWEEN ?1 AND ?2 GROUP BY day`, from, to)),
    optional(all(env.DB, 'SELECT kind, ref, at, amount, method FROM laundry_txn WHERE day BETWEEN ?1 AND ?2', lo3, hi3)),
    // How far the laundry system has been read: a shift after that has
    // nothing to be compared with yet, which is not the same as nothing sold.
    first(env.DB, `SELECT MAX(r.to_day) AS day FROM etl_run r
      JOIN etl_source_run x ON x.run_id = r.id JOIN sources s ON s.id = x.source_id
      WHERE s.kind = 'snlaundry_http' AND x.status = 'ok'`).catch(() => null),
  ]);
  const coverage = coverageOf(uploads);
  const base = { range: { from, to }, canUpload, uploads: uploads.slice(0, 12).map(uploadView), coverage, groups: GROUPS };

  // The journal around the window: from the hand-over two days before it to
  // the first hand-over more than two days after it.
  if (!markers.length) return { ...base, days: [], exceptions: [], people: [], totals: null, empty: 'journal' };
  const lo = markers[0].seq;
  const after = await first(env.DB, 'SELECT MIN(seq) AS seq FROM assd_entry WHERE kind = ?1 AND seq > ?2 AND day > ?3',
    MARKER, markers[markers.length - 1].seq, addDays(to, 2));
  const hi = after?.seq ? after.seq - 1 : Number.MAX_SAFE_INTEGER;
  // The journal itself, what people corrected in it, and what a supervisor
  // proposed and an admin has not yet decided: at once again.
  const [rows, corrections, pendingRows] = await Promise.all([
    all(env.DB, 'SELECT seq, kind, staff, day, register, data FROM assd_entry WHERE seq BETWEEN ?1 AND ?2 ORDER BY seq', lo, hi),
    correctionsFor(env, lo, hi),
    optional(all(env.DB, `SELECT * FROM shift_movement WHERE status = 'pending' AND ((seq BETWEEN ?1 AND ?2) OR (pair BETWEEN ?1 AND ?2))`, lo, hi)),
  ]);
  const entries = rows.map(entryOf);
  // The journal ends inside its last shift unless a later hand-over exists.
  const open = !after?.seq && lastMarker?.seq === markers[markers.length - 1].seq;

  const { shifts: raw } = segment(entries, corrections);
  const proposed = new Map(pendingRows.map((r) => [r.seq, { kind: r.kind, expenses: r.expenses, pair: r.pair, note: r.note, by: r.by_name, at: r.at }]));

  const events = [
    ...terminal.filter((t) => t.approved && t.kind === 'card').map((t) => ({
      id: `t:${t.rrn}`, kind: 'card', amount: t.amount, at: t.at, last4: t.last4, first6: t.first6, approval: t.approval, source: 'terminal',
    })),
    ...bank.filter((b) => b.kind === 'momo' && b.at).map((b) => ({
      id: `b:${b.id}`, kind: 'momo', amount: b.amount, at: b.at, exact: b.at_exact === 1, source: 'bank',
    })),
    // Card credits for days the terminal report does not cover, and MoMo
    // received in a batch with no time on it: by day only.
    ...bank.filter((b) => b.kind === 'card' && !coverage.terminalDays.has(b.card_day || b.day)).map((b) => ({
      id: `b:${b.id}`, kind: 'card', amount: b.amount, day: b.card_day || b.day, last4: b.last4, approval: b.approval, source: 'bank',
    })),
    ...bank.filter((b) => b.kind === 'momo' && !b.at).map((b) => ({
      id: `b:${b.id}`, kind: 'momo', amount: b.amount, day: b.day, source: 'bank',
    })),
  ];
  const declines = terminal.filter((t) => !t.approved).map((t) => ({
    id: `t:${t.rrn}`, kind: t.kind, amount: t.amount, at: t.at, last4: t.last4, status: t.status,
  }));

  const result = reconcile(raw, events, declines, { open });
  const inRange = (day) => day >= from && day <= to;
  const placed = result.shifts.filter((s) => inRange(s.day));

  const approvedInRange = terminal.filter((t) => t.approved && t.kind === 'card' && inRange(t.day))
    .map((t) => ({ rrn: t.rrn, at: t.at, amount: t.amount, last4: t.last4, approval: t.approval }));
  const bankCards = bank.filter((b) => b.kind === 'card' || b.kind === 'card-reversal').map((b) => ({
    id: b.id, kind: b.kind, day: b.day, cardDay: b.card_day, amount: b.amount, last4: b.last4, approval: b.approval,
  }));
  const settled = settlement(approvedInRange, bankCards, { terminal: coverage.terminalDays, bankTo: coverage.bankTo });

  // A card reversal that answers a refund keyed in ASSD is a refund, not a loss.
  const exceptions = [...result.exceptions.filter((x) => !x.day || inRange(x.day)),
    ...settled.exceptions.filter((x) => inRange(x.day))];
  for (const rev of exceptions.filter((x) => x.kind === 'reversal')) {
    const refund = exceptions.find((x) => x.kind === 'refund' && x.amount === rev.amount && !x.pairedWith);
    if (refund) { refund.pairedWith = rev.key; rev.pairedWith = refund.key; rev.severity = 'info'; }
  }

  // The laundry, shift by shift: what the laundry system took in each shift's
  // hours against the laundry line ASSD has in that shift. ASSD records the
  // laundry when the guest pays at the desk, so it is held against the
  // laundry's payments; what the laundry accepted in the same hours is shown
  // beside it.
  const laundryIn = new Map();
  const minuteAt = (at) => Math.floor(Date.parse(`${String(at).replace(' ', 'T')}Z`) / 60000);
  for (const t of laundryTxns) {
    const minute = minuteAt(t.at);
    const home = result.shifts.find((x) => minute >= x.window.start && minute < x.window.end);
    if (!home) continue;
    const l = laundryIn.get(home.index) || { collected: 0, cash: 0, card: 0, charged: 0, payments: 0, orders: 0 };
    if (t.kind === 'payment') {
      l.collected += t.amount;
      l[t.method === 'card' ? 'card' : 'cash'] += t.amount;
      l.payments += 1;
    } else {
      l.charged += t.amount;
      l.orders += 1;
    }
    laundryIn.set(home.index, l);
  }
  const laundryRead = laundryThrough?.day || null;
  // A night shift runs into the next morning, so it is covered only once that
  // morning has been read too.
  const laundryCovers = (s) => Boolean(laundryRead) && !s.open
    && (s.slotName === 'night' ? addDays(s.day, 1) <= laundryRead : s.day <= laundryRead);
  const laundryOfShift = (s) => (laundryCovers(s)
    ? { collected: 0, cash: 0, card: 0, charged: 0, payments: 0, orders: 0, ...laundryIn.get(s.index) }
    : null);
  for (const s of result.shifts.filter((x) => inRange(x.day))) {
    const l = laundryOfShift(s);
    if (!l || l.collected === s.laundry) continue;
    exceptions.push({
      day: s.day, slot: s.slotName, user: s.user, event: null,
      key: `laundry:${s.day}:${s.slotName}`, kind: 'laundry-mismatch', group: 'laundry', severity: 'warning',
      amount: s.laundry - l.collected, assd: s.laundry, system: l.collected, charged: l.charged, payments: l.payments,
    });
  }

  // What people typed.
  const answerOf = new Map(answers.map((a) => [a.key, {
    answer: a.answer, note: a.note, by: a.by_name, at: a.at, status: a.status || 'applied', approvedBy: a.decided_by || null,
  }]));

  const countOf = new Map(counts.map((c) => [`${c.day}|${c.slot}`, c]));
  const expenseOf = new Map(expenses.map((e) => [`${e.day}|${e.slot}`, e]));

  // The register, in slot order. ASSD counts the drawer at every hand-over:
  // a shift's first Money Count is its opening and its last is its closing.
  // A count typed here is a recount, and when there is one it is used instead.
  const ordered = [...result.shifts].sort((a, b) => a.slot - b.slot);
  const register = new Map();
  let previousClosing = null;
  for (const s of ordered) {
    const typed = countOf.get(`${s.day}|${s.slotName}`);
    const expense = expenseOf.get(`${s.day}|${s.slotName}`);
    const assdOpening = s.opening?.total ?? null;
    const opening = typed?.opening ?? assdOpening ?? previousClosing?.amount ?? null;
    const openingFrom = typed?.opening != null ? 'typed' : assdOpening != null ? 'assd' : previousClosing ? 'carried' : null;
    const out = s.drawerOut;
    const expected = opening == null ? null : opening + s.cash - out;
    const closing = typed?.closing ?? s.closing?.total ?? null;
    const closingFrom = typed?.closing != null ? 'typed' : s.closing ? 'assd' : null;
    // Expenses: what each movement was, as the count before it labelled it
    // or as a person corrected it. The expense sheet's total only settles
    // what nothing labelled: the part of it not yet accounted for is
    // expenses, the rest went to the safe. Where the sheet and the labelled
    // movements disagree, the gap is shown rather than written over.
    const sheet = expense?.sheet_total ?? null;
    const fromSheet = sheet != null ? Math.min(s.unlabelledMoved, Math.max(0, sheet - s.expensesMoved)) : 0;
    const expenses = s.expensesMoved + fromSheet;
    const toSafe = s.safeMoved + (sheet != null ? s.unlabelledMoved - fromSheet : 0);
    const unlabelled = sheet != null ? 0 : s.unlabelledMoved;
    register.set(s.index, {
      opening, openingFrom, cashIn: s.cash, laundryCash: s.laundryCash, out,
      expenses, toSafe, unlabelled, expensesFrom: fromSheet ? 'sheet' : 'assd',
      sheetGap: sheet != null && sheet !== expenses ? sheet - expenses : null,
      corrected: s.corrected,
      expected, closing, closingFrom,
      receiptsAtClose: closingFrom === 'assd' ? s.closing.receipts : null,
      variance: expected != null && closing != null ? closing - expected : null,
      // What ASSD itself booked at the close; it differs from the variance
      // only once somebody has corrected a movement on this shift.
      assdVariance: s.booked.filter((b) => b.when === 'close').reduce((t, b) => t + b.amount, 0),
      // The incoming person's first count against the outgoing person's last.
      handoverGap: previousClosing && assdOpening != null && previousClosing.amount !== assdOpening
        ? { amount: assdOpening - previousClosing.amount, from: previousClosing.user } : null,
      note: typed?.note || null, countedBy: typed?.by_name || null, countedAt: typed?.at || null,
    });
    previousClosing = closing != null ? { amount: closing, user: s.user } : null;
  }

  // The drawer's own exceptions: a count that did not agree, a hand-over
  // where the next count differed from the last, and a movement keyed wrong
  // and put back.
  for (const s of ordered.filter((x) => inRange(x.day))) {
    const r = register.get(s.index);
    const base = { day: s.day, slot: s.slotName, user: s.user, event: null };
    if (r.variance) {
      exceptions.push({
        ...base, key: `drawer:${s.day}:${s.slotName}`, kind: r.variance < 0 ? 'drawer-short' : 'drawer-over',
        group: 'drawer', severity: r.variance < 0 ? 'critical' : 'warning', amount: r.variance,
        expected: r.expected, closing: r.closing, closingFrom: r.closingFrom,
      });
    }
    if (r.handoverGap) {
      exceptions.push({
        ...base, key: `handover:${s.day}:${s.slotName}`, kind: 'handover-gap', group: 'drawer', severity: 'warning',
        amount: r.handoverGap.amount, from: r.handoverGap.from,
      });
    }
    // Cash that left the drawer with nothing to say where it went: no count
    // labelled it and no expense sheet settled it. Each one is listed, and
    // labelling it (safe or expenses) takes it off.
    if (r.unlabelled > 0) {
      for (const m of s.moves.filter((x) => x.kind === 'unlabelled' || x.kind === 'part')) {
        const amount = m.kind === 'part' ? m.amount - m.expenses : m.amount;
        if (amount <= 0) continue;
        exceptions.push({
          ...base, key: `unlabelled:${m.seq}`, kind: 'movement-unlabelled', group: 'unlabelled', severity: 'warning',
          seq: m.seq, amount, whole: m.amount, part: m.kind === 'part', labels: true, pending: proposed.get(m.seq) || null,
        });
      }
    }
    for (const m of s.moves.filter((x) => x.kind === 'corrected')) {
      exceptions.push({
        ...base, key: `movement:${m.seq}`, kind: 'movement-corrected', group: 'explained', severity: 'info',
        seq: m.seq, amount: m.amount, by: m.user, reversedBy: m.reversedByUser, reversedSeq: m.reversedBy,
      });
    }
  }

  // Where each movement sits, so a pair across two shifts can name the other.
  const moveHome = new Map();
  for (const s of result.shifts) for (const m of s.moves) moveHome.set(m.seq, { day: s.day, slot: s.slotName, user: s.user, amount: m.amount });
  for (const s of result.shifts) for (const m of s.moves) if (m.pair) m.pairShift = moveHome.get(m.pair) || null;

  // Suggestions: the same amount moved out twice on a shift that came out
  // over, and money put back into a drawer that matches a movement out on
  // another shift. Each comes with the correction that would settle it.
  const live = (m) => !['corrected', 'excluded'].includes(m.kind);
  for (const s of ordered.filter((x) => inRange(x.day))) {
    const r = register.get(s.index);
    const base = { day: s.day, slot: s.slotName, user: s.user, event: null };
    if (r.variance > 0) {
      const outs = s.moves.filter((m) => live(m) && m.amount > 0);
      const seen = new Map();
      for (const m of outs) {
        const first = seen.get(m.amount);
        if (first && m.amount <= r.variance) {
          exceptions.push({
            ...base, key: `movement-twice:${m.seq}`, kind: 'movement-twice', group: 'drawer', severity: 'warning',
            seq: m.seq, amount: m.amount, pair: first.seq,
            action: { kind: 'duplicate', seq: m.seq, pair: first.seq },
          });
        } else if (!first) seen.set(m.amount, m);
      }
    }
    for (const back of s.moves.filter((m) => live(m) && m.amount < 0)) {
      const candidates = ordered
        .filter((o) => o !== s)
        .flatMap((o) => o.moves.filter((m) => live(m) && m.amount === -back.amount).map((m) => ({ m, o, v: register.get(o.index)?.variance ?? 0 })))
        .sort((a, b) => (b.v > 0) - (a.v > 0) || Math.abs(a.m.seq - back.seq) - Math.abs(b.m.seq - back.seq));
      if (!candidates.length) continue;
      const { m, o } = candidates[0];
      exceptions.push({
        ...base, key: `movement-reversal:${back.seq}`, kind: 'movement-reversal', group: 'drawer', severity: 'warning',
        seq: back.seq, amount: -back.amount, pair: m.seq,
        pairShift: { day: o.day, slot: o.slotName, user: o.user },
        action: { kind: 'reverses', seq: back.seq, pair: m.seq },
      });
    }
  }

  for (const x of exceptions) {
    const a = answerOf.get(x.key) || null;
    // A supervisor's answer is shown, and counts for nothing until an admin approves it.
    x.answer = a && a.status !== 'pending' ? a : null;
    x.proposed = a && a.status === 'pending' ? a : null;
  }

  // Exceptions reconciled together: each one is answered by the group.
  const linkOf = new Map();
  for (const l of links) {
    let keys = [];
    try { keys = JSON.parse(l.keys); } catch { keys = []; }
    for (const k of keys) linkOf.set(k, { id: l.id, keys, note: l.note, by: l.by_name, at: l.at, status: l.status || 'applied' });
  }
  for (const x of exceptions) {
    const link = linkOf.get(x.key);
    if (!link || link.status === 'rejected') continue;
    x.link = link;
    if (link.status === 'pending') {
      x.proposed = { answer: 'Reconciled together', note: link.note, by: link.by, at: link.at, link: link.id, status: 'pending' };
      continue;
    }
    x.answer = { answer: 'Reconciled together', note: link.note, by: link.by, at: link.at, link: link.id };
  }

  const byDay = new Map(daysBetween(from, to).map((d) => [d, []]));
  for (const s of placed) {
    const expense = expenseOf.get(`${s.day}|${s.slotName}`);
    let odoo = null;
    try { odoo = expense?.odoo ? JSON.parse(expense.odoo) : null; } catch { odoo = null; }
    const cardLines = s.lines.filter((l) => l.amount > 0);
    const found = cardLines.filter((l) => l.events.length);
    byDay.get(s.day)?.push({
      day: s.day, slot: s.slotName, user: s.user, users: s.users, double: s.double, open: s.open,
      startSeq: s.startSeq, endSeq: s.endSeq,
      cash: s.cash, card: s.card, prepaid: s.prepaid, other: s.other, laundry: s.laundry, laundryCash: s.laundryCash,
      laundrySystem: laundryOfShift(s),
      drawerOut: s.drawerOut, expensesCounted: s.expensesCounted, booked: s.booked, corrected: s.corrected,
      modes: s.modes, moves: s.moves.map((m) => ({ ...m, pending: proposed.get(m.seq) || null })), opening: s.opening, closing: s.closing,
      items: s.items, stockStart: s.stockStart, stockEnd: s.stockEnd,
      expensesMoved: s.expensesMoved, safeMoved: s.safeMoved, unlabelledMoved: s.unlabelledMoved,
      lines: s.lines,
      cardFound: found.length, cardLines: cardLines.length,
      cardFoundAmount: found.reduce((t, l) => t + l.amount, 0),
      register: register.get(s.index),
      expense: expense ? {
        sheetTotal: expense.sheet_total, poNumbers: expense.po_numbers, odoo, pulledAt: expense.pulled_at,
        odooTotal: odoo?.orders?.reduce((t, o) => t + o.total, 0) ?? null,
      } : null,
      exceptions: exceptions.filter((x) => x.day === s.day && x.slot === s.slotName).length,
    });
  }

  // Laundry, against the laundry system, day by day.
  const laundryAssd = new Map();
  for (const e of entries) {
    if (e.register !== DRAWER) continue;
    for (const l of e.laundry) if (inRange(l.date)) laundryAssd.set(l.date, (laundryAssd.get(l.date) || 0) + l.amount);
  }
  const laundryOf = new Map(laundrySystem.map((r) => [r.day, r]));

  // Money that reached the bank, by the day the guest paid.
  const commission = new Map();
  for (const b of bank.filter((x) => x.kind === 'commission')) {
    const d = b.card_day || b.day;
    if (inRange(d)) commission.set(d, (commission.get(d) || 0) + b.amount);
  }

  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, list]) => {
    list.sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
    const cardRecorded = list.reduce((t, s) => t + s.lines.filter((l) => l.amount > 0).reduce((u, l) => u + l.amount, 0), 0);
    const received = events.filter((e) => e.at && shiftDayOfEvent(e, result.shifts) === day).reduce((t, e) => t + e.amount, 0);
    const laundry = laundryOf.get(day);
    return {
      day,
      shifts: list,
      totals: {
        cardRecorded,
        received,
        commission: commission.get(day) || 0,
        exceptions: exceptions.filter((x) => x.day === day).length,
        critical: exceptions.filter((x) => x.day === day && x.severity === 'critical' && !x.answer).length,
      },
      laundry: {
        assd: laundryAssd.get(day) || 0,
        system: laundry ? laundry.net : null,
        systemCash: laundry ? laundry.cash : null,
      },
    };
  });

  // Per person: counted variance, shifts, cash handled.
  const people = new Map();
  for (const d of days) {
    for (const s of d.shifts) {
      const p = people.get(s.user) || { user: s.user, shifts: 0, counted: 0, variance: 0, over: 0, short: 0, cash: 0, card: 0, exceptions: 0 };
      p.shifts += 1;
      p.cash += s.cash;
      p.card += s.card;
      p.exceptions += s.exceptions;
      if (s.register?.variance != null) {
        p.counted += 1;
        p.variance += s.register.variance;
        if (s.register.variance > 0) p.over += s.register.variance;
        if (s.register.variance < 0) p.short += s.register.variance;
      }
      people.set(s.user, p);
    }
  }

  const totals = {
    shifts: placed.length,
    cash: placed.reduce((t, s) => t + s.cash, 0),
    card: placed.reduce((t, s) => t + s.card, 0),
    prepaid: placed.reduce((t, s) => t + s.prepaid, 0),
    drawerOut: placed.reduce((t, s) => t + s.drawerOut, 0),
    received: days.reduce((t, d) => t + d.totals.received, 0),
    commission: days.reduce((t, d) => t + d.totals.commission, 0),
    counted: placed.filter((s) => register.get(s.index)?.variance != null).length,
    variance: placed.reduce((t, s) => t + (register.get(s.index)?.variance || 0), 0),
    open: exceptions.filter((x) => !x.answer && x.severity !== 'info').length,
  };

  return {
    ...base,
    days,
    exceptions: exceptions.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)),
    people: [...people.values()].sort((a, b) => a.variance - b.variance),
    totals,
    journalEndsInside: open ? (placed.find((s) => s.open) ? { day: placed.find((s) => s.open).day, slot: placed.find((s) => s.open).slotName } : null) : null,
  };
}

/** Which placed shift's day an event falls on, by its time. */
function shiftDayOfEvent(e, list) {
  const minute = Math.floor(Date.parse(`${String(e.at).replace(' ', 'T')}Z`) / 60000);
  const home = list.find((s) => minute >= s.window.start && minute < s.window.end);
  return home ? home.day : null;
}

function entryOf(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch { data = {}; }
  return {
    seq: row.seq,
    kind: row.kind,
    user: row.staff,
    date: row.day,
    register: row.register,
    payments: data.payments || [],
    laundry: data.laundry || [],
    items: data.items || [],
    stock: data.stock || null,
    expensesCounted: data.expensesCounted ?? null,
    counted: data.counted || 0,
    movement: data.movement || 0,
    booked: data.booked || 0,
  };
}

function uploadView(u) {
  return { kind: u.kind, name: u.name, from: u.from_day, to: u.to_day, rows: u.rows, note: u.note, by: u.by_name, at: u.at };
}

/** Which days each kind of file has covered, from the upload log. */
function coverageOf(uploads) {
  const terminalDays = new Set();
  let bankTo = null;
  let bankFrom = null;
  let journalFrom = null;
  let journalTo = null;
  for (const u of uploads) {
    if (!u.from_day || !u.to_day) continue;
    if (u.kind === 'terminal') for (const d of daysBetween(u.from_day, u.to_day, 400)) terminalDays.add(d);
    if (u.kind === 'bank') {
      if (!bankTo || u.to_day > bankTo) bankTo = u.to_day;
      if (!bankFrom || u.from_day < bankFrom) bankFrom = u.from_day;
    }
    if (u.kind === 'journal') {
      if (!journalTo || u.to_day > journalTo) journalTo = u.to_day;
      if (!journalFrom || u.from_day < journalFrom) journalFrom = u.from_day;
    }
  }
  const terminalSorted = [...terminalDays].sort();
  return {
    terminalDays,
    terminal: terminalSorted.length ? { from: terminalSorted[0], to: terminalSorted[terminalSorted.length - 1], days: terminalSorted.length } : null,
    bankTo,
    bank: bankTo ? { from: bankFrom, to: bankTo } : null,
    journal: journalTo ? { from: journalFrom, to: journalTo } : null,
    toJSON() { return { terminal: this.terminal, bank: this.bank, journal: this.journal }; },
  };
}

// ------------------------------------------------------------ supervisors --

/** Keys that hold money in what the Shifts screen is sent. */
const MONEY_KEYS = new Set([
  'cash', 'card', 'prepaid', 'other', 'laundry', 'laundryCash', 'drawerOut', 'expensesCounted', 'expensesMoved',
  'safeMoved', 'unlabelledMoved', 'amount', 'total', 'notes', 'receipts', 'opening', 'closing', 'expected', 'variance',
  'countVariance', 'cashIn', 'out', 'expenses', 'toSafe', 'unlabelled', 'sheetGap', 'assdVariance', 'receiptsAtClose',
  'cardRecorded', 'received', 'commission', 'cardFoundAmount', 'assd', 'system', 'systemCash', 'sheetTotal',
  'odooTotal', 'safe', 'short', 'over', 'flaggedAmount', 'collected', 'charged',
]);

/** The same object with every amount taken out. Agrees, short and over survive as a sign. */
export function withoutMoney(value) {
  if (Array.isArray(value)) return value.map(withoutMoney);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'modes') { out.modes = Object.fromEntries(Object.keys(v || {}).map((k) => [k, null])); continue; }
    if (key === 'variance' && typeof v === 'number') out.varianceSign = Math.sign(v);
    out[key] = MONEY_KEYS.has(key) && typeof v === 'number' ? null : withoutMoney(v);
  }
  return out;
}

/**
 * The Shifts screen cut down to what a supervisor was given: amounts only with
 * money, the bank's side only with the bank, people's totals only with net.
 */
export function forSupervisor(payload, access) {
  // The totals across the window are the owner's view of the business, not a
  // supervisor's: never sent, whatever else they were given.
  let out = { ...payload, totals: null };
  if (!access.bank) {
    out = { ...out, exceptions: (out.exceptions || []).filter((x) => ['drawer', 'unlabelled', 'laundry', 'explained'].includes(x.group)) };
  }
  if (!access.net) out = { ...out, people: [] };
  if (!access.files) out = { ...out, canUpload: false };
  if (!access.money) out = withoutMoney(out);
  return { ...out, redacted: !access.money };
}
