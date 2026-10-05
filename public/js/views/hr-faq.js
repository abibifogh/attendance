import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { readAsBlocks } from './handbook.js';

/**
 * The HR FAQ.
 *
 * ONE SCREEN, TWO AUDIENCES, like the handbook. A member of staff gets topics
 * across the top, questions that open one at a time, a search across all of
 * them, and a way to ask what the list did not answer. Whoever holds HR gets
 * the same list, and under it the drafts, the questions waiting on them, and
 * the editing.
 *
 * SHORT ON PURPOSE. The handbook is where the rules are set out in full and
 * acknowledged. This is what somebody opens on a phone at six in the morning
 * because they are sick, and it has to answer in three lines and a button.
 */

const openOnes = new Set();
let topicNow = 'all';
let queryNow = '';

export async function renderHrFaq() {
  const host = h('div');
  const data = await api.hrFaq();
  const reload = async () => mount(host, await renderHrFaq());

  const topics = data.topics;
  const entries = data.entries;
  const topicLabel = (key) => topics.find((t) => t.key === key)?.label ?? key;

  const list = h('div');
  const search = h('input.faq-search', {
    type: 'search', placeholder: 'Search, e.g. sick, leave, late, payslip',
    'aria-label': 'Search the FAQ', value: queryNow,
    oninput: (e) => { queryNow = e.target.value; paint(); },
  });

  const tabs = h('div.faq-tabs', { role: 'tablist' });
  const paintTabs = () => {
    const tab = (key, label, n) => h('button.faq-tab', {
      role: 'tab', 'aria-selected': String(topicNow === key && !queryNow.trim()),
      onclick: () => { topicNow = key; queryNow = ''; search.value = ''; paint(); },
    }, label, h('span.faq-tab-n', String(n)));
    mount(tabs,
      tab('all', 'All', entries.length),
      topics.map((t) => tab(t.key, t.label, entries.filter((e) => e.topic === t.key).length)));
  };

  const item = (entry) => {
    const open = openOnes.has(entry.id);
    const answer = h('div.faq-answer', { hidden: !open },
      typeset(entry.answer),
      entry.links.length
        ? h('div.faq-links', entry.links.map((l) => h('button.faq-link', {
          type: 'button',
          onclick: () => navigate(l.path),
        }, l.label, h('span', { 'aria-hidden': 'true' }, ' →'))))
        : null);
    const button = h('button.faq-q', {
      type: 'button', 'aria-expanded': String(open),
      onclick: () => {
        if (openOnes.has(entry.id)) openOnes.delete(entry.id); else openOnes.add(entry.id);
        answer.hidden = !openOnes.has(entry.id);
        button.setAttribute('aria-expanded', String(openOnes.has(entry.id)));
      },
    }, h('span.faq-mark', { 'aria-hidden': 'true' }, '+'), h('span.faq-qt', entry.question));
    return h('div.faq-item', button, answer);
  };

  const paint = () => {
    paintTabs();
    const q = queryNow.trim().toLowerCase();
    const shown = entries.filter((e) => (q
      ? `${e.question} ${e.answer}`.toLowerCase().includes(q)
      : topicNow === 'all' || e.topic === topicNow));
    if (!shown.length) {
      mount(list, h('div.card.faq-card', h('p.muted.faq-empty',
        q ? `Nothing for “${queryNow.trim()}”. Try another word, or ask HR below.` : 'Nothing here yet.')));
      return;
    }
    if (q || topicNow === 'all') {
      mount(list, topics
        .map((t) => ({ t, rows: shown.filter((e) => e.topic === t.key) }))
        .filter((g) => g.rows.length)
        .map((g) => h('div.faq-group', h('h3.faq-group-title', g.t.label),
          h('div.card.faq-card', g.rows.map(item)))));
    } else {
      mount(list, h('div.card.faq-card', shown.map(item)));
    }
  };
  paint();

  const asked = data.asked ?? [];
  const waiting = asked.find((a) => a.status === 'open');

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'HR FAQ'),
        h('div.sub', 'Quick answers for everyday questions. The handbook has the full rules.')),
      data.me
        ? h('button.btn.btn-primary', {
          onclick: () => askHr(waiting, reload),
        }, waiting ? 'Waiting on HR' : 'Ask HR a question')
        : null),

    entries.length
      ? h('div.faq-top', search, tabs)
      : null,
    entries.length
      ? list
      : emptyState('No questions yet', data.manage
        ? 'Add the standard questions below, or write your own.'
        : 'HR has not published any questions yet.'),

    asked.length ? askedCard(asked) : null,

    data.manage ? manageCard(data, topicLabel, reload) : null,
  );
  return host;
}

/** The answer, read as paragraphs, steps and lists rather than as one string. */
function typeset(text) {
  return readAsBlocks(text).map((block) => {
    if (block.kind === 'bullets') return h('ul.faq-list', block.items.map((t) => h('li', t)));
    if (block.kind === 'numbers') return h('ol.faq-list', block.items.map((t) => h('li', t)));
    return h('p', block.text);
  });
}

