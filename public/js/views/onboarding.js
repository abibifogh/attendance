import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, emptyState, face } from './components.js';
import { navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';

/**
 * The first week.
 *
 * ONE SCREEN, TWO AUDIENCES, the same way the handbook is. A new hire sees the
 * welcome, their checklist, and the one thing to do next. Whoever runs a first
 * week sees everybody's, with the steps and who is behind on what.
 *
 * WHAT IT IS NOT is a second place to sign a contract or read the handbook.
 * Every step that can be answered from somewhere else in this app links to
 * that place and ticks itself when the answer arrives, so nothing is ever
 * recorded twice and the list cannot say something the record contradicts.
 */

/** Where an unticked step is actually done, and what the button should say. */
const GO = {
  details: { label: 'Send your details', to: null },
  documents: { label: 'My account', to: null },
  contract: { label: 'My documents', to: null },
  handbook: { label: 'Open the handbook', to: 'handbook' },
};

const readableDate = (iso) => {
  if (!iso) return null;
  const when = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};

/** How a step is answered, said to the person waiting on it. */
function howItIsAnswered(step) {
  if (step.source === 'manual') {
    return step.owner === 'staff'
      ? 'Your supervisor ticks this off once you have done it.'
      : 'Somebody here will do this with you and tick it off.';
  }
  if (step.source === 'details') return 'Ticks itself once the office has your details.';
  if (step.source === 'contract') return 'Ticks itself once your signed contract is back.';
  if (step.source === 'handbook') return 'Ticks itself once nothing in the handbook is waiting on you.';
  if (step.source === 'documents') return 'Ticks itself once every document your file needs is in.';
  return '';
}

// ---------------------------------------------------------------------------
// The new hire's own screen
// ---------------------------------------------------------------------------

export async function renderOnboarding() {
  const host = h('div');

  const paint = async () => {
    const data = await api.myOnboarding();

    if (!data.onboarding) {
      mount(host,
        h('div.page-head', h('div', h('h1', 'Your first week'))),
        emptyState(data.on ? 'Nothing waiting on you' : 'Not switched on',
          data.on
            ? 'Your first week is finished, or was never opened. Everything else in the app is '
              + 'in the menu.'
            : null));
      return;
    }

    const { progress } = data;
    const done = progress.done === progress.of;

    const stepRow = (step, at) => h('div.ob-step', { class: step.done ? 'ob-step ob-done' : null },
      h('span.ob-tick', step.done ? '✓' : String(at + 1)),
      h('div.ob-step-text',
        h('div.ob-step-title', step.title),
        step.detail ? h('p.ob-step-detail', step.detail) : null,
        step.done
          ? h('p.muted.ob-step-how', readableDate(step.doneAt)
            ? `Done, ${readableDate(step.doneAt)}`
            : 'Done')
          : h('p.muted.ob-step-how', howItIsAnswered(step))),
      !step.done && GO[step.source]?.to
        ? h('button.btn-sm', {
          type: 'button', onclick: () => navigate(GO[step.source].to),
        }, GO[step.source].label)
        : null);

    mount(host,
      // The welcome, and it comes first. Somebody's first morning is not the
      // moment for a progress bar.
      h('div.ob-hero',
        h('div.ob-hero-eyebrow', 'Welcome to'),
        h('h1.ob-hero-name', data.property || 'the property'),
        h('p.ob-hero-line', `${data.me.firstName}, we are glad you are here.`)),

      data.welcomes.length
        ? h('div.ob-welcomes', data.welcomes.map((w) => h('blockquote.ob-welcome',
          h('div.ob-welcome-words', ...String(w.words).split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p) => h('p', p.trim()))),
          h('footer.ob-welcome-who',
            face(w.name, { size: '2.4rem' }),
            h('div',
              h('div.ob-welcome-name', w.name),
              h('div.muted.ob-welcome-role', w.role))))))
        : null,

      card(done ? 'You are all set' : 'What happens next', {
        note: `${progress.done} of ${progress.of}`,
        wide: true,
      },
      h('div.ob-bar', h('div.ob-bar-fill', { style: { width: `${progress.percent}%` } })),
      done
        ? h('p.muted', 'Everything on the list is done. This page stops being the first thing '
          + 'you see, and My shifts takes over.')
        : h('p.muted', data.next
          ? `Next: ${data.next.title}.`
          : 'The rest is with the office. Somebody will come and find you.'),
      h('div.ob-steps', data.steps.map(stepRow))),

      done
        ? h('div.btn-row',
          h('button.btn.btn-primary', { onclick: () => navigate('att-me') }, 'Go to My shifts'))
        : null,
    );
  };

  await paint();
  return host;
}

