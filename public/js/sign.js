import { h, mount, toast } from './util.js';
import { signaturePad } from './fields.js';

/**
 * Somebody outside the property, opening a link to sign a letter.
 *
 * Its own page, sharing nothing with the office app but the stylesheet and two
 * helpers. It is opened by suppliers, banks and guests over a link that may
 * have been forwarded, so the less of the system it can reach the better.
 *
 * Three gates, in the order every e-signing product worth copying puts them:
 * the link, an access code told down another channel, and — where an address
 * is on file — a one-time code emailed at the moment of signing. The third is
 * what turns "somebody holding this link" into "somebody holding this link and
 * reading that mailbox".
 */

const root = document.getElementById('sign');
const token = decodeURIComponent(location.pathname.replace(/^\/s\//, '').replace(/\/+$/, ''));

let packet = null;

start();

async function start() {
  if (!token) return fail('This link is not complete. Ask for it to be sent again.');
  try {
    const head = await call(`/api/s/${token}`, null, 'GET');
    if (head.done) return alreadyDone(head);
    if (head.needsCode) return askForCode(head);
    await open(null);
  } catch (err) {
    fail(err.message);
  }
}

function alreadyDone(head) {
  mount(root, shell(head.property,
    h('div.card.card-done',
      h('div.done-mark', '✓'),
      h('h2', 'This is already done'),
      h('p.muted', head.subject
        ? `You signed “${head.subject}”. The sender has a copy with the time and date on it.`
        : 'Nothing further is needed from you.'),
    ),
  ));
}

function askForCode(head) {
  const input = h('input.pin-input', {
    type: 'text', maxlength: 6, autocomplete: 'off', autocapitalize: 'characters',
    placeholder: '••••••', 'aria-label': 'Six-character access code',
    style: { letterSpacing: '.3em', fontSize: '1.6rem' },
  });

  const go = async (button) => {
    button.disabled = true;
    try {
      await open(input.value);
    } catch (err) {
      toast(err.message, 'bad');
      input.value = '';
      button.disabled = false;
      input.focus();
    }
  };

  mount(root, shell(head.property,
    h('div.card',
      h('h2', 'Enter your access code'),
      h('p.muted', 'The six characters you were given separately — on a call, or in a different '
        + 'message. If you were not given one, ask whoever sent you this link.'),
      input,
      h('button.btn.btn-primary.btn-wide', { onclick: (e) => go(e.target) }, 'Open the document'),
      h('p.fineprint', 'The code is asked for before the document opens at all, so a link '
        + 'forwarded by mistake shows nothing.'),
    ),
  ));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(root.querySelector('.btn-primary'));
  });
  input.focus();
}

