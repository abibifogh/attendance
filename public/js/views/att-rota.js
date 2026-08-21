import { api } from '../api.js';
import {
  fmtDayShort, h, mount, shiftDay, toast, todayISO,
} from '../util.js';
import { card, emptyState, table } from './components.js';
import { navigate, replaceParams } from '../app.js';
import {
  asHours, byDepartment, field, formDialog, shiftColour, shiftHours, shiftLabel,
  shiftMinutes, shiftSelect,
} from './att-shared.js';

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

  // One week to plan a busy weekend, a fortnight for the ordinary rhythm,
  // four weeks to see a rotation come round. The span is the window and
  // nothing else changes with it.
  const span = [7, 14, 28].includes(Number(params.span)) ? Number(params.span) : 7;
  const view = params.view === 'positions' ? 'positions' : 'people';
  const from = mondayOf(params.from || todayISO());
  const to = shiftDay(from, span - 1);

  const [data, imported, strain] = await Promise.all([
    api.attRoster(from, to),
    api.attRotaImport().catch(() => ({ draft: null })),
    // Read beside the rota rather than on a screen somebody has to remember to
    // open: the moment to notice that a plan gives Kofi eleven days straight
    // is while it is still a plan. Never allowed to stop the rota loading — a
    // rota that will not open because an advisory figure failed is a worse
    // problem than the one it was warning about.
    api.attWorkloadRota(from, to).catch(() => ({ rows: {} })),
  ]);

  const reload = async (next = {}) => {
    const merged = {
      from,
      span: String(span),
      view,
      department: params.department || null,
      tag: params.tag || null,
      ...next,
    };
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
        'A rota needs shifts to put on it. Create them in Attendance setup: a shift is a name, '
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
            // Saved is not published. The count on the Publish button at the
            // top of the page goes up, and one press at the end sends the lot.
            // Asking after every single edit is how a planner learns to press
            // through the question without reading it.
            toast(`${pending.size} change${pending.size === 1 ? '' : 's'} saved. `
              + 'Publish when you are happy with the week.', 'good');
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

  const shiftById = new Map(data.shifts.map((s) => [String(s.id), s]));

  /**
   * A mark against the name of anybody the plan is overworking.
   *
   * One character, with the whole reason on hover and in its title so a phone
   * can reach it by press-and-hold. Deliberately small: the rota's job is
   * still the rota, and a banner would push the grid off the screen to say
   * something the Workload tab says properly.
   */
  const strainMark = (staffId) => {
    const found = strain?.rows?.[staffId];
    if (!found) return null;

    // Four at most. The mark is meant to be glanced at, and a list of eleven
    // is a screen of its own — which is what Workload is for.
    const shown = found.findings.slice(0, 4);

    return h('span.rota-strain-wrap',
      h('button.rota-strain', {
        type: 'button',
        'aria-label': `${found.count} workload warning${found.count === 1 ? '' : 's'}`,
        onclick: () => navigate('att-workload', { from, to }),
      }, found.level === 'high' ? '🔴' : '🟠'),

      h('div.rota-strain-pop', { role: 'tooltip' },
        h('ul', shown.map((f) => h('li',
          h('strong', f.title),
          f.detail ? h('div', f.detail) : null,
          f.law ? h('div.law', f.law) : null))),
        h('p.more', found.findings.length > shown.length
          ? `and ${found.findings.length - shown.length} more. Open Workload for the whole picture.`
          : 'Open Workload for the whole picture.')),
    );
  };

  const cell = (row, entry) => {
    if (entry.leave) {
      return h('div.rota-locked', { title: 'Approved leave' }, 'Leave');
    }

    // "Cannot work this day", said before the dropdown so the planner reads it
    // before choosing. Rostering over it stays possible — some conflicts are
    // deliberate — and the mark stays put so the grid shows the conflict
    // rather than pretending it cannot happen.
    const avail = entry.availability;

    const { own, other } = shiftsFor(data.shifts, row.staff.department);

    const opt = (shift) => h('option', {
      value: shift.id, selected: String(shift.id) === String(entry.shift_id),
    }, shiftLabel(shift));

    // Whatever is already on the day is always offered, even when it belongs to
    // another department. A cover shift somebody arranged last week must not
    // vanish from the dropdown just because it is out of department — the
    // select would fall back to its first option and quietly propose undoing it.
    const outside = entry.shift_id != null
      && other.find((sh) => String(sh.id) === String(entry.shift_id));

    const expand = other.length
      ? h('option', { value: EXPAND }, `⋯ other departments (${other.length})`)
      : null;

    // The hours of whatever is currently chosen, spelled out under the cell.
    // The dropdown carries them too, but a closed select shows one truncated
    // line, and the times are the half of it worth reading — "Housekeeper
    // Helper" is four shifts on this property and only the clock tells them
    // apart.
    const hours = h('small.rota-hours');
    const syncHours = () => {
      const chosen = shiftById.get(String(select.value));
      hours.textContent = chosen ? shiftHours(chosen) : '';
      hours.className = `rota-hours${chosen ? '' : ' rota-hours-off'}`;
      paint(select);
    };

    // The wrapper is the card: it carries the colour, the draft or published
    // border, and the two lines of text. The select inside it stays plain, so
    // picking a shift still works exactly as before.
    const wrap = h('div.rota-cellwrap', {
      class: [
        entry.explicit ? 'rota-set' : 'rota-pattern',
        entry.explicit ? (entry.published ? 'rota-published' : 'rota-draft') : '',
      ].filter(Boolean).join(' '),
    });

    const paint = () => {
      const chosen = shiftById.get(String(select.value));
      wrap.dataset.shiftColour = chosen ? String(shiftColour(chosen)) : '0';
      // The card shows the name and the hours line under it shows the clock,
      // so the chosen option drops its hours. Every other option keeps them,
      // because the open list is where two Housekeeper Helpers are told apart.
      for (const option of select.options) {
        const shift = shiftById.get(String(option.value));
        if (!shift) continue;
        option.textContent = option.selected ? shift.name : shiftLabel(shift);
      }
    };

    // What this cell would save. Built from whatever is on screen rather than
    // from the change that triggered it, so setting a title does not undo a
    // shift picked a moment earlier and vice versa.
    const stage = (value) => {
      pending.set(`${row.staff.id}|${entry.day}`, value === 'pattern'
        ? { staffId: row.staff.id, day: entry.day, clear: true }
        : {
          staffId: row.staff.id,
          day: entry.day,
          shiftId: value === '' ? null : Number(value),
          title: entry.title || null,
        });
    };

    // An optional name for this one day. The shift says what hours somebody
    // works; this says what they are doing in them — "Stock take", "Cover for
    // Ama". Faint and empty until there is one, so a grid of ninety cells does
    // not read as ninety captions waiting to be written.
    const titleButton = h('button.rota-title', {
      type: 'button',
      title: 'A name for this shift, if it needs one',
      onclick: async () => {
        const got = await formDialog({
          title: `${row.staff.name}, ${fmtDayShort(entry.day)}`,
          submitLabel: 'Use it',
          body: h('div',
            field('Name for this shift', h('input', {
              type: 'text', name: 'title', maxlength: 60, value: entry.title ?? '',
              placeholder: 'Stock take',
            }), 'Optional. Shown on the card and nowhere else'),
          ),
          onSubmit: async (form) => ({ title: (form.get('title') || '').trim() }),
        });
        if (!got) return;
        entry.title = got.title || null;
        syncTitle();
        stage(select.value);
        select.classList.add('rota-dirty');
        refreshSaveBar();
      },
    });

    const syncTitle = () => {
      const chosen = shiftById.get(String(select.value));
      titleButton.textContent = entry.title || '+ name';
      titleButton.classList.toggle('rota-title-empty', !entry.title);
      // A rest day is not doing anything, so there is nothing to call it.
      titleButton.style.display = chosen ? '' : 'none';
    };

    const select = h('select.rota-cell', {
      title: entry.holiday ? `Public holiday: ${entry.holiday}` : undefined,
      onchange: (e) => {
        const value = e.target.value;

        // Not a choice of shift — a request to see the rest of them. Put the
        // value back where it was so nothing is recorded as changed, and add
        // the other departments under headings of their own rather than in one
        // lump of nineteen.
        if (value === EXPAND) {
          e.target.remove(e.target.selectedIndex);
          for (const group of byDepartment(other)) {
            e.target.append(h('optgroup', { label: group.name }, group.shifts.map(opt)));
          }
          e.target.value = entry.shift_id == null ? '' : String(entry.shift_id);
          return;
        }

        stage(value);
        e.target.classList.add('rota-dirty');
        syncHours();
        refreshSaveBar();
      },
    },
      h('option', { value: '', selected: entry.shift_id == null && entry.explicit }, 'Off'),
      outside ? opt(outside) : null,
      // Their own department needs no heading — it is the whole list until
      // somebody asks for more.
      own.map(opt),
      // Only offered where an override exists to remove.
      entry.source === 'roster' ? h('option', { value: 'pattern' }, '↺ Use pattern') : null,
      expand,
    );

    syncHours();
    syncTitle();
    cells.set(`${row.staff.id}|${entry.day}`, {
      select,
      syncHours: () => { syncHours(); syncTitle(); },
    });

    const availWindow = avail?.from ? ` ${avail.from} to ${avail.to}` : '';
    // Element.append() writes the string "null" for a null child, unlike the
    // h() helper, so only real nodes go in.
    const parts = [select, hours, titleButton];
    if (avail) {
      parts.push(h('small.rota-avail', {
        class: avail.status === 'preferred' ? 'rota-avail-pref' : '',
        title: [
          avail.status === 'preferred' ? 'Asked to work' : 'Cannot work',
          availWindow || ' this day',
          avail.note ? `: ${avail.note}` : '',
        ].join(''),
      }, avail.status === 'preferred'
        ? `★ asked${availWindow}`
        : `✕ off${availWindow}`));
    }
    wrap.append(...parts);
    return wrap;
  };

  /**
   * Put one shift across every day on screen for one person.
   *
   * The commonest thing anybody does to a fortnight, and eighteen dropdowns
   * otherwise. Days covered by approved leave are skipped rather than
   * overwritten — the leave was a decision, and this is not.
   */
  const fillRow = async (row) => {
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    // Every day, because filling the lot is the commonest use and unticking
    // two is quicker than ticking five.
    const picked = new Set([0, 1, 2, 3, 4, 5, 6]);

    const choice = await formDialog({
      title: `Fill the row for ${row.staff.name}`,
      submitLabel: 'Fill those days',
      body: h('div',
        h('p.muted', `${fmtDayShort(data.from)} to ${fmtDayShort(data.to)}. Days already covered by `
          + 'approved leave are left as they are.'),
        field('Put them on', scopedShiftSelect(data.shifts, row.staff.department, '', { name: 'shiftId' }),
          'Leave blank to make the chosen days rest days'),
        field('On these days', h('div.btn-row', { style: { flexWrap: 'wrap' } },
          names.map((label, dow) => h('label', {
            style: {
              display: 'inline-flex', alignItems: 'center', gap: '.3rem',
              padding: '.25rem .5rem', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', fontSize: '.85rem',
            },
          },
          h('input', {
            type: 'checkbox',
            checked: true,
            onchange: (e) => (e.target.checked ? picked.add(dow) : picked.delete(dow)),
          }),
          label))),
        'Applies to every one of those weekdays in the fortnight shown'),
      ),
      onSubmit: async (form) => ({ shiftId: form.get('shiftId'), days: [...picked] }),
    });
    if (!choice) return;

    if (!choice.days.length) {
      toast('No days ticked, so nothing changed.', 'bad');
      return;
    }

    const shiftId = choice.shiftId === '' ? null : Number(choice.shiftId);
    const wanted = new Set(choice.days);
    let touched = 0;

    for (const entry of row.days) {
      if (entry.leave) continue;
      // Monday-first, to match the tick boxes and the grid.
      if (!wanted.has((new Date(`${entry.day}T12:00:00Z`).getUTCDay() + 6) % 7)) continue;
      const found = cells.get(`${row.staff.id}|${entry.day}`);
      if (!found) continue;

      // A cell only lists this person's own department until somebody asks for
      // more, so filling a row with a cover shift from elsewhere would set a
      // value the dropdown has no option for — which silently falls back to Off
      // while the change queued underneath says otherwise. Add the option.
      const chosen = shiftId == null ? null : shiftById.get(String(shiftId));
      if (chosen && !found.select.querySelector(`option[value="${shiftId}"]`)) {
        found.select.append(h('option', { value: chosen.id }, shiftLabel(chosen)));
      }

      found.select.value = shiftId == null ? '' : String(shiftId);
      found.select.classList.add('rota-dirty');
      found.syncHours();
      // The title belongs to the day, not to the shift, so filling a row with
      // a different shift leaves "Stock take" where somebody wrote it.
      pending.set(`${row.staff.id}|${entry.day}`, {
        staffId: row.staff.id, day: entry.day, shiftId, title: entry.title || null,
      });
      touched += 1;
    }

    if (!touched) toast('Those days are all on approved leave, so nothing changed.', 'bad');
    refreshSaveBar();
  };

  // Which rows this view shows. Filtering is by person — a department, a tag —
  // and never changes what Save or Publish covers: the window is the window.
  const visible = data.rows.filter((row) => {
    if (params.department && (row.staff.department || '') !== params.department) return false;
    if (params.tag && !(row.staff.tags ?? []).includes(params.tag)) return false;
    return true;
  });

  const dayClass = (day) => [
    isWeekend(day) ? 'rota-weekend' : '',
    day < data.today ? 'rota-past' : '',
    day === data.today ? 'rota-today' : '',
  ].filter(Boolean).join(' ');

  const headRow = h('tr',
    h('th', 'Name'),
    h('th', 'Pattern'),
    ...data.days.map((day) => h('th',
      { class: dayClass(day) },
      h('div', new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })),
      h('small.muted', fmtDayShort(day)),
    )),
  );

  const grid = h('div.table-wrap',
    h('table.rota-table',
      h('thead', headRow),
      h('tbody', visible.map((row) => h('tr',
        h('td',
          h('div', row.staff.name, strainMark(row.staff.id)),
          h('small.muted', row.staff.department || `No. ${row.staff.employee_no}`),
          row.staff.tags?.length
            ? h('div.rota-tags', row.staff.tags.map((t) => h('span.rota-tag', t)))
            : null,
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
            h('button.btn-sm', {
              title: 'Days they cannot work, or asked for',
              onclick: () => editAvailability(row, data, reload),
            }, '✕'),
          ),
        ),
        ...row.days.map((entry) => h('td', { class: dayClass(entry.day) }, cell(row, entry))),
      ))),
    ),
  );

  /**
   * The same window turned sideways: rows are positions, cells are the shifts
   * standing on them and who is working each one.
   *
   * The question this answers is "who is opening on Saturday", which the
   * people view makes somebody read twenty-four rows for. Each card carries
   * the shift, its clock, how long it is and whose it is, and each group says
   * how many people it uses and how many hours it costs.
   *
   * Editable here too. A card opens on whoever is working it and can be handed
   * to somebody else or emptied; the gap under a shift takes a name. Both go
   * through the same pending list and the same Save as the people view, so
   * there is only ever one set of unsaved changes.
   */
  const positionsBody = h('tbody');

  const staffById = new Map(data.rows.map((row) => [String(row.staff.id), row]));

  /** The cell for one person on one day, wherever the view is looking at it. */
  const entryOf = (staffId, day) => staffById.get(String(staffId))?.days
    .find((d) => d.day === day) ?? null;

  /**
   * Put somebody on a shift, or take them off it, from the position view.
   *
   * The staged change is the same shape the dropdowns produce, because it is
   * the same rota: one person, one day, one shift.
   */
  const assign = (staffId, day, shiftId, title = undefined) => {
    const entry = entryOf(staffId, day);
    if (!entry) return;
    entry.shift_id = shiftId;
    entry.explicit = true;
    entry.published = false;
    if (title !== undefined) entry.title = title || null;
    pending.set(`${staffId}|${day}`, {
      staffId: Number(staffId), day, shiftId, title: entry.title || null,
    });
    drawPositions();
    refreshSaveBar();
  };

  /** Everybody who could take a shift on a day, and what stands in the way. */
  const candidates = (day, exceptStaffId = null) => visible
    .map((row) => ({ row, entry: entryOf(row.staff.id, day) }))
    .filter(({ row, entry }) => entry && String(row.staff.id) !== String(exceptStaffId))
    .map(({ row, entry }) => ({
      row,
      entry,
      blocked: entry.leave
        ? 'on leave'
        : entry.availability?.status === 'unavailable'
          ? `cannot work${entry.availability.from ? ` ${entry.availability.from}–${entry.availability.to}` : ''}`
          : null,
      busy: entry.shift_id != null
        ? shiftById.get(String(entry.shift_id))?.name ?? 'another shift'
        : null,
    }));

  /** Hand one card to somebody else, or empty it. */
  const editCard = async (shift, day, staffId) => {
    const row = staffById.get(String(staffId));
    const entry = entryOf(staffId, day);
    const options = candidates(day, staffId);

    const done = await formDialog({
      title: `${shift.name}, ${fmtDayShort(day)}`,
      submitLabel: 'Apply',
      body: h('div',
        h('p.muted', `${row.staff.name} is on this. ${shiftHours(shift)}, `
          + `${asHours(shiftMinutes(shift))}.`),
        field('Who works it', h('select', { name: 'staffId' },
          h('option', { value: String(staffId), selected: true }, `${row.staff.name} (as now)`),
          h('option', { value: '' }, 'Nobody — take this shift off the day'),
          options.map(({ row: other, blocked, busy }) => h('option', {
            value: String(other.staff.id), disabled: Boolean(blocked),
          }, `${other.staff.name}${blocked ? ` — ${blocked}` : busy ? ` — on ${busy}` : ''}`)),
        ), 'Somebody already on another shift that day is moved onto this one'),
        field('Name for this shift', h('input', {
          type: 'text', name: 'title', maxlength: 60, value: entry?.title ?? '',
          placeholder: 'Optional. Stock take',
        })),
      ),
      onSubmit: async (form) => ({
        staffId: form.get('staffId'),
        title: (form.get('title') || '').trim(),
      }),
    });
    if (!done) return;

    if (String(done.staffId) === String(staffId)) {
      assign(staffId, day, shift.id, done.title);
      return;
    }
    // Off this person either way. A shift handed on is a shift they are not
    // working, and that is a decision rather than a gap in the pattern.
    assign(staffId, day, null);
    if (done.staffId) assign(done.staffId, day, shift.id, done.title);
  };

  /** Fill a gap: put somebody on this shift on this day. */
  const addToCell = async (shift, day) => {
    const options = candidates(day);
    const free = options.filter((o) => !o.blocked && o.busy == null);
    const taken = options.filter((o) => !o.blocked && o.busy != null);

    const done = await formDialog({
      title: `Put somebody on ${shift.name}`,
      submitLabel: 'Put them on',
      body: h('div',
        h('p.muted', `${fmtDayShort(day)}. ${shiftHours(shift)}, ${asHours(shiftMinutes(shift))}.`),
        field('Who', h('select', { name: 'staffId', required: true },
          h('option', { value: '' }, 'Choose…'),
          free.length
            ? h('optgroup', { label: 'Free that day' },
              free.map((o) => h('option', { value: String(o.row.staff.id) }, o.row.staff.name)))
            : null,
          taken.length
            ? h('optgroup', { label: 'Already on something' },
              taken.map((o) => h('option', { value: String(o.row.staff.id) },
                `${o.row.staff.name} — on ${o.busy}`)))
            : null,
        ), 'People on leave or marked unavailable are left out'),
        field('Name for this shift', h('input', {
          type: 'text', name: 'title', maxlength: 60, placeholder: 'Optional. Stock take',
        })),
      ),
      onSubmit: async (form) => ({
        staffId: form.get('staffId'),
        title: (form.get('title') || '').trim(),
      }),
    });
    if (!done?.staffId) return;
    assign(done.staffId, day, shift.id, done.title);
  };

  /** One person's card on one shift on one day. */
  const shiftCard = (shift, day, row, entry) => h('button.pos-card', {
    type: 'button',
    class: entry.published === false ? 'rota-draft' : 'rota-published',
    'data-shift-colour': String(shiftColour(shift)),
    title: `${row.staff.name} — ${shift.name}, ${shiftHours(shift)}`,
    onclick: () => editCard(shift, day, row.staff.id),
  },
  entry.title ? h('span.pos-card-title', entry.title) : null,
  h('span.pos-card-shift', shift.name),
  h('span.pos-card-clock', `${shiftHours(shift)} · ${asHours(shiftMinutes(shift))}`),
  h('span.pos-card-who', row.staff.name));

  function drawPositions() {
    const groups = byDepartment(data.shifts.filter((sh) => sh.active !== 0
      && (!params.department || (sh.department || '') === params.department)));

    mount(positionsBody, groups.flatMap((group) => {
      // What this group costs the week: the hours standing on it, and how many
      // different people it takes to cover them.
      const people = new Set();
      let minutes = 0;
      for (const shift of group.shifts) {
        for (const day of data.days) {
          for (const row of visible) {
            const entry = entryOf(row.staff.id, day);
            if (!entry || entry.leave) continue;
            if (String(entry.shift_id) !== String(shift.id)) continue;
            people.add(row.staff.id);
            minutes += shiftMinutes(shift);
          }
        }
      }

      return [
        h('tr.rota-dept', h('td', { colspan: data.days.length + 1 },
          h('div.pos-group',
            h('strong', group.name),
            h('small.muted', `${people.size} ${people.size === 1 ? 'person' : 'people'} · `
              + `${asHours(minutes)} rostered`)))),

        ...group.shifts.map((shift) => h('tr',
          h('td.pos-shift',
            h('div.shift-key-item',
              h('span.shift-key-swatch', { style: { '--shift': `var(--c${shiftColour(shift)})` } }),
              h('span', shift.name)),
            h('small.muted', `${shiftHours(shift)} · ${asHours(shiftMinutes(shift))}`)),

          ...data.days.map((day) => {
            const on = visible
              .map((row) => ({ row, entry: entryOf(row.staff.id, day) }))
              .filter(({ entry }) => entry && !entry.leave
                && String(entry.shift_id) === String(shift.id));

            return h('td', { class: dayClass(day) },
              h('div.pos-stack',
                on.map(({ row, entry }) => shiftCard(shift, day, row, entry)),
                h('button.pos-add', {
                  type: 'button',
                  title: `Put somebody on ${shift.name} on ${fmtDayShort(day)}`,
                  onclick: () => addToCell(shift, day),
                }, '+')));
          }))),
      ];
    }));
  }

  const positionsGrid = h('div.table-wrap',
    h('table.rota-table.rota-positions',
      h('thead', h('tr',
        h('th', 'Position'),
        ...data.days.map((day) => h('th',
          { class: dayClass(day) },
          h('div', new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })),
          h('small.muted', fmtDayShort(day)),
        )),
      )),
      positionsBody,
    ),
  );

  if (view === 'positions') drawPositions();

  // What pressing Publish would do, counted by the server over the whole
  // window rather than over the filtered rows. A count that moved when
  // somebody picked a department would be lying about what the button does.
  const fresh = Number(data.publish?.fresh ?? 0);
  const again = Number(data.publish?.again ?? 0);
  const unpublished = fresh + again;

  const conflicts = Object.keys(strain?.rows ?? {}).length;

  const publish = async () => {
    const tally = (n, label) => h('div.publish-tally',
      h('strong', String(n)), h('span', label));

    const choice = (value, label, detail, checked = false) => h('label.answer-choice',
      h('input', { type: 'radio', name: 'notify', value, checked, required: true }),
      h('span', h('strong', label), detail ? h('small.muted', detail) : null));

    const done = await formDialog({
      title: 'Publish the rota',
      submitLabel: 'Publish',
      body: h('div',
        h('p', 'Shifts in the current timeline:',
          h('br'),
          h('strong', `${fmtDayShort(from)} – ${fmtDayShort(to)}`)),

        // The two numbers apart, because they mean different things. New days
        // are news; changed ones are a promise being remade, and somebody may
        // already have arranged their week around the version being replaced.
        h('div.publish-tallies',
          tally(fresh, fresh === 1 ? 'New shift' : 'New shifts'),
          tally(again, again === 1 ? 'Changed shift' : 'Changed shifts')),

        h('h3.publish-heading', 'Who is told'),
        h('div.answer-choices',
          choice('staff', 'Tell the staff it affects', ' — the usual answer', true),
          choice('everyone', 'Tell everybody', ' — managers and staff alike'),
          choice('none', 'Publish quietly', ' — nobody is told; suits a corrected typo'),
        ),

        field('Anything to say with it', h('textarea', {
          name: 'message', rows: 3, maxlength: 500,
          placeholder: 'Optional. Easter cover — the Saturday split is deliberate.',
        })),
      ),
      onSubmit: async (form) => api.attPublishRoster({
        from, to, notify: form.get('notify'), message: form.get('message') || null,
      }),
    });

    if (!done) return;
    toast(done.published
      ? `${done.published} shift${done.published === 1 ? '' : 's'} published`
        + `${done.notified === 'none' ? ', quietly' : ' and people told'}.`
      : 'Everything here was already published.', 'good');
    await reload();
  };

  // Top right of the page, beside the title, and it stays there. A planner
  // works down the grid and the running count of what is not yet promised is
  // the one number they need in view the whole time.
  const publishButton = h('button.btn.btn-primary.rota-publish', {
    onclick: publish,
    disabled: !unpublished,
    title: unpublished
      ? `${fresh} new, ${again} changed`
      : 'Nothing here is waiting to be published',
  }, unpublished
    ? h('span', 'Publish', h('span.rota-publish-count', String(unpublished)))
    : 'Published ✓');

  const seg = (options, chosen, onPick) => h('div.seg',
    options.map(([value, label]) => h('button', {
      class: String(chosen) === String(value) ? 'active' : '',
      onclick: () => onPick(value),
    }, label)));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Rota'),
        h('div.sub', 'Dashed is a draft, solid is published. Grey days are behind you.'),
      ),
      publishButton,
    ),

    h('div.toolbar',
      seg([['people', 'People'], ['positions', 'Positions']], view, (v) => reload({ view: v })),
      seg([['7', 'Week'], ['14', 'Fortnight'], ['28', '4 weeks']], span, (v) => reload({ span: v })),
      h('button.btn-sm', { onclick: () => reload({ from: shiftDay(from, -span) }) }, '‹'),
      // The calendar. The browser's own — it opens a month view on press,
      // which is the picker the request asked for without a second widget to
      // maintain — and whatever day is chosen snaps to its Monday.
      h('input', {
        type: 'date', value: from, 'aria-label': 'Week beginning',
        onchange: (e) => e.target.value && reload({ from: mondayOf(e.target.value) }),
      }),
      h('button.btn-sm', { onclick: () => reload({ from: shiftDay(from, span) }) }, '›'),
      h('button.btn-sm', { onclick: () => reload({ from: mondayOf(todayISO()) }) }, 'Today'),

      h('div', { style: { flex: 1 } }),

      data.departments?.length
        ? h('select', {
          'aria-label': 'Department',
          onchange: (e) => reload({ department: e.target.value || null }),
        },
        h('option', { value: '' }, 'Every department'),
        data.departments.map((d) => h('option', { value: d, selected: params.department === d }, d)))
        : null,
      data.tags?.length
        ? h('select', {
          'aria-label': 'Tag',
          onchange: (e) => reload({ tag: e.target.value || null }),
        },
        h('option', { value: '' }, 'Any tag'),
        data.tags.map((t) => h('option', { value: t, selected: params.tag === t }, t)))
        : null,
    ),

    conflicts || view === 'people'
      ? h('div.toolbar',
        conflicts
          ? h('button.btn-sm', {
            onclick: () => navigate('att-workload', { from, to }),
            title: 'People this plan is overworking. The full picture is on Workload',
          }, `⚠️ ${conflicts} ${conflicts === 1 ? 'person' : 'people'} to look at`)
          : null,
        h('div', { style: { flex: 1 } }),
        view === 'people'
          ? h('button.btn-sm', { onclick: () => copyWeek(data, reload) }, 'Copy a week')
          : null,
        view === 'people' ? importButton(reload) : null,
      )
      : null,

    saveBar,
    // Only when a draft is actually waiting. The empty pitch that used to sit
    // here pushed the rota below the fold to describe a button.
    view === 'people' && imported?.draft
      ? importCard(imported.draft, data.rows.map((r) => r.staff), reload)
      : null,
    card(
      span === 7 ? 'One week' : span === 28 ? 'Four weeks' : 'Two weeks',
      {
        note: view === 'people'
          ? `${visible.length}${visible.length !== data.rows.length ? ` of ${data.rows.length}` : ''} people`
          : 'who is on each shift',
        wide: true,
      },
      view === 'people' ? grid : positionsGrid,
    ),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Off means a rostered rest day. Days on approved leave are locked here; cancel the leave first.'),
  );

  return host;
}

