import { api } from '../api.js';
import { fmtDay, fmtDayShort, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { can } from '../app.js';
import { navigate, replaceParams } from '../app.js';
import { correctTimesDialog, field, formDialog } from './att-shared.js';

/**
 * What is still waiting to be signed off.
 *
 * The screen whoever builds the rota opens on a Monday. Two ideas behind it.
 *
 * Signing is per day, not per month. A fortnight with three days nobody can
 * explain used to be all-or-nothing — sign the lot or leave eleven settled days
 * waiting on three — so the three held up everything and nothing got signed.
 * Now the clear days go and the awkward ones stay on the list.
 *
 * And there is a second answer beside "sign it". A run of lateness or an
 * absence nobody has explained is a question for somebody senior before it
 * becomes a charge against a colleague's leave. Raising it is one press, and
 * it lands in a queue rather than in a conversation nobody can find again.
 */
const PRESETS = [
  ['yesterday', 'Yesterday'],
  ['week', 'Last 7 days'],
  ['fortnight', 'Last 14 days'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
];

const TABS = [['open', 'To sign off'], ['queries', 'Questions'], ['times', 'Clock changes']];

export async function renderAttSignoff(params) {
  const host = h('div');
  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'open';
  const range = rangeFor(params);

  const reload = async (next = {}) => {
    const merged = { ...params, ...next };
    replaceParams('signoff', merged);
    mount(host, await renderAttSignoff(merged));
  };

  const tabs = h('div.seg.seg-wrap', TABS.map(([key, label]) =>
    h('button', { class: tab === key ? 'active' : '', onclick: () => reload({ tab: key }) }, label)));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Sign-off'),
        h('div.sub', 'Settle up as you go — a day at a time, not a month at a time'),
      ),
    ),
    h('div.toolbar', tabs),
    tab === 'queries' ? await queriesTab(reload)
      : tab === 'times' ? await timesTab(range, reload)
        : await openTab(params, range, reload),
  );

  return host;
}

/** The window, from a preset or a pair of dates picked by hand. */
function rangeFor(params) {
  if (params.from && params.to) return { from: params.from, to: params.to, preset: null };

  const today = todayISO();
  const preset = params.preset || 'fortnight';

  if (preset === 'yesterday') return { from: shiftDay(today, -1), to: shiftDay(today, -1), preset };
  if (preset === 'week') return { from: shiftDay(today, -7), to: shiftDay(today, -1), preset };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: shiftDay(today, -1), preset };
  if (preset === 'lastmonth') {
    const first = `${today.slice(0, 7)}-01`;
    const end = shiftDay(first, -1);
    return { from: `${end.slice(0, 7)}-01`, to: end, preset };
  }
  return { from: shiftDay(today, -14), to: shiftDay(today, -1), preset: 'fortnight' };
}

// ---------------------------------------------------------------------------
// What is outstanding
// ---------------------------------------------------------------------------

