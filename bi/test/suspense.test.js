import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { first } from '../src/lib/db.js';
import * as suspense from '../src/routes/suspense.js';

/** The suspense account. Everybody and every figure is invented. */

const OWNER = { name: 'Ola Owner', isOwner: true };

test('a difference put in suspense is answered; matched with another, or moved to the safe; each undone', async () => {
  const { db } = freshDb();
  const env = { DB: db };
  await assert.rejects(suspense.addSuspense(env, { key: 'not-recorded:t:123', amount: 0 }, OWNER), /other than nothing/);

  const a = (await suspense.addSuspense(env, { key: 'not-recorded:t:123', amount: 233600, what: 'Paid, but not in ASSD', day: '2026-10-08', slot: 'afternoon', note: 'Card ...1234' }, OWNER)).entry;
  assert.equal(a.ref, `S${a.id}`);
  const answer = await first(db, 'SELECT answer, note FROM shift_answer WHERE key = ?1', 'not-recorded:t:123');
  assert.deepEqual([answer.answer, answer.note], ['In suspense', `S${a.id}: Card ...1234`], 'the difference counts as answered');
  // The net of some reconciled together: the differences are answered by the reconciliation, not here.
  const b = (await suspense.addSuspense(env, { keys: ['not-found:216551:0', 'paid-less:216552'], amount: -227200, what: 'Net of 2 reconciled together', reconciled: true }, OWNER)).entry;
  assert.equal(await first(db, 'SELECT * FROM shift_answer WHERE key = ?1', 'not-found:216551:0'), null);

  let v = await suspense.suspenseView(env);
  assert.deepEqual([v.open.length, v.total], [2, 6400]);
  await assert.rejects(suspense.matchSuspense(env, { ids: [a.id, b.id] }, OWNER), /say why/);
  await suspense.matchSuspense(env, { ids: [a.id, b.id], note: 'The GH₵64 was given back as water' }, OWNER);
  v = await suspense.suspenseView(env);
  assert.deepEqual([v.open.length, v.cleared.map((e) => e.status)], [0, ['matched', 'matched']]);
  await suspense.undoSuspense(env, { id: b.id }, OWNER);
  assert.equal((await suspense.suspenseView(env)).open.length, 2, 'the whole match opens again');

  // To the safe: a line in (plus), until a count takes it in.
  await suspense.suspenseToSafe(env, { id: a.id, day: '2026-10-09' }, OWNER);
  let lines = await suspense.suspenseSafeLines(env);
  assert.deepEqual(lines.map((l) => [l.id, l.amount, l.safeDay]), [[a.id, 233600, '2026-10-09']]);
  await suspense.closeSuspense(env, [a.id], 4);
  assert.deepEqual(await suspense.suspenseSafeLines(env), []);
  await assert.rejects(suspense.undoSuspense(env, { id: a.id }, OWNER), /undo that count first/);

  // An open one taken out: its difference is open again.
  const c = (await suspense.addSuspense(env, { key: 'drawer:2026-10-10:night', amount: -5000, what: 'The drawer was short' }, OWNER)).entry;
  await suspense.undoSuspense(env, { id: c.id }, OWNER);
  assert.equal(await first(db, 'SELECT * FROM shift_answer WHERE key = ?1', 'drawer:2026-10-10:night'), null);
});
