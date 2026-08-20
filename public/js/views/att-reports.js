import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import {
  fmtDay, fmtDayShort, fmtNum, h, monthOf, mount, shiftDay, shiftMonth, todayISO,
} from '../util.js';
import { card, emptyState, exportButton, table } from './components.js';
import { printButton } from '../print.js';
import { daysCell, totalsLine } from './att-shared.js';

/**
 * The week grid.
 *
 * Names down the side, Monday to Sunday across, one cell per day. A manager
 * reads this to find the pattern a daily list hides — the person late three
 * Mondays running, the section that is short every weekend.
 */
export async function renderAttWeek(params) {
  const host = h('div');
  const from = params.from || mondayOf(todayISO());
  const data = await api.attWeek(from);

  const reload = async (nextFrom) => {
    replaceParams('att-week', { from: nextFrom });
    mount(host, await renderAttWeek({ from: nextFrom }));
  };

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload(shiftDay(data.from, -7)) }, '‹ Previous week'),
    h('input', {
      type: 'date', value: data.from,
      onchange: (e) => e.target.value && reload(mondayOf(e.target.value)),
    }),
    h('button.btn-sm', { onclick: () => reload(shiftDay(data.from, 7)) }, 'Next week ›'),
    h('button.btn-sm', { onclick: () => reload(mondayOf(todayISO())) }, 'This week'),
    h('div', { style: { flex: 1 } }),
    printButton({
      title: 'Attendance — week',
      subtitle: `${fmtDay(data.from, { withYear: true })} to ${fmtDay(data.to, { withYear: true })}`,
      footer: PRINT_FOOTER,
    }),
    exportButton(api.attExportUrl(data.from, data.to), 'Export week'),
  );

  if (!data.rows.length) {
    mount(host, head('Week', data), nav, emptyState('Nobody on the rota this week', 'Set the rota to see this filled in.'));
    return host;
  }

  // One column per day, plus the name and the row totals. The cell is a link
  // through to the person's own report for that day, because the next question
  // after "why is that red" is always "show me".
  const columns = [
    {
      key: 'staff',
      label: 'Name',
      format: (v) => h('div',
        h('div', h('a', {
          href: `#/att-staff?id=${v.id}`,
          onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: v.id, period: 'week', day: data.from }); },
        }, v.name)),
        h('small.muted', v.department || `No. ${v.employee_no}`),
      ),
    },
    ...data.days.map((day, index) => ({
      key: `d${index}`,
      label: h('div', h('div', new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })), h('small.muted', fmtDayShort(day))),
      format: (v, row) => dayCell(row.days[index], row.staff.id),
    })),
    {
      key: 'totals',
      label: 'Days',
      align: 'right',
      format: (v) => daysCell(v.daysWorked),
    },
    {
      key: 'hours',
      label: 'Hours',
      align: 'right',
      format: (v, row) => fmtNum(row.totals.workedMinutes / 60, 1),
    },
  ];

  mount(host,
    head('Week', data),
    nav,
    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      tile('Days worked', fmtNum(data.totals.daysWorked, 1), `across ${data.rows.length} people`),
      tile('Hours', fmtNum(data.totals.workedMinutes / 60, 1), data.totals.overtimeMinutes ? `${fmtNum(data.totals.overtimeMinutes / 60, 1)} overtime` : 'total'),
      tile('Absences', fmtNum(data.totals.daysAbsent, 0), 'unexcused', data.totals.daysAbsent ? 'var(--bad)' : null),
      tile('Late arrivals', fmtNum(data.totals.lateCount, 0), data.totals.lateMinutes ? `${fmtNum(data.totals.lateMinutes, 0)} min in total` : 'none', data.totals.lateCount ? 'var(--warn)' : null),
    ),
    card('The week', { note: totalsLine(data.totals), wide: true },
      table(columns, data.rows, { empty: 'Nothing recorded.' })),
    legend(),
  );

  return host;
}

/**
 * One cell of the week grid.
 *
 * Small enough to fit seven across on a laptop, and still carrying the two
 * things worth knowing at a glance: the colour, and the hours.
 */
