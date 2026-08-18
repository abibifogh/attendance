import { all, run, setSetting, groupConfig, first } from '../lib/db.js';
import { listSources, checkSource, secretNameFor } from '../connectors/index.js';
import { validateMapping, FACTS } from '../connectors/supabase.js';
import { runEtl } from '../warehouse/etl.js';
import { analyse } from '../insight/engine.js';
import { badRequest, str } from '../lib/http.js';
import { isDay, todayIn, addDays } from '../lib/dates.js';

export async function sources(env) {
  const rows = await listSources(env.DB);
  const checks = [];
  for (const source of rows) checks.push({ id: source.id, ...(await checkSource(source, env)) });
  const byId = new Map(checks.map((c) => [c.id, c]));
  return {
    sources: rows.map((s) => ({
      ...s,
      check: byId.get(s.id) || null,
      secretSet: s.secretName ? Boolean(env[s.secretName]) : null,
      // A mapped source says what is wrong with its mapping before anybody
      // waits until midnight to find out it loaded nothing.
      mappingProblems: s.kind === 'supabase_rest' ? validateMapping(s.config) : [],
    })),
    // What a Supabase mapping may write into, so the screen can offer it
    // rather than making somebody read this file.
    facts: Object.fromEntries(Object.entries(FACTS).map(([fact, spec]) => [fact, {
      fields: [...(spec.money || []), ...(spec.counts || []), ...(spec.reals || []), ...(spec.text || [])],
      money: spec.money || [],
      needsLine: Boolean(spec.needsLine),
    }])),
    demoMode: (await groupConfig(env.DB)).demoMode,
  };
}

/**
 * Add a Supabase database as a source.
 *
 * Any number of them: two now, a third when somebody moves another system off
 * whatever it is on today. The id becomes part of the secret's name, so each
 * project's key is its own and revoking one does not revoke the others.
 */
export async function addSupabaseSource(env, body) {
  const id = str(body?.id, 'Name', { required: true, max: 40 })
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) throw badRequest('That name has no letters or numbers in it');
  if (await first(env.DB, 'SELECT id FROM sources WHERE id = ?1', id)) {
    throw badRequest(`There is already a source called ${id}`);
  }

  const label = str(body?.label, 'Label', { max: 120 }) || id;
  const base = str(body?.base, 'Address', { required: true, max: 300 });
  let url;
  try { url = new URL(base); } catch { throw badRequest('That is not a web address'); }
  if (url.protocol !== 'https:') throw badRequest('The address must start with https://');

  await run(env.DB, `
    INSERT INTO sources (id, label, kind, config, enabled)
    VALUES (?1, ?2, 'supabase_rest', ?3, 1)`,
    id, label, JSON.stringify({ base: url.origin, schema: 'public', tables: [] }));

  return sources(env);
}

/** Replace a Supabase source's table mapping, refusing one that cannot work. */
export async function saveMapping(env, id, body) {
  const existing = await first(env.DB, 'SELECT * FROM sources WHERE id = ?1', id);
  if (!existing) throw badRequest('No such source');
  if (existing.kind !== 'supabase_rest') throw badRequest('That source is not mapped by hand');

  let config = {};
  try { config = JSON.parse(existing.config || '{}'); } catch { config = {}; }
  if (body.base !== undefined) {
    let url;
    try { url = new URL(String(body.base)); } catch { throw badRequest('That is not a web address'); }
    if (url.protocol !== 'https:') throw badRequest('The address must start with https://');
    config.base = url.origin;
  }
  if (body.schema !== undefined) config.schema = str(body.schema, 'Schema', { max: 60 }) || 'public';
  if (body.tables !== undefined) {
    if (!Array.isArray(body.tables)) throw badRequest('Tables must be a list');
    config.tables = body.tables;
  }

  const problems = validateMapping(config);
  // Saving a half-finished mapping is normal — somebody is building it up a
  // table at a time. Switching the source *on* with a broken one is not.
  if (problems.length && existing.enabled) {
    throw badRequest(`That mapping would not load: ${problems[0]}`);
  }

  await run(env.DB, 'UPDATE sources SET config = ?2 WHERE id = ?1', id, JSON.stringify(config));
  return sources(env);
}

export async function removeSource(env, id) {
  const existing = await first(env.DB, 'SELECT * FROM sources WHERE id = ?1', id);
  if (!existing) throw badRequest('No such source');
  // The four built-in systems are part of the shape of the group and are
  // switched off rather than deleted; anything added here can go.
  if (existing.kind !== 'supabase_rest') {
    throw badRequest(`${existing.label} is one of the group's own systems. Switch it off rather than removing it.`);
  }
  await run(env.DB, 'DELETE FROM sources WHERE id = ?1', id);
  return sources(env);
}

