import { toMinor } from '../lib/money.js';

/**
 * Reading ASSD's "Detail Journal of every Transaction".
 *
 * The journal comes as the PDF ASSD prints. The browser turns it into lines of
 * text (public/js/pdf-lines.js) and this turns the lines into entries: one per
 * ASSD transaction, in ASSD's own order, carrying what that transaction did to
 * money.
 *
 * Three facts about the journal decide everything here.
 *
 * **It has no clock.** The only time in 77 pages is the print stamp. What it
 * has instead is a running transaction number on every entry, and a
 * `Beginn of Day Processing <user>` entry at every hand-over. Everything
 * between two of those markers is one shift, held by the user on the marker —
 * and cut that way, 20 of 21 shifts in the first week of August 2026 agree
 * with the control sheet to the cedi.
 *
 * **The Money Count is a count of the drawer.** Its denomination lines are
 * the notes and coins in it, and its `Total Expenses PAID` line is receipts
 * for things bought out of it. A shift's first count is its opening, its last
 * is its closing, and the next shift's first count should equal that.
 *
 * **Expenses and safe drops are both Cash Movements.** A Cash Movement takes
 * money out of register 001, the front-desk drawer, into register 015, and
 * says nothing about why. Every movement is posted twice, once per register,
 * so only the 001 side is read. What a movement was comes from the count done
 * just before it (see `labelMovements`). A mistaken movement put back by
 * somebody else is an equal movement the other way.
 *
 * **ASSD balances the drawer itself.** Opening count + cash taken − cash
 * moved out, against the closing count, is the figure ASSD books as an
 * `End cash deficit/surplus`. In the first week of August 2026 the two agreed
 * on every shift.
 *
 * Money comes out in whole pesewas. ASSD prints `1.763,00` and `-2.740,00`.
 */

/** Blocks that record the state of the drawer rather than a sale. */
const ADMIN = new Set([
  'Open Cash Register', 'Money Count', 'Items Count', 'Beginn of Day Processing',
  'Balance carrying forward', 'Cash Movement',
  'Begin cash deficit/surplus', 'End cash deficit/surplus',
]);

/**
 * ASSD's own booking of a drawer that did not agree, when a user opened or
 * closed it: `End cash deficit/surplus`, with a `Cash -2,00` line. It is not
 * takings and is never added to cash. It equals the closing count less what
 * should have been in the drawer, which is how the reading of counts and
 * movements here is checked.
 */
const DEFICIT = /^(Begin|End) cash deficit\/surplus$/;

/** The article number ASSD uses for the laundry. */
export const LAUNDRY_ARTICLE = '540';
/** The front-desk drawer, as ASSD numbers its registers. */
export const DRAWER = '001';

const NOISE = /^(=====|EHC\/|Business Reports|Journal( Number| Transaction Number)?:|POS Number:|Invoice (Number|Date):|Benefit Date:|Type of Report:)/;
// A block starts at the left margin with its kind, then the ASSD user in capitals.
const HEAD = /^([A-Z][A-Za-z]+(?: [A-Za-z/]+){0,4})\s{2,}([A-Z][A-Z0-9]+)\b/;
const NUMBER = /^\s*\d\d-\d{3}-(\d{4,})\s+(\S+)\s+(\d\d\.\d\d\.\d\d)\b/;
const MONEY = /-?\d{1,3}(?:\.\d{3})*,\d\d/g;
const PAYMENT = /^\s*(\d\d\.\d\d\.\d\d)\s+(?!\d{3}\s)(.+?)\s+(-?\d{1,3}(?:\.\d{3})*,\d\d)\s*GHS\s*$/;
const ARTICLE = /^\s*(\d\d\.\d\d\.\d\d)\s+(\d{3})\s+(.+?)\s{2,}(-?\d+)\s+(.*)$/;
const COUNT = /^\s*\.\s*\.\s+(\d{5})\s+(.+?)\s{2,}(\d+)\s+(\d{1,3}(?:\.\d{3})*,\d\d)\s+(\d{1,3}(?:\.\d{3})*,\d\d)\s*GHS/;
const MOVEMENT = /^\s*(\d\d\.\d\d\.\d\d)\s+(-?\d{1,3}(?:\.\d{3})*,\d\d)\s*GHS\s*$/;

