import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { dutyBoard, fillDuty, myDuties, setDuty, tellDutiesTomorrow } from '../src/lib/duties.js';
import { tickMyDuty } from '../src/routes/duties.js';

/** Duties on a shift: staff lunch, common area, laundry. Made-up people only. */

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

const MON = '2026-11-09';
const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${MON}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10));

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  // The shifts first, so the migration that sets up the duties finds them.
  const files = readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort();
  for (const f of files.filter((n) => n < '0158')) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec('DELETE FROM att_staff; DELETE FROM att_shifts;');
  raw.exec(`INSERT INTO att_shifts (id, name, department, starts_at, ends_at) VALUES
    (1, 'Breakfast', 'F&B', '06:00', '15:00'),
    (2, 'Bistro', 'F&B', '13:45', '22:00'),
    (3, 'Common area', 'Housekeeping', '07:00', '16:00'),
    (4, 'Laundry 2', 'Housekeeping', '08:30', '17:30'),
    (5, 'Helper', 'Housekeeping', '08:00', '17:00')`);
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, active, on_rota) VALUES
    (1, 'A1', 'Ama Serwaa', 'F&B', 1, 1), (2, 'A2', 'Esi Quaye', 'F&B', 1, 1), (3, 'A3', 'Kojo Antwi', 'F&B', 1, 1),
    (4, 'H1', 'Nana Adjei', 'Housekeeping', 1, 1), (5, 'H2', 'Kofi Mensah', 'Housekeeping', 1, 1), (6, 'H3', 'Akosua Darko', 'Housekeeping', 1, 1)`);
  for (const f of files.filter((n) => n >= '0158')) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  const put = raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, ?, 1)');
  for (const day of days(7)) {
    put.run(1, day, 1); put.run(2, day, 1); put.run(3, day, 2);
    put.run(5, day, 4); put.run(6, day, 5);
    if (day !== days(7)[3]) put.run(4, day, 3); // Nana is off on the Thursday
  }
  raw.exec("INSERT INTO settings (key, value) VALUES ('timezone', 'UTC') ON CONFLICT (key) DO UPDATE SET value = 'UTC'");
  return { raw, db: d1(raw) };
}

const dutyId = (raw, name) => raw.prepare('SELECT id FROM rota_duty WHERE name = ?').get(name).id;

test('the three duties are set up, linked to the shifts that are them already', () => {
  const { raw } = setup();
  const rows = raw.prepare('SELECT name, department, shift_ids, kind, ready_by, needs_daily FROM rota_duty ORDER BY sort').all();
  assert.deepEqual(rows.map((r) => [r.name, r.department, JSON.parse(r.shift_ids), r.kind, r.ready_by, r.needs_daily]), [
    ['Staff lunch', 'F&B', [], 'lunch', '12:30', 1],
    ['Common area', 'Housekeeping', [3], null, null, 1],
    ['Laundry', 'Housekeeping', [4], null, null, 1],
  ]);
});

test('staff lunch: only people on before it is due, and a day nobody has it is flagged', async () => {
  const { raw, db } = setup();
  const lunch = dutyId(raw, 'Staff lunch');
  const board = await dutyBoard(db, { from: MON, to: days(7)[6] });
  const mon = board.days[0].duties.find((d) => d.dutyId === lunch);
  assert.equal(mon.gap, true);
  assert.deepEqual(mon.eligible.map((e) => [e.name, e.ok]), [['Ama Serwaa', true], ['Esi Quaye', true], ['Kojo Antwi', false]]);
  const late = await setDuty(db, { dutyId: lunch, day: MON, staffId: 3 });
  assert.match(late.error, /starts at 13:45, after staff lunch is due at 12:30/);
  assert.equal((await setDuty(db, { dutyId: lunch, day: MON, staffId: 2 })).ok, true);
  const after = await dutyBoard(db, { from: MON, to: MON });
  assert.equal(after.days[0].duties.find((d) => d.dutyId === lunch).gap, false);
  assert.deepEqual(after.cells[`2|${MON}`], [{ dutyId: lunch, name: 'Staff lunch' }], 'a tag on her shift card');
});

test('fill the week fairly shares it out, fewest this month first', async () => {
  const { raw, db } = setup();
  const lunch = dutyId(raw, 'Staff lunch');
  await setDuty(db, { dutyId: lunch, day: MON, staffId: 1 });
  const out = await fillDuty(db, { dutyId: lunch, from: MON, to: days(7)[6] });
  assert.equal(out.filled, 6);
  const n = (id) => raw.prepare('SELECT COUNT(*) AS n FROM rota_duty_day WHERE staff_id = ?').get(id).n;
  assert.deepEqual([n(1), n(2), n(3)], [4, 3, 0], 'turn about, never the one who starts after lunch');
});

test('housekeeping: covered by its own shift, flagged the day that shift is off, given on top of a helper shift', async () => {
  const { raw, db } = setup();
  const common = dutyId(raw, 'Common area');
  const thu = days(7)[3];
  const board = await dutyBoard(db, { from: MON, to: days(7)[6] });
  const ca = (i) => board.days[i].duties.find((d) => d.dutyId === common);
  assert.equal(ca(0).gap, false);
  assert.deepEqual(ca(0).byShift.map((p) => p.name), ['Nana Adjei']);
  assert.equal(ca(3).gap, true);
  assert.equal(ca(3).suggest.name, 'Akosua Darko', 'the helper before the laundry');
  await setDuty(db, { dutyId: common, day: thu, staffId: 6 });
  const after = await dutyBoard(db, { from: thu, to: thu });
  assert.deepEqual(after.days[0].duties.find((d) => d.dutyId === common).added.map((p) => p.name), ['Akosua Darko']);
  // Off that day: the duty goes with the shift.
  raw.prepare('UPDATE att_roster SET shift_id = NULL WHERE staff_id = 6 AND day = ?').run(thu);
  const off = await dutyBoard(db, { from: thu, to: thu });
  assert.equal(off.days[0].duties.find((d) => d.dutyId === common).gap, true);
  assert.equal((await setDuty(db, { dutyId: common, day: thu, staffId: 6 })).ok, false);
});

test('their own shifts carry it, with the plates, and they are told the evening before, once', async () => {
  const { raw, db } = setup();
  const lunch = dutyId(raw, 'Staff lunch');
  const tue = days(7)[1];
  raw.exec("INSERT INTO users (id, name, role, staff_id, active) VALUES (7, 'Esi', 'staff', 2, 1)");
  raw.exec(`INSERT INTO lunch_order (staff_id, day, taking) VALUES (1, '${tue}', 1), (2, '${tue}', 1), (3, '${tue}', 0)`);
  await setDuty(db, { dutyId: lunch, day: tue, staffId: 2, by: 'Office' });
  const mine = await myDuties(db, 2, MON, days(7)[6]);
  assert.equal(mine.get(tue)[0].plates, 2);
  assert.equal(mine.get(tue)[0].steps.length, 3);

  assert.equal((await tellDutiesTomorrow(db, { now: `${MON} 17:00` })).told, 0, 'not before 18:00');
  assert.equal((await tellDutiesTomorrow(db, { now: `${MON} 18:05` })).told, 1);
  assert.equal((await tellDutiesTomorrow(db, { now: `${MON} 18:10` })).told, 0, 'once');
  const notice = raw.prepare("SELECT title, body, user_id FROM app_notices WHERE kind = 'rota.duty_tomorrow'").get();
  assert.equal(notice.title, 'Tomorrow: Breakfast at 06:00, and you make staff lunch');
  assert.match(notice.body, /2 eating so far/);
  assert.equal(notice.user_id, 7);
});

test('they tick off what they have done, on their own duty only', async () => {
  const { raw, db } = setup();
  const lunch = dutyId(raw, 'Staff lunch');
  await setDuty(db, { dutyId: lunch, day: MON, staffId: 2 });
  const ctx = (staffId, body) => ({
    db, env: {}, url: new URL('https://x/api/me/duties/tick'),
    session: { user: { id: 7, name: 'Esi', role: 'staff', staff_id: staffId }, permissions: ['att_me'] },
    request: new Request('https://x/', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const out = await (await tickMyDuty(ctx(2, { dutyId: lunch, day: MON, step: 1, on: true }))).json();
  assert.deepEqual(out.done, [1]);
  assert.equal(raw.prepare('SELECT done FROM rota_duty_day WHERE staff_id = 2').get().done, '[1]');
  await assert.rejects(() => tickMyDuty(ctx(1, { dutyId: lunch, day: MON, step: 0, on: true })), /not yours/);
});