async function openTab(params, range, reload) {
  const onlyIssues = params.issues === '1';
  const data = await api.attOutstanding({
    from: range.from,
    to: range.to,
    ...(params.department ? { department: params.department } : {}),
    ...(onlyIssues ? { issues: '1' } : {}),
  });

  const filters = h('div.toolbar',
    h('div.seg.seg-wrap', PRESETS.map(([key, label]) =>
      h('button', {
        class: range.preset === key ? 'active' : '',
        onclick: () => reload({ preset: key, from: null, to: null }),
      }, label))),

    h('input', {
      type: 'date', value: range.from, 'aria-label': 'From',
      onchange: (e) => e.target.value && reload({ from: e.target.value, to: range.to, preset: null }),
    }),
    h('input', {
      type: 'date', value: range.to, 'aria-label': 'To',
      onchange: (e) => e.target.value && reload({ from: range.from, to: e.target.value, preset: null }),
    }),

    data.departments?.length
      ? h('select', {
        onchange: (e) => reload({ department: e.target.value || null }),
      },
      h('option', { value: '' }, 'Every department'),
      data.departments.map((d) => h('option', {
        value: d, selected: params.department === d,
      }, d)))
      : null,

    h('label.inline-check',
      h('input', {
        type: 'checkbox', checked: onlyIssues,
        onchange: (e) => reload({ issues: e.target.checked ? '1' : null }),
      }),
      h('span', 'Only the ones with something wrong')),
  );

  return h('div',
    h('div.grid.grid-4',
      tile('Days outstanding', data.total, `${data.rows.length} people`),
      tile('With something wrong', data.withIssues, data.withIssues ? 'worth a look' : 'all clean',
        data.withIssues ? 'var(--warn)' : 'var(--good)'),
      tile('Worth stopping for', data.blocked,
        data.blocked ? 'absence or unsettled' : 'nothing blocking',
        data.blocked ? 'var(--bad)' : null),
      tile('Up to', fmtDayShort(data.limit), 'today is never included'),
    ),

    filters,

    data.rows.length
      ? h('div', data.rows.map((row) => personCard(row, data, reload)))
      : emptyState('Nothing outstanding',
        `Every day between ${fmtDay(data.from)} and ${fmtDay(data.limit)} has been signed off, `
        + 'or there was nothing on it to sign.'),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Today is never on this list. A shift that has not finished cannot be signed off, and '
      + 'charging an absence against somebody who is upstairs making a bed is the mistake that '
      + 'rule exists to prevent.'),
  );
}

function tile(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, String(value)),
    h('div.stat-sub', h('span', sub)),
  );
}

const ISSUE_PILL = { open: 'bad', absent: 'bad', under: 'bad', over: 'warn', late: 'warn', early: 'warn', noshift: 'warn' };

/**
 * One person, their outstanding days, and the two things that can be done.
 *
 * Nothing starts ticked. Signing a period off moves days against somebody's
 * leave, and a screen that arrives with every day already selected asks for one
 * press to do that — including for the three days nobody has looked at yet. The
 * tick is the reading, and it has to be given rather than taken away.
 *
 * The header tick still selects the lot in one press, so the ordinary week
 * where everything is fine costs two presses instead of one. That is the right
 * trade: the cheap case gets one extra press and the expensive case stops
 * happening by accident.
 */
