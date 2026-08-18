import { add, h, money, moneyShort, num, percent, hours, dayRange, lineColour } from '../util.js';
import { api } from '../api.js';
import { lineChart, barChart, smallMultiples } from '../charts.js';
import { table, banner, caveats } from './components.js';

/**
 * Hours, and what they earned.
 *
 * The attendance terminal has always known the first half of this and never
 * the second. Setting them beside each other is the single most valuable join
 * in the group, because labour is the largest cost anybody here can actually
 * change this week.
 */
export async function renderLabour(root, { range }) {
  const data = await api(`/labour?from=${range.from}&to=${range.to}`);

  add(root, 
    data.demoMode ? banner('demo', h('strong', 'Demonstration data.'), ' Not the business.') : null,

    h('div.card',
      h('h2', 'Revenue per hour worked'),
      h('p.sub', `${dayRange(data.range.from, data.range.to)}. Everything the four systems recorded as revenue, divided by every hour the terminal recorded as worked.`),
      lineChart(data.daily, [
        { key: 'rph', label: 'Revenue per hour worked', colour: 'var(--series-1)', value: (r) => r.revenuePerHour },
      ], { height: 200 })),

    h('div.card',
      h('h2', 'Hours against the work there was'),
      h('p.sub', 'Hours worked and guests in house, each on its own scale. Putting them on one pair of axes would let whoever drew the chart decide which line looked like it was leading.'),
      smallMultiples(data.daily, [
        { key: 'hours', title: 'Hours worked', colour: 'var(--series-2)', value: (r) => r.hours, format: (v) => num(v) },
        { key: 'guests', title: 'Guests in house', colour: 'var(--series-3)', value: (r) => r.guests, format: (v) => num(v) },
      ])),

    h('div.card',
      h('h2', 'The week, as it actually runs'),
      h('p.sub', 'The median day of each weekday. This is the table a rota is changed from.'),
      table([
        { label: 'Weekday', get: (r) => r.dowLabel },
        { label: 'Days', num: true, get: (r) => num(r.days) },
        { label: 'Hours worked', num: true, get: (r) => num(r.medianHours, 1) },
        { label: 'Guests', num: true, get: (r) => num(r.medianGuests) },
        { label: 'Revenue', num: true, get: (r) => money(r.medianNet) },
        { label: 'Revenue per hour', num: true, get: (r) => money(r.medianRevenuePerHour) },
      ], data.weekdays)),

    h('div.card',
      h('h2', 'What each department costs'),
      h('p.sub', 'Hours priced at the group rate unless a person carries their own. Departments are mapped to parts of the business; anything unrecognised lands in admin, on purpose, so that an unmapped department shows up rather than being quietly spread across the rest.'),
      barChart(data.departments.slice(0, 12), {
        label: (r) => r.department,
        value: (r) => r.cost,
        colour: (r) => lineColour(r.line),
      }),
      table([
        { label: 'Department', get: (r) => r.department },
        { label: 'Part of the business', get: (r) => r.line },
        { label: 'Hours', num: true, get: (r) => num(r.hours, 1) },
        { label: 'Wage cost', num: true, get: (r) => money(r.cost) },
        { label: 'Overtime hours', num: true, get: (r) => num(r.overtimeHours, 1) },
        { label: 'Late (minutes)', num: true, get: (r) => num(r.lateMinutes) },
        { label: 'Absences', num: true, get: (r) => num(r.absences) },
        { label: 'Days on leave', num: true, get: (r) => num(r.leaveDays) },
      ], data.departments)),
  );
}
