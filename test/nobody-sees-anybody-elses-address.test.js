import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createNotice } from '../src/lib/notices.js';
import { sendEmail } from '../src/lib/notify.js';

/**
 * Nobody is handed anybody else's address.
 *
 * The whole list went into `to`, so a rota going out to the property showed
 * every recipient every other recipient: the staff, the owners, and whoever is
 * on a personal address they never gave the rest of the house. That is
 * somebody else's personal data handed out by a rota notification.
 *
 * A list is now one message each. Fixed in the one function that talks to the
 * provider rather than at the four places that call it, because the next thing
 * to send mail would have had the same hole in it and nobody would have
 * looked.
 *
 * One message each rather than one blind-copied. A bcc with nothing in `to`
 * reads as bulk mail to a filter and as a mistake to a person, and it costs
 * the same.
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

function setup(people = 4) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users');
  for (let i = 1; i <= people; i += 1) {
    raw.prepare(
      'INSERT INTO users (id, name, role, email, active) VALUES (?, ?, ?, ?, 1)',
    ).run(i, `Person ${i}`, 'admin', `person${i}@example.test`);
  }
  for (const [key, value] of [
    ['email_from', 'hive@niceoperation.com'],
    ['site_url', 'https://staff.niceoperation.com'],
    ['property_name', 'Somewhere Nice'],
  ]) {
    raw.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
    ).run(key, value);
  }
  return { raw, db: d1(raw) };
}

/** Every request the provider was sent, with its parsed body. */
function catching(status = 200) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"data":[]}', {
      status, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

/** Every message in a call, whether it went one at a time or as a batch. */
const messagesIn = (call) => (Array.isArray(call.body) ? call.body : [call.body]);

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('a list of people is a message each, not one message to the list', async () => {
  const mail = catching();
  try {
    await sendEmail({
      apiKey: 'k',
      from: 'HIVE <hive@niceoperation.com>',
      to: ['a@x.test', 'b@y.test', 'c@z.test'],
      subject: 'Rota published',
      html: '<p>Out now.</p>',
    });
  } finally { mail.restore(); }

  assert.equal(mail.sent.length, 1, 'one call to the provider');
  assert.equal(mail.sent[0].url, 'https://api.resend.com/emails/batch');
  const each = messagesIn(mail.sent[0]);
  assert.equal(each.length, 3, 'three messages');
  assert.deepEqual(each.map((m) => m.to), [['a@x.test'], ['b@y.test'], ['c@z.test']]);
});

test('and one person is still one plain message', async () => {
  const mail = catching();
  try {
    await sendEmail({
      apiKey: 'k', from: 'HIVE <hive@niceoperation.com>', to: 'only@x.test',
      subject: 'Your code', html: '<p>123456</p>',
    });
  } finally { mail.restore(); }

  assert.equal(mail.sent[0].url, 'https://api.resend.com/emails', 'not the batch endpoint');
  assert.deepEqual(mail.sent[0].body.to, ['only@x.test']);
});

test('every message carries the same letter', async () => {
  const mail = catching();
  try {
    await sendEmail({
      apiKey: 'k',
      from: 'HIVE <hive@niceoperation.com>',
      to: ['a@x.test', 'b@y.test'],
      subject: 'Rota published',
      html: '<p>Out now.</p>',
      replyTo: 'office@niceoperation.com',
    });
  } finally { mail.restore(); }

  const each = messagesIn(mail.sent[0]);
  for (const one of each) {
    assert.equal(one.subject, 'Rota published');
    assert.match(one.html, /Out now/);
    assert.ok(one.text, 'and a plain-text part, which spam filters weigh');
    assert.equal(one.reply_to, 'office@niceoperation.com');
  }
});

test('blank and repeated addresses do not become messages', async () => {
  const mail = catching();
  try {
    await sendEmail({
      apiKey: 'k', from: 'HIVE <h@x.test>', to: ['a@x.test', '', '  ', null],
      subject: 'x', html: '<p>x</p>',
    });
  } finally { mail.restore(); }
  assert.equal(mail.sent[0].url, 'https://api.resend.com/emails', 'one real address');
  assert.deepEqual(mail.sent[0].body.to, ['a@x.test']);
});

