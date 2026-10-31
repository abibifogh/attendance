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

test('what reconciling left in suspense goes with the reconciliation: undo either, and both are undone', async () => {
  const { db } = freshDb();
  const env = { DB: db };
  const shifts = await import('../src/routes/shifts.js');
  const keys = ['drawer:2026-10-10:afternoon', 'pogap:2026-10-10:afternoon:66000:33000'];
  const linkId = async () => (await first(db, 'SELECT id FROM shift_link ORDER BY id DESC LIMIT 1'))?.id ?? null;

  // Undo the reconciliation: what was left comes out of suspense.
  await shifts.saveLink(env, { keys, note: 'GH₵10 left, to suspense' }, OWNER);
  const a = (await suspense.addSuspense(env, { keys: [...keys].reverse(), amount: -1000, what: 'Left after reconciling 2 together', reconciled: true }, OWNER)).entry;
  const out = await shifts.removeLink(env, { id: await linkId() }, OWNER);
  assert.deepEqual(out.suspense, [a.ref]);
  assert.equal((await suspense.suspenseView(env)).open.length, 0, 'not counted twice');

  // Take it out of suspense: the reconciliation is undone with it.
  await shifts.saveLink(env, { keys, note: 'GH₵10 left, to suspense' }, OWNER);
  const b = (await suspense.addSuspense(env, { keys, amount: -1000, what: 'Left after reconciling 2 together', reconciled: true }, OWNER)).entry;
  assert.equal((await suspense.undoSuspense(env, { id: b.id }, OWNER)).unlinked, true);
  assert.equal(await linkId(), null, 'each difference open again at its full size');

  // Matched in suspense already: undone there first.
  await shifts.saveLink(env, { keys, note: 'GH₵10 left, to suspense' }, OWNER);
  const c = (await suspense.addSuspense(env, { keys, amount: -1000, what: 'Left', reconciled: true }, OWNER)).entry;
  const d = (await suspense.addSuspense(env, { key: 'not-recorded:t:9', amount: 1000, what: 'Paid, but not in ASSD' }, OWNER)).entry;
  await suspense.matchSuspense(env, { ids: [c.id, d.id] }, OWNER);
  await assert.rejects(shifts.removeLink(env, { id: await linkId() }, OWNER), /matched in the suspense account/);
});
