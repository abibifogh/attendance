import { actFor, api, onReachabilityChange, serverReachable, setUnauthorizedHandler } from './api.js';
import { liveUp, onLive, startLive, stopLive } from './live.js';
import { guard, justProved, unguard } from './guard.js';
import { checkVersion, takeTheNewOne, waitingToRefresh } from './fresh.js';
import { registerWorker, watchForInstall } from './install.js';
import { h, holdBehindDialogs, keepScroll, mount, watchScreenHeight } from './util.js';
import { groupKeyFor, groupOf, mineTabs, openGroups, tabsOf } from './menu.js';
import { icon } from './icons.js';
import { renderLogin } from './views/login.js';
import { openAccountDialog, renderForcedPinChange } from './views/account.js';
import { noticeBell } from './views/notices.js';
import { renderAttToday } from './views/att-today.js';
import { renderAttStaff } from './views/att-staff.js';
import { renderAttOverview, renderAttWeek } from './views/att-reports.js';
import { renderAttRota } from './views/att-rota.js';
import { renderAttWorkload } from './views/att-workload.js';
import { renderAttMe } from './views/att-me.js';
import { renderMyDay } from './views/my-day.js';
import { renderHome } from './views/home.js';
import { renderInbox, inboxCount } from './views/inbox.js';
import { renderRequests } from './views/requests.js';
import { renderSettings } from './views/settings.js';
import { renderAttMyReport } from './views/att-my-report.js';
import { renderAttMyPayslips } from './views/att-my-payslips.js';
import { renderDirectory } from './views/directory.js';
import { renderSwapQueue, renderSwaps } from './views/swaps.js';
import { renderHandbook } from './views/handbook.js';
import { renderHrFaq } from './views/hr-faq.js';
import { renderAttMyAdvance } from './views/att-my-advance.js';
import { renderAttMyTill, renderAttMyTillIssues } from './views/att-my-till.js';
import { renderAttAdvances } from './views/att-advances.js';
import { renderAttMyMedical } from './views/att-my-medical.js';
import { renderAttLunch } from './views/att-lunch.js';
import { renderAttMedical } from './views/att-medical.js';
import { renderAttPayrollTab } from './views/att-payroll.js';
import { renderAttLeave } from './views/att-leave.js';
import { renderAttSignoff } from './views/att-signoff.js';
import { renderPeople } from './views/people.js';
import { renderRec } from './views/rec.js';
import { renderRecCandidate } from './views/rec-candidate.js';
import { renderPerson } from './views/person.js';
import { renderOnboarding, renderOnboardingDesk } from './views/onboarding.js';
import { renderPeopleTemplates } from './views/people-templates.js';
import { renderPeopleForm } from './views/people-form.js';
import { renderGuide } from './views/guide.js';
import { renderContract } from './views/contract.js';
import { renderMyContracts } from './views/my-contracts.js';
import { renderAttMyLunch } from './views/att-my-lunch.js';
import { renderLetters } from './views/letters.js';
import { renderLetter } from './views/letter.js';
import { renderLetterCompose } from './views/letter-compose.js';
import { renderLetterParties } from './views/letter-parties.js';
import { renderLetterSigning } from './views/letter-signing.js';
import { BRAND, brandMark } from './brand.js';
import { face } from './views/components.js';

/**
 * Permissions that are about somebody's own record: their shifts, and closing
 * their own till. A login pointed at nobody has nothing of its own to show.
 */
const OWN_RECORD = new Set(['att_me', 'till']);

export const state = {
  role: null,
  name: null,
  email: null,
  isRecovery: false,
  // Whether they have sent in a photograph, for the face in the header, and
  // when: a browser holds a face for a day, and a new one has to get past it.
  hasPhoto: false,
  photoAt: null,
  // Somebody with a first week still open. Decides where the app lands them
  // and whether the checklist is in their menu at all.
  startingOut: false,
  // Signed in on a PIN shorter than the rule. Nothing else in the app draws
  // while this is set, and it stays set until they choose a longer one.
  mustChangePin: false,
  permissions: [],
  settings: {},
  // Which staff record this login belongs to, or null. Decides whether the
  // screens about oneself mean anything.
  staffId: null,
  // Everybody whose "my" screens this login opens, their own first. One person
  // for almost every login, and then there is nothing to choose between and
  // nothing on the screen about it.
  records: [],
  // Whose screens are being shown, where there is more than one. Null means
  // the first, which is their own.
  actingFor: null,
  // What the permissions and roles are called, sent with the session so the
  // guide can name one the reader does not hold.
  permissionLabels: {},
  roleLabels: {},
};

/**
 * Two menus, one set of screens.
 *
 * STAFF, who hold nothing beyond their own record, get five places: Home,
 * Rota, Requests, Pay and Me. On a phone those are the five tabs along the
 * bottom, which is where a thumb already is.
 *
 * EVERYBODY WHO RUNS SOMETHING gets the side menu: Home, Inbox, Rota,
 * Attendance, People and Money, then Me and Settings. Fifteen groups became
 * six, and every decision anybody is waiting on is in one Inbox rather than on
 * eight different screens.
 *
 * A route's `group` is where it sits in the staff menu; `mgroup`, where it
 * differs, is where it sits in the manager menu. In the manager menu a
 * person's own screens all sit under Me: `mtab` names the ones that are tabs
 * there, and `under` says which tab a screen belongs to when it is not one.
 *
 * A group's first screen is the one its link opens. Everything after it is a
 * tab across the top, and only the tabs somebody actually holds are drawn.
 */
const STAFF_GROUPS = [
  { key: 'my-home', label: 'Home', icon: 'home' },
  { key: 'my-rota', label: 'Rota', icon: 'calendar' },
  { key: 'requests', label: 'Requests', icon: 'send' },
  { key: 'my-pay', label: 'Pay', icon: 'cash' },
  { key: 'me', label: 'Me', icon: 'user' },
];

