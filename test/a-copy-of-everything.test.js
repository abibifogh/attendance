import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { backupParts, backupZip, nightlyCopy } from '../src/lib/backup.js';
import { backup } from '../src/routes/admin.js';

/**
 * A copy of everything, in files a person can open without the app.
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
  raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('property_name', 'Somewhere Nice')").run();
  return { raw, db: d1(raw) };
}

// ignoreBOM keeps the byte-order mark in the text instead of quietly eating it.
const text = (bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
const part = (parts, name) => parts.find((p) => p.name === name);

/** The names inside a stored zip, read straight off the local headers. */
function entriesOf(zipBytes) {
  const names = [];
  let at = 0;
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  while (at + 30 <= zipBytes.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    names.push(text(zipBytes.subarray(at + 30, at + 30 + nameLen)));
    at += 30 + nameLen + extraLen + size;
  }
  return names;
}

test('every table comes out as a CSV with its columns, and the manifest counts the rows', async () => {
  const { raw, db } = setup();
  const { parts, manifest } = await backupParts(db, { now: '2026-09-02T00:30:00Z', property: 'Somewhere Nice' });

  assert.equal(parts[0].name, 'manifest.json');
  assert.equal(manifest.property, 'Somewhere Nice');
  assert.equal(manifest.at, '2026-09-02T00:30:00Z');

  const staff = text(part(parts, 'tables/att_staff.csv').bytes);
  const header = staff.split('\n')[0].replace('\uFEFF', '');
  assert.match(header, /^id,employee_no,name/);
  const people = raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n;
  assert.equal(manifest.tables.att_staff, people);
  assert.equal(staff.trim().split('\n').length, people + 1, 'header plus one line per person');

  // Nothing of SQLite's or D1's, and not the last ten minutes of wrong PINs.
  assert.ok(!part(parts, 'tables/sqlite_sequence.csv'));
  assert.ok(!part(parts, 'tables/login_attempts.csv'));
  assert.ok(!('login_attempts' in manifest.tables));

  // An empty table still has its header, so the shape survives.
  const leave = text(part(parts, 'tables/att_leave.csv').bytes);
  assert.match(leave, /^\uFEFFid,/);
});

test('a stored document comes out as the file it was, and its row points at it', async () => {
  const { raw, db } = setup();
  const staffId = raw.prepare('SELECT id FROM att_staff LIMIT 1').get().id;
  const pdf = new TextEncoder().encode('%PDF-1.4 pretend');
  raw.prepare(
    `INSERT INTO hr_document (id, staff_id, kind, title, filename, mime, bytes, content, uploaded_by)
     VALUES (41, ?, 'contract', 'Contract', 'kofi contract.pdf', 'application/pdf', ?, ?, 'test')`,
  ).run(staffId, pdf.length, pdf);

  const { parts, manifest } = await backupParts(db);
  const file = part(parts, 'files/hr_document/41-kofi_contract.pdf');
  assert.ok(file, 'the file is in the zip under its own name');
  assert.equal(text(file.bytes), '%PDF-1.4 pretend');
  assert.equal(manifest.files, 1);

  const csv = text(part(parts, 'tables/hr_document.csv').bytes);
  assert.match(csv, /files\/hr_document\/41-kofi_contract\.pdf/, 'the content column says where it went');
  assert.ok(!csv.includes('base64:'), 'and the bytes are not in the CSV');
});

test('a large document spread across parts is put back together', async () => {
  const { raw, db } = setup();
  const staffId = raw.prepare('SELECT id FROM att_staff LIMIT 1').get().id;
  const enc = new TextEncoder();
  raw.prepare(
    `INSERT INTO hr_document (id, staff_id, kind, title, filename, mime, bytes, content, parts, uploaded_by)
     VALUES (42, ?, 'id', 'ID', 'card.png', 'image/png', 9, ?, 3, 'test')`,
  ).run(staffId, enc.encode('one'));
  raw.prepare('INSERT INTO hr_document_part (document_id, seq, content) VALUES (42, 2, ?), (42, 1, ?)')
    .run(enc.encode('three'), enc.encode('two'));

  const { parts } = await backupParts(db);
  assert.equal(text(part(parts, 'files/hr_document/42-card.png').bytes), 'onetwothree');
  assert.ok(!part(parts, 'tables/hr_document_part.csv'), 'the parts table is folded into the file');
});