// ---------------------------------------------------------------------------
// The office side
// ---------------------------------------------------------------------------

export async function renderOnboardingDesk() {
  const host = h('div');

  const paint = async () => {
    const data = await api.onboardings();

    const openOnes = data.people.filter((p) => !p.finishedAt);
    const settled = data.people.filter((p) => p.finishedAt);

    const personRow = (p) => h('button.ob-person', {
      type: 'button', onclick: () => openPerson(p.staffId, paint),
    },
    face(p.name, { size: '2.2rem' }),
    h('div.ob-person-text',
      h('div.ob-person-name', p.name,
        p.finishedAt ? h('span.pill.good', 'Settled in') : null,
        !p.active ? h('span.pill', 'Left') : null),
      h('div.muted.ob-person-sub', [
        p.jobTitle, p.department, p.hiredOn ? `started ${p.hiredOn}` : null,
      ].filter(Boolean).join(' · ')),
      h('div.ob-mini-bar', h('div.ob-mini-fill', { style: { width: `${p.percent}%` } }))),
    h('span.ob-person-count', `${p.done}/${p.of}`));

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'First weeks'),
          h('div.sub', openOnes.length
            ? `${openOnes.length} in progress`
            : 'Nobody is being onboarded')),
        data.mayManage
          ? h('div.btn-row',
            data.available.length
              ? h('button.btn.btn-sm', {
                onclick: async () => {
                  const out = await api.onboardingInstall();
                  toast(`${out.added} steps added.`, 'good');
                  await paint();
                },
              }, `Add the standard steps (${data.available.length})`)
              : null,
            h('button.btn.btn-sm.btn-primary', {
              onclick: async () => { if (await stepDialog(null, data)) await paint(); },
            }, 'New step'))
          : null),

      !data.on
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'Onboarding is switched off'),
            h('div.alert-detail',
              'Nobody is landed on their first week and nobody new gets one. '
              + 'Setup → Rules, under what staff can do for themselves.')))
        : null,

      openOnes.length
        ? card('In progress', { note: String(openOnes.length), wide: true },
          h('div.ob-people', openOnes.map(personRow)))
        : null,

      settled.length
        ? card('Settled in', { note: String(settled.length), wide: true },
          h('div.ob-people', settled.map(personRow)))
        : null,

      !data.people.length
        ? emptyState('Nobody yet',
          'A first week begins on its own for anybody added to the staff list while '
          + 'onboarding is on, and can be started by hand from somebody’s record.')
        : null,

      card('The checklist', { note: `${data.steps.length} steps`, wide: true },
        data.steps.length
          ? h('div.ob-rows', data.steps.map((s) => h('div.ob-row',
            h('div',
              h('div.ob-row-title', s.title,
                !s.active ? h('span.pill', 'Off') : null,
                s.source !== 'manual' ? h('span.pill.good', 'Ticks itself') : null),
              h('div.muted.ob-row-sub', [
                s.source === 'manual'
                  ? (s.owner === 'staff' ? 'Waiting on them' : 'Done by the office')
                  : data.sources.find((x) => x.key === s.source)?.label,
                s.who,
              ].filter(Boolean).join(' · '))),
            data.mayManage
              ? h('div.btn-row',
                h('button.btn-sm', {
                  onclick: async () => { if (await stepDialog(s, data)) await paint(); },
                }, 'Edit'),
                h('button.btn-sm', {
                  onclick: async () => {
                    if (!window.confirm(`Take "${s.title}" off the checklist? Everywhere it has `
                      + 'been ticked, the tick goes with it.')) return;
                    await api.onboardingRemoveStep(s.id);
                    toast('Taken off.');
                    await paint();
                  },
                }, 'Remove'))
              : null)))
          : h('p.muted',
            'Nothing here yet. "Add the standard steps" puts in sixteen written for a hotel: '
            + 'the tour, the fire exits, the terminal, the uniform, and the documents and '
            + 'chapters that tick themselves off.')),
    );
  };

  await paint();
  return host;
}

