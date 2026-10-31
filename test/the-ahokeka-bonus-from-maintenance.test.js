import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { fromMaintenance, saveScheme } from '../src/routes/payroll.js';
import { askMaintenance, readLink, scoresFor } from '../src/lib/maintenance-bonus.js';

/**
 * The Ahokeka bonus, brought in from Maintenance.
 *
 * Maintenance works the bonus out week by week and adds the weeks up into a
 * month; HIVE asks it for the month and turns what each artisan earned into
 * the score that pays it. People are matched by employee number only. Nothing
 * is saved by asking: the screen fills the boxes and somebody saves them.
 */

const KEY = `mxh_${'ab'.repeat(24)}`;
const LINK = `https://abcdefgh.supabase.co|sb_publishable_test|${KEY}`;

// What Maintenance answers for November: Joshua's bonus is GHS 300, so a
// four-week month is GHS 75 a week; he earned 67.50 + 0 + 0 + 75.
const NOVEMBER = {
  month: '2026-11',
  weeks: ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'],
  threshold: 80,
  people: [
    { id: 'u1', name: 'Joshua Danso', employee_no: 'SN-014', budget: 300, earned: 142.5, weeks: [
      { week: '2026-11-02', jobs: 10, done: 9, rate: 90, qualifies: true, why: null, limit: 75, earned: 67.5 },
      { week: '2026-11-09', jobs: 10, done: 7, rate: 70, qualifies: false, why: '70% finished, needs 80%', limit: 75, earned: 0 },
      { week: '2026-11-16', jobs: 0, done: 0, rate: null, qualifies: false, why: 'no jobs that week', limit: 75, earned: 0 },
      { week: '2026-11-23', jobs: 5, done: 5, rate: 100, qualifies: true, why: null, limit: 75, earned: 75 }] },
    { id: 'u2', name: 'Johnson Yakanu', employee_no: 'SN-007', budget: 400, earned: 400, weeks: [] },
    { id: 'u3', name: 'Nelson Kofi Kumadey', employee_no: null, budget: 400, earned: 360, weeks: [] },
    { id: 'u4', name: 'Henry Aryee', employee_no: 'SN-999', budget: 400, earned: 100, weeks: [] },
  ],
};

test('the link is the three parts Maintenance hands over, and nothing else', () => {
  assert.deepEqual(readLink(LINK), { url: 'https://abcdefgh.supabase.co', anon: 'sb_publishable_test', key: KEY });
  assert.equal(readLink(''), null);
  assert.equal(readLink('https://evil.example.com|x|' + KEY), null, 'only a Supabase address');
  assert.equal(readLink(`https://abcdefgh.supabase.co|sb_publishable_test|not-a-key`), null);
});

test('what was earned becomes the score that pays it, on the scheme’s own worth', () => {
  const staff = [
    { id: 1, name: 'Joshua Danso', employee_no: 'SN-014' },
    { id: 2, name: 'Johnson Yakanu', employee_no: 'sn-007' },
    { id: 3, name: 'Nelson Kumadey', employee_no: 'SN-021' },
    { id: 4, name: 'Henry Aryee', employee_no: 'SN-999' },
    { id: 5, name: 'Godfred Donkor', employee_no: 'SN-030' },
  ];
  const out = scoresFor({ id: 7, name: 'Ahokeka bonus', amount: 400, staffIds: [1, 2, 3, 5] }, staff, NOVEMBER);
  const by = Object.fromEntries(out.lines.map((l) => [l.name, l]));
  assert.equal(by['Joshua Danso'].score, 35.63, 'GHS 142.50 of a GHS 400 scheme: Maintenance’s GHS 300 bonus is what is paid');
  assert.equal(by['Joshua Danso'].earned, 142.5);
  assert.equal(by['Joshua Danso'].weeks[1].why, '70% finished, needs 80%');
  assert.equal(by['Johnson Yakanu'].score, 100, 'matched whatever the case of the number');
  assert.deepEqual(out.unmatched.map((u) => u.why).sort(),
    ['no employee number in Maintenance', 'not on Ahokeka bonus'],
    'nobody is matched by name, and nobody off the scheme is scored on it');
  assert.deepEqual(out.notSent.sort(), ['Godfred Donkor', 'Nelson Kumadey'], 'whose boxes are left alone is said');
});

