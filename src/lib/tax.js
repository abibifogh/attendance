/**
 * Ghana income tax, as it applies to a monthly payroll.
 *
 * Everything in here is arithmetic on figures the Ghana Revenue Authority
 * publishes, and it is deliberately kept apart from the payroll that uses it.
 * Tax bands change with the budget; when they do, one table changes and
 * nothing else in the app has to be re-read.
 *
 * THE BANDS ARE DATA, NOT CODE. They are seeded at the current figures and
 * settable under Setup, because an app whose tax table can only be changed by
 * a developer is an app that is wrong for the first three months of every
 * year. Whatever is used is stamped on the payslip.
 *
 * WHAT IS IMPLEMENTED, AND WHAT IS DELIBERATELY NOT
 *
 *   Employee SSNIT at 5.5% of basic and employer at 13%, which is the split
 *   under the National Pensions Act 2008 (Act 766). SSNIT comes off before tax.
 *
 *   PAYE on the graduated monthly bands under the Income Tax Act 2015
 *   (Act 896), on chargeable income — gross emoluments less the employee's
 *   SSNIT contribution.
 *
 *   Bonus at 5% as a final tax up to 15% of annual basic salary, with the
 *   excess added to employment income and taxed at the graduated rates. The
 *   15% is an annual ceiling, so what has already been paid this year is
 *   counted before the rate is applied.
 *
 *   Not implemented: the overtime tax for qualifying junior staff (5% and
 *   10%), personal reliefs claimed on a tax credit certificate, and tier-three
 *   voluntary contributions. Each of those is a rule about one person's
 *   circumstances rather than a payroll-wide one, and guessing at them would
 *   put a wrong figure on a payslip somebody is held to.
 */

/** Money, to the pesewa. */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The graduated monthly bands, as at the 2026 rates.
 *
 * Written as "the next so much at this rate" rather than as thresholds,
 * because that is how the Act states them and how anybody checking them
 * against a GRA table will read them. The last band has no width: everything
 * above it is taxed at that rate.
 */
export const BANDS = [
  { width: 490, rate: 0 },
  { width: 110, rate: 0.05 },
  { width: 130, rate: 0.10 },
  { width: 3166.67, rate: 0.175 },
  { width: 16000, rate: 0.25 },
  { width: 30520, rate: 0.30 },
  { width: null, rate: 0.35 },
];

export const RATES = {
  ssnitEmployee: 0.055,
  ssnitEmployer: 0.13,
  bonusFinalRate: 0.05,
  // The share of basic salary that the 5% final rate reaches.
  bonusShareOfBasic: 0.15,
  // And what that share is of. The Act frames it as the annual basic; salaries
  // are paid monthly and the practice here is to read the same share against
  // the month being paid, which needs no running total and so has nothing to
  // be out of date about.
  bonusCapBasis: 'monthly',
};

/**
 * Whatever the property has set, over the top of the published figures.
 *
 * A band table is stored as JSON in one setting rather than as seven, because
 * the number of bands changes as often as the rates in them do.
 */
