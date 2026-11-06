import { api } from '../api.js';
import { confirmAction, h, mount, toast } from '../util.js';
import { field, formDialog } from './att-shared.js';

/**
 * Settings › Rota & clocking › Duties.
 *
 * Jobs added to a shift somebody already has: staff lunch, the common areas,
 * the laundry. Each is set up once here: whose people it goes to, the shifts
 * that are already it, when it must be ready, what it involves, and whether
 * a day without it should be flagged.
 */
export async function renderDutySetup() {
  const host = h('div.duty-setup');
  const data = await api.attDutySetup().catch((err) => ({ error: err.message }));
  if (data.error) { mount(host, h('p.muted', data.error)); return host; }
  const reload = async () => mount(host, ...(await renderDutySetup()).childNodes);
  const shiftName = (id) => data.shifts.find((s) => Number(s.id) === Number(id))?.name;

  const covered = (d) => {
    const names = d.shiftIds.map(shiftName).filter(Boolean);
    return names.length ? `By the ${names.join(', ')} shift${names.length === 1 ? '' : 's'}; otherwise added to one` : 'Always added to a shift';
  };

  mount(host,
    h('p.muted', { style: { marginTop: 0 } },
      'Jobs added to a shift somebody already has. They show as a tag on that shift on the rota and on '
      + 'the person’s own shifts, never as a shift of their own: no second card, no second clock-in.'),
    h('div.table-wrap', h('table.data',
      h('thead', h('tr', h('th', 'Duty'), h('th', 'Department'), h('th', 'Covered'), h('th', 'Every day'), h('th', ''))),
      h('tbody', data.duties.length
        ? data.duties.map((d) => h('tr', { class: d.active ? '' : 'muted' },
          h('td', h('strong', d.name), d.active ? null : h('small.muted', ' (switched off)')),
          h('td', d.department || 'Anybody'),
          h('td', covered(d)),
          h('td', d.needsDaily ? 'Flagged when nobody has it' : 'Only when given'),
          h('td', h('div.btn-row', { style: { margin: 0, flexWrap: 'nowrap' } },
            h('button.btn-sm', { type: 'button', onclick: async () => { if (await editDuty(d, data)) await reload(); } }, 'Edit'),
            h('button.btn-sm', {
              type: 'button',
              title: 'Only a duty never given to anybody. Otherwise switch it off.',
              onclick: async () => {
                if (!confirmAction(`Delete ${d.name}?`)) return;
                try { await api.attDeleteDuty(d.id); toast('Deleted.'); await reload(); } catch (err) { toast(err.message, 'bad'); }
              },
            }, 'Delete')))))
        : h('tr', h('td', { colspan: 5 }, h('span.muted', 'No duties yet.')))))),
    h('div.btn-row', h('button.btn.btn-primary', {
      type: 'button',
      onclick: async () => { if (await editDuty(null, data)) await reload(); },
    }, '+ Add a duty')),
  );
  return host;
}

async function editDuty(duty, data) {
  const d = duty ?? {
    name: '', department: data.departments[0] ?? null, shiftIds: [], kind: null, readyBy: null,
    beforeOnly: false, stepsText: '', needsDaily: true, tellBefore: true, fair: true, active: true,
  };
  const picked = new Set(d.shiftIds.map(Number));
  const dept = h('select', { name: 'department' },
    h('option', { value: '', selected: !d.department }, 'Anybody on the rota'),
    data.departments.map((x) => h('option', { value: x, selected: x === d.department }, x)));
  const shiftList = h('div.duty-shift-list');
  const drawShifts = () => {
    const only = dept.value;
    mount(shiftList, data.shifts
      .filter((s) => !only || s.department === only || picked.has(Number(s.id)))
      .map((s) => h('label.tickline',
        h('input', {
          type: 'checkbox', checked: picked.has(Number(s.id)),
          onchange: (e) => (e.target.checked ? picked.add(Number(s.id)) : picked.delete(Number(s.id))),
        }),
        h('span', `${s.name} `, h('small.muted', `${s.starts_at}–${s.ends_at}`)))));
  };
  dept.addEventListener('change', drawShifts);
  drawShifts();
  const tick = (name, checked, title, hint) => h('label.tickline',
    h('input', { type: 'checkbox', name, checked }),
    h('span', h('strong', title), h('br'), h('small.muted', hint)));

  const out = await formDialog({
    title: duty ? `Edit ${duty.name}` : 'Add a duty',
    submitLabel: 'Save',
    wide: true,
    body: h('div',
      h('div.field-row',
        field('Name', h('input', { type: 'text', name: 'name', maxlength: 60, value: d.name, required: true, placeholder: 'Staff lunch' })),
        field('Given to people in', dept),
        field('Ready by', h('input', { type: 'time', name: 'readyBy', value: d.readyBy ?? '' }), 'Optional')),
      h('div.field',
        h('span', { style: { display: 'block' } }, 'Shifts that are this duty already'),
        h('small.muted', { style: { display: 'block', marginBottom: '.3rem' } },
          'Whoever is on one of these has it by their own shift, and nobody needs to be given it that day.'),
        shiftList),
      field('What they do', h('textarea', { name: 'steps', rows: 3, maxlength: 1200, placeholder: 'One line per thing to do' }, d.stepsText ?? ''),
        'Shown on their shift and ticked off on the phone'),
      h('div.field',
        tick('needsDaily', d.needsDaily, 'Flag a day nobody has it', 'Red on the rota’s duty row, so it is seen before the week goes out.'),
        tick('beforeOnly', d.beforeOnly, 'Only people on by the ready time', 'Somebody starting after it is due is not offered it.'),
        tick('tellBefore', d.tellBefore, 'Tell them the evening before', 'With their shift, at 18:00, on their phone.'),
        tick('fair', d.fair, 'Share it out fairly', 'Fill the week gives each empty day to whoever has had it least this month.'),
        tick('lunch', d.kind === 'lunch', 'This is staff lunch', 'Tells whoever has it how many are eating, from the Lunch list.'),
        duty ? tick('active', d.active, 'Switched on', 'Off hides it from the rota. What was given stays on record.') : null),
    ),
    onSubmit: async (form) => {
      const body = {
        name: form.get('name'),
        department: form.get('department') || null,
        readyBy: form.get('readyBy') || null,
        shiftIds: [...picked],
        steps: form.get('steps') || '',
        needsDaily: form.get('needsDaily') === 'on',
        beforeOnly: form.get('beforeOnly') === 'on',
        tellBefore: form.get('tellBefore') === 'on',
        fair: form.get('fair') === 'on',
        kind: form.get('lunch') === 'on' ? 'lunch' : null,
        active: duty ? form.get('active') === 'on' : true,
      };
      return duty ? api.attUpdateDuty(duty.id, body) : api.attCreateDuty(body);
    },
  });
  if (out) toast('Saved.', 'good');
  return out;
}
