import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createNotice } from '../src/lib/notices.js';
import { noticeRecipients, renderNotice } from '../src/lib/notify.js';

/**
 * A notice by mail as well as by bell.
 *
 * The rule that matters is who it reaches. A notice carries a person or a
 * permission and never a list of addresses, so who gets the mail is worked out
 * at the moment of sending. A stored list would be a second copy of who works
 * here, and the day somebody is promoted is the day the two stop agreeing.
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
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users');
  const add = (id, name, role, permissions, email, active = 1) => raw.prepare(
    'INSERT INTO users (id, name, role, permissions, email, active) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, role, permissions ? JSON.stringify(permissions) : null, email, active);

  add(1, 'Ama', 'admin', null, 'ama@example.test');
  add(2, 'Yaa', 'planner', ['att_view', 'att_rota', 'att_signoff'], 'yaa@example.test');
  add(3, 'Kofi', 'supervisor', null, 'kofi@example.test');
  add(4, 'Esi', 'manager', null, null);            // no address on file
  add(5, 'Gone', 'manager', null, 'gone@example.test', 0);   // left

  return { raw, db: d1(raw) };
}

/** A stand-in for Resend that records what it was asked to send. */
function catching() {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'test' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { sent, restore: () => { globalThis.fetch = original; } };
}

test('the sender is the property\'s own verified address out of the box', () => {
  const { raw } = setup();
  const from = raw.prepare("SELECT value FROM settings WHERE key = 'email_from'").get();
  assert.equal(from.value, 'hive@niceoperation.com');
  const on = raw.prepare("SELECT value FROM settings WHERE key = 'notice_email'").get();
  assert.equal(on.value, '1', 'and it is on, because being told is the point');
});

test('a notice addressed to one person reaches that person and nobody else', async () => {
  const { db } = setup();
  const people = await noticeRecipients(db, { audience: 'att_manage', userId: 2 });
  assert.deepEqual(people.map((p) => p.email), ['yaa@example.test']);
});

test('a notice addressed to a permission reaches whoever holds it today', async () => {
  const { db } = setup();
  const people = await noticeRecipients(db, { audience: 'att_signoff' });
  const got = people.map((p) => p.name).sort();

  // Ama as an administrator, Yaa because it was ticked for her, and Kofi
  // because a supervisor's role carries it. Esi holds it too and has no
  // address on file; Gone has left.
  assert.deepEqual(got, ['Ama', 'Kofi', 'Yaa']);
});

test('somebody with no address on file is skipped rather than failing the send', async () => {
  const { db } = setup();
  const people = await noticeRecipients(db, { audience: 'att_manage' });
  assert.ok(!people.some((p) => p.name === 'Esi'), 'Esi has no address');
  assert.ok(!people.some((p) => p.name === 'Gone'), 'and Gone is not here any more');
});

test('recording a notice sends it, from the configured address', async () => {
  const { db, raw } = setup();
  const mail = catching();
  try {
    await createNotice(db, {
      kind: 'attendance.query',
      level: 'warn',
      title: 'Nelson Kumadey: a period needs your eye',
      body: '1 July to 31 July — nineteen days nobody can explain',
      link: '#/signoff?tab=queries',
      actor: 'Yaa (planner)',
      audience: 'att_manage',
      userId: 1,
    }, { env: { RESEND_API_KEY: 'test-key' } });
  } finally { mail.restore(); }

  assert.equal(mail.sent.length, 1);
  const { url, body } = mail.sent[0];
  assert.equal(url, 'https://api.resend.com/emails');
  // Named, not bare. A From line reading only an address is one of the
  // plainer marks of mail nobody set up.
  assert.equal(body.from, '"Staff Attendance" <hive@niceoperation.com>');
  assert.deepEqual(body.to, ['ama@example.test']);
  assert.equal(body.subject, 'Nelson Kumadey: a period needs your eye');
  assert.match(body.html, /nineteen days nobody can explain/);

  // Both parts. A message with HTML and no text is one of the things spam
  // filters weigh most heavily.
  assert.ok(body.text, 'a plain-text part was sent');
  assert.match(body.text, /nineteen days nobody can explain/);
  assert.ok(!body.text.includes('<'), 'and it is actually plain');

  // A whole document rather than a loose fragment.
  assert.match(body.html, /^<!doctype html>/);
  assert.match(body.html, /<meta charset="utf-8">/);
  assert.match(body.html, /<html lang="en">/);

  // The bell still rang, and the send is on the record.
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM app_notices').get().c, 1);
  const logged = raw.prepare("SELECT * FROM email_log WHERE kind = 'notice'").get();
  assert.equal(logged.status, 'sent');
  assert.equal(logged.recipients, 'ama@example.test');
});

