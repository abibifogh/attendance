import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { SHIFT_COLOURS, field, formDialog, shiftColour } from './att-shared.js';

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

const NEW_DEPARTMENT = '__new__';

/**
 * Pick a department, or name one that does not exist yet.
 *
 * A plain dropdown would be a trap the first time somebody opens a spa, and a
 * plain text box is what let "Kitchen" and "kitchen" become two departments in
 * the monthly figures. So: a list, with a way out of it.
 *
 * Whatever the person already has is always among the options even if it has
 * been dropped from the configured list, because editing somebody's start date
 * must not silently reassign their department.
 */
function departmentPicker(departments, current) {
  const options = [...departments];
  if (current && !options.some((d) => d.toLowerCase() === current.toLowerCase())) {
    options.unshift(current);
  }

  const typed = h('input', {
    type: 'text',
    name: 'departmentNew',
    maxlength: 80,
    placeholder: 'Name the new department',
    style: { display: 'none', marginTop: '.4rem' },
  });

  const select = h('select', {
    name: 'departmentPick',
    onchange: (e) => {
      const adding = e.target.value === NEW_DEPARTMENT;
      typed.style.display = adding ? '' : 'none';
      if (adding) typed.focus();
    },
  },
  h('option', { value: '', selected: !current }, 'No department'),
  options.map((name) => h('option', { value: name, selected: name === current }, name)),
  h('option', { value: NEW_DEPARTMENT }, '+ New department…'));

  return h('div', select, typed);
}

