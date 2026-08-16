import { api } from '../api.js';
import { can, navigate } from '../app.js';
import { fmtDay, fmtNum, h, monthOf, mount, shiftMonth, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { field, formDialog, monthLabel, signOffDialog } from './att-shared.js';

/**
 * Leave: who is off, who has asked, and how much everybody has left.
 *
 * Balances and requests on one screen deliberately. The question is never "how
 * much leave has Ama left" on its own — it is "can Ama have next Friday off",
 * and answering it means seeing the balance and the request together.
 */
export async function renderAttLeave(params = {}) {
  const host = h('div');
  // Two different jobs. A planner puts leave in and it waits for somebody;
  // a manager is the somebody. Splitting these is the whole point of the
  // rota-planner role — otherwise "can add leave" quietly means "can grant
  // themselves leave".
  const requests = can('att_rota');
  const decides = can('att_manage');

  const month = params.month || monthOf(todayISO());
  const [leaveData, balanceData, bootstrap, review] = await Promise.all([
    api.attLeave(),
    can('att_reports') ? api.attBalances() : Promise.resolve({ rows: [] }),
    api.attBootstrap(),
    can('att_reports') ? api.attMonthReview(month).catch(() => null) : Promise.resolve(null),
  ]);

  const reload = async (next = month) => mount(host, await renderAttLeave({ month: next }));

  const leaveKinds = bootstrap.reasons.filter((r) => r.kind === 'leave' && r.active);
  const pending = leaveData.leave.filter((l) => l.status === 'pending');
  const upcoming = leaveData.leave.filter((l) => l.status === 'approved' && l.to_day >= todayISO());
  const past = leaveData.leave.filter((l) => l.status !== 'pending' && !(l.status === 'approved' && l.to_day >= todayISO()));

  const request = async () => {
    const done = await formDialog({
      title: 'Record leave',
      submitLabel: decides ? 'Approve and record' : 'Send for approval',
      body: h('div',
        field('Who', h('select', { name: 'staffId', required: true },
          h('option', { value: '' }, 'Choose…'),
          bootstrap.staff.filter((s) => s.active).map((s) =>
            h('option', { value: s.id }, s.name)))),
        field('Type', h('select', { name: 'reason', required: true },
          h('option', { value: '' }, 'Choose…'),
          leaveKinds.map((r) => h('option', { value: r.code }, r.label)))),
        h('div.field-row',
          field('First day', h('input', { type: 'date', name: 'from', required: true })),
          field('Last day', h('input', { type: 'date', name: 'to', required: true })),
        ),
        field('Half day', h('select', { name: 'halfDay' },
          h('option', { value: '' }, 'No — full days throughout'),
          h('option', { value: 'start' }, 'Back for the afternoon of the first day'),
          h('option', { value: 'end' }, 'Off from the afternoon of the last day'),
          h('option', { value: 'both' }, 'Half day at each end'),
        )),
        field('Reason', h('input', { type: 'text', name: 'note', maxlength: 500 })),
        h('p.muted', { style: { fontSize: '.82rem' } },
          'Only rostered days are charged. Rest days and public holidays inside the period cost nothing.'),
      ),
      onSubmit: async (form) => api.attRequestLeave({
        staffId: Number(form.get('staffId')),
        reason: form.get('reason'),
        from: form.get('from'),
        to: form.get('to'),
        halfDay: form.get('halfDay') || null,
        note: form.get('note') || null,
      }),
    });

    if (done) {
      toast(done.status === 'approved'
        ? `${fmtNum(done.days, 1)} day${done.days === 1 ? '' : 's'} recorded.`
        : 'Sent for approval.', 'good');
      await reload();
    }
  };

  const decide = async (row, decision) => {
    try {
      await api.attDecideLeave(row.id, { decision });
      toast(decision === 'approved' ? 'Approved.' : 'Rejected.', decision === 'approved' ? 'good' : '');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const cancel = async (row) => {
    if (!window.confirm(
      `Cancel ${row.staff_name}'s ${row.reason_label?.toLowerCase() ?? 'leave'} `
      + `from ${fmtDay(row.from_day)} to ${fmtDay(row.to_day)}?\n\n`
      + 'Those days go back to whatever the terminal recorded, which for days already past '
      + 'usually means they become absences.',
    )) return;
    try {
      await api.attCancelLeave(row.id);
      toast('Cancelled.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const columns = (kind) => [
    {
      key: 'staff_name',
      label: 'Name',
      format: (v, r) => h('div', h('div', v), h('small.muted', `No. ${r.employee_no}`)),
    },
    { key: 'reason_label', label: 'Type', format: (v, r) => h('span.pill', v || r.reason_code) },
    {
      key: 'from_day',
      label: 'When',
      format: (v, r) => (v === r.to_day ? fmtDay(v) : `${fmtDay(v)} – ${fmtDay(r.to_day)}`),
    },
    { key: 'days', label: 'Days', align: 'right', format: (v) => fmtNum(v, v % 1 ? 1 : 0) },
    { key: 'paid', label: 'Paid', format: (v) => (v ? h('span.pill.good', 'Paid') : h('span.pill', 'Unpaid')) },
    { key: 'reason', label: 'Reason', format: (v) => (v ? h('small', v) : h('span.muted', '—')) },
    {
      key: 'status',
      label: kind === 'pending' ? '' : 'Status',
      format: (v, r) => {
        if (kind === 'pending' && decides) {
          return h('div.btn-row',
            h('button.btn-sm.btn-primary', { onclick: () => decide(r, 'approved') }, 'Approve'),
            h('button.btn-sm', { onclick: () => decide(r, 'rejected') }, 'Reject'),
          );
        }
        if (v === 'approved' && decides && r.to_day >= todayISO()) {
          return h('div.btn-row',
            h('span.pill.good', 'Approved'),
            h('button.btn-sm', { onclick: () => cancel(r) }, 'Cancel'),
          );
        }
        return h(`span.pill${v === 'approved' ? '.good' : v === 'rejected' ? '.bad' : ''}`, capitalise(v));
      },
    },
  ];

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Leave'),
        h('div.sub', 'Annual leave, sickness and everything else that keeps somebody off the rota'),
      ),
      requests
        ? h('button.btn.btn-primary', { onclick: request },
          decides ? '+ Record leave' : '+ Request leave')
        : null,
    ),

    pending.length
      ? card('Waiting for a decision', { note: `${pending.length}`, wide: true },
        table(columns('pending'), pending))
      : null,

    card('Booked and coming up', { note: `${upcoming.length}`, wide: true },
      table(columns('upcoming'), upcoming, { empty: 'Nobody is booked off.' })),

    monthCard(review, month, decides, reload),

    balanceData.rows.length
      ? card('Balances', { note: `As at ${fmtDay(balanceData.asOf)}`, wide: true },
        table([
          {
            key: 'staff',
            label: 'Name',
            format: (v) => h('a', {
              href: `#/att-staff?id=${v.id}`,
              onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: v.id, period: 'month' }); },
            }, v.name),
          },
          { key: 'entitlement', label: 'Entitlement', align: 'right', format: (v, r) => h('span', fmtNum(r.balance.entitlement, 1), r.balance.proRated ? h('small.muted', ' pro-rata') : null) },
          { key: 'carry', label: 'Carried over', align: 'right', format: (v, r) => (r.balance.carryOver ? fmtNum(r.balance.carryOver, 1) : h('span.muted', '—')) },
          { key: 'taken', label: 'Taken', align: 'right', format: (v, r) => fmtNum(r.balance.taken, 1) },
          { key: 'booked', label: 'Booked', align: 'right', format: (v, r) => (r.balance.booked ? fmtNum(r.balance.booked, 1) : h('span.muted', '—')) },
          { key: 'pending', label: 'Asked for', align: 'right', format: (v, r) => (r.balance.pending ? h('span', { style: { color: 'var(--warn)' } }, fmtNum(r.balance.pending, 1)) : h('span.muted', '—')) },
          {
            key: 'remaining',
            label: 'Left',
            align: 'right',
            format: (v, r) => h('strong', {
              style: { color: r.balance.remaining <= 0 ? 'var(--bad)' : r.balance.remaining < 3 ? 'var(--warn)' : 'var(--good)' },
            }, fmtNum(r.balance.remaining, 1)),
          },
          {
            key: 'qualified',
            label: '',
            format: (v, r) => (r.balance.qualified
              ? ''
              : h('small.muted', { title: `${r.balance.serviceMonths} months' service` }, 'not yet qualified')),
          },
        ], balanceData.rows, { empty: 'Nobody set up yet.' }),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
          'The default entitlement follows the Labour Act — fifteen working days after twelve months\' '
          + 'continuous service — and can be changed for the property or for one person in Attendance setup. '
          + 'Somebody part way through their first year is shown a pro-rata figure so you can see what they '
          + 'are on course for.'))
      : null,

    past.length
      ? card('Earlier', { note: `${past.length}`, wide: true }, table(columns('past'), past.slice(0, 60)))
      : null,

    !leaveData.leave.length && !balanceData.rows.length
      ? emptyState('No leave recorded', 'Once staff are set up, record leave here and it will show on the rota and in the reports.')
      : null,
  );

  return host;
}

