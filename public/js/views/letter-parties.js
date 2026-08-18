import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import { navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';

/**
 * Who letters go to.
 *
 * Not the staff list. Most correspondence leaves the building — a supplier, a
 * bank, the Labour Department, a guest, a lawyer — and typing the same address
 * every time is how three spellings of the same company end up in a register
 * that is supposed to let you find every letter you ever sent them.
 */
const KINDS = [
  ['supplier', 'Supplier'],
  ['authority', 'Government or authority'],
  ['bank', 'Bank'],
  ['guest', 'Guest'],
  ['staff', 'Member of staff'],
  ['other', 'Somebody else'],
];

export async function renderLetterParties() {
  const host = h('div');
  const { rows } = await api.corrParties();
  const reload = async () => mount(host, await renderLetterParties());

  const edit = async (existing) => {
    const done = await formDialog({
      title: existing ? `Edit ${existing.name}` : 'Add to the address book',
      submitLabel: existing ? 'Save' : 'Add them',
      body: h('div',
        h('div.field-row',
          field('Name', h('input', {
            type: 'text', name: 'name', required: true, maxlength: 160,
            value: existing?.name ?? '',
          }), 'A person where you write to a person, the body where you do not'),
          field('Kind', h('select', { name: 'kind' },
            KINDS.map(([value, label]) => h('option', {
              value, selected: existing?.kind === value,
            }, label)))),
        ),
        h('div.field-row',
          field('Organisation', h('input', {
            type: 'text', name: 'organisation', maxlength: 160, value: existing?.organisation ?? '',
          })),
          field('Their job title', h('input', {
            type: 'text', name: 'jobTitle', maxlength: 120, value: existing?.job_title ?? '',
          })),
        ),
        h('div.field-row',
          field('Email', h('input', {
            type: 'email', name: 'email', maxlength: 200, value: existing?.email ?? '',
          }), 'A one-time code can be sent here when they sign'),
          field('Phone', h('input', {
            type: 'tel', name: 'phone', maxlength: 40, value: existing?.phone ?? '',
          })),
        ),
        field('Address', h('textarea', { name: 'address', rows: 3, maxlength: 400 },
          existing?.address ?? '')),
        field('Note', h('input', {
          type: 'text', name: 'note', maxlength: 300, value: existing?.note ?? '',
        })),
        existing
          ? field('Status', h('select', { name: 'active' },
            h('option', { value: 'true', selected: !!existing.active }, 'In use'),
            h('option', { value: 'false', selected: !existing.active }, 'Retired')))
          : null,
      ),
      onSubmit: async (form) => {
        const payload = Object.fromEntries(form.entries());
        payload.active = form.get('active') !== 'false';
        return existing ? api.corrUpdateParty(existing.id, payload) : api.corrCreateParty(payload);
      },
    });
    if (done) { toast('Saved.', 'good'); await reload(); }
  };

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Address book'),
        h('div.sub', 'Who the property writes to'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('letters') }, '‹ Letters'),
        h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add somebody'),
      ),
    ),

    card('Everybody', { note: `${rows.length} held`, wide: true },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('div', h('div', v),
            r.job_title ? h('small.muted', r.job_title) : null),
        },
        { key: 'organisation', label: 'Organisation', format: (v) => v || h('span.muted', '—') },
        {
          key: 'email',
          label: 'How to reach them',
          format: (v, r) => h('div',
            v ? h('small', v) : null,
            r.phone ? h('small.muted', r.phone) : null,
            !v && !r.phone ? h('span.muted', '—') : null),
        },
        { key: 'letters', label: 'Letters', align: 'right', format: (v) => (v || h('span.muted', '0')) },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
        },
      ], rows, {
        rowClass: (r) => (r.active ? '' : 'row-muted'),
        groupBy: (r) => (KINDS.find(([k]) => k === r.kind)?.[1] ?? 'Somebody else'),
        groupNoun: ['entry', 'entries'],
        empty: 'Nobody yet. You can also write to somebody without adding them here.',
      })),
  );

  return host;
}
