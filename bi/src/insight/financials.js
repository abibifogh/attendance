import { median, mad, sum, leastSquares, trendSlope } from './stats.js';

/**
 * The financial yardstick.
 *
 * Every other screen in this app reports what happened. This one exists to
 * answer the questions somebody has to answer before deciding anything:
 *
 *   how much has to be taken before the day pays for itself;
 *   how far above that the business actually is;
 *   how much of a fall it could take before it isn't;
 *   why this period differs from the last one — not that it does;
 *   whether the profit turned into money, and when it will;
 *   which lines earn and which are carried.
 *
 * Nothing here reads a database. Everything takes arrays and returns numbers,
 * so every claim on the screen can be tested against a hand-worked example.
 *
 * Two disciplines run through all of it.
 *
 * **Money is whole pesewas.** Ratios are the only floats, and they are named
 * so (`...Ratio`, `...Pct`, `...Bp`). Anything that will be printed with a
 * currency symbol is rounded to an integer before it leaves.
 *
 * **A number that cannot be computed comes back as null.** Not zero, not
 * Infinity, not a large number that looks like an answer. A break-even for a
 * line that loses money on every cover does not exist, and printing one would
 * be worse than printing nothing.
 */

// Adding zero collapses negative zero. Math.round(-0) is -0, and a bar that
// moved the profit by nothing would otherwise be labelled "-GH₵0.00".
const round = (n) => (Number.isFinite(n) ? Math.round(n) + 0 : null);
const rate = (part, whole, places = 4) => {
  const w = Number(whole);
  if (!Number.isFinite(w) || w === 0) return null;
  const f = 10 ** places;
  return Math.round((Number(part) / w) * f) / f;
};

/**
 * Below this, purchases are not following demand in any readable way.
 * Not a gate on anything — a finding in its own right.
 */
export const MIN_FIT_R2 = 0.35;
/** Fewer days than this and there is nothing to read a pattern from. */
export const MIN_DAYS_FOR_STRUCTURE = 14;

// ---------------------------------------------------------------- structure --

/**
 * What a day costs whatever happens, and what each cedi of takings costs.
 *
 * The first version of this inferred the standing cost by regressing a day's
 * total spending on a day's takings and taking the intercept. That was wrong,
 * and wrong in the way that matters: the only costs in these five systems are
 * purchases and wages, so the intercept was not discovering rent — it was
 * re-deriving the average wage bill and presenting it as a finding. Rent,
 * power, water and depreciation are in **no** connected system, so no amount of
 * arithmetic on this data can produce them.
 *
 * So the split is made on what each cost actually is, and the one figure that
 * cannot be measured is asked for instead of invented:
 *
 *   **Purchases are variable.** Food bought is food sold. This is measured
 *   directly as a share of takings, with no model in between.
 *
 *   **Wages are fixed**, over the horizon anybody decides anything on. A rota
 *   is set a week ahead and does not shrink because Tuesday was quiet. It is
 *   measured directly too.
 *
 *   **Everything else is standing cost**, is in none of these systems, and is
 *   taken from Setup. Left at nothing, every break-even below is understated
 *   by exactly the rent — and the screen says so rather than quietly being
 *   optimistic.
 *
 * The regression survives, doing the job it is actually good for: asking
 * whether purchases move with takings at all. Where they do not, food is being
 * bought to a schedule rather than to demand, and that is worth knowing on its
 * own — it is not a reason to withhold a break-even.
 */