// ---------------------------------------------------------------------------
// Asking

async function askHr(waiting, reload) {
  if (waiting) {
    toast('HR has your question and will answer it here.', 'warn');
    return;
  }
  const done = await formDialog({
    title: 'Ask HR a question',
    submitLabel: 'Send it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.88rem', marginTop: 0 } },
        'Whoever holds HR gets it straight away. The answer comes back here, and if it is '
        + 'something others would ask, it joins the FAQ.'),
      field('Your question', h('textarea', {
        name: 'question', rows: 4, maxlength: 500, required: true,
        placeholder: 'e.g. Can I carry unused leave into next year?',
      }))),
    onSubmit: (form) => api.hrFaqAsk({ question: form.get('question') }),
  });
  if (!done) return;
  toast('Sent to HR.', 'good');
  await reload();
}

/** What this person has asked, and what came back. */
function askedCard(asked) {
  return card('My questions', { wide: true, note: `${asked.length}` },
    h('div.faq-asked', asked.map((a) => h('div.faq-asked-row',
      h('div',
        h('strong', a.question),
        h('div.muted', { style: { fontSize: '.82rem' } },
          `Asked ${fmtDay(String(a.askedAt).slice(0, 10))}`
          + (a.answeredAt ? ` · answered ${fmtDay(String(a.answeredAt).slice(0, 10))}` : ''))),
      a.status === 'answered'
        ? h('div.faq-asked-answer', typeset(a.answer))
        : h('span.pill.warn', 'Waiting on HR')))));
}

// ---------------------------------------------------------------------------
// Managing it

function manageCard(data, topicLabel, reload) {
  const { manage, topics, links } = data;
  const state = { draft: 0, published: 0, retired: 0 };
  for (const e of manage.entries) state[e.status] = (state[e.status] ?? 0) + 1;

  const row = (e) => h('div.faq-edit-row', { class: e.status === 'retired' ? 'faq-edit-row is-retired' : 'faq-edit-row' },
    h('div.faq-edit-main',
      h('div', h('strong', e.question)),
      h('div.muted', { style: { fontSize: '.8rem' } },
        topicLabel(e.topic),
        e.updatedAt ? ` · changed ${fmtDay(String(e.updatedAt).slice(0, 10))}` : '',
        e.updatedBy ? ` by ${e.updatedBy}` : '')),
    h('div.faq-edit-state',
      e.status === 'published'
        ? h('span.pill.good', 'Published')
        : e.status === 'retired' ? h('span.pill', 'Retired') : h('span.pill.warn', 'Draft'),
      e.changed ? h('span.pill.warn', { title: 'Edited since it was published' }, 'Edited') : null),
    h('div.btn-row.faq-edit-actions',
      h('button.btn-sm', { onclick: () => editDialog(e, topics, links, reload) }, 'Edit'),
      e.status !== 'published' || e.changed
        ? h('button.btn-sm.btn-primary', {
          onclick: async () => {
            try { await api.hrFaqPublish(e.id); toast('Published.', 'good'); await reload(); } catch (err) { toast(err.message, 'bad'); }
          },
        }, e.status === 'published' ? 'Publish changes' : 'Publish')
        : null,
      e.status === 'published'
        ? h('button.btn-sm', {
          onclick: async () => { await api.hrFaqRetire(e.id); toast('Taken off the screen.'); await reload(); },
        }, 'Retire')
        : h('button.btn-ghost.btn-sm', {
          onclick: async () => {
            if (!window.confirm('Remove this question for good?')) return;
            await api.hrFaqRemove(e.id); toast('Removed.'); await reload();
          },
        }, 'Remove')));

  const open = manage.open ?? [];

  return card('Managing the FAQ', {
    wide: true,
    note: `${state.published} published · ${state.draft} draft${state.retired ? ` · ${state.retired} retired` : ''}`,
    actions: h('div.btn-row',
      manage.available.length
        ? h('button.btn-sm', {
          title: 'Add any of the standard questions this property has not got, as drafts',
          onclick: async () => {
            const done = await api.hrFaqInstall();
            toast(`Added ${done.added} as drafts.`, 'good');
            await reload();
          },
        }, `Add the standard questions (${manage.available.length})`)
        : null,
      h('button.btn-sm', { onclick: () => tellDialog(reload) }, 'Tell staff about changes'),
      h('button.btn-sm.btn-primary', { onclick: () => editDialog(null, topics, links, reload) }, '+ Add a question')),
  },
  open.length
    ? h('div.faq-open',
      h('h3', `Waiting on you (${open.length})`),
      open.map((q) => h('div.faq-open-row',
        h('div',
          h('strong', q.name), q.department ? h('span.muted', ` · ${q.department}`) : null,
          h('div', q.question),
          h('div.muted', { style: { fontSize: '.8rem' } }, `Asked ${fmtDay(String(q.askedAt).slice(0, 10))}`)),
        h('button.btn-sm.btn-primary', { onclick: () => answerDialog(q, topics, reload) }, 'Answer'))))
    : null,
  h('p.muted', { style: { fontSize: '.85rem' } },
    'What staff read is the published copy. Edit as much as you like; nothing changes on their '
    + 'screen until you press Publish. Retire a question to take it off without losing it.'),
  h('div.faq-edit-list', manage.entries.map(row)));
}

