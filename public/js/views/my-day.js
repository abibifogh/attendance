import { api } from '../api.js';
import { can, state } from '../app.js';
import { fmtDayShort, h, mount } from '../util.js';
import { emptyState } from './components.js';
import { shiftHours } from './att-shared.js';
import { countdownCard, onShiftCard } from './att-me.js';
import { icon } from '../icons.js';

/**
 * Home, for somebody's own day.
 *
 * Their shift first, because it is the reason they opened the app. Then the
 * few things they have to do today, each one tap away: closing the till at the
 * end of a front-desk shift, the handbook they have been asked to sign, their
 * first week. Then the next few days. Everything else is in the tabs.
 */
export async function renderMyDay() {
  const host = h('div.my-day');

  const [week, till, issues, handbook] = await Promise.all([
    api.myWeek().catch((err) => ({ error: err.message })),
    can('till') ? api.myTill().catch(() => null) : Promise.resolve(null),
    can('till') ? api.tillIssues().catch(() => null) : Promise.resolve(null),
    api.handbook().catch(() => null),
  ]);

  const first = String(state.name || '').split(/\s+/)[0];
  const head = h('div.page-head',
    h('div',
      h('div.sub', new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })),
      h('h1', first ? `Hi ${first}` : 'Hello')));

  if (week.error) {
    mount(host, head, emptyState('Nothing to show yet', week.error));
    return host;
  }

  const todo = [];

  if (state.startingOut) {
    todo.push(task('flag', 'Your first week', 'A short list to get you started', '#/onboarding', 'info'));
  }

  // The till, while they are on a shift or have just clocked out of one, and
  // it is not closed yet. Counting up usually happens after clocking out, so
  // the to-do stays for some hours after the shift ends. The till screen
  // itself offers the shift that has just finished as well as the current one.
  const open = (till?.choices ?? []).slice(0, 2).some((c) => !c.done);
  if (till && open && (week.onShift || week.justFinished)) {
    const ends = week.onShift?.shift?.ends_at;
    const finished = week.justFinished?.shift?.name;
    todo.push(task('cash', 'Close your till',
      ends ? `Before ${ends} · 5 short steps`
        : finished ? `Your ${finished} · 5 short steps` : '5 short steps',
      '#/att-my-till', 'warn'));
  }
  const toSort = (issues?.issues ?? []).length;
  if (toSort) {
    todo.push(task('cash', 'Your till: to sort out',
      `${toSort} ${toSort === 1 ? 'thing' : 'things'} to answer`, '#/att-my-till-issues', 'bad'));
  }

  const toRead = (handbook?.chapters ?? []).filter((c) => c.needs && !c.done);
  if (toRead.length) {
    todo.push(task('doc', 'Read the handbook',
      toRead.length === 1 ? toRead[0].title || '1 section to read' : `${toRead.length} sections to read`,
      '#/handbook', 'info'));
  }

  const coming = (week.days ?? []).filter((d) => d.day > week.today).slice(0, 5);

  mount(host,
    head,
    week.onShift ? onShiftCard(week) : countdownCard(week),

    todo.length
      ? h('section.my-todo', { 'aria-labelledby': 'my-todo' },
        h('h2', { id: 'my-todo' }, 'To do today'),
        todo)
      : null,

    coming.length
      ? h('section.card', { 'aria-labelledby': 'my-next' },
        h('div.card-head',
          h('h2', { id: 'my-next' }, 'Next few days'),
          h('a', { href: '#/att-me' }, 'Full rota')),
        h('div.my-days', coming.map((d) => h('div.my-days-row',
          h('span.my-days-when',
            h('strong', new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })),
            h('small.muted', fmtDayShort(d.day))),
          h('span.my-days-what', d.leave
            ? h('span.pill.good', d.leave)
            : d.shift
              ? h('span', h('strong', d.shift.name), ` ${shiftHours(d.shift)}`)
              : d.restDay ? h('span.muted', 'Rest day') : h('span.muted', 'Not out yet'))))))
      : null,

    week.showBalance && week.balance
      ? h('p.muted.my-left', `${Math.round((week.balance.remaining ?? 0) * 10) / 10} days of leave left this year`)
      : null,
  );

  return host;
}

function task(name, title, sub, href, tone) {
  return h('a.my-task', { href },
    h(`span.my-task-icon.is-${tone}`, icon(name)),
    h('span.my-task-text', h('strong', title), h('small', sub)),
    icon('chevron', 18));
}
