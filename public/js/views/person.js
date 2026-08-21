import { api } from '../api.js';
import { fmtDay, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { can, navigate, replaceParams } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { control, listEditor } from '../fields.js';
import { EVENTS, STATUS } from './contract.js';

/**
 * One person's file.
 *
 * Five tabs, in the order somebody actually needs them: who they are, who to
 * ring and where they came from, what has been scanned, what they have signed,
 * and the trail of everything that has happened. The trail is last because it
 * is never read until it matters, and then it is the only thing that does.
 */
const TABS = [
  ['details', 'Details'],
  ['background', 'Contacts & background'],
  ['documents', 'Documents'],
  ['contracts', 'Contracts'],
  ['history', 'Links & history'],
];

export async function renderPerson(params) {
  const host = h('div');
  const id = Number(params.id);
  if (!id) {
    mount(host, emptyState('Nobody chosen', 'Open somebody from the People list.'));
    return host;
  }

  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'details';
  const [data, model] = await Promise.all([api.hrPerson(id), api.hrModel()]);

  const reload = async (next = tab) => {
    replaceParams('person', { id, tab: next });
    mount(host, await renderPerson({ id, tab: next }));
  };

  const tabs = h('div.seg.seg-wrap', TABS.map(([key, label]) =>
    h('button', { class: tab === key ? 'active' : '', onclick: () => reload(key) }, label)));

  const body = {
    details: () => detailsTab(data, model, reload),
    background: () => backgroundTab(data, model, reload),
    documents: () => documentsTab(data, reload),
    contracts: () => contractsTab(data, model, reload),
    history: () => historyTab(data),
  }[tab]();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', data.person.name),
        h('div.sub',
          [data.person.jobTitle, data.person.department, `No. ${data.person.employeeNo}`]
            .filter(Boolean).join(' · '),
          data.person.active ? '' : ' — has left'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('people') }, '‹ Everybody'),
        h('button.btn-sm', { onclick: () => navigate('att-staff', { id }) }, 'Attendance →'),
        data.canManage
          ? h('button.btn.btn-primary', { onclick: () => sendLink(data, reload) }, 'Send them a link')
          : null,
      ),
    ),

    data.missing.length
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'This file is not complete'),
          h('div.alert-detail', `Still needed: ${data.missing.join(', ')}. `
            + 'Send them a link and they can fill it in themselves.'),
        ))
      : null,

    data.submissions.length
      ? h('div.alert.info',
        h('span.alert-icon', '📥'),
        h('div',
          h('div.alert-title', 'They have sent something in'),
          h('div.alert-detail', 'Waiting to be looked at — it is on the People screen.'),
        ),
        h('button.btn-sm', { onclick: () => navigate('people') }, 'Review'))
      : null,

    h('div.toolbar', tabs),
    body,
  );

  return host;
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function detailsTab(data, model, reload) {
  const editable = data.canManage;

  const edit = async (section) => {
    const done = await formDialog({
      title: section.label,
      submitLabel: 'Save',
      body: h('div',
        section.note ? h('p.muted', section.note) : null,
        h('div.field-row', section.fields.map((f) => h('label.field',
          h('span', f.label),
          // A masked value is never put into an editable box: saving the form
          // would then write "•••• 4321" over the account number.
          control(f, data.profile?.[`${f.key}__masked`] ? '' : data.profile?.[f.key]),
          f.hint ? h('small.muted', f.hint) : null,
        ))),
      ),
      onSubmit: async (form) => {
        const payload = {};
        for (const f of section.fields) {
          const value = form.get(f.key);
          // Left blank on a masked field means "leave it alone", not "erase
          // it" — the person editing was never shown what is there.
          if (data.profile?.[`${f.key}__masked`] && (value ?? '') === '') continue;
          payload[f.key] = value ?? '';
        }
        return api.hrSavePerson(data.person.id, payload);
      },
    });
    if (done) { toast('Saved.', 'good'); await reload(); }
  };

  return h('div.grid.grid-2',
    payCard(data, reload),
    model.sections.map((section) => card(section.label, {
      note: section.fields.some((f) => f.sensitive) ? 'Private' : null,
      actions: editable
        ? h('button.btn-sm', { onclick: () => edit(section) }, 'Edit')
        : null,
    },
      section.note ? h('p.muted', { style: { fontSize: '.82rem' } }, section.note) : null,
      h('dl.detail-list', section.fields.map((f) => {
        const value = data.profile?.[f.key];
        return h('div.detail-pair',
          h('dt', f.label),
          h('dd', value
            ? h('span', { class: data.profile?.[`${f.key}__masked`] ? 'muted mono' : '' },
              f.type === 'date' ? fmtDay(value, { withYear: true }) : String(value))
            : h('span.muted', '—')),
        );
      })),
    )),
  );
}

