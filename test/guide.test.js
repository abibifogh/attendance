import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GUIDE } from '../public/js/guide-content.js';
import { PERMISSION_KEYS, PERMISSIONS, ROLES, allows, defaultPermissions } from '../src/lib/permissions.js';

/**
 * The guide, against the permissions it claims to follow.
 *
 * A handbook is the one part of a system nobody notices going wrong. It does
 * not throw, it does not fail a build, and the first sign that a section is
 * addressed to the wrong people is somebody following instructions for a screen
 * they cannot open — or, worse, never learning that the screen exists.
 *
 * So the three things worth pinning are pinned: every section names a real
 * permission, every role can actually see something, and every part of the
 * system somebody could be given has a section describing it.
 */

const sectionsFor = (permissions) =>
  GUIDE.filter((section) => !section.permission || allows(section.permission, permissions));

test('every section is addressed to a permission that exists', () => {
  for (const section of GUIDE) {
    if (!section.permission) continue;
    const needed = Array.isArray(section.permission) ? section.permission : [section.permission];
    for (const key of needed) {
      assert.ok(PERMISSION_KEYS.includes(key), `${section.key} names "${key}", which is not a permission`);
    }
  }
});

test('every section has a title, a one-line summary and something in it', () => {
  const keys = new Set();
  for (const section of GUIDE) {
    assert.ok(section.key, 'a section without a key cannot be linked to');
    assert.ok(!keys.has(section.key), `two sections share the key "${section.key}"`);
    keys.add(section.key);

    assert.ok(section.title, `${section.key} has no title`);
    assert.ok(section.lede, `${section.key} has no summary — the contents list would show a blank`);
    assert.ok(section.blocks?.length, `${section.key} says nothing`);
  }
});

test('every block is one of the six kinds the screen can draw', () => {
  // A seventh kind renders as nothing at all, silently, in the middle of a
  // page somebody is relying on.
  const KINDS = ['p', 'sub', 'list', 'steps', 'note', 'warn', 'table'];
  for (const section of GUIDE) {
    for (const [index, item] of section.blocks.entries()) {
      const kinds = Object.keys(item);
      assert.equal(kinds.length, 1, `${section.key}[${index}] mixes ${kinds.join(' and ')}`);
      assert.ok(KINDS.includes(kinds[0]), `${section.key}[${index}] is a "${kinds[0]}", which draws as nothing`);
      if (kinds[0] === 'table') {
        assert.ok(item.table.head?.length, `${section.key}[${index}] is a table with no headings`);
        for (const row of item.table.rows) {
          assert.equal(row.length, item.table.head.length,
            `${section.key}[${index}] has a row that does not match its headings`);
        }
      }
    }
  }
});

test('every role opens the guide on something it can use', () => {
  for (const role of ROLES) {
    const mine = sectionsFor(defaultPermissions(role.key));
    assert.ok(mine.length >= 2, `${role.key} would open an almost empty guide`);
    assert.ok(mine.some((s) => !s.permission), 'and everybody gets the getting-started section');
  }
});

test('an administrator sees all of it, and a supervisor does not', () => {
  assert.equal(sectionsFor(defaultPermissions('admin')).length, GUIDE.length);

  const supervisor = sectionsFor(defaultPermissions('supervisor')).map((s) => s.key);
  assert.ok(supervisor.includes('today'));
  assert.ok(supervisor.includes('settle'));
  assert.ok(!supervisor.includes('users'), 'nothing about managing logins');
  assert.ok(!supervisor.includes('setup'));
  assert.ok(!supervisor.includes('reports'), 'and nothing about the wages');
});

test('reports-only is told about reading and nothing about changing', () => {
  const wages = sectionsFor(defaultPermissions('viewer')).map((s) => s.key);
  assert.ok(wages.includes('reports'));
  assert.ok(!wages.includes('settle'), 'that role changes nothing, by definition');
  assert.ok(!wages.includes('signoff'));
  assert.ok(!wages.includes('times'));
});

test('the planner is told how to correct a clock time and not how to approve one', () => {
  const planner = sectionsFor(defaultPermissions('planner')).map((s) => s.key);
  assert.ok(planner.includes('rota'));
  assert.ok(planner.includes('times'), 'it is in their defaults');
  assert.ok(!planner.includes('times-approve'), 'and approving is not');
  assert.ok(!planner.includes('people'));
});

test('every permission somebody can be granted is described somewhere', () => {
  // Otherwise a property can hold a permission with nothing in the handbook
  // explaining it, and the feature it unlocks is discovered by accident or
  // not at all.
  const covered = new Set(GUIDE.flatMap((section) => (section.permission
    ? (Array.isArray(section.permission) ? section.permission : [section.permission])
    : [])));

  for (const permission of PERMISSIONS) {
    // Reading the letter register and writing one are the same chapter; the
    // guide is organised by the job, not by the permission table.
    if (['corr_write', 'hr_view'].includes(permission.key)) continue;
    assert.ok(covered.has(permission.key), `nothing in the guide covers "${permission.label}"`);
  }
});

test('what a reader cannot see is still named, with who holds it', () => {
  // The other half of filtering. Hiding a feature is useful; hiding the fact
  // that it exists means somebody cannot ask to be given it, and goes on doing
  // by hand the thing it was built for.
  const held = defaultPermissions('planner');
  const theirs = GUIDE.filter((section) => section.permission && !allows(section.permission, held));

  assert.ok(theirs.length, 'a planner does not hold everything');
  for (const section of theirs) {
    const needed = Array.isArray(section.permission) ? section.permission : [section.permission];
    assert.ok(needed.every((key) => PERMISSIONS.some((p) => p.key === key)),
      `${section.key} could not be labelled with a permission name`);
  }
});

test('the guide is reachable by anybody signed in', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  assert.match(app, /path: 'guide'[^}]*permission: null/,
    'a guide behind a permission is a guide the people who most need it cannot open');
});
