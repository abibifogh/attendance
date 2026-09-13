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
 *
 * AND IT IS SET LIKE A BOOK. A contents page, then one chapter at a time on a
 * measured column, because a wall of text at the full width of a laptop is a
 * wall nobody reads to the end of, and reading it to the end is the entire
 * point of asking somebody to sign it.
 */

const WHAT_IT_ASKS = {
  read: { label: 'To read', pill: null },
  ack: { label: 'Read and tick', pill: 'Tick it' },
  sign: { label: 'To sign', pill: 'Sign it' },
};

const twoDigit = (n) => String(n).padStart(2, '0');

const readableDate = (iso) => {
  if (!iso) return null;
  const when = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
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

const isHeading = (line) => {
  const text = String(line ?? '').trim();
  return /^[A-Z0-9 ,'()&.’/-]{3,}$/.test(text) && text === text.toUpperCase();
};

const BULLET = /^[-*•]\s+/;
const NUMBERED = /^\d{1,2}[.)]\s+/;

/**
 * A chapter, read as a shape rather than as a string.
 *
 * Pure, and exported, because what counts as a heading and what counts as a
 * list is the difference between a handbook and a wall of text, and it is
 * worth being able to argue with it in a test rather than in a browser.
 *
 * Four kinds. A line in capitals on its own is a heading, which is how these
 * chapters are already written and means nobody has to learn a markup
 * language to add one. A run of lines starting with a dash is a list, and a
 * run starting with a number is a numbered list. Everything else is a
 * paragraph, joined back up out of the typist's line breaks.
 */
export function readAsBlocks(body) {
  const out = [];
  for (const chunk of String(body ?? '').split(/\n{2,}/)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);

    let run = [];
    let kind = null;
    const flush = () => {
      if (!run.length) return;
      if (kind === 'text') out.push({ kind: 'text', text: reflow(run.join('\n')) });
      else out.push({ kind, items: run.slice() });
      run = [];
      kind = null;
    };

    for (const line of lines) {
      if (isHeading(line)) { flush(); out.push({ kind: 'heading', text: line }); continue; }

      const next = BULLET.test(line) ? 'bullets' : NUMBERED.test(line) ? 'numbers' : 'text';
      if (kind && next !== kind) flush();
      kind = next;
      run.push(next === 'text' ? line : line.replace(BULLET, '').replace(NUMBERED, ''));
    }
    flush();
  }
  return out;
}

