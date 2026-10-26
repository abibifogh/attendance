import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';

import {
  issueContract, listTemplates, personParticulars, previewTemplate, saveTemplate,
} from '../src/routes/people.js';
import { blockText, readKeys, splitParticulars } from '../src/lib/particulars.js';
import { splitParticulars as splitOnPage, flowParagraphs } from '../public/js/contract-flow.js';
import { contractPdf } from '../src/lib/signed-pdf.js';
import { hashBody } from '../src/lib/people.js';

/**
 * Which of the employee's details a contract shows: a tick list on the
 * template, changeable for one person when it is issued, written into the
 * words as a box at the start so it is signed with everything else.
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM hr_template;');
  raw.prepare(`INSERT INTO att_staff (id, employee_no, name, department, job_title, hired_on)
               VALUES (1, 'T01', 'Kojo Example', 'Kitchen', 'Cook', '2026-11-02')`).run();
  raw.prepare(`INSERT INTO hr_profile (staff_id, id_type, id_number, address_line, town, ssnit_number, personal_phone, date_of_birth)
               VALUES (1, 'Ghana Card', 'GHA-000000000-0', '1 Test Street', 'Accra', 'TEST-SSNIT-1', '0240000000', '1999-01-02')`).run();
  raw.prepare(`INSERT INTO hr_contact (staff_id, kind, name, relationship, phone) VALUES (1, 'next_of_kin', 'Esi Example', 'Sister', '0200000000')`).run();
  return { raw, db: d1(raw) };
}

const ctx = (db, body = null) => ({
  db,
  env: {},
  url: new URL('https://staff.example.com/api/hr'),
  session: { user: { id: 1, name: 'Office', role: 'admin' }, permissions: ['hr_view', 'hr_manage'] },
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
});
const read = async (res) => res.json();

test('the keys are cleaned: known ones, in order, full name first whenever any', () => {
  assert.deepEqual(readKeys(['ssnit_number', 'nonsense', 'employee_no']), ['name', 'employee_no', 'ssnit_number']);
  assert.deepEqual(readKeys('["home_address"]'), ['name', 'home_address']);
  assert.deepEqual(readKeys([]), []);
  assert.deepEqual(readKeys(null), []);
});

test('the box reads back out of the words the same way on the server and on the page', () => {
  const text = `${blockText([{ label: 'Full name', value: 'Kojo Example' }, { label: 'Date of birth', value: null }])}1. TERMS\n\nWords.`;
  assert.match(text, /^EMPLOYEE PARTICULARS\nFull name: Kojo Example\nDate of birth: To be given\n\n1\. TERMS/);
  const server = splitParticulars(text);
  const page = splitOnPage(text);
  assert.deepEqual(server, page);
  assert.deepEqual(server.rows, [{ label: 'Full name', value: 'Kojo Example' }, { label: 'Date of birth', value: 'To be given' }]);
  assert.equal(server.rest, '1. TERMS\n\nWords.');
  assert.deepEqual(splitParticulars('No box here.'), { rows: [], rest: 'No box here.' });
  assert.deepEqual(flowParagraphs(server.rest), ['1. TERMS', 'Words.']);
});

test('a template keeps its ticks, and issuing writes the box into the signed words', async () => {
  const { raw, db } = setup();
  const made = await read(await saveTemplate(ctx(db, {
    name: 'Contract', kind: 'contract', body: 'Between the Company and {{name}}.',
    particulars: ['employee_no', 'id_document', 'home_address', 'ssnit_number', 'next_of_kin', 'tin_number'],
  })));
  const listed = await read(await listTemplates(ctx(db)));
  assert.deepEqual(listed.rows[0].particulars, ['name', 'employee_no', 'id_document', 'home_address', 'ssnit_number', 'tin_number', 'next_of_kin']);
  assert.ok(listed.details.some((d) => d.key === 'paid_into' && d.private));

  const out = await read(await issueContract(ctx(db, { templateId: made.id }), 1));
  const c = raw.prepare('SELECT * FROM hr_contract WHERE id = ?').get(out.id);
  assert.equal(c.body, [
    'EMPLOYEE PARTICULARS',
    'Full name: Kojo Example',
    'Employee number: T01',
    'ID document: Ghana Card GHA-000000000-0',
    'Home address: 1 Test Street, Accra',
    'SSNIT number: TEST-SSNIT-1',
    'TIN: To be given',
    'Next of kin: Esi Example, Sister, 0200000000',
    '',
    'Between the Company and Kojo Example.',
  ].join('\n'));
  assert.equal(c.body_hash, await hashBody(c.body), 'the box is fingerprinted with the words');
  assert.deepEqual(JSON.parse(c.particulars).find((r) => r.key === 'tin_number'), { key: 'tin_number', label: 'TIN', given: false });
});

test('the office can change the details for one person when it issues', async () => {
  const { raw, db } = setup();
  const made = await read(await saveTemplate(ctx(db, {
    name: 'Contract', kind: 'contract', body: 'Words.', particulars: ['ssnit_number'],
  })));
  const changed = await read(await issueContract(ctx(db, { templateId: made.id, particulars: ['date_of_birth', 'personal_phone'] }), 1));
  assert.match(raw.prepare('SELECT body FROM hr_contract WHERE id = ?').get(changed.id).body,
    /^EMPLOYEE PARTICULARS\nFull name: Kojo Example\nDate of birth: 2 January 1999\nMobile: 0240000000\n\nWords\.$/);
  const none = await read(await issueContract(ctx(db, { templateId: made.id, particulars: [] }), 1));
  assert.equal(raw.prepare('SELECT body FROM hr_contract WHERE id = ?').get(none.id).body, 'Words.', 'unticking them all leaves no box');

  const plain = await read(await saveTemplate(ctx(db, { name: 'No box', kind: 'contract', body: 'Just words.' })));
  const issued = await read(await issueContract(ctx(db, { templateId: plain.id }), 1));
  assert.equal(raw.prepare('SELECT body FROM hr_contract WHERE id = ?').get(issued.id).body, 'Just words.', 'a template with no ticks is as before');
});

test('the issue dialog is told every detail and what their record holds', async () => {
  const { db } = setup();
  const out = await read(await personParticulars(ctx(db), 1));
  const by = Object.fromEntries(out.details.map((d) => [d.key, d.value]));
  assert.equal(by.name, 'Kojo Example');
  assert.equal(by.start_date, '2 November 2026');
  assert.equal(by.tin_number, null);
  assert.equal(by.paid_into, null);
});

test('the preview shows the box, with a sample person’s private details marked', async () => {
  const { db } = setup();
  const sample = await read(await previewTemplate(ctx(db, { body: 'Words.', particulars: ['employee_no', 'ssnit_number'] })));
  assert.equal(sample.body, 'EMPLOYEE PARTICULARS\nFull name: Ama Sample\nEmployee number: SAMPLE-01\nSSNIT number: [SSNIT number]\n\nWords.');
  const real = await read(await previewTemplate(ctx(db, { body: 'Words.', particulars: ['ssnit_number'], staffId: 1 })));
  assert.match(real.body, /SSNIT number: TEST-SSNIT-1/);
});

test('the signed PDF draws the box without dropping a page', async () => {
  const base = {
    title: 'Contract', body_hash: 'ab', staff_name: 'Kojo Example', signer_name: 'Kojo Example',
    signed_at: '2026-11-01 09:00:00', employer_name: 'Office', employer_at: '2026-11-01 10:00:00',
  };
  const boxed = await contractPdf({
    contract: { ...base, body: 'EMPLOYEE PARTICULARS\nFull name: Kojo Example\nSSNIT number: To be given\n\nWords.' },
    property: 'x', reference: 'HR-C-00001', verifyUrl: 'https://staff.example.com/verify',
  });
  const plain = await contractPdf({ contract: { ...base, body: 'Words.' }, property: 'x', reference: 'HR-C-00001', verifyUrl: 'https://staff.example.com/verify' });
  assert.equal((await PDFDocument.load(boxed)).getPageCount(), (await PDFDocument.load(plain)).getPageCount());
});
