import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { bootstrap } from '../src/routes/attendance.js';
import { updateSettings } from '../src/routes/attendance-setup.js';

/**
 * A switch that would not stay on.
 *
 * The staff directory, the handbook and swaps could all be turned on, saved,
 * and would be off again by the time the screen redrew. Not a saving bug: the
 * save worked. The bootstrap that feeds the Setup screen sent back everything
 * beginning with `att_` and a short list besides, and those six keys were on
 * neither. So the screen drew the default, which is Off, and the next time
 * anybody pressed Save the form posted that Off over what was really there.
 *
 * The one that hurts is the second half. A setting the screen cannot see is a
 * setting the screen quietly resets, so the test that matters is not about any
 * one switch: it is that every field the Rules form posts comes back.
 */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
    async raw() { return db.prepare(sql).all(...binds).map(Object.values); },
  });
  return {
    prepare: (sql) => st(sql),
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 2, name: 'Ama', role: 'admin' }, permissions: ['att_setup'] };
const ctx = (db, body, method = 'POST') => ({
  db,
  env: {},
  url: new URL('https://x/api/att/settings'),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }),
});

const settingsOf = async (db) => (await bootstrap(ctx(db, null, 'GET'))).json()
  .then((out) => out.settings);

/** Every `name:` in the Rules tab, which is what the form posts. */
function whatTheRulesFormPosts() {
  const view = readFileSync('public/js/views/att-setup.js', 'utf8');
  const from = view.indexOf('async function rulesTab');
  const to = view.indexOf('// What counts as too much here');
  assert.ok(from > 0 && to > from, 'the rules tab is still findable');
  return [...new Set([...view.slice(from, to).matchAll(/name: '([a-z_]+)'/g)]
    .map((m) => m[1]))].sort();
}

test('every field the rules form posts comes back with the bootstrap', async () => {
  const { db } = setup();
  // Give each of them a value, so nothing is missing merely for never having
  // been set.
  const posted = whatTheRulesFormPosts();
  await updateSettings(ctx(db, {
    hr_directory: '1',
    handbook_on: '1',
    swaps_on: '1',
    swap_notice_hours: '48',
    swap_approval: 'clean',
    swap_monthly_cap: '2',
    hr_link_days: '30',
    // Two that are only ever written when somebody changes them. Absent means
    // the default and the screen draws the same default, so they are harmless
    // either way; set here so this test is about the filter and not about what
    // the migrations happen to seed.
    att_show_balance: '0',
    att_report_holidays: '0',
  }));

  const back = await settingsOf(db);
  const missing = posted.filter((key) => !(key in back));
  assert.deepEqual(missing, [],
    'a key the form posts and the bootstrap withholds is a key the next save wipes');
});

test('turning the directory on and saving again leaves it on', async () => {
  const { raw, db } = setup();
  const valueOf = (key) => raw.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;

  await updateSettings(ctx(db, { hr_directory: '1', handbook_on: '1', swaps_on: '1' }));
  assert.equal(valueOf('hr_directory'), '1');

  // What the screen would draw next, and therefore post next. Before the fix
  // this read undefined, the select fell back to Off, and Save wrote Off.
  const back = await settingsOf(db);
  assert.equal(back.hr_directory, '1');
  assert.equal(back.handbook_on, '1');
  assert.equal(back.swaps_on, '1');

  await updateSettings(ctx(db, {
    hr_directory: back.hr_directory,
    handbook_on: back.handbook_on,
    swaps_on: back.swaps_on,
    att_away_cap: '4',
  }));
  assert.equal(valueOf('hr_directory'), '1', 'still on after saving something else');
  assert.equal(valueOf('handbook_on'), '1');
  assert.equal(valueOf('swaps_on'), '1');
});

test('and the server keeps its own secrets to itself', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('maps_key', 'AIza-secret') "
    + 'ON CONFLICT (key) DO UPDATE SET value = excluded.value').run();

  const back = await settingsOf(db);
  for (const key of ['pin_pepper', 'maps_key', 'lunch_token_hash', 'notice_email']) {
    assert.equal(key in back, false, `${key} has no business in a browser`);
  }
});
