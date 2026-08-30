import { api } from '../api.js';
import { navigate } from '../app.js';
import { confirmAction, fmtDay, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * One candidate, and everything anybody has to decide about them.
 *
 * THE TRAIL IS THE POINT. Who shortlisted them, who turned them down and why,
 * what the interviewer thought, when the link went out and when they opened
 * it. A hiring decision questioned a year later is answered off this page or
 * off nothing at all, and "nobody can remember" is the answer that costs a
 * property an unfair-dismissal claim.
 *
 * TAKING SOMEBODY ON IS THE ONLY DOOR TO THE BOOKS, and it is deliberately
 * heavy: an employee number typed in by hand, a start date, and the setup
 * permission. It makes the staff record, carries their phone number and their
 * CV across, and then stops — the contract goes out from their new record,
 * through the templates and the signing that already exist. A contract from a
 * hire and a contract from anywhere else have to be the same document with the
 * same trail, or the trail is worth nothing.
 */

export async function renderRecCandidate(params) {
  const host = h('div');
  const id = Number(params.id);
  if (!id) {
    mount(host, emptyState('No candidate chosen', 'Open somebody from the pipeline.'));
    return host;
  }

  const data = await api.recCandidate(id);
  const reload = async () => mount(host, await renderRecCandidate(params));
  const person = data.candidate;
  const closed = ['hired', 'declined', 'not_taken'].includes(person.stage);

  mount(host,
    h('div.page-head',
      h('div',
        h('button.link-button.back-link', { onclick: () => navigate('rec') }, '‹ Recruitment'),
        h('h1', person.name),
        h('div.sub', [
          data.role ? data.role.title : 'No vacancy',
          person.phone,
          person.email,
        ].filter(Boolean).join(' · ')),
      ),
      h('div.btn-row',
        data.canManage && !closed
          ? h('button.btn-sm', { onclick: () => sendLink(data, reload) }, 'Make a link')
          : null,
        data.canManage
          ? h('button.btn-sm', { onclick: () => edit(data, reload) }, 'Edit')
          : null,
        person.staffId
          ? h('button.btn-sm.btn-primary', {
            onclick: () => navigate('person', { id: person.staffId }),
          }, 'Open their record')
          : null,
      ),
    ),

    whereTheyAre(data, reload),

    h('div.grid.grid-2',
      interviewCard(data, reload),
      scoresCard(data, reload),
    ),

    person.stage === 'offer' && !person.staffId ? handover(data, reload) : null,

    h('div.grid.grid-2',
      filesCard(data, reload),
      linksCard(data, reload),
    ),

    trailCard(data),
  );

  return host;
}

// ---------------------------------------------------------------------------
// Where they are, and where they go next
// ---------------------------------------------------------------------------

/**
 * The stage, and the moves out of it.
 *
 * Forward is the primary button because that is what nearly every press is.
 * The endings sit beside it, and going back is behind "Somewhere else" — a
 * mistake to be undone rather than a normal move, and a row of seven equal
 * buttons is a row nobody reads.
 */
function whereTheyAre(data, reload) {
  const person = data.candidate;
  const order = ['applied', 'shortlisted', 'interview', 'offer'];
  const at = order.indexOf(person.stage);
  const forward = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  const stage = data.stages.find((s) => s.key === person.stage);

  return card('Where they are', {
    note: fmtDay(person.appliedOn, { withYear: true }),
    wide: true,
    cls: 'rec-where',
  },
  h('div.rec-track', order.map((key, i) => {
    const done = at > i;
    const here = at === i;
    return h(`div.rec-track-step${here ? '.is-here' : ''}${done ? '.is-done' : ''}`,
      h('span.rec-track-dot', done ? '✓' : String(i + 1)),
      h('span', data.stages.find((s) => s.key === key).label));
  })),

  h('p.rec-stage-say',
    h('strong', stage?.label ?? person.stage),
    person.outcome ? h('span', `: ${person.outcome}`) : null,
    stage?.detail ? h('small.muted', { style: { display: 'block' } }, stage.detail) : null),

  data.canManage
    ? h('div.btn-row',
      forward
        ? h('button.btn.btn-primary', { onclick: () => move(data, forward, reload) },
          `Move to ${data.stages.find((s) => s.key === forward).label.toLowerCase()}`)
        : null,
      person.stage !== 'hired' && person.stage !== 'not_taken'
        ? h('button.btn-sm', { onclick: () => move(data, 'not_taken', reload) }, 'Not this time')
        : null,
      person.stage === 'offer'
        ? h('button.btn-sm', { onclick: () => move(data, 'declined', reload) }, 'They said no')
        : null,
      h('button.btn-sm', { onclick: () => moveElsewhere(data, reload) }, 'Somewhere else'))
    : null,
  );
}

async function move(data, stage, reload) {
  const person = data.candidate;
  const target = data.stages.find((s) => s.key === stage);
  const ending = ['declined', 'not_taken'].includes(stage);

  const done = await formDialog({
    title: `${person.name}: ${target.label.toLowerCase()}`,
    submitLabel: ending ? 'Record it' : 'Move them',
    body: h('div',
      h('p.muted', target.detail),
      ending
        ? field('Why', h('textarea', { name: 'outcome', rows: 3, maxlength: 400, required: true }),
          'Kept on the record. It is the whole value of this afterwards: '
          + 'the question anybody asks a year later is why, and an empty box answers nothing.')
        : field('Anything worth noting', h('textarea', {
          name: 'outcome', rows: 2, maxlength: 400,
        })),
      ending && person.interview
        ? h('p.muted', { style: { fontSize: '.82rem' } },
          `Their interview time on ${fmtDay(person.interview.day)} goes back into the diary.`)
        : null,
    ),
    onSubmit: async (form) => api.recMoveCandidate(person.id, {
      stage, outcome: form.get('outcome'),
    }),
  });
  if (!done) return;
  toast('Moved.', 'good');
  await reload();
}

async function moveElsewhere(data, reload) {
  const person = data.candidate;
  const done = await formDialog({
    title: 'Move them somewhere else',
    submitLabel: 'Move them',
    body: h('div',
      h('p.muted', 'For putting a mistake right. Nothing is lost either way, because the trail keeps '
        + 'every move, including this one.'),
      field('To', h('select', { name: 'stage' },
        data.stages
          .filter((s) => s.key !== person.stage && s.key !== 'hired')
          .map((s) => h('option', { value: s.key }, s.label)))),
      field('Why', h('textarea', { name: 'outcome', rows: 2, maxlength: 400 })),
    ),
    onSubmit: async (form) => api.recMoveCandidate(person.id, {
      stage: form.get('stage'), outcome: form.get('outcome'),
    }),
  });
  if (!done) return;
  toast('Moved.', 'good');
  await reload();
}

async function edit(data, reload) {
  const person = data.candidate;
  const done = await formDialog({
    title: 'Edit their details',
    submitLabel: 'Save',
    body: h('div',
      field('Their name', h('input', {
        type: 'text', name: 'name', maxlength: 120, value: person.name, required: true,
      })),
      h('div.grid.grid-2',
        field('Phone', h('input', { type: 'tel', name: 'phone', maxlength: 40, value: person.phone ?? '' })),
        field('Email', h('input', { type: 'email', name: 'email', maxlength: 160, value: person.email ?? '' }))),
      field('How they found us', h('select', { name: 'source' },
        h('option', { value: '' }, 'Not said'),
        data.sources.map(([key, label]) => h('option', {
          value: key, selected: person.source === key,
        }, label)))),
      field('Referred by', h('input', {
        type: 'text', name: 'referredBy', maxlength: 120, value: person.referredBy ?? '',
      })),
      field('Notes', h('textarea', { name: 'note', rows: 4, maxlength: 2000 }, person.note ?? '')),
    ),
    onSubmit: async (form) => api.recUpdateCandidate(person.id, Object.fromEntries(form.entries())),
  });
  if (!done) return;
  toast('Saved.', 'good');
  await reload();
}

// ---------------------------------------------------------------------------
// The interview
// ---------------------------------------------------------------------------

function interviewCard(data, reload) {
  const person = data.candidate;

  if (person.interview) {
    const slot = person.interview;
    return card('Their interview', { note: slot.takenBy === 'them' ? 'they chose it' : 'booked here' },
      h('p.rec-when',
        h('strong', fmtDay(slot.day, { withYear: true })),
        h('span', ` at ${slot.at} – ${slot.ends}`)),
      slot.place ? h('p.muted', `Where: ${slot.place}`) : null,
      slot.interviewer ? h('p.muted', `Interviewing: ${slot.interviewer}`) : null,
      data.canManage
        ? h('div.btn-row',
          h('button.btn-sm', { onclick: () => book(data, reload) }, 'Move it'))
        : null);
  }

  return card('Their interview', { note: 'Not booked' },
    h('p.muted', 'Nothing in the diary for them. Make a link and let them pick a time that '
      + 'suits, or book one here if they rang up.'),
    data.canManage
      ? h('div.btn-row',
        h('button.btn-sm.btn-primary', { onclick: () => sendLink(data, reload) }, 'Make a link'),
        data.free.length
          ? h('button.btn-sm', { onclick: () => book(data, reload) }, 'Book one for them')
          : null)
      : null,
    !data.free.length
      ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'No times are published for this vacancy. Publish some under Interviews first.')
      : null);
}

