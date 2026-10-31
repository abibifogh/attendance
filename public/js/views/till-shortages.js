import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, h, money, mount, toast } from '../util.js';
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
  const [data, toDecide] = await Promise.all([
    api.tillShortages(),
    api.tillToDecide().catch((err) => ({ issues: [], error: err.message })),
  ]);
  const cash = (n) => money(n, data.currency);
  const reload = async () => mount(host, ...(await renderTillShortages(params)).childNodes);
  const decideCard = decisions(toDecide, cash, reload);
  let show = SHOW.some(([k]) => k === params.show) ? params.show : 'all';
  let query = '';

  const head = h('div.page-head',
    h('div', h('h1', 'Advances'),
      h('div.sub', 'Till shortages taken from pay. Each comes off only while its shift is checked in Insight.')));

  const surplusCard = surplusesCard(data.surpluses ?? [], cash);
  if (!data.items.length) {
    mount(host, head, decideCard, surplusCard, toDecide.issues.length || surplusCard ? null : emptyState('No till shortages',
      'Once a shift with a shortage is checked in Insight, the shortage waits here for you to recover it from pay or not.'));
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
    decideCard,
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
    surplusCard,
  );
  return host;
}

/** Surpluses paid with salary: netted against a shortage on the same payslip, the rest added to pay. */
function surplusesCard(list, cash) {
  if (!list.length) return null;
  const coming = list.filter((c) => c.status === 'coming');
  return h('section.card',
    h('div.card-head', h('h2', 'Surpluses paid with salary'),
      coming.length ? h('span.card-note', `${coming.length} to pay · ${cash(coming.reduce((n, c) => n + c.amount, 0))}`) : null),
    h('p.muted', { style: { margin: 0, fontSize: '.88rem' } },
      'Money over on somebody’s account. On the payslip it meets any till shortage coming off that month first; what is left is added to their pay, untaxed.'),
    table([
      { key: 'staff', label: 'Name', format: (v) => h('div', h('div', v.name), v.department ? h('small.muted', v.department) : null) },
      { key: 'day', label: 'Shift', format: (v, r) => (v ? h('div', h('div', fmtDay(v)), r.slot ? h('small.muted', SLOT[r.slot] ?? r.slot) : null) : h('span.muted', '—')) },
      { key: 'what', label: 'What', format: (v) => h('small', v) },
      { key: 'amount', label: 'Amount', align: 'right', format: (v) => cash(v) },
      { key: 'decidedBy', label: 'Decided by', format: (v) => v || '—' },
      {
        key: 'status', label: 'Pay',
        format: (v, r) => h('div.ts-pay', h(`span.pill${v === 'paid' ? '.ok' : '.warn'}`, v === 'paid' ? 'Paid' : 'To pay'), h('small.muted', niceMonth(r.month))),
      },
    ], list, { empty: 'None.' }));
}

/**
 * Shortages on checked shifts, waiting for somebody to decide. Recover from
 * pay puts it on their next payslip as a till shortage and leaves it on their
 * list, marked recovered through payroll; not recovering takes it off their
 * list. Their answer, if they gave one, is beside it; none is needed.
 */
function decisions(toDecide, cash, reload) {
  if (toDecide.error) {
    return h('div.alert.warn', h('span.alert-icon', '⚠️'),
      h('div', h('div.alert-title', 'The shortages waiting for a decision cannot be read just now'),
        h('div.alert-detail', toDecide.error)));
  }
  const issues = toDecide.issues ?? [];
  if (!issues.length) return null;
  const decide = async (issue, outcome, button) => {
    if (outcome === 'writeoff' && !window.confirm(issue.surplus
      ? `Not pay ${cash(issue.amount)} to ${issue.name}? It leaves their list and nothing is added to their pay.`
      : `Not recover ${cash(issue.amount)} from ${issue.name}? It leaves their list and nothing comes off their pay.`)) return;
    button.disabled = true;
    try {
      await api.tillDecide({ key: issue.key, userId: issue.userId, outcome });
      toast(outcome === 'recover' ? `${cash(issue.amount)} comes off ${issue.name}'s next pay.`
        : outcome === 'pay' ? `${cash(issue.amount)} goes on ${issue.name}'s next pay, after any till shortage.`
          : `Done. It has left ${issue.name}'s list.`, 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
    }
  };
  const total = issues.reduce((n, i) => n + (i.surplus ? -(i.amount || 0) : (i.amount || 0)), 0);
  const may = Boolean(toDecide.canDecide);
  return h(`section.card${may ? '.wait' : ''}.ts-decide`,
    h('div.card-head', h('h2', may ? 'Waiting on you' : 'Waiting for an administrator'),
      h('span.card-note', `${issues.length} · ${total < 0 ? `${cash(-total)} over` : cash(total)}`)),
    h('p.muted', { style: { margin: 0, fontSize: '.88rem' } }, may
      ? 'Shortages and surpluses on shifts checked in Insight. Recover a shortage from pay, or pay a surplus with salary: a surplus meets any till shortage on the same payslip first. Not doing either takes it off their list.'
      : 'Shortages and surpluses on shifts checked in Insight. An administrator decides whether each goes through pay.'),
    h('div.ts-decide-list', issues.map((issue) => {
      const recover = issue.surplus
        ? h('button.btn-sm.btn-primary', { type: 'button' }, 'Pay with salary')
        : h('button.btn-sm.btn-primary', { type: 'button' }, 'Recover from pay');
      const leave = h('button.btn-sm', { type: 'button' }, issue.surplus ? 'Don’t pay' : 'Don’t recover');
      recover.addEventListener('click', () => decide(issue, issue.surplus ? 'pay' : 'recover', recover));
      leave.addEventListener('click', () => decide(issue, 'writeoff', leave));
      return h('div.ts-decide-row',
        h('div', h('strong', issue.name), issue.department ? h('small.muted', ` · ${issue.department}`) : null,
          h('div.muted', { style: { fontSize: '.85rem' } },
            `${fmtDay(issue.day)}, ${SLOT[issue.slot] ?? issue.slot} · ${issue.label}`
            + (issue.checkedBy ? ` · checked by ${issue.checkedBy}` : '')),
          issue.answer
            ? h('div.ts-said', h('strong', issue.answer.how === 'repay' ? 'Will pay it back: ' : 'Said: '), issue.answer.text)
            : h('div.muted', { style: { fontSize: '.82rem' } }, 'No answer from them yet.')),
        h('strong.ts-amount', issue.surplus ? h('span', { title: 'Over: owed to them' }, `+${cash(issue.amount)}`) : cash(issue.amount)),
        may ? h('div.btn-row', leave, recover) : h('span'));
    })));
}

function tile(value, label, tone = '') {
  return h(`div.card.home-tile${tone ? `.is-${tone}` : ''}`,
    h('span.home-tile-n', value), h('span.home-tile-l', label));
}
