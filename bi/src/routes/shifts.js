import { all, first, run, writeAll } from '../lib/db.js';
import { rebuildAssdRevenue } from './revenue.js';
import { badRequest, HttpError, str } from '../lib/http.js';
import { addDays, isDay, resolveRange, daysBetween } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { parseJournal, journalWindow, mergeEntry, segment, joinShared, DRAWER } from '../shifts/assd.js';
import { parseStatement } from '../shifts/bank.js';
import { parseTerminalCsv } from '../shifts/terminal.js';
import { reconcile, settlement, placeShifts, sameLogin, slotIndex, GROUPS, SLOTS, minuteOf, slotAt, slotDay, slotName } from '../shifts/reconcile.js';
import { listSources, secretNameFor } from '../connectors/index.js';
import { purchaseOrders } from '../connectors/odoo.js';
import { logEvent } from './notes.js';

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
        charges: merged.charges || [],
        ref: merged.ref || null,
        stock: merged.stock || null,
        expensesCounted: merged.expensesCounted,
        counted: merged.counted,
        movement: merged.movement,
        booked: merged.booked,
      });
      return [e.seq, e.kind, e.user, e.date, e.register, data, at];
    }));

  // The rooms' revenue on Reports › Overview is read from the journal; write the days this file covers again.
  const dated = entries.map((e) => e.date).filter(Boolean).sort();
  await rebuildAssdRevenue(env, { from: window?.from ?? dated[0], to: window?.to ?? dated[dated.length - 1] }).catch(() => {});

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

/**
 * Link POs to a shift's expenses, or unlink one: for cash a count labelled
 * expenses, or a movement labelled expenses by hand, that no closing report
 * gave a PO for. Only the PO numbers change; they are read from Odoo at once
 * and paired with the expense movements by amount. A PO already on another
 * shift, on a closing report or linked here, is refused.
 */
export async function linkPos(env, body, account) {
  const day = dayOf(body?.day);
  const slot = slotOf(body?.slot);
  const { formPos } = await import('./advances.js');
  const add = formPos(body?.add);
  const remove = formPos(body?.remove);
  if (!add.length && !remove.length) throw badRequest('Type a PO number, for example 4123 or P04123.');
  const row = await first(env.DB, 'SELECT po_numbers FROM shift_expense WHERE day = ?1 AND slot = ?2', day, slot);
  const names = [...new Set([...poList(row?.po_numbers), ...add])].filter((n) => !remove.includes(n)).slice(0, 40);

  for (const name of add) {
    const onReport = env.ATT_DB ? await first(env.ATT_DB, 'SELECT day, slot FROM till_po WHERE UPPER(po) = ?1 AND NOT (day = ?2 AND slot = ?3) LIMIT 1', name, day, slot).catch(() => null) : null;
    if (onReport) throw badRequest(`${name} is already on the closing report of ${onReport.day} ${onReport.slot}.`);
    const linked = await all(env.DB, "SELECT day, slot, po_numbers FROM shift_expense WHERE po_numbers LIKE ?1 AND NOT (day = ?2 AND slot = ?3)", `%${name}%`, day, slot);
    const other = linked.find((r) => poList(r.po_numbers).includes(name));
    if (other) throw badRequest(`${name} is already linked to ${other.day} ${other.slot}. Unlink it there first.`);
  }

  await run(env.DB, `INSERT INTO shift_expense (day, slot, po_numbers, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (day, slot) DO UPDATE SET po_numbers = ?3, by_name = ?4, at = ?5`,
  day, slot, names.join(', ') || null, who(account), now());
  if (!names.length) {
    await run(env.DB, 'UPDATE shift_expense SET odoo = NULL, pulled_at = NULL WHERE day = ?1 AND slot = ?2', day, slot);
    return { ok: true, linked: [] };
  }
  try {
    const out = await pullOrders(env, { day, slot });
    return { ok: true, linked: names, unknown: out.unknown || [] };
  } catch (err) {
    // Saved either way; Odoo is read again next time.
    return { ok: true, linked: names, warning: String(err?.message || err) };
  }
}

/**
 * Reconcile receipts that left the drawer with no movement: they were swapped
 * for cash put into the drawer, so the notes went up by as much. The amount
 * is added back to what the drawer should hold. An empty amount undoes it.
 */
export async function saveReceiptsSwap(env, body, account) {
  const day = dayOf(body?.day);
  const slot = slotOf(body?.slot);
  const amount = cedis(body?.amount, 'Amount');
  if (!amount) {
    await run(env.DB, 'DELETE FROM shift_receipts_swap WHERE day = ?1 AND slot = ?2', day, slot);
    return { ok: true, removed: true };
  }
  if (amount < 0) throw badRequest('The amount is what was swapped: more than nothing.');
  const note = str(body?.note, 'Note', { max: 400 });
  await run(env.DB, `INSERT INTO shift_receipts_swap (day, slot, amount, note, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (day, slot) DO UPDATE SET amount = ?3, note = ?4, by_name = ?5, at = ?6`, day, slot, amount, note, who(account), now());
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
  // How people read counts whose receipts went down with some still there.
  const reads = await all(env.DB, 'SELECT * FROM shift_receipts_read WHERE count_seq BETWEEN ?1 AND ?2', lo, hi).catch(() => []);
  for (const r of reads) out.set(`count:${r.count_seq}`, { reading: r.reading, by: r.by_name, at: r.at });
  return out;
}

/**
 * A count whose receipts went down with no movement and some still there
 * reads two ways: only the difference was handed in, or all of them were and
 * the ones now counted are new. Without a person's answer, the evidence
 * decides: the closing report's expenses, then the drawer itself. Returns
 * the reading and why, or nothing when neither settles it.
 */
export function readReceipts(s, ask, reportPaid) {
  if (reportPaid != null) {
    const shown = s.receiptsIn + s.directExpenses;
    if (reportPaid - shown === ask.now) return { reading: 'all', why: 'report' };
    if (reportPaid === shown) return { reading: 'some', why: 'report' };
  }
  if (s.countVariance != null) {
    if (s.countVariance === 0) return { reading: 'some', why: 'drawer' };
    if (s.countVariance + ask.now === 0) return { reading: 'all', why: 'drawer' };
  }
  return null;
}

/**
 * A movement that seems to carry receipts the counts after it still show:
 * the receipts stayed and the movement was cash, or they went and new ones
 * came. The shift's POs settle it when some of them add up to exactly the
 * movement: it was cash paid for them. Otherwise nothing here can say.
 */
export function readCarried(s, ask, poTotals) {
  const list = (poTotals || []).filter((x) => x > 0).slice(0, 14);
  for (let mask = 1; mask < (1 << list.length); mask += 1) {
    if (list.reduce((t, x, i) => t + (mask & (1 << i) ? x : 0), 0) === ask.move) return { reading: 'stayed', why: 'pos' };
  }
  return null;
}

/**
 * A movement whose amount is exactly some of the shift's POs was cash paid
 * for them. The counts may say receipts left the drawer around it, and the
 * movement was read as carrying them: then it was not, and those receipts
 * left with no movement (they are reconciled as swapped for cash, like any
 * others). `pos` is [{ name, paid }]: what each PO took out of the drawer.
 *
 * A movement labelled by hand as the safe or a split keeps its label. A PO
 * that is exactly a movement with no receipts in it is that movement's, and
 * not counted for another. Returns the movements read again.
 */
