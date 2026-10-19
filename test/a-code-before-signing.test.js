import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createInvite, issueContract } from '../src/routes/people.js';
import { inviteOpen, inviteRequestCode, inviteSign } from '../src/routes/invite.js';
import { sendForSignature } from '../src/routes/correspondence.js';
import { signDocument, signOpen, signRequestCode } from '../src/routes/sign.js';

/**
 * A six-digit code to the signer's own email or phone before they sign, by
 * default, wherever HIVE can send one.
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

function setup({ email = 'new@example.com', mail = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM hr_profile;');
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on, active) VALUES (1, '1', 'New Starter', '2026-10-01', 1)",
  ).run();
  raw.prepare('INSERT INTO hr_profile (staff_id, personal_email) VALUES (1, ?)').run(email);
  if (mail) {
    raw.prepare("INSERT INTO settings (key, value) VALUES ('email_from', 'hive@example.com') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  }
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { raw, db: d1(raw), sent, restore: () => { globalThis.fetch = real; } };
}

const OFFICE = { user: { id: 9, name: 'Office', role: 'manager' }, permissions: ['hr_manage', 'corr_write'] };
const ENV = { RESEND_API_KEY: 'k' };
const ctx = (db, session, body = {}) => ({
  db,
  env: ENV,
  url: new URL('https://x/api/x'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
});
const read = async (r) => r.json();
const tokenOf = (url) => String(url).split('/').pop();
const codeIn = (mail) => /(\d{6}) is your code/.exec(mail.subject)?.[1];

async function aContractLink(db) {
  const c = await read(await issueContract(ctx(db, OFFICE, { body: 'The words', title: 'Contract' }), 1));
  const link = await read(await createInvite(ctx(db, OFFICE, { wantsDetails: false, contractIds: [c.id] }), 1));
  return { c, token: tokenOf(link.url) };
}

test('a contract asks for a code sent to their own email before it is signed', async () => {
  const { raw, db, sent, restore } = setup();
  try {
    const { c, token } = await aContractLink(db);
    const packet = await read(await inviteOpen(ctx(db, null), token));
    assert.equal(packet.signCode.required, true);
    assert.match(packet.signCode.hint, /@example\.com/);
    assert.ok(!packet.signCode.hint.includes('new@'), 'the address is masked');

    await assert.rejects(
      inviteSign(ctx(db, null, { contractId: c.id, agreed: true, name: 'New Starter' }), token),
      /six-digit code/,
    );
    assert.equal(raw.prepare('SELECT status FROM hr_contract').get().status, 'sent', 'nothing signed');

    await inviteRequestCode(ctx(db, null), token);
    const code = codeIn(sent.at(-1));
    assert.ok(code, 'a code went out');
    assert.equal(sent.at(-1).cc, undefined, 'and was copied to nobody');

    await assert.rejects(
      inviteSign(ctx(db, null, { contractId: c.id, agreed: true, name: 'New Starter', otp: '000000' === code ? '111111' : '000000' }), token),
      /not right/,
    );
    await inviteSign(ctx(db, null, { contractId: c.id, agreed: true, name: 'New Starter', otp: code }), token);
    const signed = raw.prepare('SELECT * FROM hr_contract').get();
    assert.equal(signed.status, 'signed');
    assert.equal(signed.signer_check, 'email code');
  } finally { restore(); }
});

test('with nothing on file to send a code to, the link itself is the check', async () => {
  const { raw, db, restore } = setup({ email: null });
  try {
    const { c, token } = await aContractLink(db);
    const packet = await read(await inviteOpen(ctx(db, null), token));
    assert.equal(packet.signCode.required, false);
    await inviteSign(ctx(db, null, { contractId: c.id, agreed: true, name: 'New Starter' }), token);
    assert.equal(raw.prepare('SELECT status FROM hr_contract').get().status, 'signed');
  } finally { restore(); }
});

test('a property can turn the code off', async () => {
  const { raw, db, restore } = setup();
  try {
    raw.prepare("INSERT INTO settings (key, value) VALUES ('hr_require_otp', '0') ON CONFLICT (key) DO UPDATE SET value = '0'").run();
    const { c, token } = await aContractLink(db);
    await inviteSign(ctx(db, null, { contractId: c.id, agreed: true, name: 'New Starter' }), token);
    assert.equal(raw.prepare('SELECT status FROM hr_contract').get().status, 'signed');
  } finally { restore(); }
});

test('a letter asks for an emailed code before it is signed', async () => {
  const { raw, db, sent, restore } = setup();
  try {
    raw.prepare(
      "INSERT INTO corr_letter (id, reference, subject, source, status) VALUES (1, 'SN/1', 'Agreement', 'uploaded', 'draft')",
    ).run();
    const out = await read(await sendForSignature(ctx(db, OFFICE, {
      deliver: false, recipients: [{ name: 'Signer', email: 'signer@example.com', code: false }],
    }), 1));
    const token = tokenOf(out.recipients[0].url);
    const packet = await read(await signOpen(ctx(db, null, {}), token));
    assert.equal(packet.otpRequired, true);

    await assert.rejects(signDocument(ctx(db, null, { agreed: true, name: 'The Signer' }), token), /six-digit code/);
    await signRequestCode(ctx(db, null), token);
    const code = codeIn(sent.at(-1));
    await signDocument(ctx(db, null, { agreed: true, name: 'The Signer', otp: code }), token);
    const r = raw.prepare('SELECT * FROM corr_recipient').get();
    assert.equal(r.status, 'signed');
    assert.equal(r.signer_check, 'email code');
  } finally { restore(); }
});
