import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import {
  fmtDay, fmtDayShort, fmtNum, h, mount, shiftDay, todayISO,
} from '../util.js';
import { card, emptyState, exportButton, table } from './components.js';
import { printButton } from '../print.js';
import {
  clockCell, hoursCell, minutesCell, statusPill, totalsLine,
} from './att-shared.js';

/**
 * One person's attendance — the report that gets handed to them.
 *
 * The screen the property already produces by hand every morning, and the
 * reason most of the rest of this exists. It has to survive being printed and
 * read by somebody who was not in the room: the times, what was made of them,
 * and a line of plain English saying why and what to do differently.
 */
export async function renderAttStaff(params) {
  const host = h('div');
  const id = Number(params.id);
  if (!id) return emptyState('No one chosen', 'Open a person from the attendance list.');

  const period = params.period || (params.from ? 'custom' : 'day');
  const anchor = params.day || params.to || todayISO();
  const { from, to } = boundsFor(period, anchor, params);

  const data = await api.attStaffReport(id, from, to);
  const single = from === to;

  const reload = async (next) => {
    const merged = { id, period, day: anchor, ...next };
    replaceParams('att-staff', merged);
    mount(host, await renderAttStaff(merged));
  };

  const periods = h('div.seg',
    ...[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([key, label]) =>
      h('button', {
        class: period === key ? 'active' : '',
        onclick: () => reload({ period: key }),
      }, label)),
  );

  const step = (direction) => {
    if (period === 'month') {
      const d = new Date(`${anchor}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + direction);
      return d.toISOString().slice(0, 10);
    }
    return shiftDay(anchor, direction * (period === 'week' ? 7 : 1));
  };

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload({ day: step(-1) }) }, '‹'),
    periods,
    h('button.btn-sm', { onclick: () => reload({ day: step(1) }) }, '›'),
    h('button.btn-sm', { onclick: () => reload({ day: todayISO() }) }, 'Today'),
    h('div', { style: { flex: 1 } }),
    printButton({
      title: `${data.staff.name} — attendance`,
      subtitle: single
        ? fmtDay(from, { withYear: true })
        : `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })}`,
      note: data.staff.department ? `${data.staff.department}${data.staff.job_title ? ` · ${data.staff.job_title}` : ''}` : null,
      footer: PRINT_FOOTER,
      label: '📄 Save as PDF',
    }),
    can('att_reports') ? exportButton(api.attExportUrl(from, to), 'Export') : null,
  );

  const t = data.totals;
  const leave = data.leave;

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    tile('Days worked', fmtNum(t.daysWorked, t.daysWorked % 1 ? 1 : 0), `of ${fmtNum(t.scheduled, 0)} rostered`),
    tile('Hours', fmtNum(t.workedMinutes / 60, 1), t.overtimeMinutes ? `${fmtNum(t.overtimeMinutes / 60, 1)} over` : 'on the clock', 'var(--c3)'),
    tile('Absences', fmtNum(t.daysAbsent, 0), t.openCount ? `${t.openCount} still to confirm` : 'unexcused', t.daysAbsent ? 'var(--bad)' : null),
    tile('Leave left', fmtNum(leave.remaining, 1), `of ${fmtNum(leave.available, 1)} days this year`),
  );

  // A single day gets the treatment the printed slip needs: the note first,
  // large, because it is the only part most people read.
  const dayCard = single && data.days.length
    ? singleDayCard(data.days[0], data.staff)
    : null;

  const daysTable = card(single ? 'The day' : 'Day by day', {
    note: totalsLine(t),
    wide: true,
  }, table([
    {
      key: 'day',
      label: 'Date',
      format: (v) => h('div', h('div', fmtDayShort(v)), h('small.muted', new Date(`${v}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }))),
    },
    { key: 'shift', label: 'Shift', format: (v) => (v ? h('div', h('div', v.name), h('small.muted', `${v.starts_at}–${v.ends_at}`)) : h('span.muted', '—')) },
    { key: 'first_in', label: 'In', align: 'right', format: (v, r) => clockCell(v, { missing: r.scheduled }) },
    { key: 'last_out', label: 'Out', align: 'right', format: (v, r) => clockCell(v, { missing: r.scheduled }) },
    { key: 'hours', label: 'Hours', align: 'right', format: hoursCell },
    { key: 'late_minutes', label: 'Late', align: 'right', format: minutesCell },
    { key: 'early_minutes', label: 'Early', align: 'right', format: minutesCell },
    { key: 'overtime_minutes', label: 'Over', align: 'right', format: minutesCell },
    { key: 'label', label: 'Status', format: (v, r) => statusPill(r) },
  ], data.days, {
    rowClass: (r) => `row-att-${r.colour}`,
    empty: 'Nothing recorded for this period.',
  }),
  data.days.some((d) => d.resolved_by)
    ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Times in rows marked as confirmed were supplied by a supervisor where the terminal had no record.')
    : null);

  const notesCard = !single && data.days.some((d) => d.colour !== 'green' && d.colour !== 'grey')
    ? card('What this means', { wide: true },
      h('div', data.days
        .filter((d) => d.colour === 'amber' || d.colour === 'red')
        .map((d) => h('div.alert', { class: d.colour === 'red' ? 'high' : 'warn' },
          h('span.alert-icon', d.colour === 'red' ? '⛔' : '⚠️'),
          h('div',
            h('div.alert-title', `${fmtDay(d.day)} — ${d.label}`),
            h('div.alert-detail', d.note),
          )))))
    : null;

  const leaveCard = card('Leave', { note: `${leave.year} leave year — ${fmtDay(leave.from)} to ${fmtDay(leave.to)}` },
    h('div.grid.grid-3',
      tile('Entitlement', fmtNum(leave.entitlement, 1), leave.proRated ? 'pro-rata from start date' : 'days a year'),
      tile('Taken', fmtNum(leave.taken, 1), leave.booked ? `${fmtNum(leave.booked, 1)} more booked` : 'days so far'),
      tile('Remaining', fmtNum(leave.remaining, 1), leave.pending ? `${fmtNum(leave.pending, 1)} awaiting a decision` : 'days', 'var(--good)'),
    ),
    !leave.qualified
      ? h('p.muted', { style: { fontSize: '.85rem', marginTop: '.6rem', marginBottom: 0 } },
        `${data.staff.name.split(' ')[0]} has ${leave.serviceMonths} months' service. Paid annual leave is `
        + 'earned after a full year, so the figure above is what they are on course for rather than what '
        + 'they can take today.')
      : null,
    leave.carryOver
      ? h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
        `Includes ${fmtNum(leave.carryOver, 1)} days carried over.`)
      : null,
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', data.staff.name),
        h('div.sub',
          [data.staff.job_title, data.staff.department, `No. ${data.staff.employee_no}`]
            .filter(Boolean).join(' · '),
        ),
      ),
      h('button.btn-sm', {
        onclick: () => navigate('att-today', { day: single ? from : undefined }),
      }, '← Everybody'),
    ),
    nav,
    tiles,
    dayCard,
    daysTable,
    notesCard,
    leaveCard,
  );

  return host;
}

