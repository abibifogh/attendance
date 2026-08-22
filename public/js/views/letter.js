import { api } from '../api.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, emptyState, table } from './components.js';
import { can, navigate, replaceParams } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { signaturePad } from '../fields.js';
import { printButton } from '../print.js';
import { asBase64 } from './letters.js';
import { paper } from './letter-paper.js';
import { confirmItIsYou } from './letter-signing.js';

/**
 * One letter, everything that has happened to it, and the proof.
 *
 * A page rather than a panel because this is the thing somebody prints and
 * files, and because the evidence under it — who signed, when, from where, and
 * whether the log has been touched — is the part that matters years later and
 * deserves to be readable rather than tucked into a dialog.
 */
const PILL = { green: 'good', amber: 'warn', red: 'bad', grey: '' };

const EVENTS = {
  created: 'Drafted',
  edited: 'Edited',
  signed_internally: 'Signed for the property',
  sent_for_signature: 'Sent for signature',
  opened_by_recipient: 'Opened by the recipient',
  access_code_failed: 'Wrong access code entered',
  code_emailed: 'One-time code emailed',
  signed: 'Signed',
  declined: 'Refused to sign',
  fully_signed: 'Everybody has signed',
  dispatched: 'Sent out',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
  link_revoked: 'Link cancelled',
  enclosure_added: 'Enclosure added',
};