function capitalise(value) {
  return String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);
}

/**
 * The monthly reckoning: days owed against days worked, and what to do about
 * the gap.
 *
 * Both numbers are computed fresh every time this loads, so a shift corrected
 * this morning or a supervisor's ruling from yesterday shows here immediately —
 * right up until somebody signs the month off. After that the figures as signed
 * are kept beside the live ones, because a decision whose basis has quietly
 * changed underneath it is worse than no decision.
 *
 * Signing off is deliberately two numbers, not one. The difference is what the
 * rota and the terminal say; what actually comes off somebody's leave is a
 * judgement, and the form opens with the difference filled in rather than
 * applied — a default, not a verdict.
 */
function monthCard(review, month, decides, reload) {
  if (!review) return null;

  const step = async (n) => reload(shiftMonth(month, n));

  const sign = async (row) => {
    const done = await signOffDialog(row, month);
    if (done) { toast('Recorded.', 'good'); await reload(); }
  };

  const undo = async (row) => {
    if (!window.confirm(`Reopen ${row.staff.name}'s ${monthLabel(month)}?`)) return;
    await api.attUndoMonth({ staffId: row.staff.id, month });
    toast('Reopened.');
    await reload();
  };

  const waiting = review.rows.filter((r) => !r.decision).length;

  return card('The month, day for day', {
    note: waiting
      ? `${waiting} still to go through`
      : `all ${review.rows.length} signed off`,
    wide: true,
    actions: h('div.btn-row',
      h('button.btn-sm', { onclick: () => step(-1) }, '‹'),
      h('input', {
        type: 'month', value: month,
        onchange: (e) => e.target.value && reload(e.target.value),
      }),
      h('button.btn-sm', {
        onclick: () => step(1),
        disabled: month >= monthOf(todayISO()),
      }, '›'),
    ),
  },
    review.unsettled
      ? h('p.muted', { style: { color: 'var(--warn)', marginTop: 0 } },
        `${review.unsettled} day${review.unsettled === 1 ? '' : 's'} this month are still waiting `
        + 'on a supervisor. Their hours are not settled, so signing off now signs off a guess.')
      : null,

    table([
      { key: 'staff', label: 'Name', format: (v) => h('div', h('div', v.name), h('small.muted', v.department || v.employee_no)) },
      {
        key: 'scheduledDays',
        label: 'Rostered',
        align: 'right',
        format: (v, r) => openable(fmtNum(v, 1), () => breakdown(r, month, 'rostered')),
      },
      {
        key: 'workedDays',
        label: 'Worked',
        align: 'right',
        format: (v, r) => openable(fmtNum(v, 1), () => breakdown(r, month, 'worked')),
      },
      {
        key: 'difference',
        label: 'Over / under',
        align: 'right',
        format: (v, r) => {
          if (!v) {
            return r.overDays || r.underDays
              ? openable(h('span.muted', 'square'), () => breakdown(r, month, 'under'))
              : h('span.muted', 'square');
          }
          return openable(
            h(`span.pill${v < 0 ? '.bad' : '.good'}`, `${v > 0 ? '+' : ''}${v}`),
            () => breakdown(r, month, v < 0 ? 'under' : 'over'),
          );
        },
      },
      { key: 'daysAbsent', label: 'Absent', align: 'right', format: (v) => (v ? fmtNum(v, 0) : h('span.muted', '—')) },
      { key: 'daysLeave', label: 'On leave', align: 'right', format: (v) => (v ? fmtNum(v, 1) : h('span.muted', '—')) },
      {
        key: 'decision',
        label: 'Decision',
        format: (v) => {
          if (!v) return h('span.pill.warn', 'waiting');
          if (v.decision === 'waived') return h('div', h('span.pill', 'let stand'), h('small.muted', ` ${v.by}`));
          return h('div',
            h('span.pill.good', `${v.daysApplied > 0 ? '+' : ''}${fmtNum(v.daysApplied, 1)} days`),
            h('small.muted', ` ${v.by}`));
        },
      },
      {
        key: 'actions',
        label: '',
        format: (v, r) => (decides
          ? h('div.btn-row', r.decision
            ? h('button.btn-sm', { onclick: () => undo(r) }, 'Reopen')
            : h('button.btn-sm.btn-primary', { onclick: () => sign(r) }, 'Sign off'))
          : null),
      },
    ], review.rows, { empty: 'Nobody was rostered or worked in this month.' }),

    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Every figure on a row can be pressed to see the days behind it. Over and under are counted '
      + 'as whole days, never hours: an extra day counts only past six hours worked, and a shortfall '
      + 'counts only when a whole shift was missed and somebody ruled on it. '
      + 'Rostered counts the days the rota asked for, with approved leave and public holidays already '
      + 'taken out — so what is left is a real gap rather than somebody\u2019s fortnight in July. '
      + 'Signing off moves days on and off the leave balance, and the balances above include '
      + 'every month already signed.'),
  );
}

