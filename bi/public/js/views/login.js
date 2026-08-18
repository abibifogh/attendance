import { h, s, mount } from '../util.js';
import { api } from '../api.js';
import { deriveLoginKey } from '../crypto.js';

/**
 * The way in.
 *
 * It is the only screen anybody sees before they have any idea what this is, so
 * it says so — four named systems flowing into one, in the same colours the
 * rest of the app gives those systems. That is not decoration: somebody who
 * arrives at a bare password box on an unfamiliar domain does not know whether
 * they are in the right place, and a picture of the four applications they use
 * every day answers that before they read a word.
 *
 * The shared owner password no longer has a link here. It still works — an
 * owner locked out of every account needs a way back — but it is behind
 * `?recover=1` rather than sitting on the page inviting itself to be used. A
 * password from a config file is a worse credential than a person's own, and
 * offering it as an equal choice makes it the one people pick.
 */

/** The four sources, in the fixed colours the rest of the app gives them. */
const SOURCES = [
  { label: 'HIVE', colour: 'var(--series-1)', what: 'who was here' },
  { label: 'Breakfast', colour: 'var(--series-4)', what: 'guests and stock' },
  { label: 'Restaurant', colour: 'var(--series-3)', what: 'sales and cash' },
  { label: 'Laundry', colour: 'var(--series-2)', what: 'charged and collected' },
];

/**
 * Four systems converging into one.
 *
 * Hand-drawn SVG rather than an image, so it inherits the theme's own colours
 * and stays sharp at any size. The curves are the point: the whole tool is the
 * claim that these four things belong on one page.
 */
function convergence() {
  const width = 420;
  const height = 300;
  const startX = 46;
  const endX = 330;
  const midY = height / 2;
  const rows = SOURCES.map((_, i) => 44 + i * ((height - 88) / 3));

  return s('svg', {
    viewBox: `0 0 ${width} ${height}`, class: 'converge', role: 'img',
    'aria-label': 'HIVE, breakfast, the restaurant and the laundry, four separate systems, flowing together into one.',
  },
  // The paths first, so the labelled nodes sit on top of them.
  ...SOURCES.map((source, i) => s('path', {
    d: `M${startX} ${rows[i]} C ${startX + 110} ${rows[i]}, ${endX - 110} ${midY}, ${endX} ${midY}`,
    fill: 'none', stroke: source.colour, 'stroke-width': 2, 'stroke-linecap': 'round',
    opacity: 0.85, class: 'flow', style: `--i:${i}`,
  })),

  ...SOURCES.map((source, i) => s('g', { class: 'node', style: `--i:${i}` },
    s('circle', {
      cx: startX, cy: rows[i], r: 5.5, fill: source.colour,
      stroke: 'var(--surface)', 'stroke-width': 2,
    }),
    s('text', {
      x: startX - 14, y: rows[i] - 2, 'text-anchor': 'end',
      fill: 'var(--ink)', 'font-size': 12.5, 'font-weight': 600,
    }, source.label),
    s('text', {
      x: startX - 14, y: rows[i] + 13, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 10.5,
    }, source.what))),

  // Where they arrive.
  s('circle', {
    cx: endX, cy: midY, r: 15, fill: 'none',
    stroke: 'var(--series-1)', 'stroke-width': 1.5, opacity: 0.35, class: 'halo',
  }),
  s('circle', { cx: endX, cy: midY, r: 8, fill: 'var(--series-1)', class: 'core' }),
  s('text', {
    x: endX + 26, y: midY - 1, fill: 'var(--ink)', 'font-size': 13, 'font-weight': 600,
  }, 'One ledger'),
  s('text', {
    x: endX + 26, y: midY + 14, fill: 'var(--muted)', 'font-size': 10.5,
  }, 'and what it means'));
}

export function renderLogin(root, me = {}, onSignedIn) {
  // Before the first account exists there is nobody to sign in *as*, so the
  // shared password is the only way in and it is shown plainly. After that it
  // is reachable only by asking for it in the address.
  const noAccounts = me.hasAccounts === false;
  const recovery = new URLSearchParams(location.search).has('recover');
  const useShared = noAccounts || recovery;

  const email = h('input', { type: 'email', autocomplete: 'username', required: true, autofocus: !useShared });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const shared = h('input', { type: 'password', autocomplete: 'current-password', required: true, autofocus: useShared });
  const message = h('p.small.form-error');
  const button = h('button.btn.primary.wide', { type: 'submit' }, 'Sign in');

  const form = h('form.signin', {
    onsubmit: async (event) => {
      event.preventDefault();
      message.textContent = '';
      button.disabled = true;
      button.textContent = 'Signing in…';
      try {
        if (useShared) {
          await api('/auth/login', { method: 'POST', body: { password: shared.value } });
        } else {
          // The password is stretched here and never leaves this page. What
          // goes to the server is a derived key, using the salt the server
          // gives back for this address — which it answers for every address,
          // account or not, so that asking is never a way to list the staff.
          const salt = await api('/auth/salt', { method: 'POST', body: { email: email.value } });
          const passwordKey = await deriveLoginKey(password.value, salt.salt, salt.iterations);
          await api('/auth/login', { method: 'POST', body: { email: email.value, passwordKey } });
        }
        await onSignedIn();
      } catch (err) {
        message.textContent = err.message;
        button.disabled = false;
        button.textContent = 'Sign in';
      }
    },
  },
  useShared
    ? h('label.field', recovery ? 'Shared owner password' : 'Password', shared)
    : [h('label.field', 'Email address', email), h('label.field', 'Password', password)],
  button);

  mount(root, h('div.signin-page',
    h('div.signin-panel',
      h('div.signin-card',
        h('div.mark', markGlyph()),
        h('h1', 'Insight'),
        h('p.lede', noAccounts
          ? 'Nobody has an account here yet. Sign in with the shared owner password and make yourself one.'
          : recovery
            ? 'Signing in with the shared owner password. Use your own account unless you have been locked out of it.'
            : 'One sign-in, for every system the group runs.'),

        me.configured === false
          ? h('p.small.form-error',
            'This site has no password or signing key set yet, so it cannot sign anybody in. '
            + 'Run Actions → Set Insight\'s secrets, then try again.')
          : null,

        form,
        message,

        h('p.small.muted.signin-foot',
          'HIVE · Breakfast & rooms · Restaurant POS · Laundry'))),

    h('div.signin-art',
      h('div.art-inner',
        h('p.eyebrow', 'Four systems, one ledger'),
        h('h2', 'The questions that need\ntwo systems at once.'),
        convergence(),
        h('p.small.muted',
          'Is the wage bill rising because the hotel is busier, or just rising? '
          + 'Do the kitchen and the restaurant pay the same supplier the same price? '
          + 'Nothing could ask, until now.')))));
}

/** A small mark: four bars of different heights, the shape of the whole idea. */
function markGlyph() {
  return s('svg', { viewBox: '0 0 32 32', class: 'mark-svg', 'aria-hidden': 'true' },
    s('rect', { x: 2, y: 17, width: 5, height: 11, rx: 2, fill: 'var(--series-1)' }),
    s('rect', { x: 10, y: 11, width: 5, height: 17, rx: 2, fill: 'var(--series-4)' }),
    s('rect', { x: 18, y: 14, width: 5, height: 14, rx: 2, fill: 'var(--series-3)' }),
    s('rect', { x: 26, y: 5, width: 5, height: 23, rx: 2, fill: 'var(--series-2)' }));
}
