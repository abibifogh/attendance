import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * The staff handbook.
 *
 * ONE SCREEN, TWO AUDIENCES. A member of staff sees the chapters that apply to
 * them, with anything still waiting on them at the top. Whoever writes it sees
 * the same list with the drafts in it and the editing on top. Two screens
 * would be two things to keep in step, and the second one always falls behind.
 *
 * What is on the screen is the published copy, never the draft. An
 * administrator part way through rewriting the disciplinary procedure has not
 * changed a word of what the property is reading until they press Publish.
 */

const WHAT_IT_ASKS = {
  read: { label: 'To read', pill: null },
  ack: { label: 'Read and tick', pill: 'Tick it' },
  sign: { label: 'To sign', pill: 'Sign it' },
};

/**
 * The words, wrapped by the screen rather than by whoever typed them.
 *
 * The chapters are written in a text box, so they arrive wrapped at whatever
 * width that box was. Left alone, every paragraph breaks in the middle of the
 * page on a desk and twice on a phone. A line that ran close to the edge was
 * the typist's wrap and is joined to the next; a short line was a decision and
 * is kept, which is what holds the lists together.
 */
const WRAPPED_AT = 64;

export function reflow(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.length >= WRAPPED_AT) {
      out[out.length - 1] = `${previous} ${line.trim()}`;
    } else {
      out.push(line.trim());
    }
  }
  return out.join('\n');
}

/** The body, as paragraphs and headings rather than one grey block. */
function pages(body) {
  const out = [];
  for (const block of String(body ?? '').split(/\n{2,}/)) {
    const text = block.replace(/\s+$/, '');
    if (!text.trim()) continue;

    // A line in capitals on its own is a heading. That is how the chapters are
    // written, and it means an administrator can type one without learning a
    // markup language.
    const [first, ...rest] = text.split('\n');
    if (/^[A-Z0-9 ,'()&.-]{3,}$/.test(first.trim()) && first.trim() === first.trim().toUpperCase()) {
      out.push(h('h3.hb-head', first.trim()));
      if (rest.length) out.push(h('p', reflow(rest.join('\n'))));
      continue;
    }
    out.push(h('p', reflow(text)));
  }
  return out;
}

export async function renderHandbook() {
  const host = h('div');
  let open = null;

  const paint = async () => {
    const data = await api.handbook();
    const manage = data.manage;

    if (!data.on && !manage) {
      mount(host,
        h('div.page-head', h('div', h('h1', 'Handbook'))),
        emptyState('Nothing published yet',
          'When the property publishes its handbook it will be here, and anything you are '
          + 'asked to read or sign will be at the top of this page.'));
      return;
    }

    const onAck = async (chapter) => {
      if (chapter.asks === 'sign') {
        const done = await signDialog(chapter);
        if (!done) return;
      } else {
        try {
          await api.handbookAck(chapter.id, { version: chapter.version });
        } catch (err) { toast(err.message || 'That did not work.', 'bad'); return; }
      }
      toast('Thank you. It is on your record.', 'good');
      await paint();
    };

    const readCard = (chapter) => {
      const isOpen = open === chapter.id;
      const asks = WHAT_IT_ASKS[chapter.asks] ?? WHAT_IT_ASKS.read;

      return h('section.card.hb-chapter', { class: chapter.done ? 'hb-done' : null },
        h('div.hb-head-row',
          h('button.hb-title', {
            type: 'button',
            onclick: () => { open = isOpen ? null : chapter.id; paint(); },
          },
          h('span.hb-caret', isOpen ? '▾' : '▸'),
          h('span', chapter.title)),
          chapter.needs && !chapter.done ? h('span.pill.warn', asks.pill) : null,
          chapter.needs && chapter.done ? h('span.pill.good', 'Done') : null),

        chapter.summary && !isOpen ? h('p.muted.hb-summary', chapter.summary) : null,

        isOpen
          ? h('div.hb-body', ...pages(chapter.body))
          : null,

        isOpen && chapter.needs && !chapter.done
          ? h('div.hb-ask',
            h('p.muted', chapter.asks === 'sign'
              ? 'Read it to the end, then sign to say you have.'
              : 'Read it to the end, then tick to say you have.'),
            h('button.btn.btn-primary', {
              type: 'button', onclick: () => onAck(chapter),
            }, chapter.asks === 'sign' ? 'Sign it' : 'I have read this'))
          : null,
      );
    };

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Handbook'),
          h('div.sub', data.chapters.length
            ? `${data.chapters.length} chapters`
            : 'Nothing published yet')),
        manage?.mayEdit
          ? h('div.btn-row',
            manage.available.length
              ? h('button.btn.btn-sm', {
                type: 'button',
                onclick: async () => {
                  const out = await api.handbookInstall();
                  toast(`${out.added} chapters added as drafts.`, 'good');
                  await paint();
                },
              }, `Add the standard chapters (${manage.available.length})`)
              : null,
            h('button.btn.btn-sm.btn-primary', {
              type: 'button',
              onclick: async () => { if (await editDialog(null, manage)) await paint(); },
            }, 'New chapter'))
          : null),

      data.outstanding.length
        ? h('div.alert.warn.hb-waiting',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', data.outstanding.length === 1
              ? 'One thing is waiting on you'
              : `${data.outstanding.length} things are waiting on you`),
            h('div.alert-detail', data.outstanding.map((c) => c.title).join(' · '))))
        : null,

      data.chapters.length
        ? h('div.hb-list', data.chapters.map(readCard))
        : (manage ? null : emptyState('Nothing published yet',
          'The property has not published any of it yet.')),

      manage ? adminCard(manage, paint) : null,
    );
  };

  await paint();
  return host;
}

