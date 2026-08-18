import { api } from '../api.js';
import { fmtDay, fmtNum, h } from '../util.js';

/**
 * The bits every attendance screen needs.
 *
 * Chiefly one thing: the four colours, applied identically everywhere. A status
 * that is amber on the day screen and red on the week report is a system nobody
 * trusts, and the surest way to get that is to decide the colour twice.
 */

const PILL = { green: 'good', amber: 'warn', red: 'bad', grey: '' };

export function statusPill(record) {
  const kind = PILL[record.colour] ?? '';
  return h(`span.pill${kind ? `.${kind}` : ''}`, record.label);
}

/** A clock time, or a red dash where one should have been. */
export function clockCell(time, { missing = true } = {}) {
  if (time) return h('span', { style: { color: 'var(--good)' } }, time);
  return missing ? h('span', { style: { color: 'var(--bad)' } }, '—') : h('span.muted', '—');
}

export function hoursCell(value) {
  if (!value) return h('span.muted', '0 hrs');
  return h('span', { style: { color: 'var(--c3)' } }, `${fmtNum(value, 1)} hrs`);
}

/** Minutes, shown only when there are any — a column of zeroes reads as noise. */
export function minutesCell(value) {
  if (!value) return h('span.muted', '—');
  return h('span', value >= 30 ? { style: { color: 'var(--bad)' } } : null, `${fmtNum(value, 0)} min`);
}

export function daysCell(value) {
  if (value == null) return h('span.muted', '—');
  return h('span', fmtNum(value, value % 1 ? 1 : 0));
}

/**
 * The one-line summary above a list.
 *
 * Ordered by what a supervisor does about it: decisions first, then absences,
 * then lateness, then the good news.
 */
export function totalsLine(totals) {
  const parts = [];
  if (totals.openCount) parts.push(`${totals.openCount} to confirm`);
  if (totals.daysAbsent) parts.push(`${totals.daysAbsent} absent`);
  if (totals.lateCount) parts.push(`${totals.lateCount} late`);
  if (totals.earlyCount) parts.push(`${totals.earlyCount} left early`);
  if (totals.daysLeave) parts.push(`${totals.daysLeave} on leave`);
  if (!parts.length) return 'Everybody accounted for.';
  return parts.join(' · ');
}

/** A <select> of the reasons a person may choose. */
export function reasonSelect(reasons, selected, props = {}) {
  return h('select', props,
    h('option', { value: '' }, 'Choose…'),
    (reasons ?? []).filter((r) => r.selectable && r.active).map((r) =>
      h('option', { value: r.code, selected: r.code === selected }, r.label)),
  );
}

/**
 * A shift's hours, written the same way everywhere.
 *
 * The `+1` matters. A shift reading 17:30–06:30 is thirteen hours across two
 * dates, and without the mark it reads as eleven hours backwards — which is the
 * one thing about a night shift everybody gets wrong on first sight.
 */
export function shiftHours(shift) {
  if (!shift?.starts_at || !shift?.ends_at) return '';
  const overnight = shift.ends_at <= shift.starts_at;
  return `${shift.starts_at}–${shift.ends_at}${overnight ? ' +1' : ''}`;
}

/**
 * A shift as an option reads.
 *
 * Always with its hours. This property runs five shifts called some variation
 * of Housekeeper and the difference between them is entirely the times, so a
 * dropdown of bare names asks somebody to remember what the system already
 * knows.
 */
export function shiftLabel(shift) {
  const hours = shiftHours(shift);
  return hours ? `${shift.name} · ${hours}` : String(shift.name ?? '');
}

/** Which department a shift belongs to, with a name for the ones that do not. */
export const NO_DEPARTMENT = 'No department';
export const departmentOf = (shift) => (shift?.department || NO_DEPARTMENT);

/** Alphabetical, with the unfiled ones at the bottom where they belong. */
export function sortDepartments(names) {
  return [...names].sort((a, b) => {
    if (a === NO_DEPARTMENT) return 1;
    if (b === NO_DEPARTMENT) return -1;
    return a.localeCompare(b);
  });
}

/** Shifts in departments, in the order a list of them should appear. */
export function byDepartment(shifts) {
  const groups = new Map();
  for (const shift of shifts ?? []) {
    const key = departmentOf(shift);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shift);
  }
  return sortDepartments([...groups.keys()]).map((name) => ({ name, shifts: groups.get(name) }));
}

