import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import {
  fmtDay, fmtDayShort, fmtNum, h, mount, shiftDay, toast, todayISO,
} from '../util.js';
import { card, emptyState, exportButton, table } from './components.js';
import { printButton } from '../print.js';
import {
  clockCell, correctTimesDialog, field, formDialog, hoursCell, minutesCell, needsAttention,
  reasonSelect, signOffDialog, spanLabel, statusPill, totalsLine,
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

  // Whatever is on screen is what can be signed off — a day, a week, a month,
  // or any range somebody picked. The record holds a span rather than a month,
  // and refuses two that share a day, so there is nothing left to restrict here.
  const span = { from, to };

  const [data, review] = await Promise.all([
    api.attStaffReport(id, from, to),
    can('att_reports') ? api.attReview({ from, to, staffId: id }).catch(() => null) : Promise.resolve(null),
  ]);
  const single = from === to;

  const reload = async (next) => {
    const merged = { id, period, day: anchor, all: params.all, ...next };
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

  /**
   * Which span, if any, a day has already been signed off under.
   *
   * Sign-off is per period rather than per day, so this is the only way a row
   * can say so. Without it a settled month looks exactly like one nobody has
   * touched, and the same fortnight gets gone through twice before anybody
   * notices — or worse, a day is quietly corrected under a decision that was
   * made on the old figure.
   */
  const signedFor = (dayStr) => (data.signedSpans ?? []).find((sp) => sp.from <= dayStr
    && sp.to >= dayStr
    // A day the sign-off deliberately left out is not signed, however far
    // inside the span it sits. Reading the dates alone marks the three days
    // nobody could explain as settled along with the eleven that were — which
    // is precisely the opposite of what leaving them out meant, and hides them
    // from the person going back to deal with them.
    && !(sp.excluded ?? []).includes(dayStr)) ?? null;

  const manages = can('att_manage');
  // Closing a period off is a separate permission from settling a day, so a
  // rota planner can be trusted with one and not the other.
  const signs = can('att_signoff');
  // And correcting a clock time is smaller than both. Whoever builds the rota
  // holds it by default: they are the person who knows what time the kitchen
  // closed, and a correction that has to be relayed through somebody else is a
  // correction that does not get made.
  const fixesTimes = can('att_times');

  const pendingOn = (dayStr) => (data.pendingTimes ?? []).find((e) => e.day === dayStr) ?? null;

  const correctTimes = async (row) => {
    const done = await correctTimesDialog(row, data.staff, {
      signedSpan: signedFor(row.day),
      approves: data.canApproveTimes,
      pending: pendingOn(row.day),
    });
    if (!done) return;
    toast(done.pending
      ? 'Sent to an administrator. Nothing has changed on the day yet.'
      : 'Times corrected and the day settled.', 'good');
    await reload({});
  };

  // Every day still shows its status; only the buttons are held back. The
  // checkbox exists because a day that looks perfectly ordinary can still have
  // the wrong clock-out on it — the terminal read somebody out at 17:02 and the
  // kitchen ran until nine — and there would otherwise be no way to reach it.
  const showAll = params.all === '1';
  const actionable = (r) => showAll || needsAttention(r) || Boolean(pendingOn(r.day));

  /**
   * Put a day right, from the person's own report.
   *
   * The same decision the morning screen offers, moved to where a discrepancy
   * is actually noticed: somebody goes through a month before payroll, finds a
   * Tuesday marked absent that was not, and until now had to remember the date,
   * go to Today, page back to it and find them in a list of everybody.
   *
   * Offered on any day, not only the ones waiting. Changing absent to present
   * is the whole point of the request, and a day the rules already called
   * "present" can still be wrong about which shift it was against.
   */
  const resolve = async (row) => {
    const { reasons } = await api.attReasons();
    const shiftHint = row.shift
      ? `${row.shift.name}, ${row.shift.starts_at}–${row.shift.ends_at}`
      : 'No shift rostered for this day';

    const done = await formDialog({
      title: `${data.staff.name} — ${fmtDay(row.day, { withYear: true })}`,
      submitLabel: 'Record it',
      body: h('div',
        h('p.muted', shiftHint),
        row.note ? h('p', row.note) : null,
        h('div.grid.grid-2',
          field('Clocked in', h('input', { type: 'time', name: 'in', value: row.first_in || '' }),
            row.first_in ? 'What the terminal saw' : 'The terminal saw nothing'),
          field('Clocked out', h('input', { type: 'time', name: 'out', value: row.last_out || '' }),
            row.last_out ? 'What the terminal saw' : 'The terminal saw nothing'),
        ),
        field('Record this day as',
          reasonSelect(reasons, row.reason_code || suggested(row), { name: 'reason', required: true })),
        field('Note', h('input', {
          type: 'text', name: 'note', maxlength: 500,
          placeholder: 'What they told you, or who confirmed it',
        })),
        h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Recorded against your name. The punches themselves are never altered — this is a '
          + 'decision stored beside them, and it can be undone.'),

        // Correcting a day inside a signed period does not rewrite the
        // sign-off: the record keeps the figures as they stood. Which is
        // exactly why it has to be said — otherwise the correction looks like
        // it has fixed the charge, and it has not.
        signedFor(row.day)
          ? h('p.muted', { style: { color: 'var(--warn)', fontSize: '.85rem', marginBottom: 0 } },
            `${fmtDay(signedFor(row.day).from)} to ${fmtDay(signedFor(row.day).to)} has already been `
            + 'signed off. Changing this day will not change what was charged — reopen that period '
            + 'and sign it again if the figure should move.')
          : null,
      ),
      onSubmit: async (form) => api.attResolve(row.day, {
        staffId: data.staff.id,
        reason: form.get('reason'),
        in: form.get('in') || null,
        out: form.get('out') || null,
        note: form.get('note') || null,
      }),
    });

    if (done) { toast('Recorded.', 'good'); await reload({}); }
  };

  /** Take the ruling off and let the rules decide again. */
  const unresolve = async (row) => {
    if (!window.confirm(`Undo the ruling on ${fmtDay(row.day)} and let the punches speak for themselves?`)) return;
    await api.attUnresolve(row.day, { staffId: data.staff.id });
    toast('Back to what the terminal saw.');
    await reload({});
  };

  const t = data.totals;
  const leave = data.leave;

  // The leave figure follows the leave box: on screen always, on paper only if
  // somebody ticks the box below. A slip handed to one person is read by
  // whoever is standing next to them.
  const leaveTile = leave
    ? tile('Leave left', fmtNum(leave.remaining, 1), `of ${fmtNum(leave.available, 1)} days this year`)
    : null;
  if (leaveTile) leaveTile.classList.add('no-print');

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    tile('Days worked', fmtNum(t.daysWorked, t.daysWorked % 1 ? 1 : 0), `of ${fmtNum(t.scheduled, 0)} rostered`),
    tile('Hours', fmtNum(t.workedMinutes / 60, 1), 'on the clock', 'var(--c3)'),
    // Absences are a count across a period. On one day the status pill and the
    // note above already say what happened, and "Absences: 1" underneath is the
    // same fact a third time.
    single
      ? null
      : tile('Absences', fmtNum(t.daysAbsent, 0), t.openCount ? `${t.openCount} still to confirm` : 'unexcused', t.daysAbsent ? 'var(--bad)' : null),
    leaveTile,
  );

  // A single day gets the treatment the printed slip needs: the note first,
  // large, because it is the only part most people read.
  const dayCard = single && data.days.length
    ? singleDayCard(data.days[0], data.staff)
    : null;

  const monthRow = review?.rows?.[0] ?? null;

  /**
   * Sign this person's month off from the screen the corrections were made on.
   *
   * The two belong together: somebody goes through a month putting days right
   * and then has to say what the month came to. Sending them to another screen
   * to find the same person in a list of twenty-four is how the second half
   * stops happening.
   */
  const signOff = async () => {
    const done = await signOffDialog(monthRow, span);
    if (done) { toast('Signed off.', 'good'); await reload({}); }
  };

  const reopen = async () => {
    if (!window.confirm(`Reopen ${data.staff.name} — ${spanLabel(span)}?`)) return;
    await api.attUndoReview({ staffId: id, ...span });
    toast('Reopened.');
    await reload({});
  };

  const daysTable = card(single ? 'The day' : 'Day by day', {
    note: totalsLine(t),
    wide: true,
    actions: h('div.btn-row.no-print',
      manages || fixesTimes
        ? h('label.tickline', { style: { padding: 0, fontSize: '.82rem' } },
          h('input', {
            type: 'checkbox',
            checked: showAll,
            onchange: (e) => reload({ all: e.target.checked ? '1' : '' }),
          }),
          h('span', 'Show buttons on every day'))
        : null,
      monthRow && signs
      ? h('div.btn-row.no-print',
        monthRow.decision
          ? h('span.pill.good',
            monthRow.decision.decision === 'waived'
              ? 'let stand'
              : `signed: ${monthRow.decision.daysApplied > 0 ? '+' : ''}${monthRow.decision.daysApplied} days`)
          : h(monthRow.overlapping?.length ? 'span.pill.bad' : 'span.pill.warn',
            monthRow.overlapping?.length
              ? 'part of this is already signed'
              : monthRow.difference
                ? `${monthRow.difference > 0 ? '+' : ''}${monthRow.difference} over ${single ? 'the day' : 'this period'}`
                : 'square'),
        monthRow.decision
          ? h('button.btn-sm', { onclick: reopen }, 'Reopen')
          : h('button.btn-sm.btn-primary', { onclick: signOff }, `Sign off ${single ? 'the day' : 'this period'}`),
      )
      : null),
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
    {
      key: 'label',
      label: 'Status',
      format: (v, r) => {
        const span = signedFor(r.day);
        const waiting = pendingOn(r.day)
          ? h('span.pill.warn', {
            style: { marginLeft: '.35rem' },
            title: `${pendingOn(r.day).actor} asked for `
              + `${pendingOn(r.day).now_in || '—'} → ${pendingOn(r.day).now_out || '—'}`
              + `: ${pendingOn(r.day).reason ?? ''}`,
          }, '⏳ change waiting')
          : null;
        if (!span) return h('div', statusPill(r), waiting);
        return h('div',
          statusPill(r),
          waiting,
          h('span.pill.good', {
            style: { marginLeft: '.35rem' },
            title: `${span.decision === 'waived' ? 'Let stand' : `${span.daysApplied > 0 ? '+' : ''}${span.daysApplied} days`}`
              + ` — ${fmtDay(span.from)} to ${fmtDay(span.to)}, by ${span.by}`,
          }, '✓ signed'),
        );
      },
    },
    {
      key: 'fix',
      label: '',
      // Hidden on paper: a column of buttons on a printed slip is noise.
      cls: 'no-print',
      format: (v, r) => ((manages || fixesTimes) && actionable(r)
        ? h('div.btn-row.no-print',
          manages
            ? h('button.btn-sm', {
              class: r.open ? 'btn-primary' : '',
              onclick: () => resolve(r),
            }, r.open ? 'Settle' : 'Correct')
            : null,
          // Offered to a manager as well as a planner. Settling a day asks for
          // a reason and a status; somebody who only wants to move a clock-out
          // by two hours should not have to answer either.
          fixesTimes
            ? h('button.btn-sm', {
              class: !manages && r.open ? 'btn-primary' : '',
              title: 'Change the clock-in or clock-out',
              onclick: () => correctTimes(r),
            }, 'Times')
            : null,
          manages && r.resolution && r.resolution !== 'auto' && r.resolved_by
            ? h('button.btn-sm', { onclick: () => unresolve(r) }, 'Undo')
            : null)
        : null),
    },
  ], data.days, {
    rowClass: (r) => `row-att-${r.colour}`,
    empty: 'Nothing recorded for this period.',
  }),
  data.days.some((d) => d.resolved_by)
    ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Times in rows marked as confirmed were supplied by a supervisor where the terminal had no record.')
    : null,
  timeEditTrail(data.timeEdits ?? []));

  const pendingCard = (data.pendingTimes ?? []).length
    ? h('div.alert.warn.no-print', { style: { marginTop: '.8rem' } },
      h('span.alert-icon', '⏳'),
      h('div',
        h('div.alert-title', `${data.pendingTimes.length} clock-time change`
          + `${data.pendingTimes.length === 1 ? '' : 's'} waiting on an administrator`),
        h('div.alert-detail', data.pendingTimes.map((e) =>
          `${fmtDayShort(e.day)}: ${e.now_in || '—'} → ${e.now_out || '—'}, asked by ${e.actor}`)
          .join(' · ')
          + '. Nothing on these days has changed yet, so a period signed off now is signed '
          + 'off on the figures as they stand.'),
      ))
    : null;

  // Shown for a single day as well as a range. The big card above already
  // carries the note, but a person reading a slip looks for the same heading
  // whatever period it covers, and "it is on this screen but not that one"
  // is the kind of inconsistency that makes people distrust the whole thing.
  const notesCard = data.days.some((d) => d.colour === 'amber' || d.colour === 'red')
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

  // Off the printout unless somebody says otherwise.
  //
  // A slip handed to one person is read by whoever is standing next to them,
  // and how much leave they have left is nobody else's business. It stays on
  // screen, where the manager who opened it already has the whole record — the
  // choice is only about what goes on paper.
  const printLeave = h('input', {
    type: 'checkbox',
    checked: false,
    onchange: (e) => {
      // Both, or the tile at the top of the page would go out on paper while
      // the box explaining it stayed behind — which is the worse of the two to
      // hand somebody.
      leaveCard.classList.toggle('no-print', !e.target.checked);
      leaveTile?.classList.toggle('no-print', !e.target.checked);
    },
  });

  const adjusted = Number(leave?.adjusted || 0);

  // Absent entirely for anybody who may sign a period off but not see balances.
  const leaveCard = !leave ? null : card('Leave', {
    note: `${leave.year} leave year — ${fmtDay(leave.from)} to ${fmtDay(leave.to)}`,
    actions: h('label.no-print', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '.35rem', fontSize: '.82rem' },
      title: 'Whether this box appears when you save or print this report',
    }, printLeave, 'Include on the printout'),
  },
    h(`div.grid.grid-${adjusted ? 4 : 3}`,
      tile('Entitlement', fmtNum(leave.entitlement, 1), leave.proRated ? 'pro-rata from start date' : 'days a year'),
      // Only shown when it is not zero: a permanent "0 days adjusted" tile is a
      // question nobody asked, and the point of this one is that it is unusual.
      adjusted
        ? tile(
          adjusted > 0 ? 'Days given back' : 'Days charged',
          `${adjusted > 0 ? '+' : ''}${fmtNum(adjusted, 1)}`,
          adjusted > 0 ? 'for months worked over' : 'for months worked short',
          adjusted > 0 ? 'var(--good)' : 'var(--bad)',
        )
        : null,
      tile('Taken', fmtNum(leave.taken, 1), leave.booked ? `${fmtNum(leave.booked, 1)} more booked` : 'days so far'),
      tile('Remaining', fmtNum(leave.remaining, 1), leave.pending ? `${fmtNum(leave.pending, 1)} awaiting a decision` : 'days', 'var(--good)'),
    ),

    adjusted
      ? h('p.muted', { style: { fontSize: '.85rem', marginTop: '.6rem', marginBottom: 0 } },
        adjusted > 0
          ? `${fmtNum(adjusted, 1)} day${Math.abs(adjusted) === 1 ? '' : 's'} added to this year's `
            + 'entitlement for months where more was worked than the rota asked for. Signed off on '
            + 'the Leave screen, month by month.'
          : `${fmtNum(Math.abs(adjusted), 1)} day${Math.abs(adjusted) === 1 ? '' : 's'} taken off this `
            + "year's entitlement for months worked short of the rota. Signed off on the Leave "
            + 'screen, month by month, and reversible there.')
      : null,
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

  // Starts hidden on paper, matching the unticked box above it.
  if (leaveCard) leaveCard.classList.add('no-print');

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
    pendingCard,
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
      // Only lateness. Overtime is measured from the shift end with no
      // threshold behind it, so every evening somebody stays ten minutes reads
      // as overtime — a number that means nothing here and is asked about.
      record.late_minutes ? box('Late by', minutesCell(record.late_minutes)) : null,
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

