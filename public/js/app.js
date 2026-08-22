import { api, onReachabilityChange, serverReachable, setUnauthorizedHandler } from './api.js';
import { registerWorker, watchForInstall } from './install.js';
import { h, mount } from './util.js';
import { renderLogin } from './views/login.js';
import { alreadyWelcomed, markWelcomed, welcomePanel } from './views/welcome.js';
import { openAccountDialog } from './views/account.js';
import { noticeBell } from './views/notices.js';
import { renderAttToday } from './views/att-today.js';
import { renderAttStaff } from './views/att-staff.js';
import { renderAttOverview, renderAttWeek } from './views/att-reports.js';
import { renderAttRota } from './views/att-rota.js';
import { renderAttWorkload } from './views/att-workload.js';
import { renderAttMe } from './views/att-me.js';
import { renderAttMyReport } from './views/att-my-report.js';
import { renderAttMyAdvance } from './views/att-my-advance.js';
import { renderAttAdvances } from './views/att-advances.js';
import { renderAttMyMedical } from './views/att-my-medical.js';
import { renderAttMedical } from './views/att-medical.js';
import { renderAttPayroll } from './views/att-payroll.js';
import { renderAttLeave } from './views/att-leave.js';
import { renderAttSignoff } from './views/att-signoff.js';
import { renderAttSetup } from './views/att-setup.js';
import { renderAdmin } from './views/admin.js';
import { renderPeople } from './views/people.js';
import { renderPerson } from './views/person.js';
import { renderPeopleTemplates } from './views/people-templates.js';
import { renderPeopleForm } from './views/people-form.js';
import { renderGuide } from './views/guide.js';
import { renderContract } from './views/contract.js';
import { renderLetters } from './views/letters.js';
import { renderLetter } from './views/letter.js';
import { renderLetterParties } from './views/letter-parties.js';
import { renderLetterSigning } from './views/letter-signing.js';
import { BRAND, brandMark } from './brand.js';

export const state = {
  role: null,
  name: null,
  email: null,
  isRecovery: false,
  permissions: [],
  settings: {},
  // What the permissions and roles are called, sent with the session so the
  // guide can name one the reader does not hold.
  permissionLabels: {},
  roleLabels: {},
};

/**
 * The screens, in the order somebody grows into them.
 *
 * Today first because it is the only one a supervisor opens, and they open it
 * every morning. Setup last because it is opened twice a year.
 */