function personCard(row, data, reload) {
  const chosen = new Set();
  const countLabel = h('strong');
  const signButton = h('button.btn.btn-primary', {
    onclick: () => sign(row, chosen, reload),
  }, 'Sign off');

  const refreshCount = () => {
    countLabel.textContent = chosen.size === 0
      ? 'nothing yet'
      : chosen.size === row.days.length
        ? `all ${row.days.length} days`
        : `${chosen.size} of ${row.days.length} days`;

    // The button says what it would do. "Sign off" against nothing ticked is a
    // press that can only produce a telling-off.
    signButton.disabled = chosen.size === 0;
    signButton.textContent = chosen.size
      ? `Sign off ${chosen.size} day${chosen.size === 1 ? '' : 's'}`
      : 'Sign off';
  };

  const rows = row.days.map((day) => h('tr',
    h('td',
      h('label.tickline', { style: { padding: 0 } },
        h('input', {
          type: 'checkbox',
          onchange: (e) => {
            if (e.target.checked) chosen.add(day.day); else chosen.delete(day.day);
            refreshCount();
          },
        }),
        h('span', fmtDay(day.day)))),
    h('td', day.shift || h('span.muted', 'no shift')),
    h('td', h('small.mono', `${day.in || '—'} → ${day.out || '—'}`)),
    h('td', h('span', day.label)),
    h('td', day.issues.length
      ? h('div.chip-row', day.issues.map((key) => {
        const issue = data.issues.find((i) => i.key === key);
        return h(`span.pill.${ISSUE_PILL[key] ?? ''}`, { title: issue?.detail ?? '' },
          issue?.label ?? key);
      }))
      : h('span.muted', '—')),

    // Where the wrong time is actually noticed. Somebody going down a week
    // deciding what to sign is reading exactly the rows a correction belongs
    // on, and sending them to another screen to make it is how the correction
    // stops happening.
    h('td', data.canFixTimes && (day.issues.length || day.pendingTimes)
      ? (day.pendingTimes
        ? h('span.pill.warn', {
          title: `${day.pendingTimes.actor} asked for ${day.pendingTimes.now_in || '—'} → `
            + `${day.pendingTimes.now_out || '—'}: ${day.pendingTimes.reason ?? ''}`,
        }, '⏳ waiting')
        : h('button.btn-sm', {
          title: 'Change the clock-in or clock-out',
          onclick: () => fixTimes(row.staff, day, reload),
        }, 'Times'))
      : null),
  ));
  refreshCount();

  return card(row.staff.name, {
    note: [row.staff.department, `${row.unsignedCount} outstanding`].filter(Boolean).join(' · '),
    wide: true,
    actions: h('div.btn-row',
      h('button.btn-sm', {
        onclick: () => navigate('att-staff', { id: row.staff.id, from: row.first, to: row.last }),
      }, 'Open their record'),
      row.query
        ? h('span.pill.warn', `Asked ${fmtDayShort(String(row.query.raised_at).slice(0, 10))}`)
        : h('button.btn-sm', { onclick: () => raise(row, chosen, reload) }, 'Ask an admin'),
      signButton,
    ),
  },
    row.issues.list.length
      ? h(`div.alert.${row.issues.blocking ? 'high' : 'warn'}`,
        h('span.alert-icon', row.issues.blocking ? '⛔' : '⚠️'),
        h('div',
          h('div.alert-title', row.issues.list.map((i) => `${i.count} ${i.label.toLowerCase()}`).join(', ')),
          h('div.alert-detail', row.issues.blocking
            ? 'Worth a second look before this is charged against anybody’s leave. Sign it anyway '
              + 'if you are satisfied, or ask an administrator first.'
            : 'Worth seeing, not worth holding the period up for.'),
        ))
      : null,

    row.query
      ? h('div.alert.info',
        h('span.alert-icon', '💬'),
        h('div',
          h('div.alert-title', `Asked about ${fmtDayShort(row.query.from_day)}–${fmtDayShort(row.query.to_day)}`),
          h('div.alert-detail', row.query.reason || ''),
        ),
        h('button.btn-sm', { onclick: () => navigate('signoff', { tab: 'queries' }) }, 'See it'))
      : null,

    h('div.table-wrap',
      h('table',
        h('thead', h('tr',
          h('th',
            h('label.tickline', { style: { padding: 0 }, title: 'Tick every day below' },
              h('input', {
                type: 'checkbox',
                onchange: (e) => {
                  const on = e.target.checked;
                  for (const box of e.target.closest('table').querySelectorAll('tbody input[type=checkbox]')) {
                    box.checked = on;
                    box.dispatchEvent(new Event('change'));
                  }
                },
              }),
              h('span', 'Day'))),
          h('th', 'Shift'), h('th', 'Clocked'), h('th', 'What happened'), h('th', 'Flags'),
          h('th', ''),
        )),
        h('tbody', rows))),

    h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
      'Signing ', countLabel,
      '. Tick the days you have looked at — anything left unticked stays on this list and can '
      + 'be dealt with on its own later.'),

    row.signedSpans.length
      ? h('details', { style: { marginTop: '.6rem' } },
        h('summary', { style: { cursor: 'pointer', fontSize: '.85rem' } },
          `${row.signedSpans.length} already signed`),
        h('ul', row.signedSpans.map((s) => h('li',
          h('small', `${fmtDayShort(s.from)} – ${fmtDayShort(s.to)} · ${s.by}`
            + (s.excluded ? ` · ${s.excluded} left out` : ''))))))
      : null,
  );
}

/**
 * Correct a clock time from the sign-off list.
 *
 * The day arrives here in the sign-off screen's own shape — a shift by name, a
 * bare `in` and `out` — rather than a full attendance record, which the shared
 * dialog is written to accept.
 */