/**
 * The benefit-date window an export was run for: `Benefit Date: 01.08.26 07.08.26`.
 *
 * It matters because ASSD prints only the lines of a transaction whose date
 * falls inside it. A reservation made on 24 July shows its August nights and
 * its August payments in an August export and nothing else; the same
 * transaction in a July export shows the rest. Each export is therefore the
 * truth about its own window and silent about everything outside it.
 */
export function journalWindow(lines) {
  for (const raw of lines) {
    const m = /Benefit Date:\s*(\d\d\.\d\d\.\d\d)\s+(\d\d\.\d\d\.\d\d)/.exec(String(raw));
    if (m) return { from: assdDate(m[1]), to: assdDate(m[2]) };
  }
  return null;
}

/**
 * One transaction as already stored, and as a new export prints it → the
 * transaction as it now stands.
 *
 * Inside the new export's window, the new export wins: its lines replace the
 * stored ones, so a correction in ASSD reaches Insight by exporting again.
 * Outside it, the stored lines stay, because the new export could not have
 * printed them. Without a window (a file with no header) the new one wins
 * outright.
 */
export function mergeEntry(stored, fresh, window) {
  if (!stored || !window) return fresh;
  const inside = (d) => d >= window.from && d <= window.to;
  return {
    ...fresh,
    payments: [...stored.payments.filter((p) => !inside(p.date)), ...fresh.payments],
    laundry: [...(stored.laundry || []).filter((l) => !inside(l.date)), ...fresh.laundry],
  };
}

/** `1.763,00` → 176300. */
export function assdMoney(text) {
  return toMinor(String(text).replace(/\./g, '').replace(',', '.'));
}

/** `01.08.26` → `2026-08-01`. */
export function assdDate(text) {
  const [d, m, y] = String(text).split('.');
  return `20${y}-${m}-${d}`;
}

/** What a payment line's method text means. Unknown text is kept, not guessed. */
export function methodOf(text) {
  const t = String(text).toUpperCase();
  if (/\bCASH\b/.test(t)) return 'cash';
  if (/\bCR\.|CREDIT CARD/.test(t)) return 'card';
  if (/PRE-?BAN|PREPAID/.test(t)) return 'prepaid';
  return 'other';
}

/**
 * Lines → entries.
 *
 * A block split across a page break comes back as two blocks with the same
 * number, the second one repeating the header; they are one entry.
 */
export function parseJournal(lines) {
  const blocks = [];
  let block = null;

  for (const raw of lines) {
    const line = String(raw).replace(/\t/g, '    ').replace(/\s+$/, '');
    if (!line.trim() || NOISE.test(line.trim())) continue;

    const head = HEAD.exec(line);
    if (head && !/^\d/.test(line)) {
      block = { kind: head[1].trim(), user: head[2], seq: null, lines: [] };
      blocks.push(block);
      continue;
    }
    if (!block) continue;

    const number = NUMBER.exec(line);
    if (number && block.seq === null) {
      block.seq = Number(number[1]);
      block.ref = number[2];
      block.date = assdDate(number[3]);
      continue;
    }
    block.lines.push(line);
  }

  const merged = [];
  for (const b of blocks) {
    if (b.seq === null) continue;
    const last = merged[merged.length - 1];
    if (last && last.seq === b.seq && last.kind === b.kind) { last.lines.push(...b.lines); continue; }
    merged.push(b);
  }
  merged.sort((a, b) => a.seq - b.seq);

  return merged.map(readBlock);
}

function readBlock(b) {
  const entry = {
    seq: b.seq,
    kind: b.kind,
    user: b.user,
    date: b.date,
    register: String(b.ref || '').split('/')[0] || null,
    payments: [],
    laundry: [],
    expensesCounted: null,
    counted: 0,
    movement: 0,
    booked: 0,
  };
  const sale = !ADMIN.has(b.kind);

  for (const line of b.lines) {
    if (b.kind === 'Money Count') {
      const c = COUNT.exec(line);
      if (c) {
        const amount = assdMoney(c[5]);
        if (c[1] === '00099' || /expenses/i.test(c[2])) entry.expensesCounted = (entry.expensesCounted || 0) + amount;
        else entry.counted += amount;
      }
      continue;
    }
    if (b.kind === 'Cash Movement') {
      const m = MOVEMENT.exec(line);
      if (m) entry.movement += assdMoney(m[2]);
      continue;
    }
    if (DEFICIT.test(b.kind)) {
      const pay = PAYMENT.exec(line);
      if (pay) entry.booked += assdMoney(pay[3]);
      continue;
    }
    if (!sale) continue;

    const article = ARTICLE.exec(line);
    if (article) {
      const amounts = article[5].match(MONEY) || [];
      const amount = amounts.length ? assdMoney(amounts[amounts.length - 1]) : 0;
      if (article[2] === LAUNDRY_ARTICLE || /laundry/i.test(article[3])) {
        entry.laundry.push({ date: assdDate(article[1]), amount });
      }
      continue;
    }
    const pay = PAYMENT.exec(line);
    if (pay) {
      entry.payments.push({ date: assdDate(pay[1]), method: methodOf(pay[2]), label: pay[2].replace(/\s+/g, ' ').trim(), amount: assdMoney(pay[3]) });
    }
  }
  return entry;
}

