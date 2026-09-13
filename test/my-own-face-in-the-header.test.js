import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { myPhoto } from '../src/routes/me.js';

/**
 * Their own face, in the corner of the app.
 *
 * The header carried a drawing of a person: the same grey shoulders and head
 * on every phone in the property. The rota has had real faces down its side
 * for months and so has the directory, and the one face nobody could see
 * anywhere was their own.
 *
 * The picture needs a route of its own. The directory's is gated on the
 * directory being switched on and the rota's on holding the rota, and neither
 * is the right question to ask somebody looking at a photograph of themselves.
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

const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);

function setup({ withPhoto = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM hr_document;');
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
     VALUES (1, '001', 'Ama Mensah', 'Reception', '2020-01-01', 1),
            (2, '002', 'Kofi Boateng', 'Kitchen', '2020-01-01', 1)`,
  ).run();
  if (withPhoto) {
    raw.prepare(
      `INSERT INTO hr_document (staff_id, kind, title, filename, mime, bytes, content)
       VALUES (1, 'photo', 'Photograph', 'face.jpg', 'image/jpeg', ?, ?)`,
    ).run(PICTURE.length, PICTURE);
  }
  return { raw, db: d1(raw) };
}

const asStaff = (staffId) => ({
  user: { id: 90 + staffId, name: 'Them', role: 'staff', staff_id: staffId },
  permissions: ['att_me'],
});

const ctx = (db, session) => ({
  db,
  env: {},
  url: new URL('https://x/api/me/photo'),
  session,
  executionContext: null,
  request: new Request('https://x/', { method: 'GET' }),
});

test('their own picture comes back, as a picture', async () => {
  const { db } = setup();
  const out = await myPhoto(ctx(db, asStaff(1)));

  assert.equal(out.status, 200);
  assert.equal(out.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await out.arrayBuffer()), PICTURE);
});

test('and no shared cache is allowed to hold it', async () => {
  const { db } = setup();
  const out = await myPhoto(ctx(db, asStaff(1)));
  // It is somebody's face.
  assert.match(out.headers.get('Cache-Control'), /private/);
});

test('somebody who has not sent one in gets a plain no', async () => {
  const { db } = setup({ withPhoto: false });
  await assert.rejects(() => myPhoto(ctx(db, asStaff(1))), /No photograph on file/);
});

test('it is their own and no route to anybody else’s', async () => {
  const { db } = setup();
  // Kofi has no picture. The route takes the person from the session and
  // nothing from the request, so there is no id to put Ama's in its place.
  await assert.rejects(() => myPhoto(ctx(db, asStaff(2))), /No photograph on file/);

  const source = readFileSync('src/routes/me.js', 'utf8');
  const at = source.indexOf('export async function myPhoto');
  const fn = source.slice(at, source.indexOf('export async function clearMyPhoto'));
  assert.match(fn, /const staff = await meOf\(ctx\)/);
  assert.equal(/searchParams/.test(fn), false, 'nothing in the request picks the person');
});

test('the session says whether there is a face, and when it was set', () => {
  const index = readFileSync('src/index.js', 'utf8');
  assert.match(index, /hasPhoto: Boolean\(photo\)/);
  assert.match(index, /photoAt: photo\?\.uploaded_at \?\? null/);
  // A boolean and a timestamp, never the picture: a face in the payload of
  // every screen is bytes on every redraw the live socket causes.
  assert.match(index, /SELECT uploaded_at FROM hr_document/);
  assert.match(index, /\['GET', '\/api\/me\/photo', 'att_me', mine\.myPhoto\]/);
});

test('the header draws the same face the directory does', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  // The shared helper, so the initials and the colour are the same everywhere
  // somebody appears.
  assert.match(app, /import \{ face \} from '\.\/views\/components\.js'/);
  assert.match(app, /face\(state\.name, \{/);
  assert.match(app, /state\.hasPhoto/);
  // And the drawing of a person is gone.
  assert.equal(app.includes("h('span.only-phone', '\u{1F464}')"), false);

  // Changing the picture redraws the header rather than waiting for a reload.
  const account = readFileSync('public/js/views/account.js', 'utf8');
  assert.match(account, /await refreshSession\(\);/);
  assert.match(app, /export async function refreshSession/);
});
