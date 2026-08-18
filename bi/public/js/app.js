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
import { renderHub } from './views/hub.js';
import { renderAccounts } from './views/accounts.js';
import { renderLogin as renderLoginView } from './views/login.js';

export const state = {
  boot: null,
  me: null,
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
  // The hub first, and reachable by everybody who can sign in at all. For most
  // people it is the only screen here they will ever open: it is how they get
  // into the four systems they actually work in.
  { path: 'hub', label: 'Hub', render: renderHub, needs: 'session' },
  { path: 'brief', label: 'Brief', render: renderBrief, needs: 'insight' },
  { path: 'money', label: 'Money', render: renderPnl },
  { path: 'labour', label: 'Labour', render: renderLabour },
  { path: 'guests', label: 'Guests', render: renderDemand },
  { path: 'cash', label: 'Cash', render: renderCash },
  { path: 'buying', label: 'Buying', render: renderSuppliers },
  { path: 'service', label: 'Service', render: renderService },
  { path: 'findings', label: 'Findings', render: renderFindings, needs: 'insight' },
  { path: 'accounts', label: 'Accounts', render: renderAccounts, needs: 'owner' },
  { path: 'setup', label: 'Setup', render: renderSetup, needs: 'owner' },
];

/** Everything on the reports side needs the reports grant. */
for (const route of ROUTES) if (!route.needs) route.needs = 'insight';

function allowed(route) {
  const me = state.me?.account;
  if (!me) return false;
  if (route.needs === 'session') return true;
  if (me.isOwner || me.bootstrap) return true;
  if (route.needs === 'owner') return false;
  return me.canSeeReports === true;
}

const root = document.getElementById('app');

setUnauthorizedHandler(() => renderLogin());

start();

async function start() {
  const me = await api('/auth/me').catch(() => ({ signedIn: false, configured: false }));
  state.me = me;
  if (!me.signedIn) return renderLogin(me);
  return renderApp();
}

function renderLogin(me = {}) {
  renderLoginView(root, me, async () => {
    state.me = await api('/auth/me');
    await renderApp();
  });
}

async function renderApp() {
  state.me = state.me?.account ? state.me : await api('/auth/me');
  const visible = ROUTES.filter(allowed);

  // Somebody who only has the hub must not be blocked by a warehouse that has
  // never been loaded, so the reports bootstrap is only fetched by people who
  // can actually see reports — and a failure there costs the reports, not the
  // front door.
  let boot = null;
  if (visible.some((r) => r.needs === 'insight')) {
    boot = await api('/bootstrap').catch(() => null);
  }
  boot = boot ?? {
    group: { name: 'Nice Operation', currency: { symbol: 'GH₵' }, today: new Date().toISOString().slice(0, 10) },
    data: { lastDay: null }, sources: [], lastRun: null, lines: [], demoMode: false,
  };
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
  const picker = rangePicker();

  const tabs = h('nav.tabs', visible.map((route) => h('button', {
    onclick: () => go(route.path),
    dataset: { path: route.path },
  }, route.label)));

  mount(root,
    h('header.top',
      h('span.brand', boot.group.name, ' · Insight'),
      rangeLabel,
      h('span.spacer'),
      h('span.small.muted', state.me.account?.name || ''),
      picker,
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
    if (visible.some((r) => r.path === path)) return path;
    // The hub for anybody whose account is only a way into the other systems;
    // the brief for anybody who came here for the numbers.
    return visible.some((r) => r.path === 'brief') ? 'brief' : 'hub';
  }

  async function go(path) {
    const route = visible.find((r) => r.path === path) || visible[0];
    if (location.hash !== `#/${route.path}`) location.hash = `#/${route.path}`;
    for (const button of tabs.children) {
      if (button.dataset.path === route.path) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    // The window means nothing on the hub or the accounts screen, so neither
    // the label nor the picker appears there.
    const windowed = route.needs === 'insight';
    rangeLabel.textContent = windowed ? dayRange(state.range.from, state.range.to) : '';
    if (picker) picker.style.display = windowed ? '' : 'none';
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
    if (!visible.some((r) => r.needs === 'insight')) return null;
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
