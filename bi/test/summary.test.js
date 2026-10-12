import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { sendDailySummary, summaryFor } from '../src/routes/summary.js';
import { SMALL_BY } from '../src/routes/shifts.js';
import { verifyLink } from '../src/lib/link.js';

/**
 * The daily till summary: one message a morning in place of one per shift
 * closed. Everything here is invented.
 */

const LINK = 'link-secret-for-the-test';

async function setUp() {
  const { db, raw } = freshDb();
  const hive = freshDb('../migrations');
  hive.raw.exec("INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe, signed_at) VALUES ('2026-10-10', 'morning', 7, 'Ama Test', 1, 1000, 0, '2026-10-10 14:00:00')");
  raw.exec(`INSERT INTO till_notify (hive_user_id, name, push, email, amounts, on_closed, on_answer, on_approval, on_summary) VALUES
      (3, 'Boss', 1, 1, 1, 0, 1, 1, 1), (9, 'Quiet', 1, 1, 1, 1, 1, 0, 0);
    INSERT INTO shift_movement (seq, kind, by_name, at, status) VALUES (101, 'safe', 'Sam', '2026-10-10 09:00:00', 'pending');
    INSERT INTO shift_movement (seq, kind, by_name, at, status, decided_by, decided_at) VALUES (102, 'expenses', 'Sam', '2026-10-10 10:00:00', 'applied', '${SMALL_BY}', '2026-10-10 10:00:00');
    INSERT INTO money_todo (key, kind, ref, state, opened_at) VALUES ('differs:P00412', 'differs', 'P00412', 'answered', '2026-10-09 10:00:00');`);
  return { env: { DB: db, ATT_DB: hive.db, SSO_SECRET_ATTENDANCE: LINK } };
}

test('the summary: each shift of the day, and what waits for an admin', async () => {
  const { env } = await setUp();
  const s = await summaryFor(env, { day: '2026-10-10', on: '2026-10-11' });
  assert.equal(s.title, 'Saturday 10 October: 1 shift closed');
  assert.deepEqual(s.lines.map((l) => l.label), ['Morning · Ama Test', 'Afternoon', 'Night']);
  assert.deepEqual(s.needs, [
    ['Corrections to approve', '1'],
    ['Money to-do answered, waiting for you', '1'],
    ['Small corrections that counted straight away', '1'],
  ]);
});

test('sent once, through HIVE, to whoever gets the daily summary', async () => {
  const { env } = await setUp();
  const asked = [];
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const text = await request.text();
    assert.ok(await verifyLink(LINK, { at: request.headers.get('X-Till-At'), sig: request.headers.get('X-Till-Sig'), path: url.pathname, bodyText: text }));
    asked.push([url.pathname, JSON.parse(text)]);
    return Response.json({ ok: true, sent: 1 });
  };
  const out = await sendDailySummary(env, { fetchImpl, day: '2026-10-10', on: '2026-10-11' });
  assert.equal(out.sent, 1);
  assert.equal(asked[0][0], '/api/link/till/summary');
  assert.deepEqual(asked[0][1].recipients.map((r) => r.userId), [3], 'only those ticked for the daily summary, not those ticked for each shift closed');

  const none = { ...env };
  await env.DB.prepare('UPDATE till_notify SET on_summary = 0').run();
  assert.deepEqual(await sendDailySummary(none, { fetchImpl }), { sent: 0, reason: 'nobody gets the daily summary' });
});
