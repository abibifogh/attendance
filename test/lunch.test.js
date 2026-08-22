import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  daysFor, first, openDaysFrom, summarise, unanswered, weekDays, windowFor,
} from '../src/lib/lunch.js';

/**
 * The weekly lunch list.
 *
 * Nearly everything that can go wrong here is a calendar mistake, and a
 * calendar mistake means the kitchen cooks for the wrong week. So the window
 * is tested against fixed dates rather than against whatever day the suite is
 * run on: 2026-08-20 is a Thursday, and the week it orders for begins Monday
 * 2026-08-24.
 */

const THU = '2026-08-20';
const FRI = '2026-08-21';
const SUN = '2026-08-23';
const MON = '2026-08-24';
const WED = '2026-08-26';

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('Thursday through Sunday all order for the same Monday', () => {
  for (const day of [THU, FRI, '2026-08-22', SUN]) {
    const w = windowFor(day);
    assert.equal(w.open, true, day);
    assert.equal(w.monday, MON, `${day} points at the same week`);
  }
});

test('the rest of the week is shut, and says when it opens', () => {
  for (const day of [MON, '2026-08-25', WED]) {
    const w = windowFor(day);
    assert.equal(w.open, false, day);
  }

  const monday = windowFor(MON);
  assert.equal(monday.opensOn, '2026-08-27', 'the Thursday of this week');
  // Shut, and still able to say which week it will be for. A page that only
  // says "come back later" is one somebody comes back to at the wrong time.
  assert.equal(monday.monday, '2026-08-31');
});

test('an open window says the last day answers are taken', () => {
  assert.equal(windowFor(THU).closesAfter, SUN);
  assert.equal(windowFor(SUN).closesAfter, SUN, 'the last day of the run is itself');
});

test('the week is Monday to Sunday, seven days', () => {
  const w = windowFor(THU);
  assert.equal(w.days.length, 7);
  assert.deepEqual(w.days, weekDays(MON));
  assert.equal(w.days[0], MON);
  assert.equal(w.days[6], '2026-08-30');
});

test('a property that orders on other days says so', () => {
  // Somebody ordering on a Monday and a Tuesday for the week after.
  const w = windowFor(MON, { openDays: [1, 2] });
  assert.equal(w.open, true);
  assert.equal(w.monday, '2026-08-31');
  assert.equal(w.closesAfter, '2026-08-25');
  assert.equal(windowFor(THU, { openDays: [1, 2] }).open, false);
});

test('nonsense open days fall back to Thursday through Sunday', () => {
  assert.deepEqual(openDaysFrom('4,5,6,7'), [4, 5, 6, 7]);
  assert.deepEqual(openDaysFrom(''), [4, 5, 6, 7]);
  assert.deepEqual(openDaysFrom('0,9,fish'), [4, 5, 6, 7]);
  assert.deepEqual(openDaysFrom('3,3,1'), [1, 3], 'and duplicates collapse');
});

// ---------------------------------------------------------------------------
// One person's page
// ---------------------------------------------------------------------------

const WEEK = weekDays(MON);
const MENU = new Map([
  [MON, { meal: 'Jollof and chicken' }],
  ['2026-08-25', { meal: 'Banku and tilapia', note: 'Pepper on the side' }],
  ['2026-08-27', { meal: 'Waakye' }],
]);

test('somebody is only asked about days they are down to work', () => {
  const days = daysFor({
    week: WEEK,
    rostered: [MON, '2026-08-25', '2026-08-27'],
    menu: MENU,
  });

  assert.deepEqual(days.map((d) => d.name), ['Monday', 'Tuesday', 'Thursday']);
  assert.equal(days[0].meal, 'Jollof and chicken');
  assert.equal(days[1].note, 'Pepper on the side');
  assert.equal(days[2].meal, 'Waakye');
});

test('a day with no menu yet is still offered, without a meal against it', () => {
  const [day] = daysFor({ week: WEEK, rostered: ['2026-08-26'], menu: MENU });
  assert.equal(day.name, 'Wednesday');
  assert.equal(day.meal, null);
});