/**
 * Point a source at an address, or switch it off.
 *
 * Keys are not accepted here and never will be. A base URL is configuration; a
 * key is a secret, and a secret typed into a web form is a secret in a browser
 * history, in a proxy log and in a database that gets exported. They go in
 * with `wrangler secret put`, where they belong.
 */
export async function saveSource(env, id, body) {
  const existing = await first(env.DB, 'SELECT * FROM sources WHERE id = ?1', id);
  if (!existing) throw badRequest('No such source');

  let config = {};
  try { config = JSON.parse(existing.config || '{}'); } catch { config = {}; }

  if (body.base !== undefined) {
    const base = str(body.base, 'Address', { max: 300 });
    if (base) {
      let url;
      try { url = new URL(base); } catch { throw badRequest('That is not a web address'); }
      if (url.protocol !== 'https:') throw badRequest('The address must start with https://');
      config.base = url.origin;
    } else {
      config.base = '';
    }
  }
  if (body.binding !== undefined) config.binding = str(body.binding, 'Binding', { max: 60 }) || '';

  const enabled = body.enabled === undefined ? existing.enabled : (body.enabled ? 1 : 0);
  await run(env.DB, 'UPDATE sources SET config = ?2, enabled = ?3 WHERE id = ?1',
    id, JSON.stringify(config), enabled);

  return sources(env);
}

/**
 * Load, then think.
 *
 * Always in that order and always in one call, because a dashboard whose
 * findings were computed against a different set of days than its charts is
 * worse than one that is simply out of date.
 */
export async function refresh(env, body) {
  const config = await groupConfig(env.DB);
  const today = todayIn(config.timezone);
  const to = isDay(body?.to) ? body.to : addDays(today, -1);
  const from = isDay(body?.from) ? body.from : null;

  const etl = await runEtl(env, { from, to, trigger: body?.trigger || 'manual' });
  // Findings are computed over a longer window than the load, because a trend
  // needs a run-up. Loading ten days and then judging a trend on ten days
  // would call every ordinary week a crisis.
  const analysisFrom = addDays(to, -89);
  const insight = await analyse(env.DB, { from: analysisFrom, to, persist: true });

  return {
    etl,
    analysed: { from: analysisFrom, to, findings: insight.findings.length, errors: insight.errors },
  };
}

/**
 * Leave the demonstration behind.
 *
 * Switching demo mode off does not tidy up after itself and must not: the
 * invented figures stay in the warehouse until a real load replaces them, so
 * somebody who turns it off by accident does not lose the only thing on their
 * screen. The next run over the same window overwrites the lot.
 */
export async function settings(env, body) {
  const allowed = {
    group_name: (v) => str(v, 'Group name', { max: 120 }),
    timezone: (v) => str(v, 'Timezone', { max: 60 }),
    currency_code: (v) => str(v, 'Currency code', { max: 8 }),
    currency_symbol: (v) => str(v, 'Currency symbol', { max: 8 }),
    default_hour_cost: (v) => String(Math.max(0, Math.round(Number(v) || 0))),
    labour_target_pct: (v) => String(Math.min(100, Math.max(0, Math.round(Number(v) || 0)))),
    demo_mode: (v) => (v ? '1' : '0'),
  };
  for (const [key, clean] of Object.entries(allowed)) {
    if (body[key] === undefined) continue;
    await setSetting(env.DB, key, clean(body[key]));
  }
  return groupConfig(env.DB);
}

export async function decideFinding(env, id, body) {
  const state = str(body?.state, 'State', { required: true, max: 20 });
  if (!['open', 'acknowledged', 'actioned', 'dismissed'].includes(state)) {
    throw badRequest('A finding can be open, acknowledged, actioned or dismissed');
  }
  const note = str(body?.note, 'Note', { max: 500 });
  await run(env.DB, `
    UPDATE findings SET state = ?2, state_at = datetime('now'), state_by = ?3, state_note = ?4
     WHERE id = ?1`, Number(id), state, str(body?.by, 'By', { max: 80 }) || 'owner', note);
  return { ok: true };
}

export async function runs(env) {
  const rows = await all(env.DB, 'SELECT * FROM etl_run ORDER BY id DESC LIMIT 20');
  const perSource = await all(env.DB, `
    SELECT * FROM etl_source_run WHERE run_id IN (SELECT id FROM etl_run ORDER BY id DESC LIMIT 20)`);
  return {
    runs: rows.map((r) => ({
      id: r.id, status: r.status, from: r.from_day, to: r.to_day, trigger: r.trigger,
      startedAt: r.started_at, finishedAt: r.finished_at, rows: r.rows_written, detail: r.detail,
      sources: perSource.filter((s) => s.run_id === r.id)
        .map((s) => ({ id: s.source_id, status: s.status, detail: s.detail })),
    })),
  };
}
