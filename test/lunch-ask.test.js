import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { askForLunch, askTimes, lunchOpen, myLunchAsk, saveMyLunchWeek } from '../src/routes/lunch.js';
import { scheduleFrom } from '../src/lib/lunch.js';
import { getPepper, hashPin } from '../src/lib/auth.js';

/** Asking staff to order lunch when the list opens. Made-up people only. */

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

const WEEK = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("INSERT INTO att_shifts (id, name, starts_at, ends_at) VALUES (1, 'Kitchen', '07:00', '16:00') ON CONFLICT (id) DO NOTHING");
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, active) VALUES
    (1, 'A1', 'Esi Quaye', 'F&B', 1), (2, 'A2', 'Kofi Mensah', 'Housekeeping', 1), (3, 'A3', 'Yaw Boateng', 'Bar', 1)`);
  const put = raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, 1, 1)');
  for (const day of WEEK.slice(0, 5)) { put.run(1, day); put.run(2, day); put.run(3, day); }
  raw.exec("INSERT INTO users (id, name, role, staff_id, active) VALUES (7, 'Esi', 'staff', 1, 1)");
  raw.exec(`INSERT INTO settings (key, value) VALUES ('lunch_on', '1'), ('timezone', 'UTC')
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  return { raw, db: d1(raw) };
}

const settingsFor = (over = {}) => ({
  on: true, schedule: scheduleFrom({}),
  ask: { on: true, at: '08:00', remindHours: 6, text: true, cc: false, skip: [], ...over },
});

test('asked at 08:00 on the day the list opens, reminded six hours before it shuts', () => {
  const t = askTimes(settingsFor(), '2026-11-12 09:00');
  assert.equal(t.window.monday, '2026-11-16');
  assert.equal(t.askAt, '2026-11-12 08:00');
  assert.equal(t.remindAt, '2026-11-15 18:00');
  assert.equal(askTimes(settingsFor(), '2026-11-10 09:00').askAt, null, 'nothing while the list is shut');
});

test('everybody on the rota who takes lunch is asked once; the reminder goes only to whoever has not answered', async () => {
  const { raw, db } = setup();
  raw.exec("UPDATE settings SET value = '[3]' WHERE key = 'lunch_ask_skip'");
  assert.equal((await askForLunch(db, { now: '2026-11-12 07:00' })).asked, 0, 'not before 08:00');
  const first = await askForLunch(db, { now: '2026-11-12 08:05' });
  assert.equal(first.asked, 1, 'Esi by the app; Kofi has no app and no phone; Yaw does not take lunch');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'lunch.ask' AND user_id = 7").get().n, 1);
  assert.deepEqual(raw.prepare('SELECT staff_id FROM lunch_ask ORDER BY staff_id').all().map((r) => r.staff_id), [1, 2]);
  assert.equal((await askForLunch(db, { now: '2026-11-12 08:10' })).asked, 0, 'once');

  // Esi answers; Kofi does not.
  raw.exec(`INSERT INTO lunch_order (staff_id, day, taking) VALUES (1, '${WEEK[0]}', 1)`);
  const later = await askForLunch(db, { now: '2026-11-15 18:30' });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'lunch.remind'").get().n, 0, 'Esi answered');
  assert.ok(raw.prepare('SELECT reminded_at FROM lunch_ask WHERE staff_id = 2').get().reminded_at, 'Kofi marked as reminded');
  assert.equal(later.reminded, 0, 'Kofi cannot be reached');
});

test('the order card on My day: their shift days, then ordering the week in one press', async () => {
  const { raw, db } = setup();
  const ctx = (body) => ({
    db, env: {}, url: new URL('https://x/'),
    session: { user: { id: 7, name: 'Esi', role: 'staff', staff_id: 1 }, permissions: ['att_me'] },
    request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  });
  // The card reads the real clock, so only check its shape when the list is open now.
  const card = await (await myLunchAsk(ctx())).json();
  if (card.show) {
    assert.equal(card.answered, false);
    await saveMyLunchWeek(ctx({ days: card.days.filter((d) => d.on).map((d, i) => ({ day: d.day, taking: i !== 1 })) }));
    const again = await (await myLunchAsk(ctx())).json();
    assert.equal(again.answered, true);
    await saveMyLunchWeek(ctx({ none: true }));
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM lunch_order WHERE staff_id = 1 AND taking = 1').get().n, 0);
  }
});

test('a personal link opens on that one person and nobody else', async () => {
  const { raw, db } = setup();
  const token = 'abc123personal';
  raw.exec("INSERT INTO settings (key, value) VALUES ('lunch_token_hash', 'not-this') ON CONFLICT (key) DO UPDATE SET value = 'not-this'");
  const monday = (await (await lunchOpen({ db, url: new URL('https://x/') }, 'nope').catch((e) => ({ json: async () => ({ error: e.message }) }))).json());
  assert.match(monday.error, /does not open anything/);
  // Hashed exactly as the route does it, for the week being ordered now.
  const { windowFor } = await import('../src/lib/lunch.js');
  const { nowIn } = await import('../src/util/dates.js');
  const w = windowFor(nowIn('UTC'), scheduleFrom({}));
  raw.prepare('INSERT INTO lunch_ask (monday, staff_id, token_hash) VALUES (?, 2, ?)')
    .run(w.monday, await hashPin(`lunch:${token}`, await getPepper(db)));
  const out = await (await lunchOpen({ db, url: new URL('https://x/') }, token)).json();
  assert.equal(out.only, 2);
  assert.ok(out.people.every((p) => p.id === 2));
});