/**
 * Entries → shifts.
 *
 * A shift is everything from one hand-over marker to the next. Two markers in
 * a row by the same person are one shift (it happens: somebody opens the day,
 * is interrupted, opens it again), and so is a person's marker directly after
 * their own shift.
 *
 * Whatever comes before the first marker in the file belongs to a shift that
 * started before the file did. It is returned separately, not dropped and not
 * folded into the first shift, because the first shift did not take it.
 */
export function segment(entries) {
  const shifts = [];
  const before = [];
  let current = null;

  for (const e of entries) {
    if (e.kind === 'Beginn of Day Processing') {
      if (current && current.user === e.user) continue;
      current = { user: e.user, startSeq: e.seq, markerDate: e.date, entries: [] };
      shifts.push(current);
      continue;
    }
    if (current) current.entries.push(e);
    else before.push(e);
  }
  return { shifts: shifts.map(summarise), before };
}

/** The money of one shift, as ASSD recorded it. */
export function summarise(shift) {
  const s = {
    user: shift.user,
    startSeq: shift.startSeq,
    endSeq: shift.entries.length ? shift.entries[shift.entries.length - 1].seq : shift.startSeq,
    markerDate: shift.markerDate,
    cash: 0, card: 0, prepaid: 0, other: 0,
    modes: {},
    laundry: 0, laundryCash: 0,
    drawerOut: 0,
    expensesCounted: 0,
    booked: [],
    cards: [],
    users: {},
    backOffice: [],
    opening: null,
    closing: null,
    moves: [],
    expensesMoved: 0,
    safeMoved: 0,
    unlabelledMoved: 0,
  };
  const counts = [];
  const movements = [];

  for (const e of shift.entries) {
    s.users[e.user] = (s.users[e.user] || 0) + 1;
    // Back-office entries (a prepayment moved between accounts on register
    // 015) are posted while a shift is open but never touched its drawer.
    if (e.register !== DRAWER) {
      if (e.payments.length) s.backOffice.push({ seq: e.seq, kind: e.kind, user: e.user });
      continue;
    }
    let paidCash = 0;
    let paidOther = 0;
    for (const p of e.payments) {
      s[p.method] += p.amount;
      s.modes[p.label] = (s.modes[p.label] || 0) + p.amount;
      if (p.method === 'cash') paidCash += p.amount;
      else paidOther += p.amount;
      if (p.method === 'card') s.cards.push({ seq: e.seq, date: p.date, amount: p.amount, user: e.user });
    }
    const laundry = e.laundry.reduce((sum, l) => sum + l.amount, 0);
    s.laundry += laundry;
    // Laundry paid in cash: a laundry sale settled wholly in cash. A mixed
    // settlement is counted as card, because the cash it drew is unknowable.
    if (laundry && paidCash >= laundry && !paidOther) s.laundryCash += laundry;

    if (DEFICIT.test(e.kind) && e.booked) {
      s.booked.push({ seq: e.seq, user: e.user, when: e.kind.startsWith('End') ? 'close' : 'open', amount: e.booked });
    }
    if (e.kind === 'Money Count') {
      const receipts = e.expensesCounted || 0;
      counts.push({ seq: e.seq, user: e.user, notes: e.counted, receipts, total: e.counted + receipts, at: movements.length });
    }
    if (e.kind === 'Cash Movement') movements.push({ seq: e.seq, user: e.user, amount: -e.movement, countsBefore: counts.length });
  }

  s.drawerOut = movements.reduce((t, m) => t + m.amount, 0);
  s.opening = counts[0] || null;
  s.closing = counts.length > 1 ? counts[counts.length - 1] : null;
  s.moves = labelMovements(movements, counts);
  for (const m of s.moves) {
    if (m.kind === 'expenses') s.expensesMoved += m.amount;
    else if (m.kind === 'safe') s.safeMoved += m.amount;
    else if (m.kind === 'split') { s.expensesMoved += m.expenses; s.safeMoved += m.safe; }
    else if (m.kind === 'part') { s.expensesMoved += m.expenses; s.unlabelledMoved += m.amount - m.expenses; }
    else if (m.kind === 'unlabelled') s.unlabelledMoved += m.amount;
  }
  s.expensesCounted = s.expensesMoved;
  // The drawer by ASSD's own counts: what the shift's first count found,
  // plus the cash it took, less what it moved out, against its last count.
  // ASSD books the same difference as an End cash deficit/surplus.
  if (s.opening && s.closing) {
    s.expected = s.opening.total + s.cash - s.drawerOut;
    s.countVariance = s.closing.total - s.expected;
  } else {
    s.expected = null;
    s.countVariance = null;
  }
  return s;
}