test('not having said is not the same as having said no', () => {
  const days = daysFor({
    week: WEEK,
    rostered: [MON, '2026-08-25', '2026-08-27'],
    menu: MENU,
    answers: new Map([[MON, true], ['2026-08-25', false]]),
  });

  assert.equal(days[0].taking, true);
  assert.equal(days[1].taking, false);
  assert.equal(days[2].taking, null, 'and this is the one worth chasing');
});

test('a rostered day outside the week is not offered', () => {
  const days = daysFor({ week: WEEK, rostered: ['2026-08-23', '2026-09-07'], menu: MENU });
  assert.deepEqual(days, []);
});

// ---------------------------------------------------------------------------
// The week, as the kitchen reads it
// ---------------------------------------------------------------------------

const STAFF = [
  { id: 1, name: 'Kwame Mensah' },
  { id: 2, name: 'Ama Boateng' },
  { id: 3, name: 'Yaa Asantewaa Darko' },
];

test('a day lists first names and counts the plates', () => {
  const out = summarise({
    week: WEEK,
    menu: MENU,
    staff: STAFF,
    orders: [
      { staff_id: 1, day: MON, taking: 1 },
      { staff_id: 2, day: MON, taking: 1 },
      { staff_id: 3, day: MON, taking: 0 },
      { staff_id: 1, day: '2026-08-25', taking: 1 },
    ],
  });

  const monday = out.columns[0];
  assert.equal(monday.short, 'Mon');
  assert.equal(monday.meal, 'Jollof and chicken');
  assert.deepEqual(monday.names, ['Ama', 'Kwame'], 'first names, in order');
  assert.equal(monday.heads, 2, 'and the person who said no is not one of them');

  assert.equal(out.columns[1].heads, 1);
  assert.equal(out.columns[6].heads, 0, 'a day nobody answered for is nought, not blank');
});

test('the week counts plates rather than people', () => {
  const out = summarise({
    week: WEEK,
    staff: STAFF,
    orders: WEEK.slice(0, 5).map((day) => ({ staff_id: 1, day, taking: 1 })),
  });

  assert.equal(out.plates, 5, 'one person in five days is five lunches');
  assert.equal(out.columns.length, 7);
});

test('the busiest day is the one the kitchen plans around', () => {
  const out = summarise({
    week: WEEK,
    staff: STAFF,
    orders: [
      { staff_id: 1, day: MON, taking: 1 },
      { staff_id: 1, day: WED, taking: 1 },
      { staff_id: 2, day: WED, taking: 1 },
      { staff_id: 3, day: WED, taking: 1 },
    ],
  });
  assert.equal(out.busiest.day, WED);
  assert.equal(out.busiest.heads, 3);
});

test('an order for somebody who has left is not counted', () => {
  const out = summarise({
    week: WEEK,
    staff: STAFF,
    orders: [{ staff_id: 1, day: MON, taking: 1 }, { staff_id: 99, day: MON, taking: 1 }],
  });
  assert.deepEqual(out.columns[0].names, ['Kwame']);
});

test('a first name is the first word of it', () => {
  assert.equal(first('Yaa Asantewaa Darko'), 'Yaa');
  assert.equal(first('  Kofi  '), 'Kofi');
  assert.equal(first(null), '');
});

// ---------------------------------------------------------------------------
// Who has not said
// ---------------------------------------------------------------------------

test('the chase list is people down to work who have not answered', () => {
  const out = unanswered({
    week: WEEK,
    staff: STAFF,
    rosteredBy: new Map([
      [1, [MON, WED]],
      [2, [MON]],
      [3, [MON, WED, '2026-08-28']],
    ]),
    orders: [
      { staff_id: 1, day: MON, taking: 1 },
      // Saying no still counts as having said.
      { staff_id: 2, day: MON, taking: 0 },
    ],
  });

  // Most days outstanding first, because that is the order somebody chases in.
  assert.deepEqual(out.map((p) => [p.name, p.days.length]), [
    ['Yaa Asantewaa Darko', 3],
    ['Kwame Mensah', 1],
  ]);
  assert.equal(out.find((p) => p.name === 'Ama Boateng'), undefined);
});

