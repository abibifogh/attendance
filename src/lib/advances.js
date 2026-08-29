import { addMonths, daysInMonth, monthOf } from '../util/dates.js';

/**
 * Salary advances.
 *
 * A hotel lends money. Not officially, not at interest, and not in a way
 * anybody writes down: somebody's rent is due, the manager hands over four
 * hundred cedis, and it comes off their pay over the next few months. What
 * goes wrong is never the lending. It is that six months later nobody can say
 * how much is left, because the only record was a figure in a notebook and two
 * people remembering different Junes.
 *
 * SO THE BALANCE IS NEVER STORED. It is what was handed over less what has
 * been taken back, worked out from rows anybody can be shown. A stored balance
 * is a number with no argument behind it, and an advance is exactly the kind
 * of number people argue about.
 *
 * THE INSTALMENT IS A TERM, NOT A CALCULATION. It is worked out once, when the
 * advance is agreed, and then it is part of the agreement. If somebody pays a
 * bit extra one month the app does not quietly re-spread the rest: it takes
 * the same instalment next month and finishes sooner, which is what both sides
 * think they agreed to. Changing the instalment is something a person does on
 * purpose, and it is recorded as having been done.
 *
 * NO INTEREST, ANYWHERE. There is no rate in this file and no room for one.
 * What is lent is what comes back, and a property that wants to charge for it
 * has left the thing this was built for.
 */

/** Money, to the nearest pesewa. Everything here rounds the same way. */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const STATUSES = ['requested', 'approved', 'declined', 'withdrawn', 'settled'];

/**
 * What an advance is for, and what follows from that.
 *
 * The property lends for three reasons and treats them differently, and every
 * one of these figures was already its policy — what was missing was anywhere
 * to write it down, so it was applied from memory and differently depending on
 * who was asked.
 *
 * School fees and rent are the big, predictable ones. They come with a bill or
 * a tenancy agreement, they go to five thousand, and they are paid back over
 * ten months. Anything else is the small emergency: a thousand at most, back
 * out of the next pay packet.
 *
 * THE PERIOD IS NOT THE ASKER'S TO SET. It follows from what the money is for.
 * Somebody who needs longer says so to a person, and a person changes it —
 * which is a conversation with a decision in it rather than a box on a form.
 */
export const PURPOSES = [
  {
    key: 'school_fees',
    label: 'School fees',
    cap: 5000,
    months: 10,
    paper: 'a copy of the bill',
  },
  {
    key: 'rent',
    label: 'Rent',
    cap: 5000,
    months: 10,
    paper: 'a copy of the tenancy agreement',
  },
  {
    key: 'other',
    label: 'Something else',
    cap: 800,
    months: 1,
    paper: null,
  },
];

export const purposeOf = (key) => PURPOSES.find((p) => p.key === key) ?? null;

/**
 * Which of the three somebody may pick, given what they are asking for.
 *
 * Two rules, and both of them are about not lending twice over. Anything above
 * a thousand has to be one of the named reasons, with the paper to go with it;
 * and somebody already paying one back can only ask for the small emergency,
 * because a second ten-month advance on top of a running one is how a person
 * ends up with no pay packet at all.
 */
export function purposesFor({ hasOpen = false, amount = 0 } = {}) {
  return PURPOSES.filter((purpose) => {
    if (hasOpen && purpose.key !== 'other') return false;
    if (round2(amount) > purpose.cap) return false;
    return true;
  });
}

/**
 * Whether a request stands up, said in the words the person will read.
 *
 * Never a bare "invalid": somebody refused by a form deserves to know which
 * rule refused them, because the next thing they do is ask a manager and the
 * manager should not have to guess either.
 */
export function checkRequest({ purpose, amount, hasOpen = false, hasPaper = false }) {
  const spec = purposeOf(purpose);
  if (!spec) return { ok: false, reason: 'Say what the money is for.' };

  const asked = round2(amount);
  if (asked <= 0) return { ok: false, reason: 'An advance has to be for something.' };

  if (hasOpen && spec.key !== 'other') {
    return {
      ok: false,
      reason: 'You are still paying one back, so the only thing you can ask for now is '
        + `something else, up to ${purposeOf('other').cap}.`,
    };
  }

  if (asked > spec.cap) {
    return {
      ok: false,
      reason: spec.key === 'other'
        ? `Anything over ${spec.cap} has to be for school fees or rent, with the paper to `
          + 'go with it.'
        : `${spec.label} goes up to ${spec.cap}.`,
    };
  }

  if (spec.paper && !hasPaper) {
    return { ok: false, reason: `${spec.label} needs ${spec.paper} attached.` };
  }

  return { ok: true, reason: null, months: spec.months };
}

/** An advance still being paid back. */
export const isOpen = (advance) => advance.status === 'approved';

/**
 * The monthly instalment.
 *
 * Rounded up to the pesewa so the last month is the short one rather than the
 * long one. Somebody expecting to finish in June and finding one cedi left in
 * July has been let down by arithmetic, and it is the kind of thing that
 * sounds petty until it happens to your own pay.
 */
