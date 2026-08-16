import { api } from '../api.js';
import { can, navigate } from '../app.js';
import { fmtDay, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * Leave: who is off, who has asked, and how much everybody has left.
 *
 * Balances and requests on one screen deliberately. The question is never "how
 * much leave has Ama left" on its own — it is "can Ama have next Friday off",
 * and answering it means seeing the balance and the request together.
 */
export async function renderAttLeave() {
  const host = h('div');
  // Two different jobs. A planner puts leave in and it waits for somebody;
  // a manager is the somebody. Splitting these is the whole point of the
  // rota-planner role — otherwise "can add leave" quietly means "can grant
  // themselves leave".
  const requests = can('att_rota');
  const decides = can('att_manage');

  const [leaveData, balanceData, bootstrap] = await Promise.all([
    api.attLeave(),
    can('att_reports') ? api.attBalances() : Promise.resolve({ rows: [] }),
    api.attBootstrap(),
  ]);

  const reload = async () => mount(host, await renderAttLeave());

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
