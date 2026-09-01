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
 * THE BONUS IS NORMALLY AGREED NET, AND SO ARE THE DEDUCTIONS FROM IT. A
 * scheme is worth five hundred cedis in somebody's hand; a hundred cedis off
 * for misconduct is a hundred cedis out of their hand. Both are net figures,
 * they are settled against each other first, and the result is grossed up
 * once. Grossing up each half separately would have the property paying tax
 * on money nobody received.
 *
 * Where somebody's figures were agreed gross instead, bonusIsNet says so and
 * the grossing up is skipped. Everything after that is the same, because a
 * gross figure is only a net one that has already had the sum done to it.
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
  bonusIsNet = true,
  // A take-home agreed with the person: what they are to receive this month
  // before anything they are paying back. Where there is one, the bonus is
  // worked back from it rather than read off their scores.
  takeHome = null,
  relief = 0,
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
  const scored = round2(earned.reduce((n, s) => n + s.amount, 0));

  const docked = round2(penalties.reduce((n, p) => n + round2(p.amount), 0));

  // ---- SSNIT, which is on basic alone and comes off before tax ----------
  const contributions = ssnitOn(pay, { qualifies: ssnit, rates });
  const split = tierSplit(pay, { qualifies: Boolean(ssnit), rates, tiers });

  const salaryGross = round2(pay + taxableAllowance);
  // A relief comes off before the bands, the same as the pension does. It is
  // claimed on a certificate the GRA issues to the person, so a payroll only
  // ever holds what somebody has been shown, and it is nought for almost
  // everybody. Where there is one it has to actually reduce the tax: on the
  // return, column 22 is 19 minus 21, and 21 includes the relief.
  const taxRelief = Math.max(0, round2(relief));
  const salaryChargeable = Math.max(0,
    round2(salaryGross - contributions.employee - taxRelief));

  // ---- a take-home agreed with the person, worked backwards -------------
  //
  // WHY THIS EXISTS. What is actually agreed with somebody here is what they
  // take home: Linda is on 2,480 a month, and the bonus is whatever makes that
  // true once the allowances and the tax have had their say. Before this,
  // somebody worked that figure out on a spreadsheet and typed the answer into
  // the bonus box every month, and the two drifted apart the first time an
  // allowance moved.
  //
  // It is exact rather than approximate because a bonus agreed net passes
  // straight through to the take-home, cedi for cedi: the grossing-up is
  // defined as whatever covers the tax on it. So the bonus needed is simply
  // the target less what they would take home with no bonus at all, and there
  // is nothing to iterate.
  //
  // MEASURED BEFORE THE ADVANCES AND BEFORE ANY PENALTY, on purpose. An
  // advance is the person's own money going back and a penalty is meant to
  // cost them; if the target were read after either, the bonus would quietly
  // grow to cancel them out and the property would be paying back its own
  // advance.
  const salaryPaye = payeOn(salaryChargeable, rates.bands);
  const withoutBonus = round2(salaryGross + freeAllowance
    - contributions.employee - salaryPaye.tax);

  const target = takeHome == null || takeHome === '' ? null : round2(takeHome);
  // Never below nothing. Somebody whose salary alone already passes the figure
  // set for them gets no bonus, and does not get money taken off them either:
  // that would be a pay cut arrived at by arithmetic nobody agreed to. The
  // screen is told, because a target that cannot be met is a target somebody
  // has to look at.
  const solved = target == null ? null : Math.max(0, round2(target - withoutBonus));
  const overshoots = target != null && round2(target - withoutBonus) < 0;

  const bonusEarned = solved == null ? scored : solved;
  // A solved bonus is a net promise by definition: the figure agreed is what
  // reaches them, and the property carries the tax. That is the whole point of
  // working backwards from a take-home, so it does not depend on the box.
  const treatAsNet = solved == null ? bonusIsNet : true;

  // Never below nothing. A deduction bigger than the bonus is a matter for a
  // person to settle, not something to take out of somebody's salary by
  // arithmetic nobody decided on. It comes off after a target has been worked
  // out rather than before, so a penalty still costs somebody money instead of
  // being quietly made up by a bigger bonus.
  const bonusNet = Math.max(0, round2(bonusEarned - docked));
  const notTaken = round2(Math.max(0, docked - bonusEarned));

  // ---- the bonus, grossed up against that ------------------------------
  const yearBasic = annualBasic == null ? round2(pay * 12) : round2(annualBasic);

  // How far the 5% final rate reaches. The Act frames the 15% against the
  // annual basic; salaries are paid monthly, and read against the month it
  // needs no running total across the year — which matters, because a running
  // total is only as good as the months it has seen, and a property in its
  // first year here has months this app never worked.
  const monthly = rates.bonusCapBasis !== 'annual';
  const ceiling = round2((monthly ? pay : yearBasic) * (rates.bonusShareOfBasic ?? 0));
  // Nothing to carry where each month stands on its own.
  const spent = monthly ? 0 : round2(bonusPaidThisYear);

  const bonusContext = {
    chargeable: salaryChargeable,
    ceiling,
    alreadyPaid: spent,
    rates,
  };
  // Whether the figure agreed was what lands in the hand or what gets taxed.
  // Net is the normal case and the default, but it is not universal: some
  // figures were worked out from a take-home somebody had already settled on
  // and are gross already. Grossing one of those up again pays the tax twice.
  const grossed = bonusNet <= 0
    ? { gross: 0, ...bonusTaxOn(0, bonusContext) }
    : treatAsNet
      ? grossUpBonus(bonusNet, bonusContext)
      : { gross: bonusNet, ...bonusTaxOn(bonusNet, bonusContext) };

  // ---- the whole month --------------------------------------------------
  const gross = round2(salaryGross + freeAllowance + grossed.gross);
  const chargeable = round2(salaryChargeable + grossed.atGraduated);
  const paye = payeOn(chargeable, rates.bands);

  // The tax on the salary is worked out above, where the take-home a bonus has
  // to reach is measured. It is told apart from the tax the bonus added,
  // because the second is the property's own doing and it should be able to
  // see it.
  const tax = round2(paye.tax + grossed.final);

  const loanDue = round2(loans.reduce((n, l) => n + round2(l.amount), 0));
  const net = round2(gross - contributions.employee - tax - loanDue);
  const cost = round2(gross + contributions.employer);

  // ---- how it reads on a payslip ---------------------------------------
  //
  // A bonus here is usually agreed net: somebody is promised four hundred and
  // gets four hundred, and the property carries the tax that makes that true.
  // Nothing below runs for a bonus agreed gross, because there is no
  // difference to carry: the carried figure is nought and the slip shows the
  // figure that was agreed, same as the list above. So
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
      // What the schemes and scores came to, kept whatever else decided the
      // money. A score that no longer sets the figure is still a score
      // somebody gave, and a screen that hid it would look like it had
      // thrown the scoring away.
      scored,
      // The take-home this was worked back from, where there is one, and
      // whether it could be reached at all.
      takeHome: target,
      solved: solved != null,
      overshoots,
      docked,
      // Where a deduction was bigger than the bonus it came out of. Said
      // rather than swallowed: somebody will ask where the rest went.
      notTaken,
      // The figure that was agreed, which is what a payslip shows. What it
      // means depends on isNet: the money in somebody's hand where the bonus
      // was promised net, the taxable figure where it was promised gross.
      net: bonusNet,
      // How it was actually treated, which is not always the box: a bonus
      // worked back from a take-home is a net promise whatever the box says,
      // and reporting the box here would have the payslip and this line
      // disagreeing about the same bonus.
      isNet: Boolean(treatAsNet),
      gross: grossed.gross,
      // What the property put in on top to make a net promise come true.
      // Nought on a gross figure, where the tax comes out of the bonus itself.
      tax: round2(grossed.gross - bonusNet),
      atFinalRate: grossed.atFinalRate,
      atGraduated: grossed.atGraduated,
      headroom: grossed.headroom,
      // The 15% ceiling itself, and how much of it has gone. Said rather than
      // left to be worked back out of a tax figure: whether the five per cent
      // rate still applies is the one thing about a bonus somebody wants to
      // check, and the only way to see it before was to notice the tax was
      // more than a twentieth.
      ceiling,
      capBasis: monthly ? 'monthly' : 'annual',
      paidThisYear: spent,
      annualBasic: yearBasic,
      finalTax: grossed.final,
      graduatedTax: grossed.graduated,
    },

    gross,
    chargeable,
    relief: taxRelief,
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