/**
 * Days somebody cannot work, or asked for, in the window on screen.
 *
 * Not leave: nothing is approved and nothing is spent. It is the fact the
 * planner needs in front of them before the dropdown, written down where the
 * rota will actually show it.
 */
async function editAvailability(row, data, reload) {
  const marked = new Map(row.days
    .filter((d) => d.availability)
    .map((d) => [d.day, d.availability]));

  const done = await formDialog({
    title: `When ${row.staff.name} cannot work`,
    submitLabel: 'Save',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'This is not leave. Nothing is approved and no days are spent. The mark simply shows '
        + 'in the cell so you see it before picking a shift.'),
      h('div.avail-days', data.days.map((day) => h('label.tickline',
        h('input', {
          type: 'checkbox', name: 'day', value: day,
          checked: marked.has(day),
        }),
        h('span', fmtDayShort(day),
          marked.get(day)?.note ? h('small.muted', ` (${marked.get(day).note})`) : null),
      ))),
      field('Kind', h('select', { name: 'status' },
        h('option', { value: 'unavailable' }, 'Cannot work'),
        h('option', { value: 'preferred' }, 'Asked to work'),
      )),
      h('div.field-row',
        field('From', h('input', { type: 'time', name: 'fromTime' }),
          'Leave both empty for the whole day'),
        field('Until', h('input', { type: 'time', name: 'toTime' })),
      ),
      field('Why', h('input', {
        type: 'text', name: 'note', maxlength: 200,
        placeholder: 'Clinic until noon',
      }), 'Shown when you hover the mark'),
    ),
    onSubmit: async (form) => {
      const chosen = form.getAll('day');
      const before = [...marked.keys()];
      const cleared = before.filter((d) => !chosen.includes(d));
      if (cleared.length) {
        await api.attSetAvailability({ staffId: row.staff.id, days: cleared, clear: true });
      }
      if (chosen.length) {
        return api.attSetAvailability({
          staffId: row.staff.id,
          days: chosen,
          status: form.get('status'),
          note: form.get('note') || null,
          fromTime: form.get('fromTime') || null,
          toTime: form.get('toTime') || null,
        });
      }
      return { ok: true };
    },
  });

  if (done) { toast('Saved.', 'good'); await reload(); }
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
        h('option', { value: '2', selected: true }, 'Two weeks'),
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
  let weeks = Math.max(1, Number(row.rotationWeeks) || 1);

  const valueAt = (week, dow) => {
    const forWeek = row.pattern?.[week] ?? row.pattern?.[String(week)] ?? {};
    return forWeek[dow] ?? forWeek[String(dow)] ?? '';
  };

  // Rebuilt rather than hidden when the cycle length changes: three weeks of
  // dropdowns that are secretly still holding a fourth week's answers is how a
  // rota ends up saying something nobody chose.
  const weekBlocks = h('div');
  const drawWeeks = () => {
    mount(weekBlocks, Array.from({ length: weeks }, (_, week) => h('div',
      weeks > 1
        ? h('h4', { style: { margin: '.9rem 0 .3rem', fontSize: '.9rem' } }, `Week ${week + 1}`)
        : null,
      h('div.field-row', days.map((label, dow) => field(
        label,
        scopedShiftSelect(shifts, row.staff.department, valueAt(week, dow), { name: `w${week}d${dow}` }),
      ))),
    )));
  };
  drawWeeks();

  const done = await formDialog({
    title: `${row.staff.name}'s usual pattern`,
    submitLabel: 'Save the pattern',
    body: h('div',
      field('Repeats every',
        h('select', {
          name: 'rotationWeeks',
          onchange: (e) => { weeks = Number(e.target.value) || 1; drawWeeks(); },
        }, [1, 2, 3, 4, 5, 6, 8, 12].map((n) => h('option', {
          value: n, selected: n === weeks,
        }, n === 1 ? 'Same every week' : `${n} weeks`))),
        'Pick the number of weeks before the pattern starts again'),
      h('p.muted', { style: { fontSize: '.85rem' } },
        'A blank day is a rest day. Any single day can still be changed on the rota itself '
        + 'without disturbing the pattern.'),
      weekBlocks,
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Weeks are counted from a fixed Monday, so week 1 always lands on the same weeks of the '
        + 'year for everybody. If somebody’s cycle comes out a week out of step, shift their '
        + 'weeks round by one rather than changing the dates.'),
    ),
    onSubmit: async (form) => {
      const chosen = Number(form.get('rotationWeeks')) || 1;
      const pattern = {};
      for (let week = 0; week < chosen; week += 1) {
        pattern[week] = {};
        for (let dow = 0; dow < 7; dow += 1) {
          const value = form.get(`w${week}d${dow}`);
          pattern[week][dow] = value === '' || value == null ? null : Number(value);
        }
      }
      return api.attSavePattern({ staffId: row.staff.id, rotationWeeks: chosen, pattern });
    },
  });

  if (done) {
    toast(
      weeks > 1
        ? `${row.staff.name}'s ${weeks}-week rotation saved.`
        : `${row.staff.name}'s usual week saved.`,
      'good',
    );
    await reload();
  }
}