export function ratesFrom(settings = {}) {
  const bands = parseBands(settings.pay_bands) ?? BANDS;
  const number = (key, fallback) => {
    const value = Number(settings[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };

  return {
    bands,
    ssnitEmployee: number('pay_ssnit_employee', RATES.ssnitEmployee),
    ssnitEmployer: number('pay_ssnit_employer', RATES.ssnitEmployer),
    bonusFinalRate: number('pay_bonus_rate', RATES.bonusFinalRate),
    bonusShareOfBasic: number('pay_bonus_share', RATES.bonusShareOfBasic),
    bonusCapBasis: settings.pay_bonus_cap_basis === 'annual' ? 'annual' : RATES.bonusCapBasis,
    // Stamped on every payslip, so a slip printed in March can be told from
    // one printed in April on different figures.
    label: String(settings.pay_bands_label ?? 'GRA monthly bands, 2026'),
  };
}

function parseBands(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const bands = parsed.map((band) => ({
      width: band.width == null ? null : Number(band.width),
      rate: Number(band.rate),
    }));
    if (bands.some((b) => !Number.isFinite(b.rate) || (b.width != null && !Number.isFinite(b.width)))) {
      return null;
    }
    return bands;
  } catch {
    // A band table somebody has broken is not a reason to pay everybody
    // nothing. Fall back to the published figures and carry on.
    return null;
  }
}

/**
 * PAYE on a month's chargeable income.
 *
 * Returns the tax and the working, because a payslip that says "PAYE 309.00"
 * and nothing else is a number somebody has to take on trust.
 */
export function payeOn(chargeable, bands = BANDS) {
  let left = Math.max(0, round2(chargeable));
  const steps = [];
  let tax = 0;

  for (const band of bands) {
    if (left <= 0) break;
    const width = band.width == null ? left : Math.min(left, band.width);
    const due = round2(width * band.rate);
    steps.push({ amount: round2(width), rate: band.rate, tax: due });
    tax = round2(tax + due);
    left = round2(left - width);
  }

  return { tax, steps };
}

/** The employee's and the employer's SSNIT, on basic salary alone. */
export function ssnitOn(basic, { qualifies = true, rates = RATES } = {}) {
  if (!qualifies) return { employee: 0, employer: 0 };
  return {
    employee: round2(round2(basic) * rates.ssnitEmployee),
    employer: round2(round2(basic) * rates.ssnitEmployer),
  };
}

/**
 * What a bonus costs in tax, on top of the tax already due on the salary.
 *
 * Two parts. What falls inside the year's 15%-of-basic ceiling is taxed at 5%
 * and goes no further — a final tax, not added to income. Anything above it
 * joins employment income and is taxed at whatever band the person is already
 * in, which is why this needs the salary's chargeable income to work from.
 */
export function bonusTaxOn(gross, {
  chargeable = 0, annualBasic = 0, alreadyPaid = 0, rates = RATES, ceiling = null,
} = {}) {
  const amount = Math.max(0, round2(gross));
  if (!amount) {
    return { tax: 0, atFinalRate: 0, atGraduated: 0, headroom: 0, final: 0, graduated: 0 };
  }

  // What the five per cent rate stretches to. Given outright where the caller
  // has worked it out, because the share is of basic salary and whether that
  // means the year's or the month's is a decision above this function.
  const cap = ceiling == null
    ? round2(round2(annualBasic) * rates.bonusShareOfBasic)
    : Math.max(0, round2(ceiling));
  const headroom = Math.max(0, round2(cap - round2(alreadyPaid)));

  const atFinalRate = Math.min(amount, headroom);
  const atGraduated = round2(amount - atFinalRate);

  const final = round2(atFinalRate * rates.bonusFinalRate);
  // The graduated part is marginal: the difference between the tax on the
  // salary with it and the tax on the salary without.
  const graduated = round2(
    payeOn(round2(chargeable + atGraduated), rates.bands ?? BANDS).tax
    - payeOn(chargeable, rates.bands ?? BANDS).tax,
  );

  return {
    tax: round2(final + graduated),
    atFinalRate: round2(atFinalRate),
    atGraduated,
    headroom,
    final,
    graduated,
  };
}

/**
 * The gross bonus that leaves a given amount in somebody's hand.
 *
 * A bonus agreed as "five hundred cedis" is agreed net: the person expects
 * five hundred, and the tax on it is the property's to carry. Working
 * backwards through a progressive table is not algebra — the answer depends on
 * which band the bonus pushes them into, and there can be two of them — so it
 * is solved by halving the interval, which is exact to the pesewa in about
 * thirty steps and cannot be got subtly wrong the way a rearranged formula
 * can.
 */
export function grossUpBonus(net, context = {}) {
  const want = round2(net);
  if (want <= 0) return { gross: 0, tax: 0, ...bonusTaxOn(0, context) };

  const takeHome = (gross) => round2(gross - bonusTaxOn(gross, context).tax);

  let low = want;
  // Nothing here is taxed above 35%, so the gross can never be more than
  // half as much again as the net. Doubling is room to spare.
  let high = round2(want * 2);
  for (let i = 0; i < 60 && takeHome(high) < want; i += 1) high = round2(high * 1.5);

  for (let i = 0; i < 60; i += 1) {
    const middle = round2((low + high) / 2);
    if (takeHome(middle) < want) low = middle; else high = middle;
    if (high - low <= 0.01) break;
  }

  const gross = round2(high);
  const detail = bonusTaxOn(gross, context);
  return { gross, ...detail };
}
