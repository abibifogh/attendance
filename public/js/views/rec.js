import { api } from '../api.js';
import { navigate } from '../app.js';
import { confirmAction, fmtDay, h, mount, toast, todayISO } from '../util.js';
import { card, dropdownMenu, emptyState, table } from './components.js';
import { field, formDialog, placeField } from './att-shared.js';

/**
 * Recruitment: the half of somebody's history that happens before People.
 *
 * Everything else in this app assumes a person is already on the books. How
 * they got there was a folder of CVs, a WhatsApp group and somebody's memory
 * of who was coming in on Thursday.
 *
 * THREE THINGS ON ONE SCREEN, because they are read together. What is being
 * filled, who is in the running, and what the diary looks like. Splitting them
 * across three tabs would mean nobody could answer "are we going to fill the
 * housekeeping job" without pressing twice.
 *
 * THE PIPELINE IS A LIST, NOT A BOARD. A column-per-stage board is a lovely
 * thing on a wide screen and unusable on the phone this is actually read on;
 * and with fifteen candidates in it, columns are mostly white space. So it is
 * a list grouped by stage, which folds, which is the same list on both.
 *
 * NOTHING HERE PUTS ANYBODY ON THE BOOKS. That is one press, on one person,
 * with an employee number typed into it, and it needs the setup permission on
 * top. The screen says so rather than hiding the button: "ask an
 * administrator" is a useful sentence and a missing control is not.
 */

const STAGE_TONE = {
  applied: '',
  shortlisted: 'is-shortlisted',
  interview: 'is-interview',
  offer: 'is-offer',
  hired: 'is-hired',
  declined: 'is-out',
  not_taken: 'is-out',
};

export async function renderRec(params) {
  const host = h('div');
  const data = await api.recBoard();
  const reload = async () => mount(host, await renderRec(params));

  const tab = ['pipeline', 'roles', 'diary'].includes(params.tab) ? params.tab : 'pipeline';
  const show = (next) => navigate('rec', { tab: next });

  const live = data.candidates.filter((c) => ['applied', 'shortlisted', 'interview', 'offer']
    .includes(c.stage));
  const openRoles = data.roles.filter((r) => r.status === 'open');
  const booked = data.diary.filter((s) => s.candidateId);
  const freeAhead = data.diary.filter((s) => !s.candidateId);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Recruitment'),
        h('div.sub', 'From an application to a contract'),
      ),
      data.canManage
        ? h('div.btn-row',
          h('button.btn-sm', { onclick: () => openRole(null, data, reload) }, 'Open a vacancy'),
          h('button.btn-sm.btn-primary', {
            onclick: () => addCandidate(data, reload),
          }, 'Add a candidate'),
        )
        : null,
    ),

    h('div.grid.grid-4',
      tile('Vacancies open', openRoles.length,
        openRoles.length
          ? sayPeople(openRoles.reduce((n, r) => n + Math.max(1, r.headcount), 0))
          : 'nothing being filled'),
      tile('In the running', live.length, live.length ? 'across every stage' : 'nobody'),
      tile('Interviews booked', booked.length,
        booked.length ? nextOne(booked) : 'none in the diary',
        booked.length ? 'var(--accent)' : null),
      tile('Times still free', freeAhead.length,
        freeAhead.length ? 'for candidates to take' : 'publish some',
        freeAhead.length ? null : 'var(--warn)'),
    ),

    h('div.toolbar',
      h('div.seg',
        h('button', { class: tab === 'pipeline' ? 'active' : '', onclick: () => show('pipeline') },
          'Pipeline', h('span.seg-count', String(live.length))),
        h('button', { class: tab === 'roles' ? 'active' : '', onclick: () => show('roles') },
          'Vacancies', h('span.seg-count', String(data.roles.length))),
        h('button', { class: tab === 'diary' ? 'active' : '', onclick: () => show('diary') },
          'Interviews', h('span.seg-count', String(data.diary.length))))),

    tab === 'pipeline' ? pipeline(data, reload) : null,
    tab === 'roles' ? roles(data, reload) : null,
    tab === 'diary' ? diary(data, reload) : null,
  );

  return host;
}

function tile(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, String(value)),
    h('div.stat-sub', h('span', sub)),
  );
}

const sayPeople = (n) => `${n} ${n === 1 ? 'person' : 'people'} wanted`;

