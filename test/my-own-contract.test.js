import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { myContract, myContractFile, myContracts } from '../src/routes/me.js';
import { getContract } from '../src/routes/people.js';
import { hashBody } from '../src/lib/people.js';

/**
 * A member of staff reading their own contract.
 *
 * The office could open a signed contract, read the certificate under it and
 * print the lot from the day signing was built. The person who signed it could
 * not: they saw the words once, on a link that expires, and after that the
 * only copy of their own employment contract was on somebody else's screen.
 *
 * Two things have to be true of the copy they get. It has to be the SAME
 * document, certificate and all, because a staff copy worth less than the
 * office copy is not worth carrying to a bank. And it has to be THEIRS ONLY,
 * because the route is reached with nothing but a staff login and the number
 * of a contract, and guessing a number is not hard.
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

const WORDS = 'This agreement is made between the property and the employee.';

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_staff; DELETE FROM users;`);
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1001', 'Ama Boateng', 'Housekeeping', '2020-01-01'),
            (2, '1002', 'Kofi Mensah', 'Security', '2021-01-01')`,
  ).run();

  const hash = await hashBody(WORDS);
  // Ama's, signed, with the property's countersignature under it.
  raw.prepare(
    `INSERT INTO hr_contract (id, staff_id, title, body, body_hash, status, issued_by, issued_at,
                              opened_at, signed_at, signer_name, signer_ip, signer_agent,
                              employer_name, employer_at)
     VALUES (10, 1, 'Contract of employment', ?, ?, 'signed', 'Yaa (manager)',
             '2026-01-04 09:00:00', '2026-01-05 07:10:00', '2026-01-05 07:14:00',
             'Ama Boateng', '154.160.4.2', 'Mozilla/5.0 (Linux; Android 13)',
             'Yaa Owusu', '2026-01-06 11:00:00')`,
  ).run(WORDS, hash);
  // Ama's, still waiting on her.
  raw.prepare(
    `INSERT INTO hr_contract (id, staff_id, title, body, body_hash, status, issued_at)
     VALUES (11, 1, 'Revised terms', ?, ?, 'sent', '2026-06-01 09:00:00')`,
  ).run(WORDS, hash);
  // Kofi's, signed. Not Ama's business.
  raw.prepare(
    `INSERT INTO hr_contract (id, staff_id, title, body, body_hash, status, signed_at, signer_name)
     VALUES (12, 2, 'Contract of employment', ?, ?, 'signed', '2026-02-02 08:00:00', 'Kofi Mensah')`,
  ).run(WORDS, hash);

  raw.prepare(
    `INSERT INTO hr_event (staff_id, contract_id, kind, detail, ip)
     VALUES (1, 10, 'contract_issued', 'Contract of employment', '41.66.1.9'),
            (1, 10, 'link_opened', NULL, '154.160.4.2'),
            (1, 10, 'contract_viewed', NULL, '154.160.4.2'),
            (1, 10, 'signed', 'Ama Boateng', '154.160.4.2')`,
  ).run();

  return { raw, db: d1(raw) };
}

const asStaff = (staffId) => ({
  user: { id: 100 + staffId, name: 'x', role: 'staff', staff_id: staffId },
  permissions: ['att_me'],
});
const OFFICE = { user: { id: 9, name: 'Yaa', role: 'manager' }, permissions: ['hr_view'] };

const ctx = (db, session, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/contracts${query}`),
  session,
  executionContext: null,
  request: new Request(`https://x/api/me/contracts${query}`),
});

const read = async (response) => response.json();

// ---------------------------------------------------------------------------
// What is on the list
// ---------------------------------------------------------------------------

test('their own signed contract is on the list, and the unsigned one is not', async () => {
  const { db } = await setup();
  const out = await read(await myContracts(ctx(db, asStaff(1))));

  assert.deepEqual(out.contracts.map((c) => c.id), [10]);
  assert.equal(out.me.name, 'Ama Boateng');
  assert.equal(out.me.employeeNo, '1001');
});

test('a colleague’s contract is on nobody else’s list', async () => {
  const { db } = await setup();
  const out = await read(await myContracts(ctx(db, asStaff(2))));
  assert.deepEqual(out.contracts.map((c) => c.id), [12]);
});

test('the list carries what is needed to tell two of them apart', async () => {
  const { db } = await setup();
  const [row] = (await read(await myContracts(ctx(db, asStaff(1))))).contracts;

  assert.equal(row.title, 'Contract of employment');
  assert.equal(row.signed_at, '2026-01-05 07:14:00');
  assert.equal(row.origin, 'electronic');
  assert.equal(row.employer_at, '2026-01-06 11:00:00');
});

// ---------------------------------------------------------------------------
// The document, and that it is the same one
// ---------------------------------------------------------------------------

test('what they get is what the office gets, down to the event chain', async () => {
  const { db } = await setup();
  const theirs = await read(await myContract(ctx(db, asStaff(1)), 10));
  const office = await read(await getContract(ctx(db, OFFICE), 10));

  // Not "similar to". A second rendering of a contract is a second contract.
  assert.deepEqual(theirs, office);
});

test('the certificate is all there: fingerprint, signature, address, chain', async () => {
  const { db } = await setup();
  const { contract, events } = await read(await myContract(ctx(db, asStaff(1)), 10));

  assert.equal(contract.body, WORDS);
  assert.equal(contract.body_hash, await hashBody(WORDS));
  assert.equal(contract.intact, true, 'the hash is recomputed, not repeated');
  assert.equal(contract.signer_name, 'Ama Boateng');
  assert.equal(contract.signer_ip, '154.160.4.2');
  assert.equal(contract.employer_name, 'Yaa Owusu');
  assert.deepEqual(events.map((e) => e.kind),
    ['contract_issued', 'link_opened', 'contract_viewed', 'signed']);
});

test('words changed after signing show as no longer matching', async () => {
  const { raw, db } = await setup();
  raw.prepare("UPDATE hr_contract SET body = 'Something else entirely' WHERE id = 10").run();

  const { contract } = await read(await myContract(ctx(db, asStaff(1)), 10));
  assert.equal(contract.intact, false);
});

// ---------------------------------------------------------------------------
// Whose it is
// ---------------------------------------------------------------------------

test('a colleague’s contract is not readable by its number', async () => {
  const { db } = await setup();
  await assert.rejects(() => myContract(ctx(db, asStaff(1)), 12), /No such contract of yours/);
});

test('their own unsigned contract is not readable here either', async () => {
  // It is not a record of anything yet, and it is already in front of them on
  // the link that carries it.
  const { db } = await setup();
  await assert.rejects(() => myContract(ctx(db, asStaff(1)), 11), /No such contract of yours/);
});

test('a login with no staff record behind it gets nothing', async () => {
  const { db } = await setup();
  const orphan = { user: { id: 7, name: 'Desk', role: 'staff', staff_id: null }, permissions: ['att_me'] };
  await assert.rejects(() => myContracts(ctx(db, orphan)), /not linked to a staff record/);
});

// ---------------------------------------------------------------------------
// The ones signed on paper
// ---------------------------------------------------------------------------

test('a paper contract downloads as the scan it is', async () => {
  const { raw, db } = await setup();
  raw.prepare(
    `INSERT INTO hr_document (id, staff_id, kind, title, filename, mime, content, bytes, parts)
     VALUES (50, 1, 'contract', 'Signed contract', 'ama-contract.pdf', 'application/pdf', ?, 4, 1)`,
  ).run(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  raw.prepare(
    `UPDATE hr_contract SET origin = 'paper', document_id = 50 WHERE id = 10`,
  ).run();

  // Inline by default, because the page embeds it: a scan behind a download is
  // a scan nobody looks at.
  const shown = await myContractFile(ctx(db, asStaff(1)), 10);
  assert.equal(shown.headers.get('Content-Type'), 'application/pdf');
  assert.match(shown.headers.get('Content-Disposition'), /^inline; filename="ama-contract\.pdf"$/);
  assert.equal(new Uint8Array(await shown.arrayBuffer()).length, 4);

  // And an attachment when the Download link asks for one, because a phone
  // handed an inline PDF opens a viewer and never saves it.
  const saved = await myContractFile(ctx(db, asStaff(1), '?download=1'), 10);
  assert.match(saved.headers.get('Content-Disposition'), /^attachment; filename="ama-contract\.pdf"$/);
});

test('the scan on somebody else’s contract is not theirs to fetch', async () => {
  const { raw, db } = await setup();
  raw.prepare(
    `INSERT INTO hr_document (id, staff_id, kind, title, filename, mime, content, bytes, parts)
     VALUES (51, 2, 'contract', 'Signed contract', 'kofi.pdf', 'application/pdf', ?, 1, 1)`,
  ).run(new Uint8Array([0x25]));
  raw.prepare("UPDATE hr_contract SET origin = 'paper', document_id = 51 WHERE id = 12").run();

  await assert.rejects(() => myContractFile(ctx(db, asStaff(1)), 12), /No such contract of yours/);
});

test('asking for a file on a contract that has none says so', async () => {
  const { db } = await setup();
  await assert.rejects(() => myContractFile(ctx(db, asStaff(1)), 10), /no file on this one/);
});
