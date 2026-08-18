import { json, HttpError, readJson, isMissingTable, csvResponse } from './lib/http.js';
import { checkPassword, clearCookie, createToken, requireSession, sessionCookie, tokenFrom, verifyToken } from './lib/auth.js';
import * as panels from './routes/panels.js';
import * as admin from './routes/admin.js';
import { loadFacts } from './insight/facts.js';
import { groupConfig } from './lib/db.js';
import { resolveRange } from './lib/dates.js';

/**
 * The route table.
 *
 * `public` means no session is required. Everything else needs one, because
 * everything else is either the group's takings or somebody's name against a
 * cash shortage. There is no middle tier and no per-user permission: the
 * people who hold this password are the people who already see all of it.
 */
const ROUTES = [
  ['POST', '/api/auth/login', 'public', login],
  ['POST', '/api/auth/logout', 'public', logout],
  ['GET', '/api/auth/me', 'public', me],

  ['GET', '/api/bootstrap', null, (env) => panels.bootstrap(env)],
  ['GET', '/api/brief', null, (env, ctx) => panels.brief(env, ctx.query)],
  ['GET', '/api/pnl', null, (env, ctx) => panels.pnl(env, ctx.query)],
  ['GET', '/api/labour', null, (env, ctx) => panels.labour(env, ctx.query)],
  ['GET', '/api/demand', null, (env, ctx) => panels.demand(env, ctx.query)],
  ['GET', '/api/cash', null, (env, ctx) => panels.cash(env, ctx.query)],
  ['GET', '/api/suppliers', null, (env, ctx) => panels.suppliers(env, ctx.query)],
  ['GET', '/api/service', null, (env, ctx) => panels.service(env, ctx.query)],
  ['GET', '/api/findings', null, (env, ctx) => panels.findings(env, ctx.query)],
  ['POST', '/api/findings/:id', null, (env, ctx) => admin.decideFinding(env, ctx.params.id, ctx.body)],

  ['GET', '/api/sources', null, (env) => admin.sources(env)],
  ['POST', '/api/sources/:id', null, (env, ctx) => admin.saveSource(env, ctx.params.id, ctx.body)],
  ['POST', '/api/refresh', null, (env, ctx) => admin.refresh(env, ctx.body)],
  ['POST', '/api/settings', null, (env, ctx) => admin.settings(env, ctx.body)],
  ['GET', '/api/runs', null, (env) => admin.runs(env)],
  ['GET', '/api/export', null, exportCsv],
];

export default {
  async fetch(request, env, execution) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      const match = findRoute(request.method, url.pathname);
      if (!match) throw new HttpError(404, 'No such endpoint');
      const [route, params] = match;
      const [, , permission, handler] = route;

      if (permission !== 'public') await requireSession(request, env);

      const query = Object.fromEntries(url.searchParams);
      const body = request.method === 'POST' && request.headers.get('Content-Type')?.includes('application/json')
        ? await readJson(request)
        : {};

      const result = await handler(env, { request, query, body, params, url });
      return result instanceof Response ? result : json(result);
    } catch (err) {
      return errorResponse(err);
    }
  },

  /**
   * The nightly run, a little after midnight in Accra.
   *
   * Late enough that yesterday is finished everywhere, early enough that the
   * brief is waiting before anybody opens it. The window reaches back ten days
   * because every one of the four sources accepts a late correction.
   */
  async scheduled(event, env, execution) {
    execution.waitUntil(admin.refresh(env, { trigger: 'schedule' }).catch((err) => {
      console.error('Scheduled refresh failed', err);
    }));
  },
};

function findRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of ROUTES) {
    const [routeMethod, pattern] = route;
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/').filter(Boolean);
    if (patternParts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (patternParts[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return [route, params];
  }
  return null;
}

function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
  }
  if (isMissingTable(err)) {
    return json({
      error: 'The warehouse has not been built yet. Run the migrations, then refresh.',
      detail: String(err?.message ?? err),
    }, { status: 503 });
  }
  console.error(err);
  return json({ error: 'Something went wrong on the server' }, { status: 500 });
}

// ------------------------------------------------------------------ auth --

async function login(env, { body }) {
  const ok = await checkPassword(env, body?.password);
  if (!ok) throw new HttpError(401, 'That password was not recognised');
  if (!env.SESSION_SECRET) throw new HttpError(503, 'SESSION_SECRET has not been set on this Worker');
  const token = await createToken(env.SESSION_SECRET);
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(token) } });
}

async function logout() {
  return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie() } });
}

async function me(env, { request }) {
  const signedIn = Boolean(env.SESSION_SECRET) && await verifyToken(env.SESSION_SECRET, tokenFrom(request));
  return json({
    signedIn,
    configured: Boolean(env.SESSION_SECRET && env.DASHBOARD_PASSWORD),
  });
}

// ---------------------------------------------------------------- export --

/**
 * One row per day per line, with revenue, cost, wages and contribution.
 *
 * The point of a warehouse is that somebody can take it away and do something
 * you did not think of, so the export is the whole joined table rather than
 * whichever screen they were looking at.
 */
async function exportCsv(env, { query }) {
  const config = await groupConfig(env.DB);
  const { from, to } = resolveRange(query, config.timezone, { days: 90 });
  const facts = await loadFacts(env.DB, from, to);

  const rows = [[
    'day', 'weekday', 'line', 'guests_in_house', 'revenue_net', 'discounts', 'collected',
    'outstanding', 'cash', 'card', 'other_tender', 'orders', 'covers',
    'purchases_cost', 'hours_worked', 'wage_cost', 'contribution', 'revenue_per_hour',
  ]];

  for (const row of facts.lineRows) {
    rows.push([
      row.day,
      facts.byDay.get(row.day)?.dow_label ?? '',
      row.line,
      facts.guestsOn(row.day),
      money(row.net), money(row.discounts), money(row.collected), money(row.outstanding),
      money(row.cash), money(row.card), money(row.other),
      row.orders, row.covers,
      money(row.cost), row.workedHours, money(row.labourCost), money(row.contribution),
      row.revenuePerHour == null ? '' : money(row.revenuePerHour),
    ]);
  }

  return csvResponse(`insight-${from}-to-${to}.csv`, rows);
}

/** Whole units, with two decimals, for a spreadsheet rather than for adding up. */
const money = (minorUnits) => (Number(minorUnits || 0) / 100).toFixed(2);
