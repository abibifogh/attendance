import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  deadlineFor, draftRule, owedNow, publishGate, shiftClock, watchRotaDraft, weekLabel,
} from '../src/lib/rota-draft.js';
import { publishRoster } from '../src/routes/attendance.js';
import {
  decideRotaReview, rotaReviewState, saveRotaDraftRule, sendRotaForReview,
} from '../src/routes/rota-review.js';
import { BY_KEY } from '../src/lib/notice-kinds.js';
import { addDays, nowIn, startOfWeek } from '../src/util/dates.js';

/** The weekly draft rota deadline and its review. Made-up people only. */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
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
  raw.exec('DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec(`INSERT INTO users (id, name, role, active, permissions) VALUES
    (1, 'Kofi Mensah', 'admin', 1, NULL),
    (2, 'Esi Quaye', 'admin', 1, NULL),
    (3, 'Kojo Antwi', 'supervisor', 1, '["att_rota"]'),
    (4, 'Yaw Boateng', 'supervisor', 1, '["att_view"]'),
    (5, 'Abena Mensah', 'supervisor', 0, '["att_rota"]')`);
  return { raw, db: d1(raw) };
}

const ctxFor = (db, { id = 3, name = 'Kojo Antwi', role = 'supervisor', url = 'https://x/api/att/rota-review', body = null } = {}) => ({
  db,
  env: {},
  request: body
    ? new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    : new Request(url),
  session: { user: { id, name, role }, permissions: ['att_rota'] },
});
const admin = (db, opts = {}) => ctxFor(db, { id: 1, name: 'Kofi Mensah', role: 'admin', ...opts });
const read = async (res) => res.json();

test('the defaults: Monday 17:00 for the next week, reminded Friday 10:00 and Monday 14:00', () => {
  const rule = draftRule({});
  assert.deepEqual([rule.on, rule.dueDow, rule.dueTime, rule.firstDays, rule.firstTime, rule.lastHours, rule.weeksAhead],
    [true, 0, '17:00', 3, '10:00', 3, 1]);
  const d = deadlineFor(rule, '2026-11-16');
  assert.equal(d.due, '2026-11-09 17:00');
  assert.deepEqual(d.steps.map((s) => [s.step, s.at]), [
    ['first', '2026-11-06 10:00'], ['last', '2026-11-09 14:00'], ['due', '2026-11-09 17:00']]);
  assert.equal(weekLabel('2026-11-16'), '16 – 22 November');
  assert.equal(shiftClock('2026-11-09 01:00', -180), '2026-11-08 22:00');
});

test('what is owed: each reminder from its time, the deadline one going stale after half a day', () => {
  const rule = draftRule({});
  assert.deepEqual(owedNow(rule, '2026-11-06 09:59'), []);
  assert.deepEqual(owedNow(rule, '2026-11-06 10:00').map((o) => [o.weekStart, o.step]), [['2026-11-16', 'first']]);
  assert.deepEqual(owedNow(rule, '2026-11-09 15:00').map((o) => o.step), ['first', 'last']);
  assert.deepEqual(owedNow(rule, '2026-11-09 17:05').map((o) => o.step), ['due']);
  assert.deepEqual(owedNow(rule, '2026-11-10 06:00'), []);
  assert.deepEqual(owedNow(draftRule({ rota_draft_on: '0' }), '2026-11-09 17:05'), []);
});

test('reminders go to the planners once, with a copy to each administrator, and stop once it is sent', async () => {
  const { raw, db } = setup();
  // Set the deadline to an hour ago, so the reminder at the deadline is owed now.
  const now = nowIn('UTC');
  const ago = shiftClock(now, -60);
  const dueDay = ago.slice(0, 10);
  const dow = (new Date(`${dueDay}T12:00:00Z`).getUTCDay() + 6) % 7;
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'rota_draft_due_dow'").run(String(dow));
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'rota_draft_due_time'").run(ago.slice(11));
  raw.prepare("UPDATE settings SET value = '0' WHERE key = 'rota_draft_last_hours'").run();
  const week = addDays(startOfWeek(dueDay), 7);

  const first = await watchRotaDraft(db);
  assert.ok(first.sent >= 3, 'the planner and two administrators');
  const notes = raw.prepare('SELECT * FROM app_notices WHERE kind IN (\'rota.draft_due\', \'rota.draft_due_copy\') ORDER BY id').all();
  assert.deepEqual([...new Set(notes.filter((n) => n.kind === 'rota.draft_due').map((n) => n.user_id))], [3]);
  assert.deepEqual([...new Set(notes.filter((n) => n.kind === 'rota.draft_due_copy').map((n) => n.user_id))].sort(), [1, 2]);
  assert.ok(notes.some((n) => /late/.test(n.title)));

  assert.equal((await watchRotaDraft(db)).sent, 0, 'not twice');

  // Sent for review: nothing more for that week, even after a fresh claim table.
  raw.exec('DELETE FROM rota_draft_nudge');
  await sendRotaForReview(ctxFor(db, { body: { from: week, to: addDays(week, 6) } }));
  assert.equal((await watchRotaDraft(db)).sent, 0);
});

test('sent for review goes to the chosen reviewers; only they answer; the planner is told', async () => {
  const { raw, db } = setup();
  await saveRotaDraftRule(admin(db, {
    body: { on: true, dueDow: 0, dueTime: '17:00', firstDays: 3, firstTime: '10:00', lastHours: 3, weeksAhead: 1, ccAdmins: true, reviewers: [2] },
  }));
  const out = await read(await sendRotaForReview(ctxFor(db, { body: { from: '2026-11-16', to: '2026-11-22', note: 'Short on Saturday' } })));
  assert.deepEqual(out.reviewers, ['Esi Quaye']);
  const asked = raw.prepare("SELECT user_id FROM app_notices WHERE kind = 'rota.review_asked'").all().map((r) => r.user_id);
  assert.deepEqual(asked, [2]);

  const state = await read(await rotaReviewState(ctxFor(db, { url: 'https://x/api/att/rota-review?from=2026-11-16&to=2026-11-22' })));
  assert.equal(state.review.status, 'sent');
  assert.deepEqual(state.review.reviewers, ['Esi Quaye']);
  assert.equal(state.canReview, false);

  await assert.rejects(decideRotaReview(ctxFor(db, { body: { action: 'approve' } }), String(out.id)), /administrator/);
  await assert.rejects(decideRotaReview(admin(db, { body: { action: 'approve' } }), String(out.id)), /not one of the reviewers/);
  await assert.rejects(decideRotaReview(admin(db, { id: 2, name: 'Esi Quaye', body: { action: 'return' } }), String(out.id)), /needs changing/);
  await decideRotaReview(admin(db, { id: 2, name: 'Esi Quaye', body: { action: 'return', note: 'Saturday needs a second cook' } }), String(out.id));
  const told = raw.prepare("SELECT * FROM app_notices WHERE kind = 'rota.review_done'").all();
  assert.equal(told.length, 1);
  assert.equal(told[0].user_id, 3);
  assert.match(told[0].title, /Sent back/);

  // Sent again: the old one is replaced, and approving it tells the planner.
  const again = await read(await sendRotaForReview(ctxFor(db, { body: { from: '2026-11-16', to: '2026-11-22' } })));
  assert.equal(raw.prepare('SELECT status FROM rota_review WHERE id = ?').get(out.id).status, 'replaced');
  await decideRotaReview(admin(db, { id: 2, name: 'Esi Quaye', body: { action: 'approve' } }), String(again.id));
  await assert.rejects(decideRotaReview(admin(db, { id: 2, name: 'Esi Quaye', body: { action: 'approve' } }), String(again.id)), /already/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'rota.review_done'").get().n, 2);
});

test('nobody chosen means every administrator; only an administrator changes the rule', async () => {
  const { db } = setup();
  const out = await read(await sendRotaForReview(ctxFor(db, { body: { from: '2026-11-16', to: '2026-11-22' } })));
  assert.deepEqual(out.reviewers.sort(), ['Esi Quaye', 'Kofi Mensah']);
  await assert.rejects(saveRotaDraftRule(ctxFor(db, { body: {} })), /administrator/);
  await assert.rejects(saveRotaDraftRule(admin(db, { body: { on: true, dueDow: 0, dueTime: '5pm', firstDays: 3, firstTime: '10:00', lastHours: 3, weeksAhead: 1 } })), /17:00/);
});

test('the four messages are notice kinds that can email', () => {
  for (const key of ['rota.draft_due', 'rota.draft_due_copy', 'rota.review_asked', 'rota.review_done']) {
    assert.ok(BY_KEY.get(key)?.ways.includes('email'), key);
  }
});

test('a planner publishes only what is approved and unchanged since; an administrator always may', async () => {
  const { raw, db } = setup();
  raw.exec("DELETE FROM att_roster; DELETE FROM att_staff; DELETE FROM att_shifts;");
  raw.exec("INSERT INTO att_shifts (id, name, starts_at, ends_at) VALUES (1, 'Morning', '06:00', '14:00')");
  raw.exec("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, 'R1', 'Akosua Darko', 'Kitchen', '2024-01-01')");
  raw.exec("INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, '2026-11-17', 1, 0)");
  const range = { from: '2026-11-16', to: '2026-11-22' };

  let gate = await publishGate(db, { ...range, role: 'supervisor' });
  assert.deepEqual([gate.needed, gate.ok, gate.waiting], [true, false, ['2026-11-17']]);
  assert.equal((await publishGate(db, { ...range, role: 'admin' })).ok, true);
  await assert.rejects(publishRoster(ctxFor(db, { url: 'https://x/api/att/roster/publish', body: { ...range, notify: 'nobody' } })), /approving first/);

  const sent = await read(await sendRotaForReview(ctxFor(db, { body: range })));
  assert.equal((await publishGate(db, { ...range, role: 'supervisor' })).ok, false, 'sent is not approved');
  await decideRotaReview(admin(db, { body: { action: 'approve' } }), String(sent.id));
  // Approved a moment ago; push the approval back so a change can come after it.
  raw.exec("UPDATE rota_review SET decided_at = datetime('now', '-1 hour')");
  assert.equal((await publishGate(db, { ...range, role: 'supervisor' })).ok, true);

  raw.exec(`INSERT INTO att_roster_log (day, staff_id, shift_id, action, source, actor)
            VALUES ('2026-11-17', 1, 1, 'changed', 'hand', 'Kojo Antwi')`);
  gate = await publishGate(db, { ...range, role: 'supervisor' });
  assert.deepEqual([gate.ok, gate.changed], [false, ['2026-11-17']]);
  await assert.rejects(publishRoster(ctxFor(db, { url: 'https://x/api/att/roster/publish', body: { ...range, notify: 'nobody' } })), /changed since it was approved/);

  raw.exec("UPDATE settings SET value = '0' WHERE key = 'rota_publish_needs_review'");
  assert.equal((await publishGate(db, { ...range, role: 'supervisor' })).ok, true, 'switched off');
});
