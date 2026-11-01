import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { adminShiftsBetween, isAdminShift, sendAdminShifts } from '../src/lib/maintenance-shifts.js';

/**
 * "For those required to send weekly plan, check their shift in hive, if they
 * have an admin shift, make those days visible in a way and require plan for
 * that day to be completed before they can submit their plan."
 *
 * HIVE sends Maintenance (where Team Tasks lives) every Admin shift from a
 * week ago to three weeks ahead, once an hour, with the link key it already
 * uses. Matched there by employee number.
 */

const KEY = `mxh_${'cd'.repeat(24)}`;
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
  raw.exec('DELETE FROM att_roster; DELETE FROM att_staff;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, no, name] of [[1, 'SV-01', 'Douglas Eshun'], [2, 'CO-02', 'Destiny Owusu'], [3, ' ', 'Abena NoNumber']]) {
    raw.prepare(`INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, '2020-01-01')`).run(id, no, name);
  }
  const shift = (name, a, b) => Number(raw.prepare('INSERT INTO att_shifts (name, starts_at, ends_at, break_minutes) VALUES (?, ?, ?, 60)').run(name, a, b).lastInsertRowid);
  const admin1 = shift('Admin 1 TEST', '08:00', '17:00');
  const morning = shift('Morning TEST', '06:00', '14:00');
  const put = (staff, day, sh, o = {}) => raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published, title) VALUES (?, ?, ?, ?, ?)')
    .run(staff, day, sh, o.published ?? 1, o.title ?? null);
  put(1, '2026-11-09', admin1);                         // Douglas, Admin, Monday
  put(1, '2026-11-10', morning);                        // Douglas, not Admin
  put(2, '2026-11-11', morning, { title: 'Admin cover' }); // the day's own title says Admin
  put(2, '2026-11-12', admin1, { published: 0 });       // a draft day goes too
  put(3, '2026-11-09', admin1);                         // no employee number: cannot be matched
  put(1, '2026-12-30', admin1);                         // too far ahead
  return { raw, db: d1(raw) };
}

test('an Admin shift is one that says Admin', () => {
  assert.equal(isAdminShift('Admin 2'), true);
  assert.equal(isAdminShift('admin'), true);
  assert.equal(isAdminShift('Administration cover'), false, 'the word, not part of a longer one');
  assert.equal(isAdminShift('Morning'), false);
});

test('only Admin shifts, with hours, by employee number', async () => {
  const { db } = setup();
  const { shifts, unnumbered } = await adminShiftsBetween(db, '2026-11-02', '2026-11-22');
  assert.deepEqual(shifts.map((s) => `${s.employee_no} ${s.day} ${s.shift} ${s.starts_at}-${s.ends_at} ${s.published}`), [
    'SV-01 2026-11-09 Admin 1 TEST 08:00-17:00 true',
    'CO-02 2026-11-11 Admin cover 06:00-14:00 true',
    'CO-02 2026-11-12 Admin 1 TEST 08:00-17:00 false',
  ]);
  assert.deepEqual(unnumbered, ['Abena NoNumber']);
});

test('sent to Maintenance with the link key, a week back to three ahead', async () => {
  const { db } = setup();
  const calls = [];
  const out = await sendAdminShifts({ DB: db, MAINTENANCE_LINK: LINK }, {
    today: '2026-11-05',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ matched: 2, unmatched: [{ employee_no: 'CO-02', name: 'Destiny Owusu' }] }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/rest/v1/rpc/mx_hive_shifts_put');
  assert.equal(calls[0].body.p_key, KEY);
  assert.equal(calls[0].body.p_from, '2026-10-29');
  assert.equal(calls[0].body.p_to, '2026-11-26');
  assert.equal(calls[0].body.p_shifts.length, 3, 'not the one in December');
  assert.equal(out.sent, 3);
  assert.equal(out.matched, 2);
  assert.deepEqual(out.unmatched, ['Abena NoNumber (no employee number in HIVE)', 'Destiny Owusu (CO-02: nobody in Maintenance has it)']);
});

test('nothing is sent until HIVE is linked; a Maintenance without the update says so', async () => {
  const { db } = setup();
  assert.deepEqual(await sendAdminShifts({ DB: db }), { sent: 0, matched: 0, unmatched: [] });
  await assert.rejects(sendAdminShifts({ DB: db, MAINTENANCE_LINK: LINK }, {
    today: '2026-11-05',
    fetchImpl: async () => new Response(JSON.stringify({ message: 'Could not find the function public.mx_hive_shifts_put' }), { status: 404 }),
  }), /database update has not been run/);
});