export function instalmentFor(amount, months) {
  const total = round2(amount);
  const over = Math.max(1, Math.trunc(Number(months) || 0));
  return round2(Math.ceil((total / over) * 100) / 100);
}

/** What is still owed, from the rows rather than from a running total. */
export function balanceOf(advance, entries = []) {
  const paid = entries.reduce((n, e) => n + (Number(e.amount) || 0), 0);
  return round2(round2(advance.amount) - round2(paid));
}

/** What has come back so far. */
export function repaidOf(entries = []) {
  return round2(entries.reduce((n, e) => n + (Number(e.amount) || 0), 0));
}

/**
 * The months still to run, at the agreed instalment.
 *
 * Whole months, rounded up, because a hundred cedis left against a two-hundred
 * instalment is still one more payday.
 */
export function monthsLeft(balance, monthly) {
  const owed = round2(balance);
  const each = round2(monthly);
  if (owed <= 0) return 0;
  if (each <= 0) return null;                 // nothing agreed, so nothing to project
  return Math.ceil(owed / each);
}

/**
 * The month a deduction is first expected.
 *
 * Money handed over on the 28th is paid back from the following month: the
 * payroll for the month it was taken in has usually been worked out already,
 * and taking it back the same month is a surprise on somebody's payslip.
 */
