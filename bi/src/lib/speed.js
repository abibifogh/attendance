import { all, run } from './db.js';

/**
 * How long Insight takes, measured where it happens.
 *
 * Every API request counts its database reads and the time they took; the
 * rest of its time is other systems (HIVE, Odoo, the AI) and the work
 * itself. The answer goes back in a Server-Timing header, and slow requests
 * (and a sample of the rest) are kept, with the Cloudflare location the
 * Worker ran in, for Settings › Connections & files › Speed. That location
 * says whether the Worker runs beside its database (good) or beside the
 * visitor, each read crossing the distance (slow).
 */

const RAW = Symbol('statement');
const SLOW_MS = 800;
const SAMPLE = 20;
const KEEP_DAYS = 7;

/** The database, counted: how many reads, and how long they took. */
export function meterDb(db) {
  // Time the database was busy, reads at once counted once: never more than the request itself.
  const meter = { reads: 0, ms: 0 };
  let busy = 0;
  let since = 0;
  const timed = async (fn) => {
    if (busy++ === 0) since = Date.now();
    try { return await fn(); } finally {
      meter.reads += 1;
      if (--busy === 0) meter.ms += Date.now() - since;
    }
  };
  // Each statement keeps the database's own (RAW), which a batch must be given.
  const wrap = (st) => ({
    [RAW]: st,
    bind: (...args) => wrap(st.bind(...args)),
    first: (...a) => timed(() => st.first(...a)),
    all: (...a) => timed(() => st.all(...a)),
    run: (...a) => timed(() => st.run(...a)),
    raw: (...a) => timed(() => st.raw(...a)),
  });
  meter.db = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql) => wrap(target.prepare(sql));
      if (key === 'batch') return (list) => timed(() => target.batch(list.map((x) => (x && x[RAW]) || x)));
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return meter;
}

/** Keep a request that was slow, or one in twenty of the rest for comparison. */
export async function keep(db, { path, ms, meter, colo }) {
  if (ms < SLOW_MS && Math.random() * SAMPLE >= 1) return;
  await run(db, 'INSERT INTO perf_log (at, path, ms, db_ms, reads, colo) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    new Date().toISOString().slice(0, 19).replace('T', ' '), path, ms, meter.ms, meter.reads, colo || null);
  if (Math.random() < 0.02) await run(db, `DELETE FROM perf_log WHERE at < datetime('now', '-${KEEP_DAYS} days')`);
}

/** The last day: each page's requests, slowest first, and where the Worker ran. */
export async function speedView(env) {
  const rows = await all(env.DB, `SELECT path, COUNT(*) AS n, ROUND(AVG(ms)) AS avg_ms, MAX(ms) AS max_ms,
      ROUND(AVG(db_ms)) AS db_ms, ROUND(AVG(reads)) AS reads
    FROM perf_log WHERE at >= datetime('now', '-1 day') GROUP BY path ORDER BY avg_ms DESC LIMIT 40`);
  const colos = await all(env.DB, `SELECT colo, COUNT(*) AS n, ROUND(AVG(ms)) AS avg_ms FROM perf_log
    WHERE at >= datetime('now', '-1 day') GROUP BY colo ORDER BY n DESC`);
  return {
    pages: rows.map((r) => ({ path: r.path, n: r.n, avgMs: r.avg_ms, maxMs: r.max_ms, dbMs: r.db_ms, reads: r.reads, otherMs: Math.max(0, r.avg_ms - r.db_ms) })),
    colos: colos.map((c) => ({ colo: c.colo || '?', n: c.n, avgMs: c.avg_ms })),
  };
}
