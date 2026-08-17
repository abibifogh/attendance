import {
  clearCookie, createToken, getPepper, getSession, hashPin, isReservedPin,
  saltForEmail, sessionCookie, storedPassword, throttleCheck, throttleFail,
  throttleReset, tokenTtl, userForCredentials, userForPin, verifyPasswordKey,
} from './lib/auth.js';
import { allows, effectivePermissions } from './lib/permissions.js';
import {
  HttpError, badRequest, forbidden, isMissingTable, json, readJson, str, unauthorized,
} from './lib/http.js';
import * as att from './routes/attendance.js';
import * as attSetup from './routes/attendance-setup.js';
import * as rotaImport from './routes/rota-import.js';
import * as people from './routes/people.js';
import * as invite from './routes/invite.js';
import * as admin from './routes/admin.js';
import * as push from './routes/push.js';
import { todayIn } from './util/dates.js';
import { PIN_TAKEN } from './routes/admin.js';

/**
 * Route table: [method, pattern, permission, handler].
 *
 * The permission is the gate. Hiding a menu item is a courtesy to the person
 * using the app; this table is what actually stops a supervisor reading the
 * leave balances. `null` means the endpoint is open to anyone signed in, and
 * `'public'` means no session is required at all.
 */
export const ROUTES = [
  ['POST', '/api/auth/salt', 'public', passwordSalt],
  ['POST', '/api/auth/login', 'public', login],
  ['POST', '/api/auth/logout', 'public', logout],
  ['GET', '/api/auth/me', 'public', me],
  ['POST', '/api/auth/change-credentials', null, changeCredentials],

  // ------------------------------------------------------------- the feed --
  // Public in the sense that no session reaches it: the caller is a script on a
  // cupboard PC that must keep working at three in the morning. It proves
  // itself with a device token instead, and the only thing that token can do is
  // add punches to its own terminal's serial.
  ['POST', '/api/att/ingest', 'public', att.ingest],
  // The same feed, reporting what the terminal says about its own attendance
  // configuration. Same token, same one thing it is allowed to do.
  ['POST', '/api/att/device-config', 'public', att.deviceConfig],
  // The terminal posting its own events, with nothing running on site. The
  // token is in the path because a listening-host configuration has nowhere to
  // put a header.
  ['POST', '/api/att/push/:token', 'public', att.pushEvents],

  // ------------------------------------------------------------- every day --
  ['GET', '/api/att/bootstrap', 'att_view', att.bootstrap],
  ['GET', '/api/att/day', 'att_view', att.day],
  ['GET', '/api/att/staff/:id/day', 'att_view', att.staffDay],

  ['GET', '/api/att/week', 'att_reports', att.week],
  // Reachable by whoever signs periods off, because that is where the days are
  // corrected. The leave balance is stripped from the answer for anybody
  // without the reports permission — see `staffReport`.
  ['GET', '/api/att/staff/:id/report', ['att_reports', 'att_signoff'], att.staffReport],
  ['GET', '/api/att/overview', 'att_reports', att.overview],
  ['GET', '/api/att/export', 'att_reports', att.exportCsv],
  ['GET', '/api/att/balances', 'att_reports', att.balances],

  // The monthly reckoning. Reading it is a report; signing it off moves
  // somebody's leave, so it needs the permission that approves leave.
  ['GET', '/api/att/review', ['att_reports', 'att_signoff'], att.periodReview],
  ['POST', '/api/att/review', 'att_signoff', att.decidePeriod],
  ['POST', '/api/att/review/undo', 'att_signoff', att.undoPeriod],

  // Settling a day is a decision with somebody's name on it, so it sits behind
  // its own permission rather than travelling with the reports.
  ['POST', '/api/att/days/:day/resolve', 'att_manage', att.resolveDay],
  ['POST', '/api/att/days/:day/unresolve', 'att_manage', att.unresolveDay],
  ['POST', '/api/att/punches', 'att_manage', att.addPunch],

  ['GET', '/api/att/roster', ['att_rota', 'att_reports'], att.getRoster],
  ['POST', '/api/att/roster', 'att_rota', att.saveRoster],
  ['POST', '/api/att/roster/copy', 'att_rota', att.copyRoster],
  ['POST', '/api/att/patterns', 'att_rota', att.savePattern],

  // Importing a week. Reading and drafting is part of building the rota;
  // so is confirming it, because the draft only ever writes the rota.
  ['GET', '/api/att/rota-import', 'att_rota', rotaImport.getRotaImport],
  ['POST', '/api/att/rota-import', 'att_rota', rotaImport.previewRotaImport],
  ['POST', '/api/att/rota-import/name', 'att_rota', rotaImport.mapImportName],
  ['POST', '/api/att/rota-import/shift', 'att_rota', rotaImport.resolveImportShift],
  ['POST', '/api/att/rota-import/confirm', 'att_rota', rotaImport.confirmRotaImport],
  ['POST', '/api/att/rota-import/discard', 'att_rota', rotaImport.discardRotaImport],

  ['GET', '/api/att/leave', 'att_view', att.listLeave],
  ['POST', '/api/att/leave', 'att_rota', att.requestLeave],
  ['POST', '/api/att/leave/:id/decide', 'att_manage', att.decideLeave],
  ['DELETE', '/api/att/leave/:id', 'att_manage', att.cancelLeave],

  // ----------------------------------------------------------------- setup --
  ['GET', '/api/att/staff', ['att_setup', 'att_rota'], attSetup.listStaff],
  ['POST', '/api/att/staff', 'att_setup', attSetup.createStaff],
  ['PUT', '/api/att/staff/:id', 'att_setup', attSetup.updateStaff],
  ['DELETE', '/api/att/staff/:id', 'att_setup', attSetup.deleteStaff],
  ['GET', '/api/att/unknown', 'att_setup', attSetup.unknownEmployees],

  ['GET', '/api/att/shifts', ['att_setup', 'att_rota'], attSetup.listShifts],
  ['GET', '/api/att/shift-suggestions', 'att_setup', att.shiftSuggestions],
  ['POST', '/api/att/shifts/import', 'att_setup', att.importShifts],
  ['POST', '/api/att/shifts', 'att_setup', attSetup.createShift],
  ['PUT', '/api/att/shifts/:id', 'att_setup', attSetup.updateShift],
  ['DELETE', '/api/att/shifts/:id', 'att_setup', attSetup.deleteShift],

  ['GET', '/api/att/reasons', 'att_view', attSetup.listReasons],
  ['POST', '/api/att/reasons', 'att_setup', attSetup.createReason],
  ['PUT', '/api/att/reasons/:code', 'att_setup', attSetup.updateReason],
  ['DELETE', '/api/att/reasons/:code', 'att_setup', attSetup.deleteReason],

  ['GET', '/api/att/holidays', 'att_view', attSetup.listHolidays],
  ['POST', '/api/att/holidays', 'att_setup', attSetup.createHoliday],
  ['POST', '/api/att/holidays/generate', 'att_setup', attSetup.generateHolidays],
  ['DELETE', '/api/att/holidays/:id', 'att_setup', attSetup.deleteHoliday],

  ['GET', '/api/att/devices', 'att_setup', attSetup.listDevices],
  ['POST', '/api/att/devices', 'att_setup', attSetup.createDevice],
  ['PUT', '/api/att/devices/:id', 'att_setup', attSetup.updateDevice],
  ['POST', '/api/att/devices/:id/token', 'att_setup', attSetup.rotateToken],
  ['DELETE', '/api/att/devices/:id', 'att_setup', attSetup.deleteDevice],

  ['PUT', '/api/att/settings', 'att_setup', attSetup.updateSettings],
  ['POST', '/api/att/recompute', 'att_setup', attSetup.recomputeRange],

  // -------------------------------------------------------------- records --
  ['GET', '/api/hr/model', 'hr_view', people.peopleModel],
  ['GET', '/api/hr/people', 'hr_view', people.listPeople],
  ['GET', '/api/hr/people/:id', 'hr_view', people.getPerson],
  ['PUT', '/api/hr/people/:id', 'hr_manage', people.savePerson],
  ['PUT', '/api/hr/people/:id/lists/:list', 'hr_manage', people.saveList],

  ['POST', '/api/hr/people/:id/documents', 'hr_manage', people.addDocument],
  // Reading a scan of somebody's Ghana Card is reading the number on it, so it
  // needs the permission that unmasks the number and not the one that hides it.
  ['GET', '/api/hr/documents/:id', 'hr_manage', people.getDocument],
  ['DELETE', '/api/hr/documents/:id', 'hr_manage', people.deleteDocument],

  ['POST', '/api/hr/people/:id/invites', 'hr_manage', people.createInvite],
  ['POST', '/api/hr/invites/:id/revoke', 'hr_manage', people.revokeInvite],

  ['GET', '/api/hr/submissions', 'hr_view', people.listSubmissions],
  ['POST', '/api/hr/submissions/:id/accept', 'hr_manage', people.acceptSubmission],
  ['POST', '/api/hr/submissions/:id/reject', 'hr_manage', people.rejectSubmission],

  ['GET', '/api/hr/templates', 'hr_manage', people.listTemplates],
  ['POST', '/api/hr/templates', 'hr_manage', (ctx) => people.saveTemplate(ctx, null)],
  ['PUT', '/api/hr/templates/:id', 'hr_manage', people.saveTemplate],
  ['DELETE', '/api/hr/templates/:id', 'hr_manage', people.deleteTemplate],

  ['POST', '/api/hr/people/:id/contracts', 'hr_manage', people.issueContract],
  ['GET', '/api/hr/contracts/:id', 'hr_view', people.getContract],
  ['POST', '/api/hr/contracts/:id/countersign', 'hr_manage', people.countersignContract],
  ['POST', '/api/hr/contracts/:id/void', 'hr_manage', people.voidContract],

  // ------------------------------------------------- somebody with a link --
  // No session reaches any of these. The token in the path is the whole of the
  // caller's authority and it can only ever act on the one person the link was
  // made for — see the note at the top of routes/invite.js.
  ['GET', '/api/i/:token', 'public', invite.inviteHead],
  ['POST', '/api/i/:token/open', 'public', invite.inviteOpen],
  ['POST', '/api/i/:token/details', 'public', invite.inviteDetails],
  ['POST', '/api/i/:token/viewed', 'public', invite.inviteViewed],
  ['POST', '/api/i/:token/sign', 'public', invite.inviteSign],
  ['POST', '/api/i/:token/decline', 'public', invite.inviteDecline],

  // ------------------------------------------------------- people and data --
  ['GET', '/api/users', 'users', admin.listUsers],
  ['POST', '/api/users', 'users', admin.createUser],
  ['PUT', '/api/users/:id', 'users', admin.updateUser],
  ['DELETE', '/api/users/:id', 'users', admin.deleteUser],

  ['GET', '/api/push/key', null, push.publicKey],
  ['GET', '/api/push/status', null, push.status],
  ['POST', '/api/push/subscribe', null, push.subscribe],
  ['POST', '/api/push/unsubscribe', null, push.unsubscribe],
  ['POST', '/api/push/test', null, push.test],
  ['DELETE', '/api/push/devices/:id', 'users', push.removeDevice],

  ['GET', '/api/notifications', 'users', admin.getNotifications],
  ['PUT', '/api/notifications', 'users', admin.updateNotifications],
  ['POST', '/api/notifications/test', 'users', admin.testNotification],

  ['GET', '/api/data/summary', 'users', admin.dataSummary],
  ['POST', '/api/data/erase', 'users', admin.eraseData],
  ['GET', '/api/audit', 'users', admin.auditTrail],

  // The bell. Open to anyone signed in, and what each person sees is decided
  // inside the query by the permissions they already hold.
  ['GET', '/api/notices', null, admin.listNoticesRoute],
  ['POST', '/api/notices/seen', null, admin.markNoticesSeen],
];