function dayCell(record, staffId) {
  if (!record) return h('span.muted', '—');

  const glyph = {
    present: '●', late: 'L', early_leave: 'E', late_early: 'LE',
    missing_out: '?', missing_in: '?', absent: '✕',
    leave: 'A', holiday: 'H', rest: '·', unscheduled: '+',
  }[record.status] ?? '·';

  return h('a.att-cell', {
    class: `att-${record.colour}`,
    href: `#/att-staff?id=${staffId}&day=${record.day}`,
    title: `${record.label}${record.first_in ? ` — ${record.first_in} to ${record.last_out || '?'}` : ''}`,
    onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: staffId, period: 'day', day: record.day }); },
  },
    h('span.att-cell-mark', glyph),
    record.hours ? h('span.att-cell-hours', fmtNum(record.hours, 1)) : null,
  );
}

function legend() {
  const item = (mark, colour, label) => h('span.att-legend-item',
    h('span.att-cell', { class: `att-${colour}` }, h('span.att-cell-mark', mark)),
    h('span', label),
  );
  return h('div.att-legend',
    item('●', 'green', 'Present'),
    item('L', 'amber', 'Late'),
    item('E', 'amber', 'Left early'),
    item('?', 'red', 'Punch missing'),
    item('✕', 'red', 'Absent'),
    item('A', 'grey', 'Leave'),
    item('H', 'grey', 'Holiday'),
    item('·', 'grey', 'Rest day'),
    item('+', 'green', 'Worked unrostered'),
  );
}

// ---------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------

/**
 * Everybody, a month at a time — the sheet that goes to whoever does the wages.
 *
 * Days worked and hours on the left, because that is what gets paid; lateness
 * and absence in the middle, because that is what gets discussed; leave on the
 * right, because that is the question asked most often and answered worst.
 */
