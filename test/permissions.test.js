import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSION_KEYS, ROLES, allows, defaultPermissions, effectivePermissions,
} from '../src/lib/permissions.js';
import { ROUTES } from '../src/index.js';

/**
 * Who can reach what.
 *
 * Worth testing against the real route table rather than against a list of
 * permission names, because the failure mode here is silent. A route that
 * quietly accepts one permission too many does not throw, does not log, and
 * does not show up until somebody sees a number they should not have seen.
 *
 * The rota planner is the case that motivated this: somebody who builds next
 * week's rota and puts leave in, but must not learn how much leave anybody has
 * left — that is between each person and whoever does the wages.
 */

/** What the route table says about one path. */
function routeFor(method, path) {
  const route = ROUTES.find(([m, p]) => m === method && p === path);
  assert.ok(route, `no such route: ${method} ${path}`);
  return route[2];
}

const held = (role) => effectivePermissions({ role, permissions: null });
const reaches = (role, method, path) => allows(routeFor(method, path), held(role));

// ---------------------------------------------------------------------------
// The rota planner
// ---------------------------------------------------------------------------

test('the rota planner exists and holds only what it needs', () => {
  assert.ok(ROLES.some((r) => r.key === 'planner'));
  assert.deepEqual(defaultPermissions('planner').sort(),
    ['att_rota', 'att_times', 'att_view']);
});

test('a planner can correct a clock time but not settle the day', () => {
  // The distinction the whole permission exists for. Saying when somebody left
  // is not the same as saying what the day should be charged to.
  assert.ok(reaches('planner', 'POST', '/api/att/days/:day/times'));
  assert.equal(reaches('planner', 'POST', '/api/att/days/:day/resolve'), false);
  assert.equal(reaches('planner', 'POST', '/api/att/days/:day/unresolve'), false);
  assert.equal(reaches('planner', 'POST', '/api/att/punches'), false,
    'and cannot invent a punch, which would put a fact in the record rather than an opinion');
});

test('anybody who can settle a day can correct a clock time', () => {
  // The implication runs one way only: the larger act includes the smaller.
  for (const role of ['supervisor', 'manager', 'admin']) {
    assert.ok(reaches(role, 'POST', '/api/att/days/:day/times'), role);
  }
  assert.equal(reaches('viewer', 'POST', '/api/att/days/:day/times'), false,
    'reports-only changes nothing, by definition');
});

test('a planner can build the rota', () => {
  assert.ok(reaches('planner', 'GET', '/api/att/roster'));
  assert.ok(reaches('planner', 'POST', '/api/att/roster'));
  assert.ok(reaches('planner', 'POST', '/api/att/roster/copy'));
  assert.ok(reaches('planner', 'POST', '/api/att/patterns'), 'including the rotating pattern');
  assert.ok(reaches('planner', 'GET', '/api/att/shifts'), 'and can see the shifts to choose from');
  assert.ok(reaches('planner', 'GET', '/api/att/staff'), 'and who is on the rota');
});

test('a planner can put leave in but cannot grant it', () => {
  assert.ok(reaches('planner', 'POST', '/api/att/leave'));
  assert.equal(reaches('planner', 'POST', '/api/att/leave/:id/decide'), false,
    'requesting is not approving, or the planner approves their own');
  assert.equal(reaches('planner', 'DELETE', '/api/att/leave/:id'), false);
});

