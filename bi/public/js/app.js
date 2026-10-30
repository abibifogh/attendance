import { api, setUnauthorizedHandler } from './api.js';
import { h, mount, setCurrency, dayRange } from './util.js';
import { renderBrief } from './views/brief.js';
import { renderPnl } from './views/pnl.js';
import { renderFinancials } from './views/financials.js';
import { renderLabour } from './views/labour.js';
import { renderDemand } from './views/demand.js';
import { renderCash } from './views/cash.js';
import { renderSafe } from './views/safe.js';
import { renderSpend } from './views/suppliers.js';
import { renderSupplierBook } from './views/supplierbook.js';
import { renderSetup } from './views/setup.js';
import { renderHub, appsPanel } from './views/hub.js';
import { renderAccounts } from './views/accounts.js';
import { renderReports } from './views/reports.js';
import { renderShifts, shiftsParts } from './views/shifts.js';
import { renderLogin as renderLoginView, markGlyph } from './views/login.js';
import { renderJoin } from './views/join.js';
import { renderUpload } from './views/files.js';
import { renderPrepaid, renderPrepaidMail } from './views/prepaid.js';
import { renderMgmt } from './views/mgmt.js';
import { renderReportAccess } from './views/reportaccess.js';
import { renderNicePlace } from './views/niceplace.js';
import { openNewPo } from './views/newpo.js';
import { renderApprovals, approvalsCount } from './views/approvals.js';
import { renderReceipts } from './views/receipts.js';
import { renderFloats } from './views/floats.js';
import { openViewAs, viewAsBar } from './views/viewas.js';
import { openPalette } from './views/palette.js';

export const state = {
  boot: null,
  me: null,
  range: { from: null, to: null },
  reload: () => {},
};

/**
 * Five places, each a few pages, some pages a few tabs.
 *
 * The menu down the left (five buttons along the bottom of a phone) is the
 * sections; under the one open, its pages; across the top of a page, its tabs
 * when it has more than one. A route is one tab: its page groups it with the
 * others under the same heading. Old addresses still open (ALIASES).
 */
