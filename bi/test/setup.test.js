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

test('the shipped config still has the three bindings the setup script expects', () => {
  for (const binding of ['DB', 'ATT_DB', 'BREAKFAST_DB']) {
    assert.notEqual(bindingId(REAL, binding), null, `${binding} is missing from wrangler.toml`);
  }
});

test('setting one binding leaves the others exactly as they were', () => {
  const before = { ATT_DB: bindingId(REAL, 'ATT_DB'), BREAKFAST_DB: bindingId(REAL, 'BREAKFAST_DB') };
  const { config, changed } = setBinding(REAL, 'DB', 'abc-123');

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

test('the shipped id is an obvious placeholder, not somebody else\'s real database', () => {
  assert.match(bindingId(REAL, 'DB'), /REPLACE/);
});
