import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { signLink } from '../src/lib/till-link.js';

/**
 * Insight's Approvals page, as far as HIVE can tell: a signed request naming
 * somebody by email, a list of what waits for them, and a decision that goes
 * through HIVE's own route for it, recorded under their name "via Insight".
 * Every name here is made up.
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
    async raw() { return db.prepare(sql).all(...binds).map((r) => Object.values(r)); },
  });
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

const SECRET = 'shared-for-the-test';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec("DELETE FROM users; DELETE FROM att_staff; UPDATE settings SET value = 'UTC' WHERE key = 'timezone';");
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Ama Test', 'Front office', '2020-01-01')").run();
  raw.prepare("INSERT INTO users (id, name, role, active, email) VALUES (3, 'Boss Test', 'admin', 1, 'boss@example.com')").run();
  raw.prepare("INSERT INTO users (id, name, role, active, staff_id, email, permissions) VALUES (7, 'Ama Test', 'staff', 1, 1, 'ama@example.com', '[\"att_me\"]')").run();
  raw.prepare("INSERT INTO att_leave (id, staff_id, reason_code, from_day, to_day, days, status, reason, requested_by, requested_by_id) VALUES (11, 1, 'annual_leave', '2026-11-02', '2026-11-04', 3, 'pending', 'A family visit', 'Ama Test (staff)', 7)").run();
  raw.prepare("INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, reason, purpose) VALUES (21, 1, 600, 3, 200, 'requested', 'Rent', 'other')").run();
  raw.prepare("INSERT INTO lunch_change (id, staff_id, day, want, note) VALUES (31, 1, '2026-11-05', 0, 'Out at a training')").run();
  raw.prepare("INSERT INTO att_time_edit (id, staff_id, day, observed_in, now_in, now_out, reason, actor, status) VALUES (41, 1, '2026-10-14', '06:02', '06:02', '14:05', 'Forgot to clock out', 'Ama Test (staff)', 'pending')").run();
  raw.prepare("INSERT INTO hr_document (id, staff_id, kind, title, filename, mime, bytes, content, status) VALUES (51, 1, 'id', 'Ghana Card', 'card.jpg', 'image/jpeg', 3, x'010203', 'pending')").run();
  raw.prepare("INSERT INTO att_query (id, staff_id, from_day, to_day, reason, raised_by) VALUES (61, 1, '2026-10-01', '2026-10-07', 'Absent two days with no note', 'Sam Test (supervisor)')").run();
  const env = { DB: d1(raw), SESSION_SECRET: 'x'.repeat(40), INSIGHT_SSO_SECRET: SECRET };
  return { raw, env };
}

async function ask(env, path, body, secret = SECRET) {
  const text = JSON.stringify(body);
  const res = await worker.fetch(new Request(`https://hive.internal${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...await signLink(secret, path, text) }, body: text,
  }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
}

test('only Insight may ask, and only for somebody with a HIVE login', async () => {
  const { env } = setup();
  assert.equal((await ask(env, '/api/link/approvals/list', { email: 'boss@example.com' }, 'wrong')).status, 401);
  const nobody = await ask(env, '/api/link/approvals/list', { email: 'stranger@example.com' });
  assert.equal(nobody.status, 403);
  assert.match(nobody.data.error, /No HIVE login has the email stranger@example\.com/);
});

test('the list is what this person may decide, in words', async () => {
  const { env } = setup();
  const { status, data } = await ask(env, '/api/link/approvals/list', { email: 'BOSS@example.com' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.as, 'Boss Test');
  assert.deepEqual(data.failed, [], 'every kind could be read');
  const byKind = Object.fromEntries(data.items.map((i) => [i.kind, i]));
  assert.ok(byKind.leave, 'leave is listed');
  assert.equal(byKind.leave.title, 'Leave · Ama Test');
  assert.match(byKind.leave.sub, /Annual leave, 3 days/);
  assert.deepEqual(byKind.leave.decisions.map((d) => d.key), ['approve', 'refuse']);
  assert.equal(byKind.leave.decisions[0].fields.find((f) => f.name === 'daysCharged').value, 3);
  assert.equal(byKind.advance.amount, 600);
  assert.match(byKind.lunch.sub, /Take me off/);
  assert.match(byKind.times.sub, /out — → 14:05/);
  assert.equal(byKind.document.sub, 'Ghana Card · card.jpg');
  assert.deepEqual(byKind.query.decisions.map((d) => d.key), ['direction', 'sign', 'close']);
  assert.match(byKind.leave.open || '', /#\/att-leave$/);

  // A member of staff decides nothing, so sees nothing.
  const staff = await ask(env, '/api/link/approvals/list', { email: 'ama@example.com' });
  assert.deepEqual(staff.data.items, []);
});

test('a decision goes through HIVE’s own route, under the name “via Insight”', async () => {
  const { env, raw } = setup();
  const leave = await ask(env, '/api/link/approvals/decide', {
    email: 'boss@example.com', kind: 'leave', id: '11', decision: 'approve', fields: { daysCharged: 2, reason: 'annual_leave' },
  });
  assert.equal(leave.status, 200, JSON.stringify(leave.data));
  const row = raw.prepare('SELECT status, days, decided_by FROM att_leave WHERE id = 11').get();
  assert.deepEqual({ ...row }, { status: 'approved', days: 2, decided_by: 'Boss Test via Insight (admin)' });
  // Ama is told, by name, as HIVE always does.
  assert.ok(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'attendance.leave_decided'").get().n >= 1);

  // HIVE's own rules still stand: already decided is already decided.
  const again = await ask(env, '/api/link/approvals/decide', { email: 'boss@example.com', kind: 'leave', id: '11', decision: 'refuse' });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already been decided/);

  // The terms of an advance, changed as it is approved.
  const adv = await ask(env, '/api/link/approvals/decide', {
    email: 'boss@example.com', kind: 'advance', id: '21', decision: 'approve', fields: { amount: 450, months: 3 },
  });
  assert.equal(adv.status, 200, JSON.stringify(adv.data));
  assert.deepEqual({ ...raw.prepare('SELECT status, amount, monthly, decided_by FROM hr_advance WHERE id = 21').get() },
    { status: 'approved', amount: 450, monthly: 150, decided_by: 'Boss Test via Insight (admin)' });

  // A refusal with a reason.
  const lunch = await ask(env, '/api/link/approvals/decide', { email: 'boss@example.com', kind: 'lunch', id: '31', decision: 'refuse', note: 'The menu is set' });
  assert.equal(lunch.status, 200, JSON.stringify(lunch.data));
  assert.equal(raw.prepare('SELECT decision FROM lunch_change WHERE id = 31').get().decision, 'declined');

  // Nothing is refused by guessing at a decision HIVE does not know.
  const odd = await ask(env, '/api/link/approvals/decide', { email: 'boss@example.com', kind: 'leave', id: '11', decision: 'aprove' });
  assert.equal(odd.status, 400);

  // Somebody without the permission cannot decide it, whatever Insight asks.
  raw.prepare("INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status) VALUES (22, 1, 100, 1, 100, 'requested')").run();
  const staff = await ask(env, '/api/link/approvals/decide', { email: 'ama@example.com', kind: 'advance', id: '22', decision: 'approve' });
  assert.equal(staff.status, 403);
  assert.equal(raw.prepare('SELECT status FROM hr_advance WHERE id = 22').get().status, 'requested');
});
