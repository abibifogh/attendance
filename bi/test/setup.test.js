import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { setBinding, disableBinding, bindingEnabled, bindingId } from '../scripts/wrangler-config.mjs';

/**
 * Editing the deploy configuration.
 *
 * `npm run setup` rewrites wrangler.toml, and a rewrite that lands on the wrong
 * block points the dashboard at the wrong database — a mistake that surfaces a
 * week later as figures nobody can explain. So these run against the real file
 * rather than a fixture, and check the identity of what changed, not merely
 * that something did.
 */

const REAL = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

/**
 * The file as it ships, before anybody has run setup against an account.
 *
 * Derived rather than read, because the checked-in wrangler.toml stops being
 * the shipped one the moment setup rewrites it — which is the entire purpose of
 * setup. An earlier version of these tests asserted things about the live file
 * and started failing the instant the tool they were testing did its job. A
 * test that only passes before the feature is used is not a test of anything.
 */
const UNCONFIGURED = ['DB', 'ATT_DB', 'BREAKFAST_DB'].reduce(
  (config, binding) => setBinding(config, binding, `REPLACE_WITH_YOUR_${binding}_ID`).config,
  REAL,
);

test('the shipped config still has the three bindings the setup script expects', () => {
  for (const binding of ['DB', 'ATT_DB', 'BREAKFAST_DB']) {
    assert.notEqual(bindingId(REAL, binding), null, `${binding} is missing from wrangler.toml`);
  }
});

test('setting one binding leaves the others exactly as they were', () => {
  const before = { ATT_DB: bindingId(REAL, 'ATT_DB'), BREAKFAST_DB: bindingId(REAL, 'BREAKFAST_DB') };
  const { config, changed } = setBinding(REAL, 'DB', 'abc-123');
  assert.notEqual(bindingId(REAL, 'DB'), 'abc-123', 'the fixture must differ from what we set');

  assert.equal(changed, true);
  assert.equal(bindingId(config, 'DB'), 'abc-123');
  assert.equal(bindingId(config, 'ATT_DB'), before.ATT_DB, 'ATT_DB must not move');
  assert.equal(bindingId(config, 'BREAKFAST_DB'), before.BREAKFAST_DB, 'BREAKFAST_DB must not move');
});

test('a binding can be switched off and back on again', () => {
  const off = disableBinding(REAL, 'BREAKFAST_DB');
  assert.equal(off.changed, true);
  assert.equal(bindingEnabled(off.config, 'BREAKFAST_DB'), false);
  // Commenting one out must not disturb the others.
  assert.equal(bindingEnabled(off.config, 'DB'), true);
  assert.equal(bindingEnabled(off.config, 'ATT_DB'), true);

  const on = setBinding(off.config, 'BREAKFAST_DB', 'breakfast-id');
  assert.equal(bindingEnabled(on.config, 'BREAKFAST_DB'), true);
  assert.equal(bindingId(on.config, 'BREAKFAST_DB'), 'breakfast-id');
  assert.equal(bindingId(on.config, 'ATT_DB'), bindingId(REAL, 'ATT_DB'));
});

test('running it twice changes nothing the second time', () => {
  const once = setBinding(REAL, 'DB', 'abc-123').config;
  const twice = setBinding(once, 'DB', 'abc-123');
  assert.equal(twice.changed, false, 'setup must be safe to run again');
  assert.equal(twice.config, once);
});

test('prose inside a binding block stays a comment when the block is switched on', () => {
  const off = disableBinding(REAL, 'BREAKFAST_DB').config;
  const on = setBinding(off, 'BREAKFAST_DB', 'x').config;
  // The explanation above BREAKFAST_DB is documentation. Uncommenting it would
  // make the file invalid TOML, and the deploy would fail on a comment.
  for (const line of on.split('\n')) {
    if (/Same arrangement|housekeeping and maintenance app/.test(line)) {
      assert.ok(line.trimStart().startsWith('#'), `prose was uncommented: ${line}`);
    }
  }
});

test('a binding that is not there is reported rather than silently invented', () => {
  assert.equal(setBinding(REAL, 'NOT_A_BINDING', 'x').found, false);
  assert.equal(disableBinding(REAL, 'NOT_A_BINDING').found, false);
  assert.equal(setBinding(REAL, 'NOT_A_BINDING', 'x').config, REAL);
});

test('a placeholder id is distinguishable from a real one', () => {
  assert.match(bindingId(UNCONFIGURED, 'DB'), /REPLACE/);
  assert.doesNotMatch(bindingId(setBinding(UNCONFIGURED, 'DB', 'aaaa-1111').config, 'DB'), /REPLACE/);
});

/**
 * The question both GitHub workflows ask before doing anything.
 *
 * "Is Insight wired up yet?" is *not* "does the word REPLACE appear anywhere in
 * the file" — setup comments out any binding whose database does not exist and
 * leaves that binding's placeholder sitting inside the comment. A grep would
 * therefore keep the deploy dormant for ever on a perfectly finished setup,
 * which is exactly the sort of thing nobody debugs quickly.
 */
const readyToDeploy = (config) => {
  const id = bindingId(config, 'DB');
  return bindingEnabled(config, 'DB') && Boolean(id) && !/REPLACE/.test(id);
};

test('the deploy gate is shut before setup has run', () => {
  assert.equal(readyToDeploy(UNCONFIGURED), false);
});

test('the deploy gate opens once the warehouse has a real id', () => {
  const wired = setBinding(UNCONFIGURED, 'DB', 'aaaa-1111').config;
  assert.equal(readyToDeploy(wired), true);
});

test('a commented-out binding elsewhere does not hold the deploy shut', () => {
  // Precisely the state setup leaves behind on a property with no breakfast
  // app: DB real and live, BREAKFAST_DB switched off with its placeholder
  // still in the comment.
  let config = setBinding(UNCONFIGURED, 'DB', 'aaaa-1111').config;
  config = disableBinding(config, 'BREAKFAST_DB').config;

  assert.match(config, /REPLACE/, 'the placeholder is still there, inside a comment');
  assert.equal(readyToDeploy(config), true, 'and it must not matter');
});

test('the gate stays shut if the warehouse binding is switched off entirely', () => {
  const off = disableBinding(setBinding(UNCONFIGURED, 'DB', 'aaaa-1111').config, 'DB').config;
  assert.equal(readyToDeploy(off), false);
});

/**
 * The checked-in file is still only tested for the things that must hold of it
 * whatever account it has been pointed at.
 */
test('however it is configured, the three bindings are present and readable', () => {
  for (const binding of ['DB', 'ATT_DB', 'BREAKFAST_DB']) {
    const id = bindingId(REAL, binding);
    assert.equal(typeof id, 'string', `${binding} has no database_id at all`);
    assert.ok(id.length > 0);
  }
});
