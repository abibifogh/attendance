import { add, h, money, num, percent, dayRange } from '../util.js';
import { api } from '../api.js';
import { barChart } from '../charts.js';
import { table, banner, caveats } from './components.js';

/**
 * What the group buys, as one account rather than three.
 *
 * The comparison table at the bottom is the reason the warehouse bothers to
 * resolve item names at all: it is the only place in any of the group's
 * software where the price the kitchen paid and the price the restaurant paid
 * for the same thing appear on the same row.
 */
export async function renderSuppliers(root, { range }) {
  const data = await api(`/suppliers?from=${range.from}&to=${range.to}`);

  add(root, 
    data.demoMode ? banner('demo', h('strong', 'Demonstration data.'), ' The suppliers below are invented.') : null,

    h('div.card',
      h('h2', 'Group spend by supplier'),
      h('p.sub', `${dayRange(data.range.from, data.range.to)}. Every purchase from the breakfast store, the restaurant and the maintenance store, added together for the first time.`),
      barChart(data.suppliers.slice(0, 12), {
        label: (r) => r.supplier,
        value: (r) => r.spend,
      }),
      table([
        { label: 'Supplier', get: (r) => r.supplier },
        { label: 'Spend', num: true, get: (r) => money(r.spend) },
        { label: 'Share', num: true, get: (r) => percent(r.sharePct) },
        { label: 'Purchases', num: true, get: (r) => num(r.purchases) },
        { label: 'Bought for', get: (r) => r.lines.join(', ') },
        { label: 'Mostly', get: (r) => r.items.slice(0, 4).join(', ') },
      ], data.suppliers)),

    h('div.card',
      h('h2', 'The same item, bought twice'),
      h('p.sub', 'Items bought by more than one part of the business, in the same unit, in this window. The gap is what the dearer side pays over the cheaper.'),
      data.comparisons.length
        ? table([
          { label: 'Item', get: (r) => r.item },
          { label: 'Unit', get: (r) => r.unit || '—' },
          {
            label: 'Prices',
            get: (r) => h('span', r.sides.map((side, i) => h('span',
              i ? ' · ' : '', `${side.label} ${money(side.unitCost)}`))),
          },
          { label: 'Gap', num: true, get: (r) => percent(r.gapPct) },
          { label: 'Could have saved', num: true, get: (r) => money(r.couldSave) },
          { label: 'Suppliers', get: (r) => [...new Set(r.sides.map((x) => x.supplier).filter(Boolean))].join(' / ') || '—' },
        ], data.comparisons)
        : h('p.muted', 'Nothing was bought by two parts of the business in the same unit in this window, so there is nothing to compare.'),
      caveats([data.note])),
  );
}
