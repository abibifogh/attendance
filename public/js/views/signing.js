import { api } from '../api.js';
import { h, mount } from '../util.js';
import { navigate } from '../app.js';
import { emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { asBase64 } from './letters.js';

/**
 * Everything sent to be signed: contracts and letters together, the way
 * somebody chasing signatures thinks about them. Each row has a segment per
 * signer, filled once they have signed, and says plainly when it is your turn.
 */
const TABS = [
  ['waitingOnUs', 'Waiting for us'],
  ['withOthers', 'Waiting for others'],
  ['completed', 'Completed'],
  ['stopped', 'Declined, withdrawn or expired'],
  ['drafts', 'Drafts'],
];
const KINDS = [['all', 'All'], ['contract', 'Contracts'], ['letter', 'Letters']];

const day = (at) => {
  if (!at) return '';
  const d = new Date(`${String(at).replace(' ', 'T').slice(0, 19)}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

function metaOf(r, tab) {
  return [
    r.who,
    r.reference,
    tab === 'drafts' ? (r.preparedBy ? `prepared by ${r.preparedBy}` : null)
      : tab === 'completed' ? `completed ${day(r.since)}`
        : r.sentAt ? `sent ${day(r.sentAt)}` : null,
    tab === 'withOthers' && r.waitingOn ? `with ${r.waitingOn}` : null,
    r.remindedAt && tab === 'withOthers' ? `reminded ${day(r.remindedAt)}` : null,
    r.meta || null,
    r.note ? `${r.waitingOn ? `${r.waitingOn}: ` : ''}“${r.note}”` : null,
  ].filter(Boolean).join(' · ');
}

export async function renderSigning(params = {}) {
  const host = h('div');
  const data = await api.signing();
  let tab = TABS.some(([k]) => k === params.tab) ? params.tab : (data.waitingOnUs.length ? 'waitingOnUs' : 'withOthers');
  let kind = 'all';
  let search = '';

  const list = h('div');
  const paintList = () => {
    const q = search.trim().toLowerCase();
    const rows = (data[tab] ?? []).filter((r) => (kind === 'all' || r.kind === kind)
      && (!q || [r.title, r.reference, r.who].some((v) => String(v ?? '').toLowerCase().includes(q))));
    mount(list, rows.length
      ? h('div.sg-list', rows.map((r) => {
        const done = (r.segments ?? []).filter(Boolean).length;
        return h('a.sg-row', { href: r.link },
          h('div.sg-main',
            h('div.sg-title', h('span.sg-kind', r.kind === 'contract' ? 'Contract' : 'Letter'), h('strong', r.title)),
            h('div.sg-meta', metaOf(r, tab))),
          h('div.sg-side',
            r.segments?.length
              ? h('span.sg-progress', { 'aria-label': `${done} of ${r.segments.length} signed` },
                h('span.sg-segs', { 'aria-hidden': 'true' }, r.segments.map((s) => h(`span.sg-seg${s ? '.on' : ''}`))),
                h('span.sg-count', `${done}/${r.segments.length}`))
              : null,
            h(`span.pill${r.tone ? `.${r.tone}` : ''}`, r.status)));
      }))
      : h('div.card', emptyState('Nothing here', tab === 'waitingOnUs'
        ? 'Nothing is waiting for you to sign or send.'
        : 'Documents appear here as they move along.')));
  };

  const paint = () => {
    mount(host,
      h('div.page-head',
        h('div', h('h1', 'Signatures'),
          h('div.sub', 'Contracts and letters sent to be signed. Each one shows who has signed and whose turn it is.')),
        data.canWrite ? h('div.btn-row', h('button.btn.btn-primary', { type: 'button', onclick: () => newDocument() }, 'New document to sign')) : null),
      h('div.sg-tabs', { role: 'tablist' }, TABS.map(([k, label]) => h('button.sg-tab', {
        type: 'button', role: 'tab', 'aria-selected': String(k === tab), class: k === tab ? 'on' : '',
        onclick: () => { tab = k; paint(); },
      }, label, h('small', String((data[k] ?? []).length))))),
      h('div.sg-tools',
        h('div.seg', { role: 'group', 'aria-label': 'Show' }, KINDS.map(([k, label]) => h('button', {
          type: 'button', class: k === kind ? 'active' : '', 'aria-pressed': String(k === kind),
          onclick: () => { kind = k; paint(); },
        }, label))),
        h('input.sg-search', {
          type: 'search', placeholder: 'Title, reference or name…', 'aria-label': 'Search', value: search,
          oninput: (event) => { search = event.target.value; paintList(); },
        })),
      list);
    paintList();
  };
  paint();
  return host;
}

/**
 * Start a document: a name, and a PDF or a template to make one from. The
 * PDF is read in the browser for [sign:1] markers on the way in.
 */
async function newDocument() {
  const people = await api.docPeople().catch(() => ({ templates: [] }));
  const file = h('input', { type: 'file', name: 'file', accept: 'application/pdf' });
  const template = h('select', { name: 'templateId' },
    h('option', { value: '' }, 'A PDF I will upload'),
    people.templates?.length
      ? h('optgroup', { label: 'Or make one from a template' }, people.templates.map((t) => h('option', { value: t.id }, t.name)))
      : null);
  const pick = h('div', field('The PDF', file, 'A Word document saved as PDF works best.'));
  template.addEventListener('change', () => { pick.hidden = Boolean(template.value); });

  const made = await formDialog({
    title: 'New document to sign',
    submitLabel: 'Start',
    body: h('div',
      field('Name', h('input', {
        type: 'text', name: 'title', required: true, maxlength: 200,
        placeholder: 'Supplier agreement: laundry services',
      }), 'What signers see in the email and on the certificate. You can change it later.'),
      field('The document', template),
      pick),
    onSubmit: async (form) => {
      const title = String(form.get('title') ?? '').trim();
      if (template.value) return api.docCreate({ title, templateId: Number(template.value) });
      const chosen = file.files?.[0];
      if (!chosen) throw new Error('Choose the PDF, or a template to make one from.');
      if (chosen.type && chosen.type !== 'application/pdf') throw new Error('That is not a PDF. Save it as a PDF first.');
      const { findMarkers } = await import('../pdf-markers.js');
      const fields = await findMarkers(chosen).catch(() => []);
      return api.docCreate({
        title, content: await asBase64(chosen), filename: chosen.name, mime: 'application/pdf',
        fields: fields.map((f) => ({ ...f, signer: Number(f.signer) })),
      });
    },
  });
  if (made?.id) navigate('sign-doc', { id: made.id });
}