const MANAGER_GROUPS = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'inbox', label: 'Inbox', icon: 'inbox' },
  { key: 'rota', label: 'Rota', icon: 'calendar' },
  { key: 'day', label: 'Attendance', icon: 'clock' },
  { key: 'people', label: 'People', icon: 'users' },
  { key: 'money', label: 'Money', icon: 'wallet' },
  { key: 'mine', label: 'Me', icon: 'user', foot: true },
  { key: 'setup', label: 'Settings', icon: 'sliders', foot: true },
];

/** Who may decide anything at all, which is who has an Inbox. */
const DECIDES = ['att_manage', 'att_setup', 'att_rota', 'hr_pay', 'hr_manage', 'lunch'];

/**
 * The screens.
 *
 * Grouped, and inside a group in the order the tabs read left to right.
 */
const ROUTES = [
  // ---- a person's own: Home, Rota, Requests, Pay, Me ----------------------
  { mine: true, group: 'my-home', tab: 'Home', mgroup: 'mine', mtab: 'My day', path: 'my-day', label: 'Home', permission: 'att_me', render: renderMyDay, live: ['rota', 'attendance', 'leave', 'people'] },
  // A new hire's own first week, beside Home while it is open. It leaves the
  // menu the day it is finished, which is the whole difference between a
  // checklist and a screen.
  { mine: true, group: 'my-home', tab: 'My first week', mgroup: 'mine', mtab: 'First week', path: 'onboarding', label: 'My first week', permission: null, only: () => state.startingOut, render: renderOnboarding, live: ['people'] },
  // `freshEach` is what does not survive arriving here. The week is written to
  // the address so a live redraw keeps it, and dropped on the way in so the
  // screen always opens on this week.
  { mine: true, group: 'my-rota', tab: 'My shifts', mgroup: 'mine', mtab: 'Shifts', path: 'att-me', label: 'My shifts', permission: 'att_me', render: renderAttMe, live: ['rota', 'attendance', 'leave', 'lunch'], freshEach: ['from'] },
  { mine: true, group: 'my-rota', tab: 'Swaps', mgroup: 'mine', under: 'att-me', path: 'swaps', label: 'Swaps', permission: 'att_me', render: renderSwaps, live: ['rota'] },
  { mine: true, group: 'my-rota', tab: 'Lunch', mgroup: 'mine', under: 'att-me', path: 'att-my-lunch', label: 'My lunch', permission: 'att_me', render: renderAttMyLunch, live: ['lunch'], freshEach: ['week'] },
  { mine: true, group: 'my-rota', tab: 'Report', mgroup: 'mine', under: 'att-me', path: 'att-my-report', label: 'My report', permission: 'att_me', render: renderAttMyReport, live: ['attendance', 'leave'] },
  // Everything somebody can ask for, and what became of it, in one place.
  { mine: true, group: 'requests', tab: 'Requests', mgroup: 'mine', mtab: 'Requests', path: 'requests', label: 'Requests', permission: 'att_me', render: renderRequests, live: ['leave', 'rota', 'pay', 'lunch'] },
  { mine: true, group: 'my-pay', tab: 'Payslips', mgroup: 'mine', mtab: 'Pay', path: 'att-my-payslips', label: 'My payslips', permission: 'att_me', render: renderAttMyPayslips, live: ['pay'] },
  { mine: true, group: 'my-pay', tab: 'Advance', mgroup: 'mine', under: 'att-my-payslips', path: 'att-my-advance', label: 'My advance', permission: 'att_me', render: renderAttMyAdvance, live: ['pay'] },
  { mine: true, group: 'my-pay', tab: 'Claims', mgroup: 'mine', under: 'att-my-payslips', path: 'att-my-medical', label: 'My claims', permission: 'att_me', render: renderAttMyMedical, live: ['pay'] },
  { mine: true, group: 'me', tab: 'Documents', mgroup: 'mine', mtab: 'Documents', path: 'att-my-contracts', label: 'My documents', permission: 'att_me', render: renderMyContracts, live: ['people'] },

  // ---- everybody who runs something --------------------------------------
  { group: 'home', tab: 'Home', path: 'home', label: 'Home', permission: 'att_view', render: renderHome, live: ['attendance', 'rota', 'leave', 'people', 'pay'] },
  { group: 'inbox', tab: 'Inbox', path: 'inbox', label: 'Inbox', permission: ['att_manage', 'att_setup', 'att_rota', 'hr_pay', 'hr_manage', 'lunch'], render: renderInbox, live: ['leave', 'rota', 'attendance', 'pay', 'people', 'lunch'] },

  { group: 'rota', tab: 'Build', path: 'att-rota', label: 'Rota', permission: ['att_rota', 'att_rota_view'], render: renderAttRota, live: ['rota', 'leave', 'attendance'] },
  { group: 'rota', tab: 'Swaps', path: 'att-swaps', label: 'Swaps', permission: ['att_rota', 'att_manage'], render: renderSwapQueue, live: ['rota'] },
  { group: 'rota', tab: 'Workload', path: 'att-workload', label: 'Workload', permission: ['att_rota', 'att_reports'], render: renderAttWorkload, live: ['rota', 'leave'] },
  { group: 'rota', tab: 'Lunch', path: 'att-lunch', label: 'Lunch', permission: 'lunch', render: renderAttLunch, live: ['lunch', 'rota'] },

  { group: 'day', tab: 'Today', path: 'att-today', label: 'Today', permission: 'att_view', render: renderAttToday, live: ['attendance', 'rota', 'leave'] },
  { group: 'day', tab: 'Week', path: 'att-week', label: 'Week', permission: 'att_reports', render: renderAttWeek, live: ['attendance', 'rota', 'leave'] },
  { group: 'day', tab: 'Month', path: 'att-overview', label: 'Month', permission: ['att_reports', 'att_rota'], render: renderAttOverview, live: ['attendance', 'rota', 'leave'] },
  { group: 'day', tab: 'Leave', path: 'att-leave', label: 'Leave', permission: 'att_view', render: renderAttLeave, live: ['leave', 'rota'] },
  // Last, because it is what closes a period rather than what reads one, and
  // it is the only tab here that cannot be undone.
  { group: 'day', tab: 'Sign-off', path: 'signoff', label: 'Sign-off', permission: 'att_signoff', render: renderAttSignoff, live: ['attendance', 'rota', 'leave'] },

  { group: 'people', tab: 'Staff', path: 'people', label: 'People', permission: 'hr_view', render: renderPeople, live: ['people'] },
  { group: 'people', tab: 'Recruitment', path: 'rec', label: 'Recruitment', permission: 'rec_view', render: renderRec, live: ['recruitment'] },
  { group: 'people', tab: 'First weeks', path: 'onboarding-desk', label: 'First weeks', permission: ['hr_view', 'hr_manage'], render: renderOnboardingDesk, live: ['people'] },
  { group: 'people', tab: 'Letters', path: 'letters', label: 'Letters', permission: 'corr_view', render: renderLetters, live: ['letters'] },
  // Reachable by everybody signed in. Under Me for staff, under People for
  // everybody who runs something.
  { group: 'me', tab: 'Directory', mgroup: 'people', path: 'directory', label: 'Directory', permission: null, render: renderDirectory, live: ['people'] },
  { group: 'me', tab: 'Handbook', mgroup: 'people', path: 'handbook', label: 'Handbook', permission: null, render: renderHandbook, live: ['people'] },
  { group: 'me', tab: 'HR FAQ', mgroup: 'people', path: 'hr-faq', label: 'HR FAQ', permission: null, render: renderHrFaq, live: ['people'] },
  { group: 'me', tab: 'Guide', mgroup: 'mine', mtab: 'Guide', path: 'guide', label: 'Guide', permission: null, render: renderGuide },

  { group: 'money', tab: 'Payroll', path: 'att-payroll', label: 'Payroll', permission: 'hr_pay', render: renderAttPayrollTab, live: ['pay', 'attendance'] },
  { group: 'money', tab: 'Advances', path: 'att-advances', label: 'Advances', permission: 'hr_pay', render: renderAttAdvances, live: ['pay'] },
  { group: 'money', tab: 'Medical claims', path: 'att-medical', label: 'Medical claims', permission: 'hr_pay', render: renderAttMedical, live: ['pay'] },

  // Everything set once, as topics down the side of one screen.
  { group: 'setup', tab: 'Settings', path: 'settings', label: 'Settings', permission: ['att_setup', 'users'], render: renderSettings, live: ['admin'] },
  // The three screens it replaced keep their addresses, and open the topic
  // that holds what they showed.
  { alias: 'settings', path: 'att-setup', label: 'Settings', permission: 'att_setup', render: (params) => renderSettings({ ...params, from: 'att-setup' }), live: ['admin'], hidden: true },
  { alias: 'settings', path: 'notifications', label: 'Settings', permission: 'users', render: (params) => renderSettings({ ...params, from: 'notifications' }), live: ['admin'], hidden: true },
  { alias: 'settings', path: 'admin', label: 'Settings', permission: 'users', render: (params) => renderSettings({ ...params, from: 'admin' }), live: ['admin'], hidden: true },

  // Reached from Home rather than from the menu: closing the till is a job on
  // the day's list, not a place somebody goes.
  { mine: true, path: 'att-my-till', label: 'Close your till', permission: 'till', render: renderAttMyTill, hidden: true },
  { mine: true, path: 'att-my-till-issues', label: 'Till: to sort out', permission: 'till', render: renderAttMyTillIssues, hidden: true },

  // Reached by clicking a name rather than from the menu.
  { path: 'att-staff', label: 'Person', permission: 'att_view', render: renderAttStaff, live: ['attendance', 'rota', 'leave'], hidden: true },
  { path: 'person', label: 'Record', permission: 'hr_view', render: renderPerson, live: ['people'], hidden: true },
  { path: 'rec-candidate', label: 'Candidate', permission: 'rec_view', render: renderRecCandidate, live: ['recruitment'], hidden: true },
  { path: 'people-templates', label: 'Templates', permission: 'hr_manage', render: renderPeopleTemplates, hidden: true },
  { path: 'people-form', label: 'What to ask for', permission: 'hr_manage', render: renderPeopleForm, hidden: true },
  { path: 'contract', label: 'Contract', permission: 'hr_view', render: renderContract, live: ['people'], hidden: true },
  // The same page, read by the person it is about. A separate path because the
  // permission is the whole difference: hr_view reads anybody's, att_me reads
  // your own.
  { path: 'my-contract', label: 'My contract', permission: 'att_me', render: (params) => renderContract({ ...params, mine: true }), live: ['people'], hidden: true },
  { path: 'letter', label: 'Letter', permission: 'corr_view', render: renderLetter, live: ['letters'], hidden: true },
  { path: 'letter-compose', label: 'Write', permission: 'corr_write', render: renderLetterCompose, hidden: true },
  { path: 'letter-parties', label: 'Address book', permission: 'corr_view', render: renderLetterParties, live: ['letters'], hidden: true },
  { path: 'letter-signing', label: 'Signature & stamp', permission: 'corr_view', render: renderLetterSigning, live: ['letters'], hidden: true },
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
  // "Your own" needs a you. An administrator holds every permission there is,
  // including this one, and with no staff record behind the login there is
  // nothing of theirs to show, so the menu item goes: an item that opens an
  // apology is worse than no item.
  //
  // UNLESS THEY HAVE NOTHING ELSE. That reasoning assumed the alternative was
  // a full menu with one broken entry in it. For a member of staff whose
  // login has not been pointed at their record yet it produced something far
  // worse: every screen they own hidden, and an app that opened on the Guide
  // with no way out of it. One screen that explains why it is empty beats an
  // app that appears to contain nothing.
  return needed.some((p) => state.permissions.includes(p)
    && (!OWN_RECORD.has(p) || state.staffId != null || nothingElseToShow()));
}

