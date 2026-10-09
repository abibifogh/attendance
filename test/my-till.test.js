import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  answer, closeShift, closedSummary, linkMail, linkRecover, linkReopen, lookUpPo, myTill, shiftAt,
} from '../src/routes/till.js';
import { signLink, verifyLink } from '../src/lib/till-link.js';
import { getPepper, hashPin } from '../src/lib/auth.js';
import { effectivePermissions } from '../src/lib/permissions.js';

/**
 * My till: closing a front-desk shift in HIVE.
 *
 * Insight is played by a stand-in on the service binding that checks every
 * request is signed, the way the real one does, and answers from a small
 * invented Odoo. Every name and number here is made up.
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

const SECRET = 'shared-for-the-test';
const ODOO = {
  P00412: { name: 'P00412', vendor: 'A Produce Seller', total: 44000, state: 'purchase', confirmed: true },
  P00415: { name: 'P00415', vendor: 'A Gas Seller', total: 18000, state: 'purchase', confirmed: true },
  P00420: { name: 'P00420', vendor: 'A Hardware Shop', total: 6500, state: 'draft', confirmed: false },
};

/** Insight, as far as HIVE can tell. */
function insight({ issues = [] } = {}) {
  const asked = [];
  return {
    asked,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const ok = await verifyLink(SECRET, { at: request.headers.get('X-Till-At'), sig: request.headers.get('X-Till-Sig'), path: url.pathname, bodyText: text });
      if (!ok) return Response.json({ error: 'unsigned' }, { status: 401 });
      const body = JSON.parse(text);
      asked.push([url.pathname, body]);
      if (url.pathname.endsWith('/setup')) {
        return Response.json({ checks: [{ id: 1, label: 'Scale' }, { id: 2, label: 'Hair dryer' }], rentals: [{ id: 'padlock', label: 'Padlocks', unit: 'padlock' }] });
      }
      if (url.pathname.endsWith('/po')) {
        return Response.json({ found: body.names.map((t) => {
          const digits = String(t).replace(/\D/g, '').padStart(5, '0');
          return ODOO[`P${digits}`] ? { typed: t, ...ODOO[`P${digits}`] } : { typed: t, name: null };
        }) });
      }
      if (url.pathname.endsWith('/recipients')) return Response.json({ to: [{ userId: 3, name: 'Boss', push: true, email: false, amounts: true }] });
      if (url.pathname.endsWith('/issues')) return Response.json({ issues, cleared: 0 });
      return Response.json({ error: 'unknown' }, { status: 404 });
    },
  };
}

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec("DELETE FROM users; DELETE FROM att_staff; UPDATE settings SET value = 'UTC' WHERE key = 'timezone';");
  const db = d1(raw);
  const pepper = await getPepper(db);
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Ama Test', 'Front office', '2020-01-01')").run();
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, staff_id, active, permissions) VALUES (7, 'Ama Test', 'staff', ?, 1, 1, '[\"att_me\",\"till\"]')")
    .run(await hashPin('246810', pepper));
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, active, permissions) VALUES (8, 'Kofi Test', 'staff', ?, 1, '[\"till\"]')")
    .run(await hashPin('135791', pepper));
  raw.prepare("INSERT INTO users (id, name, role, active) VALUES (3, 'Boss', 'admin', 1)").run();
  return { raw, db };
}

const AMA = { user: { id: 7, name: 'Ama Test', role: 'staff', staff_id: 1 } };
const KOFI = { user: { id: 8, name: 'Kofi Test', role: 'staff', staff_id: null } };

