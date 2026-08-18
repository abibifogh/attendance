import { median, sum, groupBy } from '../stats.js';

/**
 * Buying the same thing twice, at two prices.
 *
 * The kitchen buys tomatoes through the breakfast app. The restaurant buys
 * tomatoes through the POS. Maintenance buys through a third list. Each system
 * keeps its own suppliers, its own item names and its own prices, and no
 * screen in the group has ever put two of them side by side — so a supplier
 * charging one arm of the business half as much again as another is invisible
 * by construction, not by anybody's oversight.
 *
 * Two guards keep this honest. Prices are only compared within the same unit,
 * because a kilo and a crate are not a price difference. And a comparison
 * needs purchases from both sides inside the same window, because a price from
 * March against a price from August is inflation, not a discrepancy.
 */

export const priceDivergence = {
  id: 'price-divergence',
  title: 'The same item, two prices',
  needs: ['breakfast', 'pos'],
  run({ facts, money }) {
    const findings = [];
    const lines = facts.purchases.filter((p) => p.unit_cost > 0 && p.qty > 0 && p.item_id);
    const byItem = groupBy(lines, (p) => `${p.item_id}|${p.unit || ''}`);

    for (const [, rows] of byItem) {
      const bySide = groupBy(rows, (r) => r.line_id);
      if (bySide.size < 2) continue;

      const sides = [...bySide.entries()]
        .map(([line, lineRows]) => ({
          line,
          price: median(lineRows.map((r) => r.unit_cost)),
          spend: sum(lineRows.map((r) => r.amount)),
          qty: sum(lineRows.map((r) => r.qty)),
          purchases: lineRows.length,
          supplier: mostCommon(lineRows.map((r) => r.supplier_name).filter(Boolean)),
        }))
        .filter((s) => s.price && s.purchases >= 3)
        .sort((a, b) => a.price - b.price);

      if (sides.length < 2) continue;
      const cheap = sides[0];
      const dear = sides[sides.length - 1];
      const gap = Math.round(((dear.price - cheap.price) / cheap.price) * 1000) / 10;
      if (gap < 12) continue;

      const item = rows[0].item_name;
      const unit = rows[0].unit ? ` per ${rows[0].unit}` : '';
      // What the dearer side would have saved at the cheaper price, over what
      // it actually bought. Real quantities, not a projection.
      const saving = Math.round(dear.qty * (dear.price - cheap.price));
      const sameSupplier = cheap.supplier && dear.supplier
        && cheap.supplier.toLowerCase() === dear.supplier.toLowerCase();

      findings.push({
        ruleId: this.id,
        severity: sameSupplier && gap > 25 ? 'warning' : 'info',
        line: dear.line,
        headline: sameSupplier
          ? `${dear.supplier} charges ${dear.line} ${gap}% more for ${item.toLowerCase()} than ${cheap.line}`
          : `${item} costs ${dear.line} ${gap}% more than ${cheap.line}`,
        detail: [
          `${dear.line} pays about ${money(dear.price)}${unit} across ${dear.purchases} purchases; ${cheap.line} pays ${money(cheap.price)}${unit} across ${cheap.purchases}.`,
          sameSupplier
            ? `Both buy it from ${dear.supplier}, in the same window, in the same unit.`
            : `${dear.line} buys from ${dear.supplier || 'an unrecorded supplier'}, ${cheap.line} from ${cheap.supplier || 'an unrecorded supplier'}.`,
          `On the quantity ${dear.line} actually bought, the difference is ${money(Math.max(0, saving))}.`,
        ].join(' '),
        action: sameSupplier
          ? `Put both invoices in front of ${dear.supplier}. A supplier quoting two prices to one group usually only needs to be shown that the group noticed.`
          : `Buy ${item.toLowerCase()} for both sides on whichever account gets the better price.`,
        impactMonthly: Math.round(Math.max(0, saving) / Math.max(1, facts.dayList.length) * 30),
        confidence: dear.purchases >= 6 && cheap.purchases >= 6 ? 'high' : 'medium',
        sources: ['breakfast', 'pos'],
        evidence: {
          item, unit: rows[0].unit || null,
          dearer: { line: dear.line, unitCost: dear.price, purchases: dear.purchases, supplier: dear.supplier },
          cheaper: { line: cheap.line, unitCost: cheap.price, purchases: cheap.purchases, supplier: cheap.supplier },
          gapPct: gap,
          sameSupplier,
        },
      });
    }
    return findings.sort((a, b) => b.impactMonthly - a.impactMonthly).slice(0, 4);
  },
};

export const supplierConcentration = {
  id: 'supplier-concentration',
  title: 'What the group spends, per supplier, across everything',
  needs: ['breakfast', 'pos'],
  run({ facts, money }) {
    const findings = [];
    const lines = facts.purchases.filter((p) => p.supplier_id && p.amount > 0);
    if (lines.length < 20) return findings;

    const total = sum(lines.map((l) => l.amount));
    const bySupplier = groupBy(lines, (l) => l.supplier_name || `supplier ${l.supplier_id}`);

    for (const [supplier, rows] of bySupplier) {
      const spend = sum(rows.map((r) => r.amount));
      const share = Math.round((spend / total) * 1000) / 10;
      const acrossLines = new Set(rows.map((r) => r.line_id));
      // Only interesting when it is both large and spread across arms of the
      // business that have never compared notes — that is the combination that
      // means the group has buying power it is not using.
      if (share < 25 || acrossLines.size < 2) continue;

      findings.push({
        ruleId: this.id,
        severity: 'info',
        line: null,
        headline: `${supplier} takes ${share}% of everything the group buys`,
        detail: [
          `${money(spend)} of ${money(total)} in the window, across ${acrossLines.size} parts of the business (${[...acrossLines].join(', ')}) that each order separately.`,
          'Each arm negotiates as if it were a small customer, because each only sees its own half of the account.',
        ].join(' '),
        action: `Order as one account. A supplier already taking ${share}% of the group's spend has room to price it as one customer.`,
        impactMonthly: Math.round(spend * 0.05 / Math.max(1, facts.dayList.length) * 30),
        confidence: 'medium',
        sources: ['breakfast', 'pos'],
        evidence: { supplier, spend, groupSpend: total, sharePct: share, lines: [...acrossLines] },
      });
    }
    return findings.sort((a, b) => b.impactMonthly - a.impactMonthly).slice(0, 2);
  },
};

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [value, count] of counts) if (!best || count > best.count) best = { value, count };
  return best?.value ?? null;
}
