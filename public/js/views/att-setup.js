import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * Attendance setup.
 *
 * Six things, each done rarely and each with a way of going quietly wrong:
 * people (whose employee number must match the terminal exactly), shifts (which
 * decide what "late" means), what absences cost, public holidays, the terminals
 * themselves, and the handful of rules that apply to all of it.
 */

const TABS = [
  ['staff', 'Staff'],
  ['shifts', 'Shifts'],
  ['reasons', 'Absence reasons'],
  ['holidays', 'Public holidays'],
  ['devices', 'Terminals'],
  ['rules', 'Rules'],
];

export async function renderAttSetup(params) {
  const host = h('div');
  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'staff';

  const reload = async (next = tab) => {
    replaceParams('att-setup', { tab: next });
    mount(host, await renderAttSetup({ tab: next }));
  };

  const tabs = h('div.seg.seg-wrap', TABS.map(([key, label]) =>
    h('button', { class: tab === key ? 'active' : '', onclick: () => reload(key) }, label)));

  const body = await {
    staff: staffTab,
    shifts: shiftsTab,
    reasons: reasonsTab,
    holidays: holidaysTab,
    devices: devicesTab,
    rules: rulesTab,
  }[tab](reload);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Attendance setup'),
        h('div.sub', 'Set once, then left alone'),
      ),
    ),
    h('div.toolbar', tabs),
    body,
  );

  return host;
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