const EXPAND = '__all__';

/**
 * The shifts worth putting in front of somebody.
 *
 * This property runs twenty-four shifts and nobody works more than a handful of
 * them. A housekeeper's dropdown offering Bar, Security and three Maintenance
 * rotas is not neutral — it is where the wrong pick comes from, on a screen
 * whose whole job is picking quickly across a fortnight of cells.
 *
 * So their own department comes first and the rest are one click away rather
 * than gone: covering another department is a normal thing to need and an
 * unusual thing to want by accident, which is exactly the shape of a dropdown
 * that has to be asked for.
 *
 * Somebody with no department, or a department with no shifts of its own, gets
 * everything — a short list is only an improvement while it contains the answer.
 */
function shiftsFor(shifts, department) {
  const active = (shifts ?? []).filter((s) => s.active !== 0);
  if (!department) return { own: active, other: [] };

  const own = active.filter((s) => (s.department || '') === department);
  if (!own.length) return { own: active, other: [] };

  return { own, other: active.filter((s) => (s.department || '') !== department) };
}

/**
 * A shift dropdown for one person, their own department grouped first.
 *
 * A dialog can afford the whole list where a grid cell cannot — there is one of
 * it, and it is open deliberately — so nothing is hidden here. The grouping is
 * enough: the five shifts they might actually work sit at the top under their
 * own department, and the other nineteen are below under theirs.
 */
