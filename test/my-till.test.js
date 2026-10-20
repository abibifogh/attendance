import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  answer, closeShift, closedSummary, linkExpect, linkSummary, linkMail, linkMove, linkRecover, linkReopen, lookUpPo, myTill, poChanges, shiftAt,
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
  P00421: { name: 'P00421', vendor: 'A Paint Shop', total: 9000, state: 'cancel', confirmed: false },
};

/** Insight, as far as HIVE can tell. */
function insight({ issues = [], recipients = [{ userId: 3, name: 'Boss', push: true, email: false, amounts: true }], form = null } = {}) {
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
        return Response.json({ formLive: Boolean(form), found: body.names.map((t) => {
          const digits = String(t).replace(/\D/g, '').padStart(5, '0');
          const o = ODOO[`P${digits}`];
          return o ? { typed: t, ...o, reported: form?.reported?.[o.name] || null, decision: form?.decisions?.[o.name] || null, ...(form?.made?.[o.name] ? { madeInInsight: form.made[o.name] } : {}) } : { typed: t, name: null };
        }) });
      }
      if (url.pathname.endsWith('/po-ask')) return Response.json({ ok: true });
      if (url.pathname.endsWith('/recipients')) return Response.json({ to: recipients });
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
    [['412', 'P00412', true, 44000], ['415', 'P00415', true, 18000], ['420', 'P00420', true, 6500], ['999', null, false, null]]);
  assert.equal(many.found[2].state, 'advance', 'a requisition goes in as an advance');
  await assert.rejects(lookUpPo(ctx(db, AMA, { env, body: { pos: [] }, path: '/api/me/till/po' })), /at least one/);

  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { pin: '000000' }) })), /PIN is not right/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { checks: [{ id: 1, ok: true }, { id: 2, ok: false }] }) })), /which guest has it, or explain/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { envelopes: [{ no: 'E417', amount: '1500' }] }) })), /digits only/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { toSafe: true, envelopes: [] }) })), /envelope number/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { rentals: {} }) })), /Padlocks at the start/);
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good({ day: '2020-01-01', slot: 'morning' }) })), /cannot be closed from here/);

  // A cancelled PO cannot close a shift.
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { expenses: [{ po: '412', paid: '1' }, { po: '421', paid: '90' }] }) })),
    /This PO cannot go on the report: P00421 \(cancelled in Odoo\)/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM till_report').get().n, 0, 'nothing was stored');

  const sent = await (await closeShift(ctx(db, AMA, { env, body: good(shift, { expenses: [{ po: '412', paid: '1' }] }) }))).json();
  assert.equal(sent.ok, true);
  const row = raw.prepare('SELECT * FROM till_report').get();
  assert.deepEqual([row.cash, row.to_safe, row.user_id, row.device], [108350, 1, 7, 'pc']);
  assert.deepEqual(JSON.parse(row.envelopes), [{ no: '417', amount: 150000 }]);
  const lines = JSON.parse(row.expenses);
  assert.deepEqual(lines.map((e) => [e.name, e.counted, e.state]), [['P00412', true, 'confirmed']]);
  assert.deepEqual(raw.prepare('SELECT po, paid, total FROM till_po').all().map((r) => ({ ...r })), [{ po: 'P00412', paid: 44000, total: 44000 }]);

  // The boss was told the moment it was signed, with the amounts, because Insight said so.
  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'till.closed'").get();
  assert.equal(notice.user_id, 3);
  assert.match(notice.body, /Drawer GH₵ 1,083.50 · safe GH₵ 1,500.00 in envelope 417 · hair dryer not at the desk \(Room 12\) · padlocks 6 → 5\./);
  assert.ok(binding.asked.some(([p, body]) => p.endsWith('/recipients') && body.event === 'closed'), 'Insight was asked who follows closed shifts');

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
  await assert.rejects(answer(ctx(db, AMA, { env, body: { key, how: 'po', po: '420' }, path: '/api/me/till/answer' })), /draft in Odoo|not approved/);
  await answer(ctx(db, AMA, { env, body: { key, how: 'po', po: '415' }, path: '/api/me/till/answer' }));
  assert.deepEqual({ ...raw.prepare('SELECT po, via, day, slot, paid FROM till_po').get() }, { po: 'P00415', via: 'answer', day: '2026-10-07', slot: 'afternoon', paid: 18000 });
  await assert.rejects(answer(ctx(db, AMA, { env, body: { key, how: 'po', po: '415' }, path: '/api/me/till/answer' })), /already been claimed/);
  await answer(ctx(db, AMA, { env, body: { key, how: 'repay', text: 'From my pay, please' }, path: '/api/me/till/answer' }));
  assert.equal(raw.prepare("SELECT how FROM till_answer ORDER BY id DESC LIMIT 1").get().how, 'repay');
});

