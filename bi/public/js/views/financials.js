import { add, h, money, moneyShort, num, percent, dayRange } from '../util.js';
import { api } from '../api.js';
import { barChart } from '../charts.js';
import { tile, table, banner, caveats } from './components.js';

/**
 * The yardstick.
 *
 * Every other screen answers "what happened". This one exists to answer the
 * questions that come immediately after it, in the order somebody actually
 * asks them:
 *
 *   Where do we stand, against last month and against the point where the
 *   month pays for itself?
 *   Why is this month different? Not that it is — why.
 *   What would break us, and how far away is it?
 *   Which lines earn, which are carried, and how much rests on how few?
 *   Did any of it turn into money?
 *
 * A card is left off the screen entirely when its answer is not available,
 * rather than drawn with dashes in it. Half a screen of real numbers is worth
 * more than a full one where the reader has to work out which are which.
 */
export async function renderFinancials(root, { range }) {
  const data = await api(`/financials?from=${range.from}&to=${range.to}`);
  const t = data.totals;
  const be = data.breakEven;

  add(root,
    data.demoMode
      ? banner('demo', h('strong', 'Demonstration data.'), ' Every figure below is invented.')
      : null,

    standingCard(data, t),
    breakEvenCard(data, be),
    bridgeCard(data),
    lineBridgeCard(data),
    sensitivityCard(data),
    unitCard(data),
    concentrationCard(data),
    moneyCard(data),
    forecastCard(data),

    caveats(data.caveats));
}

/**
 * A figure with nothing to compare it against.
 *
 * `tile` prints "no comparison" under anything without a prior-period change,
 * which is right on a screen where most tiles have one and the odd one does
 * not. Here most of them do not — a break-even has no last month — and eight
 * repetitions of "no comparison" down one screen reads as eight things having
 * gone wrong.
 */
function stat(label, value, note) {
  return h('div.tile',
    h('div.label', label),
    h('div.value', value == null ? '—' : value),
    note ? h('div.note', note) : null);
}

// ------------------------------------------------------------ where we are --

function standingCard(data, t) {
  return h('div.card',
    h('h2', 'Where the business stands'),
    h('p.sub',
      `${dayRange(data.range.from, data.range.to)}, against the ${data.priorRange.days} days `
      + `immediately before it (${dayRange(data.priorRange.from, data.priorRange.to)}). `
      + 'Contribution is what the lines earned after what they bought and what they paid people. '
      + 'Operating profit takes the standing cost off that as well.'),
    h('div.grid.four',
      tile({ label: 'Taken', value: t.revenue, unit: 'money', changePct: data.movement.revenue }),
      tile({ label: 'Contribution', value: t.contribution, unit: 'money', changePct: data.movement.contribution,
        note: t.marginPct == null ? null : `${percent(t.marginPct)} of takings` }),
      stat('Operating profit', money(t.operatingProfit),
        data.structure.standingKnown
          ? `after ${money(t.standing)} of rent, power and the rest`
          : 'rent and power are in no connected system, so this is contribution — set them in Setup'),
      tile({ label: 'Wages', value: t.labour, unit: 'money', changePct: data.movement.labour, goodWhen: 'down' })));
}

// -------------------------------------------------------------- break-even --

function breakEvenCard(data, be) {
  if (!be.known) {
    return h('div.card',
      h('h2', 'What a day has to take'),
      h('p.sub', whyNoBreakEven(data, be)));
  }

  const st = data.structure;
  const below = data.belowBreakEven;
  const safe = be.marginOfSafetyPct;

  return h('div.card',
    h('h2', 'What a day has to take to pay for itself'),
    h('p.sub',
      `Of every cedi taken, ${percent(be.contributionRatio * 100)} survives the food and drink bought `
      + `to earn it. That has to cover ${money(st.wagesPerDay)} a day of wages`
      + (st.standingKnown ? ` and ${money(st.standingPerDay)} a day of rent, power and the rest.`
        : '. Wages are treated as fixed because a rota is set a week ahead and does not shrink '
          + 'because Tuesday was quiet.')),

    !st.standingKnown
      ? banner('warning',
        h('strong', 'Rent and power are not in this figure.'),
        ' They are in none of the five connected systems, so the break-even below is understated by '
        + 'exactly that amount and the margin of safety is flattered by it. One number in Setup — '
        + 'roughly right is enough — makes every figure on this card true.')
      : null,

    h('div.grid.four',
      stat('Break-even, a day', money(be.perDay),
        st.standingKnown ? 'wages and standing costs' : 'wages only, until rent is set'),
      stat('Actually taken, a day', money(be.actualPerDay),
        be.actualPerDay >= be.perDay ? 'above the line' : 'below the line'),
      stat('Margin of safety', safe == null ? null : percent(safe),
        safe == null ? null
          : safe >= 0 ? 'takings could fall this far before the profit is gone'
            : 'takings are this far below the point where the period pays for itself'),
      be.hasProfit
        ? stat('Operating leverage', be.leverage == null ? null : `${num(be.leverage, 1)}×`,
          be.leverage == null
            ? 'too near break-even to be a useful multiple'
            : `so a 10% fall in takings costs about ${money(be.profitAtRiskFromTenPct)} of profit`)
        : stat('A 10% fall in takings', money(-be.profitAtRiskFromTenPct),
          'would deepen the loss by this much — there is no profit for a leverage figure to multiply')),

    below && below.days
      ? h('p.sub',
        `${num(below.days)} of ${num(below.of)} days (${percent(below.pct)}) took less than `
        + `${money(below.line)} and so did not cover their own share of the fixed cost. `
        + 'A handful is normal; a pattern by weekday is a rota question, not a marketing one.')
      : below ? h('p.sub', 'Every day in this window covered its own share of the fixed cost.') : null,

    below && below.worst.length
      ? table([
        { label: 'Day', get: (r) => r.day },
        { label: 'Taken', num: true, get: (r) => money(r.net) },
        { label: 'Short by', num: true, get: (r) => money(r.short) },
      ], below.worst)
      : null,

    trackingNote(st));
}