export function costStructure(daily, { standingPerDay = 0 } = {}) {
  const usable = daily.filter((d) => Number.isFinite(d.net) && Number.isFinite(d.cost)
    && Number.isFinite(d.labour));
  const days = usable.length;
  if (!days) return { known: false, why: 'no-days', days: 0 };

  const revenue = sum(usable.map((d) => d.net));
  const purchases = sum(usable.map((d) => d.cost));
  const wages = sum(usable.map((d) => d.labour));
  if (revenue <= 0) return { known: false, why: 'no-revenue', days };

  const variableRatio = Math.round((purchases / revenue) * 10000) / 10000;
  const wagesPerDay = round(wages / days);
  const standing = round(Math.max(0, standingPerDay));
  const fixedPerDay = wagesPerDay + standing;
  const fixedTotal = round(wages + standing * days);

  return {
    known: true,
    days,
    // Measured, not modelled.
    variableRatio,
    contributionRatio: Math.round((1 - variableRatio) * 10000) / 10000,
    purchases: round(purchases),
    wages: round(wages),
    wagesPerDay,
    standingPerDay: standing,
    standingTotal: round(standing * days),
    standingKnown: standing > 0,
    fixedPerDay,
    fixedTotal,
    fixedSharePct: (purchases + wages + standing * days) > 0
      ? Math.round((fixedTotal / (purchases + wages + standing * days)) * 1000) / 10 : null,
    tracking: purchaseTracking(usable),
  };
}

/**
 * Do purchases follow demand, or a delivery schedule?
 *
 * A kitchen buying to demand shows a clear line between a day's takings and a
 * day's food bill. A weak one is not a measurement failure; it is a business
 * fact, and usually means food arrives on set days and sits. That is a real
 * cost — it is money and shelf life tied up ahead of need — so it is reported
 * as a finding rather than swallowed.
 */
function purchaseTracking(daily) {
  if (daily.length < MIN_DAYS_FOR_STRUCTURE) return { known: false, why: 'too-few-days' };
  const fit = leastSquares(daily.map((d) => d.net), daily.map((d) => d.cost),
    { minPoints: MIN_DAYS_FOR_STRUCTURE });
  if (!fit) return { known: false, why: 'no-variation' };
  return {
    known: true,
    r2: fit.r2,
    perCediOfTakings: Math.round(fit.slope * 10000) / 10000,
    followsDemand: fit.r2 != null && fit.r2 >= MIN_FIT_R2,
  };
}

/**
 * The takings a day has to make to pay for itself, and how far above it we are.
 *
 * Break-even = fixed cost ÷ contribution ratio. Both come from `costStructure`,
 * so this returns nothing whenever that did.
 *
 * Operating leverage is contribution ÷ operating profit: the multiplier from a
 * change in takings to a change in profit. It runs away to infinity as profit
 * approaches zero, and near break-even the true answer really is "an enormous
 * multiplier" — but a printed 4,000× reads as a bug, so it is capped and the
 * cap is declared.
 */
export function breakEven(structure, { revenue, days }) {
  if (!structure.known) return { known: false, why: structure.why };
  const cmRatio = structure.contributionRatio;
  if (cmRatio == null || cmRatio <= 0) {
    return { known: false, why: 'no-break-even', contributionRatio: cmRatio };
  }

  const perDay = round(structure.fixedPerDay / cmRatio);
  const forPeriod = perDay * days;
  const actualPerDay = days > 0 ? round(revenue / days) : null;
  // Gross margin, not contribution. Everywhere else in this app contribution
  // is after wages; here it is what is left before them, because wages are on
  // the other side of this particular sum. Two meanings of one word on one
  // screen is how a number gets read as the wrong number, so this one is
  // called what it is.
  //
  // Taken from the purchases themselves rather than from revenue times the
  // ratio. The ratio is rounded to four places, and multiplying by it put the
  // operating profit here three cedis away from the operating profit in the
  // tile at the top of the same screen — a discrepancy nobody could explain
  // and everybody would eventually notice.
  const grossMargin = Number.isFinite(structure.purchases)
    ? round(revenue - structure.purchases) : round(revenue * cmRatio);
  const operatingProfit = round(grossMargin - structure.fixedTotal);

  // Below break-even the "margin of safety" is a margin of danger, and it is
  // reported as a negative number rather than clamped, because how far under
  // is the only thing anybody wants to know at that point.
  const marginOfSafetyPct = revenue > 0
    ? Math.round(((revenue - forPeriod) / revenue) * 1000) / 10 : null;

  // Leverage is "how much a change in takings is multiplied by on its way to
  // the profit". With no profit there is nothing for it to be multiplied into:
  // the arithmetic still yields a number, and -6× on a loss-making month reads
  // as a fact about volatility rather than what it is, which is a division by
  // a negative. Withheld, and the screen says the plain thing instead.
  const leverageRaw = operatingProfit <= 0 ? null : grossMargin / operatingProfit;
  const leverage = leverageRaw == null || Math.abs(leverageRaw) > 25
    ? null : Math.round(leverageRaw * 10) / 10;

  return {
    known: true,
    perDay,
    forPeriod,
    actualPerDay,
    revenue: round(revenue),
    grossMargin,
    operatingProfit,
    contributionRatio: cmRatio,
    marginOfSafetyPct,
    leverage,
    leverageCapped: leverageRaw != null && Math.abs(leverageRaw) > 25,
    hasProfit: operatingProfit > 0,
    // Read plainly: a 10% fall in takings costs this much profit.
    profitAtRiskFromTenPct: round(revenue * 0.1 * cmRatio),
    // Understated by exactly the rent until somebody types it into Setup.
    includesStandingCost: structure.standingKnown === true,
  };
}