export async function renderLetter(params) {
  const host = h('div');
  const id = Number(params.id);
  if (!id) {
    mount(host, emptyState('No letter chosen', 'Open one from the register.'));
    return host;
  }

  const data = await api.corrLetter(id);
  const { letter, recipients, events, chain, progress } = data;
  const model = await api.corrModel();
  const reload = async () => mount(host, await renderLetter({ id }));

  // The composer ends by asking how the letter is signed and sends the answer
  // here, because this is where both of those actions already live with the
  // re-authentication and the recipient list they need. Opened once, then the
  // answer is taken out of the address so a refresh does not ask again.
  const then = ['self', 'invite', 'both'].includes(params.then) ? params.then : null;
  if (then) {
    replaceParams('letter', { id });
    queueMicrotask(async () => {
      if (then === 'self' || then === 'both') {
        const signed = await signIt(data, reload);
        // Both means one after the other, and only if the first happened.
        if (then === 'both' && signed) {
          const fresh = await api.corrLetter(id);
          await sendOut({ ...fresh, canWrite: data.canWrite, canSign: data.canSign }, model, reload);
        }
        return;
      }
      await sendOut(data, model, reload);
    });
  }

  const status = model.statuses[letter.status] ?? { label: letter.status, colour: 'grey' };

  mount(host,
    h('div.page-head.no-print',
      h('div',
        h('h1', letter.subject),
        h('div.sub',
          h('span.mono', letter.reference), ' · ',
          letter.addressed_to || 'Unaddressed',
          letter.organisation ? ` · ${letter.organisation}` : ''),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('letters') }, '‹ Register'),
        printButton({
          title: letter.subject,
          subtitle: `${letter.reference} · ${letter.addressed_to || ''}`,
          footer: 'Signed electronically. The record of signature at the foot of this document '
            + 'shows what was presented, who signed it, and when.',
        }),
        ...actions(data, model, reload),
      ),
    ),

    // The one thing on this page worth shouting about, and the reason the log
    // is hashed at all.
    !chain.intact
      ? h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', 'The record of this letter has been altered'),
          h('div.alert-detail', `Everything from event ${chain.brokenAt} onwards no longer `
            + 'matches its own fingerprint, so the log has been changed since it was written. '
            + 'Do not rely on it. Tell whoever looks after the system.'),
        ))
      : null,

    letter.body != null && !letter.bodyIntact
      ? h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', 'The words no longer match what was signed'),
          h('div.alert-detail', 'The stored letter does not produce the fingerprint taken when '
            + 'it was written. Do not rely on it.'),
        ))
      : null,

    progress.declined
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', `${progress.declined} refused to sign`),
          h('div.alert-detail',
            recipients.find((r) => r.status === 'declined')?.declineNote || 'No reason given.'),
        ))
      : null,

    h('div.toolbar.no-print',
      h(`span.pill${PILL[status.colour] ? `.${PILL[status.colour]}` : ''}`, status.label),
      progress.waitingOn ? h('span.muted', `Waiting on ${progress.waitingOn}`) : null,
      letter.response_due
        ? h('span.muted', `Reply due ${fmtDay(letter.response_due, { withYear: true })}`)
        : null,
      letter.replies_to_reference
        ? h('span.muted', `Replies to ${letter.replies_to_reference}`)
        : null,
    ),

    card(null, { wide: true },
      letter.source === 'uploaded'
        ? h('div',
          h('object.scan', { data: api.corrFileUrl(letter.file_id), type: letter.file_mime },
            h('p.muted', 'Your browser will not show this here. ',
              h('a', { href: api.corrFileUrl(letter.file_id), target: '_blank', rel: 'noopener' },
                'Open the letter'), '.')),
          h('p.muted.no-print', { style: { fontSize: '.85rem' } },
            h('a', { href: api.corrFileUrl(letter.file_id), target: '_blank', rel: 'noopener' },
              'Open it in a new tab'), ' to print it.'))
        : letter.layout?.blocks?.length
          // As the page it will be, rather than as a wall of text. The same
          // renderer the composer and the signing page use, so what is filed
          // here is provably what was signed there.
          ? h('div.letter-paper', paper({
            ...letter,
            stamp: data.stamp?.image ?? null,
            signedRecipients: recipients.filter((r) => r.signedAt),
          }, { scale: 0.86 }))
          : h('div.contract-body', letter.body || ''),

      letter.signed_at || recipients.some((r) => r.signedAt)
        ? h('div.sig-block',
          letter.signed_at
            ? signatureSlot('For the property', letter.signed_by, letter.signed_title,
              letter.signature_ink, letter.signed_at, data.stamp?.image)
            : null,
          ...recipients.filter((r) => r.signedAt).map((r) =>
            signatureSlot(r.organisation || 'Signed by', r.signerName, r.organisation,
              r.signatureInk, r.signedAt, null)),
        )
        : null,
    ),

    recipients.length
      ? card('Who it went to', { note: `${progress.signed} of ${progress.signers} signed`, wide: true },
        table([
          { key: 'seq', label: '#', align: 'right' },
          {
            key: 'name',
            label: 'Name',
            format: (v, r) => h('div', h('div', v),
              h('small.muted', [r.organisation, r.email, r.phone].filter(Boolean).join(' · '))),
          },
          { key: 'role', label: 'Asked to', format: (v) => (v === 'copy' ? 'Read it' : v === 'approver' ? 'Approve' : 'Sign') },
          {
            key: 'status',
            label: 'Where it is',
            format: (v, r) => h('div',
              h(`span.pill${v === 'signed' ? '.good' : v === 'declined' ? '.bad' : v === 'opened' ? '.warn' : ''}`,
                { }, { pending: 'Not opened', opened: 'Opened', signed: 'Signed', declined: 'Refused', revoked: 'Cancelled' }[v] ?? v),
              r.hasCode ? h('small.muted', 'access code set') : null,
              r.verifiedAt ? h('small.muted', 'code verified') : null,
            ),
          },
          {
            key: 'signedAt',
            label: 'When',
            format: (v, r) => (v
              ? h('div', h('small.mono', String(v)), h('small.muted', r.signerIp || ''))
              : h('span.muted', r.expiresAt ? `expires ${fmtDay(String(r.expiresAt).slice(0, 10))}` : '—')),
          },
          {
            key: 'actions',
            label: '',
            format: (v, r) => (data.canWrite && !['signed', 'revoked'].includes(r.status)
              ? h('button.btn-sm.no-print', {
                onclick: async () => {
                  if (!window.confirm(`Cancel ${r.name}'s link? It stops working immediately.`)) return;
                  await api.corrRevokeRecipient(r.id);
                  toast('Cancelled.');
                  await reload();
                },
              }, 'Cancel')
              : ''),
          },
        ], recipients, { empty: 'Nobody.' }))
      : null,

    data.enclosures.length
      ? card('Enclosures', { note: `${data.enclosures.length}`, wide: true },
        h('ul', data.enclosures.map((f) => h('li',
          h('a', { href: api.corrFileUrl(f.id), target: '_blank', rel: 'noopener' }, f.title),
          h('small.muted', ` — ${Math.round(f.bytes / 1024)} KB`)))))
      : null,

    card('Record of this letter', { wide: true },
      h('table.cert',
        row('Reference', h('span.mono', letter.reference)),
        row('Subject', letter.subject),
        row('Addressed to', [letter.addressed_to, letter.organisation, letter.address]
          .filter(Boolean).join(' · ') || '—'),
        letter.source === 'composed'
          ? row('Fingerprint of the words (SHA-256)', h('span.mono', letter.body_hash || '—'))
          : row('Fingerprint of the file (SHA-256)', h('span.mono', letter.file_hash || '—')),
        row('Still matches', letter.bodyIntact ? 'Yes — checked just now' : h('strong', 'NO')),
        row('Signed for the property', letter.signed_at
          ? `${letter.signed_by}${letter.signed_title ? `, ${letter.signed_title}` : ''}, ${letter.signed_at} UTC`
          : 'Not yet'),
        row('Company stamp', letter.stamped_at ? `Applied ${letter.stamped_at} UTC` : 'Not applied'),
        row('Sent', letter.sent_at ? `${letter.sent_at} UTC by ${letter.sent_via}` : 'Not yet'),
        row('Log', chain.intact
          ? `${events.length} events, hash-linked and intact`
          : h('strong', `ALTERED at event ${chain.brokenAt}`)),
      ),

      h('h4', { style: { margin: '1.1rem 0 .3rem' } }, 'What happened, in order'),
      table([
        { key: 'seq', label: '#', align: 'right' },
        { key: 'at_utc', label: 'When (UTC)', format: (v) => h('small.mono', v) },
        { key: 'kind', label: 'What', format: (v) => EVENTS[v] ?? v },
        { key: 'actor', label: 'Who', format: (v) => h('small', v || '—') },
        { key: 'detail', label: 'Detail', format: (v) => h('small', v || '') },
        { key: 'ip', label: 'From', format: (v) => h('small.mono', v || '—') },
      ], events, { empty: 'Nothing recorded.' }),

      h('p.muted', { style: { fontSize: '.8rem', marginBottom: 0 } },
        'Each line above carries the fingerprint of the line before it, so a row that is edited '
        + 'or removed breaks every fingerprint after it and this page says so. An audit trail '
        + 'that can be quietly rewritten is not one.'),
    ),

    data.replies.length
      ? card('Replies', { wide: true },
        h('ul', data.replies.map((r) => h('li',
          h('button.link-button', { onclick: () => navigate('letter', { id: r.id }) },
            `${r.reference} — ${r.subject}`)))))
      : null,
  );

  return host;
}

