import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as panels from '../src/routes/panels.js';
import { decideFinding } from '../src/routes/admin.js';

/** The Brief lists live findings; what somebody put down is listed apart, and can be brought back. */
test('put-down findings are listed apart from the live ones, and come back when reopened', async () => {
  const { db } = freshDb();
  const env = { DB: db };
  const add = (fp, state) => db.prepare(`INSERT INTO findings (fingerprint, rule_id, severity, headline, detail, impact_monthly, confidence, sources, evidence, from_day, to_day, state)
      VALUES (?1, 'made-up', 'warning', ?1, 'x', 100, 'medium', '[]', '{}', '2026-10-01', '2026-10-19', ?2)`).bind(fp, state).run();
  for (const [fp, state] of [['a', 'open'], ['b', 'acknowledged'], ['c', 'actioned'], ['d', 'dismissed'], ['e', 'resolved']]) await add(fp, state);
  const names = (r) => r.findings.map((f) => f.headline).sort();
  assert.deepEqual(names(await panels.findings(env, { state: 'live' })), ['a', 'b']);
  assert.deepEqual(names(await panels.findings(env, { state: 'down' })), ['c', 'd', 'e']);
  const d = (await panels.findings(env, { state: 'down' })).findings.find((f) => f.headline === 'd');
  await decideFinding(env, d.id, { state: 'open' });
  assert.deepEqual(names(await panels.findings(env, { state: 'down' })), ['c', 'e']);
  assert.deepEqual(names(await panels.findings(env, { state: 'live' })), ['a', 'b', 'd']);
});