/** One person's first week, and the ticking. */
async function openPerson(staffId, reload) {
  let data;
  try {
    data = await api.onboardingFor(staffId);
  } catch (err) { toast(err.message || 'Could not read that.', 'bad'); return; }

  const body = h('div');
  const draw = () => mount(body,
    h('p.muted', data.finishedAt
      ? `Settled in on ${readableDate(data.finishedAt)}.`
      : `Started ${readableDate(data.startedAt)}. ${data.progress.done} of `
        + `${data.progress.of} done.`),
    h('div.ob-bar', h('div.ob-bar-fill', { style: { width: `${data.progress.percent}%` } })),
    h('div.ob-steps', data.steps.map((s) => h('label.ob-step.ob-tickable',
      { class: s.done ? 'ob-step ob-tickable ob-done' : null },
      h('input', {
        type: 'checkbox',
        checked: s.done,
        disabled: !data.mayManage || s.source !== 'manual',
        onchange: async (event) => {
          const want = event.target.checked;
          try {
            await api.onboardingTick(s.id, { staffId, done: want });
            data = await api.onboardingFor(staffId);
            draw();
            await reload();
          } catch (err) {
            event.target.checked = !want;
            toast(err.message || 'That did not work.', 'bad');
          }
        },
      }),
      h('div.ob-step-text',
        h('div.ob-step-title', s.title),
        h('p.muted.ob-step-how', s.done
          ? [readableDate(s.doneAt), s.doneBy].filter(Boolean).join(' · ')
          : (s.source === 'manual'
            ? (s.owner === 'staff' ? 'Waiting on them' : 'Waiting on the office')
            : howItIsAnswered(s)))),
    ))),
  );
  draw();

  await formDialog({
    title: data.staff.name,
    wide: true,
    submitLabel: 'Close',
    body,
    onSubmit: async () => true,
  });
}

/** Writing a step. */
async function stepDialog(step, model) {
  const title = h('input', { type: 'text', maxlength: 160, value: step?.title ?? '' });
  const detail = h('textarea', { rows: 4, maxlength: 1000 }, step?.detail ?? '');
  const source = h('select', model.sources.map((s) => h('option', {
    value: s.key, selected: (step?.source ?? 'manual') === s.key,
  }, s.label)));
  const owner = h('select',
    h('option', { value: 'office', selected: (step?.owner ?? 'office') === 'office' },
      'The office does it'),
    h('option', { value: 'staff', selected: step?.owner === 'staff' },
      'They do it themselves'));
  const order = h('input', {
    type: 'number', min: '0', max: '9999', value: String(step?.order ?? 100),
  });
  const active = h('select',
    h('option', { value: 'yes', selected: step ? step.active : true }, 'On the checklist'),
    h('option', { value: 'no', selected: step ? !step.active : false }, 'Off, kept for later'));
  const departments = h('input', {
    type: 'text', value: (step?.departments ?? []).join(', '),
    placeholder: 'Leave empty for everybody',
  });
  const tags = h('input', {
    type: 'text', value: (step?.tags ?? []).join(', '), placeholder: 'A tag on the staff record',
  });

  const split = (input) => input.value.split(',').map((s) => s.trim()).filter(Boolean);
  const said = h('p.muted', { style: { fontSize: '.85rem' } });
  const say = () => {
    said.textContent = model.sources.find((s) => s.key === source.value)?.detail ?? '';
  };
  source.addEventListener('change', say);
  say();

  return formDialog({
    title: step ? 'Edit a step' : 'A new step',
    wide: true,
    submitLabel: 'Save it',
    body: h('div',
      field('What it is', title),
      field('What it means', detail, 'Read by the new hire on their first morning'),
      h('div.form-row',
        field('How it is answered', source),
        field('Where it sits', order, 'Lower numbers come first')),
      said,
      h('div.form-row',
        field('Whose job it is', owner, 'Only the office may tick, either way'),
        field('On or off', active)),
      h('div.form-row',
        field('Only these departments', departments),
        field('Only these tags', tags))),
    onSubmit: async () => api.onboardingSaveStep({
      id: step?.id ?? null,
      title: title.value,
      detail: detail.value,
      source: source.value,
      owner: owner.value,
      order: Number(order.value) || 100,
      active: active.value === 'yes',
      departments: split(departments),
      tags: split(tags),
    }),
  });
}