/** And the same shape, as elements. The first paragraph carries the chapter. */
function typeset(body) {
  const blocks = readAsBlocks(body);
  const leadAt = blocks.findIndex((b) => b.kind === 'text');
  const headingFirst = blocks.findIndex((b) => b.kind === 'heading');

  return blocks.map((block, i) => {
    if (block.kind === 'heading') return h('h3.hb-section', block.text);
    if (block.kind === 'bullets') {
      return h('ul.hb-list-block', block.items.map((t) => h('li', t)));
    }
    if (block.kind === 'numbers') {
      return h('ol.hb-list-block', block.items.map((t) => h('li', t)));
    }
    // The opening words, before any heading, are the chapter's own summary of
    // itself and are set larger. Only when they really do come first.
    const lead = i === leadAt && (headingFirst === -1 || leadAt < headingFirst);
    return h(lead ? 'p.hb-lead' : 'p', block.text);
  });
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export async function renderHandbook() {
  const host = h('div');
  // Which chapter is being read. Null is the contents page, which is where
  // somebody who has finished one lands again.
  let reading = null;

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

    const list = data.chapters;
    const numberOf = new Map(list.map((c, i) => [c.id, i + 1]));
    const asked = list.filter((c) => c.needs);
    const done = asked.filter((c) => c.done).length;

    const onAck = async (chapter) => {
      if (chapter.asks === 'sign') {
        const signed = await signDialog(chapter);
        if (!signed) return;
      } else {
        try {
          await api.handbookAck(chapter.id, { version: chapter.version });
        } catch (err) { toast(err.message || 'That did not work.', 'bad'); return; }
      }
      toast('Thank you. It is on your record.', 'good');
      await paint();
    };

    const goTo = (id) => { reading = id; paint(); window.scrollTo({ top: 0 }); };

    // ----------------------------------------------------------- one chapter
    const chapterPage = (chapter) => {
      const at = numberOf.get(chapter.id);
      const asks = WHAT_IT_ASKS[chapter.asks] ?? WHAT_IT_ASKS.read;
      const previous = list[at - 2] ?? null;
      const next = list[at] ?? null;

      return h('article.hb-page',
        h('button.hb-back', { type: 'button', onclick: () => goTo(null) }, '← All chapters'),

        h('header.hb-page-head',
          h('div.hb-eyebrow', `Chapter ${twoDigit(at)}`),
          h('h2', chapter.title),
          chapter.summary ? h('p.hb-standfirst', chapter.summary) : null,
          h('div.hb-meta',
            chapter.needs && chapter.done ? h('span.pill.good', 'Done') : null,
            chapter.needs && !chapter.done ? h('span.pill.warn', asks.pill) : null,
            h('span', `Version ${chapter.version}`),
            readableDate(chapter.publishedAt)
              ? h('span', `Published ${readableDate(chapter.publishedAt)}`)
              : null)),

        h('div.hb-body', ...typeset(chapter.body)),

        chapter.needs && !chapter.done
          ? h('div.hb-ask',
            h('div',
              h('strong', chapter.asks === 'sign'
                ? 'This chapter asks for your signature'
                : 'This chapter asks you to confirm you have read it'),
              h('p.muted', chapter.asks === 'sign'
                ? 'Read it to the end, then sign to say you have. Your name, the date and these '
                  + 'exact words are kept together.'
                : 'Read it to the end, then tick to say you have. The date and these exact words '
                  + 'are kept with it.')),
            h('button.btn.btn-primary', {
              type: 'button', onclick: () => onAck(chapter),
            }, chapter.asks === 'sign' ? 'Sign it' : 'I have read this'))
          : null,

        chapter.needs && chapter.done
          ? h('div.hb-ask.hb-ask-done',
            h('div', h('strong', 'You have already done this one'),
              h('p.muted', `Recorded against version ${chapter.version}. If the wording changes `
                + 'you will be asked again.')))
          : null,

        h('nav.hb-turn',
          previous
            ? h('button.hb-turn-btn', { type: 'button', onclick: () => goTo(previous.id) },
              h('span.muted', '← Before'), h('span', previous.title))
            : h('span'),
          next
            ? h('button.hb-turn-btn.hb-turn-next', { type: 'button', onclick: () => goTo(next.id) },
              h('span.muted', 'Next →'), h('span', next.title))
            : h('span')),
      );
    };

    // --------------------------------------------------------- the contents
    const contentsRow = (chapter, i) => {
      const asks = WHAT_IT_ASKS[chapter.asks] ?? WHAT_IT_ASKS.read;
      return h('button.hb-item', {
        type: 'button',
        class: chapter.needs && !chapter.done ? 'hb-item hb-item-waiting' : null,
        onclick: () => goTo(chapter.id),
      },
      h('span.hb-num', twoDigit(i + 1)),
      h('span.hb-item-text',
        h('span.hb-item-title', chapter.title),
        chapter.summary ? h('span.hb-item-sub', chapter.summary) : null),
      chapter.needs && !chapter.done ? h('span.pill.warn', asks.pill) : null,
      chapter.needs && chapter.done ? h('span.pill.good', 'Done') : null);
    };

    const contents = h('div',
      asked.length
        ? h('div.hb-progress',
          h('div.hb-progress-head',
            h('strong', done === asked.length
              ? 'You are up to date'
              : `${asked.length - done} of ${asked.length} still waiting on you`),
            h('span.muted', `${done} of ${asked.length} done`)),
          h('div.hb-bar', h('div.hb-bar-fill', {
            style: { width: `${asked.length ? Math.round((done / asked.length) * 100) : 0}%` },
          })))
        : null,

      list.length
        ? h('div.hb-contents', list.map(contentsRow))
        : (manage ? null : emptyState('Nothing published yet',
          'The property has not published any of it yet.')),
    );

    const chapter = reading ? list.find((c) => c.id === reading) : null;
    if (reading && !chapter) reading = null;

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Handbook'),
          h('div.sub', [
            data.property,
            list.length ? `${list.length} chapters` : 'Nothing published yet',
          ].filter(Boolean).join(' · '))),
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

      // The one thing that catches people out: chapters published, handbook
      // switched off, and nothing on a single phone. Said here, where the
      // person who just pressed Publish is standing, and fixed here too.
      manage?.mayEdit && !data.on
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'Staff cannot see any of this yet'),
            h('div.alert-detail',
              'The handbook is switched off, so publishing a chapter puts it in front of the '
              + 'office and nobody else.'),
            h('button.btn.btn-sm.btn-primary', {
              type: 'button',
              style: { marginTop: '.6rem' },
              onclick: async () => {
                try {
                  await api.attUpdateSettings({ handbook_on: '1' });
                  toast('The handbook is open to staff.', 'good');
                  await paint();
                } catch (err) { toast(err.message || 'That did not work.', 'bad'); }
              },
            }, 'Turn it on for staff')))
        : null,

      chapter ? chapterPage(chapter) : contents,

      manage && !chapter ? adminCard(manage, paint) : null,
    );
  };

  await paint();
  return host;
}

