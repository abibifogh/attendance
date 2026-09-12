import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { staffDirectory } from '../src/routes/directory.js';

/**
 * A phone number and an email address, and nothing else.
 *
 * Somebody needs to reach the person covering their shift. Until now that
 * meant asking an administrator to open a personnel record, which shows a date
 * of birth, an ID number and a bank account to somebody who wanted a phone
 * number. So the number is on a screen of its own, and the screen holds four
 * columns.
 *
 * The safety is in the query rather than in the drawing. A whole record read
 * out and then filtered on the way to the browser is the same screen one
 * careless edit away from being a personnel file; four columns selected are
 * four columns, and what is not in the query cannot leak.
 *
 * And it is off until the property turns it on. A directory of everybody's
 * personal mobile is not something an upgrade switches on for a property that
 * never asked for one.
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

function setup({ on = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM hr_profile; DELETE FROM users;');
  raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
  ).run('hr_directory', on ? '1' : '0');

  const add = (id, name, dept, active = 1) => raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
     VALUES (?, ?, ?, ?, '2020-01-01', ?)`,
  ).run(id, String(id), name, dept, active);
  add(1, 'Ama Mensah', 'Reception');
  add(2, 'Kofi Boateng', 'Housekeeping');
  add(3, 'Yaa Dede', 'Reception');
  add(4, 'Gone Away', 'Reception', 0);

  const profile = (id, phone, email, extra = {}) => {
    raw.prepare('INSERT INTO hr_profile (staff_id, personal_phone, personal_email) VALUES (?, ?, ?)')
      .run(id, phone, email);
    for (const [col, v] of Object.entries(extra)) {
      raw.prepare(`UPDATE hr_profile SET ${col} = ? WHERE staff_id = ?`).run(v, id);
    }
  };
  // Everything a personnel record holds, so the test can prove none of it travels.
  profile(1, '024 111 2222', 'ama@example.test', {
    date_of_birth: '1990-04-01',
    id_number: 'GHA-000000000-1',
    ssnit_number: 'C0192092106',
    account_number: '1234567890',
    address_line: '12 Independence Avenue',
  });
  profile(2, '055 333 4444', null);
  profile(3, null, null);
  profile(4, '020 555 6666', 'gone@example.test');
  return { raw, db: d1(raw) };
}

const ctx = (db) => ({
  db,
  env: {},
  url: new URL('https://x/api/directory'),
  session: { user: { id: 7, name: 'Kofi', role: 'staff', staff_id: 2 }, permissions: ['att_me'] },
  executionContext: null,
  request: new Request('https://x/'),
});

const look = async (db) => (await staffDirectory(ctx(db))).json();

// ---------------------------------------------------------------------------
// What is on it
// ---------------------------------------------------------------------------

test('a name, a department, a number and an address', async () => {
  const { db } = setup();
  const out = await look(db);
  assert.equal(out.on, true);
  assert.deepEqual(out.people.find((p) => p.name === 'Ama Mensah'), {
    id: 1,
    name: 'Ama Mensah',
    department: 'Reception',
    phone: '024 111 2222',
    email: 'ama@example.test',
    hasPhoto: false,
  });
});

test('and not one thing more, whatever else the record holds', async () => {
  const { db } = setup();
  const said = JSON.stringify(await look(db));
  for (const secret of [
    '1990-04-01', 'GHA-000000000-1', 'C0192092106', '1234567890', '12 Independence Avenue',
  ]) {
    assert.equal(said.includes(secret), false, `the directory gave out ${secret}`);
  }
  // Belt and braces: the shape itself, so a new column on hr_profile cannot
  // quietly join the answer.
  for (const person of (await look(db)).people) {
    assert.deepEqual(Object.keys(person).sort(),
      ['department', 'email', 'hasPhoto', 'id', 'name', 'phone']);
  }
});

test('one of the two is enough to be on it', async () => {
  const { db } = setup();
  const kofi = (await look(db)).people.find((p) => p.name === 'Kofi Boateng');
  assert.equal(kofi.phone, '055 333 4444');
  assert.equal(kofi.email, null, 'and the missing one is plainly missing');
});

test('somebody with neither is not on it', async () => {
  const { db } = setup();
  // A row of blanks is a name somebody reads twice before working out that the
  // directory cannot help them.
  assert.equal((await look(db)).people.some((p) => p.name === 'Yaa Dede'), false);
});

test('somebody who has left is not on it', async () => {
  const { db } = setup();
  assert.equal((await look(db)).people.some((p) => p.name === 'Gone Away'), false);
});

test('in alphabetical order, which is the order somebody looks in', async () => {
  const { db } = setup();
  const names = (await look(db)).people.map((p) => p.name);
  assert.deepEqual(names, [...names].sort());
});

// ---------------------------------------------------------------------------
// Whether it is on at all
// ---------------------------------------------------------------------------

test('it is off until the property turns it on, and says so rather than emptying', async () => {
  const { db } = setup({ on: false });
  const out = await look(db);
  assert.equal(out.on, false);
  assert.deepEqual(out.people, [], 'and no numbers travel while it is off');
});

test('off is the default, not something an upgrade decides', async () => {
  const { raw, db } = setup({ on: false });
  raw.prepare("DELETE FROM settings WHERE key = 'hr_directory'").run();
  const out = await look(db);
  assert.equal(out.on, false);
  assert.deepEqual(out.people, []);
});

// ---------------------------------------------------------------------------
// Who may open it
// ---------------------------------------------------------------------------

test('everybody signed in, because a directory nobody can open is a list', () => {
  const index = readFileSync('src/index.js', 'utf8');
  assert.match(index, /\['GET', '\/api\/directory', null, directory\.staffDirectory\]/);
});

test('the screen is a link of its own, reachable without any permission', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  assert.match(app, /group: 'directory'.*permission: null/);
  // Not under People, which is the personnel records and their permission.
  assert.equal(/group: 'people'.*path: 'directory'/.test(app), false);
});

test('the query names its columns and no others', () => {
  const route = readFileSync('src/routes/directory.js', 'utf8');
  // The people query, not the one-line settings read above it.
  // The query itself, which starts a template literal. Matching bare SELECT
  // finds the word in the comment above it first.
  const select = route.match(/`SELECT([\s\S]*?)FROM att_staff/)[1];
  for (const column of [/s\.id/, /s\.name/, /s\.department/, /personal_phone/,
    /personal_email/, /kind = 'photo'/]) {
    assert.match(select, column);
  }
  assert.equal(/\*/.test(select), false, 'never SELECT *, which is the whole record');
  // A name, a department, the two ways of reaching somebody, and enough to put
  // a face against the name. Anything past that is a decision, not a tidy-up:
  // the count is here so adding one has to be done on purpose.
  assert.equal(select.split(',').length, 6, 'six, and a seventh is a decision');
  assert.equal((select.match(/AS has_photo/g) ?? []).length, 1);
});
