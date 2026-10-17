import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as approvals from '../src/routes/approvals.js';
import hiveWorker from '../../src/index.js';

/**
 * Approvals: Insight's own and HIVE's, in one list, decided from here.
 *
 * HIVE is the real HIVE, on its own database, reached the way the service
 * binding reaches it: signed. Everything is invented.
 */

const SECRET = 'shared-for-the-test';
const OWNER = { id: 1, name: 'Test Owner', email: 'owner@example.test', isOwner: true, access: [] };
const SUP = { id: 21, name: 'Sup Kofi', email: 'kofi@example.test', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };

function setUp({ hiveUp = true } = {}) {
  const { db, raw } = freshDb();
  const hive = freshDb('../migrations');
  hive.raw.exec(`DELETE FROM users; DELETE FROM att_staff;
    INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Ama Test', 'Front office', '2020-01-01');
    INSERT INTO users (id, name, role, active, email) VALUES (3, 'Test Owner', 'admin', 1, 'owner@example.test');
    INSERT INTO hr_advance (id, staff_id, amount, months, monthly, status, purpose) VALUES (21, 1, 600, 3, 200, 'requested', 'other');`);
  raw.exec(`INSERT INTO shift_answer (key, answer, note, by_name, at, status) VALUES ('drawer:2026-10-14:night', 'Explained', 'Change given twice', 'Sup Kofi', '2026-10-15 07:10:00', 'pending');
    UPDATE systems SET home_url = 'https://staff.example.test' WHERE id = 'attendance';`);
  const hiveEnv = { DB: hive.db, SESSION_SECRET: 'x'.repeat(40), INSIGHT_SSO_SECRET: SECRET };
  const env = {
    DB: db, ATT_DB: hive.db, SSO_SECRET_ATTENDANCE: SECRET,
    HIVE: { fetch: (req) => (hiveUp ? hiveWorker.fetch(req, hiveEnv, { waitUntil() {} }) : Promise.reject(new Error('HIVE is down'))) },
  };
  return { env, raw, hive: hive.raw };
}

test('one list: Insight’s own and HIVE’s, oldest first, admins only', async () => {
  const { env } = setUp();
  await assert.rejects(approvals.list(env, SUP), /Only an admin/);
  const out = await approvals.list(env, OWNER);
  assert.deepEqual(out.systems.map((s) => [s.id, s.ok, s.count]), [['insight', true, 1], ['hive', true, 1]]);
  const [answer, advance] = [out.items.find((i) => i.system === 'insight'), out.items.find((i) => i.system === 'hive')];
  assert.equal(answer.title, 'Answered “Explained”');
  assert.match(answer.sub, /The drawer count, Wed 14 Oct night · by Sup Kofi/);
  assert.equal(advance.title, 'Salary advance · Ama Test');
  assert.equal(advance.amount, 60000, 'HIVE’s cedis, in pesewas like the rest of Insight');
  assert.match(advance.open, /\/#\/att-advances$/, 'HIVE says where its own screen is');
  assert.equal(out.count, 2);
});

test('a decision is made in the system it came from, as the admin', async () => {
  const { env, raw, hive } = setUp();
  const out = await approvals.decide(env, { system: 'hive', kind: 'advance', id: '21', decision: 'approve', fields: { amount: 300, months: 2 } }, OWNER);
  assert.equal(out.ok, true);
  assert.deepEqual({ ...hive.prepare('SELECT status, amount, monthly, decided_by FROM hr_advance WHERE id = 21').get() },
    { status: 'approved', amount: 300, monthly: 150, decided_by: 'Test Owner via Insight (admin)' });
  // Decided there already: HIVE's own words come back.
  await assert.rejects(approvals.decide(env, { system: 'hive', kind: 'advance', id: '21', decision: 'refuse' }, OWNER), /already been decided/);

  await approvals.decide(env, { system: 'insight', kind: 'answer', id: 'drawer:2026-10-14:night', decision: 'approve' }, OWNER);
  assert.equal(raw.prepare("SELECT status FROM shift_answer WHERE key = 'drawer:2026-10-14:night'").get().status, 'applied');
  assert.equal((await approvals.list(env, OWNER)).count, 0);
});

test('a system that cannot be reached is said, and the rest still shows', async () => {
  const { env } = setUp({ hiveUp: false });
  const out = await approvals.list(env, OWNER);
  const h = out.systems.find((s) => s.id === 'hive');
  assert.equal(h.ok, false);
  assert.match(h.error, /HIVE is down/);
  assert.equal(out.items.length, 1);
  await assert.rejects(approvals.decide(env, { system: 'hive', kind: 'advance', id: '21', decision: 'approve' }, OWNER), /HIVE: HIVE is down/);
});

test('an Insight email with no HIVE login is told how to fix it', async () => {
  const { env } = setUp();
  const out = await approvals.list(env, { ...OWNER, email: 'someone.else@example.test' });
  assert.match(out.systems.find((s) => s.id === 'hive').error, /No HIVE login has the email someone\.else@example\.test/);
});

test('the POS joins once linked: a signed call to its notify function, its items beside the rest', async () => {
  const { env, raw } = setUp();
  // Not linked yet: not in the list at all.
  assert.equal((await approvals.list(env, OWNER)).systems.some((s) => s.id === 'pos'), false);
  raw.exec(`INSERT OR REPLACE INTO sources (id, label, kind, config, enabled) VALUES ('pos', 'Restaurant POS', 'snpos_http', '{"base":"https://pos-fn.example.test/"}', 1)`);
  env.SSO_SECRET_POS = 'pos-secret';
  const asked = [];
  const { signLink } = await import('../src/lib/link.js');
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const want = await signLink('pos-secret', path, init.body, Number(init.headers['X-Till-At']));
    assert.equal(init.headers['X-Till-Sig'], want['X-Till-Sig']);
    asked.push([path, JSON.parse(init.body)]);
    if (path === '/approvals/list') {
      return Response.json({ ok: true, items: [{ kind: 'spend', id: 'e1', title: 'Spend · A Gas Seller', amount: 25000, askedAt: '2026-10-17T08:00:00Z', decisions: [{ key: 'approve', label: 'Approve' }] }] });
    }
    return Response.json({ ok: true, said: 'Approved', as: 'Test Owner via Insight' });
  };
  const out = await approvals.list(env, OWNER);
  const pos = out.items.find((i) => i.system === 'pos');
  assert.deepEqual([pos.title, pos.amount, pos.systemLabel], ['Spend · A Gas Seller', 25000, 'POS']);
  assert.deepEqual(asked[0], ['/approvals/list', { email: 'owner@example.test' }]);
  const done = await approvals.decide(env, { system: 'pos', kind: 'spend', id: 'e1', decision: 'approve' }, OWNER);
  assert.equal(done.as, 'Test Owner via Insight');
  assert.equal(asked[1][1].decision, 'approve');
});
