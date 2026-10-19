import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { watchReminders } from '../src/lib/reminders.js';
import { createInvite, issueContract } from '../src/routes/people.js';
import { inviteSign } from '../src/routes/invite.js';
import { sendForSignature } from '../src/routes/correspondence.js';
import { signDocument } from '../src/routes/sign.js';

/**
 * What is still waiting on somebody is chased, and the office hears when
 * something comes in.
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
  raw.exec(`DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices; DELETE FROM hr_profile;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, department, hired_on, active) VALUES (1, '1', 'New Starter', 'Kitchen', '2026-10-01', 1)",
  ).run();
  raw.prepare("INSERT INTO hr_profile (staff_id, personal_email, personal_phone) VALUES (1, 'new@example.com', '0241112222')").run();
  return { raw, db: d1(raw) };
}

const OFFICE = { user: { id: 9, name: 'Office Person', role: 'manager' }, permissions: ['hr_view', 'hr_manage', 'corr_view', 'corr_write'] };

const ctx = (db, session, body = {}, env = {}) => ({
  db,
  env,
  url: new URL('https://x/api/x'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
});
const read = async (r) => r.json();
const tokenOf = (url) => String(url).split('/').pop();

function at10(t) {
  const today = new Date().toISOString().slice(0, 10);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${today}T10:00:00Z`) });
}

/** A mail provider that accepts everything, and what it was handed. */
function mailbox(raw) {
  for (const [key, value] of [['email_from', 'hive@example.com'], ['site_url', 'https://staff.example.com']]) {
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2').run(key, value);
  }
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, restore: () => { globalThis.fetch = real; }, env: { RESEND_API_KEY: 'k' } };
}

test('a details link HIVE sent is sent again after two days, with a fresh link', async (t) => {
  const { raw, db } = setup();
  const box = mailbox(raw);
  try {
    const made = await read(await createInvite(ctx(db, OFFICE, { wantsDetails: true, sendEmail: true }, box.env), 1));
    assert.equal(made.delivered.emailed, true, 'emailed by HIVE');
    assert.equal(box.sent.length, 1);

    at10(t);
    // Not yet: it went today.
    assert.equal((await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } })).links, 0);

    raw.prepare("UPDATE hr_invite SET sent_at = datetime('now', '-3 days')").run();
    assert.equal((await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } })).links, 1);

    const rows = raw.prepare('SELECT * FROM hr_invite ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].replaced_by, rows[1].id, 'the old link is replaced');
    assert.ok(rows[0].revoked_at);
    assert.equal(rows[1].reminders, 1);
    assert.equal(box.sent.length, 2);
    assert.match(JSON.stringify(box.sent[1]), /Reminder/);

    // And not again the same day.
    assert.equal((await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } })).links, 0);
  } finally { box.restore(); }
});

test('a link opened in the last day is left alone, and a finished one is never chased', async (t) => {
  const { raw, db } = setup();
  const box = mailbox(raw);
  try {
    await createInvite(ctx(db, OFFICE, { wantsDetails: true, sendEmail: true }, box.env), 1);
    raw.prepare("UPDATE hr_invite SET sent_at = datetime('now', '-3 days'), opened_at = datetime('now', '-2 hours')").run();
    at10(t);
    assert.equal((await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } })).links, 0, 'they are on it');

    raw.prepare("UPDATE hr_invite SET opened_at = NULL, finished_at = datetime('now')").run();
    assert.equal((await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } })).links, 0, 'done');
  } finally { box.restore(); }
});

test('a link only copied by hand is not chased by HIVE', async (t) => {
  const { raw, db } = setup();
  await createInvite(ctx(db, OFFICE, { wantsDetails: true }), 1);
  raw.prepare("UPDATE hr_invite SET sent_at = datetime('now', '-3 days')").run();
  at10(t);
  assert.equal((await watchReminders(db, { timezone: 'UTC' })).links, 0);
});

