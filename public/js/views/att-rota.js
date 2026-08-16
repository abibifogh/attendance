import { api } from '../api.js';
import {
  fmtDayShort, h, mount, shiftDay, toast, todayISO,
} from '../util.js';
import { card, emptyState } from './components.js';
import { replaceParams } from '../app.js';
import { field, formDialog, shiftSelect } from './att-shared.js';

/**
 * The rota.
 *
 * The screen somebody opens once a week, so it is built for the way a rota is
 * actually made: last week, with a few changes. Copying a week is one press;
 * filling one person's fortnight is one more; and the totals along the bottom
 * answer the question the grid otherwise hides — is anybody on nights on Sunday.
 *
 * Two layers underneath, and the difference between them is the whole design. A
 * standing weekly pattern says what somebody normally works — set once, and for
 * a fixed rota that is the end of it. The grid overrides it for one specific
 * day, which is what a swap, a cover or a one-off double writes.
 *
 * A cell showing a shift in grey is following the pattern; the same cell in
 * black has been set by hand. Without that distinction, "I gave him Thursday
 * off" and "the pattern never had him working Thursday" look identical, and
 * they are not — one of them is a decision somebody made.
 */
export async function renderAttRota(params) {
  const host = h('div');
  const from = params.from || mondayOf(todayISO());
  const to = params.to || shiftDay(from, 13);
  const data = await api.attRoster(from, to);

  const reload = async (next = {}) => {
    const merged = { from, to, ...next };
    replaceParams('att-rota', merged);
    mount(host, await renderAttRota(merged));
  };

  if (!data.rows.length) {
    mount(host,
      h('div.page-head', h('h1', 'Rota')),
      emptyState('No staff yet', 'Add people in Attendance setup and they will appear here.'),
    );
    return host;
  }

  if (!data.shifts.length) {
    mount(host,
      h('div.page-head', h('h1', 'Rota')),
      emptyState(
        'No shifts defined',
        'A rota needs shifts to put on it. Create them in Attendance setup — a shift is a name, '
        + 'a start and an end, and how much lateness you are prepared to overlook.',
      ),
    );
    return host;
  }

  // Pending edits, held until Save. A request per cell would make filling in a
  // fortnight on a phone a hundred round trips.
  const pending = new Map();
  const saveBar = h('div.toolbar.rota-savebar', { style: { display: 'none' } });

  const refreshSaveBar = () => {
    const count = pending.size;
    saveBar.style.display = count ? '' : 'none';
    mount(saveBar,
      h('strong', `${count} change${count === 1 ? '' : 's'} not saved`),
      h('div', { style: { flex: 1 } }),
      h('button.btn-sm', { onclick: () => reload() }, 'Discard'),
      h('button.btn.btn-primary', {
        onclick: async () => {
          try {
            await api.attSaveRoster({ entries: [...pending.values()] });
            toast(`${pending.size} change${pending.size === 1 ? '' : 's'} saved.`, 'good');
            pending.clear();
            await reload();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      }, 'Save the rota'),
    );
  };

  // Every editable cell, so filling a row can set them in place rather than
  // redrawing a grid somebody is halfway through editing.
  const cells = new Map();

  const cell = (row, entry) => {
    const select = h('select.rota-cell', {
      class: entry.explicit ? 'rota-set' : 'rota-pattern',
      title: entry.holiday ? `Public holiday: ${entry.holiday}` : undefined,
      disabled: Boolean(entry.leave),
      onchange: (e) => {
        const value = e.target.value;
        pending.set(`${row.staff.id}|${entry.day}`, value === 'pattern'
          ? { staffId: row.staff.id, day: entry.day, clear: true }
          : { staffId: row.staff.id, day: entry.day, shiftId: value === '' ? null : Number(value) });
        e.target.classList.add('rota-dirty');
        refreshSaveBar();
      },
    },
      h('option', { value: '', selected: entry.shift_id == null && entry.explicit }, 'Off'),
      ...data.shifts.map((s) => h('option', {
        value: s.id, selected: String(s.id) === String(entry.shift_id),
      }, s.name)),
      // Only offered where an override exists to remove.
      entry.source === 'roster' ? h('option', { value: 'pattern' }, '↺ Use pattern') : null,
    );

    if (entry.leave) {
      return h('div.rota-locked', { title: 'Approved leave' }, 'Leave');
    }
    cells.set(`${row.staff.id}|${entry.day}`, select);
    return select;
  };

  /**
   * Put one shift across every day on screen for one person.
   *
   * The commonest thing anybody does to a fortnight, and eighteen dropdowns
   * otherwise. Days covered by approved leave are skipped rather than
   * overwritten — the leave was a decision, and this is not.
   */
  const fillRow = async (row) => {
    const choice = await formDialog({
      title: `${row.staff.name} — every day shown`,
      submitLabel: 'Fill the row',
      body: h('div',
        h('p.muted', `${fmtDayShort(data.from)} to ${fmtDayShort(data.to)}. Days already covered by `
          + 'approved leave are left as they are.'),
        field('Put them on', shiftSelect(data.shifts, '', { name: 'shiftId' }),
          'Leave blank for a rest day every day'),
      ),
      onSubmit: async (form) => ({ shiftId: form.get('shiftId') }),
    });
    if (!choice) return;

    const shiftId = choice.shiftId === '' ? null : Number(choice.shiftId);
    for (const entry of row.days) {
      if (entry.leave) continue;
      const select = cells.get(`${row.staff.id}|${entry.day}`);
      if (!select) continue;
      select.value = shiftId == null ? '' : String(shiftId);
      select.classList.add('rota-dirty');
      pending.set(`${row.staff.id}|${entry.day}`, {
        staffId: row.staff.id, day: entry.day, shiftId,
      });
    }
    refreshSaveBar();
  };

  const grid = h('div.table-wrap',
    h('table.rota-table',
      h('thead', h('tr',
        h('th', 'Name'),
        h('th', 'Pattern'),
        ...data.days.map((day) => h('th',
          { class: isWeekend(day) ? 'rota-weekend' : '' },
          h('div', new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })),
          h('small.muted', fmtDayShort(day)),
        )),
      )),
      h('tfoot',
        // The totals a rota exists to get right. Zero on a day somebody is
        // needed is the one thing worth shouting about, so it is the only thing
        // that changes colour.
        data.shifts.map((shift) => h('tr.rota-total',
          h('td', h('small', shift.name)),
          h('td'),
          ...data.days.map((day) => {
            const n = data.coverage.find((c) => c.day === day)?.counts?.[shift.id] ?? 0;
            return h('td', { class: isWeekend(day) ? 'rota-weekend' : '' },
              h('span', { class: n ? '' : 'rota-gap' }, String(n)));
          }),
        )),
        h('tr.rota-total',
          h('td', h('small.muted', 'Off / on leave')),
          h('td'),
          ...data.days.map((day) => {
            const c = data.coverage.find((x) => x.day === day);
            return h('td', { class: isWeekend(day) ? 'rota-weekend' : '' },
              h('small.muted', `${c?.off ?? 0}${c?.onLeave ? ` · ${c.onLeave}L` : ''}`));
          }),
        ),
      ),
      h('tbody', data.rows.map((row) => h('tr',
        h('td',
          h('div', row.staff.name),
          h('small.muted', row.staff.department || `No. ${row.staff.employee_no}`),
        ),
        h('td',
          h('div.btn-row',
            h('button.btn-sm', {
              title: 'What this person normally works each week',
              onclick: () => editPattern(row, data.shifts, reload),
            }, row.hasPattern ? 'Pattern' : 'Set'),
            h('button.btn-sm', {
              title: 'Put one shift across every day shown',
              onclick: () => fillRow(row),
            }, '⇢'),
          ),
        ),
        ...row.days.map((entry) => h('td', { class: isWeekend(entry.day) ? 'rota-weekend' : '' }, cell(row, entry))),
      ))),
    ),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Rota'),
        h('div.sub', 'Who is working which shift. Grey follows the standing pattern; black was set by hand.'),
      ),
    ),
    h('div.toolbar',
      h('button.btn-sm', { onclick: () => reload({ from: shiftDay(from, -14), to: shiftDay(to, -14) }) }, '‹ Earlier'),
      h('input', {
        type: 'date', value: from,
        onchange: (e) => e.target.value && reload({ from: mondayOf(e.target.value), to: shiftDay(mondayOf(e.target.value), 13) }),
      }),
      h('button.btn-sm', { onclick: () => reload({ from: shiftDay(from, 14), to: shiftDay(to, 14) }) }, 'Later ›'),
      h('button.btn-sm', {
        onclick: () => reload({ from: mondayOf(todayISO()), to: shiftDay(mondayOf(todayISO()), 13) }),
      }, 'This fortnight'),
      h('div', { style: { flex: 1 } }),
      h('button.btn.btn-primary', { onclick: () => copyWeek(data, reload) }, 'Copy a week →'),
    ),
    saveBar,
    card('Two weeks', { note: `${data.rows.length} people`, wide: true }, grid),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'A day set to Off is a rostered rest day — a decision, and not the same as somebody simply not '
      + 'being on the rota. Days covered by approved leave cannot be edited here; cancel the leave first.'),
  );

  return host;
}