const nextOne = (booked) => {
  const soonest = [...booked].sort((a, b) => `${a.day}${a.at}`.localeCompare(`${b.day}${b.at}`))[0];
  return soonest ? `next ${fmtDay(soonest.day)} at ${soonest.at}` : '';
};

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function pipeline(data, reload) {
  const byRole = new Map(data.roles.map((r) => [r.id, r]));

  // The buttons belong on the empty card too. An empty pipeline is exactly when
  // somebody wants to upload a folder of CVs, and hiding the way to do it
  // until there is already somebody in the list is the wrong way round.
  const ways = data.canManage
    ? h('div.btn-row',
      h('button.btn-sm', { onclick: () => uploadCvs(data, reload) }, 'Upload CVs'),
      h('button.btn-sm', { onclick: () => pasteList(data, reload) }, 'Paste a list'))
    : null;

  if (!data.candidates.length) {
    return card('Everybody who has applied', { wide: true, actions: ways },
      emptyState('Nobody yet',
        'Upload a folder of CVs, paste a list of names, or add somebody above. Nothing here '
        + 'ever puts anybody on the books. That is a separate press once somebody has been '
        + 'offered the job.'));
  }

  // Live stages first, in order, then the endings. Somebody comes to this
  // screen to move the pipeline along, not to read the archive.
  const order = data.stages.map((s) => s.key);
  const rows = [...data.candidates].sort((a, b) => {
    const by = order.indexOf(a.stage) - order.indexOf(b.stage);
    if (by) return by;
    return String(b.appliedOn).localeCompare(String(a.appliedOn));
  });

  /**
   * Ticking several and moving them together.
   *
   * Shortlisting is the one step genuinely done in a batch: somebody reads
   * twenty CVs in an evening and six of them are worth seeing. Six presses
   * with a dialog on each is how that turns into an afternoon, and how a
   * pipeline stops being kept up to date.
   *
   * The bar only appears once something is ticked. A row of controls above a
   * list nobody has selected anything in is a row of controls that is wrong
   * every time it is read.
   */
  const chosen = new Set();
  const bar = h('div.rec-picked', { hidden: true });

  const canMove = (r) => !['hired'].includes(r.stage);

  const refresh = () => {
    bar.hidden = chosen.size === 0;
    if (!chosen.size) return;

    const picked = rows.filter((r) => chosen.has(r.id));
    // Where they all sit now decides what is worth offering. Six people at
    // Applied get "shortlist them"; a mixed handful gets the endings and the
    // full list, because there is no one forward step for all of them.
    const stages = new Set(picked.map((r) => r.stage));
    const only = stages.size === 1 ? [...stages][0] : null;
    const next = only ? order[order.indexOf(only) + 1] : null;
    const forward = next && !['hired'].includes(next) ? next : null;

    mount(bar,
      h('span.rec-picked-count',
        `${chosen.size} ${chosen.size === 1 ? 'person' : 'people'} ticked`),
      h('div.btn-row',
        forward
          ? h('button.btn-sm.btn-primary', {
            onclick: () => moveMany(picked, forward, data, reload),
          }, `Move to ${labelOf(data.stages, forward).toLowerCase()}`)
          : null,
        // Only for people who could actually use one. Somebody already taken
        // on or turned down has nothing to be invited to.
        picked.some((r) => !['hired', 'declined', 'not_taken'].includes(r.stage))
          ? h('button.btn-sm', {
            onclick: () => inviteMany(picked, data, reload),
          }, 'Make links')
          : null,
        h('button.btn-sm', {
          onclick: () => moveMany(picked, 'not_taken', data, reload),
        }, 'Not this time'),
        // Every other stage, by name, in one press.
        //
        // This was a button called "Somewhere else" that opened a dialog with
        // a picker in it, and it read as the place things went when there was
        // nowhere sensible for them. So moving somebody back — the
        // interview fell through, put them back in the pile — looked like
        // something the app would not do, when it always would. Naming the
        // stages is the whole fix.
        dropdownMenu({
          label: 'Move to',
          title: 'Any other stage, including back to where they were',
          items: data.stages
            .filter((stage) => stage.key !== 'hired' && stage.key !== only
              && stage.key !== forward && stage.key !== 'not_taken')
            .map((stage) => ({
              label: stage.label,
              title: stage.detail,
              onClick: () => moveMany(picked, stage.key, data, reload),
            })),
        }),
        h('button.link-button', {
          onclick: () => {
            chosen.clear();
            for (const box of bodyEl.querySelectorAll('input.rec-tick')) box.checked = false;
            const all = bodyEl.querySelector('.rec-tick-all');
            if (all) { all.checked = false; all.indeterminate = false; }
            refresh();
          },
        }, 'Clear')),
    );
  };

  const tickAll = h('input.th-tick.rec-tick-all', {
    type: 'checkbox',
    title: 'Tick everybody who can be moved',
    onchange: (event) => {
      const on = event.target.checked;
      event.target.indeterminate = false;
      for (const box of bodyEl.querySelectorAll('input.rec-tick:not(:disabled)')) {
        box.checked = on;
        const id = Number(box.dataset.id);
        if (on) chosen.add(id); else chosen.delete(id);
      }
      refresh();
    },
  });

  const list = table([
    data.canManage
      ? {
        key: 'id',
        label: tickAll,
        cls: 'rec-tick-col',
        format: (v, r) => h('input.rec-tick', {
          type: 'checkbox',
          'data-id': String(v),
          // Somebody already on the books is not in the pipeline any more,
          // and nothing a batch does applies to them.
          disabled: !canMove(r),
          title: canMove(r) ? '' : 'They are on the books now',
          onchange: (event) => {
            if (event.target.checked) chosen.add(v); else chosen.delete(v);
            const boxes = [...bodyEl.querySelectorAll('input.rec-tick:not(:disabled)')];
            tickAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
            tickAll.indeterminate = !tickAll.checked && boxes.some((b) => b.checked);
            refresh();
          },
        }),
      }
      : null,
    {
      key: 'name',
      label: 'Name',
      format: (v, r) => h('a.link-button', { href: `#/rec-candidate?id=${r.id}` },
        h('div',
          h('div', v),
          h('small.muted', [
            r.roleId != null ? byRole.get(r.roleId)?.title : 'No vacancy',
            r.phone,
          ].filter(Boolean).join(' · ')))),
    },
    {
      key: 'stage',
      label: 'Where they are',
      format: (v, r) => h('div',
        h(`span.pill.rec-stage.${STAGE_TONE[v] || ''}`, labelOf(data.stages, v)),
        r.outcome ? h('small.muted', { style: { display: 'block' } }, r.outcome) : null),
    },
    {
      key: 'interview',
      label: 'Interview',
      format: (v) => (v
        ? h('div', h('div', fmtDay(v.day)), h('small.muted', `${v.at} – ${v.ends}`))
        : h('span.muted', '—')),
    },
    {
      key: 'bestRating',
      label: 'Scored',
      format: (v, r) => (r.scores
        ? h('span', v != null ? `${v}/5` : `${r.scores} note${r.scores === 1 ? '' : 's'}`)
        : h('span.muted', '—')),
    },
    {
      key: 'appliedOn',
      label: 'Applied',
      format: (v) => h('small', fmtDay(v, { withYear: true })),
    },
    {
      key: 'liveLinks',
      label: '',
      format: (v, r) => h('div.chip-row',
        v ? h('span.pill', 'link out') : null,
        r.files ? h('span.pill', `${r.files} file${r.files === 1 ? '' : 's'}`) : null),
    },
  ].filter(Boolean), rows, {
    groupBy: (r) => labelOf(data.stages, r.stage),
    // The stages in their own order. Alphabetical would put "Not this time"
    // above "Shortlisted", which is sorted correctly and reads as nonsense.
    groupOrder: data.stages.map((s) => s.label),
    groupNoun: ['person', 'people'],
    fold: true,
    rowClass: (r) => (['hired', 'declined', 'not_taken'].includes(r.stage) ? 'row-muted' : ''),
    empty: 'Nobody yet.',
  });

  const bodyEl = list;

  return card('Everybody who has applied', {
    note: `${rows.length}`,
    wide: true,
    actions: ways,
  }, bar, list);
}

const labelOf = (stages, key) => stages.find((s) => s.key === key)?.label ?? key;

// ---------------------------------------------------------------------------
// Vacancies
// ---------------------------------------------------------------------------