const row = (label, value) => h('tr', h('th', label), h('td', value));

function signatureSlot(label, name, title, ink, at, stamp) {
  return h('div.sig-slot',
    h('div.sig-label', label),
    h('div', { style: { position: 'relative' } },
      ink
        ? h('img.sig-image', { src: ink, alt: `${name || ''} signature` })
        : h('div.sig-typed', name || ''),
      stamp ? h('img.stamp-image', { src: stamp, alt: 'Company stamp' }) : null,
    ),
    h('div.sig-name', name || '—'),
    title ? h('div.sig-when', title) : null,
    h('div.sig-when', at ? `${fmtDay(String(at).slice(0, 10), { withYear: true })}` : ''),
  );
}

// ---------------------------------------------------------------------------
// What can be done to it
// ---------------------------------------------------------------------------

function actions(data, model, reload) {
  const { letter, canWrite, canSign } = data;
  const out = [];
  const ended = ['void', 'closed'].includes(letter.status);

  if (canSign && !letter.signed_at && !ended) {
    out.push(h('button.btn.btn-primary', { onclick: () => signIt(data, reload) },
      'Sign for the property'));
  }
  if (canWrite && !ended && letter.direction === 'outgoing') {
    out.push(h('button.btn-sm', { onclick: () => sendOut(data, model, reload) },
      'Send for signature'));
  }
  if (canWrite && !ended && !letter.sent_at) {
    out.push(h('button.btn-sm', { onclick: () => dispatch(data, reload) }, 'Record it as sent'));
  }
  if (canWrite && !ended) {
    out.push(h('button.btn-sm', { onclick: () => enclose(data, reload) }, 'Add an enclosure'));
    out.push(h('button.btn-sm', { onclick: () => finish(data, reload) }, 'Close'));
  }
  if (canWrite && letter.status === 'draft' && letter.source !== 'uploaded') {
    out.unshift(h('button.btn-sm', {
      onclick: () => navigate('letter-compose', { id: letter.id }),
    }, 'Open the page'));
  }
  if (canWrite && letter.status === 'draft') {
    out.push(h('button.btn-sm', { onclick: () => withdraw(data, reload) }, 'Withdraw'));
  }
  return out;
}