/**
 * Copy a week onto the weeks on screen.
 *
 * Defaults to the week before the one being viewed, because "same as last week"
 * is what most weeks are. Leave already approved in the target weeks survives
 * it, and a day the standing pattern already covers goes back to following the
 * pattern rather than being pinned — otherwise one press would turn the whole
 * grid black and the distinction the screen rests on would be gone.
 */
async function copyWeek(data, reload) {
  const target = data.from;
  const suggested = shiftDay(target, -7);

  const done = await formDialog({
    title: 'Copy a week',
    submitLabel: 'Copy it across',
    body: h('div',
      h('p.muted', 'Most weeks are last week with two changes. Copy, then fix the two.'),
      h('div.field-row',
        field('Copy from the week beginning', h('input', {
          type: 'date', name: 'from', value: suggested, required: true,
        })),
        field('Onto the week beginning', h('input', {
          type: 'date', name: 'to', value: target, required: true,
        })),
      ),
      field('How many weeks', h('select', { name: 'weeks' },
        h('option', { value: '1' }, 'One week'),
        h('option', { value: '2', selected: true }, 'Two weeks — the whole fortnight shown'),
        h('option', { value: '4' }, 'Four weeks'),
      )),
      h('p.muted', { style: { fontSize: '.82rem' } },
        'Approved leave in the weeks being written to is never overwritten. Anything else '
        + 'in those weeks is replaced.'),
    ),
    onSubmit: async (form) => api.attCopyRoster({
      from: form.get('from'),
      to: form.get('to'),
      weeks: Number(form.get('weeks')),
    }),
  });

  if (done) {
    toast(`${done.copied} day${done.copied === 1 ? '' : 's'} copied`
      + `${done.skippedLeave ? `, ${done.skippedLeave} left as leave` : ''}.`, 'good');
    await reload();
  }
}

/**
 * The standing weekly pattern for one person.
 *
 * Seven dropdowns. Leaving one blank means a rest day; the pattern always says
 * something about all seven, because a pattern with holes is a pattern nobody
 * can reason about.
 */
async function editPattern(row, shifts, reload) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const selects = days.map((label, dow) => field(
    label,
    shiftSelect(shifts, row.pattern[dow] ?? row.pattern[String(dow)] ?? '', { name: `d${dow}` }),
  ));

  const done = await formDialog({
    title: `${row.staff.name} — usual week`,
    submitLabel: 'Save the pattern',
    body: h('div',
      h('p.muted', 'What this person normally works. Any day can still be changed on the rota itself.'),
      h('div.field-row', selects),
    ),
    onSubmit: async (form) => {
      const pattern = {};
      for (let dow = 0; dow < 7; dow++) {
        const value = form.get(`d${dow}`);
        pattern[dow] = value === '' ? null : Number(value);
      }
      return api.attSavePattern({ staffId: row.staff.id, pattern });
    },
  });

  if (done) {
    toast(`${row.staff.name}'s usual week saved.`, 'good');
    await reload();
  }
}

function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return shiftDay(day, -((d.getUTCDay() + 6) % 7));
}

function isWeekend(day) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}