/**
 * Whether this login opens anything at all beyond their own screens.
 *
 * Deliberately does not call `can`, which calls this.
 */
function nothingElseToShow() {
  return !ROUTES.some((route) => {
    if (route.hidden || !route.permission) return false;
    const needed = Array.isArray(route.permission) ? route.permission : [route.permission];
    return needed.some((p) => !OWN_RECORD.has(p) && state.permissions.includes(p));
  });
}

function allowed(route) {
  if (!route || !can(route.permission)) return false;
  // A screen can also be closed for a reason that is not a permission: a first
  // week belongs to somebody having one.
  return route.only ? Boolean(route.only()) : true;
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
  // A NEW HIRE LANDS ON THEIR FIRST WEEK, whatever else they can open. It is
  // the one morning where the most useful screen is not the one with today's
  // work on it: they have no shifts yet, and what they need is the welcome and
  // the list. It stops being the landing the day the list is done.
  if (state.startingOut && allowed(ROUTES.find((r) => r.path === 'onboarding'))) {
    return 'onboarding';
  }

  // Home first, for both menus: the manager's for anybody who runs the floor,
  // their own for everybody else.
  const preferred = ['home', 'inbox', 'att-today', 'att-overview', 'att-rota', 'signoff', 'att-leave',
    'people', 'letters', 'settings', 'my-day', 'att-me'];
  const wanted = preferred.find((path) => allowed(ROUTES.find((r) => r.path === path)));
  return wanted ?? ROUTES.find((r) => allowed(r) && !r.hidden)?.path ?? 'att-today';
}

