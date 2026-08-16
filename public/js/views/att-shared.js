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

export function shiftSelect(shifts, selected, props = {}) {
  return h('select', props,
    h('option', { value: '' }, '—'),
    (shifts ?? []).filter((s) => s.active).map((s) =>
      h('option', {
        value: s.id,
        selected: String(s.id) === String(selected),
      }, `${s.name} (${s.starts_at}–${s.ends_at})`)),
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