/** Days in the window that did not cover their own share of the fixed cost. */
export function daysBelowBreakEven(daily, structure) {
  if (!structure.known || structure.contributionRatio == null || structure.contributionRatio <= 0) {
    return null;
  }
  const line = structure.fixedPerDay / structure.contributionRatio;
  const below = daily.filter((d) => Number.isFinite(d.net) && d.net < line);
  return {
    line: round(line),
    days: below.length,
    of: daily.length,
    pct: daily.length ? Math.round((below.length / daily.length) * 1000) / 10 : null,
    worst: below.slice().sort((a, b) => a.net - b.net).slice(0, 5)
      .map((d) => ({ day: d.day, net: round(d.net), short: round(line - d.net) })),
  };
}

/**
 * What breaks first.
 *
 * Three shocks, each applied on its own to the period as it actually was: a
 * fall in takings, a rise in what is bought, a rise in what is paid. The point
 * of putting them side by side is that they are rarely equally survivable, and
 * which one the business is most exposed to is not obvious from any of the
 * three costs on their own.
 *
 * The headroom figures answer the question in the other direction: how big a
 * shock of each kind takes operating profit to nothing.
 */
export function sensitivity({ revenue, cost, labour, fixed }, shockPct = 10) {
  const shock = shockPct / 100;
  const base = revenue - cost - labour - fixed;
  const scenario = (label, next) => ({
    label,
    profit: round(next),
    change: round(next - base),
    changePct: base === 0 ? null : Math.round(((next - base) / Math.abs(base)) * 1000) / 10,
  });

  // A fall in takings takes the bought-in cost down with it — food not sold is
  // food not bought. Wages do not follow, which is exactly why a quiet month
  // hurts more than the revenue line suggests.
  const variableRatio = revenue > 0 ? cost / revenue : 0;
  const revenueDown = (revenue * (1 - shock)) - (revenue * (1 - shock) * variableRatio) - labour - fixed;

  return {
    shockPct,
    base: round(base),
    scenarios: [
      scenario(`Takings fall ${shockPct}%`, revenueDown),
      scenario(`Purchases cost ${shockPct}% more`, revenue - cost * (1 + shock) - labour - fixed),
      scenario(`Wages rise ${shockPct}%`, revenue - cost - labour * (1 + shock) - fixed),
      // Only where there is one. A bar reading "standing costs rise 10%: no
      // change" does not say "rent is not in this data" — it says rent does
      // not matter, which is the opposite of true.
      ...(fixed > 0
        ? [scenario(`Standing costs rise ${shockPct}%`, revenue - cost - labour - fixed * (1 + shock))]
        : []),
    ],
    // How big a shock of each kind takes the profit to nothing. Meaningless
    // where there is no profit to take: "takings can fall -14.5% before the
    // profit is gone" is not a smaller warning than "you are losing money", it
    // is a different and false statement. Below zero these are withheld and
    // the screen says the plainer thing instead.
    hasProfit: base > 0,
    headroom: base <= 0 ? { revenueFallPct: null, purchaseRisePct: null, wageRisePct: null } : {
      revenueFallPct: revenue > 0 && (1 - variableRatio) > 0
        ? Math.round((base / (revenue * (1 - variableRatio))) * 1000) / 10 : null,
      purchaseRisePct: cost > 0 ? Math.round((base / cost) * 1000) / 10 : null,
      wageRisePct: labour > 0 ? Math.round((base / labour) * 1000) / 10 : null,
    },
  };
}

