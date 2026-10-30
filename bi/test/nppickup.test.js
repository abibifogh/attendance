import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { all, first, run } from '../src/lib/db.js';
import * as np from '../src/routes/niceplace.js';
import * as pickup from '../src/routes/nppickup.js';

/** Nice Place: the desk's sales, and the supervisor's pickups. Everybody and every figure is invented. */

const OWNER = { id: 1, name: 'Test Owner', isOwner: true };
const SUP = { id: 3, name: 'Sam Test', access: [{ systemId: 'insight', role: 'supervisor' }] };
const OTHER = { id: 4, name: 'Kojo Test', access: [{ systemId: 'insight', role: 'supervisor' }] };
const PIC = `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test('the shift is the one ending: Day 03:30 to 13:30, Night 13:30 to 23:00, read an hour back', () => {
  const at = (t) => new Date(`2026-10-30T${t}:00Z`);
  assert.deepEqual(np.suggest(null, at('10:00')), { day: '2026-10-30', shift: 'day' });
  assert.deepEqual(np.suggest(null, at('13:40')), { day: '2026-10-30', shift: 'day' }, 'just after the day shift ends, it is still the day shift being sent');
  assert.deepEqual(np.suggest(null, at('14:45')), { day: '2026-10-30', shift: 'night' });
  assert.deepEqual(np.suggest(null, at('23:20')), { day: '2026-10-30', shift: 'night' });
  assert.deepEqual(np.suggest(null, at('02:00')), { day: '2026-10-29', shift: 'night' });
});

test('the desk sends the money with the counters: it lands where the workbook did, and the people paid for are worked out', async () => {
  const { db } = freshDb();
  const env = { DB: db };
  await np.saveSettings(env, { newLink: true, addName: 'Ama Test' });
  const { token } = await np.settingsOf(env);
  const form = await np.linkForm(env, { t: token });
  assert.deepEqual(form.hours, { day: '03:30–13:30', night: '13:30–23:00' });
  assert.equal(form.choices.length, 4);
  await assert.rejects(np.sendReading(env, { t: token, name: 'Ama Test', day: today(), shift: 'day', photo: PIC, sales: { showerChild: 'lots' } }), /Shower, children/);
  const out = await np.sendReading(env, { t: token, name: 'Ama Test', day: today(), shift: 'day', photo: PIC, sales: { showerChild: '40', showerAdult: '180', toiletChild: '25', toiletAdult: '1,35' } });
  assert.deepEqual(out.sales, { shower: 22000, toilet: 16000, total: 38000 });
  const row = await first(db, 'SELECT * FROM np_revenue WHERE day = ?1 AND shift = ?2', today(), 'day');
  assert.deepEqual([row.shower_child, row.shower_adult, row.shower_total, row.toilet_total, row.staff, row.uploaded_by], [4000, 18000, 22000, 16000, 'Ama Test', 'Desk: Ama Test']);
  assert.equal((await np.linkForm(env, { t: token })).choices.find((c) => c.day === today() && c.shift === 'day').sent, true);
});

async function world() {
  const { db } = freshDb();
  const env = { DB: db };
  await run(db, "INSERT INTO till_access (account_id, area, level) VALUES (3, 'pickups', 2), (4, 'pickups', 1)");
  const d = today();
  for (const [day, shift, total] of [[addDays(d, -3), 'day', 41000], [addDays(d, -3), 'night', 16500], [addDays(d, -2), 'day', 35200], [addDays(d, -1), 'night', 15800]]) {
    await run(db, `INSERT INTO np_revenue (day, shift, toilet_total, shower_total, staff, uploaded_by, uploaded_at) VALUES (?1, ?2, ?3, 0, 'Esi Test', 'Desk: Esi Test', ?1)`, day, shift, total);
  }
  return { env, db, d };
}

test('only admins and the supervisors given pickups see them; only those who may act make one', async () => {
  const { env } = await world();
  await assert.rejects(pickup.pickupsView(env, { id: 9, name: 'Nobody', access: [{ systemId: 'insight', role: 'supervisor' }] }), /not been shared/);
  const seen = await pickup.pickupsView(env, OTHER);
  assert.equal(seen.inSafe.length, 4);
  await assert.rejects(pickup.startPickup(env, OTHER), /look at this, not change it/);
});

test('a pickup: the envelopes in the safe, what was spent with its receipt, the count, then admin and the safe', async () => {
  const { env, db, d } = await world();
  const view = await pickup.pickupsView(env, SUP);
  assert.equal(view.tiles.inSafe, 41000 + 16500 + 35200 + 15800);
  assert.ok(view.missing.some((m) => m.day === addDays(d, -2) && m.shift === 'night'), 'a shift with nothing sent is said');

  const p = await pickup.startPickup(env, SUP);
  assert.equal((await pickup.startPickup(env, SUP)).id, p.id, 'one pickup at a time');
  await assert.rejects(pickup.addExpense(env, { pickupId: p.id, what: 'Toilet roll', amount: '240' }, SUP), /picture of the receipt/);
  const withRoll = await pickup.addExpense(env, { pickupId: p.id, what: 'Toilet roll', amount: '240', supplier: 'A Cleaning Supplies Co', file: PIC }, SUP);
  assert.equal(withRoll.spent, 24000);
  assert.equal(withRoll.expenses[0].ref, `NP/PU/${String(p.id).padStart(3, '0')}-1`);
  const receipt = await first(db, 'SELECT came, hint FROM receipt');
  assert.deepEqual([receipt.came, receipt.hint], ['pickup', 'Toilet roll, from A Cleaning Supplies Co, GH₵ 240.00']);

  const keys = view.inSafe.map((s) => s.key);
  const net = 41000 + 16500 + 35200 + 15800 - 24000;
  await assert.rejects(pickup.recordPickup(env, { pickupId: p.id, shifts: keys, counted: String((net - 1000) / 100) }, SUP), /Say why/);
  const done = await pickup.recordPickup(env, { pickupId: p.id, shifts: keys, counted: String((net - 1000) / 100), note: 'One envelope GH₵ 10 short' }, SUP);
  assert.deepEqual([done.status, done.sales, done.net, done.difference], ['review', net + 24000, net, -1000]);
  assert.equal((await pickup.pickupsView(env, SUP)).inSafe.length, 0, 'each envelope is picked up once');

  await assert.rejects(pickup.reviewPickup(env, { id: p.id, decision: 'approve' }, SUP), /admin/i);
  const asked = await pickup.reviewPickup(env, { id: p.id, decision: 'ask', note: 'Which envelope?' }, OWNER);
  assert.deepEqual([asked.status, asked.reviewNote], ['asked', 'Which envelope?']);
  assert.equal((await pickup.reviewPickup(env, { id: p.id, decision: 'approve' }, OWNER)).status, 'approved');

  // Into the safe, until a count takes it in.
  assert.deepEqual((await pickup.safeIns(env)).map((x) => x.amount), [net - 1000]);
  await pickup.closeInto(env, [p.id], 7);
  assert.deepEqual(await pickup.safeIns(env), []);
  assert.equal((await all(db, 'SELECT * FROM np_pickup_shift')).length, 4);
});