/**
 * Shift options, banded by department.
 *
 * Twenty-four shifts in one flat list is a scroll and a squint. The same
 * twenty-four under five headings is five short lists, and the heading tells
 * you which one to read before you have read any of them.
 *
 * A single department is left ungrouped: one heading over the whole list says
 * nothing and costs a row.
 */
export function shiftOptionGroups(shifts, selected, { label = null } = {}) {
  const groups = byDepartment(shifts);
  const opt = (s) => h('option', {
    value: s.id, selected: String(s.id) === String(selected),
  }, shiftLabel(s));

  if (groups.length <= 1) return (groups[0]?.shifts ?? []).map(opt);
  return groups.map((g) => h('optgroup', { label: label ? `${label} — ${g.name}` : g.name },
    g.shifts.map(opt)));
}

export function shiftSelect(shifts, selected, props = {}) {
  return h('select', props,
    h('option', { value: '' }, '—'),
    shiftOptionGroups((shifts ?? []).filter((s) => s.active), selected),
  );
}

/**
 * A modal that returns what was filled in, or null if it was dismissed.
 *
 * Uses a real <dialog>, so Escape closes it and the browser handles the focus
 * trap — both of which a hand-rolled overlay gets wrong.
 */
export function formDialog({ title, body, submitLabel = 'Save', onSubmit }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog' });
    const dialog = h('dialog', {
      style: {
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--surface)',
        color: 'var(--text)',
        maxWidth: '560px',
        width: '92vw',
        padding: '1.2rem',
      },
    },
      h('div.card-head',
        h('h2', title),
        h('button.btn-sm.btn-ghost', {
          type: 'button',
          onclick: () => { dialog.close(); resolve(null); },
        }, '✕'),
      ),
      form,
    );

    const error = h('p.form-error', { style: { display: 'none' } });
    let busy = false;

    const submit = h('button.btn.btn-primary', { type: 'submit' }, submitLabel);
    form.append(
      body,
      error,
      h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
        h('button.btn-sm', {
          type: 'button',
          onclick: () => { dialog.close(); resolve(null); },
        }, 'Cancel'),
        submit,
      ),
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      submit.disabled = true;
      error.style.display = 'none';
      try {
        const result = await onSubmit(new FormData(form));
        dialog.close();
        resolve(result ?? true);
      } catch (err) {
        error.textContent = err.message || 'That did not work.';
        error.style.display = '';
        busy = false;
        submit.disabled = false;
      }
    });

    dialog.addEventListener('close', () => { dialog.remove(); resolve(null); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function field(label, control, hint) {
  return h('label.field',
    h('span', label),
    control,
    hint ? h('small.muted', hint) : null,
  );
}


/**
 * Put a clock time right.
 *
 * Deliberately not the same form as settling a day, and the difference is the
 * whole idea. Settling asks "what should this day be charged to" and needs
 * somebody who can answer that. This asks only "when did they actually arrive
 * and leave" — the person building the rota knows, and everything else follows
 * from the answer on its own: the hours, the lateness, the overtime, the
 * verdict.
 *
 * Two things are said on the form rather than in a manual nobody opens: that
 * the punches themselves are untouched, and that the administrators are told.
 * Somebody who knows both of those before they type is not going to be
 * surprised by either afterwards.
 */
export function correctTimesDialog(row, staff, { signedSpan = null } = {}) {
  const observed = (side) => {
    const was = side === 'in' ? row.corrected_in : row.corrected_out;
    const seen = side === 'in' ? row.first_in : row.last_out;
    if (was) return `Corrected to ${was}. ${seen && seen !== was ? `The terminal read ${seen}` : 'The terminal saw nothing'}`;
    return seen ? `The terminal read ${seen}` : 'The terminal saw nothing';
  };

  return formDialog({
    title: `${staff.name} — clock times, ${fmtDay(row.day, { withYear: true })}`,
    submitLabel: 'Correct the times',
    body: h('div',
      h('p.muted', row.shift
        ? `${row.shift.name}, ${row.shift.starts_at}–${row.shift.ends_at}`
        : 'No shift rostered for this day'),
      h('div.grid.grid-2',
        field('Clocked in',
          h('input', { type: 'time', name: 'in', value: row.corrected_in || row.first_in || '' }),
          observed('in')),
        field('Clocked out',
          h('input', { type: 'time', name: 'out', value: row.corrected_out || row.last_out || '' }),
          observed('out')),
      ),
      field('Why',
        h('input', {
          type: 'text', name: 'reason', maxlength: 400, required: true,
          placeholder: 'The kitchen closed at 21:00 and he forgot to clock out',
        }),
        'Required. It is shown to the administrators and kept on the record'),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'The punches themselves are never altered — this is recorded beside them, against your '
        + 'name, and the administrators are told each time. Clearing both boxes puts the day '
        + 'back to what the terminal saw.'),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'This does not settle the day or excuse anything. The hours, the lateness and the '
        + 'overtime are all worked out again from the times you give.'),
      signedSpan
        ? h('p.muted', { style: { color: 'var(--warn)', fontSize: '.85rem', marginBottom: 0 } },
          `${fmtDay(signedSpan.from)} to ${fmtDay(signedSpan.to)} has already been signed off. `
          + 'Changing the times will not change what was charged — reopen that period and sign '
          + 'it again if the figure should move.')
        : null,
    ),
    onSubmit: async (form) => api.attCorrectTimes(row.day, {
      staffId: staff.id,
      in: form.get('in') || null,
      out: form.get('out') || null,
      reason: form.get('reason'),
    }),
  });
}