export async function renderAttOverview(params) {
  const host = h('div');
  const month = params.month || monthOf(todayISO());
  const data = await api.attOverview(month);

  const reload = async (nextMonth) => {
    replaceParams('att-overview', { month: nextMonth });
    mount(host, await renderAttOverview({ month: nextMonth }));
  };

  const label = new Date(`${data.month}-15T12:00:00Z`)
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload(shiftMonth(data.month, -1)) }, '‹'),
    h('input', {
      type: 'month', value: data.month,
      onchange: (e) => e.target.value && reload(e.target.value),
    }),
    h('button.btn-sm', {
      onclick: () => reload(shiftMonth(data.month, 1)),
      disabled: data.month >= monthOf(todayISO()),
    }, '›'),
    h('div', { style: { flex: 1 } }),
    printButton({
      title: `Attendance — ${label}`,
      subtitle: `${data.rows.length} people · ${fmtDay(data.from)} to ${fmtDay(data.to)}`,
      footer: PRINT_FOOTER,
    }),
    // The export carries the balances, so it stays behind the permission that
    // may see them rather than handing a planner a file with the column the
    // screen just took out.
    can('att_reports') ? exportButton(api.attExportUrl(data.from, data.to), 'Export month') : null,
  );

  if (!data.rows.length) {
    mount(host,
      h('div.page-head', h('h1', 'Attendance'), h('div.sub', label)),
      nav,
      emptyState('Nothing recorded this month', 'No punches have landed for anybody in this period.'),
    );
    return host;
  }

  const totals = data.rows.reduce((acc, row) => ({
    daysWorked: acc.daysWorked + row.totals.daysWorked,
    workedMinutes: acc.workedMinutes + row.totals.workedMinutes,
    daysAbsent: acc.daysAbsent + row.totals.daysAbsent,
    lateCount: acc.lateCount + row.totals.lateCount,
    openCount: acc.openCount + row.totals.openCount,
  }), { daysWorked: 0, workedMinutes: 0, daysAbsent: 0, lateCount: 0, openCount: 0 });

  mount(host,
    h('div.page-head',
      h('div', h('h1', 'Attendance'), h('div.sub', label)),
      totals.openCount
        ? h('span.pill.warn', `${totals.openCount} day${totals.openCount === 1 ? '' : 's'} still unconfirmed`)
        : h('span.pill.good', 'Every day settled'),
    ),
    nav,
    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      tile('Days worked', fmtNum(totals.daysWorked, 1), `${data.rows.length} people`),
      tile('Hours', fmtNum(totals.workedMinutes / 60, 0), 'total for the month', 'var(--c3)'),
      tile('Absences', fmtNum(totals.daysAbsent, 0), 'unexcused', totals.daysAbsent ? 'var(--bad)' : null),
      tile('Late arrivals', fmtNum(totals.lateCount, 0), 'across the month', totals.lateCount ? 'var(--warn)' : null),
    ),
    card('Per person', { note: 'Click a name for the day-by-day report', wide: true },
      table([
        {
          key: 'staff',
          label: 'Name',
          format: (v) => h('div',
            h('div', h('a', {
              href: `#/att-staff?id=${v.id}`,
              onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: v.id, period: 'month', day: `${data.month}-15` }); },
            }, v.name)),
            h('small.muted', v.department || `No. ${v.employee_no}`),
          ),
        },
        { key: 'totals', label: 'Rostered', align: 'right', format: (v) => fmtNum(v.scheduled, 0) },
        { key: 'worked', label: 'Worked', align: 'right', format: (v, r) => daysCell(r.totals.daysWorked) },
        { key: 'hours', label: 'Hours', align: 'right', format: (v, r) => fmtNum(r.totals.workedMinutes / 60, 1) },
        { key: 'overtime', label: 'Overtime', align: 'right', format: (v, r) => (r.totals.overtimeMinutes ? `${fmtNum(r.totals.overtimeMinutes / 60, 1)} h` : h('span.muted', '—')) },
        { key: 'late', label: 'Late', align: 'right', format: (v, r) => (r.totals.lateCount ? h('span', { style: { color: 'var(--warn)' } }, fmtNum(r.totals.lateCount, 0)) : h('span.muted', '—')) },
        { key: 'absent', label: 'Absent', align: 'right', format: (v, r) => (r.totals.daysAbsent ? h('span', { style: { color: 'var(--bad)' } }, fmtNum(r.totals.daysAbsent, 0)) : h('span.muted', '—')) },
        { key: 'leaveTaken', label: 'Leave taken', align: 'right', format: (v, r) => daysCell(r.totals.daysLeave) },
        // Leave *taken* is what happened this month and belongs to the rota.
        // Leave *left* is a balance, and whoever builds the rota is
        // deliberately never shown it — the server does not send it to them,
        // so there is nothing here to draw.
        data.showsLeave
          ? { key: 'leaveLeft', label: 'Leave left', align: 'right', format: (v, r) => h('span', { style: { color: r.leave.remaining <= 0 ? 'var(--bad)' : 'var(--good)' } }, fmtNum(r.leave.remaining, 1)) }
          : null,
        { key: 'rate', label: 'Attendance', align: 'right', format: (v, r) => (r.totals.attendanceRate == null ? h('span.muted', '—') : `${fmtNum(r.totals.attendanceRate, 0)}%`) },
      ].filter(Boolean), data.rows, {
        groupBy: (r) => r.staff.department,
        empty: 'Nothing recorded.',
      })),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Days worked counts a full day at or above the shift\'s full-day threshold and a half day above the '
      + 'half-day threshold, both set per shift in Attendance setup.'
      + (data.showsLeave ? ' Leave left is against the current leave year.' : '')),
  );

  return host;
}

function head(title, data) {
  return h('div.page-head',
    h('div',
      h('h1', `Attendance — ${title.toLowerCase()}`),
      h('div.sub', `${fmtDay(data.from, { withYear: true })} to ${fmtDay(data.to, { withYear: true })}`),
    ),
  );
}

function tile(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, value),
    sub ? h('div.stat-sub', h('span', sub)) : null,
  );
}

function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return shiftDay(day, -((d.getUTCDay() + 6) % 7));
}

const PRINT_FOOTER = 'Clock times come from the attendance terminal. Where a punch was missing, '
  + 'the time shown was supplied by a supervisor and is noted as such.';