// ------------------------------------------------------------------ bridge --

/**
 * Why this period differs from the last one.
 *
 * Two decompositions, both of which add up to the actual change exactly. That
 * is not a nicety: a bridge whose parts do not sum to the whole invites the
 * reader to believe whichever bar suits them, and every one of these is
 * asserted to the pesewa in the tests.
 *
 * **At group level**, on revenue share, because covers and laundry orders and
 * rooms cleaned cannot be added together:
 *
 *   revenue effect — the same margin on more (or less) money
 *   mix effect     — the same total, earned by different lines
 *   margin effect  — the same lines and shares, earning differently
 *
 * A line that did not exist last period has no prior margin, so its whole
 * contribution lands in mix. That is the correct place for it: a new line is
 * a change in what the business sells, not a change in how well it sells it.
 */
export function groupBridge(prior, current) {
  const earned = (rows) => sum(rows.filter((l) => l.net > 0).map((l) => l.contribution));
  // Housekeeping, maintenance and admin take nothing. Their whole contribution
  // is cost, they have no share of revenue and no margin, and a decomposition
  // built on revenue share cannot see them at all. Left out, they are simply
  // missing from a bridge that claims to explain the whole change — so they
  // get a bar of their own, which is also the honest name for what they are.
  const overhead = (rows) => sum(rows.filter((l) => !(l.net > 0)).map((l) => l.contribution));

  const r0 = sum(prior.map((l) => l.net));
  const r1 = sum(current.map((l) => l.net));
  const c0 = sum(prior.map((l) => l.contribution));
  const c1 = sum(current.map((l) => l.contribution));

  if (r0 <= 0 || r1 <= 0) {
    return { known: false, why: 'no-revenue', from: round(c0), to: round(c1), change: round(c1 - c0) };
  }

  const priorBy = new Map(prior.map((l) => [l.line, l]));
  const rho0 = earned(prior) / r0;

  let mix = 0;
  let margin = 0;
  for (const line of current) {
    if (!(line.net > 0)) continue;
    const was = priorBy.get(line.line);
    const w1 = line.net / r1;
    const w0 = was && was.net > 0 ? was.net / r0 : 0;
    const m0 = was && was.net > 0 ? was.contribution / was.net : 0;
    mix += r1 * (w1 - w0) * m0;
    margin += r1 * w1 * (line.contribution / line.net - m0);
  }
  // Lines that earned last period and nothing this one have vanished from the
  // loop above. Their lost share is a mix effect too, and leaving it out is
  // what would stop the bridge adding up.
  for (const was of prior) {
    if (!(was.net > 0)) continue;
    if (current.some((l) => l.line === was.line && l.net > 0)) continue;
    mix += r1 * (0 - was.net / r0) * (was.contribution / was.net);
  }

  const total = c1 - c0;
  const parts = [
    { key: 'revenue', label: 'Money through the door', amount: round((r1 - r0) * rho0) },
    { key: 'mix', label: 'Which lines earned it', amount: round(mix) },
    { key: 'margin', label: 'How well they earned', amount: round(margin) },
    { key: 'overhead', label: 'Support-line costs', amount: round(overhead(current) - overhead(prior)) },
  ];

  return { known: true,
    from: round(c0),
    to: round(c1),
    change: round(total),
    changePct: c0 === 0 ? null : Math.round(((c1 - c0) / Math.abs(c0)) * 1000) / 10,
    ...reconcile(parts, round(total)) };
}

