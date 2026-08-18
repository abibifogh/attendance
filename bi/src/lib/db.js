import { minor } from './money.js';

/**
 * Read a whole query. D1 returns `{ results }`; a missing table is not a
 * catastrophe here, it means a source has not been loaded yet, and every
 * caller in this app would rather have an empty list than an exception.
 */
export async function all(db, sql, ...binds) {
  const out = await db.prepare(sql).bind(...binds).all();
  return out?.results ?? [];
}

export async function first(db, sql, ...binds) {
  return (await db.prepare(sql).bind(...binds).first()) ?? null;
}

export async function run(db, sql, ...binds) {
  return db.prepare(sql).bind(...binds).run();
}

/**
 * Write a batch of rows, in chunks.
 *
 * D1 has a limit on how many statements one batch may carry, and an ETL that
 * loads three months of four systems goes past it easily. Chunking here means
 * no caller has to think about it.
 */
export async function writeAll(db, statements, chunk = 60) {
  let written = 0;
  for (let i = 0; i < statements.length; i += chunk) {
    const slice = statements.slice(i, i + chunk);
    if (!slice.length) continue;
    await db.batch(slice);
    written += slice.length;
  }
  return written;
}

export async function getSettings(db) {
  const rows = await all(db, 'SELECT key, value FROM settings');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function setSetting(db, key, value) {
  await run(db,
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2',
    key, String(value));
}

/** The group's shared reading of its own settings, with sane fallbacks. */
export async function groupConfig(db) {
  const s = await getSettings(db);
  return {
    groupName: s.group_name || 'Nice Operation',
    timezone: s.timezone || 'Africa/Accra',
    currencyCode: s.currency_code || 'GHS',
    currencySymbol: s.currency_symbol || 'GH₵',
    defaultHourCost: minor(s.default_hour_cost || 1200),
    labourTargetPct: Number(s.labour_target_pct || 30),
    demoMode: s.demo_mode === '1',
  };
}