async function staffTab(reload) {
  const [{ staff, departments = [] }, { unknown }] = await Promise.all([
    api.attStaff(), api.attUnknown(),
  ]);

  /**
   * Add somebody, edit somebody, or add somebody the terminal already knows.
   *
   * The third case is why this reads `existing?.id` rather than `existing`. A
   * row from the "numbers nobody recognises" list arrives here as a *prefill* —
   * an employee number and nothing else — and it has no id, because there is no
   * record yet. Deciding add-or-update on whether the object exists sent those
   * to the update endpoint with an id of `undefined`, which came back as "No
   * such member of staff" on the commonest path there is: the terminal has been
   * sending a number for a week, and somebody presses Add this person.
   */
  const edit = async (existing) => {
    const isEdit = Boolean(existing?.id);

    const done = await formDialog({
      title: isEdit ? `Edit ${existing.name}` : 'Add somebody',
      submitLabel: isEdit ? 'Save changes' : 'Add them',
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
          field('Department', departmentPicker(departments, existing?.department ?? '')),
          field('Job title', h('input', { type: 'text', name: 'jobTitle', maxlength: 80, value: existing?.job_title ?? '' })),
        ),
        h('div.field-row',
          field('Started', h('input', { type: 'date', name: 'hiredOn', value: existing?.hired_on ?? '' }), 'Leave earns from this date'),
          field('Left', h('input', { type: 'date', name: 'leftOn', value: existing?.left_on ?? '' }), 'They drop off the rota after this'),
        ),
        h('div.field-row',
          field(
            'Annual leave days',
            h('input', { type: 'number', name: 'leaveDays', min: 0, max: 365, step: 0.5, value: existing?.leave_days ?? '' }),
            'Leave blank to use the property default',
          ),
          // What this person's week is worth. It decides what their month's
          // over-or-under is measured against, so somebody on six shorter days
          // is not permanently over and somebody on four long ones is not
          // permanently under for doing exactly what their contract says.
          field(
            'Days a week',
            h('input', { type: 'number', name: 'daysPerWeek', min: 0.5, max: 7, step: 0.5, value: existing?.days_per_week ?? '' }),
            'What the month expects of them. Blank uses the property default',
          ),
        ),
        isEdit
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
          department: form.get('departmentPick') === NEW_DEPARTMENT
            ? (form.get('departmentNew') || '').trim() || null
            : form.get('departmentPick') || null,
          jobTitle: form.get('jobTitle') || null,
          hiredOn: form.get('hiredOn') || null,
          leftOn: form.get('leftOn') || null,
          leaveDays: form.get('leaveDays') || null,
          daysPerWeek: form.get('daysPerWeek') || null,
          note: form.get('note') || null,
          active: form.get('active') !== 'false',
        };
        return isEdit ? api.attUpdateStaff(existing.id, payload) : api.attCreateStaff(payload);
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
  const [{ shifts, departments = [] }, suggested] = await Promise.all([
    api.attShifts(),
    api.attShiftSuggestions().catch(() => null),
  ]);

  const edit = async (existing) => {
    const done = await formDialog({
      title: existing ? `Edit ${existing.name}` : 'Add a shift',
      submitLabel: existing ? 'Save changes' : 'Add the shift',
      body: h('div',
        h('div.field-row',
          field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 60, value: existing?.name ?? '', placeholder: 'Morning' })),
          field('Department', departmentPicker(departments, existing?.department ?? ''),
            'Groups the shift list and the reports'),
        ),
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
        // Chosen for the shift already, from its id, so a property with
        // twenty-four shifts is not a colouring exercise before the rota
        // becomes readable. This is only for when the automatic one puts two
        // shifts somebody cares about next to each other in the same colour.
        field('Colour on the rota', h('select', { name: 'colour' },
          h('option', { value: '', selected: !existing?.colour },
            `Chosen for it${existing ? ` (${shiftColour(existing)})` : ''}`),
          ...Array.from({ length: SHIFT_COLOURS }, (unused, i) => h('option', {
            value: String(i + 1), selected: String(existing?.colour ?? '') === String(i + 1),
          }, `Colour ${i + 1}`)))),

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
        payload.colour = form.get('colour') || null;
        payload.department = form.get('departmentPick') === NEW_DEPARTMENT
          ? (form.get('departmentNew') || '').trim() || null
          : form.get('departmentPick') || null;
        return existing ? api.attUpdateShift(existing.id, payload) : api.attCreateShift(payload);
      },
    });

    if (done) {
      toast(done.recomputed ? `Saved — ${done.recomputed} days worked out again.` : 'Saved.', 'good');
      await reload();
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete the ${row.name} shift?\n\n`
      + 'Nothing has ever used it, so there is nothing to lose.')) return;
    try {
      await api.attDeleteShift(row.id);
      toast('Deleted.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  /**
   * Retire a shift, or bring one back.
   *
   * The ordinary end of a shift's life. It stops being offered anywhere
   * somebody picks a shift, and every day already measured against it keeps
   * meaning what it meant.
   */
  const retire = async (row, retired) => {
    const used = Number(row.used_days ?? 0);
    if (retired && !window.confirm(
      `Retire the ${row.name} shift?\n\n`
      + 'It comes off the rota and off every list anybody picks from. '
      + `${used ? `The ${used} day${used === 1 ? '' : 's'} already recorded against it are untouched.`
        : 'Nothing already recorded changes.'}\n\n`
      + 'You can bring it back at any time.',
    )) return;

    try {
      await api.attUpdateShift(row.id, {
        name: row.name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        breakMinutes: row.break_minutes,
        graceInMinutes: row.grace_in_minutes,
        graceOutMinutes: row.grace_out_minutes,
        halfDayMinutes: row.half_day_minutes,
        fullDayMinutes: row.full_day_minutes,
        overtimeAfter: row.overtime_after,
        department: row.department || null,
        active: !retired,
      });
      toast(retired ? 'Retired. It is off the rota.' : 'Back in use.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const inUse = shifts.filter((s) => s.active);
  const retired = shifts.filter((s) => !s.active);

  return h('div',
    suggestionsCard(suggested, reload),

    card('Shifts', {
      note: 'A shift is what "late" is measured against',
      actions: h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add a shift'),
      wide: true,
    },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('div.shift-key-item',
            h('span.shift-key-swatch', { style: { '--shift': `var(--c${shiftColour(r)})` } }),
            h('span', v)),
        },
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
          // Delete only where there is genuinely nothing to lose. Everywhere
          // else the honest offer is Retire, and offering Delete anyway just
          // to refuse it afterwards teaches people the buttons are guesses.
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
            r.active
              ? h('button.btn-sm', { onclick: () => retire(r, true) }, 'Retire')
              : h('button.btn-sm', { onclick: () => retire(r, false) }, 'Bring back'),
            r.deletable
              ? h('button.btn-sm.btn-danger', { onclick: () => remove(r) }, 'Delete')
              : null,
          ),
        },
      ], inUse, {
        empty: 'No shifts yet. Add the ones your rota actually uses — usually two or three.',
        // Banded by department, which is also how the rota offers them. Two
        // dozen shifts read as one intimidating list and as five ordinary ones,
        // and the difference is entirely the headings.
        groupBy: (r) => r.department || null,
        groupNoun: ['shift', 'shifts'],
      })),

    // Folded away rather than mixed in. A retired shift is not one of the
    // property's shifts any more — it is a thing the history refers to — and
    // leaving it in the list means reading past it every time somebody comes
    // to change a grace period.
    retired.length
      ? card('Retired', {
        note: `${retired.length} — off the rota, still in the history`,
        wide: true,
      },
        h('p.muted', { style: { fontSize: '.85rem' } },
          'These are offered nowhere: not on the rota, not in a pattern, not when somebody settles '
          + 'a day. Every day already measured against one still reads exactly as it did.'),
        table([
          { key: 'name', label: 'Name' },
          { key: 'starts_at', label: 'Hours', format: (v, r) => `${v} – ${r.ends_at}` },
          {
            key: 'used_days',
            label: 'Days recorded',
            align: 'right',
            format: (v) => (Number(v) ? fmtNum(v, 0) : h('span.muted', 'none')),
          },
          {
            key: 'actions',
            label: '',
            format: (v, r) => h('div.btn-row',
              h('button.btn-sm', { onclick: () => retire(r, false) }, 'Bring back'),
              r.deletable
                ? h('button.btn-sm.btn-danger', { onclick: () => remove(r) }, 'Delete')
                : null,
            ),
          },
        ], retired, { empty: 'None.' }))
      : null,

    h('p.muted', { style: { fontSize: '.82rem' } },
      'The terminal decides what it shows the person at the door; these decide what the reports say. '
      + 'A shift the sync brought in can be edited freely — only its name and times are refreshed on a '
      + 're-sync, and a shift you created yourself is never touched by it.'),
  );
}

/**
 * The shifts this property appears to run, found rather than typed.
 *
 * Two sources behind it. The terminal's own attendance bands — the windows it
 * uses to label a tap as a clock-in or a clock-out — which come down from
 * wherever the shifts were set up, Hik-Connect included. And the punches
 * themselves, which are the better evidence: a few hundred people have been
 * clocking in for these shifts already, and where they actually arrive says
 * more than any configured window.
 *
 * Nothing is applied on its own. A shift decides whether somebody is recorded
 * as late, so it takes a press — but the press is next to a filled-in form.
 */
function suggestionsCard(data, reload) {
  if (!data) return null;

  const fresh = data.suggestions.filter((s) => !s.existing);
  // Pre-ticked, and the set has to agree with the boxes from the first frame —
  // a form that looks ready and then imports nothing is worse than one that
  // starts empty.
  const chosen = new Set(fresh.map((s) => `${s.starts_at}-${s.ends_at}`));

  if (!data.suggestions.length) {
    return card('Shifts found for you', { note: 'Nothing yet', wide: true },
      h('p.muted',
        data.evidence.daysOfPunches
          ? `${data.evidence.daysOfPunches} days of punches so far — not yet a clear enough pattern to `
            + 'suggest a shift from. It usually takes a couple of weeks. Add your shifts by hand in the '
            + 'meantime; the suggestions will stop appearing once they match.'
          : 'No punches yet, and the terminal has not reported any attendance bands. Once the poller has '
            + 'been running for a week or two, the shifts your staff actually work will be offered here.'),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        `The terminal answered ${data.evidence.deviceReported} configuration `
        + `${data.evidence.deviceReported === 1 ? 'endpoint' : 'endpoints'} with `
        + `${data.evidence.deviceBands} usable time ${data.evidence.deviceBands === 1 ? 'band' : 'bands'}. `
        + 'A device that is not in automatic attendance mode reports none, which is normal — the punches '
        + 'alone are enough.'),
    );
  }

  const importChosen = async () => {
    const wanted = data.suggestions
      .filter((s) => chosen.has(key(s)))
      .map((s) => ({
        name: s.name,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        breakMinutes: 0,
        graceIn: 5,
        graceOut: 5,
        halfDayMinutes: Math.round((lengthOf(s) / 2) / 30) * 30,
        fullDayMinutes: Math.round((lengthOf(s) * 0.9) / 30) * 30,
      }));

    if (!wanted.length) {
      toast('Tick the ones you want first.', 'bad');
      return;
    }

    try {
      const result = await api.attImportShifts(wanted);
      const added = result.applied.filter((a) => a.action === 'added').length;
      const updated = result.applied.filter((a) => a.action === 'updated').length;
      toast(`${added} added${updated ? `, ${updated} updated` : ''}. Check the break and grace on each.`, 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return card('Shifts found for you', {
    note: 'From the terminal and from the punches already recorded',
    actions: fresh.length
      ? h('button.btn.btn-primary', { onclick: importChosen }, 'Add the ticked ones')
      : h('span.pill.good', 'All of these are already set up'),
    wide: true,
  },
    table([
      {
        key: 'pick',
        label: '',
        format: (v, r) => (r.existing
          ? h('span.pill.good', '✓')
          : h('input', {
            type: 'checkbox',
            checked: true,
            onchange: (e) => (e.target.checked ? chosen.add(key(r)) : chosen.delete(key(r))),
          })),
      },
      { key: 'name', label: 'Shift', format: (v, r) => h('div', h('div', v), r.existing ? h('small.muted', `already set up as "${r.existing}"`) : null) },
      { key: 'starts_at', label: 'Starts', align: 'right' },
      { key: 'ends_at', label: 'Ends', align: 'right', format: (v, r) => h('span', v, lengthOf(r) > 0 && toMin(r.ends_at) <= toMin(r.starts_at) ? h('small.muted', ' next day') : null) },
      { key: 'length', label: 'Length', align: 'right', format: (v, r) => `${fmtNum(lengthOf(r) / 60, 1)} h` },
      {
        key: 'support',
        label: 'Evidence',
        format: (v, r) => h('div',
          v ? h('div', `${v} days of punches`) : h('div.muted', 'no punches yet'),
          r.confirmedByDevice ? h('small.muted', 'confirmed by the terminal') : null),
      },
    ], data.suggestions, { empty: 'Nothing found.' }),

    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Times come from where people actually clock in and out, rounded to five minutes — which is a '
      + 'better guess than the terminal\u2019s own windows, because those are the times a tap is '
      + '*accepted* between rather than the hour anybody is due. Breaks, grace periods and what counts '
      + 'as a full day are policy: no device knows them, so they arrive as defaults and are worth '
      + 'checking on each shift after you add it.'),
  );

  function key(s) { return `${s.starts_at}-${s.ends_at}`; }
  function toMin(t) { const [hh, mm] = String(t).split(':').map(Number); return hh * 60 + mm; }
  function lengthOf(s) {
    const a = toMin(s.starts_at);
    let b = toMin(s.ends_at);
    if (b <= a) b += 1440;
    return b - a;
  }
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
  const { devices, clockThresholdSeconds = 180 } = await api.attDevices();

  /**
   * The one screen that has to be got exactly right.
   *
   * Shown once, after registering. It carries the token — never readable again
   * — and, for a pushing terminal, the settings to type into the device's own
   * web page. Assembling that URL by hand out of three places is where this
   * goes wrong, so it is assembled here instead.
   */
  const block = (text) => h('pre', {
    style: {
      background: 'var(--surface-2)', padding: '.8rem', borderRadius: 'var(--radius-sm)',
      fontSize: '.78rem', overflowX: 'auto', userSelect: 'all',
      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    },
  }, text);

  const showToken = (result) => {
    const listening = result.listening ?? {};
    const rows = [
      ['Type', 'HTTP'],
      ['Protocol', listening.protocolType],
      ['Address type', 'Domain name'],
      ['Domain name', listening.hostName],
      ['Port', String(listening.portNo ?? '')],
      ['URL', listening.urlPath],
      ['Format', 'JSON'],
      ['Authentication', 'None'],
    ];

    return formDialog({
      title: result.mode === 'poll' ? 'The terminal’s token' : 'Set the terminal up to report here',
      submitLabel: 'Done',
      body: result.mode === 'poll'
        ? h('div',
          h('p', 'This is the only time this token is readable. Put it into the reader’s '
            + 'configuration file now.'),
          block(JSON.stringify({ device: result.serial, token: result.token }, null, 2)))
        : h('div',
          h('p', 'On the terminal’s own web page, find ',
            h('strong', 'Network → Advanced Settings → HTTP Listening'),
            ' — some firmware puts it under ', h('strong', 'Event'),
            ' — and enter this:'),
          h('div.table-scroll',
            h('table',
              h('tbody', rows.map(([label, value]) => h('tr',
                h('td', { style: { width: '38%' } }, label),
                h('td', h('code', { style: { fontSize: '.82rem', userSelect: 'all' } }, value || '—')),
              ))))),
          h('p.muted', { style: { fontSize: '.85rem', marginTop: '.8rem' } },
            'Some firmware asks for the whole address in a single box instead. If so, use:'),
          block(listening.url ?? ''),
          h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
            'That address contains this terminal’s token, so treat it like a password. It is '
            + 'readable now and never again — if it is lost, press “New token” here and the old '
            + 'one stops working immediately.'),
          h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
            'Then press Test on the terminal’s page. This screen will show it as heard from.')),
      onSubmit: async () => true,
    });
  };

  const add = async () => {
    const done = await formDialog({
      title: 'Register a terminal',
      submitLabel: 'Register it',
      body: h('div',
        field('How should it reach us?', h('select', { name: 'mode' },
          h('option', { value: 'push' }, 'The terminal posts to us — nothing to run on site'),
          h('option', { value: 'poll' }, 'A reader program on site fetches from it'),
        ), 'Posting needs no computer in the building. Fetching survives an internet outage.'),
        field('Serial number', h('input', { type: 'text', name: 'serial', required: true, maxlength: 120 }),
          'Exactly as the device reports it, under System → Device Information'),
        field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 80, placeholder: 'Staff entrance' })),
        h('div.field-row',
          field('Location', h('input', { type: 'text', name: 'location', maxlength: 120 })),
          field('Model', h('input', { type: 'text', name: 'model', maxlength: 80, placeholder: 'DS-K1T321MFWX' })),
        ),
      ),
      onSubmit: async (form) => api.attCreateDevice(Object.fromEntries(form.entries())),
    });

    if (done) {
      await showToken(done);
      await reload();
    }
  };

  const rotate = async (row) => {
    if (!window.confirm(
      `Issue a new token for ${row.name}?\n\n`
      + 'The terminal stops reporting until the new one is put into its settings.',
    )) return;
    const result = await api.attRotateToken(row.id);
    await showToken(result);
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
          key: 'mode',
          label: 'Reaches us by',
          format: (v) => (v === 'poll'
            ? h('span.pill', 'a reader on site')
            : h('span.pill.good', 'posting to us')),
        },
        {
          key: 'last_seen_at',
          label: 'Last heard from',
          format: (v, r) => (v ? staleness(v, r.mode) : h('span.pill.bad', 'never')),
        },
        {
          key: 'last_event_at',
          label: 'Last punch',
          format: (v) => (v ? h('small', v.slice(0, 16)) : h('span.muted', 'none yet')),
        },
        {
          key: 'clock_offset_seconds',
          label: 'Its clock',
          format: (v) => deviceClockCell(v, clockThresholdSeconds),
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
      h('p.muted', { style: { marginTop: 0 } },
        'Two ways, and the difference is whether anything has to run in the building.'),

      h('div.grid.grid-2',
        h('div',
          h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'The terminal posts to us'),
          h('p.muted', { style: { fontSize: '.88rem' } },
            'Nothing runs on site. Register the terminal above, then type the settings it '
            + 'shows you into the device\u2019s own web page under Network \u2192 Advanced '
            + 'Settings \u2192 HTTP Listening. From then on it reports every tap by itself.'),
          h('p.muted', { style: { fontSize: '.88rem', marginBottom: 0 } },
            h('strong', 'The catch: '),
            'it is one attempt per tap. If the internet is down at 07:03, that tap does not '
            + 'arrive \u2014 it stays in the terminal\u2019s own log, but nothing here will go '
            + 'and fetch it.')),

        h('div',
          h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'A reader on site fetches'),
          h('p.muted', { style: { fontSize: '.88rem' } },
            'A small program on any always-on computer asks the terminal for its log every '
            + 'five minutes, over an overlapping window, so an outage costs nothing \u2014 '
            + 'the next successful run catches up.'),
          h('p.muted', { style: { fontSize: '.88rem', marginBottom: 0 } },
            h('strong', 'The catch: '),
            'something has to be running, and somebody has to notice when it stops.')),
      ),

      h('p.muted', { style: { fontSize: '.85rem', marginTop: '1rem', marginBottom: 0 } },
        'Both can run at once against the same terminal. Punches are matched on the '
        + 'device\u2019s own event number, so a tap that arrives twice is stored once \u2014 '
        + 'which makes belt and braces a real option if the records matter enough.'),
    ),

  );
}

/**
 * Whether the terminal's own clock can be trusted.
 *
 * Measured on every pushed punch, so "not checked yet" is the honest answer
 * until the first one arrives — and it is worth saying rather than showing a
 * reassuring tick that has nothing behind it.
 *
 * A terminal fetched by a poller can never fill this in: it hands over a log
 * that may be an hour old, and the delay would read as drift.
 */
function deviceClockCell(offsetSeconds, threshold) {
  if (offsetSeconds == null) return h('span.muted', 'not checked yet');

  const off = Number(offsetSeconds);
  const seconds = Math.abs(off);
  if (seconds < threshold) return h('span.pill.good', 'right');

  // The ladder runs all the way to days on purpose. A terminal whose battery
  // died comes back believing it is years ago, and "1580 hr slow" is a number
  // nobody can picture — which is the difference between a warning that gets
  // acted on and one that gets squinted at.
  const amount = seconds < 5400
    ? `${Math.round(seconds / 60)} min`
    : seconds < 172800
      ? `${Math.round(seconds / 3600)} hr`
      : `${Math.round(seconds / 86400)} days`;

  return h(seconds >= 900 ? 'span.pill.bad' : 'span.pill.warn', `${amount} ${off > 0 ? 'fast' : 'slow'}`);
}

/**
 * How long since the terminal last said anything, coloured by whether to worry.
 *
 * What counts as worrying depends on how it reports. A reader on site calls in
 * every few minutes whether or not anybody has walked past, so an hour of
 * silence means it has stopped. A terminal that posts only speaks when somebody
 * taps it, so an hour of silence on a Sunday afternoon means nothing at all —
 * and showing that as a red warning is how people learn to ignore the red
 * warnings that matter.
 */
function staleness(stamp, mode) {
  const then = new Date(`${stamp.replace(' ', 'T')}Z`);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return h('span.muted', stamp);

  const say = (n) => (n < 60 ? `${n} min ago` : n < 1440 ? `${Math.round(n / 60)} hr ago`
    : `${Math.round(n / 1440)} days ago`);

  if (minutes < 15) return h('span.pill.good', 'just now');

  if (mode === 'poll') {
    if (minutes < 120) return h('span.pill.good', say(minutes));
    return h(`span.pill.${minutes < 1440 ? 'warn' : 'bad'}`, say(minutes));
  }

  // Posting terminals: quiet is only suspicious after a whole day, by which
  // point somebody has certainly walked past it.
  if (minutes < 1440) return h('span.pill.good', say(minutes));
  if (minutes < 2880) return h('span.pill.warn', say(minutes));
  return h('span.pill.bad', say(minutes));
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
      // Who this property is. It goes on every contract issued and on the head
      // of every printed report, so it belongs on a screen rather than in
      // whatever the first migration happened to seed.
      card('This property', { note: 'Goes on contracts and printouts' },
        h('label.field',
          h('span', 'Name'),
          h('input', {
            type: 'text', name: 'property_name', maxlength: 120, required: true,
            value: s.property_name ?? '',
          }),
          h('small.muted', 'Exactly as it should read on a contract'),
        ),
        h('label.field',
          h('span', 'Address'),
          h('textarea', { name: 'property_address', rows: 2, maxlength: 300 },
            s.property_address ?? ''),
          h('small.muted', 'Used as the employer\u2019s address on contracts and letters'),
        ),
        h('label.field',
          h('span', 'A link to a member of staff lasts'),
          h('input', {
            type: 'number', name: 'hr_link_days', min: 1, max: 90,
            value: s.hr_link_days ?? 21,
          }),
          h('small.muted', 'Days before a details or signing link stops working'),
        ),
      ),

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
          h('label.field', h('span', 'Working days a week'),
            h('input', { type: 'number', name: 'att_days_per_week', min: 0.5, max: 7, step: 0.5, value: s.att_days_per_week ?? 5 }),
            h('small.muted', 'What a month expects of somebody. Five out of seven by default, '
              + 'and settable per person under Staff')),
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

      card('Departments', { note: 'One per line', wide: true },
        h('label.field',
          h('textarea', {
            name: 'att_departments',
            rows: 8,
            style: { width: '100%', fontFamily: 'inherit', fontSize: '.9rem' },
          }, s.att_departments ?? '')),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'What the dropdown offers when you add somebody. Reports group by department, so this '
          + 'list is what stops "Kitchen" and "kitchen" being counted as two. Taking one out here '
          + 'moves nobody — it only stops it being offered, and it keeps appearing for as long as '
          + 'anybody is still in it.'),
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
