import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import attendance from '../../src/index.js';
import { getPepper, storedPassword, createToken, sessionCookie } from '../src/lib/auth.js';
import { issueCode, redeemCode, systemsFor } from '../src/lib/sso.js';
import { run, all } from '../src/lib/db.js';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { d1 } from './helpers.js';

/**
 * Signing in once and arriving somewhere else already signed in.
 *
 * This is the part of the group's software where a mistake is not a wrong
 * number on a screen — it is somebody in a system they should not be in, under
 * a name that is not theirs. So the tests here are mostly about refusal: what
 * happens to a code that has been used, a code presented by the wrong system,
 * a person who was switched off between the click and the arrival.
 */

const SHARED = 'shared-secret-between-insight-and-attendance';
const SECRETS = {
  SESSION_SECRET: 'insight-signing',
  DASHBOARD_PASSWORD: 'owner-pw',
  SSO_SECRET_ATTENDANCE: SHARED,
  SSO_SECRET_POS: 'a-different-secret-for-the-pos',
};

async function hub({ grant = 'attendance', owner = false, active = 1 } = {}) {
  const { raw, db } = freshDb('migrations');
  const env = { DB: db, ...SECRETS, ASSETS: { fetch: async () => new Response('x') } };

  await run(db, `INSERT INTO accounts (email, name, is_owner, active, password_hash) VALUES ('ama@nice.test','Ama Boateng',?1,?2,?3)`,
    owner ? 1 : 0, active,
    await storedPassword({ passwordKey: 'derived', salt: 'AAAAAAAAAAAAAAAAAAAAAA', iterations: 600000 }, await getPepper(db)));
  if (grant) await run(db, `INSERT INTO account_access (account_id, system_id, role) VALUES (1, ?1, 'manager')`, grant);

  await run(db, `UPDATE systems SET sso_url = 'https://staff.test/sso', home_url = 'https://staff.test/', sso_enabled = 1 WHERE id = 'attendance'`);
  await run(db, `UPDATE systems SET sso_url = 'https://pos.test/sso', sso_enabled = 1 WHERE id = 'pos'`);

  const account = {
    id: 1, email: 'ama@nice.test', name: 'Ama Boateng', isOwner: owner, bootstrap: false,
    access: grant ? [{ systemId: grant, role: 'manager' }] : [],
  };
  return { raw, db, env, account };
}

const codeFrom = (url) => new URL(url).searchParams.get('code');

test('a code is minted, redeemed once, and refused the second time', async () => {
  const { env, account } = await hub();
  const { url } = await issueCode(env, account, 'attendance');
  assert.match(url, /^https:\/\/staff\.test\/sso\?code=/);

  const identity = await redeemCode(env, { code: codeFrom(url), systemId: 'attendance', secret: SHARED });
  assert.equal(identity.email, 'ama@nice.test');
  assert.equal(identity.name, 'Ama Boateng');
  assert.equal(identity.role, 'manager');

  await assert.rejects(
    () => redeemCode(env, { code: codeFrom(url), systemId: 'attendance', secret: SHARED }),
    /cannot be redeemed/, 'a code must be worth exactly one sign-in');
});

test('the identity never travels in the URL', async () => {
  const { env, account } = await hub();
  const { url } = await issueCode(env, account, 'attendance');
  // A URL ends up in a browser history, a proxy log and a Referer header.
  assert.ok(!url.includes('ama'), 'no address in the redirect');
  assert.ok(!url.toLowerCase().includes('boateng'), 'no name in the redirect');
  assert.ok(!url.includes('manager'), 'no role in the redirect');
});

test('the code itself is never stored, only its hash', async () => {
  const { raw, env, account } = await hub();
  const { url } = await issueCode(env, account, 'attendance');
  const code = codeFrom(url);
  const stored = raw.prepare('SELECT code_hash FROM sso_codes').all();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].code_hash, code,
    'a copy of this database must not yield live codes');
});