/**
 * Sign for the property.
 *
 * Asks for the signer's own PIN or password at the moment of signing, on top
 * of the session they already have. A stored signature that anybody with an
 * unlocked phone could stamp onto a letter would be worse than having none.
 */
async function signIt(data, reload) {
  const [me, { rows: stamps }] = await Promise.all([api.corrMe(), api.corrStamps()]);
  const pad = signaturePad({ height: 130 });
  const hasStored = Boolean(me.signatory?.hasSignature);

  const done = await formDialog({
    title: `Sign ${data.letter.reference}`,
    submitLabel: 'Sign it',
    body: h('div',
      hasStored
        ? h('p.muted', `Your saved signature (${me.signatory.displayName}`
          + `${me.signatory.jobTitle ? `, ${me.signatory.jobTitle}` : ''}) will be used unless `
          + 'you draw a new one below.')
        : h('p.muted', 'Draw your signature. Save one under Signature & stamp and you will not '
          + 'have to draw it every time.'),

      h('div.field-row',
        field('Signing as', h('input', {
          type: 'text', name: 'name', maxlength: 120,
          value: me.signatory?.displayName ?? '', required: !hasStored,
        })),
        field('Job title', h('input', {
          type: 'text', name: 'jobTitle', maxlength: 120, value: me.signatory?.jobTitle ?? '',
        })),
      ),

      pad.element,

      stamps.length
        ? field('Company stamp', h('select', { name: 'stampId' },
          h('option', { value: '' }, 'No stamp'),
          stamps.filter((s) => s.active).map((s) => h('option', { value: s.id }, s.label))),
          'Applied beside your signature and recorded in the log')
        : null,

      confirmItIsYou(me),
    ),
    onSubmit: async (form) => {
      const proof = await proofFrom(form, me);
      return api.corrSign(data.letter.id, {
        ...proof,
        name: form.get('name'),
        jobTitle: form.get('jobTitle'),
        ink: pad.read(),
        stampId: form.get('stampId') || null,
      });
    },
  });

  if (done) { toast('Signed.', 'good'); await reload(); }
  // Said out loud so "both" knows whether the second half should happen: a
  // letter nobody signed should not then be sent out as if somebody had.
  return Boolean(done);
}

/** Turn what was typed into something the server can check. */
export async function proofFrom(form, me) {
  const secret = String(form.get('confirm') ?? '');
  if (!secret) throw new Error('Confirm it is you before signing.');

  if (me.method === 'password') {
    const { deriveLoginKey } = await import('../crypto.js');
    return {
      passwordKey: await deriveLoginKey(secret, me.salt.passwordSalt, me.salt.passwordIterations),
    };
  }
  return { pin: secret };
}

/**
 * Send it out for signature.
 *
 * Recipients sign in the order they are listed, and each gets a link plus an
 * access code to be told separately. The links are shown once — only their
 * fingerprints are kept — so the screen afterwards is built for copying.
 */