async function book(data, reload) {
  const person = data.candidate;
  if (!data.free.length) { toast('No times are free. Publish some first.', 'bad'); return; }

  const done = await formDialog({
    title: `Book a time for ${person.name}`,
    submitLabel: 'Book it',
    body: h('div',
      h('p.muted', 'For somebody who rang up, or has no smartphone. A time booked here and a '
        + 'time somebody picks on their own screen cannot both be the same half hour.'),
      field('Which time', h('select', { name: 'slotId' },
        data.free.map((slot) => h('option', { value: String(slot.id) },
          `${fmtDay(slot.day, { withYear: true })} · ${slot.at} – ${slot.ends}`
          + `${slot.place ? ` · ${slot.place}` : ''}`)))),
      person.interview
        ? h('p.muted', { style: { fontSize: '.82rem' } },
          `Their current time on ${fmtDay(person.interview.day)} goes back into the diary.`)
        : null,
    ),
    onSubmit: async (form) => api.recBookSlot(form.get('slotId'), person.id),
  });
  if (!done) return;
  toast('Booked.', 'good');
  await reload();
}

// ---------------------------------------------------------------------------
// What the interviewer thought
// ---------------------------------------------------------------------------

function scoresCard(data, reload) {
  return card('What the interviewers thought', {
    note: data.scores.length ? `${data.scores.length}` : 'Nothing yet',
    actions: h('button.btn-sm', { onclick: () => score(data, reload) }, 'Add a note'),
  },
  data.scores.length
    ? h('ul.rec-scores', data.scores.map((s) => h('li',
      h('div.rec-score-head',
        s.rating != null ? h('span.rec-rating', `${s.rating}/5`) : null,
        s.recommend ? h(`span.pill.rec-rec.is-${s.recommend}`, sayRecommend(s.recommend)) : null,
        h('small.muted', `${s.by ?? 'Somebody'} · ${fmtDay(String(s.at).slice(0, 10))}`)),
      s.note ? h('p', s.note) : null)))
    : emptyState('Nothing written down yet',
      'Whoever sits in the interview writes what they thought here, while it is fresh.'));
}