/**
 * What this person is paid.
 *
 * Only for somebody holding the pay permission, which nobody holds by default
 * — not even a manager, who holds employee records as a matter of course. What
 * a colleague earns is a different order of confidence from where they live.
 *
 * A rate has a date it starts, and the old ones stay. A rise in June must not
 * quietly rewrite what January cost.
 */
function payCard(data, reload) {
  if (!can('hr_pay')) return null;

  const host = h('div');

  const draw = async () => {
    let pay;
    try {
      pay = await api.hrStaffPay(data.person.id);
    } catch (err) {
      mount(host, card('Pay', { wide: true }, h('p.muted', err.message)));
      return;
    }

    const current = pay.rates.find((r) => r.from_day <= todayISO()) ?? null;

    const add = async (existing = null) => {
      const done = await formDialog({
        title: existing ? 'Correct a rate' : 'Set a rate',
        submitLabel: 'Save',
        body: h('div',
          h('p.muted', { style: { fontSize: '.85rem' } },
            existing
              ? 'Saving over the same start date corrects it. To record a rise, add a new rate '
                + 'with the day it starts and leave this one where it is.'
              : 'Give the day it starts from. Everything before that day keeps costing whatever '
                + 'the rate before it said.'),
          h('div.field-row',
            field('Paid', h('select', { name: 'basis' },
              ...[['monthly', 'Monthly salary'], ['daily', 'Daily rate'], ['hourly', 'Hourly rate']]
                .map(([v, label]) => h('option', {
                  value: v, selected: (existing?.basis ?? 'monthly') === v,
                }, label)))),
            field('Amount', h('input', {
              type: 'number', name: 'amount', min: '0', step: '0.01', required: true,
              value: existing?.amount ?? '',
            }), pay.currency),
          ),
          h('div.field-row',
            field('From', h('input', {
              type: 'date', name: 'fromDay', required: true,
              value: existing?.from_day ?? todayISO(),
            }), 'the day this rate starts'),
            field('Note', h('input', {
              type: 'text', name: 'note', maxlength: 300, value: existing?.note ?? '',
            }), 'optional — "annual review", "promoted"'),
          ),
        ),
        onSubmit: async (form) => api.hrSetStaffPay(data.person.id, {
          basis: form.get('basis'),
          amount: Number(form.get('amount')),
          fromDay: form.get('fromDay'),
          note: form.get('note') || null,
        }),
      });
      if (done) { toast('Saved.', 'good'); await draw(); }
    };

    const remove = async (rate) => {
      if (!window.confirm(`Remove the rate starting ${fmtDay(rate.from_day)}?\n\n`
        + 'Only for one entered by mistake. Everything costed at it will be worked out again '
        + 'at whatever rate came before.')) return;
      await api.hrRemoveStaffPay(data.person.id, rate.id);
      toast('Removed.');
      await draw();
    };

    const label = { monthly: 'a month', daily: 'a day', hourly: 'an hour' };

    mount(host, card('Pay', {
      note: 'Private — pay permission only',
      wide: true,
      actions: h('button.btn-sm.btn-primary', { onclick: () => add(null) }, '+ Set a rate'),
    },
      current
        ? h('p', h('strong', { style: { fontSize: '1.15rem' } },
          `${pay.currency} ${Number(current.amount).toLocaleString('en-GB')}`),
        h('span.muted', ` ${label[current.basis] ?? ''} · since ${fmtDay(current.from_day, { withYear: true })}`))
        : h('p.muted', 'No rate recorded. Until there is one, this person is left out of every '
          + 'labour-cost figure rather than counted as costing nothing.'),

      pay.rates.length > 1
        ? h('details', { style: { marginTop: '.4rem' } },
          h('summary', { style: { cursor: 'pointer', fontSize: '.85rem' } },
            `${pay.rates.length} rates on the record`),
          h('ul.signed-list', pay.rates.map((rate) => h('li',
            h('small', `${fmtDay(rate.from_day, { withYear: true })} · `,
              `${pay.currency} ${Number(rate.amount).toLocaleString('en-GB')} `,
              label[rate.basis] ?? '',
              rate.note ? ` · ${rate.note}` : '',
              rate.set_by ? h('span.muted', ` · ${rate.set_by}`) : null),
            h('div.btn-row',
              h('button.btn-sm', { onclick: () => add(rate) }, 'Correct'),
              h('button.btn-sm.btn-danger', { onclick: () => remove(rate) }, 'Remove')),
          ))))
        : null,
    ));
  };

  draw();
  return host;
}

