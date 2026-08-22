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

  // And what is still to come.
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

/** When the last instalment falls, or nothing where there is nothing to project. */
export function finishesOn(advance, entries = []) {
  const schedule = scheduleFor(advance, entries);
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
export function summarise(advances, entriesBy) {
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
    const end = finishesOn(advance, entries);
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
