import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  daysFor, first, menuWeek, readTime, scheduleFrom, showTime, summarise, unanswered, weekDays,
  windowFor,
} from '../src/lib/lunch.js';

/**
 * The weekly lunch list.
 *
 * Nearly everything that can go wrong here is a calendar mistake, and a
 * calendar mistake means the kitchen cooks for the wrong week. So the window
 * is tested against fixed moments rather than against whatever day the suite
 * is run on: 2026-08-20 is a Thursday, and the week it orders for begins
 * Monday 2026-08-24.
 */

const THU = '2026-08-20';
const FRI = '2026-08-21';
const SUN = '2026-08-23';
const MON = '2026-08-24';
const WED = '2026-08-26';

/** The arrangement the property started with: all of Thursday to all of Sunday. */
const USUAL = { opensDow: 4, opensAt: 0, closesDow: 1, closesAt: 0 };
const at = (h2, m = 0) => h2 * 60 + m;

// ---------------------------------------------------------------------------
// Reading the two moments
// ---------------------------------------------------------------------------

test('a time is a time, and anything else is not', () => {
  assert.equal(readTime('09:00'), 540);
  assert.equal(readTime('9:05'), 545);
  assert.equal(readTime('00:00'), 0);
  assert.equal(readTime('23:59'), 1439);
  // The far end of the day, which is how somebody writes the midnight they
  // mean when they mean the end rather than the beginning.
  assert.equal(readTime('24:00'), 1440);

  assert.equal(readTime(''), null);
  assert.equal(readTime('nine'), null);
  assert.equal(readTime('25:00'), null);
  assert.equal(readTime('09:70'), null);
});

test('a time comes back out the way it went in', () => {
  assert.equal(showTime(0), '00:00');
  assert.equal(showTime(540), '09:00');
  assert.equal(showTime(1439), '23:59');
  assert.equal(showTime(1440), '00:00');
});

