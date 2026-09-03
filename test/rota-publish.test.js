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

/** A login against Kofi's name, because a person with none cannot be told. */
function giveKofiALogin(raw, id = 7) {
  raw.prepare(
    `INSERT INTO users (id, name, role, active, staff_id)
     VALUES (?, 'Kofi', 'staff', 1, 1)`,
  ).run(id);
  return id;
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
  const kofi = giveKofiALogin(raw);

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

  // And the bell rang for the one person it was about.
  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'rota.published.mine'").get();
  assert.ok(notice, 'a notice went out');
  assert.equal(notice.user_id, kofi, 'to him, not to the whole house');
  assert.equal(notice.audience, null);
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
    body: { from: '2026-06-01', to: '2026-06-14', notify: 'none' },
  }))).json();

  assert.equal(done.published, 1);
  assert.equal(done.notified, 'none');
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM app_notices').get().c, 0,
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

test('a new day and a changed one are counted apart', async () => {
  const { db } = setup();

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  // One promise being remade, one nobody has heard about yet.
  await saveRoster(ctx(db, {
    body: {
      entries: [
        { staffId: 1, day: '2026-06-02', shiftId: 1, note: 'moved' },
        { staffId: 1, day: '2026-06-03', shiftId: 1 },
      ],
    },
  }));

  const out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.deepEqual(out.publish, { fresh: 1, again: 1 });

  const done = await (await publishRoster(ctx(db, {
    body: { from: '2026-06-01', to: '2026-06-14' },
  }))).json();
  assert.equal(done.fresh, 1);
  assert.equal(done.again, 1);
  assert.equal(done.published, 2);

  const after = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.deepEqual(after.publish, { fresh: 0, again: 0 });
});

test('a day carries an optional title of its own', async () => {
  const { db } = setup();
  await saveRoster(ctx(db, {
    body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1, title: 'Stock take' }] },
  }));

  const out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  const cell = out.rows[0].days.find((d) => d.day === '2026-06-02');
  assert.equal(cell.title, 'Stock take');

  // Cleared by saving it away again, like any other field on the cell.
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  const back = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.equal(back.rows[0].days.find((d) => d.day === '2026-06-02').title, null);
});

test('telling everybody and telling the people it is about are different', async () => {
  const { db, raw } = setup();
  const kofi = giveKofiALogin(raw);

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, {
    body: { from: '2026-06-01', to: '2026-06-14', notify: 'staff', message: 'Easter cover.' },
  }));

  // The people it affects, and nobody else: there is no house announcement at
  // all, only Kofi's own.
  const mine = raw.prepare("SELECT * FROM app_notices WHERE kind = 'rota.published.mine'").get();
  assert.equal(mine.user_id, kofi);
  assert.match(mine.body, /Easter cover/);
  assert.equal(
    raw.prepare("SELECT COUNT(*) c FROM app_notices WHERE kind = 'rota.published'").get().c, 0,
    'nothing went to the house',
  );

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-04', shiftId: 1 }] } }));
  await publishRoster(ctx(db, {
    body: { from: '2026-06-01', to: '2026-06-14', notify: 'everyone' },
  }));

  const all = raw.prepare(
    "SELECT * FROM app_notices WHERE kind = 'rota.published' ORDER BY id DESC",
  ).get();
  assert.equal(all.audience, null, 'everybody means everybody');
  assert.equal(
    raw.prepare("SELECT COUNT(*) c FROM app_notices WHERE kind = 'rota.published.mine'").get().c, 2,
    'and Kofi still hears about his own day',
  );
});