test('one system cannot redeem another system\'s code', async () => {
  const { env, account } = await hub({ grant: null, owner: true });
  const { url } = await issueCode(env, account, 'attendance');

  // The POS holds a perfectly valid secret — its own — and presents it against
  // a code that was minted for attendance.
  await assert.rejects(
    () => redeemCode(env, { code: codeFrom(url), systemId: 'pos', secret: SECRETS.SSO_SECRET_POS }),
    /cannot be redeemed/);

  // And it cannot simply claim to be attendance, because it does not hold
  // attendance's secret.
  await assert.rejects(
    () => redeemCode(env, { code: codeFrom(url), systemId: 'attendance', secret: SECRETS.SSO_SECRET_POS }),
    /Not a recognised system/);
});

test('an expired code is refused', async () => {
  const { raw, env, account } = await hub();
  const { url } = await issueCode(env, account, 'attendance');
  raw.exec("UPDATE sso_codes SET expires_at = datetime('now', '-1 minute')");
  await assert.rejects(
    () => redeemCode(env, { code: codeFrom(url), systemId: 'attendance', secret: SHARED }),
    /cannot be redeemed/);
});

test('somebody switched off between the click and the arrival does not get in', async () => {
  const { raw, env, account } = await hub();
  const { url } = await issueCode(env, account, 'attendance');
  raw.exec('UPDATE accounts SET active = 0 WHERE id = 1');
  await assert.rejects(
    () => redeemCode(env, { code: codeFrom(url), systemId: 'attendance', secret: SHARED }),
    /cannot be redeemed/, 'ninety seconds is small and it is not zero');
});

test('a system a person was not given is refused before a code exists', async () => {
  const { raw, env, account } = await hub({ grant: 'attendance' });
  await assert.rejects(() => issueCode(env, account, 'pos'), /has not been given/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sso_codes').get().n, 0,
    'nothing should be minted for a system somebody cannot reach');
});

test('the shared owner password cannot be handed over to anything', async () => {
  const { env } = await hub();
  const bootstrap = { id: null, name: 'Owner', isOwner: true, bootstrap: true, access: [] };
  await assert.rejects(() => issueCode(env, bootstrap, 'attendance'),
    /Create yourself a real account/,
    'a password out of a config file is not a person');
});

test('a system with no secret on this Worker refuses rather than half-working', async () => {
  const { db, account } = await hub();
  const env = { DB: db, SESSION_SECRET: 'x' };   // no SSO_SECRET_ATTENDANCE
  await assert.rejects(() => issueCode(env, account, 'attendance'), /wrangler secret put/);
});

test('an owner reaches everything, and everybody else only what they were given', async () => {
  const owner = await hub({ grant: null, owner: true });
  const forOwner = await systemsFor(owner.env, owner.account);
  assert.ok(forOwner.every((s) => s.granted));

  const staff = await hub({ grant: 'attendance' });
  const forStaff = await systemsFor(staff.env, staff.account);
  assert.deepEqual(forStaff.filter((s) => s.granted).map((s) => s.id), ['attendance']);
  assert.equal(forStaff.find((s) => s.id === 'attendance').handOff, true);
  assert.equal(forStaff.find((s) => s.id === 'pos').handOff, false);
  assert.match(forStaff.find((s) => s.id === 'pos').reason, /Not granted/);
});

test('the hub says why a system cannot hand over, rather than offering a button that fails', async () => {
  const { db, account } = await hub({ grant: 'attendance' });
  // Granted, configured, and no secret set here.
  const env = { DB: db, SESSION_SECRET: 'x' };
  const [attendanceRow] = (await systemsFor(env, account)).filter((s) => s.id === 'attendance');
  assert.equal(attendanceRow.granted, true);
  assert.equal(attendanceRow.handOff, false);
  assert.match(attendanceRow.reason, /SSO_SECRET_ATTENDANCE is not set/);
});

test('every hand-off and every refusal is written down', async () => {
  const { db, env, account } = await hub();
  const { url } = await issueCode(env, account, 'attendance');
  await redeemCode(env, { code: codeFrom(url), systemId: 'attendance', secret: SHARED });
  await redeemCode(env, { code: codeFrom(url), systemId: 'attendance', secret: SHARED }).catch(() => {});
  await issueCode(env, account, 'pos').catch(() => {});

  const log = await all(db, 'SELECT event, system_id, detail FROM sso_log ORDER BY id');
  assert.deepEqual(log.map((r) => r.event), ['issued', 'redeemed', 'refused', 'refused']);
  assert.equal(log[0].system_id, 'attendance');
  assert.match(log[3].detail, /not granted/);
});

