import { add, h, money, num, percent, dayRange } from '../util.js';
import { api } from '../api.js';
import { lineChart, stackedColumns } from '../charts.js';
import { table, banner, caveats } from './components.js';

/**
 * Money charged, money collected, and money that was neither.
 *
 * The person table on this screen names people, so it says plainly how each
 * name was matched. A row matched on a name alone is a weaker claim than one
 * matched on an employee number, and somebody reading it deserves to be told
 * which they are looking at before they act on it.
 */
export async function renderCash(root, { range }) {
  const data = await api(`/cash?from=${range.from}&to=${range.to}`);
  const s = data.summary;

  add(root, 
    data.demoMode ? banner('demo', h('strong', 'Demonstration data.'), ' The names below are invented.') : null,

    h('div.card',
      h('h2', 'Charged, collected, outstanding'),
      h('p.sub', dayRange(data.range.from, data.range.to)),
      h('div.grid.three',
        h('div.tile', h('div.label', 'Charged'), h('div.value', money(s.charged))),
        h('div.tile', h('div.label', 'Collected'), h('div.value', money(s.collected)),
          h('div.note', `${percent(s.collectedPct)} of what was charged.`)),
        h('div.tile', h('div.label', 'Still owed'), h('div.value', money(s.outstanding)),
          h('div.note', 'Charged and not yet received. Guests who leave owing rarely come back to settle.'))),
      lineChart(data.daily, [
        { key: 'collected', label: 'Collected', colour: 'var(--series-1)', value: (r) => r.collected },
        { key: 'outstanding', label: 'Left owing', colour: 'var(--series-2)', value: (r) => r.outstanding },
      ], { height: 190 })),

    h('div.card',
      h('h2', 'How it was paid'),
      h('p.sub', 'The tender mix adds to what was collected, so it is one stacked column a day.'),
      stackedColumns(data.daily, [
        { key: 'cash', label: 'Cash', colour: 'var(--series-1)', value: (r) => r.cash },
        { key: 'card', label: 'Card', colour: 'var(--series-2)', value: (r) => r.card },
        { key: 'other', label: 'Mobile money and other', colour: 'var(--series-3)', value: (r) => r.other },
      ], { height: 190 })),

    h('div.card',
      h('h2', 'Till closes'),
      h('p.sub', `${num(s.closes)} closes, ${num(s.shortCloses)} of them short by more than five cedis. Together they came to ${money(s.totalVariance)}.`),
      table([
        { label: 'Person', get: (r) => r.name },
        {
          label: 'Matched by',
          get: (r) => h('span.pill', r.matchedBy === 'exact'
            ? 'employee number'
            : 'name only — weaker'),
        },
        { label: 'Department', get: (r) => r.department || '—' },
        { label: 'Closes', num: true, get: (r) => num(r.closes) },
        { label: 'Short closes', num: true, get: (r) => num(r.shortCloses) },
        { label: 'Rate', num: true, get: (r) => percent(r.shortRatePct, 0) },
        { label: 'Net variance', num: true, get: (r) => money(r.totalVariance) },
        { label: 'Worst single close', num: true, get: (r) => money(r.worstVariance) },
      ], data.people),
      caveats([
        data.note,
        'A short till is usually a mistake. This table is a place to start a conversation, not a conclusion about anybody.',
      ])),
  );
}