test('a planner cannot see what anybody has left', () => {
  // The whole reason this role exists.
  assert.equal(reaches('planner', 'GET', '/api/att/balances'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/export'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/staff/:id/report'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/week'), false);
});

test('a planner reads the month, and the month leaves the balance out', () => {
  // They need to know who was absent and who is over their hours before
  // building the next rota. What they must not see is taken out of the answer
  // rather than left to the screen to hide, so the route being reachable is
  // not the same as the number being readable — see attendance-db for that
  // half of it.
  assert.ok(reaches('planner', 'GET', '/api/att/overview'));
  assert.equal(reaches('planner', 'GET', '/api/att/balances'), false,
    'and the balances themselves stay where they were');
});

test('a planner does not settle days or change the setup', () => {
  assert.equal(reaches('planner', 'POST', '/api/att/days/:day/resolve'), false);
  assert.equal(reaches('planner', 'POST', '/api/att/punches'), false);
  assert.equal(reaches('planner', 'POST', '/api/att/staff'), false);
  assert.equal(reaches('planner', 'POST', '/api/att/shifts'), false);
  assert.equal(reaches('planner', 'PUT', '/api/att/settings'), false);
});

// ---------------------------------------------------------------------------
// And everybody else, unchanged
// ---------------------------------------------------------------------------

test('holding the bigger permission still carries the smaller one', () => {
  // Otherwise every rota route would have to name both forever, and the day
  // somebody forgets is the day a supervisor loses the rota.
  assert.ok(held('supervisor').includes('att_rota'));
  assert.ok(held('manager').includes('att_rota'));
  assert.ok(held('admin').includes('att_rota'));
});

test('a supervisor keeps the rota and still sees no balances', () => {
  assert.ok(reaches('supervisor', 'POST', '/api/att/roster'));
  assert.ok(reaches('supervisor', 'POST', '/api/att/days/:day/resolve'));
  assert.equal(reaches('supervisor', 'GET', '/api/att/balances'), false);
});

test('a manager still runs the whole thing bar the setup', () => {
  assert.ok(reaches('manager', 'GET', '/api/att/balances'));
  assert.ok(reaches('manager', 'POST', '/api/att/leave/:id/decide'));
  assert.equal(reaches('manager', 'POST', '/api/att/shifts'), false);
});

test('reports-only changes nothing', () => {
  assert.ok(reaches('viewer', 'GET', '/api/att/balances'));
  assert.ok(reaches('viewer', 'GET', '/api/att/roster'), 'read, to build a report from');
  assert.equal(reaches('viewer', 'POST', '/api/att/roster'), false);
  assert.equal(reaches('viewer', 'POST', '/api/att/leave'), false);
});

test('an administrator reaches every route there is', () => {
  const admin = held('admin');
  for (const [method, path, required] of ROUTES) {
    if (required === 'public') continue;
    assert.ok(allows(required, admin), `admin blocked from ${method} ${path}`);
  }
});

test('every permission a route asks for is a real one', () => {
  // A typo in the route table would otherwise lock a route to nobody at all,
  // silently, and only be found when somebody complained.
  for (const [method, path, required] of ROUTES) {
    if (!required || required === 'public') continue;
    for (const key of Array.isArray(required) ? required : [required]) {
      assert.ok(PERMISSION_KEYS.includes(key), `${method} ${path} wants unknown "${key}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// A planner who may also close the books
// ---------------------------------------------------------------------------

/** A planner an administrator has additionally trusted with sign-off. */
const plannerPlus = ['att_view', 'att_rota', 'att_signoff'];
const reachesWith = (held, method, path) => allows(routeFor(method, path), held);

test('sign-off is its own permission, granted rather than assumed', () => {
  assert.ok(PERMISSION_KEYS.includes('att_signoff'));
  assert.equal(held('planner').includes('att_signoff'), false,
    'a planner does not get it by being a planner');
  assert.ok(held('manager').includes('att_signoff'), 'but anybody who settles days already has it');
  assert.ok(held('supervisor').includes('att_signoff'));
});

test('reports-only still changes nothing', () => {
  assert.equal(held('viewer').includes('att_signoff'), false,
    'signing off moves leave, and that role exists to move nothing');
  assert.equal(reaches('viewer', 'POST', '/api/att/review'), false);
});

test('a planner given sign-off can close a period', () => {
  assert.ok(reachesWith(plannerPlus, 'GET', '/api/att/review'));
  assert.ok(reachesWith(plannerPlus, 'POST', '/api/att/review'));
  assert.ok(reachesWith(plannerPlus, 'POST', '/api/att/review/undo'));
  assert.ok(reachesWith(plannerPlus, 'GET', '/api/att/staff/:id/report'),
    'and reach the screen where the days are corrected');
});

test('and still cannot see what anybody has left', () => {
  // The whole point of granting one without the other.
  assert.equal(reachesWith(plannerPlus, 'GET', '/api/att/balances'), false);
  assert.equal(reachesWith(plannerPlus, 'GET', '/api/att/export'), false);
  assert.equal(reachesWith(plannerPlus, 'POST', '/api/att/leave/:id/decide'), false);
  assert.equal(reachesWith(plannerPlus, 'POST', '/api/att/days/:day/resolve'), false);
});

test('a planner without sign-off is unchanged', () => {
  assert.equal(reaches('planner', 'POST', '/api/att/review'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/staff/:id/report'), false);
});

test('the morning list can be downloaded by whoever clears it', () => {
  // Everything in that file is already on the screen it is offered from — no
  // wages, no rates, no leave balances. Gating it behind the reports
  // permission would only mean the person doing the chasing has to ask
  // somebody else for a copy of what they are looking at.
  for (const role of ['supervisor', 'planner', 'manager', 'admin', 'viewer']) {
    assert.ok(reaches(role, 'GET', '/api/att/export/issues'), role);
  }

  // The payroll extract stays where it was.
  assert.equal(reaches('supervisor', 'GET', '/api/att/export'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/export'), false);
  assert.ok(reaches('viewer', 'GET', '/api/att/export'));
});

test('what a month expected is set by whoever sets the property up', () => {
  // It moves what a sign-off proposes against somebody's leave, so it sits
  // with setting the property up rather than with signing it off.
  assert.ok(reaches('admin', 'POST', '/api/att/calendar'));
  assert.equal(reaches('manager', 'POST', '/api/att/calendar'), false);
  assert.equal(reaches('supervisor', 'POST', '/api/att/calendar'), false);
  assert.equal(reaches('planner', 'POST', '/api/att/calendar'), false);
});

// ---------------------------------------------------------------------------
// Somebody who is on the rota as well as running it
// ---------------------------------------------------------------------------

test('a login pointed at a staff record sees its own week, whatever role it holds', () => {
  // The head of housekeeping rosters her own department and works shifts in
  // it. Before this she could build the rota and had no way to open her own
  // month, because "your own" lived on one role.
  for (const role of ['supervisor', 'planner', 'manager', 'viewer', 'admin']) {
    const without = effectivePermissions({ role, permissions: null });
    const with_ = effectivePermissions({ role, permissions: null, staff_id: 4 });

    // An administrator holds every permission there is, so it already has it;
    // the menu is what decides whether it means anything, and it asks whether
    // there is a staff record rather than asking this list.
    if (role !== 'admin') {
      assert.equal(without.includes('att_me'), false, `${role} without a record`);
    }
    assert.ok(with_.includes('att_me'), `${role} with one`);

    // And it adds nothing else. A staff record is not a promotion.
    assert.deepEqual(
      with_.filter((p) => p !== 'att_me').sort(),
      without.filter((p) => p !== 'att_me').sort(),
      `${role} gains only their own screens`,
    );
  }
});

test('a staff record does not smuggle in anybody else’s week', () => {
  const held = effectivePermissions({ role: 'viewer', permissions: null, staff_id: 9 });
  // Their own, and nothing that reads across people.
  assert.ok(held.includes('att_me'));
  assert.equal(held.includes('att_rota'), false);
  assert.equal(held.includes('hr_pay'), false);
  assert.equal(held.includes('users'), false);
});

test('a custom permission list still gains their own screens', () => {
  // Ticking boxes by hand replaces the role's defaults outright, and the
  // staff link has to survive that or the field would look like it did
  // nothing on exactly the accounts somebody has bothered to tailor.
  const held = effectivePermissions({
    role: 'supervisor', permissions: JSON.stringify(['att_view']), staff_id: 2,
  });
  assert.deepEqual(held.sort(), ['att_me', 'att_view']);
});
