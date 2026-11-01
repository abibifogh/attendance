import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { takeMaintenanceDeductions } from '../src/routes/payroll.js';
import { askMaintenancePenalties } from '../src/lib/maintenance-bonus.js';

/**
 * "When a report is late for more than 4 hours, 50ghs is to be deducted from
 * their bonus (either coordinator or supervisor's) in hive, reason is "late
 * submission of report". Can you automate it and include it in the
 * notification"
 *
 * Maintenance marks the late report; HIVE asks for the month's, once an hour,
 * and puts each on the payroll, matched by employee number, with the person
 * told at once. Put on once however often it asks; taken back off if
 * Maintenance withdraws it while the month is open.
 */

const KEY = `mxh_${'ab'.repeat(24)}`;
const LINK = `https://abcdefgh.supabase.co|sb_publishable_test|${KEY}`;

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
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_run; DELETE FROM app_notices;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, no, name] of [[1, 'SV-01', 'Douglas Eshun'], [2, 'CO-02', 'Destiny Owusu']]) {
    raw.prepare(`INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, '2020-01-01')`).run(id, no, name);
  }
  raw.prepare("INSERT INTO users (id, name, role, active, staff_id) VALUES (11, 'Douglas', 'staff', 1, 1)").run();
  return { raw, db: d1(raw) };
}

// What Maintenance holds, by month; the fake answers from it.
const said = (byMonth, calls = []) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  return new Response(JSON.stringify({ month: body.p_month, penalties: byMonth[body.p_month] ?? [] }), { status: 200 });
};
const late = (id, no, name, at) => ({ id, employee_no: no, name, amount: 50, reason: 'Late submission of report', at, week: '06 Nov 2026' });

test('Maintenance is asked for the month’s deductions with the same key', async () => {
  const calls = [];
  const got = await askMaintenancePenalties(LINK, '2026-11', said({ '2026-11': [late('r1', 'SV-01', 'Douglas', '2026-11-06T17:10:00Z')] }, calls));
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/rest/v1/rpc/mx_hive_penalties');
  assert.deepEqual(calls[0].body, { p_key: KEY, p_month: '2026-11' });
  assert.equal(got.penalties.length, 1);
  await assert.rejects(askMaintenancePenalties(LINK, '2026-11', async () => new Response('{"message":"That is not the key"}', { status: 400 })), /not the key/);
});

test('GHS 50 goes on the payroll, with the reason, and the person is told', async () => {
  const { raw, db } = setup();
  const out = await takeMaintenanceDeductions({ DB: db, MAINTENANCE_LINK: LINK }, {
    today: '2026-11-07',
    fetchImpl: said({ '2026-11': [late('r1', 'sv-01 ', 'Douglas', '2026-11-06T17:10:00Z')] }),
  });
  assert.equal(out.added, 1);
  const rows = raw.prepare(`SELECT p.*, r.month FROM pay_penalty p JOIN pay_run r ON r.id = p.run_id`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].staff_id, 1, 'matched by employee number, whatever its case or spaces');
  assert.equal(rows[0].amount, 50);
  assert.equal(rows[0].reason, 'Late submission of report');
  assert.equal(rows[0].actor, 'Maintenance (automatic)');
  assert.match(rows[0].month, /^2026-11/);
  const told = raw.prepare("SELECT title, body FROM app_notices WHERE kind = 'payroll.penalty'").all();
  assert.equal(told.length, 1, 'told now, not on payday');
  assert.match(told[0].title, /50.*has come off your bonus for 2026-11/);
  assert.equal(told[0].body, 'Late submission of report');
});