/**
 * Whether the kitchen buys to demand or to a delivery schedule.
 *
 * This used to be a gate: a weak relationship between takings and the food
 * bill withheld the whole break-even. That was the wrong conclusion from the
 * right observation — the break-even never depended on it, and food arriving
 * on set days is a finding about buying, not a failure to measure anything.
 */
function trackingNote(st) {
  const t = st.tracking;
  if (!t || !t.known) return null;
  if (t.followsDemand) {
    return h('p.sub.muted',
      `Purchases track takings closely (fit ${num(t.r2, 2)}), at about `
      + `${money(Math.round(t.perCediOfTakings * 100))} of food for every hundred cedis taken. `
      + 'The kitchen is buying to demand.');
  }
  return h('p.sub',
    `Purchases barely follow takings at all (fit ${num(t.r2, 2)}, where anything under 0.35 is a `
    + 'cloud of points). That normally means food arrives on set days and sits, rather than being '
    + 'bought against what is actually being sold — money and shelf life tied up ahead of need. '
    + 'It does not affect the break-even above, which does not depend on it.');
}

function whyNoBreakEven(data, be) {
  if (be.why === 'no-break-even') {
    return 'Every cedi taken in this window cost more than a cedi to buy the goods for, before a '
      + 'single wage was paid. There is no level of takings at which this period pays for itself — '
      + 'that is a pricing or a buying problem, not a volume one, and selling more of the same '
      + 'would make it worse.';
  }
  if (be.why === 'no-revenue') {
    return 'Nothing was taken in this window, so there is nothing to work a break-even out of.';
  }
  return 'There are no days with figures in this window.';
}

// ------------------------------------------------------------------ bridge --

function bridgeCard(data) {
  const b = data.bridge;
  if (!b || !b.known) return null;

  return h('div.card',
    h('h2', 'Why this period differs from the last'),
    h('p.sub',
      `Contribution went from ${money(b.from)} to ${money(b.to)}, a change of ${money(b.change)}`
      + `${b.changePct == null ? '' : ` (${percent(b.changePct)})`}. The bars below add up to exactly `
      + 'that. They separate the reasons it can happen, which need different answers: more money '
      + 'through the door, the same money earned by different lines, the same lines earning '
      + 'differently, or the lines that take nothing — housekeeping, maintenance, admin — simply '
      + 'costing more. That last one has no revenue and no margin, so it is invisible to the '
      + 'other three and needs a bar of its own.'),
    !b.reconciled
      ? banner('warning', h('strong', 'These bars do not fully explain the change.'),
        ' The remainder is shown as its own bar rather than hidden in the others. Worth reporting.')
      : null,
    barChart(b.parts, {
      label: (r) => r.label,
      value: (r) => r.amount,
      colour: (r) => (r.key === 'unexplained' ? 'var(--muted)'
        : r.amount >= 0 ? 'var(--series-3)' : 'var(--series-2)'),
    }));
}