function roles(data, reload) {
  if (!data.roles.length) {
    return card('Vacancies', { wide: true },
      emptyState('Nothing being filled',
        'A vacancy is what candidates and interview times are published against. '
        + 'Open one and the rest of the screen has somewhere to hang.'));
  }

  return h('div.grid.grid-2',
    data.roles.map((role) => card(role.title, {
      note: role.department || null,
      actions: data.canManage
        ? h('button.btn-sm', { onclick: () => openRole(role, data, reload) }, 'Edit')
        : null,
    },
    h(`div.rec-going.tone-${role.going.tone}`, role.going.text),

    h('dl.rec-facts',
      h('div', h('dt', 'Wanted'), h('dd', `${role.headcount}`)),
      role.employment ? h('div', h('dt', 'Terms'), h('dd', sayEmployment(role.employment))) : null,
      role.hiringFor ? h('div', h('dt', 'For'), h('dd', role.hiringFor)) : null,
      h('div', h('dt', 'Opened'), h('dd', fmtDay(role.openedOn, { withYear: true }))),
      role.neededBy ? h('div', h('dt', 'Needed by'), h('dd', fmtDay(role.neededBy, { withYear: true }))) : null,
    ),

    h('div.chip-row', data.stages
      .filter((s) => role.counts[s.key])
      .map((s) => h(`span.pill.rec-stage.${STAGE_TONE[s.key] || ''}`,
        `${role.counts[s.key]} ${s.label.toLowerCase()}`))),

    role.detail ? h('p.muted.rec-detail', role.detail) : null)),
  );
}

const EMPLOYMENT = {
  permanent: 'Permanent',
  probation: 'Permanent, after probation',
  fixed: 'Fixed term',
  casual: 'Casual',
  temporary: 'Temporary cover',
};
const sayEmployment = (key) => EMPLOYMENT[key] ?? key;

async function openRole(role, data, reload) {
  const done = await formDialog({
    title: role ? role.title : 'Open a vacancy',
    submitLabel: role ? 'Save' : 'Open it',
    body: h('div',
      field('What the job is', h('input', {
        type: 'text', name: 'title', maxlength: 120, required: true,
        value: role?.title ?? '', placeholder: 'Room attendant',
      })),
      h('div.grid.grid-2',
        field('Department', h('select', { name: 'department' },
          h('option', { value: '' }, 'Not said'),
          data.departments.map((d) => h('option', {
            value: d, selected: role?.department === d,
          }, d)))),
        field('How many', h('input', {
          type: 'number', name: 'headcount', min: 1, max: 50, value: role?.headcount ?? 1,
        })),
        field('Terms', h('select', { name: 'employment' },
          h('option', { value: '' }, 'Not said'),
          Object.entries(EMPLOYMENT).map(([key, label]) => h('option', {
            value: key, selected: role?.employment === key,
          }, label)))),
        field('Needed by', h('input', {
          type: 'date', name: 'neededBy', value: role?.neededBy ?? '',
        }))),
      field('Who it is for', h('input', {
        type: 'text', name: 'hiringFor', maxlength: 120, value: role?.hiringFor ?? '',
        placeholder: 'Head housekeeper',
      }), 'Whoever the applications belong to. A name rather than a login: '
        + 'the person who wants the room attendant may not have an account.'),
      field('What the job is, in a line or two', h('textarea', {
        name: 'detail', rows: 3, maxlength: 4000,
      }, role?.detail ?? '')),
      role
        ? field('State', h('select', { name: 'status' },
          ...[['open', 'Open'], ['on_hold', 'On hold'], ['filled', 'Filled'], ['closed', 'Closed']]
            .map(([key, label]) => h('option', { value: key, selected: role.status === key }, label))))
        : null,
    ),
    onSubmit: async (form) => {
      const payload = Object.fromEntries(form.entries());
      return role ? api.recUpdateRole(role.id, payload) : api.recCreateRole(payload);
    },
  });
  if (!done) return;
  toast(role ? 'Saved.' : 'Vacancy open.', 'good');
  await reload();
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Add somebody, with whatever they handed over.
 *
 * The CV comes in here rather than only on their page afterwards, because the
 * moment somebody is typing a name off an application is the moment they are
 * holding the application. Made to wait for a second screen, it does not get
 * attached at all, and a pipeline of names with no paper behind them is a
 * pipeline nobody can shortlist from.
 *
 * Several files at once, and each one says what it is. A certificate filed as
 * a CV is a certificate nobody finds later, and what it is decides where it
 * lands on the staff record if this person is taken on.
 */
async function addCandidate(data, reload) {
  const files = h('input', {
    type: 'file',
    multiple: true,
    accept: 'image/*,application/pdf,.doc,.docx',
  });
  // Deliberately unnamed: it is read straight off the element, and a name
  // would put a field the candidate endpoint knows nothing about into every
  // payload it sends.
  const kind = h('select',
    (data.fileKinds ?? [['cv', 'CV']]).map(([key, label]) =>
      h('option', { value: key }, label)));

  const done = await formDialog({
    title: 'Add a candidate',
    submitLabel: 'Add them',
    body: h('div',
      field('Their name', h('input', {
        type: 'text', name: 'name', maxlength: 120, required: true,
      })),
      h('div.grid.grid-2',
        field('Phone', h('input', { type: 'tel', name: 'phone', maxlength: 40 })),
        field('Email', h('input', { type: 'email', name: 'email', maxlength: 160 }))),
      field('For which vacancy', rolePicker(data, null)),
      h('div.grid.grid-2',
        field('How they found us', h('select', { name: 'source' },
          h('option', { value: '' }, 'Not said'),
          data.sources.map(([key, label]) => h('option', { value: key }, label)))),
        field('Applied on', h('input', {
          type: 'date', name: 'appliedOn', value: todayISO(),
        }))),

      h('div.grid.grid-2',
        field('Their CV', files,
          'A photograph of a printed one is fine. Several at once if you have them.'),
        field('What it is', kind,
          'Applies to everything picked. Add anything of a different kind on their '
          + 'page afterwards.')),

      field('Anything worth noting', h('textarea', { name: 'note', rows: 2, maxlength: 2000 })),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'This adds somebody to the pipeline and nothing else. Nobody reaches the property’s '
        + 'books until they are offered the job and taken on, which is a separate press.'),
    ),
    onSubmit: async (form) => {
      const chosen = [...(files.files ?? [])];
      // Read before the candidate is created, so a file the browser cannot
      // read stops the whole thing rather than leaving a candidate behind with
      // half their paper.
      const payloads = [];
      for (const file of chosen) {
        payloads.push({
          filename: file.name,
          title: file.name,
          kind: kind.value,
          mime: file.type || 'application/octet-stream',
          content: await asBase64(file),
        });
      }

      const created = await api.recAddCandidate(Object.fromEntries(form.entries()));

      // Attached one at a time after the fact, because the candidate has to
      // exist for a file to belong to. If one is refused the person is still
      // added and the message says which: losing a name because a photograph
      // was the wrong type would be the worse trade.
      const refused = [];
      for (const payload of payloads) {
        try {
          await api.recAddFile(created.id, payload);
        } catch (err) {
          refused.push(`${payload.filename}: ${err.message}`);
        }
      }
      return { ...created, attached: payloads.length - refused.length, refused };
    },
  });
  if (!done) return;

  if (done.refused?.length) {
    toast(`Added, but ${done.refused.length} file did not go on. ${done.refused[0]}`, 'bad');
  } else {
    toast(done.attached
      ? `Added, with ${done.attached} file${done.attached === 1 ? '' : 's'}.`
      : 'Added.', 'good');
  }
  navigate('rec-candidate', { id: done.id });
}