async function open(code) {
  packet = await call(`/api/s/${token}/open`, { code });
  draw();
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function draw() {
  const pad = signaturePad();
  let agreed = false;
  let typed = '';
  let otp = '';
  let codeSent = false;

  const otpBox = h('div');

  const drawOtp = () => {
    if (!packet.emailHint) {
      mount(otpBox, null);
      return;
    }
    mount(otpBox, codeSent
      ? h('div',
        h('label.field',
          h('span', `The six-digit code we emailed to ${packet.emailHint}`),
          h('input', {
            type: 'text', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code',
            oninput: (e) => { otp = e.target.value; },
          }),
        ),
        h('button.btn-sm', { type: 'button', onclick: (e) => sendCode(e.target) }, 'Send it again'))
      : h('div',
        h('p.muted', { style: { fontSize: '.9rem' } },
          `For extra certainty we can email a one-time code to ${packet.emailHint} `
          + 'before you sign.'),
        h('button.btn-sm', { type: 'button', onclick: (e) => sendCode(e.target) },
          'Email me a code')));
  };

  const sendCode = async (button) => {
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const out = await call(`/api/s/${token}/code`, {});
      codeSent = true;
      drawOtp();
      toast(`Sent to ${out.sentTo}. It lasts fifteen minutes.`, 'good');
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
      button.textContent = 'Email me a code';
    }
  };
  drawOtp();

  const sign = async (button) => {
    if (!agreed) return toast('Tick the box first.', 'bad');
    if (!pad.isDrawn() && typed.trim().split(/\s+/).length < 2) {
      return toast('Sign with your finger, or type your full name.', 'bad');
    }

    button.disabled = true;
    button.textContent = 'Signing…';
    try {
      await call(`/api/s/${token}/sign`, {
        name: typed.trim() || packet.you.name,
        ink: pad.read(),
        hash: packet.letter.hash,
        otp: otp.trim() || undefined,
        agreed: true,
      });
      thanks();
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
      button.textContent = 'Sign this';
    }
    return undefined;
  };

  const refuse = async () => {
    const why = window.prompt('You do not have to sign. Tell the sender why, if you want to:');
    if (why === null) return;
    try {
      await call(`/api/s/${token}/decline`, { note: why });
      mount(root, shell(packet.property,
        h('div.card.card-done',
          h('div.done-mark', '×'),
          h('h2', 'Noted'),
          h('p.muted', 'Nothing has been signed. The sender has been told.'),
        )));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const readOnly = packet.you.role === 'copy';

  mount(root, shell(packet.property,
    h('div.card',
      h('h2', packet.letter.subject),
      h('p.muted',
        h('span.mono', packet.letter.reference),
        packet.letter.signedBy ? ` · signed for ${packet.property} by ${packet.letter.signedBy}` : ''),
      readOnly
        ? h('p.note-from', 'You have been sent this for information. There is nothing to sign.')
        : h('p.muted', 'Read all of it. Scroll to the bottom to sign.'),
      packet.others.length > 1 ? whoElse(packet.others) : null,
    ),

    h('div.card',
      packet.letter.source === 'uploaded'
        ? h('object.scan', { data: `/api/s/${token}/file`, type: 'application/pdf' },
          h('p.muted', 'Your browser will not show this here. ',
            h('a', { href: `/api/s/${token}/file`, target: '_blank', rel: 'noopener' },
              'Open the document'), '.'))
        : h('pre.contract-text', packet.letter.body || ''),
    ),

    packet.letter.signatureInk
      ? h('div.card',
        h('div.sig-slot',
          h('div.sig-label', `Signed for ${packet.property}`),
          h('div', { style: { position: 'relative' } },
            h('img.sig-image', { src: packet.letter.signatureInk, alt: 'signature' }),
            packet.letter.stamp ? h('img.stamp-image', { src: packet.letter.stamp, alt: 'stamp' }) : null),
          h('div.sig-name', packet.letter.signedBy || ''),
          packet.letter.signedTitle ? h('div.sig-when', packet.letter.signedTitle) : null,
        ))
      : null,

    readOnly
      ? h('div.card',
        h('p.muted', { style: { marginBottom: 0 } },
          'That is all — you can close this page.'))
      : h('div.card',
        h('h3', 'Sign here'),
        h('label.tickline',
          h('input', { type: 'checkbox', onchange: (e) => { agreed = e.target.checked; } }),
          h('span', 'I have read this document and I agree to sign it electronically. '
            + 'I understand this has the same effect as signing on paper.'),
        ),
        pad.element,
        h('label.field',
          h('span', 'Or type your full name'),
          h('input', {
            type: 'text', maxlength: 160, autocomplete: 'name', placeholder: packet.you.name,
            oninput: (e) => { typed = e.target.value; },
          }),
        ),
        otpBox,
        h('button.btn.btn-primary.btn-wide', { onclick: (e) => sign(e.target) }, 'Sign this'),
        h('button.btn-sm.btn-wide', { onclick: refuse, style: { marginTop: '.6rem' } },
          'I do not want to sign this'),
        h('p.fineprint',
          'When you sign, the time, your network address and a fingerprint of this exact '
          + 'document are recorded, so both you and the sender can show later what was agreed.'),
      ),

    h('p.fineprint',
      `This link is private to you and stops working on ${String(packet.expiresAt).slice(0, 10)}.`),
  ));
  window.scrollTo(0, 0);
}

/** Who else is on it, and where it is up to. */
function whoElse(others) {
  return h('div',
    h('h4', { style: { margin: '.8rem 0 .3rem', fontSize: '.85rem' } }, 'Everybody on this document'),
    h('ol.who-else', others.map((r) => h('li',
      h('span', r.name),
      h('span', { class: `pill ${r.status === 'signed' ? 'good' : r.status === 'declined' ? 'bad' : ''}` },
        { pending: 'not opened', opened: 'reading it', signed: 'signed', declined: 'refused', revoked: 'cancelled' }[r.status] ?? r.status),
      r.role === 'copy' ? h('small.muted', 'for information') : null,
    ))),
  );
}

function thanks() {
  mount(root, shell(packet.property,
    h('div.card.card-done',
      h('div.done-mark', '✓'),
      h('h2', 'Signed. Thank you.'),
      h('p.muted', 'The sender has a copy with the time and date on it, and a record of how it '
        + 'was signed. Ask them for one whenever you want it.'),
    ),
  ));
  window.scrollTo(0, 0);
}

function shell(property, ...children) {
  return h('div.invite-inner',
    h('header.invite-head', h('div.invite-brand', property || 'Document')),
    ...children,
  );
}

function fail(message) {
  mount(root, shell('',
    h('div.card',
      h('h2', 'This link will not open'),
      h('p', message),
      h('p.muted', 'Links are private to one person and stop working after a few weeks. '
        + 'Ask whoever sent it for a new one.'),
    ),
  ));
}

async function call(path, body, method = 'POST') {
  const response = await fetch(path, {
    method,
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  }).catch(() => null);

  if (!response) throw new Error('No connection. Check your data and try again.');

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}