async function staffTab(reload) {
  const [{ staff }, { unknown }] = await Promise.all([api.attStaff(), api.attUnknown()]);

  const edit = async (existing) => {
    const done = await formDialog({
      title: existing ? `Edit ${existing.name}` : 'Add somebody',
      submitLabel: existing ? 'Save changes' : 'Add them',
      body: h('div',
        h('div.field-row',
          field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 120, value: existing?.name ?? '' })),
          field(
            'Employee number',
            h('input', { type: 'text', name: 'employeeNo', required: true, maxlength: 40, value: existing?.employee_no ?? '' }),
            'Exactly as it is on the terminal — this is what joins a face to a name',
          ),
        ),
        h('div.field-row',
          field('Department', h('input', { type: 'text', name: 'department', maxlength: 80, value: existing?.department ?? '' })),
          field('Job title', h('input', { type: 'text', name: 'jobTitle', maxlength: 80, value: existing?.job_title ?? '' })),
        ),
        h('div.field-row',
          field('Started', h('input', { type: 'date', name: 'hiredOn', value: existing?.hired_on ?? '' }), 'Leave earns from this date'),
          field('Left', h('input', { type: 'date', name: 'leftOn', value: existing?.left_on ?? '' }), 'They drop off the rota after this'),
        ),
        field(
          'Annual leave days',
          h('input', { type: 'number', name: 'leaveDays', min: 0, max: 365, step: 0.5, value: existing?.leave_days ?? '' }),
          'Leave blank to use the property default',
        ),
        existing
          ? field('Status', h('select', { name: 'active' },
            h('option', { value: 'true', selected: !!existing.active }, 'Active'),
            h('option', { value: 'false', selected: !existing.active }, 'Not active'),
          ))
          : null,
        field('Note', h('input', { type: 'text', name: 'note', maxlength: 300, value: existing?.note ?? '' })),
      ),
      onSubmit: async (form) => {
        const payload = {
          name: form.get('name'),
          employeeNo: form.get('employeeNo'),
          department: form.get('department') || null,
          jobTitle: form.get('jobTitle') || null,
          hiredOn: form.get('hiredOn') || null,
          leftOn: form.get('leftOn') || null,
          leaveDays: form.get('leaveDays') || null,
          note: form.get('note') || null,
          active: form.get('active') !== 'false',
        };
        return existing ? api.attUpdateStaff(existing.id, payload) : api.attCreateStaff(payload);
      },
    });

    if (done) {
      if (done.claimedPunches) {
        toast(`Added — and ${done.claimedPunches} punch${done.claimedPunches === 1 ? '' : 'es'} already held for that number have been attached.`, 'good');
      } else {
        toast('Saved.', 'good');
      }
      await reload();
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Remove ${row.name}?`)) return;
    try {
      await api.attDeleteStaff(row.id);
      toast('Removed.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return h('div',
    // The single most useful diagnostic here: somebody enrolled on the terminal
    // and never added, whose punches are piling up unattached and who is
    // invisible in every report until this is dealt with.
    unknown.length
      ? card('The terminal is sending numbers nobody here recognises', {
        note: 'Their punches are being kept and will attach as soon as you add them',
        wide: true,
      },
        table([
          { key: 'employee_no', label: 'Employee number', format: (v) => h('strong', v) },
          { key: 'punches', label: 'Punches', align: 'right' },
          { key: 'first_seen', label: 'First seen', format: (v) => fmtDay(v) },
          { key: 'last_seen', label: 'Last seen', format: (v) => fmtDay(v) },
          {
            key: 'add',
            label: '',
            format: (v, r) => h('button.btn-sm.btn-primary', {
              onclick: () => edit({ employee_no: r.employee_no, name: '', active: 1 }),
            }, 'Add this person'),
          },
        ], unknown))
      : null,

    card('Staff', {
      note: `${staff.filter((s) => s.active).length} active`,
      actions: h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add somebody'),
      wide: true,
    },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('div',
            h('div', v, r.active ? null : h('span.pill', { style: { marginLeft: '.4rem' } }, 'inactive')),
            h('small.muted', [r.job_title, r.department].filter(Boolean).join(' · ') || '—'),
          ),
        },
        { key: 'employee_no', label: 'Employee no', format: (v) => h('code', v) },
        { key: 'hired_on', label: 'Started', format: (v) => (v ? fmtDay(v) : h('span.muted', '—')) },
        { key: 'left_on', label: 'Left', format: (v) => (v ? fmtDay(v) : h('span.muted', '—')) },
        { key: 'leave_days', label: 'Leave', align: 'right', format: (v) => (v == null ? h('span.muted', 'default') : fmtNum(v, 1)) },
        { key: 'punch_count', label: 'Punches', align: 'right', format: (v) => fmtNum(v, 0) },
        { key: 'last_seen', label: 'Last seen', format: (v) => (v ? fmtDay(v) : h('span.muted', 'never')) },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
            r.punch_count ? null : h('button.btn-sm', { onclick: () => remove(r) }, 'Remove'),
          ),
        },
      ], staff, {
        rowClass: (r) => (r.active ? '' : 'row-muted'),
        empty: 'Nobody set up yet.',
      })),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Somebody who has left keeps their history — set a leaving date rather than removing them, or the '
      + 'months you have already reported on go with them.'),
  );
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

async function shiftsTab(reload) {
  const { shifts } = await api.attShifts();

  const edit = async (existing) => {
    const done = await formDialog({
      title: existing ? `Edit ${existing.name}` : 'Add a shift',
      submitLabel: existing ? 'Save changes' : 'Add the shift',
      body: h('div',
        field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 60, value: existing?.name ?? '', placeholder: 'Morning' })),
        h('div.field-row',
          field('Starts', h('input', { type: 'time', name: 'startsAt', required: true, value: existing?.starts_at ?? '06:00' })),
          field('Ends', h('input', { type: 'time', name: 'endsAt', required: true, value: existing?.ends_at ?? '14:00' }), 'Before the start means it runs overnight'),
          field('Unpaid break', h('input', { type: 'number', name: 'breakMinutes', min: 0, max: 480, value: existing?.break_minutes ?? 0 }), 'minutes'),
        ),
        h('div.field-row',
          field('Grace before late', h('input', { type: 'number', name: 'graceIn', min: 0, max: 120, value: existing?.grace_in_minutes ?? 5 }), 'minutes'),
          field('Grace before early', h('input', { type: 'number', name: 'graceOut', min: 0, max: 120, value: existing?.grace_out_minutes ?? 5 }), 'minutes'),
          field('Overtime after', h('input', { type: 'number', name: 'overtimeAfter', min: 0, max: 480, value: existing?.overtime_after ?? 0 }), 'minutes past the end'),
        ),
        h('div.field-row',
          field('Half day at', h('input', { type: 'number', name: 'halfDayMinutes', min: 0, max: 1440, value: existing?.half_day_minutes ?? 240 }), 'minutes worked'),
          field('Full day at', h('input', { type: 'number', name: 'fullDayMinutes', min: 0, max: 1440, value: existing?.full_day_minutes ?? 420 }), 'minutes worked'),
        ),
        existing
          ? field('Status', h('select', { name: 'active' },
            h('option', { value: 'true', selected: !!existing.active }, 'In use'),
            h('option', { value: 'false', selected: !existing.active }, 'Retired'),
          ))
          : null,
        h('p.muted', { style: { fontSize: '.82rem' } },
          'Changing the times rewrites history: every day already recorded against this shift is worked out '
          + 'again, and somebody who was on time last week may not be afterwards.'),
      ),
      onSubmit: async (form) => {
        const payload = Object.fromEntries(form.entries());
        payload.active = form.get('active') !== 'false';
        return existing ? api.attUpdateShift(existing.id, payload) : api.attCreateShift(payload);
      },
    });

    if (done) {
      toast(done.recomputed ? `Saved — ${done.recomputed} days worked out again.` : 'Saved.', 'good');
      await reload();
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete the ${row.name} shift?`)) return;
    try {
      await api.attDeleteShift(row.id);
      toast('Deleted.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return h('div',
    card('Shifts', {
      note: 'A shift is what "late" is measured against',
      actions: h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add a shift'),
      wide: true,
    },
      table([
        { key: 'name', label: 'Name', format: (v, r) => h('div', h('div', v), r.active ? null : h('small.muted', 'retired')) },
        {
          key: 'starts_at',
          label: 'Hours',
          format: (v, r) => h('div',
            h('div', `${v} – ${r.ends_at}`),
            r.ends_at <= v ? h('small.muted', 'overnight') : null,
          ),
        },
        { key: 'break_minutes', label: 'Break', align: 'right', format: (v) => (v ? `${v} min` : h('span.muted', 'none')) },
        { key: 'grace_in_minutes', label: 'Grace in', align: 'right', format: (v) => `${v} min` },
        { key: 'grace_out_minutes', label: 'Grace out', align: 'right', format: (v) => `${v} min` },
        { key: 'half_day_minutes', label: 'Half day', align: 'right', format: (v) => `${fmtNum(v / 60, 1)} h` },
        { key: 'full_day_minutes', label: 'Full day', align: 'right', format: (v) => `${fmtNum(v / 60, 1)} h` },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
            h('button.btn-sm', { onclick: () => remove(r) }, 'Delete'),
          ),
        },
      ], shifts, {
        rowClass: (r) => (r.active ? '' : 'row-muted'),
        empty: 'No shifts yet. Add the ones your rota actually uses — usually two or three.',
      })),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'If you already set shifts up on the terminal or in Hik-Connect, mirror them here. The terminal '
      + 'decides what it shows the person at the door; these decide what the reports say.'),
  );
}