async function editDialog(entry, topics, links, reload) {
  const picked = (entry?.links ?? []).map((l) => ({ ...l }));
  const linksBox = h('div.faq-link-picks');
  const paintLinks = () => mount(linksBox,
    picked.map((l, i) => h('span.pill', l.label, h('button.faq-link-off', {
      type: 'button', 'aria-label': `Take ${l.label} off`,
      onclick: () => { picked.splice(i, 1); paintLinks(); },
    }, '✕'))),
    picked.length < 4
      ? h('select', {
        'aria-label': 'Add a link to a screen',
        onchange: (e) => {
          const path = e.target.value;
          if (!path) return;
          const screen = links.find((l) => l.path === path);
          const label = window.prompt('Words on the button', screen.label) ?? screen.label;
          picked.push({ path, label: label.trim() || screen.label });
          paintLinks();
        },
      }, h('option', { value: '' }, '+ Link to a screen…'),
      links.map((l) => h('option', { value: l.path }, l.label)))
      : null);
  paintLinks();

  const done = await formDialog({
    title: entry ? 'Edit the question' : 'A new question',
    submitLabel: entry ? 'Save the draft' : 'Save as a draft',
    wide: true,
    body: h('div',
      field('Topic', h('select', { name: 'topic', required: true },
        topics.map((t) => h('option', { value: t.key, selected: t.key === (entry?.topic ?? 'sick') }, t.label)))),
      field('Question', h('input', { type: 'text', name: 'question', maxlength: 200, required: true, value: entry?.question ?? '' }),
        'As somebody would ask it: "I’m sick and can’t come in. What do I do?"'),
      field('Answer', h('textarea', { name: 'answer', rows: 10, maxlength: 6000 }, entry?.answer ?? ''),
        'Plain text. A blank line between paragraphs, "- " for a list, "1. " for steps. Keep it to what to do and where.'),
      field('Where it sends them', linksBox, 'Buttons under the answer that open a screen in HIVE'),
      field('Order', h('input', { type: 'number', name: 'order', min: 0, max: 9999, value: entry?.order ?? 100 }),
        'Lower comes first within its topic')),
    onSubmit: (form) => api.hrFaqSave({
      id: entry?.id ?? null,
      topic: form.get('topic'),
      question: form.get('question'),
      answer: form.get('answer'),
      links: picked,
      order: Number(form.get('order')) || 100,
    }),
  });
  if (!done) return;
  toast(entry ? 'Draft saved. Publish it when it is ready.' : 'Saved as a draft.', 'good');
  await reload();
}

async function tellDialog(reload) {
  const done = await formDialog({
    title: 'Tell staff the FAQ changed',
    submitLabel: 'Send',
    body: h('div',
      h('p.muted', { style: { fontSize: '.88rem', marginTop: 0 } },
        'One short notice to everybody with a login, with a line on what moved. Fixing a typo '
        + 'does not need one; a new rule on sick days does.'),
      field('What changed', h('input', { type: 'text', name: 'about', maxlength: 200, placeholder: 'e.g. New answer on what to do when sick' }))),
    onSubmit: (form) => api.hrFaqTell({ about: form.get('about') }),
  });
  if (!done) return;
  toast(`Told ${done.told} ${done.told === 1 ? 'person' : 'people'}.`, 'good');
  await reload();
}

async function answerDialog(q, topics, reload) {
  const add = h('input', { type: 'checkbox', name: 'addToFaq' });
  const topicPick = h('select', { name: 'topic', disabled: true },
    topics.map((t) => h('option', { value: t.key }, t.label)));
  const asFaq = h('input', { type: 'text', name: 'question', maxlength: 200, disabled: true, value: q.question.slice(0, 200) });
  add.addEventListener('change', () => { topicPick.disabled = !add.checked; asFaq.disabled = !add.checked; });

  const done = await formDialog({
    title: `Answer ${q.name}`,
    submitLabel: 'Send the answer',
    wide: true,
    body: h('div',
      h('p', h('strong', q.question)),
      field('Your answer', h('textarea', { name: 'answer', rows: 7, maxlength: 6000, required: true })),
      h('label.tickline', add, h('span', 'Also add it to the FAQ as a draft, so the next person finds it')),
      field('Under', topicPick),
      field('As the question', asFaq)),
    onSubmit: (form) => api.hrFaqAnswer(q.id, {
      answer: form.get('answer'),
      addToFaq: add.checked,
      topic: form.get('topic'),
      question: form.get('question'),
    }),
  });
  if (!done) return;
  toast(done.faqId ? 'Answered, and added as a draft.' : 'Answered.', 'good');
  await reload();
}
