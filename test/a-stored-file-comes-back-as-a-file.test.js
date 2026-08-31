import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { asBytes } from '../src/lib/files.js';
import { addFile, readFile } from '../src/routes/recruitment.js';
import { addCandidate } from '../src/routes/recruitment.js';

/**
 * A file put in comes back out as the same bytes.
 *
 * THE TEST HAS TO LIE ABOUT THE DRIVER TO BE WORTH ANYTHING. `node:sqlite`
 * hands a BLOB back as a Uint8Array, which every route handles by accident.
 * D1 hands back a plain array of numbers, and a route that puts that straight
 * into a Response sends the browser the text "37,80,68,70,..." under a PDF
 * content type. So the shim below returns arrays of numbers, the way the real
 * thing does, and these tests fail against any route that has not been through
 * `asBytes`.
 */

function d1(db, { blobsAsArrays = true } = {}) {
  const shape = (row) => {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = blobsAsArrays && v instanceof Uint8Array ? Array.from(v) : v;
    }
    return out;
  };
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds).map(shape) }; },
    async first() { const r = db.prepare(sql).get(...binds); return r ? shape(r) : null; },
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  return { raw, db: d1(raw) };
}

const WHO = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['rec_manage', 'rec_view'] };
const ctx = (db, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/rec'),
  session: WHO,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (r) => r.json();

// A real little PDF: the header is what a browser checks first.
const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
  ...Array.from({ length: 200 }, (_, i) => i % 256),
]);
const base64 = Buffer.from(PDF).toString('base64');

test('bytes survive whatever shape the driver hands them back in', () => {
  assert.deepEqual(asBytes(Array.from(PDF)), PDF, 'a plain array, which is what D1 gives');
  assert.deepEqual(asBytes(PDF), PDF);
  assert.deepEqual(asBytes(PDF.buffer.slice(0)), PDF);
  assert.equal(asBytes(null), null);
});

test('a CV downloaded is byte for byte the CV that was uploaded', async () => {
  const { db } = setup();
  const person = await read(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const added = await read(await addFile(ctx(db, {
    kind: 'cv', filename: 'ama-cv.pdf', mime: 'application/pdf', content: base64,
  }), person.id));

  const response = await readFile(ctx(db), person.id, added.id ?? added.fileId ?? 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');

  const back = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(back, PDF, 'the same bytes, not a stringified array of them');
  // The thing a browser looks at before it decides the file is broken.
  assert.equal(new TextDecoder().decode(back.slice(0, 5)), '%PDF-');
});

test('the body is not the numbers written out as text', async () => {
  // What the bug actually produced: "37,80,68,70,45,49,46,52,..." served under
  // a PDF content type, which Chrome reports as "Failed to load PDF document".
  const { db } = setup();
  const person = await read(await addCandidate(ctx(db, { name: 'Kofi Boateng' })));
  const added = await read(await addFile(ctx(db, {
    kind: 'cv', filename: 'kofi.pdf', mime: 'application/pdf', content: base64,
  }), person.id));

  const text = await (await readFile(ctx(db), person.id, added.id ?? 1)).text();
  assert.ok(!text.startsWith('37,80,68'), 'not a stringified array');
  assert.ok(text.startsWith('%PDF-'));
});

test('a photograph of a CV comes back as a photograph', async () => {
  const { db } = setup();
  const person = await read(await addCandidate(ctx(db, { name: 'Yaa Owusu' })));
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
  const added = await read(await addFile(ctx(db, {
    kind: 'cv', filename: 'yaa.jpg', mime: 'image/jpeg',
    content: Buffer.from(jpeg).toString('base64'),
  }), person.id));

  const response = await readFile(ctx(db), person.id, added.id ?? 1);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
});