// ---------------------------------------------------------------------------
// What absences mean
// ---------------------------------------------------------------------------

const KINDS = [
  ['worked', 'Counts as being at work'],
  ['leave', 'Leave'],
  ['absent', 'Absence'],
  ['holiday', 'Public holiday'],
  ['rest', 'Rest day'],
];

async function reasonsTab(reload) {
  const { reasons } = await api.attReasons();

  const edit = async (existing) => {
    const done = await formDialog({
      title: existing ? `Edit "${existing.label}"` : 'Add a reason',
      submitLabel: 'Save',
      body: h('div',
        h('div.field-row',
          field('Label', h('input', { type: 'text', name: 'label', required: true, maxlength: 80, value: existing?.label ?? '' })),
          existing
            ? null
            : field('Code', h('input', { type: 'text', name: 'code', required: true, maxlength: 40, placeholder: 'study_leave' }), 'Used internally; letters and underscores'),
        ),
        field('Kind', h('select', { name: 'kind', required: true, disabled: Boolean(existing?.system) },
          KINDS.map(([value, label]) => h('option', { value, selected: existing?.kind === value }, label))),
        existing?.system ? 'Built in — the kind cannot change, but everything below can' : 'What the system does with a day charged to this'),
        h('div.field-row',
          field('Paid', h('select', { name: 'paid' },
            h('option', { value: 'true', selected: !!existing?.paid }, 'Yes'),
            h('option', { value: 'false', selected: !existing?.paid }, 'No'),
          )),
          field('Counts as a day worked', h('select', { name: 'countsAsWorked' },
            h('option', { value: 'false', selected: !existing?.counts_as_worked }, 'No'),
            h('option', { value: 'true', selected: !!existing?.counts_as_worked }, 'Yes'),
          )),
          field('Comes off annual leave', h('select', { name: 'deductsLeave' },
            h('option', { value: 'false', selected: !existing?.deducts_leave }, 'No'),
            h('option', { value: 'true', selected: !!existing?.deducts_leave }, 'Yes'),
          )),
        ),
        h('div.field-row',
          field('Colour', h('select', { name: 'colour' },
            ['green', 'amber', 'red', 'grey'].map((c) =>
              h('option', { value: c, selected: (existing?.colour ?? 'grey') === c }, c)))),
          field('Needs a note', h('select', { name: 'requiresNote' },
            h('option', { value: 'false', selected: !existing?.requires_note }, 'No'),
            h('option', { value: 'true', selected: !!existing?.requires_note }, 'Yes'),
          )),
          field('Order', h('input', { type: 'number', name: 'sortOrder', min: 0, max: 9999, value: existing?.sort_order ?? 100 })),
        ),
        h('p.muted', { style: { fontSize: '.82rem' } },
          'Paid and counts-as-worked are different questions. Paid annual leave is paid but is not a day '
          + 'worked; a day at a training course is both.'),
      ),
      onSubmit: async (form) => {
        const payload = {
          label: form.get('label'),
          kind: form.get('kind') || existing?.kind,
          paid: form.get('paid') === 'true',
          countsAsWorked: form.get('countsAsWorked') === 'true',
          deductsLeave: form.get('deductsLeave') === 'true',
          colour: form.get('colour'),
          requiresNote: form.get('requiresNote') === 'true',
          sortOrder: Number(form.get('sortOrder')),
          selectable: true,
          active: true,
        };
        return existing
          ? api.attUpdateReason(existing.code, payload)
          : api.attCreateReason({ ...payload, code: form.get('code') });
      },
    });

    if (done) { toast('Saved.', 'good'); await reload(); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete "${row.label}"?`)) return;
    try {
      await api.attDeleteReason(row.code);
      toast('Deleted.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const yesNo = (v) => (v ? h('span.pill.good', 'Yes') : h('span.pill', 'No'));

  return h('div',
    card('What each kind of day means', {
      note: 'Decide for yourself what an absence costs',
      actions: h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add a reason'),
      wide: true,
    },
      table([
        {
          key: 'label',
          label: 'Reason',
          format: (v, r) => h('div',
            h('div', v, r.system ? h('small.muted', ' · built in') : null),
            h('small.muted', KINDS.find(([k]) => k === r.kind)?.[1] ?? r.kind),
          ),
        },
        { key: 'paid', label: 'Paid', format: yesNo },
        { key: 'counts_as_worked', label: 'Day worked', format: yesNo },
        { key: 'deducts_leave', label: 'Off annual leave', format: yesNo },
        { key: 'requires_note', label: 'Needs a note', format: yesNo },
        { key: 'colour', label: 'Colour', format: (v) => h(`span.pill${v === 'green' ? '.good' : v === 'red' ? '.bad' : v === 'amber' ? '.warn' : ''}`, v) },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
            r.system ? null : h('button.btn-sm', { onclick: () => remove(r) }, 'Delete'),
          ),
        },
      ], reasons)),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Changing these changes every report that has ever used them, which is the point. The change is '
      + 'written to the audit trail with the old values beside the new.'),
  );
}

// ---------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------

async function holidaysTab(reload) {
  const year = Number(todayISO().slice(0, 4));
  const { holidays } = await api.attHolidays(year);

  const generate = async () => {
    try {
      const result = await api.attGenerateHolidays(year);
      toast(`${year} filled in. Add ${result.missing.join(' and ')} when they are announced.`, 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const add = async () => {
    const done = await formDialog({
      title: 'Add a public holiday',
      submitLabel: 'Add it',
      body: h('div',
        field('Date', h('input', { type: 'date', name: 'day', required: true })),
        field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 120, placeholder: 'Eid al-Fitr' })),
        field('Observed on', h('input', { type: 'date', name: 'observedOn' }),
          'Only if the day off is not the date itself — a Saturday holiday taken on the Monday'),
      ),
      onSubmit: async (form) => api.attCreateHoliday({
        day: form.get('day'),
        name: form.get('name'),
        observedOn: form.get('observedOn') || null,
      }),
    });
    if (done) { toast('Added.', 'good'); await reload(); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Remove ${row.name}?`)) return;
    await api.attDeleteHoliday(row.id);
    toast('Removed.');
    await reload();
  };

  return h('div',
    card(`Public holidays ${year}`, {
      note: 'Nobody is marked absent on one of these',
      actions: h('div.btn-row',
        h('button.btn-sm', { onclick: generate }, `Fill in ${year}`),
        h('button.btn.btn-primary', { onclick: add }, '+ Add one'),
      ),
      wide: true,
    },
      table([
        { key: 'day', label: 'Date', format: (v) => fmtDay(v, { withYear: true }) },
        { key: 'name', label: 'Holiday' },
        {
          key: 'observed_on',
          label: 'Taken on',
          format: (v) => (v ? h('span', { style: { color: 'var(--warn)' } }, fmtDay(v)) : h('span.muted', 'the day itself')),
        },
        { key: 'paid', label: 'Paid', format: (v) => (v ? h('span.pill.good', 'Paid') : h('span.pill', 'Unpaid')) },
        { key: 'actions', label: '', format: (v, r) => h('button.btn-sm', { onclick: () => remove(r) }, 'Remove') },
      ], holidays, {
        empty: `Nothing set for ${year}. "Fill in ${year}" adds everything Ghana's calendar can work out.`,
      })),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Filling in a year adds the fixed dates, Good Friday and Easter Monday, and Farmers\' Day as the '
      + 'first Friday in December, moving any that fall at a weekend to the following Monday. Eid al-Fitr '
      + 'and Eid al-Adha follow the moon and are announced locally, so they are left for you to add — a '
      + 'computed guess that lands in a payroll is worse than a blank.'),
  );
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