/**
 * What to pre-select when correcting a day.
 *
 * Conservative on purpose. A day with an arrival and no departure is almost
 * always somebody who worked and forgot, so "present" is offered. A day with
 * nothing at all is offered nothing — that one needs a human to choose, and
 * pre-picking "absent" would turn the dialog into a rubber stamp for exactly
 * the decision this screen exists to let somebody reconsider.
 */
function suggested(row) {
  if (row.status === 'missing_out' || row.status === 'missing_in') {
    return row.late_minutes > 5 ? 'late' : 'present';
  }
  return '';
}

/**
 * What was changed, by whom, and why.
 *
 * Printed with the report rather than tucked behind a screen only
 * administrators can reach. A person handed a slip that says they worked eight
 * hours is entitled to see, on the same sheet, that somebody moved their
 * clock-out to make it eight — and the surest way to make an audit trail
 * meaningless is to keep it somewhere the person it concerns never looks.
 */
const DECISION = {
  rejected: 'Sent back',
  superseded: 'Replaced before it was answered',
  pending: 'Waiting on an administrator',
};

function timeEditTrail(edits) {
  if (!edits.length) return null;

  const side = (label, observed, was, now) => {
    const from = was ?? observed;
    if (from === now) return null;
    if (!now) return `${label} ${from} removed — back to what the terminal saw`;
    if (!from) return `${label} set to ${now}, where the terminal saw nothing`;
    return `${label} ${from} → ${now}`;
  };

  return h('div', { style: { marginTop: '1rem' } },
    h('h3', { style: { fontSize: '.95rem', marginBottom: '.4rem' } }, 'Clock times changed'),
    h('ul', { style: { fontSize: '.85rem', lineHeight: 1.55, paddingLeft: '1.1rem', margin: 0 } },
      edits.map((e) => h('li',
        h('strong', fmtDayShort(e.day)),
        ' — ',
        [side('in', e.observed_in, e.was_in, e.now_in), side('out', e.observed_out, e.was_out, e.now_out)]
          .filter(Boolean).join('; ') || 'no change',
        h('br'),
        h('small.muted', `${e.actor}, ${(e.at_utc || '').slice(0, 16).replace('T', ' ')}`
          + `${e.reason ? ` — ${e.reason}` : ''}`),
        e.status && e.status !== 'approved'
          ? h('div', h('small.muted', DECISION[e.status] ?? e.status,
            e.decision_note ? `: ${e.decision_note}` : ''))
          : e.decided_by && e.decided_by !== e.actor
            ? h('div', h('small.muted', `Approved by ${e.decided_by}`))
            : null,
      ))),
  );
}