async function fixTimes(staff, day, reload) {
  const done = await correctTimesDialog(day, staff, {
    approves: can('att_setup'),
    pending: day.pendingTimes,
  });
  if (!done) return;
  toast(done.pending
    ? 'Sent to an administrator. Nothing has changed on the day yet.'
    : 'Times corrected and the day settled.', 'good');
  await reload();
}

async function sign(row, chosen, reload) {
  if (!chosen.size) {
    toast('Nothing ticked, so nothing to sign.', 'bad');
    return;
  }

  const days = [...chosen].sort();

  const done = await formDialog({
    title: `Sign off ${row.staff.name}`,
    submitLabel: `Sign off ${days.length} day${days.length === 1 ? '' : 's'}`,
    body: h('div',
      h('p.muted',
        `${fmtDay(days[0], { withYear: true })} to ${fmtDay(days[days.length - 1], { withYear: true })}`
        + (days.length < row.days.length
          ? ` — ${row.days.length - days.length} day(s) left out and still outstanding.`
          : '.')),

      row.issues.blocking
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'You are signing over something'),
            h('div.alert-detail', row.issues.list.map((i) => `${i.count} ${i.label.toLowerCase()}`).join(', ')
              + '. That you knew is recorded with the sign-off.'),
          ))
        : null,

      // Offered to anybody who may sign off, including the rota planner. This
      // is the over-or-under for the period, not a leave balance — how many
      // days somebody has left is a different question and one the planner is
      // deliberately never shown.
      field('Days against their leave', h('input', {
        type: 'number', name: 'daysApplied', step: 1, min: -60, max: 60,
        value: String(row.difference ?? 0),
      }), `The figures make it ${row.difference ?? 0}. What actually moves is your call`),

      field('Note', h('input', {
        type: 'text', name: 'note', maxlength: 300,
        placeholder: 'Spoke to him — was at the clinic',
      })),
    ),
    onSubmit: async (form) => api.attSignDays({
      staffId: row.staff.id,
      days,
      daysApplied: Number(form.get('daysApplied')),
      note: form.get('note'),
    }),
  });

  if (done) {
    toast(`${done.signed} day${done.signed === 1 ? '' : 's'} signed off`
      + `${done.excluded ? `, ${done.excluded} left for later` : ''}.`, 'good');
    await reload();
  }
}

