import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as act from '../src/routes/odooact.js';
import * as till from '../src/routes/till.js';

/**
 * Odoo activities, read from a small invented Odoo: people, activities on
 * purchase orders and a bill, and the messages Odoo writes when one is done.
 * Everything here is made up.
 */

const OWNER = { id: 1, name: 'Test Owner', isOwner: true, access: [] };
const SUPERVISOR = { id: 2, name: 'Sam Supervisor', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const DESK = { id: 3, name: 'Desk Supervisor', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };

const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function odoo() {
  const data = {
    'res.users': [
      { id: 10, name: 'Owner In Odoo', login: 'owner@example.test', email: 'owner@example.test', partner_id: [110, 'Owner In Odoo'] },
      { id: 20, name: 'Sam In Odoo', login: 'sam', email: 'sam@example.test', partner_id: [120, 'Sam In Odoo'] },
      { id: 30, name: 'Stores In Odoo', login: 'stores', email: '', partner_id: [130, 'Stores In Odoo'] },
    ],
    'mail.activity': [
      { id: 1, res_model: 'purchase.order', res_id: 501, res_name: 'P00491', activity_type_id: [4, 'To-Do'], summary: 'Approve P00491', note: '<p>Please approve before the cashier pays.</p>', date_deadline: day(-3), user_id: [20, 'Sam In Odoo'] },
      { id: 2, res_model: 'account.move', res_id: 701, res_name: 'BILL/0412', activity_type_id: [4, 'To-Do'], summary: 'Pay bill', note: false, date_deadline: day(0), user_id: [10, 'Owner In Odoo'] },
      { id: 3, res_model: 'purchase.order', res_id: 502, res_name: 'P00495', activity_type_id: [5, 'Receive'], summary: false, note: false, date_deadline: day(4), user_id: [30, 'Stores In Odoo'] },
    ],
    'purchase.order': [
      { id: 501, name: 'P00491', partner_id: [1, 'A Supplier'], amount_total: 250 },
      { id: 502, name: 'P00495', partner_id: [2, 'A Store'], amount_total: 80 },
    ],
    'account.move': [{ id: 701, name: 'BILL/0412', partner_id: [3, 'A Gas Seller'], amount_total: 120 }],
    'mail.message': [],
  };
  let asked = 0;
  const fetchImpl = async (url, init) => {
    asked += 1;
    const model = String(url).split('/json/2/')[1].split('/')[0];
    const body = JSON.parse(init.body);
    let rows = data[model] || [];
    for (const [field, op, value] of body.domain || []) {
      if (field === 'id' && op === 'in') rows = rows.filter((r) => value.includes(r.id));
    }
    return new Response(JSON.stringify(rows.slice(body.offset || 0, (body.offset || 0) + (body.limit || 100))), { headers: { 'Content-Type': 'application/json' } });
  };
  return { data, fetchImpl, asked: () => asked };
}

async function setUp() {
  const { db } = freshDb();
  const env = { DB: db, ODOO_KEY_ODOO: 'k' };
  await db.prepare("UPDATE sources SET config = '{\"base\":\"https://odoo.example.test\"}', enabled = 1 WHERE id = 'odoo'").run();
  await db.prepare(`INSERT INTO accounts (id, email, name) VALUES (1, 'owner@example.test', 'Test Owner'), (2, 'sam@example.test', 'Sam Supervisor'),
    (3, 'desk@example.test', 'Desk Supervisor')`).run();
  return env;
}

test('who is who: suggested by email, linked by an admin, one Odoo user to one account', async () => {
  const env = await setUp();
  const o = odoo();
  let v = await act.linksView(env, OWNER, { fetchImpl: o.fetchImpl });
  assert.deepEqual(v.users.map((u) => u.name), ['Owner In Odoo', 'Sam In Odoo', 'Stores In Odoo']);
  assert.deepEqual(v.suggest, { 1: 10, 2: 20 }, 'the same email in Odoo is offered, nothing linked yet');
  assert.deepEqual(v.links, {});
  await assert.rejects(act.linksView(env, SUPERVISOR), /Only an admin/);

  await act.saveLink(env, { accountId: 2, odooUserId: 20 }, OWNER);
  await assert.rejects(act.saveLink(env, { accountId: 3, odooUserId: 20 }, OWNER), /already linked/);
  await assert.rejects(act.saveLink(env, { accountId: 3, odooUserId: 99 }, OWNER), /not known/);
  v = await act.linksView(env, OWNER, { fetchImpl: o.fetchImpl });
  assert.deepEqual(v.links, { 2: 20 });
  assert.deepEqual(v.suggest, { 1: 10 });
  await act.saveLink(env, { accountId: 2, odooUserId: null }, OWNER);
  assert.deepEqual((await act.linksView(env, OWNER, { fetchImpl: o.fetchImpl })).links, {}, 'unlinked');
});

test('activities: everything for an admin, their own for a supervisor, POs with Odoo shared', async () => {
  const env = await setUp();
  const o = odoo();
  await act.linksView(env, OWNER, { fetchImpl: o.fetchImpl });
  await act.saveLink(env, { accountId: 2, odooUserId: 20 }, OWNER);

  const all = await act.activitiesView(env, {}, OWNER, { fetchImpl: o.fetchImpl });
  assert.deepEqual(all.activities.map((a) => [a.resName, a.state, a.late, a.userName, a.account]), [
    ['P00491', 'overdue', 3, 'Sam In Odoo', 'Sam Supervisor'],
    ['BILL/0412', 'today', 0, 'Owner In Odoo', null],
    ['P00495', 'planned', 0, 'Stores In Odoo', null],
  ]);
  const first = all.activities[0];
  assert.deepEqual([first.partner, first.amount, first.note, first.type], ['A Supplier', 25000, 'Please approve before the cashier pays.', 'To-Do']);
  assert.equal(first.url, 'https://odoo.example.test/web#model=purchase.order&id=501&view_type=form');
  assert.deepEqual(all.people.map((p) => [p.name, p.overdue, p.today, p.planned]), [
    ['Sam Supervisor', 1, 0, 0], ['Owner In Odoo', 0, 1, 0], ['Stores In Odoo', 0, 0, 1],
  ]);

  // Read again within ten minutes: Odoo is not asked.
  const asked = o.asked();
  await act.activitiesView(env, {}, OWNER, { fetchImpl: o.fetchImpl });
  assert.equal(o.asked(), asked, 'the last read is recent enough');

  // Sam, linked: his own. With Odoo shared, those on POs too, for the shifts' PO tables.
  await till.saveSettings(env, { access: { accountId: 2, area: 'odoo', level: 0 } }, OWNER);
  let sam = await act.activitiesView(env, {}, SUPERVISOR, { fetchImpl: o.fetchImpl });
  assert.deepEqual(sam.activities.map((a) => [a.resName, a.mine]), [['P00491', true]]);
  assert.equal(sam.people, null, 'nobody else’s month');
  await till.saveSettings(env, { access: { accountId: 2, area: 'odoo', level: 1 } }, OWNER);
  sam = await act.activitiesView(env, {}, SUPERVISOR, { fetchImpl: o.fetchImpl });
  assert.deepEqual(sam.activities.map((a) => [a.resName, a.mine]), [['P00491', true], ['P00495', false]]);

  // Not linked, no Odoo: nothing, and Odoo is not asked for them.
  await till.saveSettings(env, { access: { accountId: 3, area: 'odoo', level: 0 } }, OWNER);
  assert.deepEqual((await act.activitiesView(env, {}, DESK, { fetchImpl: o.fetchImpl })).activities, []);

  // Done in Odoo: gone from the list, and counted, late, in the month.
  o.data['mail.activity'] = o.data['mail.activity'].filter((a) => a.id !== 1);
  o.data['mail.message'] = [{ id: 900, model: 'purchase.order', res_id: 501, record_name: 'P00491', mail_activity_type_id: [4, 'To-Do'], author_id: [120, 'Sam In Odoo'], date: `${day(0)} 09:00:00` }];
  const after = await act.activitiesView(env, { force: '1' }, OWNER, { fetchImpl: o.fetchImpl });
  assert.ok(!after.activities.some((a) => a.resName === 'P00491'));
  assert.deepEqual(after.people.find((p) => p.name === 'Sam Supervisor'), {
    userId: 20, name: 'Sam Supervisor', linked: true, overdue: 0, today: 0, planned: 0, done: 1, doneLate: 1,
  });
});

test('Odoo not set up, or not answering: said, and what was read last is kept', async () => {
  const { db } = freshDb();
  const env = { DB: db };
  const v = await act.activitiesView(env, {}, OWNER);
  assert.equal(v.configured, false);
  const env2 = await setUp();
  const o = odoo();
  await act.activitiesView(env2, {}, OWNER, { fetchImpl: o.fetchImpl });
  const down = async () => new Response('no', { status: 500 });
  const stale = await act.activitiesView(env2, { force: '1' }, OWNER, { fetchImpl: down });
  assert.match(stale.error, /could not be read/);
  assert.equal(stale.activities.length, 3, 'the last read stands');
});