/**
 * The single-day slip.
 *
 * Deliberately not a table. This is the thing that gets printed and handed over,
 * and the plain-language note is the part that changes behaviour — so it gets
 * the space, and the four numbers sit under it as evidence.
 */
function singleDayCard(record, staff) {
  const box = (label, value) => h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: { fontSize: '1.3rem' } }, value),
  );

  return card(fmtDay(record.day, { withYear: true }), {
    note: record.shift ? `${record.shift.name} · ${record.shift.starts_at}–${record.shift.ends_at}` : 'Not rostered',
    actions: statusPill(record),
    wide: true,
  },
    h('p', { style: { fontSize: '1.02rem', lineHeight: 1.6, margin: '0 0 1rem' } }, record.note),
    h('div.grid.grid-4',
      box('Clocked in', clockCell(record.first_in, { missing: record.scheduled })),
      box('Clocked out', clockCell(record.last_out, { missing: record.scheduled })),
      box('Hours worked', hoursCell(record.hours)),
      box(record.late_minutes ? 'Late by' : 'Overtime', minutesCell(record.late_minutes || record.overtime_minutes)),
    ),
    record.resolved_by
      ? h('p.muted', { style: { fontSize: '.85rem', marginTop: '.8rem', marginBottom: 0 } },
        `Confirmed by ${record.resolved_by}${record.resolved_note ? ` — ${record.resolved_note}` : ''}.`)
      : null,
  );
}

function tile(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, value),
    sub ? h('div.stat-sub', h('span', sub)) : null,
  );
}

/** The dates a period selection means. */
function boundsFor(period, anchor, params = {}) {
  if (period === 'custom' && params.from) {
    return { from: params.from, to: params.to || params.from };
  }
  if (period === 'week') {
    const d = new Date(`${anchor}T12:00:00Z`);
    const monday = shiftDay(anchor, -((d.getUTCDay() + 6) % 7));
    return { from: monday, to: shiftDay(monday, 6) };
  }
  if (period === 'month') {
    const month = anchor.slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
  }
  return { from: anchor, to: anchor };
}

const PRINT_FOOTER = 'Clock times come from the attendance terminal. Where a punch was missing, '
  + 'the time shown was supplied by a supervisor and is noted as such. Days worked count a full day '
  + 'at or above the shift\'s full-day threshold and a half day above the half-day threshold.';