/** Query params live after the route: #/att-today?day=2026-08-08 */
/**
 * Which screen was last arrived at, as opposed to redrawn.
 *
 * Null until the first draw, so the first screen of a session counts as an
 * arrival too: somebody opening the app on My shifts wants this week whatever
 * a bookmark says.
 */
let arrivedAt = null;

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

/** The way out, however it was reached. */
async function signOut() {
  stopLive();
  unguard();
  await api.logout().catch(() => {});
  resetSession();
  render();
}

/** Which of the two menus this login gets. */
function mode() {
  return nothingElseToShow() ? 'staff' : 'manager';
}

/** The groups this login can open, worked out against what they hold. */
function myGroups() {
  const which = mode();
  return openGroups(ROUTES, which === 'staff' ? STAFF_GROUPS : MANAGER_GROUPS, allowed, groupKeyFor(which));
}

/** Which group the screen on the page belongs to. */
function hereGroup(groups = myGroups()) {
  const route = currentRoute();
  return groupOf(groups, route?.alias ?? route?.path);
}

/**
 * The tabs across the top of a group that holds more than one screen.
 *
 * Above the page rather than inside each view, in the shell beside the who
 * strip, because it belongs to the menu rather than to any of the screens
 * under it. Anchors rather than buttons so the router handles them, which
 * means a half-filled form gets the same warning it would from the menu.
 */
function groupStrip() {
  const group = hereGroup();
  if (!group) return null;
  const here = currentRoute()?.path;
  const tab = (t, active) => h('a', { href: `#/${t.path}`, class: active ? 'active' : '' }, t.label);

  // A manager's own screens: one row of the five things they are, and the
  // screens under the one they are on as a smaller second row.
  if (mode() === 'manager' && group.key === 'mine') {
    const { tabs, parent, siblings } = mineTabs(group, here);
    return h('div.group-strips',
      tabs.length > 1 ? h('div.group-tabs.seg.seg-wrap', tabs.map((t) => tab(t, t.path === parent))) : null,
      siblings.length ? h('div.group-tabs.group-tabs-sub.seg.seg-sm.seg-wrap', siblings.map((t) => tab(t, t.path === here))) : null);
  }

  if (group.screens.length < 2) return null;
  return h('div.group-tabs.seg.seg-wrap', tabsOf(group).map((t) => tab(t, here === t.path)));
}

function sidebar() {
  const groups = myGroups();
  const current = hereGroup(groups);

  const link = (group) => h('a.side-link', {
    href: `#/${group.screens[0].path}`,
    class: current?.key === group.key ? 'side-link active' : 'side-link',
    onclick: () => closeDrawer(),
  }, icon(group.icon), h('span.side-label', group.label),
  group.key === 'inbox' ? h('span.side-count', { 'data-inbox-count': '', hidden: true }) : null);

  const main = groups.filter((g) => !g.foot);
  const foot = groups.filter((g) => g.foot);

  return h('nav.sidebar', { 'aria-label': 'Main menu' },
    h('div.side-group', main.map(link)),
    foot.length ? h('div.side-group.side-group-foot', foot.map(link)) : null,

    // Only ever seen on a phone, where it is not on the header. Last in the
    // drawer, under everything else, because it is the one thing here nobody
    // wants to press by accident.
    h('div.side-foot.only-phone',
      h('div.side-who', state.name || '', state.name ? h('br') : null,
        h('small', roleLabel(state.role))),
      h('button.btn-sm', { onclick: signOut }, 'Sign out')),
  );
}

/**
 * The tabs along the bottom of a phone.
 *
 * Staff get their five places. Everybody else gets their first four and a
 * More that opens the full menu, because six places and two more do not fit
 * across a handset.
 */
function bottomBar() {
  const groups = myGroups();
  if (!groups.length) return null;
  const current = hereGroup(groups);
  const staff = mode() === 'staff';
  const shown = staff ? groups.slice(0, 5) : groups.filter((g) => !g.foot).slice(0, 4);

  const tab = (group) => h('a.bottom-tab', {
    href: `#/${group.screens[0].path}`,
    class: current?.key === group.key ? 'bottom-tab active' : 'bottom-tab',
    'aria-current': current?.key === group.key ? 'page' : null,
  }, icon(group.icon, 22), h('span', group.label),
  group.key === 'inbox' ? h('span.bottom-count', { 'data-inbox-count': '', hidden: true }) : null);

  return h('nav.bottom-bar', { 'aria-label': 'Main' },
    shown.map(tab),
    staff && groups.length <= 5 ? null : h('button.bottom-tab', {
      type: 'button',
      class: shown.some((g) => g.key === current?.key) ? 'bottom-tab' : 'bottom-tab active',
      onclick: () => document.querySelector('.shell')?.classList.add('nav-open'),
    }, icon('more', 22), h('span', 'More')));
}

