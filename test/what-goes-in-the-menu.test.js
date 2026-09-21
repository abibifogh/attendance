import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { HEADINGS_FROM, groupOf, menuRuns, openGroups, tabsOf } from '../public/js/menu.js';
import { ROLES, allows, effectivePermissions } from '../src/lib/permissions.js';

/**
 * Twenty-three links became nine.
 *
 * One link per screen was fine at ten and unreadable at twenty-three: an
 * administrator opening the app was reading a list longer than anybody ever
 * used, and the five screens that answer "what happened" sat in it beside the
 * three that answer "who is on" with nothing saying so.
 *
 * Every screen is still here and still has its own address. What changed is
 * that the ones answering the same question share a link, and the link names
 * the question. Which is exactly the kind of thing that goes quietly wrong for
 * somebody who is not you, so the table itself is read here and put through
 * the real grouping, role by role.
 */

// ---------------------------------------------------------------------------
// The real table, read out of the app
// ---------------------------------------------------------------------------

const APP = readFileSync('public/js/app.js', 'utf8');

const one = (line, key) => line.match(new RegExp(`\\b${key}: '([^']*)'`))?.[1] ?? null;

/** Every route the app declares, as the menu sees it. */
function routes() {
  const out = [];
  for (const line of APP.split('\n')) {
    if (!/^\s*\{ .*\bpath: '/.test(line)) continue;
    const list = line.match(/permission: \[([^\]]*)\]/);
    out.push({
      group: one(line, 'group'),
      path: one(line, 'path'),
      label: one(line, 'label'),
      tab: one(line, 'tab'),
      hidden: /\bhidden: true/.test(line),
      // A screen can be closed for a reason that is not a permission. The only
      // one so far is a first week, which belongs to somebody having one.
      only: /\bonly: /.test(line),
      permission: list
        ? list[1].split(',').map((p) => p.trim().replace(/'/g, ''))
        : one(line, 'permission'),
    });
  }
  return out;
}

/** And every group, in menu order. */
function groups() {
  const block = APP.slice(APP.indexOf('const GROUPS = ['), APP.indexOf('const ROUTES = ['));
  return block.split('\n')
    .filter((line) => /^\s*\{ key: '/.test(line))
    .map((line) => ({
      key: one(line, 'key'), label: one(line, 'label'), section: one(line, 'section'),
    }));
}

const ROUTE_LIST = routes();
const GROUP_LIST = groups();

/** The app's own permission test, for somebody holding these. */
const holder = (held, { staffId = 1, startingOut = false } = {}) => (route) => {
  // `only` first, because a permission everybody holds is not the question it
  // is asking. Nobody is onboarding unless the caller says so.
  if (route.only && !startingOut) return false;
  if (!route.permission) return true;
  const needed = Array.isArray(route.permission) ? route.permission : [route.permission];
  return needed.some((p) => allows(p, held) && (p !== 'att_me' || staffId != null));
};

const menuFor = (held, opts) => openGroups(ROUTE_LIST, GROUP_LIST, holder(held, opts));
const labels = (held, opts) => menuFor(held, opts).map((g) => g.label);

/** What somebody in this role actually holds, the way the server works it out. */
const roleHolds = (role, staffId = null) => effectivePermissions({ role, staff_id: staffId });

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

test('the app reads out as fourteen groups and thirty-one screens', () => {
  assert.equal(GROUP_LIST.length, 14);
  const inMenu = ROUTE_LIST.filter((r) => !r.hidden);
  assert.equal(inMenu.length, 31, 'nothing was dropped, only regrouped');
  for (const route of inMenu) {
    assert.ok(route.group, `${route.path} is in the menu with no group`);
    assert.ok(GROUP_LIST.some((g) => g.key === route.group), `${route.path}: no such group`);
  }
});

test('nothing hidden claims a group, and nothing sits in a group alone by accident', () => {
  for (const route of ROUTE_LIST.filter((r) => r.hidden)) {
    assert.equal(route.group, null, `${route.path} is hidden and grouped`);
  }
  // Every group has at least one screen, or it is a link to nowhere.
  for (const group of GROUP_LIST) {
    assert.ok(ROUTE_LIST.some((r) => r.group === group.key), `${group.key} has no screens`);
  }
});

// ---------------------------------------------------------------------------
// What each role opens
// ---------------------------------------------------------------------------

test('an administrator reads thirteen links, where they read twenty-three', () => {
  const menu = labels(roleHolds('admin', 1), { staffId: 1 });
  assert.deepEqual(menu, [
    'My shifts', 'My pay', 'My documents', 'Attendance', 'Rota', 'People', 'Payroll',
    'Letters', 'Directory', 'Handbook', 'First weeks', 'Setup', 'Guide',
  ]);
  assert.equal(menu.length, 13);
  assert.equal(ROUTE_LIST.filter((r) => !r.hidden).length, 31, 'and it is the same screens');
});

test('a new hire has one more link than they will have next month', () => {
  // The whole difference between a checklist and a screen. It is in the menu
  // while it is open and gone the day it is done, rather than sitting there
  // for the next two years saying nothing.
  const settled = menuFor(['att_me']).map((g) => g.label);
  const starting = labels(['att_me'], { startingOut: true });

  assert.equal(starting.includes('My first week'), true);
  assert.equal(settled.includes('My first week'), false);
  assert.equal(starting.length, settled.length + 1);
  // And it is the first thing in the menu, because it is the first morning.
  assert.equal(starting[0], 'My first week');
});

test('a first week is theirs, and the list of everybody’s is not', () => {
  // Two screens, two permissions. A new hire holds nothing at all, so the one
  // that is theirs asks for nothing; the one that is everybody's asks for the
  // personnel permission.
  const mine = ROUTE_LIST.find((r) => r.path === 'onboarding');
  const desk = ROUTE_LIST.find((r) => r.path === 'onboarding-desk');
  assert.equal(mine.permission, null);
  assert.equal(mine.only, true);
  assert.deepEqual(desk.permission, ['hr_view', 'hr_manage']);
  assert.equal(desk.only, false);

  assert.equal(labels(['att_me'], { startingOut: true }).includes('First weeks'), false);
  assert.equal(labels(['hr_view'], { staffId: null }).includes('First weeks'), true);
});

test('a member of staff reads six, and their own week is the first', () => {
  const menu = menuFor(['att_me']);
  assert.deepEqual(menu.map((g) => g.label),
    ['My shifts', 'My pay', 'My documents', 'Directory', 'Handbook', 'Guide']);
  assert.equal(menu[0].screens[0].path, 'att-me');
  assert.deepEqual(tabsOf(menu[0]).map((t) => t.label), ['Shifts', 'Report', 'Swaps', 'Lunch']);
  assert.deepEqual(tabsOf(menu[1]).map((t) => t.label), ['Payslips', 'Advance', 'Claims']);
  // Their own signed contract. A link of its own rather than a fourth tab
  // under My pay: it is not pay, it is the terms pay is settled by. One screen,
  // so no tab strip over it.
  assert.deepEqual(menu[2].screens.map((r) => r.path), ['att-my-contracts']);
  assert.deepEqual(tabsOf(menu[2]), []);
});

test('a login with no staff record behind it gets none of the "my" screens', () => {
  // An administrator holds att_me like every other permission and has nothing
  // of their own to show. A link that opens an apology is worse than no link.
  assert.deepEqual(labels(roleHolds('admin'), { staffId: null }), [
    'Attendance', 'Rota', 'People', 'Payroll', 'Letters', 'Directory', 'Handbook',
    'First weeks', 'Setup', 'Guide',
  ]);
});

test('a rota reader still reads one screen and no tabs', () => {
  const menu = menuFor(roleHolds('rota_reader'), { staffId: null });
  assert.deepEqual(menu.map((g) => g.label), ['Rota', 'Directory', 'Handbook', 'Guide']);
  assert.deepEqual(tabsOf(menu[0]), [], 'one screen is not a tab strip');
});

test('a supervisor reads three, and Today carries the leave book with it', () => {
  const menu = menuFor(roleHolds('supervisor'), { staffId: null });
  assert.deepEqual(menu.map((g) => g.label),
    ['Attendance', 'Rota', 'Directory', 'Handbook', 'Guide']);
  // No Week: that is the reports permission, which a supervisor is not given.
  assert.deepEqual(tabsOf(menu[0]).map((t) => t.label), ['Today', 'Month', 'Leave', 'Sign-off']);
});

test('a manager reads eight, where the same person used to read fourteen', () => {
  const menu = menuFor(roleHolds('manager'), { staffId: null });
  assert.deepEqual(menu.map((g) => g.label),
    ['Attendance', 'Rota', 'People', 'Letters', 'Directory', 'Handbook', 'First weeks',
      'Guide']);
  assert.deepEqual(tabsOf(menu[0]).map((t) => t.label),
    ['Today', 'Week', 'Month', 'Leave', 'Sign-off']);
  assert.deepEqual(tabsOf(menu[1]).map((t) => t.label), ['Rota', 'Swaps', 'Workload', 'Lunch']);
  assert.deepEqual(tabsOf(menu[2]).map((t) => t.label), ['People', 'Recruitment']);
});

test('a link never promises a screen its holder cannot open', () => {
  // Whoever does the wages reads the workload and the lunch list and has no
  // business moving anybody. A link reading "Rota" that cannot open the rota
  // would be the menu telling a lie, so it takes the name of what it opens.
  const menu = menuFor(['att_view', 'att_reports', 'lunch'], { staffId: null });
  const rota = menu.find((g) => g.key === 'rota');
  assert.equal(rota.label, 'Workload');
  assert.equal(rota.screens[0].path, 'att-workload');
  assert.deepEqual(tabsOf(rota).map((t) => t.label), ['Workload', 'Lunch']);

  // Every link, for every role: the screen it opens is one they hold.
  for (const role of ROLES) {
    for (const group of menuFor(roleHolds(role.key))) {
      assert.ok(holder(roleHolds(role.key))(group.screens[0]),
        `${role.key} gets a "${group.label}" link onto ${group.screens[0].path}`);
    }
  }
});

test('whoever does the wages sees the payroll and not the setup', () => {
  const menu = labels(['att_view', 'hr_pay'], { staffId: null });
  assert.deepEqual(menu, ['Attendance', 'Payroll', 'Directory', 'Handbook', 'Guide']);
});

test('somebody who manages logins but does not set the property up lands on their own tab', () => {
  const menu = menuFor(['users'], { staffId: null });
  const setup = menu.find((g) => g.key === 'setup');
  assert.equal(setup.label, 'Notifications', 'not "Setup", which they cannot open');
  assert.deepEqual(tabsOf(setup).map((t) => t.label), ['Notifications', 'Users & data']);
});

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

test('headings appear on a long menu and stay off a short one', () => {
  const long = menuRuns(menuFor(roleHolds('admin', 1), { staffId: 1 }));
  assert.deepEqual(long.map((r) => r.section), ['Mine', 'The day', 'The people', null]);
  assert.deepEqual(long.map((r) => r.groups.length), [3, 2, 6, 2]);

  // And the same administrator on their own first week, which adds one to the
  // section that is theirs rather than opening a new one.
  const starting = menuRuns(menuFor(roleHolds('admin', 1), { staffId: 1, startingOut: true }));
  assert.deepEqual(starting.map((r) => r.groups.length), [4, 2, 6, 2]);

  // A supervisor's four stay one plain list. Cutting four into three headed
  // sections is worse than not cutting them at all.
  const mid = menuRuns(menuFor(roleHolds('supervisor'), { staffId: null }));
  assert.equal(mid.length, 1);
  assert.equal(mid[0].section, null);
  assert.ok(menuFor(roleHolds('supervisor'), { staffId: null }).length < HEADINGS_FROM);

  const short = menuRuns(menuFor(['att_me']));
  assert.deepEqual(short.map((r) => r.section), [null]);
});

test('Setup and Guide end the list without a heading over them', () => {
  const runs = menuRuns(menuFor(roleHolds('admin', 1), { staffId: 1 }));
  const tail = runs[runs.length - 1];
  assert.equal(tail.section, null);
  assert.deepEqual(tail.groups.map((g) => g.label), ['Setup', 'Guide']);
});

// ---------------------------------------------------------------------------
// Finding your way back
// ---------------------------------------------------------------------------

test('a screen opened by its own address lights up the link it lives under', () => {
  const menu = menuFor(roleHolds('admin', 1), { staffId: 1 });
  for (const [path, label] of [
    ['signoff', 'Attendance'], ['att-week', 'Attendance'], ['att-leave', 'Attendance'],
    ['att-today', 'Attendance'], ['att-overview', 'Attendance'],
    ['att-lunch', 'Rota'], ['att-workload', 'Rota'],
    ['rec', 'People'], ['att-advances', 'Payroll'], ['admin', 'Setup'],
    ['att-my-payslips', 'My pay'], ['att-my-report', 'My shifts'],
    ['directory', 'Directory'],
  ]) {
    assert.equal(groupOf(menu, path)?.label, label, path);
  }
  assert.equal(groupOf(menu, 'att-staff'), null, 'a screen reached by clicking a name has none');
});

test('every screen still has its own address, so a bookmark still opens it', () => {
  const paths = ROUTE_LIST.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length, 'two screens on one address');
  for (const path of [
    'att-me', 'att-my-report', 'att-my-advance', 'att-my-medical', 'att-my-payslips',
    'att-today', 'att-week', 'att-overview', 'att-leave', 'signoff',
    'att-rota', 'att-workload', 'att-lunch', 'people', 'rec',
    'att-payroll', 'att-advances', 'att-medical', 'letters',
    'att-setup', 'notifications', 'admin', 'directory', 'guide',
  ]) {
    assert.ok(paths.includes(path), `${path} lost its address`);
  }
});

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

test('the tabs are drawn once, above the page, not inside every view', () => {
  assert.match(APP, /h\('main\.main', whoStrip\(\), groupStrip\(\), content\)/);
  // Anchors, so the router sees the move and a half-filled form still warns.
  assert.match(APP, /group-tabs\.seg\.seg-wrap/);
  assert.match(APP, /href: `#\/\$\{tab\.path\}`/);
});

test('the menu no longer draws one link per screen', () => {
  assert.equal(/visible\.map\(\(route\) => h\('a\.side-link'/.test(APP), false);
  assert.match(APP, /menuRuns\(groups\)\.map/);
});