async function devicesTab(reload) {
  const { devices } = await api.attDevices();

  const showToken = (serial, token) => formDialog({
    title: 'The terminal\'s token',
    submitLabel: 'I have copied it',
    body: h('div',
      h('p', 'This is the only time this token is readable. Put it in the poller\'s configuration now.'),
      h('pre', {
        style: {
          background: 'var(--surface-2)', padding: '.8rem', borderRadius: 'var(--radius-sm)',
          fontSize: '.8rem', overflowX: 'auto', userSelect: 'all',
        },
      }, JSON.stringify({ device: serial, token }, null, 2)),
      h('p.muted', { style: { fontSize: '.82rem' } },
        'Paste it into .hik-poller.json on the machine that runs the poller. If you lose it, issue a new '
        + 'one here — the old one stops working the moment you do.'),
    ),
    onSubmit: async () => true,
  });

  const add = async () => {
    const done = await formDialog({
      title: 'Register a terminal',
      submitLabel: 'Register it',
      body: h('div',
        field('Serial number', h('input', { type: 'text', name: 'serial', required: true, maxlength: 120 }),
          'Exactly as the device reports it — the poller checks and will warn you if they differ'),
        field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 80, placeholder: 'Staff entrance' })),
        h('div.field-row',
          field('Location', h('input', { type: 'text', name: 'location', maxlength: 120 })),
          field('Model', h('input', { type: 'text', name: 'model', maxlength: 80, placeholder: 'DS-K1T321MFWX' })),
        ),
      ),
      onSubmit: async (form) => api.attCreateDevice(Object.fromEntries(form.entries())),
    });

    if (done) {
      await showToken(done.serial, done.token);
      await reload();
    }
  };

  const rotate = async (row) => {
    if (!window.confirm(`Issue a new token for ${row.name}?\n\nThe poller will stop sending until you update its configuration.`)) return;
    const result = await api.attRotateToken(row.id);
    await showToken(result.serial, result.token);
    await reload();
  };

  const remove = async (row) => {
    if (!window.confirm(`Remove ${row.name}?`)) return;
    try {
      await api.attDeleteDevice(row.id);
      toast('Removed.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return h('div',
    card('Terminals', {
      note: 'Each one carries its own token, and can only add punches under its own serial',
      actions: h('button.btn.btn-primary', { onclick: add }, '+ Register a terminal'),
      wide: true,
    },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('div', h('div', v), h('small.muted', r.location || r.model || '—')),
        },
        { key: 'serial', label: 'Serial', format: (v) => h('code', { style: { fontSize: '.78rem' } }, v) },
        {
          key: 'last_seen_at',
          label: 'Last heard from',
          format: (v) => (v ? staleness(v) : h('span.pill.bad', 'never')),
        },
        {
          key: 'last_event_at',
          label: 'Last punch',
          format: (v) => (v ? h('small', v.slice(0, 16)) : h('span.muted', 'none yet')),
        },
        { key: 'punches', label: 'Punches', align: 'right', format: (v) => fmtNum(v, 0) },
        { key: 'has_token', label: 'Token', format: (v) => (v ? h('span.pill.good', 'set') : h('span.pill.bad', 'missing')) },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', { onclick: () => rotate(r) }, 'New token'),
            r.punches ? null : h('button.btn-sm', { onclick: () => remove(r) }, 'Remove'),
          ),
        },
      ], devices, {
        empty: 'No terminals registered. Register one, copy its token, and point the poller at it.',
      })),

    card('How the punches get here', { wide: true },
      h('ol', { style: { lineHeight: 1.7, paddingLeft: '1.2rem' } },
        h('li', 'Register the terminal above and copy the token it shows you.'),
        h('li', h('span', 'On any always-on machine on the same network as the terminal, copy ',
          h('code', '.hik-poller.json.example'), ' to ', h('code', '.hik-poller.json'), ' and fill it in.')),
        h('li', h('span', 'Try it once: ', h('code', 'node scripts/hik-poller.mjs --once --verbose'))),
        h('li', h('span', 'Backfill your history: ', h('code', 'node scripts/hik-poller.mjs --from 2026-01-01'))),
        h('li', h('span', 'Then leave it running: ', h('code', 'node scripts/hik-poller.mjs'))),
      ),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'The poller reads the terminal over its local network and posts here. It has to run on site '
        + 'because this app runs in the cloud and cannot reach a device on your LAN — and putting an '
        + 'access-control terminal on the open internet is not worth the convenience.'),
    ),
  );
}