function lineBridgeCard(data) {
  const rows = (data.lineBridges || []).filter((b) => b.change !== 0);
  if (!rows.length) return null;

  const part = (r, key) => r.parts.find((p) => p.key === key)?.amount ?? 0;
  return h('div.card',
    h('h2', 'Line by line, what actually moved'),
    h('p.sub',
      'The same question for each line, where the number sold can be compared with itself. '
      + 'Everything but volume is measured per cover, per order or per day — because "we spent more '
      + 'on food" is not a finding when more people were served, and per head it either is or it is '
      + 'not. Ordered by how much the line moved the group.'),
    table([
      { label: 'Line', get: (r) => r.label },
      { label: 'Sold', num: true, get: (r) => `${num(r.volumeFrom)} → ${num(r.volumeTo)} ${r.unit}s` },
      { label: 'Volume', num: true, get: (r) => money(part(r, 'volume')) },
      { label: 'Charged', num: true, get: (r) => money(part(r, 'price')) },
      { label: 'Bought', num: true, get: (r) => money(part(r, 'cost')) },
      { label: 'Paid', num: true, get: (r) => money(part(r, 'labour')) },
      { label: 'Net change', num: true, get: (r) => money(r.change) },
    ], rows));
}

// ------------------------------------------------------------- sensitivity --

function sensitivityCard(data) {
  const s = data.sensitivity;
  const head = s.headroom;

  return h('div.card',
    h('h2', 'What breaks first'),
    h('p.sub',
      `Four shocks of ${percent(s.shockPct)}, each applied on its own to the period as it actually was. `
      + 'A fall in takings takes the food bill down with it — food not sold is food not bought — while '
      + 'the wages stay where they are, which is why a quiet month hurts more than the takings line '
      + 'suggests.'
      + (data.sensitivityIncludesFixed ? ''
        : ' Rent and power are not set, so these move contribution rather than profit. The '
          + 'direction and the size of each shock are right; the level they start from is not.')),
    barChart(s.scenarios, {
      label: (r) => r.label,
      value: (r) => r.change,
      colour: (r) => (r.change >= 0 ? 'var(--series-3)' : 'var(--series-2)'),
    }),
    s.hasProfit
      ? h('div',
        h('p.sub', 'Read the other way round: how big a shock of each kind takes the profit to nothing.'),
        table([
          { label: 'If this happens', get: (r) => r.what },
          { label: 'Profit goes to nothing at', num: true, get: (r) => (r.at == null ? '—' : percent(r.at)) },
        ], [
          { what: 'Takings fall', at: head.revenueFallPct },
          { what: 'Everything bought costs more', at: head.purchaseRisePct },
          { what: 'Wages rise', at: head.wageRisePct },
        ]))
      : h('p.sub',
        'There is no headroom to report, because there is no profit to protect: this window cost '
        + `${money(Math.abs(s.base))} more than it earned. Every bar above makes an existing loss `
        + 'larger or smaller — none of them is a warning about a profit that is not there.'));
}

// ---------------------------------------------------------- unit economics --

function unitCard(data) {
  const u = data.unit;
  if (!u.rows.length) return null;

  return h('div.card',
    h('h2', 'What each line earns, and what it costs to earn it'),
    h('p.sub',
      'Margin is compared against the weighted margin of the '
      + `${num(u.group.benchmarkLines)} lines that take money — `
      + `${u.group.benchmarkRatio == null ? '—' : percent(u.group.benchmarkRatio * 100)} — and not `
      + 'against two other things it would be easy to use and wrong to. Not the average of the '
      + 'lines, which lets a small line with a freak margin set a standard the line that is '
      + 'actually the business then fails. And not the group’s own margin, which housekeeping, '
      + 'maintenance and admin drag below zero by design: judged against that, every earning line '
      + 'looks sixty points above standard, which says nothing about the line and everything about '
      + 'who pays for the cleaners. Return on wage is the one figure comparable between a kitchen '
      + 'and a laundry, and is left blank for lines that take nothing — theirs is always exactly '
      + '−1.00 and cannot vary.'),
    table([
      { label: 'Line', get: (r) => r.label },
      { label: 'Taken', num: true, get: (r) => money(r.net) },
      { label: 'Contribution', num: true, get: (r) => money(r.contribution) },
      { label: 'Margin', num: true, get: (r) => (r.marginRatio == null ? '—' : percent(r.marginRatio * 100)) },
      { label: 'vs group', num: true, get: (r) => (r.marginVsGroupPts == null ? '—'
        : `${r.marginVsGroupPts > 0 ? '+' : ''}${num(r.marginVsGroupPts, 1)} pts`) },
      { label: 'Per unit', num: true, get: (r) => (r.contributionPerUnit == null ? '—'
        : `${money(r.contributionPerUnit)} / ${r.unit}`) },
      { label: 'Per wage cedi', num: true, get: (r) => (r.returnOnWage == null ? '—' : num(r.returnOnWage, 2)) },
      // A column of nothing but dashes is worse than no column, and that is
      // exactly what this becomes in a month the group did not make a profit.
      ...(u.group.sharesMeaningful
        ? [{ label: 'Share of profit', num: true, get: (r) => (r.shareOfContributionPct == null ? '—' : percent(r.shareOfContributionPct)) }]
        : []),
    ], u.rows),
    h('p.sub.muted',
      'Breakfast will always look ruinous here. The food is bought for every guest in the house and '
      + 'only outside guests pay a fee any system records, so it is a cost of the rooms — and the '
      + 'rooms are the line nothing reports.'));
}

