import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import { fmtDay, fmtNum, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { alertList, card, emptyState, exportButton, moreActions, table } from './components.js';
import { printButton } from '../print.js';
import { birthdayStrip } from './birthday.js';
import { byDepartment, sayHowItStands, standing, toDealWith } from '../today-groups.js';
import {
  clockCell, correctTimesDialog, field, formDialog, hoursCell, minutesCell, needsAttention,
  reasonSelect, statusPill, totalsLine,
} from './att-shared.js';

/**
 * The morning screen.
 *
 * One job: show a supervisor what needs dealing with before they get on with
 * their day. Arranged the way somebody actually walks the building — one card
 * per department, everybody in it once, and a colour against the name saying
 * whether they are absent, late or in.
 *
 * It used to be four lists by state. That is the right order for one person
 * clearing a queue at a desk and the wrong shape for everybody else: a head of
 * housekeeping wants her floor, not the property's absences, and "is my
 * department all in" took reading four lists and remembering which names were
 * in which. The order inside each card is the old order, because within a
 * department it was doing real work.
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
  const quiet = terminalBanner(data.terminals);
  // Only ever on the day itself, and never allowed to stop the morning list
  // loading. It is a nicety; the rest of this screen is the job.
  const birthdays = day === todayISO() ? await birthdayStrip().catch(() => null) : null;
  // Everything with something against it. The list is no longer a section of
  // the screen, but it is still exactly what the download is: whoever is about
  // to walk round the building wants the eight names with something wrong,
  // not the ninety who turned up.
  const issues = data.rows.filter(toDealWith);

  const nav = h('div.toolbar',
    // Arrows on a phone, words on a desk. The date sits between them and the
    // three of them take one row: "‹ Previous day" and "Next day ›" either
    // side of a date field is wider than a handset, and what it costs is a
    // whole row of the screen to say twice what the field already says.
    h('button.btn-sm', {
      onclick: () => reload(shiftDay(day, -1)),
      'aria-label': 'The day before',
    }, '‹', h('span.only-desk', ' Previous day')),
    h('input', {
      type: 'date', value: day, max: data.today,
      onchange: (e) => e.target.value && reload(e.target.value),
    }),
    h('button.btn-sm', {
      onclick: () => reload(shiftDay(day, 1)),
      disabled: day >= data.today,
      'aria-label': 'The day after',
    }, h('span.only-desk', 'Next day '), '›'),
    day !== data.today ? h('button.btn-sm', { onclick: () => reload(data.today) }, 'Today') : null,
    h('div', { style: { flex: 1 } }),

    // Everything that makes a file. On a desk they sit along the toolbar as
    // they always did; on a phone they are one More button, because four of
    // them wrap onto three rows and push the morning's list off the screen.
    moreActions(
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
    ),
  );

  if (!data.rows.length) {
    mount(host,
      h('div.page-head', h('h1', 'Attendance'), h('div.sub', fmtDay(day, { withYear: true }))),
      nav,
      quiet,
      clocks,
      birthdays,
      // Two different empty screens wearing one sentence. A Sunday nobody is
      // working needs nothing done about it; a property with nobody on the
      // books needs somebody to go and set it up, and telling the first one to
      // do the second is how a quiet day reads as a broken app.
      data.anybody
        ? emptyState(
          'Nobody on for this day',
          'Nobody is rostered and nobody clocked in. If that is wrong, the rota for this day is '
          + 'where to put it right.',
        )
        : emptyState(
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
      // The colour sits beside the name rather than only down the edge of the
      // row. The department is the card's heading now, so what the second line
      // said is said once at the top instead of against every person.
      format: (v, r) => h('div.today-who',
        h('span.today-dot', {
          class: `is-${standing(r)}`,
          title: r.open ? 'Waiting on a decision' : r.label,
          'aria-label': r.open ? 'Waiting on a decision' : r.label,
        }),
        h('div',
          h('div', h('a', {
            href: `#/att-staff?id=${v.id}&day=${day}`,
            onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: v.id, day }); },
          }, v.name)),
          h('small.muted', `No. ${v.employee_no}`),
        ),
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

  const departments = byDepartment(data.rows);

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

    departments.map((group) => card(group.department, {
      note: sayHowItStands(group),
      wide: true,
    }, table(columns, group.rows, { rowClass: (r) => `row-att-${r.colour}` }))),
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
function terminalBanner(spells) {
  if (!spells?.length) return null;
  return alertList(spells.map((s) => ({
    level: 'high',
    title: `${s.device} has gone quiet`,
    detail: `Nothing has been heard from it since ${s.since.slice(11)} on ${fmtDay(s.since.slice(0, 10))}. `
      + (s.due === 1
        ? 'One person was due to start since then and has no punch. '
        : `${s.due} people were due to start since then and none of them has a punch. `)
      + 'Until it is back, the shifts that began in the silence are held on the to-confirm list '
      + 'rather than marked absent. Check the terminal is on and the machine that polls it is running.',
  })));
}

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