const ROUTES = [
  // First, and for most people the only one. A member of staff holds this and
  // nothing else, so it has to be the screen they land on.
  { path: 'att-me', label: 'My shifts', permission: 'att_me', render: renderAttMe },
  // Beside it, because the month is the other question somebody asks about
  // their own attendance and it is not one the week can answer.
  { path: 'att-my-report', label: 'My report', permission: 'att_me', render: renderAttMyReport },
  // Money going the other way. Beside their own report because that is where
  // somebody looks when they are working out what they will be paid.
  { path: 'att-my-advance', label: 'My advance', permission: 'att_me', render: renderAttMyAdvance },
  { path: 'att-my-medical', label: 'My claims', permission: 'att_me', render: renderAttMyMedical },
  { path: 'att-today', label: 'Today', permission: 'att_view', render: renderAttToday },
  { path: 'att-week', label: 'Week', permission: 'att_reports', render: renderAttWeek },
  // The planner reads the month before building the next one. The one thing
  // they may not see — how much leave anybody has left — comes out of the
  // answer, not just off the screen.
  { path: 'att-overview', label: 'Month', permission: ['att_reports', 'att_rota'], render: renderAttOverview },
  { path: 'att-rota', label: 'Rota', permission: 'att_rota', render: renderAttRota },
  // Beside the rota, because it is read while the rota is being built.
  { path: 'att-workload', label: 'Workload', permission: ['att_rota', 'att_reports'], render: renderAttWorkload },
  { path: 'att-leave', label: 'Leave', permission: 'att_view', render: renderAttLeave },
  { path: 'signoff', label: 'Sign-off', permission: 'att_signoff', render: renderAttSignoff },
  { path: 'people', label: 'People', permission: 'hr_view', render: renderPeople },
  // Its own permission, the same one as what anybody earns.
  { path: 'att-advances', label: 'Advances', permission: 'hr_pay', render: renderAttAdvances },
  { path: 'att-medical', label: 'Medical claims', permission: 'hr_pay', render: renderAttMedical },
  { path: 'att-payroll', label: 'Payroll', permission: 'hr_pay', render: renderAttPayroll },
  { path: 'letters', label: 'Letters', permission: 'corr_view', render: renderLetters },
  { path: 'att-setup', label: 'Setup', permission: 'att_setup', render: renderAttSetup },
  { path: 'admin', label: 'Users & data', permission: 'users', render: renderAdmin },
  // Last in the menu and reachable by everybody. What it contains is filtered
  // to what the reader actually holds, so it is short for a supervisor and
  // long for an administrator without either of them being sent elsewhere.
  { path: 'guide', label: 'Guide', permission: null, render: renderGuide },
  // Reached by clicking a name rather than from the menu.
  { path: 'att-staff', label: 'Person', permission: 'att_view', render: renderAttStaff, hidden: true },
  { path: 'person', label: 'Record', permission: 'hr_view', render: renderPerson, hidden: true },
  { path: 'people-templates', label: 'Templates', permission: 'hr_manage', render: renderPeopleTemplates, hidden: true },
  { path: 'people-form', label: 'What to ask for', permission: 'hr_manage', render: renderPeopleForm, hidden: true },
  { path: 'contract', label: 'Contract', permission: 'hr_view', render: renderContract, hidden: true },
  { path: 'letter', label: 'Letter', permission: 'corr_view', render: renderLetter, hidden: true },
  { path: 'letter-parties', label: 'Address book', permission: 'corr_view', render: renderLetterParties, hidden: true },
  { path: 'letter-signing', label: 'Signature & stamp', permission: 'corr_view', render: renderLetterSigning, hidden: true },
];

const root = document.getElementById('app');

/**
 * Does the signed-in person hold this?
 *
 * A list means "any one of these", exactly as the route table on the server
 * reads it. The two have to agree: a screen the API would answer but the menu
 * will not show is a screen nobody can reach, and one the menu shows but the
 * API refuses is worse.
 */
export function can(permission) {
  if (!permission) return true;
  const needed = Array.isArray(permission) ? permission : [permission];
  return needed.some((p) => state.permissions.includes(p));
}

function allowed(route) {
  return Boolean(route) && can(route.permission);
}

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.find((r) => r.path === hash && allowed(r));
}

/**
 * Land people on the most useful screen they can actually open.
 *
 * The fallback matters as much as the list. Naming a specific route here would
 * send anybody whose permissions are not on it to a screen they cannot open,
 * which loops straight back here and leaves them staring at the sign-in page
 * they just cleared. So the last resort is the first route they can open.
 */
function defaultRoute() {
  const preferred = ['att-today', 'att-overview', 'att-rota', 'signoff', 'att-leave', 'people',
    'letters', 'att-setup', 'admin'];
  const wanted = preferred.find((path) => allowed(ROUTES.find((r) => r.path === path)));
  return wanted ?? ROUTES.find((r) => allowed(r) && !r.hidden)?.path ?? 'att-today';
}

/** Query params live after the route: #/att-today?day=2026-08-08 */
export function routeParams() {
  const query = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(query));
}

export function navigate(path, params = {}) {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v != null && v !== ''),
  );
  const query = new URLSearchParams(clean).toString();
  location.hash = `#/${path}${query ? `?${query}` : ''}`;
}

