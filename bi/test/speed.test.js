import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { meterDb, keep, speedView } from '../src/lib/speed.js';

test('the database, counted: reads and their time; a batch gets the database’s own statements', async () => {
  const { db } = freshDb();
  // A stand-in for D1's batch, which refuses anything that is not its own statement.
  const own = new WeakSet();
  const strict = {
    prepare: (sql) => { const st = db.prepare(sql); const mark = (s) => { const x = { ...s, bind: (...a) => mark(s.bind(...a)) }; own.add(x); return x; }; return mark(st); },
    batch: (list) => { if (!list.every((x) => own.has(x))) throw new Error('not a D1 statement'); return db.batch(list); },
  };
  const meter = meterDb(strict);
  await meter.db.prepare('SELECT 1').first();
  await meter.db.batch([meter.db.prepare("INSERT INTO perf_log (at, path, ms, db_ms, reads) VALUES ('2026-01-01', 'x', 1, 0, 0)")]);
  assert.equal(meter.reads, 2);
});

test('slow requests are kept, and the last day is shown by page, slowest first, with where it ran', async () => {
  const { db } = freshDb();
  await keep(db, { path: 'GET /api/assistant', ms: 4200, meter: { ms: 3900, reads: 36 }, colo: 'ACC' });
  await keep(db, { path: 'GET /api/np', ms: 1200, meter: { ms: 900, reads: 8 }, colo: 'ACC' });
  const v = await speedView({ DB: db });
  assert.deepEqual(v.pages.map((p) => [p.path, p.avgMs, p.dbMs, p.otherMs, p.reads]), [['GET /api/assistant', 4200, 3900, 300, 36], ['GET /api/np', 1200, 900, 300, 8]]);
  assert.deepEqual(v.colos, [{ colo: 'ACC', n: 2, avgMs: 2700 }]);
});
