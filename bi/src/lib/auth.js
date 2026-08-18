import { HttpError, isMissingTable } from './http.js';
import { first, run } from './db.js';

/**
 * Who is signed in, and what they may reach.
 *
 * This started as one password for one person, which is the right size of lock
 * for a reporting tool nobody else opens. It is the wrong one the moment the
 * tool becomes the front door to the group's other software, because then the
 * question is no longer "may you see the numbers" but "which of five systems
 * may we let you into, under whose name".
 *
 * So there are accounts now. The single owner password survives as a bootstrap
 * route — a fresh installation with no accounts in it has to be openable by
 * somebody — and it is the only way in until the first real account exists.
 */

const COOKIE = 'insight_session';
const TTL_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

// -------------------------------------------------------------- encoding --

function b64urlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
    + '==='.slice((String(text).length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(secret, message) {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
  return b64urlEncode(new Uint8Array(signature));
}

/**
 * Compare without leaking how much of the string matched.
 *
 * A plain `===` exits at the first differing byte and the time that takes is
 * measurable across enough requests. It costs nothing to not do that.
 */
export function timingSafeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

// -------------------------------------------------------------- sessions --

/**
 * A session names an account, and says whether it arrived by the bootstrap
 * password rather than by an account's own credentials.
 *
 * The bootstrap route deliberately cannot reach another system: it exists to
 * create the first real account, and handing somebody the keys to the till
 * because they know a shared password typed into a config file once is exactly
 * the thing this table of accounts was added to stop.
 */
export async function createToken(secret, { accountId = null, bootstrap = false, ttl = TTL_SECONDS } = {}) {
  const payload = {
    sub: accountId,
    boot: bootstrap ? 1 : 0,
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await sign(secret, body)}`;
}

export async function readToken(secret, token) {
  if (!secret || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  if (!timingSafeEqual(await sign(secret, body), signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
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
 * Who is making this request, read fresh from the database every time.
 *
 * Re-reading means that switching somebody off, or taking a system away from
 * them, takes effect on their very next click rather than whenever their cookie
 * happens to expire. For a front door that is the whole point: revoking access
 * has to be immediate or it is not revoking.
 */
export async function currentAccount(request, env) {
  if (!env.SESSION_SECRET) {
    throw new HttpError(503, 'This dashboard has no SESSION_SECRET set, so it cannot sign anybody in.');
  }
  const payload = await readToken(env.SESSION_SECRET, tokenFrom(request));
  if (!payload) return null;

  if (payload.boot) {
    return { id: null, email: null, name: 'Owner', isOwner: true, bootstrap: true, access: [] };
  }
  if (!payload.sub) return null;

  let row = null;
  try {
    row = await first(env.DB, 'SELECT id, email, name, is_owner, active FROM accounts WHERE id = ?1', payload.sub);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return null;
  }
  if (!row || !row.active) return null;

  const access = await accessFor(env.DB, row.id);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isOwner: row.is_owner === 1,
    bootstrap: false,
    access,
  };
}

export async function accessFor(db, accountId) {
  try {
    const rows = await db.prepare(
      'SELECT system_id, role FROM account_access WHERE account_id = ?1').bind(accountId).all();
    return (rows?.results ?? []).map((r) => ({ systemId: r.system_id, role: r.role || '' }));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return [];
  }
}

/** Signed in at all. Every screen needs at least this. */
export async function requireSession(request, env) {
  const account = await currentAccount(request, env);
  if (!account) throw new HttpError(401, 'Sign in required');
  return account;
}

/** Signed in, and allowed to look at the numbers. */
export async function requireInsight(request, env) {
  const account = await requireSession(request, env);
  if (account.isOwner || account.bootstrap) return account;
  if (!account.access.some((a) => a.systemId === 'insight')) {
    throw new HttpError(403, 'Your account can reach the other systems from the hub, but has not been given the reports.');
  }
  return account;
}

/** Signed in, and allowed to manage accounts and grants. */
export async function requireOwner(request, env) {
  const account = await requireSession(request, env);
  if (!account.isOwner && !account.bootstrap) throw new HttpError(403, 'Only an owner can do that.');
  return account;
}

// -------------------------------------------------------------- passwords --

/**
 * Passwords are stretched in the browser and reach the server only as a derived
 * key; the server keeps a peppered hash of that key.
 *
 * The same scheme the attendance app uses, deliberately, for the same two
 * reasons. A Worker cannot afford six hundred thousand PBKDF2 rounds inside its
 * CPU budget, so stretching on the server means either a broken sign-in or a
 * work factor not worth having. And a stolen copy of this database still has to
 * be attacked one full derivation at a time, because guessing still means
 * running the rounds.
 *
 * Stored as: pbkdf2c$1$<iterations>$<salt>$<peppered hmac>
 */
const PASSWORD_VERSION = '1';
export const DEFAULT_ITERATIONS = 600_000;

async function pepperHmac(value, pepper) {
  return sign(`password:${pepper}`, String(value));
}

export async function getPepper(db) {
  const row = await first(db, "SELECT value FROM settings WHERE key = 'pin_pepper'");
  if (row?.value) return row.value;
  // A fresh database that has not been seeded yet. Make one and keep it, rather
  // than deriving from a constant — a shared pepper across installations is no
  // pepper at all.
  const made = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  await run(db, "INSERT INTO settings (key, value) VALUES ('pin_pepper', ?1) ON CONFLICT (key) DO NOTHING", made);
  const again = await first(db, "SELECT value FROM settings WHERE key = 'pin_pepper'");
  return again?.value ?? made;
}

export async function storedPassword({ passwordKey, salt, iterations }, pepper) {
  const hmac = await pepperHmac(passwordKey, pepper);
  return `pbkdf2c$${PASSWORD_VERSION}$${Number(iterations) || DEFAULT_ITERATIONS}$${salt}$${hmac}`;
}

export function passwordParams(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('pbkdf2c$')) return null;
  const [, , iterations, salt] = stored.split('$');
  if (!iterations || !salt) return null;
  return { iterations: Number(iterations), salt };
}

export async function verifyPasswordKey(passwordKey, stored, pepper) {
  const params = passwordParams(stored);
  if (!params || !passwordKey) return false;
  const expected = String(stored).split('$')[4];
  const actual = await pepperHmac(passwordKey, pepper);
  return Boolean(expected) && timingSafeEqual(expected, actual);
}

export const normaliseEmail = (value) => String(value ?? '').trim().toLowerCase();

/**
 * The salt to derive with, for a given address.
 *
 * An address with no account still gets a salt — a stable one derived from the
 * address itself — so that asking for a salt never reveals who has an account
 * here. Without that, this endpoint is a free list of the group's staff.
 */
export async function saltForEmail(db, email) {
  const normalised = normaliseEmail(email);
  const pepper = await getPepper(db);

  let row = null;
  try {
    row = await first(db, 'SELECT password_hash FROM accounts WHERE email = ?1 AND active = 1', normalised);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  const params = row ? passwordParams(row.password_hash) : null;
  if (params) return params;

  return {
    salt: (await sign(`salt:${pepper}`, normalised)).slice(0, 22),
    iterations: DEFAULT_ITERATIONS,
  };
}

/** A dummy of the right shape, so a missing account costs the same time as a wrong password. */
const DECOY = `pbkdf2c$1$1$AAAAAAAAAAAAAAAAAAAAAA$${'A'.repeat(43)}`;

export async function accountForCredentials(db, email, passwordKey) {
  if (!email || !passwordKey) return null;
  let row = null;
  try {
    row = await first(db,
      'SELECT id, email, name, is_owner, active, password_hash FROM accounts WHERE email = ?1',
      normaliseEmail(email));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return null;
  }

  const pepper = await getPepper(db);
  // Compare even when nothing matched, so a wrong address and a wrong password
  // take the same path and the same time.
  const valid = await verifyPasswordKey(passwordKey, row?.password_hash ?? DECOY, pepper);
  if (!row || !valid || !row.active) return null;

  await run(db, "UPDATE accounts SET last_login_at = datetime('now') WHERE id = ?1", row.id);
  return { id: row.id, email: row.email, name: row.name, isOwner: row.is_owner === 1 };
}

/**
 * The bootstrap password.
 *
 * Both sides are put through HMAC-SHA256 first, so the comparison is always
 * over a fixed length and cannot leak how long the real password is. A Worker
 * with no password configured refuses everybody rather than letting everybody
 * in — an app that opens itself when misconfigured is worse than one that locks
 * its owner out until they set one.
 */
export async function checkBootstrapPassword(env, password) {
  if (!env.DASHBOARD_PASSWORD) {
    throw new HttpError(503, 'This dashboard has no DASHBOARD_PASSWORD set. Set it with `wrangler secret put DASHBOARD_PASSWORD`.');
  }
  if (typeof password !== 'string' || !password) return false;
  const secret = env.SESSION_SECRET || env.DASHBOARD_PASSWORD;
  const [given, real] = await Promise.all([sign(secret, password), sign(secret, env.DASHBOARD_PASSWORD)]);
  return timingSafeEqual(given, real);
}

export { b64urlEncode, b64urlDecode, sign };
