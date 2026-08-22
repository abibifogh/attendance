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
 * How long a shift lasts, in minutes, less its unpaid break.
 *
 * A shift that ends at or before it starts runs into the next day, which is
 * the one thing about a night shift everybody gets wrong on first sight.
 */
export function shiftMinutes(shift) {
  if (!shift?.starts_at || !shift?.ends_at) return 0;
  const at = (clock) => {
    const [hh, mm] = String(clock).split(':').map(Number);
    return (Number(hh) || 0) * 60 + (Number(mm) || 0);
  };
  const start = at(shift.starts_at);
  const end = at(shift.ends_at);
  const span = end > start ? end - start : (24 * 60) - start + end;
  return Math.max(0, span - (Number(shift.break_minutes) || 0));
}

/** Those minutes as somebody would say them: 7h, 7h 30m. */
export function asHours(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  const hh = Math.floor(n / 60);
  const mm = n % 60;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
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

/**
 * Which of eight colours a shift wears, everywhere it appears.
 *
 * Chosen for the shift rather than by whoever set it up, so a property with
 * twenty-four shifts is not a colouring exercise before the rota is readable.
 * The choice is stable — it comes from the shift's id, which never changes —
 * so a shift is the same colour tomorrow as it was today, which is the only
 * property that makes a colour worth learning.
 *
 * An administrator can override it, and then theirs stands. Eight is the
 * ceiling on purpose: past that nobody can tell two of them apart at a glance,
 * and a colour nobody can name is decoration rather than information.
 */
export const SHIFT_COLOURS = 8;

/**
 * Names for the eight, so a choice can be spoken about.
 *
 * "Colour 5" is not something anybody says to a colleague. "The red one" is.
 */
export const SHIFT_COLOUR_NAMES = [
  'Blue', 'Teal', 'Amber', 'Violet', 'Red', 'Cyan', 'Green', 'Pink',
];

/**
 * Eight swatches to pick from, and the option of letting the app choose.
 *
 * A picker rather than a dropdown of numbers, because the whole point of the
 * setting is what the thing looks like on the rota, and a list reading
 * "Colour 1 … Colour 8" asks somebody to hold eight guesses in their head.
 */
export function shiftColourPicker(existing) {
  const chosen = String(existing?.colour ?? '');
  const swatch = (value, label, hint) => h('label.swatch-choice',
    h('input', {
      type: 'radio', name: 'colour', value, checked: chosen === value,
    }),
    value
      ? h('span.swatch-dot', { style: { '--shift': `var(--c${value})` } })
      : h('span.swatch-dot.swatch-auto'),
    h('span.swatch-label', label, hint ? h('small.muted', hint) : null));

  return h('div.swatch-row',
    swatch('', 'Chosen for it',
      existing ? ` (${SHIFT_COLOUR_NAMES[shiftColour(existing) - 1]})` : null),
    ...SHIFT_COLOUR_NAMES.map((name, i) => swatch(String(i + 1), name)),
  );
}

export function shiftColour(shift) {
  if (!shift) return 0;
  const chosen = Number(shift.colour);
  if (Number.isInteger(chosen) && chosen >= 1 && chosen <= SHIFT_COLOURS) return chosen;
  const id = Number(shift.id);
  if (!Number.isFinite(id)) return 1;
  return ((Math.abs(id) - 1) % SHIFT_COLOURS) + 1;
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
 * Shifts gathered into the jobs they actually are.
 *
 * A property runs "Breakfast 06:00–14:00", "Breakfast 06:00–14:30" and
 * "Breakfast 06:00–15:00". Those are one job that finishes at three different
 * times, and they are three shifts because a shift is what lateness is
 * measured against. Where somebody has said so, they collapse into one row of
 * the position view. Where nobody has, a shift is its own position, which is
 * the truth for most of them.
 */
export function byPosition(shifts) {
  const groups = new Map();
  for (const shift of shifts ?? []) {
    // Keyed by name so two positions spelled the same are the same, and by the
    // shift's own id where there is no position, so it stands alone.
    const name = (shift.position || '').trim();
    const key = name ? `p:${name.toLowerCase()}` : `s:${shift.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: name || shift.name,
        // A position holding one shift is not really a position, and saying so
        // stops the view claiming credit for a grouping nobody made.
        grouped: Boolean(name),
        department: departmentOf(shift),
        shifts: [],
      });
    }
    groups.get(key).shifts.push(shift);
  }

  // Ordered as the shifts themselves are, by whichever of theirs comes first.
  return [...groups.values()].map((group) => ({
    ...group,
    grouped: group.grouped && group.shifts.length > 1,
  }));
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
 * A sheet with something to read in it, and one way out.
 *
 * Not a form. `formDialog` would give this a Cancel and a submit that both do
 * the same thing, and two buttons meaning "close" is how a reader learns not
 * to read the buttons.
 */
export function showSheet({ title, body }) {
  const dialog = h('dialog.app-dialog',
    h('div.dialog-head',
      h('h2', title),
      h('button.dialog-close', {
        type: 'button', 'aria-label': 'Close', onclick: () => dialog.close(),
      }, '✕'),
    ),
    body,
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button.btn.btn-primary', { type: 'button', onclick: () => dialog.close() }, 'Close'),
    ),
  );

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
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
    // Styled by class rather than inline, so the phone rules can win. An
    // inline width beats any stylesheet, which is how a dialog ended up 92% of
    // a handset with its buttons off the bottom.
    const dialog = h('dialog.app-dialog',
      h('div.dialog-head',
        h('h2', title),
        h('button.dialog-close', {
          type: 'button',
          'aria-label': 'Close',
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
 * The over-or-under of a set of days, counted rather than recalculated.
 *
 * Each day arrives from the sign-off list already marked as an extra day
 * worked, a whole shift missed, or neither — the rule that decides which lives
 * on the server and is applied there before anything is written. So this is a
 * count, not a second copy of the rule, and it exists only to fill in the box
 * with the figure for the days somebody actually ticked.
 *
 * That matters more than it sounds. Almost nobody edits a number the screen
 * appears confident about, so a box showing the whole fortnight's figure
 * against three ticked days is how eleven days of somebody's leave move by
 * accident.
 */
export function overUnderOf(days) {
  const delivered = days.reduce((n, d) => n + (d.owed ?? 0), 0);
  const quota = days.reduce((n, d) => n + (d.quota ?? 0), 0);
  // The expectation is five sevenths of a day at a time, so the sum is
  // fractional and what gets charged is not. Rounding here rather than showing
  // somebody a proposal of -1.4 days against their colleague's leave.
  return Math.round(delivered - quota);
}

/**
 * Is there anything about this day worth a button?
 *
 * The Settle and Times buttons appear only against days with something wrong
 * with them — absent, late, left early, or a clock-in or clock-out the terminal
 * never completed. A column of buttons against twenty-eight ordinary days is a
 * column nobody reads, and the four that matter are lost in it.
 *
 * Decided from the four colours rather than from a list of statuses, so it
 * cannot drift away from what the rest of the screen is already saying: green
 * is fine, amber is worth a word, red is deal with this. A day still waiting on
 * somebody counts however it is coloured.
 *
 * Days already ruled on keep their buttons too — that is how a ruling is
 * undone, and a decision you cannot reverse is a decision nobody wants to make.
 */
export function needsAttention(record) {
  if (!record) return false;
  if (record.open) return true;
  if (record.resolution === 'resolved' || record.resolution === 'auto') return true;
  return record.colour === 'amber' || record.colour === 'red';
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
export function correctTimesDialog(row, staff, {
  signedSpan = null, approves = false, pending = null,
} = {}) {
  const observed = (side) => {
    const was = side === 'in' ? row.corrected_in : row.corrected_out;
    const seen = side === 'in' ? (row.first_in ?? row.in) : (row.last_out ?? row.out);
    if (was) return `Corrected to ${was}. ${seen && seen !== was ? `The terminal read ${seen}` : 'The terminal saw nothing'}`;
    return seen ? `The terminal read ${seen}` : 'The terminal saw nothing';
  };
  const startValue = (side) => (side === 'in'
    ? pending?.now_in ?? row.corrected_in ?? row.first_in ?? row.in ?? ''
    : pending?.now_out ?? row.corrected_out ?? row.last_out ?? row.out ?? '');

  // A shift arrives as an object on the reports and as a bare name on the
  // sign-off list. Both are worth showing and neither is worth a second dialog.
  const shiftLine = typeof row.shift === 'string'
    ? row.shift
    : row.shift
      ? `${row.shift.name}, ${row.shift.starts_at}–${row.shift.ends_at}`
      : 'No shift rostered for this day';

  return formDialog({
    title: `${staff.name} — clock times, ${fmtDay(row.day, { withYear: true })}`,
    submitLabel: approves ? 'Correct the times' : 'Send for approval',
    body: h('div',
      h('p.muted', shiftLine),

      pending
        ? h('div.alert.warn',
          h('span.alert-icon', '⏳'),
          h('div',
            h('div.alert-title', 'A change is already waiting on this day'),
            h('div.alert-detail',
              `${pending.actor} asked for ${pending.now_in || '—'} → ${pending.now_out || '—'}`
              + `${pending.reason ? `: ${pending.reason}` : ''}. Saving replaces it.`),
          ))
        : null,
      h('div.grid.grid-2',
        field('Clocked in',
          h('input', { type: 'time', name: 'in', value: startValue('in') }),
          observed('in')),
        field('Clocked out',
          h('input', { type: 'time', name: 'out', value: startValue('out') }),
          observed('out')),
      ),
      field('Why',
        h('input', {
          type: 'text', name: 'reason', maxlength: 400, required: true,
          placeholder: 'The kitchen closed at 21:00 and he forgot to clock out',
        }),
        approves
          ? 'Required, and kept on the record'
          : 'Required. An administrator reads this before deciding'),

      approves
        ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Applied straight away, under your name, and the day is settled on whatever the rules '
          + 'make of the times you give — you are not being asked to choose a status. Clearing '
          + 'both boxes puts the day back to what the terminal saw and reopens it.')
        : h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'This goes to an administrator. Nothing changes on the day until they approve it, and '
          + 'when they do, the day is settled on whatever the rules make of the new times. You '
          + 'can replace what you sent until then.'),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'The punches themselves are never altered — this is recorded beside them, against your '
        + 'name, and it stays on the record either way.'),
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
