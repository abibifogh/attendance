import { json, HttpError, readJson, isMissingTable, csvResponse, str, badRequest } from './lib/http.js';
import {
  accountForCredentials, checkBootstrapPassword, clearCookie, createToken, currentAccount,
  requireInsight, requireOwner, requireSession, saltForEmail, sessionCookie,
} from './lib/auth.js';
import { issueCode, redeemCode, systemsFor } from './lib/sso.js';
import * as panels from './routes/panels.js';
import * as admin from './routes/admin.js';
import * as accounts from './routes/accounts.js';
import { first } from './lib/db.js';
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
  ['POST', '/api/auth/salt', 'public', passwordSalt],
  ['POST', '/api/auth/login', 'public', login],
  ['POST', '/api/auth/logout', 'public', logout],
  ['GET', '/api/auth/me', 'public', me],

  // The back channel. No session reaches it: the caller is another system's
  // server, and it proves what it is with its own shared secret. This is the
  // only endpoint in the app that hands out an identity, and it hands out
  // exactly one, once, to the system a code was minted for.
  ['POST', '/api/sso/redeem', 'public', ssoRedeem],

  // The hub. Everybody who can sign in can see it, whatever else they can
  // reach — it is the reason most people will open this at all.
  ['GET', '/api/hub', 'session', hub],
  ['POST', '/api/sso/start', 'session', ssoStart],
  ['POST', '/api/auth/change-password', 'session', changeOwnPassword],

  // The numbers. A separate permission from being able to sign in, because
  // somebody who needs the till does not necessarily get the wage bill.
  ['GET', '/api/bootstrap', 'insight', (env) => panels.bootstrap(env)],
  ['GET', '/api/brief', 'insight', (env, ctx) => panels.brief(env, ctx.query)],
  ['GET', '/api/pnl', 'insight', (env, ctx) => panels.pnl(env, ctx.query)],
  ['GET', '/api/labour', 'insight', (env, ctx) => panels.labour(env, ctx.query)],
  ['GET', '/api/demand', 'insight', (env, ctx) => panels.demand(env, ctx.query)],
  ['GET', '/api/cash', 'insight', (env, ctx) => panels.cash(env, ctx.query)],
  ['GET', '/api/suppliers', 'insight', (env, ctx) => panels.suppliers(env, ctx.query)],
  ['GET', '/api/service', 'insight', (env, ctx) => panels.service(env, ctx.query)],
  ['GET', '/api/findings', 'insight', (env, ctx) => panels.findings(env, ctx.query)],
  ['POST', '/api/findings/:id', 'insight', (env, ctx) => admin.decideFinding(env, ctx.params.id, ctx.body)],
  ['GET', '/api/export', 'insight', exportCsv],

  // Loading and configuring. Owners only: these change what every other screen
  // in the group is built on.
  ['GET', '/api/sources', 'owner', (env) => admin.sources(env)],
  ['POST', '/api/sources/:id', 'owner', (env, ctx) => admin.saveSource(env, ctx.params.id, ctx.body)],
  ['POST', '/api/sources', 'owner', (env, ctx) => admin.addSupabaseSource(env, ctx.body)],
  ['POST', '/api/sources/:id/mapping', 'owner', (env, ctx) => admin.saveMapping(env, ctx.params.id, ctx.body)],
  ['POST', '/api/sources/:id/remove', 'owner', (env, ctx) => admin.removeSource(env, ctx.params.id)],
  ['POST', '/api/refresh', 'owner', (env, ctx) => admin.refresh(env, ctx.body)],
  ['POST', '/api/settings', 'owner', (env, ctx) => admin.settings(env, ctx.body)],
  ['GET', '/api/runs', 'owner', (env) => admin.runs(env)],

  ['GET', '/api/accounts', 'owner', (env) => accounts.list(env)],
  ['POST', '/api/accounts', 'owner', (env, ctx) => accounts.save(env, ctx.body, ctx.account)],
  ['POST', '/api/accounts/:id/password', 'owner', (env, ctx) => accounts.setPassword(env, ctx.params.id, ctx.body)],
  ['POST', '/api/accounts/:id/access', 'owner', (env, ctx) => accounts.setAccess(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/systems/:id', 'owner', (env, ctx) => accounts.saveSystem(env, ctx.params.id, ctx.body)],
  ['GET', '/api/sso/log', 'owner', (env) => accounts.handoffLog(env)],
];
;

export default {
  async fetch(request, env, execution) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      const match = findRoute(request.method, url.pathname);
      if (!match) throw new HttpError(404, 'No such endpoint');
      const [route, params] = match;
      const [, , permission, handler] = route;

      // Four levels, and the difference between them matters now that this is
      // a front door rather than a report: signing in, reading the numbers,
      // and changing what everybody else sees are three different things.
      let account = null;
      if (permission === 'session') account = await requireSession(request, env);
      else if (permission === 'insight') account = await requireInsight(request, env);
      else if (permission === 'owner') account = await requireOwner(request, env);

      const query = Object.fromEntries(url.searchParams);
      const body = request.method === 'POST' && request.headers.get('Content-Type')?.includes('application/json')
        ? await readJson(request)
        : {};

      const result = await handler(env, { request, query, body, params, url, account });
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

/**
 * The salt to stretch a password with.
 *
 * Answers for an address whether or not it has an account, with a stable salt
 * derived from the address itself in the second case. Without that, this
 * endpoint is a free list of who works here.
 */
async function passwordSalt(env, { body }) {
  const email = str(body?.email, 'Email address', { required: true, max: 200 });
  return json(await saltForEmail(env.DB, email));
}

/**
 * Two ways in.
 *
 * An account with an address and a stretched password is the ordinary route.
 * The shared bootstrap password is the other, and it exists for exactly one
 * situation: a fresh installation with no accounts in it yet, which somebody
 * has to be able to open in order to make the first one. A bootstrap session
 * can manage accounts and read the numbers; it deliberately cannot be handed
 * over to another system, because a password out of a config file is not a
 * person and should not be able to open a till under somebody's name.
 */
async function login(env, { body }) {
  if (!env.SESSION_SECRET) throw new HttpError(503, 'SESSION_SECRET has not been set on this Worker');

  if (body?.email) {
    const account = await accountForCredentials(env.DB, body.email, body.passwordKey);
    if (!account) throw new HttpError(401, 'That address and password were not recognised');
    const token = await createToken(env.SESSION_SECRET, { accountId: account.id });
    return json({ ok: true, account: { name: account.name, email: account.email, isOwner: account.isOwner } },
      { headers: { 'Set-Cookie': sessionCookie(token) } });
  }

  if (!await checkBootstrapPassword(env, body?.password)) {
    throw new HttpError(401, 'That password was not recognised');
  }
  const token = await createToken(env.SESSION_SECRET, { bootstrap: true });
  return json({ ok: true, bootstrap: true }, { headers: { 'Set-Cookie': sessionCookie(token) } });
}

async function logout() {
  return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie() } });
}

