import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster } from '../src/routes/attendance.js';
import { myDepartment, myWeek } from '../src/routes/me.js';
import { ROLES, allows, effectivePermissions } from '../src/lib/permissions.js';

/**
 * A public holiday is a planner's fact, and only a planner's.
 *
 * The kitchen still has to cook on the sixth of March, so somebody has to be
 * asked to come in, and whoever is filling the column needs to know which day
 * they are asking about before they ask. It was on the grid as a tooltip on a
 * dropdown, which is to say it was not on the grid.
 *
 * It stays off every screen a member of staff opens, and that is the older
 * decision rather than a new one: on their own week a holiday beside a shift
 * reads as an offer — that the day is theirs, or that it is worth more — and
 * neither is a promise this screen may make. What a holiday does to their
 * month is arithmetic, and it is settled at sign-off and shown on their report
 * where the arithmetic is.
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

const FROM = '2099-09-07';
const HOLIDAY = '2099-09-09';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM att_holidays; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (1, 'AM Shift', '06:00', '14:00', 0, 'Reception')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, sees_dept_rota)
     VALUES (1, '1', 'Destiny', 'Reception', '2020-01-01', 1)`,
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, staff_id, active) VALUES (7, 'Destiny', 'staff', 1, 1)",
  ).run();
  raw.prepare(
    "INSERT INTO att_holidays (day, name, active) VALUES (?, 'Farmers'' Day', 1)",
  ).run(HOLIDAY);
  raw.prepare(
    'INSERT INTO att_roster (staff_id, day, shift_id, published, ever_published) VALUES (1, ?, 1, 1, 1)',
  ).run(HOLIDAY);
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 9, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const READER = { user: { id: 8, name: 'Efua', role: 'rota_reader' }, permissions: ['att_rota_view'] };
const DESTINY = { user: { id: 7, name: 'Destiny', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };

const ctx = (db, session, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/x${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/'),
});

const rota = async (db, who) => (await getRoster(ctx(db, who, `?from=${FROM}&to=2099-09-20`))).json();

// ---------------------------------------------------------------------------
// On the planner's grid
// ---------------------------------------------------------------------------

test('the grid is told which day it is and what it is called', async () => {
  const { db } = setup();
  const data = await rota(db, PLANNER);
  const day = data.coverage.find((c) => c.day === HOLIDAY);
  assert.equal(day.holiday, "Farmers' Day");
  assert.equal(data.coverage.filter((c) => c.holiday).length, 1, 'and no other day is one');
});

test('a reader of the rota is told too, because a reader is not a member of staff', async () => {
  // A head of department, an owner, whoever answers the phone on a Saturday.
  const { db } = setup();
  const data = await rota(db, READER);
  assert.equal(data.coverage.find((c) => c.day === HOLIDAY).holiday, "Farmers' Day");
});

test('the day is named in the header and tinted down the column', () => {
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  assert.match(view, /const holidayOn = new Map\(\(data\.coverage \?\? \[\]\)/);
  assert.match(view, /holidayOn\.has\(day\) \? 'rota-holiday' : ''/);
  assert.match(view, /rota-holiday-name/);
  // Both ways of reading the grid, not only the one somebody happened to open.
  assert.equal((view.match(/holidayMark\(day\)/g) ?? []).length, 2, 'drawn on both ways of reading the grid');

  const css = readFileSync('public/styles.css', 'utf8');
  assert.match(css, /\.rota-table th\.rota-holiday,\n\s*\.rota-table td\.rota-holiday \{/);
  assert.match(css, /\.rota-holiday-name \{/);
  // Squeezed to a fortnight the column has no room for a name.
  assert.match(css, /\.rota-table\.rota-tight \.rota-holiday-name,/);
});

// ---------------------------------------------------------------------------
// And nowhere a member of staff looks
// ---------------------------------------------------------------------------

test('their own week is never told', async () => {
  const { db } = setup();
  const out = await (await myWeek(ctx(db, DESTINY, `?from=${FROM}`))).json();
  assert.equal(JSON.stringify(out.days).includes('Farmers'), false);
  assert.equal(JSON.stringify(out.days).includes('holiday'), false);
});

test('nor their department’s rota', async () => {
  const { db } = setup();
  const out = await (await myDepartment(ctx(db, DESTINY, `?from=${FROM}`))).json();
  assert.equal(JSON.stringify(out).includes('Farmers'), false);
});

test('and a member of staff cannot open the grid that is told', () => {
  // Nothing has to enforce it in the drawing: the rota screen is behind the
  // two rota permissions and the staff role holds neither.
  const held = effectivePermissions({ role: 'staff', staff_id: 1 });
  assert.equal(allows('att_rota', held), false);
  assert.equal(allows('att_rota_view', held), false);
  assert.deepEqual(held, ['att_me'], 'one permission, and it is their own');
  // And no role that reaches the grid is the one a member of staff is given.
  const reaches = ROLES.filter((r) => allows('att_rota', effectivePermissions({ role: r.key }))
    || allows('att_rota_view', effectivePermissions({ role: r.key })));
  assert.equal(reaches.some((r) => r.key === 'staff'), false);
});
