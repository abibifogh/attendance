import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { originOf } from '../src/lib/site.js';

/**
 * The links the property sends out, and the one setting that can break all of
 * them at once.
 *
 * Every link is an origin with a path stuck on the end: `/i/<token>` for
 * somebody's own details, `/s/<token>` for a letter waiting to be signed. The
 * origin comes from a text box somebody typed their address into once, and
 * what gets typed into it is whatever was in the address bar at the time.
 *
 * A path left in that box does not fail loudly. The link still serves the
 * page, the page still runs, and only the API call underneath it lands on
 * nothing — so the person holding a link that is minutes old is told it has
 * expired, and asks for another one built exactly the same way.
 */

function db(raw) {
  const statement = (sql, binds = []) => ({
    bind(...a) { return statement(sql, a); },
    async all() { return { results: raw.prepare(sql).all(...binds) }; },
    async first() { return raw.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = raw.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  return {
    raw,
    env: {
      DB: db(raw),
      SESSION_SECRET: 'x'.repeat(40),
      ASSETS: { fetch: async (req) => new Response(`ASSET ${new URL(req.url).pathname}`, { status: 200 }) },
    },
  };
}

const get = (env, path) => worker.fetch(new Request(`https://staff.example.test${path}`), env, null);

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

test('the site address is kept as an origin, whatever gets typed into the box', () => {
  assert.equal(originOf('https://staff.example.com'), 'https://staff.example.com');
  assert.equal(originOf('https://staff.example.com/'), 'https://staff.example.com');

  // The one that caused this. Somebody copies the address bar while looking at
  // a link, and every link the property sends from then on carries the extra
  // segment in the middle of it.
  assert.equal(originOf('https://staff.example.com/i'), 'https://staff.example.com');
  assert.equal(originOf('https://staff.example.com/app/x?y=1#z'), 'https://staff.example.com');

  // Nobody types the protocol for their own site.
  assert.equal(originOf('staff.example.com'), 'https://staff.example.com');
  assert.equal(originOf('staff.example.com/i/'), 'https://staff.example.com');

  // A port survives, because that is how the thing is reached in development.
  assert.equal(originOf('http://127.0.0.1:8787/x'), 'http://127.0.0.1:8787');

  // Empty or unusable falls back rather than failing.
  assert.equal(originOf('', 'https://fallback.test'), 'https://fallback.test');
  assert.equal(originOf('   ', 'https://fallback.test/'), 'https://fallback.test');
  assert.equal(originOf('mailto:someone@example.com', 'https://fallback.test'), 'https://fallback.test');
});

// ---------------------------------------------------------------------------
// The link itself
// ---------------------------------------------------------------------------

test('a link is built on the origin alone, even when the setting carries a path', async () => {
  const { raw, env } = setup();
  raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('site_url', 'https://staff.example.com/i')").run();
  raw.exec('DELETE FROM att_staff');
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1001', 'Henry Aryee', '2020-01-01')",
  ).run();

  const { createInvite } = await import('../src/routes/people.js');
  const ctx = {
    db: env.DB,
    url: new URL('https://staff.example.test/api/hr/people/1/invites'),
    session: { user: { id: 1, name: 'Ama', role: 'manager' }, permissions: ['hr_manage'] },
    request: new Request('https://staff.example.test/api/hr/people/1/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wantsDetails: true }),
    }),
  };

  const out = await (await createInvite(ctx, '1')).json();
  assert.match(out.url, /^https:\/\/staff\.example\.com\/i\/[0-9a-f]{48}$/,
    'one /i/, not two');
  assert.ok(out.message.includes(out.url));
});

// ---------------------------------------------------------------------------
// And the links already sent, which cannot be shown again
// ---------------------------------------------------------------------------

test('the page finds the token however many segments are in front of it', async () => {
  // A link built before the setting was put right still has to work: the
  // database holds only a hash of the token, so a link that cannot be opened
  // cannot be reissued either — it has to be made again from scratch, for
  // everybody who was sent one.
  const { lastSegment } = await import('./helpers/last-segment.js');

  const token = 'a'.repeat(48);
  assert.equal(lastSegment(`/i/${token}`, 'i'), token);
  assert.equal(lastSegment(`/i/${token}/`, 'i'), token, 'a trailing slash');
  assert.equal(lastSegment(`/i/i/${token}`, 'i'), token, 'the doubled path this bug produced');
  assert.equal(lastSegment(`/app/i/${token}`, 'i'), token, 'or any other prefix');
  assert.equal(lastSegment('/i/', 'i'), '', 'and the prefix alone is not a token');
  assert.equal(lastSegment('/i', 'i'), '', 'with or without the slash');
});

test('the API answers a token with a trailing slash rather than calling it unknown', async () => {
  const { env } = setup();

  const plain = await get(env, '/api/i/deadbeef');
  assert.equal(plain.status, 404);
  assert.match((await plain.json()).error, /link does not work/,
    'a token nobody recognises is a dead link');

  const slashed = await get(env, '/api/i/deadbeef/');
  assert.match((await slashed.json()).error, /link does not work/,
    'and so is the same one with a slash on the end — not "unknown endpoint"');
});

test('the page is still served for a link with an extra segment in it', async () => {
  const { env } = setup();
  const res = await get(env, `/i/i/${'a'.repeat(48)}`);
  assert.equal(await res.text(), 'ASSET /invite.html');
});
