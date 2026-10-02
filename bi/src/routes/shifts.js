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

export async function saveAnswer(env, body, account) {
  const key = str(body?.key, 'Exception', { required: true, max: 200 });
  const answer = str(body?.answer, 'Answer', { max: 60 });
  const note = str(body?.note, 'Note', { max: 600 });
  if (!answer) {
    await run(env.DB, 'DELETE FROM shift_answer WHERE key = ?1', key);
    return { ok: true };
  }
  await run(env.DB, `INSERT INTO shift_answer (key, answer, note, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (key) DO UPDATE SET answer = ?2, note = ?3, by_name = ?4, at = ?5`,
  key, answer, note, who(account), now());
  return { ok: true };
}

// ------------------------------------------------------------------ read --

/**
 * Everything the Shifts screen shows for a window of days.
 */
export async function shifts(env, query, account) {
  let { from, to } = resolveRange(query, 'UTC', { days: 7 });
  if (daysBetween(from, to).length > MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  const canUpload = Boolean(account?.isOwner || account?.bootstrap);

  const uploads = await all(env.DB, 'SELECT kind, name, from_day, to_day, rows, note, by_name, at FROM shift_upload ORDER BY id DESC LIMIT 40');
  const coverage = coverageOf(uploads);
  const base = { range: { from, to }, canUpload, uploads: uploads.slice(0, 12).map(uploadView), coverage, groups: GROUPS };

  // The journal around the window: from the hand-over two days before it to
  // the first hand-over more than two days after it.
  const markers = await all(env.DB, `SELECT seq, day FROM assd_entry WHERE kind = ?1 AND day BETWEEN ?2 AND ?3 ORDER BY seq`,
    MARKER, addDays(from, -2), addDays(to, 2));
  if (!markers.length) return { ...base, days: [], exceptions: [], people: [], totals: null, empty: 'journal' };
  const lo = markers[0].seq;
  const after = await first(env.DB, 'SELECT MIN(seq) AS seq FROM assd_entry WHERE kind = ?1 AND seq > ?2 AND day > ?3',
    MARKER, markers[markers.length - 1].seq, addDays(to, 2));
  const hi = after?.seq ? after.seq - 1 : Number.MAX_SAFE_INTEGER;
  const rows = await all(env.DB, 'SELECT seq, kind, staff, day, register, data FROM assd_entry WHERE seq BETWEEN ?1 AND ?2 ORDER BY seq', lo, hi);
  const entries = rows.map(entryOf);
  const lastMarker = await first(env.DB, 'SELECT MAX(seq) AS seq FROM assd_entry WHERE kind = ?1', MARKER);
  // The journal ends inside its last shift unless a later hand-over exists.
  const open = !after?.seq && lastMarker?.seq === markers[markers.length - 1].seq;

  const { shifts: raw } = segment(entries);
  const lo3 = addDays(from, -3);
  const hi3 = addDays(to, 3);
  const terminal = await all(env.DB, 'SELECT * FROM terminal_txn WHERE day BETWEEN ?1 AND ?2', lo3, hi3);
  const bank = await all(env.DB, `SELECT * FROM bank_card_txn WHERE (day BETWEEN ?1 AND ?2) OR (card_day BETWEEN ?1 AND ?2)`, lo3, addDays(to, 10));

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

  // What people typed.
  const counts = await all(env.DB, 'SELECT * FROM shift_count WHERE day BETWEEN ?1 AND ?2', addDays(from, -3), to);
  const expenses = await all(env.DB, 'SELECT * FROM shift_expense WHERE day BETWEEN ?1 AND ?2', from, to);
  const answers = await all(env.DB, 'SELECT * FROM shift_answer');
  const answerOf = new Map(answers.map((a) => [a.key, { answer: a.answer, note: a.note, by: a.by_name, at: a.at }]));

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
    // Expenses: the expense sheet when it has been typed; otherwise what the
    // counts before each movement label as receipts. Whatever no count
    // labels stays "not labelled" rather than being guessed into either.
    const sheet = expense?.sheet_total ?? null;
    const expenses = sheet ?? s.expensesMoved;
    const toSafe = sheet != null ? Math.max(0, out - sheet) : s.safeMoved;
    const unlabelled = sheet != null ? 0 : s.unlabelledMoved;
    register.set(s.index, {
      opening, openingFrom, cashIn: s.cash, laundryCash: s.laundryCash, out,
      expenses, toSafe, unlabelled, expensesFrom: sheet != null ? 'sheet' : 'assd',
      expected, closing, closingFrom,
      receiptsAtClose: closingFrom === 'assd' ? s.closing.receipts : null,
      variance: expected != null && closing != null ? closing - expected : null,
      assdVariance: s.countVariance,
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
    for (const m of s.moves.filter((x) => x.kind === 'corrected')) {
      exceptions.push({
        ...base, key: `movement:${m.seq}`, kind: 'movement-corrected', group: 'explained', severity: 'info',
        seq: m.seq, amount: m.amount, by: m.user, reversedBy: m.reversedByUser, reversedSeq: m.reversedBy,
      });
    }
  }

  for (const x of exceptions) x.answer = answerOf.get(x.key) || null;

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
      drawerOut: s.drawerOut, expensesCounted: s.expensesCounted, booked: s.booked,
      modes: s.modes, moves: s.moves, opening: s.opening, closing: s.closing,
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
  let laundrySystem = [];
  try {
    laundrySystem = await all(env.DB, `SELECT day, SUM(net) AS net, SUM(cash) AS cash FROM fact_revenue
      WHERE line_id = 'laundry' AND day BETWEEN ?1 AND ?2 GROUP BY day`, from, to);
  } catch { laundrySystem = []; }
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
