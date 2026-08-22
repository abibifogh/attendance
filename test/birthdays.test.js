import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  ageOn, birthdaysOn, daysUntil, greeting, monthDay, prompt, upcoming,
} from '../src/lib/birthdays.js';
import { birthdays, sendBirthdayCard, wishThem } from '../src/routes/birthdays.js';

/**
 * Birthdays.
 *
 * Two rules worth pinning down. Nobody is wished twice, and nobody's age is
 * ever put on a card — the record holds a full date because payroll needs one,
 * and announcing that somebody is fifty-three is not a kindness.
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

const today = () => new Date().toISOString().slice(0, 10);

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_staff; DELETE FROM hr_profile; DELETE FROM users;
            DELETE FROM app_notices; DELETE FROM att_nudge; DELETE FROM audit_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec("INSERT INTO settings (key, value) VALUES ('property_name', 'Somewhere Nice') "
    + "ON CONFLICT(key) DO UPDATE SET value = 'Somewhere Nice'");

  const person = (id, name, born, { login = false } = {}) => {
    raw.prepare(
      "INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (?, ?, ?, 'F&B', '2020-01-01')",
    ).run(id, String(id), name);
    raw.prepare('INSERT INTO hr_profile (staff_id, date_of_birth) VALUES (?, ?)').run(id, born);
    if (login) {
      raw.prepare(
        "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (?, ?, 'staff', ?, ?, 1)",
      ).run(100 + id, name, `pin${id}`, id);
    }
  };
  return { raw, db: d1(raw), person };
}

const ADMIN = { user: { id: 2, name: 'Ama', role: 'admin' }, permissions: ['att_view', 'att_manage'] };
const ctx = (db, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/birthdays'),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

// ------------------------------------------------------------------ pure --

test('a date of birth that cannot be one is not a birthday', () => {
  assert.equal(monthDay('1990-06-01'), '06-01');
  assert.equal(monthDay('2999-06-01'), null, 'the future');
  assert.equal(monthDay('1801-06-01'), null, 'before anybody alive');
  assert.equal(monthDay('not a date'), null);
  assert.equal(monthDay(null), null);
});

test('a leap-day birthday is noticed every year, not one in four', () => {
  const leaper = [{ name: 'Kofi', date_of_birth: '1992-02-29' }];
  // 2028 has a 29th; 2027 does not, so it falls to the 28th.
  assert.equal(birthdaysOn(leaper, '2028-02-29').length, 1);
  assert.equal(birthdaysOn(leaper, '2027-02-28').length, 1);
  assert.equal(birthdaysOn(leaper, '2027-03-01').length, 0);
});

test('age is worked out, and is never in the greeting', () => {
  assert.equal(ageOn('1990-06-01', '2026-06-01'), 36);
  assert.equal(ageOn('1990-06-02', '2026-06-01'), 35, 'the day before does not count');

  const wish = greeting('Ama Serwaa', { property: 'Somewhere Nice' });
  assert.match(wish.title, /Happy birthday, Ama/);
  assert.ok(!/\d/.test(wish.title + wish.line), 'no number of any kind on a card');
});

test('what is coming up is ordered by how far off it is, across new year', () => {
  const people = [
    { name: 'A', date_of_birth: '1990-01-03' },
    { name: 'B', date_of_birth: '1990-12-30' },
    { name: 'C', date_of_birth: '1990-06-15' },
  ];
  const soon = upcoming(people, '2026-12-28', 30);
  assert.deepEqual(soon.map((p) => p.name), ['B', 'A'], 'December and January sit together');
  assert.equal(soon[0].inDays, 2);
  assert.equal(soon[1].inDays, 6);
  assert.equal(daysUntil('06-15', '2026-06-15'), 0, 'today is nought days away');
});

test('the prompt to the floor asks for a person, not an automatic message', () => {
  const said = prompt(['Ama']);
  assert.match(said.title, /It is Ama's birthday today/);
  assert.match(said.body, /somebody saying it out loud/);
  assert.match(prompt(['Ama', 'Kofi']).title, /Ama and Kofi/);
});

// ----------------------------------------------------------------- routes --

test('the daily run wishes them and prompts the floor, once', async () => {
  const { db, raw, person } = setup();
  const born = `1990-${today().slice(5)}`;
  person(1, 'Ama Serwaa', born, { login: true });
  person(2, 'Kofi Mensah', '1985-01-01');

  const out = await wishThem(db, { timezone: 'UTC' });
  assert.equal(out.wished, 1);

  const wish = raw.prepare("SELECT * FROM app_notices WHERE kind = 'birthday.wish'").get();
  assert.match(wish.title, /Happy birthday, Ama/);
  assert.equal(wish.user_id, 101, 'to her, and to nobody else');

  const said = raw.prepare("SELECT * FROM app_notices WHERE kind = 'birthday.prompt'").get();
  assert.equal(said.audience, 'att_view');

  // Run again, as a cron that fires twice would.
  assert.equal((await wishThem(db, { timezone: 'UTC' })).wished, 0);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM app_notices WHERE kind = 'birthday.wish'").get().n, 1);
});

test('somebody with no login is still counted, and simply not messaged', async () => {
  const { db, raw, person } = setup();
  person(1, 'Kofi Mensah', `1985-${today().slice(5)}`);

  assert.equal((await wishThem(db, { timezone: 'UTC' })).wished, 1);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM app_notices WHERE kind = 'birthday.wish'").get().n, 0);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM app_notices WHERE kind = 'birthday.prompt'").get().n, 1,
    'the floor is still prompted — a card is the point');
});

test('the screen lists today and the month ahead', async () => {
  const { db, person } = setup();
  person(1, 'Ama Serwaa', `1990-${today().slice(5)}`, { login: true });
  person(2, 'Kofi Mensah', '1985-01-01');
  person(3, 'Yaw Boateng', 'nonsense');

  const out = await (await birthdays(ctx(db))).json();
  assert.equal(out.todays.length, 1);
  assert.equal(out.todays[0].name, 'Ama Serwaa');
  assert.equal(out.todays[0].hasLogin, true);
  assert.equal(out.todays[0].cardSent, false);
  assert.equal(out.property, 'Somewhere Nice');
  assert.equal(out.withDates, 3, 'a nonsense date is still a record with a date on it');
});

test('the card goes to them and to everybody, and only once a day', async () => {
  const { db, raw, person } = setup();
  person(1, 'Ama Serwaa', `1990-${today().slice(5)}`, { login: true });

  const out = await (await sendBirthdayCard(ctx(db, {
    staffId: 1, message: 'Enjoy the day.',
  }))).json();
  assert.equal(out.told, true);
  assert.equal(out.everybody, true);

  const mine = raw.prepare("SELECT * FROM app_notices WHERE kind = 'birthday.wish'").get();
  assert.equal(mine.user_id, 101);
  assert.match(mine.body, /Enjoy the day/);

  const all = raw.prepare("SELECT * FROM app_notices WHERE kind = 'birthday.today'").get();
  assert.equal(all.audience, null, 'the one notice that genuinely means everybody');
  assert.match(all.title, /It is Ama's birthday/);

  await assert.rejects(
    () => sendBirthdayCard(ctx(db, { staffId: 1 })),
    /already gone out/,
  );
});

test('the card can be sent to them alone', async () => {
  const { db, raw, person } = setup();
  person(1, 'Ama Serwaa', `1990-${today().slice(5)}`, { login: true });

  await sendBirthdayCard(ctx(db, { staffId: 1, everybody: false }));
  assert.equal(raw.prepare("SELECT count(*) AS n FROM app_notices WHERE kind = 'birthday.today'").get().n, 0);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM app_notices WHERE kind = 'birthday.wish'").get().n, 1);
});
