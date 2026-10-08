/**
 * What does not agree on a shift, and whose it is to answer.
 *
 * Staff close their shift in HIVE: a cash total for the drawer, the envelopes
 * they put in the safe, the PO number for each expense, the rentals they
 * counted and the front desk checks. This sets that report beside what ASSD
 * recorded for the same shift and says, per person, what still needs them.
 *
 * Everything here is pure: shifts, reports and settings in, issues out. The
 * route reads the databases and the screens show the result.
 *
 * WHOSE IT IS. A shift belongs to whoever closed it in HIVE. A shift nobody
 * closed belongs to the HIVE login mapped to its ASSD user, where there is one.
 *
 * MONEY OUT OF THE DRAWER. ASSD records each cash movement as an amount and
 * nothing more; the count before it suggests what it was, and the suggestion
 * is wrong often enough that people correct it. So what staff are held to is
 * the total: everything that left the drawer has to be in a safe envelope or
 * covered by a confirmed PO. The envelope figure is also set beside what ASSD
 * labelled safe, for whoever counts the safe.
 */

export const SLOTS = ['morning', 'afternoon', 'night'];

/** Kinds an issue can be, with the words a person reads. */
export const KINDS = {
  drawer: 'The drawer did not agree',
  unexplained: 'Cash left the drawer with no envelope or PO',
  overclaimed: 'Envelopes and POs add up to more than left the drawer',
  rental: 'A rental count did not agree with ASSD',
  noreport: 'No closing report',
};

/** Outcomes that settle an issue for good. "back" sends it back to the person. */
export const FINAL = new Set(['accept', 'recover', 'cash', 'writeoff']);

const sum = (list, f) => list.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const cedis = (minor) => `GH₵ ${(Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, word) => `${n} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

/** A report row from HIVE, with its JSON read. */
export function readReport(row) {
  const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
  return {
    id: row.id,
    day: row.day,
    slot: row.slot,
    userId: Number(row.user_id),
    name: row.name,
    floatOk: Boolean(row.float_ok),
    floatDiff: row.float_diff ?? null,
    floatNote: row.float_note || null,
    cash: Number(row.cash) || 0,
    toSafe: Boolean(row.to_safe),
    envelopes: parse(row.envelopes, []),
    expenses: parse(row.expenses, []),
    rentals: parse(row.rentals, {}),
    checks: parse(row.checks, []),
    note: row.note || null,
    signedAt: row.signed_at,
    device: row.device || null,
  };
}

/** Pesewas staff put in the safe, by their own envelopes. */
export const envelopeTotal = (report) => (report?.toSafe ? sum(report.envelopes || [], (e) => e.amount) : 0);

/** Expenses that count: a confirmed PO, up to its total, once. */
export function countedPos(pos, day, slot) {
  return pos.filter((p) => p.day === day && p.slot === slot)
    .reduce((t, p) => t + Math.min(Number(p.paid) || 0, Number(p.total) || 0), 0);
}

/**
 * Everything staff wrote set beside ASSD, for one shift.
 *
 * `shift` is a shift as the Shifts screen has it; `report` may be missing.
 */
export function compare(shift, report, { pos = [], rentals = [] } = {}) {
  const r = shift.register || {};
  const out = r.out ?? shift.drawerOut ?? 0;
  const counted = countedPos(pos, shift.day, shift.slot);
  const envelopes = envelopeTotal(report);
  const rentalRows = rentals.map((rental) => {
    const typed = report?.rentals?.[rental.id] || null;
    const net = Number(shift.items?.[rental.article] || 0);
    const start = typed?.start ?? null;
    const end = typed?.end ?? null;
    const expected = start == null ? null : start - net;
    return {
      id: rental.id,
      label: rental.label,
      unit: rental.unit,
      start,
      end,
      rented: net > 0 ? net : 0,
      returned: net < 0 ? -net : 0,
      expected,
      gap: expected == null || end == null ? null : end - expected,
      assdStock: shift.stockEnd?.[rental.article] ?? null,
      deposit: rental.deposit,
    };
  });
  const safeLabelled = shift.safeMoved ?? null;
  const unlabelled = shift.unlabelledMoved ?? 0;
  const staffCash = report ? report.cash : null;
  const assdClosing = r.closing ?? null;
  return {
    // Agree or not, without the amounts: what a supervisor who is not shown
    // money still needs to see.
    safeAgrees: report && safeLabelled != null
      ? envelopes === safeLabelled || (unlabelled > 0 && envelopes === safeLabelled + unlabelled) : null,
    countAgrees: staffCash != null && assdClosing != null ? staffCash === assdClosing : null,
    out,
    safeLabelled,
    expensesLabelled: shift.expensesMoved ?? null,
    unlabelled: shift.unlabelledMoved ?? null,
    envelopes,
    counted,
    // Positive: money left the drawer that nothing accounts for.
    unexplained: report ? out - envelopes - counted : null,
    staffCash,
    assdClosing,
    variance: r.variance ?? null,
    rentals: rentalRows,
  };
}