/**
 * How many decisions are waiting, on the Inbox link.
 *
 * Asked after the page has drawn and never more than once a minute, because
 * the answer comes from every kind of request at once.
 */
let inboxAskedAt = 0;
async function paintInboxCount(force = false) {
  if (mode() !== 'manager' || !DECIDES.some((p) => can(p))) return;
  if (!force && Date.now() - inboxAskedAt < 60_000) {
    showInboxCount(lastInboxCount);
    return;
  }
  inboxAskedAt = Date.now();
  lastInboxCount = await inboxCount().catch(() => lastInboxCount);
  showInboxCount(lastInboxCount);
}
let lastInboxCount = 0;
function showInboxCount(n) {
  for (const el of document.querySelectorAll('[data-inbox-count]')) {
    el.textContent = n > 99 ? '99+' : String(n || '');
    el.hidden = !n;
  }
}
export function inboxChanged() {
  paintInboxCount(true);
}

function closeDrawer() {
  document.querySelector('.shell')?.classList.remove('nav-open');
}

/**
 * Hiding the menu on a wide screen.
 *
 * Two different things wear the same button. On a phone it is a drawer that
 * slides over the page, because nineteen links down the side would leave no
 * room for what they lead to. On a desk it is a column that is simply not
 * there, because a rota fourteen days wide and a payslip at A4 both want the
 * two hundred pixels back.
 *
 * The choice is remembered, per browser. Somebody who folds the menu away to
 * read a rota does not want it back the next time they open one.
 */
const MENU_KEY = 'hive.menu.folded';

const menuFolded = () => {
  try {
    return localStorage.getItem(MENU_KEY) === '1';
  } catch {
    // A browser refusing storage is not a reason to have no menu at all.
    return false;
  }
};

function applyMenu(shellEl) {
  shellEl?.classList.toggle('nav-folded', menuFolded());
}

function toggleMenu() {
  const shellEl = document.querySelector('.shell');
  if (!shellEl) return;

  // Under 900 pixels the same button is the drawer, which is a different
  // thing and is never remembered: a drawer left open over the page would be
  // a strange way to greet somebody.
  if (window.matchMedia('(max-width: 900px)').matches) {
    shellEl.classList.toggle('nav-open');
    return;
  }

  const folded = !shellEl.classList.contains('nav-folded');
  shellEl.classList.toggle('nav-folded', folded);
  try {
    localStorage.setItem(MENU_KEY, folded ? '1' : '0');
  } catch {
    // Then it lasts until the page is reloaded, which is still better than
    // refusing to fold at all.
  }
}

// ---------------------------------------------------------------------------
// Whose screens these are
// ---------------------------------------------------------------------------

/**
 * A login that carries more than one person's record.
 *
 * Rare, and real: somebody on the books twice from a reissued card, and
 * somebody with no phone of their own whose record sits on the phone of
 * whoever they live with. The choice is remembered for the tab and not
 * beyond it, so a shared handset does not open on the last person who used
 * it after somebody signs in again.
 */
const WHO_KEY = 'hive.showing';

function rememberedWho() {
  try {
    return Number(sessionStorage.getItem(WHO_KEY)) || null;
  } catch {
    return null;
  }
}

/**
 * Show this person's screens from here on.
 *
 * Null means the first record, which is their own, and sends nothing with any
 * request: a login with one person on it behaves exactly as it always has.
 */
function showing(staffId) {
  const first = state.records[0]?.id ?? null;
  const wanted = staffId == null || staffId === first ? null : Number(staffId);
  state.actingFor = wanted;
  actFor(wanted);
  try {
    if (wanted == null) sessionStorage.removeItem(WHO_KEY);
    else sessionStorage.setItem(WHO_KEY, String(wanted));
  } catch {
    // Then it lasts until the page is reloaded, which is no worse than what
    // the app did before there was anybody to choose between.
  }
}

/**
 * Ask again who is signed in, and redraw.
 *
 * For the handful of things somebody changes about themselves from inside the
 * app: a photograph is the one that shows, in the corner of the header, on
 * every screen. Cheaper and less surprising than reloading the page, which
 * would throw away whatever they had half filled in behind the dialog.
 */
export async function refreshSession() {
  const me = await api.me().catch(() => null);
  if (!me?.authenticated) return;
  adoptSession(me);
  await render();
}

/** Everything about who is signed in, from one answer, in one place. */
function adoptSession(me) {
  state.role = me.role ?? state.role;
  state.name = me.name ?? state.name;
  state.email = me.email ?? null;
  state.isRecovery = Boolean(me.isRecovery);
  state.hasPhoto = Boolean(me.hasPhoto);
  state.photoAt = me.photoAt ?? null;
  state.startingOut = Boolean(me.startingOut);
  state.hasPin = Boolean(me.hasPin);
  state.hasPassword = Boolean(me.hasPassword);
  state.signedInWith = me.signedInWith ?? 'pin';
  state.permissions = me.permissions || [];
  state.settings = me.settings || state.settings || {};
  state.staffId = me.staffId ?? null;
  state.records = me.records ?? [];
  state.permissionLabels = me.permissionLabels || state.permissionLabels || {};
  state.roleLabels = me.roleLabels || state.roleLabels || {};
  state.mustChangePin = Boolean(me.mustChangePin);

  // A name remembered from earlier in this tab, but only if it is still one of
  // theirs: an administrator can take a record off a login at any time, and
  // the tab would go on asking for it.
  const remembered = rememberedWho();
  showing(state.records.some((p) => p.id === remembered) ? remembered : null);
}

