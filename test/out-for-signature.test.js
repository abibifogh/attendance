import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { checkBeforeSending, correctRecipient, sendForSignature } from '../src/routes/correspondence.js';
import { signingBoard } from '../src/routes/signing.js';
import { inboxList } from '../src/routes/approvals.js';

/** Out for signature: checked before it goes, tracked in one place, put right after. */

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
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, hired_on, active) VALUES (1, '1', 'New Starter', '2026-10-01', 1)").run();
  raw.prepare(
    "INSERT INTO corr_letter (id, reference, subject, source, status) VALUES (1, 'SN/1', 'Agreement', 'uploaded', 'draft')",
  ).run();
  return { raw, db: d1(raw) };
}

const OFFICE = { user: { id: 9, name: 'Office', role: 'manager' }, permissions: ['hr_view', 'hr_manage', 'corr_view', 'corr_write'] };
const ctx = (db, body = {}) => ({
  db, env: {}, url: new URL('https://x/api/x'), session: OFFICE, executionContext: null,
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const read = async (r) => r.json();

test('nobody to sign, or two signers on one address, is refused before anything goes', () => {
  assert.throws(() => checkBeforeSending({}, [{ name: 'A', role: 'copy' }]), /at least one of them a signer/);
  assert.throws(() => checkBeforeSending({}, [
    { name: 'A', email: 'same@example.com' }, { name: 'B', email: 'SAME@example.com' },
  ]), /same email address/);
  assert.doesNotThrow(() => checkBeforeSending({}, [{ name: 'A', email: 'a@example.com' }]));
});

test('every signer needs a place on a letter that has places, and every place a signer', () => {
  const letter = { layout: JSON.stringify({ blocks: [{ role: 'field', signer: 1 }, { role: 'field', signer: 2 }] }) };
  assert.throws(() => checkBeforeSending(letter, [{ name: 'A' }]), /place for person 2/);
  assert.throws(() => checkBeforeSending(letter, [{ name: 'A' }, { name: 'B', role: 'copy' }]), /copied in, but the letter has a place/);
  assert.throws(() => checkBeforeSending({ layout: JSON.stringify({ blocks: [{ role: 'field', signer: 1 }] }) },
    [{ name: 'A' }, { name: 'B' }]), /B has no place to sign/);
  assert.doesNotThrow(() => checkBeforeSending(letter, [{ name: 'A' }, { name: 'B' }]));
});

test('a wrong address is put right, and the old link stops working', async () => {
  const { raw, db } = setup();
  await sendForSignature(ctx(db, { deliver: false, recipients: [{ name: 'Signer', email: 'wrong@example.com' }] }), 1);
  const before = raw.prepare('SELECT * FROM corr_recipient').get();
  const out = await read(await correctRecipient(ctx(db, { email: 'right@example.com' }), before.id));
  const after = raw.prepare('SELECT * FROM corr_recipient').get();
  assert.equal(after.email, 'right@example.com');
  assert.notEqual(after.token_hash, before.token_hash, 'a fresh link');
  assert.ok(out.url, 'shown to copy, since email is not set up here');
  assert.ok(raw.prepare("SELECT 1 FROM corr_event WHERE kind = 'address_corrected'").get());
  await assert.rejects(correctRecipient(ctx(db, { email: 'not an address' }), before.id), /does not look right/);
});

test('one board: waiting on us, with others, done and stopped', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO hr_contract (id, staff_id, title, body, body_hash, status, signed_at, signer_name)
     VALUES (1, 1, 'Contract', 'w', 'h', 'signed', '2026-10-02 09:00:00', 'New Starter'),
            (2, 1, 'Policy', 'w', 'h', 'sent', NULL, NULL)`,
  ).run();
  await sendForSignature(ctx(db, { deliver: false, recipients: [{ name: 'Signer', email: 's@example.com' }] }), 1);

  const board = await read(await signingBoard(ctx(db)));
  assert.deepEqual(board.waitingOnUs.map((r) => r.status), ['To countersign']);
  assert.deepEqual(board.withOthers.map((r) => `${r.kind}:${r.status}`).sort(), ['contract:Sent', 'letter:Sent']);
});

test('a contract to countersign is in the Inbox, with a way to open it', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO hr_contract (id, staff_id, title, body, body_hash, status, signed_at, signer_name)
     VALUES (1, 1, 'Contract', 'w', 'h', 'signed', '2026-10-02 09:00:00', 'New Starter')`,
  ).run();
  const runAs = async () => { throw new Error('not used'); };
  const out = await read(await inboxList(ctx(db), runAs));
  const item = out.items.find((i) => i.kind === 'countersign');
  assert.ok(item);
  assert.equal(item.link, '#/contract?id=1');
  assert.deepEqual(item.decisions, []);
});