/** A file as the API takes it. Read in one go: these are photographs, not films. */
function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/**
 * Move everybody ticked, in one press.
 *
 * `stage` of null asks which, for the mixed handful where there is no one
 * forward step. An ending still insists on a reason, asked once and written on
 * every one of their records, because "why was this person not taken on" is
 * the question the record exists to answer and six blanks answer it no better
 * than one.
 */
async function moveMany(picked, stage, data, reload) {
  const ending = ['declined', 'not_taken'].includes(stage);
  const target = data.stages.find((s) => s.key === stage);
  const count = `${picked.length} ${picked.length === 1 ? 'person' : 'people'}`;

  const done = await formDialog({
    title: `${target?.label ?? 'Move'}: ${count}`,
    submitLabel: `Move ${picked.length}`,
    body: h('div',
      target ? h('p.muted', target.detail) : null,

      h('ul.rec-picked-list', picked.slice(0, 12).map((p) => h('li',
        h('span', p.name),
        h('small.muted', labelOf(data.stages, p.stage))))),
      picked.length > 12
        ? h('p.muted', { style: { fontSize: '.82rem' } },
          `and ${picked.length - 12} more`)
        : null,

      ending
        ? field('Why', h('textarea', { name: 'outcome', rows: 3, maxlength: 400 }),
          'Written on every one of their records. It is the whole value of this '
          + 'afterwards: the question anybody asks a year later is why.')
        : field('Anything worth noting', h('textarea', {
          name: 'outcome', rows: 2, maxlength: 400,
        })),

      picked.some((p) => p.interview)
        ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Anybody being taken out of the pipeline gives their interview time back '
          + 'to the diary.')
        : null,
    ),
    onSubmit: async (form) => api.recMoveCandidates({
      ids: picked.map((p) => p.id),
      stage,
      outcome: form.get('outcome'),
    }),
  });
  if (!done) return;

  // One refusal does not sink the rest, so the message says what actually
  // happened rather than reporting a clean sweep.
  if (done.skipped?.length) {
    toast(`${done.moved.length} moved. ${done.skipped.length} skipped: `
      + `${done.skipped[0].name ?? 'somebody'} — ${done.skipped[0].why}`, 'warn');
  } else {
    toast(`${done.moved.length} moved.`, 'good');
  }
  await reload();
}

/**
 * A link each, for everybody ticked, and a file to keep them in.
 *
 * The point of shortlisting six people in one press is inviting six people in
 * one press. Doing it one at a time, through a dialog that shows a link once
 * and never again, is six chances to lose one.
 *
 * SO THE FIRST THING OFFERED IS THE DOWNLOAD. Every link is stored only as a
 * hash and can never be shown again; a browser closed at the wrong moment
 * loses the lot. The spreadsheet has the name, the number, the link and the
 * whole message on one row, which is both a safe copy and the shape somebody
 * actually wants for pasting them into WhatsApp one at a time.
 */
async function inviteMany(picked, data, reload) {
  const live = picked.filter((r) => !['hired', 'declined', 'not_taken'].includes(r.stage));

  const made = await formDialog({
    title: `A link each for ${live.length} ${live.length === 1 ? 'person' : 'people'}`,
    submitLabel: `Make ${live.length} link${live.length === 1 ? '' : 's'}`,
    body: h('div',
      h('p.muted', 'Nothing is sent from here. You get a link and a message for each of them, '
        + 'and a file to keep them in, to send however you already talk to people.'),

      h('ul.rec-picked-list', live.slice(0, 12).map((p) => h('li',
        h('span', p.name),
        h('small.muted', p.phone || 'no number')))),
      live.length > 12
        ? h('p.muted', { style: { fontSize: '.82rem' } }, `and ${live.length - 12} more`)
        : null,

      h('label.tickline',
        h('input', { type: 'checkbox', name: 'wantsSlot', checked: true }),
        h('span', 'Let them pick an interview time')),
      h('label.tickline',
        h('input', { type: 'checkbox', name: 'wantsDetails', checked: true }),
        h('span', 'Ask them to check their phone number and email')),
      h('label.tickline',
        h('input', { type: 'checkbox', name: 'wantsCv', checked: false }),
        h('span', 'Ask for their CV')),

      field('Anything to say', h('textarea', {
        name: 'message', rows: 3, maxlength: 600,
        placeholder: 'Thank you for applying. Please pick a time that suits you…',
      }), 'The same message on every one of them.'),
      field('Lasts', h('input', { type: 'number', name: 'days', min: 1, max: 60, value: 10 }),
        'Days.'),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'No four-digit code on a batch: a code has to be told to each person out loud on a '
        + 'call, which is the phone call this exists to remove, and one code shared by twenty '
        + 'is not really a code. Where you want one, make that link on its own from their '
        + 'page.'),
    ),
    onSubmit: async (form) => api.recInviteMany({
      ids: live.map((p) => p.id),
      wantsSlot: form.get('wantsSlot') === 'on',
      wantsDetails: form.get('wantsDetails') === 'on',
      wantsCv: form.get('wantsCv') === 'on',
      message: form.get('message'),
      days: form.get('days'),
    }),
  });
  if (!made) return;

  await showLinks(made);
  await reload();
}

/**
 * The links, once, with the file first.
 *
 * The download is the primary button and it is at the top, because it is the
 * only one of these controls that cannot be repeated. Everything else on this
 * screen is a convenience; that one is the difference between having the links
 * and having made them.
 */