test('the schedule falls back to the arrangement the property started with', () => {
  assert.deepEqual(scheduleFrom({}), USUAL);
  assert.deepEqual(scheduleFrom({
    lunch_opens_dow: '5', lunch_opens_at: '17:30',
    lunch_closes_dow: '7', lunch_closes_at: '20:00',
  }), { opensDow: 5, opensAt: at(17, 30), closesDow: 7, closesAt: at(20) });

  // Nonsense in a setting is not a reason to stop taking lunch orders.
  assert.deepEqual(scheduleFrom({
    lunch_opens_dow: '9', lunch_opens_at: 'lunchtime',
    lunch_closes_dow: '', lunch_closes_at: null,
  }), USUAL);
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('Thursday through Sunday all order for the same Monday', () => {
  for (const now of [`${THU} 00:00`, `${FRI} 12:00`, '2026-08-22 06:00', `${SUN} 23:59`]) {
    const w = windowFor(now, USUAL);
    assert.equal(w.open, true, now);
    assert.equal(w.monday, MON, now);
  }
});

test('the rest of the week is shut, and says when it opens', () => {
  for (const now of [`${MON} 00:00`, `${MON} 09:00`, `${WED} 23:59`]) {
    const w = windowFor(now, USUAL);
    assert.equal(w.open, false, now);
    assert.equal(w.opensOn, `${'2026-08-27'} 00:00`, now);
    // A shut page still names the week it will be for, because "come back
    // later" on its own is a page somebody comes back to at the wrong time.
    assert.equal(w.monday, '2026-08-31', now);
  }
});

test('the hour is part of it, at both ends', () => {
  const nine = { opensDow: 4, opensAt: at(9), closesDow: 7, closesAt: at(18) };

  assert.equal(windowFor(`${THU} 08:59`, nine).open, false, 'a minute early is early');
  assert.equal(windowFor(`${THU} 09:00`, nine).open, true, 'and the minute itself is open');
  assert.equal(windowFor(`${SUN} 17:59`, nine).open, true);
  assert.equal(windowFor(`${SUN} 18:00`, nine).open, false, 'shut on the minute, not after it');

  assert.equal(windowFor(`${THU} 08:59`, nine).opensOn, `${THU} 09:00`);
  assert.equal(windowFor(`${THU} 09:00`, nine).closesOn, `${SUN} 18:00`);
});

test('everybody inside one window orders for the same week', () => {
  const nine = { opensDow: 4, opensAt: at(9), closesDow: 7, closesAt: at(18) };
  for (const now of [`${THU} 09:00`, `${FRI} 23:00`, `${SUN} 17:59`]) {
    assert.equal(windowFor(now, nine).monday, MON, now);
  }
});

test('a window that runs Monday to Wednesday orders for the Monday after', () => {
  const early = { opensDow: 1, opensAt: at(9), closesDow: 3, closesAt: at(17) };
  assert.equal(windowFor(`${MON} 09:00`, early).monday, '2026-08-31');
  assert.equal(windowFor(`${WED} 16:59`, early).monday, '2026-08-31');
  // Shut again, and now pointing at the week after that.
  assert.equal(windowFor(`${WED} 17:00`, early).open, false);
  assert.equal(windowFor(`${WED} 17:00`, early).monday, '2026-09-07');
});

test('a window that runs over the end of the week still holds together', () => {
  // Saturday noon to Tuesday morning: the week rolls over inside it, which is
  // the case a naive comparison gets wrong.
  const wraps = { opensDow: 6, opensAt: at(12), closesDow: 2, closesAt: at(10) };

  assert.equal(windowFor('2026-08-22 11:59', wraps).open, false);
  assert.equal(windowFor('2026-08-22 12:00', wraps).open, true);
  assert.equal(windowFor(`${MON} 23:00`, wraps).open, true, 'still open on the far side');
  assert.equal(windowFor('2026-08-25 09:59', wraps).open, true);
  assert.equal(windowFor('2026-08-25 10:00', wraps).open, false);

  // And everybody in it names the same week, either side of the rollover.
  const monday = windowFor('2026-08-22 12:00', wraps).monday;
  assert.equal(windowFor(`${MON} 23:00`, wraps).monday, monday);
  assert.equal(windowFor('2026-08-25 09:59', wraps).monday, monday);
});

test('the week is Monday to Sunday, seven days', () => {
  const w = windowFor(`${THU} 10:00`, USUAL);
  assert.equal(w.days.length, 7);
  assert.equal(w.days[0], MON);
  assert.equal(w.days[6], '2026-08-30');
  assert.deepEqual(weekDays(MON), w.days);
});

test('a date with no time on it means the beginning of that day', () => {
  assert.deepEqual(windowFor(THU, USUAL).open, windowFor(`${THU} 00:00`, USUAL).open);
  assert.equal(windowFor(THU, USUAL).monday, MON);
});

// ---------------------------------------------------------------------------
// The standing menu
// ---------------------------------------------------------------------------

test('the menu is seven days in order, whatever is set on them', () => {
  const week = menuWeek([
    { dow: 3, meal: 'Waakye' },
    { dow: 1, meal: 'Jollof', note: 'Pepper on the side' },
  ]);

  assert.equal(week.length, 7);
  assert.deepEqual(week.map((d) => d.name), [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ]);
  assert.equal(week[0].meal, 'Jollof');
  assert.equal(week[0].note, 'Pepper on the side');
  assert.equal(week[2].meal, 'Waakye');
  // A day nobody has set is a day with no meal, not a missing row.
  assert.equal(week[1].meal, null);
  assert.equal(week[1].dow, 2);
});

// ---------------------------------------------------------------------------
// One person's page
// ---------------------------------------------------------------------------

const WEEK = weekDays(MON);
// Keyed by which day of the week it is, not by the date: the menu is a
// standing week and Monday is jollof every Monday.
const MENU = new Map([
  [1, { meal: 'Jollof and chicken' }],
  [2, { meal: 'Banku and tilapia', note: 'Pepper on the side' }],
  [4, { meal: 'Waakye' }],
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

// The clock. The window is worked out from the real moment, so the tests that
// need a Thursday morning say so rather than hoping.
function atDay(day, run, time = '09:00') {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a) { return a.length ? new Real(...a) : new Real(`${day}T${time}:00Z`); }
    static now() { return new Real(`${day}T${time}:00Z`).getTime(); }
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

test('turning the list off does not touch the link or what was said', async () => {
  const { db, raw } = property();
  const lunch = await import('../src/routes/lunch.js');
  const token = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];

  await atDay(THU, async () => {
    await lunch.lunchSay(
      ctxFor(db, `/api/l/${token}/me/1`, { days: [{ day: MON, taking: true }] }), token, '1',
    );
  });

  await lunch.setOpen(ctxFor(db, '/api/lunch/switch', { on: false }));

  await atDay(THU, async () => {
    // The address still opens. It has to: a link that 404s is a link somebody
    // assumes is broken and asks for a new one.
    const look = await (await lunch.lunchOpen(ctxFor(db, '/x'), token)).json();
    assert.equal(look.open, false);
    assert.equal(look.off, true, 'and it says why, rather than looking like the wrong hour');

    await assert.rejects(
      () => lunch.lunchSay(ctxFor(db, '/x', { days: [{ day: MON, taking: true }] }), token, '1'),
      /shut/,
    );
  });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM lunch_order').get().n, 1);

  // And on again, with the same address.
  await lunch.setOpen(ctxFor(db, '/api/lunch/switch', { on: true }));
  await atDay(THU, async () => {
    assert.equal((await (await lunch.lunchOpen(ctxFor(db, '/x'), token)).json()).open, true);
  });
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
    assert.equal(look.off, false, 'too early, not turned off');
    assert.equal(look.opensOn, `${THU} 00:00`);

    await assert.rejects(
      () => lunch.lunchSay(ctxFor(db, '/x', { days: [{ day: MON, taking: true }] }), token, '1'),
      /shut. It opens again on Thursday at 00:00/,
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
      days: [{ dow: 1, meal: 'Jollof and chicken' }, { dow: 3, meal: 'Waakye' }],
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

test('the menu is a standing week, and a cleared day loses its row', async () => {
  const { db, raw } = property();
  const lunch = await import('../src/routes/lunch.js');

  await lunch.setMenu(ctxFor(db, '/api/lunch/menu', {
    days: [{ dow: 1, meal: 'Jollof', note: 'Pepper on the side' }, { dow: 3, meal: 'Waakye' }],
  }));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM lunch_menu_week').get().n, 2);

  await lunch.setMenu(ctxFor(db, '/api/lunch/menu', { days: [{ dow: 3, meal: '' }] }));
  assert.deepEqual(raw.prepare('SELECT dow FROM lunch_menu_week').all().map((r) => r.dow), [1]);
});

test('the same menu turns up week after week without being set again', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');

  await lunch.setMenu(ctxFor(db, '/api/lunch/menu', {
    days: [{ dow: 1, meal: 'Jollof and chicken' }, { dow: 5, meal: 'Red red' }],
  }));

  for (const monday of [MON, '2026-08-31', '2026-12-28']) {
    const week = await (await lunch.lunchWeek(
      ctxFor(db, `/api/lunch?week=${monday}`),
    )).json();
    assert.equal(week.summary.columns[0].meal, 'Jollof and chicken', monday);
    assert.equal(week.summary.columns[4].meal, 'Red red', monday);
    assert.equal(week.summary.columns[1].meal, null, monday);
  }
});

test('the two moments have to be two moments', async () => {
  const { db, raw } = property();
  const lunch = await import('../src/routes/lunch.js');

  await lunch.setSchedule(ctxFor(db, '/api/lunch/schedule', {
    opensDow: 5, opensAt: '17:30', closesDow: 7, closesAt: '20:00',
  }));
  const got = (key) => raw.prepare('SELECT value FROM settings WHERE key = ?').get(key).value;
  assert.equal(got('lunch_opens_dow'), '5');
  assert.equal(got('lunch_opens_at'), '17:30');
  assert.equal(got('lunch_closes_dow'), '7');
  assert.equal(got('lunch_closes_at'), '20:00');

  await assert.rejects(
    () => lunch.setSchedule(ctxFor(db, '/x', {
      opensDow: 9, opensAt: '09:00', closesDow: 1, closesAt: '00:00',
    })),
    /has to be a day/,
  );
  await assert.rejects(
    () => lunch.setSchedule(ctxFor(db, '/x', {
      opensDow: 4, opensAt: 'morning', closesDow: 1, closesAt: '00:00',
    })),
    /has to be a time/,
  );
  await assert.rejects(
    () => lunch.setSchedule(ctxFor(db, '/x', {
      opensDow: 4, opensAt: '09:00', closesDow: 4, closesAt: '09:00',
    })),
    /same moment/,
  );
});

test('the kitchen can put anybody down, on a day the rota does not have them', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');

  // Held on the Thursday, like every other test here. Without it the week the
  // list shows is whichever week it happens to be when the suite runs, and a
  // test that passes on a Wednesday and fails on a Sunday is not a test.
  await atDay(THU, async () => {
    // Ama is only pencilled in for Thursday and it was never published, so as
    // far as the rota is concerned she is not in at all that week.
    const friday = '2026-08-28';
    const out = await (await lunch.setOrder(ctxFor(db, '/api/lunch/order', {
      staffId: 2,
      days: [{ day: friday, taking: true }, { day: MON, taking: false }],
    }))).json();
    assert.equal(out.saved, 2);
    assert.equal(out.name, 'Ama Serwaa');

    const week = await (await lunch.lunchWeek(ctxFor(db, '/api/lunch'))).json();
    const fri = week.summary.columns.find((c) => c.day === friday);
    assert.deepEqual(fri.names, ['Ama'], 'she is on the count even though she is not on the rota');
  });
});

test('somebody the kitchen put down can change it themselves', async () => {
  const { db } = property();
  const lunch = await import('../src/routes/lunch.js');
  const token = (await (await lunch.makeLink(ctxFor(db, '/api/lunch/link', {}))).json())
    .url.split('/lunch/')[1];

  const friday = '2026-08-28';
  await lunch.setOrder(ctxFor(db, '/api/lunch/order', {
    staffId: 1, days: [{ day: friday, taking: true }],
  }));

  await atDay(THU, async () => {
    // The day is on his own page, even though the rota does not have him in.
    const mine = await (await lunch.lunchMine(ctxFor(db, '/x'), token, '1')).json();
    assert.ok(mine.days.some((d) => d.day === friday && d.taking === true));

    // And he can say no to it.
    const said = await (await lunch.lunchSay(
      ctxFor(db, '/x', { days: [{ day: friday, taking: false }] }), token, '1',
    )).json();
    assert.equal(said.saved, 1);
  });
});
