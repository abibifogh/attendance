import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  getRoster, publishRoster, saveRoster, setAvailability,
} from '../src/routes/attendance.js';

/**
 * Saving is thinking out loud; publishing is the promise.
 *
 * The grid draws the difference — dashed until published, solid after — so the
 * flags these tests pin down are exactly what a member of staff reads before
 * planning their week around a shift.
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
  return {
    prepare: (sql) => st(sql),
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_availability; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0, 5, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, tags)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01', '["keyholder"]')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session: PLANNER,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const WINDOW = '?from=2026-06-01&to=2026-06-14';

test('a saved cell is a draft, and publishing turns it solid', async () => {
  const { db, raw } = setup();

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));

  let out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  let cell = out.rows[0].days.find((d) => d.day === '2026-06-02');
  assert.equal(cell.published, false, 'saved is not published — the border is dashed');

  const done = await (await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }))).json();
  assert.equal(done.published, 1);

  out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  cell = out.rows[0].days.find((d) => d.day === '2026-06-02');
  assert.equal(cell.published, true, 'now it is a promise');

  // On the record: what was published, when, by whom.
  const log = raw.prepare('SELECT * FROM rota_publish').get();
  assert.equal(log.changes, 1);
  assert.match(log.actor, /Yaa/);

  // And the bell rang for everybody who can see attendance.
  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'rota.published'").get();
  assert.ok(notice, 'a notice went out');
  assert.equal(notice.audience, 'att_view');
});

test('changing a published day makes it a draft again', async () => {
  const { db } = setup();
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  // The planner moves the shift. Staff planned their lives around the solid
  // version, so the cell cannot change under them while still claiming to be
  // the version they saw.
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: null }] } }));

  const out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  const cell = out.rows[0].days.find((d) => d.day === '2026-06-02');
  assert.equal(cell.published, false, 'dashed again until republished');
});

test('publishing quietly skips the bell, and the log says it was quiet', async () => {
  const { db, raw } = setup();
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));

  const done = await (await publishRoster(ctx(db, {
    body: { from: '2026-06-01', to: '2026-06-14', notify: false },
  }))).json();

  assert.equal(done.published, 1);
  assert.equal(done.notified, false);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM app_notices WHERE kind = 'rota.published'").get().c, 0,
    'nobody was told — that was the point');
  // But quiet is on the record, not invisible: whoever reads the log can see
  // a publication happened and that it chose not to ring.
  assert.match(raw.prepare('SELECT actor FROM rota_publish').get().actor, /quietly/);
});

test('publishing when nothing changed says so instead of ringing the bell', async () => {
  const { db, raw } = setup();
  const done = await (await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }))).json();
  assert.equal(done.published, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM app_notices').get().c, 0,
    'no notice about nothing');
});

test('unavailability shows in the cell, and rostering over it is allowed', async () => {
  const { db } = setup();
  await setAvailability(ctx(db, {
    body: { staffId: 1, days: ['2026-06-04'], status: 'unavailable', note: 'Graduation' },
  }));

  let out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  let cell = out.rows[0].days.find((d) => d.day === '2026-06-04');
  assert.equal(cell.availability.status, 'unavailable');
  assert.equal(cell.availability.note, 'Graduation');

  // The planner rosters them anyway — a deliberate conflict, and the grid
  // shows both rather than pretending it cannot happen.
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-04', shiftId: 1 }] } }));
  out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  cell = out.rows[0].days.find((d) => d.day === '2026-06-04');
  assert.equal(cell.shift_id, 1);
  assert.equal(cell.availability.status, 'unavailable', 'the mark stays put');

  // Taking the mark off.
  await setAvailability(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], clear: true } }));
  out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.equal(out.rows[0].days.find((d) => d.day === '2026-06-04').availability, null);
});

test('tags travel with the row, and the roster names every tag in use', async () => {
  const { db } = setup();
  const out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.deepEqual(out.rows[0].staff.tags, ['keyholder']);
  assert.deepEqual(out.tags, ['keyholder']);
});
