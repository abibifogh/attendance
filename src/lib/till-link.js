/**
 * The till link: HIVE and this app asking each other things, server to server.
 *
 * Staff close their shift in HIVE, and what they type has to be checked here
 * (a PO against Odoo, a shift against the journal) while they wait. The other
 * way, a shortage recovered from pay has to become an advance in HIVE's
 * payroll, which only HIVE may write.
 *
 * The two Workers reach each other over a service binding, so nothing goes
 * out onto the internet. But each Worker's front door is public, so every
 * request is signed with the secret they already share for the sign-in
 * hand-off, under a label of its own so a signature made for one purpose can
 * never be replayed as the other. A request older than five minutes is
 * refused, and so is one whose body was changed on the way.
 *
 * The same file lives in Insight, as `bi/src/lib/link.js`. The two must agree.
 */

const LABEL = 'till-link';
const WINDOW_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The headers that prove a request came from the other app. */
export async function signLink(secret, path, bodyText, at = Date.now()) {
  const stamp = String(at);
  return { 'X-Till-At': stamp, 'X-Till-Sig': await hmac(secret, `${LABEL}\n${stamp}\n${path}\n${bodyText}`) };
}

/** Whether a request is from the other app: right secret, right path, recent, unaltered. */
export async function verifyLink(secret, { at, sig, path, bodyText, now = Date.now() }) {
  if (!secret || !at || !sig) return false;
  const stamp = Number(at);
  if (!Number.isFinite(stamp) || Math.abs(now - stamp) > WINDOW_MS) return false;
  return same(await hmac(secret, `${LABEL}\n${at}\n${path}\n${bodyText}`), String(sig));
}

/**
 * Ask the other app something.
 *
 * `binding` is the service binding; `fetchImpl` stands in for it in tests.
 * Throws with a sentence a person can act on when the link is not set up.
 */
export async function callLink({ binding, secret, path, body = {}, fetchImpl = null, what = 'Insight' }) {
  const send = fetchImpl || (binding ? (req) => binding.fetch(req) : null);
  if (!send || !secret) {
    const error = new Error(`HIVE and Insight are not linked yet. Run Actions → "Set Insight's secrets" with Insight's address in the box.`);
    error.status = 503;
    throw error;
  }
  const bodyText = JSON.stringify(body ?? {});
  const headers = { 'Content-Type': 'application/json', ...(await signLink(secret, path, bodyText)) };
  const response = await send(new Request(`https://link.internal${path}`, { method: 'POST', headers, body: bodyText }));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `${what} answered ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}
