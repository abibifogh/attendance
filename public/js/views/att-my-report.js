import { api } from '../api.js';
import { fmtDayShort, fmtNum, h, monthOf, mount, shiftMonth, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { asHours, monthLabel, showSheet } from './att-shared.js';

/**
 * My month.
 *
 * The figures somebody asks about at the end of a month, answered before they
 * have to ask: how many days they worked, what that came to in hours, how
 * often they were late and by how long, and what leave it cost them.
 *
 * A summary first and the days underneath, because the summary is what
 * somebody came for and the days are what they turn to when one of the numbers
 * surprises them. Both of their own month and nobody else's.
 *
 * There is no overtime figure, here as everywhere else on this side of the
 * app. What somebody is owed is settled when a person signs the month off
 * having looked at all of it, and a number here that turned out to differ from
 * the one on a payslip would be worse than no number at all. The screen says
 * whether the month has been signed off, which is the difference between "this
 * is what happened" and "this is what happened so far".
 */
export async function renderAttMyReport(params = {}) {
  const host = h('div');
  const month = params.month || monthOf(todayISO());
  const data = await api.myReport(month).catch((err) => ({ error: err.message }));

  const reload = async (next = {}) => mount(host, await renderAttMyReport({ ...params, ...next }));

  if (data.error) {
    mount(host,
      h('div.page-head', h('h1', 'My report')),
      emptyState('Nothing to show yet', data.error));
    return host;
  }

  const head = h('div.page-head',
    h('div',
      h('h1', 'My report'),
      h('div.sub', `${monthLabel(month)} — your own figures`),
    ),
  );

  const picker = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload({ month: shiftMonth(month, -1) }) }, '‹'),
    h('strong', monthLabel(month)),
    h('button.btn-sm', {
      onclick: () => reload({ month: shiftMonth(month, 1) }),
      disabled: month >= monthOf(todayISO()),
    }, '›'),
    h('button.btn-sm', { onclick: () => reload({ month: monthOf(todayISO()) }) }, 'This month'),
  );

  if (data.future || !data.totals) {
    mount(host, head, picker,
      emptyState('Not yet', 'That month has not started.'));
    return host;
  }

  const t = data.totals;
  const shown = data.days.slice(0, 10);
  const rest = data.days.slice(10);

  mount(host, head, picker,

    // The four numbers somebody came for, before anything they have to read.
    h('div.grid.grid-4',
      figure('Days worked', fmtNum(t.daysWorked, t.daysWorked % 1 ? 1 : 0),
        `of ${fmtNum(t.scheduled, 0)} rostered`),
      figure('Hours', asHours(t.workedMinutes), 'on the clock'),
      figure('Late', String(t.lateCount),
        t.lateMinutes ? `${fmtNum(t.lateMinutes, 0)} minutes in all` : 'never',
        t.lateCount ? 'warn' : 'good'),
      figure('Absent', fmtNum(t.daysAbsent, t.daysAbsent % 1 ? 1 : 0),
        t.daysAbsent ? 'days unaccounted for' : 'nothing unaccounted for',
        t.daysAbsent ? 'bad' : 'good'),
    ),

    signedLine(data),

    // The rest of the month, in one line each rather than four more tiles.
    card('The month in words', { wide: true },
      h('ul.report-lines',
        line('Rest days', fmtNum(t.daysRest, 0)),
        t.daysHoliday ? line('Public holidays', fmtNum(t.daysHoliday, 0)) : null,
        t.daysLeave ? line('Days on leave', fmtNum(t.daysLeave, t.daysLeave % 1 ? 1 : 0)) : null,
        t.leaveDeducted
          ? line('Charged against your leave',
            fmtNum(t.leaveDeducted, t.leaveDeducted % 1 ? 1 : 0))
          : null,
        t.earlyCount
          ? line('Left early', `${t.earlyCount} time${t.earlyCount === 1 ? '' : 's'}`
            + `, ${fmtNum(t.earlyMinutes, 0)} minutes in all`)
          : null,
      ),
      t.byReason.length
        ? h('div.chip-row', { style: { marginTop: '.7rem' } },
          t.byReason.map((r) => h('span.pill', `${r.label}: ${fmtNum(r.days, r.days % 1 ? 1 : 0)}`)))
        : null),

    card('Day by day', {
      note: `${data.days.length} day${data.days.length === 1 ? '' : 's'} with something on them`,
      wide: true,
    },
    data.days.length
      ? h('div',
        dayTable(shown),
        rest.length
          ? h('button.btn-sm.me-more', {
            style: { marginTop: '.6rem' },
            onclick: () => showSheet({
              title: `Every day in ${monthLabel(month)}`,
              body: dayTable(data.days),
            }),
          }, `See all ${data.days.length} days`)
          : null)
      : h('p.muted', 'Nothing on the rota and nothing recorded.')),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'These are the figures as they stand. A month nobody has signed off can still change '
      + 'if a clock time is corrected. What you are paid is settled separately.'),
  );

  return host;
}

