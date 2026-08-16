import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import { fmtDay, fmtNum, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { card, emptyState, exportButton, table } from './components.js';
import { printButton } from '../print.js';
import {
  clockCell, field, formDialog, hoursCell, minutesCell, reasonSelect, statusPill, totalsLine,
} from './att-shared.js';

/**
 * The morning screen.
 *
 * One job: show a supervisor what needs dealing with before they get on with
 * their day, in the order they should deal with it. Days waiting on a decision
 * first, then absences, then lateness, then everybody who simply turned up.
 *
 * Everything else about attendance lives on other screens on purpose. Somebody
 * standing in a corridor with a phone wants a list and a couple of buttons, not
 * a dashboard.
 */
export async function renderAttToday(params) {
  const host = h('div');
  const day = params.day || todayISO();
  const data = await api.attDay(day);

  const reload = async (nextDay = day) => {
    replaceParams('att-today', { day: nextDay });
    mount(host, await renderAttToday({ day: nextDay }));
  };

  const manages = can('att_manage');
  const needing = data.rows.filter((r) => r.open);
  const absent = data.rows.filter((r) => !r.open && r.colour === 'red');
  const flagged = data.rows.filter((r) => !r.open && r.colour === 'amber');
  const fine = data.rows.filter((r) => !r.open && (r.colour === 'green' || r.colour === 'grey'));

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload(shiftDay(day, -1)) }, '‹ Previous day'),
    h('input', {
      type: 'date', value: day, max: data.today,
      onchange: (e) => e.target.value && reload(e.target.value),
    }),
    h('button.btn-sm', {
      onclick: () => reload(shiftDay(day, 1)),
      disabled: day >= data.today,
    }, 'Next day ›'),
    day !== data.today ? h('button.btn-sm', { onclick: () => reload(data.today) }, 'Today') : null,
    h('div', { style: { flex: 1 } }),
    printButton({
      title: `Attendance — ${fmtDay(day, { withYear: true })}`,
      subtitle: totalsLine(data.totals),
      footer: PRINT_FOOTER,
    }),
    can('att_reports') ? exportButton(api.attExportUrl(day, day), 'Export this day') : null,
  );

  if (!data.rows.length) {
    mount(host,
      h('div.page-head', h('h1', 'Attendance'), h('div.sub', fmtDay(day, { withYear: true }))),
      nav,
      emptyState(
        'Nobody on the rota for this day',
        can('att_setup')
          ? 'Add your staff and their shifts in Attendance setup, then the terminal\'s punches will start '
            + 'landing against them. Punches for people who are not set up yet are kept, not thrown away.'
          : 'Nobody has been set up for attendance yet. An administrator can do it in Attendance setup.',
      ),
    );
    return host;
  }

  /** Ask what happened, then record it against the day. */
  const resolve = async (row) => {
    const shiftHint = row.shift ? `${row.shift.name}, ${row.shift.starts_at}–${row.shift.ends_at}` : 'No shift rostered';
    const { reasons } = await api.attReasons();

    const done = await formDialog({
      title: `${row.staff.name} — ${fmtDay(day)}`,
      submitLabel: 'Record it',
      body: h('div',
        h('p.muted', shiftHint),
        h('p', row.note),
        h('div.grid.grid-2',
          field('Clocked in', h('input', {
            type: 'time', name: 'in', value: row.first_in || '',
          }), row.first_in ? 'What the terminal saw' : 'The terminal saw nothing'),
          field('Clocked out', h('input', {
            type: 'time', name: 'out', value: row.last_out || '',
          }), row.last_out ? 'What the terminal saw' : 'The terminal saw nothing'),
        ),
        field('Record this day as', reasonSelect(reasons, suggestedReason(row), { name: 'reason', required: true })),
        field('Note', h('input', {
          type: 'text', name: 'note', maxlength: 500,
          placeholder: 'What they told you, or who confirmed it',
        })),
      ),
      onSubmit: async (form) => api.attResolve(day, {
        staffId: row.staff.id,
        reason: form.get('reason'),
        in: form.get('in') || null,
        out: form.get('out') || null,
        note: form.get('note') || null,
      }),
    });

    if (done) {
      toast(`${row.staff.name}: recorded.`, 'good');
      await reload();
    }
  };

  const undo = async (row) => {
    await api.attUnresolve(day, { staffId: row.staff.id });
    toast('Put back to what the terminal recorded.');
    await reload();
  };

  const columns = [
    {
      key: 'staff',
      label: 'Name',
      format: (v, r) => h('div',
        h('a', {
          href: `#/att-staff?id=${v.id}&day=${day}`,
          onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: v.id, day }); },
        }, v.name),
        h('small.muted', v.department || `No. ${v.employee_no}`),
      ),
    },
    { key: 'shift', label: 'Shift', format: (v) => (v ? h('div', h('div', v.name), h('small.muted', `${v.starts_at}–${v.ends_at}`)) : h('span.muted', '—')) },
    { key: 'first_in', label: 'In', align: 'right', format: (v, r) => clockCell(v, { missing: r.scheduled }) },
    { key: 'last_out', label: 'Out', align: 'right', format: (v, r) => clockCell(v, { missing: r.scheduled }) },
    { key: 'hours', label: 'Hours', align: 'right', format: hoursCell },
    { key: 'late_minutes', label: 'Late', align: 'right', format: minutesCell },
    { key: 'early_minutes', label: 'Early', align: 'right', format: minutesCell },
    { key: 'label', label: 'Status', format: (v, r) => statusPill(r) },
  ];

  if (manages) {
    columns.push({
      key: 'resolution',
      label: '',
      format: (v, r) => (v === 'resolved'
        ? h('button.btn-sm', { onclick: () => undo(r) }, 'Undo')
        : h('button.btn-sm', {
          class: r.open ? 'btn-primary' : '',
          onclick: () => resolve(r),
        }, r.open ? 'Confirm' : 'Change')),
    });
  }

  const section = (title, rows, note, empty) => (rows.length
    ? card(title, { note: note ?? `${rows.length}`, wide: true },
      table(columns, rows, { rowClass: (r) => `row-att-${r.colour}` }))
    : (empty ? card(title, { wide: true }, h('div.empty', h('p', empty))) : null));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Attendance'),
        h('div.sub', fmtDay(day, { withYear: true })),
      ),
      h('span.pill', totalsLine(data.totals)),
    ),
    nav,

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      tile('On duty', `${fmtNum(data.totals.scheduled, 0)}`, 'rostered today'),
      tile('Worked', fmtNum(data.totals.daysWorked, 1), `${fmtNum(data.totals.workedMinutes / 60, 1)} hrs`),
      tile('Absent', fmtNum(data.totals.daysAbsent, 0), data.totals.daysAbsent ? 'need chasing' : 'nobody', data.totals.daysAbsent ? 'var(--bad)' : null),
      tile('To confirm', fmtNum(data.totals.openCount, 0), data.totals.openCount ? 'waiting on you' : 'all settled', data.totals.openCount ? 'var(--warn)' : null),
    ),

    section(
      'Waiting on a decision', needing,
      'A punch is missing, so the day is being held rather than counted as an absence',
      null,
    ),
    section('Absent', absent, null, null),
    section('Late or left early', flagged, null, null),
    section('Everybody else', fine, `${fine.length} — nothing to deal with`, 'Nobody yet.'),
  );

  return host;
}

function tile(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, value),
    sub ? h('div.stat-sub', h('span', sub)) : null,
  );
}

/**
 * What to pre-select in the dialog.
 *
 * A guess, and a conservative one: a day with an arrival and no departure is
 * almost always somebody who worked and forgot, so "present" is offered. A day
 * with nothing at all is offered nothing — that one needs a human to choose,
 * and pre-picking "absent" would turn the dialog into a rubber stamp.
 */
function suggestedReason(row) {
  if (row.status === 'missing_out' || row.status === 'missing_in') {
    return row.late_minutes > 5 ? 'late' : 'present';
  }
  return '';
}

const PRINT_FOOTER = 'Clock times come from the attendance terminal. Where a punch was '
  + 'missing, the time shown was supplied by a supervisor and is recorded as such.';
