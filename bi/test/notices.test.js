import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDb, freshDb } from './helpers.js';
import { callLink } from '../src/lib/link.js';
import { tell, pushTo } from '../src/lib/notices.js';
import { b64urlEncode, vapidKeys } from '../src/lib/webpush.js';
import * as notices from '../src/routes/notices.js';
import * as storeReq from '../src/routes/storereq.js';
import * as todo from '../src/routes/todo.js';

/**
 * Notifications: everything Insight emails a person also in their inbox, and
 * pushed to the phones they turned it on for; the inbox's filters; and the
 * kitchen's store-room requests from the breakfast app, told once by email
 * and pushed every 15 minutes until issued. Made-up people, a made-up push
 * service, a made-up breakfast app.
 */

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const GINA = { id: 31, name: 'Gina Test', email: 'gina@example.test', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const SAM = { id: 32, name: 'Sam Test', email: 'sam@example.test', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };

async function setUp() {
  const { db, raw } = freshDb();
  raw.exec(`INSERT INTO accounts (id, email, name, active) VALUES (31, 'gina@example.test', 'Gina Test', 1), (32, 'sam@example.test', 'Sam Test', 1);
    INSERT INTO account_access (account_id, system_id, role) VALUES (31, 'insight', 'supervisor'), (32, 'insight', 'supervisor');`);
  return { env: { DB: db, SITE_URL: 'https://insight.example.test' }, raw };
}

/** A browser's own keys, as one gives them when it subscribes. */
async function browserSub(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  return { endpoint, keys: { p256dh, auth } };
}

/** A made-up push service: what it was sent, and which endpoints are gone. */
function pushService({ gone = [] } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, bytes: init.body?.length || 0 });
    return new Response('', { status: gone.includes(String(url)) ? 410 : 201 });
  };
  return { sent, fetchImpl };
}

test('an email Insight sends a person is in their inbox too; urgent, unread and read are kept apart', async () => {
  const { env } = await setUp();
  const hive = async () => Response.json({ ok: true });
  // A to-do given to Gina, Sam copied; a stranger left out.
  await callLink({ env, fetchImpl: hive, secret: 's', path: '/api/link/mail', body: { to: 'Gina@Example.test', cc: ['sam@example.test', 'nobody@example.test'], subject: 'A to-do for you: count the laundry tokens', text: 'Kofi Test gave you a to-do.\n\nDue Monday.', kind: 'insight_todo' } });
  await callLink({ env, fetchImpl: hive, secret: 's', path: '/api/link/mail', body: { to: 'gina@example.test', subject: 'Proof asked: paid back to the guest', text: 'Send a picture.', kind: 'insight_proof' } });
  await callLink({ env, fetchImpl: hive, secret: 's', path: '/api/link/mail', body: { to: 'gina@example.test', subject: 'Your 07:00 list: 2 overdue', text: 'Two things are late.', kind: 'insight_digest' } });
  // Not an email: nothing in the inbox.
  await callLink({ env, fetchImpl: hive, secret: 's', path: '/api/link/report', body: { to: 'gina@example.test', subject: 'x' } });

  let d = await notices.list(env, GINA, { filter: 'all' });
  assert.equal(d.items.length, 3);
  assert.deepEqual(d.counts, { all: 3, unread: 3, urgent: 2, read: 0 });
  const todoN = d.items.find((n) => n.kind === 'insight_todo');
  assert.equal(todoN.link, '#/inbox');
  assert.equal(todoN.body, 'Kofi Test gave you a to-do. Due Monday.');
  assert.equal(todoN.urgent, false);
  assert.equal((await notices.list(env, SAM, { filter: 'all' })).items.length, 1, 'copied: told too');
  assert.deepEqual((await notices.list(env, GINA, { filter: 'urgent' })).items.map((n) => n.kind).sort(), ['insight_digest', 'insight_proof']);

  // Read, unread again, all read; only one's own.
  await notices.mark(env, { ids: [todoN.id], read: true }, GINA);
  assert.equal((await notices.list(env, GINA, { filter: 'read' })).items.length, 1);
  assert.equal((await notices.list(env, GINA, { filter: 'unread' })).items.length, 2);
  await notices.mark(env, { ids: [todoN.id], read: true }, SAM);
  await notices.mark(env, { ids: [todoN.id], read: false }, GINA);
  assert.equal((await notices.counts(env, GINA)).unread, 3);
  await notices.mark(env, { all: true }, GINA);
  d = await notices.list(env, GINA, { filter: 'unread' });
  assert.equal(d.items.length, 0);
  assert.equal(d.counts.read, 3);
  await assert.rejects(notices.list(env, OWNER, {}), /their own account/);
});