test('a scheme cannot pay more than its own worth', () => {
  const out = scoresFor({ id: 7, name: 'Ahokeka bonus', amount: 300, staffIds: [2] },
    [{ id: 2, name: 'Johnson Yakanu', employee_no: 'SN-007' }], NOVEMBER);
  assert.equal(out.lines[0].score, 100);
  assert.equal(out.lines[0].capped, true);
});

test('Maintenance is asked with its key, for the month', async () => {
  let asked;
  const fake = async (url, init) => { asked = { url, init }; return new Response(JSON.stringify(NOVEMBER), { status: 200 }); };
  const got = await askMaintenance(LINK, '2026-11', fake);
  assert.equal(got.month, '2026-11');
  assert.equal(asked.url, 'https://abcdefgh.supabase.co/rest/v1/rpc/mx_hive_bonus');
  assert.equal(asked.init.headers.apikey, 'sb_publishable_test');
  assert.deepEqual(JSON.parse(asked.init.body), { p_key: KEY, p_month: '2026-11' });
});

test('every way it can fail says what to do', async () => {
  await assert.rejects(askMaintenance('', '2026-11'), /not linked to Maintenance yet.*APP_MAINTENANCE_LINK/);
  await assert.rejects(askMaintenance(LINK, '2026-11', async () => { throw new Error('offline'); }), /could not be reached/);
  await assert.rejects(askMaintenance(LINK, '2026-11', async () => new Response(JSON.stringify({ message: 'That is not the key for this Maintenance app. Make a new one.' }), { status: 400 })),
    /not the key for this Maintenance app/);
  await assert.rejects(askMaintenance(LINK, '2026-11', async () => new Response(JSON.stringify({ message: 'Could not find the function public.mx_hive_bonus' }), { status: 404 })),
    /database update has not been run/);
});

// ---- the route, against the real tables

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { const r = db.prepare(sql).run(...binds); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}
function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_scheme; DELETE FROM pay_run;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, no, name] of [[1, 'SN-014', 'Joshua Danso'], [2, 'SN-007', 'Johnson Yakanu']]) {
    raw.prepare(`INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, '2020-01-01')`).run(id, no, name);
  }
  return { raw, db: d1(raw) };
}
const ADMIN = { user: { id: 9, name: 'Kwame', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, body, extra = {}) => ({
  db, env: { MAINTENANCE_LINK: LINK }, url: new URL('https://x/api/payroll/from-maintenance'), session: ADMIN, executionContext: null,
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  ...extra,
});

test('the payroll asks, and is told each person’s score — and nothing is saved', async () => {
  const { raw, db } = setup();
  const scheme = await (await saveScheme(ctx(db, { name: 'Ahokeka bonus', amount: 400, staffIds: [1, 2] }))).json();
  const res = await fromMaintenance(ctx(db, { month: '2026-11', schemeId: scheme.id },
    { fetchMaintenance: async () => new Response(JSON.stringify(NOVEMBER), { status: 200 }) }));
  const out = await res.json();
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines.find((l) => l.staffId === 1).score, 35.63);
  assert.equal(out.lines.find((l) => l.staffId === 2).score, 100);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_score').get().n, 0, 'asking saves nothing');
});

test('a scheme that pays a set figure is not Maintenance’s to score', async () => {
  const { db } = setup();
  const scheme = await (await saveScheme(ctx(db, { name: 'Housing', amount: 300, kind: 'amount', staffIds: [1] }))).json();
  await assert.rejects(fromMaintenance(ctx(db, { month: '2026-11', schemeId: scheme.id },
    { fetchMaintenance: async () => new Response(JSON.stringify(NOVEMBER), { status: 200 }) })), /pays a set figure or by tier/);
});
