import { api } from '../api.js';
import { confirmAction, fmtDay, h, money, mount, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { niceMonth } from './att-advances.js';

/**
 * My salary advance.
 *
 * The one screen in this app about money somebody owes rather than money they
 * are owed, and the reason it exists is that the alternative is asking. The
 * question "how much is left on my advance" currently gets answered by a
 * manager looking in a notebook, which means it gets answered slowly, in front
 * of other people, and sometimes wrongly.
 *
 * THREE THINGS, IN THIS ORDER. What is left. What comes off next month. When
 * it ends. Everything else on the page is the working behind those three, and
 * the working matters: somebody who cannot see the months they have already
 * paid has no way of disagreeing with the total.
 *
 * NOTHING HERE IS A DECISION. Asking for an advance is asking. The screen says
 * so plainly, because an app that reads like an approval is how somebody ends
 * up counting on money that is not coming.
 */

export async function renderAttMyAdvance() {
  const host = h('div');
  const data = await api.myAdvances();
  const cash = (n) => money(n, data.currency);
  const reload = async () => mount(host, await renderAttMyAdvance());

  if (!data.linked) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'My advance'))),
      emptyState('This login is not linked to your staff record',
        'Ask whoever set it up to point it at you under Users, and this will fill in.'));
    return host;
  }

  const waiting = data.advances.find((a) => a.status === 'requested');
  const running = data.advances.filter((a) => a.status === 'approved');
  const done = data.advances.filter((a) => ['settled', 'declined', 'withdrawn'].includes(a.status));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My advance'),
        h('div.sub', 'What you owe, what comes off, and when it ends'),
      ),
      waiting || running.length
        ? null
        : h('button.btn-sm.btn-primary', { onclick: () => ask(reload, cash) }, 'Ask for an advance'),
    ),

    waiting ? waitingCard(waiting, reload, cash) : null,

    running.length
      ? running.map((advance) => runningCard(advance, cash))
      : (waiting ? null : card('Nothing owed', {},
        h('p.muted', 'You have no advance running. If you need one, ask and somebody will '
          + 'decide.'))),

    // Only worth showing where there is something to show. A permanent "no
    // history" heading is a row of a phone screen given over to saying nothing.
    done.length
      ? card('Before this', { note: `${done.length}` },
        h('ul.adv-history', done.map((advance) => h('li',
          h('div',
            h('strong', cash(advance.amount)),
            h('span.muted', ` · ${STATUS[advance.status] ?? advance.status}`)),
          h('small.muted', advance.takenOn ? fmtDay(advance.takenOn) : '')))))
      : null,
  );

  return host;
}

const STATUS = {
  settled: 'paid off',
  declined: 'turned down',
  withdrawn: 'you took it back',
};

function waitingCard(advance, reload, cash) {
  return card('Waiting on a decision', { note: 'not agreed yet' },
    h('p', h('strong', cash(advance.amount)),
      ` over ${advance.months} month${advance.months === 1 ? '' : 's'}`,
      advance.reason ? ` — ${advance.reason}` : ''),
    h('p.muted', { style: { fontSize: '.88rem' } },
      'Nothing has been agreed and nothing will come off your pay until somebody says yes. '
      + 'You will get a message either way.'),
    h('button.btn-sm', {
      onclick: async () => {
        if (!confirmAction('Take back your request?')) return;
        await api.myWithdrawAdvance(advance.id);
        toast('Taken back.', 'good');
        await reload();
      },
    }, 'Take it back'));
}

/**
 * The one that is running.
 *
 * A bar rather than a number on its own: "GHS 600 of GHS 1,200" is arithmetic,
 * and a half-filled bar is a fact somebody takes in at a glance on a phone in a
 * corridor.
 */