// ------------------------------------------------- both Workers, for real --

function attendanceDb() {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync('../migrations').filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`../migrations/${file}`, 'utf8'));
  }
  return { raw, db: d1(raw) };
}

/**
 * The whole hand-off, both Workers in one process, with the network between
 * them replaced by a direct call into the Insight Worker.
 *
 * This is the test that would have caught every integration mistake the unit
 * tests above cannot: a header spelled differently on each side, a body the
 * other end does not parse, a cookie that is set but not accepted.
 */
async function bothEnds({ localUser = true, active = 1 } = {}) {
  const bi = await hub();
  const att = attendanceDb();
  if (localUser) {
    att.raw.exec(`INSERT INTO users (name, email, role, active) VALUES ('Ama Boateng','ama@nice.test','manager',${active})`);
  }

  const attEnv = {
    DB: att.db,
    SESSION_SECRET: 'attendance-signing',
    INSIGHT_SSO_URL: 'https://insight.test/api/sso/redeem',
    INSIGHT_SSO_SECRET: SHARED,
    ASSETS: { fetch: async () => new Response('the app') },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const target = typeof url === 'string' ? url : url.url;
    if (target.startsWith('https://insight.test')) {
      return insight.fetch(new Request(target, opts), bi.env, { waitUntil: () => {} });
    }
    return realFetch(url, opts);
  };

  return { bi, att, attEnv, restore: () => { globalThis.fetch = realFetch; } };
}

test('signing in at the hub lands you inside attendance, already signed in', async () => {
  const { bi, attEnv, restore } = await bothEnds();
  try {
    const { url } = await issueCode(bi.env, bi.account, 'attendance');

    const arrival = await attendance.fetch(new Request(url), attEnv, { waitUntil: () => {} });
    assert.equal(arrival.status, 302);
    assert.equal(arrival.headers.get('Location'), '/');
    assert.equal(arrival.headers.get('Referrer-Policy'), 'no-referrer');

    const cookie = arrival.headers.get('Set-Cookie');
    assert.match(cookie, /bf_session=/);
    assert.match(cookie, /HttpOnly/);

    // And it is a real attendance session, not just a cookie shaped like one.
    const me = await attendance.fetch(new Request('https://staff.test/api/auth/me', {
      headers: { Cookie: cookie.split(';')[0] },
    }), attEnv, { waitUntil: () => {} });
    const body = await me.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.name, 'Ama Boateng');
    assert.equal(body.role, 'manager', 'the role comes from attendance, not from the hub');
  } finally { restore(); }
});

test('following the same link twice does not sign you in twice', async () => {
  const { bi, attEnv, restore } = await bothEnds();
  try {
    const { url } = await issueCode(bi.env, bi.account, 'attendance');
    const first = await attendance.fetch(new Request(url), attEnv, { waitUntil: () => {} });
    assert.equal(first.status, 302);

    const second = await attendance.fetch(new Request(url), attEnv, { waitUntil: () => {} });
    assert.equal(second.status, 400);
    assert.equal(second.headers.get('Set-Cookie'), null, 'a refused arrival must not set a session');
    assert.match(await second.text(), /expired or has already been used/);
  } finally { restore(); }
});

test('the hub cannot create an account in attendance that does not exist', async () => {
  const { bi, attEnv, restore } = await bothEnds({ localUser: false });
  try {
    const { url } = await issueCode(bi.env, bi.account, 'attendance');
    const arrival = await attendance.fetch(new Request(url), attEnv, { waitUntil: () => {} });
    assert.equal(arrival.status, 400);
    assert.equal(arrival.headers.get('Set-Cookie'), null);
    const text = await arrival.text();
    assert.match(text, /ama@nice\.test/, 'say which address needs an account');
    assert.match(text, /nobody with that address has an account/);
  } finally { restore(); }
});

