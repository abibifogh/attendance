import { h, mount, toast } from './util.js';
import { prepareNewPassword } from './crypto.js';

/**
 * Setting up the login somebody has been given.
 *
 * Its own entry point, sharing nothing with the office app but the stylesheet
 * and two helpers. It is opened by a person with no session at all, on a
 * phone, from a link in their email, and the less of the system it can reach
 * the better. Three things happen here and nothing else: read who the
 * invitation is for, pick a way in, set it.
 *
 * THE CHOICE IS THE POINT. A housekeeper working off a tablet in a corridor
 * wants six digits she can key with one hand. Whoever does the wages wants an
 * address and a password their browser already fills in. Neither is right for
 * the other, and nobody here is in a position to know which of them the person
 * reading this is. So the page asks, and it asks in plain terms rather than
 * naming credentials: "a short number" and "an email address and a password".
 */

const root = document.getElementById('join');
const token = tokenFrom(location.pathname, 'j');

/**
 * The token, from the segment after `/j/`.
 *
 * Found by its prefix rather than by stripping the front or taking the last
 * segment. The address links are built from is a setting somebody typed once
 * and may have a path in it, and an address that lost its token on the way
 * here is a different problem from a dead link — telling somebody the wrong
 * one sends them to ask for a replacement that fails in exactly the same way.
 */
function tokenFrom(pathname, prefix) {
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf(prefix);
  if (at === -1 || at === parts.length - 1) return '';
  try {
    return decodeURIComponent(parts[at + 1]);
  } catch {
    return parts[at + 1];
  }
}

let packet = null;

start();

async function start() {
  if (!token) {
    fail('The address is missing its code. Open the link from your email again rather than '
      + 'typing it, and if it still will not open, ask for another.');
    return;
  }
  try {
    const response = await fetch(`/api/j/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(body.error || 'This link will not open. Ask whoever set your account up for another.');
      return;
    }
    packet = body;
    draw();
  } catch {
    fail('There is no connection to the server. Try again when you have a signal.');
  }
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

function draw() {
  const ways = packet.ways ?? ['pin'];
  mount(root, shell(packet.property,
    h('div.card',
      h('h2', `Hello ${packet.name}`),
      h('p', 'An account has been made for you. Choose how you would like to sign in. '
        + 'You can change it later, and whoever set the account up never sees what you pick.'),
      h('div.join-ways',
        ways.includes('pin')
          ? h('button.join-way', { onclick: () => pinForm() },
            h('span.join-way-mark', '⌨'),
            h('span',
              h('strong', 'A short number'),
              h('small', 'Six to ten digits. Quickest on a phone or the tablet by the door.')))
          : null,
        ways.includes('password')
          ? h('button.join-way', { onclick: () => passwordForm() },
            h('span.join-way-mark', '🔒'),
            h('span',
              h('strong', 'An email address and a password'),
              h('small', ways.length > 1
                ? 'Better on a computer, and your browser can remember it.'
                : 'This account signs in with a password.')))
          : null),
    ),
  ));
  window.scrollTo(0, 0);
}

function pinForm() {
  const pin = h('input', {
    type: 'password', inputmode: 'numeric', maxlength: 10, autocomplete: 'new-password',
    placeholder: 'Six to ten digits',
  });
  const again = h('input', {
    type: 'password', inputmode: 'numeric', maxlength: 10, autocomplete: 'new-password',
    placeholder: 'The same again',
  });
  const error = h('p.field-error');

  const save = async () => {
    error.textContent = '';
    if (pin.value !== again.value) { error.textContent = 'The two do not match.'; return; }
    await send({ way: 'pin', pin: pin.value.trim() }, error);
  };

  mount(root, shell(packet.property,
    h('div.card',
      back(),
      h('h2', 'Choose your number'),
      h('p.muted', 'Nobody else is told it. Do not use your year of birth, and do not use '
        + 'anything anybody could read over your shoulder in one go.'),
      h('label.field', h('span', 'Your number'), pin),
      h('label.field', h('span', 'Type it again'), again),
      error,
      h('button.btn.btn-primary.btn-wide', { onclick: save }, 'That is my number'),
    ),
  ));
  window.scrollTo(0, 0);
  pin.focus();
}

function passwordForm() {
  const least = packet.leastPassword ?? 10;
  const word = h('input', {
    type: 'password', maxlength: 200, autocomplete: 'new-password',
    placeholder: `At least ${least} characters`,
  });
  const again = h('input', {
    type: 'password', maxlength: 200, autocomplete: 'new-password',
    placeholder: 'The same again',
  });
  const error = h('p.field-error');

  const save = async () => {
    error.textContent = '';
    if (word.value.length < least) {
      error.textContent = `Your password has to be at least ${least} characters.`;
      return;
    }
    if (/^\d+$/.test(word.value)) {
      error.textContent = 'All digits is a PIN rather than a password. Put some words in it.';
      return;
    }
    if (word.value !== again.value) { error.textContent = 'The two do not match.'; return; }
    // Stretched here. The password itself never leaves this phone — see the
    // note at the top of crypto.js.
    const stretched = await prepareNewPassword(word.value);
    await send({ way: 'password', ...stretched }, error);
  };

  mount(root, shell(packet.property,
    h('div.card',
      back(),
      h('h2', 'Choose your password'),
      h('p.muted', `You will sign in with ${packet.email} and this password. `
        + 'Three words you will remember beat one clever one.'),
      h('label.field', h('span', 'Your password'), word),
      h('label.field', h('span', 'Type it again'), again),
      error,
      h('button.btn.btn-primary.btn-wide', { onclick: save }, 'That is my password'),
    ),
  ));
  window.scrollTo(0, 0);
  word.focus();
}

/**
 * Send it, and go straight into the app.
 *
 * The server signs them in as part of setting this, so there is no login
 * screen in between. Making somebody choose a number and then immediately
 * type it into a box is a step that exists only because it was easier to
 * build.
 */
async function send(body, error) {
  try {
    const response = await fetch(`/api/j/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const said = await response.json().catch(() => ({}));
    if (!response.ok) {
      error.textContent = said.error || 'That did not save. Try again.';
      return;
    }
    done(said);
  } catch {
    error.textContent = 'There is no connection to the server. Try again when you have a signal.';
  }
}

function done(said) {
  toast('You are in.', 'good');
  mount(root, shell(packet.property,
    h('div.card.card-done',
      h('div.done-mark', '✓'),
      h('h2', 'That is set'),
      h('p.muted', said.way === 'pin'
        ? 'From now on you sign in with your number. Keep it to yourself.'
        : `From now on you sign in with ${packet.email} and your password.`),
      h('a.btn.btn-primary.btn-wide', { href: '/' }, 'Open HIVE'),
    ),
  ));
  window.scrollTo(0, 0);
  // Straight in, without asking them to press anything. The button above is
  // for the browser that blocks this.
  setTimeout(() => { window.location.href = '/'; }, 1200);
}

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

function shell(property, ...children) {
  return h('div.invite-inner',
    h('header.invite-head', h('div.invite-brand', property || 'Staff')),
    ...children,
  );
}

const back = () => h('button.btn-sm.invite-back', { onclick: draw }, '‹ Back');

function fail(message) {
  mount(root, shell('',
    h('div.card',
      h('h2', 'This link will not open'),
      h('p', message),
    ),
  ));
}