/**
 * Make the bars sum to the change, and be loud when they nearly didn't.
 *
 * Float arithmetic on nine-digit pesewa figures leaves a pesewa or two on the
 * floor, and rounding that away onto the largest bar is right. Absorbing
 * *anything* onto the largest bar is not: it takes a decomposition that has
 * genuinely failed to explain the change and makes it add up on screen, which
 * is the one failure mode of a bridge that nobody can see.
 *
 * So: drift within a few pesewas is rounding, and is absorbed silently. Drift
 * beyond that is a fault, and gets a bar of its own labelled as one. A bridge
 * with an "unexplained" bar on it is embarrassing, which is the point — it is
 * how the fault reaches somebody instead of being averaged into an answer.
 *
 * This caught a real one: before there was an overhead bar, every change in
 * what housekeeping and maintenance cost was landing here, invisibly, on
 * whichever bar happened to be largest.
 */
function reconcile(parts, total) {
  const tolerance = parts.length + 1;
  const drift = total - sum(parts.map((p) => p.amount));
  if (drift === 0) return { parts, reconciled: true };
  if (Math.abs(drift) <= tolerance) {
    const biggest = parts.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
    biggest.amount += drift;
    return { parts, reconciled: true };
  }
  return {
    parts: [...parts, { key: 'unexplained', label: 'Not explained by any of the above', amount: drift }],
    reconciled: false,
  };
}

/**
 * The same question for one line, where volume *is* comparable to itself.
 *
 *   volume — sold more or fewer, at the margin it used to make
 *   price  — charged more or less per cover
 *   cost   — bought more or less dearly per cover
 *   labour — paid more or less per cover
 *
 * Per cover, not in total, because "we spent more on food" is not a finding
 * when we also served more people. Per cover it is.
 */
export function lineBridge(prior, current, { volumeOf = defaultVolume } = {}) {
  const v0 = volumeOf(prior);
  const v1 = volumeOf(current);
  if (!(v0 > 0) || !(v1 > 0)) {
    return {
      known: false,
      why: 'no-volume',
      from: round(prior.contribution),
      to: round(current.contribution),
      change: round(current.contribution - prior.contribution),
    };
  }

  const per = (row, v) => ({ p: row.net / v, c: row.cost / v, l: row.labour / v });
  const a = per(prior, v0);
  const b = per(current, v1);
  const cmUnit = a.p - a.c - a.l;

  const parts = [
    { key: 'volume', label: 'Sold more or fewer', amount: round((v1 - v0) * cmUnit) },
    { key: 'price', label: 'Charged differently', amount: round((b.p - a.p) * v1) },
    { key: 'cost', label: 'Bought differently', amount: round(-(b.c - a.c) * v1) },
    { key: 'labour', label: 'Paid differently', amount: round(-(b.l - a.l) * v1) },
  ];
  const total = round(current.contribution - prior.contribution);

  return {
    known: true,
    line: current.line,
    label: current.label,
    unit: unitName(current),
    volumeFrom: v0,
    volumeTo: v1,
    from: round(prior.contribution),
    to: round(current.contribution),
    change: total,
    ...reconcile(parts, total),
  };
}

/**
 * What counts as one sale on this line.
 *
 * Covers where a line serves meals, orders where it takes orders, and days
 * where it does neither — housekeeping has neither covers nor orders, and a
 * per-day figure is still comparable with itself, which is all the bridge asks.
 */
function defaultVolume(row) {
  if (row.covers > 0) return row.covers;
  if (row.orders > 0) return row.orders;
  return row.days || 0;
}