test('bytes handed over as a plain array, the way D1 does, are still a file', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO rec_candidate (id, name) VALUES (1, 'Ama')").run();
  raw.prepare(
    `INSERT INTO rec_file (id, candidate_id, kind, title, filename, mime, bytes, content, uploaded_by)
     VALUES (7, 1, 'cv', 'CV', 'cv.pdf', 'application/pdf', 3, ?, 'test')`,
  ).run(new TextEncoder().encode('abc'));
  const shaped = {
    prepare: (sql) => {
      const st = db.prepare(sql);
      const wrap = (r) => (r && r.content instanceof Uint8Array ? { ...r, content: [...r.content] } : r);
      return {
        bind: (...a) => { const b = st.bind(...a); return { ...b, all: async () => ({ results: (await b.all()).results.map(wrap) }), first: async () => wrap(await b.first()), run: b.run }; },
        all: async () => ({ results: (await st.all()).results.map(wrap) }),
        first: async () => wrap(await st.first()),
        run: st.run,
      };
    },
  };
  const { parts } = await backupParts(shaped);
  assert.equal(text(part(parts, 'files/rec_file/7-cv.pdf').bytes), 'abc');
});

test('the zip holds every part and the route hands it over as a download, recorded', async () => {
  const { raw, db } = setup();
  const { bytes, manifest } = await backupZip(db, { now: '2026-09-02T00:30:00Z' });
  const names = entriesOf(bytes);
  assert.equal(names[0], 'manifest.json');
  assert.ok(names.includes('tables/att_staff.csv'));
  assert.ok(names.includes('README.txt'));
  assert.equal(names.length, Object.keys(manifest.tables).length + 2 + manifest.files);

  const res = await backup({
    db, env: {}, url: new URL('https://x/api/data/backup'),
    session: { user: { id: 1, name: 'Kwame', role: 'admin' } },
  });
  assert.equal(res.headers.get('Content-Type'), 'application/zip');
  assert.match(res.headers.get('Content-Disposition'), /hive-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip/);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(body[0], 0x50);
  assert.equal(body[1], 0x4b);

  const logged = raw.prepare("SELECT action, detail FROM audit_log WHERE action = 'data.backup'").get();
  assert.ok(logged, 'taking a copy is on the audit log');
  assert.match(logged.detail, /"tables":\d+/);
});

test('the nightly copy writes one object a day to the bucket and keeps thirty', async () => {
  const { db } = setup();
  const store = new Map();
  for (let i = 1; i <= 31; i += 1) store.set(`hive/2026-08-${String(i).padStart(2, '0')}.zip`, new Uint8Array(1));
  const bucket = {
    async put(key, value) { store.set(key, value); },
    async list({ prefix }) { return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key) { store.delete(key); },
  };

  const out = await nightlyCopy(db, bucket, { today: '2026-09-01', property: 'Somewhere Nice' });
  assert.equal(out.written, true);
  assert.equal(out.key, 'hive/2026-09-01.zip');
  assert.ok(out.bytes > 1000);
  assert.equal(out.dropped, 2, 'thirty-two copies, thirty kept');
  assert.equal(store.size, 30);
  assert.ok(!store.has('hive/2026-08-01.zip'));
  assert.ok(store.has('hive/2026-09-01.zip'));

  const none = await nightlyCopy(db, null, { today: '2026-09-01' });
  assert.equal(none.written, false);
});
