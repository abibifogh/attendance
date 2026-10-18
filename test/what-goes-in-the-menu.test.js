import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { groupKeyFor, groupOf, mineTabs, openGroups, tabsOf } from '../public/js/menu.js';
import { ROLES, allows, effectivePermissions } from '../src/lib/permissions.js';

/**
 * Two menus, one set of screens.
 *
 * Staff get five places along the bottom of the phone: Home, Rota, Requests,
 * Pay and Me. Everybody who runs something gets the side menu: Home, Inbox,
 * Rota, Attendance, People and Money, then Me and Settings. Fifteen groups
 * became six, and every screen still has its own address.
 *
 * Who sees what is the part of a menu that goes quietly wrong for somebody who
 * is not you, so the table itself is read out of the app here and put through
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
      mgroup: one(line, 'mgroup'),
      mtab: one(line, 'mtab'),
      under: one(line, 'under'),
      path: one(line, 'path'),
      label: one(line, 'label'),
      tab: one(line, 'tab'),
      hidden: /\bhidden: true/.test(line),
      mine: /\bmine: true/.test(line),
      only: /\bonly: /.test(line),
      permission: list
        ? list[1].split(',').map((p) => p.trim().replace(/'/g, ''))
        : one(line, 'permission'),
    });
  }
  return out;
}

/** And each menu's groups, in order. */
function groupsOf(name) {
  const start = APP.indexOf(`const ${name} = [`);
  const block = APP.slice(start, APP.indexOf('];', start));
  return block.split('\n')
    .filter((line) => /^\s*\{ key: '/.test(line))
    .map((line) => ({
      key: one(line, 'key'), label: one(line, 'label'), icon: one(line, 'icon'),
      foot: /\bfoot: true/.test(line),
    }));
}

const ROUTE_LIST = routes();
const STAFF = groupsOf('STAFF_GROUPS');
const MANAGER = groupsOf('MANAGER_GROUPS');

/** The app's own permission test, for somebody holding these. */
const holder = (held, { staffId = 1, startingOut = false } = {}) => (route) => {
  if (route.only && !startingOut) return false;
  if (!route.permission) return true;
  const needed = Array.isArray(route.permission) ? route.permission : [route.permission];
  return needed.some((p) => allows(p, held) && (!['att_me', 'till'].includes(p) || staffId != null));
};

/** Staff are those who hold nothing beyond their own record, as the app decides. */
const modeOf = (held) => (ROUTE_LIST.some((r) => {
  if (r.hidden || !r.permission) return false;
  const needed = Array.isArray(r.permission) ? r.permission : [r.permission];
  return needed.some((p) => !['att_me', 'till'].includes(p) && allows(p, held));
}) ? 'manager' : 'staff');

const menuFor = (held, opts) => {
  const mode = modeOf(held);
  return openGroups(ROUTE_LIST, mode === 'staff' ? STAFF : MANAGER, holder(held, opts), groupKeyFor(mode));
};
const labels = (held, opts) => menuFor(held, opts).map((g) => g.label);
const roleHolds = (role, staffId = null) => effectivePermissions({ role, staff_id: staffId });

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

test('two menus: five places for staff, six and two for everybody else', () => {
  assert.deepEqual(STAFF.map((g) => g.label), ['Home', 'Rota', 'Requests', 'Pay', 'Me']);
  assert.deepEqual(MANAGER.map((g) => g.label),
    ['Home', 'Inbox', 'Rota', 'Attendance', 'People', 'Money', 'Me', 'Settings']);
  assert.deepEqual(MANAGER.filter((g) => g.foot).map((g) => g.label), ['Me', 'Settings']);
  for (const g of [...STAFF, ...MANAGER]) assert.ok(g.icon, `${g.key} has an icon`);
});

test('every screen in a menu belongs to a group in it, and nothing hidden claims one', () => {
  const staffKeys = new Set(STAFF.map((g) => g.key));
  const managerKeys = new Set(MANAGER.map((g) => g.key));
  for (const route of ROUTE_LIST) {
    if (route.hidden) {
      assert.equal(route.group, null, `${route.path} is hidden and grouped`);
      continue;
    }
    assert.ok(managerKeys.has(route.mgroup ?? route.group), `${route.path}: not in the manager menu`);
    if (route.mine) assert.ok(staffKeys.has(route.group), `${route.path}: their own, but not in the staff menu`);
  }
});

test('a person’s own screens all sit under Me for managers, as tabs or under one', () => {
  for (const route of ROUTE_LIST.filter((r) => r.mine && !r.hidden)) {
    assert.equal(route.mgroup, 'mine', route.path);
    assert.ok(route.mtab || route.under, `${route.path} is neither a tab nor under one`);
    if (route.under) assert.ok(ROUTE_LIST.find((r) => r.path === route.under)?.mtab, `${route.path} is under a non-tab`);
  }
});

// ---------------------------------------------------------------------------
// What each person opens
// ---------------------------------------------------------------------------

test('a member of staff gets their five places, and Home first', () => {
  const menu = menuFor(['att_me']);
  assert.deepEqual(menu.map((g) => g.label), ['Home', 'Rota', 'Requests', 'Pay', 'Me']);
  assert.equal(menu[0].screens[0].path, 'my-day');
  assert.deepEqual(tabsOf(menu[1]).map((t) => t.label), ['My shifts', 'Swaps', 'Lunch', 'Report']);
  assert.deepEqual(tabsOf(menu[3]).map((t) => t.label), ['Payslips', 'Advance', 'Claims']);
  assert.deepEqual(tabsOf(menu[4]).map((t) => t.label), ['Documents', 'Directory', 'Handbook', 'HR FAQ', 'Guide']);
});

test('the front desk gets the same five, and closing the till is always a tab away', () => {
  // A receptionist who had clocked out before counting up had no way to the
  // till at all while it lived only as a to-do on Home. It is a tab beside
  // Home for anybody who closes one, and still the to-do as well.
  assert.deepEqual(labels(['att_me', 'till']), ['Home', 'Rota', 'Requests', 'Pay', 'Me']);
  const desk = menuFor(['att_me', 'till']);
  assert.deepEqual(tabsOf(desk[0]).map((t) => t.label), ['Home', 'Close till']);
  assert.deepEqual(tabsOf(menuFor(['att_me'])[0]), [], 'nobody else sees it');
  const till = ROUTE_LIST.find((r) => r.path === 'att-my-till');
  assert.equal(till.permission, 'till');
  assert.match(readFileSync('public/js/views/my-day.js', 'utf8'), /'#\/att-my-till'/);
});

test('a new hire’s first week sits beside Home while it is open', () => {
  const settled = menuFor(['att_me']);
  const starting = menuFor(['att_me'], { startingOut: true });
  assert.deepEqual(tabsOf(settled[0]), []);
  assert.deepEqual(tabsOf(starting[0]).map((t) => t.label), ['Home', 'My first week']);
});

test('an administrator who works shifts reads the six, then Me and Settings', () => {
  const menu = menuFor(roleHolds('admin', 1), { staffId: 1 });
  assert.deepEqual(menu.map((g) => g.label),
    ['Home', 'Inbox', 'Rota', 'Attendance', 'People', 'Money', 'Me', 'Settings']);
  const me = menu.find((g) => g.key === 'mine');
  assert.deepEqual(mineTabs(me, 'my-day').tabs.map((t) => t.label),
    ['My day', 'Shifts', 'Requests', 'Pay', 'Documents', 'Guide']);
  // On a screen under one of those, the parent lights and its own tabs come up.
  const under = mineTabs(me, 'att-my-medical');
  assert.equal(under.parent, 'att-my-payslips');
  assert.deepEqual(under.siblings.map((t) => t.label), ['Payslips', 'Advance', 'Claims']);
  assert.deepEqual(mineTabs(me, 'requests').siblings, []);
});

test('a login with no staff record behind it has none of the "my" screens', () => {
  const menu = labels(roleHolds('admin'), { staffId: null });
  assert.deepEqual(menu, ['Home', 'Inbox', 'Rota', 'Attendance', 'People', 'Money', 'Guide', 'Settings']);
});

test('a supervisor reads Home, Inbox, Rota and Attendance', () => {
  const menu = menuFor(roleHolds('supervisor'), { staffId: null });
  assert.deepEqual(menu.map((g) => g.label).slice(0, 4), ['Home', 'Inbox', 'Rota', 'Attendance']);
  const day = menu.find((g) => g.key === 'day');
  assert.deepEqual(tabsOf(day).map((t) => t.label), ['Today', 'Month', 'Leave', 'Sign-off']);
});

test('a manager reads People with its four, and the directory and handbook beside them', () => {
  const menu = menuFor(roleHolds('manager'), { staffId: null });
  const people = menu.find((g) => g.key === 'people');
  assert.deepEqual(tabsOf(people).map((t) => t.label),
    ['Staff', 'Recruitment', 'First weeks', 'Letters', 'Directory', 'Handbook', 'HR FAQ']);
  assert.equal(menu.some((g) => g.key === 'money'), false, 'no payroll for a manager by default');
});

test('a rota reader still reads one screen and no tabs, and gets no Inbox', () => {
  const menu = menuFor(roleHolds('rota_reader'), { staffId: null });
  assert.equal(menu[0].label, 'Rota');
  assert.deepEqual(tabsOf(menu[0]), []);
  assert.equal(menu.some((g) => g.key === 'inbox'), false);
});

test('a link never promises a screen its holder cannot open', () => {
  const menu = menuFor(['att_view', 'att_reports', 'lunch'], { staffId: null });
  const rota = menu.find((g) => g.key === 'rota');
  assert.equal(rota.label, 'Workload');
  assert.deepEqual(tabsOf(rota).map((t) => t.label), ['Workload', 'Lunch']);

  for (const role of ROLES) {
    for (const group of menuFor(roleHolds(role.key, 1), { staffId: 1 })) {
      assert.ok(holder(roleHolds(role.key, 1))(group.screens[0]),
        `${role.key} gets a "${group.label}" link onto ${group.screens[0].path}`);
    }
  }
});

test('Settings is one screen, and its old addresses still open it', () => {
  const settings = ROUTE_LIST.find((r) => r.path === 'settings');
  assert.deepEqual(settings.permission, ['att_setup', 'users']);
  assert.equal(labels(['users'], { staffId: null }).includes('Settings'), true);
  assert.deepEqual(tabsOf(menuFor(roleHolds('admin'), { staffId: null }).find((g) => g.key === 'setup')), []);
  for (const path of ['att-setup', 'notifications', 'admin']) {
    const old = ROUTE_LIST.find((r) => r.path === path);
    assert.equal(old.hidden, true, path);
    assert.match(APP, new RegExp(`alias: 'settings', path: '${path}'`));
  }
});

test('the Inbox is open to whoever may decide something, and to nobody else', () => {
  const inbox = ROUTE_LIST.find((r) => r.path === 'inbox');
  assert.deepEqual(inbox.permission, ['att_manage', 'att_setup', 'att_rota', 'hr_pay', 'hr_manage', 'lunch']);
  assert.equal(labels(['att_view', 'att_reports'], { staffId: null }).includes('Inbox'), false);
  assert.equal(labels(['lunch'], { staffId: null }).includes('Inbox'), true);
});

// ---------------------------------------------------------------------------
// Finding your way back
// ---------------------------------------------------------------------------

test('a screen opened by its own address lights up the link it lives under', () => {
  const menu = menuFor(roleHolds('admin', 1), { staffId: 1 });
  for (const [path, label] of [
    ['signoff', 'Attendance'], ['att-leave', 'Attendance'], ['att-lunch', 'Rota'],
    ['rec', 'People'], ['directory', 'People'], ['att-advances', 'Money'], ['settings', 'Settings'],
    ['att-my-payslips', 'Me'], ['swaps', 'Me'], ['inbox', 'Inbox'], ['home', 'Home'],
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
    'att-payroll', 'att-advances', 'att-medical', 'letters', 'att-my-till',
    'att-setup', 'notifications', 'admin', 'directory', 'guide', 'home', 'inbox', 'my-day', 'requests',
  ]) {
    assert.ok(paths.includes(path), `${path} lost its address`);
  }
});

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

test('the tabs are drawn once, above the page, and phones get a bar along the bottom', () => {
  assert.match(APP, /h\('main\.main', whoStrip\(\), groupStrip\(\), content\)/);
  assert.match(APP, /bottomBar\(\)/);
  assert.match(APP, /group-tabs\.seg\.seg-wrap/);
});