// ---------------------------------------------------------------------------
// Contacts, education, previous jobs
// ---------------------------------------------------------------------------

function backgroundTab(data, model, reload) {
  const editList = async (list) => {
    const editor = listEditor(list, data.lists[list.key] ?? [], {
      labels: LABELS[list.key] ?? {},
    });

    const done = await formDialog({
      title: list.label,
      submitLabel: 'Save',
      body: h('div',
        list.key === 'contacts'
          ? h('p.muted', 'Put the person who actually answers their phone first. '
            + 'Kind can be “emergency” or “next of kin”.')
          : null,
        editor.element,
      ),
      onSubmit: async () => api.hrSaveList(data.person.id, list.key, editor.read()),
    });
    if (done) { toast('Saved.', 'good'); await reload(); }
  };

  return h('div',
    model.lists.map((list) => {
      const rows = data.lists[list.key] ?? [];
      return card(list.label, {
        note: `${rows.length} recorded`,
        wide: true,
        actions: data.canManage
          ? h('button.btn-sm', { onclick: () => editList(list) }, rows.length ? 'Edit' : '+ Add')
          : null,
      },
        rows.length
          ? table(list.columns.map((column) => ({
            key: column,
            label: (LABELS[list.key] ?? {})[column] ?? titleise(column),
            format: (v) => (v ? String(v) : h('span.muted', '—')),
          })), rows, { empty: 'None.' })
          : h('p.muted', { style: { marginBottom: 0 } },
            list.key === 'contacts'
              ? 'Nobody to ring. This is the one thing on this screen that is needed in a hurry.'
              : 'Nothing recorded.'),
      );
    }),
  );
}

const LABELS = {
  contacts: {
    kind: 'Kind', name: 'Name', relationship: 'Relationship', phone: 'Phone',
    alt_phone: 'Other number', email: 'Email', address: 'Address',
  },
  education: {
    level: 'Level', institution: 'Where', qualification: 'Qualification',
    field: 'Subject', finished_on: 'Finished',
  },
  employment: {
    employer: 'Employer', job_title: 'Job', from_on: 'From', to_on: 'To',
    reason_left: 'Why they left',
  },
};

