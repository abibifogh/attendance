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
 * Two layers, and the difference between them is the whole design. A standing
 * weekly pattern says what somebody normally works — set once, and most people
 * never need anything else. The grid below overrides it for one specific day,
 * which is what a swap, a cover or a one-off double writes.
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
    return select;
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
      h('tbody', data.rows.map((row) => h('tr',
        h('td',
          h('div', row.staff.name),
          h('small.muted', row.staff.department || `No. ${row.staff.employee_no}`),
        ),
        h('td',
          h('button.btn-sm', {
            onclick: () => editPattern(row, data.shifts, reload),
          }, row.hasPattern ? 'Edit' : 'Set'),
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
