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

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Templates'),
        h('div.sub', 'What a contract is made from'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('people') }, '‹ People'),
        h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ New template'),
      ),
    ),

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

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Section 12 of the Labour Act 2003 requires a written contract where somebody is employed '
      + 'for six months or more, and section 13 requires the main terms in writing within two '
      + 'months of starting. The starter template below has those particulars in it. It is a '
      + 'starting point and not legal advice — have somebody who knows Ghanaian employment law '
      + 'read it before you issue it to anybody.'),
  );

  return host;
}

/**
 * Something to edit rather than a blank box.
 *
 * The particulars are the ones the Labour Act names — job, pay, hours, notice,
 * grounds for termination — because a blank template is a template nobody
 * finishes, and one missing the statutory terms is worse than none.
 */
const STARTER = `CONTRACT OF EMPLOYMENT

This agreement is made between {{property}} ("the Employer") and {{name}} of
{{address}} ("the Employee"), holding {{id_type}}, employee number
{{employee_no}}.

1. POSITION
   The Employee is engaged as {{job_title}} in the {{department}} department.

2. COMMENCEMENT
   Employment begins on {{start_date}}.

3. PROBATION
   The first {{probation}} of employment is probationary. During this period
   either party may end the employment on one week's notice.

4. REMUNERATION
   {{salary}}, payable monthly in arrears, subject to statutory deductions
   including income tax and the Employee's SSNIT contribution.

5. HOURS OF WORK
   {{hours}} The Employee is entitled to a rest period in accordance with the
   Labour Act, 2003 (Act 651).

6. ANNUAL LEAVE
   The Employee is entitled to paid annual leave in accordance with the Labour
   Act, 2003, to be taken at times agreed with the Employer.

7. NOTICE OF TERMINATION
   After probation, either party may terminate this contract by giving
   {{notice}} written notice, or payment in lieu.

8. GROUNDS FOR TERMINATION
   The Employer may terminate without notice for gross misconduct, including
   theft, dishonesty, being unfit for duty through drink or drugs, or serious
   breach of the Employer's rules. Nothing in this clause removes the
   Employee's rights under the Labour Act, 2003.

9. CONFIDENTIALITY
   The Employee shall not disclose information about guests, colleagues or the
   business of the Employer, during employment or afterwards.

10. RULES AND POLICIES
    The Employee agrees to observe the Employer's rules, including those on
    attendance, uniform, health and safety.

By signing below the Employee confirms that they have read and understood this
contract, and agree to be bound by it.

Dated {{today}}.`;
