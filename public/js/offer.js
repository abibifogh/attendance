import { h, mount, toast } from './util.js';
import { signaturePad } from './fields.js';

/**
 * A job offer, opened on the candidate's phone.
 *
 * Its own entry point, like the interview and signing pages: the person
 * holding this link does not work here yet, has no account, and should reach
 * nothing but the offer it was made for.
 *
 * Four screens. The offer: the job, the terms and a look at the contract.
 * The contract in full, with the signature at the foot of it, because what
 * makes an electronic signature stand up is that the words were shown before
 * it. Then either "Offer accepted" or a short form to decline.
 */

const root = document.getElementById('offer');
const token = tokenFrom(location.pathname, 'o');
const api = `/api/o/${encodeURIComponent(token)}`;
let packet = null;

function tokenFrom(pathname, prefix) {
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf(prefix);
  if (at === -1 || at === parts.length - 1) return '';
  try { return decodeURIComponent(parts[at + 1]); } catch { return parts[at + 1]; }
}

const longDay = (day) => (day ? new Date(`${String(day).slice(0, 10)}T12:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '');
const stamp = (at) => (at ? new Date(`${String(at).replace(' ', 'T').slice(0, 19)}Z`)
  .toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '');

async function call(path, body = null, method = body ? 'POST' : 'GET') {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!response) throw new Error('No connection. Check your data and try again.');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

/**
 * The contract's words, set for a phone.
 *
 * Templates are written with hard line breaks at eighty characters, which on
 * a narrow screen wrap twice and read as ragged half-lines. For reading, the
 * lines of a paragraph are joined again, except where a line starts a new
 * clause. The words themselves are untouched: what was signed, and its
 * fingerprint, are the stored text exactly.
 */
const CLAUSE = /^\s*(\d+(\.\d+)*\.?|\([a-z0-9]+\)|[a-z]\)|[-•*])\s/i;
function contractText(text) {
  return h('div.contract-flow', String(text ?? '').split(/\n\s*\n/).map((para) => {
    const lines = para.split('\n');
    const out = [];
    for (const line of lines) {
      const before = out.length ? out[out.length - 1].trim() : '';
      const alone = (text) => /^[A-Z0-9 ,.'"&()\-]{3,}$/.test(text) || /:$/.test(text) || /^[._\s-]{4,}$/.test(text);
      if (!out.length || CLAUSE.test(line) || alone(before) || /^[._\s-]{4,}$/.test(line.trim())) out.push(line.trim());
      else out[out.length - 1] += ` ${line.trim()}`;
    }
    return h('p', out.join('\n'));
  }));
}

function shell(property, subtitle, ...body) {
  return h('div.sv2.offer',
    h('header.sv2-top.no-print',
      h('span.sv2-mark', { 'aria-hidden': 'true' }),
      h('div.sv2-top-text',
        h('div.sv2-property', String(property ?? '').toUpperCase()),
        h('div.sv2-title', subtitle))),
    h('div.sv2-body', ...body));
}

function closed(property, title, text) {
  mount(root, shell(property, 'Your job offer', h('section.sv2-card.sv2-closed', h('h1', title), h('p', text))));
}

start();

async function start() {
  if (!token) return closed('', 'This link will not open', 'The address is missing the long code that makes it yours. Go back to the message and tap the link itself.');
  try {
    const head = await call(api);
    if (head.state === 'declined') {
      return closed(head.property, 'You declined the offer', `${head.property} has been told. Nothing was signed. Thank you for your time.`);
    }
    packet = await call(`${api}/open`, {});
    if (packet.state === 'accepted') return accepted();
    if (packet.state === 'expired') {
      return closed(packet.property, 'This offer has closed',
        `It was open until ${longDay(packet.replyBy)}. Ask ${packet.property} whether it still stands.`);
    }
    return showOffer();
  } catch (err) {
    return closed('', 'This link will not open', err.message);
  }
}

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

function showOffer() {
  const p = packet;
  mount(root, shell(p.property, 'Your job offer',
    h('section.sv2-card',
      h('h1', `${p.jobTitle} at ${p.property}`),
      h('p.sv2-lead', `Offered to you, ${p.name}${p.from ? `, by ${p.from}` : ''}. Please reply by ${longDay(p.replyBy)}.`),
      p.message ? h('blockquote.offer-note', p.message, p.from ? h('span', p.from) : null) : null,
      h('dl.offer-facts', ...p.terms.flatMap(([k, v]) => [h('dt', k), h('dd', v)]))),
    h('section.sv2-card',
      h('div.offer-row', h('h2', 'The contract'),
        h('button.sv2-link', { type: 'button', onclick: () => { showContract(); setTimeout(() => window.print(), 300); } }, 'Print or save it')),
      h('div.offer-preview', { 'aria-hidden': 'true' }, contractText(p.body.slice(0, 900))),
      h('button.sv2-link', { type: 'button', onclick: showContract }, 'Read all of it')),
    h('div.offer-actions',
      h('button.btn.btn-primary.btn-wide', { type: 'button', onclick: showContract }, 'Accept and sign'),
      h('button.btn.btn-wide', { type: 'button', onclick: showDecline }, 'Decline the offer')),
    h('p.sv2-foot', `Questions first? Reply to the message you were sent, or call ${p.property}.`)));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Reading and signing
// ---------------------------------------------------------------------------

/**
 * The contract in full, and the signature under it.
 *
 * A dark bar stays at the bottom with what is left to do (tick the box, the
 * code, the signature) and a button that goes to the next one, and becomes
 * "Accept the offer and sign" once nothing is left.
 */
function showContract() {
  const p = packet;
  const needCode = Boolean(p.signCode?.required && !p.signCode.verified);
  const pad = signaturePad({ height: 150 });
  let codeSent = false;

  const agree = h('input', { type: 'checkbox' });
  const consentBox = h('label.sv2-consent.offer-step',
    agree,
    h('span', 'I have read this contract. I accept the offer and agree to sign it electronically, '
      + 'which has the same effect as signing on paper.'));

  const codeInput = h('input.sv2-code', {
    type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7,
    'aria-label': 'Six-digit code', placeholder: '••• •••',
  });
  const codeBox = h('div.offer-step.sign-code');
  const drawCode = () => {
    if (!needCode) { mount(codeBox, null); codeBox.hidden = true; return; }
    const send = h(codeSent ? 'button.sv2-link' : 'button.btn.btn-wide', { type: 'button' },
      codeSent ? 'Send another code' : 'Send me a code');
    send.addEventListener('click', async () => {
      send.disabled = true;
      try {
        const out = await call(`${api}/code`, {});
        codeSent = true;
        drawCode();
        toast(`Sent to ${out.sentTo}. It lasts fifteen minutes.`, 'good');
        codeInput.focus();
      } catch (err) { toast(err.message, 'bad'); send.disabled = false; }
    });
    mount(codeBox,
      h('p', 'To check it is you, we send a six-digit code to ', h('b', p.signCode.hint), '.'),
      codeSent ? h('label.sv2-code-label', h('span', 'Code'), codeInput) : null,
      send);
  };
  drawCode();

  const typed = h('input', { type: 'text', maxlength: 120, autocomplete: 'name', placeholder: p.name });
  const signBox = h('div.offer-step',
    h('h3', 'Your signature'),
    pad.element,
    h('label.field', h('span', 'Or type your full name'), typed));

  const left = () => [
    !agree.checked ? { el: consentBox, say: 'Tick the box' } : null,
    needCode && !codeInput.value.replace(/\D/g, '') ? { el: codeBox, say: codeSent ? 'Enter the code' : 'Ask for a code' } : null,
    !pad.isDrawn() && typed.value.trim().split(/\s+/).length < 2 ? { el: signBox, say: 'Sign' } : null,
  ].filter(Boolean);

  const count = h('span.offer-bar-count');
  const go = h('button.btn.btn-primary', { type: 'button' });
  const bar = h('div.offer-bar.no-print',
    h('div.offer-bar-text', count, h('span.offer-bar-who', `Signing as ${p.name}`)),
    h('div.offer-bar-buttons',
      h('button.btn', { type: 'button', onclick: showOffer }, 'Back'),
      go));
  const refresh = () => {
    const todo = left();
    count.textContent = todo.length ? `${todo.length} ${todo.length === 1 ? 'thing' : 'things'} left` : 'Ready to sign';
    go.textContent = todo.length ? 'Next' : 'Accept the offer and sign';
  };
  for (const el of [agree, codeInput, typed]) el.addEventListener('input', refresh);
  agree.addEventListener('change', refresh);
  for (const ev of ['pointerup', 'touchend', 'mouseup']) pad.element.addEventListener(ev, () => setTimeout(refresh, 0));

  go.addEventListener('click', async () => {
    const todo = left();
    if (todo.length) {
      todo[0].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      todo[0].el.classList.add('offer-flash');
      setTimeout(() => todo[0].el.classList.remove('offer-flash'), 1200);
      return;
    }
    go.disabled = true;
    go.textContent = 'Signing…';
    try {
      await call(`${api}/accept`, {
        agreed: true,
        name: typed.value.trim() || p.name,
        ink: pad.read(),
        hash: p.hash,
        otp: codeInput.value.replace(/\D/g, '') || undefined,
      });
      packet = await call(`${api}/open`, {});
      accepted(true);
    } catch (err) {
      toast(err.message, 'bad');
      go.disabled = false;
      refresh();
    }
  });

  mount(root, shell(p.property, p.title,
    h('section.offer-paper', contractText(p.body)),
    h('section.sv2-card.offer-sign.no-print',
      h('h2', 'Accept and sign'),
      consentBox,
      codeBox,
      signBox,
      h('p.fineprint', 'When you sign, the time, your network address and a fingerprint of these exact words '
        + 'are recorded, so both you and the property can show later what was agreed.')),
    bar));
  refresh();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Afterwards
// ---------------------------------------------------------------------------

function accepted(justNow = false) {
  const p = packet;
  const step = (n, done, title, detail) => h('li', { class: done ? 'done' : '' },
    h('span.offer-tick', done ? '✓' : String(n)),
    h('span', h('b', title), h('br'), h('small', detail)));
  mount(root, shell(p.property, 'Your job offer',
    h('section.sv2-card',
      h('span.offer-yes', { 'aria-hidden': 'true' }, '✓'),
      h('h1', `Offer accepted. Welcome, ${p.firstName}.`),
      h('p.sv2-lead', `You signed the contract for ${p.jobTitle}${p.signedAt ? ` on ${stamp(p.signedAt)}` : ''}. `
        + `${p.property} has been told.`)),
    h('section.sv2-card',
      h('ol.offer-steps',
        step(1, true, 'You signed', p.signerCheck && p.signerCheck !== 'offer link' ? `With a code sent by ${p.signerCheck.replace(' code', '')}` : 'From your own link'),
        step(2, false, `${p.property} countersigns`, 'When they put you on the books, before you start'),
        step(3, false, 'Your signed copy arrives by email', p.signedTo ? `The PDF, signed by both sides, to ${p.signedTo}` : 'Ask the office for a copy whenever you want one'),
        step(4, false, `Your first day: ${longDay(p.startDate)}`, 'Details of your first week follow before then'))),
    h('div.offer-actions',
      h('button.btn.btn-wide', { type: 'button', onclick: () => { showSigned(); setTimeout(() => window.print(), 300); } }, 'Print or save what you signed')),
    h('p.sv2-foot', 'This link keeps working, so you can come back to read the contract again.')));
  if (justNow) toast('Signed. Thank you.', 'good');
  window.scrollTo(0, 0);
}

/** The contract as signed, for printing. */
function showSigned() {
  const p = packet;
  mount(root, shell(p.property, p.title,
    h('section.offer-paper', contractText(p.body),
      h('p.offer-signed', `Signed by ${p.signerName}${p.signedAt ? `, ${stamp(p.signedAt)}` : ''}.`)),
    h('div.offer-actions.no-print', h('button.btn.btn-wide', { type: 'button', onclick: () => accepted() }, 'Back'))));
}

function showDecline() {
  const p = packet;
  let reason = p.declineReasons[0]?.key ?? null;
  const options = p.declineReasons.map((r, i) => h('label.offer-option',
    h('input', { type: 'radio', name: 'reason', value: r.key, checked: i === 0, onchange: () => { reason = r.key; } }),
    h('span', r.label)));
  const note = h('textarea', { rows: 3, maxlength: 600 });
  const send = h('button.btn.btn-danger.btn-wide', { type: 'button' }, 'Decline the offer');
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await call(`${api}/decline`, { reason, note: note.value.trim() });
      closed(p.property, 'You declined the offer',
        `${p.property} has been told. Nothing was signed, and this link now only shows this message. Thank you for your time, ${p.firstName}.`);
    } catch (err) {
      toast(err.message, 'bad');
      send.disabled = false;
    }
  });
  mount(root, shell(p.property, 'Your job offer',
    h('section.sv2-card',
      h('h1', 'Decline the offer?'),
      h('p.sv2-lead', `${p.jobTitle}, starting ${longDay(p.startDate)}. Telling ${p.property} why helps, but it is up to you.`),
      h('div.offer-options', { role: 'radiogroup', 'aria-label': 'Why' }, ...options),
      h('label.field', h('span', 'Anything to add (optional)'), note)),
    h('div.offer-actions',
      send,
      h('button.btn.btn-wide', { type: 'button', onclick: showOffer }, 'Go back to the offer'))));
  window.scrollTo(0, 0);
}
