import { api } from '../api.js';
import { navigate } from '../app.js';
import { confirmAction, fmtDay, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
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

  return card('Everybody who has applied', {
    note: `${rows.length}`,
    wide: true,
    actions: ways,
  },
  table([
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
  ], rows, {
    groupBy: (r) => labelOf(data.stages, r.stage),
    // The stages in their own order. Alphabetical would put "Not this time"
    // above "Shortlisted", which is sorted correctly and reads as nonsense.
    groupOrder: data.stages.map((s) => s.label),
    groupNoun: ['person', 'people'],
    fold: true,
    rowClass: (r) => (['hired', 'declined', 'not_taken'].includes(r.stage) ? 'row-muted' : ''),
    empty: 'Nobody yet.',
  }));
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
 * Who is interviewing, picked off the staff list.
 *
 * A name typed in a box printed and did nothing else. The moment a candidate
 * takes a time somebody has to be told, and "Kwame" is not somebody the app
 * can tell — so this is a person, and a person with a login gets it on their
 * phone.
 *
 * SOMEBODY ELSE IS STILL AN ANSWER. An owner, a consultant sitting on the
 * panel, somebody who does not work here: the last option opens a plain box,
 * and everything works as it did except that nobody can be notified. The
 * screen says which of the two you have chosen rather than leaving somebody to
 * wonder why no notice arrived.
 */
function interviewerField(data, current = {}) {
  const typed = h('input', {
    type: 'text', maxlength: 120, placeholder: 'Their name',
    value: current.staffId ? '' : (current.name ?? ''),
  });
  const wrap = h('div.rec-who-typed', { hidden: Boolean(current.staffId) || !current.name },
    typed);
  const note = h('small.muted.rec-who-note');

  const picker = h('select',
    h('option', { value: '' }, 'Nobody named yet'),
    (data.panel ?? []).map((person) => h('option', {
      value: String(person.id),
      selected: current.staffId === person.id,
    }, `${person.name}${person.department ? ` — ${person.department}` : ''}`
      + `${person.canBeTold ? '' : ' (no login)'}`)),
    h('option', {
      value: 'other',
      selected: !current.staffId && Boolean(current.name),
    }, 'Somebody else…'));

  const say = () => {
    const chosen = picker.value;
    wrap.hidden = chosen !== 'other';
    if (chosen === 'other') {
      note.textContent = 'Not on the books, so nothing can be sent to them. '
        + 'You will be told, and can pass it on.';
    } else if (!chosen) {
      note.textContent = 'Nobody is named, so nobody is told when a time is taken.';
    } else {
      const person = (data.panel ?? []).find((p) => String(p.id) === chosen);
      note.textContent = person?.canBeTold
        ? 'They get a notice on their phone the moment a candidate takes one of these times.'
        : 'They have no login, so nothing can be sent to them. '
          + 'You will be told, and can pass it on.';
    }
  };
  picker.addEventListener('change', say);
  say();

  return {
    el: h('div', picker, wrap, note),
    get value() {
      return picker.value === 'other'
        ? { interviewer: typed.value, interviewerStaffId: '' }
        : { interviewer: '', interviewerStaffId: picker.value };
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
  const who = interviewerField(data, data.interviewerAt ?? {});

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
  const who = interviewerField(data, {
    staffId: slot.interviewerStaffId, name: slot.interviewer,
  });

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
  const who = interviewerField(data, {
    staffId: first.interviewerStaffId, name: first.interviewer,
  });

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