const sayRecommend = (key) => ({ yes: 'Take them', maybe: 'Maybe', no: 'No' })[key] ?? key;

async function score(data, reload) {
  const done = await formDialog({
    title: `What did you think of ${data.candidate.name}?`,
    submitLabel: 'Save it',
    body: h('div',
      h('div.grid.grid-2',
        field('Out of five', h('select', { name: 'rating' },
          h('option', { value: '' }, 'Not marking'),
          [1, 2, 3, 4, 5].map((n) => h('option', { value: String(n) }, `${n}`)))),
        field('Would you take them?', h('select', { name: 'recommend' },
          h('option', { value: '' }, 'Not saying'),
          h('option', { value: 'yes' }, 'Yes'),
          h('option', { value: 'maybe' }, 'Maybe'),
          h('option', { value: 'no' }, 'No')))),
      field('What you thought', h('textarea', { name: 'note', rows: 5, maxlength: 4000 }),
        'Written down while it is fresh. It stays on the record whichever way the '
        + 'decision goes.'),
    ),
    onSubmit: async (form) => api.recScoreCandidate(data.candidate.id,
      Object.fromEntries(form.entries())),
  });
  if (!done) return;
  toast('Saved.', 'good');
  await reload();
}

// ---------------------------------------------------------------------------
// Taking them on
// ---------------------------------------------------------------------------

