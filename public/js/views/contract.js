import { api } from '../api.js';
import { confirmItIsYou } from './letter-signing.js';
import { proofFrom } from './letter.js';
import { fileLink } from '../file-view.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, emptyState, table } from './components.js';
import { can, navigate, state } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { printButton } from '../print.js';
import { contractCover } from './contract-cover.js';
import { particularsBox, splitParticulars } from '../contract-flow.js';
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

  // THE SAME PAGE, READ BY THE PERSON IT IS ABOUT. `mine` swaps the endpoint
  // for the one that will only ever hand back this reader's own contracts, and
  // takes the office's buttons off. Everything below it — the words, the two
  // signatures, the fingerprint, the certificate, the chain of events — is
  // identical, because a staff copy showing less than the office copy would be
  // worth less than the office copy, and the point of it is that it is worth
  // the same.
  const mine = Boolean(params.mine);
  const { contract, events, cover } = mine ? await api.myContract(id) : await api.hrContract(id);
  const reload = async () => mount(host, await renderContract({ id, mine: params.mine }));
  // The buttons follow the permission, not the caller. Whoever may read a
  // contract may not necessarily countersign one.
  const canManage = !mine && can('hr_manage');
  const scanUrl = mine
    ? api.myContractFileUrl(id)
    : api.hrDocumentUrl(contract.document_id);

  const countersign = async () => {
    const pad = signaturePad({ height: 130 });
    // Your own PIN or password, as for signing a letter.
    const me = await api.hrSignCheck().catch(() => ({ method: 'pin' }));
    const done = await formDialog({
      title: 'Countersign for the property',
      submitLabel: 'Countersign',
      body: h('div',
        h('p.muted', 'A contract signed by one side is an offer. This is what makes it an '
          + 'agreement, and your name goes on it.'),
        field('Signing as', h('input', { type: 'text', name: 'name', required: true, maxlength: 120 })),
        pad.element,
        confirmItIsYou(me),
      ),
      onSubmit: async (form) => api.hrCountersign(id, {
        ...(await proofFrom(form, me)), name: form.get('name'), ink: pad.read(),
      }),
    });
    if (done) { toast('Countersigned.', 'good'); await reload(); }
  };

  // A contract of employment is accepted online and then signed on paper at
  // the property. Recording that is what completes it.
  const paperFlow = contract.satisfies === 'contract' && contract.origin !== 'paper';
  const recordPaper = async () => {
    const me = await api.hrSignCheck().catch(() => ({ method: 'pin' }));
    const today = new Date().toISOString().slice(0, 10);
    const scan = h('input', { type: 'file', name: 'scan', accept: 'application/pdf,image/*' });
    const done = await formDialog({
      title: 'Record the paper signing',
      submitLabel: 'Record it',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } }, `${contract.signer_name || contract.staff_name} accepted this online. `
          + 'Once you have both signed the two paper copies (print them from Save as PDF above), record it here. '
          + 'Give them one copy and keep the other.'),
        field('Date the paper copies were signed', h('input', {
          type: 'date', name: 'signedOn', required: true, value: today, max: today,
          min: String(contract.signed_at ?? '').slice(0, 10) || undefined,
        })),
        field('Signed for the company by', h('input', {
          type: 'text', name: 'name', required: true, maxlength: 120, value: state.name || '',
        })),
        field('Scan of the signed copy (optional)', scan, 'A photo or PDF of the signed pages, kept on their record.'),
        confirmItIsYou(me),
      ),
      onSubmit: async (form) => {
        const file = scan.files?.[0] ?? null;
        let upload = {};
        if (file) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          upload = { content: btoa(bin), filename: file.name, mime: file.type || 'application/pdf' };
        }
        return api.hrPaperSigned(id, {
          ...(await proofFrom(form, me)), signedOn: form.get('signedOn'), name: form.get('name'), ...upload,
        });
      },
    });
    if (done) { toast('Recorded. The contract is complete.', 'good'); await reload(); }
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
        h('div.sub', `${contract.staff_name} · ${statusLabel(contract)}`),
      ),
      h('div.btn-row',
        mine
          ? h('button.btn-sm', { onclick: () => navigate('att-my-contracts') }, '‹ My contracts')
          : h('button.btn-sm', { onclick: () => navigate('person', { id: contract.staff_id, tab: 'contracts' }) },
            '‹ Their record'),
        printButton({
          title: contract.title,
          subtitle: `${contract.staff_name} · employee ${contract.employee_no}`,
          // The same cover the signed PDF opens with, made fresh for each print.
          cover: cover ? () => contractCover(cover) : null,
          footer: 'Signed electronically. The certificate of signature at the foot of this '
            + 'document records what was presented, when it was signed and from where.',
        }),
        contract.status === 'signed' && contract.employer_at && contract.origin !== 'paper'
          ? h('a.btn.btn-primary', {
            href: mine ? `/api/me/contracts/${id}/signed.pdf?download=1` : `/api/hr/contracts/${id}/signed.pdf?download=1`,
            title: 'The signed copy with both signatures and the certificate, as a PDF anybody can check',
          }, 'Download signed PDF')
          : null,
        canManage && contract.status === 'signed' && !contract.employer_at
          ? (paperFlow
            ? h('button.btn.btn-primary', { onclick: recordPaper }, 'Record the paper signing')
            : h('button.btn.btn-primary', { onclick: countersign }, 'Countersign'))
          : null,
        canManage && !['signed', 'void'].includes(contract.status)
          ? h('button.btn-sm', { onclick: withdraw }, 'Withdraw')
          : null,
      ),
    ),

    // Said once, on the screen, and only to the person who came here to get a
    // copy of their own contract. The print dialog is the download: it is the
    // only route to a PDF that works the same on a phone, on a laptop and in
    // whatever browser somebody actually has.
    contract.status === 'signed' && contract.employer_at && contract.origin !== 'paper'
      ? h('p.muted.no-print', { style: { fontSize: '.85rem', marginTop: '-.4rem' } },
        'The signed PDF has the words, both signatures and the certificate of signature. Anybody '
        + 'can check a copy is genuine at /verify.')
      : null,

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

    paperFlow && contract.status === 'signed' && !contract.employer_at
      ? h('div.alert.no-print',
        h('span.alert-icon', '✍️'),
        h('div',
          h('div.alert-title', 'Accepted online. The paper copy is still to be signed.'),
          h('div.alert-detail', mine
            ? 'You accepted this by typing your full name. Please come in to sign the paper copy; the office will tell you when.'
            : `${contract.signer_name} accepted it by typing their full name${contract.signed_at ? ` on ${fmtDay(String(contract.signed_at).slice(0, 10), { withYear: true })}` : ''}. `
              + 'Print two copies from Save as PDF, sign them together, give one to them, then press Record the paper signing.'),
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
            data: scanUrl,
            type: 'application/pdf',
          },
          h('p.muted',
            'Your browser will not show this here. ',
            fileLink({
              href: scanUrl,
              name: 'The signed contract',
              label: 'Open the scan',
            }), '.')),
          h('p.muted.no-print', { style: { fontSize: '.85rem' } },
            fileLink({
              href: scanUrl,
              name: 'The signed contract',
              label: 'Open the scan on its own',
            }),
            ' to print it — a scanned page prints from its own viewer, not from this one.',
            // Save as PDF at the top of this page prints the certificate, not
            // the scan, because the browser will not print somebody else's
            // embedded viewer. So the scan gets a download of its own.
            mine
              ? h('span', ', or ', fileLink({
                href: api.myContractFileUrl(id, true),
                name: 'The signed contract',
                label: 'download the file itself',
              }), '.')
              : null),
        )
        : (() => {
          // The employee's particulars as a box, then the words.
          const { rows, rest } = splitParticulars(contract.body);
          return rows.length
            ? h('div', particularsBox(h, rows), h('div.contract-body', rest))
            : h('div.contract-body', contract.body);
        })(),

      contract.origin === 'paper'
        ? h('p.muted', { style: { marginTop: '.8rem' } },
          'Signed on paper. The signatures are on the scan above.')
        : h('div.sig-block',
          signatureSlot(paperFlow ? 'Accepted by the employee' : 'Signed by the employee', contract.signer_name, contract.signature_ink,
            contract.signed_at, contract.signature_ink ? 'Drawn by hand' : 'Full name typed'),
          signatureSlot('For the property', contract.employer_name, contract.employer_ink,
            contract.paper_signed_on || contract.employer_at, contract.paper_signed_on ? 'Signed on paper' : null),
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
          row(paperFlow ? 'Accepted by' : 'Signed by', contract.signer_name || '—'),
          row('How', contract.signature_ink ? 'Drawn by hand on a touchscreen' : 'Full name typed'),
          row('When (UTC)', contract.signed_at || 'Not signed'),
          row('From', contract.signer_ip || '—'),
          row('Device', h('small', contract.signer_agent || '—')),
          paperFlow
            ? row('Paper copies signed', contract.paper_signed_on
              ? [`${fmtDay(contract.paper_signed_on, { withYear: true })}, for the company by ${contract.employer_name}; recorded by ${contract.paper_recorded_by || '—'}`,
                contract.paper_document_id && !mine
                  ? h('span', ' · ', fileLink({ href: api.hrDocumentUrl(contract.paper_document_id), name: 'Signed paper copy', label: 'the scan' }))
                  : null]
              : (contract.employer_at ? `Countersigned by ${contract.employer_name}, ${contract.employer_at} UTC` : 'Not yet'))
            : row('Countersigned by', contract.employer_name
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

/** What a contract's state reads as, with the paper step where it has one. */
export function statusLabel(c) {
  if (c.status === 'signed' && c.satisfies === 'contract' && c.origin !== 'paper') {
    if (!c.employer_at) return 'Accepted online, paper copy to sign';
    return c.paper_signed_on ? 'Accepted online and signed on paper' : 'Signed and countersigned';
  }
  return STATUS[c.status]?.[1] ?? c.status;
}

export const EVENTS = {
  contract_issued: 'Issued',
  link_created: 'Link sent',
  link_opened: 'Link opened',
  link_pin_failed: 'Wrong code entered',
  link_revoked: 'Link cancelled',
  contract_viewed: 'Document opened',
  signed: 'Accepted',
  declined: 'Refused',
  countersigned: 'Countersigned by the property',
  paper_signed: 'Paper copies signed',
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