test('when Odoo or Insight cannot answer, adding a PO says so in words, and what to do', async () => {
  const { db } = await setup();
  const failing = (status, error) => ({ INSIGHT: { fetch: async () => Response.json({ error }, { status }) } });
  await assert.rejects(lookUpPo(ctx(db, AMA, { env: failing(502, 'Odoo did not answer in time (purchase.order, search_read).'), body: { pos: ['412'] }, path: '/api/me/till/po' })),
    /The PO could not be checked just now\. Odoo did not answer in time \(purchase\.order, search_read\)\. Try Add again in a minute/);
  await assert.rejects(lookUpPo(ctx(db, AMA, { env: failing(500, 'Something went wrong on the server'), body: { po: '412' }, path: '/api/me/till/po' })),
    /could not be checked just now\. Insight had a problem\. Try Add again/);
  // Something wrong with what was typed is still said as it was.
  await assert.rejects(lookUpPo(ctx(db, AMA, { env: failing(502, 'x'), body: { pos: [] }, path: '/api/me/till/po' })), /at least one/);
});

test('a shift not checked yet takes a note, not an answer; once checked, the other way round', async () => {
  const { db, raw } = await setup();
  const key = 'drawer:2026-10-07:afternoon';
  const issue = { key, kind: 'drawer', label: 'The drawer did not agree', day: '2026-10-07', slot: 'afternoon', amount: -3000 };
  const unchecked = { INSIGHT: insight({ issues: [{ ...issue, checked: false }] }) };
  await assert.rejects(answer(ctx(db, AMA, { env: unchecked, body: { key, how: 'explain', text: 'A guest' }, path: '/api/me/till/answer' })), /not been checked yet: add a note/);
  const noted = await (await answer(ctx(db, AMA, { env: unchecked, body: { key, how: 'note', text: 'A guest was given change twice' }, path: '/api/me/till/answer' }))).json();
  assert.equal(noted.note, true);
  assert.deepEqual({ ...raw.prepare('SELECT how, text FROM till_answer').get() }, { how: 'note', text: 'A guest was given change twice' });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'till.answer'").get().n, 0, 'a note tells nobody');

  const checked = { INSIGHT: insight({ issues: [{ ...issue, checked: true }] }) };
  await assert.rejects(answer(ctx(db, AMA, { env: checked, body: { key, how: 'note', text: 'x' }, path: '/api/me/till/answer' })), /has been checked: answer it/);
  await answer(ctx(db, AMA, { env: checked, body: { key, how: 'explain', text: 'A guest was given change twice' }, path: '/api/me/till/answer' }));
  // An Insight that does not say (older) counts as checked, as before.
  const older = { INSIGHT: insight({ issues: [issue] }) };
  await answer(ctx(db, AMA, { env: older, body: { key, how: 'repay', text: 'From my pay' }, path: '/api/me/till/answer' }));
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

test('an email from Insight can carry a small CSV, and nothing else', async () => {
  const { db, raw } = await setup();
  raw.exec("INSERT INTO settings (key, value) VALUES ('email_from', 'desk@hotel.test') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const path = '/api/link/mail';
  const send = async (attachments) => {
    const body = JSON.stringify({ to: 'accounts@example.test', subject: 'Prepaid stays', html: '<p>Hi</p>', kind: 'insight_prepaid', attachments });
    return linkMail({
      db, env: { INSIGHT_SSO_SECRET: SECRET, RESEND_API_KEY: 'k' }, url: new URL(`https://x${path}`), session: null, executionContext: null,
      request: new Request(`https://x${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await signLink(SECRET, path, body)) }, body }),
    });
  };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return Response.json({ id: 'x' }); };
  try {
    await send([{ filename: 'prepaid-stays-2026-09.csv', content: btoa('Reservation,Charged\r\n1,2') }]);
    assert.deepEqual(sent[0].attachments, [{ filename: 'prepaid-stays-2026-09.csv', content: btoa('Reservation,Charged\r\n1,2') }]);
    await assert.rejects(send([{ filename: 'run.exe', content: 'AAAA' }]), /Only a CSV/);
    await assert.rejects(send([{ filename: 'a.csv', content: 'not base64!' }]), /not a small CSV/);
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the daily summary reaches an address on the staff record, with or without amounts, and says why when it cannot', async () => {
  const { db, raw } = await setup();
  // Ama has a login with no address on it, and her address on her staff record. The boss has neither.
  raw.prepare("INSERT INTO hr_profile (staff_id, personal_email) VALUES (1, 'ama@example.test')").run();
  raw.exec("INSERT INTO settings (key, value) VALUES ('email_from', 'hive@example.test') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const path = '/api/link/till/summary';
  const body = JSON.stringify({
    title: 'Saturday 10 October: 3 shifts closed', sub: '2 agree · afternoon short', subWith: '2 agree · afternoon short gh₵20.00',
    lines: [{ label: 'Morning · Ama Test', tone: 'good', with: 'Agrees', without: 'Agrees' }, { label: 'Afternoon · Kofi Test', tone: 'bad', with: 'Short GH₵20.00', without: 'Short' }],
    needs: [['Corrections to approve', '1']],
    recipients: [{ userId: 7, name: 'Ama Test', push: false, email: true, amounts: false }, { userId: 3, name: 'Boss', push: true, email: true, amounts: true }],
  });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push([String(url), JSON.parse(init.body)]); return Response.json({ id: 'x' }); };
  try {
    const call = async (secret = SECRET) => linkSummary({ db, env: { INSIGHT_SSO_SECRET: SECRET, RESEND_API_KEY: 'k', INSIGHT_SSO_URL: 'https://insight.example.test/api/sso/redeem' },
      url: new URL(`https://x${path}`), executionContext: null,
      request: new Request(`https://x${path}`, { method: 'POST', headers: await signLink(secret, path, body), body }) });
    await assert.rejects(call('wrong'), /did not come from Insight/);
    const out = await (await call()).json();
    assert.equal(out.sent, 2);
    const notices = raw.prepare("SELECT user_id, body, link FROM app_notices WHERE kind = 'till.summary' ORDER BY user_id").all();
    assert.deepEqual(notices.map((n) => [n.user_id, n.body]), [[3, '2 agree · afternoon short gh₵20.00'], [7, '2 agree · afternoon short']], 'amounts only for whoever sees them');
    assert.equal(notices[0].link, 'https://insight.example.test/#/shifts');
    const mails = sent.filter(([u]) => u.includes('resend'));
    assert.equal(mails.length, 1, 'one email, to the address on Ama’s record');
    assert.deepEqual(mails[0][1].to, ['ama@example.test']);
    assert.doesNotMatch(mails[0][1].html, /GH₵20\.00/, 'no amounts for Ama');
    const log = raw.prepare("SELECT status, detail FROM email_log ORDER BY id").all().map((r) => [r.status, r.detail]);
    assert.ok(log.some(([status, detail]) => status === 'sent' && detail === 'till.summary'));
    assert.ok(log.some(([status, detail]) => status === 'skipped' && /user 3 has no email on their login or their staff record/.test(detail)),
      'the boss’s missing address is said in the email log');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Insight can move a report to the shift it belongs to, with its POs, only when it signs', async () => {
  const { db, raw } = await setup();
  const env = { INSIGHT: insight() };
  const screen = await (await myTill(ctx(db, AMA, { env }))).json();
  // Closed on the wrong row: the shift after the one she worked.
  const wrong = screen.choices[0];
  await closeShift(ctx(db, AMA, { env, body: good(wrong) }));
  const id = raw.prepare('SELECT id FROM till_report').get().id;
  const right = screen.choices[1];
  const path = '/api/link/till/move';
  const call = async (body, headers) => linkMove({ db, env: { INSIGHT_SSO_SECRET: SECRET }, url: new URL(`https://x${path}`), executionContext: null,
    request: new Request(`https://x${path}`, { method: 'POST', headers: headers || await signLink(SECRET, path, body), body }) });

  const body = JSON.stringify({ reportId: id, day: right.day, slot: right.slot, by: 'Test Owner', reason: 'Signed after the shift ended' });
  await assert.rejects(call(body, { 'Content-Type': 'application/json' }), /401|signed|did not come/i);
  const out = await (await call(body)).json();
  assert.equal(out.moved, true);
  assert.deepEqual({ ...raw.prepare('SELECT day, slot FROM till_report WHERE id = ?').get(id) }, { day: right.day, slot: right.slot });
  assert.deepEqual(raw.prepare('SELECT day, slot FROM till_po').all().map((r) => [r.day, r.slot]), [[right.day, right.slot]], 'its POs move with it');
  assert.ok(raw.prepare("SELECT title FROM app_notices WHERE user_id = 7 AND title LIKE 'Your closing report was moved%'").get(), 'she is told');
  assert.match(raw.prepare("SELECT body FROM app_notices WHERE user_id = 7 AND title LIKE 'Your closing report was moved%'").get().body, /Signed after the shift ended/);
  // Where it was, who moved it and why are kept on it, so it can be moved back.
  assert.deepEqual({ ...raw.prepare('SELECT moved_from, moved_by, moved_reason FROM till_report WHERE id = ?').get(id) },
    { moved_from: `${wrong.day}|${wrong.slot}`, moved_by: 'Test Owner', moved_reason: 'Signed after the shift ended' });

  // A shift with somebody else's report on it cannot take another.
  raw.prepare(`INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe, envelopes, expenses, rentals, checks, signed_at)
    VALUES (?, ?, 8, 'Kofi Test', 1, 0, 0, '[]', '[]', '{}', '[]', datetime('now'))`).run(wrong.day, wrong.slot);
  await assert.rejects(call(JSON.stringify({ reportId: id, day: wrong.day, slot: wrong.slot, by: 'Test Owner' })), /Kofi Test has a report on .* Reopen it first/);
  raw.prepare('DELETE FROM till_report WHERE user_id = 8').run();

  // She now has a report on that shift: another of hers cannot be moved onto it.
  await closeShift(ctx(db, AMA, { env, body: good(wrong, { expenses: [] }) }));
  const second = raw.prepare('SELECT id FROM till_report WHERE day = ? AND slot = ?').get(wrong.day, wrong.slot).id;
  await assert.rejects(call(JSON.stringify({ reportId: second, day: right.day, slot: right.slot })), /already has a report/);
});

test('a PO whose price changed after it was paid: the difference counts on the shift where it moves', async () => {
  const { db, raw } = await setup();
  const env = { INSIGHT: insight() };
  const screen = await (await myTill(ctx(db, AMA, { env }))).json();
  const [first, second, third] = screen.choices;
  const was = ODOO.P00412.total;
  try {
    await closeShift(ctx(db, AMA, { env, body: good(first) }));
    const changes = async (who = KOFI) => (await (await poChanges(ctx(db, who, { env, path: '/api/me/till/po-changes' }))).json()).changes;
    assert.deepEqual(await changes(), [], 'nothing changed yet');
    const asked = () => env.INSIGHT.asked.filter(([p]) => p.endsWith('/po')).length;
    const before = asked();
    await changes();
    assert.equal(asked(), before, 'opened again straight away: Odoo is not asked again');

    // The supplier charged GH₵ 20 more and the PO was amended in Odoo. What
    // Odoo said is remembered ten minutes; forget it, as ten minutes passing would.
    ODOO.P00412.total = was + 2000;
    assert.deepEqual(await changes(), [], 'within ten minutes, the remembered answer');
    raw.exec("UPDATE till_po_odoo SET checked_at = datetime('now', '-11 minutes')");
    const up = await changes();
    assert.equal(up.length, 1);
    assert.deepEqual([up[0].name, up[0].state, up[0].amount, up[0].paidSoFar, up[0].first.by], ['P00412', 'topup', 2000, was, 'Ama Test']);
    const look = await (await lookUpPo(ctx(db, KOFI, { env, body: { po: '412' }, path: '/api/me/till/po' }))).json();
    assert.deepEqual([look.state, look.counted, look.amount], ['topup', true, 2000], 'typed again, it is the top-up, not "already claimed"');

    const topped = await (await closeShift(ctx(db, KOFI, { env, body: good(second, { pin: '135791', expenses: [{ po: '412' }] }) }))).json();
    assert.deepEqual(topped.report.expenses.map((e) => [e.name, e.kind, e.paid, e.counted]), [['P00412', 'topup', 2000, true]]);
    assert.deepEqual(raw.prepare("SELECT kind, paid FROM till_po WHERE po = 'P00412' ORDER BY id").all().map((r) => [r.kind, r.paid]),
      [['claim', was], ['topup', 2000]]);
    assert.deepEqual(await changes(), [], 'settled: no longer shown');
    const again = await (await lookUpPo(ctx(db, KOFI, { env, body: { po: '412' }, path: '/api/me/till/po' }))).json();
    assert.deepEqual([again.state, again.counted], ['claimed', false], 'paid in full: claimed again');

    // Then it came down to GH₵ 430: GH₵ 30 change is due back.
    ODOO.P00412.total = was - 1000;
    raw.exec("UPDATE till_po_odoo SET checked_at = datetime('now', '-11 minutes')");
    const down = await changes(AMA);
    assert.deepEqual([down[0].state, down[0].amount, down[0].paidSoFar], ['change', -3000, was + 2000]);
    // Change coming back does not explain cash leaving a drawer.
    const key = `unexplained:${third.day}:${third.slot}`;
    const withIssue = { INSIGHT: insight({ issues: [{ key, kind: 'unexplained', label: 'Cash left', day: third.day, slot: third.slot, amount: -3000 }] }) };
    await assert.rejects(answer(ctx(db, AMA, { env: withIssue, body: { key, how: 'po', po: '412' }, path: '/api/me/till/answer' })), /came down in price/);
    const back = await (await closeShift(ctx(db, AMA, { env, body: good(third, { expenses: [{ po: '412' }] }) }))).json();
    assert.deepEqual(back.report.expenses.map((e) => [e.kind, e.paid, e.counted]), [['change', -3000, true]]);
    assert.equal(raw.prepare("SELECT SUM(paid) AS n FROM till_po WHERE po = 'P00412'").get().n, was - 1000, 'what left the drawers is the PO’s total now');
  } finally {
    ODOO.P00412.total = was;
  }
});

test('an advance: given out against a requisition, it holds up the next shift until approved and reported', async () => {
  const { db, raw } = await setup();
  const form = { reported: {}, decisions: {} };
  const env = { INSIGHT: insight({ form }) };
  const screen = await (await myTill(ctx(db, AMA, { env }))).json();
  // Oldest first: Ama's shift, then Kofi's after it.
  const [first, second, third, fourth] = [...screen.choices].reverse();
  const was = { ...ODOO.P00420 };
  const earlier = async (shift, who = KOFI, fresh = true) => (await (await poChanges(ctx(db, who, {
    env, path: `/api/me/till/po-changes?day=${shift.day}&slot=${shift.slot}${fresh ? '&fresh=1' : ''}`,
  }))).json());
  try {
    const out = await (await closeShift(ctx(db, AMA, { env, body: good(first, { expenses: [{ po: '420' }] }) }))).json();
    assert.deepEqual(out.report.expenses.map((e) => [e.name, e.state, e.counted, e.paid, e.advance]), [['P00420', 'advance', true, 6500, true]]);
    assert.deepEqual({ ...raw.prepare('SELECT advance, paid, state FROM till_po').get() }, { advance: 1, paid: 6500, state: 'draft' });
    assert.deepEqual((await earlier(first, AMA)).advances, [], 'not on its own shift');

    // The next shift sees it, and cannot close until it is approved.
    const pending = (await earlier(second)).advances;
    assert.deepEqual(pending.map((a) => [a.name, a.status, a.paid, a.first.by]), [['P00420', 'approve', 6500, 'Ama Test']]);
    const kofi = (shift, extra = {}) => closeShift(ctx(db, KOFI, { env, body: good(shift, { pin: '135791', expenses: [], ...extra }) }));
    await assert.rejects(kofi(second), /To close: P00420 advance of GH₵ 65\.00 \(Morning|Afternoon|Night/);
    await assert.rejects(kofi(second), /approve it in Odoo/);

    // Approved, but not on the expense form yet.
    Object.assign(ODOO.P00420, { state: 'purchase', confirmed: true });
    await assert.rejects(kofi(second), /report it on the expense form/);
    // A PO typed now that is approved and not reported cannot go on a report.
    const look = await (await lookUpPo(ctx(db, KOFI, { env, body: { po: '415' }, path: '/api/me/till/po' }))).json();
    assert.deepEqual([look.state, look.counted], ['report', false]);
    form.reported.P00415 = { amount: 17000, tnt: 1000, total: 18000, count: 1 };

    // An admin gives it more time: not in the way meanwhile.
    form.decisions.P00420 = { until: '2999-01-01', closed: false };
    assert.deepEqual((await earlier(second)).advances, []);
    form.decisions.P00420 = null;

    // Given to Ama to report: only Ama's Close shift waits for it, whatever shift; Kofi's does not.
    form.decisions.P00420 = { until: null, closed: false, given: { userId: 7, name: 'Ama Test', by: 'Test Owner' } };
    assert.deepEqual((await earlier(second)).advances, [], 'not in Kofi’s way');
    const hers = (await earlier(second, AMA)).advances;
    assert.deepEqual(hers.map((a) => [a.name, a.status, a.given]), [['P00420', 'report', { by: 'Test Owner' }]]);
    assert.deepEqual((await earlier(first, AMA)).advances.length, 1, 'even on the shift it was given out on');
    await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(second, { expenses: [] }) })), /P00420 advance of GH₵ 65\.00 \(.*given to you to report by Test Owner\): report it on the expense form/);
    form.decisions.P00420 = null;

    // Reported for exactly what was given out: settled.
    form.reported.P00420 = { amount: 6000, tnt: 500, total: 6500, count: 1 };
    await kofi(second);
    assert.deepEqual(await earlier(third), { advances: [], changes: [] });

    // Bought for less after all: GH₵ 5 change comes back. It holds up a shift until it is in a drawer.
    ODOO.P00420.total = 6000;
    form.reported.P00420 = { amount: 5500, tnt: 500, total: 6000, count: 1 };
    const back = (await earlier(third)).changes;
    assert.deepEqual(back.map((c) => [c.name, c.state, c.amount]), [['P00420', 'change', -500]]);
    await assert.rejects(kofi(third), /P00420: put the GH₵ 5\.00 refund in the drawer and tap Done/);
    await assert.rejects(kofi(third, { notMine: ['P00420'] }), /refund/, 'a refund cannot be put aside');
    const done = await (await kofi(third, { expenses: [{ po: '420' }] })).json();
    assert.deepEqual(done.report.expenses.map((e) => [e.kind, e.paid, e.counted]), [['change', -500, true]]);

    // A deficit: Done if it went through this drawer, or Not on my shift.
    ODOO.P00420.total = 7000;
    form.reported.P00420 = { amount: 6500, tnt: 500, total: 7000, count: 1 };
    await assert.rejects(kofi(fourth), /P00420: GH₵ 10\.00 more was paid/);
    await kofi(fourth, { notMine: ['P00420'] });
    assert.deepEqual({ ...raw.prepare('SELECT po, total, user_id FROM till_po_skip').get() }, { po: 'P00420', total: 7000, user_id: 8 });
    assert.deepEqual((await earlier(fourth)).changes, [], 'not asked of Kofi again');
    assert.equal((await earlier(fourth, AMA)).changes.length, 1, 'still asked of anybody else');
  } finally {
    Object.assign(ODOO.P00420, was);
  }
});

test('a refund coming back: whoever is next on reception is told, or the till list when nobody is rostered', async () => {
  const { db, raw } = await setup();
  const path = '/api/link/till/expect';
  const body = JSON.stringify({ po: 'P00420', vendor: 'A Hardware Shop', amount: 500, paid: 6500, total: 6000, reported: { amount: 5500, tnt: 500 }, by: 'Ama Test', day: '2026-10-08', slot: 'morning' });
  const call = async (b = body, secret = SECRET) => linkExpect({ db, env: { INSIGHT_SSO_SECRET: SECRET, INSIGHT: insight() }, url: new URL(`https://x${path}`), executionContext: null,
    request: new Request(`https://x${path}`, { method: 'POST', headers: await signLink(secret, path, b), body: b }) });
  await assert.rejects(call(body, 'wrong'), /did not come from Insight/);
  const out = await (await call()).json();
  assert.equal(out.sentTo, 'Boss', 'nobody on the rota: the people told about closed shifts');
  const n = raw.prepare("SELECT * FROM app_notices WHERE kind = 'till.expect'").get();
  assert.equal(n.user_id, 3);
  assert.equal(n.title, 'Your next shift: expect GH₵ 5.00 more than ASSD');
  assert.match(n.body, /GH₵ 65\.00 was advanced from the drawer on the morning shift of .* by Ama Test, and it was bought for GH₵ 60\.00 \(GH₵ 55\.00 \+ GH₵ 5\.00 TnT\)/);
});

test('a PO made in Insight: not a shift’s expense until an admin allows it, and trying asks them', async () => {
  const { db } = await setup();
  const form = { reported: { P00412: { amount: 44000, tnt: 0, total: 44000, count: 1 } }, decisions: {}, made: { P00412: { by: 'Test Owner', allowed: false, refused: false } } };
  const ins = insight({ form });
  const env = { INSIGHT: ins };
  const screen = await (await myTill(ctx(db, AMA, { env }))).json();
  const shift = [...screen.choices].reverse()[0];
  const look = await (await lookUpPo(ctx(db, AMA, { env, body: { po: '412' }, path: '/api/me/till/po' }))).json();
  assert.deepEqual([look.state, look.counted], ['held', false]);
  assert.deepEqual(ins.asked.filter(([p]) => p.endsWith('/po-ask')).map(([, b]) => b), [{ name: 'P00412', by: 'Ama Test' }], 'the admins are asked');
  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(shift, { expenses: [{ po: '412' }] }) })), /made in Insight, and an admin has not allowed it/);
  // Refused: never on a shift.
  form.made.P00412 = { by: 'Test Owner', allowed: false, refused: true, decidedBy: 'Test Owner', note: 'Paid by MoMo' };
  assert.equal((await (await lookUpPo(ctx(db, AMA, { env, body: { po: '412' }, path: '/api/me/till/po' }))).json()).state, 'refused');
  // Allowed: counted like any other.
  form.made.P00412 = { by: 'Test Owner', allowed: true, refused: false };
  const out = await (await closeShift(ctx(db, AMA, { env, body: good(shift, { expenses: [{ po: '412' }] }) }))).json();
  assert.deepEqual(out.report.expenses.map((e) => [e.name, e.counted]), [['P00412', true]]);
});