/**
 * What each Cash Movement out of the drawer was.
 *
 * A movement says only an amount: front drawer to the back office. What
 * labels it is the Money Count done just before it, whose notes are cash and
 * whose "Total Expenses PAID" line is the receipts for what was bought out of
 * the drawer. So, in order:
 *
 * - a movement put straight back by an equal movement the other way is a
 *   correction, and both are set aside (a 17,630 keyed for 1,763);
 * - a movement equal to the count's notes plus receipts is both: the receipts
 *   are expenses and the notes went to the safe;
 * - a movement no bigger than the receipts is expenses;
 * - a movement bigger than the receipts is the receipts as expenses and the
 *   rest not labelled;
 * - a movement equal to the count's notes, with no receipts, is cash to the
 *   safe;
 * - anything else is not labelled in ASSD. The expense sheet's total, typed on
 *   the Shifts screen, settles it.
 *
 * Each count's receipts are used once.
 */
export function labelMovements(movements, counts) {
  const out = [];
  const done = new Set();
  for (let i = 0; i < movements.length; i += 1) {
    if (done.has(i)) continue;
    const m = movements[i];
    const undo = movements.findIndex((x, j) => j > i && !done.has(j) && x.amount === -m.amount);
    if (m.amount !== 0 && undo >= 0) {
      done.add(i);
      done.add(undo);
      out.push({ seq: m.seq, user: m.user, amount: m.amount, kind: 'corrected', reversedBy: movements[undo].seq, reversedByUser: movements[undo].user });
      continue;
    }
    if (m.amount <= 0) {
      out.push({ seq: m.seq, user: m.user, amount: m.amount, kind: 'returned' });
      continue;
    }
    const before = counts.slice(0, m.countsBefore);
    const withReceipts = [...before].reverse().find((c) => c.receipts && !c.used);
    const last = before[before.length - 1];
    if (withReceipts && withReceipts.notes + withReceipts.receipts === m.amount) {
      withReceipts.used = true;
      // A count of receipts and nothing else, moved whole, is expenses alone.
      out.push(withReceipts.notes
        ? { seq: m.seq, user: m.user, amount: m.amount, kind: 'split', expenses: withReceipts.receipts, safe: withReceipts.notes, count: withReceipts.seq }
        : { seq: m.seq, user: m.user, amount: m.amount, kind: 'expenses', count: withReceipts.seq });
    } else if (withReceipts && m.amount <= withReceipts.receipts) {
      withReceipts.used = true;
      out.push({ seq: m.seq, user: m.user, amount: m.amount, kind: 'expenses', count: withReceipts.seq });
    } else if (withReceipts) {
      withReceipts.used = true;
      out.push({ seq: m.seq, user: m.user, amount: m.amount, kind: 'part', expenses: withReceipts.receipts, count: withReceipts.seq });
    } else if (last && !last.receipts && last.notes === m.amount) {
      out.push({ seq: m.seq, user: m.user, amount: m.amount, kind: 'safe', count: last.seq });
    } else {
      out.push({ seq: m.seq, user: m.user, amount: m.amount, kind: 'unlabelled' });
    }
  }
  return out;
}
