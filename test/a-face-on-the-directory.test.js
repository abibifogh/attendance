import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { staffDirectory, directoryPhoto } from '../src/routes/directory.js';

/**
 * A face against a name on the directory.
 *
 * A page of twenty-four names is a page you read with a finger. The rota has
 * had faces down the side for months, and the directory, which is the screen
 * somebody opens precisely because they are trying to work out who somebody
 * is, had none of them.
 *
 * The picture rides on the same switch as the rest of the page. A property
 * that has decided its people may hold each other's personal mobile numbers
 * has decided the larger thing already, and one that has not has the directory
 * off, at which point none of this answers at all. What it does not do is
 * widen the rota's own photograph route, which asks for a planner's
 * permission and is going to keep asking for one.
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

const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function setup({ on = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM hr_profile; DELETE FROM hr_document; DELETE FROM users;');
  raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
  ).run('hr_directory', on ? '1' : '0');

  const add = (id, name, active = 1) => {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
       VALUES (?, ?, ?, 'Reception', '2020-01-01', ?)`,
    ).run(id, String(id), name, active);
    raw.prepare(
      'INSERT INTO hr_profile (staff_id, personal_phone) VALUES (?, ?)',
    ).run(id, `024 000 000${id}`);
  };
  add(1, 'Ama Mensah');           // with a photograph
  add(2, 'Kofi Boateng');         // without one
  add(3, 'Gone Away', 0);         // left, and had one

  const photo = (id) => raw.prepare(
    `INSERT INTO hr_document (staff_id, kind, title, filename, mime, bytes, content)
     VALUES (?, 'photo', 'Photograph', 'face.jpg', 'image/jpeg', ?, ?)`,
  ).run(id, PICTURE.length, PICTURE);
  photo(1);
  photo(3);

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
const fetchPhoto = (db, id) => directoryPhoto(ctx(db), String(id));

// ---------------------------------------------------------------------------
// Whether to ask for the picture at all
// ---------------------------------------------------------------------------

test('the list says who has a photograph and who has not', async () => {
  const out = await look(setup().db);
  const by = Object.fromEntries(out.people.map((p) => [p.name, p]));
  assert.equal(by['Ama Mensah'].hasPhoto, true);
  assert.equal(by['Kofi Boateng'].hasPhoto, false);
});

test('and gives an id to ask for it with', async () => {
  const out = await look(setup().db);
  assert.equal(out.people.find((p) => p.name === 'Ama Mensah').id, 1);
});

// ---------------------------------------------------------------------------
// The picture itself
// ---------------------------------------------------------------------------

test('a colleague can fetch a face without a planner’s permission', async () => {
  const { db } = setup();
  const res = await fetchPhoto(db, 1);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PICTURE);
});

test('and no shared cache holds on to somebody’s face', async () => {
  const res = await fetchPhoto(setup().db, 1);
  assert.match(res.headers.get('Cache-Control'), /private/);
});

test('nothing comes out while the directory is off', async () => {
  const { db } = setup({ on: false });
  await assert.rejects(() => fetchPhoto(db, 1), /No photograph on file/);
});

test('nor for somebody who has left, who is not on the page either', async () => {
  const { db } = setup();
  await assert.rejects(() => fetchPhoto(db, 3), /No photograph on file/);
});

test('nor for somebody who never sent one in', async () => {
  const { db } = setup();
  await assert.rejects(() => fetchPhoto(db, 2), /No photograph on file/);
});

test('nor for a staff id that is not one', async () => {
  const { db } = setup();
  await assert.rejects(() => fetchPhoto(db, 404), /No photograph on file/);
});

test('the rota’s own photograph route keeps the permission it had', () => {
  const index = readFileSync('src/index.js', 'utf8');
  assert.match(index,
    /\['GET', '\/api\/att\/staff\/:id\/photo', \['att_rota', 'att_view', 'att_reports'\]/);
  assert.match(index,
    /\['GET', '\/api\/directory\/photo\/:id', null, directory\.directoryPhoto\]/);
});

// ---------------------------------------------------------------------------
// One face, drawn the same way on both screens
// ---------------------------------------------------------------------------

test('the face is a shared piece rather than a second copy of the rota’s', () => {
  const components = readFileSync('public/js/views/components.js', 'utf8');
  assert.match(components, /export function face\(/);
  // Initials where there is no picture, on a colour worked out from the name
  // so the same person is the same colour on every screen.
  assert.match(components, /toUpperCase\(\)/);
  assert.match(components, /'--face'/);

  const css = readFileSync('public/styles.css', 'utf8');
  for (const rule of ['.face,\n.rota-face', '.face-letters,', '.face-photo,']) {
    assert.ok(css.includes(rule), rule);
  }
});

test('a picture that will not load leaves the initials showing', () => {
  const components = readFileSync('public/js/views/components.js', 'utf8');
  assert.match(components, /onerror: \(e\) => e\.target\.remove\(\)/);
});
