import { api } from '../api.js';
import { can, state } from '../app.js';
import { fmtDayShort, h, mount } from '../util.js';
import { emptyState } from './components.js';
import { shiftHours } from './att-shared.js';
import { countdownCard, onShiftCard } from './att-me.js';
import { icon } from '../icons.js';
import { mySickCards } from './absence.js';
import { shrink } from './att-my-medical.js';

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

  const [week, till, issues, handbook, sick, leavePlan] = await Promise.all([
    api.myWeek().catch((err) => ({ error: err.message })),
    can('till') ? api.myTill().catch(() => null) : Promise.resolve(null),
    can('till') ? api.tillIssues().catch(() => null) : Promise.resolve(null),
    api.handbook().catch(() => null),
    api.mySick().catch(() => null),
    api.myLeavePlan().catch(() => null),
  ]);
  const reload = async () => mount(host, ...(await renderMyDay()).childNodes);

  const first = String(state.name || '').split(/\s+/)[0];
  const head = h('div.page-head',
    h('div',
      h('div.sub', new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })),
      h('h1', first ? `Hi ${first}` : 'Hello')));

  if (week.error) {
    mount(host, head, emptyState('Nothing to show yet', week.error));
    return host;
  }

  // Off sick today: no countdown to a shift they are not coming in for.
  const off = sick?.sick;
  const offToday = Boolean(off && off.status === 'approved' && off.from <= week.today && off.to >= week.today);

  const todo = [];

  if (state.startingOut) {
    todo.push(task('flag', 'Your first week', 'A short list to get you started', '#/onboarding', 'info'));
  }

  // The till, while they are on a shift or have just clocked out of one, and
  // it is not closed yet. Counting up usually happens after clocking out, so
  // the to-do stays for some hours after the shift ends. The till screen
  // itself offers the shift that has just finished as well as the current one.
  const open = (till?.choices ?? []).slice(0, 2).some((c) => !c.done);
  const owed = till?.owed ?? [];
  if (owed.length) {
    // Owed from a shift already over, whatever the time now: it comes first,
    // and nothing later can be closed until it is in.
    const [oldest] = owed;
    const when = new Date(`${oldest.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const slot = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' }[oldest.slot] ?? '';
    todo.push(task('cash', owed.length > 1 ? `${owed.length} closing reports still not in` : 'Closing report still not in',
      `${slot} shift · ${when}${owed.length > 1 ? ' first' : ''}`, '#/att-my-till', 'bad'));
  } else if (till && open && (week.onShift || week.justFinished)) {
    const ends = week.onShift?.shift?.ends_at;
    const finished = week.justFinished?.shift?.name;
    todo.push(task('cash', 'Close your till',
      ends ? `Before ${ends} · 5 short steps`
        : finished ? `Your ${finished} · 5 short steps` : '5 short steps',
      '#/att-my-till', 'warn'));
  }
  // Only what has been checked: a shift not checked yet may still change.
  const toSort = (issues?.issues ?? []).filter((i) => i.checked !== false).length;
  if (toSort) {
    todo.push(task('cash', 'Your till: to sort out',
      `${toSort} ${toSort === 1 ? 'thing' : 'things'} to answer`, '#/att-my-till-issues', 'bad'));
  }

  // The year's leave plan, while it is not sent, or has dates to move.
  if (leavePlan?.eligible) {
    const moving = (leavePlan.blocks ?? []).some((b) => b.status === 'move');
    if (leavePlan.plan?.status === 'draft') {
      const due = new Date(`${leavePlan.round.dueOn}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      todo.push(task('calendar', `Send your ${leavePlan.round.year} leave plan`, `By ${due} · ${Math.max(0, leavePlan.left)} days to plan`, '#/my-leave-plan', 'warn'));
    } else if (moving) {
      todo.push(task('calendar', 'Your leave plan: dates to move', 'Your manager suggested other dates', '#/my-leave-plan', 'warn'));
    }
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
    week.onShift ? onShiftCard(week) : offToday && week.next?.day === week.today ? null : countdownCard(week),
    mySickCards(sick, { reload, shrink }),

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