function scopedShiftSelect(shifts, department, selected, props = {}) {
  const { own, other } = shiftsFor(shifts, department);
  if (!other.length) return shiftSelect(own, selected, props);

  const opt = (s) => h('option', {
    value: s.id, selected: String(s.id) === String(selected),
  }, shiftLabel(s));

  return h('select', props,
    h('option', { value: '' }, '—'),
    h('optgroup', { label: department }, own.map(opt)),
    // The rest under their own departments rather than one heading reading
    // "other": nineteen shifts in a lump is the list this grouping exists to
    // avoid, and putting it behind a heading does not make it shorter.
    byDepartment(other).map((g) => h('optgroup', { label: g.name }, g.shifts.map(opt))),
  );
}

function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return shiftDay(day, -((d.getUTCDay() + 6) % 7));
}

function isWeekend(day) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Importing a week from the scheduling export.
 *
 * Two steps, and the gap between them is the feature. The file is read and
 * resolved against the staff and shifts this property actually has, and what it
 * *would* do sits on the screen until somebody agrees. The rota decides who is
 * late and who is absent, so an import that writes first and reports afterwards
 * is one nobody dares run a second time.
 *
 * Discarding costs nothing, which is what makes trying it safe.
 */
/** One shared file picker: reads the export, holds it as a draft. */
function importPicker(reload) {
  return h('input', {
    type: 'file',
    accept: '.csv,.pdf,text/csv,application/pdf',
    style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      // Cleared straight away, so choosing the same file twice after fixing
      // something in it still fires a change.
      e.target.value = '';
      if (!file) return;

      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      try {
        const payload = isPdf
          ? { pdf: await asBase64(file), filename: file.name }
          : { csv: await file.text(), filename: file.name };
        await api.attRotaImportPreview(payload);
        toast('File read. Check the draft before confirming it.', 'good');
        await reload();
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });
}

/**
 * The way in for a CSV or PDF export. A button, not a card: the card version
 * spent two paragraphs above the rota describing a file picker.
 */
function importButton(reload) {
  const picker = importPicker(reload);
  return h('span',
    picker,
    h('button.btn-sm', {
      title: 'CSV or PDF from the scheduling export. Nothing is written until you confirm the draft.',
      onclick: () => picker.click(),
    }, 'Import'),
  );
}

function importCard(draft, staff, reload) {
  const picker = importPicker(reload);

  const c = draft.counts;
  const skipped = draft.rows.filter((r) => r.action === 'skip');

  const confirm = async () => {
    if (c.undecided) {
      toast('Answer the questions below first. Nothing is applied while one is open.', 'bad');
      return;
    }
    if (!window.confirm(
      `Write ${c.ready} rostered days for ${c.people} people, ${fmtDayShort(draft.from)} to `
      + `${fmtDayShort(draft.to)}?\n\nAnything already on those days is replaced.`,
    )) return;
    try {
      const done = await api.attRotaImportConfirm();
      toast(`${done.applied} days written${done.newShifts ? `, ${done.newShifts} shift added` : ''}.`, 'good');
      await reload({ from: mondayOf(draft.from), to: shiftDay(mondayOf(draft.from), 13) });
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const discard = async () => {
    if (!window.confirm('Throw this draft away? Nothing has been written, so nothing is lost.')) return;
    await api.attRotaImportDiscard();
    toast('Discarded.');
    await reload();
  };

  const nameFor = async (unknown) => {
    const done = await formDialog({
      title: `Who is "${unknown}"?`,
      submitLabel: 'That is them',
      body: h('div',
        h('p.muted',
          'The scheduling system spells some names differently. Say who this is once and it will '
          + 'be recognised in every import from now on.'),
        field('This is', h('select', { name: 'staffId', required: true },
          h('option', { value: '' }, 'Choose…'),
          staff.map((p) => h('option', { value: p.id }, `${p.name} (${p.employee_no})`)))),
      ),
      onSubmit: async (form) => api.attRotaImportName({
        alias: unknown, staffId: Number(form.get('staffId')),
      }),
    });
    if (done) { toast(`Matched to ${done.matched}.`, 'good'); await reload(); }
  };

  return card('A week is waiting', {
    note: `${draft.filename || 'Uploaded file'} · ${fmtDayShort(draft.from)} to ${fmtDayShort(draft.to)}`,
    wide: true,
    actions: h('div.btn-row',
      h('button.btn-sm', { onclick: discard }, 'Discard'),
      h('button.btn.btn-primary', {
        onclick: confirm,
        disabled: !c.ready || Boolean(c.undecided),
        title: c.undecided ? 'There are still questions to answer below' : '',
      }, c.undecided ? `${c.undecided} to decide first` : `Confirm ${c.ready} days`),
    ),
  },
    picker,

    h('div.grid.grid-4', { style: { marginBottom: '.8rem' } },
      stat('Ready to write', c.ready, `${c.people} people`),
      stat('Need a decision', c.undecided,
        c.questions ? `${c.questions} question${c.questions === 1 ? '' : 's'} below` : 'none',
        c.undecided ? 'var(--warn)' : null),
      stat('Shifts to create', c.willCreate, c.willCreate ? 'because you asked' : 'none',
        c.willCreate ? 'var(--warn)' : null),
      stat('Left out', c.skipped, c.skipped ? 'see below' : 'nothing', c.skipped ? 'var(--bad)' : null),
    ),

    h('p.muted', { style: { fontSize: '.85rem' } },
      'Nothing has been written yet, and nothing is created unless you ask for it. Confirming '
      + 'replaces whatever is on those days for these people; every other day, and everybody '
      + 'else, is untouched.'),

    // A CSV states its columns; a printed grid has to be worked out from where
    // the words sit on the page. It is right far more often than not, and the
    // one place it can be wrong — a shift read into the day beside it — is
    // invisible unless somebody is told to look.
    /\.pdf$/i.test(draft.filename || '')
      ? h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'Read off a printed schedule'),
          h('div.alert-detail',
            'The dates and hours below were worked out from where things sit on the page. '
            + 'Check them against the printout before confirming, particularly anybody whose '
            + 'name wrapped onto two lines.'),
        ))
      : null,

    shiftQuestions(draft, reload),

    draft.unknownNames.length
      ? h('div',
        h('h4', { style: { margin: '.9rem 0 .4rem', fontSize: '.92rem' } },
          'Names nobody here answers to'),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'These lines are skipped. Say who each one is and they will be matched in this draft '
          + 'and in every import after it. Or leave them, and they stay out.'),
        h('div.btn-row', { style: { flexWrap: 'wrap' } },
          draft.unknownNames.map((n) => h('button.btn-sm', { onclick: () => nameFor(n) }, `${n} →`))),
      )
      : null,

    skipped.length
      ? h('details', { style: { marginTop: '.9rem' } },
        h('summary', { style: { cursor: 'pointer', fontSize: '.88rem' } },
          `${skipped.length} skipped line${skipped.length === 1 ? '' : 's'}`),
        table([
          { key: 'line', label: 'Line', align: 'right' },
          { key: 'name', label: 'Name' },
          { key: 'day', label: 'Date', format: (v) => (v ? fmtDayShort(v) : h('span.muted', '—')) },
          { key: 'problem', label: 'Why', format: (v) => h('small', v) },
        ], skipped, { empty: 'None.' }))
      : null,

    h('details', { style: { marginTop: '.6rem' } },
      h('summary', { style: { cursor: 'pointer', fontSize: '.88rem' } },
        `All ${c.ready} days this would write`),
      table([
        { key: 'day', label: 'Date', format: (v) => fmtDayShort(v) },
        { key: 'name', label: 'From the file', format: (v) => h('small.muted', v) },
        {
          key: 'shiftName',
          label: 'Shift',
          format: (v, r) => h('div', h('div', v),
            r.action === 'create-shift' ? h('small.muted', 'new, created on confirm') : null),
        },
        { key: 'startsAt', label: 'Hours', format: (v, r) => h('small', `${v}–${r.endsAt}`) },
        { key: 'note', label: 'Note', format: (v, r) => h('small.muted', v || r.title || '') },
      ], draft.rows.filter((r) => r.action === 'roster' || r.action === 'create-shift'),
        { empty: 'Nothing.' })),
  );
}

