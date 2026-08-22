import { api } from '../api.js';
import { deriveLoginKey } from '../crypto.js';
import { h, mount } from '../util.js';
import { BRAND, brandMark } from '../brand.js';

/** PIN keypad. Big targets, no keyboard needed, works with gloves on. */
export function renderLogin(onSuccess) {
  let pin = '';
  let busy = false;

  const display = h('div.pin-display', '');
  const error = h('p.muted', { style: { minHeight: '1.2rem', fontSize: '.85rem' } }, '');

  const paint = () => { display.textContent = '•'.repeat(pin.length); };

  const submit = async () => {
    if (busy || !pin) return;
    busy = true;
    error.textContent = 'Checking…';
    try {
      const result = await api.login(pin);
      onSuccess(result);
    } catch (err) {
      error.textContent = err.message;
      pin = '';
      paint();
      display.animate(
        [{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
        { duration: 180, iterations: 2 },
      );
    } finally {
      busy = false;
    }
  };

  const press = (digit) => {
    if (pin.length >= 12) return;
    pin += digit;
    paint();
    error.textContent = '';
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const keypad = h('div.keypad',
    keys.map((k) => h('button', { onclick: () => press(k) }, k)),
    h('button.btn-ghost', {
      onclick: () => { pin = pin.slice(0, -1); paint(); },
    }, '⌫'),
    h('button', { onclick: () => press('0') }, '0'),
    h('button.btn-primary', { onclick: submit }, '→'),
  );

  const onKeydown = (event) => {
    if (/^\d$/.test(event.key)) press(event.key);
    else if (event.key === 'Backspace') { pin = pin.slice(0, -1); paint(); }
    else if (event.key === 'Enter') submit();
  };
  window.addEventListener('keydown', onKeydown);

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

  const pinPane = h('div', display, error, keypad,
    h('p.muted', { style: { fontSize: '.75rem', marginTop: '1rem' } },
      'Everybody signs in with their own PIN, administrators included if they have set one.'));

  const passwordPane = h('div.hidden',
    h('label.field', { style: { textAlign: 'left' } }, h('span', 'Email address'), email),
    h('label.field', { style: { textAlign: 'left' } }, h('span', 'Password'), password),
    h('button.btn-primary', { style: { width: '100%' }, onclick: submitPassword }, 'Sign in'),
    h('p.muted', { style: { fontSize: '.75rem', marginTop: '1rem' } },
      'Administrators always have an email address and a password. It is the only way to set '
      + 'a payroll PIN.'));

  const showPin = (on) => {
    pinPane.classList.toggle('hidden', !on);
    passwordPane.classList.toggle('hidden', on);
    error.textContent = '';
    if (on) window.addEventListener('keydown', onKeydown);
    else window.removeEventListener('keydown', onKeydown);
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
      window.removeEventListener('keydown', onKeydown);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return wrap;
}
