import { round2 } from './tax.js';

/**
 * The two returns a Ghanaian payroll has to produce every month.
 *
 * THE JOURNAL. Nothing in this app posts to a ledger, and it should not: the
 * property keeps its books somewhere else and always will. What it can do is
 * hand over the entry to be typed, already balanced, so nobody works it out
 * from a payslip run at midnight.
 *
 * THE TIER SPLIT. The 18.5% of basic that goes to the pension is not one
 * payment. Act 766 divides it: 13.5% to SSNIT as the first tier, 5% to a
 * licensed trustee as the second, and they are remitted separately to
 * different people on different forms. A payroll that reports one figure of
 * 18.5% has not finished the job, because somebody then has to split it by
 * hand every month and will eventually split it wrong.
 *
 * The split is on basic salary, not on the employee and employer halves. The
 * worker's 5.5% and the property's 13% go into one pot and the pot is divided
 * 13.5 / 5. Which is why the tier figures do not line up with either half.
 */

/** What the mandatory pension comes to, and who each part of it goes to. */
export const TIERS = {
  // Of basic salary, under Act 766.
  tier1: 0.135,
  tier2: 0.05,
};

export function tiersFrom(settings = {}) {
  const number = (key, fallback) => {
    const value = Number(settings[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    tier1: number('pay_tier1', TIERS.tier1),
    tier2: number('pay_tier2', TIERS.tier2),
  };
}

/**
 * One person's pension for the month, split the way it is remitted.
 *
 * `total` is what leaves the property. `tier1` and `tier2` are what it is
 * split into, and they add up to it whenever the rates do.
 */
export function tierSplit(basic, { qualifies = true, rates, tiers = TIERS } = {}) {
  if (!qualifies) {
    return { employee: 0, employer: 0, total: 0, tier1: 0, tier2: 0, unallocated: 0 };
  }
  const pay = round2(basic);
  const employee = round2(pay * rates.ssnitEmployee);
  const employer = round2(pay * rates.ssnitEmployer);
  const total = round2(employee + employer);
  const tier1 = round2(pay * tiers.tier1);
  const tier2 = round2(pay * tiers.tier2);
  return {
    employee,
    employer,
    total,
    tier1,
    tier2,
    // Zero when the rates are the published ones. Not hidden if a property has
    // edited a rate into something that no longer adds up, because a return
    // that quietly loses money is worse than one that says it does not fit.
    unallocated: round2(total - tier1 - tier2),
  };
}

/**
 * The month's journal entry, balanced, in the order it is usually typed.
 *
 * Debits first: what the month cost. Then credits: what is owed to whom and
 * what actually goes out to people. Every row that would be zero is dropped,
 * because a journal with eight empty lines in it is harder to check than one
 * with four full ones.
 */
export function journalFor({ lines = [], totals, rates, tiers = TIERS }) {
  const pension = lines.reduce((acc, line) => {
    // The split the line was worked out with, wherever it has one. A closed
    // month is read out of payslips written months ago, and recomputing their
    // pension at today's percentages would have the journal disagree with what
    // was actually paid over — and with the PAYE on the line beside it, which
    // does come from the payslip. Lines written before the split was kept fall
    // back to working it out, which is what they always did.
    const split = line.ssnit?.tier1 == null
      ? tierSplit(line.basic, { qualifies: line.ssnit?.qualifies !== false, rates, tiers })
      : {
        employee: line.ssnit.employee ?? 0,
        employer: line.ssnit.employer ?? 0,
        tier1: line.ssnit.tier1 ?? 0,
        tier2: line.ssnit.tier2 ?? 0,
        unallocated: line.ssnit.unallocated ?? 0,
      };
    return {
      employee: round2(acc.employee + split.employee),
      employer: round2(acc.employer + split.employer),
      tier1: round2(acc.tier1 + split.tier1),
      tier2: round2(acc.tier2 + split.tier2),
      unallocated: round2(acc.unallocated + split.unallocated),
    };
  }, { employee: 0, employer: 0, tier1: 0, tier2: 0, unallocated: 0 });

  const sum = totals ?? {};
  // Gross pay as the ledger sees it: salary, allowances and the grossed-up
  // bonus. The bonus goes in at gross because the property is carrying the tax
  // on it, and that tax is a cost like any other.
  const wages = round2((sum.basic ?? 0) + (sum.allowances ?? 0));
  const bonus = round2(sum.bonusGross ?? 0);

  const debits = [
    { account: 'Salaries and wages', detail: 'Basic and allowances', amount: wages },
    { account: 'Bonus', detail: 'Grossed up, tax carried by the property', amount: bonus },
    {
      account: 'Employer pension contribution',
      detail: `${pct(rates.ssnitEmployer)} of basic`,
      amount: pension.employer,
    },
  ].filter((row) => row.amount > 0);

  const credits = [
    { account: 'PAYE payable (GRA)', detail: 'Employees’ tax deducted', amount: round2(sum.paye ?? 0) },
    {
      account: 'SSF payable, tier 1 (SSNIT)',
      detail: `${pct(tiers.tier1)} of basic`,
      amount: pension.tier1,
    },
    {
      account: 'SSF payable, tier 2 (trustee)',
      detail: `${pct(tiers.tier2)} of basic`,
      amount: pension.tier2,
    },
    {
      account: 'SSF payable, unallocated',
      detail: 'The rates as set do not add up to the two tiers',
      amount: pension.unallocated,
    },
    {
      account: 'Staff advances',
      detail: 'Repayments withheld this month',
      amount: round2(sum.loans ?? 0),
    },
    { account: 'Net pay', detail: 'What goes out to people', amount: round2(sum.net ?? 0) },
  ].filter((row) => row.amount > 0);

  const debitTotal = round2(debits.reduce((n, r) => n + r.amount, 0));
  const creditTotal = round2(credits.reduce((n, r) => n + r.amount, 0));

  return {
    debits,
    credits,
    debitTotal,
    creditTotal,
    // Rounding to the pesewa person by person can leave a pesewa or two in it.
    // Said rather than forced, so whoever types it knows what they are looking
    // at instead of hunting a difference the arithmetic put there.
    difference: round2(debitTotal - creditTotal),
    pension,
  };
}

const pct = (rate) => `${round2(Number(rate) * 100)}%`;

/**
 * The PAYE schedule, in the shape the GRA asks for.
 *
 * The Ghana Revenue Authority takes a monthly return listing every employee,
 * what they earned, what was deducted and what tax that came to. The columns
 * below are that return's columns, in its order and under its names, so the
 * sheet can be read straight across into the form rather than translated.
 *
 * A COLUMN THE APP CANNOT FILL IS LEFT EMPTY RATHER THAN GUESSED. Tax reliefs
 * are claimed on a certificate the GRA issues to the person, not something a
 * payroll knows about, so that column comes across as nothing and whoever
 * files it puts in what the certificates say.
 */
export const PAYE_COLUMNS = [
  { key: 'no', label: 'No.' },
  { key: 'name', label: 'Name of employee' },
  { key: 'tin', label: 'TIN / Ghana Card' },
  { key: 'ssnitNumber', label: 'SSNIT number' },
  { key: 'basic', label: 'Basic salary', money: true },
  { key: 'allowances', label: 'Cash allowances', money: true },
  { key: 'totalCash', label: 'Total cash emoluments', money: true },
  { key: 'ssf', label: 'SSF employee', money: true },
  { key: 'relief', label: 'Tax relief', money: true },
  { key: 'excessBonus', label: 'Excess bonus', money: true },
  { key: 'chargeable', label: 'Chargeable income', money: true },
  { key: 'tax', label: 'Tax on income', money: true },
  { key: 'bonus', label: 'Bonus at 5%', money: true },
  { key: 'bonusTax', label: 'Tax on bonus', money: true },
  { key: 'total', label: 'Total PAYE', money: true },
];

/** The keys a total is worth showing under. The rest are names and numbers. */
export const PAYE_TOTALLED = PAYE_COLUMNS
  .filter((c) => c.money && c.key !== 'relief').map((c) => c.key);

export function payeSchedule({ lines = [], people = new Map() }) {
  const rows = lines.map((line, i) => {
    const record = people.get(Number(line.staff?.id)) ?? {};
    const allowances = round2(line.allowanceTotal ?? 0);
    return {
      no: i + 1,
      name: line.staff?.name ?? '',
      tin: record.tin_number || '',
      ssnitNumber: record.ssnit_number || '',
      basic: round2(line.basic),
      allowances,
      // Basic, allowances and the part of the bonus past the ceiling — the
      // GRA form's column 15 is 6 + 11 + 14, and it leaves out the bonus
      // taxed at the 5% final rate on purpose: that is not assessable income,
      // it is settled separately in columns 12 and 13. Adding it in here made
      // the column read higher than the form wants and stopped the page
      // reconciling downwards, even though the chargeable income and the tax
      // beside it were right.
      totalCash: round2(line.basic + allowances + (line.bonus?.atGraduated ?? 0)),
      ssf: round2(line.ssnit?.employee ?? 0),
      // Reliefs live on a certificate the GRA issues, not in a payroll.
      relief: null,
      // The part of the bonus past the 15% ceiling. It is not a separate tax:
      // it is income, and it is already inside the chargeable figure beside
      // it. Shown because a return where the chargeable income is larger than
      // the salary and nothing on the page says why is a return that gets
      // queried.
      excessBonus: round2(line.bonus?.atGraduated ?? 0),
      chargeable: round2(line.chargeable ?? 0),
      // Everything on the graduated bands: the salary and the excess bonus
      // together, because that is one calculation and splitting it would
      // report a figure the tax table never produced.
      tax: round2((line.paye?.total ?? 0) - (line.paye?.finalOnBonus ?? 0)),
      bonus: round2(line.bonus?.atFinalRate ?? 0),
      bonusTax: round2(line.paye?.finalOnBonus ?? 0),
      total: round2(line.paye?.total ?? 0),
    };
  });

  const add = (key) => round2(rows.reduce((n, r) => n + (Number(r[key]) || 0), 0));
  return {
    rows,
    totals: {
      basic: add('basic'),
      allowances: add('allowances'),
      totalCash: add('totalCash'),
      ssf: add('ssf'),
      excessBonus: add('excessBonus'),
      chargeable: add('chargeable'),
      tax: add('tax'),
      bonus: add('bonus'),
      bonusTax: add('bonusTax'),
      total: add('total'),
    },
  };
}