test('a reminder carries the contracts still to sign, and the same code', async (t) => {
  const { raw, db } = setup();
  const box = mailbox(raw);
  try {
    const c = await read(await issueContract(ctx(db, OFFICE, { body: 'The words', title: 'Contract' }), 1));
    await createInvite(ctx(db, OFFICE, { wantsDetails: false, contractIds: [c.id], pin: '4821', sendEmail: true }, box.env), 1);
    raw.prepare("UPDATE hr_invite SET sent_at = datetime('now', '-3 days')").run();
    at10(t);
    await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } });
    const [old, fresh] = raw.prepare('SELECT * FROM hr_invite ORDER BY id').all();
    assert.equal(fresh.pin_hash, old.pin_hash, 'the code they were told still works');
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_invite_contract WHERE invite_id = ?').get(fresh.id).n, 1);
    assert.ok(!JSON.stringify(box.sent).includes('4821'), 'the code never travels with the link');
  } finally { box.restore(); }
});

test('the office hears when a contract is signed from a link', async () => {
  const { raw, db } = setup();
  const c = await read(await issueContract(ctx(db, OFFICE, { body: 'The words', title: 'Contract of employment' }), 1));
  const link = await read(await createInvite(ctx(db, OFFICE, { wantsDetails: false, contractIds: [c.id] }), 1));
  await inviteSign(ctx(db, null, { contractId: c.id, agreed: true, name: 'New Starter' }), tokenOf(link.url));
  const told = raw.prepare("SELECT * FROM app_notices WHERE kind = 'people.contract_signed'").get();
  assert.ok(told);
  assert.equal(told.audience, 'hr_manage');
  assert.match(told.title, /New Starter signed Contract of employment/);
});

function aLetter(raw) {
  raw.prepare(
    `INSERT INTO corr_letter (id, reference, subject, source, body, body_hash, status)
     VALUES (1, 'SN/ADM/2026/0001', 'Agreement', 'uploaded', NULL, NULL, 'draft')`,
  ).run();
}

test('a letter goes to the first signer by email, the second hears when it is their turn', async () => {
  const { raw, db } = setup();
  aLetter(raw);
  const box = mailbox(raw);
  try {
    const out = await read(await sendForSignature(ctx(db, OFFICE, {
      routing: 'order',
      recipients: [
        { name: 'First Signer', email: 'one@example.com' },
        { name: 'Second Signer', email: 'two@example.com' },
      ],
    }, box.env), 1));
    assert.equal(out.recipients[0].emailed, true);
    assert.ok(!out.recipients[1].emailed, 'not their turn yet');
    assert.equal(box.sent.length, 1);
    assert.ok(!JSON.stringify(box.sent[0]).includes(out.recipients[0].code), 'the code is not in the email');

    const code = out.recipients[0].code;
    const sign = ctx(db, null, { agreed: true, name: 'First Signer', code }, box.env);
    // The access code is checked when the page opens; mark it verified as the page would.
    raw.prepare("UPDATE corr_recipient SET verified_at = datetime('now') WHERE seq = 1").run();
    await signDocument(sign, tokenOf(out.recipients[0].url));

    const second = raw.prepare('SELECT * FROM corr_recipient WHERE seq = 2').get();
    assert.ok(second.turn_told_at, 'told it is their turn');
    assert.equal(box.sent.length, 2);
    assert.match(JSON.stringify(box.sent[1]), /Your turn to sign/);
    assert.ok(raw.prepare("SELECT 1 FROM app_notices WHERE kind = 'corr.signed'").get(), 'and the office heard');
  } finally { box.restore(); }
});

test('a letter waiting on a signer is chased, and the office warned before it runs out', async (t) => {
  const { raw, db } = setup();
  aLetter(raw);
  const box = mailbox(raw);
  try {
    await sendForSignature(ctx(db, OFFICE, {
      routing: 'order', days: 2, recipients: [{ name: 'First Signer', email: 'one@example.com' }],
    }, box.env), 1);
    raw.prepare("UPDATE corr_recipient SET turn_told_at = datetime('now', '-3 days')").run();
    const before = raw.prepare('SELECT token_hash FROM corr_recipient').get().token_hash;
    at10(t);
    const out = await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } });
    assert.equal(out.letters, 1);
    assert.equal(out.warned, 1);
    assert.notEqual(raw.prepare('SELECT token_hash FROM corr_recipient').get().token_hash, before, 'a fresh link');
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM app_notices WHERE kind = 'corr.expiring'").get().n, 1);

    await watchReminders(db, { timezone: 'UTC', ctx: { env: box.env } });
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM app_notices WHERE kind = 'corr.expiring'").get().n, 1, 'warned once');
  } finally { box.restore(); }
});
