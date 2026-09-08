import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { myWeek } from '../src/routes/me.js';

/**
 * The week on somebody's own screen, and the buttons that move it.
 *
 * It used to be the next seven days from today. So on a Thursday the card
 * headed "Mon 8 to Sun 14" listed Thursday to Wednesday, and Prev week walked
 * backwards through a window that never lined up with a week anybody thinks
 * in. Somebody asking what they were on this week got the back half of it.
 *
 * And it used to move on two chevrons. A ‹ and a › either side of a date range
 * read as decoration until somebody presses one to find out which way it goes,
 * which on the screen most of the property opens is the wrong way round.
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
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    'INSERT INTO att_staff (id, employee_no, name, department, hired_on) '
    + "VALUES (1, '1', 'Ama', 'Housekeeping', '2020-01-01')",
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, active, staff_id) VALUES (5, 'Ama', 'staff', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const AMA = { user: { id: 5, name: 'Ama', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };

const ctx = (db, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/shifts${query}`),
  session: AMA,
  executionContext: null,
  request: new Request('https://x/'),
});

const read = async (res) => JSON.parse(await res.text());

/** The weekday of a date, Monday being 1. */
const dow = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

test('the window starts on a Monday, whatever day is asked for', async () => {
  const { db } = setup();
  // A Thursday, a Sunday and a Monday all land on the same Monday.
  for (const [asked, monday] of [
    ['2099-09-10', '2099-09-07'],
    ['2099-09-13', '2099-09-07'],
    ['2099-09-07', '2099-09-07'],
  ]) {
    const out = await read(await myWeek(ctx(db, `?from=${asked}`)));
    assert.equal(out.from, monday, asked);
    assert.equal(dow(out.from), 1, 'a Monday');
  }
});

test('and the week it names is all seven of its days', async () => {
  const { db } = setup();
  const out = await read(await myWeek(ctx(db, '?from=2099-09-10')));
  const week = out.days.filter((d) => d.day >= '2099-09-07' && d.day <= '2099-09-13');
  assert.equal(week.length, 7);
  assert.equal(week[0].day, '2099-09-07', 'the Monday is in it, not skipped for being past');
  assert.equal(week[6].day, '2099-09-13');
});

test('a week that has already gone is still a whole week', async () => {
  const { db } = setup();
  // Every day of it is behind us, which is exactly the case the old "next
  // seven days from today" could not show at all.
  const out = await read(await myWeek(ctx(db, '?from=2020-03-09')));
  assert.equal(out.from, '2020-03-09');
  const week = out.days.filter((d) => d.day >= '2020-03-09' && d.day <= '2020-03-15');
  assert.equal(week.length, 7);
});

test('the screen slices the week it names, not seven days from today', () => {
  const view = readFileSync('public/js/views/att-me.js', 'utf8');
  assert.match(view, /const weekEnd = shiftDay\(data\.from, 6\)/);
  assert.match(view, /d\.day >= data\.from && d\.day <= weekEnd/);
  // The old shape, which quietly cut the front off the week.
  assert.equal(/upcoming\.slice\(0, 7\)/.test(view), false);
});

test('the buttons say which way they go', () => {
  const view = readFileSync('public/js/views/att-me.js', 'utf8');
  // Both cards on the screen: their own week, and their department's.
  assert.equal((view.match(/Prev week'\)/g) ?? []).length, 2);
  assert.equal((view.match(/Next week \\u203a'\)/g) ?? []).length, 2);
  // And the chevrons on their own are gone from both.
  assert.equal(/}, '‹'\)/.test(view), false);
  assert.equal(/}, '›'\)/.test(view), false);
});

test('the way back to this week is only offered when you have left it', () => {
  const view = readFileSync('public/js/views/att-me.js', 'utf8');
  // A button that takes you where you already are is a button that teaches
  // people the row is decoration.
  assert.match(view, /onThisWeek \? null : h\('button\.btn-sm'/);
});