/** Update the URL without re-rendering — used by in-view date pickers. */
export function replaceParams(path, params) {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v != null && v !== ''),
  );
  const query = new URLSearchParams(clean).toString();
  history.replaceState(null, '', `#/${path}${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/**
 * Ten screens is about the limit for one flat list.
 *
 * The other apps in this operation group their navigation because they carry
 * three stores between them. This one does not, and inventing a section
 * heading for a list of ten would be furniture for its own sake.
 */
async function signOut() {
  await api.logout().catch(() => {});
  resetSession();
  render();
}

function sidebar() {
  const visible = ROUTES.filter((r) => allowed(r) && !r.hidden);
  const here = currentRoute()?.path;

  return h('nav.sidebar',
    h('div.side-group', visible.map((route) => h('a.side-link', {
      href: `#/${route.path}`,
      class: here === route.path ? 'side-link active' : 'side-link',
      onclick: () => closeDrawer(),
    }, route.label))),

    // Only ever seen on a phone, where it is not on the header. Last in the
    // drawer, under everything else, because it is the one thing here nobody
    // wants to press by accident.
    h('div.side-foot.only-phone',
      h('div.side-who', state.name || '', state.name ? h('br') : null,
        h('small.muted', roleLabel(state.role))),
      h('button.btn-sm', { onclick: signOut }, 'Sign out')),
  );
}

function closeDrawer() {
  document.querySelector('.shell')?.classList.remove('nav-open');
}

function shell(content) {
  const shellEl = h('div.shell',
    h('header.topbar',
      h('button.btn-ghost.btn-sm.nav-toggle', {
        title: 'Menu',
        onclick: () => document.querySelector('.shell')?.classList.toggle('nav-open'),
      }, '☰'),
      // The system's own name, with the property underneath rather than
      // instead of it. Somebody working here already knows where they work;
      // which system they are looking at is the thing worth saying.
      h('div.brand',
        brandMark(),
        h('div',
          BRAND.name,
          h('span.brand-sub', [
            state.settings.property_name,
            state.name,
            roleLabel(state.role),
          ].filter(Boolean).join(' · ')),
        ),
      ),
      h('div.topbar-spacer'),
      noticeBell(),
      h('button.btn-ghost.btn-sm', { title: 'Switch light / dark', onclick: toggleTheme }, '🌗'),
      h('button.btn-ghost.btn-sm.topbar-account', {
        title: state.role === 'admin' ? 'Change my password' : 'Change my PIN',
        'aria-label': 'My account',
        onclick: () => openAccountDialog({
          role: state.role,
          name: state.name || 'you',
          email: state.email,
          isRecovery: state.isRecovery,
          // Anybody who has to act on an exception is worth alerting; somebody
          // who only reads the month-end report is not, and would come to
          // resent a phone buzzing every morning about it.
          // Anybody a notification would actually reach. That is whoever
          // settles the morning list, and now also anybody on the rota: a
          // published shift and "your shift started" are the two alerts
          // written for a phone rather than a desk.
          canAlert: can('att_manage') || can('att_me'),
        }),
      },
      // The icon is what shows on a phone and the words are what show on a
      // desk. Both are always in the button so the label is never only a
      // tooltip, which a finger cannot hover over.
      h('span.only-phone', '👤'),
      h('span.only-desk', 'My account')),

      // Sign out is in the drawer on a phone. It was the last thing on a row
      // that had already run out of room, and it is the one button on this bar
      // that undoes your morning if you hit it by mistake.
      h('button.btn-ghost.btn-sm.only-desk', {
        onclick: signOut,
      }, 'Sign out'),
    ),
    // Said loudly, because the app now opens without a signal and a screen that
    // opens is a screen somebody believes. "Nobody absent, all settled" is a
    // reasonable-looking morning and a dangerous lie when the truth is that
    // nothing could be fetched.
    h('div.offline-bar', { hidden: serverReachable() },
      h('strong', 'No connection.'),
      ' What you are looking at may be out of date, and nothing you change will be saved '
      + 'until the signal is back.'),

    h('div.body-row',
      sidebar(),
      // Tapping the page behind an open drawer closes it, which is what every
      // phone user already expects to happen.
      h('div.nav-scrim', { onclick: closeDrawer }),
      h('main.main', content),
    ),
  );

  return shellEl;
}

