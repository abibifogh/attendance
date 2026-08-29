import { bonusTaxOn, grossUpBonus, payeOn, round2, ssnitOn } from './tax.js';
import { TIERS, tierSplit } from './statutory.js';

/**
 * One person's month, worked out.
 *
 * THE ORDER MATTERS AND IT IS NOT THE ORDER PEOPLE EXPECT. A bonus agreed as a
 * net figure cannot be taxed until the salary beside it has been, because what
 * the bonus costs depends on the band the salary has already used up. So:
 * SSNIT first, then the salary's chargeable income, then the bonus grossed up
 * against it, and only then the tax on the whole.
 *
 * THE BONUS IS AGREED NET AND SO ARE THE DEDUCTIONS FROM IT. A scheme is worth
 * five hundred cedis in somebody's hand; a hundred cedis off for misconduct is
 * a hundred cedis out of their hand. Both are net figures, they are settled
 * against each other first, and the result is grossed up once. Grossing up
 * each half separately would have the property paying tax on money nobody
 * received.
 *
 * WHAT COMES OUT AFTER TAX IS NOT AN EXPENSE. A salary advance being repaid is
 * the person's own money going back; it comes off the net pay and it changes
 * nothing about the tax or what the person costs. Putting it anywhere else in
 * this order is the classic way to under-report a wage bill.
 */