export function cashForPos(s, pos) {
  const list = (pos || []).filter((p) => p.paid > 0).map((p, i) => ({ ...p, i }));
  if (!list.length) return [];
  const used = new Set();
  const live = (s.moves || []).filter((m) => m.amount > 0 && ['expenses', 'safe', 'split', 'part', 'unlabelled'].includes(m.kind));
  for (const m of live.filter((x) => !(x.receipts > 0))) {
    const same = list.find((p) => !used.has(p.i) && p.paid === m.amount);
    if (same) used.add(same.i);
  }
  const changed = [];
  const candidates = live
    .filter((m) => m.receipts > 0 && !(m.manual && ['safe', 'split'].includes(m.kind)))
    .filter((m) => (m.drops || []).reduce((t, d) => t + d.amount, 0) === m.receipts)
    .sort((a, b) => b.amount - a.amount);
  for (const m of candidates) {
    const free = list.filter((p) => !used.has(p.i)).slice(0, 14);
    let pick = null;
    for (let mask = 1; mask < (1 << free.length) && !pick; mask += 1) {
      const set = free.filter((_, b) => mask & (1 << b));
      if (set.reduce((t, p) => t + p.paid, 0) === m.amount) pick = set;
    }
    if (!pick) continue;
    for (const p of pick) used.add(p.i);
    const receipts = m.receipts;
    // Out with the old parts, in with all of it as expenses paid straight out.
    s.receiptsMoved -= receipts;
    s.directExpenses += m.amount - (m.direct || 0);
    s.safeMoved -= m.safe || 0;
    s.unlabelledMoved -= m.unlabelledCash || 0;
    Object.assign(m, { receipts: 0, cash: m.amount, direct: m.amount, safe: 0, unlabelledCash: 0, wasReceipts: receipts, byPos: pick.map((p) => p.name) });
    if (!m.manual) { m.kind = 'expenses'; m.expenses = 0; }
    // The receipts left the counts with no movement.
    for (const d of m.drops) s.receiptsSwaps.push({ seq: d.seq, amount: d.amount, leg: d.leg || null });
    s.receiptsSwaps.sort((a, b) => a.seq - b.seq);
    s.receiptsSwapped += receipts;
    s.expenses = s.receiptsIn + s.directExpenses;
    s.expensesMoved = s.expenses;
    s.expensesCounted = s.expenses;
    if (s.expected != null) { s.expected -= receipts; s.countVariance += receipts; }
    changed.push(m);
  }
  return changed;
}

/** Count a reading of 'all' on a shift already summarised as 'some'. */
function applyAll(s, ask) {
  s.receiptsIn += ask.now;
  s.receiptsSwapped += ask.now;
  s.receiptsSwaps.push({ seq: ask.seq, amount: ask.now });
  s.receiptsOut += ask.now;
  s.expenses += ask.now;
  s.expensesMoved = s.expenses;
  s.expensesCounted = s.expenses;
  s.receiptsNew.push({ seq: ask.seq, amount: ask.now, reading: 'all' });
  if (s.expected != null) { s.expected -= ask.now; s.countVariance += ask.now; }
}

/**
 * Receipts from shift to shift. A receipt stays in the drawer until it is
 * carried out, and may be handed over a few times first; it is the expense of
 * the shift whose count it first appeared on. Followed oldest first:
 *
 *  - `origins`: for each movement that carried receipts, whose they were.
 *  - `trail`: for each shift, what became of the receipts it left in the
 *    drawer, and which later shift took them out.
 *
 * Shifts are in slot order and summarised. A hand-over count that shows
 * fewer receipts than were left takes the oldest off; one that shows more
 * holds receipts from before (`earlier`).
 */
export function receiptTrail(ordered) {
  const shiftOf = (s) => ({ day: s.day, slot: s.slotName, user: s.user });
  const lots = [];
  const origins = new Map();
  const trail = new Map(ordered.map((s) => [s.index, { left: 0, cleared: [], still: 0, swaps: [] }]));
  // Takes `amount` off the oldest lots, as `how` on shift `by`.
  const take = (amount, by, how, seq) => {
    const out = [];
    let need = amount;
    while (need > 0 && lots.length) {
      const lot = lots[0];
      const n = Math.min(need, lot.amount);
      lot.amount -= n;
      need -= n;
      if (!lot.amount) lots.shift();
      const last = out[out.length - 1];
      if (last && last.index === lot.index) { last.amount += n; if (!last.seqs.includes(lot.seq)) last.seqs.push(lot.seq); } else out.push({ index: lot.index, ...lot.from, seqs: lot.seq ? [lot.seq] : [], amount: n, earlier: lot.earlier || undefined, leg: lot.leg || undefined });
      if (lot.index !== by.index && trail.has(lot.index)) {
        const t = trail.get(lot.index);
        const same = t.cleared.find((c) => c.seq === seq && c.how === how);
        if (same) same.amount += n;
        else t.cleared.push({ amount: n, how, seq, ...shiftOf(by) });
      }
    }
    return { out, short: need };
  };
  const total = () => lots.reduce((t, l) => t + l.amount, 0);
  for (const s of ordered) {
    const open = s.opening?.receipts;
    if (open != null) {
      const have = total();
      if (open < have) take(have - open, s, 'handover', s.opening.seq);
      else if (open > have) lots.push({ index: null, from: null, seq: null, amount: open - have, earlier: true });
    }
    // What this shift's own movements carried before its counts showed the
    // receipts (they appear later, as new): those are its own already.
    let owed = 0;
    const events = [
      ...(s.receiptsSwaps || []).map((x) => ({ seq: x.seq, at: 0, out: x.amount, how: 'swapped', leg: x.leg || null })),
      ...(s.moves || []).filter((m) => m.receipts > 0).map((m) => ({ seq: m.seq, at: 0, out: m.receipts, how: 'moved', move: m })),
      ...(s.receiptsNew || []).map((x) => ({ seq: x.seq, at: 1, add: x.amount, leg: x.leg || null })),
    ].sort((a, b) => a.seq - b.seq || a.at - b.at);
    for (const e of events) {
      if (e.add) {
        const paid = Math.min(owed, e.add);
        owed -= paid;
        if (e.add > paid) lots.push({ index: s.index, from: shiftOf(s), seq: e.seq, amount: e.add - paid, leg: e.leg || null });
        continue;
      }
      const { out, short } = take(e.out, s, e.how, e.seq);
      if (short) {
        owed += short;
        const last = out[out.length - 1];
        if (last && last.index === s.index) last.amount += short; else out.push({ index: s.index, ...shiftOf(s), seqs: [], amount: short });
      }
      if (e.move) origins.set(e.move.seq, out.map((o) => ({ ...o, here: o.index === s.index })));
      // Whose receipts left with no movement, at which count.
      if (e.how === 'swapped') trail.get(s.index).swaps.push({ seq: e.seq, amount: e.out, leg: e.leg || null, origins: out.map((o) => ({ ...o, here: o.index === s.index })) });
    }
    // What it handed over of its own.
    trail.get(s.index).left = lots.filter((l) => l.index === s.index).reduce((t, l) => t + l.amount, 0);
  }
  for (const l of lots) if (trail.has(l.index)) trail.get(l.index).still += l.amount;
  for (const o of origins.values()) for (const x of o) delete x.index;
  for (const t of trail.values()) for (const w of t.swaps) for (const x of w.origins) delete x.index;
  return { origins, trail };
}

/**
 * A person reads a count's receipts: 'all' (every receipt before it was handed
 * in, those now counted are new), 'some' (only the difference was), or ''
 * to go back to what the evidence says.
 */
