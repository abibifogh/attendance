import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDayShort, h, money, mount } from '../util.js';
import { askForLeave, editMyAvailability, leaveRow } from './att-me.js';
import { ask as askForAdvance } from './att-my-advance.js';
import { makeClaim } from './att-my-medical.js';
import { icon } from '../icons.js';
import { holidayCard } from './holiday-choice.js';

/**
 * Everything somebody can ask for, and what became of it.
 *
 * Time off, a day they cannot work, a shift to give away, an advance, a
 * medical claim and a change to lunch were each asked for on a different
 * screen, and the answer to each came back on that screen. This is the one
 * place for both: six buttons, and one list of what they have asked.
 */
export async function renderRequests() {
  const host = h('div.requests');
  const reload = async () => mount(host, ...(await body(reload)));
  mount(host, ...(await body(reload)));
  return host;
}

async function body(reload) {
  const [week, swaps, advances, medical, plan, holiday] = await Promise.all([
    api.myWeek().catch(() => null),
    api.swaps().catch(() => null),
    api.myAdvances().catch(() => null),
    api.myMedical().catch(() => null),
    api.myLeavePlan().catch(() => null),
    api.myHoliday().catch(() => null),
  ]);

  const cash = (n, cur) => money(n, cur);
  const asks = [
    week && { name: 'leave', label: 'Time off', tone: 'good', run: () => askForLeave(week, reload) },
    week && { name: 'block', label: 'I can’t work a day', tone: '', run: () => editMyAvailability(week, reload) },
    swaps?.on && { name: 'swap', label: 'Swap a shift', tone: 'info', run: () => navigate('swaps') },
    advances?.linked && !advances.advances?.some((a) => a.status === 'requested') && {
      name: 'cash', label: 'Salary advance', tone: 'money',
      run: () => askForAdvance(advances, reload, (n) => cash(n, advances.currency)),
    },
    medical?.linked && medical.standing && {
      name: 'plus', label: 'Medical claim', tone: 'bad',
      run: () => makeClaim(medical, reload, (n) => cash(n, medical.currency)),
    },
    { name: 'food', label: 'Change my lunch', tone: 'warn', run: () => navigate('att-my-lunch') },
  ].filter(Boolean);

  // What they have asked, newest first, whatever kind it was.
  const items = [];
  for (const row of week?.leave ?? []) items.push({ at: row.from, el: leaveRow(row, reload) });
  for (const s of swaps?.mine ?? []) {
    items.push({
      at: s.day,
      el: line(`Swap, ${fmtDayShort(s.day)}${s.shift?.name ? ` ${s.shift.name}` : ''}`,
        s.status === 'claimed' ? 'Somebody took it, waiting for a manager' : 'Waiting for somebody to take it',
        s.status === 'claimed' ? ['warn', 'With a manager'] : ['', 'Waiting']),
    });
  }
  for (const a of advances?.advances ?? []) {
    const state = {
      requested: ['warn', 'Waiting'], approved: ['good', 'Approved'], settled: ['', 'Paid back'],
      declined: ['bad', 'Declined'], withdrawn: ['', 'Taken back'],
    }[a.status] ?? ['', a.status];
    items.push({
      at: String(a.askedAt || '').slice(0, 10),
      el: line(`${a.purpose === 'till' ? 'Till shortage' : 'Advance'}, ${cash(a.amount, advances.currency)}`,
        a.months ? `${a.months} month${a.months === 1 ? '' : 's'} to pay back` : '', state),
    });
  }
  for (const c of medical?.claims ?? []) {
    const state = c.status === 'approved'
      ? (c.paidAt ? ['good', 'Paid'] : ['warn', 'To be paid in cash'])
      : { requested: ['warn', 'Waiting'], declined: ['bad', 'Declined'], withdrawn: ['', 'Taken back'] }[c.status] ?? ['', c.status];
    items.push({
      at: String(c.askedAt || '').slice(0, 10),
      el: line(`Medical claim, ${cash(c.approved ?? c.amount, medical.currency)}`,
        c.what || '', state),
    });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return [
    h('div.page-head', h('div', h('h1', 'Requests'))),
    h('section', { 'aria-labelledby': 'ask-for' },
      h('h2.requests-h', { id: 'ask-for' }, 'Ask for'),
      h('div.ask-grid', asks.map((a) => h('button.ask-tile', { type: 'button', onclick: a.run },
        h(`span.ask-icon${a.tone ? `.is-${a.tone}` : ''}`, icon(a.name)),
        h('span', a.label))))),
    holidayCard(holiday),
    planCard(plan),
    h('section.card', { 'aria-labelledby': 'asked' },
      h('div.card-head', h('h2', { id: 'asked' }, 'What I’ve asked')),
      items.length
        ? h('div.me-list', items.slice(0, 30).map((i) => i.el))
        : h('p.muted', 'Nothing asked yet. Anything you ask for shows here with its answer.')),
  ];
}

/**
 * The year's leave plan, while there is one to send. A card here rather than a
 * tab of its own: most of the year there is nothing to plan.
 */
function planCard(data) {
  if (!data?.round || !data.eligible) return null;
  const status = data.plan?.status;
  const said = status === 'reviewed' ? ['good', 'Approved']
    : status === 'sent' ? ['warn', 'With your manager']
      : ['', 'Not sent yet'];
  return h('section.card',
    h('div.card-head', h('h2', `Your ${data.round.year} leave plan`), h(`span.pill${said[0] ? `.${said[0]}` : ''}`, said[1])),
    h('p.muted', data.round.dueOn ? `Plans are due by ${fmtDayShort(data.round.dueOn)}.` : 'Choose the weeks you want off next year.'),
    h('button.btn.btn-primary', { type: 'button', onclick: () => navigate('my-leave-plan') },
      status === 'sent' || status === 'reviewed' ? 'Open my plan' : 'Plan my leave'));
}

function line(title, sub, [tone, label]) {
  return h('div.me-day',
    h('div.me-what', h('strong', title), sub ? h('small.muted', sub) : null),
    h('div.me-was', h(`span.pill${tone ? `.${tone}` : ''}`, label)));
}