/** The part only the office sees: every chapter, its state, and who is behind. */
function adminCard(manage, paint) {
  const rows = manage.chapters.map((chapter) => h('div.hb-row',
    h('div',
      h('div.hb-row-title', chapter.title,
        chapter.status === 'published' ? h('span.pill.good', `v${chapter.version}`) : null,
        chapter.status === 'draft' ? h('span.pill', 'Draft') : null,
        chapter.status === 'retired' ? h('span.pill', 'Taken down') : null,
        chapter.changed ? h('span.pill.warn', 'Edited since it went out') : null),
      h('div.muted.hb-row-sub', [
        WHAT_IT_ASKS[chapter.asks]?.label ?? 'To read',
        chapter.departments.length || chapter.tags.length
          ? [...chapter.departments, ...chapter.tags].join(', ')
          : 'Everybody',
        chapter.counts ? `${chapter.counts.done} of ${chapter.counts.of} done` : null,
      ].filter(Boolean).join(' · '))),

    h('div.btn-row',
      chapter.counts
        ? h('button.btn.btn-sm', {
          type: 'button',
          onclick: () => whoDialog(chapter),
        }, `Who has not (${chapter.counts.waiting})`)
        : null,
      manage.mayEdit
        ? h('button.btn.btn-sm', {
          type: 'button',
          onclick: async () => { if (await editDialog(chapter, manage)) await paint(); },
        }, 'Edit')
        : null,
      manage.mayEdit
        ? h('button.btn.btn-sm.btn-primary', {
          type: 'button',
          onclick: async () => { if (await publishDialog(chapter)) await paint(); },
        }, chapter.status === 'published' ? 'Publish again' : 'Publish')
        : null,
      manage.mayEdit && chapter.status === 'published'
        ? h('button.btn.btn-sm', {
          type: 'button',
          onclick: async () => {
            await api.handbookRetire(chapter.id);
            toast('Taken down. What people signed is kept.', 'good');
            await paint();
          },
        }, 'Take it down')
        : null),
  ));

  return card('Every chapter', { note: String(manage.chapters.length), wide: true },
    manage.chapters.length
      ? h('div.hb-rows', rows)
      : h('p.muted',
        'Nothing here yet. "Add the standard chapters" puts in eighteen written for a hotel, '
        + 'as drafts, for you to read and change before anybody sees them.'));
}

