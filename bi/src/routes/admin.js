import { all, run, setSetting, groupConfig, first } from '../lib/db.js';
import { listSources, checkSource } from '../connectors/index.js';
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
    sources: rows.map((s) => ({ ...s, check: byId.get(s.id) || null })),
    demoMode: (await groupConfig(env.DB)).demoMode,
  };
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