// ---------------------------------------------------------------------------
// The office side
// ---------------------------------------------------------------------------

/** Every chapter, its state, and who is behind. */
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

/**
 * Who a chapter is for.
 *
 * Typed department names are how a chapter ends up aimed at "Kitchen " and
 * reaching nobody, so nothing is typed: the real departments and the real tags
 * are ticked, with the number of people behind each one, and the line at the
 * bottom says who that comes to before anything is saved.
 */
function audiencePicker(chapter, audience) {
  const picked = {
    departments: new Set(chapter?.departments ?? []),
    tags: new Set(chapter?.tags ?? []),
  };
  const summary = h('p.hb-aud-count');

  const say = () => {
    const bits = [...picked.departments, ...picked.tags];
    summary.textContent = bits.length
      ? `Only ${bits.join(', ')}. Everybody else will not see this chapter.`
      : `Everybody: all ${audience.everybody} on the staff list.`;
  };

  const tick = (group, name, people) => {
    const box = h('input', { type: 'checkbox', checked: picked[group].has(name) });
    box.addEventListener('change', () => {
      if (box.checked) picked[group].add(name); else picked[group].delete(name);
      say();
    });
    return h('label.hb-tick', box,
      h('span', name),
      h('span.muted.hb-tick-n', people === 1 ? '1' : String(people)));
  };

  // A department or tag the chapter was aimed at that nobody carries any more
  // still has to appear, ticked, or saving the chapter would quietly widen it.
  const orphans = (group, known) => [...picked[group]]
    .filter((name) => !known.some((k) => k.name === name))
    .map((name) => ({ name, people: 0 }));

  const departments = [...audience.departments, ...orphans('departments', audience.departments)];
  const tags = [...audience.tags, ...orphans('tags', audience.tags)];

  say();

  return {
    picked,
    element: h('div.hb-audience',
      h('div.hb-aud-group',
        h('div.hb-aud-head', 'Departments'),
        departments.length
          ? h('div.hb-ticks', departments.map((d) => tick('departments', d.name, d.people)))
          : h('p.muted', 'No departments set up yet.')),
      h('div.hb-aud-group',
        h('div.hb-aud-head', 'Tags on the staff record'),
        tags.length
          ? h('div.hb-ticks', tags.map((t) => tick('tags', t.name, t.people)))
          : h('p.muted', 'Nobody carries a tag yet. Tags are set on a person under People.')),
      summary),
  };
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
  const order = h('input', {
    type: 'number', min: '0', max: '9999', value: String(chapter?.order ?? 100),
  });

  const audience = audiencePicker(chapter, manage.audience
    ?? { departments: [], tags: [], everybody: 0 });

  return formDialog({
    title: chapter ? 'Edit a chapter' : 'A new chapter',
    wide: 'xl',
    submitLabel: 'Save the draft',
    body: h('div',
      field('Title', title),
      field('One line about it', summary),
      field('The chapter', body,
        'A line in capitals on its own becomes a heading. A blank line starts a paragraph. '
        + 'A line starting with a dash becomes a bullet, and one starting with a number '
        + 'becomes a numbered point.'),
      h('div.form-row',
        field('What it asks of people', asks),
        field('Where it sits', order, 'Lower numbers come first')),
      field('Who sees it', audience.element),
      chapter?.status === 'published'
        ? h('p.muted', 'Saving changes the draft only. Nothing on anybody’s screen moves '
          + 'until you publish it.')
        : null),
    onSubmit: async () => api.handbookSave({
      id: chapter?.id ?? null,
      title: title.value,
      summary: summary.value,
      body: body.value,
      asks: asks.value,
      order: Number(order.value) || 100,
      departments: [...audience.picked.departments],
      tags: [...audience.picked.tags],
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
      h('p.muted', chapter.departments.length || chapter.tags.length
        ? `It goes to ${[...chapter.departments, ...chapter.tags].join(', ')} and nobody else.`
        : 'It goes to everybody on the staff list.'),
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
          h('h3.hb-section', `Still waiting (${data.waiting.length})`),
          h('div.hb-who', data.waiting.map((p) => h('span.pill', p.name))))
        : h('p', 'Everybody it applies to has done it.'),
      data.signed.length
        ? h('div',
          h('h3.hb-section', `Done (${data.signed.length})`),
          h('div.hb-who', data.signed.map((p) => h('span.pill.good',
            `${p.name} · ${String(p.at).slice(0, 10)}`))))
        : null),
    onSubmit: async () => true,
  });
}
