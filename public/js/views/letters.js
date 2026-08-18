import { api } from '../api.js';
import { fmtDay, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { navigate, replaceParams } from '../app.js';
import { field, formDialog } from './att-shared.js';

/**
 * The letter register.
 *
 * A hotel writes to suppliers, banks, the Labour Department and guests, and in
 * most small properties those letters live in a Word folder and a sent-items
 * box. Six months later nobody can say what was sent, when, who signed it, or
 * whether the reply ever came.
 *
 * This screen answers those four, and it puts the fourth first: a reply that
 * is overdue is the one thing a register catches that a folder never will.
 */
const PILL = { green: 'good', amber: 'warn', red: 'bad', grey: '' };

export async function renderLetters(params) {
  const host = h('div');
  const status = params.status || '';
  const query = params.q || '';

  const data = await api.corrLetters({
    ...(status ? { status } : {}),
    ...(query ? { q: query } : {}),
  });

  const reload = async (next = {}) => {
    const merged = { status, q: query, ...next };
    replaceParams('letters', merged);
    mount(host, await renderLetters(merged));
  };

  const today = todayISO();
  const overdue = data.rows.filter((l) => l.response_due && l.response_due < today
    && !['closed', 'void'].includes(l.status));
  const waiting = data.rows.filter((l) => l.status === 'awaiting_signature');
  const unsent = data.rows.filter((l) => l.status === 'signed');

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Letters'),
        h('div.sub', 'What has gone out, who signed it, and what came back'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('letter-parties') }, 'Address book'),
        h('button.btn-sm', { onclick: () => navigate('letter-signing') }, 'Signature & stamp'),
        data.canWrite
          ? h('button.btn.btn-primary', { onclick: () => compose(data, reload) }, '+ New letter')
          : null,
      ),
    ),

    h('div.grid.grid-4',
      tile('Waiting to be answered', overdue.length, overdue.length ? 'past the date' : 'nothing overdue',
        overdue.length ? 'var(--bad)' : 'var(--good)', () => reload({ status: '' })),
      tile('Out for signature', waiting.length, 'with somebody now',
        waiting.length ? 'var(--warn)' : null, () => reload({ status: 'awaiting_signature' })),
      tile('Signed, not sent', unsent.length, unsent.length ? 'ready to go' : 'none',
        unsent.length ? 'var(--accent)' : null, () => reload({ status: 'signed' })),
      tile('In the register', data.rows.length, 'letters', null, () => reload({ status: '' })),
    ),

    overdue.length
      ? card('Past the date they were due to reply', { wide: true },
        overdue.map((l) => h('div.alert.high',
          h('span.alert-icon', '⛔'),
          h('div', { style: { flex: 1 } },
            h('div.alert-title', `${l.reference} — ${l.subject}`),
            h('div.alert-detail', `${l.addressed_to || 'Unaddressed'} · reply was due `
              + fmtDay(l.response_due, { withYear: true })),
          ),
          h('button.btn-sm', { onclick: () => navigate('letter', { id: l.id }) }, 'Open')),
        ))
      : null,

    h('div.toolbar',
      h('input', {
        type: 'search', placeholder: 'Reference, subject or who it went to…',
        value: query, style: { minWidth: '16rem' },
        onchange: (e) => reload({ q: e.target.value }),
      }),
      h('select', {
        onchange: (e) => reload({ status: e.target.value }),
      },
      h('option', { value: '', selected: !status }, 'Every state'),
      Object.entries(data.statuses).map(([key, s]) =>
        h('option', { value: key, selected: status === key }, s.label))),
      h('div', { style: { flex: 1 } }),
    ),

    data.rows.length
      ? card('The register', { note: `${data.rows.length} shown`, wide: true },
        table([
          {
            key: 'reference',
            label: 'Reference',
            format: (v, r) => h('div',
              h('button.link-button', { onclick: () => navigate('letter', { id: r.id }) },
                h('span.mono', v)),
              h('small.muted', fmtDay(String(r.created_at).slice(0, 10), { withYear: true })),
            ),
          },
          {
            key: 'subject',
            label: 'Subject',
            format: (v, r) => h('div',
              h('div', v),
              h('small.muted', r.direction === 'incoming' ? '← received' : '→ outgoing'),
            ),
          },
          {
            key: 'addressed_to',
            label: 'To / from',
            format: (v, r) => h('div',
              h('div', v || h('span.muted', '—')),
              r.organisation ? h('small.muted', r.organisation) : null,
            ),
          },
          {
            key: 'status',
            label: 'Where it is',
            format: (v, r) => {
              const s = data.statuses[v] ?? { label: v, colour: 'grey' };
              const kind = PILL[s.colour] ?? '';
              return h('div',
                h(`span.pill${kind ? `.${kind}` : ''}`, s.label),
                r.signers
                  ? h('small.muted', `${r.signed} of ${r.signers} signed`)
                  : null,
              );
            },
          },
          {
            key: 'response_due',
            label: 'Reply due',
            format: (v, r) => {
              if (!v) return h('span.muted', '—');
              const late = v < today && !['closed', 'void'].includes(r.status);
              return h('span', { class: late ? 'pill bad' : '' }, fmtDay(v));
            },
          },
        ], data.rows, { empty: 'Nothing yet.' }))
      : emptyState('No letters yet',
        'Draft one here and it gets a reference, a recipient and a place in the register — '
        + 'or upload one you wrote in Word and file it after the event.'),
  );

  return host;
}