/**
 * Which of them the "my" screens are showing, on the screens that show one.
 *
 * Above the page rather than inside each of the five, because it is the same
 * question on all of them and the answer has to hold as somebody moves from
 * their week to their payslips. Nothing at all for the ordinary login, which
 * is one person.
 */
function whoStrip() {
  if (state.records.length < 2 || !currentRoute()?.mine) return null;
  const now = state.actingFor ?? state.records[0].id;
  const showThem = (event) => {
    showing(Number(event.target.value));
    render();
  };

  // Said loudly when it is not their own record. Every one of these screens is
  // headed "My", and "My payslips" over somebody else's pay is the app telling
  // a lie in large type.
  const mine = now === state.records[0].id;
  const them = state.records.find((person) => person.id === now)?.name ?? 'somebody else';

  return h(mine ? 'div.who-strip' : 'div.who-strip.not-me',
    h('span.who-strip-label', 'Showing'),
    h('select.who-strip-pick', { 'aria-label': 'Whose screens to show', onchange: showThem },
      state.records.map((person, i) => h('option', {
        value: String(person.id),
        selected: person.id === now,
      }, i === 0 ? `${person.name} (you)` : person.name))),
    h('span.who-strip-note', mine
      ? 'Your own shifts, report, advances, claims and payslips'
      : `Not your own. This is ${them}\u2019s week, report, advances, claims and payslips.`),
  );
}

