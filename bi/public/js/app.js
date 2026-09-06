import { api, setUnauthorizedHandler } from './api.js';
import { h, mount, setCurrency, dayRange } from './util.js';
import { renderBrief } from './views/brief.js';
import { renderPnl } from './views/pnl.js';
import { renderFinancials } from './views/financials.js';
import { renderLabour } from './views/labour.js';
import { renderDemand } from './views/demand.js';
import { renderCash } from './views/cash.js';
import { renderSuppliers } from './views/suppliers.js';
import { renderBooks } from './views/books.js';
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
  { path: 'yardstick', label: 'Yardstick', render: renderFinancials },
  { path: 'labour', label: 'Labour', render: renderLabour },
  { path: 'guests', label: 'Guests', render: renderDemand },
  { path: 'cash', label: 'Cash', render: renderCash },
  { path: 'buying', label: 'Buying', render: renderSuppliers },
  { path: 'books', label: 'Books', render: renderBooks },
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
  state.range = rangeFromHash(boot) || { from: shift(last, -29), to: last };

  const view = h('div');
  // The picker's own button says which days are on screen, so the label that
  // used to sit beside the name would now be the same sentence twice.
  const picker = rangePicker();

  const tabs = h('nav.tabs', visible.map((route) => h('button', {
    onclick: () => go(route.path),
    dataset: { path: route.path },
  }, route.label)));

  mount(root,
    h('header.top',
      h('span.brand', boot.group.name, ' · Insight'),
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
    const path = location.hash.replace(/^#\/?/, '').split('?')[0];
    if (visible.some((r) => r.path === path)) return path;
    // The hub for anybody whose account is only a way into the other systems;
    // the brief for anybody who came here for the numbers.
    return visible.some((r) => r.path === 'brief') ? 'brief' : 'hub';
  }

  async function go(path) {
    const route = visible.find((r) => r.path === path) || visible[0];
    // The window rides in the address, so a reload keeps it and a link to a
    // screen is a link to the days somebody was actually looking at.
    const want = route.needs === 'insight'
      ? `#/${route.path}?from=${state.range.from}&to=${state.range.to}`
      : `#/${route.path}`;
    if (location.hash !== want) location.hash = want;
    for (const button of tabs.children) {
      if (button.dataset.path === route.path) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    // The window means nothing on the hub or the accounts screen, so neither
    // the label nor the picker appears there.
    const windowed = route.needs === 'insight';
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

  /**
   * The window every screen is read over.
   *
   * A button that says what the range is, opening a panel of the ranges people
   * actually ask for and two boxes for the one they ask for that nobody
   * anticipated. It is a panel rather than a row of buttons in the header
   * because the header already carries five things and a phone has to fit them
   * all; and because the useful presets are now six, which is a row too many.
   *
   * The calendar months are not decoration. The Yardstick's forecast only runs
   * on a whole calendar month — a projection to the end of a period that is not
   * a month is a projection to an arbitrary date — and before this there was no
   * way to select one.
   */
  function rangePicker() {
    if (!visible.some((r) => r.needs === 'insight')) return null;

    const first = boot.data.firstDay || '2000-01-01';
    const today = boot.group.today;
    const summary = h('summary.btn');
    const from = h('input', { type: 'date', min: first, max: today, id: 'range-from' });
    const to = h('input', { type: 'date', min: first, max: today, id: 'range-to' });
    const said = h('p.small.muted');
    const box = h('details.rangemenu', summary,
      h('div.rangepanel',
        h('div.rangepresets',
          ...[['7 days', 7], ['30 days', 30], ['90 days', 90], ['365 days', 365]].map(([label, days]) =>
            h('button.btn', { onclick: () => apply(shift(lastReadable(), -(days - 1)), lastReadable()) }, label)),
          ...[['This month', 0], ['Last month', -1]].map(([label, offset]) => {
            const span = monthOf(today, offset);
            return h('button.btn', {
              // This month stops at the last day worth reading rather than at
              // the 31st, so "this month" on the 8th is eight days and not a
              // month with three weeks of nothing dragging every average down.
              onclick: () => apply(span.from, offset === 0 ? minDay(span.to, lastReadable()) : span.to),
            }, label);
          })),
        h('div.rangecustom',
          h('label.field', 'From', from),
          h('label.field', 'To', to),
          h('button.btn.primary', {
            onclick: () => {
              if (!from.value || !to.value) { say('Both dates, please.'); return; }
              // Backwards is a slip, not an error worth refusing. It is turned
              // round and said out loud, which teaches the box in a way a red
              // message telling somebody to try again does not.
              const backwards = from.value > to.value;
              const a = backwards ? to.value : from.value;
              const b = backwards ? from.value : to.value;
              apply(a, b, backwards ? 'Those were the wrong way round, so they have been swapped.' : '');
            },
          }, 'Show these days')),
        said));

    box.addEventListener('toggle', () => { if (box.open) refresh(); });
    // A panel that stays open behind the screen it just changed is a panel
    // somebody closes by clicking the thing they were trying to read.
    document.addEventListener('click', (event) => {
      if (box.open && !box.contains(event.target)) box.open = false;
    });

    refresh();
    return box;

    function say(text) { said.textContent = text; }

    /** The last day worth reading: never today, never past what was loaded. */
    function lastReadable() {
      return minDay(boot.data.lastDay || shift(today, -1), shift(today, -1));
    }

    function refresh() {
      summary.textContent = dayRange(state.range.from, state.range.to);
      from.value = state.range.from;
      to.value = state.range.to;
      say(state.range.to >= today
        ? 'This range includes today, which is only half a day. Every line will look low.'
        : '');
    }

    function apply(a, b, note = '') {
      state.range = { from: a, to: b };
      refresh();
      if (note) say(note);
      else box.open = false;
      go(current());
    }
  }

}

/** The earlier of two days. */
function minDay(a, b) { return a < b ? a : b; }

/**
 * A whole calendar month, `offset` months from the one `day` falls in.
 *
 * Month arithmetic by string rather than by Date, because `setMonth` on the
 * 31st of a month walks into the next one — asking for "last month" on 31
 * March gives 3 March — and every version of that bug looks like a data
 * problem rather than a calendar one.
 */
function monthOf(day, offset = 0) {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7)) - 1 + offset;
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end) };
}

/**
 * The window named in the address, if it names one and it is real.
 *
 * Anything malformed is ignored rather than repaired: a link with half a date
 * in it should open on the ordinary default, not on a window somebody could
 * mistake for the one they were sent.
 */
function rangeFromHash(boot) {
  const at = location.hash.indexOf('?');
  if (at < 0) return null;
  const params = new URLSearchParams(location.hash.slice(at + 1));
  const from = params.get('from');
  const to = params.get('to');
  const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
  if (!isDay(from) || !isDay(to)) return null;
  // Deliberately not checked against what the warehouse holds. Asking for days
  // with nothing in them is a reasonable thing to do — it is how somebody finds
  // out a range was never loaded — and the screens say so plainly. Quietly
  // substituting a different window would leave the address naming January
  // while the page showed August, which is the one outcome worse than empty.
  return from <= to ? { from, to } : { from: to, to: from };
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
