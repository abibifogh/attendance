import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { fill, greeting, prompt } from '../src/lib/birthdays.js';
import { birthdayAdmin, birthdays, wishThem } from '../src/routes/birthdays.js';

/**
 * Managing the birthday message.
 *
 * The wording used to be in the code, which made it the one message in this
 * app nobody here could change. Three things worth pinning down: the wording
 * that is set is the wording that goes out, turning it off turns it off, and
 * the screen that manages it says who the app knows nothing about — because a
 * birthday it was never told of looks exactly like a birthday nobody has.
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

  const set = (key, value) => raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
  ).run(key, value, value);

  const person = (id, name, born, { login = false, department = 'F&B' } = {}) => {
    raw.prepare(
      'INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (?, ?, ?, ?, ?)',
    ).run(id, String(id), name, department, '2020-01-01');
    if (born !== null) {
      raw.prepare('INSERT INTO hr_profile (staff_id, date_of_birth) VALUES (?, ?)').run(id, born);
    }
    if (login) {
      raw.prepare(
        "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (?, ?, 'staff', ?, ?, 1)",
      ).run(100 + id, name, `pin${id}`, id);
    }
  };

  return { raw, db: d1(raw), person, set };
}

const ctx = (db) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/birthdays/manage'),
  session: { user: { id: 2, name: 'Ama', role: 'admin' }, permissions: ['att_setup'] },
  executionContext: null,
  request: new Request('https://x/'),
});

const body = async (res) => JSON.parse(await res.text());

/** Somebody whose birthday is today, whatever today happens to be. */
const bornToday = (year = 1990) => `${year}-${today().slice(5)}`;

// ------------------------------------------------------------------ pure --

test('the wording takes a name and a place and nothing else', () => {
  assert.equal(
    fill('Happy birthday {name}, from everybody at {property}',
      { name: 'Kofi', property: 'Somewhere Nice' }),
    'Happy birthday Kofi, from everybody at Somewhere Nice',
  );
  // A property that has not set its name would otherwise send "Everybody at
  // hopes you have a lovely day".
  assert.equal(fill('Everybody at {property} says hello'), 'Everybody at work says hello');
  assert.equal(fill('Hello {name}'), 'Hello you');
});

test('what is written on the setup screen is what the wish says', () => {
  const wish = greeting('Godfred Donkor', {
    property: 'Somewhere Nice',
    title: 'Many happy returns, {name}',
    line: 'From all of us at {property}.',
  });
  assert.equal(wish.title, 'Many happy returns, Godfred');
  assert.equal(wish.line, 'From all of us at Somewhere Nice.');
});

test('the prompt takes its words but still counts the names itself', () => {
  const one = prompt(['Ama'], { body: 'Go and say something.' });
  assert.equal(one.title, "It is Ama's birthday today");
  assert.equal(one.body, 'Go and say something.');

  const two = prompt(['Ama', 'Kofi'], { body: 'Go and say something.' });
  assert.equal(two.title, "It is Ama and Kofi's birthdays today");
});

// ------------------------------------------------------------- the daily --

test('the daily run uses the wording that is set', async () => {
  const { db, person, set, raw } = setup();
  person(1, 'Godfred Donkor', bornToday(), { login: true });
  set('att_bd_title', 'Many happy returns, {name}');
  set('att_bd_line', 'Everybody at {property} is glad you are here.');

  await wishThem(db, { timezone: 'UTC' });

  const wish = raw.prepare("SELECT title, body FROM app_notices WHERE kind = 'birthday.wish'").get();
  assert.equal(wish.title, 'Many happy returns, Godfred');
  assert.equal(wish.body, 'Everybody at Somewhere Nice is glad you are here.');
});

test('turned off, nothing goes out at all', async () => {
  const { db, person, set, raw } = setup();
  person(1, 'Godfred Donkor', bornToday(), { login: true });
  set('att_bd_wish', '0');
  set('att_bd_prompt', '0');

  const result = await wishThem(db, { timezone: 'UTC' });
  assert.equal(result.off, true);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM app_notices WHERE kind LIKE 'birthday.%'").get().n, 0);
  // And nothing was claimed either, so turning it back on tomorrow is not a
  // day somebody was silently skipped.
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM att_nudge WHERE kind = 'birthday'").get().n, 0);
});