async function showLinks(made) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `interview-links-${stamp}.csv`;

  const download = () => {
    const rows = [
      ['Name', 'Phone', 'Email', 'Link', 'Expires in (days)', 'Message'],
      ...made.links.map((l) => [
        l.name, l.phone ?? '', l.email ?? '', l.url, String(l.expiresInDays), l.message,
      ]),
    ];
    // A BOM, so a spreadsheet opened in Ghana reads the accented names right
    // rather than showing them as mojibake and having somebody retype them.
    const csv = `\ufeff${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  await formDialog({
    title: `${made.links.length} link${made.links.length === 1 ? '' : 's'} — save them now`,
    submitLabel: 'Done',
    wide: true,
    body: h('div',
      h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'This is the only time you will see them'),
          h('div.alert-detail', 'Only a fingerprint of each one is stored, so they cannot be '
            + 'shown again. Download the file before you close this: making them again is '
            + 'quick, but these ones will be gone.'))),

      h('div.btn-row', { style: { marginBottom: '.9rem' } },
        h('button.btn.btn-primary', { onclick: download }, 'Download the file'),
        h('button.btn-sm', {
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(
                made.links.map((l) => `${l.name}\t${l.phone ?? ''}\t${l.url}`).join('\n'),
              );
              e.target.textContent = 'Copied ✓';
            } catch {
              toast('Use the file instead.', 'bad');
            }
          },
        }, 'Copy all')),

      made.skipped?.length
        ? h('div.alert.info',
          h('span.alert-icon', 'ℹ️'),
          h('div',
            h('div.alert-title',
              `${made.skipped.length} did not get one`),
            h('div.alert-detail', made.skipped
              .map((sk) => `${sk.name ?? 'Somebody'}: ${sk.why}`).join(' '))))
        : null,

      table([
        { key: 'name', label: 'Name', format: (v, r) => h('div', h('div', v), h('small.muted', r.phone ?? '')) },
        {
          key: 'url',
          label: 'Their link',
          format: (v) => h('input.link-cell', {
            type: 'text', value: v, readonly: true, onclick: (e) => e.target.select(),
          }),
        },
        {
          key: 'id',
          label: '',
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', {
              onclick: async (e) => {
                try {
                  await navigator.clipboard.writeText(r.message);
                  e.target.textContent = 'Copied ✓';
                } catch {
                  toast('Select the link and copy it.', 'bad');
                }
              },
            }, 'Copy'),
            h('a.btn-sm', {
              href: `https://wa.me/${(r.phone ?? '').replace(/\D/g, '')}`
                + `?text=${encodeURIComponent(r.message)}`,
              target: '_blank', rel: 'noopener',
            }, 'WhatsApp')),
        },
      ], made.links, { empty: 'None were made.' }),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        `They stop working in ${made.expiresInDays} days.`),
    ),
    onSubmit: async () => ({ ok: true }),
  });
}

/** One cell of a CSV, quoted where it has to be. */
function cell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rolePicker(data, current) {
  return h('select', { name: 'roleId' },
    h('option', { value: '' }, 'Not against a vacancy'),
    data.roles
      .filter((r) => r.status !== 'closed' || r.id === current)
      .map((r) => h('option', {
        value: String(r.id), selected: current === r.id,
      }, `${r.title}${r.department ? `, ${r.department}` : ''}`)));
}

/**
 * A pasted list, read before anything is written.
 *
 * The realistic case is a stack of applications typed into a phone, or a list
 * forwarded from an agency. Same shape as every other import here: read it,
 * show what it found with a tick on each line, and only write when the second
 * button is pressed. Anybody already in the pipeline under that name is shown
 * as such and unticked, so a second paste of the same list does not double
 * everybody up.
 */
async function pasteList(data, reload) {
  const text = h('textarea', {
    rows: 8, name: 'text', maxlength: 20000,
    placeholder: 'Ama Mensah, 024 111 2222\nKofi Boateng, 020 333 4444\nYaa Owusu',
  });
  const host = h('div');
  let read = null;
  const chosen = new Set();

  const preview = () => {
    if (!read) return;
    mount(host,
      h('p.muted', `${read.rows.length} name${read.rows.length === 1 ? '' : 's'} found. `
        + 'Untick anybody you do not want.'),
      h('div.diff', read.rows.map((row, i) => h('label.diff-row',
        h('input', {
          type: 'checkbox',
          checked: chosen.has(i),
          onchange: (e) => (e.target.checked ? chosen.add(i) : chosen.delete(i)),
        }),
        h('div',
          h('div.diff-label', row.name,
            row.already ? h('span.pill.warn', `already ${row.already.label.toLowerCase()}`) : null),
          h('div.diff-values',
            h('span.muted', [row.phone, row.email].filter(Boolean).join(' · ') || 'no number'))),
      ))));
  };

  const done = await formDialog({
    title: 'Paste a list of names',
    submitLabel: 'Add the ticked ones',
    wide: true,
    body: h('div',
      h('p.muted', 'One person per line. Put their number after a comma if you have it. '
        + 'It reads names and nothing else: nobody reaches the books this way.'),
      field('The list', text),
      h('div.btn-row',
        h('button.btn-sm', {
          type: 'button',
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              read = await api.recReadCandidates(text.value);
              chosen.clear();
              read.rows.forEach((row, i) => { if (!row.already) chosen.add(i); });
              preview();
            } catch (err) {
              toast(err.message, 'bad');
            }
            event.target.disabled = false;
          },
        }, 'Read it')),
      host,
      field('Add them all against', rolePicker(data, null)),
    ),
    onSubmit: async (form) => {
      if (!read) throw new Error('Press "Read it" first, so you can see what it found.');
      const rows = read.rows.filter((_, i) => chosen.has(i));
      if (!rows.length) throw new Error('Nothing is ticked.');
      return api.recImportCandidates({ roleId: form.get('roleId'), rows });
    },
  });
  if (!done) return;
  toast(`${done.added} added.`, 'good');
  await reload();
}

/**
 * A stack of CVs, read and then added.
 *
 * The way applications actually arrive here is twenty files in a folder or a
 * WhatsApp thread. Typing twenty names off them is an afternoon nobody has, so
 * the files go in together and what could be read off each one comes back for
 * checking.
 *
 * EVERY FIELD IS EDITABLE, because a name read off a CV is a guess. The screen
 * says where each one came from — the heading, the first line, the file name —
 * so somebody checking knows how much to trust it, and a photograph says
 * plainly that there was no text to read and leaves the box empty.
 *
 * Nothing is written until the second press, and each CV lands on the person
 * it came from.
 */
