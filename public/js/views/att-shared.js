import { api } from '../api.js';
import { fmtDay, fmtNum, h, mount } from '../util.js';

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
  return h('span', value >= 30 ? { style: { color: 'var(--bad)' } } : null, lateBy(value));
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
 * Does this shift run into the small hours, or right up to them?
 *
 * Two shapes, and they read the same to whoever is working it. One ends after
 * it starts, which is the night shift everybody recognises. The other ends at
 * exactly midnight — a bar closing at twelve is not a day shift, whatever the
 * clock arithmetic says about which date it finishes on.
 */
export function runsIntoTheNight(shift) {
  if (!shift?.starts_at || !shift?.ends_at) return false;
  return shift.ends_at <= shift.starts_at || shift.ends_at === '00:00';
}

/** The little moon, for a shift that does. Nothing at all for one that does not. */
export function nightMark(shift) {
  if (!runsIntoTheNight(shift)) return null;
  return h('span.night-mark', {
    title: shift.ends_at === '00:00' && shift.ends_at > shift.starts_at
      ? 'Runs until midnight'
      : 'Runs overnight, finishing the next morning',
    'aria-label': 'overnight',
  }, '☾');
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

/**
 * The blanket "full day" every shift was made with before this was worked out.
 * Not a number anybody chose, so it does not count as one.
 */
export const LEGACY_FULL_DAY = 420;

/**
 * Whether a shift's full-day threshold is somebody's own decision.
 *
 * A property is allowed to say a full day on an eight-hour shift is seven
 * hours, and that has to survive a change to the times. Everything else — a
 * new shift, or one still carrying the old blanket 420 — follows the hours.
 */
export function fullDayIsOwn(shift) {
  if (!shift) return false;
  const stored = Number(shift.full_day_minutes);
  if (!Number.isFinite(stored)) return false;
  return stored !== shiftMinutes(shift) && stored !== LEGACY_FULL_DAY;
}

/**
 * A stretch of lateness, as somebody would say it out loud.
 *
 * Nobody says "eighty-seven minutes late". Past the hour it becomes hours and
 * whatever is on top, which is both shorter and the only form a person can
 * picture. Under the hour it stays in minutes, because "0 hr 40 min" is worse
 * than "40 min" in every way.
 */
export function lateBy(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return mm ? `${hh} hr ${mm} min` : `${hh} hr${hh === 1 ? '' : 's'}`;
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
 * An administrator can override it, and then theirs stands. Eleven is the
 * ceiling, and it is a ceiling rather than a suggestion: past a dozen nobody
 * can tell two of them apart at a glance, and a colour nobody can name is
 * decoration rather than information. Every one of these can be named.
 *
 * Grey earns its place for a reason the others do not share. A property with
 * a shift it wants on the rota and does not want the eye drawn to — a standby,
 * a cover slot, an office day among a wall of service shifts — has had to
 * spend a colour on it. Grey is the one that says "here, and not the thing to
 * look at".
 */
export const SHIFT_COLOURS = 11;

/**
 * Names for them, so a choice can be spoken about.
 *
 * "Colour 5" is not something anybody says to a colleague. "The red one" is.
 */
export const SHIFT_COLOUR_NAMES = [
  'Blue', 'Teal', 'Amber', 'Violet', 'Red', 'Cyan', 'Green', 'Pink',
  'Indigo', 'Brown', 'Grey',
];

/**
 * The swatches to pick from, and the option of letting the app choose.
 *
 * A picker rather than a dropdown of numbers, because the whole point of the
 * setting is what the thing looks like on the rota, and a list reading
 * "Colour 1 … Colour 11" asks somebody to hold eleven guesses in their head.
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

/**
 * The department a bonus scheme belongs to.
 *
 * A scheme that covers the whole property has none, and that is a real answer
 * rather than a gap: those sit together under General, at the bottom, where a
 * property-wide scheme belongs after the ones that are somebody's own.
 */
export const GENERAL = 'General';

/**
 * The departments a bonus scheme covers.
 *
 * A list rather than one name, because a property runs schemes that genuinely
 * span two: the kitchen and the bistro share a service bonus, front office and
 * reservations share an upsell one. Empty means the whole property, which is a
 * real answer and not a gap somebody forgot to fill in.
 *
 * The single `department` is still read for a row written before schemes could
 * span more than one.
 */
export function schemeDepartments(scheme) {
  const many = scheme?.departments;
  const list = Array.isArray(many)
    ? many
    : (() => {
      if (typeof many !== 'string' || !many.trim()) return null;
      try {
        const parsed = JSON.parse(many);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })();

  const names = (list ?? [scheme?.department])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** 'Kitchen', 'Kitchen and F&B', 'Kitchen, F&B and Bar'. */
export function sayDepartments(names) {
  if (!names.length) return GENERAL;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Bonus schemes in departments, in the order they should be read.
 *
 * Grouped on the whole set a scheme covers rather than listed once under each
 * of them. A scheme shown twice is two sets of score boxes for one scheme, and
 * whichever was typed into last would win without anybody being told.
 */
export function schemesByDepartment(schemes) {
  const groups = new Map();
  for (const scheme of schemes ?? []) {
    const names = schemeDepartments(scheme);
    const key = names.length ? names.join('\u0000') : GENERAL;
    if (!groups.has(key)) groups.set(key, { name: sayDepartments(names), schemes: [] });
    groups.get(key).schemes.push(scheme);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.name === GENERAL) return 1;
    if (b.name === GENERAL) return -1;
    return a.name.localeCompare(b.name);
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
/**
 * Earliest start at the top.
 *
 * A rota is read as the shape of a day — who opens, who follows, who closes —
 * so anything that stacks shifts stacks them this way: the position rows, the
 * shifts inside one position, and the cards in a day's cell. Ties fall back to
 * the name, so the order is the same every time the page is drawn.
 */
export const earliestFirst = (a, b) => (
  String(a?.starts_at ?? '').localeCompare(String(b?.starts_at ?? ''))
  || String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
);

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

  return [...groups.values()]
    .map((group) => ({
      ...group,
      shifts: [...group.shifts].sort(earliestFirst),
      grouped: group.grouped && group.shifts.length > 1,
    }))
    // And the positions themselves in the same order, by the earliest shift in
    // each, so the whole column reads down the day.
    .sort((a, b) => earliestFirst(a.shifts[0] ?? {}, b.shifts[0] ?? {}));
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
    h('div.btn-row',
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
export function formDialog({ title, body, submitLabel = 'Save', onSubmit, wide = false }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog' });
    // Styled by class rather than inline, so the phone rules can win. An
    // inline width beats any stylesheet, which is how a dialog ended up 92% of
    // a handset with its buttons off the bottom.
    // `wide` for a form with a table in it, 'xl' where that table has more
    // columns than the wide one holds.
    const room = wide === 'xl' ? '.app-dialog-xl' : (wide ? '.app-dialog-wide' : '');
    const dialog = h(`dialog.app-dialog${room}`,
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
      h('div.btn-row',
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

/**
 * Somebody's borrowing, drawn as a statement.
 *
 * Opening, taken, repaid, closing — the shape a bookkeeper writes it in, and
 * the reason for that shape is that every line balances against the one above
 * it. A list of movements says what happened; this says what it added up to,
 * which is the question anybody actually has.
 *
 * One table for the person and everything they have borrowed, not one per
 * advance. Somebody paying back four hundred who takes another two hundred in
 * June should not have to add two tables together to find out what they owe.
 *
 * The months ahead are in it too, greyed. They are a forecast and they move,
 * and a person deciding whether they can ask for anything else needs to see
 * how long the current one has to run.
 */
export function advanceStatement(account, cash, { title = 'Month by month', currency = 'GHS' } = {}) {
  const rows = account ?? [];
  if (!rows.length) return null;

  const last = rows[rows.length - 1];
  // The currency once, in the heading, rather than on every figure in every
  // row. Five columns of "GHS" is what pushed this off the side of a phone,
  // and a running account is read down a column, not one cell at a time.
  const figure = (n) => new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);

  return h('div',
    title ? h('h3.adv-sub', title) : null,
    h('table.adv-statement',
      h('thead', h('tr',
        h('th', 'Month'),
        h('th.num', 'Opening'),
        h('th.num', 'Taken'),
        h('th.num', 'Repaid'),
        h('th.num', `Closing ${currency}`))),
      h('tbody', rows.map((row) => h(`tr${row.done ? '' : '.adv-ahead'}`,
        // Both spellings of the month, and the stylesheet picks. A phone gets
        // Aug 26 and everything else gets August 2026, without the screen
        // having to watch for a resize to change its mind.
        h('td.adv-when',
          h('span.adv-when-long', niceMonth(row.month)),
          h('span.adv-when-short', shortMonth(row.month))),
        h('td.num.muted', figure(row.opening)),
        h('td.num', row.additions ? figure(row.additions) : h('span.muted', '—')),
        // Three different blanks, and telling them apart is most of what
        // somebody opens this for. A month deliberately let go says so; a
        // month nobody answered for is a bare dash; a month ahead carries
        // what is expected.
        h('td.num', row.repayment
          ? figure(row.repayment)
          : h('span.muted', row.letGo ? 'nothing taken' : '—')),
        h('td.num.strong', figure(row.closing)))))),
    last.closing > 0
      ? h('p.muted', { style: { fontSize: '.82rem' } },
        `${cash(last.closing)} is still expected after ${niceMonth(last.month)}.`)
      : null);
}

/** 'Aug 26' from '2026-08', for a column too narrow for the long one. */
export function shortMonth(month) {
  const [year, mm] = String(month ?? '').split('-');
  if (!year || !mm) return String(month ?? '');
  const at = new Date(Date.UTC(Number(year), Number(mm) - 1, 1));
  return `${at.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })} ${year.slice(2)}`;
}

/** 'August 2026' from '2026-08'. */
export function niceMonth(month) {
  const text = String(month ?? '');
  if (!/^\d{4}-\d{2}$/.test(text)) return text;
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' })
    .format(new Date(`${text}-01T12:00:00Z`));
}

/**
 * A tier table in a sentence, for a card with one line to say it in.
 *
 * The ends and the count. The rungs between them are on the screen underneath,
 * and repeating all ten in a summary helps nobody.
 *
 * The worker has the same sentence, because the sheet template writes it too
 * and neither side can import the other. It is a label, not a figure: what a
 * rung is worth is worked out in one place and sent here already decided.
 */
export function sayTiers(tiers, cash = (n) => String(n)) {
  const table = (tiers ?? []).filter((t) => t && Number.isFinite(Number(t.score)));
  if (!table.length) return 'no scores set yet';
  if (table.length === 1) {
    return `one score, ${table[0].score}, worth ${cash(table[0].amount)}`;
  }
  const first = table[0];
  const last = table[table.length - 1];
  return `${table.length} scores, ${first.score} at ${cash(first.amount)} `
    + `up to ${last.score} at ${cash(last.amount)}`;
}

/**
 * A box that finds a real place while somebody types in it.
 *
 * WHY THIS EXISTS AT ALL. An address typed by whoever already knows where it is
 * reads perfectly to them and is no use to anybody else. "The office, main
 * building" is not somewhere a candidate at the other end of Accra can
 * navigate to. So the box asks Google what somebody means, and what comes back
 * carries an address and a pair of coordinates — which become a directions
 * link on the page of somebody who has never been here. The autocomplete is
 * the means; the link is the point.
 *
 * IT IS STILL A TEXT BOX. Whatever is typed stands: nobody is forced to pick a
 * suggestion, a property with no key set sees no difference at all, and a
 * lookup that fails leaves the typing alone rather than clearing it. A field
 * that will not accept "the office" because Google has not heard of it is a
 * field that stops people publishing interview times.
 *
 * ONE BILLABLE SESSION PER ADDRESS. Google charges per session of typing when
 * a token is carried from the first letter through to the pick, and per
 * request when it is not. So a token is made here, sent on every call, and
 * replaced once something is chosen.
 */
export function placeField({
  value = '', placeholder = '', name = 'place', enabled = true, onPick = null,
} = {}) {
  const input = h('input', {
    type: 'text', name, maxlength: 160, value, placeholder,
    autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list',
  });
  const list = h('ul.place-list', { role: 'listbox', hidden: true });
  const note = h('small.muted.place-note');
  const box = h('div.place-field', input, list, note);

  // What was picked, if anything. Read back by whoever built the field.
  let chosen = { placeId: null, lat: null, lng: null };
  let session = newSession();
  let at = -1;
  let timer = null;
  let seq = 0;

  const state = {
    el: box,
    input,
    get value() { return input.value; },
    // Only where the text still matches what was picked. Editing the box after
    // choosing a place makes the coordinates a lie about the words beside them.
    get place() {
      return chosen.placeId && input.value === chosen.label
        ? { placeId: chosen.placeId, lat: chosen.lat, lng: chosen.lng }
        : { placeId: null, lat: null, lng: null };
    },
  };

  if (!enabled) {
    note.textContent = '';
    return state;
  }

  const close = () => {
    mount(list, []);
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    at = -1;
  };

  const pick = async (place) => {
    close();
    note.textContent = 'Looking it up…';
    try {
      const found = await api.placeDetails(place.id, session);
      input.value = found.label;
      chosen = {
        placeId: found.id, lat: found.lat, lng: found.lng, label: found.label,
      };
      note.textContent = found.lat != null
        ? 'Found on the map. Whoever you send this to gets directions.'
        : 'Found, but with no pin on the map.';
      // A new session: the next address somebody types is a separate one, and
      // reusing the token would bill it as part of this.
      session = newSession();
      onPick?.(found);
    } catch (err) {
      note.textContent = err.message;
    }
  };

  const draw = (places) => {
    if (!places.length) return close();
    at = -1;
    mount(list, places.map((place, i) => h('li',
      h('button.place-option', {
        type: 'button',
        role: 'option',
        onmousedown: (event) => { event.preventDefault(); pick(place); },
        onclick: () => pick(place),
        'data-at': String(i),
      },
      h('strong', place.name),
      place.address ? h('small.muted', place.address) : null))));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const look = async () => {
    const q = input.value.trim();
    if (q.length < 3) { close(); note.textContent = ''; return; }

    const mine = ++seq;
    try {
      const found = await api.placeSuggest(q, session);
      // A slower answer to an earlier keystroke must not overwrite a faster
      // answer to a later one.
      if (mine !== seq) return;
      note.textContent = found.problem ?? '';
      draw(found.places ?? []);
    } catch {
      if (mine !== seq) return;
      // Silent on purpose. The box still works; it just is not helping.
      close();
    }
  };

  input.addEventListener('input', () => {
    chosen = { placeId: null, lat: null, lng: null };
    note.textContent = '';
    clearTimeout(timer);
    // A quarter of a second after somebody stops, not on every letter. Each
    // call is a request to Google and Google is billed.
    timer = setTimeout(look, 250);
  });

  input.addEventListener('keydown', (event) => {
    const options = [...list.querySelectorAll('.place-option')];
    if (!options.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      at = (at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options.forEach((o, i) => o.classList.toggle('is-at', i === at));
      options[at].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && at >= 0) {
      event.preventDefault();
      options[at].click();
    } else if (event.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 150));
  return state;
}

/** A token tying one session of typing to the one place picked at the end. */
function newSession() {
  return crypto.randomUUID?.() ?? String(Math.random()).slice(2);
}
