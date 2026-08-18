import { api, setUnauthorizedHandler } from './api.js';
import { h, mount, setCurrency, dayRange } from './util.js';
import { renderBrief } from './views/brief.js';
import { renderPnl } from './views/pnl.js';
import { renderLabour } from './views/labour.js';
import { renderDemand } from './views/demand.js';
import { renderCash } from './views/cash.js';
import { renderSuppliers } from './views/suppliers.js';
import { renderService } from './views/service.js';
import { renderFindings } from './views/findings.js';
import { renderSetup } from './views/setup.js';

export const state = {
  boot: null,
  range: { from: null, to: null },
  reload: () => {},
};

/**
 * The screens, in the order somebody grows into them.
 *
 * Brief first, because it is the one that gets opened every morning and the
 * only one most people will ever open. Setup last, because it is opened twice.
 */
const ROUTES = [
  { path: 'brief', label: 'Brief', render: renderBrief },
  { path: 'money', label: 'Money', render: renderPnl },
  { path: 'labour', label: 'Labour', render: renderLabour },
  { path: 'guests', label: 'Guests', render: renderDemand },
  { path: 'cash', label: 'Cash', render: renderCash },
  { path: 'buying', label: 'Buying', render: renderSuppliers },
  { path: 'service', label: 'Service', render: renderService },
  { path: 'findings', label: 'Findings', render: renderFindings },
  { path: 'setup', label: 'Setup', render: renderSetup },
];

const root = document.getElementById('app');

setUnauthorizedHandler(() => renderLogin());

start();

async function start() {
  const me = await api('/auth/me').catch(() => ({ signedIn: false, configured: false }));
  if (!me.signedIn) return renderLogin(me);
  return renderApp();
}

function renderLogin(me = {}) {
  const password = h('input', { type: 'password', autofocus: true, autocomplete: 'current-password' });
  const message = h('p.small', { style: { color: 'var(--critical)' } });

  mount(root, h('div.login',
    h('div.card',
      h('h1', 'Insight'),
      h('p.sub', 'The group\'s numbers, from all four systems at once.'),
      me.configured === false
        ? h('p.small', { style: { color: 'var(--critical)' } },
          'This Worker has no DASHBOARD_PASSWORD or SESSION_SECRET set, so it cannot sign anybody in. Set both with wrangler secret put and deploy again.')
        : null,
      h('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          message.textContent = '';
          try {
            await api('/auth/login', { method: 'POST', body: { password: password.value } });
            await renderApp();
          } catch (err) {
            message.textContent = err.message;
          }
        },
      },
      h('label.field', 'Password', password),
      h('button.btn.primary', { type: 'submit' }, 'Sign in')),
      message)));
}

async function renderApp() {
  const boot = await api('/bootstrap');
  state.boot = boot;
  setCurrency(boot.group.currency.symbol);

  // Default window: the last thirty days that have data, ending yesterday.
  // Today is always half-finished, and a dashboard that includes it shows
  // every line falling every morning until people stop believing it.
  const last = boot.data.lastDay || boot.group.today;
  state.range = {
    from: shift(last, -29),
    to: last,
  };

  const view = h('div');
  const rangeLabel = h('span.small.muted');

  const tabs = h('nav.tabs', ROUTES.map((route) => h('button', {
    onclick: () => go(route.path),
    dataset: { path: route.path },
  }, route.label)));

  mount(root,
    h('header.top',
      h('span.brand', boot.group.name, ' · Insight'),
      rangeLabel,
      h('span.spacer'),
      rangePicker(),
      h('button.btn', { onclick: toggleTheme, title: 'Light or dark' }, '◐'),
      h('button.btn', {
        onclick: async () => { await api('/auth/logout', { method: 'POST' }); renderLogin(); },
      }, 'Sign out')),
    tabs,
    h('main', view));

  state.reload = () => go(current());
  window.addEventListener('hashchange', () => go(current()));
  await go(current());

  function current() {
    const path = location.hash.replace(/^#\/?/, '');
    return ROUTES.some((r) => r.path === path) ? path : 'brief';
  }

  async function go(path) {
    const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
    if (location.hash !== `#/${route.path}`) location.hash = `#/${route.path}`;
    for (const button of tabs.children) {
      if (button.dataset.path === route.path) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    rangeLabel.textContent = dayRange(state.range.from, state.range.to);
    mount(view, h('p.muted', 'Reading…'));
    try {
      const fresh = h('div');
      await route.render(fresh, { range: state.range, boot });
      mount(view, fresh);
    } catch (err) {
      mount(view, h('div.card',
        h('h2', 'That did not work'),
        h('p', err.message),
        err.detail ? h('p.small.muted', err.detail) : null));
    }
  }

  function rangePicker() {
    const presets = [
      ['7 days', 7], ['30 days', 30], ['90 days', 90],
    ];
    return h('span.rangebar', { style: { margin: 0 } },
      presets.map(([label, days]) => h('button.btn', {
        onclick: () => {
          state.range = { from: shift(state.range.to, -(days - 1)), to: state.range.to };
          go(current());
        },
      }, label)));
  }
}

function shift(day, by) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

function toggleTheme() {
  const now = document.documentElement.dataset.theme;
  const next = now === 'dark' ? 'light' : now === 'light' ? '' : 'dark';
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('insight-theme', next); } catch { /* private browsing */ }
}

try {
  const saved = localStorage.getItem('insight-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* private browsing */ }