function unitName(row) {
  if (row.covers > 0) return 'cover';
  if (row.orders > 0) return 'order';
  return 'day';
}

// --------------------------------------------------------- working capital --

/**
 * How long money takes to arrive, and how long it is held before it leaves.
 *
 * Days sales outstanding against days payable outstanding. The gap is the
 * number that matters: a business collecting in 40 days and paying in 20 is
 * lending its suppliers' money to its customers for three weeks, and will feel
 * poor in a month it is profitable.
 *
 * Both are computed on the window's own daily rates rather than an annual
 * convention, so a 30-day window and a 90-day one give comparable answers.
 *
 * Stock is missing from this on purpose. None of the connected systems values
 * what is on the shelf, so a cash cycle including inventory days would be a
 * guess wearing the same font as two measured numbers.
 */
export function workingCapital({ revenue, outstanding, billed, payable, days }) {
  const dso = revenue > 0 && days > 0
    ? Math.round((outstanding / (revenue / days)) * 10) / 10 : null;
  const dpo = billed > 0 && days > 0
    ? Math.round((payable / (billed / days)) * 10) / 10 : null;

  return {
    days,
    receivables: round(outstanding),
    payables: round(payable),
    dso,
    dpo,
    // Funded by suppliers when negative; funding customers when positive.
    cashGapDays: dso != null && dpo != null ? Math.round((dso - dpo) * 10) / 10 : null,
    netWorkingCapital: round(outstanding - payable),
    // What one day of the gap costs to carry, so the gap has a price on it.
    dailyRevenue: days > 0 ? round(revenue / days) : null,
    inventoryDays: null,
    inventoryNote: 'No connected system values stock, so the cycle below excludes it and is that much shorter than the real one.',
  };
}

/**
 * Did the profit turn into money?
 *
 * A period can be profitable and still empty the account, and the two figures
 * that reveal it — what was charged against what was collected, and what was
 * earned against what was billed — are in different systems and have never
 * been on the same screen.
 */
export function earningsQuality({ charged, collected, contribution, billed, paid }) {
  return {
    charged: round(charged),
    collected: round(collected),
    uncollected: round(charged - collected),
    collectedPct: charged > 0 ? Math.round((collected / charged) * 1000) / 10 : null,
    billed: round(billed),
    paid: round(paid),
    unpaid: round(billed - paid),
    paidPct: billed > 0 ? Math.round((paid / billed) * 1000) / 10 : null,
    // Cash actually moved: collected in, paid out. Not a cash-flow statement —
    // there is no rent or loan repayment in any of these systems — but it is
    // the part of the movement these systems do see, and it is the part a
    // contribution figure hides.
    netMovement: round(collected - paid),
    contribution: round(contribution),
    conversionPct: contribution > 0
      ? Math.round(((collected - paid) / contribution) * 1000) / 10 : null,
  };
}

// ---------------------------------------------------------- unit economics --

/**
 * What each line earns per thing it does, and per cedi of wage it spends.
 *
 * Compared against the group's **weighted** figure, not the average of the
 * lines. A mean of lines lets a tiny line with a freak margin set the standard
 * every real line then fails.
 */