/**
 * A file as base64, in pieces.
 *
 * `String.fromCharCode(...bytes)` on a four-megabyte PDF spreads four million
 * arguments across the stack and throws — on a big file, which is exactly the
 * one somebody is trying to upload.
 */
async function asBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function stat(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, String(value)),
    sub ? h('div.stat-sub', h('span', sub)) : null,
  );
}

/**
 * Hours the file used that this property has no shift for.
 *
 * Spelled out rather than resolved. The obvious thing to do with 05:30–11:30 on
 * a property that runs 05:00–11:30 is to fold it into the shift it was meant to
 * be, and the obvious thing for a system to do is create a second shift half an
 * hour along — after which the reports are split between two nearly identical
 * shifts and nobody notices for a month.
 *
 * So the nearest shifts are offered in order of how far away they are, creating
 * one is a deliberate act with a name typed into it, and leaving the lines out
 * is a first-class answer.
 */
function shiftQuestions(draft, reload) {
  if (!draft.shiftQuestions?.length) return null;

  const decide = async (q) => {
    const nearest = q.nearest ?? [];

    const done = await formDialog({
      title: `${q.startsAt}–${q.endsAt}: no shift with these hours`,
      submitLabel: 'Use this answer',
      body: h('div',
        h('p.muted',
          `${q.lines} line${q.lines === 1 ? '' : 's'} in the file, `
          + `${q.days.length} day${q.days.length === 1 ? '' : 's'}, `
          + `for ${q.people.join(', ')}. Filed under ${q.position || 'no position'}.`),

        field('What are these?', h('select', {
          name: 'choice',
          onchange: (e) => {
            const creating = e.target.value === 'create';
            e.target.closest('form')?.querySelector('[data-new-name]')
              ?.style.setProperty('display', creating ? '' : 'none');
          },
        },
        ...nearest.map((n) => h('option', { value: `use:${n.id}` },
          `${n.name} (${n.startsAt}–${n.endsAt})`
          + (n.minutesApart ? ` (${n.minutesApart} min different)` : ' (same hours)'))),
        h('option', { value: 'create' }, '＋ Create a new shift for these hours'),
        h('option', { value: 'skip' }, 'Leave these lines out'))),

        h('div', { 'data-new-name': '', style: { display: 'none' } },
          field('Call it', h('input', {
            type: 'text', name: 'name', maxlength: 60, value: q.suggestedName || '',
          }), 'Break and grace start at the defaults. Set them on the shift afterwards')),

        h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'The nearest shifts are listed first. A few minutes\u2019 difference is usually somebody '
          + 'typing the wrong time rather than a shift you do not have.'),
      ),
      onSubmit: async (form) => {
        const choice = form.get('choice');
        if (choice === 'skip') {
          return api.attRotaImportShift({ startsAt: q.startsAt, endsAt: q.endsAt, choice: 'skip' });
        }
        if (choice === 'create') {
          return api.attRotaImportShift({
            startsAt: q.startsAt, endsAt: q.endsAt, choice: 'create', name: form.get('name'),
          });
        }
        return api.attRotaImportShift({
          startsAt: q.startsAt,
          endsAt: q.endsAt,
          choice: 'existing',
          shiftId: Number(String(choice).slice(4)),
        });
      },
    });

    if (done) { toast('Noted.', 'good'); await reload(); }
  };

  return h('div', { style: { margin: '.9rem 0' } },
    h('h4', { style: { margin: '0 0 .4rem', fontSize: '.92rem' } },
      `Hours with no shift: ${draft.shiftQuestions.length} to decide`),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'Nothing is created for these unless you say so, and the lines using them stay out of the '
      + 'rota until each one is answered.'),

    draft.shiftQuestions.map((q) => h('div.alert.warn', { style: { alignItems: 'center' } },
      h('span.alert-icon', '⚠️'),
      h('div', { style: { flex: 1 } },
        h('div.alert-title', `${q.startsAt}–${q.endsAt}`),
        h('div.alert-detail',
          `${q.lines} line${q.lines === 1 ? '' : 's'} · ${q.people.join(', ')}`
          + (q.nearest?.[0]
            ? ` · closest is ${q.nearest[0].name} (${q.nearest[0].startsAt}–${q.nearest[0].endsAt})`
            : '')),
      ),
      h('button.btn-sm.btn-primary', { onclick: () => decide(q) }, 'Decide'),
    )),
  );
}
