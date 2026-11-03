import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { computeLine, splitConduct } from '../src/lib/payroll.js';
import { ratesFrom } from '../src/lib/tax.js';
import { deductionRows } from '../src/lib/payslip-pdf.js';
import {
  conductOverview, dropConduct, levyConduct, myConduct, replyConduct, saveConductRules,
} from '../src/routes/conduct.js';
import { BY_KEY } from '../src/lib/notice-kinds.js';

/** Bonus deductions for breaking a house rule. Made-up people only. */

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

const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES
              (1, 'C1', 'Kwame Asare', 'Front office', '2024-01-01'),
              (2, 'C2', 'Kojo Antwi', 'F&B', '2024-01-01')`);
  return { raw, db: d1(raw) };
}

const ctxFor = (db, { role = 'admin', staffId = null, url = 'https://x/api/conduct', body = null } = {}) => ({
  db,
  env: {},
  request: body
    ? new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    : new Request(url),
  session: { user: { id: 1, name: role === 'admin' ? 'Test Admin' : 'Test Person', role, staff_id: staffId }, permissions: ['hr_pay', 'att_me'] },
});
const read = async (res) => res.json();

test('the migration seeds six rules, two of them doubling', () => {
  const { raw } = setup();
  const rules = raw.prepare('SELECT * FROM conduct_rule ORDER BY sort_order').all();
  assert.equal(rules.length, 6);
  assert.deepEqual(rules.filter((r) => r.double_repeat).map((r) => r.name), ['Phone during working hours', 'Left before the shift ended']);
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'conduct_notify'").get().value, '1');
});

test('only an administrator levies, drops or changes the list', async () => {
  const { db } = setup();
  await assert.rejects(levyConduct(ctxFor(db, { role: 'manager', body: { staffId: 1, ruleId: 1 } })), /administrator/);
  await assert.rejects(saveConductRules(ctxFor(db, { role: 'manager', body: { rules: [] } })), /administrator/);
  await assert.rejects(dropConduct(ctxFor(db, { role: 'manager', body: {} }), '1'), /administrator/);
});

test('a second phone in the same month is doubled; a rule that does not double stays the same', async () => {
  const { raw, db } = setup();
  const one = await read(await levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 1, note: 'At the desk' } })));
  const two = await read(await levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 1 } })));
  assert.deepEqual([one.amount, one.doubled, two.amount, two.doubled], [10, false, 20, true]);
  const a = await read(await levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 2 } })));
  const b = await read(await levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 2 } })));
  assert.deepEqual([a.amount, b.amount], [10, 10]);
  assert.equal(one.month, TODAY.slice(0, 7));
  const row = raw.prepare('SELECT * FROM conduct_levy WHERE id = ?').get(one.id);
  assert.equal(row.levied_by, 'Test Admin');
  assert.equal(row.note, 'At the desk');
});

test('a day still to come, or a rule switched off, is refused', async () => {
  const { raw, db } = setup();
  await assert.rejects(levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 1, day: '2999-01-01' } })), /still to come/);
  raw.exec('UPDATE conduct_rule SET active = 0 WHERE id = 3');
  await assert.rejects(levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 3 } })), /not in use/);
});

test('dropped, it stops counting; the month list totals only what stands', async () => {
  const { db } = setup();
  const one = await read(await levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 4 } })));
  await levyConduct(ctxFor(db, { body: { staffId: 2, ruleId: 5 } }));
  await dropConduct(ctxFor(db, { body: { reason: 'It was a gift' } }), String(one.id));
  await assert.rejects(dropConduct(ctxFor(db, { body: {} }), String(one.id)), /Already dropped/);
  const view = await read(await conductOverview(ctxFor(db)));
  assert.equal(view.levies.length, 2);
  assert.deepEqual([view.totals.count, view.totals.amount, view.totals.people], [1, 30, 1]);
  assert.equal(view.levies.find((l) => l.id === one.id).dropped.reason, 'It was a gift');
  assert.ok(view.people.length >= 2, 'an admin gets the people to pick from');
});

test('the person sees their own and can reply; somebody else’s is not theirs', async () => {
  const { db } = setup();
  const one = await read(await levyConduct(ctxFor(db, { body: { staffId: 1, ruleId: 5 } })));
  const mine = await read(await myConduct(ctxFor(db, { role: 'staff', staffId: 1 })));
  assert.equal(mine.levies.length, 1);
  assert.equal((await read(await myConduct(ctxFor(db, { role: 'staff', staffId: 2 })))).levies.length, 0);
  await replyConduct(ctxFor(db, { role: 'staff', staffId: 1, body: { id: one.id, text: 'A guest left it for staff' } }));
  await assert.rejects(replyConduct(ctxFor(db, { role: 'staff', staffId: 2, body: { id: one.id, text: 'x' } })), /No such/);
  const view = await read(await conductOverview(ctxFor(db)));
  assert.equal(view.levies[0].reply.text, 'A guest left it for staff');
  assert.equal(view.totals.replied, 1);
});

test('the list can be changed and added to', async () => {
  const { raw, db } = setup();
  const out = await read(await saveConductRules(ctxFor(db, {
    body: {
      rules: [{ id: 1, name: 'Phone during working hours', amount: 15, doubleRepeat: true },
        { name: 'Smoking where it is not allowed', amount: 20 }],
      notify: false,
    },
  })));
  assert.equal(out.rules.find((r) => r.id === 1).amount, 15);
  assert.ok(out.rules.some((r) => r.name === 'Smoking where it is not allowed'));
  assert.equal(out.notify, false);
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'conduct_notify'").get().value, '0');
});

test('whole deductions onto the bonus, oldest first; the rest waits for salary', () => {
  const split = splitConduct([
    { levyId: 3, day: '2026-11-09', amount: 30 },
    { levyId: 1, day: '2026-11-02', amount: 50 },
    { levyId: 2, day: '2026-11-05', amount: 10 },
  ], 55);
  assert.deepEqual(split.onBonus.map((c) => c.levyId), [1]);
  assert.equal(split.bonusTotal, 50);
  assert.deepEqual(split.toSalary.map((c) => c.levyId).sort(), [2, 3]);
});

test('on a payslip: off the bonus where there is one, off salary where there is none', () => {
  const base = { basic: 1800, ssnit: true, allowances: [], penalties: [], loans: [], rates: ratesFrom({}) };
  const withBonus = { ...base, schemes: [{ name: 'Service', amount: 400, score: 100 }] };
  const conduct = [{ levyId: 1, day: '2026-11-03', amount: 50, name: 'Work things used for personal benefit' },
    { levyId: 2, day: '2026-10-28', amount: 10, name: 'Phone during working hours' }];

  const plain = computeLine(withBonus);
  const docked = computeLine({ ...withBonus, conduct });
  assert.equal(docked.bonus.docked, 60);
  assert.equal(docked.bonus.net, plain.bonus.net - 60);
  assert.equal(docked.conductSalary, 0);
  assert.equal(docked.conduct.onBonus.length, 2);

  const noBonus = computeLine({ ...base, schemes: [] });
  const fromSalary = computeLine({ ...base, schemes: [], conduct });
  assert.equal(fromSalary.conductSalary, 60);
  assert.equal(fromSalary.paye.total, noBonus.paye.total, 'not before tax');
  assert.equal(Math.round((noBonus.net - fromSalary.net) * 100) / 100, 60);
  const { rows, took } = deductionRows(fromSalary, (n) => `GHS ${n}`, fromSalary.rates);
  const row = rows.find((r) => String(r[0]).startsWith('Conduct deductions'));
  assert.equal(row[0], 'Conduct deductions (2)');
  assert.equal(row[1], 'GHS 60');
  assert.match(row[2], /Phone during working hours \(28 Oct\)/);
  assert.ok(Math.abs(took - (fromSalary.ssnit.employee + fromSalary.paye.total + 60)) < 0.01);

  // Never below nothing: what does not fit waits.
  const tiny = computeLine({ ...base, basic: 40, ssnit: false, schemes: [], conduct });
  assert.ok(tiny.net >= 0);
  assert.ok(tiny.conduct.waiting.length >= 1);
});

test('the three messages are notice kinds that can email', () => {
  for (const key of ['conduct.levied', 'conduct.dropped', 'conduct.reply']) {
    const kind = BY_KEY.get(key);
    assert.ok(kind, key);
    assert.ok(kind.ways.includes('email'));
  }
});
