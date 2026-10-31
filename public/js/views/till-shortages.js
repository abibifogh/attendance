import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, h, money, mount } from '../util.js';
import { emptyState, table } from './components.js';
import { niceMonth } from './att-shared.js';

/**
 * Till shortages: every one Insight has sent to be taken from pay, for
 * everybody, on one list.
 *
 * Each is recorded as a one-month advance, so Money › Advances holds the
 * record and anything done to it. This reads the same records as till
 * shortages: the shift, who checked it, who decided to recover it, and where
 * it stands. Held means its shift is not checked in Insight, so nothing comes
 * off until it is.
 */

const SLOT = { morning: 'morning', afternoon: 'afternoon', night: 'night' };

const STATUS = {
  coming: ['warn', 'Coming off'],
  held: ['bad', 'Held'],
  deducted: ['good', 'Deducted'],
  settled: ['', 'Settled another way'],
  cancelled: ['', 'Cancelled'],
};

const SHOW = [
  ['all', 'All'],
  ['coming', 'Coming off'],
  ['held', 'Held'],
  ['deducted', 'Deducted'],
];

export async function renderTillShortages(params = {}) {
  const host = h('div');
  const data = await api.tillShortages();
  const cash = (n) => money(n, data.currency);
  let show = SHOW.some(([k]) => k === params.show) ? params.show : 'all';
  let query = '';

  const head = h('div.page-head',
    h('div', h('h1', 'Advances'),
      h('div.sub', 'Till shortages taken from pay. Each comes off only while its shift is checked in Insight.')));

  if (!data.items.length) {
    mount(host, head, emptyState('No till shortages',
      'When a shortage on a checked shift is recovered from pay in Insight, it is listed here with its shift and who decided it.'));
    return host;
  }

  const count = (k) => (k === 'all' ? data.items.length : data.items.filter((i) => i.status === k).length);
  const list = h('div');
  const filters = h('div.seg.seg-wrap', { role: 'group', 'aria-label': 'Show' });
  const search = h('input.ts-search', {
    type: 'search', placeholder: 'Find a name', 'aria-label': 'Find a name',
    oninput: () => { query = search.value.trim().toLowerCase(); draw(); },
  });

  const columns = [
    {
      key: 'staff', label: 'Name',
      format: (v) => h('div', h('div', v.name), v.department ? h('small.muted', v.department) : null),
    },
    {
      key: 'day', label: 'Shift',
      format: (v, r) => (v ? h('div', h('div', fmtDay(v)), r.slot ? h('small.muted', SLOT[r.slot] ?? r.slot) : null) : h('span.muted', '—')),
    },
    { key: 'what', label: 'What', format: (v) => h('small', v) },
    { key: 'amount', label: 'Amount', align: 'right', format: (v, r) => h('div', cash(v), r.left > 0 && r.left < v ? h('small.muted', ` ${cash(r.left)} left`) : null) },
    {
      key: 'checkedAt', label: 'Shift checked',
      format: (v, r) => (v
        ? h('div', h('div', r.checkedBy || 'Yes'), h('small.muted', fmtDay(String(v).slice(0, 10))))
        : h('span.pill.bad', 'Not checked')),
    },
    {
      key: 'decidedBy', label: 'Recovered by',
      format: (v, r) => h('div', h('div', v || '—'), r.recordedOn ? h('small.muted', fmtDay(r.recordedOn)) : null),
    },
    {
      key: 'status', label: 'Pay',
      format: (v, r) => {
        const [tone, label] = STATUS[v] ?? ['', v];
        return h('div.ts-pay',
          h(`span.pill${tone ? `.${tone}` : ''}`, label),
          r.deducted.length
            ? r.deducted.map((d) => h('small.muted', `${niceMonth(d.month)}: ${cash(d.amount)}`))
            : r.comesOff ? h('small.muted', v === 'held' ? `${niceMonth(r.comesOff)} once checked` : niceMonth(r.comesOff)) : null);
      },
    },
  ];

  function draw() {
    mount(filters, SHOW.map(([k, label]) => h('button', {
      type: 'button',
      class: k === show ? 'active' : '',
      'aria-pressed': String(k === show),
      onclick: () => { show = k; replaceParams('till-shortages', k === 'all' ? {} : { show: k }); draw(); },
    }, `${label} ${count(k)}`)));
    const rows = data.items
      .filter((i) => show === 'all' || i.status === show)
      .filter((i) => !query || `${i.staff.name} ${i.staff.department ?? ''}`.toLowerCase().includes(query));
    mount(list, table(columns, rows, { empty: 'None of these.' }));
  }
  draw();

  mount(host,
    head,
    h('div.home-tiles',
      tile(cash(data.totals.coming), `Coming off ${niceMonth(data.month)} pay`, data.totals.coming ? 'warn' : ''),
      tile(cash(data.totals.held), 'Held: shift not checked', data.totals.held ? 'bad' : ''),
      tile(cash(data.totals.deducted), 'Deducted so far')),
    h('section.card',
      h('div.ts-tools', filters, search),
      list,
      h('p.muted.ts-note',
        'To change one, hold it over a month or take it off, open the person under the Advances view: each shortage is one of their advances. '
        + 'Why it was theirs, and their answer, are on their till list in Insight.')),
  );
  return host;
}

function tile(value, label, tone = '') {
  return h(`div.card.home-tile${tone ? `.is-${tone}` : ''}`,
    h('span.home-tile-n', value), h('span.home-tile-l', label));
}