async function uploadCvs(data, reload) {
  const picker = h('input', {
    type: 'file',
    multiple: true,
    accept: 'image/*,application/pdf,.doc,.docx',
  });
  const host = h('div');
  const status = h('p.muted');

  // Held here between the two presses. A Worker has nowhere to keep twenty
  // files while somebody reads a list, so the browser keeps them and sends
  // them again with the ticks.
  let held = [];
  const rows = new Map();

  const draw = () => {
    if (!held.length) return mount(host, []);

    mount(host,
      h('p.muted', `${held.length} file${held.length === 1 ? '' : 's'} read. `
        + 'Correct anything that is wrong, and untick anybody you do not want.'),

      h('div.cv-rows', held.map((row, i) => {
        if (row.problem) {
          return h('div.cv-row.is-bad',
            h('div.cv-file', row.filename),
            h('div.cv-problem', row.problem));
        }

        const state = rows.get(i);
        const name = h('input', {
          type: 'text', maxlength: 120, value: state.name ?? '',
          placeholder: 'Their name',
          oninput: (e) => { state.name = e.target.value; },
        });
        const phone = h('input', {
          type: 'tel', maxlength: 40, value: state.phone ?? '', placeholder: 'Phone',
          oninput: (e) => { state.phone = e.target.value; },
        });
        const email = h('input', {
          type: 'email', maxlength: 160, value: state.email ?? '', placeholder: 'Email',
          oninput: (e) => { state.email = e.target.value; },
        });

        return h('div.cv-row',
          h('label.cv-tick',
            h('input', {
              type: 'checkbox',
              checked: state.take,
              onchange: (e) => { state.take = e.target.checked; },
            })),
          h('div.cv-body',
            h('div.cv-file',
              row.filename,
              h('small.muted', `${Math.round(row.bytes / 1000)} KB`),
              row.already
                ? h('span.pill.warn', `already ${row.already.label.toLowerCase()}`)
                : null),
            h('div.cv-fields', name, phone, email),
            h('small.muted.cv-note',
              row.note
                ? row.note
                : row.nameFrom
                  ? `Name read from ${row.nameFrom}. Check it.`
                  : 'No name could be read. Type it.')),
        );
      })));
  };

  picker.addEventListener('change', async () => {
    const chosen = [...(picker.files ?? [])];
    if (!chosen.length) return;
    picker.disabled = true;
    status.textContent = `Reading ${chosen.length} file${chosen.length === 1 ? '' : 's'}…`;

    try {
      const files = [];
      for (const file of chosen) {
        files.push({
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          content: await asBase64(file),
        });
      }
      const read = await api.recReadCvs(files);

      held = read.rows;
      rows.clear();
      held.forEach((row, i) => {
        if (row.problem) return;
        rows.set(i, {
          // Anybody already in the pipeline starts unticked, so a folder
          // uploaded twice does not double everybody up.
          take: Boolean(row.name) && !row.already,
          name: row.name ?? '',
          phone: row.phone ?? '',
          email: row.email ?? '',
          content: files[i]?.content,
          mime: files[i]?.mime,
          filename: row.filename,
        });
      });
      status.textContent = read.unread
        ? `${read.read} read, ${read.unread} that could not be read. Type those names.`
        : `${read.read} read.`;
      draw();
    } catch (err) {
      toast(err.message, 'bad');
      status.textContent = '';
    }
    picker.disabled = false;
  });

  const done = await formDialog({
    title: 'Upload CVs',
    submitLabel: 'Add the ticked ones',
    wide: true,
    body: h('div',
      h('p.muted', 'Several at once. Each one is read for a name, a number and an email, and '
        + 'nothing is written until you press Add. The CV goes on the person it came from.'),
      field('Which vacancy are these for', rolePicker(data, null)),
      h('div.grid.grid-2',
        field('The files', picker),
        field('How they found us', h('select', { name: 'source' },
          h('option', { value: '' }, 'Not said'),
          data.sources.map(([key, label]) => h('option', { value: key }, label))))),
      status,
      host,
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'A name read off a CV is a guess: there is no marker for one, so it is taken from the '
        + 'heading, the first line, or the file name, whichever is there. A photograph has no '
        + 'text in it at all and its name is left for you.'),
    ),
    onSubmit: async (form) => {
      const taking = [...rows.values()].filter((r) => r.take);
      if (!taking.length) throw new Error('Nothing is ticked.');
      if (taking.some((r) => !String(r.name).trim())) {
        throw new Error('One of the ticked ones has no name. Type it, or untick it.');
      }
      return api.recImportCvs({
        roleId: form.get('roleId'),
        source: form.get('source'),
        rows: taking,
      });
    },
  });
  if (!done) return;

  toast(done.refused?.length
    ? `${done.added} added, ${done.refused.length} without their file.`
    : `${done.added} added.`, done.refused?.length ? 'warn' : 'good');
  await reload();
}

// ---------------------------------------------------------------------------
// The diary
// ---------------------------------------------------------------------------

/**
 * When the property is free, and who has taken what.
 *
 * By day rather than as a table, because a diary is read as days. A free time
 * and a taken one look different at a glance: the whole question somebody asks
 * of this screen is how much of the morning is still going spare.
 */
function diary(data, reload) {
  const days = [];
  for (const slot of data.diary) {
    const last = days[days.length - 1];
    if (last && last.day === slot.day) last.slots.push(slot);
    else days.push({ day: slot.day, slots: [slot] });
  }

  return h('div',
    card('The interview diary', {
      note: data.diary.length ? `${data.diary.length} time${data.diary.length === 1 ? '' : 's'}` : 'Empty',
      wide: true,
      actions: data.canManage
        ? h('button.btn-sm.btn-primary', { onclick: () => publishSlots(data, reload) },
          'Publish times')
        : null,
    },
    h('p.muted',
      'Publish when you are free and the candidates choose. A time somebody is told to attend '
      + 'is a time half of them cannot make, and the phone calls that follow are the whole cost '
      + 'of arranging interviews.'),

    days.length
      ? h('div.rec-diary', days.map((day) => h('div.rec-diary-day',
        h('div.rec-diary-head',
          h('h3', fmtDay(day.day, { withYear: true })),
          h('small.muted', sayDay(day.slots)),
          data.canManage
            ? h('button.link-button', { onclick: () => editDay(day, data, reload) },
              'Edit this day')
            : null),

        h('div.rec-slots', day.slots.map((slot) => h(
          `div.rec-slot${slot.candidateId ? '.is-taken' : ''}`,
          h('div.rec-slot-time', h('strong', slot.at), h('small', `– ${slot.ends}`)),
          slot.candidateId
            ? h('a.rec-slot-who', { href: `#/rec-candidate?id=${slot.candidateId}` },
              slot.candidateName,
              h('small.muted', slot.takenBy === 'them' ? 'they chose it' : `booked by ${slot.takenBy}`))
            : h('span.rec-slot-free', 'Free'),
          h('div.rec-slot-meta',
            slot.roleTitle ? h('small', slot.roleTitle) : h('small.muted', 'any vacancy'),
            slot.interviewer ? h('small.muted', `${slot.interviewer} interviewing`) : null,
            slot.place
              ? (slot.directions
                ? h('a.rec-slot-map', {
                  href: slot.directions, target: '_blank', rel: 'noopener',
                  title: 'Open in Maps',
                }, slot.place)
                : h('small.muted', slot.place))
              : null),
          data.canManage
            ? h('div.rec-slot-tools',
              h('button.rec-slot-tool', {
                type: 'button',
                title: 'Change this time',
                onclick: () => editSlot(slot, data, reload),
              }, '✎'),
              h('button.rec-slot-tool', {
                type: 'button',
                title: slot.candidateId ? 'Cancel this interview' : 'Take this time out',
                onclick: () => dropSlot(slot, reload),
              }, '✕'))
            : null,
        ))))))
      : emptyState('Nothing published',
        'Publish a morning of times and a candidate with a link can take one.')),
  );
}

