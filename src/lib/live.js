import { allows } from './permissions.js';

/**
 * Live updates: one message, to every device signed in.
 *
 * These screens are read as boards. Somebody leaves Today open on the office
 * computer, a supervisor has Rota on a phone, a member of staff has My shifts
 * on theirs — and until now all three brought themselves up to date on a
 * timer. A timer is the wrong shape for this. It is late by design (a minute
 * of staleness on every screen, all the time), it fetches when nothing has
 * happened, which is most of the time, and it still cannot tell a screen that
 * something *has*. So the timer is gone and the server says so instead.
 *
 * WHAT TRAVELS IS THE FACT THAT SOMETHING CHANGED, AND NOTHING ELSE. A message
 * is a topic name and a timestamp. No rows, no names, no numbers. The screen
 * that hears it re-asks the API through the same permission-checked endpoint
 * it always used, so this channel can never become a way of learning something
 * the asker was not allowed to fetch.
 *
 * The topic still decides who is told, because "payroll changed" is itself
 * worth keeping off a supervisor's phone even with nothing attached to it.
 * Each topic names the permissions that may hear it, read the same way the
 * route table reads them: any one is enough.
 */

/** The hub is one object for the property. Two dozen sockets, one room. */
export const HUB = 'property';

/**
 * Who may be told, per topic.
 *
 * These are permissions to *hear*, not permissions to change. That difference
 * is the whole point of the list: a member of staff can do nothing at all to a
 * rota and is the person most waiting to hear that one has been published, so
 * `att_me` belongs on the rota topic even though it can never write to it.
 *
 * `null` means everybody signed in.
 */
export const TOPICS = {
  attendance: ['att_view', 'att_me'],
  rota: ['att_rota', 'att_view', 'att_me'],
  leave: ['att_view', 'att_me'],
  people: ['hr_view'],
  // A candidate taking an interview time is the one change in this app that
  // happens with nobody here doing it, so the diary has to hear about it.
  recruitment: ['rec_view'],
  pay: ['hr_pay', 'att_me'],
  letters: ['corr_view'],
  lunch: ['lunch', 'att_me'],
  admin: ['users'],
  notices: null,
  // Anything the table below has not got to yet. Told to everybody, which is
  // safe because a topic name carries nothing, and treated by every screen as
  // "ask again" — which is exactly what the old timer did on every tick.
  other: null,
};

/**
 * Path to topic.
 *
 * A prefix table rather than a fifth column on two hundred routes: a route
 * added under `/api/corr/` is a letter changing whether or not anybody
 * remembered to say so here. Longest prefix wins, so the specific entries
 * below can sit under the general ones in any order.
 */
const BY_PATH = [
  ['/api/att/roster', 'rota'],
  ['/api/att/shifts', 'rota'],
  ['/api/att/patterns', 'rota'],
  ['/api/att/rota-import', 'rota'],
  ['/api/att/availability', 'rota'],
  ['/api/att/holidays', 'rota'],
  ['/api/att/leave', 'leave'],
  ['/api/me/leave', 'leave'],
  ['/api/me/availability', 'rota'],
  ['/api/me/medical', 'pay'],
  ['/api/me/advances', 'pay'],
  ['/api/me/running-late', 'attendance'],
  ['/api/att/', 'attendance'],
  ['/api/signoff', 'attendance'],
  ['/api/audit/', 'attendance'],
  ['/api/hr/', 'people'],
  ['/api/i/', 'people'],
  ['/api/rec/', 'recruitment'],
  // The candidate's own side. Their booking is exactly the change the office
  // screens most need to hear about, and it comes from a page with no session.
  ['/api/c/', 'recruitment'],
  ['/api/payroll', 'pay'],
  ['/api/advances', 'pay'],
  ['/api/medical', 'pay'],
  ['/api/corr/', 'letters'],
  ['/api/s/', 'letters'],
  ['/api/lunch', 'lunch'],
  ['/api/l/', 'lunch'],
  ['/api/users', 'admin'],
  ['/api/notifications', 'admin'],
  ['/api/data/', 'admin'],
  ['/api/company/', 'admin'],
];

/**
 * Requests that change something on the server without changing anything on
 * anybody's screen.
 *
 * Signing in, sending a test notification, marking one's own bell read: real
 * writes, every one, and none of them a reason to make two dozen devices
 * re-ask for a rota.
 */
const QUIET = [
  '/api/auth/',
  '/api/push/',
  '/api/notices/seen',
  '/api/notifications/test',
  '/api/payroll/unlock',
  '/api/payroll/access',
  '/api/payroll/pin',
  '/api/payroll/lock',
];

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Does this request change something worth telling other screens about? */
export function worthTelling(method, pathname) {
  if (!CHANGES.has(method)) return false;
  return !QUIET.some((prefix) => pathname.startsWith(prefix));
}

/** Which topic a path belongs to. Longest prefix wins. */
export function topicFor(pathname) {
  let best = null;
  for (const [prefix, topic] of BY_PATH) {
    if (!pathname.startsWith(prefix)) continue;
    if (!best || prefix.length > best[0].length) best = [prefix, topic];
  }
  return best ? best[1] : 'other';
}

/** May somebody holding these permissions be told about this topic? */
export function mayHear(topic, permissions = []) {
  const needed = Object.prototype.hasOwnProperty.call(TOPICS, topic)
    ? TOPICS[topic]
    : TOPICS.other;
  return allows(needed, permissions);
}

/** The one hub, or null where the binding is not configured. */
export function hubFor(env) {
  if (!env?.LIVE?.idFromName) return null;
  try {
    return env.LIVE.get(env.LIVE.idFromName(HUB));
  } catch {
    return null;
  }
}

/**
 * Tell every device that something changed.
 *
 * Fire and forget, and deliberately so: a live channel that is down must never
 * be able to fail a save. The worst it can do is leave the other screens where
 * they were, which is where a timer would have left them anyway.
 */
export function announce(env, executionContext, { topic, by = null }) {
  const hub = hubFor(env);
  if (!hub) return;

  const work = hub.fetch('https://live.internal/announce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, by, at: Date.now() }),
  }).catch(() => {});

  if (executionContext?.waitUntil) executionContext.waitUntil(work);
}

/**
 * A browser asking to be told.
 *
 * The session has already been checked by the route table, so what is handed
 * on to the hub is the answer to "what may this socket hear" and nothing that
 * could widen it: the permissions the session actually holds, and the id of
 * the tab, so that tab is not told about its own saves.
 */
export function connect(ctx) {
  if (ctx.request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(JSON.stringify({
      error: 'This address is a live connection, not a page. Open it from the app.',
    }), { status: 426, headers: { 'Content-Type': 'application/json' } });
  }

  const hub = hubFor(ctx.env);
  if (!hub) {
    // The app falls back to asking on a slow timer when this happens, so a
    // deployment without the binding is degraded rather than broken.
    return new Response(JSON.stringify({ error: 'Live updates are not configured here.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const target = new URL('https://live.internal/socket');
  for (const permission of ctx.session?.permissions ?? []) {
    target.searchParams.append('p', permission);
  }
  const by = ctx.url.searchParams.get('by');
  if (by) target.searchParams.set('by', by.slice(0, 64));

  return hub.fetch(new Request(target, ctx.request));
}
