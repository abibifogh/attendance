import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import { fmtDay, fmtNum, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { alertList, card, emptyState, exportButton, table } from './components.js';
import { printButton } from '../print.js';
import { birthdayStrip } from './birthday.js';
import {
  clockCell, correctTimesDialog, field, formDialog, hoursCell, minutesCell, needsAttention,
  reasonSelect, statusPill, totalsLine,
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
  // Correcting a clock time is smaller than settling a day, and whoever builds
  // the rota holds it on its own.
  const fixesTimes = can('att_times');
  const clocks = clockBanner(data.clockWarnings);
  // Only ever on the day itself, and never allowed to stop the morning list
  // loading. It is a nicety; the rest of this screen is the job.
  const birthdays = day === todayISO() ? await birthdayStrip().catch(() => null) : null;
  const needing = data.rows.filter((r) => r.open);
  const absent = data.rows.filter((r) => !r.open && r.colour === 'red');
  const flagged = data.rows.filter((r) => !r.open && r.colour === 'amber');
  const fine = data.rows.filter((r) => !r.open && (r.colour === 'green' || r.colour === 'grey'));
  // The three groups below, together — which is exactly what the download is.
  const issues = [...needing, ...absent, ...flagged];

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

    // Just the ones needing somebody, as a file. The full export is the
    // payroll extract and answers a different question at the wrong length:
    // whoever is about to walk round the building wants the eight names with
    // something against them, not the ninety who turned up.
    //
    // Offered to anybody who can open this screen. Everything in the file is
    // already on it.
    issues.length
      ? exportButton(api.attIssuesUrl({ day }),
        `Download the ${issues.length} to deal with`)
      : null,
    // And the same thing across the week, for whoever comes back on a Monday
    // to a Friday nobody settled.
    issues.length
      ? h('a.btn.btn-sm', {
        href: api.attIssuesUrl({ from: shiftDay(day, -6), to: day }),
        download: '',
        title: 'Everything with something wrong with it, over the last seven days',
      }, 'Last 7 days')
      : null,
    can('att_reports') ? exportButton(api.attExportUrl(day, day), 'Export this day') : null,
  );

  if (!data.rows.length) {
    mount(host,
      h('div.page-head', h('h1', 'Attendance'), h('div.sub', fmtDay(day, { withYear: true }))),
      nav,
      clocks,
      birthdays,
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

  /**
   * Move a clock time without ruling on the day.
   *
   * The smaller of the two actions on this screen, and the one most of the
   * morning's list actually needs: the person was here, the terminal read them
   * out at the wrong minute, and nothing else about the day is in doubt.
   */
  const correctTimes = async (row) => {
    const done = await correctTimesDialog({ ...row, day }, row.staff, { approves: can('att_setup') });
    if (!done) return;
    toast(done.pending
      ? `${row.staff.name}: sent to an administrator. Nothing has changed on the day yet.`
      : `${row.staff.name}: times corrected and the day settled.`, 'good');
    await reload();
  };

  const columns = [
    {
      key: 'staff',
      label: 'Name',
      format: (v, r) => h('div',
        h('div', h('a', {
          href: `#/att-staff?id=${v.id}&day=${day}`,
          onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: v.id, day }); },
        }, v.name)),
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

  if (manages || fixesTimes) {
    columns.push({
      key: 'resolution',
      label: '',
      // Only against days with something wrong with them. A column of buttons
      // beside everybody who turned up on time is a column nobody reads.
      format: (v, r) => (needsAttention(r) ? h('div.btn-row',
        manages
          ? (v === 'resolved'
            ? h('button.btn-sm', { onclick: () => undo(r) }, 'Undo')
            : h('button.btn-sm', {
              class: r.open ? 'btn-primary' : '',
              onclick: () => resolve(r),
            }, r.open ? 'Confirm' : 'Change'))
          : null,
        fixesTimes
          ? h('button.btn-sm', {
            class: !manages && r.open ? 'btn-primary' : '',
            title: 'Change the clock-in or clock-out',
            onclick: () => correctTimes(r),
          }, 'Times')
          : null,
      ) : null),
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
    clocks,
    birthdays,

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

/**
 * A terminal whose clock has wandered, said before anything else on the screen.
 *
 * Above the counts on purpose. Every number underneath it was worked out from
 * times this terminal supplied, so if the clock is wrong they are all wrong,
 * and reading them first and the warning second is the wrong way round.
 *
 * Silent when there is nothing to say — an "all clear" for a fault that is rare
 * would be one more thing to scroll past every morning, and the whole point of
 * this screen is that everything on it needs dealing with.
 */
function clockBanner(warnings) {
  if (!warnings?.length) return null;

  return alertList(warnings.map((w) => ({
    level: Math.abs(w.offsetSeconds) >= 900 ? 'high' : 'warn',
    title: 'The terminal’s clock is wrong',
    detail: `${w.note} Fix it on the terminal: set the time zone to GMT+00:00, leave daylight `
      + 'saving off, and switch time sync to NTP so it corrects itself from now on.',
  })));
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