function tile(label, value, sub, accent, onclick) {
  return h('div.stat', { style: onclick ? { cursor: 'pointer' } : null, onclick },
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, String(value)),
    h('div.stat-sub', h('span', sub)),
  );
}

/**
 * Start a letter.
 *
 * Two ways in, and the screen does not make you choose a mode first: fill in
 * the words, or attach a file. Somebody who wrote it in Word should not have to
 * find a different button from somebody who is writing it here.
 */
async function compose(data, reload) {
  const model = await api.corrModel();
  let file = null;

  const picker = h('input', {
    type: 'file',
    accept: 'application/pdf,image/*,.doc,.docx',
    onchange: async (e) => {
      file = e.target.files?.[0] ?? null;
      const note = e.target.parentElement.querySelector('[data-file-note]');
      if (note) {
        note.textContent = file
          ? `${file.name} — the words below are then only a note to yourself`
          : '';
      }
    },
  });

  const done = await formDialog({
    title: 'New letter',
    submitLabel: 'Create it',
    body: h('div',
      h('div.field-row',
        field('Series', h('select', { name: 'series' },
          data.series.map((s) => h('option', { value: s.code }, `${s.code} — ${s.label}`))),
          'Decides the reference. It is allocated now and never reused'),
        field('Direction', h('select', { name: 'direction' },
          h('option', { value: 'outgoing' }, 'Going out'),
          h('option', { value: 'incoming' }, 'Received — filing it'))),
      ),

      field('Subject', h('input', {
        type: 'text', name: 'subject', required: true, maxlength: 200,
        placeholder: 'Outstanding invoice 4471',
      })),

      h('div.field-row',
        field('To / from', h('select', { name: 'partyId' },
          h('option', { value: '' }, 'Somebody not in the address book'),
          data.parties.map((p) => h('option', { value: p.id },
            p.organisation ? `${p.name} — ${p.organisation}` : p.name)))),
        field('Or type a name', h('input', {
          type: 'text', name: 'addressedTo', maxlength: 200,
        })),
      ),

      field('Reply due by', h('input', { type: 'date', name: 'responseDue' }),
        'The register will chase you about it. Leave blank if no reply is expected'),

      field('Attach a letter written elsewhere', picker,
        h('span', { 'data-file-note': '' }, '')),

      field('Or write it here', h('textarea', {
        name: 'body', rows: 12, maxlength: 40000,
        placeholder: 'Dear Sir or Madam,\n\n…\n\nYours faithfully,',
      })),

      model.templates.length
        ? field('From a template', h('select', { name: 'templateId' },
          h('option', { value: '' }, 'None — the words above'),
          model.templates.map((t) => h('option', { value: t.id }, t.name))),
          'A letter template fills in the reference, the address and the date')
        : null,
    ),
    onSubmit: async (form) => {
      const payload = {
        series: form.get('series'),
        direction: form.get('direction'),
        subject: form.get('subject'),
        partyId: form.get('partyId') || null,
        addressedTo: form.get('addressedTo') || null,
        responseDue: form.get('responseDue') || null,
        body: form.get('body') || null,
        templateId: form.get('templateId') || null,
      };

      if (file) {
        payload.filename = file.name;
        payload.mime = file.type || 'application/pdf';
        payload.content = await asBase64(file);
      }
      return api.corrCreateLetter(payload);
    },
  });

  if (done) {
    toast(`Created as ${done.reference}.`, 'good');
    navigate('letter', { id: done.id });
    await reload();
  }
}

export async function asBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