async function raise(row, chosen, reload) {
  const days = chosen.size ? [...chosen].sort() : row.days.map((d) => d.day);

  const done = await formDialog({
    title: `Ask an administrator about ${row.staff.name}`,
    submitLabel: 'Send it',
    body: h('div',
      h('p.muted', 'It goes to whoever settles days, with the dates and what the figures say. '
        + 'Nothing is signed off until somebody answers, and the days stay on your list.'),

      h('p', h('strong', `${days.length} day${days.length === 1 ? '' : 's'}: `),
        days.map((d) => fmtDayShort(d)).join(', ')),

      row.issues.list.length
        ? h('div.chip-row', { style: { marginBottom: '.6rem' } },
          row.issues.list.map((i) => h(`span.pill.${ISSUE_PILL[i.key] ?? ''}`,
            `${i.count} ${i.label.toLowerCase()}`)))
        : null,

      field('What is the question?', h('textarea', {
        name: 'reason', rows: 4, required: true, maxlength: 600,
        placeholder: 'Absent all day Thursday and nobody knows why. I would rather not charge '
          + 'his leave without somebody checking.',
      })),
    ),
    onSubmit: async (form) => api.attRaiseQuery({
      staffId: row.staff.id,
      days,
      reason: form.get('reason'),
      issues: row.issues.counts,
    }),
  });

  if (done) { toast('Sent. It is in the questions tab until somebody answers.', 'good'); await reload(); }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

const STATUS_PILL = { open: 'warn', answered: 'good', resolved: '', withdrawn: '' };
const STATUS_LABEL = {
  open: 'Waiting on an administrator',
  answered: 'Answered — back to you',
  resolved: 'Dealt with',
  withdrawn: 'Taken back',
};

/**
 * Everything anybody has asked about, in one place.
 *
 * The point of the tab. A question asked in a corridor is a question nobody can
 * find again; a question with the dates, the figures and the answer on it is a
 * record of a decision.
 */
async function queriesTab(reload) {
  const data = await api.attQueries('all');
  const live = data.rows.filter((q) => ['open', 'answered'].includes(q.status));
  const done = data.rows.filter((q) => !['open', 'answered'].includes(q.status));

  if (!data.rows.length) {
    return emptyState('Nothing to answer',
      'When somebody signing off is unsure about a period, they can send it here rather than '
      + 'sign it. It arrives with the dates and what the figures said.');
  }

  return h('div',
    live.length
      ? h('div', live.map((q) => queryCard(q, data, reload)))
      : emptyState('Nothing waiting', 'Everything asked has been dealt with.'),

    done.length
      ? card('Already dealt with', { note: `${done.length}`, wide: true },
        table([
          { key: 'staff', label: 'Who', format: (v) => v.name },
          {
            key: 'from',
            label: 'Period',
            format: (v, r) => h('small', `${fmtDayShort(v)} – ${fmtDayShort(r.to)}`),
          },
          { key: 'reason', label: 'Asked', format: (v) => h('small.muted', v) },
          {
            key: 'outcome',
            label: 'Outcome',
            format: (v) => h('span.pill', { }, { signed: 'Signed off', returned: 'Sent back', withdrawn: 'Taken back', no_action: 'Closed' }[v] ?? v),
          },
          {
            key: 'closedBy',
            label: 'By',
            format: (v, r) => h('small.muted', `${v || '—'}${r.closedAt ? ` · ${String(r.closedAt).slice(0, 10)}` : ''}`),
          },
        ], done, { empty: 'None.' }))
      : null,
  );
}

/**
 * The register of clock-time changes.
 *
 * Whoever builds the rota can put a wrong clock time right on their own, which
 * is the only way corrections actually get made — the person who knows what
 * time the kitchen closed is not usually the person who can approve leave. The
 * price of that is this page: every change, with what stood before it, who made
 * it and why, in one list somebody can read down.
 *
 * Sat beside the sign-off screen rather than buried in setup, because the
 * question it answers — "has anything on this period been touched?" — is asked
 * at exactly the moment somebody is about to sign it.
 */
async function timesTab(range, reload) {
  const { edits, pending, canApprove } = await api.attTimeEdits({
    from: range.from, to: range.to, limit: 400,
  });

  if (!edits.length && !pending.length) {
    return emptyState('Nothing changed',
      `No clock time was altered between ${fmtDay(range.from)} and ${fmtDay(range.to)}. `
      + 'When somebody asks for one, it waits here until you approve it.');
  }

  const moved = (observed, was, now) => {
    const from = was ?? observed;
    if (from === now) return h('span.muted', 'unchanged');
    if (!now) return h('span', h('s', from), ' ', h('span.muted', 'removed'));
    if (!from) return h('span', h('span.muted', '— → '), h('strong', now));
    return h('span', h('s', from), ' → ', h('strong', now));
  };

  // Louder where the correction contradicts something the terminal actually
  // recorded. Filling in a punch the device never saw is the ordinary case;
  // overwriting one it did see is the row worth stopping on.
  const contradicts = (e) => (e.now_in && e.observed_in && e.now_in !== e.observed_in)
    || (e.now_out && e.observed_out && e.now_out !== e.observed_out);

  const queue = pending.length
    ? card('Waiting for you', {
      note: `${pending.length}`,
      wide: true,
    }, h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        canApprove
          ? 'Nothing on these days has changed. Approving puts the times on and settles the day '
            + 'on whatever the rules make of them — you are not being asked to choose a status.'
          : 'These are waiting on an administrator. Until one answers, the days read exactly as '
            + 'the terminal left them.'),
      h('div.table-wrap', h('table',
        h('thead', h('tr',
          h('th', 'Day'), h('th', 'In'), h('th', 'Out'), h('th', 'Why'), h('th', 'Asked by'),
          canApprove ? h('th', '') : null,
        )),
        h('tbody', pending.map((e) => h('tr',
          h('td', h('div',
            h('div', fmtDayShort(e.day)),
            h('small.muted', e.staff_name))),
          h('td', moved(e.observed_in, e.was_in, e.now_in)),
          h('td', moved(e.observed_out, e.was_out, e.now_out)),
          h('td', h('small', e.reason || '—')),
          h('td', h('div',
            h('small', e.actor),
            h('br'),
            h('small.muted', String(e.at_utc || '').slice(0, 16).replace('T', ' ')))),
          canApprove
            ? h('td', h('div.btn-row',
              h('button.btn-sm.btn-primary', { onclick: () => decide(e, 'approve', reload) }, 'Approve'),
              h('button.btn-sm', { onclick: () => decide(e, 'reject', reload) }, 'Send back'),
            ))
            : null,
        ))),
      )),
    ))
    : null;

  if (!edits.length) return h('div', queue);

  return h('div', queue, card('Already applied', {
    note: `${edits.length} in this period`,
    wide: true,
  }, table([
    {
      key: 'day',
      label: 'Day',
      format: (v, r) => h('div',
        h('div', fmtDayShort(v)),
        h('small.muted', r.staff_name)),
    },
    { key: 'now_in', label: 'In', align: 'right', format: (v, r) => moved(r.observed_in, r.was_in, r.now_in) },
    { key: 'now_out', label: 'Out', align: 'right', format: (v, r) => moved(r.observed_out, r.was_out, r.now_out) },
    {
      key: 'reason',
      label: 'Why',
      format: (v, r) => h('div',
        h('div', v || h('span.muted', '—')),
        contradicts(r)
          ? h('small.pill.warn', 'overwrote what the terminal read')
          : null),
    },
    {
      key: 'actor',
      label: 'By',
      format: (v, r) => h('div',
        h('div', h('small', v)),
        h('small.muted', String(r.at_utc || '').slice(0, 16).replace('T', ' '))),
    },
    {
      key: 'status',
      label: '',
      format: (v, r) => (v === 'approved'
        ? h('small.muted', r.decided_by && r.decided_by !== r.actor ? `approved by ${r.decided_by}` : 'applied')
        : h('span.pill.warn', { title: r.decision_note ?? '' },
          v === 'rejected' ? 'sent back' : v === 'superseded' ? 'replaced' : v)),
    },
  ], edits, { empty: 'None.' })));
}

