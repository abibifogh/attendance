import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';

import { contractPdf, fingerprint, letterPdf, plain } from '../src/lib/signed-pdf.js';
import { contractCopy, letterCopy, signedContract, verify } from '../src/routes/signed-copies.js';

/**
 * The finished, signed copy: a PDF with the signatures on it and a
 * certificate at the back, whose fingerprint anybody can check.
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
  raw.exec('DELETE FROM att_staff;');
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, hired_on, active) VALUES (1, '1', 'New Starter', '2026-10-01', 1)").run();
  return { raw, db: d1(raw) };
}

const OFFICE = { user: { id: 9, name: 'Office', role: 'manager' }, permissions: ['hr_view', 'hr_manage', 'corr_view'] };
const ctx = (db, body = null, query = '') => ({
  db,
  env: {},
  url: new URL(`https://staff.example.com/api/x${query}`),
  session: OFFICE,
  executionContext: null,
  request: new Request('https://x/', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: body ? JSON.stringify(body) : undefined,
  }),
});

// A one-pixel PNG, as a signature.
const INK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const signedContractRow = (raw, { employer = true } = {}) => raw.prepare(
  `INSERT INTO hr_contract (id, staff_id, title, body, body_hash, status, signed_at, signer_name, signature_ink,
                            signer_ip, signer_check, employer_name, employer_ink, employer_at)
   VALUES (1, 1, 'Contract of employment', 'Clause one.\nClause two — paid monthly in ₵.', 'abc123', 'signed',
           '2026-10-02 09:00:00', 'New Starter', ?1, '1.2.3.4', 'email code', ?2, ?3, ?4)`,
).run(INK, employer ? 'Office Person' : null, employer ? INK : null, employer ? '2026-10-02 10:00:00' : null);

test('words the built-in faces cannot draw are mapped, not left to break the file', () => {
  assert.equal(plain('a — b ’c’ ₵5'), "a - b 'c' GHS 5");
  assert.equal(plain('ok ✓'), 'ok ?');
});

test('a signed contract becomes a PDF with a certificate at the back', async () => {
  const bytes = await contractPdf({
    contract: {
      title: 'Contract', body: 'A short contract.', body_hash: 'abc', staff_name: 'New Starter',
      signer_name: 'New Starter', signed_at: '2026-10-02 09:00:00', signature_ink: INK, signer_check: 'email code',
      employer_name: 'Office', employer_at: '2026-10-02 10:00:00', employer_ink: INK,
    },
    property: 'Somewhere Nice',
    reference: 'HR-C-00001',
    verifyUrl: 'https://staff.example.com/verify',
    events: [{ at: '2026-10-02 09:00:00', what: 'Signed', ip: '1.2.3.4' }],
  });
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 2, 'the contract and its certificate');
  assert.equal(doc.getProducer(), 'HIVE');
  assert.match(await fingerprint(bytes), /^[0-9a-f]{64}$/);
});

test('the copy is made once both sides have signed, kept, and checks as genuine', async () => {
  const { raw, db } = setup();
  signedContractRow(raw);
  const res = await contractCopy(ctx(db, null, '?download=1'), '1');
  assert.equal(res.headers.get('Content-Type'), 'application/pdf');
  assert.match(res.headers.get('Content-Disposition'), /attachment/);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const row = raw.prepare('SELECT final_hash, final_document_id FROM hr_contract').get();
  assert.equal(row.final_hash, await fingerprint(bytes));
  assert.ok(row.final_document_id, 'kept on their record');

  // The same file is handed out every time.
  const again = new Uint8Array(await (await contractCopy(ctx(db), '1')).arrayBuffer());
  assert.equal(await fingerprint(again), row.final_hash);

  const checked = await (await verify(ctx(db, { hash: row.final_hash }))).json();
  assert.equal(checked.genuine, true);
  assert.equal(checked.reference, 'HR-C-00001');
  assert.match(checked.signers, /New Starter/);

  const changed = bytes.slice();
  changed[changed.length - 10] ^= 1;
  const bad = await (await verify(ctx(db, { hash: await fingerprint(changed) }))).json();
  assert.equal(bad.genuine, false);
  assert.equal(bad.title, undefined, 'and says nothing about any document');
});

test('no copy until the property has countersigned', async () => {
  const { raw, db } = setup();
  signedContractRow(raw, { employer: false });
  assert.equal(await signedContract(ctx(db), '1'), null);
  await assert.rejects(contractCopy(ctx(db), '1'), /both sides/);
});

test('an uploaded letter keeps its own pages and gains signatures and a certificate', async () => {
  const original = await PDFDocument.create();
  original.addPage([595, 842]);
  original.addPage([595, 842]);
  const bytes = await letterPdf({
    letter: { reference: 'SN/1', subject: 'Agreement', source: 'uploaded', file_hash: 'f00' },
    recipients: [{ role: 'signer', name: 'A Signer', signer_name: 'A Signer', status: 'signed', signed_at: '2026-10-03 08:00:00', signature_ink: INK }],
    property: 'Somewhere Nice',
    verifyUrl: 'https://x/verify',
    original: await original.save(),
  });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 4, 'two of theirs, a page of signatures, the certificate');
});

test('a letter has a copy once everybody has signed', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO corr_letter (id, reference, subject, source, body, body_hash, status, layout)
     VALUES (1, 'SN/2', 'Offer', 'composed', '<p>Dear you</p>', 'h', 'awaiting_signature', ?)`,
  ).run(JSON.stringify({ blocks: [
    { id: 'b1', page: 1, x: 10, y: 20, w: 80, html: '<p>Dear you, here is the offer.</p>' },
    { id: 'b2', page: 1, x: 10, y: 70, w: 30, h: 8, role: 'field', signer: 1, field: 'signature' },
  ] }));
  raw.prepare(
    "INSERT INTO corr_recipient (letter_id, seq, role, name, status) VALUES (1, 1, 'signer', 'A Signer', 'pending')",
  ).run();
  await assert.rejects(letterCopy(ctx(db), '1'), /everybody has signed/);

  raw.prepare("UPDATE corr_recipient SET status = 'signed', signed_at = '2026-10-03 08:00:00', signer_name = 'A Signer', signature_ink = ?").run(INK);
  const res = await letterCopy(ctx(db), '1');
  const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
  assert.equal(doc.getPageCount(), 2);
  assert.ok(raw.prepare('SELECT final_hash FROM corr_letter').get().final_hash);
});

test('a signed contract opens with a cover page for the company that employs them', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('company_legal_name', 'Example Hotels Ltd') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('property_name', 'Somewhere Example') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  signedContractRow(raw);
  raw.prepare(`UPDATE hr_contract SET title = 'Contract of employment — permanent', issued_at = '2026-10-01 08:00:00',
               fields = '{"job_title":"Cook","department":"Kitchen","start_date":"2026-11-02"}' WHERE id = 1`).run();

  const { contractWithTrail } = await import('../src/routes/people.js');
  const found = await contractWithTrail(db, 1);
  assert.equal(found.cover.companyName, 'Example Hotels Ltd');
  assert.equal(found.cover.tradingAs, 'Somewhere Example');
  assert.equal(found.cover.title, 'Contract of employment');
  assert.equal(found.cover.subtitle, 'Permanent');
  assert.equal(found.cover.reference, 'HR-C-00001');
  assert.equal(found.cover.issued, '2026-10-01');
  assert.equal(found.cover.hasLogo, false);
  assert.equal(found.cover.sentence,
    'made between Example Hotels Ltd and New Starter, who is employed as Cook in the Kitchen department from 2 November 2026, under the Labour Act, 2003 (Act 651).');

  const withCover = await contractPdf({
    contract: found.contract, property: 'Somewhere Example', reference: 'HR-C-00001',
    verifyUrl: 'https://staff.example.com/verify', cover: found.cover,
  });
  const without = await contractPdf({
    contract: found.contract, property: 'Somewhere Example', reference: 'HR-C-00001',
    verifyUrl: 'https://staff.example.com/verify',
  });
  assert.equal((await PDFDocument.load(withCover)).getPageCount(), (await PDFDocument.load(without)).getPageCount() + 1);

  // With a logo, it is drawn in the ring.
  const png = Uint8Array.from(atob(INK.split(',')[1]), (c) => c.charCodeAt(0));
  const logoed = await contractPdf({
    contract: found.contract, property: 'x', reference: 'HR-C-00001', verifyUrl: 'https://staff.example.com/verify',
    cover: { ...found.cover, hasLogo: true }, logo: { bytes: png, mime: 'image/png' },
  });
  assert.ok(logoed.length > withCover.length, 'the logo is embedded');

  // And the copy HIVE keeps and fingerprints has the cover too.
  const made = await signedContract(ctx(db), 1);
  assert.equal((await PDFDocument.load(made.bytes)).getPageCount(), (await PDFDocument.load(withCover)).getPageCount());
});

test('a contract for the second company has that company on its cover', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO company (id, main, legal_name, address) VALUES (7, 0, 'Second Example Ltd', '2 Example Lane') ON CONFLICT (id) DO UPDATE SET legal_name = excluded.legal_name, address = excluded.address").run();
  raw.prepare('UPDATE att_staff SET company_id = 7 WHERE id = 1').run();
  signedContractRow(raw);
  const { contractWithTrail } = await import('../src/routes/people.js');
  const found = await contractWithTrail(db, 1);
  assert.equal(found.cover.companyName, 'Second Example Ltd');
  assert.equal(found.cover.address, '2 Example Lane');
  assert.equal(found.cover.tradingAs, null);
  assert.equal(found.cover.sentence, 'made between Second Example Ltd and New Starter.');
});
