import { api } from '../api.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, emptyState, table } from './components.js';
import { can, navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { printButton } from '../print.js';
import { signaturePad } from '../fields.js';

/**
 * A contract, as it was signed, with the evidence under it.
 *
 * A page of its own rather than a panel, for one reason: this is the thing
 * somebody prints. A modal lives in the browser's top layer and prints badly
 * or not at all, and a signed contract that cannot be put on paper is not
 * finished.
 *
 * The order is the argument. The words first, because that is what was agreed.
 * Then the two signatures. Then the certificate — the fingerprint, the times,
 * the addresses — because a signature on its own is an assertion, and a
 * signature with all of that beside it is something you can show somebody.
 */
export async function renderContract(params) {
  const host = h('div');
  const id = Number(params.id);
  if (!id) {
    mount(host, emptyState('No document chosen', 'Open one from somebody’s record.'));
    return host;
  }

  const { contract, events } = await api.hrContract(id);
  const reload = async () => mount(host, await renderContract({ id }));
  // The buttons follow the permission, not the caller. Whoever may read a
  // contract may not necessarily countersign one.
  const canManage = can('hr_manage');

  const countersign = async () => {
    const pad = signaturePad({ height: 130 });
    const done = await formDialog({
      title: 'Countersign for the property',
      submitLabel: 'Countersign',
      body: h('div',
        h('p.muted', 'A contract signed by one side is an offer. This is what makes it an '
          + 'agreement, and your name goes on it.'),
        field('Signing as', h('input', { type: 'text', name: 'name', required: true, maxlength: 120 })),
        pad.element,
      ),
      onSubmit: async (form) => api.hrCountersign(id, { name: form.get('name'), ink: pad.read() }),
    });
    if (done) { toast('Countersigned.', 'good'); await reload(); }
  };

  const withdraw = async () => {
    const done = await formDialog({
      title: 'Withdraw this document?',
      submitLabel: 'Withdraw it',
      body: h('div',
        h('p.muted', 'It stops working on any link carrying it. A signed contract cannot be '
          + 'withdrawn — issue a replacement instead and say what it supersedes.'),
        field('Why', h('input', { type: 'text', name: 'note', maxlength: 300 })),
      ),
      onSubmit: async (form) => api.hrVoidContract(id, form.get('note')),
    });
    if (done) { toast('Withdrawn.'); await reload(); }
  };

  mount(host,
    h('div.page-head.no-print',
      h('div',
        h('h1', contract.title),
        h('div.sub', `${contract.staff_name} · ${STATUS[contract.status]?.[1] ?? contract.status}`),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('person', { id: contract.staff_id, tab: 'contracts' }) },
          '‹ Their record'),
        printButton({
          title: contract.title,
          subtitle: `${contract.staff_name} · employee ${contract.employee_no}`,
          footer: 'Signed electronically. The certificate of signature at the foot of this '
            + 'document records what was presented, when it was signed and from where.',
        }),
        canManage && contract.status === 'signed' && !contract.employer_at
          ? h('button.btn.btn-primary', { onclick: countersign }, 'Countersign')
          : null,
        canManage && !['signed', 'void'].includes(contract.status)
          ? h('button.btn-sm', { onclick: withdraw }, 'Withdraw')
          : null,
      ),
    ),

    // The one thing on this page worth shouting about. Checked on the server
    // every time the contract is read: the stored words are hashed again and
    // compared with the hash recorded when it was signed.
    contract.origin !== 'paper' && !contract.intact
      ? h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', 'The words no longer match the signature'),
          h('div.alert-detail', 'The text stored here does not produce the fingerprint that was '
            + 'recorded when this was signed, so it has been altered since. Do not rely on it. '
            + 'Tell whoever looks after the system.'),
        ))
      : null,

    contract.status === 'declined'
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'They did not sign this'),
          h('div.alert-detail', contract.decline_note || 'No reason was given.'),
        ))
      : null,

    card(null, { wide: true },
      // A paper contract has no words here to show — the scan is the contract.
      // Embedding it rather than linking it means the thing somebody came to
      // read is on the screen they landed on.
      contract.origin === 'paper'
        ? h('div',
          h('object.scan', {
            data: api.hrDocumentUrl(contract.document_id),
            type: 'application/pdf',
          },
          h('p.muted',
            'Your browser will not show this here. ',
            h('a', { href: api.hrDocumentUrl(contract.document_id), target: '_blank', rel: 'noopener' },
              'Open the scan'), '.')),
          h('p.muted.no-print', { style: { fontSize: '.85rem' } },
            h('a', { href: api.hrDocumentUrl(contract.document_id), target: '_blank', rel: 'noopener' },
              'Open the scan in a new tab'),
            ' to print it — a scanned page prints from its own viewer, not from this one.'),
        )
        : h('div.contract-body', contract.body),

      contract.origin === 'paper'
        ? h('p.muted', { style: { marginTop: '.8rem' } },
          'Signed on paper. The signatures are on the scan above.')
        : h('div.sig-block',
          signatureSlot('Signed by the employee', contract.signer_name, contract.signature_ink,
            contract.signed_at, contract.signature_ink ? 'Drawn by hand' : 'Typed name'),
          signatureSlot('For the property', contract.employer_name, contract.employer_ink,
            contract.employer_at, null),
        ),
    ),

    card(contract.origin === 'paper' ? 'How this came to be on file' : 'Certificate of signature',
      { wide: true },
      contract.origin === 'paper'
        // A scan and an electronic signature are not the same evidence, and a
        // screen that presented them alike would be worse than one that showed
        // nothing. What can honestly be said about a scan is said, and no more.
        ? h('table.cert',
          row('Document', contract.title),
          row('Employee', `${contract.staff_name} · ${contract.employee_no}`),
          row('How it was signed', 'On paper. This is a scan of it.'),
          row('Date on the paper', contract.signed_at || '—'),
          row('Signed by', contract.signer_name || '—'),
          row('Countersigned by', contract.employer_name || '—'),
          row('Scan filed by', `${contract.filed_by || '—'}${contract.filed_at ? `, ${contract.filed_at} UTC` : ''}`),
          row('Fingerprint of the scan (SHA-256)', h('span.mono', contract.body_hash)),
          row('What that proves', 'That this file is the one that was filed, and has not been '
            + 'swapped since. It says nothing about the signature on the page, which is a '
            + 'question for the paper original.'),
        )
        : h('table.cert',
          row('Document', contract.title),
          row('Employee', `${contract.staff_name} · ${contract.employee_no}`),
          row('Fingerprint of the words (SHA-256)', h('span.mono', contract.body_hash)),
          row('Still matches the words above', contract.intact
            ? 'Yes — checked just now'
            : h('strong', 'NO — see the warning above')),
          row('Signed by', contract.signer_name || '—'),
          row('How', contract.signature_ink ? 'Drawn by hand on a touchscreen' : 'Full name typed'),
          row('When (UTC)', contract.signed_at || 'Not signed'),
          row('From', contract.signer_ip || '—'),
          row('Device', h('small', contract.signer_agent || '—')),
          row('Countersigned by', contract.employer_name
            ? `${contract.employer_name}, ${contract.employer_at} UTC` : 'Not yet'),
        ),

      h('h4', { style: { margin: '1.1rem 0 .3rem' } }, 'What happened, in order'),
      table([
        { key: 'at_utc', label: 'When (UTC)', format: (v) => h('small.mono', v) },
        { key: 'kind', label: 'What', format: (v) => EVENTS[v] ?? v },
        { key: 'detail', label: 'Detail', format: (v) => h('small', v || '') },
        { key: 'ip', label: 'From', format: (v) => h('small.mono', v || '—') },
      ], events, { empty: 'Nothing recorded.' }),

      contract.origin === 'paper' ? null : h('p.muted', { style: { fontSize: '.8rem', marginBottom: 0 } },
        'Ghana’s Electronic Transactions Act 2008 gives an electronic signature the same effect '
        + 'as a written one where it is uniquely linked to the person signing and under their '
        + 'control. What is recorded above is the evidence of that: the exact words that were on '
        + 'the screen, that the person agreed to sign them electronically, and when and from '
        + 'where they did it.'),
    ),
  );

  return host;
}