const ctx = (db, session, { body = null, path = '/api/me/till', env = {} } = {}) => ({
  db,
  env: { INSIGHT_SSO_SECRET: SECRET, ...env },
  url: new URL(`https://x${path}`),
  session,
  executionContext: null,
  request: new Request(`https://x${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }),
});

/** A complete, correct closing report for the shift on screen. */
const good = (shift, extra = {}) => ({
  day: shift.day, slot: shift.slot, floatOk: true, cash: '1083.50', toSafe: true,
  envelopes: [{ no: '417', amount: '1500' }],
  expenses: [{ po: '412', paid: '440' }],
  rentals: { padlock: { start: 6, end: 5 } },
  checks: [{ id: 1, ok: true }, { id: 2, ok: false, guest: 'Room 12' }],
  pin: '246810', device: 'pc', ...extra,
});

test('the shift being closed, from the clock', () => {
  assert.deepEqual(shiftAt('2026-10-08 22:04'), { day: '2026-10-08', slot: 'afternoon' });
  assert.deepEqual(shiftAt('2026-10-08 14:30'), { day: '2026-10-08', slot: 'morning' });
  assert.deepEqual(shiftAt('2026-10-08 23:30'), { day: '2026-10-08', slot: 'night' });
  assert.deepEqual(shiftAt('2026-10-09 05:50'), { day: '2026-10-08', slot: 'night' }, 'before six is the night before');
  assert.deepEqual(shiftAt('2026-10-09 00:30'), { day: '2026-10-08', slot: 'night' });
});

test('My till is its own permission, and gives nothing else', () => {
  const list = effectivePermissions({ role: 'staff', permissions: '["till"]' });
  assert.deepEqual(list, ['till']);
  assert.ok(!effectivePermissions({ role: 'staff', permissions: null }).includes('till'), 'not every member of staff closes a till');
});

test('closing a shift: checked, signed, stored and told', async () => {
  const { db, raw } = await setup();
  const binding = insight();
  const env = { INSIGHT: binding };
  const screen = await (await myTill(ctx(db, AMA, { env }))).json();
  assert.equal(screen.linked, true);
  assert.deepEqual(screen.setup.checks.map((c) => c.label), ['Scale', 'Hair dryer']);
  const shift = screen.choices[0];

  // Looked up as it is typed, read-only.
  const po = await (await lookUpPo(ctx(db, AMA, { env, body: { po: 'po412' }, path: '/api/me/till/po' }))).json();
  assert.deepEqual([po.name, po.counted, po.state], ['P00412', true, 'confirmed']);

  // Several at once, as typed or pasted: each looked up, repeats dropped.
  const many = await (await lookUpPo(ctx(db, AMA, { env, body: { pos: ['412', ' 415 ', '420', '999', '412'] }, path: '/api/me/till/po' }))).json();
  assert.deepEqual(many.found.map((f) => [f.po, f.name, f.counted, f.total ?? null]),
    [['412', 'P00412', true, 44000], ['415', 'P00415', true, 18000], ['420', 'P00420', false, 6500], ['999', null, false, null]]);
  await assert.rejects(lookUpPo(ctx(db, AMA, { env, body: { pos: [] }, path: '/api/me/till/po' })), /at least one/);

  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { pin: '000000' }) })), /PIN is not right/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { checks: [{ id: 1, ok: true }, { id: 2, ok: false }] }) })), /which guest has it, or explain/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { envelopes: [{ no: 'E417', amount: '1500' }] }) })), /digits only/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { toSafe: true, envelopes: [] }) })), /envelope number/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { rentals: {} }) })), /Padlocks at the start/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good({ day: '2020-01-01', slot: 'morning' }) })), /cannot be closed from here/);

  const sent = await (await closeShift(ctx(db, AMA, { env, body: good(shift, { expenses: [{ po: '412', paid: '1' }, { po: '420', paid: '65' }] }) }))).json();
  assert.equal(sent.ok, true);
  const row = raw.prepare('SELECT * FROM till_report').get();
  assert.deepEqual([row.cash, row.to_safe, row.user_id, row.device], [108350, 1, 7, 'pc']);
  assert.deepEqual(JSON.parse(row.envelopes), [{ no: '417', amount: 150000 }]);
  const lines = JSON.parse(row.expenses);
  assert.deepEqual(lines.map((e) => [e.name, e.counted, e.state]), [['P00412', true, 'confirmed'], ['P00420', false, 'draft']]);
  assert.deepEqual(raw.prepare('SELECT po, paid, total FROM till_po').all().map((r) => ({ ...r })), [{ po: 'P00412', paid: 44000, total: 44000 }]);

  // The boss was told, with the amounts, because Insight said so.
  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'till.closed'").get();
  assert.equal(notice.user_id, 3);
  assert.match(notice.body, /Drawer GH₵ 1,083.50 · safe GH₵ 1,500.00 in envelope 417 · GH₵ 65.00 of expenses with no confirmed PO · hair dryer not at the desk \(Room 12\) · padlocks 6 → 5\./);

  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift) })), /already closed that shift/);

  // Kofi cannot claim the same PO on his shift.
  const second = await (await closeShift(ctx(db, KOFI, { env, body: good(shift, { pin: '135791' }) }))).json();
  assert.deepEqual(second.report.expenses.map((e) => [e.name, e.counted, e.state]), [['P00412', false, 'claimed']]);
});

test('without the link, a shift can still be closed and nothing is counted unchecked', async () => {
  const { db, raw } = await setup();
  const screen = await (await myTill(ctx(db, AMA))).json();
  assert.equal(screen.linked, false);
  assert.deepEqual(screen.setup.rentals.map((r) => r.id), ['padlock'], 'the form still asks what it always asks');
  await closeShift(ctx(db, AMA, { body: good(screen.choices[0]) }));
  const lines = JSON.parse(raw.prepare('SELECT expenses FROM till_report').get().expenses);
  assert.deepEqual(lines.map((e) => [e.counted, e.state]), [[false, 'unchecked']]);
});

test('a PO answers cash that left the drawer, once', async () => {
  const { db, raw } = await setup();
  const key = 'unexplained:2026-10-07:afternoon';
  const env = { INSIGHT: insight({ issues: [{ key, kind: 'unexplained', label: 'Cash left the drawer with no envelope or PO', day: '2026-10-07', slot: 'afternoon', amount: -18000 }] }) };
  await assert.rejects(answer(ctx(db, AMA, { env, body: { key: 'drawer:x', how: 'explain', text: 'hm' }, path: '/api/me/till/answer' })), /not on your list/);
  await assert.rejects(answer(ctx(db, AMA, { env, body: { key, how: 'po', po: '420' }, path: '/api/me/till/answer' })), /draft in Odoo|not confirmed/);
  await answer(ctx(db, AMA, { env, body: { key, how: 'po', po: '415' }, path: '/api/me/till/answer' }));
  assert.deepEqual({ ...raw.prepare('SELECT po, via, day, slot, paid FROM till_po').get() }, { po: 'P00415', via: 'answer', day: '2026-10-07', slot: 'afternoon', paid: 18000 });
  await assert.rejects(answer(ctx(db, AMA, { env, body: { key, how: 'po', po: '415' }, path: '/api/me/till/answer' })), /already been claimed/);
  await answer(ctx(db, AMA, { env, body: { key, how: 'repay', text: 'From my pay, please' }, path: '/api/me/till/answer' }));
  assert.equal(raw.prepare("SELECT how FROM till_answer ORDER BY id DESC LIMIT 1").get().how, 'repay');
});

test('Insight can take a shortage from pay, as a one-month advance, only when it signs the request', async () => {
  const { db, raw } = await setup();
  const path = '/api/link/till/recover';
  const body = JSON.stringify({ userId: 7, amount: 5000, reason: 'Till: the drawer did not agree, 2026-10-06 afternoon', by: 'Test Owner' });
  const signed = (headers) => ({
    db, env: { INSIGHT_SSO_SECRET: SECRET }, url: new URL(`https://x${path}`), session: null, executionContext: null,
    request: new Request(`https://x${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }),
  });
  await assert.rejects(linkRecover(signed({})), /did not come from Insight/);
  await assert.rejects(linkRecover(signed(await signLink('wrong', path, body))), /did not come from Insight/);
  const out = await (await linkRecover(signed(await signLink(SECRET, path, body)))).json();
  const advance = raw.prepare('SELECT * FROM hr_advance WHERE id = ?').get(out.advanceId);
  assert.deepEqual([advance.staff_id, advance.amount, advance.months, advance.monthly, advance.status, advance.purpose], [1, 50, 1, 50, 'approved', 'other']);

  // Nobody's pay to take it from.
  const kofi = JSON.stringify({ userId: 8, amount: 5000 });
  const k = { ...signed({}), request: new Request(`https://x${path}`, { method: 'POST', headers: await signLink(SECRET, path, kofi), body: kofi }) };
  await assert.rejects(linkRecover(k), /not linked to a staff record/);
});

test('a reopened report frees its POs and can be sent again', async () => {
  const { db, raw } = await setup();
  const env = { INSIGHT: insight() };
  const screen = await (await myTill(ctx(db, AMA, { env }))).json();
  await closeShift(ctx(db, AMA, { env, body: good(screen.choices[0]) }));
  const id = raw.prepare('SELECT id FROM till_report').get().id;
  const path = '/api/link/till/reopen';
  const body = JSON.stringify({ reportId: id, reason: 'The cash was typed wrong', by: 'Test Owner' });
  await linkReopen({ db, env: { INSIGHT_SSO_SECRET: SECRET }, url: new URL(`https://x${path}`), executionContext: null,
    request: new Request(`https://x${path}`, { method: 'POST', headers: await signLink(SECRET, path, body), body }) });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM till_po').get().n, 0);
  await closeShift(ctx(db, AMA, { env, body: good(screen.choices[0], { cash: '1093.50' }) }));
  assert.deepEqual(raw.prepare('SELECT cash, reopened_at IS NOT NULL AS old FROM till_report ORDER BY id').all().map((r) => [r.cash, r.old]), [[108350, 1], [109350, 0]]);
});

test('what a closed shift says without the amounts', () => {
  const r = { cash: 100000, toSafe: false, envelopes: [], expenses: [{ paid: 500, counted: false }], floatOk: false, floatDiff: -2000, checks: [], rentals: {} };
  assert.equal(closedSummary(r, false), 'Drawer counted · nothing to the safe · an expense with no confirmed PO · float not right.');
  assert.doesNotMatch(closedSummary(r, false), /GH₵/);
});

test('Insight can send one email through HIVE, only when it signs the request', async () => {
  const { db, raw } = await setup();
  raw.exec("INSERT INTO settings (key, value) VALUES ('email_from', 'desk@hotel.test') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const path = '/api/link/mail';
  const body = JSON.stringify({ to: 'new.person@example.test', subject: 'You are invited', html: '<p>Hello</p>', kind: 'insight_invite' });
  const call = (headers, env = {}) => linkMail({
    db, env: { INSIGHT_SSO_SECRET: SECRET, RESEND_API_KEY: 'k', ...env }, url: new URL(`https://x${path}`), session: null, executionContext: null,
    request: new Request(`https://x${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }),
  });

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push([String(url), JSON.parse(init.body)]); return Response.json({ id: 'x' }); };
  try {
    await assert.rejects(call({}), /did not come from Insight/);
    assert.equal(sent.length, 0);

    const out = await (await call(await signLink(SECRET, path, body))).json();
    assert.equal(out.ok, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0][0], /resend\.com\/emails$/);
    assert.deepEqual(sent[0][1].to, ['new.person@example.test']);
    // From HIVE's own address, under Insight's name; never from the request.
    assert.equal(sent[0][1].from, '"Insight" <desk@hotel.test>');
    assert.ok(sent[0][1].text, 'a plain-text part goes with it');
    assert.equal(raw.prepare("SELECT status FROM email_log WHERE kind = 'insight_invite'").get().status, 'sent');

    await assert.rejects(call(await signLink(SECRET, path, body), { RESEND_API_KEY: '' }), /no email provider key/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