test('the wish can be off while the floor is still prompted', async () => {
  const { db, person, set, raw } = setup();
  person(1, 'Godfred Donkor', bornToday(), { login: true });
  set('att_bd_wish', '0');

  await wishThem(db, { timezone: 'UTC' });

  assert.equal(raw.prepare("SELECT COUNT(*) n FROM app_notices WHERE kind = 'birthday.wish'").get().n, 0,
    'they were not messaged');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM app_notices WHERE kind = 'birthday.prompt'").get().n, 1,
    'but somebody was told to say it out loud');
});

// -------------------------------------------------------------- managing --

test('the screen says who has no date on file', async () => {
  const { db, person } = setup();
  person(1, 'Godfred Donkor', bornToday());
  person(2, 'Nobody Knows', null, { department: 'Housekeeping' });

  const data = await body(await birthdayAdmin(ctx(db)));

  assert.equal(data.withDates, 1);
  assert.equal(data.missing.length, 1);
  assert.equal(data.missing[0].name, 'Nobody Knows');
  assert.equal(data.missing[0].department, 'Housekeeping');
});

test('the year is twelve months, with everybody under the right one', async () => {
  const { db, person } = setup();
  person(1, 'March Person', '1990-03-14');
  person(2, 'Another March', '1988-03-02');
  person(3, 'December Person', '1991-12-25');

  const data = await body(await birthdayAdmin(ctx(db)));

  assert.equal(data.months.length, 12);
  const march = data.months[2];
  assert.equal(march.people.length, 2);
  // By the day of the month, so the list reads as a month rather than as an
  // alphabet.
  assert.deepEqual(march.people.map((p) => p.day), [2, 14]);
  assert.equal(data.months[11].people[0].name, 'December Person');
  assert.equal(data.months[0].people.length, 0);
});

test('the preview is against a real name off the books', async () => {
  const { db, person, set } = setup();
  person(1, 'Godfred Donkor', bornToday());
  set('att_bd_line', 'Everybody at {property} hopes you have a lovely day.');

  const data = await body(await birthdayAdmin(ctx(db)));

  assert.equal(data.preview.real, true);
  assert.equal(data.preview.name, 'Godfred Donkor');
  assert.equal(data.preview.wish.title, 'Happy birthday, Godfred');
  assert.match(data.preview.wish.line, /Somewhere Nice/);
});

test('with nobody on the books the preview uses a stand-in and says so', async () => {
  const { db } = setup();
  const data = await body(await birthdayAdmin(ctx(db)));

  assert.equal(data.preview.real, false);
  assert.equal(data.withDates, 0);
  assert.equal(data.months.every((m) => m.people.length === 0), true);
});

test('what has gone out is listed, and says who it went to', async () => {
  const { db, person } = setup();
  person(1, 'Godfred Donkor', bornToday(), { login: true });
  await wishThem(db, { timezone: 'UTC' });

  const data = await body(await birthdayAdmin(ctx(db)));

  const kinds = new Map(data.sent.map((n) => [n.kind, n.to]));
  assert.equal(kinds.get('birthday.wish'), 'The person');
  assert.equal(kinds.get('birthday.prompt'), 'Whoever runs the floor');
});

test('how far ahead to look is a setting, not a fixed month', async () => {
  const { db, raw, set } = setup();
  // Somebody 40 days out, which the default month would not reach.
  const soon = new Date(Date.parse(`${today()}T12:00:00Z`) + 40 * 86400000)
    .toISOString().slice(0, 10);
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Later', 'F&B', '2020-01-01')",
  ).run();
  raw.prepare('INSERT INTO hr_profile (staff_id, date_of_birth) VALUES (1, ?)')
    .run(`1990-${soon.slice(5)}`);

  assert.equal((await body(await birthdays(ctx(db)))).soon.length, 0, 'a month does not reach');

  set('att_bd_ahead', '60');
  assert.equal((await body(await birthdays(ctx(db)))).soon.length, 1, 'two months does');
});

test('the card on the morning screen offers the wording that is set', async () => {
  const { db, person, set } = setup();
  person(1, 'Godfred Donkor', bornToday());
  set('att_bd_line', 'All of us at {property} wish you well.');

  const data = await body(await birthdays(ctx(db)));

  // The name is left as a placeholder for the screen to fill in against
  // whoever the card is being made for; the property is already in.
  assert.equal(data.wording.line, 'All of us at Somewhere Nice wish you well.');
  assert.equal(data.wording.title, 'Happy birthday, {name}');
});
