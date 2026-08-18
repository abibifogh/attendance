import { add, h, money, moneyShort, num, percent, dayRange, lineColour } from '../util.js';
import { api } from '../api.js';
import { lineChart, barChart, smallMultiples } from '../charts.js';
import { table, caveats, banner } from './components.js';

/**
 * Where the money goes, by part of the business.
 *
 * The table is the point of this screen and the charts serve it. Four systems
 * have never been added up before, so the first useful thing is simply the
 * addition, laid out so that a line which costs more than it earns cannot hide
 * inside a group total.
 */
export async function renderPnl(root, { range }) {
  const data = await api(`/pnl?from=${range.from}&to=${range.to}`);
  const revenueLines = data.lines.filter((l) => l.net > 0 || l.labour > 0 || l.cost > 0);

  add(root, 
    data.demoMode ? banner('demo', h('strong', 'Demonstration data.'), ' Not the business.') : null,

    h('div.card',
      h('h2', 'Contribution by part of the business'),
      h('p.sub', `${dayRange(data.range.from, data.range.to)}. Revenue less purchases and wages. A bar to the left of the line is a part of the business that costs more than it brings in.`),
      barChart(revenueLines.slice().sort((a, b) => b.contribution - a.contribution), {
        label: (r) => r.label,
        value: (r) => r.contribution,
        colour: (r) => (r.contribution < 0 ? 'var(--critical)' : lineColour(r.line)),
      })),

    h('div.card',
      h('h2', 'The whole of it'),
      table([
        { label: 'Line', get: (r) => r.label },
        { label: 'Revenue', num: true, get: (r) => money(r.net), foot: (t) => money(t.net) },
        { label: 'Purchases', num: true, get: (r) => money(r.cost), foot: (t) => money(t.cost) },
        { label: 'Wages', num: true, get: (r) => money(r.labour), foot: (t) => money(t.labourCost) },
        { label: 'Contribution', num: true, get: (r) => money(r.contribution), foot: (t) => money(t.contribution) },
        { label: 'Margin', num: true, get: (r) => percent(r.marginPct) },
        { label: 'Wages as % of revenue', num: true, get: (r) => percent(r.labourPct) },
        { label: 'Hours', num: true, get: (r) => num(r.hours, 1) },
        { label: 'Revenue per hour', num: true, get: (r) => money(r.revenuePerHour) },
      ], revenueLines, { footer: data.total }),
      caveats(data.caveats)),

    h('div.card',
      h('h2', 'Day by day'),
      h('p.sub', 'Revenue against what it cost to produce it. Both are money, so they share one axis.'),
      lineChart(data.daily, [
        { key: 'net', label: 'Revenue', colour: 'var(--series-1)', value: (r) => r.net },
        { key: 'spend', label: 'Purchases and wages', colour: 'var(--series-2)', value: (r) => r.cost + r.labour },
      ], { height: 210 })),

    h('div.card',
      h('h2', 'Contribution against how full the hotel was'),
      h('p.sub', 'Two different measures, so two panels rather than two axes on one chart. Guests come from the breakfast app; contribution comes from all four systems.'),
      smallMultiples(data.daily, [
        { key: 'contribution', title: 'Contribution', colour: 'var(--series-1)', value: (r) => r.contribution, format: moneyShort },
        { key: 'guests', title: 'Guests in house', colour: 'var(--series-3)', value: (r) => r.guests, format: (v) => num(v) },
      ])),
  );
}