/**
 * The handover.
 *
 * Shown only once somebody has actually been offered the job, because it is
 * the one control on this screen that changes the property rather than the
 * pipeline. It is a card rather than a button in a row for the same reason:
 * this is the step that ends recruitment and starts employment, and it should
 * read as such.
 */
function handover(data, reload) {
  const person = data.candidate;

  return card('Take them on', {
    wide: true,
    cls: 'rec-hire',
    note: data.canHire ? 'The last step' : 'Needs an administrator',
  },
  h('p',
    h('strong', `${person.name} has been offered the job. `),
    'Taking them on makes their staff record, moves their CV onto it, and carries across '
    + 'the phone number and email the pipeline already holds. Their contract goes out from '
    + 'their record afterwards, the same way it does for anybody else.'),

  h('ul.rec-next',
    h('li', 'Their employee number has to match what is set up on the terminal, exactly. '
      + 'It is the join between a punch and a person.'),
    h('li', 'Their interview time goes back into the diary for somebody else.'),
    h('li', 'Nothing is sent to them by this. The contract and the details form go out on '
      + 'one link from their record.')),

  data.canHire
    ? h('div.btn-row',
      h('button.btn.btn-primary', { onclick: () => hire(data, reload) },
        `Take ${person.name.split(' ')[0]} on`))
    : h('div.alert.info',
      h('span.alert-icon', 'ℹ️'),
      h('div',
        h('div.alert-title', 'An administrator has to press this one'),
        h('div.alert-detail', 'Putting somebody on the property’s books is what the attendance '
          + 'setup permission guards, and running the recruitment does not include it. '
          + 'Everything up to here is done. Ask an administrator to finish it.'))),
  );
}

async function hire(data, reload) {
  const person = data.candidate;
  const role = data.role;

  const done = await formDialog({
    title: `Take ${person.name} on`,
    submitLabel: 'Take them on',
    body: h('div',
      h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'The employee number must match the terminal'),
          h('div.alert-detail', 'A punch joins to a person by this number, exactly as typed. '
            + 'Enrol them on the terminal under the same one, or their clock-ins will belong '
            + 'to nobody.'))),

      field('Employee number', h('input', {
        type: 'text', name: 'employeeNo', maxlength: 40, required: true,
        placeholder: 'HSK006', autocapitalize: 'characters',
      })),
      field('Name', h('input', {
        type: 'text', name: 'name', maxlength: 120, value: person.name, required: true,
      }), 'As it should read on a payslip.'),
      h('div.grid.grid-2',
        field('Department', h('input', {
          type: 'text', name: 'department', maxlength: 80, value: role?.department ?? '',
        })),
        field('Job title', h('input', {
          type: 'text', name: 'jobTitle', maxlength: 80, value: role?.title ?? '',
        }))),
      field('Starts on', h('input', {
        type: 'date', name: 'hiredOn', value: todayISO(), required: true,
      }), 'Leave accrues from this date, and a mid-year joiner is pro-rated from it.'),

      h('label.tickline',
        h('input', { type: 'checkbox', name: 'onClock', checked: true }),
        h('span', 'They clock in and out')),
      h('label.tickline',
        h('input', { type: 'checkbox', name: 'onRota', checked: true }),
        h('span', 'They go on the rota')),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Untick both for somebody who is only ever paid: a director, a consultant on a '
        + 'retainer. Everything about attendance then stops applying to them.'),
    ),
    onSubmit: async (form) => api.recHire(person.id, {
      employeeNo: form.get('employeeNo'),
      name: form.get('name'),
      department: form.get('department'),
      jobTitle: form.get('jobTitle'),
      hiredOn: form.get('hiredOn'),
      onClock: form.get('onClock') === 'on',
      onRota: form.get('onRota') === 'on',
    }),
  });
  if (!done) return;

  toast(`${person.name} is on the books.`, 'good');
  if (confirmAction('Open their record now to send the contract and the details form?')) {
    navigate('person', { id: done.staffId });
    return;
  }
  await reload();
}