export async function saveReceiptsRead(env, body, account) {
  const seq = Number(body?.seq);
  if (!Number.isInteger(seq)) throw badRequest('Which count? Its ASSD number is needed.');
  const reading = String(body?.reading || '');
  if (!reading) {
    await run(env.DB, 'DELETE FROM shift_receipts_read WHERE count_seq = ?1', seq);
    return { ok: true };
  }
  // A count: were all its receipts handed in, or only some. A movement: did
  // the receipts it seems to carry stay in the drawer, or go with new ones
  // in their place.
  const forMove = ['stayed', 'new'].includes(reading);
  if (!forMove && !['all', 'some'].includes(reading)) throw badRequest('Say whether all the receipts were handed in, or only some.');
  const kind = forMove ? 'Cash Movement' : 'Money Count';
  const row = await first(env.DB, 'SELECT seq FROM assd_entry WHERE seq = ?1 AND kind = ?2', seq, kind);
  if (!row) throw badRequest(`ASSD ${seq} is not a ${kind}.`);
  await run(env.DB, `INSERT INTO shift_receipts_read (count_seq, reading, by_name, at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (count_seq) DO UPDATE SET reading = ?2, by_name = ?3, at = ?4`, seq, reading, who(account), now());
  return { ok: true };
}

/** A Cash Movement on the front drawer, with the amount it took out (negative: put back). */
async function drawerMovement(env, seq) {
  const row = await first(env.DB, 'SELECT seq, kind, day, register, data FROM assd_entry WHERE seq = ?1', seq);
  if (!row || row.kind !== 'Cash Movement' || row.register !== DRAWER) return null;
  let data = {};
  try { data = JSON.parse(row.data); } catch { data = {}; }
  return { seq: row.seq, day: row.day, amount: -(data.movement || 0) };
}

/**
 * Correct what a Cash Movement was.
 *
 * `kind` is one of: `expenses`, `safe`, `split` (with `expenses`, the part
 * that was expenses), `duplicate` (with `pair`, the movement it repeats),
 * `reverses` (with `pair`, the movement it puts back, which may be on
 * another shift), or `clear` to undo whatever was said about this movement.
 */
/** Who decided a supervisor's correction that was small enough to count straight away. */
export const SMALL_BY = 'Counted straight away (small)';
/** Who decided a supervisor's label for cash no count had labelled. */
export const UNLABELLED_BY = 'Counted straight away (had no label)';

/**
 * What the counts said a movement was before anybody corrected it:
 * expenses, safe, split, part (some receipts, the rest unsaid) or unlabelled.
 */
async function autoLabel(env, move) {
  if (!isDay(move.day)) return null;
  try {
    const out = await shifts(env, { from: addDays(move.day, -1), to: addDays(move.day, 1) }, null);
    for (const d of out.days || []) {
      for (const sh of d.shifts || []) {
        const m = (sh.moves || []).find((x) => x.seq === move.seq);
        if (m) return m.auto || m.kind;
      }
    }
  } catch { /* not known: it waits for an admin */ }
  return null;
}

export async function saveMovement(env, body, account, { pending = false, smallUpTo = null } = {}) {
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

  // A supervisor's correction of a small movement counts straight away: at or
  // under the small-differences limit, it is not worth an admin's decision.
  // It is marked, so the daily summary can list it.
  const small = pending && smallUpTo > 0 && Math.abs(move.amount) <= smallUpTo;
  // Cash no count labelled, labelled expenses or the safe, counts straight
  // away too: it fills in what was missing rather than overruling a count.
  const filled = pending && !small && ['expenses', 'safe', 'split'].includes(kind)
    && ['unlabelled', 'part'].includes(await autoLabel(env, move));
  const status = pending && !small && !filled ? 'pending' : 'applied';
  const decidedBy = small ? SMALL_BY : filled ? UNLABELLED_BY : null;
  await run(env.DB, `INSERT INTO shift_movement (seq, kind, expenses, pair, note, by_name, at, status, decided_by, decided_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT (seq) DO UPDATE SET kind = ?2, expenses = ?3, pair = ?4, note = ?5, by_name = ?6, at = ?7, status = ?8,
      decided_by = ?9, decided_at = ?10`,
  rowSeq, kind, expenses, pair, note, who(account), now(), status, decidedBy, decidedBy ? now() : null);
  return { ok: true, pending: status === 'pending', small, filled, seq: rowSeq, kind };
}

/**
 * An admin decided these differences another way (answered, reconciled, put
 * on a staff account, settled on a person's list): whatever a supervisor
 * proposed for them and is still waiting for approval is done with. It
 * leaves Waiting for admin, and its history says why.
 */
export async function setAside(env, keys, how, account) {
  const wanted = new Set(keys.map(String));
  if (!wanted.size) return 0;
  let n = 0;
  const by = who(account);
  for (const key of wanted) {
    // eslint-disable-next-line no-await-in-loop
    const a = await first(env.DB, "SELECT * FROM shift_answer WHERE key = ?1 AND status = 'pending'", key).catch(() => null);
    if (!a) continue;
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, "DELETE FROM shift_answer WHERE key = ?1 AND status = 'pending'", key);
    // eslint-disable-next-line no-await-in-loop
    await logEvent(env, key, `${a.by_name || 'A supervisor'}’s answer “${a.answer}” set aside: ${how}`, by);
    n += 1;
  }
  const links = await all(env.DB, "SELECT * FROM shift_link WHERE status = 'pending'").catch(() => []);
  for (const l of links) {
    let lk = [];
    try { lk = JSON.parse(l.keys); } catch { lk = []; }
    if (!lk.some((k) => wanted.has(k))) continue;
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, "DELETE FROM shift_link WHERE id = ?1 AND status = 'pending'", l.id);
    for (const k of lk) {
      // eslint-disable-next-line no-await-in-loop
      await logEvent(env, k, `${l.by_name || 'A supervisor'}’s “Reconciled together” set aside: ${how}`, by);
    }
    n += 1;
  }
  return n;
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
  // An admin's reconciliation decides instead of whatever waits for approval on them.
  if (!pending) await setAside(env, keys, 'reconciled together by an admin instead', account);
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

/** The answers that make a guest's overpayment a refund owed, and keep a pair apart. */
export const REFUND_DUE = 'Refund due to the guest';
export const NOT_SAME = 'Not the same payment';

export async function saveAnswer(env, body, account, { pending = false } = {}) {
  const key = str(body?.key, 'Exception', { required: true, max: 200 });
  const answer = str(body?.answer, 'Answer', { max: 60 });
  const note = str(body?.note, 'Note', { max: 600 });
  let existing = await first(env.DB, 'SELECT * FROM shift_answer WHERE key = ?1', key);
  // What an admin settled is the admin's to change; a supervisor may change
  // or take back only their own answer, while it is still waiting.
  if (pending && existing && ((existing.status || 'applied') === 'applied' || existing.by_name !== who(account))) {
    throw badRequest('That has already been answered. Ask an admin to change it.');
  }
  // Put on a staff account by an admin: decided, so nothing more waits on it.
  if (pending && answer && await first(env.DB, 'SELECT id FROM till_move WHERE key = ?1 AND undone_at IS NULL', key).catch(() => null)) {
    throw badRequest('An admin has put that on a staff account already.');
  }
  // An admin answering decides instead of whatever a supervisor proposed.
  if (!pending && answer && await setAside(env, [key], 'answered by an admin instead', account)) {
    existing = await first(env.DB, 'SELECT * FROM shift_answer WHERE key = ?1', key);
  }
  if (!answer) {
    await run(env.DB, 'DELETE FROM shift_answer WHERE key = ?1', key);
    if (existing) await logEvent(env, key, `Answer “${existing.answer}” taken back`, who(account));
    return { ok: true };
  }
  const status = pending ? 'pending' : 'applied';
  await run(env.DB, `INSERT INTO shift_answer (key, answer, note, by_name, at, status, decided_by, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)
    ON CONFLICT (key) DO UPDATE SET answer = ?2, note = ?3, by_name = ?4, at = ?5, status = ?6, decided_by = NULL, decided_at = NULL`,
  key, answer, note, who(account), now(), status);
  await logEvent(env, key, `${existing ? 'Answer changed to' : 'Answered'} “${answer}”${note ? `: “${note}”` : ''}${pending ? ' (waiting for an admin)' : ''}`, who(account));
  // A refund owed is kept with what was paid, so the list of them does not
  // depend on the days on screen.
  if (key.startsWith('paid-more:') && answer === REFUND_DUE) await keepRefund(env, key);
  return { ok: true, pending };
}

