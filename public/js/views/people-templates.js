import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import { field, formDialog } from './att-shared.js';
import { signaturePad } from '../fields.js';
import { contractFlow } from '../contract-flow.js';
import { contractCover, coverMasthead } from './contract-cover.js';

/**
 * What each kind is for, in the words the screen uses.
 *
 * The kind is not decoration: the Letters screen offers correspondence and
 * nothing else, and a contract offered there would come out with unfilled
 * placeholders down the middle of it.
 */
const KINDS = [
  ['contract', 'Contract'],
  ['letter', 'HR letter, issued to one person'],
  ['policy', 'Policy to acknowledge'],
  ['correspondence', 'Letter template, for the Letters screen'],
];

const KIND_LABEL = Object.fromEntries(KINDS);

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
  const { rows, placeholders, missing = [], companies = [] } = await api.hrTemplates();
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
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
            KINDS.map(([k, label]) => h('option', {
              value: k, selected: (existing?.kind ?? 'contract') === k,
            }, label))),
          'A letter template is the only kind the Letters screen offers'),
        ),
        companies.length > 1
          ? field('For', h('select', { name: 'companyId' },
            h('option', { value: '', selected: !existing?.company_id }, 'Every company'),
            companies.map((c) => h('option', { value: c.id, selected: existing?.company_id === c.id }, `${c.name} only`))),
          'One company’s template is only offered for the people it employs, and names it as the employer')
          : null,

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

        h('div.tpl-words-head',
          h('button.btn-sm', {
            type: 'button',
            onclick: (e) => {
              const form = e.target.closest('form');
              previewTemplate({
                name: form.querySelector('[name="name"]').value,
                kind: form.querySelector('[name="kind"]').value,
                body: form.querySelector('[name="body"]').value,
                companyId: form.querySelector('[name="companyId"]')?.value || null,
              });
            },
          }, 'Preview as staff see it')),
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
          ...(companies.length > 1 ? { companyId: form.get('companyId') || null } : {}),
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
        h('button.btn-sm', {
          onclick: loadStandard,
          class: missing.length ? 'btn-sm btn-primary' : 'btn-sm',
        }, missing.length
          ? `Load the standard set (${missing.length} new)`
          : 'Load the standard set'),
        h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ New template'),
      ),
    ),

    // A standard template written since this property last loaded the set is
    // invisible otherwise: the button reads like something already done, and
    // the new contract is simply not in the list.
    missing.length && rows.length
      ? h('div.alert.info',
        h('span.alert-icon', '\u2139\ufe0f'),
        h('div',
          h('div.alert-title', missing.length === 1
            ? 'One standard template is not here yet'
            : `${missing.length} standard templates are not here yet`),
          h('div.alert-detail', `${missing.map((t) => t.name).join(', ')}. `
            + 'Loading the set adds only these. Anything you have edited is left alone.'),
          h('button.btn.btn-sm.btn-primary', {
            style: { marginTop: '.6rem' }, onclick: loadStandard,
          }, 'Add them')))
      : null,

    rows.length ? null : starterCard(loadStandard),

    card('Templates', { note: `${rows.length} held`, wide: true },
      table([
        {
          key: 'name',
          label: 'Name',
          // The kind is the band heading, so it is not repeated on the row.
          // Retired is not a kind and does need saying.
          format: (v, r) => h('div', h('div', v),
            companies.length > 1
              ? h('small.muted', r.company_id ? `${companyName.get(r.company_id) ?? 'One company'} only` : 'Every company')
              : null,
            r.active ? null : h('small.muted', { style: { display: 'block' } }, 'Retired')),
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
            h('button.btn-sm', { onclick: () => previewTemplate({ templateId: r.id, name: r.name, kind: r.kind, companyId: r.company_id }) }, 'Preview'),
            h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
            h('button.btn-sm', { onclick: () => remove(r) }, 'Delete'),
          ),
        },
      ], rows, {
        groupBy: (r) => KIND_LABEL[r.kind] ?? 'Other',
        groupNoun: ['template', 'templates'],
        groupOrder: KINDS.map(([, label]) => label),
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

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * A template as the person it is sent to will see it.
 *
 * Built from the same pieces as the page a member of staff opens from their
 * link (the property's name at the top, the title, the words, and the box to
 * sign at the foot), inside a frame the width of a phone or of a computer.
 * Filled in for a sample person, or for somebody real chosen from the list,
 * with what is typed in at issue left as a marked gap. Nothing is sent and
 * nothing is stored; the sign box does nothing.
 *
 * A letter template is printed on the letterhead from the Letters screen
 * rather than signed on a phone, and the preview says so.
 */
let staffList = null;

async function previewTemplate({ templateId = null, name = '', kind = 'contract', body = null, companyId = null }) {
  const frame = h('div.tpl-frame.is-phone');
  const who = h('select', { 'aria-label': 'Show it for' }, h('option', { value: '' }, 'A sample person'));
  // Phone and computer show the page they sign on; Cover page shows the
  // first sheet of the signed PDF and of a printed copy.
  let view = 'phone';
  let last = null;
  const show = () => {
    frame.classList.toggle('is-phone', view === 'phone');
    frame.classList.toggle('is-cover', view === 'cover');
    if (!last) return;
    mount(frame, view === 'cover'
      ? h('div.tpl-cover', contractCover(last.cover, { screen: true }))
      : staffView(last, kind));
  };
  const width = h('div.seg', { role: 'group', 'aria-label': 'Show' },
    [['phone', 'Phone'], ['computer', 'Computer'], ['cover', 'Cover page']].map(([key, label]) => h(`button${key === view ? '.active' : ''}`, {
      type: 'button',
      onclick: (e) => {
        view = key;
        for (const b of width.children) b.classList.toggle('active', b === e.target);
        show();
      },
    }, label)));

  const draw = async () => {
    mount(frame, h('p.muted', { style: { padding: '1rem' } }, 'Filling it in…'));
    try {
      last = await api.hrPreviewTemplate({
        templateId, name, body, kind, companyId, staffId: who.value || null,
      });
      show();
    } catch (err) {
      mount(frame, h('p.form-error', { style: { padding: '1rem' } }, err.message));
    }
  };
  who.addEventListener('change', draw);

  if (!staffList) {
    staffList = await api.hrPeople().then((d) => (d.rows ?? []).filter((r) => r.active)).catch(() => []);
  }
  // Only the people this template could go to.
  for (const p of staffList) {
    if (companyId && Number(companyId) !== p.companyId) continue;
    who.append(h('option', { value: p.id }, p.name));
  }

  const shown = formDialog({
    title: `Preview: ${name || 'Untitled'}`,
    submitLabel: 'Close',
    wide: true,
    body: h('div.tpl-preview',
      h('div.tpl-preview-bar',
        h('label.tpl-preview-who', h('span', 'Show it for'), who),
        width),
      h('p.muted', { style: { fontSize: '.82rem', margin: 0 } },
        kind === 'correspondence'
          ? 'A letter template is printed on your letterhead from the Letters screen. This shows its words filled in.'
          : 'What they see when they open the link they are sent. Anything typed in when it is issued shows in square brackets.'),
      frame),
    onSubmit: async () => true,
  });
  await draw();
  return shown;
}

/** The page from the staff link, drawn with the same classes, doing nothing. */
function staffView(out, kind) {
  const pad = signaturePad({ height: 120 });
  const inert = { type: 'button', tabindex: -1, onclick: (e) => { e.preventDefault(); toast('This is only a preview.'); } };
  return h('main.invite',
    h('div.invite-inner',
      h('header.invite-head', h('div.invite-brand', out.property || 'Staff')),
      h('button.btn-sm.invite-back', inert, '‹ Back'),
      kind === 'correspondence' ? null : coverMasthead(out.cover),
      h('div.card',
        h('h2', out.title),
        h('p.muted', kind === 'correspondence' ? 'A letter.' : 'Read all of it. Scroll to the bottom to sign.')),
      h('div.card', contractFlow(h, out.body)),
      kind === 'correspondence' ? null : h('div.card',
        h('h3', 'Sign here'),
        h('label.tickline',
          h('input', { type: 'checkbox', tabindex: -1 }),
          h('span', 'I have read this document and I agree to sign it electronically. '
            + 'I understand this has the same effect as signing on paper.')),
        h('p.muted', 'Before you sign, we send a six-digit code to their email or phone to check it is them.'),
        pad.element,
        h('label.field', h('span', 'Or type your full name'),
          h('input', { type: 'text', tabindex: -1, placeholder: out.person?.name ?? 'Ama Sample' })),
        h('button.btn.btn-primary.btn-wide', inert, 'Sign this'),
        h('button.btn-sm.btn-wide', { ...inert, style: { marginTop: '.6rem' } }, 'I do not want to sign this'),
        h('p.fineprint', 'When you sign, the time, your network address and a fingerprint of these exact words '
          + 'are recorded, so both you and the property can show later what was agreed.'))));
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