test('each person hears about their own week and nobody else hears about it', async () => {
  const { db, raw } = setup();
  const kofi = giveKofiALogin(raw);
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (2, '2', 'Ama', 'Kitchen', '2020-01-01'),
            (3, '3', 'Yaw', 'Kitchen', '2020-01-01')`,
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, active, staff_id) VALUES (8, 'Ama', 'staff', 1, 2)",
  ).run();

  await saveRoster(ctx(db, { body: { entries: [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 1, day: '2026-06-03', shiftId: 1 },
    // Yaw is on the rota and has no login. Nothing can reach him.
    { staffId: 3, day: '2026-06-05', shiftId: 1 },
  ] } }));

  const done = await (await publishRoster(ctx(db, {
    body: { from: '2026-06-01', to: '2026-06-14', notify: 'staff' },
  }))).json();

  assert.equal(done.told, 1, 'Kofi and Yaw are on it; only Kofi can be reached');
  assert.equal(done.noLogin, 1, 'and the planner is told that Yaw was not');

  const sent = raw.prepare(
    "SELECT * FROM app_notices WHERE kind = 'rota.published.mine' ORDER BY id",
  ).all();
  assert.equal(sent.length, 1, 'Ama has nothing this fortnight and hears nothing');
  assert.equal(sent[0].user_id, kofi);
  assert.match(sent[0].title, /2 shifts/);
  assert.match(sent[0].body, /Tue 2 Jun/, 'and it says when the first one is');
});

test('a day being remade says so, because somebody planned around the old one', async () => {
  const { db, raw } = setup();
  giveKofiALogin(raw);

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: null }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  const last = raw.prepare(
    "SELECT * FROM app_notices WHERE kind = 'rota.published.mine' ORDER BY id DESC",
  ).get();
  assert.match(last.body, /change to what you were told/);
  assert.equal(last.level, 'warn', 'louder than a new day, which is only news');
});

// ---------------------------------------------------------------------------
// A day put back the way it was published
// ---------------------------------------------------------------------------

/**
 * `published` used to be cleared by every write, on the reasoning that a day
 * being changed is a draft again. True, and it was applied to writes where
 * nothing had moved. Take a shift off somebody, think better of it, put it
 * back where it was, and the rota is exactly what staff were sent while the
 * Publish button asks for a change nobody made. The only way to clear that was
 * to publish the week again, which sends everybody a notice about a rota that
 * has not moved.
 *
 * The flag cannot answer this on its own because it does not know what was
 * published. `published_as` does: the shape of the row at the moment it went
 * out, and a write that comes to the same shape stays published.
 */
const state = (raw, day = '2026-06-02') => raw
  .prepare('SELECT staff_id, shift_id, published, ever_published FROM att_roster WHERE day = ?')
  .all(day);

/** Somebody to move a shift to, and another shift to move to. */
const alsoThere = (raw) => {
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (2, '2', 'Ama', 'Kitchen', '2020-01-01')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (2, 'Evening', '14:00', '22:00', 0, 5)`,
  ).run();
};

test('moving a shift to somebody else and back needs no publish', async () => {
  const { db, raw } = setup();
  alsoThere(raw);
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  const { id } = raw.prepare('SELECT id FROM att_roster WHERE day = ?').get('2026-06-02');

  await saveRoster(ctx(db, { body: { entries: [{ id, day: '2026-06-02', staffId: 2, shiftId: 1 }] } }));
  let out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.deepEqual(out.publish, { fresh: 0, again: 1 }, 'moved, so it does need publishing');

  await saveRoster(ctx(db, { body: { entries: [{ id, day: '2026-06-02', staffId: 1, shiftId: 1 }] } }));
  out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.deepEqual(out.publish, { fresh: 0, again: 0 }, 'and back, so it does not');
  assert.equal(state(raw)[0].published, 1);
});

test('changing a shift and changing it back needs no publish either', async () => {
  const { db, raw } = setup();
  alsoThere(raw);
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 2 }] } }));
  assert.equal(state(raw)[0].published, 0, 'a different shift is a change');

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  assert.equal(state(raw)[0].published, 1, 'the one that was published is not');
});

test('saving a day that says exactly what it already said writes nothing', async () => {
  const { db, raw } = setup();
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  const before = raw.prepare('SELECT id, set_at FROM att_roster WHERE day = ?').get('2026-06-02');
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  const after = raw.prepare('SELECT id, set_at, published FROM att_roster WHERE day = ?').get('2026-06-02');

  assert.equal(after.id, before.id);
  assert.equal(after.set_at, before.set_at, 'the trail does not say somebody touched it');
  assert.equal(after.published, 1);
});

test('a real change still needs publishing, and says which kind', async () => {
  const { db, raw } = setup();
  alsoThere(raw);
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  await saveRoster(ctx(db, {
    body: {
      entries: [
        { staffId: 1, day: '2026-06-02', shiftId: 2 },
        { staffId: 2, day: '2026-06-03', shiftId: 1 },
      ],
    },
  }));

  const out = await (await getRoster(ctx(db, { query: WINDOW }))).json();
  assert.deepEqual(out.publish, { fresh: 1, again: 1 });
});

test('a day published, changed, published again and put back is a change again', async () => {
  // Because what it goes back to is the second thing published, not the first.
  const { db, raw } = setup();
  alsoThere(raw);
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));
  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 2 }] } }));
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-14' } }));

  await saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: '2026-06-02', shiftId: 1 }] } }));
  assert.equal(state(raw)[0].published, 0,
    'staff were last told the second shift, so going back to the first is news');
});