function shell(content) {
  const shellEl = h(`div.shell.mode-${mode()}`,
    h('header.topbar',
      h('button.btn-ghost.btn-sm.nav-toggle', {
        title: 'Show or hide the menu',
        'aria-label': 'Show or hide the menu',
        onclick: toggleMenu,
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
        title: state.role === 'admin' ? 'My password and PIN' : 'Change my PIN',
        'aria-label': 'My account',
        onclick: () => openAccountDialog({
          role: state.role,
          name: state.name || 'you',
          email: state.email,
          isRecovery: state.isRecovery,
          hasPin: state.hasPin,
          hasPassword: state.hasPassword,
          signedInWith: state.signedInWith,
          // Anybody who has to act on an exception is worth alerting; somebody
          // who only reads the month-end report is not, and would come to
          // resent a phone buzzing every morning about it.
          // Anybody a notification would actually reach. That is whoever
          // settles the morning list, and now also anybody on the rota: a
          // published shift and "your shift started" are the two alerts
          // written for a phone rather than a desk.
          canAlert: can('att_manage') || can('att_me'),
          // Only somebody who appears on a rota has a picture to choose. A
          // login that belongs to nobody on the staff list has nowhere for
          // one to show.
          canPhoto: can('att_me'),
          // The code that guards My payslips. Same test: a login that belongs
          // to nobody on the staff list has no payslips to put one on.
          canLockPayslips: can('att_me'),
        }),
      },
      // Their own face rather than a drawing of a person: the photograph they
      // sent in, or their initials on the colour their name works out to,
      // which is the same face the directory and the rota put beside them. It
      // also says at a glance which of two logins a shared handset is on.
      //
      // Cache-busted on the version rather than on every draw, or the header
      // would fetch the picture again on every redraw the live socket causes,
      // which on a busy morning is every punch on the terminal.
      h('span.only-phone', face(state.name, {
        src: state.hasPhoto
          ? `/api/me/photo?v=${encodeURIComponent(state.photoAt ?? '')}`
          : null,
        size: '1.7rem',
      })),
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
      h('main.main', whoStrip(), groupStrip(), content),
    ),
    bottomBar(),
  );

  applyMenu(shellEl);
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

/**
 * The screen currently mounted in the shell.
 *
 * Held so a live update can put a fresh view straight into it rather than
 * rebuilding the page around it.
 */
let screen = null;

/**
 * Draw the route.
 *
 * `quiet` is for an update nobody asked for. A first paint and a change of
 * screen both want the skeleton — something has to be on the page while the
 * first request is out — but a live update has a perfectly good screen up
 * already, and replacing it with a grey box for as long as the fetch takes is
 * two seconds of nothing on a phone, several times an hour. Quiet builds the
 * new view first and swaps it in when it is ready, so the page never empties.
 */
export async function render({ quiet = false } = {}) {
  root.classList.remove('app-loading');

  if (!state.role) {
    mount(root, renderLogin(async (signedIn) => {
      // What signing in answered, then the fuller answer if it can be had. The
      // sign-in reply is enough to open the app; the session says who else is
      // on this login and what the property is called, and without asking for
      // it the header opened nameless until the next reload.
      const me = await api.me().catch(() => null);
      adoptSession(me?.authenticated ? me : signedIn);
      // Before the watch starts. Signing in is somebody proving who they are,
      // and the watch would otherwise open on a phone with nothing written
      // down and ask them for the same PIN a second time.
      justProved();
      startLive();
      watchForTheRoom();
      checkVersion(api.version, { force: true });
      if (!location.hash || !currentRoute()) navigate(defaultRoute());
      await render();
    }));
    return;
  }

  // Nothing else until the PIN is long enough. Drawn in place of the app
  // rather than over it, so there is no screen behind it to get back to.
  if (state.mustChangePin) {
    mount(root, renderForcedPinChange({
      role: state.role,
      email: state.email,
      onDone: async () => {
        state.mustChangePin = false;
        state.hasPin = true;
        if (!currentRoute()) navigate(defaultRoute());
        await render();
      },
    }));
    return;
  }

  const route = currentRoute();
  if (!route) {
    navigate(defaultRoute());
    return;
  }

  // ARRIVING AT A SCREEN IS NOT THE SAME AS IT REDRAWING UNDER YOU.
  //
  // Both come through here, and a handful of things in the address are worth
  // keeping through the second and not through the first. My shifts is the
  // one: it opens on this week however it was left, but the week somebody
  // walked to has to survive a live update, and on a working property that is
  // every punch on the terminal all morning. Held in the address, which is the
  // only place a redraw reads, and cleared on the way in.
  if (route.path !== arrivedAt) {
    arrivedAt = route.path;
    if (route.freshEach?.length) {
      const params = routeParams();
      let dropped = false;
      for (const key of route.freshEach) {
        if (key in params) { delete params[key]; dropped = true; }
      }
      if (dropped) replaceParams(route.path, params);
    }
  }

  // Whatever the last view asked us not to interrupt went with it, and a
  // change waiting for the old screen has been answered by drawing this one.
  holds = [];
  unsaved = [];
  pending = false;

  // A live update is not a new screen. The shell stays where it is — the bell
  // keeps its own count up to date and the menu has not changed — and what is
  // on the page stays on the page until there is something to put in its
  // place.
  const inPlace = quiet && screen?.isConnected;
  const container = inPlace ? screen : h('div');
  if (!inPlace) {
    mount(root, shell(container));
    trackTopbarHeight();
    mount(container, h('div.card', h('div.skeleton', { style: { height: '120px' } })));
  }
  screen = container;

  try {
    // Built before anything on screen is touched, which is what makes a quiet
    // update quiet: the old view is still there while this is in the air.
    const view = await route.render(routeParams());
    mount(container, view);
    paintInboxCount();
    // No greeting banner any more: Home is the greeting, and says what is
    // waiting. A banner above every first screen was the same thing twice.
  } catch (err) {
    if (err.status === 401) return; // the unauthorized handler already reset us
    mount(container, h('div.card.empty',
      h('h3', 'Could not load this view'),
      h('p.muted', err.message || String(err)),
      h('button.btn-primary', { onclick: () => render() }, 'Try again'),
    ));
  }
}

// ---------------------------------------------------------------------------
// Keeping the screen honest
// ---------------------------------------------------------------------------

/**
 * The page brings itself up to date, when something actually changes.
 *
 * These screens are read as boards. Somebody leaves Today open on the office
 * computer, or opens Rota on a phone and puts it in a pocket, and an hour
 * later they are looking at an hour-old answer and treating it as this
 * morning's. Nothing about the page says so, which is the whole problem: a
 * stale screen and a fresh one are indistinguishable.
 *
 * This used to be a timer — once a minute, on every screen, whether or not
 * anything had happened. Wrong on both sides: a rota two people are building
 * at the same time was a minute behind all day, and a phone on a counter with
 * nothing going on fetched fourteen hundred times a day to be told so. Now the
 * server says when something changed and the screen answers it, which is both
 * immediate and quiet. See live.js.
 *
 * THREE THINGS STOP IT BEING AN INTERRUPTION, which is the only way a thing
 * like this survives on a screen somebody is working in.
 *
 *   It never refreshes while somebody is in the middle of something. A dialog
 *   open, a cursor in a box, or a view holding unsaved changes all hold it
 *   off, and it comes back to it when the screen is free rather than throwing
 *   the work away.
 *
 *   It does nothing while the tab is hidden. A phone in a pocket is not
 *   reading anything. What arrived while it was away is remembered, and taken
 *   in the moment somebody looks at the screen again.
 *
 *   It is silent. No spinner, no flash, no scroll jump — the view is rebuilt
 *   in place and the page keeps its scroll position, so somebody reading the
 *   bottom of a list stays at the bottom of it.
 */

/**
 * How long to wait before asking again while the live channel is down.
 *
 * The only timer left, and it runs only when there is no socket: a site that
 * cannot be told is better off asking slowly than sitting on an answer from
 * an hour ago. It stops the moment the socket comes back.
 */
const WHILE_DEAF_MS = 120000;

/** How often to look at a deferred update to see whether the screen is free. */
const RETRY_MS = 4000;

/** What a view has asked us not to interrupt. Cleared on every render. */
let holds = [];

/**
 * "Do not refresh me yet."
 *
 * A view with staged edits registers one of these. It is asked, not told, so a
 * view that has since been replaced simply stops being asked.
 */
export function holdRefresh(check) {
  holds.push(check);
}

/** What is on the screen and not yet saved. Cleared on every render. */
let unsaved = [];

/**
 * "Ask before you take this away."
 *
 * A view with work somebody has done and not saved registers one of these: a
 * function returning what would be lost, or nothing when there is nothing to
 * lose. It is asked when the screen is about to be replaced and when the tab
 * is about to close.
 *
 * Asked rather than told, the same as holdRefresh, so a view that has since
 * been replaced simply stops being asked — and so a screen cannot leave a
 * warning behind after its work has been saved.
 */
export function warnBeforeLeaving(what, { key = null } = {}) {
  // A key replaces rather than adds. A screen that redraws part of itself
  // without the router — switching a tab, changing a month — would otherwise
  // leave the guard for the half it has just thrown away still answering.
  if (key) unsaved = unsaved.filter((c) => c.key !== key);
  const check = () => what();
  check.key = key;
  unsaved.push(check);
}

/** The first thing that would be lost, said in words somebody can act on. */
function wouldBeLost() {
  for (const check of unsaved) {
    try {
      const said = check();
      if (said) return typeof said === 'string' ? said : 'Changes you have not saved';
    } catch {
      // A view mid-teardown is not a reason to trap somebody on a screen.
    }
  }
  return null;
}

const busy = () => {
  if (document.querySelector('dialog[open]')) return true;
  const focused = document.activeElement;
  if (focused && /^(INPUT|SELECT|TEXTAREA)$/.test(focused.tagName)) return true;
  return holds.some((check) => {
    try { return check(); } catch { return false; }
  });
};

/** Something changed that this screen has not taken in yet. */
let pending = false;
let deafTimer = null;

/**
 * Is this screen looking at the thing that changed?
 *
 * A route says what it watches; one that says nothing watches everything,
 * which is what every screen did under the timer and is the safe answer for a
 * screen nobody has thought about yet.
 */
function watching(topic) {
  const route = currentRoute();
  if (!route) return false;
  if (!route.live || topic === 'other') return true;
  return route.live.includes(topic);
}

async function catchUp() {
  // A new deploy is picked up in exactly the same gap, and for the same
  // reason: an app opened from a home screen is handed back the page it
  // already had, so nothing else ever brings a new version in. Reloading is
  // the heavier of the two, so it goes first and this returns — the page is
  // on its way out.
  if (waitingToRefresh() && !document.hidden && state.role && !busy()
      && !wouldBeLost() && serverReachable()) {
    takeTheNewOne();
    return;
  }

  if (!pending) return;
  // Not gone — held. Somebody typing, or a dialog open, or a rota with staged
  // edits: the update waits for the screen to be free rather than taking the
  // work with it.
  if (document.hidden || !state.role || busy() || !serverReachable()) return;

  pending = false;
  const x = window.scrollX;
  const y = window.scrollY;
  // The rota scrolls inside its own box rather than with the page, so keeping
  // the page's place is only half of keeping somebody's place.
  const putBack = keepScroll('.rota-scroll');
  await render({ quiet: true });
  // The shell stays put now, but the view inside it is replaced and a taller
  // or shorter one moves the page under somebody who was reading it.
  window.scrollTo(x, y);
  putBack();
}

onLive((event) => {
  if (event.topics) {
    if (event.topics.some(watching)) {
      pending = true;
      catchUp();
    }
    return;
  }

  if (event.open) {
    clearInterval(deafTimer);
    deafTimer = null;
    // Back after being away. Whatever happened in between was said down a
    // socket that was not there to hear it, so the screen asks once.
    if (event.missed) {
      pending = true;
      catchUp();
    }
    return;
  }

  // No socket. Fall back to asking, slowly, rather than sitting on an answer
  // that gets older every minute.
  if (!deafTimer) {
    deafTimer = setInterval(() => {
      if (liveUp()) return;
      pending = true;
      catchUp();
    }, WHILE_DEAF_MS);
  }
});

// A held update, looked at again. Not a poll: nothing is fetched unless
// something already told us there was a reason to.
setInterval(() => { if (pending || waitingToRefresh()) catchUp(); }, RETRY_MS);

document.addEventListener('visibilitychange', async () => {
  // Back from a pocket, and this is the moment whatever arrived while it was
  // in there is worth putting on the screen.
  if (document.hidden) return;
  catchUp();
  // And the moment to find out whether the app itself has moved on. Closing
  // and opening one on a home screen does not reload it, so without this the
  // screen stays on whatever version it was opened with.
  if (state.role && await checkVersion(api.version)) catchUp();
});

/**
 * Nobody is standing here any more.
 *
 * Half of what this app holds is somebody else's business: their pay, their
 * leave, who is off sick on Thursday. A phone put down on a bar with it open
 * is a screen the room can read, so it does not stay open for the room.
 */
function watchForTheRoom() {
  guard({
    signOut,
    // What they hold as well as what they last used. The lock asks for the
    // wrong credential otherwise, and used to give no way to correct it.
    who: () => ({
      name: state.name,
      signsInWith: state.signedInWith,
      email: state.email,
      hasPin: state.hasPin,
      hasPassword: state.hasPassword,
      isRecovery: state.isRecovery,
    }),
    // Somebody who unlocked with a PIN from before the six-digit rule. The
    // forced-change screen is drawn in place of the app, the same as it is at
    // sign-in, so there is nothing behind it to get back to.
    shortPin: () => { state.mustChangePin = true; render(); },
  });
}

function resetSession() {
  state.role = null;
  state.name = null;
  state.email = null;
  state.isRecovery = false;
  state.hasPhoto = false;
  state.photoAt = null;
  state.startingOut = false;
  state.hasPin = false;
  state.hasPassword = false;
  state.signedInWith = 'pin';
  state.permissions = [];
  state.staffId = null;
  // And whoever this login was showing. A tablet somebody else signs in on
  // must not open on the last person's payslips.
  state.records = [];
  showing(null);
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
  // The socket is a signed-in thing. Holding one open against a session that
  // has expired is a reconnect loop nobody can see.
  stopLive();
  resetSession();
  render();
});

/**
 * Leaving a screen with work on it that has not been saved.
 *
 * The screen is about to be replaced and whatever is staged on it goes with
 * it. Somebody who has typed fifteen figures and pressed a menu item by
 * mistake should be asked, not simply have the afternoon taken away.
 *
 * The hash has already moved by the time this runs, so saying no means putting
 * it back — and putting it back fires another hashchange, which the flag
 * swallows.
 */
let hereNow = location.hash;
let goingBack = false;

window.addEventListener('hashchange', async () => {
  if (goingBack) { goingBack = false; return; }

  const said = wouldBeLost();
  if (said && !window.confirm(`${said}. Leave this screen anyway?`)) {
    goingBack = true;
    location.hash = hereNow;
    return;
  }

  hereNow = location.hash;
  await render();
});

// And the tab itself. The browser shows its own words rather than ours, but it
// will not show them at all unless the page says there is something to lose.
window.addEventListener('beforeunload', (e) => {
  if (!wouldBeLost()) return;
  e.preventDefault();
  e.returnValue = '';
});

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
  // Before anything is drawn: every full-height thing on the page is measured
  // against this.
  watchScreenHeight();
  holdBehindDialogs();

  try {
    const me = await api.me();
    if (me.authenticated) adoptSession(me);
  } catch { /* fall through to the login screen */ }

  if (state.role && !currentRoute()) navigate(defaultRoute());
  if (state.role) {
    startLive();
    watchForTheRoom();
    // Which version this screen is. Learned once, on the way in, so that
    // every later answer has something to be compared against. Nothing waits
    // for it.
    checkVersion(api.version, { force: true });
  }
  await render();
})();