function runningCard(advance, cash) {
  const paid = Math.max(0, advance.amount - advance.balance);
  const share = advance.amount > 0 ? Math.min(1, paid / advance.amount) : 0;
  const ahead = advance.schedule.filter((row) => !row.done);
  const behind = advance.schedule.filter((row) => row.done);

  return card('What is left', {
    note: advance.takenOn ? `taken ${fmtDay(advance.takenOn)}` : null,
  },
  h('div.adv-mine',
    h('div.adv-mine-figure',
      h('div.adv-mine-label', 'Still to pay'),
      h('div.adv-mine-value', cash(advance.balance)),
      h('div.muted', `of ${cash(advance.amount)}`)),
    h('div.adv-mine-bar',
      h('div.adv-mine-track', h('div.adv-mine-fill', { style: { width: `${Math.round(share * 100)}%` } })),
      h('div.adv-mine-ends',
        h('span', `${cash(paid)} paid`),
        h('span', advance.finishes ? `Last one ${niceMonth(advance.finishes)}` : '')))),

  h('div.grid.grid-3', { style: { marginTop: '.9rem' } },
    h('div.stat',
      h('div.stat-label', 'Off your pay each month'),
      h('div.stat-value', cash(advance.monthly)),
      h('div.stat-sub', advance.reason || 'as agreed')),
    h('div.stat',
      h('div.stat-label', 'Paydays left'),
      h('div.stat-value', advance.left == null ? '—' : String(advance.left)),
      h('div.stat-sub', advance.finishes ? `ending ${niceMonth(advance.finishes)}` : '')),
    h('div.stat',
      h('div.stat-label', 'Paid so far'),
      h('div.stat-value', cash(paid)),
      h('div.stat-sub', `${behind.length} month${behind.length === 1 ? '' : 's'} in`))),

  h('h3.adv-sub', 'Month by month'),
  h('p.muted', { style: { fontSize: '.85rem', marginTop: '-.4rem' } },
    'The months behind you are what actually came off. The ones ahead are what is expected, and '
    + 'they move if anything changes.'),

  h('div.table-wrap', h('table.adv-schedule',
    h('tbody',
      behind.map((row) => h('tr',
        h('td', niceMonth(row.month)),
        h('td', row.skipped
          ? h('span.pill.warn', 'nothing taken')
          : h('span.pill.good', 'taken')),
        h('td.num', row.skipped ? h('span.muted', '—') : cash(row.paid)),
        h('td.num.muted', `${cash(row.balance)} left`))),
      ahead.map((row) => h('tr.adv-ahead',
        h('td', niceMonth(row.month)),
        h('td', h('span.muted', 'to come')),
        h('td.num', cash(row.paid)),
        h('td.num.muted', `${cash(row.balance)} left`)))))),

  h('p.muted', { style: { fontSize: '.82rem' } },
    'If a month here does not match your payslip, say so — the figures are kept by hand and a '
    + 'mistake is worth catching in the same month it happened.'));
}

/** Ask for one. */
async function ask(reload, cash) {
  const amount = h('input', { type: 'number', name: 'amount', step: '0.01', min: '1', required: true });
  const months = h('input', { type: 'number', name: 'months', min: '1', max: '24', value: 3, required: true });
  const each = h('p.muted', { style: { fontSize: '.9rem', margin: '.2rem 0 0' } }, ' ');

  const recompute = () => {
    const total = Number(amount.value) || 0;
    const over = Math.max(1, Number(months.value) || 1);
    each.textContent = total
      ? `That is about ${cash(Math.ceil((total / over) * 100) / 100)} off your pay each month.`
      : ' ';
  };
  amount.addEventListener('input', recompute);
  months.addEventListener('input', recompute);

  const done = await formDialog({
    title: 'Ask for a salary advance',
    submitLabel: 'Send the request',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'This is a request, not an agreement. Somebody will decide, and you will be told either '
        + 'way. Nothing comes off your pay unless it is agreed.'),
      h('div.field-row',
        field('How much', amount),
        field('Over how many months', months)),
      each,
      field('What it is for', h('input', { type: 'text', name: 'reason', maxlength: 300 }),
        'Optional, but it helps whoever decides')),
    onSubmit: (form) => api.myAskForAdvance(Object.fromEntries(form.entries())),
  });
  if (!done) return;
  toast('Sent. You will be told when it is decided.', 'good');
  await reload();
}
