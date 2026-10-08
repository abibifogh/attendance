import { h, mount } from '../util.js';
import { api } from '../api.js';
import { prepareNewPassword } from '../crypto.js';
import { markGlyph } from './login.js';

/**
 * Where an invitation's link lands.
 *
 * The token is in the address after the #, so it never reaches a server log
 * or the Referer of anything this page loads. Every way a link can stop
 * working gets a sentence of its own and, where it helps, something to do
 * about it: an expired or replaced link can ask for a fresh one, and the owner
 * sees that request on Accounts.
 */
export async function renderJoin(root, token, onJoined) {
  const page = h('div.join-page');
  mount(root, page);
  const frame = (...children) => mount(page,
    h('div.join-card',
      h('div.join-brand', markGlyph(), h('strong', 'Insight')),
      ...children));

  frame(h('p.muted', 'Opening your invitation…'));
  let info;
  try {
    info = await api('/invite/look', { method: 'POST', body: { token } });
  } catch (err) {
    frame(h('h1', 'That link did not open'), h('p', err.message));
    return;
  }

  const first = String(info.name || '').split(/\s+/)[0];

  if (info.state === 'open') {
    const name = h('input', { type: 'text', value: info.name, autocomplete: 'name', required: true });
    const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 10 characters', required: true });
    const again = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const bar = h('i');
    const word = h('span.small.muted');
    const meter = h('div.join-meter', h('div', bar), word);
    const message = h('p.small.form-error');
    const button = h('button.btn.primary.wide', { type: 'submit' }, 'Create my account');

    const strength = () => {
      const n = password.value.length;
      const score = n === 0 ? 0 : n < 10 ? 1 : n < 14 ? 2 : 3;
      bar.style.width = `${score * 33.4}%`;
      bar.className = ['', 'weak', 'fair', 'strong'][score];
      word.textContent = ['', 'Too short', 'Good', 'Strong'][score];
    };
    password.addEventListener('input', strength);

    frame(
      h('h1', `Welcome, ${first}`),
      h('p.lede', `${info.inviter} invited you. Choose a password and you're in.`),
      h('form.signin', {
        onsubmit: async (event) => {
          event.preventDefault();
          message.textContent = '';
          if (password.value.length < 10) { message.textContent = 'Use at least 10 characters. A short sentence is easy to remember.'; return; }
          if (password.value !== again.value) { message.textContent = "The two passwords don't match."; return; }
          button.disabled = true;
          button.textContent = 'Setting it up…';
          try {
            // Stretched here; the password itself never leaves this page.
            const derived = await prepareNewPassword(password.value);
            await api('/invite/accept', { method: 'POST', body: { token, name: name.value, ...derived } });
            done(name.value);
          } catch (err) {
            message.textContent = err.message;
            button.disabled = false;
            button.textContent = 'Create my account';
          }
        },
      },
      h('label.field', 'Your name', name),
      h('div.field', 'Email address',
        h('div.join-fixed', info.email),
        h('span.small.muted', 'This is where the invitation went, so it stays.')),
      h('label.field', 'Choose a password', password),
      meter,
      h('label.field', 'Type it again', again),
      message,
      button),
      h('div.join-what',
        h('p.eyebrow', "What you'll see"),
        h('p', h('strong', info.level), ': ', info.levelNote),
        info.others?.length ? h('p', 'From the hub, without signing in again: ', h('strong', info.others.join(', '))) : null,
        h('p.small.muted', `${info.inviter} can change this later. Insight keeps only a scrambled copy of your password.`)));
    return;
  }

  function done(who) {
    frame(
      h('div.join-tick', '✓'),
      h('h1', `You're in, ${String(who).split(/\s+/)[0]}`),
      h('p', `Your account is ready and you're signed in. Next time, sign in with ${info.email} and the password you just chose.`),
      h('p.muted', `${info.inviter} has been told you've joined.`),
      h('button.btn.primary.wide', { onclick: () => onJoined() }, 'Open Insight'));
  }

  const ended = {
    expired: ['This invitation has expired', `${info.inviter} sent it on ${info.sentOn}, and invitations last 7 days. Nothing is wrong; it just needs a fresh link.`],
    replaced: ['This link has been replaced', `${info.inviter} sent you a newer invitation, so this one stopped working. Use the most recent email.`],
    used: ['This invitation has already been used', `The account for ${info.email} is set up. Sign in instead; if that wasn't you, tell ${info.inviter}.`],
    withdrawn: ['This invitation was withdrawn', `${info.inviter} cancelled it. If you think that was a mistake, ask them directly.`],
    unknown: ['That link does not work', 'It may have been copied only in part. Open it again from the email, or ask whoever invited you for a new one.'],
  }[info.state] || ['That link does not work', ''];

  const asked = (already) => frame(
    h('div.join-clock', '⏱'),
    h('h1', ended[0]),
    h('p', ended[1]),
    h('div.join-done', already ? `Already asked. A new link will come to ${info.email}.` : `Asked. A new link will come to ${info.email}.`),
    h('p.small.muted', 'You can close this page. The new email replaces this one.'));

  if (info.canAsk && info.asked) return asked(true);

  const askButton = info.canAsk ? h('button.btn.primary.wide', {
    onclick: async (event) => {
      event.target.disabled = true;
      try {
        const out = await api('/invite/ask', { method: 'POST', body: { token } });
        asked(out.already);
      } catch (err) { alert(err.message); event.target.disabled = false; }
    },
  }, `Ask ${info.inviter} for a new link`) : null;

  frame(
    h('div.join-clock', '⏱'),
    h('h1', ended[0]),
    h('p', ended[1]),
    askButton,
    info.canAsk ? h('p.small.muted', `${info.inviter} gets an email and can resend it from Accounts with one tap.`) : null,
    info.state === 'used' ? h('button.btn.primary.wide', { onclick: () => onJoined() }, 'Go to sign in') : null);
}
