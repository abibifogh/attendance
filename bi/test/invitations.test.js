import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie } from '../src/lib/auth.js';
import { verifyLink } from '../src/lib/link.js';
import { run, first, all } from '../src/lib/db.js';
import { invitationEmail, stateOf, statusOf } from '../src/routes/invitations.js';

/**
 * Inviting somebody so they choose their own password.
 *
 * Driven through the Worker's own front door, with HIVE played by a stand-in
 * on the service binding that checks every request is signed and keeps the
 * mail it was asked to send. Everybody here is invented.
 */

const SHARED = 'shared-secret-for-the-test';

async function setup({ mailFails = false } = {}) {
  const { raw, db } = freshDb('migrations');
  const mail = [];
  const env = {
    DB: db,
    SESSION_SECRET: 'insight-signing',
    DASHBOARD_PASSWORD: 'owner-pw',
    SSO_SECRET_ATTENDANCE: SHARED,
    ASSETS: { fetch: async () => new Response('x') },
    HIVE: {
      async fetch(request) {
        const url = new URL(request.url);
        const text = await request.text();
        const ok = await verifyLink(SHARED, { at: request.headers.get('X-Till-At'), sig: request.headers.get('X-Till-Sig'), path: url.pathname, bodyText: text });
        if (!ok) return Response.json({ error: 'unsigned' }, { status: 401 });
        if (mailFails) return Response.json({ error: 'Could not email: HIVE has no email provider key set.' }, { status: 503 });
        mail.push(JSON.parse(text));
        return Response.json({ ok: true });
      },
    },
  };
  await run(db, "INSERT INTO accounts (email, name, is_owner, active, password_hash) VALUES ('boss@example.test', 'Test Owner', 1, 1, 'pbkdf2c$1$600000$AAAA$BBBB')");
  const owner = `${(sessionCookie(await createToken(env.SESSION_SECRET, { accountId: 1 }))).split(';')[0]}`;

  const call = async (path, body, cookie = owner) => {
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { waitUntil: () => {} });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const tokenIn = (html) => /#join=([A-Za-z0-9_-]+)/.exec(html)?.[1];
  return { raw, db, env, mail, call, tokenIn };
}

const NEW = { name: 'Abena Test', email: 'Abena@Example.test', level: 'supervisor', systems: ['attendance'], note: 'You will look after closing reports.' };

test('an invitation makes the account, with no password, and emails a link that opens', async () => {
  const { db, mail, call, tokenIn } = await setup();
  const out = await call('/api/invitations', NEW);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.emailed, true);
  assert.equal(out.data.link, null, 'an emailed invitation does not hand the link back');

  const account = await first(db, "SELECT * FROM accounts WHERE email = 'abena@example.test'");
  assert.equal(account.password_hash, null);
  assert.equal(account.is_owner, 0);
  const grants = await all(db, 'SELECT system_id, role FROM account_access WHERE account_id = ?1 ORDER BY system_id', account.id);
  assert.deepEqual(grants.map((g) => [g.system_id, g.role]), [['attendance', ''], ['insight', 'supervisor']]);

  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'abena@example.test');
  assert.equal(mail[0].subject, 'Test Owner has invited you to Insight');
  assert.match(mail[0].html, /You will look after closing reports\./);
  assert.match(mail[0].html, /Supervisor/);
  assert.match(mail[0].html, /https:\/\/insight\.example\.test\/#join=/);
  assert.equal(mail[0].replyTo, 'boss@example.test');

  // The token is not kept, only its hash.
  const token = tokenIn(mail[0].html);
  const row = await first(db, 'SELECT * FROM invitations');
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash.length, 64);

  const looked = await call('/api/invite/look', { token }, null);
  assert.equal(looked.data.state, 'open');
  assert.equal(looked.data.name, 'Abena Test');
  assert.equal(looked.data.level, 'Supervisor');
  assert.deepEqual(looked.data.others, ['HIVE']);
  assert.ok((await first(db, 'SELECT opened_at FROM invitations')).opened_at, 'opening it is noted');

  const listed = await call('/api/invitations');
  assert.equal(listed.data.invitations[0].status, 'opened');
});