async function keepRefund(env, key) {
  const day = key.split(':')[1];
  if (!isDay(day)) return;
  const data = await shifts(env, { from: day, to: day }, { isOwner: true });
  const x = (data.exceptions || []).find((e) => e.key === key);
  if (!x) return;
  await run(env.DB, `INSERT INTO guest_refund (key, day, slot, assd_user, seq, amount, assd, paid, method, last4, paid_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT (key) DO UPDATE SET amount = ?6, assd = ?7, paid = ?8, method = ?9, last4 = ?10, paid_at = ?11`,
  key, x.day, x.slot, x.user || null, x.seq ?? null, x.amount, x.assd ?? null, x.paid ?? null, x.event?.kind || null, x.event?.last4 || null, x.event?.at || null);
}

/** Refunds owed to guests: answered so, and not yet paid back. With `paid`, the last ones paid back too. */
export async function refundsOwed(env) {
  const rows = await all(env.DB, `SELECT r.*, a.note, a.by_name AS answered_by, a.at AS answered_at FROM guest_refund r
    JOIN shift_answer a ON a.key = r.key
    WHERE a.answer = ?1 AND COALESCE(a.status, 'applied') = 'applied' ORDER BY r.day, r.slot`, REFUND_DUE).catch(() => []);
  const view = (r) => ({
    key: r.key, day: r.day, slot: r.slot, user: r.assd_user, seq: r.seq, amount: r.amount, assd: r.assd, paid: r.paid,
    method: r.method, last4: r.last4, paidAt: r.paid_at, note: r.note, answeredBy: r.answered_by, answeredAt: r.answered_at,
    paidBack: r.paid_back_at ? { by: r.paid_back_by, at: r.paid_back_at } : null,
  });
  return {
    owed: rows.filter((r) => !r.paid_back_at).map(view),
    paid: rows.filter((r) => r.paid_back_at).sort((a, b) => String(b.paid_back_at).localeCompare(String(a.paid_back_at))).slice(0, 10).map(view),
  };
}

/** A refund owed, paid back to the guest; or, with `undo`, not after all. */
export async function refundPaid(env, body, account) {
  const key = str(body?.key, 'Which refund', { required: true, max: 200 });
  const row = await first(env.DB, 'SELECT * FROM guest_refund WHERE key = ?1', key);
  if (!row) throw badRequest('That refund is not on the list.');
  if (body?.undo) await run(env.DB, 'UPDATE guest_refund SET paid_back_by = NULL, paid_back_at = NULL WHERE key = ?1', key);
  else {
    if (row.paid_back_at) throw badRequest(`Already paid back (${row.paid_back_by}).`);
    await run(env.DB, 'UPDATE guest_refund SET paid_back_by = ?1, paid_back_at = ?2 WHERE key = ?3', who(account), now(), key);
  }
  return { ok: true };
}

/** The day an ASSD line was keyed on. */
export async function whereIs(env, query) {
  // Money with no ASSD line (a card on the terminal, a MoMo or card in the
  // bank): its shift is the one its time falls in, or its day when it has none.
  const ev = /(?:^|:)(t|b):([^:]+)$/.exec(String(query?.key || ''));
  if (ev) {
    const row = ev[1] === 't'
      ? await first(env.DB, 'SELECT at, day FROM terminal_txn WHERE rrn = ?1', ev[2])
      : await first(env.DB, 'SELECT at, day, card_day FROM bank_card_txn WHERE id = ?1', ev[2]);
    if (!row) return { key: query.key, day: null, slot: null };
    if (row.at) {
      const t = slotAt(minuteOf(row.at));
      return { key: query.key, day: slotDay(t), slot: slotName(t) };
    }
    return { key: query.key, day: row.card_day || row.day || null, slot: null };
  }
  const seq = Number(query?.seq);
  if (!Number.isInteger(seq)) throw badRequest('Which ASSD line?');
  const row = await first(env.DB, 'SELECT day FROM assd_entry WHERE seq = ?1', seq);
  return { seq, day: row?.day || null };
}

/**
 * The day a difference's key belongs to, near enough: the day in the key, the
 * day its payment was made, or the day of its ASSD line (a night's lines can
 * carry the next day's date). Null when the key says nothing about a day.
 */
export async function dayOfKey(env, key) {
  const k = String(key || '');
  if (/^(stay|notpair):/.test(k)) return null;
  const date = /\d{4}-\d{2}-\d{2}/.exec(k);
  if (date) return date[0];
  if (/(?:^|:)(t|b):[^:]+$/.test(k)) return (await whereIs(env, { key: k }).catch(() => null))?.day || null;
  const seq = /:(\d{5,})(?::|$)/.exec(k);
  if (seq) return (await first(env.DB, 'SELECT day FROM assd_entry WHERE seq = ?1', Number(seq[1])).catch(() => null))?.day || null;
  return null;
}

/** What has been loaded, and nothing about what is in it: the Upload page. */
export async function filesStatus(env) {
  const uploads = await all(env.DB, 'SELECT kind, name, from_day, to_day, rows, note, by_name, at FROM shift_upload ORDER BY id DESC LIMIT 40');
  return { uploads: uploads.slice(0, 12).map(uploadView), coverage: coverageOf(uploads), canUpload: true };
}

// ------------------------------------------------------------------ read --

/**
 * Everything the Shifts screen shows for a window of days.
 */
/**
 * Who signed each shift's closing report in HIVE, and the drawer they
 * counted, as evidence of where an ASSD session sat: `signed(session, slot)`
 * weighs it, and `pick(logins, slot)` is the login of whoever signed a slot
 * several sessions share. A login is a person through Settings → Whose
 * ASSD login is whose, else by name. Nothing when HIVE is not bound.
 */
