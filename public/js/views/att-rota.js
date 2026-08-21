import { api } from '../api.js';
import {
  fmtDayShort, h, mount, shiftDay, toast, todayISO,
} from '../util.js';
import { card, emptyState, table } from './components.js';
import { navigate, replaceParams } from '../app.js';
import {
  byDepartment, field, formDialog, shiftHours, shiftLabel, shiftSelect,
  shiftColour,
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
  const span = [7, 14, 28].includes(Number(params.span)) ? Number(params.span) : 14;
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
        'A rota needs shifts to put on it. Create them in Attendance setup — a shift is a name, '
        + 'a start and an end, and how much lateness you are prepared to overlook.',
      ),
    );
    return host;
  }

  // Pending edits, held until Save. A request per cell would make filling in a
  // fortnight on a phone a hundred round trips.
  const pending = new Map();

  // Whether any of them touched a day staff had already been promised. If so,
  // saving is not the end of it: the grid goes dashed where they are looking,
  // and the honest next step is to offer republication — loudly or quietly,
  // but asked, not assumed.
  let editedPublished = false;
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

            // A published day was changed, so somewhere a person is planning
            // around a version that no longer exists. Offer to put that right
            // now rather than leaving it dashed until somebody remembers.
            if (editedPublished) {
              await offerRepublish(from, to);
            }
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
    const lines = found.findings
      .map((f) => `${f.title}. ${f.detail}${f.law ? ` (${f.law})` : ''}`)
      .join('\n');
    return h('button.rota-strain', {
      type: 'button',
      title: `${lines}\n\nOpen Workload for the whole picture.`,
      'aria-label': `${found.count} workload warning${found.count === 1 ? '' : 's'}`,
      onclick: () => navigate('att-workload', { from, to }),
    }, found.level === 'high' ? '🔴' : '🟠');
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

    const paint = (el) => {
      const chosen = shiftById.get(String(el.value));
      // Zero is "no shift", which is the absence of a colour rather than one
      // of them: a rest day should read as empty, not as a ninth shift.
      el.dataset.shiftColour = chosen ? String(shiftColour(chosen)) : '0';
    };

    // The border is the publication state, exactly as a member of staff will
    // read it: dashed is still a draft, solid is the version they may plan
    // their lives around. A pattern day was never individually decided, so it
    // stays dashed and faint.
    const select = h('select.rota-cell', {
      class: [
        entry.explicit ? 'rota-set' : 'rota-pattern',
        entry.explicit ? (entry.published ? 'rota-published' : 'rota-draft') : '',
      ].filter(Boolean).join(' '),
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

        editedPublished = editedPublished || entry.published === true;
        pending.set(`${row.staff.id}|${entry.day}`, value === 'pattern'
          ? { staffId: row.staff.id, day: entry.day, clear: true }
          : { staffId: row.staff.id, day: entry.day, shiftId: value === '' ? null : Number(value) });
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
    cells.set(`${row.staff.id}|${entry.day}`, { select, syncHours });
    return h('div.rota-cellwrap',
      select,
      avail
        ? h('small.rota-avail', {
          class: avail.status === 'preferred' ? 'rota-avail-pref' : '',
          title: avail.note
            ? `${avail.status === 'preferred' ? 'Asked for this day' : 'Cannot work this day'}: ${avail.note}`
            : (avail.status === 'preferred' ? 'Asked for this day' : 'Cannot work this day'),
        }, avail.status === 'preferred' ? '★ asked for' : '✕ unavailable')
        : hours,
    );
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
      title: `${row.staff.name} — fill the row`,
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
      pending.set(`${row.staff.id}|${entry.day}`, {
        staffId: row.staff.id, day: entry.day, shiftId,
      });
      touched += 1;
    }

    if (!touched) toast('Those days are all on approved leave — nothing changed.', 'bad');
    refreshSaveBar();
  };

  // The key. Only the shifts actually on this fortnight's grid, in the order
  // the grid groups them — a legend listing all twenty-four when six are in
  // use is a legend nobody reads twice.
  const onScreen = new Map();
  for (const row of data.rows ?? []) {
    for (const entry of row.days ?? []) {
      const shift = entry.shift_id == null ? null : shiftById.get(String(entry.shift_id));
      if (shift && !onScreen.has(shift.id)) onScreen.set(shift.id, shift);
    }
  }

  const legend = onScreen.size
    ? h('div.shift-key',
      byDepartment([...onScreen.values()]).flatMap((group) => group.shifts.map((shift) => h(
        'span.shift-key-item',
        { title: `${shift.name}${shift.department ? ` · ${shift.department}` : ''}` },
        h('span.shift-key-swatch', { style: { '--shift': `var(--c${shiftColour(shift)})` } }),
        h('span', shift.name),
        h('span.shift-key-hours', shiftHours(shift)),
      ))))
    : null;

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
      h('tfoot',
        // The totals a rota exists to get right, department by department —
        // "is anybody on Security on Sunday" is the question, and it is not
        // asked by reading twenty-four unsorted lines. Zero on a day somebody
        // is needed is the one thing worth shouting about, so it is the only
        // thing that changes colour.
        byDepartment(data.shifts.filter((s) => s.active !== 0)).map((group) => [
          h('tr.rota-total.rota-dept',
            h('td', { colspan: data.days.length + 2 }, h('small', group.name)),
          ),
          ...group.shifts.map((shift) => h('tr.rota-total',
            h('td',
              h('small', shift.name),
              h('small.muted', { style: { marginLeft: '.4rem' } }, shiftHours(shift)),
            ),
            h('td'),
            ...data.days.map((day) => {
              const n = data.coverage.find((c) => c.day === day)?.counts?.[shift.id] ?? 0;
              return h('td', { class: isWeekend(day) ? 'rota-weekend' : '' },
                h('span', { class: n ? '' : 'rota-gap' }, String(n)));
            }),
          )),
        ]),
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
   * The same window turned sideways: rows are shifts, cells are who is on
   * them. The question this view answers is "who is opening on Saturday",
   * which the people view makes somebody read twenty-four rows for.
   *
   * Read-only on purpose, for now: assignment stays where the dropdowns and
   * the save bar already are, and a second editable surface would be a second
   * set of half-finished edits.
   */
  const positionsGrid = h('div.table-wrap',
    h('table.rota-table.rota-positions',
      h('thead', h('tr',
        h('th', 'Shift'),
        ...data.days.map((day) => h('th',
          { class: dayClass(day) },
          h('div', new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })),
          h('small.muted', fmtDayShort(day)),
        )),
      )),
      h('tbody', byDepartment(data.shifts.filter((sh) => sh.active !== 0
        && (!params.department || (sh.department || '') === params.department)))
        .flatMap((group) => [
          h('tr.rota-dept', h('td', { colspan: data.days.length + 1 }, h('small', group.name))),
          ...group.shifts.map((shift) => h('tr',
            h('td',
              h('div.shift-key-item',
                h('span.shift-key-swatch', { style: { '--shift': `var(--c${shiftColour(shift)})` } }),
                h('span', shift.name)),
              h('small.muted', shiftHours(shift)),
            ),
            ...data.days.map((day) => {
              const on = visible.filter((row) => {
                const entry = row.days.find((d) => d.day === day);
                return entry && !entry.leave && String(entry.shift_id) === String(shift.id);
              });
              return h('td', { class: dayClass(day) },
                on.length
                  ? h('div.rota-names', on.map((row) => h('small', row.staff.name.split(' ')[0])))
                  : h('span.rota-gap-soft', '—'));
            }),
          )),
        ])),
    ),
  );

  // Days somebody decided and nobody has yet published. Counted over the
  // whole window, not the filtered rows: Publish covers the window.
  const unpublished = data.rows.reduce(
    (n, row) => n + row.days.filter((d) => d.explicit && d.published === false).length, 0,
  );

  const conflicts = Object.keys(strain?.rows ?? {}).length;

  const publish = async () => {
    const done = await formDialog({
      title: `Publish ${fmtDayShort(from)} – ${fmtDayShort(to)}`,
      submitLabel: 'Publish',
      body: h('div',
        h('p.muted',
          `${unpublished} decided day${unpublished === 1 ? '' : 's'} in this window `
          + 'still dashed. Publishing turns them solid — the version people plan their '
          + 'lives around.'),
        field('Who is told', h('select', { name: 'notify' },
          h('option', { value: 'yes' }, 'Everybody — ring the bell and send the mail'),
          h('option', { value: 'no' }, 'Nobody — publish quietly'),
        ), 'Quietly is for a typo fixed five minutes after the real publication. '
          + 'Either way the log records which this was.'),
      ),
      onSubmit: async (form) => api.attPublishRoster({
        from, to, notify: form.get('notify') !== 'no',
      }),
    });
    if (done) {
      toast(done.published
        ? `${done.published} day${done.published === 1 ? '' : 's'} published${done.notified ? ' — everybody told' : ', quietly'}.`
        : 'Everything here was already published.', 'good');
      await reload();
    }
  };

  const seg = (options, chosen, onPick) => h('div.seg',
    options.map(([value, label]) => h('button', {
      class: String(chosen) === String(value) ? 'active' : '',
      onclick: () => onPick(value),
    }, label)));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Rota'),
        h('div.sub', 'Dashed is a draft; solid has been published. Grey days are already behind you.'),
      ),
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

    h('div.toolbar',
      conflicts
        ? h('button.btn-sm', {
          onclick: () => navigate('att-workload', { from, to }),
          title: 'People this plan is overworking — the full picture is on Workload',
        }, `⚠️ ${conflicts} ${conflicts === 1 ? 'person' : 'people'} to look at`)
        : null,
      h('div', { style: { flex: 1 } }),
      view === 'people'
        ? h('button.btn-sm', { onclick: () => copyWeek(data, reload) }, 'Copy a week →')
        : null,
      h('button.btn.btn-primary', {
        onclick: publish,
        disabled: !unpublished,
        title: unpublished ? '' : 'Nothing here is waiting to be published',
      }, unpublished ? `Publish [${unpublished}]` : 'Published ✓'),
    ),

    saveBar,
    view === 'people' ? importCard(imported?.draft ?? null, data.rows.map((r) => r.staff), reload) : null,
    card(
      span === 7 ? 'One week' : span === 28 ? 'Four weeks' : 'Two weeks',
      {
        note: view === 'people'
          ? `${visible.length}${visible.length !== data.rows.length ? ` of ${data.rows.length}` : ''} people`
          : 'who is on each shift',
        wide: true,
      },
      legend,
      view === 'people' ? grid : positionsGrid,
    ),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'A day set to Off is a rostered rest day — a decision, and not the same as somebody simply not '
      + 'being on the rota. Days covered by approved leave cannot be edited here; cancel the leave first.'),
  );

  return host;
}

