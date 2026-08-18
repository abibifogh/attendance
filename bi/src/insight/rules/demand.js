import { median, halves, sum, groupBy, correlation } from '../stats.js';
import { mid, revenueSourceFor } from '../labels.js';

/**
 * The hotel's own guests, as a denominator.
 *
 * `service_days.inhouse_guests` is typed into the breakfast app every morning
 * so the kitchen knows how many to cook for, and it is the only daily record
 * of how full the property is that exists anywhere in the group. Set against
 * the restaurant's covers it gives a capture rate; against the laundry's
 * orders an attach rate; against food purchases a cost per head.
 *
 * None of those three numbers has ever been calculable before, because the
 * denominator lived in a kitchen app and the numerators lived in two other
 * companies' software.
 */

export const guestCapture = {
  id: 'guest-capture',
  title: 'How much of the house each line sells to',
  needs: ['breakfast', 'pos', 'laundry'],
  run({ facts, money }) {
    const findings = [];
    const days = facts.dayList.filter((day) => (facts.demandByDay.get(day)?.inhouse_guests || 0) > 0);
    if (days.length < 21) return findings;

    const checks = [
      {
        line: 'restaurant',
        what: 'covers',
        of: (d) => d.covers,
        name: 'restaurant covers',
        action: 'A card in the room and a word at check-in is the cheapest revenue in the building.',
      },
      {
        line: 'laundry',
        what: 'orders',
        of: (d) => d.laundry_orders,
        name: 'laundry orders',
        action: 'Reception mentioning the service at check-in moves this more than anything the laundry itself can do.',
      },
    ];

    for (const check of checks) {
      const series = days.map((day) => {
        const d = facts.demandByDay.get(day);
        return { day, rate: check.of(d) / d.inhouse_guests, guests: d.inhouse_guests, count: check.of(d) };
      }).filter((r) => Number.isFinite(r.rate));
      if (series.length < 21) continue;

      const split = halves(series.map((r) => r.rate), 10);
      if (!split || split.changePct == null) continue;

      // A falling rate is a finding. A flat rate while the hotel empties is
      // also one, and a more useful one, because it says the line has no
      // demand of its own: it will shrink exactly as fast as the house does
      // and nothing it does on its own will change that.
      const guestSplit = halves(series.map((r) => r.guests), 10);
      const flat = Math.abs(split.changePct) < 8;
      const houseFalling = guestSplit && guestSplit.changePct != null && guestSplit.changePct < -10;

      if (split.changePct < -12) {
        const lineRows = facts.forLine(check.line);
        const perUnit = median(lineRows.filter((r) => r[check.what === 'covers' ? 'covers' : 'orders'] > 0)
          .map((r) => r.net / r[check.what === 'covers' ? 'covers' : 'orders']));
        const laterGuests = sum(series.slice(Math.floor(series.length / 2)).map((r) => r.guests));
        const lost = Math.round((split.before - split.after) * laterGuests * (perUnit || 0));
        findings.push({
          ruleId: this.id,
          severity: 'warning',
          line: check.line,
          headline: `Fewer of the guests in house are using ${mid(check.line)}`,
          detail: [
            `${Math.round(split.before * 100)} in 100 guests generated a ${check.name.replace(/s$/, '')} in the first half of the window; now it is ${Math.round(split.after * 100)} in 100.`,
            `Applied to the guests who have stayed since, that is about ${money(Math.max(0, lost))} of trade that used to happen and no longer does.`,
            'Nothing in the hotel is short of guests to sell to — it is selling to fewer of them.',
          ].join(' '),
          action: check.action,
          impactMonthly: Math.round(Math.max(0, lost) / Math.max(1, series.length / 2) * 30),
          confidence: series.length >= 45 ? 'high' : 'medium',
          sources: ['breakfast', revenueSourceFor(check.line)].filter(Boolean),
          evidence: {
            beforePer100Guests: Math.round(split.before * 100),
            afterPer100Guests: Math.round(split.after * 100),
            changePct: split.changePct,
            days: series.length,
          },
        });
      } else if (flat && houseFalling) {
        findings.push({
          ruleId: this.id,
          severity: 'info',
          line: check.line,
          headline: `${mid(check.line).replace(/^./, (c) => c.toUpperCase())} is tracking the house down, not falling on its own`,
          detail: [
            `Guests in house are down ${Math.abs(guestSplit.changePct)}% across the window, and ${check.name} per guest has held steady at ${Math.round(split.after * 100)} in 100.`,
            `So ${mid(check.line)}'s takings are falling for a reason that has nothing to do with the ${check.line}.`,
            'Judging it on its own turnover will produce the wrong decision.',
          ].join(' '),
          action: `Measure ${mid(check.line)} on ${check.name} per guest, not on turnover, until the house fills again.`,
          impactMonthly: 0,
          confidence: 'high',
          sources: ['breakfast', revenueSourceFor(check.line)].filter(Boolean),
          evidence: {
            guestChangePct: guestSplit.changePct,
            ratePer100Guests: Math.round(split.after * 100),
            rateChangePct: split.changePct,
          },
        });
      }
    }
    return findings;
  },
};