test('push: to every device a person turned on, encrypted and signed; a device gone is forgotten; one thing told again is one line', async () => {
  const { env } = await setUp();
  const keys = await vapidKeys(env.DB);
  assert.equal((await vapidKeys(env.DB)).publicKey, keys.publicKey, 'made once, then kept');
  assert.equal((await notices.pushKey(env)).publicKey, keys.publicKey);

  await assert.rejects(notices.subscribe(env, { subscription: { endpoint: 'http://x' } }, GINA), /did not give/);
  await notices.subscribe(env, { subscription: await browserSub('https://push.example.test/phone'), device: 'Android phone, Chrome' }, GINA);
  await notices.subscribe(env, { subscription: await browserSub('https://push.example.test/laptop') }, GINA);
  const svc = pushService({ gone: ['https://push.example.test/laptop'] });

  const out = await tell(env, { to: [31], kind: 'insight_store', key: 'store:7', title: 'R-0007: Kitchen needs stock now', body: 'Milk 4 L', urgent: true, link: '#/inbox' }, { fetchImpl: svc.fetchImpl });
  assert.deepEqual(out, { told: 1, pushed: 1 });
  assert.equal(svc.sent.length, 2);
  const h = svc.sent[0].headers;
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.equal(h.Urgency, 'high');
  assert.match(h.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  assert.ok(svc.sent[0].bytes > 100, 'encrypted, not plain');
  // The laptop is gone for good: forgotten.
  let d = await notices.list(env, GINA, {});
  assert.deepEqual(d.devices.map((x) => x.device), ['Android phone, Chrome']);

  // Told again: the same line, unread again, told twice.
  await notices.mark(env, { all: true }, GINA);
  await tell(env, { to: [31], kind: 'insight_store', key: 'store:7', title: 'Still waiting: R-0007', body: 'Milk 4 L', urgent: true }, { fetchImpl: svc.fetchImpl });
  d = await notices.list(env, GINA, {});
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].title, 'Still waiting: R-0007');
  assert.equal(d.items[0].times, 2);
  assert.equal(d.items[0].read, false);

  // Off for that phone: nothing more is pushed to it.
  await notices.unsubscribe(env, { endpoint: 'https://push.example.test/phone' }, GINA);
  assert.equal(await pushTo(env, 31, { title: 'x' }, { fetchImpl: svc.fetchImpl }), 0);
});

// ------------------------------------------------- the breakfast app's store room --

/** A made-up breakfast app: its store room, as its migration 0024 makes it. */
function breakfastApp() {
  const { db, raw } = emptyDb();
  raw.exec(`CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name TEXT, unit TEXT);
    CREATE TABLE store_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, department TEXT NOT NULL DEFAULT 'Kitchen', needed TEXT NOT NULL DEFAULT 'now', note TEXT,
      status TEXT NOT NULL DEFAULT 'waiting', follows INTEGER, requested_by TEXT NOT NULL, requested_by_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      issued_by TEXT, issued_at TEXT, day TEXT, issue_note TEXT, received_by TEXT, received_at TEXT, received_auto INTEGER NOT NULL DEFAULT 0,
      difference INTEGER NOT NULL DEFAULT 0, receipt_note TEXT, closed_by TEXT, closed_at TEXT);
    CREATE TABLE store_request_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, asked REAL NOT NULL,
      issued REAL, received REAL, unit_cost REAL, short_reason TEXT);
    INSERT INTO ingredients (id, name, unit) VALUES (1, 'Milk', 'L'), (2, 'Tissue', 'roll'), (3, 'Eggs', 'crate');`);
  const ask = (by, lines, { needed = 'now', note = null, at = '2026-11-02 06:00:00' } = {}) => {
    const { lastInsertRowid: id } = raw.prepare('INSERT INTO store_requests (requested_by, needed, note, created_at) VALUES (?, ?, ?, ?)').run(by, needed, note, at);
    for (const [item, qty] of lines) raw.prepare('INSERT INTO store_request_lines (request_id, ingredient_id, asked) VALUES (?, ?, ?)').run(id, item, qty);
    return Number(id);
  };
  return { db, raw, ask };
}