/**
 * Issues, per person.
 *
 * - `shifts`: shifts as the Shifts screen has them (`day`, `slot`, `user`,
 *   `open`, `register`, `drawerOut`, `items`, `stockEnd`, …).
 * - `reports`: HIVE reports, read with `readReport`.
 * - `pos`: confirmed POs claimed in HIVE.
 * - `rentals`: the rentals being counted.
 * - `people`: ASSD user → HIVE user id, for shifts nobody closed.
 * - `since`: the first day reports were asked for. A shift before it is not
 *   anybody's missing report.
 * - `threshold`: a difference this small or smaller is left alone.
 */
export function issuesFor({ shifts, reports, pos = [], rentals = [], people = new Map(), since = null, threshold = 0 }) {
  const out = [];
  const reportOf = new Map();
  for (const r of [...reports].sort((a, b) => String(a.signedAt).localeCompare(String(b.signedAt)))) {
    const key = `${r.day}|${r.slot}`;
    if (!reportOf.has(key)) reportOf.set(key, r);
  }
  const big = (minor) => Math.abs(minor) > threshold;

  for (const s of shifts) {
    if (s.open) continue;
    const report = reportOf.get(`${s.day}|${s.slot}`) || null;
    const owner = report ? report.userId : (people.get(s.user) ?? null);
    const base = { day: s.day, slot: s.slot, assdUser: s.user, userId: owner, reportId: report?.id ?? null };
    const c = compare(s, report, { pos, rentals });

    if (!report) {
      if (since && s.day >= since) {
        out.push({ ...base, key: `noreport:${s.day}:${s.slot}`, kind: 'noreport', amount: 0, text: 'No closing report was sent for this shift.' });
      }
    }

    const variance = c.variance;
    if (variance != null && variance !== 0 && big(variance)) {
      out.push({
        ...base, key: `drawer:${s.day}:${s.slot}`, kind: 'drawer', amount: variance,
        text: `ASSD's closing count was ${cedis(c.assdClosing ?? 0)}, ${cedis(variance)} ${variance < 0 ? 'less' : 'more'} than the drawer should have held.`,
      });
    }

    if (report && c.unexplained != null && c.unexplained !== 0 && big(c.unexplained)) {
      const parts = [`ASSD moved ${cedis(c.out)} out of the drawer`];
      parts.push(c.envelopes ? `your envelopes come to ${cedis(c.envelopes)}` : 'you put nothing in the safe');
      parts.push(c.counted ? `confirmed POs cover ${cedis(c.counted)}` : 'no confirmed PO covers any of it');
      out.push(c.unexplained > 0
        ? {
          ...base, key: `unexplained:${s.day}:${s.slot}`, kind: 'unexplained', amount: -c.unexplained,
          text: `${parts.join('; ')}. ${cedis(c.unexplained)} is not accounted for. Add the PO number if it was an expense.`,
        }
        : {
          ...base, key: `overclaimed:${s.day}:${s.slot}`, kind: 'overclaimed', amount: -c.unexplained,
          text: `${parts.join('; ')}. That is ${cedis(-c.unexplained)} more than left the drawer.`,
        });
    }

    for (const row of c.rentals) {
      if (row.gap == null || row.gap === 0) continue;
      const said = row.rented ? `ASSD has ${plural(row.rented, `${row.unit} deposit`)}` : `ASSD has no ${row.unit} deposit`;
      const back = row.returned ? ` and ${plural(row.returned, 'refund')}` : '';
      out.push({
        ...base, key: `rental:${row.id}:${s.day}:${s.slot}`, kind: 'rental', rental: row.id,
        qty: row.gap, amount: row.gap * row.deposit,
        text: `You counted ${row.start} ${row.unit}s at the start and ${row.end} at the end. ${said}${back} on your shift, so ${row.expected} were expected.`,
      });
    }
  }
  return out;
}

/**
 * Where each issue stands for its person.
 *
 * `answers` come from HIVE (`key`, `user_id`, `how`, `text`, `at`), and
 * `resolutions` from here. The latest decision wins; "back" reopens it for
 * anything said before it.
 */
export function withStatus(issues, { answers = [], resolutions = [] } = {}) {
  const latest = (list, issue) => list
    .filter((x) => x.key === issue.key && Number(x.user_id ?? x.hive_user_id) === Number(issue.userId))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.id ?? 0) - (b.id ?? 0))
    .pop() || null;
  return issues.map((issue) => {
    const decision = latest(resolutions, issue);
    const answer = latest(answers, issue);
    let status = 'open';
    if (decision && FINAL.has(decision.outcome)) status = 'settled';
    else if (answer && (!decision || String(answer.at) > String(decision.at))) status = 'answered';
    return {
      ...issue,
      status,
      answer: answer ? { how: answer.how, text: answer.text, po: answer.po || null, at: answer.at } : null,
      decision: decision ? { outcome: decision.outcome, note: decision.note, by: decision.by_name, at: decision.at, amount: decision.amount } : null,
    };
  });
}
