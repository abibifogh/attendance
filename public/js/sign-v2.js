import { h, mount } from './util.js';
import { signingScreen } from './signing-screen.js';

/**
 * Opening a link to a document prepared in three steps.
 *
 * Who sent it, to whom and by when, and where the code will go. Nothing of
 * the document until the code is in and they have agreed to sign
 * electronically. Then the document, with their boxes to fill.
 */

const root = document.getElementById('sign');
const GRANT = (token) => `hive-sign-${token.slice(0, 16)}`;

const dayOf = (at) => (at ? new Date(`${String(at).replace(' ', 'T').slice(0, 19)}Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';

async function call(path, body = null, { method = body ? 'POST' : 'GET', grant = null } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(grant ? { 'X-Sign-Grant': grant } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!response) throw new Error('No connection. Check your data and try again.');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

const keep = (token, grant) => { try { sessionStorage.setItem(GRANT(token), grant); } catch { /* private mode */ } };
const kept = (token) => { try { return sessionStorage.getItem(GRANT(token)); } catch { return null; } };

function shell(head, ...body) {
  document.title = head.title ? `${head.title} · to sign` : 'Document to sign';
  return h('div.sv2',
    h('header.sv2-top',
      h('span.sv2-mark', { 'aria-hidden': 'true' }),
      h('div.sv2-top-text',
        h('div.sv2-property', String(head.property ?? '').toUpperCase()),
        h('div.sv2-title', head.title ?? ''))),
    h('div.sv2-body', ...body));
}

function closed(head, title, text) {
  mount(root, shell(head, h('section.sv2-card.sv2-closed', h('h1', title), h('p', text))));
}

export async function startV2(token, head) {
  const api = `/api/s/${encodeURIComponent(token)}`;

  if (head.status === 'signed') return closed(head, 'Already signed', 'You have already signed this document. Thank you.');
  if (head.status === 'declined') return closed(head, 'You declined to sign', 'The sender has been told, with your reason.');
  if (head.copyOnly) return closed(head, 'For your information', 'You were sent this for information. There is nothing to sign.');
  if (head.notYet) return closed(head, 'Not your turn yet', 'It is not your turn to sign yet. You will get a message when it is.');

  const grant = kept(token);
  if (grant) {
    try { return await openIt(token, head, grant); } catch { /* the pass ran out: ask again */ }
  }

  const intro = h('p.sv2-lead',
    `Sent by ${head.sender || head.property} at ${head.property} for you, ${head.name}, to sign`
    + `${head.dueBy ? ` by ${dayOf(head.dueBy)}` : ''}. Reference ${head.reference}.`);
  const agree = h('input', { type: 'checkbox' });
  const consent = h('label.sv2-consent', agree,
    h('span', 'I agree to sign this document electronically, and to receive the signed copy by email.'));
  const paperNote = h('p.sv2-small', 'You can ask for a paper copy instead: reply to the message you were sent.');
  const step = h('div.sv2-step');
  const error = h('p.form-error', { hidden: true });
  const say = (message) => { error.textContent = message; error.hidden = !message; };

  const verify = async (button, code = null) => {
    if (!agree.checked) { say('Tick the box to agree to sign electronically.'); return; }
    button.disabled = true;
    say('');
    try {
      const out = await call(`${api}/verify`, { agreed: true, code });
      keep(token, out.grant);
      await openIt(token, head, out.grant);
    } catch (err) {
      say(err.message);
      button.disabled = false;
    }
  };

  const askCode = () => {
    const how = head.codeTo.how === 'text' ? 'text' : 'email';
    const send = h('button.btn.btn-primary.btn-wide', { type: 'button' }, how === 'text' ? 'Text me a code' : 'Email me a code');
    send.addEventListener('click', async () => {
      send.disabled = true;
      send.textContent = 'Sending…';
      say('');
      try {
        await call(`${api}/code`, {});
        enterCode();
      } catch (err) {
        say(err.message);
        send.disabled = false;
        send.textContent = how === 'text' ? 'Text me a code' : 'Email me a code';
      }
    });
    mount(step,
      h('p', `To check it is you, we ${how} a six-digit code to `, h('b', head.codeTo.hint), '.'),
      send);
  };

  const enterCode = () => {
    const how = head.codeTo.how === 'text' ? 'texted' : 'emailed';
    const input = h('input.sv2-code', {
      type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7,
      'aria-label': 'Six-digit code', placeholder: '••• •••',
    });
    const go = h('button.btn.btn-primary.btn-wide', { type: 'button' }, 'Continue');
    go.addEventListener('click', () => verify(go, input.value.replace(/\D/g, '')));
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
    mount(step,
      h('p', `We have ${how} a code to `, h('b', head.codeTo.hint), '. It works for 15 minutes.'),
      h('label.sv2-code-label', h('span', 'Code'), input),
      consent, paperNote, go,
      h('button.sv2-link', {
        type: 'button',
        onclick: async () => {
          try { await call(`${api}/code`, {}); say(''); input.value = ''; input.focus(); } catch (err) { say(err.message); }
        },
      }, 'Send another code'));
    input.focus();
  };

  if (head.needsCode) askCode();
  else {
    const go = h('button.btn.btn-primary.btn-wide', { type: 'button' }, 'Continue');
    go.addEventListener('click', () => verify(go));
    mount(step, consent, paperNote, go);
  }

  mount(root, shell(head,
    h('section.sv2-card',
      h('div.sv2-eyebrow', head.reference),
      h('h1', head.title),
      intro,
      h('div.sv2-rule'),
      step,
      error),
    h('p.sv2-foot', `Is this genuine? Enter ${head.reference} at ${location.host}/verify. `
      + `${head.property} will never ask for your password.`)));
}

async function openIt(token, head, grant) {
  const api = `/api/s/${encodeURIComponent(token)}`;
  const packet = await call(`${api}/open`, {}, { grant });
  const screen = await signingScreen({
    packet,
    fileUrl: packet.fileUrl,
    headers: { 'X-Sign-Grant': grant },
    submit: (body) => call(`${api}/sign`, body, { grant }),
    decline: (note) => call(`${api}/decline`, { note }, { grant }),
    onDone: (out) => done(head, out),
  });
  mount(root, shell(head, screen));
}

function done(head, out) {
  try { sessionStorage.clear(); } catch { /* nothing kept */ }
  if (out.declined) {
    return mount(root, shell(head, h('section.sv2-card.sv2-done',
      h('h1', 'You declined to sign'),
      h('p', 'The sender has been told, with your reason, so they can put it right.'),
      h('p.sv2-small', 'You can close this page.'))));
  }
  const next = (out.next ?? []).filter(Boolean);
  return mount(root, shell(head, h('section.sv2-card.sv2-done',
    h('div.done-mark', { 'aria-hidden': 'true' }, '✓'),
    h('h1', `Signed. Thank you, ${firstName(head.name)}.`),
    h('p', out.complete
      ? 'Everyone has now signed. The finished PDF, with its certificate, is on its way to you by email.'
      : `${next.length ? `${next.join(' and ')} ${next.length === 1 ? 'signs' : 'sign'} next. ` : ''}`
        + 'When everyone has signed, we email you the finished PDF, with a certificate as its last page.'),
    h('p.sv2-small', 'You can close this page.'))));
}