/** Writing one. */
async function editDialog(chapter, manage) {
  const title = h('input', { type: 'text', name: 'title', maxlength: 160, value: chapter?.title ?? '' });
  const summary = h('input', {
    type: 'text', name: 'summary', maxlength: 300, value: chapter?.summary ?? '',
    placeholder: 'One line, shown under the title',
  });
  const body = h('textarea', { name: 'body', rows: 18 }, chapter?.body ?? '');
  const asks = h('select', { name: 'asks' },
    manage.asks.map((a) => h('option', {
      value: a.key, selected: (chapter?.asks ?? 'read') === a.key,
    }, a.label)));
  const departments = h('input', {
    type: 'text', value: (chapter?.departments ?? []).join(', '),
    placeholder: 'Kitchen, Housekeeping',
  });
  const tags = h('input', {
    type: 'text', value: (chapter?.tags ?? []).join(', '),
    placeholder: 'Team lead',
  });
  const order = h('input', {
    type: 'number', min: '0', max: '9999', value: String(chapter?.order ?? 100),
  });

  const split = (input) => input.value.split(',').map((s) => s.trim()).filter(Boolean);

  return formDialog({
    title: chapter ? 'Edit a chapter' : 'A new chapter',
    wide: 'xl',
    submitLabel: 'Save the draft',
    body: h('div',
      field('Title', title),
      field('One line about it', summary),
      field('The chapter', body,
        'A line in capitals on its own becomes a heading. A blank line starts a paragraph.'),
      h('div.form-row',
        field('What it asks of people', asks),
        field('Where it sits', order, 'Lower numbers come first')),
      h('div.form-row',
        field('Only these departments', departments, 'Leave empty for everybody'),
        field('Only these tags', tags, 'A tag on the staff record')),
      chapter?.status === 'published'
        ? h('p.muted', 'Saving changes the draft only. Nothing on anybody’s screen moves until '
          + 'you publish it.')
        : null),
    onSubmit: async () => api.handbookSave({
      id: chapter?.id ?? null,
      title: title.value,
      summary: summary.value,
      body: body.value,
      asks: asks.value,
      order: Number(order.value) || 100,
      departments: split(departments),
      tags: split(tags),
    }),
  });
}

/** Publishing one, which is the moment it reaches people. */
async function publishDialog(chapter) {
  const again = h('input', { type: 'checkbox' });
  const fresh = chapter.status !== 'published' || chapter.changed;

  return formDialog({
    title: `Publish “${chapter.title}”`,
    submitLabel: 'Publish it',
    body: h('div',
      h('p', fresh
        ? (chapter.status === 'published'
          ? 'The words have changed, so this becomes version '
            + `${Number(chapter.version) + 1} and everybody it applies to will be asked to read `
            + 'it again.'
          : 'This puts it in front of everybody it applies to.')
        : 'The words are the same as the copy already out, so nothing changes for anybody who '
          + 'has already read it.'),
      chapter.asks !== 'read'
        ? h('p.muted', chapter.asks === 'sign'
          ? 'It asks for a signature. Everybody it applies to will be told once.'
          : 'It asks for a tick. Everybody it applies to will be told once.')
        : h('p.muted', 'It is a reference page. Nobody is asked for anything and nobody is told.'),
      !fresh && chapter.asks !== 'read'
        ? h('label.hb-again', again,
          h('span', 'Ask everybody to read and confirm it again anyway'))
        : null),
    onSubmit: async () => api.handbookPublish(chapter.id, { again: again.checked }),
  });
}

/** Signing one. */
async function signDialog(chapter) {
  const name = h('input', { type: 'text', maxlength: 120, autocomplete: 'name' });

  return formDialog({
    title: `Sign “${chapter.title}”`,
    submitLabel: 'Sign it',
    body: h('div',
      h('p.muted', 'Typing your full name here is your signature, under the Electronic '
        + 'Transactions Act, 2008 (Act 772). The time and these exact words are kept with it.'),
      field('Your full name', name)),
    onSubmit: async () => api.handbookAck(chapter.id, {
      version: chapter.version, name: name.value,
    }),
  });
}

/** Who has done it, and who has not. */
async function whoDialog(chapter) {
  let data;
  try {
    data = await api.handbookWho(chapter.id);
  } catch (err) { toast(err.message || 'Could not read that.', 'bad'); return; }

  await formDialog({
    title: data.title,
    wide: true,
    submitLabel: 'Close',
    body: h('div',
      h('p.muted', `Version ${data.version} · ${data.done} of ${data.of} done`),
      data.waiting.length
        ? h('div',
          h('h3.hb-head', `Still waiting (${data.waiting.length})`),
          h('div.hb-who', data.waiting.map((p) => h('span.pill', p.name))))
        : h('p', 'Everybody it applies to has done it.'),
      data.signed.length
        ? h('div',
          h('h3.hb-head', `Done (${data.signed.length})`),
          h('div.hb-who', data.signed.map((p) => h('span.pill.good',
            `${p.name} · ${String(p.at).slice(0, 10)}`))))
        : null),
    onSubmit: async () => true,
  });
}