/** One of the four figures at the top. */
function figure(label, value, sub, tone = '') {
  return h(`div.stat${tone ? `.stat-${tone}` : ''}`,
    h('div.stat-label', label),
    h('div.stat-value', value),
    h('div.stat-sub', sub));
}

/** One line of the month in words. */
function line(label, value) {
  return h('li', h('span', label), h('strong', String(value)));
}

/** Whether anybody has closed this month off, and what it moved. */
function signedLine(data) {
  if (!data.signed.length) {
    return h('p.signoff-counts',
      h('span.pill.warn', 'Not signed off yet'),
      h('span.muted', ' — these figures can still change'));
  }

  const moved = data.signed.reduce((n, s) => n + (Number(s.daysApplied) || 0), 0);
  const by = [...new Set(data.signed.map((s) => s.by).filter(Boolean))];

  return h('p.signoff-counts',
    h('span.pill.good', 'Signed off'),
    h('span.muted', ` by ${by.join(', ') || 'somebody'}`),
    moved
      ? h('span.pill', { style: { marginLeft: '.4rem' } },
        `${moved > 0 ? '+' : ''}${moved} against your leave`)
      : null);
}

/**
 * The days, as a table somebody can read down.
 *
 * On a phone the middle four columns fold into the first one rather than
 * scrolling off the right. A member of staff reading their own month on a
 * handset should not have to swipe a table sideways to find out what time
 * they clocked in.
 */
function dayTable(rows) {
  return table([
    {
      key: 'day',
      label: 'Day',
      format: (v, r) => h('div',
        h('div', fmtDayShort(v), ' ',
          h('small.muted', new Date(`${v}T12:00:00Z`)
            .toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }))),
        h('small.muted.on-phone',
          [r.shift, `${r.in || '—'} → ${r.out || '—'}`, r.minutes ? asHours(r.minutes) : null]
            .filter(Boolean).join(' · '))),
    },
    { key: 'shift', label: 'Shift', cls: 'off-phone', format: (v) => v || h('span.muted', '—') },
    {
      key: 'in', label: 'In', align: 'right', cls: 'off-phone',
      format: (v) => v || h('span.muted', '—'),
    },
    {
      key: 'out', label: 'Out', align: 'right', cls: 'off-phone',
      format: (v) => v || h('span.muted', '—'),
    },
    {
      key: 'minutes', label: 'Worked', align: 'right', cls: 'off-phone',
      format: (v) => (v ? asHours(v) : h('span.muted', '—')),
    },
    {
      key: 'label',
      label: 'What happened',
      format: (v, r) => h('div',
        h(`span.pill${r.colour === 'green' ? '.good' : r.colour === 'red' ? '.bad' : r.colour === 'amber' ? '.warn' : ''}`, v),
        r.lateMinutes ? h('small.muted', ` ${r.lateMinutes} min late`) : null),
    },
  ], rows, { empty: 'Nothing recorded.', rowClass: (r) => `row-att-${r.colour}` });
}
