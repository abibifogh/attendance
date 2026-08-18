import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import { navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';

/**
 * The words a contract is made from.
 *
 * A template is not a contract. Issuing one copies the words out and freezes
 * them against a person, so editing a template next year cannot change what
 * somebody signed last year — which is the only property that makes templates
 * safe to edit at all.
 */
export async function renderPeopleTemplates() {
  const host = h('div');
  const { rows, placeholders } = await api.hrTemplates();
  const reload = async () => mount(host, await renderPeopleTemplates());

  const edit = async (existing) => {
    const done = await formDialog({
      title: existing ? `Edit ${existing.name}` : 'New template',
      submitLabel: existing ? 'Save' : 'Create it',
      body: h('div',
        h('div.field-row',
          field('Name', h('input', {
            type: 'text', name: 'name', required: true, maxlength: 120,
            value: existing?.name ?? '', placeholder: 'Contract of employment — permanent',
          })),
          field('Kind', h('select', { name: 'kind' },
            ['contract', 'letter', 'policy'].map((k) => h('option', {
              value: k, selected: existing?.kind === k,
            }, k === 'contract' ? 'Contract' : k === 'letter' ? 'Letter' : 'Policy to acknowledge')))),
        ),

        h('details', { open: !existing },
          h('summary', { style: { cursor: 'pointer', fontSize: '.88rem', margin: '.4rem 0' } },
            'What you can put in double braces'),
          h('div.chip-row', placeholders.map((p) => h('button.btn-sm', {
            type: 'button',
            title: p.ask ? 'You are asked for this when you issue it' : 'Filled in from their record',
            onclick: (e) => {
              const box = e.target.closest('form').querySelector('[name="body"]');
              const at = box.selectionStart ?? box.value.length;
              box.value = `${box.value.slice(0, at)}{{${p.key}}}${box.value.slice(at)}`;
              box.focus();
            },
          }, `${p.label}${p.ask ? ' *' : ''}`))),
          h('p.muted', { style: { fontSize: '.8rem' } },
            'Starred ones are typed in when the contract is issued. Everything else comes '
            + 'straight out of their record, and a placeholder with nothing behind it is left '
            + 'visibly unfilled rather than blank.'),
        ),

        field('The words', h('textarea', {
          name: 'body', rows: 22, required: true, maxlength: 60000,
          style: { fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: '.85rem' },
          value: existing?.body ?? STARTER,
        })),

        existing
          ? field('Status', h('select', { name: 'active' },
            h('option', { value: 'true', selected: !!existing.active }, 'In use'),
            h('option', { value: 'false', selected: !existing.active }, 'Retired')))
          : null,
      ),
      onSubmit: async (form) => {
        const payload = {
          name: form.get('name'),
          kind: form.get('kind'),
          body: form.get('body'),
          active: form.get('active') !== 'false',
        };
        return existing ? api.hrUpdateTemplate(existing.id, payload) : api.hrCreateTemplate(payload);
      },
    });

    if (done) { toast('Saved.', 'good'); await reload(); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete the "${row.name}" template? Contracts already issued from it are `
      + 'untouched — they keep their own copy of the words.')) return;
    await api.hrDeleteTemplate(row.id);
    toast('Deleted.');
    await reload();
  };

  /**
   * Put the standard set in, without disturbing anything already here.
   *
   * Only what is missing, matched on the code each was loaded under. A
   * template somebody has rewritten into the property's own words is never
   * touched, so this is safe to press again after the set has been added to.
   */
  const loadStandard = async () => {
    if (!window.confirm(
      'Add the standard Ghana set — employment contracts, the section 13 statement, the '
      + 'handbook, confidentiality, data protection, health and safety and next of kin?\n\n'
      + 'Anything you have already edited is left exactly as it is.',
    )) return;
    const done = await api.hrLoadStandardTemplates();
    toast(done.added
      ? `${done.added} template${done.added === 1 ? '' : 's'} added.`
      : 'Nothing to add — you already have all of them.', 'good');
    await reload();
  };

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Templates'),
        h('div.sub', 'What a contract is made from'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('people') }, '‹ People'),
        h('button.btn-sm', { onclick: loadStandard }, 'Load the standard set'),
        h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ New template'),
      ),
    ),

    rows.length ? null : starterCard(loadStandard),

    card('Templates', { note: `${rows.length} held`, wide: true },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('div', h('div', v),
            h('small.muted', `${r.kind}${r.active ? '' : ' · retired'}`)),
        },
        {
          key: 'uses',
          label: 'Fills in',
          format: (v) => (v.length
            ? h('div.chip-row', v.map((p) => h('span.pill', p.label + (p.ask ? ' *' : ''))))
            : h('span.muted', 'nothing — fixed words')),
        },
        {
          key: 'body',
          label: 'Length',
          format: (v) => h('small.muted', `${String(v).split(/\s+/).length} words`),
        },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
            h('button.btn-sm', { onclick: () => remove(r) }, 'Delete'),
          ),
        },
      ], rows, {
        rowClass: (r) => (r.active ? '' : 'row-muted'),
        empty: 'No templates yet. The new-template button starts you off with one that has the '
          + 'particulars Ghana’s Labour Act asks for.',
      })),

    h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', 'A starting point, not legal advice'),
        h('div.alert-detail',
          'The standard set was written from the Labour Act 2003 (Act 651), the National '
          + 'Pensions Act 2008 (Act 766), the Public Health Act 2012 (Act 851) and the Data '
          + 'Protection Act 2012 (Act 843). Nobody has settled it as a lawyer. Have somebody '
          + 'who knows Ghanaian employment law read it before you issue any of it — and note '
          + 'that a new Labour Bill is expected to replace Act 651, which will mean revisiting '
          + 'these. Contracts already signed keep their own words and are unaffected.'),
      )),
  );

  return host;
}

/** The nudge on an empty screen, which is where everybody starts. */
function starterCard(loadStandard) {
  return card('Start with the standard set', { wide: true },
    h('p', 'Ten documents written from the Ghanaian statutes that apply to a hotel:'),
    h('ul', { style: { margin: '0 0 .8rem', paddingLeft: '1.1rem', fontSize: '.9rem' } },
      h('li', h('strong', 'Contracts of employment'), ' — permanent, fixed term and casual, '
        + 'with the particulars section 13 of Act 651 requires'),
      h('li', h('strong', 'Written statement of particulars'), ' — the two-month statement, for '
        + 'anybody already working here who never got a contract'),
      h('li', h('strong', 'Confirmation after probation')),
      h('li', h('strong', 'Handbook and house rules'), ', ', h('strong', 'confidentiality and '
        + 'guest privacy'), ', ', h('strong', 'health, safety and food hygiene')),
      h('li', h('strong', 'Personal data notice and consent'), ' — required by Act 843 before '
        + 'holding somebody’s details at all'),
      h('li', h('strong', 'Next of kin declaration')),
    ),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'They come in as ordinary templates. Edit them into your own words — once you have, '
      + 'loading the set again never touches them.'),
    h('button.btn.btn-primary', { onclick: loadStandard }, 'Load the standard set'),
  );
}

/**
 * Something to edit rather than a blank box.
 *
 * Short on purpose. The full contracts live in the standard set, where they
 * belong; what a blank "new template" needs is a shape, not a second copy of
 * something already one button away.
 */
const STARTER = `TITLE OF THIS DOCUMENT

{{property}} and {{name}} of {{address}}, employee number {{employee_no}}.

1. FIRST THING
   Say it plainly.

2. SECOND THING
   Placeholders in double braces are filled in when this is issued. The buttons
   above the box list the ones you can use.

The person signing confirms that they have read and understood this document.

Dated {{today}}.`;