// ---------------------------------------------------------------------------
// Files and links
// ---------------------------------------------------------------------------

function filesCard(data, reload) {
  const person = data.candidate;
  const input = h('input', {
    type: 'file',
    accept: 'image/*,application/pdf,.doc,.docx',
    onchange: async (event) => {
      const chosen = event.target.files?.[0];
      if (!chosen) return;
      event.target.disabled = true;
      try {
        await api.recAddFile(person.id, {
          filename: chosen.name,
          title: chosen.name,
          mime: chosen.type || 'application/octet-stream',
          content: await asBase64(chosen),
        });
        toast('Filed.', 'good');
        await reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    },
  });

  return card('Their CV and anything else', {
    note: data.files.length ? `${data.files.length}` : 'Nothing yet',
  },
  data.files.length
    ? h('ul.rec-files', data.files.map((f) => h('li',
      h('a', {
        href: `/api/rec/candidates/${person.id}/files/${f.id}`,
        target: '_blank', rel: 'noopener',
      }, f.filename || f.title),
      h('small.muted', `${Math.round(f.bytes / 1000)} KB · ${f.by ?? ''}`),
      data.canManage
        ? h('button.link-button', {
          onclick: async () => {
            if (!confirmAction(`Delete ${f.filename || f.title}?`)) return;
            await api.recRemoveFile(person.id, f.id);
            await reload();
          },
        }, 'Delete')
        : null)))
    : h('p.muted', 'Nothing yet. Upload one here, or ask for it on their link.'),
  data.canManage ? field('Add one', input) : null,
  person.staffId
    ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
      'These were copied onto their staff record when they were taken on.')
    : null);
}

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

function linksCard(data, reload) {
  return card('Links sent to them', {
    note: data.invites.length ? `${data.invites.length}` : 'None',
    actions: data.canManage
      ? h('button.btn-sm', { onclick: () => sendLink(data, reload) }, 'Make one')
      : null,
  },
  data.invites.length
    ? table([
      { key: 'createdAt', label: 'Made', format: (v) => h('small', fmtDay(String(v).slice(0, 10))) },
      { key: 'asks', label: 'Asks for', format: (v) => (v.length ? v.join(', ') : '—') },
      {
        key: 'openedAt',
        label: 'Opened',
        format: (v) => (v
          ? h('span.pill.good', fmtDay(String(v).slice(0, 10)))
          : h('span.muted', 'not yet')),
      },
      {
        key: 'revokedAt',
        label: '',
        format: (v, r) => (v
          ? h('span.pill', 'cancelled')
          : (data.canManage
            ? h('button.link-button', {
              onclick: async () => {
                if (!confirmAction('Cancel this link? It stops working immediately.')) return;
                await api.recRevokeInvite(r.id);
                toast('Cancelled.', 'good');
                await reload();
              },
            }, 'Cancel')
            : null)),
      },
    ], data.invites, { empty: 'None yet.' })
    : h('p.muted', 'A link is how somebody picks their own interview time. '
      + 'It is yours to send however you already talk to them. Nothing is emailed from here.'));
}

/**
 * Make the link, and show it once.
 *
 * There is no email anywhere in this. The office copies the message and sends
 * it however it already talks to that person, which at this property is
 * WhatsApp. An app that insists on sending its own email is an app that needs
 * an address for somebody who applied by walking in with a printed CV.
 */
