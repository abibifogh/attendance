import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster } from '../src/routes/attendance.js';

/**
 * Leave somebody has asked for, on the rota before it is decided.
 *
 * Approved leave has always turned the day into the leave. A request still
 * waiting showed nothing at all, so a week could be built right over the top
 * of it and the clash only surface when somebody approved it. It is shown now
 * the way a day somebody says they cannot work is shown: to whoever plans the
 * rota, as a question waiting on an answer.
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
            DELETE FROM att_availability; DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec(`INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
            VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`);
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES
            (1, '1', 'Adjoa', 'Front', '2020-01-01'),
            (2, '2', 'Kwesi', 'Front', '2020-01-01')`);
  const code = raw.prepare("SELECT code FROM att_reasons WHERE kind = 'leave' AND active = 1 ORDER BY sort_order LIMIT 1").get().code;
  return { raw, db: d1(raw), code };
}

const asWho = (db, permissions) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/roster?from=2026-10-05&to=2026-10-11'),
  session: { user: { id: 4, name: 'Efua', role: 'x' }, permissions },
  executionContext: null,
  request: new Request('https://x/'),
});
const planner = (db) => asWho(db, ['att_rota', 'att_view']);
const reader = (db) => asWho(db, ['att_rota_view']);
const dayOf = (out, name, day) => out.rows.find((r) => r.staff.name === name).days.find((d) => d.day === day);

test('leave waiting on an answer is on the planner’s rota, every day it covers', async () => {
  const { raw, db, code } = setup();
  raw.prepare(`INSERT INTO att_leave (id, staff_id, reason_code, from_day, to_day, days, status, reason)
               VALUES (7, 1, ?, '2026-10-07', '2026-10-09', 3, 'pending', 'Sister''s wedding')`).run(code);
  const out = await (await getRoster(planner(db))).json();

  for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) {
    const asked = dayOf(out, 'Adjoa', day).leaveAsked;
    assert.equal(asked.id, 7, `on ${day}`);
    assert.equal(asked.from, '2026-10-07');
    assert.equal(asked.to, '2026-10-09');
    assert.equal(asked.days, 3);
    assert.equal(asked.note, "Sister's wedding");
    assert.ok(asked.label);
  }
  assert.equal(dayOf(out, 'Adjoa', '2026-10-06').leaveAsked, null, 'not the day before');
  assert.equal(dayOf(out, 'Adjoa', '2026-10-10').leaveAsked, null, 'nor the day after');
  assert.equal(dayOf(out, 'Kwesi', '2026-10-08').leaveAsked, null, 'nor anybody else');
  assert.equal(dayOf(out, 'Adjoa', '2026-10-08').leave, null, 'and it is not leave yet');
});

test('once approved it is the leave itself, and a declined one is gone', async () => {
  const { raw, db, code } = setup();
  raw.prepare(`INSERT INTO att_leave (id, staff_id, reason_code, from_day, to_day, days, status)
               VALUES (8, 1, ?, '2026-10-07', '2026-10-07', 1, 'approved'),
                      (9, 2, ?, '2026-10-07', '2026-10-07', 1, 'rejected')`).run(code, code);
  const out = await (await getRoster(planner(db))).json();
  const approved = dayOf(out, 'Adjoa', '2026-10-07');
  assert.equal(approved.leaveAsked, null);
  assert.ok(approved.leave, 'the day is the leave');
  assert.equal(dayOf(out, 'Kwesi', '2026-10-07').leaveAsked, null, 'a declined request shows nothing');
});

test('somebody who can only read the rota does not see what has been asked for', async () => {
  const { raw, db, code } = setup();
  raw.prepare(`INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
               VALUES (1, ?, '2026-10-07', '2026-10-07', 1, 'pending')`).run(code);
  const out = await (await getRoster(reader(db))).json();
  assert.equal(dayOf(out, 'Adjoa', '2026-10-07').leaveAsked, null);
});
