import { json, HttpError, readJson, isMissingTable, csvResponse, str, badRequest } from './lib/http.js';
import {
  accountForCredentials, checkBootstrapPassword, clearCookie, createToken, currentAccount,
  requireInsight, requireOwner, requireSession, saltForEmail, sessionCookie,
} from './lib/auth.js';
import { issueCode, redeemCode, systemsFor } from './lib/sso.js';
import * as panels from './routes/panels.js';
import * as admin from './routes/admin.js';
import * as accounts from './routes/accounts.js';
import * as reports from './routes/reports.js';
import * as shiftRoutes from './routes/shifts.js';
import * as till from './routes/till.js';
import * as invitations from './routes/invitations.js';
import * as safe from './routes/safe.js';
import * as safebook from './routes/safebook.js';
import * as stays from './routes/stays.js';
import * as revenue from './routes/revenue.js';
import * as cashpo from './routes/cashpo.js';
import * as todo from './routes/todo.js';
import { verifyLink } from './lib/link.js';
import { first } from './lib/db.js';
import { loadFacts } from './insight/facts.js';
import { groupConfig } from './lib/db.js';
import { resolveRange } from './lib/dates.js';

/** The days asked for, thirty to yesterday unless said. Accra keeps UTC. */
const rangeOf = (query) => { const { from, to } = resolveRange(query, 'UTC', { days: 30 }); return { from, to }; };

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

  // An invitation's link. The token in the body is the only credential, and
  // each one works for one person, once, for a week.
  ['POST', '/api/invite/look', 'public', (env, ctx) => invitations.look(env, ctx.body)],
  ['POST', '/api/invite/accept', 'public', (env, ctx) => invitations.accept(env, ctx.body)],
  ['POST', '/api/invite/ask', 'public', (env, ctx) => invitations.ask(env, ctx.body, { origin: ctx.url.origin })],

  // The hub. Everybody who can sign in can see it, whatever else they can
  // reach — it is the reason most people will open this at all.
  ['GET', '/api/hub', 'session', hub],
  ['POST', '/api/sso/start', 'session', ssoStart],
  ['POST', '/api/auth/change-password', 'session', changeOwnPassword],

  // The numbers. A separate permission from being able to sign in, because
  // somebody who needs the till does not necessarily get the wage bill.
  ['GET', '/api/bootstrap', 'shifts', (env) => panels.bootstrap(env)],
  ['GET', '/api/brief', 'insight', (env, ctx) => panels.brief(env, ctx.query)],
  ['GET', '/api/pnl', 'insight', (env, ctx) => panels.pnl(env, ctx.query)],
  // Money, from the shifts: the rooms' revenue out of the ASSD journal, and spending paid in cash.
  ['GET', '/api/money/cash', 'insight', (env, ctx) => cashpo.cashView(env, rangeOf(ctx.query))],
  ['POST', '/api/money/cash/refresh', 'insight', (env, ctx) => cashpo.refreshNow(env, ctx.account)],
  ['GET', '/api/money/articles', 'insight', (env, ctx) => revenue.articlesView(env, rangeOf(ctx.query))],
  ['POST', '/api/money/articles', 'insight', (env, ctx) => revenue.saveArticle(env, ctx.body, ctx.account)],
  // The money to-do list: a supervisor's own, everything for an admin.
  ['GET', '/api/todo', 'shifts', (env, ctx) => todo.listTodos(env, ctx.account, { closed: ctx.query.closed === '1' })],
  ['POST', '/api/todo/check', 'shifts', (env, ctx) => cashpo.refreshNow(env, ctx.account, { fromTodo: true })],
  ['POST', '/api/todo/assign', 'shifts', (env, ctx) => todo.assignMany(env, ctx.body, ctx.account)],
  // A longer or shorter look-back is a different set of POs: Odoo is asked again.
  ['POST', '/api/todo/settings', 'shifts', async (env, ctx) => {
    const saved = await todo.saveTodoSettings(env, ctx.body, ctx.account);
    if (!saved.lookbackChanged) return saved;
    const checked = await cashpo.refreshCashPos(env).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    return { ...saved, checked };
  }],
  ['POST', '/api/todo/:id/answer', 'shifts', (env, ctx) => todo.answerTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/todo/:id/decide', 'shifts', (env, ctx) => todo.decideTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/todo/:id/assign', 'shifts', (env, ctx) => todo.assignTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/todo/:id/dismiss', 'shifts', (env, ctx) => todo.dismissTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['GET', '/api/financials', 'insight', (env, ctx) => panels.financials(env, ctx.query)],
  ['GET', '/api/labour', 'insight', (env, ctx) => panels.labour(env, ctx.query)],
  ['GET', '/api/demand', 'insight', (env, ctx) => panels.demand(env, ctx.query)],
  ['GET', '/api/cash', 'insight', (env, ctx) => panels.cash(env, ctx.query)],
  ['GET', '/api/suppliers', 'insight', (env, ctx) => panels.suppliers(env, ctx.query)],
  ['GET', '/api/books', 'insight', (env, ctx) => panels.books(env, ctx.query)],
  ['GET', '/api/service', 'insight', (env, ctx) => panels.service(env, ctx.query)],
  ['GET', '/api/findings', 'insight', (env, ctx) => panels.findings(env, ctx.query)],
  ['POST', '/api/findings/:id', 'insight', (env, ctx) => admin.decideFinding(env, ctx.params.id, ctx.body)],
  ['GET', '/api/export', 'insight', exportCsv],

  // Shift reconciliation. An admin does all of it; a supervisor gets the
  // parts an admin chose (see routes/till.js), and nothing else in the app.
  // `shifts` lets both in, and each handler checks what this one may do.
  ['GET', '/api/shifts', 'shifts', shiftsRead],
  ['POST', '/api/shifts/count', 'shifts', adminOnly((env, ctx) => shiftRoutes.saveCount(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/expense', 'shifts', adminOnly((env, ctx) => shiftRoutes.saveExpense(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/expense/pull', 'shifts', adminOnly((env, ctx) => shiftRoutes.pullOrders(env, ctx.body))],
  ['POST', '/api/shifts/answer', 'shifts', async (env, ctx) => {
    // An unpaid stay is answered by whoever may act on Unpaid stays; anything else by whoever may act on the exceptions.
    const stay = String(ctx.body?.key || '').startsWith('stay:');
    await till.requireArea(env, ctx.account, stay ? 'unpaid' : 'bank', 2);
    return waitsForAdmin(env, ctx, shiftRoutes.saveAnswer(env, ctx.body, ctx.account, { pending: isSupervisor(ctx) }),
      `${ctx.account?.name || 'A supervisor'} answered ${stay ? 'an unpaid stay' : 'an exception'}: ${ctx.body?.answer || ''}.`);
  }],
  ['POST', '/api/shifts/movement', 'shifts', movement],
  ['POST', '/api/shifts/link', 'shifts', area('bank', 2, (env, ctx) => waitsForAdmin(env, ctx, shiftRoutes.saveLink(env, ctx.body, ctx.account, { pending: isSupervisor(ctx) }), `${ctx.account?.name || 'A supervisor'} reconciled ${(ctx.body?.keys || []).length} exceptions together.`))],
  ['POST', '/api/shifts/unlink', 'shifts', area('bank', 2, (env, ctx) => shiftRoutes.removeLink(env, ctx.body, ctx.account, { pending: isSupervisor(ctx) }))],
  ['GET', '/api/shifts/files', 'shifts', area('files', 1, (env) => shiftRoutes.filesStatus(env))],
  ['POST', '/api/shifts/journal', 'shifts', area('files', 2, (env, ctx) => shiftRoutes.uploadJournal(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/bank', 'shifts', area('files', 2, (env, ctx) => shiftRoutes.uploadBank(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/terminal', 'shifts', area('files', 2, (env, ctx) => shiftRoutes.uploadTerminal(env, ctx.body, ctx.account))],

  // Stays not fully paid: leaving in the next 24 hours, or already left.
  // Answers to them go through /api/shifts/answer, like any exception.
  ['GET', '/api/stays', 'shifts', area('unpaid', 1, (env, ctx) => stays.unpaidStays(env, ctx.account))],

  // The safe: what each shift moved into it, and the closures. Admins only.
  ['GET', '/api/safe', 'shifts', (env, ctx) => safe.safeView(env, ctx.query, ctx.account)],
  // The safe book: in from the shifts, out as written, a count to close a page.
  ['GET', '/api/safe/book', 'shifts', (env, ctx) => safebook.bookView(env, ctx.account, { counted: ctx.query.counted ? Math.round(Number(ctx.query.counted) * 100) : null, from: ctx.query.from, to: ctx.query.to })],
  ['POST', '/api/safe/entry', 'shifts', (env, ctx) => safebook.addEntry(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/entry/:id/po', 'shifts', (env, ctx) => safebook.settleEntry(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/safe/entry/:id/remove', 'shifts', (env, ctx) => safebook.removeEntry(env, ctx.params.id, ctx.account)],
  ['POST', '/api/safe/dismiss', 'shifts', (env, ctx) => safebook.dismissPo(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/count', 'shifts', (env, ctx) => safebook.countSafe(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/close', 'shifts', (env, ctx) => safe.closeSafe(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/:id/taken', 'shifts', (env, ctx) => safe.saveTaken(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/safe/:id/undo', 'shifts', (env, ctx) => safe.undoClosure(env, ctx.params.id, ctx.account)],

  // Closing reports from HIVE, what staff answered, and the settings.
  ['GET', '/api/till', 'shifts', (env, ctx) => till.overview(env, ctx.query, ctx.account)],
  ['POST', '/api/till/resolve', 'shifts', (env, ctx) => till.resolve(env, ctx.body, ctx.account)],
  ['POST', '/api/till/reopen', 'shifts', (env, ctx) => till.reopen(env, ctx.body, ctx.account)],
  ['POST', '/api/till/move', 'shifts', (env, ctx) => till.moveReport(env, ctx.body, ctx.account)],
  ['POST', '/api/till/approve', 'shifts', (env, ctx) => till.approve(env, ctx.body, ctx.account)],
  ['POST', '/api/till/settings', 'shifts', (env, ctx) => till.saveSettings(env, ctx.body, ctx.account)],

  // The till link: HIVE asking, server to server, signed with the secret the
  // two already share for the sign-in hand-off. No session reaches these.
  ['POST', '/api/link/till/setup', 'link', (env) => till.linkSetup(env)],
  ['POST', '/api/link/till/po', 'link', (env, ctx) => till.linkPo(env, ctx.body)],
  ['POST', '/api/link/till/issues', 'link', (env, ctx) => till.linkIssues(env, ctx.body)],
  ['POST', '/api/link/till/recipients', 'link', (env, ctx) => till.linkRecipients(env, ctx.body)],

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
  ['GET', '/api/invitations', 'owner', async (env) => ({ invitations: await invitations.list(env) })],
  ['POST', '/api/invitations', 'owner', (env, ctx) => invitations.invite(env, ctx.body, ctx.account, { origin: ctx.url.origin })],
  ['POST', '/api/invitations/:id/resend', 'owner', (env, ctx) => invitations.resend(env, ctx.params.id, ctx.body, ctx.account, { origin: ctx.url.origin })],
  ['POST', '/api/invitations/:id/withdraw', 'owner', (env, ctx) => invitations.withdraw(env, ctx.params.id)],

  // Reports made elsewhere, published behind a PIN. Publishing is a multipart
  // upload, so the handler reads the request itself rather than a JSON body.
  ['GET', '/api/reports', 'owner', (env) => reports.list(env)],
  ['POST', '/api/reports', 'owner', (env, ctx) => reports.publish(env, ctx.request, ctx.account)],
  ['POST', '/api/reports/:slug/remove', 'owner', (env, ctx) => reports.remove(env, ctx.params.slug)],
  ['POST', '/api/reports/:slug/files/:name/remove', 'owner', (env, ctx) => reports.removeFile(env, ctx.params.slug, ctx.params.name)],
  ['POST', '/api/report-pins', 'owner', (env, ctx) => reports.createPin(env, ctx.body, ctx.account)],
  ['POST', '/api/report-pins/:id/revoke', 'owner', (env, ctx) => reports.revokePin(env, ctx.params.id)],
];
;

/** Everything an uploader may call, beyond signing in and the hub. */
const UPLOADER_MAY = new Set([
  'GET /api/shifts/files', 'POST /api/shifts/journal', 'POST /api/shifts/bank', 'POST /api/shifts/terminal',
]);

export default {
  async fetch(request, env, execution) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // A published report lives at its own address, in front of the app's
      // own files. Anything that is not one falls through to them as before.
      try {
        const served = await reports.serve(request, env, url);
        if (served) return served;
      } catch (err) {
        return errorResponse(err);
      }
      return env.ASSETS.fetch(request);
    }

    try {
      const match = findRoute(request.method, url.pathname);
      if (!match) throw new HttpError(404, 'No such endpoint');
      const [route, params] = match;
      const [, , permission, handler] = route;

      // Four levels, and the difference between them matters now that this is
      // a front door rather than a report: signing in, reading the numbers,
      // and changing what everybody else sees are three different things.
      let account = null;
      let body = null;
      if (permission === 'session') account = await requireSession(request, env);
      else if (permission === 'shifts') {
        account = await requireInsight(request, env);
        // An uploader reaches the upload endpoints and nothing else.
        if (till.roleOf(account) === 'uploader' && !UPLOADER_MAY.has(`${request.method} ${url.pathname}`)) {
          throw new HttpError(403, 'Your account uploads files and nothing else here.');
        }
      } else if (permission === 'insight') {
        account = await requireInsight(request, env);
        // A supervisor holds the reports grant for the Shifts screen alone, and an uploader for the files.
        const role = till.roleOf(account);
        if (role === 'supervisor') throw new HttpError(403, 'Your account opens Shifts and nothing else here.');
        if (role === 'uploader') throw new HttpError(403, 'Your account uploads files and nothing else here.');
      } else if (permission === 'owner') account = await requireOwner(request, env);
      else if (permission === 'link') {
        const text = await request.text();
        const ok = await verifyLink(env.SSO_SECRET_ATTENDANCE, {
          at: request.headers.get('X-Till-At'), sig: request.headers.get('X-Till-Sig'), path: url.pathname, bodyText: text,
        });
        if (!ok) throw new HttpError(401, 'That request did not come from HIVE.');
        try { body = JSON.parse(text || '{}'); } catch { throw badRequest('That was not JSON.'); }
      }

      const query = Object.fromEntries(url.searchParams);
      if (body === null) {
        body = request.method === 'POST' && request.headers.get('Content-Type')?.includes('application/json')
          ? await readJson(request)
          : {};
      }

      const result = await handler(env, { request, query, body, params, url, account, execution });
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
      canSeeReports: till.roleOf(account) === 'admin',
      till: till.roleOf(account) ? { role: till.roleOf(account), access: await till.accessOf(env, account) } : null,
    },
  });
}

// ----------------------------------------------------------------- shifts --

/** A handler only an admin may use. */
function adminOnly(handler) {
  return async (env, ctx) => {
    await till.requireAdmin(ctx.account);
    return handler(env, ctx);
  };
}

/** A handler for whoever may do `level` with `area`: every admin, and the supervisors given it. */
function area(name, level, handler) {
  return async (env, ctx) => {
    await till.requireArea(env, ctx.account, name, level);
    return handler(env, ctx);
  };
}

/** The Shifts screen's data, cut to what a supervisor was given. */
async function shiftsRead(env, ctx) {
  const role = till.roleOf(ctx.account);
  const data = await shiftRoutes.shifts(env, ctx.query, ctx.account);
  if (role === 'admin') return { ...data, canUpload: true };
  const access = await till.accessOf(env, ctx.account);
  if (!['day', 'week', 'month', 'money', 'bank', 'net', 'files', 'moves'].some((k) => access[k] > 0)) {
    throw new HttpError(403, 'No part of Shifts has been shared with you yet.');
  }
  return shiftRoutes.forSupervisor(data, access);
}

const isSupervisor = (ctx) => till.roleOf(ctx.account) !== 'admin';

/** A supervisor's answer waits for an admin; tell the admins, without holding up the reply. */
async function waitsForAdmin(env, ctx, saving, text) {
  const out = await saving;
  if (out?.pending) {
    const tell = till.tellApprovers(env, { text });
    if (ctx.execution?.waitUntil) ctx.execution.waitUntil(tell); else await tell;
  }
  return out;
}

/** A correction to a cash movement: an admin's applies, a supervisor's waits for an admin. */
async function movement(env, ctx) {
  if (till.roleOf(ctx.account) === 'admin') return shiftRoutes.saveMovement(env, ctx.body, ctx.account);
  await till.requireArea(env, ctx.account, 'moves', 2);
  const out = await shiftRoutes.saveMovement(env, ctx.body, ctx.account, { pending: true });
  if (out.pending) {
    const tell = till.tellApprovers(env, { seq: out.seq, kind: out.kind, by: ctx.account?.name || 'A supervisor' });
    if (ctx.execution?.waitUntil) ctx.execution.waitUntil(tell); else await tell;
  }
  return out;
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