async function signers(env, entries) {
  const none = { signed: null, pick: null };
  if (!env.ATT_DB || !entries.length) return none;
  const days = entries.map((e) => e.date).filter(Boolean).sort();
  if (!days.length) return none;
  const [reports, mapped] = await Promise.all([
    all(env.ATT_DB, 'SELECT day, slot, user_id, name, cash FROM till_report WHERE reopened_at IS NULL AND day BETWEEN ?1 AND ?2',
      addDays(days[0], -2), addDays(days[days.length - 1], 2)).catch(() => []),
    all(env.DB, 'SELECT assd_user, hive_user_id FROM till_people WHERE hive_user_id IS NOT NULL').catch(() => []),
  ]);
  if (!reports.length) return none;
  const bySlot = new Map(reports.filter((r) => SLOTS.includes(r.slot)).map((r) => [slotIndex(r.day, SLOTS.indexOf(r.slot)), r]));
  const owner = new Map(mapped.map((m) => [m.assd_user, Number(m.hive_user_id)]));
  const isTheirs = (login, r) => (owner.has(login) ? owner.get(login) === Number(r.user_id) : sameLogin(login, r.name));
  return {
    // The person on the login signed it (3), and the drawer they counted is
    // what this session closed on (1.5): the hand-over count.
    signed: (session, t) => {
      const r = bySlot.get(t);
      if (!r) return 0;
      return (isTheirs(session.user, r) ? 3 : 0) + (Number(r.cash) > 0 && session.closing?.notes === Number(r.cash) ? 1.5 : 0);
    },
    pick: (logins, t) => { const r = bySlot.get(t); return r ? logins.find((l) => isTheirs(l, r)) || null : null; },
  };
}

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

  const { shifts: sessions, sessions: parts } = segment(entries, corrections);
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

  // A guest who paid more: the pairs somebody said are not one payment.
  const notSame = answers.filter((a) => /^paid-(more|less):/.test(String(a.key)) && a.answer === NOT_SAME && (a.status || 'applied') === 'applied');
  // Where each ASSD session sat. Who signed each shift's closing report in
  // HIVE is evidence; sessions that share a shift (a quick log-in, a hand-over
  // in the middle of a night) are made one.
  const signer = await signers(env, entries);
  const placed0 = placeShifts(sessions, events.map((e) => ({ ...e, minute: minuteOf(e.at) })), { signed: signer.signed });
  const { shifts: raw, places } = joinShared(parts, placed0, corrections, signer.pick);
  // Payments an admin moved to another shift.
  const homeRows = await optional(all(env.DB, 'SELECT * FROM payment_home'));
  const homes = new Map(homeRows.map((r) => [r.event_id, { day: r.day, slot: r.slot }]));
  const result = reconcile(raw, events, declines, { open, notSame: notSame.map((a) => a.key), places, homes });
  for (const x of result.exceptions) {
    const m = x.event?.id && homeRows.find((r) => r.event_id === x.event.id);
    if (m) x.home = { fromDay: m.from_day, fromSlot: m.from_slot, why: m.why, by: m.by_name, at: m.at };
  }
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
    const l = laundryIn.get(home.index) || { collected: 0, cash: 0, card: 0, charged: 0, payments: 0, orders: 0, list: [] };
    l.list.push({ kind: t.kind, ref: t.ref, at: t.at, amount: t.amount, method: t.method || null });
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
    ? { collected: 0, cash: 0, card: 0, charged: 0, payments: 0, orders: 0, list: [], ...laundryIn.get(s.index) }
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

  // A card or MoMo line ASSD has twice, or with no payment found: what else
  // says what happened. The terminal's declined tries of that amount in the
  // shift's hours (a failed first try is often keyed too), and, for laundry,
  // how many payments of that amount the laundry system took.
  for (const x of exceptions.filter((e) => ['duplicate', 'not-found', 'failed'].includes(e.kind) && e.seq)) {
    const s = result.shifts.find((o) => o.day === x.day && o.slotName === x.slot);
    if (!s) continue;
    const w = s.window;
    x.declined = x.kind === 'failed' ? [] : declines.filter((d) => d.amount === x.amount && d.at && minuteAt(d.at) >= w.start - 30 && minuteAt(d.at) < w.end + 30)
      .map((d) => ({ at: d.at, last4: d.last4 || null, status: d.status || null }));
    const seqs = [x.seq, x.pair].filter(Boolean);
    if (!(s.laundryLines || []).some((ll) => seqs.includes(ll.seq))) continue;
    const l = laundryOfShift(s);
    x.laundry = l
      ? { read: true, same: l.list.filter((t) => t.kind === 'payment' && t.amount === x.amount).map((t) => ({ at: t.at, method: t.method, ref: t.ref })) }
      : { read: false };
  }

  // What people typed.
  const answerOf = new Map(answers.map((a) => [a.key, {
    answer: a.answer, note: a.note, by: a.by_name, at: a.at, status: a.status || 'applied', approvedBy: a.decided_by || null,
  }]));

  const countOf = new Map(counts.map((c) => [`${c.day}|${c.slot}`, c]));
  const swaps = await all(env.DB, 'SELECT * FROM shift_receipts_swap WHERE day BETWEEN ?1 AND ?2', addDays(from, -3), to).catch(() => []);
  const swapOf = new Map(swaps.map((w) => [`${w.day}|${w.slot}`, w]));
  const expenseOf = new Map(expenses.map((e) => [`${e.day}|${e.slot}`, e]));
  // The POs on each shift's closing report in HIVE, already checked against
  // Odoo when it was signed. Shown with any typed here, so a shift whose
  // person gave their POs does not read as having none.
  const reportPos = new Map();
  // What each shift's closing report says left the drawer for expenses. It
  // settles cash movements nothing labelled, the way a typed expense sheet
  // used to, so nobody has to type the total in here.
  const reportPaid = new Map();
  // Expenses are expected to carry a PO from the first closing report in
  // HIVE on; shifts before it are history and are not flagged.
  const poFrom = env.ATT_DB ? (await first(env.ATT_DB, 'SELECT MIN(day) AS day FROM till_report').catch(() => null))?.day || null : null;
  // Which POs are on the expense form: those on closing reports and those
  // typed here.
  const reported = new Set();
  const poRows = env.ATT_DB ? await all(env.ATT_DB, 'SELECT * FROM till_po WHERE day BETWEEN ?1 AND ?2', from, to).catch(() => []) : [];
  const typedPos = expenses.flatMap((e) => { try { return (JSON.parse(e.odoo || 'null')?.orders || []).map((o) => o.name); } catch { return []; } });
  const names = [...new Set([...poRows.map((r) => r.po), ...typedPos].map((x) => String(x).toUpperCase()))];
  for (let i = 0; i < names.length; i += 90) {
    const chunk = names.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    for (const r of await all(env.DB, `SELECT DISTINCT po FROM expense_report WHERE po IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`, ...chunk).catch(() => [])) reported.add(String(r.po).toUpperCase());
  }
  // What each PO took out of each shift's drawer: from its closing report,
  // and the POs linked here (their Odoo total).
  const poPaid = new Map();
  const paidOn = (key, name, paid) => { if (!poPaid.has(key)) poPaid.set(key, []); poPaid.get(key).push({ name: String(name).toUpperCase(), paid: Math.round(paid) }); };
  for (const r of poRows) paidOn(`${r.day}|${r.slot}`, r.po, Number(r.paid) || 0);
  for (const e of expenses) {
    let orders = [];
    try { orders = JSON.parse(e.odoo || 'null')?.orders || []; } catch { orders = []; }
    for (const o of orders) {
      const key = `${e.day}|${e.slot}`;
      if (!(poPaid.get(key) || []).some((p) => p.name === String(o.name).toUpperCase())) paidOn(key, o.name, Number(o.total) || 0);
    }
  }
  for (const r of poRows) {
    const key = `${r.day}|${r.slot}`;
    if (!reportPos.has(key)) reportPos.set(key, []);
    reportPaid.set(key, (reportPaid.get(key) || 0) + (Number(r.paid) || 0));
    // A top-up or change back on a later shift is the difference that moved
    // through that drawer, not the PO's whole total again.
    const kind = r.kind || 'claim';
    reportPos.get(key).push({
      name: r.po, vendor: r.vendor || '', total: kind === 'claim' ? Number(r.total) || 0 : Number(r.paid) || 0,
      // HIVE saves an approved PO as "confirmed"; Odoo's own word for it is "purchase".
      state: !r.state || r.state === 'confirmed' ? 'purchase' : r.state, fromReport: true, ...(kind !== 'claim' ? { kind } : {}),
      reported: reported.has(String(r.po).toUpperCase()), advance: Number(r.advance) === 1,
    });
  }

  // The register, in slot order. ASSD counts the drawer at every hand-over:
  // a shift's first Money Count is its opening and its last is its closing.
  // A count typed here is a recount, and when there is one it is used instead.
  const ordered = [...result.shifts].sort((a, b) => a.slot - b.slot);
  const register = new Map();
  const previousUser = new Map();
  let previousClosing = null;
  for (const s of ordered) {
    const typed = countOf.get(`${s.day}|${s.slotName}`);
    const expense = expenseOf.get(`${s.day}|${s.slotName}`);
    // The drawer in notes and coins. Receipts in a count are not cash: the
    // ones that appeared on this shift are its expenses; those carried out
    // with a movement are not cash moved; those that left with no movement
    // were swapped for cash, which a person reconciles.
    // Counts that read two ways and nobody answered: the evidence decides,
    // or they wait for a person, counted meanwhile only as far as is sure.
    // A movement that is exactly some of the shift's POs was cash for them,
    // not receipts carried out (those left with no movement).
    cashForPos(s, poPaid.get(`${s.day}|${s.slotName}`));
    for (const ask of s.receiptsAsk || []) {
      if (ask.reading) { ask.decided = { reading: ask.reading, why: 'person', by: ask.said?.by || null, at: ask.said?.at || null }; continue; }
      const guess = readReceipts(s, ask, reportPaid.get(`${s.day}|${s.slotName}`) ?? null);
      ask.decided = guess;
      if (guess?.reading === 'all') applyAll(s, ask);
    }
    // Movements that seem to carry receipts the counts still show: counted
    // once (stayed) unless a person said new ones came; the shift's POs may
    // settle it, or it waits for a person.
    const poTotals = [...(reportPos.get(`${s.day}|${s.slotName}`) || []).map((o) => Math.round(o.total)),
      ...(() => { try { return (JSON.parse(expense?.odoo || 'null')?.orders || []).map((o) => Math.round(Number(o.total) || 0)); } catch { return []; } })()];
    for (const ask of s.carriedAsk || []) {
      ask.decided = ask.reading ? { reading: ask.reading, why: 'person', by: ask.said?.by || null, at: ask.said?.at || null } : readCarried(s, ask, poTotals);
    }
    const swap = swapOf.get(`${s.day}|${s.slotName}`) || null;
    const assdOpening = s.opening?.notes ?? null;
    const opening = typed?.opening ?? assdOpening ?? previousClosing?.amount ?? null;
    const openingFrom = typed?.opening != null ? 'typed' : assdOpening != null ? 'assd' : previousClosing ? 'carried' : null;
    const out = s.drawerOut;
    const swapped = swap?.amount || 0;
    const expected = opening == null ? null : opening + s.cash - s.receiptsIn - (out - s.receiptsMoved) + swapped;
    const closing = typed?.closing ?? s.closing?.notes ?? null;
    const closingFrom = typed?.closing != null ? 'typed' : s.closing ? 'assd' : null;
    // Expenses: what each movement was, as the count before it labelled it
    // or as a person corrected it. The expense sheet's total only settles
    // what nothing labelled: the part of it not yet accounted for is
    // expenses, the rest went to the safe. Where the sheet and the labelled
    // movements disagree, the gap is shown rather than written over.
    const sheet = expense?.sheet_total ?? reportPaid.get(`${s.day}|${s.slotName}`) ?? null;
    const fromSheet = sheet != null ? Math.min(s.unlabelledMoved, Math.max(0, sheet - s.expenses)) : 0;
    const expenses = s.expenses + fromSheet;
    const toSafe = s.safeMoved + (sheet != null ? s.unlabelledMoved - fromSheet : 0);
    const unlabelled = sheet != null ? 0 : s.unlabelledMoved;
    register.set(s.index, {
      opening, openingFrom, cashIn: s.cash, laundryCash: s.laundryCash, out,
      expenses, toSafe, unlabelled, expensesFrom: fromSheet ? 'sheet' : 'assd', fromSheet,
      // Money put back into the drawer by a movement the other way.
      putBack: -s.moves.filter((m) => m.kind === 'returned').reduce((t, m) => t + m.amount, 0),
      receipts: {
        open: s.opening?.receipts ?? null, close: s.closing?.receipts ?? null,
        in: s.receiptsIn, out: s.receiptsOut, moved: s.receiptsMoved, swapped: s.receiptsSwapped,
        direct: s.directExpenses, list: s.receiptsNew,
        reconciled: swap ? { amount: swap.amount, note: swap.note, by: swap.by_name, at: swap.at } : null,
      },
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
    previousUser.set(s.index, previousClosing?.user || null);
    previousClosing = closing != null ? { amount: closing, user: s.user } : null;
  }

  // Receipts from shift to shift: whose each movement carried, and which
  // later shift took out what each shift left in the drawer.
  const { origins, trail } = receiptTrail(ordered);
  for (const s of ordered) {
    const tr = trail.get(s.index);
    // Taken out with no movement is settled once that shift reconciled it.
    for (const c of tr.cleared) if (c.how === 'swapped') c.reconciled = Boolean(swapOf.get(`${c.day}|${c.slot}`)?.amount);
    register.get(s.index).receipts.trail = tr;
  }

  // Whose receipts left a shift's drawer with no movement, and at which count.
  const swapFromOf = (r) => (r.receipts.trail?.swaps || []).flatMap((w) => w.origins.map((o) => ({ ...o, gone: w.seq, goneLeg: w.leg })));

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
        // Receipts that left with no movement, not yet reconciled: the likely story of a surplus.
        swapped: r.receipts.swapped - (r.receipts.reconciled?.amount || 0) > 0 ? r.receipts.swapped - (r.receipts.reconciled?.amount || 0) : null,
        receiptsFrom: r.receipts.open ? previousUser.get(s.index) || null : null,
        swapFrom: swapFromOf(r),
      });
    }
    for (const ask of s.receiptsAsk || []) {
      const d = ask.decided;
      exceptions.push({
        ...base, key: `receipts-read:${ask.seq}`, kind: 'receipts-unclear', group: d ? 'explained' : 'drawer', severity: d ? 'info' : 'warning',
        seq: ask.seq, amount: ask.left, prev: ask.prev, now: ask.now, left: ask.left, reading: d?.reading || null, why: d?.why || null,
        by: d?.by || null, at: d?.at || null,
      });
    }
    for (const ask of s.carriedAsk || []) {
      const d = ask.decided;
      exceptions.push({
        ...base, key: `receipts-carried:${ask.seq}`, kind: 'receipts-carried', group: d ? 'explained' : 'drawer', severity: d ? 'info' : 'warning',
        seq: ask.seq, amount: ask.amount, move: ask.move, reading: d?.reading || null, why: d?.why || null, by: d?.by || null, at: d?.at || null,
      });
    }
    if (r.receipts.reconciled?.amount) {
      exceptions.push({
        ...base, key: `receipts:${s.day}:${s.slotName}`, kind: 'receipts-swapped', group: 'explained', severity: 'info',
        amount: r.receipts.reconciled.amount, by: r.receipts.reconciled.by, at: r.receipts.reconciled.at, note: r.receipts.reconciled.note,
        receiptsFrom: r.receipts.open ? previousUser.get(s.index) || null : null,
        swapFrom: swapFromOf(r),
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
    // Expenses paid from the drawer with no PO at all: not on a closing
    // report, not linked here. Linking one takes it off.
    if (r.expenses > 0 && poFrom && s.day >= poFrom) {
      const key = `${s.day}|${s.slotName}`;
      const exp = expenseOf.get(key);
      let pulled = [];
      try { pulled = JSON.parse(exp?.odoo || 'null')?.orders || []; } catch { pulled = []; }
      const fromReport = (reportPos.get(key) || [])
        .filter((o) => !pulled.some((x) => String(x.name).toUpperCase() === String(o.name).toUpperCase()));
      const seqs = s.moves.filter((m) => ['expenses', 'split', 'part'].includes(m.kind)).map((m) => m.seq);
      if (!poList(exp?.po_numbers).length && !pulled.length && !fromReport.length) {
        exceptions.push({
          ...base, key: `nopo:${s.day}:${s.slotName}`, kind: 'expense-no-po', group: 'nopo', severity: 'warning',
          amount: r.expenses, seqs,
        });
      } else if (pulled.length || fromReport.length) {
        // The POs, as Odoo has them, against what left the drawer as
        // expenses. Typed POs not read from Odoo yet are not judged.
        const poTotal = Math.round([...pulled, ...fromReport].reduce((t, o) => t + (Number(o.total) || 0), 0));
        const gap = r.expenses - poTotal;
        if (gap !== 0) {
          exceptions.push({
            ...base, key: `pogap:${s.day}:${s.slotName}:${r.expenses}:${poTotal}`, kind: 'expense-po-gap', group: 'nopo', severity: 'warning',
            amount: gap, expenses: r.expenses, poTotal, seqs, pos: [...pulled, ...fromReport].map((o) => o.name),
          });
        }
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

  // Put on staff accounts by an admin: answered, with who carries what and why.
  const movedRows = await all(env.DB, 'SELECT * FROM till_move WHERE undone_at IS NULL AND day BETWEEN ?1 AND ?2', from, to).catch(() => []);
  const movedOf = new Map(movedRows.map((m) => [m.key, m]));
  for (const x of exceptions) {
    const m = movedOf.get(x.key);
    if (!m || x.answer) continue;
    let shares = [];
    try { shares = JSON.parse(m.shares); } catch { shares = []; }
    x.moved = {
      id: m.id, reason: m.reason, by: m.by_name, at: m.at, ownerName: m.owner_name,
      shares: shares.map((y) => ({ userId: Number(y.userId), name: y.name, amount: Number(y.amount) })),
    };
    x.answer = { answer: 'Put on a staff account', note: m.reason, by: m.by_name, at: m.at, status: 'applied' };
  }

  // A guest who paid more: a refund owed says whether it was paid back; a
  // line kept apart from the larger payment says so, to be paired again.
  const refundRows = await all(env.DB, 'SELECT * FROM guest_refund WHERE day BETWEEN ?1 AND ?2', from, to).catch(() => []);
  const refundOf = new Map(refundRows.map((r) => [r.key, r]));
  const keptApart = new Map(notSame.map((a) => [a.key, a]));
  for (const x of exceptions) {
    if (x.kind === 'paid-more') {
      const r = refundOf.get(x.key);
      x.refund = r?.paid_back_at ? { paidBack: { by: r.paid_back_by, at: r.paid_back_at } } : null;
    }
    if (x.seq != null && !['paid-more', 'paid-less'].includes(x.kind) && x.day && x.slot && x.key.startsWith(`${x.kind}:`)) {
      const line = x.key.slice(x.kind.length + 1);
      for (const what of ['paid-more', 'paid-less']) {
        const key = `${what}:${x.day}:${x.slot}:${line}`;
        const said = keptApart.get(key);
        if (said) x.split = { key, by: said.by_name, at: said.at, what };
      }
    }
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

  // One payment seen twice: laundry paid by card on the hotel's terminal and
  // not keyed in ASSD shows as a card payment ASSD lacks and as laundry ASSD
  // lacks. A card payment the laundry system took, the same amount, on the
  // same shift and within half an hour of one the terminal approved, with no
  // other that could be it, is the same money: one difference, settled by
  // one answer. "Not the same payment" keeps them apart.
  const PAIR_MINUTES = 30;
  const SPLIT = 'Not the same payment';
  const gone = new Set();
  for (const lx of exceptions.filter((x) => x.kind === 'laundry-mismatch' && x.amount < 0)) {
    const home = result.shifts.find((o) => o.day === lx.day && o.slotName === lx.slot);
    const pays = (laundryIn.get(home?.index)?.list || []).filter((p) => p.kind === 'payment' && p.method === 'card' && p.at);
    let paired = 0;
    const made = [];
    for (const p of pays) {
      const near = exceptions.filter((x) => x.kind === 'not-recorded' && x.event?.kind === 'card' && x.event.at && !gone.has(x.key)
        && x.day === lx.day && x.slot === lx.slot && x.amount === p.amount && Math.abs(minuteAt(x.event.at) - minuteAt(p.at)) <= PAIR_MINUTES);
      if (near.length !== 1) continue;
      const [card] = near;
      const rivals = pays.filter((q) => q !== p && q.amount === p.amount && Math.abs(minuteAt(q.at) - minuteAt(card.event.at)) <= PAIR_MINUTES);
      if (rivals.length) continue;
      const key = `laundry-card:${card.event.id}`;
      const said = answerOf.get(key);
      if (said?.answer === SPLIT && said.status !== 'pending') { card.split = { key, by: said.by, at: said.at }; continue; }
      const x = {
        day: lx.day, slot: lx.slot, user: lx.user, key, kind: 'laundry-card', group: lx.group, severity: 'warning',
        amount: p.amount, event: card.event, laundry: { at: p.at, ref: p.ref, amount: p.amount },
        minutesApart: Math.abs(minuteAt(card.event.at) - minuteAt(p.at)), merged: [card.key, lx.key],
        answer: said && said.status !== 'pending' ? said : card.answer || null,
        proposed: said && said.status === 'pending' ? said : null,
      };
      exceptions.push(x);
      made.push(x);
      gone.add(card.key);
      paired += p.amount;
    }
    if (!paired) continue;
    lx.amount += paired;
    lx.paired = paired;
    if (lx.amount !== 0) continue;
    // All of the laundry's difference was these payments: an answer it had is theirs.
    gone.add(lx.key);
    for (const x of made) if (!x.answer && !x.proposed && lx.answer) x.answer = lx.answer;
  }
  for (let i = exceptions.length - 1; i >= 0; i -= 1) if (gone.has(exceptions[i].key)) exceptions.splice(i, 1);

  // What people settled by correcting a movement leaves a record, answered,
  // so it can be found again under "Show answered" and undone. Without it a
  // duplicate matched away took its exception, and the drawer difference it
  // explained, off the screen with no trace.
  const labelOf = (m) => ({ expenses: 'it was expenses', safe: 'it went to the safe', split: `${m.expenses != null ? `split, part expenses` : 'split'}` })[m.kind] || m.kind;
  for (const sh of result.shifts.filter((x) => inRange(x.day))) {
    const r = register.get(sh.index);
    const drawerNow = r?.variance == null ? null : r.variance;
    const base = { day: sh.day, slot: sh.slotName, user: sh.user, event: null, drawerNow };
    for (const m of sh.moves || []) {
      if (m.kind === 'excluded' && ['duplicate', 'reverses'].includes(m.reason)) {
        exceptions.push({
          ...base, key: `matched:${m.seq}`, kind: 'movement-matched', group: 'drawer', severity: 'warning',
          seq: m.seq, pair: m.pair, amount: m.amount, reason: m.reason, undo: { seq: m.seq },
          answer: { answer: m.reason === 'duplicate' ? 'Matched as a duplicate' : 'Matched: one puts the other back', note: m.manual?.note || null, by: m.manual?.by || null, at: m.manual?.at || null },
        });
      } else if (m.manual && ['expenses', 'safe', 'split'].includes(m.kind)) {
        exceptions.push({
          ...base, key: `labelled:${m.seq}`, kind: 'movement-labelled', group: ['unlabelled', 'part'].includes(m.auto) ? 'unlabelled' : 'drawer', severity: 'warning',
          seq: m.seq, amount: m.amount, label: labelOf(m), was: m.auto || null, undo: { seq: m.seq },
          answer: { answer: `Labelled by hand: ${labelOf(m)}`, note: m.manual?.note || null, by: m.manual?.by || null, at: m.manual?.at || null },
        });
      }
    }
  }

  const byDay = new Map(daysBetween(from, to).map((d) => [d, []]));
  for (const s of placed) {
    const expense = expenseOf.get(`${s.day}|${s.slotName}`);
    let odoo = null;
    try { odoo = expense?.odoo ? JSON.parse(expense.odoo) : null; } catch { odoo = null; }
    const fromReport = (reportPos.get(`${s.day}|${s.slotName}`) || [])
      .filter((o) => !(odoo?.orders || []).some((x) => String(x.name).toUpperCase() === String(o.name).toUpperCase()));
    if (fromReport.length) odoo = { ...(odoo || {}), orders: [...(odoo?.orders || []), ...fromReport] };
    if (odoo?.orders) odoo = { ...odoo, orders: odoo.orders.map((o) => ({ ...o, reported: reported.has(String(o.name).toUpperCase()) })) };
    // A line keyed and reversed in the same shift took no money: it is not a
    // payment to find. A line whose difference has been answered is
    // accounted for.
    const cardLines = s.lines.filter((l) => l.amount > 0 && l.how !== 'corrected');
    const found = cardLines.filter((l) => l.events.length);
    const answered = cardLines.filter((l) => !l.events.length && exceptions.some((x) => x.day === s.day && x.slot === s.slotName
      && x.seq === l.seq && x.amount === l.amount && x.answer));
    byDay.get(s.day)?.push({
      day: s.day, slot: s.slotName, user: s.user, users: s.users, double: s.double, open: s.open,
      startSeq: s.startSeq, endSeq: s.endSeq,
      // More than one ASSD session on this shift (a quick log-in, a hand-over in the night): each login, in order.
      sessions: s.sessions || null,
      cash: s.cash, card: s.card, prepaid: s.prepaid, other: s.other, laundry: s.laundry, laundryCash: s.laundryCash,
      laundrySystem: laundryOfShift(s),
      cashLines: s.cashLines || [], laundryLines: s.laundryLines || [],
      drawerOut: s.drawerOut, expensesCounted: s.expensesCounted, booked: s.booked, corrected: s.corrected,
      modes: s.modes, moves: s.moves.map((m) => ({ ...m, pending: proposed.get(m.seq) || null, origins: origins.get(m.seq) || null })), opening: s.opening, closing: s.closing,
      items: s.items, stockStart: s.stockStart, stockEnd: s.stockEnd,
      expensesMoved: s.expensesMoved, safeMoved: s.safeMoved, unlabelledMoved: s.unlabelledMoved,
      lines: s.lines,
      cardFound: found.length, cardAnswered: answered.length, cardLines: cardLines.length,
      cardFoundAmount: found.reduce((t, l) => t + l.amount, 0),
      register: register.get(s.index),
      expense: expense || fromReport.length ? {
        sheetTotal: expense?.sheet_total ?? reportPaid.get(`${s.day}|${s.slotName}`) ?? null,
        sheetFrom: expense?.sheet_total != null ? 'typed' : reportPaid.has(`${s.day}|${s.slotName}`) ? 'report' : null,
        poNumbers: expense?.po_numbers ?? null, odoo, pulledAt: expense?.pulled_at ?? null,
        odooTotal: odoo?.orders?.reduce((t, o) => t + o.total, 0) ?? null,
        // Which of the POs came with the closing report rather than typed here.
        fromReport: fromReport.map((o) => o.name),
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
    formLive: Boolean(env.EXPENSE_FORM_SECRET),
    // Look-alike differences a person said are not related: not suggested again.
    notPairs: answers.filter((r) => String(r.key).startsWith('notpair:') && (r.status || 'applied') !== 'pending').map((r) => r.key),
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
  'odooTotal', 'safe', 'short', 'over', 'flaggedAmount', 'collected', 'charged', 'paid', 'balance',
  'open', 'close', 'in', 'moved', 'swapped', 'direct', 'putBack', 'fromSheet', 'poTotal', 'gap',
  'receiptsIn', 'receiptsOut', 'receiptsMoved', 'receiptsSwapped', 'directExpenses', 'left', 'still',
  'receiptsBefore', 'receiptsAfter', 'notesBefore', 'notesAfter',
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

// The drawer's own exceptions (cash, receipts, POs, laundry): acted on with
// "Correct cash movements" as well as with the bank. Card and bank lines need the bank.
const CASH_KEYS = ['drawer:', 'handover:', 'unlabelled:', 'receipts:', 'receipts-read:', 'receipts-carried:', 'nopo:', 'pogap:',
  'laundry:', 'laundry-card:', 'movement:', 'movement-twice:', 'movement-reversal:', 'matched:', 'labelled:'];
export const isCashKey = (key) => {
  const k = String(key || '');
  // "Not related" names the two it keeps apart.
  if (k.startsWith('notpair:')) return k.slice(8).split('|').every(isCashKey);
  return CASH_KEYS.some((p) => k.startsWith(p));
};

/**
 * The Shifts screen cut down to what a supervisor was given: amounts only with
 * money, the bank's side only with the bank, people's totals only with net.
 */
export function forSupervisor(payload, access) {
  // The totals across the window are the owner's view of the business, not a
  // supervisor's: never sent, whatever else they were given.
  let out = { ...payload, totals: null };
  if (!access.bank) {
    out = { ...out, exceptions: (out.exceptions || []).filter((x) => ['drawer', 'unlabelled', 'nopo', 'laundry', 'explained'].includes(x.group)) };
  }
  if (!access.net) out = { ...out, people: [] };
  if (!access.files) out = { ...out, canUpload: false };
  if (!access.money) out = withoutMoney(out);
  return { ...out, redacted: !access.money };
}

/**
 * An admin moves a payment ASSD does not show to another shift (one taken
 * just after a hand-over belongs to the shift before), saying why; or puts it
 * back where its time says (`back: true`).
 */
export async function movePayment(env, body, account) {
  const id = String(body?.eventId || '');
  if (!/^[tb]:[A-Za-z0-9_.-]{1,80}$/.test(id)) throw badRequest('Which payment?');
  if (body?.back) {
    await run(env.DB, 'DELETE FROM payment_home WHERE event_id = ?1', id);
    if (body?.key) await logEvent(env, String(body.key), 'Put back on the shift its time falls in', account?.name || account?.email || 'Owner');
    return { ok: true, back: true };
  }
  const day = String(body?.day || '');
  const slot = String(body?.slot || '');
  if (!isDay(day) || !SLOTS.includes(slot)) throw badRequest('Which shift?');
  const why = str(body?.why, 'Why', { max: 300 });
  if (!why || why.length < 3) throw badRequest('Say why it belongs to that shift.');
  const fromDay = isDay(String(body?.fromDay || '')) ? body.fromDay : null;
  const fromSlot = SLOTS.includes(body?.fromSlot) ? body.fromSlot : null;
  await run(env.DB, `INSERT INTO payment_home (event_id, day, slot, from_day, from_slot, why, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT (event_id) DO UPDATE SET day = ?2, slot = ?3, why = ?6, by_name = ?7, at = ?8`,
  id, day, slot, fromDay, fromSlot, why, account?.name || account?.email || 'Owner', new Date().toISOString().slice(0, 19).replace('T', ' '));
  if (body?.key) await logEvent(env, String(body.key), `Moved to the ${slot} shift of ${day}: “${why}”`, account?.name || account?.email || 'Owner');
  return { ok: true };
}