export const STATUS = {
  draft: ['', 'Not sent'],
  sent: ['warn', 'Sent, not opened'],
  opened: ['warn', 'Opened, not signed'],
  signed: ['good', 'Signed'],
  declined: ['bad', 'Refused'],
  void: ['', 'Withdrawn'],
};

export const EVENTS = {
  contract_issued: 'Issued',
  link_created: 'Link sent',
  link_opened: 'Link opened',
  link_pin_failed: 'Wrong code entered',
  link_revoked: 'Link cancelled',
  contract_viewed: 'Document opened',
  signed: 'Signed',
  declined: 'Refused',
  countersigned: 'Countersigned by the property',
  contract_void: 'Withdrawn',
  contract_filed: 'Signed on paper, scan filed',
  details_sent: 'Details sent in',
  details_accepted: 'Details accepted',
  details_rejected: 'Details turned down',
};

function signatureSlot(label, name, ink, at, how) {
  return h('div.sig-slot',
    h('div.sig-label', label),
    ink
      ? h('img.sig-image', { src: ink, alt: `${name || ''} signature` })
      // A typed name is set in a serif italic and never in a face pretending to
      // be handwriting. What it is matters, and the certificate says which.
      : h('div.sig-typed', name || ''),
    h('div.sig-name', name || 'Not signed'),
    h('div.sig-when', at ? `${fmtDay(String(at).slice(0, 10), { withYear: true })}${how ? ` · ${how}` : ''}` : '—'),
  );
}

const row = (label, value) => h('tr', h('th', label), h('td', value));
