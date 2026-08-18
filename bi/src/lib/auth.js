import { HttpError } from './http.js';

/**
 * One password, one cookie.
 *
 * This application shows the group's takings, its wage bill and, on one
 * screen, a named person's till record. It is not a staff app: three or four
 * people should ever see it, and none of them needs a user account, a
 * permission matrix or a password reset flow. A single owner's password held
 * as a Worker secret is the right size of lock for the number of people who
 * hold the key.
 *
 * The cookie is an HMAC over an expiry, signed with a secret that only the
 * Worker has. Nothing about who is signed in is stored server-side, because
 * there is nothing to store.
 */

const COOKIE = 'insight_session';
const TTL_SECONDS = 12 * 60 * 60;

async function key(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function createToken(secret, ttl = TTL_SECONDS) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(String(expires)));
  return `${expires}.${hex(signature)}`;
}

export async function verifyToken(secret, token) {
  if (!token || !secret) return false;
  const [expires, signature] = String(token).split('.');
  if (!expires || !signature) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const expected = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(expires));
  return timingSafeEqual(hex(expected), signature);
}

/**
 * Compare without leaking how much of the string matched.
 *
 * A plain === on a signature exits at the first differing byte, and the time
 * that takes is measurable across enough requests. It costs nothing to not do
 * that.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function sessionCookie(token, ttl = TTL_SECONDS) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function tokenFrom(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

/**
 * Passwords are compared against a Worker secret, and a missing secret refuses
 * everybody rather than letting everybody in. That is the failure mode worth
 * choosing deliberately: an app that opens itself when misconfigured is worse
 * than one that locks its owner out until they set a password.
 */
export async function requireSession(request, env) {
  if (!env.SESSION_SECRET) {
    throw new HttpError(503, 'This dashboard has no SESSION_SECRET set, so it cannot sign anybody in.');
  }
  const ok = await verifyToken(env.SESSION_SECRET, tokenFrom(request));
  if (!ok) throw new HttpError(401, 'Sign in required');
  return true;
}

/**
 * Compare the password given against the one this Worker was configured with.
 *
 * Both sides are put through HMAC-SHA256 first and the digests are compared.
 * That is done for two reasons: the comparison is then always over a fixed
 * length, so it cannot leak how long the real password is, and a digest
 * collision cannot be constructed offline the way one can against a cheap
 * non-cryptographic fold.
 */
export async function checkPassword(env, password) {
  if (!env.DASHBOARD_PASSWORD) {
    throw new HttpError(503, 'This dashboard has no DASHBOARD_PASSWORD set. Set it with `wrangler secret put DASHBOARD_PASSWORD`.');
  }
  if (typeof password !== 'string' || !password) return false;
  const secret = env.SESSION_SECRET || env.DASHBOARD_PASSWORD;
  const signer = await key(secret);
  const digest = async (text) => hex(await crypto.subtle.sign('HMAC', signer, new TextEncoder().encode(text)));
  return timingSafeEqual(await digest(password), await digest(env.DASHBOARD_PASSWORD));
}