/** A figure you can press, which is the difference between a number and a claim. */
function openable(content, onclick) {
  return h('button.btn-plain', {
    onclick,
    title: 'See the days behind this',
    style: {
      background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit',
      color: 'inherit', textDecoration: 'underline', textDecorationStyle: 'dotted',
      textUnderlineOffset: '3px',
    },
  }, content);
}


/**
 * The days behind a figure.
 *
 * Every number on that row is a count of days, and a count nobody can open is
 * an assertion. Rostered, worked, over and under each list the days they were
 * made of — which is what turns "you were two days short" from a claim into
 * something a person can be shown.
 */
function breakdown(row, month, which) {
  const titles = {
    rostered: 'Days the rota asked for',
    worked: 'Days worked',
    over: 'Extra days that counted',
    under: 'Whole shifts missed and confirmed',
  };

  const pick = {
    rostered: (d) => d.scheduled,
    worked: (d) => d.credit > 0,
    over: (d) => d.counts === 'over',
    under: (d) => d.counts === 'under',
  }[which];

  const days = (row.days ?? []).filter(pick);

  return formDialog({
    title: `${row.staff.name} — ${titles[which]}`,
    submitLabel: 'Close',
    body: h('div',
      h('p.muted', `${monthLabel(month)} — ${days.length} day${days.length === 1 ? '' : 's'}`),
      which === 'over'
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          'A day the rota did not ask for, where more than six hours were actually worked. '
          + 'Shorter days are not counted: two hours covering a gap is a favour, not a day off '
          + 'in lieu.')
        : null,
      which === 'under'
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          'A whole rostered shift missed, and only once somebody has ruled on it. A part-day is '
          + 'never an under, and an absence nobody has confirmed may yet be a forgotten tap.')
        : null,
      days.length
        ? table([
          { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
          { key: 'shift', label: 'Shift', format: (v) => (v ? h('small', v) : h('span.muted', 'not rostered')) },
          { key: 'in', label: 'In', align: 'right', format: (v) => (v || h('span.muted', '—')) },
          { key: 'out', label: 'Out', align: 'right', format: (v) => (v || h('span.muted', '—')) },
          { key: 'minutes', label: 'Hours', align: 'right', format: (v) => (v ? fmtNum(v / 60, 1) : h('span.muted', '—')) },
          { key: 'label', label: 'Status', format: (v) => h('small', v) },
          { key: 'resolvedBy', label: 'Ruled by', format: (v) => (v ? h('small.muted', v) : h('span.muted', '—')) },
        ], days, { empty: 'None.' })
        : h('div.empty', h('p', which === 'under'
          ? 'Nothing counted. Absences that nobody has confirmed do not count here — settle them '
            + 'on the person\u2019s report and they will appear.'
          : 'Nothing counted.')),
    ),
    onSubmit: async () => true,
  });
}