test('the kitchen asks the store room: a to-do for the person chosen, an email once, a push every 15 minutes until it is issued', async () => {
  const { env } = await setUp();
  const bf = breakfastApp();
  env.BREAKFAST_DB = bf.db;
  env.BREAKFAST_URL = 'https://breakfast.example.test';
  const mails = [];
  env.SSO_SECRET_ATTENDANCE = 'link-secret';
  const svc = pushService();
  const fetchImpl = async (req, init) => {
    if (req instanceof Request) { mails.push(JSON.parse(await req.text())); return Response.json({ ok: true }); }
    return svc.fetchImpl(req, init);
  };
  await notices.subscribe(env, { subscription: await browserSub('https://push.example.test/gina') }, GINA);

  // Gina is chosen for them.
  await todo.saveTodoSettings(env, { storeTo: 31 }, OWNER, { today: '2026-11-02' });
  assert.equal((await todo.listTodos(env, OWNER)).storeTo, 31);
  await assert.rejects(todo.saveTodoSettings(env, { storeTo: 999 }, OWNER), /Choose a supervisor or an admin/);

  const id = bf.ask('Ama Test', [[1, 4], [2, 6]], { note: 'For the 7:00 sitting' });
  const t0 = Date.parse('2026-11-02T06:05:00Z');
  let out = await storeReq.syncStore(env, { now: t0, fetchImpl });
  assert.deepEqual([out.raised, out.emailed, out.pushed], [1, 1, 1]);
  // The email: to Gina, what was asked, where to issue it.
  assert.equal(mails[0].to, 'gina@example.test');
  assert.equal(mails[0].subject, 'R-0001: Kitchen needs stock now');
  assert.match(mails[0].text, /Milk: 4 L\n- Tissue: 6 roll/);
  assert.match(mails[0].text, /https:\/\/breakfast\.example\.test\/#\/store/);
  // The to-do: in To sort out, Gina's, on her Today.
  let item = (await todo.listTodos(env, GINA)).items.find((t) => t.kind === 'store');
  assert.equal(item.ref, 'R-0001');
  assert.equal(item.assignee.id, 31);
  assert.equal(item.kindLabel, 'Kitchen store request');
  assert.deepEqual(item.detail.lines, [{ name: 'Milk', unit: 'L', asked: 4 }, { name: 'Tissue', unit: 'roll', asked: 6 }]);
  const assistant = await import('../src/routes/assistant.js');
  const got = await assistant.gather(env, GINA, { now: t0 });
  const line = got.items.find((x) => x.tag === 'Store');
  assert.equal(line.title, 'R-0001: Kitchen needs stock now');
  assert.equal(line.actions[0].href, 'https://breakfast.example.test/#/store');
  // In her inbox, urgent.
  let inbox = await notices.list(env, GINA, { filter: 'urgent' });
  assert.equal(inbox.items.length, 1);

  // Ten minutes on: not yet. Fifteen: pushed again, the same line, no second email.
  out = await storeReq.syncStore(env, { now: t0 + 10 * 60000, fetchImpl });
  assert.equal(out.reminded, 0);
  out = await storeReq.syncStore(env, { now: t0 + 16 * 60000, fetchImpl });
  assert.equal(out.reminded, 1);
  assert.equal(mails.length, 1);
  assert.equal(svc.sent.length, 2);
  inbox = await notices.list(env, GINA, { filter: 'all' });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].times, 2);
  assert.match(inbox.items[0].title, /^Still waiting: R-0001, Kitchen/);

  // Issued in the breakfast app: the to-do closes itself, the reminders stop, the notification is done.
  bf.raw.prepare("UPDATE store_requests SET status = 'issued', issued_by = 'Kojo Test' WHERE id = ?").run(id);
  out = await storeReq.syncStore(env, { now: t0 + 32 * 60000, fetchImpl });
  assert.equal(out.closed, 1);
  item = (await todo.listTodos(env, OWNER, { closed: true })).items.find((t) => t.kind === 'store');
  assert.equal(item.closedWhy, 'Issued in the breakfast app by Kojo Test.');
  out = await storeReq.syncStore(env, { now: t0 + 48 * 60000, fetchImpl });
  assert.deepEqual([out.reminded, out.raised], [0, 0]);
  assert.equal(svc.sent.length, 2);
  inbox = await notices.list(env, GINA, { filter: 'urgent' });
  assert.equal(inbox.items.length, 0, 'done: no longer urgent');
});

test('store requests: nobody chosen shares them out; declined and cancelled close too; the breakfast app not there changes nothing', async () => {
  const { env } = await setUp();
  assert.match((await storeReq.syncStore(env)).skipped, /not bound/);
  const bf = breakfastApp();
  env.BREAKFAST_DB = bf.db;
  const a = bf.ask('Ama Test', [[3, 1]], { needed: 'tomorrow' });
  const b = bf.ask('Esi Test', [[1, 2]]);
  const svc = pushService();
  await storeReq.syncStore(env, { now: Date.parse('2026-11-02T06:05:00Z'), fetchImpl: svc.fetchImpl });
  const items = (await todo.listTodos(env, OWNER)).items.filter((t) => t.kind === 'store');
  assert.equal(items.length, 2);
  assert.ok(items.every((t) => [31, 32].includes(t.assignee?.id)), 'shared out among supervisors');
  assert.equal(items.find((t) => t.ref === 'R-0001').detail.neededText, 'tomorrow morning');

  bf.raw.prepare("UPDATE store_requests SET status = 'declined', issued_by = 'Kojo Test', issue_note = 'None in stock' WHERE id = ?").run(a);
  bf.raw.prepare("UPDATE store_requests SET status = 'cancelled', closed_by = 'Esi Test' WHERE id = ?").run(b);
  const out = await storeReq.syncStore(env, { now: Date.parse('2026-11-02T06:20:00Z'), fetchImpl: svc.fetchImpl });
  assert.equal(out.closed, 2);
  const closed = (await todo.listTodos(env, OWNER, { closed: true })).items.filter((t) => t.kind === 'store');
  assert.deepEqual(closed.map((t) => t.closedWhy).sort(), ['Cancelled in the breakfast app by Esi Test.', 'Declined in the breakfast app by Kojo Test: None in stock.']);

  // Its store room not set up yet: said, and nothing changes.
  const empty = emptyDb();
  env.BREAKFAST_DB = empty.db;
  assert.match((await storeReq.syncStore(env)).skipped, /could not be read/);
});
