import { api } from '../api.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, emptyState, table } from './components.js';
import { navigate, replaceParams } from '../app.js';
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

const KINDS = ['ID document', 'Certificate', 'Reference', 'Photograph', 'Medical', 'Other'];

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
            KINDS.map((k) => h('option', { value: k }, k)))),
          field('Call it', h('input', {
            type: 'text', name: 'title', required: true, maxlength: 120,
            value: file.name.replace(/\.[^.]+$/, ''),
          })),
        ),
        field('Expires', h('input', { type: 'date', name: 'expiresOn' }),
          'For an ID or a permit that runs out. Leave blank if it does not.'),
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

  return card('Documents', {
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
            h('small.muted', `${r.kind} · ${Math.round(r.bytes / 1024)} KB`),
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
        + 'before they are sent, so a picture taken on a phone is fine.'),
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

  return h('div',
    card('Contracts and documents to sign', {
      note: `${data.contracts.length} issued`,
      wide: true,
      actions: data.canManage
        ? h('button.btn.btn-primary', { onclick: issue }, '+ Issue a contract')
        : null,
    },
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
            format: (v) => {
              const [kind, label] = STATUS[v] ?? ['', v];
              return h(`span.pill${kind ? `.${kind}` : ''}`, label);
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
          'Ghana’s Labour Act asks for a written contract where somebody is employed for six '
          + 'months or more. Issue one from a template, send them the link, and they sign it '
          + 'on their phone.'),
    ),
  );
}

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