test('somebody switched off in attendance is refused even with a good code', async () => {
  const { bi, attEnv, restore } = await bothEnds({ active: 0 });
  try {
    const { url } = await issueCode(bi.env, bi.account, 'attendance');
    const arrival = await attendance.fetch(new Request(url), attEnv, { waitUntil: () => {} });
    assert.equal(arrival.status, 400);
    assert.match(await arrival.text(), /switched off/);
  } finally { restore(); }
});

test('a site with the wrong shared secret is told so plainly', async () => {
  const { bi, attEnv, restore } = await bothEnds();
  try {
    const { url } = await issueCode(bi.env, bi.account, 'attendance');
    const arrival = await attendance.fetch(new Request(url),
      { ...attEnv, INSIGHT_SSO_SECRET: 'not-the-right-secret' }, { waitUntil: () => {} });
    assert.equal(arrival.status, 400);
    assert.match(await arrival.text(), /did not recognise this site/);
  } finally { restore(); }
});

test('a site not connected to a hub at all says that rather than failing blank', async () => {
  const { bi, attEnv, restore } = await bothEnds();
  try {
    const { url } = await issueCode(bi.env, bi.account, 'attendance');
    const arrival = await attendance.fetch(new Request(url),
      { ...attEnv, INSIGHT_SSO_URL: '', INSIGHT_SSO_SECRET: '' }, { waitUntil: () => {} });
    assert.equal(arrival.status, 400);
    assert.match(await arrival.text(), /not been connected to the group hub/);
  } finally { restore(); }
});


// -------------------------------------------------------------- accounts --

test('two accounts cannot end up sharing an address', async () => {
  const { db, env } = await hub();
  const { save } = await import('../src/routes/accounts.js');

  await save(env, { email: 'kofi@nice.test', name: 'Kofi Asare' }, { email: 'owner' });
  await assert.rejects(() => save(env, { email: 'kofi@nice.test', name: 'Somebody Else' }, {}),
    /already uses that address/);

  // And renaming one onto another's address is refused too, rather than
  // reaching the unique constraint and surfacing as a server error.
  await assert.rejects(() => save(env, { id: 1, email: 'kofi@nice.test', name: 'Ama Boateng' }, {}),
    /already uses that address/);
});

test('the last owner cannot be demoted or switched off', async () => {
  const { env } = await hub({ owner: true });
  const { save } = await import('../src/routes/accounts.js');

  await assert.rejects(
    () => save(env, { id: 1, email: 'ama@nice.test', name: 'Ama Boateng', isOwner: false }, {}),
    /last active owner/, 'the group must never be locked out of its own front door');

  await assert.rejects(
    () => save(env, { id: 1, email: 'ama@nice.test', name: 'Ama Boateng', active: false }, {}),
    /last active owner/);
});

test('nobody can switch off their own account', async () => {
  const { env } = await hub({ owner: true });
  const { save } = await import('../src/routes/accounts.js');
  // A second owner, so the last-owner rule is not what refuses this.
  await save(env, { email: 'kofi@nice.test', name: 'Kofi Asare', isOwner: true }, {});
  await assert.rejects(
    () => save(env, { id: 1, email: 'ama@nice.test', name: 'Ama Boateng', active: false }, { id: 1 }),
    /cannot switch off your own account/);
});

test('a grant may only name a system that exists', async () => {
  const { db, env } = await hub();
  const { setAccess } = await import('../src/routes/accounts.js');
  await setAccess(env, 1, { access: [
    { systemId: 'pos', role: 'cashier' },
    { systemId: 'made-up-system', role: 'admin' },
  ] }, {});
  const rows = await all(db, 'SELECT system_id FROM account_access WHERE account_id = 1');
  assert.deepEqual(rows.map((r) => r.system_id), ['pos']);
});

test('a system address must be https, and single sign-on needs one before it can be switched on', async () => {
  const { env } = await hub();
  const { saveSystem } = await import('../src/routes/accounts.js');

  await assert.rejects(() => saveSystem(env, 'pos', { ssoUrl: 'http://pos.test/sso' }), /https/);
  await assert.rejects(() => saveSystem(env, 'pos', { ssoUrl: 'not a url' }), /not a web address/);
  await assert.rejects(
    () => saveSystem(env, 'breakfast', { ssoUrl: '', ssoEnabled: true }),
    /needs a sign-in address/);
});