/** How much of a morning is spoken for, which is the question anybody asks. */
function sayDay(slots) {
  const taken = slots.filter((s) => s.candidateId).length;
  if (!taken) return `${slots.length} free`;
  if (taken === slots.length) return 'all taken';
  return `${taken} of ${slots.length} taken`;
}

/**
 * Who is on the panel, picked off the staff list.
 *
 * A name typed in a box printed and did nothing else. The moment a candidate
 * takes a time somebody has to be told, and "Kwame" is not somebody the app
 * can tell.
 *
 * SEVERAL OF THEM, because an interview at a property this size is the head of
 * department and whoever runs the place sitting in together. Chips rather than
 * a list of six-and-twenty tick boxes: a panel is two people out of two dozen,
 * so the control should be small until it is used and should show what has
 * been chosen rather than making somebody scan for the ticks.
 *
 * SOMEBODY ELSE IS STILL AN ANSWER. An owner, a consultant, somebody who does
 * not work here: the last option in the picker opens a plain box, and
 * everything works as it did except that they cannot be notified. The line
 * underneath says which of the two you have ended up with, and how many of the
 * people chosen can actually be reached, rather than leaving somebody to
 * wonder why no notice arrived.
 */
function panelField(data, current = {}) {
  const roster = data.panel ?? [];
  const chosen = [...(current.staffIds ?? [])].filter((id) => roster.some((p) => p.id === id));

  const typed = h('input', {
    type: 'text', maxlength: 160, placeholder: 'Their name',
    value: chosen.length ? '' : (current.name ?? ''),
  });
  const typedWrap = h('div.rec-who-typed', { hidden: chosen.length > 0 || !current.name }, typed);
  const chips = h('div.rec-panel-chips');
  const note = h('small.muted.rec-who-note');

  const picker = h('select',
    h('option', { value: '' }, chosen.length ? 'Add somebody else…' : 'Nobody named yet'),
    roster.map((person) => h('option', { value: String(person.id) },
      `${person.name}${person.department ? ` — ${person.department}` : ''}`
      + `${person.canBeTold ? '' : ' (no login)'}`)),
    h('option', { value: 'other' }, 'Somebody not on the books…'));

  const say = () => {
    if (picker.value === 'other') {
      note.textContent = 'Not on the books, so nothing can be sent to them. '
        + 'You will be told, and can pass it on.';
      return;
    }
    if (!chosen.length) {
      note.textContent = 'Nobody is named, so nobody is told when a time is taken.';
      return;
    }
    const people = chosen.map((id) => roster.find((p) => p.id === id));
    const reachable = people.filter((p) => p?.canBeTold);

    if (reachable.length === people.length) {
      note.textContent = people.length === 1
        ? 'They get a notice on their phone the moment a candidate takes one of these times.'
        : `All ${people.length} get a notice on their phone the moment a candidate takes one `
          + 'of these times.';
    } else if (!reachable.length) {
      note.textContent = people.length === 1
        ? 'They have no login, so nothing can be sent to them. You will be told.'
        : 'None of them have a login, so nothing can be sent to them. You will be told.';
    } else {
      const without = people.filter((p) => !p?.canBeTold).map((p) => p.name).join(' and ');
      note.textContent = `${reachable.length} of ${people.length} get a notice. `
        + `${without} ${people.length - reachable.length === 1 ? 'has' : 'have'} no login, `
        + 'so pass it on to them yourself.';
    }
  };

  const drawChips = () => {
    mount(chips, chosen.map((id) => {
      const person = roster.find((p) => p.id === id);
      return h(`span.rec-chip${person?.canBeTold ? '' : '.is-unreachable'}`,
        h('span', person?.name ?? 'Somebody'),
        person?.canBeTold ? null : h('small', 'no login'),
        h('button', {
          type: 'button',
          'aria-label': `Take ${person?.name ?? 'them'} off the panel`,
          onclick: (e) => {
            // The whole field sits inside a <label>, and a label forwards a
            // click to the control inside it. Without this the handler runs
            // twice, and the second run takes somebody else off the panel.
            e.preventDefault();
            const at = chosen.indexOf(id);
            if (at === -1) return;
            chosen.splice(at, 1);
            drawChips();
            picker.options[0].textContent = chosen.length ? 'Add somebody else…' : 'Nobody named yet';
            say();
          },
        }, '✕'));
    }));
  };

  picker.addEventListener('change', () => {
    const value = picker.value;
    if (value === 'other') {
      typedWrap.hidden = false;
      say();
      return;
    }
    typedWrap.hidden = true;
    const id = Number(value);
    if (Number.isInteger(id) && id > 0 && !chosen.includes(id)) chosen.push(id);
    picker.value = '';
    picker.options[0].textContent = chosen.length ? 'Add somebody else…' : 'Nobody named yet';
    drawChips();
    say();
  });

  drawChips();
  say();

  return {
    el: h('div', chips, picker, typedWrap, note),
    get value() {
      // A typed name and a picked panel are two different answers, and the
      // chips win: somebody who has picked two people and left an old name in
      // the box meant the two people.
      return chosen.length
        ? { interviewerStaffIds: chosen, interviewer: '' }
        : { interviewerStaffIds: [], interviewer: typed.value };
    },
  };
}

