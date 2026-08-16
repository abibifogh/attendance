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
  assert.deepEqual(defaultPermissions('planner').sort(), ['att_rota', 'att_view']);
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
  assert.equal(reaches('planner', 'GET', '/api/att/overview'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/export'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/staff/:id/report'), false);
  assert.equal(reaches('planner', 'GET', '/api/att/week'), false);
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
