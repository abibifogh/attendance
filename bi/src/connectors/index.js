import * as attendance from './attendance.js';
import * as breakfast from './breakfast.js';
import * as snpos from './snpos.js';
import * as snlaundry from './snlaundry.js';
import * as supabase from './supabase.js';
import { emptyBundle } from './bundle.js';
import { demoPull } from '../fixtures/demo.js';
import { all } from '../lib/db.js';

/**
 * The registry: which code reads which system, and what it needs to do it.
 *
 * Two of the four sources are Cloudflare D1 databases in the same account as
 * this Worker, so they are read directly through a binding — no key, no
 * network, nothing to rotate. The other two live elsewhere and are read over
 * their own read-only APIs with a token held as a Worker secret.
 *
 * The asymmetry is worth keeping in mind when a source goes quiet: a bound
 * database cannot fail for a reason outside this account, and an HTTP source
 * usually has.
 */
const KINDS = {
  attendance_d1: {
    transport: 'binding',
    pull: attendance.pull,
    describes: 'Who was on the premises, when, and against what shift.',
  },
  breakfast_d1: {
    transport: 'binding',
    pull: breakfast.pull,
    describes: 'Guests in house, food bought and used, rooms checked, parts issued.',
  },
  snpos_http: {
    transport: 'http',
    secret: 'POS_REPORTS_KEY',
    pull: snpos.pull,
    check: snpos.check,
    describes: 'Restaurant and bar sales, payments, expenses and till closes.',
  },
  snlaundry_http: {
    transport: 'http',
    secret: 'LAUNDRY_TOKEN',
    pull: snlaundry.pull,
    check: snlaundry.check,
    describes: 'Laundry charged, collected and left owing, by day and by shift.',
  },
  // Any Postgres database on Supabase, read over PostgREST. Unlike the four
  // above it knows nothing about its source's schema — the mapping from that
  // schema to this warehouse is configuration, so a database this code has
  // never seen can be connected without changing this code.
  supabase_rest: {
    transport: 'http',
    // One secret per Supabase source, named after the source, so two projects
    // never share a key and revoking one does not revoke the other.
    secretFor: (sourceId) => `SUPABASE_KEY_${String(sourceId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    pull: supabase.pull,
    check: supabase.check,
    describes: 'A Postgres database on Supabase, mapped table by table.',
  },
};

/** Where a source's key lives on this Worker, fixed or derived from its id. */
export function secretNameFor(source) {
  const kind = KINDS[source?.kind];
  if (!kind) return null;
  if (kind.secret) return kind.secret;
  if (kind.secretFor) return kind.secretFor(source.id);
  return null;
}

export async function listSources(db) {
  const rows = await all(db, 'SELECT * FROM sources ORDER BY id');
  return rows.map((row) => {
    const kind = KINDS[row.kind] || {};
    let config = {};
    try { config = JSON.parse(row.config || '{}'); } catch { config = {}; }
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      transport: kind.transport || 'unknown',
      describes: kind.describes || '',
      secretName: secretNameFor({ id: row.id, kind: row.kind }),
      config,
      enabled: row.enabled === 1,
      lastOkAt: row.last_ok_at,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
    };
  });
}

/**
 * Is a source actually able to answer?
 *
 * Configured and working are different states and the difference matters more
 * here than almost anywhere: a source that is merely unconfigured must never
 * make the business look as though it stopped trading. Every screen that shows
 * a total also shows which sources stood behind it.
 */
export function readiness(source, env) {
  const kind = KINDS[source.kind];
  if (!kind) return { ready: false, why: 'No connector of that kind' };
  if (!source.enabled) return { ready: false, why: 'Switched off' };
  if (kind.transport === 'binding') {
    const binding = source.config?.binding;
    if (!binding) return { ready: false, why: 'No binding named in the configuration' };
    if (!env?.[binding]) return { ready: false, why: `The ${binding} database is not bound to this Worker` };
    return { ready: true };
  }
  if (!source.config?.base) return { ready: false, why: 'No address configured' };
  const secret = secretNameFor(source);
  if (secret && !env?.[secret]) return { ready: false, why: `${secret} has not been set` };
  return { ready: true };
}

/**
 * Read one source for one window.
 *
 * Never throws. A source that fails comes back with `status: 'error'` and an
 * empty bundle, so one system being down costs the dashboard that system's
 * figures and nothing else. Losing four systems' insight because a Netlify
 * function was cold is not a trade worth making.
 */
export async function pullSource(source, { env, from, to, demo }) {
  const kind = KINDS[source.kind];
  if (!kind) return { status: 'error', detail: 'No connector of that kind', bundle: emptyBundle() };

  if (demo) {
    const bundle = demoPull({ sourceId: source.id, from, to });
    return { status: 'demo', detail: 'Demonstration data', bundle };
  }

  const ready = readiness(source, env);
  if (!ready.ready) return { status: 'skipped', detail: ready.why, bundle: emptyBundle() };

  try {
    const bundle = await kind.pull({
      db: kind.transport === 'binding' ? env[source.config.binding] : null,
      config: source.config,
      token: secretNameFor(source) ? env[secretNameFor(source)] : null,
      from,
      to,
    });
    return { status: 'ok', detail: (bundle.notes || []).join('; '), bundle };
  } catch (err) {
    return {
      status: 'error',
      detail: `${err?.message ?? err}${err?.detail ? ` — ${err.detail}` : ''}`.slice(0, 500),
      bundle: emptyBundle(),
    };
  }
}

/** A live poke at an HTTP source, for the setup screen. */
export async function checkSource(source, env) {
  const kind = KINDS[source.kind];
  if (!kind) return { ok: false, detail: 'No connector of that kind' };
  const ready = readiness(source, env);
  if (!ready.ready) return { ok: false, detail: ready.why };
  if (!kind.check) return { ok: true, detail: 'Bound and readable' };
  try {
    const secret = secretNameFor(source);
    return await kind.check({ config: source.config, token: secret ? env[secret] : null });
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

export { KINDS };