/**
 * Approve a correction, or send it back.
 *
 * Sending it back asks for a reason and will not take no answer, because "no"
 * on its own tells whoever asked nothing about what to do instead — and they
 * will simply ask again.
 */
async function decide(edit, decision, reload) {
  const done = await formDialog({
    title: decision === 'approve'
      ? `Approve: ${edit.staff_name}, ${fmtDay(edit.day, { withYear: true })}`
      : `Send back: ${edit.staff_name}, ${fmtDay(edit.day, { withYear: true })}`,
    submitLabel: decision === 'approve' ? 'Approve and settle the day' : 'Send it back',
    body: h('div',
      h('p.muted',
        `${edit.actor} asked for ${edit.now_in || '—'} → ${edit.now_out || '—'}`
        + `${edit.reason ? `: ${edit.reason}` : ''}`),
      h('p.muted', { style: { fontSize: '.85rem' } },
        `The terminal read ${edit.observed_in || 'nothing'} → ${edit.observed_out || 'nothing'}.`),

      field(decision === 'approve' ? 'Anything to add' : 'Why not', h('input', {
        type: 'text', name: 'note', maxlength: 500,
        required: decision !== 'approve',
        placeholder: decision === 'approve'
          ? 'Optional'
          : 'That was Kofi on the late shift — check the roster and ask again',
      }), decision === 'approve'
        ? 'Kept with the record'
        : 'Required. Whoever asked needs to know what to do instead'),

      decision === 'approve'
        ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'The times go on, the day is worked out again from them, and it is settled on that '
          + 'verdict under your name. The punches themselves are untouched.')
        : h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Nothing changes on the day. It stays exactly as the terminal left it, and whoever '
          + 'asked is told why.'),
    ),
    onSubmit: async (form) => api.attDecideTimeEdit(edit.id, {
      decision,
      note: form.get('note') || null,
    }),
  });

  if (done) { toast(decision === 'approve' ? 'Approved and settled.' : 'Sent back.', 'good'); await reload(); }
}