async function sendOut(data, model, reload) {
  const { rows: parties } = await api.corrParties();
  const people = [{ name: data.letter.addressed_to || '', email: data.letter.party_email || '', role: 'signer' }];
  const list = h('div');

  const draw = () => {
    mount(list, people.map((person, i) => h('div.list-row',
      h('div.list-row-fields',
        h('label.field', h('span', `${i + 1}. Name`),
          h('input', {
            type: 'text', value: person.name, maxlength: 160,
            oninput: (e) => { person.name = e.target.value; },
          })),
        h('label.field', h('span', 'Organisation'),
          h('input', {
            type: 'text', value: person.organisation ?? '', maxlength: 160,
            oninput: (e) => { person.organisation = e.target.value; },
          })),
        h('label.field', h('span', 'Email'),
          h('input', {
            type: 'email', value: person.email ?? '', maxlength: 200,
            oninput: (e) => { person.email = e.target.value; },
          })),
        h('label.field', h('span', 'Asked to'),
          h('select', { onchange: (e) => { person.role = e.target.value; } },
            h('option', { value: 'signer', selected: person.role === 'signer' }, 'Sign'),
            h('option', { value: 'approver', selected: person.role === 'approver' }, 'Approve'),
            h('option', { value: 'copy', selected: person.role === 'copy' }, 'Read only'))),
      ),
      h('button.btn-sm.list-row-remove', {
        type: 'button',
        onclick: () => { people.splice(i, 1); if (!people.length) people.push({ role: 'signer' }); draw(); },
      }, '×'),
    )));
  };
  draw();

  const done = await formDialog({
    title: 'Send for signature',
    submitLabel: 'Make the links',
    body: h('div',
      h('p.muted', 'They sign in the order listed. Only the first person’s link works until they '
        + 'have dealt with it — a letter counter-signed before it was signed is one nobody can '
        + 'reason about afterwards.'),

      parties.length
        ? field('Add from the address book', h('select', {
          onchange: (e) => {
            const party = parties.find((p) => String(p.id) === e.target.value);
            if (!party) return;
            people.push({
              name: party.name, organisation: party.organisation ?? '', email: party.email ?? '',
              role: 'signer', partyId: party.id,
            });
            e.target.value = '';
            draw();
          },
        },
        h('option', { value: '' }, 'Choose somebody…'),
        parties.filter((p) => p.active).map((p) => h('option', { value: p.id },
          p.organisation ? `${p.name} — ${p.organisation}` : p.name))))
        : null,

      list,
      h('button.btn-sm', {
        type: 'button',
        onclick: () => { people.push({ role: 'signer' }); draw(); },
      }, '+ Add another'),

      h('div.field-row', { style: { marginTop: '.8rem' } },
        field('Links last for', h('select', { name: 'days' },
          [7, 14, 21, 30, 60].map((n) => h('option', {
            value: n, selected: n === model.linkDays,
          }, `${n} days`)))),
      ),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Each signer gets a six-character access code as well as the link. Give it to them by a '
        + 'different route — read it out on a call — so a forwarded link on its own opens nothing.'),
    ),
    onSubmit: async (form) => api.corrSendForSignature(data.letter.id, {
      recipients: people.filter((p) => String(p.name ?? '').trim()),
      days: Number(form.get('days')),
    }),
  });

  if (!done) return;
  await showLinks(done);
  await reload();
}