test('nothing to send to is an error rather than a call', async () => {
  const mail = catching();
  try {
    await assert.rejects(
      () => sendEmail({ apiKey: 'k', from: 'x', to: [], subject: 'x', html: 'x' }),
      /No address to send to/,
    );
    await assert.rejects(
      () => sendEmail({ apiKey: 'k', from: 'x', to: null, subject: 'x', html: 'x' }),
      /No address to send to/,
    );
  } finally { mail.restore(); }
  assert.equal(mail.sent.length, 0);
});

test('a hundred at a time, which is what the provider takes', async () => {
  const many = Array.from({ length: 230 }, (_, i) => `p${i}@x.test`);
  const mail = catching();
  try {
    await sendEmail({ apiKey: 'k', from: 'HIVE <h@x.test>', to: many, subject: 'x', html: '<p>x</p>' });
  } finally { mail.restore(); }

  assert.equal(mail.sent.length, 3, '100, 100 and 30');
  assert.deepEqual(mail.sent.map((c) => messagesIn(c).length), [100, 100, 30]);
  const all = mail.sent.flatMap((c) => messagesIn(c)).flatMap((m) => m.to);
  assert.equal(all.length, 230, 'and nobody was dropped');
  assert.equal(new Set(all).size, 230);
});

// ---------------------------------------------------------------------------
// Through a real notice, which is how it went wrong
// ---------------------------------------------------------------------------

test('a notice to the whole house names one person per message', async () => {
  const { db } = setup(4);
  const mail = catching();
  try {
    await createNotice(db, {
      kind: 'rota.published',
      level: 'info',
      title: 'Rota published: 2026-09-14 to 2026-09-20',
      body: '125 new and 3 changed — confirmed by Michael (admin).',
      link: '#/att-rota',
      actor: 'Michael (admin)',
      audience: null,
      push: false,
    }, { env: { RESEND_API_KEY: 'test-key' } });
  } finally { mail.restore(); }

  const each = mail.sent.flatMap(messagesIn);
  assert.equal(each.length, 4, 'four people, four messages');
  for (const one of each) {
    assert.equal(one.to.length, 1, `addressed to ${one.to.join(', ')}`);
  }
  // The thing that was on the screenshot: nobody's copy names anybody else.
  for (const one of each) {
    const mine = one.to[0];
    for (const other of each.map((m) => m.to[0])) {
      if (other === mine) continue;
      assert.equal(JSON.stringify(one).includes(other), false,
        `${mine} was shown ${other}`);
    }
  }
});

test('the send log still records who it went to, which is the property’s own record', async () => {
  const { db, raw } = setup(3);
  const mail = catching();
  try {
    await createNotice(db, {
      kind: 'rota.published',
      level: 'info',
      title: 'Rota published',
      body: 'Out now.',
      actor: 'Michael (admin)',
      audience: null,
      push: false,
    }, { env: { RESEND_API_KEY: 'test-key' } });
  } finally { mail.restore(); }

  const logged = raw.prepare("SELECT recipients FROM email_log WHERE kind = 'notice'").get();
  assert.match(String(logged.recipients), /person1@example\.test/);
  assert.match(String(logged.recipients), /person3@example\.test/);
});

// ---------------------------------------------------------------------------
// And no way back in
// ---------------------------------------------------------------------------

test('nothing outside this function talks to the provider', () => {
  // The fix only holds while every path goes through sendEmail. A second
  // fetch to the mail API somewhere else is the hole reopening.
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (/api\.resend\.com/.test(readFileSync(path, 'utf8'))) hits.push(path);
    }
  };
  walk('src');
  assert.deepEqual(hits, ['src/lib/notify.js'],
    `only sendEmail may talk to the provider: ${hits.join(', ')}`);
  assert.match(readFileSync('src/lib/notify.js', 'utf8'), /to: \[one\],/,
    'and every message it builds names one person');
});