async function me(env, { request }) {
  let account = null;
  try {
    account = await currentAccount(request, env);
  } catch {
    // A Worker with no SESSION_SECRET cannot sign anybody in, and the sign-in
    // screen needs to be able to say so rather than failing blank.
    return json({ signedIn: false, configured: false });
  }

  // Whether any account exists at all decides which sign-in form to show: an
  // installation with none still needs the shared password.
  let hasAccounts = false;
  try {
    hasAccounts = Boolean((await first(env.DB, 'SELECT 1 AS n FROM accounts WHERE active = 1 LIMIT 1'))?.n);
  } catch { hasAccounts = false; }

  return json({
    signedIn: Boolean(account),
    configured: Boolean(env.SESSION_SECRET && env.DASHBOARD_PASSWORD),
    hasAccounts,
    account: account && {
      name: account.name,
      email: account.email,
      isOwner: account.isOwner,
      bootstrap: account.bootstrap,
      canSeeReports: account.isOwner || account.bootstrap
        || account.access.some((a) => a.systemId === 'insight'),
    },
  });
}

/** Change your own password. Anybody may do this; nobody may do it to somebody else. */
async function changeOwnPassword(env, { body, account }) {
  if (!account?.id) throw badRequest('A shared-password session has no account to change.');
  return json(await accounts.setPassword(env, account.id, body));
}

// ------------------------------------------------------------------- sso --

/** Everything this person may open, and whether they will be handed over. */
async function hub(env, { account }) {
  const systems = await systemsFor(env, account);
  return json({
    account: {
      name: account.name, email: account.email,
      isOwner: account.isOwner, bootstrap: account.bootstrap,
    },
    systems,
  });
}

/**
 * Mint a hand-off and say where to send the browser.
 *
 * Answers with the address rather than a redirect so the front end can open it
 * in a new tab. A person moving between five systems all day wants five tabs,
 * not five round trips back to a hub they have to find again.
 */
async function ssoStart(env, { body, account }) {
  const systemId = str(body?.systemId, 'System', { required: true, max: 40 });
  const { url, system, expiresIn } = await issueCode(env, account, systemId);
  return json({ url, expiresIn, system: { id: system.id, label: system.label } });
}

/**
 * The back channel: a code in, an identity out, once.
 *
 * The caller is another system's server. It says which system it is and proves
 * it with its own shared secret; a secret that authenticates it as the laundry
 * cannot redeem a code minted for the POS.
 */
async function ssoRedeem(env, { request, body }) {
  const header = request.headers.get('Authorization') || '';
  const secret = header.replace(/^Bearer\s+/i, '').trim() || str(body?.secret, 'Secret', { max: 300 });
  const systemId = str(body?.systemId ?? body?.system, 'System', { required: true, max: 40 });
  const code = str(body?.code, 'Code', { required: true, max: 300 });
  return json(await redeemCode(env, { code, systemId, secret }));
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