/** How long since the poller last said anything, coloured by whether to worry. */
function staleness(stamp) {
  const then = new Date(`${stamp.replace(' ', 'T')}Z`);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return h('span.muted', stamp);
  if (minutes < 15) return h('span.pill.good', 'just now');
  if (minutes < 120) return h('span.pill.good', `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return h('span.pill.warn', `${hours} hr ago`);
  return h('span.pill.bad', `${Math.round(hours / 24)} days ago`);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

async function rulesTab(reload) {
  const data = await api.attBootstrap();
  const s = data.settings;

  const form = h('form.att-rules');
  const save = async (event) => {
    event.preventDefault();
    try {
      const result = await api.attUpdateSettings(Object.fromEntries(new FormData(form).entries()));
      toast(result.recomputed
        ? `Saved — ${result.recomputed} days worked out again.`
        : 'Saved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  form.addEventListener('submit', save);

  form.append(
    h('div.grid.grid-2',
      card('When a punch is missing', { note: 'The decision that matters most' },
        h('label.field',
          h('span', 'A day with only one of the two taps'),
          h('select', { name: 'att_missing_punch' },
            h('option', { value: 'incomplete', selected: s.att_missing_punch === 'incomplete' },
              'Hold it for a supervisor to confirm'),
            h('option', { value: 'absent', selected: s.att_missing_punch === 'absent' },
              'Mark it absent, as the terminal does'),
            h('option', { value: 'auto_close', selected: s.att_missing_punch === 'auto_close' },
              'Credit the scheduled shift and flag it'),
          ),
        ),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'The terminal marks these absent because it has no way to ask anybody. Holding them costs '
          + 'somebody a minute each morning and stops the system quietly refusing to pay for shifts '
          + 'that were actually worked.'),
      ),

      card('Annual leave', { note: 'Labour Act 2003 defaults' },
        h('div.field-row',
          h('label.field', h('span', 'Days a year'),
            h('input', { type: 'number', name: 'att_leave_days', min: 0, max: 365, step: 0.5, value: s.att_leave_days ?? 15 })),
          h('label.field', h('span', 'Qualifying service (months)'),
            h('input', { type: 'number', name: 'att_leave_qualify_months', min: 0, max: 60, value: s.att_leave_qualify_months ?? 12 })),
        ),
        h('div.field-row',
          h('label.field', h('span', 'Carried over'),
            h('input', { type: 'number', name: 'att_leave_carryover_days', min: 0, max: 365, step: 0.5, value: s.att_leave_carryover_days ?? 0 })),
          h('label.field', h('span', 'Leave year starts'),
            h('input', { type: 'text', name: 'att_leave_year_starts', pattern: '\\d{2}-\\d{2}', value: s.att_leave_year_starts ?? '01-01', placeholder: '01-01' })),
        ),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'Fifteen working days after twelve months is the statutory floor. A property may be more '
          + 'generous, and one person can be given their own figure on their record.'),
      ),

      card('Reading the terminal', { note: 'Rarely worth changing' },
        h('div.field-row',
          h('label.field', h('span', 'Ignore repeat taps within'),
            h('input', { type: 'number', name: 'att_min_gap_minutes', min: 0, max: 120, value: s.att_min_gap_minutes ?? 2 })),
          h('label.field', h('span', 'Claim punches from (min before)'),
            h('input', { type: 'number', name: 'att_window_before', min: 0, max: 720, value: s.att_window_before ?? 180 })),
          h('label.field', h('span', 'and after (min)'),
            h('input', { type: 'number', name: 'att_window_after', min: 0, max: 720, value: s.att_window_after ?? 240 })),
        ),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'The window decides which shift a punch belongs to. Wide enough for somebody who arrives an '
          + 'hour early, narrow enough that a night shift\'s clock-out is not claimed by the morning.'),
      ),

      card('Chasing', {},
        h('label.field', h('span', 'Raise the alarm after this many absences in a row'),
          h('input', { type: 'number', name: 'att_escalate_after', min: 1, max: 30, value: s.att_escalate_after ?? 3 })),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'Changes the tone of the note the person receives, and rings the bell for anybody who can '
          + 'manage the rota.'),
      ),
    ),
    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn.btn-primary', { type: 'submit' }, 'Save the rules'),
    ),
  );

  return h('div',
    form,
    card('Rebuild', { note: 'Should never be necessary', wide: true },
      h('p.muted',
        'Everything that changes a verdict works the affected days out again on its own. This is here '
        + 'for the first run after importing a year of history, and for the day something goes wrong anyway.'),
      h('button.btn-sm', {
        onclick: async () => {
          const from = window.prompt('Rebuild from which date? (YYYY-MM-DD)', todayISO().slice(0, 8) + '01');
          if (!from) return;
          try {
            const result = await api.attRecompute({ from, to: todayISO() });
            toast(`${result.days} days worked out again.`, 'good');
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      }, 'Work the days out again'),
    ),
    !data.staff.length
      ? emptyState('Nothing set up yet', 'Start with Staff — everything else hangs off who is on the list.')
      : null,
  );
}