/** One line of the payroll, from the terms of somebody's employment. */
export function computeLine({
  staff = null,
  basic = 0,
  allowances = [],
  ssnit = true,
  schemes = [],
  penalties = [],
  loans = [],
  annualBasic = null,
  bonusPaidThisYear = 0,
  rates,
  tiers = TIERS,
}) {
  const pay = round2(basic);
  const taxableAllowances = allowances.filter((a) => a.taxable !== false && a.taxable !== 0);
  const freeAllowances = allowances.filter((a) => a.taxable === false || a.taxable === 0);

  const taxableAllowance = round2(taxableAllowances.reduce((n, a) => n + round2(a.amount), 0));
  const freeAllowance = round2(freeAllowances.reduce((n, a) => n + round2(a.amount), 0));

  // ---- the bonus, before any tax is anywhere near it --------------------
  const earned = schemes.map((scheme) => ({
    id: scheme.id ?? null,
    name: scheme.name,
    award: round2(scheme.amount),
    score: round2(scheme.score),
    // The scheme's full award at a hundred per cent, scaled by what they
    // scored. Half a scheme is half the money.
    amount: round2(round2(scheme.amount) * (round2(scheme.score) / 100)),
  }));
  const bonusEarned = round2(earned.reduce((n, s) => n + s.amount, 0));

  const docked = round2(penalties.reduce((n, p) => n + round2(p.amount), 0));
  // Never below nothing. A deduction bigger than the bonus is a matter for a
  // person to settle, not something to take out of somebody's salary by
  // arithmetic nobody decided on.
  const bonusNet = Math.max(0, round2(bonusEarned - docked));
  const notTaken = round2(Math.max(0, docked - bonusEarned));

  // ---- SSNIT, which is on basic alone and comes off before tax ----------
  const contributions = ssnitOn(pay, { qualifies: ssnit, rates });
  const split = tierSplit(pay, { qualifies: Boolean(ssnit), rates, tiers });

  const salaryGross = round2(pay + taxableAllowance);
  const salaryChargeable = Math.max(0, round2(salaryGross - contributions.employee));

  // ---- the bonus, grossed up against that ------------------------------
  const yearBasic = annualBasic == null ? round2(pay * 12) : round2(annualBasic);
  const bonusContext = {
    chargeable: salaryChargeable,
    annualBasic: yearBasic,
    alreadyPaid: round2(bonusPaidThisYear),
    rates,
  };
  const grossed = bonusNet > 0
    ? grossUpBonus(bonusNet, bonusContext)
    : { gross: 0, ...bonusTaxOn(0, bonusContext) };

  // ---- the whole month --------------------------------------------------
  const gross = round2(salaryGross + freeAllowance + grossed.gross);
  const chargeable = round2(salaryChargeable + grossed.atGraduated);
  const paye = payeOn(chargeable, rates.bands);

  // The tax on the salary, told apart from the tax the bonus added, because
  // the second is the property's own doing and it should be able to see it.
  const salaryPaye = payeOn(salaryChargeable, rates.bands);
  const tax = round2(paye.tax + grossed.final);

  const loanDue = round2(loans.reduce((n, l) => n + round2(l.amount), 0));
  const net = round2(gross - contributions.employee - tax - loanDue);
  const cost = round2(gross + contributions.employer);

  // ---- how it reads on a payslip ---------------------------------------
  //
  // A bonus here is agreed net: somebody is promised four hundred and gets
  // four hundred, and the property carries the tax that makes that true. So
  // the grossed-up figure is not a number anybody was offered, and putting it
  // on a payslip under Bonus invites the one question it cannot answer —
  // "why does this say 470 when we agreed 400".
  //
  // The cost still has to be somewhere, because gross pay has to add up. It
  // goes where it belongs: with the allowances, which is what it is. The
  // person sees the bonus they agreed and an allowance line that includes what
  // the property put in, and the column still totals to the same gross.
  const carried = round2(grossed.gross - bonusNet);
  const onSlip = allowances.map((a) => ({
    name: a.name, amount: round2(a.amount), taxable: a.taxable !== false && a.taxable !== 0,
  }));

  if (carried > 0) {
    // The allowance it joins. A property that calls its one allowance
    // "Allowance" means that one; a property with a single allowance under any
    // name means that one too. Where there are several and none of them is the
    // obvious one, it goes on a line of its own rather than being added to
    // whichever happened to be first.
    const named = onSlip.find((a) => /^allowances?$/i.test(String(a.name).trim()));
    const only = onSlip.length === 1 ? onSlip[0] : null;
    const target = named ?? only;

    if (target) {
      target.amount = round2(target.amount + carried);
      target.carries = carried;
    } else {
      onSlip.push({ name: 'Allowance', amount: carried, taxable: true, carries: carried });
    }
  }

  return {
    staff,
    basic: pay,
    allowances: allowances.map((a) => ({
      name: a.name, amount: round2(a.amount), taxable: a.taxable !== false && a.taxable !== 0,
    })),
    // The same money, arranged the way a payslip says it. Kept apart from the
    // list above, which is what the property actually agreed to pay and is
    // what the journal, the GRA schedule and every export are drawn from.
    slip: {
      allowances: onSlip,
      allowanceTotal: round2(onSlip.reduce((n, a) => n + a.amount, 0)),
      bonus: bonusNet,
      carried,
    },
    allowanceTotal: round2(taxableAllowance + freeAllowance),
    taxableAllowance,
    freeAllowance,

    bonus: {
      schemes: earned,
      earned: bonusEarned,
      docked,
      // Where a deduction was bigger than the bonus it came out of. Said
      // rather than swallowed: somebody will ask where the rest went.
      notTaken,
      net: bonusNet,
      gross: grossed.gross,
      tax: round2(grossed.gross - bonusNet),
      atFinalRate: grossed.atFinalRate,
      atGraduated: grossed.atGraduated,
      headroom: grossed.headroom,
      finalTax: grossed.final,
      graduatedTax: grossed.graduated,
    },

    gross,
    chargeable,
    ssnit: {
      qualifies: Boolean(ssnit),
      employee: contributions.employee,
      employer: contributions.employer,
      // The tier 1 / tier 2 split, worked out here and kept with the line
      // rather than left to whoever draws the journal later. A closed month's
      // journal is read months afterwards, and it must say what was actually
      // paid over, not what today's percentages would come to.
      tier1: split.tier1,
      tier2: split.tier2,
      unallocated: split.unallocated,
    },
    paye: {
      total: tax,
      onSalary: salaryPaye.tax,
      onBonus: round2(tax - salaryPaye.tax),
      steps: paye.steps,
      finalOnBonus: grossed.final,
    },
    loans: loans.map((l) => ({ ...l, amount: round2(l.amount) })),
    loanTotal: loanDue,
    net,
    employerCost: cost,
    rates: { label: rates.label, ssnitEmployee: rates.ssnitEmployee, ssnitEmployer: rates.ssnitEmployer },
  };
}

/** What a whole run comes to, for the page that has to sign it off. */
export function totalsOf(lines) {
  const add = (key, of) => round2(lines.reduce((n, l) => n + (of ? of(l) : l[key]), 0));
  return {
    people: lines.length,
    basic: add('basic'),
    allowances: add(null, (l) => l.allowanceTotal),
    // The same money the way a payslip says it: the tax the property carried
    // on the bonuses counted with the allowances rather than with the bonus.
    // A totals row that split it the other way to the rows above it is a
    // column somebody has to reconcile before they can trust either.
    allowancesOnSlip: add(null, (l) => l.slip?.allowanceTotal ?? l.allowanceTotal),
    carriedOnBonus: add(null, (l) => l.slip?.carried ?? 0),
    bonusNet: add(null, (l) => l.bonus.net),
    bonusGross: add(null, (l) => l.bonus.gross),
    gross: add('gross'),
    ssnitEmployee: add(null, (l) => l.ssnit.employee),
    ssnitEmployer: add(null, (l) => l.ssnit.employer),
    paye: add(null, (l) => l.paye.total),
    loans: add('loanTotal'),
    net: add('net'),
    cost: add('employerCost'),
  };
}