// ---------------------------------------------------------------------------
// The routes, against a real database
//
// The pure logic above proves the calendar. What is left to prove is the door:
// that the token has to be right, that a shut list refuses answers, and that
// nobody can put themselves down for a day they are not working.
// ---------------------------------------------------------------------------

function d1(raw) {
  const statement = (sql, binds = []) => ({
    bind(...a) { return statement(sql, a); },
    async all() { return { results: raw.prepare(sql).all(...binds) }; },
    async first() { return raw.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = raw.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

/**
 * A property with two people on it, a week of shifts, and the clock held at a
 * Thursday so the window is open.
 *
 * Henry works Monday to Wednesday and it is published. Ama is down for
 * Thursday but the planner has not published it, so as far as the kitchen is
 * concerned she is not working that day.
 */
function property() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_roster; DELETE FROM att_staff; DELETE FROM att_shifts;');
  raw.prepare("INSERT INTO settings (key, value) VALUES ('timezone', 'UTC') "
    + 'ON CONFLICT (key) DO UPDATE SET value = excluded.value').run();

  raw.prepare(
    "INSERT INTO att_shifts (id, name, starts_at, ends_at) VALUES (1, 'Day', '08:00', '17:00')",
  ).run();
  for (const [id, no, name] of [[1, '1001', 'Henry Aryee'], [2, '1002', 'Ama Serwaa']]) {
    raw.prepare(
      'INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, \'2020-01-01\')',
    ).run(id, no, name);
  }
  const put = (staffId, day, published) => raw.prepare(
    'INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, 1, ?)',
  ).run(staffId, day, published);
  put(1, MON, 1);
  put(1, '2026-08-25', 1);
  put(1, WED, 1);
  put(2, '2026-08-27', 0);

  return { raw, db: d1(raw) };
}

const ctxFor = (db, path, body) => ({
  db,
  url: new URL(`https://staff.example.test${path}`),
  session: { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['lunch'] },
  request: new Request(`https://staff.example.test${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
});

// The clock. The window is worked out from the real date, so the tests that
// need a Thursday say so rather than hoping.
function atDay(day, run) {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a) { return a.length ? new Real(...a) : new Real(`${day}T09:00:00Z`); }
    static now() { return new Real(`${day}T09:00:00Z`).getTime(); }
  };
  return Promise.resolve().then(run).finally(() => { globalThis.Date = Real; });
}

test('a link that is not the link opens nothing', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');

  const made = await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json();
  const token = made.url.split('/lunch/')[1];
  assert.match(token, /^[0-9a-f]{36}$/);

  await atDay(THU, async () => {
    const ok = await lunch.lunchOpen(ctxFor(db, `/api/l/${token}`), token);
    assert.equal(ok.status, 200);

    await assert.rejects(
      () => lunch.lunchOpen(ctxFor(db, '/api/l/x'), 'f'.repeat(36)),
      /does not open anything/,
    );
  });
});

test('making a new link retires the old one', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');

  const first = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];
  const second = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];
  assert.notEqual(first, second);

  await atDay(THU, async () => {
    assert.equal((await lunch.lunchOpen(ctxFor(db, '/x'), second)).status, 200);
    await assert.rejects(() => lunch.lunchOpen(ctxFor(db, '/x'), first), /does not open/);
  });
});

test('closing the list shuts the link without losing what was said', async () => {
  const { db, raw } = property();
  const lunch = await import('../src/routes/lunch.js');
  const token = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];

  await atDay(THU, async () => {
    await lunch.lunchSay(
      ctxFor(db, `/api/l/${token}/me/1`, { days: [{ day: MON, taking: true }] }), token, '1',
    );
  });

  await lunch.closeLink(ctxFor(db, '/api/lunch/close', {}));

  await atDay(THU, async () => {
    await assert.rejects(() => lunch.lunchOpen(ctxFor(db, '/x'), token), /not open at the moment/);
  });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM lunch_order').get().n, 1);
});

test('the list refuses answers on a day it is not open', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');
  const token = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];

  // Wednesday. The page still opens — somebody should be able to look at what
  // is coming — but it will not take an answer.
  await atDay('2026-08-19', async () => {
    const look = await (await lunch.lunchOpen(ctxFor(db, '/x'), token)).json();
    assert.equal(look.open, false);
    assert.equal(look.opensOn, THU);

    await assert.rejects(
      () => lunch.lunchSay(ctxFor(db, '/x', { days: [{ day: MON, taking: true }] }), token, '1'),
      /shut. It opens again on Thursday/,
    );
  });
});

test('a day somebody is not down to work is ignored', async () => {
  const { db, raw } = property();
  const lunch = await import('../src/routes/lunch.js');
  const token = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];

  await atDay(THU, async () => {
    const out = await (await lunch.lunchSay(ctxFor(db, '/x', {
      days: [
        { day: MON, taking: true },
        // Henry is not on the rota for Friday, so this is a plate nobody
        // ordered and the kitchen would have cooked it.
        { day: '2026-08-28', taking: true },
      ],
    }), token, '1')).json();

    assert.equal(out.saved, 1);
  });

  const rows = raw.prepare('SELECT day FROM lunch_order ORDER BY day').all();
  assert.deepEqual(rows.map((r) => r.day), [MON]);
});

test('an unpublished day is not a day to cook for', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');
  const token = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];

  await atDay(THU, async () => {
    // Ama's only day that week is pencilled in, so she is not offered anything
    // and does not appear on the list of names to find yourself in.
    const look = await (await lunch.lunchOpen(ctxFor(db, '/x'), token)).json();
    assert.deepEqual(look.people.map((p) => p.first), ['Henry']);

    const mine = await (await lunch.lunchMine(ctxFor(db, '/x'), token, '2')).json();
    assert.deepEqual(mine.days, []);
  });
});

test('the kitchen counts plates, not the people who said yes', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');
  const token = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];

  await atDay(THU, async () => {
    await lunch.setMenu(ctxFor(db, '/api/lunch/menu', {
      days: [{ day: MON, meal: 'Jollof and chicken' }, { day: WED, meal: 'Waakye' }],
    }));
    await lunch.lunchSay(ctxFor(db, '/x', {
      days: [
        { day: MON, taking: true },
        { day: '2026-08-25', taking: false },
        { day: WED, taking: true },
      ],
    }), token, '1');

    const week = await (await lunch.lunchWeek(ctxFor(db, '/api/lunch'))).json();
    assert.equal(week.monday, MON);
    assert.equal(week.summary.plates, 2);
    assert.deepEqual(week.summary.columns[0].names, ['Henry']);
    assert.equal(week.summary.columns[0].meal, 'Jollof and chicken');
    // Tuesday: he said no, so nobody is down and it is not a guess.
    assert.deepEqual(week.summary.columns[1].names, []);
    assert.deepEqual(week.waiting, []);
  });
});

test('the menu is set for the week and a cleared day loses its row', async () => {
  const { db, raw } = property();
  const lunch = await import('../src/routes/lunch.js');

  await lunch.setMenu(ctxFor(db, '/api/lunch/menu', {
    days: [{ day: MON, meal: 'Jollof', note: 'Pepper on the side' }, { day: WED, meal: 'Waakye' }],
  }));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM lunch_menu').get().n, 2);

  await lunch.setMenu(ctxFor(db, '/api/lunch/menu', { days: [{ day: WED, meal: '' }] }));
  assert.deepEqual(raw.prepare('SELECT day FROM lunch_menu').all().map((r) => r.day), [MON]);
});

test('the days ordering is open on have to be days', async () => {
  const { db, raw } = property();
  const lunch = await import('../src/routes/lunch.js');

  await lunch.setOpenDays(ctxFor(db, '/api/lunch/days', { days: [5, 6, 5] }));
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'lunch_open_days'").get().value, '5,6');

  await assert.rejects(
    () => lunch.setOpenDays(ctxFor(db, '/api/lunch/days', { days: [0, 9] })),
    /at least one day/,
  );
});