test('put on once, however often HIVE asks', async () => {
  const { raw, db } = setup();
  const fetchImpl = said({ '2026-11': [late('r1', 'SV-01', 'Douglas', '2026-11-06T17:10:00Z')] });
  await takeMaintenanceDeductions({ DB: db, MAINTENANCE_LINK: LINK }, { today: '2026-11-07', fetchImpl });
  const again = await takeMaintenanceDeductions({ DB: db, MAINTENANCE_LINK: LINK }, { today: '2026-11-07', fetchImpl });
  assert.equal(again.added, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_penalty').get().n, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'payroll.penalty'").get().n, 1, 'and told once');
});

test('one marked late on the last night of the month is still found the next morning', async () => {
  const { raw, db } = setup();
  const calls = [];
  await takeMaintenanceDeductions({ DB: db, MAINTENANCE_LINK: LINK }, {
    today: '2026-12-01', fetchImpl: said({ '2026-11': [late('r9', 'CO-02', 'Destiny', '2026-11-30T23:20:00Z')] }, calls),
  });
  assert.deepEqual(calls.map((c) => c.body.p_month), ['2026-11', '2026-12'], 'last month and this one');
  const row = raw.prepare('SELECT p.staff_id, r.month FROM pay_penalty p JOIN pay_run r ON r.id = p.run_id').get();
  assert.equal(row.staff_id, 2);
  assert.match(row.month, /^2026-11/, 'on the month it was marked in');
});

test('if that month is already closed, it goes on this month instead — never lost', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO pay_run (month, opened_by, status) VALUES ('2026-11', 'x', 'final')").run();
  await takeMaintenanceDeductions({ DB: db, MAINTENANCE_LINK: LINK }, {
    today: '2026-12-01', fetchImpl: said({ '2026-11': [late('r9', 'CO-02', 'Destiny', '2026-11-30T23:20:00Z')] }),
  });
  const row = raw.prepare('SELECT r.month FROM pay_penalty p JOIN pay_run r ON r.id = p.run_id').get();
  assert.match(row.month, /^2026-12/);
});

test('nobody is matched by name: no employee number, nothing taken, and it says so', async () => {
  const { raw, db } = setup();
  const out = await takeMaintenanceDeductions({ DB: db, MAINTENANCE_LINK: LINK }, {
    today: '2026-11-07', fetchImpl: said({ '2026-11': [late('r2', null, 'Douglas Eshun', '2026-11-06T17:10:00Z'), late('r3', 'XX-9', 'Somebody', '2026-11-06T17:10:00Z')] }),
  });
  assert.equal(out.added, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_penalty').get().n, 0);
  assert.equal(out.unmatched.length, 2);
  assert.match(out.unmatched.join(' '), /no employee number in Maintenance/);
  assert.match(out.unmatched.join(' '), /no one in HIVE is XX-9/);
});

test('withdrawn in Maintenance: taken back off while the month is open, left alone once closed', async () => {
  const { raw, db } = setup();
  const env = { DB: db, MAINTENANCE_LINK: LINK };
  await takeMaintenanceDeductions(env, { today: '2026-11-07', fetchImpl: said({ '2026-11': [late('r1', 'SV-01', 'Douglas', '2026-11-06T17:10:00Z'), late('r4', 'CO-02', 'Destiny', '2026-11-06T17:10:00Z')] }) });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pay_penalty').get().n, 2);
  // A deduction somebody entered by hand is not Maintenance's to take off.
  const run = raw.prepare("SELECT id FROM pay_run WHERE month LIKE '2026-11%'").get();
  raw.prepare("INSERT INTO pay_penalty (run_id, staff_id, amount, reason, actor) VALUES (?, 1, 20, 'Broken glass', 'Kwame')").run(run.id);
  const out = await takeMaintenanceDeductions(env, { today: '2026-11-07', fetchImpl: said({ '2026-11': [late('r4', 'CO-02', 'Destiny', '2026-11-06T17:10:00Z')] }) });
  assert.equal(out.removed, 1);
  assert.deepEqual(raw.prepare('SELECT reason FROM pay_penalty ORDER BY id').all().map((r) => r.reason), ['Late submission of report', 'Broken glass']);
  raw.prepare("UPDATE pay_run SET status = 'final' WHERE id = ?").run(run.id);
  const closed = await takeMaintenanceDeductions(env, { today: '2026-11-07', fetchImpl: said({}) });
  assert.equal(closed.removed, 0, 'a closed month is a record');
});

test('nothing happens until HIVE is linked to Maintenance', async () => {
  const { db } = setup();
  let asked = false;
  const out = await takeMaintenanceDeductions({ DB: db }, { fetchImpl: async () => { asked = true; return new Response('{}'); } });
  assert.equal(out.added, 0);
  assert.equal(asked, false);
});