async function publishSlots(data, reload) {
  // The Where box, which finds a real place while somebody types in it. Where
  // no key is set it is an ordinary text box and nobody sees a difference.
  const where = placeField({
    name: 'place',
    value: data.place || '',
    placeholder: 'The office, main building',
    enabled: data.canFindPlaces,
  });
  const who = panelField(data, data.interviewerAt ?? {});

  const done = await formDialog({
    title: 'Publish interview times',
    submitLabel: 'Publish them',
    body: h('div',
      h('p.muted', 'Say when you are free and how long each one is. It cuts the morning up '
        + 'for you, and a time already published is left alone rather than doubled.'),
      field('Which day', h('input', {
        type: 'date', name: 'day', required: true, value: todayISO(), min: todayISO(),
      })),
      h('div.grid.grid-3',
        field('From', h('input', { type: 'time', name: 'from', value: '10:00', required: true })),
        field('To', h('input', { type: 'time', name: 'to', value: '13:00', required: true })),
        field('Each one', h('input', {
          type: 'number', name: 'minutes', min: 5, max: 240, step: 5, value: data.slotMinutes,
        }))),
      field('For which vacancy', rolePicker(data, null),
        'A candidate is only ever offered times published for their own vacancy, '
        + 'or for none.'),

      field('Where', where.el, data.canFindPlaces
        ? 'Start typing and pick it off the map. What you pick becomes a directions link on '
          + 'the candidate’s own page, which is the difference between them finding the '
          + 'place and ringing to ask.'
        : 'Typed as it is. To have this find real places and give candidates directions, '
          + 'set a Google maps key under Setup → Rules.'),

      field('Who is interviewing', who.el),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Where is printed on the candidate’s page. Who is not: whoever is on the panel is '
        + 'the property’s business.'),
    ),
    onSubmit: async (form) => api.recAddSlots({
      ...Object.fromEntries(form.entries()),
      place: where.value,
      // Only where the words and the pin still agree. Somebody who picks a
      // place and then edits the text has an address that is theirs, not
      // Google's, and a coordinate from the old one would be a lie.
      ...where.place,
      ...who.value,
    }),
  });
  if (!done) return;
  toast(done.skipped
    ? `${done.added} published, ${done.skipped} were already there.`
    : `${done.added} published.`, 'good');
  await reload();
}

/**
 * Change one time that is already published.
 *
 * Moving a booked one is allowed and the box says what it costs: the
 * candidate's own page reads the slot, so the new time is what they see next
 * time they open their link, but a link they have already closed does not
 * ring. Somebody has to tell them.
 */
async function editSlot(slot, data, reload) {
  const where = placeField({
    name: 'place',
    value: slot.place || '',
    placeholder: 'The office, main building',
    enabled: data.canFindPlaces,
  });
  const who = panelField(data, { staffIds: slot.panel, name: slot.interviewer });

  const done = await formDialog({
    title: slot.candidateName
      ? `${slot.candidateName}, ${fmtDay(slot.day)} at ${slot.at}`
      : `${fmtDay(slot.day)} at ${slot.at}`,
    submitLabel: 'Save',
    body: h('div',
      slot.candidateId
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', `${slot.candidateName} has taken this time`),
            h('div.alert-detail', 'Their own page reads this, so a change shows the next time '
              + 'they open their link. A link they have already closed does not ring, so ring '
              + 'them if you move it.')))
        : null,

      h('div.grid.grid-3',
        field('Day', h('input', { type: 'date', name: 'day', value: slot.day, required: true })),
        field('At', h('input', { type: 'time', name: 'at', value: slot.at, required: true })),
        field('How long', h('input', {
          type: 'number', name: 'minutes', min: 5, max: 240, step: 5, value: slot.minutes,
        }))),
      field('For which vacancy', rolePicker(data, slot.roleId)),
      field('Where', where.el),
      field('Who is interviewing', who.el),
    ),
    onSubmit: async (form) => api.recUpdateSlot(slot.id, {
      ...Object.fromEntries(form.entries()),
      place: where.value,
      ...where.place,
      ...who.value,
    }),
  });
  if (!done) return;
  toast(done.moved && done.booked
    ? 'Moved. Ring them, because their link will not.'
    : 'Saved.', done.moved && done.booked ? 'warn' : 'good');
  await reload();
}

/**
 * Change a whole day at once.
 *
 * The realistic edit is not one time, it is "Tuesday is Yaa now, not me" or
 * "we are doing them in the small office". Doing that one slot at a time
 * across a morning of eleven is how somebody gives up and republishes.
 *
 * The times themselves are left alone. Moving eleven interviews together is a
 * different thing from correcting who is on the panel, and it would move
 * appointments people have already been given.
 */
async function editDay(day, data, reload) {
  const booked = day.slots.filter((s) => s.candidateId).length;
  const first = day.slots[0] ?? {};

  const where = placeField({
    name: 'place',
    value: first.place || '',
    placeholder: 'The office, main building',
    enabled: data.canFindPlaces,
  });
  const who = panelField(data, { staffIds: first.panel, name: first.interviewer });

  const done = await formDialog({
    title: fmtDay(day.day, { withYear: true }),
    submitLabel: 'Change the day',
    body: h('div',
      h('p.muted', `${day.slots.length} time${day.slots.length === 1 ? '' : 's'} published`
        + `${booked ? `, ${booked} already taken` : ', none taken yet'}. `
        + 'This changes where they are, who is on the panel and which vacancy they belong to. '
        + 'The times themselves are left alone.'),

      field('For which vacancy', rolePicker(data, first.roleId)),
      field('Where', where.el),
      field('Who is interviewing', who.el),

      booked
        ? h('label.tickline',
          h('input', { type: 'checkbox', name: 'includeBooked' }),
          h('span', `Change the ${booked} that ${booked === 1 ? 'has' : 'have'} `
            + 'already been taken as well'))
        : null,
      booked
        ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Left unticked, an appointment somebody has already been given is not touched. '
          + 'Whoever is put on the panel is told either way.')
        : null,
    ),
    onSubmit: async (form) => api.recUpdateDay({
      day: day.day,
      roleId: form.get('roleId'),
      includeBooked: form.get('includeBooked') === 'on',
      place: where.value,
      ...where.place,
      ...who.value,
    }),
  });
  if (!done) return;
  toast(done.left
    ? `${done.changed} changed, ${done.left} left alone.`
    : `${done.changed} changed.`, 'good');
  await reload();
}

async function dropSlot(slot, reload) {
  const warning = slot.candidateId
    ? `${slot.candidateName} has taken this time. Cancelling it does not tell them, so `
      + 'ring them. Take it out anyway?'
    : 'Take this time out of the diary?';
  if (!confirmAction(warning)) return;

  try {
    await api.recRemoveSlot(slot.id);
    toast('Taken out.', 'good');
    await reload();
  } catch (err) {
    toast(err.message, 'bad');
  }
}