function concentrationCard(data) {
  const c = data.concentration;
  if (!c.earningLines) return null;

  return h('div.card',
    h('h2', 'How much rests on how little'),
    h('p.sub',
      c.topLine
        ? `${c.topLine.label} earns ${percent(c.topSharePct)} of everything the group makes`
          + `${c.linesToEighty ? `, and ${num(c.linesToEighty)} of ${num(c.earningLines)} earning lines account for four fifths of it` : ''}. `
          + 'That is the exposure worth knowing before anything is decided about the others.'
        : 'No line earned a contribution in this window.'),
    c.losing.length
      ? h('div',
        h('p.sub',
          `${num(c.losing.length)} line${c.losing.length === 1 ? '' : 's'} cost more than they earned, `
          + `by ${money(Math.abs(c.drag))} between them. Housekeeping, maintenance and admin belong here `
          + 'by design — they are costs the earning lines carry, not businesses that failed. A line '
          + 'that takes money and still appears here is the finding.'),
        table([
          { label: 'Line', get: (r) => r.label },
          { label: 'Taken', num: true, get: (r) => money(r.net) },
          { label: 'Cost the group', num: true, get: (r) => money(r.contribution) },
        ], c.losing))
      : null);
}

// ----------------------------------------------------------------- cash --

function moneyCard(data) {
  const q = data.quality;
  const w = data.workingCapital;

  return h('div.card',
    h('h2', 'Did the profit turn into money?'),
    h('p.sub',
      'A period can be profitable and still empty the account. These two figures live in different '
      + 'systems — what the tills charged against what they collected, and what suppliers invoiced '
      + 'against what has been paid — and this is the only screen they appear on together.'),
    h('div.grid.four',
      stat('Charged but not collected', money(q.uncollected),
        q.collectedPct == null ? null : `${percent(q.collectedPct)} of takings came in`),
      stat('Invoiced but not paid', money(q.unpaid),
        data.hasBooks ? (q.paidPct == null ? null : `${percent(q.paidPct)} of bills settled`)
          : 'Odoo is not connected, so nothing is known about bills'),
      stat('Cash actually moved', money(q.netMovement), 'collected in, less paid out'),
      stat('Waiting on customers', w.dso == null ? null : `${num(w.dso, 1)} days`,
        w.dso == null ? 'no takings to measure against'
          : `against ${w.dpo == null ? 'no known' : `${num(w.dpo, 1)} days`} waiting on suppliers`)),

    w.cashGapDays != null
      ? h('p.sub',
        w.cashGapDays > 0
          ? `Money is collected ${num(w.cashGapDays, 1)} days later than it is paid out. For those `
            + 'days the business is funding its customers out of its own pocket, and it will feel '
            + 'poor in a month it is profitable.'
          : `Suppliers are paid ${num(Math.abs(w.cashGapDays), 1)} days after the money for their goods `
            + 'has already been collected. That gap is working capital the business does not have to find.')
      : h('p.sub',
        'The cash cycle needs both sides — what customers owe and what suppliers are owed. '
        + 'Connect Odoo to complete it.'),

    h('p.sub.muted', w.inventoryNote));
}

function forecastCard(data) {
  const r = data.runRate;
  if (!r) return null;

  return h('div.card',
    h('h2', 'Where the month lands'),
    h('p.sub',
      `${num(r.elapsed)} days in, ${num(r.remaining)} to go. The projection runs on the typical day of `
      + `${money(r.typicalDay)} — the middle one, not the average, so a single wedding does not set the `
      + 'month — and the range is what an ordinary amount of day-to-day variation does to it. It is not '
      + 'a confidence interval and this data would not support one.'),
    h('div.grid.three',
      stat('Contribution so far', money(r.soFar)),
      stat('Month should end near', money(r.projected), `${moneyShort(r.low)} to ${moneyShort(r.high)}`),
      stat('Drifting per day', r.trendPerDay == null ? null : money(r.trendPerDay),
        r.trendPerDay == null ? 'no direction yet'
          : r.trendPerDay >= 0 ? 'each day a little better than the last' : 'each day a little worse')));
}