/** The links, once. */
async function showLinks(result) {
  await formDialog({
    title: 'The links — copy them now',
    submitLabel: 'Done',
    body: h('div',
      h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'This is the only time you will see them'),
          h('div.alert-detail', 'Only fingerprints are stored, so they cannot be shown again. '
            + 'Lose one and you make another.'),
        )),

      result.recipients.map((r) => (r.url
        ? h('div', { style: { marginBottom: '1rem' } },
          h('h4', { style: { marginBottom: '.2rem' } }, `${r.seq}. ${r.name}`),
          h('textarea.link-box', { rows: 3, readonly: true, onclick: (e) => e.target.select() },
            `${r.url}\n\nAccess code: ${r.code}`),
          h('div.btn-row',
            h('button.btn-sm.btn-primary', {
              onclick: async (e) => {
                try {
                  await navigator.clipboard.writeText(r.url);
                  e.target.textContent = 'Link copied ✓';
                } catch { toast('Select the text and copy it.', 'bad'); }
              },
            }, 'Copy the link'),
            r.email
              ? h('a.btn-sm', {
                href: `mailto:${r.email}?subject=${encodeURIComponent('Document for your signature')}`
                  + `&body=${encodeURIComponent(`Please open this link to sign:\n\n${r.url}\n\n`
                    + 'You will be asked for an access code, which I will give you separately.')}`,
              }, 'Email it')
              : null,
          ),
          h('p.muted', { style: { fontSize: '.82rem' } },
            'Access code ', h('strong.mono', r.code),
            ' — tell them this on a call, not in the same message as the link.'),
        )
        : h('p.muted', `${r.seq}. ${r.name} — copied in for information, no link needed.`))),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        `They stop working in ${result.expiresInDays} days.`),
    ),
    onSubmit: async () => ({ ok: true }),
  });
}

async function dispatch(data, reload) {
  const done = await formDialog({
    title: 'Record it as sent',
    submitLabel: 'Record it',
    body: h('div',
      h('div.field-row',
        field('How it went', h('select', { name: 'via' },
          h('option', { value: 'email' }, 'Email'),
          h('option', { value: 'hand' }, 'By hand'),
          h('option', { value: 'post' }, 'Post'),
          h('option', { value: 'courier' }, 'Courier'),
          h('option', { value: 'whatsapp' }, 'WhatsApp'))),
        field('Note', h('input', {
          type: 'text', name: 'note', maxlength: 300, placeholder: 'Left with reception',
        })),
      ),
    ),
    onSubmit: async (form) => api.corrDispatch(data.letter.id, {
      via: form.get('via'), note: form.get('note'),
    }),
  });
  if (done) { toast('Recorded.', 'good'); await reload(); }
}

async function enclose(data, reload) {
  let file = null;
  const done = await formDialog({
    title: 'Add an enclosure',
    submitLabel: 'Attach it',
    body: h('div',
      field('File', h('input', {
        type: 'file', required: true,
        onchange: (e) => { file = e.target.files?.[0] ?? null; },
      })),
      field('Call it', h('input', { type: 'text', name: 'title', required: true, maxlength: 200 })),
    ),
    onSubmit: async (form) => {
      if (!file) throw new Error('Choose a file first.');
      return api.corrAddEnclosure(data.letter.id, {
        title: form.get('title'),
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        content: await asBase64(file),
      });
    },
  });
  if (done) { toast('Attached.', 'good'); await reload(); }
}

async function finish(data, reload) {
  const done = await formDialog({
    title: 'Close this letter',
    submitLabel: 'Close it',
    body: h('div',
      h('p.muted', 'It stops being chased for a reply and drops out of the outstanding list.'),
      field('What happened', h('input', {
        type: 'text', name: 'note', maxlength: 300, placeholder: 'They paid on 3 September',
      })),
    ),
    onSubmit: async (form) => api.corrClose(data.letter.id, form.get('note')),
  });
  if (done) { toast('Closed.'); await reload(); }
}

async function withdraw(data, reload) {
  const done = await formDialog({
    title: 'Withdraw this letter',
    submitLabel: 'Withdraw it',
    body: h('div',
      h('p.muted', 'Every link stops working. The reference is not reused — a gap in the '
        + 'register is a question worth asking, and a reused number is a filing system that '
        + 'disagrees with itself.'),
      field('Why', h('input', { type: 'text', name: 'note', maxlength: 300 })),
    ),
    onSubmit: async (form) => api.corrVoid(data.letter.id, form.get('note')),
  });
  if (done) { toast('Withdrawn.'); await reload(); }
}

export { EVENTS };
