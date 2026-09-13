import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { updateSettings } from '../src/routes/attendance-setup.js';

/**
 * Saving one rule should change one rule.
 *
 * The rules screen posts every box on it, changed or not, because that is what
 * a form does. Left alone, that meant every save wrote forty settings and
 * rebuilt sixty days of the ledger, so somebody turning the staff directory on
 * was told that two thousand days had been worked out again. It is alarming,
 * it is slow, and it makes the audit trail useless for saying who changed
 * what.
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
  // Somebody to have days to rebuild, so a recompute is not zero either way.
  raw.exec('DELETE FROM att_staff');
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
     VALUES (1, '001', 'Ama Mensah', 'Reception', '2020-01-01', 1)`,
  ).run();
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 2, name: 'Ama', role: 'admin' }, permissions: ['att_setup'] };
const ctx = (db, body) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/settings'),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const save = async (db, body) => (await updateSettings(ctx(db, body))).json();
const settingOf = (raw, key) => raw.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;

// The whole screen, posted the way a form posts it.
const WHOLE_FORM = {
  att_missing_punch: 'incomplete',
  att_min_gap_minutes: '2',
  att_window_before: '180',
  att_window_after: '240',
  att_leave_days: '15',
  att_days_per_week: '5',
  att_leave_qualify_months: '12',
  att_leave_carryover_days: '0',
  att_leave_year_starts: '01-01',
  att_away_cap: '3',
  att_escalate_after: '3',
  att_terminal_quiet_minutes: '60',
  hr_link_days: '21',
  hr_directory: '0',
  handbook_on: '0',
  swaps_on: '0',
  att_show_balance: '1',
  att_report_holidays: '1',
};

test('pressing Save with nothing typed changes nothing and rebuilds nothing', async () => {
  const { db } = setup();
  await save(db, WHOLE_FORM);       // settle whatever the migrations seeded
  const second = await save(db, WHOLE_FORM);

  assert.deepEqual(second.changed, []);
  assert.equal(second.recomputed, 0);
});

test('turning the handbook on does not work the ledger out again', async () => {
  const { raw, db } = setup();
  await save(db, WHOLE_FORM);

  const out = await save(db, { ...WHOLE_FORM, handbook_on: '1' });

  assert.deepEqual(out.changed, ['handbook_on']);
  assert.equal(out.recomputed, 0, 'a screen switch is not a verdict');
  assert.equal(settingOf(raw, 'handbook_on'), '1');
});

test('nor does the directory, the balance, the link or the holidays line', async () => {
  const { db } = setup();
  await save(db, WHOLE_FORM);

  // One at a time, keeping the ones already changed, exactly as the screen
  // posts them: otherwise the second save also changes the first one back.
  const form = { ...WHOLE_FORM };
  for (const [key, value] of [
    ['hr_directory', '1'],
    ['att_show_balance', '0'],
    ['hr_link_days', '30'],
    ['att_report_holidays', '0'],
    ['swaps_on', '1'],
  ]) {
    form[key] = value;
    const out = await save(db, form);
    assert.deepEqual(out.changed, [key], `${key} saved on its own`);
    assert.equal(out.recomputed, 0, `${key} does not touch a stored day`);
  }
});

test('but changing what a punch means does', async () => {
  const { raw, db } = setup();
  await save(db, WHOLE_FORM);

  const out = await save(db, { ...WHOLE_FORM, att_missing_punch: 'absent' });
  assert.deepEqual(out.changed, ['att_missing_punch']);
  assert.ok(out.recomputed > 0, 'the last sixty days are worked out again');
  assert.equal(settingOf(raw, 'att_missing_punch'), 'absent');
});

test('and so does the length of a working week', async () => {
  const { db } = setup();
  await save(db, WHOLE_FORM);

  const out = await save(db, { ...WHOLE_FORM, att_days_per_week: '6' });
  assert.deepEqual(out.changed, ['att_days_per_week']);
  assert.ok(out.recomputed > 0);
});

test('two changes at once, one of which counts, still rebuilds once', async () => {
  const { db } = setup();
  await save(db, WHOLE_FORM);

  const out = await save(db, {
    ...WHOLE_FORM, handbook_on: '1', att_window_before: '120',
  });
  assert.deepEqual(out.changed.sort(), ['att_window_before', 'handbook_on']);
  assert.ok(out.recomputed > 0);
});

test('an optional particular can still be emptied, and only when it was not', async () => {
  const { raw, db } = setup();
  await save(db, { ...WHOLE_FORM, company_website: 'somewherenice.com' });
  assert.equal(settingOf(raw, 'company_website'), 'somewherenice.com');

  const cleared = await save(db, { ...WHOLE_FORM, company_website: '' });
  assert.deepEqual(cleared.changed, ['company_website']);
  assert.equal(settingOf(raw, 'company_website'), '');

  const again = await save(db, { ...WHOLE_FORM, company_website: '' });
  assert.deepEqual(again.changed, [], 'blank over blank is not a change');
});

test('the screen is banded rather than one wall of cards', () => {
  const view = readFileSync('public/js/views/att-setup.js', 'utf8');
  assert.match(view, /function band\(title, lead/);
  for (const heading of [
    'A day at work', 'Time off', 'What staff can do for themselves',
    'What their phone tells them', 'The property itself',
  ]) {
    assert.ok(view.includes(`band('${heading}'`), `${heading} is a band`);
  }
  // And the save bar says how much is waiting rather than sitting at the foot
  // of a page somebody has scrolled past.
  assert.match(view, /rules-save/);
  assert.match(view, /changes waiting/);
});