const titleise = (key) => key.replace(/_on$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * What a document can be filed as.
 *
 * Taken from the file checklist rather than typed here, because the checklist
 * ticks off on an exact match. A free-text "kind" and a checklist looking for
 * `ghana_card` is a screen where nothing ever completes and nobody can see
 * why — which is worse than having no checklist at all.
 */
function kindOptions(data) {
  const required = (data.fileStatus ?? []).map((r) => ({ value: r.code, label: r.label }));
  return [...required, { value: 'other', label: 'Something else' }];
}

function documentsTab(data, reload) {
  const picker = h('input', {
    type: 'file',
    accept: 'image/*,application/pdf',
    style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      await upload(file);
    },
  });

  const upload = async (file) => {
    let prepared;
    try {
      prepared = await shrink(file);
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }

    const done = await formDialog({
      title: 'Add a document',
      submitLabel: 'Save it',
      body: h('div',
        h('p.muted', `${file.name} — ${Math.round(prepared.bytes / 1024)} KB`
          + (prepared.shrunk ? ', shrunk to fit' : '')),
        h('div.field-row',
          field('What is it', h('select', { name: 'kind' },
            kindOptions(data).map((k) => h('option', { value: k.value }, k.label))),
            'Filing it under the right kind is what ticks it off the checklist'),
          field('Call it', h('input', {
            type: 'text', name: 'title', required: true, maxlength: 120,
            value: file.name.replace(/\.[^.]+$/, ''),
          })),
        ),
        field('Expires', h('input', { type: 'date', name: 'expiresOn' }),
          'A food handler’s certificate runs out every year, and so does a permit. '
          + 'Leave blank for anything that does not.'),
      ),
      onSubmit: async (form) => api.hrAddDocument(data.person.id, {
        kind: form.get('kind'),
        title: form.get('title'),
        expiresOn: form.get('expiresOn'),
        filename: file.name,
        mime: prepared.mime,
        content: prepared.base64,
      }),
    });

    if (done) { toast('Saved.', 'good'); await reload(); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete "${row.title}"? This cannot be undone.`)) return;
    await api.hrDeleteDocument(row.id);
    toast('Deleted.');
    await reload();
  };

  /**
   * Paper this person sent in from their phone, waiting on somebody.
   *
   * Above the file rather than beside it, because until it is looked at it is
   * not part of the file — and a review that sits at the bottom of a list of
   * twenty held documents is a review nobody does.
   */
  const decide = async (doc, decision) => {
    const done = await formDialog({
      title: decision === 'accept'
        ? `Accept: ${doc.title}`
        : `Send back: ${doc.title}`,
      submitLabel: decision === 'accept' ? 'Put it on the file' : 'Send it back',
      body: h('div',
        h('p.muted', `${doc.filename || doc.title} · ${Math.round(doc.bytes / 1024)} KB, sent `
          + `${fmtDay(String(doc.uploaded_at).slice(0, 10))}`),
        h('p', h('a', { href: api.hrDocumentUrl(doc.id), target: '_blank', rel: 'noopener' },
          'Open it first ↗')),
        decision === 'accept'
          ? field('Expires', h('input', { type: 'date', name: 'expiresOn' }),
            'For a certificate that has to be renewed. Leave blank if it does not')
          : null,
        field(decision === 'accept' ? 'Note' : 'Why not', h('input', {
          type: 'text', name: 'note', maxlength: 400,
          required: decision !== 'accept',
          placeholder: decision === 'accept'
            ? 'Optional'
            : 'That is the back of the card — please send the front',
        }), decision === 'accept' ? null : 'They are told what you say, so say what to send'),
      ),
      onSubmit: async (form) => api.hrDecideDocument(doc.id, {
        decision,
        note: form.get('note') || null,
        expiresOn: form.get('expiresOn') || null,
      }),
    });
    if (done) { toast(decision === 'accept' ? 'On the file.' : 'Sent back.', 'good'); await reload(); }
  };

  const waiting = (data.waitingDocuments ?? []).length
    ? card('Sent in from their phone', {
      note: `${data.waitingDocuments.length} waiting`,
      wide: true,
    }, h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Not on the file yet. Open each one, check it is what it says it is and that it is '
        + 'this person’s, then accept it or send it back with a reason.'),
      table([
        {
          key: 'title',
          label: 'Document',
          format: (v, r) => h('div',
            data.canManage
              ? h('a', { href: api.hrDocumentUrl(r.id), target: '_blank', rel: 'noopener' },
                r.filename || v)
              : h('span', r.filename || v),
            h('small.muted', `${v} · ${Math.round(r.bytes / 1024)} KB`)),
        },
        {
          key: 'uploaded_at',
          label: 'Sent',
          format: (v) => h('small.muted', fmtDay(String(v).slice(0, 10), { withYear: true })),
        },
        {
          key: 'actions',
          label: '',
          format: (v, r) => (data.canManage
            ? h('div.btn-row',
              h('button.btn-sm.btn-primary', { onclick: () => decide(r, 'accept') }, 'Accept'),
              h('button.btn-sm', { onclick: () => decide(r, 'reject') }, 'Send back'))
            : ''),
        },
      ], data.waitingDocuments, { empty: 'None.' })))
    : null;

  const sentBack = (data.rejectedDocuments ?? []).length
    ? h('details', { style: { marginTop: '.6rem' } },
      h('summary', { style: { cursor: 'pointer', fontSize: '.85rem' } },
        `${data.rejectedDocuments.length} sent back`),
      h('ul', { style: { fontSize: '.85rem' } }, data.rejectedDocuments.map((d) => h('li',
        `${d.title} — ${d.note || 'no reason recorded'}`,
        h('br'),
        h('small.muted', `${d.decided_by || ''} · ${String(d.decided_at || '').slice(0, 10)}`)))))
    : null;

  return h('div',
    checklist(data),
    waiting,

    card('Documents', {
      note: `${data.documents.length} held`,
      wide: true,
      actions: data.canManage
        ? h('button.btn.btn-primary', { onclick: () => picker.click() }, '+ Add a document')
        : null,
    },
    picker,
    data.documents.length
      ? table([
        {
          key: 'title',
          label: 'Document',
          format: (v, r) => h('div',
            data.canManage
              ? h('a', { href: api.hrDocumentUrl(r.id), target: '_blank', rel: 'noopener' }, v)
              : h('span', v),
            h('small.muted', `${kindLabel(data, r.kind)} · ${Math.round(r.bytes / 1024)} KB`),
          ),
        },
        {
          key: 'expires_on',
          label: 'Expires',
          format: (v) => {
            if (!v) return h('span.muted', '—');
            const gone = v < new Date().toISOString().slice(0, 10);
            return h('span', { class: gone ? 'pill bad' : '' }, fmtDay(v, { withYear: true }));
          },
        },
        {
          key: 'uploaded_at',
          label: 'Added',
          format: (v, r) => h('small.muted', `${fmtDay(String(v).slice(0, 10))} · ${r.uploaded_by || '—'}`),
        },
        {
          key: 'actions',
          label: '',
          format: (v, r) => (data.canManage
            ? h('button.btn-sm', { onclick: () => remove(r) }, 'Delete')
            : ''),
        },
      ], data.documents, { empty: 'Nothing yet.' })
      : h('p.muted', { style: { marginBottom: 0 } },
        'Scans of an ID, certificates, a reference. Photographs are shrunk in the browser '
        + 'before they are sent, so a picture taken on a phone is fine, and a scanned '
        + 'contract of up to 12 MB is stored whole.'),
    sentBack,
    ),
  );
}

const kindLabel = (data, code) =>
  (data.fileStatus ?? []).find((r) => r.code === code)?.label ?? code;

const CHECK = {
  held: ['good', '✓', 'On file'],
  expiring: ['warn', '!', 'Runs out soon'],
  expired: ['bad', '×', 'Expired'],
  missing: ['bad', '·', 'Missing'],
};

/**
 * What ought to be in this person's file, and what is.
 *
 * Worked out per person rather than shown to everybody: two of the
 * requirements depend on who they are, and a checklist that demands a work
 * permit from every Ghanaian is a checklist people learn to scroll past.
 *
 * An expired certificate counts as missing, because that is what it is worth
 * to an inspector — and rather less than that to whoever eats the food.
 */
function checklist(data) {
  const rows = data.fileStatus ?? [];
  if (!rows.length) return null;

  const short = rows.filter((r) => r.state !== 'held').length;

  return card('What this file must contain', {
    note: short ? `${short} outstanding` : 'complete',
    wide: true,
  },
    h('div.checklist', rows.map((row) => {
      const [kind, mark, label] = CHECK[row.state] ?? CHECK.missing;
      return h('div.check-row',
        h('span', { class: `check-mark check-${kind}` }, mark),
        h('div',
          h('div.check-label',
            row.label,
            h('span', { class: `pill ${kind}` }, label),
            row.expiresOn ? h('small.muted', ` until ${fmtDay(row.expiresOn, { withYear: true })}`) : null,
          ),
          h('small.muted', row.detail),
        ),
        row.documentId
          ? h('a.btn-sm', {
            href: api.hrDocumentUrl(row.documentId), target: '_blank', rel: 'noopener',
          }, 'Open')
          : null,
      );
    })),

    h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
      'A document counts once it is filed under the matching kind. A signed contract, '
      + 'handbook acknowledgement, data-protection consent or next-of-kin form is ticked off '
      + 'by the signed copy itself, on paper or on screen.'),
  );
}

/**
 * A photograph, made small enough to keep.
 *
 * A phone camera produces four megabytes and a legible scan of a Ghana Card
 * needs a fraction of that. Shrinking here rather than refusing there is the
 * difference between a feature people use and one they work around by emailing
 * things to somebody.
 */
async function shrink(file) {
  const LIMIT = 1_300_000;
  const raw = new Uint8Array(await file.arrayBuffer());

  if (!file.type.startsWith('image/')) {
    if (raw.length > LIMIT) {
      throw new Error(`That PDF is ${Math.round(raw.length / 1024)} KB and the limit is `
        + `${Math.round(LIMIT / 1024)} KB. Photograph it instead — pictures are shrunk to fit.`);
    }
    return { base64: toBase64(raw), mime: file.type || 'application/pdf', bytes: raw.length, shrunk: false };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  // Down the quality ladder until it fits. Stopping at 0.5 rather than going
  // lower: below that an ID number stops being readable, and an unreadable
  // scan of an ID is worse than no scan at all because it looks like one.
  for (const quality of [0.82, 0.7, 0.6, 0.5]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    if (bytes <= LIMIT) {
      return { base64: dataUrl.split(',')[1], mime: 'image/jpeg', bytes, shrunk: scale < 1 || quality < 0.82 };
    }
  }
  throw new Error('That picture is too large even after shrinking. Try photographing it closer.');
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

function contractsTab(data, model, reload) {
  const issue = async () => {
    const { rows: templates } = await api.hrTemplates();
    const usable = templates.filter((t) => t.active);

    if (!usable.length) {
      toast('Make a template first — Templates, on the People screen.', 'bad');
      return;
    }

    const asked = h('div');
    const drawAsked = (template) => {
      const uses = (template?.uses ?? []).filter((p) => p.ask);
      mount(asked, uses.length
        ? h('div',
          h('h4', { style: { margin: '.8rem 0 .3rem', fontSize: '.9rem' } }, 'This one asks for'),
          h('div.field-row', uses.map((p) => field(p.label, h('input', {
            type: 'text', name: `v_${p.key}`, maxlength: 300, placeholder: p.fallback ?? '',
          })))),
        )
        : h('p.muted', { style: { fontSize: '.85rem' } },
          'Everything this template needs, it already knows.'));
    };
    drawAsked(usable[0]);

    const done = await formDialog({
      title: `Issue a contract to ${data.person.name}`,
      submitLabel: 'Issue it',
      body: h('div',
        h('p.muted', 'The words are copied out of the template now and fixed. Editing the '
          + 'template afterwards cannot change what this person is asked to sign.'),
        field('Template', h('select', {
          name: 'templateId',
          onchange: (e) => drawAsked(usable.find((t) => String(t.id) === e.target.value)),
        }, usable.map((t) => h('option', { value: t.id }, t.name)))),
        field('Call it', h('input', {
          type: 'text', name: 'title', maxlength: 160,
          value: usable[0].name,
        }), 'What they will see at the top'),
        asked,
        h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Nothing is sent yet. Issue it, then send them a link carrying it.'),
      ),
      onSubmit: async (form) => {
        const values = {};
        for (const [key, value] of form.entries()) {
          if (key.startsWith('v_')) values[key.slice(2)] = value;
        }
        return api.hrIssueContract(data.person.id, {
          templateId: Number(form.get('templateId')),
          title: form.get('title'),
          values,
        });
      },
    });

    if (done) { toast('Issued. Send them a link to sign it.', 'good'); await reload(); }
  };

  const scanPicker = h('input', {
    type: 'file',
    accept: 'application/pdf,image/*',
    style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) await fileOnPaper(data, file, reload);
    },
  });

  return h('div',
    card('Contracts and documents to sign', {
      note: `${data.contracts.length} on file`,
      wide: true,
      actions: data.canManage
        ? h('div.btn-row',
          h('button.btn-sm', {
            title: 'A contract they already signed on paper — scan or photograph it',
            onclick: () => scanPicker.click(),
          }, 'File a signed paper contract'),
          h('button.btn.btn-primary', { onclick: issue }, '+ Issue a contract'),
        )
        : null,
    },
      scanPicker,
      data.contracts.length
        ? table([
          {
            key: 'title',
            label: 'Document',
            format: (v, r) => h('div',
              h('button.link-button', {
                onclick: () => navigate('contract', { id: r.id }),
              }, v),
              h('small.muted.mono', String(r.body_hash).slice(0, 12)),
            ),
          },
          {
            key: 'status',
            label: 'Where it is up to',
            format: (v, r) => {
              const [kind, label] = STATUS[v] ?? ['', v];
              return h('div',
                h(`span.pill${kind ? `.${kind}` : ''}`, label),
                // Which sort of signature is behind it. The two are not the
                // same kind of evidence and the screen should never imply
                // they are.
                h('small.muted', r.origin === 'paper' ? 'signed on paper' : 'signed on screen'),
              );
            },
          },
          {
            key: 'signed_at',
            label: 'Signed',
            format: (v, r) => (v
              ? h('div', h('div', fmtDay(String(v).slice(0, 10), { withYear: true })),
                h('small.muted', r.signer_name || ''))
              : h('span.muted', '—')),
          },
          {
            key: 'employer_at',
            label: 'Countersigned',
            format: (v, r) => (v
              ? h('div', h('div', fmtDay(String(v).slice(0, 10))), h('small.muted', r.employer_name || ''))
              : h('span.muted', '—')),
          },
        ], data.contracts, { empty: 'None issued.' })
        : h('p.muted', { style: { marginBottom: 0 } },
          'Section 12 of the Labour Act asks for a written contract where somebody is employed '
          + 'for six months or more. Issue one from a template and they sign it on their phone — '
          + 'or, for somebody who signed on paper years ago, scan what they signed and file it '
          + 'here so it counts.'),
    ),
  );
}

/**
 * Put a contract that was signed on paper where a contract belongs.
 *
 * For everybody already on the books this is the only record of what was
 * agreed, and until now the only place for it was the general documents pile,
 * where it sat beside a photocopied ID with nothing saying it was a contract.
 *
 * The dialog asks for the date it was signed rather than assuming today,
 * because the date on the paper is the fact that matters and the date somebody
 * got round to scanning it is not.
 */
async function fileOnPaper(data, file, reload) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 12_000_000) {
    toast(`That file is ${Math.round(bytes.length / 1_000_000)} MB. Scan it again at 200 dpi in `
      + 'black and white — the limit is 12 MB.', 'bad');
    return;
  }

  const kinds = kindOptions(data).filter((k) => FILEABLE.has(k.value));

  const done = await formDialog({
    title: 'File a contract signed on paper',
    submitLabel: 'File it',
    body: h('div',
      h('p.muted', `${file.name} — ${Math.round(bytes.length / 1024)} KB. `
        + 'It goes in as a signed contract, not as a loose document, so it appears in the list '
        + 'above and counts towards the file checklist.'),

      h('div.field-row',
        field('What is it', h('select', { name: 'satisfies' },
          kinds.map((k) => h('option', { value: k.value }, k.label)))),
        field('Call it', h('input', {
          type: 'text', name: 'title', required: true, maxlength: 160,
          value: file.name.replace(/\.[^.]+$/, '') || 'Contract of employment',
        })),
      ),

      h('div.field-row',
        field('Date it was signed', h('input', {
          type: 'date', name: 'signedOn', required: true,
          max: new Date().toISOString().slice(0, 10),
          value: data.person.hiredOn || '',
        }), 'The date on the paper, not today'),
        field('Signed by', h('input', {
          type: 'text', name: 'signerName', maxlength: 120, value: data.person.name,
        })),
        field('For the property', h('input', {
          type: 'text', name: 'employerName', maxlength: 120,
          placeholder: 'Who countersigned it',
        })),
      ),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'A fingerprint of the scan is kept, so a file swapped later can be told from the one '
        + 'that was filed. There is no electronic signature behind a paper contract and the '
        + 'certificate says so plainly.'),
    ),
    onSubmit: async (form) => api.hrFileContract(data.person.id, {
      title: form.get('title'),
      satisfies: form.get('satisfies'),
      signedOn: form.get('signedOn'),
      signerName: form.get('signerName'),
      employerName: form.get('employerName'),
      filename: file.name,
      mime: file.type || 'application/pdf',
      content: toBase64(bytes),
    }),
  });

  if (done) { toast('Filed.', 'good'); await reload(); }
}

/** The requirements a signed piece of paper can answer. */
const FILEABLE = new Set(['contract', 'handbook', 'data_consent', 'next_of_kin', 'other']);

// ---------------------------------------------------------------------------
// Links and history
// ---------------------------------------------------------------------------

function historyTab(data) {
  return h('div',
    card('Links sent to them', { note: `${data.invites.length} shown`, wide: true },
      data.invites.length
        ? table([
          {
            key: 'createdAt',
            label: 'Made',
            format: (v, r) => h('div',
              h('div', fmtDay(String(v).slice(0, 10), { withYear: true })),
              h('small.muted', r.createdBy || '')),
          },
          {
            key: 'wantsDetails',
            label: 'Asked for',
            format: (v) => (v ? 'Their details' : 'Signing only'),
          },
          {
            key: 'hasPin',
            label: 'Code',
            format: (v) => (v ? h('span.pill', '4 digits') : h('span.muted', 'none')),
          },
          {
            key: 'expiresAt',
            label: 'Where it is up to',
            format: (v, r) => {
              if (r.revokedAt) return h('span.pill.bad', 'Cancelled');
              if (r.finishedAt) return h('span.pill.good', 'Finished');
              if (String(v) < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
                return h('span.pill', 'Expired');
              }
              return h('div',
                h('span.pill.warn', r.openedAt ? 'Opened' : 'Not opened yet'),
                h('small.muted', `until ${fmtDay(String(v).slice(0, 10))}`));
            },
          },
          {
            key: 'actions',
            label: '',
            format: (v, r) => (data.canManage && !r.revokedAt && !r.finishedAt
              ? h('button.btn-sm', {
                onclick: async () => {
                  if (!window.confirm('Cancel this link? It stops working immediately.')) return;
                  await api.hrRevokeInvite(r.id);
                  toast('Cancelled.');
                  location.reload();
                },
              }, 'Cancel')
              : ''),
          },
        ], data.invites, { empty: 'None yet.' })
        : h('p.muted', { style: { marginBottom: 0 } },
          'No link has been sent to this person. A link is how they fill in their own details '
          + 'and sign what needs signing, without an account.'),
    ),

    card('Everything that has happened', { note: 'Newest first', wide: true },
      table([
        { key: 'at_utc', label: 'When (UTC)', format: (v) => h('small.mono', v) },
        { key: 'kind', label: 'What', format: (v) => EVENTS[v] ?? v },
        { key: 'detail', label: 'Detail', format: (v) => h('small', v || '') },
        { key: 'ip', label: 'From', format: (v) => h('small.mono', v || '—') },
      ], data.events, { empty: 'Nothing yet.' })),
  );
}

// ---------------------------------------------------------------------------
// Sending somebody a link
// ---------------------------------------------------------------------------

/**
 * One link, carrying whatever this person still owes.
 *
 * Deliberately one and not two. A new starter who gets a message asking for
 * their details and a second message asking them to sign a contract does one
 * of the two; a single link with a list on it gets both, which is what every
 * onboarding product worth copying works out eventually.
 */
async function sendLink(data, reload) {
  const open = data.contracts.filter((c) => ['draft', 'sent', 'opened'].includes(c.status));
  const chosen = new Set(open.map((c) => c.id));

  const result = await formDialog({
    title: `Send ${data.person.name} a link`,
    submitLabel: 'Make the link',
    body: h('div',
      h('p.muted', 'They open it on their phone. No account, no password — the link is the key, '
        + 'so send it to them and nobody else.'),

      h('label.field',
        h('span', 'Ask for their details'),
        h('select', { name: 'wantsDetails' },
          h('option', { value: 'yes', selected: data.missing.length > 0 }, 'Yes — the whole form'),
          h('option', { value: 'no', selected: data.missing.length === 0 }, 'No — signing only'),
        ),
        h('small.muted', data.missing.length
          ? `Still needed: ${data.missing.join(', ')}`
          : 'Their file already has everything asked for'),
      ),

      open.length
        ? h('div.field',
          h('span', 'Documents to sign'),
          h('div', open.map((c) => h('label.tickline',
            h('input', {
              type: 'checkbox',
              checked: true,
              onchange: (e) => (e.target.checked ? chosen.add(c.id) : chosen.delete(c.id)),
            }),
            h('span', c.title),
          ))),
        )
        : h('p.muted', { style: { fontSize: '.85rem' } },
          'No contract is waiting to be signed. Issue one first if you want the link to carry it.'),

      h('div.field-row',
        field('Lasts for', h('select', { name: 'days' },
          [7, 14, 21, 30, 60].map((n) => h('option', { value: n, selected: n === 21 }, `${n} days`)))),
        field('Code to open it', h('input', {
          type: 'text', name: 'pin', inputmode: 'numeric', maxlength: 4, placeholder: 'optional',
        }), 'Four digits, told to them out loud. Worth it for a contract'),
      ),

      field('A line to them', h('input', {
        type: 'text', name: 'message', maxlength: 400,
        placeholder: 'Please do this before Friday',
      })),
    ),
    onSubmit: async (form) => api.hrCreateInvite(data.person.id, {
      wantsDetails: form.get('wantsDetails') === 'yes',
      contractIds: [...chosen],
      days: Number(form.get('days')),
      pin: form.get('pin'),
      message: form.get('message'),
    }),
  });

  if (!result) return;
  await showLink(result);
  await reload();
}

/**
 * The link, once, with a button that copies it.
 *
 * Never shown again: the database holds only a hash of it, which is what makes
 * a stolen copy of the database useless. Losing one costs ten seconds.
 */
async function showLink(result) {
  await formDialog({
    title: 'The link — copy it now',
    submitLabel: 'Done',
    body: h('div',
      h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'This is the only time you will see it'),
          h('div.alert-detail', 'Only a fingerprint of it is stored, so it cannot be shown '
            + 'again. If you lose it, make another — it takes seconds.'),
        )),

      h('textarea.link-box', { rows: 4, readonly: true, onclick: (e) => e.target.select() },
        result.message),

      h('div.btn-row',
        h('button.btn.btn-primary', {
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(result.message);
              e.target.textContent = 'Copied ✓';
            } catch {
              toast('Select the text above and copy it.', 'bad');
            }
          },
        }, 'Copy the message'),
        h('a.btn-sm', {
          href: `https://wa.me/?text=${encodeURIComponent(result.message)}`,
          target: '_blank', rel: 'noopener',
        }, 'Send on WhatsApp'),
      ),

      result.pin
        ? h('p', h('strong', 'Tell them the code: '), h('span.mono.pin-show', result.pin),
          h('br'), h('small.muted', 'Say it out loud or on a call. Do not put it in the same message as the link.'))
        : null,

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        `It stops working in ${result.expiresInDays} days.`),
    ),
    onSubmit: async () => ({ ok: true }),
  });
}
