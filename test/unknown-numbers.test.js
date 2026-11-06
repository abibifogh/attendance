import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ingestPunches } from '../src/lib/attendance-ingest.js';

import { handNumber, matchUnknown, recentPunches, unknownEmployees } from '../src/routes/attendance-setup.js';

/** Punches from a number nobody has, matched to a new starter. Made-up people only. */

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
  raw.exec('DELETE FROM att_staff;');
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on, on_clock) VALUES
    (1, 'T01', 'Kwame Asare', 'Kitchen', '2025-01-01', 1),
    (2, 'H-0042', 'Akosua Darko', 'Kitchen', '2026-11-03', 0)`);
  const punch = raw.prepare(`INSERT INTO att_punches (device_serial, employee_no, at_utc, at_local, day, source, dedupe_key)
                             VALUES ('DEV1', ?, ?, ?, ?, 'push', ?)`);
  for (const [at, i] of [['2026-11-04 08:02:00', 1], ['2026-11-04 17:31:00', 2], ['2026-11-05 07:58:00', 3]]) {
    punch.run('77', at, at, at.slice(0, 10), `k${i}`);
  }
  return { raw, db: d1(raw) };
}

const ctx = (db, body = {}) => ({
  db, env: {},
  url: new URL('https://staff.example.com/api/att/unknown'),
  session: { user: { id: 1, name: 'Office', role: 'admin' }, permissions: ['att_setup'] },
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});

test('a number nobody has is listed with its latest punches', async () => {
  const { db } = setup();
  const { unknown } = await (await unknownEmployees(ctx(db))).json();
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].employee_no, '77');
  assert.equal(unknown[0].punches, 3);
  assert.deepEqual(unknown[0].recent, ['2026-11-05 07:58', '2026-11-04 17:31', '2026-11-04 08:02']);
});

test('matching the number to a new starter gives them the punches and the number', async () => {
  const { raw, db } = setup();
  const out = await (await matchUnknown(ctx(db, { staffId: 2 }), '77')).json();
  assert.equal(out.claimed, 3);
  assert.equal(out.was, 'H-0042');
  const person = raw.prepare('SELECT employee_no, on_clock FROM att_staff WHERE id = 2').get();
  assert.deepEqual({ ...person }, { employee_no: '77', on_clock: 1 });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_punches WHERE staff_id = 2').get().n, 3);
  assert.equal((await (await unknownEmployees(ctx(db))).json()).unknown.length, 0);
  assert.ok(raw.prepare('SELECT COUNT(*) AS n FROM att_days WHERE staff_id = 2').get().n >= 1, 'their days are worked out');
});

test('a number already somebody else’s, or with nothing waiting, is refused', async () => {
  const { db } = setup();
  await assert.rejects(() => matchUnknown(ctx(db, { staffId: 2 }), 'T01'), /already belongs to Kwame Asare/);
  await assert.rejects(() => matchUnknown(ctx(db, { staffId: 2 }), '99'), /Nothing is waiting/);
});

test('the latest punches say whose each one is, and a search finds them by number or name', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, source, dedupe_key)
            VALUES ('DEV1', 'T01', 1, '2026-11-05 09:00:00', '2026-11-05 09:00:00', '2026-11-05', 'push', 'kk')`);
  const get = async (q) => (await recentPunches({ ...ctx(db), url: new URL(`https://x/api/att/punches/recent${q ? `?q=${encodeURIComponent(q)}` : ''}`) })).json();
  const all = await get('');
  assert.equal(all.punches.length, 4);
  assert.deepEqual(all.punches.map((p) => [p.employeeNo, p.name]).slice(0, 2), [['T01', 'Kwame Asare'], ['77', null]]);
  assert.equal(all.lastAt, '2026-11-05 09:00');

  const byName = await get('akosua');
  assert.deepEqual(byName.people.map((p) => [p.name, p.employeeNo, p.punches, p.onClock]), [['Akosua Darko', 'H-0042', 0, false]]);
  assert.equal(byName.punches.length, 0, 'nothing under her number: the terminal knows her by another');
  const byNumber = await get('77');
  assert.equal(byNumber.punches.length, 3);
  assert.ok(byNumber.punches.every((p) => p.name === null));
});

test('a leaver’s number handed on: punches from that day go to the new holder, the earlier stay', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on, left_on, active, on_clock)
            VALUES (3, 'NSS002', 'Kojo Antwi', 'Kitchen', '2025-01-01', '2026-10-31', 0, 1)`);
  const put = raw.prepare(`INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, source, dedupe_key)
                           VALUES ('DEV1', 'NSS002', 3, ?, ?, ?, 'push', ?)`);
  for (const [at, k] of [['2026-10-07 18:14:00', 'a'], ['2026-11-04 19:36:00', 'b'], ['2026-11-06 07:49:00', 'c']]) put.run(at, at, at.slice(0, 10), k);

  const out = await (await handNumber(ctx(db, { toStaffId: 2, from: '2026-11-01' }), '3')).json();
  assert.equal(out.moved, 2);
  assert.equal(out.retired, 'NSS002 (left)');
  const who = (k) => raw.prepare('SELECT staff_id FROM att_punches WHERE dedupe_key = ?').get(k).staff_id;
  assert.deepEqual([who('a'), who('b'), who('c')], [3, 2, 2]);
  assert.equal(raw.prepare('SELECT employee_no FROM att_staff WHERE id = 2').get().employee_no, 'NSS002');
  assert.equal(raw.prepare('SELECT employee_no FROM att_staff WHERE id = 3').get().employee_no, 'NSS002 (left)');
});

test('a punch under a leaver’s number after they left is nobody’s, and shows up to be matched', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on, left_on, active, on_clock)
            VALUES (3, 'NSS002', 'Kojo Antwi', 'Kitchen', '2025-01-01', '2026-10-31', 0, 1)`);
  raw.exec("INSERT INTO att_devices (id, serial, name, active) VALUES (9, 'D9', 'Front door', 1)");
  await ingestPunches(db, {
    device: { id: 9, serial: 'D9' },
    events: [
      { employeeNoString: 'NSS002', time: '2026-10-30T08:00:00Z', serialNo: 'x1' },
      { employeeNoString: 'NSS002', time: '2026-11-06T07:49:00Z', serialNo: 'x2' },
    ],
    timezone: 'UTC',
    source: 'push',
  });
  const who = (k) => raw.prepare('SELECT staff_id FROM att_punches WHERE dedupe_key = ?').get(k).staff_id;
  assert.equal(who('s:x1'), 3, 'before they left: theirs');
  assert.equal(who('s:x2'), null, 'after: asked about');
  const { unknown } = await (await unknownEmployees(ctx(db))).json();
  assert.ok(unknown.some((u) => u.employee_no === 'NSS002'));
});