export const foodCostPerGuest = {
  id: 'food-cost-per-guest',
  title: 'What it costs to feed a guest',
  needs: ['breakfast'],
  run({ facts, money }) {
    const findings = [];
    const days = facts.dayList.map((day) => {
      const d = facts.demandByDay.get(day);
      const guests = (d?.inhouse_guests || 0) + (d?.outside_guests || 0);
      const used = sum(facts.usage.filter((u) => u.day === day).map((u) => u.value));
      return { day, guests, used, perGuest: guests > 0 ? used / guests : null };
    }).filter((r) => r.perGuest != null && r.used > 0);

    if (days.length < 21) return findings;

    const split = halves(days.map((r) => r.perGuest), 10);
    if (!split || split.changePct == null || split.changePct < 10) return findings;

    // Separate a price rise from more being eaten. They call for completely
    // different conversations — one with a supplier, one with the kitchen —
    // and the purchase lines can tell them apart.
    const priceSplit = priceMove(facts);
    const laterGuests = sum(days.slice(Math.floor(days.length / 2)).map((r) => r.guests));
    const extra = Math.round((split.after - split.before) * laterGuests);
    const perDay = extra / Math.max(1, Math.ceil(days.length / 2));

    const explained = priceSplit && priceSplit.changePct != null && priceSplit.changePct > 8;

    findings.push({
      ruleId: this.id,
      severity: split.changePct > 25 ? 'warning' : 'info',
      line: 'breakfast',
      headline: `Feeding a guest costs ${split.changePct}% more than it did`,
      detail: [
        `Food used per head has gone from ${money(Math.round(split.before))} to ${money(Math.round(split.after))} across ${split.n} days.`,
        explained
          ? `Purchase prices are up ${priceSplit.changePct}% over the same period on the same items, so most of this is the market rather than the kitchen.`
          : 'Purchase prices have not moved enough to explain it, so more is being used per head than before.',
        `On the guests served since, the difference is about ${money(Math.max(0, extra))}.`,
      ].join(' '),
      action: explained
        ? 'Take the price rise to the supplier, or reprice the affected items. The kitchen is not the problem here.'
        : 'Compare a few days of recorded usage against what was actually served. A drift this size is portioning, waste or stock leaving.',
      impactMonthly: Math.round(Math.max(0, perDay) * 30),
      confidence: days.length >= 45 ? 'high' : 'medium',
      sources: ['breakfast'],
      evidence: {
        beforePerGuest: Math.round(split.before),
        afterPerGuest: Math.round(split.after),
        changePct: split.changePct,
        purchasePriceChangePct: priceSplit?.changePct ?? null,
        days: days.length,
      },
    });
    return findings;
  },
};

/** Has the price of what the kitchen buys moved, on a like-for-like basis? */
function priceMove(facts) {
  const lines = facts.purchases.filter((p) => p.line_id === 'breakfast' && p.unit_cost > 0);
  if (lines.length < 12) return null;
  // Per item, so a change in the shopping basket cannot masquerade as a price
  // rise. The median across items is the answer.
  const byItem = groupBy(lines, (p) => p.item_key || p.item_name);
  const moves = [];
  for (const [, rows] of byItem) {
    const ordered = rows.slice().sort((a, b) => a.day.localeCompare(b.day));
    const split = halves(ordered.map((r) => r.unit_cost), 2);
    if (split && split.changePct != null) moves.push(split.changePct);
  }
  const changePct = median(moves);
  return changePct == null ? null : { changePct: Math.round(changePct * 10) / 10, items: moves.length };
}

export const usageOutliers = {
  id: 'usage-outliers',
  title: 'Stock used against guests fed',
  needs: ['breakfast'],
  run({ facts, money }) {
    const findings = [];
    const guestsOn = (day) => {
      const d = facts.demandByDay.get(day);
      return (d?.inhouse_guests || 0) + (d?.outside_guests || 0);
    };
    const byItem = groupBy(facts.usage.filter((u) => guestsOn(u.day) > 0), (u) => u.item_name);

    for (const [item, rows] of byItem) {
      if (rows.length < 21) continue;
      const series = rows.slice().sort((a, b) => a.day.localeCompare(b.day))
        .map((u) => ({ day: u.day, per: u.qty / guestsOn(u.day), value: u.value }));
      const split = halves(series.map((r) => r.per), 10);
      if (!split || split.changePct == null || split.changePct < 20) continue;

      const laterValue = sum(series.slice(Math.floor(series.length / 2)).map((r) => r.value));
      const excess = Math.round(laterValue * (split.changePct / (100 + split.changePct)));
      const perDay = excess / Math.max(1, Math.ceil(series.length / 2));
      if (perDay < 500) continue;   // below five cedis a day, not worth a line on a screen

      findings.push({
        ruleId: this.id,
        severity: split.changePct > 45 ? 'warning' : 'info',
        line: 'breakfast',
        headline: `${item} used per guest is up ${split.changePct}%`,
        detail: [
          `Per guest fed, ${item.toLowerCase()} has gone from ${round3(split.before)} to ${round3(split.after)} a head across ${split.n} days.`,
          'Guest numbers are already divided out, so this is not a busier hotel.',
          `At the recorded cost, the extra is worth about ${money(Math.max(0, excess))} over the later half of the window.`,
        ].join(' '),
        action: `Weigh a day's ${item.toLowerCase()} against the portions actually served. If they agree, the recipe has changed; if they do not, the stock has.`,
        impactMonthly: Math.round(Math.max(0, perDay) * 30),
        confidence: series.length >= 45 ? 'medium' : 'low',
        sources: ['breakfast'],
        evidence: {
          item,
          beforePerGuest: round3(split.before),
          afterPerGuest: round3(split.after),
          changePct: split.changePct,
          days: series.length,
        },
      });
    }
    return findings.sort((a, b) => b.impactMonthly - a.impactMonthly).slice(0, 3);
  },
};

const round3 = (n) => Math.round(n * 1000) / 1000;