export function firstMonthFor(takenOn) {
  const day = String(takenOn ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const month = monthOf(day);
  const late = Number(day.slice(8, 10)) > daysInMonth(month) - 7;
  return late ? addMonths(month, 1) : month;
}

/**
 * The whole schedule: what was agreed, what has happened, what is left.
 *
 * Months already dealt with carry what was actually recorded. Months ahead
 * carry the instalment, which is a forecast and is labelled as one — the last
 * of them is whatever is left rather than a full instalment.
 */
export function scheduleFor(advance, entries = [], { asOfMonth = null } = {}) {
  const rows = [...entries].sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const start = advance.start_month || firstMonthFor(advance.taken_on) || monthOf(advance.asked_at ?? '');
  const out = [];

  // What actually happened, month by month.
  const byMonth = new Map();
  for (const entry of rows) {
    if (!byMonth.has(entry.month)) byMonth.set(entry.month, []);
    byMonth.get(entry.month).push(entry);
  }

  let running = round2(advance.amount);
  // Sorted by the month itself. A bare sort() stringifies each pair, which on
  // rows straight out of the database is a throw rather than an odd order.
  const inOrder = [...byMonth.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  for (const [month, list] of inOrder) {
    const paid = round2(list.reduce((n, e) => n + (Number(e.amount) || 0), 0));
    running = round2(running - paid);
    out.push({
      month,
      expected: round2(advance.monthly),
      paid,
      balance: Math.max(0, running),
      done: true,
      // A month somebody deliberately let go, rather than one nobody has got
      // to yet. The distinction is the difference between an arrangement and
      // an oversight.
      skipped: list.every((e) => e.kind === 'skipped'),
      note: list.map((e) => e.note).filter(Boolean).join(' · ') || null,
    });
  }

  // And what is still to come. Never into a month that has been and gone:
  // once one is let go, the months after it each move on by one, and a
  // projection that keeps planning a deduction for last July quietly takes
  // that delay back again. What is left comes off from this month onwards.
  let month = out.length ? nextMonth(out[out.length - 1].month) : start;
  if (asOfMonth && month < asOfMonth) month = asOfMonth;

  let guard = 0;
  while (running > 0.009 && guard < 240) {
    const due = Math.min(round2(advance.monthly), running);
    running = round2(running - due);
    out.push({
      month,
      expected: round2(advance.monthly),
      paid: due,
      balance: Math.max(0, running),
      done: false,
      skipped: false,
      note: null,
    });
    month = nextMonth(month);
    guard += 1;
  }

  return out;
}

/**
 * What is due off one advance in a given month, and nothing where it is not.
 *
 * The one place this is worked out, because two screens ask it — the
 * month-end close and the payroll — and they must never disagree. A month
 * already answered is not due again, and the last instalment is whatever is
 * left rather than a full one.
 */
export function dueThisMonth(advance, entries = [], month) {
  if (!isOpen(advance)) return 0;
  if ((advance.start_month || '9999-99') > month) return 0;
  if (entries.some((e) => e.month === month && ['repayment', 'skipped'].includes(e.kind))) return 0;

  const balance = balanceOf(advance, entries);
  if (balance <= 0) return 0;
  return round2(Math.min(round2(advance.monthly), balance));
}

/**
 * When the last instalment falls, or nothing where there is nothing to project.
 *
 * Give it the month it is being asked in. Without one it will happily count on
 * deductions in months that are already behind us, and the date it gives back
 * never moves however many months are let go.
 */
export function finishesOn(advance, entries = [], { asOfMonth = null } = {}) {
  const schedule = scheduleFor(advance, entries, { asOfMonth });
  const ahead = schedule.filter((row) => !row.done);
  if (!ahead.length) return null;
  return ahead[ahead.length - 1].month;
}

/**
 * What one person owes across every advance they have open.
 *
 * Two advances running side by side is two deductions in the same month, and
 * whoever does the payroll needs the sum of them rather than a screen each.
 */
export function summarise(advances, entriesBy, { asOfMonth = null } = {}) {
  let owed = 0;
  let monthly = 0;
  let taken = 0;
  let last = null;

  for (const advance of advances) {
    const entries = entriesBy.get(advance.id) ?? [];
    taken = round2(taken + round2(advance.amount));
    if (!isOpen(advance)) continue;
    const balance = balanceOf(advance, entries);
    if (balance <= 0) continue;
    owed = round2(owed + balance);
    monthly = round2(monthly + round2(advance.monthly));
    const end = finishesOn(advance, entries, { asOfMonth });
    if (end && (!last || end > last)) last = end;
  }

  return { taken, owed, monthly, finishes: last };
}

/** Whether a date is the last day of its month, which is when the asking happens. */
export function isMonthEnd(day) {
  const text = String(day ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  return Number(text.slice(8, 10)) === daysInMonth(monthOf(text));
}

const nextMonth = (month) => addMonths(month, 1);

/**
 * The months a running advance has gone through with nothing recorded at all.
 *
 * Not a skip and not a payment: an unanswered month. The month-end question is
 * how this ledger stays honest, and a property that misses it for a fortnight
 * misses it for a quarter. Left alone the gap is invisible — the balance is
 * right, because nothing was written, and the balance is what every screen
 * shows — while the finish date quietly assumes those months were paid.
 *
 * The month running is not in the list. It is not late until it is over.
 */
export function unansweredMonths(advance, entries = [], { asOfMonth = null } = {}) {
  if (!isOpen(advance) || !asOfMonth) return [];
  if (balanceOf(advance, entries) <= 0) return [];

  const start = advance.start_month || firstMonthFor(advance.taken_on);
  if (!start) return [];

  const answered = new Set(entries
    .filter((e) => ['repayment', 'skipped'].includes(e.kind))
    .map((e) => e.month));

  const out = [];
  let month = start;
  let guard = 0;
  while (month < asOfMonth && guard < 240) {
    if (!answered.has(month)) out.push(month);
    month = addMonths(month, 1);
    guard += 1;
  }
  return out;
}

/**
 * One person's whole borrowing as a running account.
 *
 * A statement, the shape a bookkeeper draws it: opening, what was handed over,
 * what came back, closing. Per person rather than per advance, because that is
 * how it is lived — somebody paying back four hundred takes another two
 * hundred in June, and asking them to add up two tables to find out what they
 * owe is asking them to take the app's word for it.
 *
 * Every row balances against the one above it, which is the only reason to
 * draw it this way rather than as a list of movements.
 */
export function accountFor(advances = [], entriesBy = new Map(), { asOfMonth = null } = {}) {
  const additions = new Map();
  const movements = new Map();
  const letGo = new Map();
  const ahead = new Map();

  const bump = (map, month, amount) => {
    if (!month) return;
    map.set(month, round2((map.get(month) ?? 0) + round2(amount)));
  };

  for (const advance of advances) {
    // What was never handed over is not on a statement. A request nobody has
    // decided is not money the person has.
    if (!['approved', 'settled'].includes(advance.status)) continue;
    const entries = entriesBy.get(advance.id) ?? [];

    // The month it was handed over, not the month repayment starts. Money in
    // somebody's hand in March is March's, even where nothing comes off until
    // April.
    bump(additions, monthOf(advance.taken_on) || advance.start_month, advance.amount);

    for (const entry of entries) {
      bump(movements, entry.month, entry.amount);
      // A month answered with nothing taken. Worth keeping apart from a month
      // nobody has reached: both are a blank in a column of figures, and only
      // one of them is somebody's decision.
      if (entry.kind === 'skipped') letGo.set(entry.month, true);
      else letGo.set(entry.month, false);
    }
    for (const row of scheduleFor(advance, entries, { asOfMonth })) {
      if (!row.done) bump(ahead, row.month, row.paid);
    }
  }

  const months = [...new Set([...additions.keys(), ...movements.keys(), ...ahead.keys()])]
    .filter(Boolean)
    .sort();
  if (!months.length) return [];

  const first = months[0];
  const last = months[months.length - 1];

  const rows = [];
  let opening = 0;
  let month = first;
  let guard = 0;
  while (month <= last && guard < 480) {
    const added = round2(additions.get(month) ?? 0);
    // A month that has been answered stands on what was answered. Only a month
    // nobody has reached yet falls back to what is expected.
    const done = movements.has(month) || additions.has(month) ? (movements.get(month) ?? 0) : null;
    const repaid = round2(done ?? ahead.get(month) ?? 0);
    const closing = round2(opening + added - repaid);
    rows.push({
      month,
      opening,
      additions: added,
      repayment: repaid,
      closing,
      // Whether this row is a record or a forecast. The screen greys one and
      // not the other, and a person reading it has to be able to tell.
      done: done !== null || (asOfMonth ? month < asOfMonth : false),
      // And where it is a record, whether the blank is a decision.
      letGo: letGo.get(month) === true && !repaid,
    });
    opening = closing;
    month = addMonths(month, 1);
    guard += 1;
  }

  return rows;
}
