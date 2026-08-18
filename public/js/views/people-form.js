import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { navigate } from '../app.js';

/**
 * What this property asks its people for.
 *
 * One screen, three lists, and the same three answers against every line of
 * them: ask for it, insist on it, or do not ask at all. That is deliberately
 * narrower than it could be — there is no reordering, no renaming, no inventing
 * a question of your own — because the fields are what the record holds, and a
 * form that could ask for something the record has nowhere to put would be a
 * form that quietly loses answers.
 *
 * Everything is shown, including what is switched off. A settings page that
 * hides what it is hiding is a page nobody can use to find out why a form is
 * missing a question.
 */
export async function renderPeopleForm() {
  const host = h('div');
  const data = await api.hrForm();
  const reload = async () => mount(host, await renderPeopleForm());

  // Held here and saved in one press. Twenty questions each saving on change is
  // twenty chances to half-save a plan over a bad connection.
  const plan = {
    fields: { ...data.plan.fields },
    lists: { ...data.plan.lists },
    documents: { ...data.plan.documents },
  };

  const counts = () => {
    const all = [...Object.values(plan.fields), ...Object.values(plan.lists),
      ...Object.values(plan.documents)];
    return {
      required: all.filter((v) => v === 'require').length,
      skipped: all.filter((v) => v === 'skip').length,
    };
  };

  const summary = h('span.muted');
  const refresh = () => {
    const { required, skipped } = counts();
    summary.textContent = required || skipped
      ? `${required} insisted on, ${skipped} not asked`
      : 'The standard set — everything asked for, nothing insisted on';
  };

  /**
   * One line, and the three answers to it.
   *
   * A segmented control rather than a dropdown: the whole value of this screen
   * is reading a column of thirty and seeing at a glance which are red, and a
   * page of closed dropdowns shows nothing until you open all of them.
   */
  const row = (group, key, label, detail, current) => {
    const buttons = ['ask', 'require', 'skip'].map((value) => h('button.btn-sm', {
      type: 'button',
      class: (plan[group][key] ?? current ?? 'ask') === value ? 'active' : '',
      onclick: (event) => {
        if (value === 'ask') delete plan[group][key];
        else plan[group][key] = value;
        for (const sibling of event.target.parentElement.children) {
          sibling.classList.toggle('active', sibling === event.target);
        }
        event.target.closest('.ask-row').dataset.ask = value;
        refresh();
      },
    }, data.asks.find((a) => a.key === value).label));

    return h('div.ask-row', { 'data-ask': plan[group][key] ?? current ?? 'ask' },
      h('div',
        h('div', label),
        detail ? h('small.muted', detail) : null),
      h('div.seg.seg-sm', buttons),
    );
  };

  const save = async (event) => {
    event.target.disabled = true;
    try {
      await api.hrSaveForm({ plan });
      toast('Saved. The next link somebody opens asks for this.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  refresh();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'What to ask for'),
        h('div.sub', 'The form somebody fills in on their phone, and the paper they send with it'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('people') }, '‹ People'),
        h('button.btn.btn-primary', { onclick: save }, 'Save'),
      ),
    ),

    h('div.alert.info',
      h('span.alert-icon', 'ℹ️'),
      h('div',
        h('div.alert-title', summary),
        h('div.alert-detail',
          'This applies to every link from now on. Links already sent pick it up when they are '
          + 'next opened, and nothing anybody has already sent in is affected.'),
      )),

    ...data.sections.map((section) => card(section.label, {
      note: section.note ?? null,
      wide: true,
    }, h('div.ask-list', section.fields.map((field) =>
      row('fields', field.key, field.label, field.hint, field.ask))))),

    card('Lists they can add to', { wide: true },
      h('div.ask-list', data.lists.map((list) =>
        row('lists', list.key, list.label, null, list.ask)))),

    card('Paper they can photograph', {
      note: 'Sent from their phone. Nothing goes on the record until you have looked at it',
      wide: true,
    }, data.documents.length
      ? h('div',
        h('div.ask-list', data.documents.map((doc) => row(
          'documents',
          doc.code,
          doc.label,
          [doc.detail, doc.applies === 'food' ? 'Only asked of people who handle food.' : null,
            doc.applies === 'foreign' ? 'Only asked of people who are not Ghanaian.' : null]
            .filter(Boolean).join(' '),
          doc.ask,
        ))),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
          'A contract is not on this list. It is the property’s own document, signed through '
          + 'the same link, and would mean nothing arriving as a photograph from the person it '
          + 'binds.'))
      : emptyState('Nothing to attach', 'No document kinds are set up.')),

    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn.btn-primary', { onclick: save }, 'Save')),
  );

  return host;
}
