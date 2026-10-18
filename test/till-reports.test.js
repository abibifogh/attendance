import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { chaseTill, tillReports } from '../src/routes/till-reports.js';
import { effectivePermissions } from '../src/lib/permissions.js';
import { readFileSync as read } from 'node:fs';

/**
 * Till reports: what came in, what did not, and chasing it.
 *
 * Every reception shift in the week with its report, the ones still owed
 * first, and a Chase that tells the person by phone and email. The clock is
 * pinned so the days are fixed. Every name is made up.
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM app_notices; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, department)
     VALUES (1, 'AM Shift', '06:00', '14:15', 0, 5, 'Reception')`,
  ).run();
  for (const [id, name, user] of [[1, 'Kwame Mensah', 7], [2, 'Esi Quaye', 8]]) {
    raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (?, ?, ?, 'Reception', '2020-01-01')").run(id, String(id), name);
    raw.prepare("INSERT INTO users (id, name, role, pin_hash, staff_id, active, permissions) VALUES (?, ?, 'staff', ?, ?, 1, '[\"att_me\",\"till\"]')").run(user, name, `pin-${user}`, id);
  }
  raw.prepare("INSERT INTO users (id, name, role, active) VALUES (3, 'Yaa Boss', 'admin', 1)").run();
  return { raw, db: d1(raw) };
}

function worked(raw, staffId, day, { punched = true } = {}) {
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, 1, 1)').run(staffId, day);
  if (!punched) return;
  for (const [at, direction] of [[`${day} 05:55:00`, 'in'], [`${day} 14:20:00`, 'out']]) {
    raw.prepare(
      `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, direction, dedupe_key)
       VALUES ('D1', ?1, ?1, ?2, ?2, ?3, ?4, ?5)`,
    ).run(String(staffId), at, day, direction, `${staffId}-${at}-${direction}`);
  }
}

const report = (raw, userId, name, day, extra = '') => raw.prepare(
  `INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe, envelopes, expenses, rentals, checks, signed_at${extra ? ', reopened_at' : ''})
   VALUES (?, 'morning', ?, ?, 1, 108350, 0, '[]', '[]', '{}', '[]', ?${extra ? ', ?' : ''})`,
).run(day, userId, name, `${day} 14:10:00`, ...(extra ? [extra] : []));

const BOSS = { user: { id: 3, name: 'Yaa Boss', role: 'admin' } };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/till/reports${query}`),
  session: BOSS,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }),
});

test('the week: who submitted, who owes, who did not work, and what is still running', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { raw, db } = setup();
  worked(raw, 1, '2026-10-16');
  report(raw, 7, 'Kwame Mensah', '2026-10-16');
  worked(raw, 1, '2026-10-17');
  worked(raw, 2, '2026-10-17', { punched: false });
  worked(raw, 2, '2026-10-15');
  report(raw, 8, 'Esi Quaye', '2026-10-15', '2026-10-16 10:00:00');
  worked(raw, 2, '2026-10-18');

  const data = await (await tillReports(ctx(db, { query: '?to=2026-10-18' }))).json();
  const states = Object.fromEntries(data.rows.map((r) => [`${r.name} ${r.day}`, r.state]));
  assert.deepEqual(states, {
    'Kwame Mensah 2026-10-16': 'in',
    'Kwame Mensah 2026-10-17': 'owed',
    'Esi Quaye 2026-10-17': 'not_worked',
    'Esi Quaye 2026-10-15': 'reopened',
    'Esi Quaye 2026-10-18': 'running',
  });
  assert.deepEqual(data.totals, { in: 1, owed: 2, notWorked: 1, running: 1 });
  const kwame = data.rows.find((r) => r.state === 'in');
  assert.equal(kwame.cash, 108350);
  assert.match(kwame.summary, /Drawer GH₵ 1,083\.50/);
});

test('chasing one: a phone alert and an email to them, once within the hour, and said on the screen', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { raw, db } = setup();
  worked(raw, 1, '2026-10-17');

  const out = await (await chaseTill(ctx(db, { body: { userId: 7, day: '2026-10-17', slot: 'morning' } }))).json();
  assert.equal(out.sent, 1);
  const [n] = raw.prepare("SELECT * FROM app_notices WHERE kind = 'till.chase'").all();
  assert.equal(n.user_id, 7);
  assert.equal(n.day, '2026-10-17');
  assert.match(n.title, /Please submit your closing report for the morning shift on .*17 October/);
  assert.match(n.body, /^Yaa asked for it/);

  await assert.rejects(chaseTill(ctx(db, { body: { userId: 7, day: '2026-10-17', slot: 'morning' } })), /less than 60 minutes ago/);
  await assert.rejects(chaseTill(ctx(db, { body: { userId: 8, day: '2026-10-17', slot: 'morning' } })), /not owed/);

  const data = await (await tillReports(ctx(db, { query: '?to=2026-10-18' }))).json();
  assert.equal(data.rows[0].chased.times, 1);
});

test('chase all: everybody owed in the week, and nobody whose report is in', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { raw, db } = setup();
  worked(raw, 1, '2026-10-16');
  worked(raw, 2, '2026-10-17');
  worked(raw, 1, '2026-10-17');
  report(raw, 7, 'Kwame Mensah', '2026-10-17');
  const out = await (await chaseTill(ctx(db, { body: { all: true, from: '2026-10-12', to: '2026-10-18' } }))).json();
  assert.equal(out.sent, 2);
  assert.deepEqual(raw.prepare("SELECT user_id, day FROM app_notices WHERE kind = 'till.chase' ORDER BY user_id").all().map((r) => `${r.user_id} ${r.day}`),
    ['7 2026-10-16', '8 2026-10-17']);
});

test('who sees it: administrators, and anybody given Till reports; not the front desk', () => {
  assert.ok(effectivePermissions({ role: 'admin', permissions: '["att_view"]' }).includes('till_reports'),
    'an administrator with a narrowed list still has it');
  assert.ok(!effectivePermissions({ role: 'staff', permissions: '["att_me","till"]' }).includes('till_reports'));
  const line = read('public/js/app.js', 'utf8').split('\n').find((l) => l.includes("path: 'till-reports'"));
  assert.match(line, /group: 'money'/, 'under Money');
  assert.match(line, /permission: 'till_reports'/);
});