function match(pattern, pathname) {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params = [];
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (!got[i]) return null;
      params.push(decodeURIComponent(got[i]));
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);

    // The link somebody is sent reads `/i/<token>` — short enough to type off a
    // screen and to survive being pasted into a message. It is one page, and
    // the token is read back out of the address by the page itself.
    if (url.pathname.startsWith('/i/')) {
      return env.ASSETS.fetch(new Request(new URL('/invite.html', url), request));
    }

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env, url, executionContext);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
      }
      if (isMissingTable(err)) {
        return json({
          error: 'This site has been updated but its database has not. '
            + 'Run the latest database changes — see “Create the tables” in the setup guide — '
            + 'and this will start working. Nothing has been lost.',
          detail: { missingSchema: true },
        }, { status: 503 });
      }
      // Last resort: a constraint that slipped past its handler is still a
      // rule being broken, not a broken server. Say which rule.
      const text = String(err?.message ?? err);
      if (/UNIQUE constraint/i.test(text)) {
        return json({
          error: 'That would duplicate something that has to be unique — usually a name or an '
            + 'employee number that is already taken. Change it and try again.',
        }, { status: 400 });
      }
      if (/FOREIGN KEY constraint/i.test(text)) {
        return json({
          error: 'That refers to something that no longer exists. Reload the page and try again.',
        }, { status: 400 });
      }

      console.error('Unhandled error', err);
      return json({ error: 'Something went wrong on the server' }, { status: 500 });
    }
  },

  /**
   * The daily tick, from a Cron Trigger.
   *
   * Recomputes the last few days so a punch that arrived late is reflected, and
   * rings the bell once for whatever still needs a person. Once — a
   * notification per exception would be a dozen a morning and everybody would
   * learn to swipe them away.
   *
   * Idempotent, so a cron that fires twice cannot produce two rounds of email.
   */
  async scheduled(event, env, executionContext) {
    if (!env.DB) return;

    const run = (async () => {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'")
        .first()
        .catch(() => null);
      const today = todayIn(row?.value || 'UTC');

      const result = await att.dailyTick(env.DB, env, today);
      if (result.open || result.absent) {
        console.log(`Attendance: ${result.open} to confirm, ${result.absent} absent`);
      }
    })().catch((err) => console.error('Scheduled run failed', err));

    if (executionContext?.waitUntil) executionContext.waitUntil(run);
    else await run;
  },
};

