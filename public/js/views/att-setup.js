import { api } from '../api.js';
import { replaceParams, warnBeforeLeaving } from '../app.js';
import {
  confirmAction, fmtDay, fmtNum, h, mount, toast, todayISO, watchForm,
} from '../util.js';
import { bulkUpload, card, emptyState, table } from './components.js';
import {
  byPosition, field, formDialog, fullDayIsOwn, shiftColour, shiftColourPicker, shiftMinutes,
} from './att-shared.js';

/**
 * Attendance setup.
 *
 * Six things, each done rarely and each with a way of going quietly wrong:
 * people (whose employee number must match the terminal exactly), shifts (which
 * decide what "late" means), what absences cost, public holidays, the terminals
 * themselves, and the handful of rules that apply to all of it.
 */

const TABS = [
  ['company', 'Company'],
  ['staff', 'Staff'],
  ['shifts', 'Shifts'],
  ['reasons', 'Absence reasons'],
  ['holidays', 'Public holidays'],
  ['devices', 'Terminals'],
  ['rules', 'Rules'],
  ['workload', 'Workload'],
  ['tax', 'Tax and SSNIT'],
  ['birthdays', 'Birthdays'],
];

export async function renderAttSetup(params) {
  const host = h('div');
  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'staff';

  const reload = async (next = tab) => {
    replaceParams('att-setup', { tab: next });
    mount(host, await renderAttSetup({ tab: next }));
  };

  // Switching a tab throws away whatever is half-typed on this one, and it
  // does not go through the router, so the router's own guard never sees it.
  const tabs = h('div.seg.seg-wrap', TABS.map(([key, label]) =>
    h('button', {
      class: tab === key ? 'active' : '',
      onclick: () => {
        if (key !== tab && guard?.changed()
          && !confirmAction('Changes on this form are not saved. Leave them?')) return;
        reload(key);
      },
    }, label)));

  const body = await {
    company: companyTab,
    staff: staffTab,
    shifts: shiftsTab,
    reasons: reasonsTab,
    holidays: holidaysTab,
    devices: devicesTab,
    rules: rulesTab,
    workload: workloadTab,
    tax: taxTab,
    birthdays: birthdaysTab,
  }[tab](reload);

  // The forms under Setup are the ones somebody types a page of figures into
  // and then walks away from. Watched as a whole rather than field by field:
  // what matters is only whether what is on the form now is what was on it
  // when it opened.
  const formEl = body?.matches?.('form.att-rules')
    ? body
    : body?.querySelector?.('form.att-rules');
  const guard = formEl ? watchForm(formEl) : null;
  warnBeforeLeaving(
    () => (guard?.changed() ? 'Changes on this form are not saved' : null),
    { key: 'att-setup' },
  );

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
// The company
// ---------------------------------------------------------------------------

/**
 * Who the employer is, on paper.
 *
 * A payslip is the one thing this app prints that somebody carries out of the
 * building and shows to a bank, a landlord or SSNIT. It has to say which
 * company paid them, where that company is, and how to reach it. None of that
 * was anywhere in here, so a slip came out with a name and nothing else.
 *
 * The two numbers earn their place for the same reason. Somebody querying a
 * deduction at a SSNIT branch is asked for the employer number, and the answer
 * should be on the paper in their hand rather than a phone call away.
 */
async function companyTab(reload) {
  const data = await api.attBootstrap();
  const s = data.settings;

  const form = h('form.att-rules');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.attUpdateSettings(Object.fromEntries(new FormData(form).entries()));
      toast('Saved.', 'good');
      await reload('company');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  const text = (name, label, value, hint, extra = {}) => h('label.field',
    h('span', label),
    h('input', { type: 'text', name, maxlength: 160, value: value ?? '', ...extra }),
    hint ? h('small.muted', hint) : null);

  form.append(
    h('div.grid.company-grid',
      card('Name and address', { note: 'The head of every payslip, contract and letter' },
        text('property_name', 'Name', s.property_name, 'What everybody calls the place',
          { required: true, maxlength: 120 }),
        text('company_legal_name', 'Registered name', s.company_legal_name,
          'Only if the certificate says something different. Left blank, the name above is used'),
        h('label.field',
          h('span', 'Address'),
          h('textarea', { name: 'property_address', rows: 3, maxlength: 300 },
            s.property_address ?? ''),
          h('small.muted', 'One line to a line, the way it should print')),
      ),

      card('How to reach it', { note: 'Printed small, under the address' },
        text('company_phone', 'Telephone', s.company_phone, 'The office number somebody rings '
          + 'about a figure they do not recognise', { maxlength: 60, inputmode: 'tel' }),
        text('company_email', 'Email', s.company_email, '', { maxlength: 120 }),
        text('company_website', 'Website', s.company_website, '', { maxlength: 120 }),
      ),

      card('Numbers', { note: 'Quoted back at you by whoever is checking a deduction' },
        text('company_tin', 'TIN', s.company_tin,
          'The Taxpayer Identification Number the GRA issued', { maxlength: 40 }),
        text('company_ssnit', 'SSNIT employer number', s.company_ssnit,
          'What a member of staff is asked for at a SSNIT branch', { maxlength: 40 }),
      ),

      logoCard(s, reload),
    ),

    h('div.btn-row', { style: { marginTop: '.8rem' } },
      h('button.btn.btn-primary', { type: 'submit' }, 'Save')),
  );

  return form;
}

/**
 * The logo.
 *
 * Its own card and its own request, because it is bytes rather than a setting
 * and because it should not be able to fail a save of the address.
 */
function logoCard(s, reload) {
  const has = Boolean(s.company_logo_at);
  const picker = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' },
  });
  const status = h('span.muted', { style: { fontSize: '.85rem' } }, '');

  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    try {
      status.textContent = 'Reading it\u2026';
      const picked = await readLogo(file);
      await api.attSetLogo(picked);
      toast('Logo saved.', 'good');
      await reload('company');
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'bad');
    }
  });

  return card('Logo', { note: has ? 'On every payslip' : 'Not set' },
    has
      ? h('div.logo-shows',
        h('img.logo-preview', {
          src: `/api/company/logo?v=${encodeURIComponent(s.company_logo_at)}`,
          alt: `${s.property_name || 'The property'} logo`,
        }))
      : h('p.muted', { style: { fontSize: '.85rem' } },
        'Without one a payslip is headed by the name alone, which is fine and looks '
        + 'plainer than it needs to.'),

    h('p.muted', { style: { fontSize: '.85rem' } },
      'A PNG with a transparent background sits best. It is shrunk to about 600 pixels '
      + 'across on the way in, which is more than a payslip can show.'),

    h('div.btn-row',
      h('button.btn-sm', { type: 'button', onclick: () => picker.click() },
        has ? 'Replace it' : 'Upload one'),
      has
        ? h('button.btn-sm', {
          type: 'button',
          onclick: async () => {
            if (!confirmAction('Take the logo off? Payslips go back to the name alone.')) return;
            try {
              await api.attRemoveLogo();
              toast('Taken off.', 'good');
              await reload('company');
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }, 'Take it off')
        : null,
      picker, status));
}

/** Read a logo, shrink it, and keep its transparency. */
async function readLogo(file) {
  const LIMIT = 600_000;
  if (!file.type.startsWith('image/')) throw new Error('A logo has to be a picture.');

  const bitmap = await createImageBitmap(file);
  // 600 across covers the biggest a payslip prints it at three hundred dots to
  // the inch, and keeps the file small enough to travel with every slip.
  const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  // PNG first, because a logo on a transparent background put on a white one
  // grows a grey box the moment it is turned into a JPEG.
  const tries = [['image/png', undefined], ['image/jpeg', 0.9], ['image/jpeg', 0.75]];
  for (const [mime, quality] of tries) {
    const url = canvas.toDataURL(mime, quality);
    const bytes = Math.round((url.length - url.indexOf(',') - 1) * 0.75);
    if (bytes <= LIMIT) {
      return { content: url.split(',')[1], mime, bytes };
    }
  }
  throw new Error('That picture is too large even after shrinking. Export it 600 pixels across.');
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

/**
 * Pick a position, or name one that does not exist yet.
 *
 * The same shape as the department picker and for the same reason: a plain box
 * is how one job ends up spelled three ways, and a plain dropdown is a dead
 * end the first time somebody adds a job that is not on it.
 */
function positionPicker(positions, current, {
  name = 'position', blank = 'Its own position', add = '+ New position…', placeholder = 'Name the position',
} = {}) {
  const options = [...positions];
  if (current && !options.some((p) => p.toLowerCase() === current.toLowerCase())) {
    options.unshift(current);
  }

  const typed = h('input', {
    type: 'text',
    name: `${name}New`,
    maxlength: 80,
    placeholder,
    style: { display: 'none', marginTop: '.4rem' },
  });

  const select = h('select', {
    name: `${name}Pick`,
    onchange: (e) => {
      const adding = e.target.value === NEW_DEPARTMENT;
      typed.style.display = adding ? '' : 'none';
      if (adding) typed.focus();
    },
  },
  h('option', { value: '', selected: !current }, blank),
  options.map((p) => h('option', { value: p, selected: p === current }, p)),
  h('option', { value: NEW_DEPARTMENT }, add));

  return h('div', select, typed);
}

/** The departments already ticked for somebody, read off the record. */
function readWorksIn(staff) {
  if (!staff?.works_in) return [];
  try {
    const parsed = JSON.parse(staff.works_in);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** The shifts somebody has been picked out for one at a time. */
function readWorksShifts(staff) {
  if (!staff?.works_shifts) return [];
  try {
    const parsed = JSON.parse(staff.works_shifts);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

/** A stored array of weekdays, Monday as 0, read back without ever throwing. */
function readDayList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      : [];
  } catch {
    return [];
  }
}

/** The people a shift belongs to, first choice first. */
function readOnlyStaff(shift) {
  try {
    const parsed = JSON.parse(shift?.only_staff ?? 'null');
    if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isFinite);
  } catch { /* falls through to the single-id form below */ }
  return shift?.only_staff_id ? [Number(shift.only_staff_id)] : [];
}

/** The weekdays a shift is set to run, or null for every day. */
function readRunsOn(shift) {
  const list = readDayList(shift?.runs_on);
  return list.length ? list : null;
}

/** What a position picker was set to, whichever half of it was used. */
const readPosition = (form, name = 'position') => (
  form.get(`${name}Pick`) === NEW_DEPARTMENT
    ? (form.get(`${name}New`) || '').trim()
    : form.get(`${name}Pick`)) || null;

/**
 * The register, out of a spreadsheet.
 *
 * THE ONE IMPORT IN THE APP THAT CREATES PEOPLE. Every other one refuses a
 * name it has not seen, because a rota or a payroll sheet is about people
 * somebody already decided to employ. Here it is the whole point: a property
 * that has been running on a spreadsheet for six years should not have to type
 * ninety names into a form one at a time.
 *
 * So the safeguard moves. Everything the file would do sits on the screen —
 * who is being added, who is changing, what about them, and every line that
 * could not be read — and nothing is written until somebody has looked at it
 * and pressed the button.
 */
function staffImportButton(reload) {
  return bulkUpload({
    accept: '.csv,text/csv',
    title: 'A staff list as a CSV. Nothing is written until you have seen what it would do.',
    template: {
      href: '/api/att/staff/template',
      download: 'staff.csv',
      label: 'Download template',
    },
    onFile: async (file) => {
      try {
        const text = await file.text();
        const read = await api.attReadStaffImport(text);
        await showStaffImport({ text, read, reload });
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });
}

/** What the file would do, and the button that does it. */
async function showStaffImport({ text, read, reload }) {
  const { tally } = read;

  const line = (row) => h('div.pay-import-row',
    h('div',
      h('strong', row.name),
      h('span.muted', ` · ${row.employeeNo}`),
      row.adding ? h('span.pill.good', { style: { marginLeft: '.4rem' } }, 'new') : null,
      row.changes.length
        ? h('ul.pay-import-changes', row.changes.map((c) => h('li',
          `${c.label}: `,
          row.adding
            ? h('strong', c.to)
            : [h('span.muted', c.from ?? 'nothing'), ' to ', h('strong', c.to)])))
        : null,
      row.notes.length
        ? h('ul.pay-import-notes', row.notes.map((n) => h('li', `${n.what}: ${n.why}`)))
        : null));

  const adding = read.lines.filter((r) => r.adding);
  const changing = read.lines.filter((r) => !r.adding);

  const sentence = tally.nothing
    ? 'Nothing in that file is different from what is already here.'
    : `${[
      tally.adding ? `${tally.adding} ${tally.adding === 1 ? 'person' : 'people'} would be added`
        : null,
      tally.changes
        ? `${tally.changes} detail${tally.changes === 1 ? '' : 's'} would change on `
          + `${tally.changing} ${tally.changing === 1 ? 'person' : 'people'} already here`
        : null,
    ].filter(Boolean).join(', ')}. Nothing has been written yet.`;

  const done = await formDialog({
    title: 'Staff from a spreadsheet',
    submitLabel: tally.nothing
      ? 'Nothing to do'
      : tally.adding
        ? `Add ${tally.adding} and save the rest`
        : `Change ${tally.changes} details`,
    body: h('div',
      h('p.muted', { style: { fontSize: '.9rem', marginTop: 0 } }, sentence),

      read.missingColumns.length
        ? h('div.returns-warn', `The sheet needs ${read.missingColumns.join(' and ')}.`)
        : null,

      tally.adding
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', `${tally.adding} new `
              + `${tally.adding === 1 ? 'person' : 'people'}`),
            h('div.alert-detail', 'This is the only import that adds people. Check the names '
              + 'below are ones you meant to employ — a number that does not match anybody '
              + 'here is read as somebody new, so one typo in a staff number makes a '
              + 'duplicate.')))
        : null,

      read.unknown.length
        ? h('div.returns-warn',
          h('strong', 'Columns nobody recognised, so they were left alone'),
          h('div', read.unknown.join(', ')),
          h('div.muted', 'An allowance column has to say so: “Allowance: Transport”, or '
            + '“Allowance: Transport (not taxable)”. A bare heading is never turned into '
            + 'money on a payslip.'))
        : null,

      read.skipped.length
        ? h('div.returns-warn',
          h('strong', `${read.skipped.length} line${read.skipped.length === 1 ? '' : 's'} skipped`),
          h('ul', read.skipped.map((row) => h('li',
            `Line ${row.at}: ${row.name || row.employeeNo || 'blank'} · ${row.why}`))))
        : null,

      adding.length
        ? h('div',
          h('div.stat-label', { style: { margin: '.8rem 0 .4rem' } }, 'Being added'),
          h('div.pay-import-list.import-open', adding.map(line)))
        : null,

      changing.length
        ? h('div',
          h('div.stat-label', { style: { margin: '.8rem 0 .4rem' } }, 'Being changed'),
          h('div.pay-import-list.import-open', changing.map(line)))
        : null),

    onSubmit: () => (tally.nothing
      ? Promise.resolve({ added: 0, changed: 0, failed: [] })
      : api.attApplyStaffImport(text)),
  });

  if (!done) return;
  const bits = [];
  if (done.added) bits.push(`${done.added} added`);
  if (done.changed) bits.push(`${done.changed} changed`);
  if (done.failed?.length) bits.push(`${done.failed.length} could not be saved`);
  toast(bits.length ? bits.join(', ') + '.' : 'Nothing changed.',
    done.failed?.length ? 'warn' : bits.length ? 'good' : 'warn');
  await reload();
}

async function staffTab(reload) {
  const [{ staff, departments = [], shifts = [] }, { unknown }] = await Promise.all([
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

    // Every department the property has, plus any this person is already
    // ticked for that has since been renamed away. Dropping one silently is
    // how a restriction becomes a mystery.
    // Weekdays they never work. The standing version of the ✕ on the rota,
    // which is about one named date.
    const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const never = new Set(readDayList(existing?.off_days));
    const offBoxes = WEEK.map((label, index) => h('label.tickline',
      h('input', {
        type: 'checkbox',
        checked: never.has(index),
        onchange: (e) => (e.target.checked ? never.add(index) : never.delete(index)),
      }),
      h('span', label)));

    const already = new Set(readWorksIn(existing));
    const areas = [...new Set([...departments, ...already])].sort();
    const chosen = new Set(already);
    const pickedShifts = new Set(readWorksShifts(existing));

    // Shifts belonging to no department are open to everybody whatever is
    // ticked here, so offering a box for them would be offering a box that
    // does nothing. Said in the hint underneath instead.
    // Retired shifts are left out: nobody can be rostered onto one, so a box
    // for it is a box that does nothing. One this person is already picked out
    // for stays, because a tick nobody can see is a tick nobody can undo.
    const inAreas = shifts.filter((sh) => sh.department
      && (sh.active !== 0 || pickedShifts.has(sh.id)));
    const byArea = new Map(areas.map((name) => [name, []]));
    for (const sh of inAreas) {
      if (!byArea.has(sh.department)) byArea.set(sh.department, []);
      byArea.get(sh.department).push(sh);
    }

    // Ticking a department is a standing answer: anything in it, including the
    // shift added next month. Naming shifts is the narrow one. So a ticked
    // department covers its own shifts, and their boxes go quiet to say so.
    const shiftBoxes = new Map();
    const syncArea = (name) => {
      for (const box of shiftBoxes.get(name) ?? []) {
        box.disabled = chosen.has(name);
        box.checked = chosen.has(name) || pickedShifts.has(Number(box.dataset.shift));
      }
    };

    // The one way to get this wrong: naming a shift somewhere else and losing
    // your own department without noticing. Said out loud, and only while it
    // is true.
    const warning = h('small.muted', { style: { display: 'none' } });
    const syncWarning = () => {
      const lost = pickedShifts.size && !chosen.size && existing?.department;
      warning.style.display = lost ? '' : 'none';
      warning.textContent = lost
        ? `Only the shifts ticked above. Tick ${existing.department} as well if they should `
          + 'still work their own department.'
        : '';
    };

    const areaBlock = (name) => {
      const list = (byArea.get(name) ?? []);
      const boxes = [];
      shiftBoxes.set(name, boxes);

      return h('div.works-area',
        h('label.tickline.works-area-head',
          h('input', {
            type: 'checkbox',
            checked: chosen.has(name),
            onchange: (e) => {
              if (e.target.checked) chosen.add(name); else chosen.delete(name);
              syncArea(name);
              syncWarning();
            },
          }),
          h('span', h('strong', name),
            h('small.muted', ` · the whole department${list.length ? `, ${list.length} shift${list.length === 1 ? '' : 's'}` : ''}`))),

        list.length
          ? h('div.works-shifts', list.map((sh) => {
            const box = h('input', {
              type: 'checkbox',
              'data-shift': String(sh.id),
              checked: chosen.has(name) || pickedShifts.has(sh.id),
              disabled: chosen.has(name),
              onchange: (e) => {
                if (e.target.checked) pickedShifts.add(sh.id); else pickedShifts.delete(sh.id);
                syncWarning();
              },
            });
            boxes.push(box);
            return h('label.tickline', box,
              h('span', sh.name,
                h('small.muted', ` · ${sh.starts_at}–${sh.ends_at}`),
                sh.active === 0 ? h('small.muted', ' · retired') : null));
          }))
          : null,
      );
    };

    const worksInBoxes = areas.length
      ? [...areas.map(areaBlock), warning]
      : [h('small.muted', 'No departments set up yet. Add one on a shift or a person first.')];
    syncWarning();

    // Three answers, not two. A director is on the payroll and nowhere else:
    // rostering them means nothing, and neither does marking them absent every
    // morning for never touching a terminal they have never stood in front of.
    const tracking = h('select', { name: 'tracking' },
      h('option', {
        value: 'full',
        selected: existing == null || (existing.on_clock !== 0 && existing.on_rota !== 0),
      }, 'The rota and attendance'),
      h('option', {
        value: 'no-rota',
        selected: existing != null && existing.on_clock !== 0 && existing.on_rota === 0,
      }, 'Attendance, but never rostered'),
      h('option', {
        value: 'payroll',
        selected: existing?.on_clock === 0,
      }, 'Payroll only'),
    );

    const rotaOnly = h('div',
      field('Never works', h('div.day-ticks', offBoxes),
        'A standing rule, so it needs no ✕ on the rota every fortnight. For one date only, '
        + 'use Days they cannot work on the rota instead'),

      // Where they may be put on. Their own department answers for them until
      // somebody ticks more, which is the truth for most of the staff and
      // saves ticking one box twenty-four times.
      field('They can work in', h('div.works-picker', worksInBoxes),
        'Tick a whole department, or pick out single shifts within one. Leave everything '
        + 'clear and their own department answers for them. Shifts that are not in a '
        + 'department are open to everybody either way'));

    // Nothing about a rota or a working week applies to somebody who is only
    // paid, so the form stops asking. Left on screen and greyed they would
    // still read as questions somebody has to answer.
    const clockOnly = [];
    // Hidden by style rather than by the hidden attribute: a field row is laid
    // out as a grid, and a class that sets display beats the browser's own
    // rule for [hidden] every time.
    const show = (node, on) => { node.style.display = on ? '' : 'none'; };
    const syncTracking = () => {
      const paid = tracking.value === 'payroll';
      show(rotaOnly, !paid && tracking.value !== 'no-rota');
      for (const node of clockOnly) show(node, !paid);
    };
    tracking.addEventListener('change', syncTracking);

    const remember = (node) => { clockOnly.push(node); return node; };

    const body = h('div',
      h('div.field-row',
        field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 120, value: existing?.name ?? '' })),
        field(
          'Employee number',
          h('input', { type: 'text', name: 'employeeNo', required: true, maxlength: 40, value: existing?.employee_no ?? '' }),
          'Exactly as it is on the terminal — this is what joins a face to a name. '
          + 'For somebody only on the payroll, any staff number will do',
        ),
      ),
      field('What they are here for', tracking,
        'Never rostered takes them off the grid, the draft and the workload list. '
        + 'Payroll only takes them out of attendance as well: no day is worked out for '
        + 'them, nothing counts them absent, and nothing chases them'),
      h('div.field-row',
        field('Department', departmentPicker(departments, existing?.department ?? '')),
        field('Job title', h('input', { type: 'text', name: 'jobTitle', maxlength: 80, value: existing?.job_title ?? '' })),
      ),
      h('div.field-row',
        field('Started', h('input', { type: 'date', name: 'hiredOn', value: existing?.hired_on ?? '' }), 'Leave earns from this date'),
        field('Left', h('input', { type: 'date', name: 'leftOn', value: existing?.left_on ?? '' }), 'They drop off the rota after this'),
      ),
      remember(h('div.field-row',
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
          'What the month expects of them, and the most the rota will put them down for. '
          + 'Blank uses the property default',
        ),
      )),
      rotaOnly,

      h('div.field-row',
        isEdit
          ? field('Status', h('select', { name: 'active' },
            h('option', { value: 'true', selected: !!existing.active }, 'Active'),
            h('option', { value: 'false', selected: !existing.active }, 'Not active'),
          ))
          : null,
      ),
      field('Note', h('input', { type: 'text', name: 'note', maxlength: 300, value: existing?.note ?? '' })));

    // Once now, so an existing payroll-only record opens without the questions
    // that do not apply to them, rather than showing them for a moment first.
    syncTracking();

    const done = await formDialog({
      title: isEdit ? `Edit ${existing.name}` : 'Add somebody',
      submitLabel: isEdit ? 'Save changes' : 'Add them',
      body,
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
          onClock: form.get('tracking') !== 'payroll',
          onRota: form.get('tracking') === 'full',
          offDays: [...never],
          worksIn: [...chosen],
          // A shift inside a ticked department is already covered by it, and
          // storing it twice makes a rename look like a change nobody made.
          worksShifts: [...pickedShifts].filter((id) => {
            const sh = shifts.find((x) => x.id === id);
            return sh && !chosen.has(sh.department);
          }),
        };
        return isEdit ? api.attUpdateStaff(existing.id, payload) : api.attCreateStaff(payload);
      },
    });

    if (done) {
      if (done.clearedFromRota) {
        toast(`Saved. ${done.clearedFromRota} shift`
          + `${done.clearedFromRota === 1 ? '' : 's'} from today onwards have been taken off `
          + 'the rota.', 'good');
      } else if (done.claimedPunches) {
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
      note: (() => {
        const active = staff.filter((s) => s.active).length;
        const paid = staff.filter((s) => s.active && s.on_clock === 0).length;
        const off = staff.filter((s) => s.active && s.on_clock !== 0 && s.on_rota === 0).length;
        return [
          `${active} active`,
          off ? `${off} not on the rota` : null,
          paid ? `${paid} payroll only` : null,
        ].filter(Boolean).join(', ');
      })(),
      actions: h('div.btn-row', { style: { margin: 0 } },
        staffImportButton(reload),
        h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add somebody')),
      wide: true,
    },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('div',
            h('div', v,
              r.active ? null : h('span.pill', { style: { marginLeft: '.4rem' } }, 'inactive'),
              r.on_clock === 0
                ? h('span.pill', { style: { marginLeft: '.4rem' } }, 'payroll only')
                : r.on_rota === 0
                  ? h('span.pill', { style: { marginLeft: '.4rem' } }, 'not on rota')
                  : null),
            h('small.muted', [r.job_title, r.department].filter(Boolean).join(' · ') || '—'),
            readDayList(r.off_days).length
              ? h('small.muted', { style: { display: 'block' } },
                `Never works ${readDayList(r.off_days)
                  .map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(' ')}`)
              : null,
            readWorksIn(r).length || readWorksShifts(r).length
              ? h('small.muted', { style: { display: 'block' } },
                `Works in ${[
                  ...readWorksIn(r),
                  ...readWorksShifts(r)
                    .map((id) => shifts.find((sh) => sh.id === id)?.name)
                    .filter(Boolean),
                ].join(', ')}`)
              : null,
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
  const [{ shifts, departments = [], positions = [], staff = [] }, suggested] = await Promise.all([
    api.attShifts(),
    api.attShiftSuggestions().catch(() => null),
  ]);

  const edit = async (existing) => {
    // The three boxes the full day is worked out from, held here so the one
    // below can follow them.
    const startsAt = h('input', { type: 'time', name: 'startsAt', required: true, value: existing?.starts_at ?? '06:00' });
    const endsAt = h('input', { type: 'time', name: 'endsAt', required: true, value: existing?.ends_at ?? '14:00' });
    const breakMinutes = h('input', { type: 'number', name: 'breakMinutes', min: 0, max: 480, value: existing?.break_minutes ?? 0 });

    // A full day is the shift, less whatever is not paid. Nobody was working
    // that out by hand and getting it right, so the box fills itself in and
    // keeps up as the times are changed. It stops the moment somebody types
    // their own number, because a property that wants a full day to mean
    // seven hours on an eight-hour shift is entitled to say so.
    const worked = () => shiftMinutes({
      starts_at: startsAt.value,
      ends_at: endsAt.value,
      break_minutes: breakMinutes.value,
    });
    const fullDay = h('input', {
      type: 'number', name: 'fullDayMinutes', min: 0, max: 1440,
      value: existing?.full_day_minutes ?? worked(),
    });
    let own = fullDayIsOwn(existing);
    if (!own) fullDay.value = String(worked());
    fullDay.addEventListener('input', () => { own = true; });
    const follow = () => { if (!own) fullDay.value = String(worked()); };
    for (const el of [startsAt, endsAt, breakMinutes]) el.addEventListener('input', follow);

    // Monday first, to match the standing pattern and the grid. Nothing stored
    // means every day, so a shift nobody has said anything about opens with
    // all seven ticked and saves as nothing at all.
    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const runsOn = new Set(readRunsOn(existing) ?? [0, 1, 2, 3, 4, 5, 6]);
    const dayBoxes = DAY_NAMES.map((label, index) => h('label.tickline',
      h('input', {
        type: 'checkbox',
        checked: runsOn.has(index),
        onchange: (e) => (e.target.checked ? runsOn.add(index) : runsOn.delete(index)),
      }),
      h('span', label)));

    // Every alternatives group already named, so the second breakfast is put
    // in the same one rather than into a second spelling of it.
    const altGroups = [...new Set(shifts.map((sh) => sh.alt_group).filter(Boolean))].sort();
    const pairGroups = [...new Set(shifts.map((sh) => sh.pair_group).filter(Boolean))].sort();

    // Whose shift it is, in order. "Nii, and Dorcas when Nii is not there" is
    // one instruction and the order is what carries it, so the rows are
    // numbered and can be taken away rather than being a set of ticks.
    const owners = readOnlyStaff(existing);
    const ownerPicker = h('div.owner-picker');

    const drawOwners = () => {
      const row = (id, index) => h('div.owner-row',
        h('span.owner-rank', index === 0 ? '1st' : index === 1 ? '2nd' : `${index + 1}th`),
        h('select', {
          onchange: (e) => {
            const picked = Number(e.target.value);
            if (picked) owners[index] = picked; else owners.splice(index, 1);
            drawOwners();
          },
        },
        h('option', { value: '' }, index === 0 ? 'Anybody set up for it' : 'Nobody after this'),
        staff.map((p) => h('option', {
          value: String(p.id),
          selected: p.id === id,
        }, p.department ? `${p.name} · ${p.department}` : p.name))));

      mount(ownerPicker,
        owners.map(row),
        // One empty row at the end, and only where there is somebody to put in
        // it. A shift with nobody named shows one; a shift with two shows a
        // third waiting.
        owners.length < staff.length ? row(null, owners.length) : null);
    };
    drawOwners();

    const done = await formDialog({
      title: existing ? `Edit ${existing.name}` : 'Add a shift',
      submitLabel: existing ? 'Save changes' : 'Add the shift',
      body: h('div',
        h('div.field-row',
          field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 60, value: existing?.name ?? '', placeholder: 'Morning' })),
          field('Department', departmentPicker(departments, existing?.department ?? ''),
            'Groups the shift list and the reports'),
          // The job, as against the hours. Three breakfast shifts that differ
          // only in when they finish are one position, and the rota's position
          // view reads as a list of near duplicates until somebody says so.
          field('Position', positionPicker(positions, existing?.position ?? ''),
            'Groups the rota. Leave it alone unless another shift is the same job'),
        ),
        h('div.field-row',
          field('Starts', startsAt),
          field('Ends', endsAt, 'Before the start means it runs overnight'),
          field('Unpaid break', breakMinutes, 'minutes'),
        ),
        h('div.field-row',
          field('Grace before late', h('input', { type: 'number', name: 'graceIn', min: 0, max: 120, value: existing?.grace_in_minutes ?? 5 }), 'minutes'),
          field('Grace before early', h('input', { type: 'number', name: 'graceOut', min: 0, max: 120, value: existing?.grace_out_minutes ?? 5 }), 'minutes'),
          field('Overtime after', h('input', { type: 'number', name: 'overtimeAfter', min: 0, max: 480, value: existing?.overtime_after ?? 0 }), 'minutes past the end'),
        ),
        h('div.field-row',
          field('Half day at', h('input', { type: 'number', name: 'halfDayMinutes', min: 0, max: 1440, value: existing?.half_day_minutes ?? 240 }), 'minutes worked'),
          field('Full day at', fullDay, 'minutes worked, from the hours less the break'),
          // What the draft aims at. Three on reception every day is a fact
          // about the job, and left blank the suggester has to guess it from
          // the weeks behind, which a brand new shift does not have.
          field('People needed', h('input', {
            type: 'number', name: 'needed', min: 0, max: 99, value: existing?.needed ?? '',
          }), 'How many the draft puts on. Blank copies what the last few weeks did'),
        ),

        field('It runs on', h('div.day-ticks', dayBoxes),
          'Untick a day and the shift is not wanted then. The draft leaves it alone and does '
          + 'not count it as a gap'),

        h('div.field-row',
          // Work that is wanted often but not two days running, because the
          // point of it is the day in between.
          field('Days in between', h('select', { name: 'everyDays' },
            [1, 2, 3, 4, 7, 14].map((n) => h('option', {
              value: String(n),
              selected: Number(existing?.every_days || 1) === n,
            }, n === 1 ? 'None, it can run any day'
              : n === 2 ? 'Every other day'
                : n === 7 ? 'Once a week'
                  : n === 14 ? 'Once a fortnight'
                    : `Every ${n} days`))),
          'A deep clean wanted every other day, not three days running'),

          // The five breakfasts that differ by half an hour are one morning
          // written five ways. Naming them the same thing here says so.
          field('One of these runs a day', positionPicker(altGroups, existing?.alt_group ?? '', {
            name: 'altGroup',
            blank: 'Nothing stands in for it',
            add: '+ New group…',
            placeholder: 'Name the group, eg Breakfast',
          }),
            'Shifts sharing a name here stand in for each other'),
          // The other arrangement, and the one the alternates group could not
          // express: a service cut in two is two shifts and one decision.
          field('These run together', positionPicker(pairGroups, existing?.pair_group ?? '', {
            name: 'pairGroup',
            blank: 'It runs on its own',
            add: '+ New pair…',
            placeholder: 'Name the pair, eg Bistro split',
          }),
            'Shifts sharing a name here are one service cut in two: either all of them are on '
            + 'a day or none of them is. A pair may sit in an alternates group against the '
            + 'single shift that replaces it, and the two of them will not rule each other out'),
          field('And they clash', h('select', { name: 'altScope' },
            h('option', { value: 'day', selected: existing?.alt_scope !== 'week' },
              'For that day only'),
            h('option', { value: 'week', selected: existing?.alt_scope === 'week' },
              'For the whole week'),
          ), 'Two breakfasts clash for the morning. Two shifts that each run once a week clash '
            + 'for the week, whichever day either of them lands on'),
          field('Whose shift it is', ownerPicker,
            'Named people only, first choice first. On a day none of them is free it does not '
            + 'run at all, rather than becoming a gap nobody can fill'),
          field('Only if somebody is spare', h('select', { name: 'optional' },
            h('option', { value: 'false', selected: !existing?.optional }, 'No, it has to be covered'),
            h('option', { value: 'true', selected: !!existing?.optional }, 'Yes, optional'),
          ), 'Optional shifts are filled last, from whoever is left over, and never at the cost '
            + 'of one that has to be covered'),
        ),
        // Chosen for the shift already, from its id, so a property with
        // twenty-four shifts is not a colouring exercise before the rota
        // becomes readable. This is only for when the automatic one puts two
        // shifts somebody cares about next to each other in the same colour.
        field('Colour on the rota', shiftColourPicker(existing),
          'One is chosen for every shift already. Pick your own where two that '
          + 'matter come out too alike'),

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
        payload.position = readPosition(form);
        payload.runsOn = [...runsOn];
        payload.altGroup = readPosition(form, 'altGroup');
        payload.pairGroup = readPosition(form, 'pairGroup');
        payload.optional = form.get('optional') === 'true';
        payload.onlyStaff = [...owners];
        payload.everyDays = Number(form.get('everyDays')) || 1;
        payload.altScope = form.get('altScope') === 'week' ? 'week' : 'day';
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
        needed: row.needed,
        runsOn: readRunsOn(row) ?? [0, 1, 2, 3, 4, 5, 6],
        altGroup: row.alt_group || null,
        pairGroup: row.pair_group || null,
        altScope: row.alt_scope || 'day',
        optional: Boolean(row.optional),
        onlyStaff: readOnlyStaff(row),
        everyDays: row.every_days ?? 1,
        department: row.department || null,
        position: row.position || null,
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
  // Every position somebody has named, whether or not it currently holds two
  // shifts. One that has been narrowed to a single shift is still a position,
  // and hiding it would mean a rename that appears to have lost the thing.
  const grouped = byPosition(inUse).filter((g) => g.key.startsWith('p:'));

  /**
   * Put several shifts under one position in one action.
   *
   * The direct answer to three breakfast shifts that differ only in when they
   * finish. Doing it by opening each of them and typing the same word is how
   * two of them end up spelled differently.
   */
  const chosen = new Set();
  const groupBar = h('div.bulk-clear', { style: { display: 'none' } });

  const refreshGroupBar = () => {
    groupBar.style.display = chosen.size ? '' : 'none';
    const names = inUse.filter((r) => chosen.has(r.id)).map((r) => r.name);
    mount(groupBar,
      h('span', h('strong', `${chosen.size} ticked`),
        h('span.muted', ` — ${names.slice(0, 3).join(', ')}`
          + (names.length > 3 ? ` and ${names.length - 3} more` : ''))),
      h('button.btn-sm.btn-primary', { onclick: () => groupThem([...chosen]) },
        'Put under one position'));
  };

  const groupThem = async (ids) => {
    const rows = inUse.filter((r) => ids.includes(r.id));
    const already = [...new Set(rows.map((r) => r.position).filter(Boolean))];

    const done = await formDialog({
      title: `${ids.length} shift${ids.length === 1 ? '' : 's'} under one position`,
      submitLabel: 'Group them',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          'A position is the job, as against the hours. Three breakfast shifts that differ '
          + 'only in when they finish are one position, and the rota groups by it. Nothing '
          + 'about the shifts themselves changes.'),
        h('ul.signed-list', rows.map((r) => h('li', h('small',
          `${r.name} · ${r.starts_at}–${r.ends_at}`
          + `${r.position ? ` · now under ${r.position}` : ''}`)))),
        field('Position', positionPicker(positions, already.length === 1 ? already[0] : ''),
          'Pick "Its own position" to ungroup them again'),
      ),
      onSubmit: async (form) => api.attGroupShifts({
        shiftIds: ids, position: readPosition(form),
      }),
    });

    if (!done) return;
    toast(done.position
      ? `${done.changed} shift${done.changed === 1 ? '' : 's'} under ${done.position}.`
      : `${done.changed} shift${done.changed === 1 ? '' : 's'} back on their own.`, 'good');
    await reload();
  };

  /**
   * Change a position that already exists.
   *
   * Grouping shifts is easy; ungrouping one, or fixing a name typed two ways,
   * meant hunting down each shift and retyping the word. This is the same
   * operation from the other end: the position is the thing on screen, and
   * what changes is its name and which shifts are under it.
   */
  const editGroup = async (group) => {
    const picked = new Set(group.shifts.map((r) => r.id));

    const name = h('input', {
      type: 'text', name: 'position', maxlength: 60, value: group.name, required: true,
    });

    const list = h('div.pos-edit-list', inUse.map((row) => h('label.tickline',
      h('input', {
        type: 'checkbox',
        checked: picked.has(row.id),
        onchange: (e) => {
          if (e.target.checked) picked.add(row.id); else picked.delete(row.id);
        },
      }),
      h('span', `${row.name} · ${row.starts_at}–${row.ends_at}`,
        row.position && row.position !== group.name
          ? h('small.muted', ` · under ${row.position}`)
          : null))));

    const done = await formDialog({
      title: `The ${group.name} position`,
      submitLabel: 'Save the position',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          'Rename it, or change which shifts belong to it. Nothing about the shifts themselves '
          + 'changes, and unticking one puts it back on its own.'),
        field('Called', name),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: '.2rem' } }, 'Shifts under it'),
        list),
      onSubmit: async (form) => {
        const called = String(form.get('position') || '').trim();
        if (!called) throw new Error('A position needs a name.');

        const now = [...picked];
        const dropped = group.shifts.map((r) => r.id).filter((id) => !picked.has(id));
        if (!now.length && !dropped.length) return { changed: 0, position: called };

        // Two calls on purpose: one says what the position now holds, the
        // other puts what left it back on its own. Doing it in one would mean
        // an endpoint that has to guess which of the two somebody meant.
        if (now.length) await api.attGroupShifts({ shiftIds: now, position: called });
        if (dropped.length) await api.attGroupShifts({ shiftIds: dropped, position: '' });
        return { changed: now.length, position: called, dropped: dropped.length };
      },
    });

    if (!done) return;
    toast(done.dropped
      ? `${done.position}: ${done.changed} shift${done.changed === 1 ? '' : 's'}, `
        + `${done.dropped} put back on ${done.dropped === 1 ? 'its' : 'their'} own.`
      : `${done.position}: ${done.changed} shift${done.changed === 1 ? '' : 's'}.`, 'good');
    await reload();
  };

  const tickAll = h('input.th-tick', {
    type: 'checkbox',
    title: 'Tick every shift',
    onchange: (event) => {
      const on = event.target.checked;
      for (const box of shiftBody.querySelectorAll('input[type=checkbox]')) {
        box.checked = on;
        box.dispatchEvent(new Event('change'));
      }
    },
  });

  const shiftBody = h('div');

  return h('div',
    suggestionsCard(suggested, reload),

    card('Shifts', {
      note: 'A shift is what "late" is measured against',
      actions: h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add a shift'),
      wide: true,
    },
      groupBar,
      mount(shiftBody, table([
        {
          key: 'tick',
          label: tickAll,
          cls: 'no-print',
          format: (v, r) => h('input', {
            type: 'checkbox',
            'aria-label': r.name,
            onchange: (event) => {
              if (event.target.checked) chosen.add(r.id); else chosen.delete(r.id);
              refreshGroupBar();
            },
          }),
        },
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
        {
          key: 'position',
          label: 'Position',
          format: (v) => (v ? h('span.pill', v) : h('span.muted', 'its own')),
        },
        { key: 'break_minutes', label: 'Break', align: 'right', cls: 'off-phone', format: (v) => (v ? `${v} min` : h('span.muted', 'none')) },
        { key: 'grace_in_minutes', label: 'Grace in', align: 'right', format: (v) => `${v} min` },
        { key: 'grace_out_minutes', label: 'Grace out', align: 'right', format: (v) => `${v} min` },
        { key: 'half_day_minutes', label: 'Half day', align: 'right', format: (v) => `${fmtNum(v / 60, 1)} h` },
        { key: 'full_day_minutes', label: 'Full day', align: 'right', format: (v) => `${fmtNum(v / 60, 1)} h` },
        {
          key: 'needed',
          label: 'Needed',
          align: 'right',
          cls: 'off-phone',
          format: (v, r) => h('div',
            v == null ? h('span.muted', 'from history') : fmtNum(v, 0),
            r.optional ? h('small.muted', { style: { display: 'block' } }, 'if spare') : null),
        },
        {
          key: 'runs_on',
          label: 'Runs',
          cls: 'off-phone',
          format: (v, r) => {
            const days = readRunsOn(r);
            return h('div',
              days
                ? h('span', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                  .filter((_, i) => days.includes(i)).join(' '))
                : h('span.muted', 'every day'),
              r.pair_group
                ? h('span.rule-chip', { title: `Runs together with the rest of ${r.pair_group}` },
                  `with ${r.pair_group}`)
                : null,
              r.alt_group
                ? h('small.muted', { style: { display: 'block' } },
                  `or ${r.alt_group}${r.alt_scope === 'week' ? ', weekly' : ''}`)
                : null,
              r.every_days > 1
                ? h('small.muted', { style: { display: 'block' } },
                  r.every_days === 2 ? 'every other day' : `every ${r.every_days} days`)
                : null,
              readOnlyStaff(r).length
                ? h('small.muted', { style: { display: 'block' } },
                  readOnlyStaff(r).map((id) => staff.find((p) => p.id === id)?.name ?? '?')
                    .join(', then '))
                : null);
          },
        },
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
      }))),

    // The positions themselves, where there are any. A property that has never
    // grouped two shifts has nothing to read here, and the card stays away.
    grouped.length
      ? card('Positions', {
        note: 'The job, as against the hours',
        wide: true,
      },
        h('p.muted', { style: { fontSize: '.85rem' } },
          'The rota can be read by position as well as by person. Shifts under one position are '
          + 'stacked earliest first, so a group reads down the day.'),
        h('div.pos-sets', grouped.map((group) => h('div.pos-set',
          h('div',
            h('div.pos-set-name', group.name),
            h('div.muted', group.shifts
              .map((r) => `${r.name} · ${r.starts_at}–${r.ends_at}`).join('  ·  '))),
          h('button.btn-sm', { onclick: () => editGroup(group) }, 'Edit')))))
      : null,

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
    const kindSelect = h('select', { name: 'kind', required: true, disabled: Boolean(existing?.system) },
      KINDS.map(([value, label]) => h('option', { value, selected: existing?.kind === value }, label)));

    /**
     * Whether a member of staff may ask for this themselves.
     *
     * Only asked of a kind of leave, because nothing else appears on the Ask
     * for leave list to begin with. Maternity leave is arranged in an office;
     * a suspension is not something anybody requests. Whoever manages leave
     * can still record every one of them.
     */
    const staffPickField = field('Staff can ask for this themselves',
      h('select', { name: 'staffPick' },
        h('option', { value: 'true', selected: (existing?.staff_pick ?? 1) !== 0 }, 'Yes — it is on their list'),
        h('option', { value: 'false', selected: (existing?.staff_pick ?? 1) === 0 }, 'No — only somebody who manages leave can record it'),
      ),
      'Their Ask for leave list. It changes nothing about what you can record for them');

    const kindField = field('Kind', kindSelect,
      existing?.system
        ? 'Built in — the kind cannot change, but everything below can'
        : 'What the system does with a day charged to this');

    const syncStaffPick = () => {
      staffPickField.style.display = kindSelect.value === 'leave' ? '' : 'none';
    };
    kindSelect.addEventListener('change', syncStaffPick);
    syncStaffPick();

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
        kindField,
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
        staffPickField,
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
          staffPick: form.get('staffPick') !== 'false',
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
        {
          key: 'staff_pick',
          label: 'Staff can ask',
          // Only a kind of leave ever appears on their list, so the question
          // does not arise for anything else and a Yes there would be a lie.
          format: (v, r) => (r.kind === 'leave' ? yesNo(v) : h('span.muted', '—')),
        },
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
      card('Links', { note: 'How long a link to a member of staff lasts' },
        h('label.field',
          h('span', 'A link to a member of staff lasts'),
          h('input', {
            type: 'number', name: 'hr_link_days', min: 1, max: 90,
            value: s.hr_link_days ?? 21,
          }),
          h('small.muted', 'Days before a details or signing link stops working'),
        ),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'The property\u2019s own name, address and logo moved to the Company tab, '
          + 'where the rest of what goes on a payslip is set.'),
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

      card('What the terminal tells them', { note: 'On their own phone' },
        h('label.field',
          h('span', 'When they clock in and out'),
          h('select', { name: 'att_clock_push' },
            h('option', { value: '1', selected: (s.att_clock_push ?? '1') !== '0' },
              'Send them the time it recorded'),
            h('option', { value: '0', selected: (s.att_clock_push ?? '1') === '0' },
              'Say nothing'),
          )),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'The terminal beeps and shows a name, which does not say what time went down or '
          + 'whether it counts as late. This does, on the phone of the person who tapped and '
          + 'nobody else, at the moment it happens.'),

        h('label.field',
          h('span', 'When a shift has started and nothing has been recorded'),
          h('select', { name: 'att_late_nudge' },
            h('option', { value: '1', selected: (s.att_late_nudge ?? '1') !== '0' },
              'Chase them every half hour until they clock in'),
            h('option', { value: '0', selected: (s.att_late_nudge ?? '1') === '0' },
              'Say nothing'),
          )),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'It waits out the grace the shift already allows, stops the moment a clock-in is '
          + 'recorded, and stops on its own when the shift has ended.'),

        h('label.field',
          h('span', 'Ten minutes before their shift ends'),
          h('select', { name: 'att_clockout_nudge' },
            h('option', { value: '1', selected: (s.att_clockout_nudge ?? '1') !== '0' },
              'Remind them to clock out before they leave'),
            h('option', { value: '0', selected: (s.att_clockout_nudge ?? '1') === '0' },
              'Say nothing'),
          )),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'Only to somebody who clocked in and has not clocked out yet, and once per shift. '
          + 'A day with one tap is held back rather than counted, so this is the cheapest way '
          + 'to stop the pile of days somebody has to reconstruct at the end of the month. '
          + 'All of these need notifications turned on in the browser on their phone.'),
      ),

      card('What staff see', { note: 'On My shifts and My report' },
        h('label.field',
          h('span', 'How much leave they have left'),
          h('select', { name: 'att_show_balance' },
            h('option', { value: '1', selected: (s.att_show_balance ?? '1') !== '0' },
              'Show it on their screen'),
            h('option', { value: '0', selected: (s.att_show_balance ?? '1') === '0' },
              'Keep it off their screen'),
          )),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'It is their own figure, so nothing here is confidential either way. Turn it off while '
          + 'the balances are still being tidied up after an import: a number in front of somebody '
          + 'is a number they will ask about, and it should be right before it is published to '
          + 'everybody. They can still ask for leave with it off.'),

        h('label.field',
          h('span', 'Public holidays on their monthly report'),
          h('select', { name: 'att_report_holidays' },
            h('option', { value: '1', selected: (s.att_report_holidays ?? '1') !== '0' },
              'Count them'),
            h('option', { value: '0', selected: (s.att_report_holidays ?? '1') === '0' },
              'Leave them out'),
          )),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'A property that pays for public holidays wants them in the figure; one that treats '
          + 'them as ordinary rest days does not. Left out, they go from the totals and from the '
          + 'day-by-day together, so the two halves of the report cannot disagree. This changes '
          + 'only what staff read about themselves — every management report counts them as it '
          + 'always did.'),
      ),
    ),
    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn.btn-primary', { type: 'submit' }, 'Save the rules'),
    ),
  );

  return h('div',
    form,
    await mapsCard(reload),
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

// ---------------------------------------------------------------------------
// What counts as too much here
// ---------------------------------------------------------------------------

/**
 * The eight figures the rota is measured against.
 *
 * Four of them are Act 651 and are seeded at the statutory figure. A property
 * may tighten one; loosening one is possible too, and the screen says plainly
 * what that means rather than quietly allowing it. The other four are this
 * trade's rules of thumb and genuinely arguable — a property running four-on
 * four-off would say something different about six days in a row, and should
 * be able to.
 *
 * None of it blocks a rota. A hotel has nights when somebody simply has to
 * cover, and an app that refuses to record what happened gets worked around on
 * paper, at which point it knows nothing at all.
 */
const WORKLOAD_LIMITS = [
  {
    key: 'wl_dailyRestHours',
    label: 'Rest between shifts',
    unit: 'hours',
    fallback: 12,
    law: 'Act 651 s.35',
    hint: 'Clock-out to the next clock-in',
  },
  {
    key: 'wl_weeklyRestHours',
    label: 'Unbroken rest each week',
    unit: 'hours',
    fallback: 48,
    law: 'Act 651 s.36',
    hint: 'One stretch, not two days added together',
  },
  {
    key: 'wl_weeklyHours',
    label: 'Hours in a week',
    unit: 'hours',
    fallback: 40,
    law: 'Act 651 s.33',
    hint: 'Before overtime starts',
  },
  {
    key: 'wl_dailyHours',
    label: 'Hours in a day',
    unit: 'hours',
    fallback: 9,
    law: 'Act 651 ss.33–34',
    hint: 'Eight, stretching to nine where another day is shorter',
  },
  {
    key: 'wl_consecutiveDays',
    label: 'Days in a row without one off',
    unit: 'days',
    fallback: 6,
    hint: 'Where hotel practice puts the line',
  },
  {
    key: 'wl_nightsPerFortnight',
    label: 'Night shifts in a fortnight',
    unit: 'nights',
    fallback: 7,
    hint: 'A shift touching midnight to five counts as a night',
  },
  {
    key: 'wl_flipsPerFortnight',
    label: 'Swaps between nights and days',
    unit: 'swaps',
    fallback: 2,
    hint: 'The change of rhythm costs more sleep than the hours do',
  },
  {
    key: 'wl_weekendsPerMonth',
    label: 'Weekends worked in a month',
    unit: 'weekends',
    fallback: 3,
    hint: 'Counted so the same people are not always the ones giving theirs up',
  },
  {
    key: 'wl_sundaysOffPerMonth',
    label: 'Sundays off in a month',
    unit: 'Sundays',
    fallback: 1,
    min: 0,
    hint: 'The fewest anybody should get. Set it to 0 if Sundays are like any other day here',
  },
  {
    key: 'wl_sundaysWorkedPerMonth',
    label: 'Sundays worked in a month',
    unit: 'Sundays',
    fallback: 2,
    min: 0,
    hint: 'The most before the rota marks it. Reaching this is what puts the mark on the '
      + 'Sunday cells, while there is still time to move somebody',
  },
];

/**
 * The figures the payroll is worked out on.
 *
 * They are the Ghana Revenue Authority's and SSNIT's, not the property's, and
 * they change with the budget. They live here rather than in the code because
 * the alternative is a payroll that is wrong every January until somebody
 * ships a new version of the app.
 *
 * The band table is the tax itself, so it is edited as a table rather than as
 * a line of JSON: a comma in the wrong place would be a wrong figure on every
 * payslip in the property.
 */
/** 'YYYY-MM' as somebody would say it. */
/**
 * The key that lets an address box find a real place.
 *
 * ITS OWN FORM, ON PURPOSE. Everything else on this tab is one form with one
 * Save, and a key in it would be cleared every time somebody saved the rules
 * for an unrelated reason — a blank box being read as "take it off". So this
 * one saves itself and is never touched by the button above it.
 *
 * THE KEY IS NEVER SHOWN BACK. It is not carried in any answer the browser
 * gets: the screen is told whether one is set and where it came from, and
 * nothing more. Somebody who has lost it makes another at Google, which is
 * what they would have to do anyway.
 */
async function mapsCard(reload) {
  const ready = await api.placesReady().catch(() => ({ ready: false, from: null }));
  const bySecret = ready.from === 'secret';

  const form = h('form.maps-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    // Blank means leave it alone, not take it off. Removing one is its own
    // button, because it should take a decision rather than an empty box.
    if (!String(values.maps_key ?? '').trim()) delete values.maps_key;
    try {
      await api.attUpdateSettings(values);
      toast('Saved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  form.append(
    h('label.field',
      h('span', 'Google maps key'),
      h('input', {
        type: 'password', name: 'maps_key', maxlength: 200, autocomplete: 'off',
        placeholder: ready.ready ? 'One is set. Type a new one to replace it' : 'Paste it here',
        disabled: bySecret,
      }),
      h('small.muted', bySecret
        ? 'Set as a Worker secret, which beats anything typed here. Change it with '
          + 'wrangler secret put GOOGLE_MAPS_KEY.'
        : 'From a Google Cloud project with the Places API (New) turned on and billing '
          + 'enabled. It is never shown again and never sent to a browser.')),

    h('label.field',
      h('span', 'Offer places in'),
      h('input', {
        type: 'text', name: 'maps_region', maxlength: 2, value: ready.region ?? '',
        placeholder: 'gh', style: { maxWidth: '6rem' },
      }),
      h('small.muted', 'Two letters, like gh for Ghana. Blank offers places anywhere.')),

    h('div.btn-row',
      h('button.btn.btn-primary', { type: 'submit', disabled: bySecret && !ready.region },
        'Save'),
      ready.ready && !bySecret
        ? h('button.btn-sm', {
          type: 'button',
          onclick: async () => {
            if (!confirmAction('Take the key off? Address boxes go back to being plain '
              + 'text and candidates stop getting directions.')) return;
            await api.attUpdateSettings({ maps_key: '' });
            toast('Taken off.', 'good');
            await reload();
          },
        }, 'Take it off')
        : null),
  );

  return card('Finding places on a map', {
    note: ready.ready ? (bySecret ? 'On, from a secret' : 'On') : 'Off',
    wide: true,
  },
  h('p.muted',
    'With a key set, the Where box when publishing interview times finds real places as '
    + 'somebody types, and what they pick becomes a directions link on the candidate’s own '
    + 'page. Without one, that box is an ordinary line of text and nothing else changes.'),
  h('p.muted', { style: { fontSize: '.85rem' } },
    'The key stays on the server. The usual way of doing this puts it in the source of '
    + 'every page that has an address box; here the browser asks this app and this app asks '
    + 'Google, so there is nothing in a page to copy.'),
  form);
}

function sayMonth(value) {
  if (!value || value === '0000-01') return 'Everything before that';
  const [year, month] = String(value).split('-');
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return at.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function taxTab(reload) {
  const [data, history] = await Promise.all([api.attBootstrap(), api.attTaxTables()]);
  const s = data.settings;

  let bands;
  try {
    bands = JSON.parse(s.pay_bands ?? '[]');
  } catch {
    bands = [];
  }
  if (!bands.length) {
    bands = [
      { width: 490, rate: 0 }, { width: 110, rate: 0.05 }, { width: 130, rate: 0.1 },
      { width: 3166.67, rate: 0.175 }, { width: 16000, rate: 0.25 },
      { width: 30520, rate: 0.3 }, { width: null, rate: 0.35 },
    ];
  }

  const rows = [];
  const list = h('tbody');

  const draw = () => {
    mount(list, rows.map((row, i) => h('tr',
      h('td.muted', i === 0 ? 'First' : (row.width.value === '' ? 'Everything above' : 'Then the next')),
      h('td.num', row.width),
      h('td.num', row.rate, h('span.muted', ' %')),
      h('td.num', h('button.btn-ghost.btn-sm', {
        type: 'button',
        'aria-label': 'Take this band off',
        onclick: () => { rows.splice(i, 1); draw(); },
      }, '✕')))));
  };

  const addRow = (band = { width: '', rate: 0 }) => {
    rows.push({
      width: h('input.med-amount', {
        type: 'number', step: '0.01', min: '0',
        value: band.width == null ? '' : band.width,
        placeholder: 'the rest',
        'aria-label': 'How much of the income this band covers',
        onchange: draw,
      }),
      rate: h('input.pay-score', {
        type: 'number', step: '0.5', min: '0', max: '100',
        value: Math.round(Number(band.rate) * 1000) / 10,
        'aria-label': 'The rate for this band',
      }),
    });
  };

  for (const band of bands) addRow(band);
  draw();

  // Which month these figures start in. A tax table is a fact about a period,
  // not about the property: the bands that applied in January are the January
  // bands however many budgets have happened since.
  //
  // IT OPENS ON THE TABLE THAT IS ON SCREEN, not on today. The figures shown
  // are the newest dated table's, so the month has to be that table's month or
  // the two halves of the form disagree — somebody dated a table January,
  // saved, and the box came back saying August, which reads as the change
  // having been thrown away. Worse, the next save would then quietly make a
  // second table starting in August.
  const dated = (history.tables ?? []).filter((t) => t.fromMonth !== '0000-01');
  const thisMonth = new Date().toISOString().slice(0, 7);
  const fromMonth = h('input', {
    type: 'month',
    name: 'fromMonth',
    required: true,
    value: dated[0]?.fromMonth ?? thisMonth,
  });

  // Said under the box, so changing an existing table does not look like
  // adding one.
  const startNote = h('small.muted');
  const sayStart = () => {
    const already = dated.some((t) => t.fromMonth === fromMonth.value);
    startNote.textContent = already
      ? 'Changes the table that already starts then. Months before it keep whatever was in '
        + 'force, and a month already closed keeps its payslips either way'
      : 'A new table from that month on. Months before it keep whatever was in force then, '
        + 'and a month already closed keeps its payslips either way';
  };
  fromMonth.addEventListener('input', sayStart);
  sayStart();

  const form = h('form.att-rules');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const table = rows.map((row) => ({
        width: row.width.value === '' ? null : Number(row.width.value),
        rate: (Number(row.rate.value) || 0) / 100,
      }));
      const asked = Object.fromEntries(new FormData(form).entries());
      const share = (key) => (asked[key] === '' || asked[key] == null
        ? null
        : Number(asked[key]) / 100);

      await api.attSaveTaxTable({
        fromMonth: fromMonth.value,
        label: asked.pay_bands_label,
        bands: table,
        ssnitEmployee: share('pay_ssnit_employee'),
        ssnitEmployer: share('pay_ssnit_employer'),
        bonusRate: share('pay_bonus_rate'),
        bonusShare: share('pay_bonus_share'),
      });
      toast(`Saved. Payrolls from ${sayMonth(fromMonth.value)} on use these figures; `
        + 'earlier months keep the table that was in force then.', 'good');
      await reload('tax');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  const percent = (key, label, value, hint) => h('label.field',
    h('span', label),
    h('input', {
      type: 'number', name: key, step: '0.1', min: '0', max: '50',
      value: Math.round(Number(value) * 1000) / 10,
    }),
    h('small.muted', hint));

  form.append(
    card('The graduated bands', { note: 'Income Tax Act 2015 (Act 896)' },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Monthly chargeable income, band by band, exactly as the GRA publishes them: so much '
        + 'at nothing, then the next so much at five per cent, and so on. The last band has no '
        + 'width — everything above it is taxed at that rate.'),
      h('div.field-row',
        h('label.field',
          h('span', 'What to call this table'),
          h('input', {
            type: 'text', name: 'pay_bands_label', maxlength: 80,
            value: s.pay_bands_label ?? 'GRA monthly bands',
          }),
          h('small.muted', 'Printed on every payslip, so a slip can be checked against the '
            + 'table it was worked out on')),
        h('label.field',
          h('span', 'These figures start in'),
          fromMonth,
          startNote)),
      h('div.table-wrap', h('table.med-set',
        h('thead', h('tr',
          h('th', ''), h('th.num', 'How much'), h('th.num', 'At'), h('th', ''),
        )),
        list)),
      h('button.btn-sm', {
        type: 'button',
        style: { marginTop: '.5rem' },
        onclick: () => { addRow(); draw(); },
      }, 'Add a band')),

    card('SSNIT', { note: 'National Pensions Act 2008 (Act 766)' },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Both halves are worked out on basic salary alone, and the worker’s half comes off '
        + 'before tax. Somebody the scheme does not cover is ticked out of it on the payroll '
        + 'screen rather than here.'),
      h('div.field-row',
        percent('pay_ssnit_employee', 'From the worker', s.pay_ssnit_employee ?? 0.055,
          'per cent of basic'),
        percent('pay_ssnit_employer', 'From the property', s.pay_ssnit_employer ?? 0.13,
          'per cent of basic'))),

    card('Bonus', { note: 'Act 896, the 5% final tax' },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Bonus up to a share of annual basic salary is taxed at a flat rate as a final tax, and '
        + 'anything above that joins employment income at the graduated rates. The share is '
        + 'annual, so what has already been paid this year is counted first.'),
      h('div.field-row',
        percent('pay_bonus_rate', 'The flat rate', s.pay_bonus_rate ?? 0.05, 'per cent'),
        percent('pay_bonus_share', 'Up to this share of annual basic', s.pay_bonus_share ?? 0.15,
          'per cent of a year’s basic salary'))),

    h('div.btn-row', h('button.btn.btn-primary', { type: 'submit' }, 'Save the figures')),

    taxHistoryCard(history, reload),
  );

  return form;
}

/**
 * Every set of figures the property has used, and the month each started.
 *
 * Worth showing rather than only storing: somebody asked in November why
 * March came to what it did, and the answer is a row on this list.
 */
function taxHistoryCard(history, reload) {
  const tables = history.tables ?? [];
  if (!tables.length) {
    return card('Tables by date', { note: 'Nothing dated yet', wide: true },
      h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
        'One set of figures so far, used for every month. Save a change above with a month '
        + 'against it and what you are using now is kept as its own table, so months behind '
        + 'the change keep the rates that were in force then.'));
  }

  return card('Tables by date', { note: `${tables.length}`, wide: true },
    table([
      {
        key: 'fromMonth',
        label: 'From',
        format: (v) => (v === '0000-01'
          ? h('span.muted', 'Everything before')
          : h('strong', sayMonth(v))),
      },
      { key: 'label', label: 'Called' },
      {
        key: 'ssnitEmployee',
        label: 'SSNIT',
        align: 'right',
        format: (v, r) => h('small', `${(v * 100).toFixed(1)}% + ${(r.ssnitEmployer * 100).toFixed(1)}%`),
      },
      {
        key: 'bands',
        label: 'Bands',
        align: 'right',
        format: (v) => h('small.muted', `${(v ?? []).length}`),
      },
      {
        key: 'setBy',
        label: 'Set by',
        format: (v, r) => h('small.muted', `${v ?? 'somebody'} · ${String(r.setAt ?? '').slice(0, 10)}`),
      },
      {
        key: 'actions',
        label: '',
        format: (v, r) => (r.fromMonth === '0000-01' ? null : h('button.btn-sm', {
          onclick: async () => {
            if (!window.confirm(`Take the table starting ${sayMonth(r.fromMonth)} off? `
              + 'Those months go back to whatever was in force before it.')) return;
            try {
              await api.attRemoveTaxTable(r.id);
              toast('Removed.', 'good');
              await reload('tax');
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }, 'Remove')),
      },
    ], tables, { empty: 'Nothing dated yet.' }));
}

async function workloadTab(reload) {
  const data = await api.attBootstrap();
  const s = data.settings;

  const form = h('form.att-rules');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.attUpdateSettings(Object.fromEntries(new FormData(form).entries()));
      toast('Saved. The rota is measured against these from now on.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  const row = (limit) => {
    const current = s[limit.key];
    const set = current != null && current !== '' && Number(current) !== limit.fallback;
    return h('label.field',
      h('span', limit.label,
        limit.law ? h('small.pill', limit.law) : null,
        set ? h('small.pill.warn', 'changed') : null),
      h('input', {
        type: 'number', name: limit.key, min: limit.min ?? 1,
        step: limit.unit === 'hours' ? 0.5 : 1,
        value: current ?? limit.fallback,
      }),
      h('small.muted', `${limit.unit} · ${limit.hint}. Statutory or usual figure: ${limit.fallback}`),
    );
  };

  form.append(
    card('The law', { note: 'Ghana Labour Act 2003 (Act 651)' },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Seeded at the figures the Act sets. Tighten one and the app holds you to yours; '
        + 'loosen one and it stops warning about something the Act does not allow, which is '
        + 'a decision with your name on it.'),
      h('div.field-row', WORKLOAD_LIMITS.filter((l) => l.law).map(row)),
    ),

    card('This property', { note: 'Rules of thumb, and yours to set' },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'These are not law. They are where hotel practice puts the line, and a property '
        + 'running four-on four-off would put it somewhere else.'),
      h('div.field-row', WORKLOAD_LIMITS.filter((l) => !l.law).map(row)),
    ),

    h('div.btn-row', { style: { justifyContent: 'flex-end' } },
      h('button.btn-sm', {
        type: 'button',
        onclick: async () => {
          if (!window.confirm('Put every figure back to the statutory or usual one?')) return;
          try {
            await api.attUpdateSettings(Object.fromEntries(
              WORKLOAD_LIMITS.map((l) => [l.key, String(l.fallback)]),
            ));
            toast('Back to the defaults.', 'good');
            await reload();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      }, 'Back to the defaults'),
      h('button.btn.btn-primary', { type: 'submit' }, 'Save'),
    ),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Nothing here refuses a rota. A hotel has nights when somebody has to cover, and an app '
      + 'that will not record what happened gets worked around on paper. It says so, names the '
      + 'rule, and leaves the decision where it belongs. The Workload screen is where it says it.'),
  );

  return form;
}

// ---------------------------------------------------------------------------
// Birthdays
// ---------------------------------------------------------------------------

/**
 * The one message this app sends that is not about hours, lateness or money.
 *
 * It was written into the code, which made it the one message nobody here
 * could change. A property that wants to say something in its own voice had no
 * way to, and a property that would rather a person said it out loud and the
 * app stayed out of it had no way to turn it off either.
 *
 * WHAT IS ON THIS SCREEN AND WHY. The wording, obviously. But the two lists
 * under it are what makes it a screen rather than a form: who has no date of
 * birth on file, because a birthday the app never mentions looks exactly like a
 * birthday nobody has and nothing else in the app tells them apart; and what
 * has actually gone out, so a change to the wording can be checked against
 * something real rather than taken on trust.
 *
 * The preview is against a real first name off the books. A preview against
 * "John Smith" reads as a preview; the same sentence with somebody's actual
 * name in it is the thing itself, which is what makes a clumsy line obvious.
 */
async function birthdaysTab(reload) {
  const data = await api.attBirthdayManage();
  const s = data.settings;
  const property = data.property || 'work';

  const form = h('form.att-rules');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.attUpdateSettings(Object.fromEntries(new FormData(form).entries()));
      toast('Saved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  const title = h('input', {
    type: 'text', name: 'att_bd_title', maxlength: 120, value: s.title,
  });
  const line = h('textarea', { name: 'att_bd_line', rows: 3, maxlength: 300 }, s.line);
  const promptBody = h('textarea',
    { name: 'att_bd_prompt_body', rows: 3, maxlength: 300 }, s.promptBody);

  // What a real person would receive, redrawn on every keystroke. The name is
  // whoever's birthday is next, so somebody editing this is reading the
  // sentence that is actually about to go out.
  const preview = h('div.bd-set-preview');
  const drawPreview = () => {
    const first = String(data.preview.name).trim().split(/\s+/)[0];
    mount(preview,
      h('div.bd-set-note', data.preview.real
        ? `As ${data.preview.name} will read it`
        : 'Nobody has a date on file yet, so this is a stand-in name'),
      h('div.bd-set-card',
        h('strong', fillWording(title.value, first, property)),
        h('p', fillWording(line.value, first, property))),
      h('div.bd-set-card.bd-set-card-prompt',
        h('strong', `It is ${first}'s birthday today`),
        h('p', fillWording(promptBody.value, first, property))),
    );
  };
  [title, line, promptBody].forEach((el) => el.addEventListener('input', drawPreview));
  drawPreview();

  form.append(
    h('div.grid.grid-2',
      card('What they get', { note: 'On the day, once' },
        h('label.field',
          h('span', 'Wish them'),
          h('select', { name: 'att_bd_wish' },
            h('option', { value: '1', selected: s.wish }, 'Send them a message on the day'),
            h('option', { value: '0', selected: !s.wish }, 'Say nothing'),
          )),
        field('Headed', title),
        field('And it says', line),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'Write {name} where their name goes and {property} where this place’s name goes. '
          + `{name} becomes their preferred name if they have given one, and {property} is `
          + `“${property}”.`),
        h('label.field',
          h('span', 'How it reaches them'),
          h('select', { name: 'att_bd_push' },
            h('option', { value: '1', selected: s.push }, 'Push it to their phone'),
            h('option', { value: '0', selected: !s.push }, 'Leave it in the bell for them'),
          )),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'A wish that is read three days later is not a wish. Pushing needs notifications '
          + 'turned on in the browser on their phone; where they are not, it waits in the bell '
          + 'either way.'),
      ),

      card('What whoever runs the floor gets', { note: 'A prompt, not a wish' },
        h('label.field',
          h('span', 'Tell them'),
          h('select', { name: 'att_bd_prompt' },
            h('option', { value: '1', selected: s.prompt }, 'Prompt them on the day'),
            h('option', { value: '0', selected: !s.prompt }, 'Say nothing'),
          )),
        field('And it says', promptBody),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'Deliberately a different message. What somebody actually remembers about their '
          + 'birthday is a colleague saying it out loud, and an app that only sends an automatic '
          + 'message has replaced that rather than prompted it.'),
        h('label.field',
          h('span', 'Show birthdays coming up within'),
          h('input', {
            type: 'number', name: 'att_bd_ahead', min: 0, max: 365, value: s.ahead,
          })),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'Days. It fills the coming-up list on the Today screen, where a card gets made the '
          + 'day before. Nought hides the list and leaves only the day itself.'),
      ),
    ),

    card('How it reads', { wide: true }, preview),

    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn.btn-primary', { type: 'submit' }, 'Save the wording'),
      h('span.muted', { style: { alignSelf: 'center', fontSize: '.85rem' } },
        `${data.withDates} ${data.withDates === 1 ? 'person has' : 'people have'} a date on file`),
    ),
  );

  return h('div',
    form,

    // The chase list, and the reason this screen exists at all beyond the
    // wording. Absent entirely when there is nobody to chase.
    data.missing.length
      ? card('Nobody knows when these birthdays are', {
        note: `${data.missing.length}`,
        wide: true,
      },
      h('p.muted',
        'The app cannot mention a birthday it has never been told about, and a birthday it '
        + 'has never been told about looks exactly like a birthday nobody has. Their date of '
        + 'birth goes on their record, under People.'),
      table([
        { key: 'name',
          label: 'Name',
          format: (v, row) => h('a', { href: `#/person?id=${row.id}` }, v) },
        { key: 'employee_no', label: 'Number' },
        { key: 'department', label: 'Department', format: (v) => v || h('span.muted', '—') },
      ], data.missing, {
        empty: 'Everybody has one.',
        groupBy: (r) => r.department || null,
        groupNoun: ['person', 'people'],
        // Grouped and foldable because this is a list somebody walks round the
        // building with, and they walk round it one department at a time.
        fold: true,
      }))
      : null,

    card('The year', { note: `${data.withDates}`, wide: true },
      data.withDates
        ? h('div.bd-year', data.months.map((month) => h('div.bd-year-month',
          h('h3', MONTH_NAMES[month.month - 1]),
          month.people.length
            ? h('ul', month.people.map((p) => h('li',
              { class: p.isToday ? 'is-today' : '' },
              h('span.bd-year-day', String(p.day).padStart(2, '0')),
              h('a', { href: `#/att-staff?id=${p.id}` }, p.preferred || p.name))))
            : h('p.muted', 'Nobody'))))
        : emptyState('No dates on file yet',
          'Every birthday in here comes off a date of birth on somebody’s record.')),

    card('What has gone out', { note: data.sent.length ? `${data.sent.length}` : 'Nothing yet', wide: true },
      data.sent.length
        ? table([
          { key: 'at', label: 'When', format: (v) => fmtDay(String(v).slice(0, 10)) },
          { key: 'to', label: 'To' },
          { key: 'title', label: 'Said' },
          { key: 'body', label: 'And', format: (v) => h('span.muted', v || '—') },
        ], data.sent, { empty: 'Nothing yet.' })
        : emptyState('Nothing has gone out yet',
          'The daily run sends these first thing. Nothing appears here until somebody on the '
          + 'books has a birthday.')),
  );
}

/** The same two placeholders the server fills, so the preview cannot lie. */
function fillWording(text, name, property) {
  return String(text ?? '')
    .replace(/\{name\}/g, name || 'you')
    .replace(/\{property\}/g, property || 'work')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
