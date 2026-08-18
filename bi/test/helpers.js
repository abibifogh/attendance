import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Enough of D1's interface to run the real handlers against real SQL.
 *
 * The same approach the attendance app's tests take, and for the same reason:
 * every interesting bug in a warehouse is a bug in a query, and a stubbed
 * database cannot have one. These tests run the actual migrations into SQLite
 * and drive the actual code.
 */
export function d1(db) {
  const statement = (sql, binds = []) => ({
    sql,
    binds,
    bind(...args) { return statement(sql, args); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() {
      const prepared = db.prepare(sql);
      // INSERT ... RETURNING is a read on a writing statement; node:sqlite
      // will only give the row back through get().
      return prepared.get(...binds) ?? null;
    },
    async run() {
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes ?? 0) } };
    },
  });

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

/** A database with no schema at all, for standing in as a source system. */
export function emptyDb() {
  const raw = new DatabaseSync(':memory:');
  return { raw, db: d1(raw) };
}

export function freshDb(dir = 'migrations') {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`${dir}/${file}`, 'utf8'));
  }
  return { raw, db: d1(raw) };
}

/** A Worker `env` with only the warehouse bound: demo mode, no sources. */
export function demoEnv(db) {
  return { DB: db };
}