/**
 * A published day was just edited: offer to republish, and ask who is told.
 *
 * Asked every time rather than remembered, because "quietly" that becomes a
 * default is how staff end up planning around a rota that changed under them
 * with nobody ever choosing that.
 */
async function offerRepublish(from, to) {
  const done = await formDialog({
    title: 'You changed a published day',
    submitLabel: 'Publish again',
    body: h('div',
      h('p.muted',
        'Somebody may already be planning around the old version. Publishing again makes the '
        + 'change official — or press Cancel to leave it as a draft and publish later.'),
      field('Who is told', h('select', { name: 'notify' },
        h('option', { value: 'yes' }, 'Everybody — ring the bell and send the mail'),
        h('option', { value: 'no' }, 'Nobody — publish quietly'),
      ), 'Quietly is for a typo. A moved shift deserves the bell.'),
    ),
    onSubmit: async (form) => api.attPublishRoster({
      from, to, notify: form.get('notify') !== 'no',
    }),
  });
  if (done?.published) {
    toast(`Republished${done.notified ? ' — everybody told' : ', quietly'}.`, 'good');
  }
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
    title: `${row.staff.name} — days they cannot work`,
    submitLabel: 'Save',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Tick the days. This is not leave — nothing is approved and no entitlement is spent. '
        + 'The mark shows in the cell, and rostering over it is still possible: some conflicts '
        + 'are deliberate, and the grid shows them rather than hiding them.'),
      h('div.avail-days', data.days.map((day) => h('label.tickline',
        h('input', {
          type: 'checkbox', name: 'day', value: day,
          checked: marked.has(day),
        }),
        h('span', fmtDayShort(day),
          marked.get(day)?.note ? h('small.muted', ` — ${marked.get(day).note}`) : null),
      ))),
      field('Kind', h('select', { name: 'status' },
        h('option', { value: 'unavailable' }, 'Cannot work'),
        h('option', { value: 'preferred' }, 'Asked to work'),
      )),
      field('Why', h('input', {
        type: 'text', name: 'note', maxlength: 200,
        placeholder: 'Daughter’s graduation',
      }), 'Kept with the mark, shown on hover'),
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
    title: `${row.staff.name} — usual pattern`,
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
function importCard(draft, staff, reload) {
  const picker = h('input', {
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
        toast('Read. Nothing has been changed yet — check it below.', 'good');
        await reload();
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });

  if (!draft) {
    return card('Import a week', {
      note: 'From the scheduling export',
      wide: true,
      actions: h('button.btn.btn-primary', { onclick: () => picker.click() }, 'Choose a file'),
    },
      picker,
      h('p.muted',
        'Nothing is written when you choose a file. It is read, matched against your staff and '
        + 'shifts, and held as a draft so you can see exactly what it would do before agreeing '
        + 'to any of it.'),
      h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
        'A CSV export or a printed schedule as a PDF. The CSV is the surer of the two — it says '
        + 'what it means — while a PDF has to be read off the printed grid, so check the draft '
        + 'against the printout before confirming. A PDF printed from a phone is usually a '
        + 'picture with no text in it and cannot be read at all; print it from a computer.'),
    );
  }

  const c = draft.counts;
  const skipped = draft.rows.filter((r) => r.action === 'skip');

  const confirm = async () => {
    if (c.undecided) {
      toast('Answer the questions below first — nothing is applied while one is open.', 'bad');
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
    note: `${draft.filename || 'Uploaded file'} — ${fmtDayShort(draft.from)} to ${fmtDayShort(draft.to)}`,
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
            + 'Check them against the printout before confirming — particularly anybody whose '
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
          + 'and in every import after it — or leave them, and they stay out.'),
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
            r.action === 'create-shift' ? h('small.muted', 'new — created on confirm') : null),
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
      title: `${q.startsAt}–${q.endsAt} — no shift with these hours`,
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
          + (n.minutesApart ? ` — ${n.minutesApart} min different` : ' — same hours'))),
        h('option', { value: 'create' }, '＋ Create a new shift for these hours'),
        h('option', { value: 'skip' }, 'Leave these lines out'))),

        h('div', { 'data-new-name': '', style: { display: 'none' } },
          field('Call it', h('input', {
            type: 'text', name: 'name', maxlength: 60, value: q.suggestedName || '',
          }), 'Break and grace start at the defaults — set them on the shift afterwards')),

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
      `Hours with no shift — ${draft.shiftQuestions.length} to decide`),
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
