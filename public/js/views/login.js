import { api } from '../api.js';
import { deriveLoginKey } from '../crypto.js';
import { h, mount } from '../util.js';
import { pinKeypad } from '../keypad.js';
import { BRAND, brandMark } from '../brand.js';

/** PIN keypad. Big targets, no keyboard needed, works with gloves on. */
export function renderLogin(onSuccess) {
  const error = h('p.muted', { style: { minHeight: '1.2rem', fontSize: '.85rem' } }, '');

  const pad = pinKeypad({
    onChange: () => { error.textContent = ''; },
    onSubmit: async (pin) => {
      error.textContent = 'Checking…';
      try {
        onSuccess(await api.login(pin));
      } catch (err) {
        error.textContent = err.message;
        pad.clear();
        pad.shake();
      }
    },
  });
  pad.listen();

  // The other way in. An administrator must have an email address and a
  // password and may also have a PIN, so both panes are theirs; the keypad
  // stays the default because far more people use it, far more often.
  const email = h('input', { type: 'email', placeholder: 'you@niceoperation.com', autocomplete: 'username' });
  const password = h('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });

  const submitPassword = async (event) => {
    if (!email.value.trim() || !password.value) {
      error.textContent = 'Enter both your email address and password';
      return;
    }
    if (event?.target) event.target.disabled = true;
    // The stretching runs here rather than on the server, and takes a moment on
    // a phone — say so rather than looking frozen.
    error.textContent = 'Checking…';
    try {
      const params = await api.passwordSalt(email.value.trim());
      const passwordKey = await deriveLoginKey(password.value, params.salt, params.iterations);
      const result = await api.loginWithKey(email.value.trim(), passwordKey);
      onSuccess(result);
    } catch (err) {
      error.textContent = err.message;
      password.value = '';
      if (event?.target) event.target.disabled = false;
    }
  };

  password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPassword({ target: null }); });

  const pinPane = h('div', pad.display, error, pad.keypad);

  const passwordPane = h('div.hidden',
    h('label.field', { style: { textAlign: 'left' } }, h('span', 'Email address'), email),
    h('label.field', { style: { textAlign: 'left' } }, h('span', 'Password'), password),
    h('button.btn-primary', { style: { width: '100%' }, onclick: submitPassword }, 'Sign in'));

  const showPin = (on) => {
    pinPane.classList.toggle('hidden', !on);
    passwordPane.classList.toggle('hidden', on);
    error.textContent = '';
    if (on) pad.listen();
    else pad.stopListening();
  };

  const modeToggle = h('div.seg', { style: { marginBottom: '.9rem' } },
    h('button', { class: 'active', onclick: (e) => { swapSeg(e); showPin(true); } }, 'PIN'),
    h('button', { onclick: (e) => { swapSeg(e); showPin(false); setTimeout(() => email.focus(), 0); } }, 'Email & password'),
  );

  function swapSeg(event) {
    for (const btn of event.target.parentElement.children) btn.classList.remove('active');
    event.target.classList.add('active');
  }

  const wrap = h('div.login-wrap',
    h('div.card.login-card',
      brandMark('3rem'),
      h('h1', BRAND.name),
      h('p.muted', { style: { marginTop: '-.2rem', fontSize: '.82rem', letterSpacing: '.02em' } },
        BRAND.full),
      h('p.muted', { style: { fontSize: '.88rem', marginBottom: '.9rem' } }, 'Sign in to continue'),

      modeToggle,
      pinPane,
      passwordPane,
    ),
  );

  // The login screen is replaced wholesale on success; drop the global listener
  // with it so keystrokes are not captured by a detached view.
  const observer = new MutationObserver(() => {
    if (!wrap.isConnected) {
      pad.stopListening();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return wrap;
}