async function sendLink(data, reload) {
  const person = data.candidate;

  const made = await formDialog({
    title: `A link for ${person.name}`,
    submitLabel: 'Make the link',
    body: h('div',
      h('p.muted', 'Nothing is sent from here. You get a link and a message to paste '
        + 'wherever you already talk to them.'),

      h('label.tickline',
        h('input', { type: 'checkbox', name: 'wantsSlot', checked: true }),
        h('span', 'Let them pick an interview time')),
      h('label.tickline',
        h('input', { type: 'checkbox', name: 'wantsDetails', checked: true }),
        h('span', 'Ask them to check their phone number and email')),
      h('label.tickline',
        h('input', { type: 'checkbox', name: 'wantsCv', checked: !data.files.length }),
        h('span', 'Ask for their CV')),

      field('Anything to say', h('textarea', {
        name: 'message', rows: 3, maxlength: 600,
        placeholder: 'Thank you for coming in on Tuesday…',
      })),
      h('div.grid.grid-2',
        field('Lasts', h('input', { type: 'number', name: 'days', min: 1, max: 60, value: 10 }),
          'Days. Shorter than a staff link on purpose: it carries a diary, and a '
          + 'diary three weeks old offers times that have been and gone.'),
        field('Four-digit code', h('input', {
          type: 'text', name: 'pin', inputmode: 'numeric', maxlength: 4, placeholder: 'optional',
        }), 'Told to them out loud, never in the same message.')),
    ),
    onSubmit: async (form) => api.recInvite(person.id, {
      wantsSlot: form.get('wantsSlot') === 'on',
      wantsDetails: form.get('wantsDetails') === 'on',
      wantsCv: form.get('wantsCv') === 'on',
      message: form.get('message'),
      days: form.get('days'),
      pin: form.get('pin'),
    }),
  });
  if (!made) return;

  await formDialog({
    title: 'The link, copy it now',
    submitLabel: 'Done',
    body: h('div',
      h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'This is the only time you will see it'),
          h('div.alert-detail', 'Only a fingerprint of it is stored, so it cannot be shown '
            + 'again. If you lose it, make another; it takes seconds.'))),

      h('textarea.link-box', { rows: 5, readonly: true, onclick: (e) => e.target.select() },
        made.message),

      h('div.btn-row',
        h('button.btn.btn-primary', {
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(made.message);
              e.target.textContent = 'Copied ✓';
            } catch {
              toast('Select the text above and copy it.', 'bad');
            }
          },
        }, 'Copy the message'),
        h('a.btn-sm', {
          href: `https://wa.me/${(person.phone ?? '').replace(/\D/g, '')}`
            + `?text=${encodeURIComponent(made.message)}`,
          target: '_blank', rel: 'noopener',
        }, 'Send on WhatsApp')),

      made.pin
        ? h('p', h('strong', 'Tell them the code: '), h('span.mono.pin-show', made.pin),
          h('br'), h('small.muted', 'Say it on a call. Not in the same message as the link.'))
        : null,

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        `It stops working in ${made.expiresInDays} days.`),
    ),
    onSubmit: async () => ({ ok: true }),
  });

  await reload();
}

// ---------------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------------

const SAYS = {
  added: 'Added to the pipeline',
  stage: 'Moved',
  scored: 'Scored',
  file: 'A file was filed',
  cv_sent: 'They sent a CV',
  details_sent: 'They confirmed their details',
  link_created: 'A link was made',
  link_opened: 'They opened the link',
  link_pin_failed: 'A wrong code was tried on the link',
  link_cancelled: 'The link was cancelled',
  slot_taken: 'An interview time was taken',
  slot_changed: 'They changed their interview time',
  slot_given_back: 'They gave the time back',
  slot_released: 'Their time went back into the diary',
  slot_cancelled: 'The interview was cancelled here',
  hired: 'Taken on',
};

function trailCard(data) {
  return card('Everything that has happened', {
    note: `${data.events.length}`,
    wide: true,
  },
  h('p.muted', 'The answer to "why was this person not taken on", a year later. '
    + 'Nothing here can be edited or removed.'),

  data.events.length
    ? h('ol.rec-trail', data.events.map((e) => h('li',
      h('div.rec-trail-what',
        h('strong', SAYS[e.kind] ?? e.kind),
        e.kind === 'stage' && e.to
          ? h('span', ` to ${(data.stages.find((s) => s.key === e.to)?.label ?? e.to).toLowerCase()}`)
          : null),
      e.detail ? h('div.rec-trail-detail', e.detail) : null,
      h('div.rec-trail-who',
        h('small.muted', `${e.actor ?? 'They did'} · ${stamp(e.at)}`)))))
    : emptyState('Nothing yet', 'Everything from here on is written down.'));
}

const stamp = (at) => {
  const text = String(at ?? '');
  return `${fmtDay(text.slice(0, 10), { withYear: true })} ${text.slice(11, 16)}`;
};
