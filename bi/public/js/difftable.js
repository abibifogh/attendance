/**
 * Shift differences as a table, a month at a time: what each shift's
 * differences come to, kind by kind, and where they stand.
 *
 * Every difference is signed the same way, whatever its kind stores: plus is
 * money that came in which ASSD does not show (a payment not keyed, a drawer
 * over), minus is money ASSD shows which is not there (a card that never
 * paid, a drawer short, cash out with no label or no PO). Explanations of a
 * drawer count are counted but carry no amount, so the drawer is not counted
 * twice: receipts read one way or another, a cash movement labelled by hand
 * or matched as a duplicate or a reversal, and the suggestions that one was
 * moved out twice or put back on another shift. The drawer's own difference
 * already holds every movement. Differences the rules explained by
 * themselves (info) are left out.
 */

export const COLUMNS = [['drawer', 'Drawer'], ['card', 'Card & MoMo'], ['bank', 'Bank'], ['po', 'POs & expenses'], ['laundry', 'Laundry']];
export const SLOT_ORDER = ['morning', 'afternoon', 'night'];

const BANK = new Set(['never-settled', 'reversal', 'bank-only']);
const DRAWER_KINDS = new Set(['drawer-short', 'drawer-over', 'handover-gap', 'movement-unlabelled', 'movement-twice', 'movement-reversal', 'receipts-unclear', 'receipts-carried']);
const NO_AMOUNT = new Set(['receipts-unclear', 'receipts-carried', 'movement-labelled', 'movement-matched', 'movement-twice', 'movement-reversal']);
const MINUS = new Set(['failed', 'not-found', 'paid-less', 'duplicate', 'never-settled', 'reversal', 'movement-unlabelled', 'expense-no-po', 'expense-po-gap']);
const PLUS = new Set(['not-recorded', 'paid-more', 'double-charge', 'laundry-card', 'bank-only']);

/** Which column a difference goes in. */
export function columnOf(x) {
  if (DRAWER_KINDS.has(x.kind) || ['drawer', 'unlabelled'].includes(x.group)) return 'drawer';
  if (x.kind === 'laundry-mismatch') return 'laundry';
  if (x.group === 'nopo' || String(x.kind).startsWith('expense-')) return 'po';
  if (BANK.has(x.kind)) return 'bank';
  return 'card';
}

/** A difference in pesewas: plus came in and ASSD does not show it, minus ASSD shows and it is not there. Null when hidden. */
export function signedAmount(x) {
  if (NO_AMOUNT.has(x.kind)) return 0;
  if (x.amount == null) return null;
  const a = Math.abs(Number(x.amount) || 0);
  // A keying slip says both sides: what was paid against what ASSD has.
  if (x.paid != null && x.assd != null && !['laundry-mismatch'].includes(x.kind)) return Number(x.paid) - Number(x.assd);
  // The laundry is ASSD less the laundry system: turned round, so plus is the system taking more.
  if (x.kind === 'laundry-mismatch') return -Number(x.amount);
  if (MINUS.has(x.kind)) return -a;
  if (PLUS.has(x.kind)) return a;
  return Number(x.amount) || 0;
}

/** Where a difference stands: answered (settled, matched, on a staff account), waiting for an admin, or open. */
export const standing = (x) => (x.answer ? 'answered' : x.proposed ? 'waiting' : 'open');

/** One shift's line: the net of each kind, the net of all, how many stand where, and a word for all of it. */
export function shiftLine(s, exceptions) {
  const own = exceptions.filter((x) => x.day === s.day && x.slot === s.slot && x.severity !== 'info');
  const kinds = Object.fromEntries(COLUMNS.map(([k]) => [k, 0]));
  let hidden = false;
  const counts = { open: 0, waiting: 0, answered: 0 };
  for (const x of own) {
    const v = signedAmount(x);
    if (v == null) hidden = true; else kinds[columnOf(x)] += v;
    counts[standing(x)] += 1;
  }
  const net = Object.values(kinds).reduce((t, v) => t + v, 0);
  const status = s.open && !own.length ? 'journal' : counts.open ? 'open' : counts.waiting ? 'waiting' : own.length ? 'answered' : 'agrees';
  return { s, day: s.day, slot: s.slot, user: s.user, kinds, net: hidden ? null : net, hidden, ...counts, count: own.length, status };
}

/** Every day from `from` to `to`, each with its three shifts (null where the journal has none). */
export function monthLines(shifts, exceptions, from, to) {
  const byKey = new Map(shifts.map((s) => [`${s.day}|${s.slot}`, s]));
  const out = [];
  for (let d = from; d <= to; d = nextDay(d)) {
    out.push({ day: d, slots: SLOT_ORDER.map((sl) => (byKey.has(`${d}|${sl}`) ? shiftLine(byKey.get(`${d}|${sl}`), exceptions) : null)) });
  }
  return out;
}
const nextDay = (day) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

/** The month by person: shifts, those with differences, the drawer, the net, what is still open. */
export function byPerson(lines, nameOf = (u) => u) {
  const out = new Map();
  for (const l of lines) {
    const who = nameOf(l);
    const p = out.get(who) || { who, shifts: 0, withDiff: 0, drawer: 0, net: 0, open: 0, waiting: 0 };
    p.shifts += 1;
    if (l.count) p.withDiff += 1;
    p.drawer += l.kinds.drawer;
    p.net += l.net || 0;
    p.open += l.open;
    p.waiting += l.waiting;
    out.set(who, p);
  }
  return [...out.values()].sort((a, b) => a.net - b.net || b.open - a.open || String(a.who).localeCompare(String(b.who)));
}

/** The lines as CSV, amounts in cedis, a row per shift. */
export function toCsv(lines, nameOf = (l) => l.user) {
  const cedis = (v) => (v == null ? '' : (v / 100).toFixed(2));
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ['Day', 'Shift', 'Who', ...COLUMNS.map(([, l]) => l), 'Net', 'Open', 'Waiting for admin', 'Answered', 'Status'];
  const rows = lines.map((l) => [l.day, l.slot, nameOf(l), ...COLUMNS.map(([k]) => (l.hidden ? '' : cedis(l.kinds[k]))), cedis(l.net), l.open, l.waiting, l.answered, l.status]);
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\n');
}