test('accepting sets their password, signs them in, tells the owner, and works only once', async () => {
  const { db, mail, call, tokenIn } = await setup();
  await call('/api/invitations', NEW);
  const token = tokenIn(mail[0].html);
  const password = { passwordKey: 'derived-key', passwordSalt: 'AAAAAAAAAAAAAAAAAAAAAA', passwordIterations: 600000 };

  const tooWeak = await call('/api/invite/accept', { token, ...password, passwordIterations: 1000 }, null);
  assert.equal(tooWeak.status, 400);

  const joined = await call('/api/invite/accept', { token, name: 'Abena T. Test', ...password }, null);
  assert.equal(joined.status, 200);
  const cookie = joined.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly/);
  const me = await call('/api/auth/me', undefined, cookie.split(';')[0]);
  assert.equal(me.data.account.email, 'abena@example.test');
  assert.equal(me.data.account.name, 'Abena T. Test');
  assert.equal(me.data.account.till.role, 'supervisor');

  assert.match((await first(db, "SELECT password_hash FROM accounts WHERE email = 'abena@example.test'")).password_hash, /^pbkdf2c\$/);
  assert.equal(mail.length, 2);
  assert.equal(mail[1].to, 'boss@example.test');
  assert.match(mail[1].subject, /has joined Insight/);

  const again = await call('/api/invite/accept', { token, ...password }, null);
  assert.equal(again.status, 410);
  assert.equal((await call('/api/invite/look', { token }, null)).data.state, 'used');
  assert.equal((await call('/api/invitations')).data.invitations[0].status, 'joined');

  // And somebody who has joined cannot be invited over the top.
  const twice = await call('/api/invitations', NEW);
  assert.equal(twice.status, 400);
  assert.match(twice.data.error, /already has an account/);
});