test('switching it off leaves the bell ringing and sends nothing', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE settings SET value = '0' WHERE key = 'notice_email'").run();

  const mail = catching();
  try {
    await createNotice(db, {
      kind: 'attendance.times', title: 'Approve: clock times', audience: 'att_setup',
    }, { env: { RESEND_API_KEY: 'test-key' } });
  } finally { mail.restore(); }

  assert.equal(mail.sent.length, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM app_notices').get().c, 1, 'the bell is unaffected');
});

test('no provider key means no mail and no error', async () => {
  const { db, raw } = setup();
  const mail = catching();
  try {
    await createNotice(db, { kind: 'attendance.query', title: 'Something', audience: 'att_manage' },
      { env: {} });
  } finally { mail.restore(); }

  assert.equal(mail.sent.length, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM app_notices').get().c, 1);
});

test('a provider having a bad afternoon does not fail the round that earned the notice', async () => {
  const { db, raw } = setup();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream exploded', { status: 500 });

  let id;
  try {
    // Must resolve, not reject: the notice is a courtesy on top of work that
    // has already happened.
    id = await createNotice(db, {
      kind: 'attendance.query', title: 'Something', audience: 'att_manage',
    }, { env: { RESEND_API_KEY: 'test-key' } });
    await new Promise((r) => setTimeout(r, 20));
  } finally { globalThis.fetch = original; }

  assert.ok(id, 'the notice was still recorded');
  const logged = raw.prepare("SELECT * FROM email_log WHERE kind = 'notice'").get();
  assert.equal(logged.status, 'failed');
  assert.match(logged.detail, /500/);
});

test('the email carries a real link when the site address is known', () => {
  const { subject, html } = renderNotice({
    notice: { title: 'A period needs your eye', body: 'Nineteen days', level: 'warn', link: '#/signoff?tab=queries' },
    propertyName: 'Somewhere Nice',
    siteUrl: 'https://staff.niceoperation.com',
  });
  assert.equal(subject, 'A period needs your eye');
  assert.match(html, /https:\/\/staff\.niceoperation\.com\/#\/signoff\?tab=queries/);
  assert.match(html, /Somewhere Nice/);
});

test('a title with markup in it cannot become markup in the mail', () => {
  const { html } = renderNotice({
    notice: { title: '<script>alert(1)</script>', body: 'x & y', level: 'info' },
    propertyName: 'Somewhere Nice',
    siteUrl: null,
  });
  assert.ok(!html.includes('<script>'), 'escaped rather than embedded');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /x &amp; y/);
});


test('the sender carries the property name, and a name already set is left alone', async () => {
  const { senderWithName } = await import('../src/lib/notify.js');

  assert.equal(senderWithName('hive@niceoperation.com', 'Somewhere Nice'),
    '"Somewhere Nice" <hive@niceoperation.com>');

  // Somebody who wrote their own name into the setting keeps it.
  assert.equal(senderWithName('HIVE <hive@niceoperation.com>', 'Somewhere Nice'),
    'HIVE <hive@niceoperation.com>');

  // A comma in a property name must not become a second recipient.
  assert.equal(senderWithName('hive@niceoperation.com', 'Somewhere Nice, Accra'),
    '"Somewhere Nice, Accra" <hive@niceoperation.com>');

  // And a quote in it must not close the quoting early.
  assert.equal(senderWithName('hive@niceoperation.com', 'The "Nice" Hotel'),
    '"The Nice Hotel" <hive@niceoperation.com>');

  assert.equal(senderWithName('hive@niceoperation.com', ''), 'hive@niceoperation.com');
  assert.equal(senderWithName('', 'Somewhere Nice'), '');
});

test('the plain-text part keeps the words and the links, and drops the markup', async () => {
  const { asPlainText } = await import('../src/lib/notify.js');

  const text = asPlainText(`
    <h1>Nelson Kumadey</h1>
    <p>Nineteen days &amp; nobody can explain them</p>
    <ul><li>1 July</li><li>2 July</li></ul>
    <a href="https://staff.niceoperation.com/#/signoff">Open it</a>
  `);

  assert.match(text, /Nelson Kumadey/);
  assert.match(text, /Nineteen days & nobody/, 'entities decoded');
  assert.match(text, /- 1 July/, 'list items survive as a list');
  assert.match(text, /Open it: https:\/\/staff\.niceoperation\.com/, 'the link is readable');
  assert.ok(!text.includes('<'), 'no markup left');
  assert.ok(!/\n{3,}/.test(text), 'no runs of blank lines');
});
