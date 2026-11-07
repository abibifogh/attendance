import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import insight from '../src/index.js';
import { createToken, sessionCookie } from '../src/lib/auth.js';
import { all, run } from '../src/lib/db.js';
import { accessOf, roleOf } from '../src/routes/till.js';
import { derive, settle, reportsFor, tabsOf, TABS } from '../src/routes/tabaccess.js';

/**
 * Settings › People & access › Who sees what: one table that gives each person
 * each tab, and Insight keeping to it. Driven through the Worker's front door,
 * so the refusals are the real ones. Everybody here is invented.
 */

async function setUp() {
  const { db } = freshDb('migrations');
  const env = { DB: db, SESSION_SECRET: 'insight-signing', DASHBOARD_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('x') } };
  const people = [
    [1, 'owner@example.test', 'Kofi Test', 1, null],
    [2, 'admin@example.test', 'Esi Test', 0, 'admin'],
    [3, 'yaw@example.test', 'Yaw Test', 0, 'supervisor'],
    [4, 'gina@example.test', 'Gina Test', 0, 'uploader'],
    [5, 'efua@example.test', 'Efua Test', 0, null],
  ];
  for (const [id, email, name, owner, role] of people) {
    // eslint-disable-next-line no-await-in-loop
    await run(db, 'INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES (?1, ?2, ?3, ?4, 1, ?5)', id, email, name, owner, 'x');
    // eslint-disable-next-line no-await-in-loop
    if (role) await run(db, "INSERT INTO account_access (account_id, system_id, role) VALUES (?1, 'insight', ?2)", id, role);
  }
  const as = (id) => async (method, path, body) => {
    const cookie = sessionCookie(await createToken(env.SESSION_SECRET, { accountId: id })).split(';')[0];
    const response = await insight.fetch(new Request(`https://insight.example.test${path}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { env, db, owner: as(1), admin: as(2), yaw: as(3), gina: as(4), efua: as(5) };
}

const none = () => Object.fromEntries(TABS.map((t) => [t.key, 0]));

test('what a role gives, tab by tab, before anybody is saved in the table', () => {
  const admin = derive('admin');
  assert.equal(admin.floats, 2);
  assert.equal(admin.people, 2);
  const up = derive('uploader', { files: 2 });
  assert.deepEqual(Object.entries(up).filter(([, v]) => v).map(([k]) => k).sort(), ['mylist', 'notifications', 'upload']);
  const sup = derive('supervisor', { day: 1, week: 1, month: 1, reports: 1, answers: 2, reopen: 2, advances: 2 }, ['labour']);
  assert.equal(sup.shifts, 1);
  assert.equal(sup.closing, 2);
  assert.equal(sup.inbox, 2);
  assert.equal(sup.cashiers, 1);
  assert.equal(sup.labour, 1);
  assert.equal(sup.floats, 0, 'an admin’s tab is nobody else’s until given');
  assert.equal(derive(null).mylist, 0, 'nothing for somebody without Insight');
});

test('tabs and their areas are made to agree', () => {
  const hidden = settle({ shifts: 0, closing: 1 }, { day: 1, money: 1, check: 2, reopen: 2 });
  assert.equal(hidden.areas.day, 0, 'a hidden tab owns nothing');
  assert.equal(hidden.areas.money, 0);
  assert.equal(hidden.areas.reports, 1, 'Closing reports shown needs its area');
  assert.equal(hidden.areas.reopen, 1, 'a See tab does nothing: reopening is Do');
  const shown = settle({ shifts: 2, people: 2, approvals: 5 }, {});
  assert.equal(shown.areas.day, 1, 'Shifts shown starts with its views');
  assert.equal(shown.areas.check, 2, 'Shifts on Do checks shifts');
  assert.equal(shown.tabs.people, 0, 'Settings stay with admins');
  assert.equal(shown.tabs.approvals, 2, 'no more than Do');
  const safe = settle({ safe: 1 }, { envelopes: 2 });
  assert.equal(safe.areas.envelopes, 2, 'marking envelopes received is a tick that goes with See');
  assert.deepEqual(reportsFor({ ...none(), spend: 1, pnl: 1, npcounters: 2 }).sort(), ['buying', 'money', 'niceplace']);
});

test('the table is for admins only', async () => {
  const { admin, yaw, gina } = await setUp();
  const list = await admin('GET', '/api/access');
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data.people.length, 5);
  const yawRow = list.data.people.find((p) => p.name === 'Yaw Test');
  assert.equal(yawRow.role, 'supervisor');
  assert.ok(list.data.systems.some((s) => s.id === 'attendance'), 'the other systems are there');
  assert.equal((await yaw('GET', '/api/access')).status, 403);
  assert.equal((await gina('GET', '/api/access')).status, 403);
  assert.equal((await yaw('POST', '/api/access', { people: [{ accountId: 3, start: 'admin' }] })).status, 403);
});

test('saving a person writes their tabs, areas and reports, and Insight keeps to them', async () => {
  const { env, db, admin, yaw } = await setUp();
  const tabs = { ...none(), floats: 1, spend: 1, suppliers: 1, shifts: 1, safe: 1 };
  const saved = await admin('POST', '/api/access', { people: [{ accountId: 3, start: 'custom', tabs, areas: { money: 1 } }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const rows = await all(db, 'SELECT tab, level FROM tab_access WHERE account_id = 3');
  assert.equal(rows.length, TABS.length, 'a row for every tab');
  const me = await yaw('GET', '/api/auth/me');
  assert.equal(me.data.account.tabs.floats, 1);
  assert.equal(me.data.account.tabs.approvals, 0);
  assert.equal(me.data.account.tabs.people, 0);
  const account = { id: 3, access: [{ systemId: 'insight', role: 'supervisor' }] };
  assert.equal(roleOf(account), 'supervisor');
  const areas = await accessOf(env, account);
  assert.equal(areas.day, 1);
  assert.equal(areas.money, 1);
  assert.equal(areas.answers, 0, 'nothing of To sort out: its tab is hidden');
  assert.deepEqual((await tabsOf(env, account)).spend, 1);
  const reports = (await all(db, 'SELECT report FROM report_access WHERE account_id = 3')).map((r) => r.report);
  assert.deepEqual(reports, ['buying']);

  // Floats on See: they read it, as an admin would, and change nothing.
  const floats = await yaw('GET', '/api/floats');
  assert.equal(floats.status, 200, JSON.stringify(floats.data));
  const give = await yaw('POST', '/api/floats/give', { name: 'Sam Test', amount: '10', source: 'safe' });
  assert.equal(give.status, 403, 'giving money is Do');
  // Not given at all: still refused.
  assert.equal((await yaw('GET', '/api/approvals')).status, 403);
  assert.equal((await yaw('GET', '/api/stock')).status, 403);
  assert.equal((await yaw('GET', '/api/team')).status, 403);
  // Suppliers on See: they read them and may not change one.
  assert.equal((await yaw('GET', '/api/suppliers/book')).status, 200);
  const change = await yaw('POST', '/api/suppliers/save', { name: 'A Drinks Depot' });
  assert.equal(change.status, 403);
  assert.match(change.data.error, /Suppliers on Do/);
  // The safe on See: Envelopes received, not the book.
  assert.equal((await yaw('GET', '/api/safe/envelopes')).status, 200);
  assert.equal((await yaw('POST', '/api/safe/count', {})).status, 403);

  // Floats on Do: giving money passes the door.
  await admin('POST', '/api/access', { people: [{ accountId: 3, start: 'custom', tabs: { ...tabs, floats: 2, approvals: 1 } }] });
  const again = await yaw('POST', '/api/floats/give', { name: 'Sam Test', amount: '10', source: 'safe' });
  assert.notEqual(again.status, 403, JSON.stringify(again.data));
  assert.equal((await yaw('GET', '/api/approvals')).status, 200);
});

test('somebody with no Insight is given some tabs, and taken back to none', async () => {
  const { db, admin, efua } = await setUp();
  await admin('POST', '/api/access', { people: [{ accountId: 5, start: 'custom', tabs: { ...none(), pnl: 1 } }] });
  const me = await efua('GET', '/api/auth/me');
  assert.equal(me.data.account.till.role, 'supervisor');
  assert.equal(me.data.account.tabs.pnl, 1);
  assert.equal((await efua('GET', '/api/pnl')).status, 200);
  assert.equal((await efua('GET', '/api/labour')).status, 403);
  await admin('POST', '/api/access', { people: [{ accountId: 5, start: 'none' }] });
  assert.equal((await all(db, "SELECT 1 FROM account_access WHERE account_id = 5 AND system_id = 'insight'")).length, 0);
  assert.equal((await all(db, 'SELECT 1 FROM tab_access WHERE account_id = 5')).length, 0);
});

test('admins are an owner’s to make and unmake; nobody takes their own away', async () => {
  const { db, owner, admin } = await setUp();
  const make = await admin('POST', '/api/access', { people: [{ accountId: 3, start: 'admin' }] });
  assert.equal(make.status, 403);
  assert.match(make.data.error, /Only an owner/);
  const self = await admin('POST', '/api/access', { people: [{ accountId: 2, start: 'custom', tabs: none() }] });
  assert.equal(self.status, 400);
  const byOwner = await owner('POST', '/api/access', { people: [{ accountId: 3, start: 'admin' }] });
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.data));
  assert.equal((await all(db, "SELECT role FROM account_access WHERE account_id = 3 AND system_id = 'insight'"))[0].role, 'admin');
  const ownerRow = await owner('POST', '/api/access', { people: [{ accountId: 1, start: 'custom', tabs: none() }] });
  assert.equal(ownerRow.status, 400, 'an owner sees everything');
});

test('the other systems: an owner’s to change', async () => {
  const { db, owner, admin } = await setUp();
  const no = await admin('POST', '/api/access', { people: [{ accountId: 3, systems: { attendance: true } }] });
  assert.equal(no.status, 403);
  const yes = await owner('POST', '/api/access', { people: [{ accountId: 3, systems: { attendance: true, nonsense: true } }] });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  const grants = (await all(db, 'SELECT system_id FROM account_access WHERE account_id = 3 ORDER BY system_id')).map((r) => r.system_id);
  assert.deepEqual(grants, ['attendance', 'insight'], 'Insight kept, the unknown one ignored');
  await owner('POST', '/api/access', { people: [{ accountId: 3, systems: { attendance: false } }] });
  assert.deepEqual((await all(db, 'SELECT system_id FROM account_access WHERE account_id = 3')).map((r) => r.system_id), ['insight']);
});

test('somebody not yet saved keeps exactly what they had', async () => {
  const { gina } = await setUp();
  const me = await gina('GET', '/api/auth/me');
  assert.equal(me.data.account.tabs.upload, 2);
  assert.equal(me.data.account.tabs.shifts, 0);
  assert.equal((await gina('GET', '/api/floats')).status, 403);
});