/**
 * Publish the header's real height as --topbar-h.
 *
 * Anything sticky below the header — the sidebar, the rota's unsaved-changes
 * bar — measures from this rather than a guessed constant, so a header that
 * changes height cannot hide them.
 */
let topbarWatcher = null;
function trackTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar || typeof ResizeObserver !== 'function') return;
  topbarWatcher?.disconnect();
  topbarWatcher = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  });
  topbarWatcher.observe(bar);
}

function toggleTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = explicit ? (explicit === 'dark' ? 'light' : 'dark') : (prefersDark ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('att.theme', next);
}

export async function render() {
  root.classList.remove('app-loading');

  if (!state.role) {
    mount(root, renderLogin(async ({ role, name, email, permissions, isRecovery }) => {
      state.role = role;
      state.name = name;
      state.email = email ?? null;
      state.isRecovery = Boolean(isRecovery);
      state.permissions = permissions ?? [];
      if (!location.hash || !currentRoute()) navigate(defaultRoute());
      await render();
    }));
    return;
  }

  const route = currentRoute();
  if (!route) {
    navigate(defaultRoute());
    return;
  }

  const container = h('div');
  mount(root, shell(container));
  trackTopbarHeight();
  mount(container, h('div.card', h('div.skeleton', { style: { height: '120px' } })));

  try {
    mount(container, await route.render(routeParams()));
    // The greeting goes above whatever they landed on, once for the session.
    // Anywhere else and it would be a banner somebody learns to scroll past.
    if (!alreadyWelcomed()) {
      markWelcomed();
      container.prepend(welcomePanel({
        name: state.name,
        role: state.role,
        permissions: state.permissions,
      }));
    }
  } catch (err) {
    if (err.status === 401) return; // the unauthorized handler already reset us
    mount(container, h('div.card.empty',
      h('h3', 'Could not load this view'),
      h('p.muted', err.message || String(err)),
      h('button.btn-primary', { onclick: () => render() }, 'Try again'),
    ));
  }
}

function resetSession() {
  state.role = null;
  state.name = null;
  state.email = null;
  state.isRecovery = false;
  state.permissions = [];
}

const ROLE_LABELS = {
  supervisor: 'Supervisor',
  manager: 'Manager',
  viewer: 'Reports',
  admin: 'Administrator',
};
function roleLabel(role) {
  return ROLE_LABELS[role] || 'Signed in';
}

setUnauthorizedHandler(() => {
  resetSession();
  render();
});

window.addEventListener('hashchange', render);

// Shown and hidden in place rather than by redrawing the page: losing what
// somebody had half-filled in because a lift went past is its own small
// disaster, and the bar is one element.
onReachabilityChange((ok) => {
  const bar = document.querySelector('.offline-bar');
  if (bar) bar.hidden = ok;
});

// The device losing its network is worth reacting to immediately rather than
// waiting for the next request to fail — but it is only ever the early
// warning. Whether the server answers is the question, and only a request
// answers it.
window.addEventListener('offline', () => {
  const bar = document.querySelector('.offline-bar');
  if (bar) bar.hidden = false;
});
window.addEventListener('online', () => { api.me().catch(() => {}); });

(async function boot() {
  const savedTheme = localStorage.getItem('att.theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

  registerWorker();
  watchForInstall();

  try {
    const me = await api.me();
    if (me.authenticated) {
      state.role = me.role;
      state.name = me.name;
      state.email = me.email ?? null;
      state.isRecovery = Boolean(me.isRecovery);
      state.permissions = me.permissions || [];
      state.settings = me.settings || {};
      state.permissionLabels = me.permissionLabels || {};
      state.roleLabels = me.roleLabels || {};
    }
  } catch { /* fall through to the login screen */ }

  if (state.role && !currentRoute()) navigate(defaultRoute());
  await render();
})();