/**
 * Sign a person's month off, from wherever the question was asked.
 *
 * Shared between the leave screen and the person's own report on purpose. It
 * moves somebody's leave, and two copies of a form that does that would drift —
 * one of them would keep the whole-day rounding and the other would quietly not.
 *
 * Opens with the difference filled in as a default rather than an applied
 * verdict. The figures are arithmetic; a manager looking at two days short may
 * charge one, or none, and both halves end up on the record.
 */
export function signOffDialog(row, span) {
  const short = row.difference < 0;
  const size = Math.abs(row.difference);

  return formDialog({
    title: `${row.staff.name} — ${spanLabel(span)}`,
    submitLabel: 'Record the decision',
    body: h('div',
      h('p.muted',
        `Rostered ${fmtNum(row.scheduledDays, 1)} days, worked ${fmtNum(row.workedDays, 1)}. `
        + (size
          ? `${row.overDays} extra day${row.overDays === 1 ? '' : 's'} and `
            + `${row.underDays} whole shift${row.underDays === 1 ? '' : 's'} missed — `
            + `${short ? 'short by' : 'over by'} ${size}.`
          : 'Nothing counted either way.')),

      field('What happens to their leave',
        h('select', { name: 'decision' },
          h('option', { value: 'approved' }, short ? 'Charge days to their leave' : 'Give days back'),
          h('option', { value: 'waived', selected: !size }, 'Let it stand — nothing comes off'),
        )),

      field('Days',
        h('input', {
          type: 'number', name: 'daysApplied', step: 1, min: -60, max: 60,
          value: row.difference,
        }),
        'Whole days. Negative takes days off their entitlement, positive gives days back'),

      field('Note', h('input', { type: 'text', name: 'note', maxlength: 300 })),

      row.openCount
        ? h('p.muted', { style: { color: 'var(--warn)' } },
          `${row.openCount} day${row.openCount === 1 ? '' : 's'} here are still waiting on a `
          + 'supervisor. Settling those first will change these figures.')
        : null,

      // Signing a month that already contains a signed week would charge the
      // same days twice. The server refuses it; saying so first is kinder than
      // an error after somebody has filled the form in.
      row.overlapping?.length
        ? h('p.muted', { style: { color: 'var(--bad)' } },
          `${row.staff.name} already has ${row.overlapping.map((o) => `${o.from} to ${o.to}`).join(', ')} `
          + 'signed off inside this span. Reopen it first, or the same days would be charged twice.')
        : null,
    ),
    onSubmit: async (form) => api.attDecideReview({
      staffId: row.staff.id,
      ...span,
      decision: form.get('decision'),
      daysApplied: Math.round(Number(form.get('daysApplied')) || 0),
      note: form.get('note') || null,
    }),
  });
}

/**
 * What to call the span being signed off.
 *
 * A month by name, a single day by date, anything else by its two ends. The
 * label is only ever a label — the dates are what the record keeps and what the
 * overlap check works on.
 */
export function spanLabel(span) {
  if (span.month) return monthLabel(span.month);
  if (span.from === span.to) return fmtDay(span.from, { withYear: true });
  return `${fmtDay(span.from)} to ${fmtDay(span.to, { withYear: true })}`;
}

export function monthLabel(month) {
  return new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}