const SECTIONS = [
  { id: 'assistant', label: 'Assistant', icon: 'spark' },
  { id: 'desk', label: 'Front desk', icon: 'desk' },
  { id: 'buying', label: 'Buying', icon: 'cart' },
  { id: 'reports', label: 'Reports', icon: 'chart' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

/** One part of the Shifts screen as a page of its own, telling the menu when it moves to another part. */
const shiftsPart = (part, settingsParts = null) => (root, ctx) => renderShifts(root, { ...ctx, section: part, settingsParts, onSection: (s) => ctx.moved(SHIFT_PATHS[s]) });
const SHIFT_PATHS = { shifts: 'shifts', inbox: 'inbox', people: 'people', reports: 'closing', files: 'files', settings: 'rules' };

const ROUTES = [
  // Everything waiting for an admin, in every system, decided here; and the morning summary.
  { path: 'approvals', label: 'Approvals', section: 'assistant', page: 'Assistant', render: renderApprovals, needs: 'admin', own: true, count: true },
  { path: 'brief', label: 'Brief', section: 'assistant', page: 'Assistant', render: renderBrief, needs: 'insight' },

  // The front desk's control sheet, its people, the safe the shifts fill, and the washroom.
  { path: 'shifts', label: 'Shifts', section: 'desk', page: 'Shifts', render: shiftsPart('shifts'), needs: 'shifts', part: 'shifts' },
  { path: 'inbox', label: 'To sort out', section: 'desk', page: 'Shifts', render: shiftsPart('inbox'), needs: 'shifts', part: 'inbox' },
  { path: 'closing', label: 'Closing reports', section: 'desk', page: 'Shifts', render: shiftsPart('reports'), needs: 'shifts', part: 'reports' },
  { path: 'people', label: 'People', section: 'desk', page: 'People', render: shiftsPart('people'), needs: 'shifts', part: 'people' },
  { path: 'safe', label: 'Safe', section: 'desk', page: 'Safe', render: renderSafe, needs: 'safe' },
  { path: 'niceplace', label: 'Nice Place', section: 'desk', page: 'Nice Place', render: renderNicePlace, needs: 'insight' },
  // The one screen an uploader gets: the three shift files, nothing in them.
  { path: 'upload', label: 'Upload files', section: 'desk', page: 'Upload files', render: renderUpload, needs: 'upload', own: true },

  // Odoo's suppliers, receipts made into POs, money given out to buy with, and what it all cost.
  { path: 'suppliers', label: 'Suppliers', section: 'buying', page: 'Suppliers', render: renderSupplierBook, needs: 'insight', report: 'buying' },
  { path: 'receipts', label: 'Receipts', section: 'buying', page: 'Receipts', render: renderReceipts, needs: 'admin', own: true },
  { path: 'floats', label: 'Floats', section: 'buying', page: 'Floats', render: renderFloats, needs: 'admin', own: true },
  { path: 'spend', label: 'Spend', section: 'buying', page: 'Spend', render: renderSpend, needs: 'insight', report: 'buying' },

  // What the business made, the week's report from the other apps, the guests and the staff.
  { path: 'money', label: 'Profit & loss', section: 'reports', page: 'Money', render: renderPnl, needs: 'insight' },
  { path: 'yardstick', label: 'Health', section: 'reports', page: 'Money', render: renderFinancials, needs: 'insight' },
  { path: 'cash', label: 'Cash & collections', section: 'reports', page: 'Money', render: renderCash, needs: 'insight' },
  { path: 'management', label: 'Management report', section: 'reports', page: 'Management report', render: renderMgmt, needs: 'insight', ownHash: true, own: true },
  { path: 'guests', label: 'Occupancy & spend', section: 'reports', page: 'Guests', render: renderDemand, needs: 'insight' },
  { path: 'prepaid', label: 'Prepaid stays', section: 'reports', page: 'Guests', render: renderPrepaid, needs: 'insight', ownHash: true, own: true },
  { path: 'labour', label: 'Staff costs', section: 'reports', page: 'Staff costs', render: renderLabour, needs: 'insight' },

  // Who may do what, where the systems connect, how things are done, who is told, and reports shared by PIN.
  { path: 'accounts', label: 'People', section: 'settings', page: 'People & access', render: renderAccounts, needs: 'owner' },
  { path: 'supervisors', label: 'Supervisors', section: 'settings', page: 'People & access', render: shiftsPart('settings', ['who']), needs: 'shifts', part: 'settings', still: true },
  { path: 'report-access', label: 'Reports they see', section: 'settings', page: 'People & access', render: renderReportAccess, needs: 'admin', own: true },
  { path: 'setup', label: 'Connections', section: 'settings', page: 'Connections & files', render: renderSetup, needs: 'owner' },
  { path: 'files', label: 'Shift files', section: 'settings', page: 'Connections & files', render: shiftsPart('files'), needs: 'shifts', part: 'files', still: true },
  { path: 'rules', label: 'Front desk', section: 'settings', page: 'Rules', render: shiftsPart('settings', ['desk', 'limits', 'lock']), needs: 'shifts', part: 'settings', still: true },
  { path: 'np-rules', label: 'Nice Place', section: 'settings', page: 'Rules', render: (root) => renderNicePlace(root, { part: 'settings' }), needs: 'admin' },
  { path: 'receipt-rules', label: 'Receipts', section: 'settings', page: 'Rules', render: (root) => renderReceipts(root, { part: 'settings' }), needs: 'admin' },
  { path: 'notify', label: 'HIVE alerts', section: 'settings', page: 'Notifications', render: shiftsPart('settings', ['told']), needs: 'shifts', part: 'settings', still: true },
  { path: 'notify-mgmt', label: 'Management report', section: 'settings', page: 'Notifications', render: (root) => renderMgmt(root, { part: 'settings' }), needs: 'admin' },
  { path: 'notify-prepaid', label: 'Prepaid summary', section: 'settings', page: 'Notifications', render: renderPrepaidMail, needs: 'admin' },
  { path: 'reports', label: 'Shared reports', section: 'settings', page: 'Shared reports', render: renderReports, needs: 'owner' },

  // The other systems, signed in: a page only for somebody given nothing here.
  { path: 'hub', label: 'Systems', section: null, page: 'Systems', render: renderHub, needs: 'session' },
];

/** Where an old address now goes: `#/buying` was Spend | Suppliers, `#/shifts?tab=inbox` the Inbox. */
const ALIASES = { buying: 'spend', findings: 'brief', books: 'brief' };

const ICONS = {
  spark: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z"/>',
  desk: '<path d="M3 10h18M5 10v10M19 10v10M3 20h18M7 10V6a2 2 0 012-2h6a2 2 0 012 2v4"/>',
  cart: '<path d="M3 4h2l2.4 10.5a2 2 0 002 1.5h7.7a2 2 0 002-1.5L21 8H6"/><circle cx="10" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
};
export const icon = (name) => h('span.ic', { html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>` });

function allowed(route) {
  const me = state.me?.account;
  if (!me) return false;
  if (route.needs === 'session') return true;
  // Owners and admins load files under Settings › Connections & files; this page is for uploaders.
  if (route.needs === 'upload') return me.till?.role === 'uploader';
  if (route.part && !(me.isOwner || me.bootstrap) && !shiftsParts(me.till)[route.part]) return false;
  if (me.isOwner || me.bootstrap) return true;
  if (route.needs === 'shifts') return ['admin', 'supervisor'].includes(me.till?.role);
  if (route.needs === 'owner') return false;
  if (route.needs === 'admin') return me.till?.role === 'admin';
  // The safe book is the admins'; a supervisor given Envelopes received sees that tab.
  if (route.needs === 'safe') return me.till?.role === 'admin' || (me.till?.role === 'supervisor' && (me.till?.access?.envelopes || 0) >= 1);
  // A report page: every one for an admin, the ones shared with them for anybody else.
  return me.canSeeReports === true || (me.reports || []).includes(route.report || route.path);
}

const root = document.getElementById('app');

setUnauthorizedHandler(() => renderLogin());

start();

async function start() {
  // An invitation's link opens its own page, signed in or not: the person
  // following it may be on a shared desk PC where somebody else is signed in.
  // A to-do's email links straight to it: Front desk › Shifts › To sort out with the to-do open.
  const todo = /^#\/shifts\?(?:.*&)?todo=(\d+)/.exec(location.hash);
  if (todo) {
    try { sessionStorage.setItem('insight-shifts-opentodo', todo[1]); } catch { /* private mode */ }
    history.replaceState(null, '', '#/inbox');
  }
  if (/^#\/shifts\?(?:.*&)?tab=inbox/.test(location.hash)) history.replaceState(null, '', '#/inbox');
  const invited = /^#join=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (invited) {
    return renderJoin(root, invited[1], () => {
      history.replaceState(null, '', location.pathname);
      state.me = null;
      start();
    });
  }
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
  const account = state.me.account || {};

  // Somebody who only has the hub must not be blocked by a warehouse that has
  // never been loaded, so the reports bootstrap is only fetched by people who
  // can actually see reports — and a failure there costs the reports, not the
  // front door.
  let boot = null;
  if (visible.some((r) => r.needs === 'insight' || r.needs === 'shifts')) {
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

  // The hub is a page only for somebody given nothing else; everybody else
  // reaches the other systems from the apps button.
  const shown = visible.some((r) => r.path !== 'hub') ? visible.filter((r) => r.path !== 'hub') : visible;
  const sections = SECTIONS.map((s) => ({ ...s, routes: shown.filter((r) => r.section === s.id) })).filter((s) => s.routes.length);
  const pagesOf = (s) => [...new Set(s.routes.map((r) => r.page))].map((page) => ({ page, routes: s.routes.filter((r) => r.page === page) }));

  const view = h('div.pg-body');
  const head = h('div.pg-head');
  const picker = rangePicker();
  const side = h('nav.side-nav', { 'aria-label': 'Main menu' });
  const bottom = h('nav.bottom-nav', { 'aria-label': 'Main menu' });
  const counts = h('span.cnt');
  let currentRoute = null;

  // The count of what waits for an admin, on the Assistant: read now, every five minutes, and after each decision.
  if (shown.some((r) => r.count)) {
    const say = (n) => { counts.textContent = n ? String(n) : ''; for (const el of document.querySelectorAll('.cnt-assistant')) el.textContent = n ? String(n) : ''; };
    window.addEventListener('approvals:count', (e) => say(e.detail));
    const ask = () => approvalsCount().then(say).catch(() => {});
    ask();
    setInterval(() => { if (document.visibilityState === 'visible' && currentRoute?.path !== 'approvals') ask(); }, 300_000);
  }

  function drawNav() {
    const here = currentRoute;
    mount(side, sections.map((s) => {
      const on = here?.section === s.id;
      const pages = pagesOf(s);
      return h('div.side-sec',
        h('button.side-b', { type: 'button', 'aria-current': on ? 'page' : null, onclick: () => go(s.routes[0].path) },
          icon(s.icon), h('span', s.label), s.id === 'assistant' ? h('span.cnt.cnt-assistant', counts.textContent) : null),
        on && pages.length > 1 ? h('div.side-sub', pages.map((p) => h('button', {
          type: 'button', 'aria-current': here.page === p.page ? 'page' : null, onclick: () => go(p.routes[0].path),
        }, p.page))) : null);
    }));
    mount(bottom, sections.map((s) => h('button', { type: 'button', 'aria-current': here?.section === s.id ? 'page' : null, onclick: () => go(s.routes[0].path) },
      icon(s.icon), h('span', s.label.split(' ')[0]), s.id === 'assistant' ? h('span.cnt.cnt-assistant', counts.textContent) : null)));
  }

  /** Over the page: on a phone the section's pages; the page's own title, unless it says it itself; and its tabs. */
  function drawHead(route) {
    const s = sections.find((x) => x.id === route.section);
    const pages = s ? pagesOf(s) : [];
    const tabs = pages.find((p) => p.page === route.page)?.routes || [route];
    mount(head,
      pages.length > 1 ? h('div.seg.pg-pages', { role: 'tablist', 'aria-label': s.label }, pages.map((p) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(p.page === route.page), onclick: () => go(p.routes[0].path),
      }, p.page))) : null,
      route.own && tabs.length < 2 ? null : h('div.pg-title', route.own ? null : h('h1', route.page),
        tabs.length > 1 ? h('div.seg', { role: 'tablist', 'aria-label': route.page }, tabs.map((r) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(r.path === route.path), onclick: () => go(r.path),
        }, r.label))) : null));
  }

  const isAdmin = (account.till?.role || (account.isOwner ? 'admin' : null)) === 'admin';
  const apps = h('div.pop.apps-pop', { hidden: true });
  const appsBtn = h('button.icon-b', { type: 'button', 'aria-label': 'Open another system', 'aria-expanded': 'false', onclick: (e) => { e.stopPropagation(); toggle(apps, appsBtn); if (!apps.hidden && !apps.childElementCount) appsPanel(apps); } }, icon('grid'));
  const me = h('div.pop.me-pop', { hidden: true },
    h('div.me-who', h('b', account.name || 'Account'), h('small', roleName(account))),
    account.mayViewAs ? h('button', { type: 'button', onclick: () => { closePops(); openViewAs(); } }, '👁 View as somebody else…') : null,
    h('button', { type: 'button', onclick: () => { toggleTheme(); closePops(); } }, '◐ Light or dark'),
    h('button', { type: 'button', onclick: async () => { await api('/auth/logout', { method: 'POST' }); renderLogin(); } }, 'Sign out'));
  const meBtn = (cls) => h(`button.${cls}`, { type: 'button', 'aria-label': 'Your account', onclick: (e) => { e.stopPropagation(); e.currentTarget.parentElement.append(me); toggle(me, e.currentTarget); } },
    h('span.av', (account.name || '?').trim().charAt(0).toUpperCase()),
    cls === 'side-me' ? h('span.side-who', h('b', account.name || 'Account'), h('small', roleName(account))) : null);

  function toggle(pop, btn) {
    const open = pop.hidden;
    closePops();
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
  function closePops() {
    for (const p of [apps, me]) p.hidden = true;
    for (const b of document.querySelectorAll('[aria-expanded]')) b.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', (e) => { if (!apps.contains(e.target) && !me.contains(e.target)) closePops(); });

  const palette = () => openPalette({
    pages: shown.map((r) => ({ label: r.page === r.label ? r.label : `${r.page} › ${r.label}`, section: sections.find((s) => s.id === r.section)?.label || '', go: () => go(r.path) })),
    actions: [
      isAdmin ? { label: 'New purchase order', go: () => openNewPo() } : null,
      shown.some((r) => r.path === 'floats') ? { label: 'Give money (floats)', go: () => go('floats') } : null,
      shown.some((r) => r.path === 'safe') ? { label: 'Count the safe', go: () => go('safe') } : null,
      account.mayViewAs ? { label: 'View as somebody else', go: () => openViewAs() } : null,
      { label: 'Light or dark', go: toggleTheme },
    ].filter(Boolean),
    suppliers: shown.some((r) => r.path === 'suppliers') ? () => go('suppliers') : null,
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); }
    if (e.key === 'Escape') closePops();
  });

  mount(root,
    h('div.shell',
      h('aside.side',
        h('div.side-brand', markGlyph(), h('span', h('b', boot.group.name), h('small', 'Insight'))),
        side,
        h('span.grow'),
        h('div.side-foot', meBtn('side-me'))),
      h('div.shell-main',
        account.viewedBy ? viewAsBar(account) : null,
        h('header.top',
          h('button.search', { type: 'button', onclick: palette }, icon('search'), h('span', 'Search Insight…'), h('kbd', 'Ctrl K')),
          h('span.spacer'),
          picker,
          isAdmin ? h('button.chip-b.po-new', { type: 'button', 'aria-label': 'Create a purchase order', onclick: () => openNewPo() }, icon('plus'), h('span', 'New PO')) : null,
          h('div.pop-at', appsBtn, apps),
          h('div.pop-at.top-me', meBtn('icon-b'), me)),
        h('main', head, view))),
    bottom);

  state.reload = () => go(current());
  // A part of Shifts that moved to another (a shift opened from To sort out):
  // the address and the menu follow without drawing the page again.
  let quiet = null;
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#join=')) { start(); return; }
    if (quiet && location.hash === quiet) { quiet = null; return; }
    go(current());
  });
  await go(current());

  function current() {
    const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
    const path = ALIASES[raw] || raw;
    if (shown.some((r) => r.path === path)) return path;
    // Whatever needs this person first: the Assistant, the shifts, the files, the reports, or the systems.
    return shown.find((r) => r.section === 'assistant')?.path || shown.find((r) => r.section === 'desk')?.path
      || shown.find((r) => r.needs === 'insight')?.path || shown[0].path;
  }

  function hashFor(route) {
    const own = route.ownHash && location.hash.split('?')[0] === `#/${route.path}`;
    return own ? location.hash
      : windowed(route) ? `#/${route.path}?from=${state.range.from}&to=${state.range.to}`
        : `#/${route.path}`;
  }

  /** Days matter on this page: the window rides in its address and the picker shows. */
  function windowed(route) {
    return !route.ownHash && !route.still && (route.needs === 'insight' || route.needs === 'shifts');
  }

  function moved(path) {
    const route = shown.find((r) => r.path === path);
    if (!route || route === currentRoute) return;
    currentRoute = route;
    const want = hashFor(route);
    if (location.hash !== want) { quiet = want; location.hash = want; }
    drawNav();
    drawHead(route);
  }

  async function go(path) {
    const route = shown.find((r) => r.path === path) || shown[0];
    currentRoute = route;
    // The window rides in the address, so a reload keeps it and a link to a
    // screen is a link to the days somebody was actually looking at.
    const want = hashFor(route);
    if (location.hash !== want) { quiet = want; location.hash = want; }
    closePops();
    drawNav();
    drawHead(route);
    document.title = `${route.page === route.label ? route.label : `${route.page} · ${route.label}`} · Insight`;
    if (picker) picker.style.display = windowed(route) ? '' : 'none';
    mount(view, h('p.muted', 'Reading…'));
    try {
      const fresh = h('div');
      await route.render(fresh, { range: state.range, boot, moved });
      if (currentRoute === route) mount(view, fresh);
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

    const first = boot.data.firstDay || '';
    const today = boot.group.today;
    const summary = h('summary.btn');
    // No lower bound. It was the first day the warehouse currently holds, which
    // greyed out every year before the one that happened to have been loaded —
    // and that is exactly backwards now that history can be fetched. Somebody
    // wanting last year has to be able to ask for it *before* it exists here;
    // asking is how they find out it has to be loaded, and the panel says so.
    // The upper bound stays: a report about days that have not happened is not
    // a question anybody is asking.
    const from = h('input', { type: 'date', max: today, id: 'range-from' });
    const to = h('input', { type: 'date', max: today, id: 'range-to' });
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
      say(note());
    }

    /**
     * The one sentence worth saying about the range that was chosen.
     *
     * Reaching past what has been loaded is the common one and used to be
     * silent — the screens simply came back empty and left somebody to work
     * out why. It is not an error and is not prevented; it is a prompt to go
     * and fetch the days, which is now a thing that can be done.
     */
    function note() {
      if (state.range.to >= today) {
        return 'This range includes today, which is only half a day. Every line will look low.';
      }
      if (first && state.range.from < first) {
        return `The warehouse only holds ${first} onwards, so the days before that will be empty. `
          + 'Settings › Connections & files › Loads → "Load these days instead" goes and fetches them.';
      }
      return '';
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

/** What somebody is, in a word, under their name. */
function roleName(account) {
  if (account.isOwner) return 'Owner';
  return ({ admin: 'Admin', supervisor: 'Supervisor', uploader: 'Uploader', reports: 'Reports only' })[account.till?.role] || '';
}