function queryCard(q, data, reload) {
  const mine = q.raisedBy === data.mine;

  return card(q.staff.name, {
    note: `${fmtDay(q.from, { withYear: true })} – ${fmtDay(q.to, { withYear: true })} · ${q.days.length} day(s)`,
    wide: true,
    actions: h('div.btn-row',
      h(`span.pill.${STATUS_PILL[q.status] ?? ''}`, STATUS_LABEL[q.status] ?? q.status),
      mine && q.status !== 'resolved'
        ? h('button.btn-sm', {
          onclick: async () => {
            if (!window.confirm('Take this question back? You worked it out yourself.')) return;
            await api.attWithdrawQuery(q.id);
            toast('Taken back.');
            await reload();
          },
        }, 'Take it back')
        : null,
      data.canDecide
        ? h('button.btn.btn-primary', { onclick: () => answer(q, reload) }, 'Answer it')
        : null,
    ),
  },
    q.issues && Object.keys(q.issues).length
      ? h('div.chip-row', { style: { marginBottom: '.6rem' } },
        Object.entries(q.issues).map(([key, n]) =>
          h(`span.pill.${ISSUE_PILL[key] ?? ''}`, `${n} ${key}`)))
      : null,

    h('div.thread', q.notes.map((note) => h('div.thread-note',
      h('div.thread-head',
        h('strong', note.author),
        h('small.muted', String(note.at_utc).slice(0, 16)),
        note.kind === 'direction' ? h('span.pill.good', 'direction') : null,
        note.kind === 'decision' ? h('span.pill', 'decision') : null,
      ),
      h('div', note.body),
    ))),

    h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
      `Raised by ${q.raisedBy} on ${fmtDay(String(q.raisedAt).slice(0, 10), { withYear: true })}. `
      + 'The days stay outstanding until this is settled.'),
  );
}

/**
 * Answer one, three ways.
 *
 * They are genuinely different things and the dialog does not pretend
 * otherwise: saying something is not the same as handing it back, and neither
 * is the same as dealing with it yourself.
 */
async function answer(q, reload) {
  const done = await formDialog({
    title: `${q.staff.name}, ${fmtDayShort(q.from)}–${fmtDayShort(q.to)}`,
    submitLabel: 'Send',
    body: h('div',
      field('What are you doing?', h('select', {
        name: 'action',
        onchange: (e) => {
          const box = e.target.closest('form').querySelector('[data-days]');
          if (box) box.style.display = e.target.value === 'sign' ? '' : 'none';
        },
      },
      h('option', { value: 'comment' }, 'Just saying something — leave it open'),
      h('option', { value: 'direction' }, 'Telling them what to do — hand it back'),
      h('option', { value: 'sign' }, 'Signing it off myself, now'),
      h('option', { value: 'close' }, 'Closing it — nothing needed'))),

      field('What to say', h('textarea', {
        name: 'body', rows: 4, maxlength: 800,
        placeholder: 'He was at the clinic — mark it sick leave, then sign it.',
      })),

      h('div', { 'data-days': '', style: { display: 'none' } },
        field('Days against their leave', h('input', {
          type: 'number', name: 'daysApplied', step: 1, min: -60, max: 60, value: '0',
        }))),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Handing it back puts it on their screen and rings their bell. Signing it off does it '
        + 'under your name, and closes the question.'),
    ),
    onSubmit: async (form) => api.attAnswerQuery(q.id, {
      action: form.get('action'),
      body: form.get('body'),
      daysApplied: Number(form.get('daysApplied') || 0),
    }),
  });

  if (done) { toast('Done.', 'good'); await reload(); }
}