async function route(request, env, url, executionContext) {
  if (!env.SESSION_SECRET) {
    return json(
      { error: 'Server not configured: SESSION_SECRET is missing. See the README setup steps.' },
      { status: 503 },
    );
  }
  if (!env.DB) {
    return json({ error: 'Server not configured: no database binding.' }, { status: 503 });
  }

  const method = request.method === 'HEAD' ? 'GET' : request.method;
  let allowedMethods = null;

  for (const [routeMethod, pattern, permission, handler] of ROUTES) {
    const params = match(pattern, url.pathname);
    if (!params) continue;
    if (routeMethod !== method) {
      allowedMethods = allowedMethods || [];
      allowedMethods.push(routeMethod);
      continue;
    }

    const ctx = { request, env, url, db: env.DB, executionContext, session: null };

    if (permission !== 'public') {
      ctx.session = await getSession(request, env, env.DB);
      if (!ctx.session) throw unauthorized();
      // A list means any one of them is enough — see `allows`.
      if (!allows(permission, ctx.session.permissions)) {
        throw forbidden('You do not have access to that part of the system.');
      }
    }

    return handler(ctx, ...params);
  }

  if (allowedMethods?.length) {
    return json({ error: 'Method not allowed' }, {
      status: 405,
      headers: { Allow: [...new Set(allowedMethods)].join(', ') },
    });
  }
  return json({ error: 'Unknown endpoint' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

/**
 * The salt and work factor to derive with, for a given address.
 *
 * Public by necessity — the browser needs it before it can prove anything. An
 * address with no account gets a stable made-up salt, so this cannot be used to
 * find out who has an account.
 */
async function passwordSalt(ctx) {
  const body = await readJson(ctx.request);
  const email = str(body.email, 'Email address', { required: true, max: 200 });
  const params = await saltForEmail(ctx.db, email, await getPepper(ctx.db));
  return json(params);
}

async function login(ctx) {
  const { request, env, url, db } = ctx;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const gate = throttleCheck(ip);
  if (!gate.allowed) {
    return json(
      { error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.` },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } },
    );
  }

  const body = await readJson(request);

  // Two ways in: a PIN for a supervisor with a phone in a corridor, or an email
  // address and password for administrators.
  const user = body.email
    ? await userForCredentials(db, body.email, String(body.passwordKey ?? ''))
    : await userForPin(db, str(body.pin, 'PIN', { required: true, max: 64 }), env);

  if (!user) {
    throttleFail(ip);
    // A uniform delay keeps a wrong credential from being distinguishable by
    // timing, and says nothing about which half was wrong.
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest(body.email
      ? 'That email address and password combination was not recognised'
      : 'That PIN was not recognised');
  }

  throttleReset(ip);

  const now = Math.floor(Date.now() / 1000);
  const token = await createToken(
    {
      uid: user.id,
      role: user.role,
      recovery: user.isRecovery ? 1 : 0,
      iat: now,
      exp: now + tokenTtl(user.role),
    },
    env.SESSION_SECRET,
  );

  if (!user.isRecovery) {
    await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .bind(user.id).run().catch(() => {});
  }

  return json({
    ok: true,
    role: user.role,
    name: user.name,
    email: user.email ?? null,
    isRecovery: Boolean(user.isRecovery),
    permissions: effectivePermissions(user),
  }, {
    headers: { 'Set-Cookie': sessionCookie(token, user.role, url.protocol === 'https:') },
  });
}

async function logout(ctx) {
  return json({ ok: true }, {
    headers: { 'Set-Cookie': clearCookie(ctx.url.protocol === 'https:') },
  });
}

async function me(ctx) {
  const session = await getSession(ctx.request, ctx.env, ctx.db);
  if (!session) return json({ authenticated: false });

  const settings = await ctx.db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('property_name','timezone')",
  ).all();

  return json({
    authenticated: true,
    role: session.user.role,
    name: session.user.name,
    email: session.user.email ?? null,
    userId: session.user.id,
    isRecovery: Boolean(session.user.isRecovery),
    signsInWith: session.user.role === 'admin' ? 'password' : 'pin',
    permissions: session.permissions,
    settings: Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value])),
  });
}

/**
 * Change your own PIN or password.
 *
 * Everyone can do this for themselves, which is what stops a shared PIN quietly
 * becoming permanent because changing it needed an administrator. The current
 * credential is always required, so an unattended signed-in tablet cannot be
 * used to lock its owner out.
 */
async function changeCredentials(ctx) {
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  if (session.user.isRecovery) {
    throw badRequest(
      'You are signed in with the emergency recovery PIN, which is set on the server rather than here. '
      + 'Sign in with your own account to change its credentials.',
    );
  }

  const row = await db.prepare(
    'SELECT id, role, pin_hash, password_hash FROM users WHERE id = ?',
  ).bind(session.user.id).first();
  if (!row) throw badRequest('Your account could not be found');

  // Administrators hold a password; everyone else holds a PIN.
  if (session.user.role === 'admin') {
    const pepper = await getPepper(db);
    const currentKey = String(body.currentPasswordKey ?? '');

    if (!await verifyPasswordKey(currentKey, row.password_hash, pepper)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw badRequest('Your current password is not correct');
    }
    if (!body.passwordKey || !body.passwordSalt) {
      throw badRequest('The new password did not reach the server correctly. Please try again.');
    }
    if (body.passwordKey === currentKey) {
      throw badRequest('The new password is the same as the current one');
    }

    const next = await storedPassword({
      passwordKey: String(body.passwordKey),
      salt: String(body.passwordSalt),
      iterations: body.passwordIterations,
    }, pepper);

    await db.batch([
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(next, row.id),
      db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
        .bind(`${session.user.name} (${session.user.role})`, 'account.password_change', String(row.id), null),
    ]);

    return json({ ok: true, changed: 'password' });
  }

  const current = String(body.currentPin ?? '');
  const next = String(body.newPin ?? '');
  const pepper = await getPepper(db);

  if (await hashPin(current, pepper) !== row.pin_hash) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest('Your current PIN is not correct');
  }
  if (!/^\d{4,10}$/.test(next)) throw badRequest('The new PIN must be 4 to 10 digits');
  if (next === current) throw badRequest('The new PIN is the same as the current one');
  if (await isReservedPin(next, ctx.env)) throw badRequest(PIN_TAKEN);

  try {
    await db.batch([
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
        .bind(await hashPin(next, pepper), row.id),
      db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
        .bind(`${session.user.name} (${session.user.role})`, 'account.pin_change', String(row.id), null),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw badRequest(PIN_TAKEN);
    throw err;
  }

  return json({ ok: true, changed: 'pin' });
}
