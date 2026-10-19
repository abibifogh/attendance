import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';

import { issueToMany } from '../src/routes/people.js';
import { createLetter } from '../src/routes/correspondence.js';
import { letterPdf } from '../src/lib/signed-pdf.js';
import { MARKER, placeFor } from '../public/js/pdf-markers.js';

/** One document to several people; places to sign marked in the document itself. */

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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff;');
  for (const [id, name, active] of [[1, 'First Person', 1], [2, 'Second Person', 1], [3, 'Gone Person', 0]]) {
    raw.prepare("INSERT INTO att_staff (id, employee_no, name, hired_on, active) VALUES (?, ?, ?, '2026-01-01', ?)").run(id, String(id), name, active);
  }
  raw.prepare("INSERT INTO hr_template (id, name, kind, body) VALUES (50, 'Confidentiality', 'policy', 'I, {{name}}, will keep things confidential.')").run();
  return { raw, db: d1(raw) };
}

const OFFICE = { user: { id: 9, name: 'Office', role: 'manager' }, permissions: ['hr_manage', 'corr_write'] };
const ctx = (db, body = {}) => ({
  db, env: {}, url: new URL('https://x/api/x'), session: OFFICE, executionContext: null,
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const read = async (r) => r.json();

test('one document to several people: each their own copy, on their own link', async () => {
  const { raw, db } = setup();
  const out = await read(await issueToMany(ctx(db, { templateId: 50, staffIds: [1, 2, 3] })));
  assert.equal(out.issued, 2);
  const contracts = raw.prepare('SELECT staff_id, body, status FROM hr_contract ORDER BY staff_id').all();
  assert.deepEqual(contracts.map((c) => c.staff_id), [1, 2]);
  assert.match(contracts[0].body, /I, First Person,/, 'filled in with their own particulars');
  assert.match(contracts[1].body, /I, Second Person,/);
  assert.ok(contracts.every((c) => c.status === 'sent'));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_invite').get().n, 2, 'a link each');
  assert.equal(out.results.find((r) => r.staffId === 3).ok, false, 'not somebody who has left');
  assert.ok(out.results.filter((r) => r.ok).every((r) => r.url), 'links to copy, since nothing could be sent here');
});

test('a marker becomes a place to sign, on its baseline', () => {
  assert.deepEqual([...'Sign here [sign:1] and [date:2]'.matchAll(MARKER)].map((m) => [m[1], m[2]]), [['sign', '1'], ['date', '2']]);
  const place = placeFor({ kind: 'sign', signer: '1', x: 100, y: 200, pageWidth: 600, pageHeight: 800 });
  assert.equal(place.field, 'signature');
  assert.equal(place.signer, 1);
  assert.equal(place.x, 16.67);
  // 200pt up from the bottom of an 800pt page is 75% down; the box rises above it.
  assert.ok(place.y < 75 && place.y > 65);
});

test('an uploaded letter keeps the places marked in it', async () => {
  const { raw, db } = setup();
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const content = Buffer.from(await pdf.save()).toString('base64');
  const out = await read(await createLetter(ctx(db, {
    series: 'ADM', subject: 'Agreement', filename: 'a.pdf', mime: 'application/pdf', content,
    fields: [{ page: 1, x: 10, y: 70, w: 28, h: 6, signer: 1, field: 'signature' }],
  })));
  const layout = JSON.parse(raw.prepare('SELECT layout FROM corr_letter WHERE id = ?').get(out.id).layout);
  assert.equal(layout.blocks.length, 1);
  assert.equal(layout.blocks[0].role, 'field');
  assert.equal(layout.blocks[0].signer, 1);
});

test('the signed copy puts each signature where it was marked, with no extra page', async () => {
  const original = await PDFDocument.create();
  original.addPage([595, 842]);
  const bytes = await letterPdf({
    letter: { reference: 'SN/1', subject: 'Agreement', source: 'uploaded' },
    recipients: [{ seq: 1, role: 'signer', name: 'A', signer_name: 'A Signer', status: 'signed', signed_at: '2026-10-03 08:00:00' }],
    property: 'Somewhere Nice',
    verifyUrl: 'https://x/verify',
    original: await original.save(),
    layout: { blocks: [{ role: 'field', page: 1, x: 10, y: 70, w: 28, h: 6, signer: 1, field: 'signature' }], pages: 1 },
  });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2, 'their page, signed where marked, and the certificate');
});