test('a closing report still owed has to go in before any later one', async (t) => {
  // Saturday's morning shift was worked and never closed. On Sunday the till
  // screen opens on it, offers nothing later, and refuses a later report.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { db, raw } = await setup();
  const env = { INSIGHT: insight() };
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, department)
     VALUES (90, 'Desk mornings', '06:00', '14:15', 0, 5, 'Reception')`,
  ).run();
  // The property's first report, from earlier in the week, by somebody else.
  raw.prepare("INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe) VALUES ('2026-10-12', 'morning', 8, 'Kofi Test', 1, 100, 0)").run();
  raw.prepare("INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, '2026-10-15', 90, 1)").run();
  for (const [at, direction] of [['2026-10-15 05:55:00', 'in'], ['2026-10-15 14:20:00', 'out']]) {
    raw.prepare(
      `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, direction, dedupe_key)
       VALUES ('D1', '1', 1, ?1, ?1, '2026-10-15', ?2, ?3)`,
    ).run(at, direction, `${at}-${direction}`);
  }

  const screen = await (await myTill(ctx(db, AMA, { env }))).json();
  assert.deepEqual(screen.owed.map((o) => `${o.day} ${o.slot}`), ['2026-10-15 morning']);
  const owedChoice = screen.choices.find((c) => c.day === '2026-10-15' && c.slot === 'morning');
  assert.ok(owedChoice, 'offered, though it is further back than the last four shifts');
  assert.equal(owedChoice.blocked, false);
  const current = screen.choices.find((c) => c.day === '2026-10-18' && c.slot === 'morning');
  assert.equal(current.blocked, true, 'today waits behind it');

  await assert.rejects(closeShift(ctx(db, AMA, { env, body: good(current) })),
    /First submit your closing report for the morning shift on .*15 October/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM till_report WHERE user_id = 7').get().n, 0);

  const sent = await (await closeShift(ctx(db, AMA, { env, body: good(owedChoice) }))).json();
  assert.equal(sent.ok, true, 'the owed one goes in');
  const now = await (await closeShift(ctx(db, AMA, { env, body: good(current, { rentals: { padlock: { start: 5, end: 5 } } }) }))).json();
  assert.equal(now.ok, true, 'and then today’s');
});