export function unitEconomics(lines) {
  const totalNet = sum(lines.map((l) => l.net));
  const totalContribution = sum(lines.map((l) => l.contribution));
  const totalLabour = sum(lines.map((l) => l.labour));

  // The benchmark is the weighted margin of the lines that take money, not of
  // the group. The group's own margin is dragged down by housekeeping,
  // maintenance and admin, which have no takings at all and are pure cost by
  // design — comparing the restaurant against that says the restaurant is 64
  // points above standard, which is not a fact about the restaurant. It is a
  // fact about who pays for the cleaners.
  const earners = lines.filter((l) => l.net > 0);
  const earnerNet = sum(earners.map((l) => l.net));
  const earnerContribution = sum(earners.map((l) => l.contribution));
  const benchmarkRatio = rate(earnerContribution, earnerNet);
  const groupReturnOnWage = rate(totalContribution, totalLabour);

  const rows = lines.map((l) => {
    const volume = defaultVolume(l);
    const marginRatio = rate(l.contribution, l.net);
    // A line with no takings and no purchases returns exactly -1.00 per wage
    // cedi, every time, because its contribution *is* its wage bill negated.
    // Arithmetically true and informationally empty; it invites a reader to
    // rank support lines against each other on a number that cannot vary.
    const meaningfulWageReturn = l.net > 0 && l.labour > 0;
    return {
      line: l.line,
      label: l.label,
      unit: unitName(l),
      volume,
      net: round(l.net),
      contribution: round(l.contribution),
      earns: l.net > 0,
      contributionPerUnit: volume > 0 ? round(l.contribution / volume) : null,
      revenuePerUnit: volume > 0 ? round(l.net / volume) : null,
      contributionPerHour: l.hours > 0 ? round(l.contribution / l.hours) : null,
      // Every cedi of wage bought this much contribution. The one figure that
      // is comparable between a kitchen and a laundry without apology.
      returnOnWage: meaningfulWageReturn ? rate(l.contribution, l.labour, 2) : null,
      marginRatio,
      // Against the lines that take money, in percentage points, so "12 points
      // below" is readable where "0.63 versus 0.75" is not.
      marginVsGroupPts: marginRatio == null || benchmarkRatio == null ? null
        : Math.round((marginRatio - benchmarkRatio) * 1000) / 10,
      shareOfRevenuePct: totalNet > 0 ? Math.round((l.net / totalNet) * 1000) / 10 : null,
      shareOfContributionPct: totalContribution > 0
        ? Math.round((l.contribution / totalContribution) * 1000) / 10 : null,
    };
  }).sort((a, b) => b.contribution - a.contribution);

  return {
    group: {
      marginRatio: rate(totalContribution, totalNet),
      benchmarkRatio,
      benchmarkLines: earners.length,
      returnOnWage: groupReturnOnWage == null ? null : Math.round(groupReturnOnWage * 100) / 100,
      net: round(totalNet),
      contribution: round(totalContribution),
      labour: round(totalLabour),
      // Shares of profit mean nothing when the group made none, and a column
      // of dashes is worse than no column.
      sharesMeaningful: totalContribution > 0,
    },
    rows,
  };
}

/**
 * How much of the group's profit rests on how few lines.
 *
 * Loss-making lines are excluded from the denominator on purpose. Including
 * them makes the earners' shares exceed 100% and the concentration read as
 * worse than it is; the loss-makers are listed separately, where they are the
 * actual finding.
 */
export function concentration(lines) {
  const earning = lines.filter((l) => l.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);
  const losing = lines.filter((l) => l.contribution < 0)
    .sort((a, b) => a.contribution - b.contribution);
  const totalEarned = sum(earning.map((l) => l.contribution));

  let running = 0;
  let linesToEighty = null;
  earning.forEach((l, i) => {
    running += l.contribution;
    if (linesToEighty == null && totalEarned > 0 && running / totalEarned >= 0.8) {
      linesToEighty = i + 1;
    }
  });

  return {
    earningLines: earning.length,
    totalEarned: round(totalEarned),
    topSharePct: totalEarned > 0 && earning.length
      ? Math.round((earning[0].contribution / totalEarned) * 1000) / 10 : null,
    topLine: earning[0] ? { line: earning[0].line, label: earning[0].label } : null,
    linesToEighty,
    losing: losing.map((l) => ({
      line: l.line, label: l.label,
      contribution: round(l.contribution), net: round(l.net),
    })),
    drag: round(sum(losing.map((l) => l.contribution))),
  };
}

// ----------------------------------------------------------------- run rate --