test('resending makes a fresh link and the old one stops, saying why', async () => {
  const { mail, call, tokenIn } = await setup();
  const first = await call('/api/invitations', NEW);
  const oldToken = tokenIn(mail[0].html);
  const id = first.data.invitations[0].id;

  const resent = await call(`/api/invitations/${id}/resend`, { how: 'email' });
  assert.equal(resent.data.emailed, true);
  const newToken = tokenIn(mail[1].html);
  assert.notEqual(newToken, oldToken);

  const old = await call('/api/invite/look', { token: oldToken }, null);
  assert.equal(old.data.state, 'replaced');
  assert.equal(old.data.canAsk, true);
  assert.equal((await call('/api/invite/look', { token: newToken }, null)).data.state, 'open');

  const refused = await call('/api/invite/accept', { token: oldToken, passwordKey: 'k', passwordSalt: 'AAAAAAAAAAAAAAAAAAAAAA', passwordIterations: 600000 }, null);
  assert.equal(refused.status, 410);
  assert.match(refused.data.error, /newer invitation/);

  const listed = (await call('/api/invitations')).data.invitations;
  assert.equal(listed.length, 1, 'one row per person, the newest link');
  assert.equal(listed[0].sends, 2);

  // A link to copy, rather than an email, comes back to the owner.
  const copied = await call(`/api/invitations/${listed[0].id}/resend`, { how: 'link' });
  assert.match(copied.data.link, /^https:\/\/insight\.example\.test\/#join=[A-Za-z0-9_-]{20,}$/);
  assert.equal(mail.length, 2, 'no email for a copied link');
});

test('an expired link can ask for a new one, once, and the owner sees it', async () => {
  const { raw, mail, call, tokenIn } = await setup();
  await call('/api/invitations', NEW);
  const token = tokenIn(mail[0].html);
  raw.exec("UPDATE invitations SET expires_at = '2020-01-01 00:00:00'");

  const looked = await call('/api/invite/look', { token }, null);
  assert.equal(looked.data.state, 'expired');
  assert.equal(looked.data.canAsk, true);
  assert.equal(looked.data.asked, false);

  const asked = await call('/api/invite/ask', { token }, null);
  assert.equal(asked.data.ok, true);
  assert.equal(mail.length, 2);
  assert.equal(mail[1].to, 'boss@example.test');
  assert.match(mail[1].subject, /asked for a new Insight link/);
  assert.match(mail[1].html, /#\/accounts/);

  const twice = await call('/api/invite/ask', { token }, null);
  assert.equal(twice.data.already, true);
  assert.equal(mail.length, 2, 'asking twice does not email twice');
  assert.equal((await call('/api/invite/look', { token }, null)).data.asked, true);
  assert.equal((await call('/api/invitations')).data.invitations[0].status, 'asked');

  // Nothing to ask for on a link that still works.
  const { mail: m2, call: c2, tokenIn: t2 } = await setup();
  await c2('/api/invitations', NEW);
  assert.equal((await c2('/api/invite/ask', { token: t2(m2[0].html) }, null)).status, 400);
});

test('withdrawing stops the link and switches the unused account off', async () => {
  const { db, mail, call, tokenIn } = await setup();
  const made = await call('/api/invitations', NEW);
  const token = tokenIn(mail[0].html);
  await call(`/api/invitations/${made.data.invitations[0].id}/withdraw`, {});

  const looked = await call('/api/invite/look', { token }, null);
  assert.equal(looked.data.state, 'withdrawn');
  assert.equal(looked.data.canAsk, false);
  assert.equal((await first(db, "SELECT active FROM accounts WHERE email = 'abena@example.test'")).active, 0);
  assert.equal((await call('/api/invite/accept', { token, passwordKey: 'k', passwordSalt: 'AAAAAAAAAAAAAAAAAAAAAA', passwordIterations: 600000 }, null)).status, 410);
  assert.equal((await call('/api/invitations')).data.invitations[0].status, 'withdrawn');

  // Inviting again revives them.
  const again = await call(`/api/invitations/${made.data.invitations[0].id}/resend`, { how: 'email' });
  assert.equal(again.status, 200);
  assert.equal((await first(db, "SELECT active FROM accounts WHERE email = 'abena@example.test'")).active, 1);
  assert.equal((await call('/api/invite/look', { token: tokenIn(mail[1].html) }, null)).data.state, 'open');
});

test('when HIVE cannot send, the invitation still stands and the owner gets the link', async () => {
  const { db, mail, call } = await setup({ mailFails: true });
  const out = await call('/api/invitations', NEW);
  assert.equal(out.status, 200);
  assert.equal(out.data.emailed, false);
  assert.match(out.data.emailError, /no email provider key/);
  assert.match(out.data.link, /#join=/);
  assert.equal(mail.length, 0);
  assert.match((await first(db, 'SELECT email_error FROM invitations')).email_error, /provider key/);
});

test('only an owner can invite, and a made-up token opens nothing', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/invitations', NEW, null)).status, 401);
  assert.equal((await call('/api/invitations', undefined, null)).status, 401);
  assert.equal((await call('/api/invite/look', { token: 'not-a-real-token-at-all-000' }, null)).data.state, 'unknown');
  assert.equal((await call('/api/invite/look', { token: '<script>' }, null)).data.state, 'unknown');
  assert.equal((await call('/api/invitations', { ...NEW, level: 'emperor' })).status, 400);
});

test('a link ends one way, and the owner sees it in a word', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const base = { expires_at: '2026-10-15 12:00:00' };
  assert.equal(stateOf(null), 'unknown');
  assert.equal(stateOf(base, now), 'open');
  assert.equal(stateOf({ ...base, expires_at: '2026-10-08 11:59:59' }, now), 'expired');
  assert.equal(stateOf({ ...base, used_at: 'x', expires_at: '2020-01-01 00:00:00' }, now), 'used');
  assert.equal(stateOf({ ...base, replaced_at: 'x' }, now), 'replaced');
  assert.equal(statusOf({ ...base, opened_at: 'x' }, now), 'opened');
  assert.equal(statusOf({ ...base, replaced_at: 'x', asked_at: 'y' }, now), 'asked');
  assert.equal(statusOf(base, now), 'sent');
});

test('the email says who, what, until when, and escapes what people typed', () => {
  const mail = invitationEmail({
    name: 'Efua <b>Test</b>', inviter: 'Test Owner', note: '<script>alert(1)</script>', level: 'admin',
    others: ['HIVE', 'Laundry'], link: 'https://insight.example.test/#join=abc', expires: 'Thursday 15 October', iconUrl: 'https://insight.example.test/icon-180.png',
  });
  assert.doesNotMatch(mail.html, /<script>/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(mail.html, /Thursday 15 October/);
  assert.match(mail.html, /HIVE, Laundry/);
  assert.match(mail.html, /icon-180\.png/);
  assert.match(mail.text, /Set up your account: https:\/\/insight\.example\.test\/#join=abc/);
});

test('somebody can be invited to upload files and nothing else', async () => {
  const { db, mail, call } = await setup();
  const out = await call('/api/invitations', { name: 'Fiifi Files', email: 'fiifi@example.test', level: 'uploader', systems: [] });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const grants = await all(db, "SELECT system_id, role FROM account_access WHERE account_id = (SELECT id FROM accounts WHERE email = 'fiifi@example.test')");
  assert.deepEqual(grants.map((g) => [g.system_id, g.role]), [['insight', 'uploader']]);
  assert.match(mail[0].html, /Uploads only/);
  assert.equal(out.data.invitations[0].level, 'Uploads only');
});