/**
 * Where the period lands if the rest of it looks like what has happened.
 *
 * A range, not a point, and built from the median day and its deviation rather
 * than the mean — a single festival day would otherwise set the forecast for
 * the month. The band is the median day ± one MAD across the days remaining,
 * which is a modest claim honestly made rather than a confidence interval that
 * would need assumptions this data does not support.
 */
export function runRate(daily, { daysInPeriod, direction = 'contribution' } = {}) {
  const values = daily.map((d) => d[direction]).filter((v) => Number.isFinite(v));
  if (values.length < 7 || !daysInPeriod || daysInPeriod <= values.length) return null;

  const mid = median(values);
  const spread = mad(values);
  const remaining = daysInPeriod - values.length;
  const sofar = sum(values);

  return {
    elapsed: values.length,
    remaining,
    soFar: round(sofar),
    typicalDay: round(mid),
    projected: round(sofar + mid * remaining),
    low: round(sofar + (mid - spread) * remaining),
    high: round(sofar + (mid + spread) * remaining),
    trendPerDay: (() => {
      const slope = trendSlope(values);
      return slope == null ? null : round(slope);
    })(),
  };
}

// --------------------------------------------------------------- assembly --

/**
 * Everything above, from one set of arrays.
 *
 * `current` and `prior` are the same shape: daily rows and line rows. The
 * caller is responsible for the two windows being the same length — comparing
 * thirty days with twenty-eight produces a 7% "fall" out of the calendar, and
 * that mistake is not detectable from inside here.
 */
export function financialAnalysis({
  currentDaily, currentLines, priorDaily, priorLines,
  charged, collected, outstanding, billed, paid, payable,
  daysInPeriod, standingPerDay = 0,
} = {}) {
  const daily = currentDaily || [];
  const lines = currentLines || [];
  const days = daily.length;
  const revenue = sum(lines.map((l) => l.net));
  const cost = sum(lines.map((l) => l.cost));
  const labour = sum(lines.map((l) => l.labour));
  const contribution = sum(lines.map((l) => l.contribution));

  const structure = costStructure(daily, { standingPerDay });
  const be = breakEven(structure, { revenue, days });

  // The standing cost, and only the standing cost. Contribution already has
  // wages taken off it, so adding the whole fixed cost here would charge the
  // group for its wage bill twice — a mistake that would roughly double the
  // apparent loss and be entirely invisible on the screen.
  const standing = structure.known ? structure.standingTotal : 0;

  const priorL = priorLines || [];
  const priorBy = new Map(priorL.map((l) => [l.line, l]));
  const lineBridges = lines
    .filter((l) => priorBy.has(l.line))
    .map((l) => lineBridge(priorBy.get(l.line), l))
    .filter((b) => b.known)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  return {
    period: { days, daysInPeriod: daysInPeriod ?? null },
    totals: {
      revenue: round(revenue),
      cost: round(cost),
      labour: round(labour),
      contribution: round(contribution),
      standing: round(standing),
      operatingProfit: round(contribution - standing),
      marginPct: revenue > 0 ? Math.round((contribution / revenue) * 1000) / 10 : null,
      operatingMarginPct: revenue > 0
        ? Math.round(((contribution - standing) / revenue) * 1000) / 10 : null,
    },
    structure,
    breakEven: be,
    belowBreakEven: daysBelowBreakEven(daily, structure),
    sensitivity: sensitivity({ revenue, cost, labour, fixed: standing }),
    sensitivityIncludesFixed: structure.standingKnown === true,
    bridge: priorL.length ? groupBridge(priorL, lines) : null,
    lineBridges,
    unit: unitEconomics(lines),
    concentration: concentration(lines),
    workingCapital: workingCapital({
      revenue, outstanding: outstanding || 0, billed: billed || 0, payable: payable || 0, days,
    }),
    quality: earningsQuality({
      charged: charged ?? revenue,
      collected: collected || 0,
      contribution,
      billed: billed || 0,
      paid: paid || 0,
    }),
    runRate: runRate(daily, { daysInPeriod }),
  };
}
