import { all, run } from './db.js';

/**
 * The audit trail: every change anybody makes, kept for good.
 *
 * Every request that can change something passes through the router, so it
 * is recorded there, not in each handler: a new kind of change is recorded
 * without anybody remembering to. A row is written when the change is asked
 * for, before the handler runs; if that cannot be written the change does not
 * happen. A second row says it was done, or refused and why. The table
 * refuses UPDATE and DELETE (migration 0062), so nothing written can be
 * written over: an answer taken back, a link undone or a count typed over
 * still shows what was there, who did it and when.
 *
 * What is kept is the request as sent, with passwords, PINs, tokens and
 * secrets taken out and files and long lists cut to their size.
 */

/** Requests that change nothing: signing in and out, reading, asking questions. */
export const NOT_AUDITED = new Set([
  '/api/auth/salt', '/api/auth/login', '/api/auth/logout', '/api/sso/redeem', '/api/sso/start', '/api/invite/look',
  '/api/shifts/notes/counts', '/api/shifts/tasks/for-keys', '/api/assistant/ask',
  '/api/link/till/issues', '/api/link/till/checks', '/api/link/till/to-decide', '/api/link/till/recipients',
  '/api/np/read-test', '/api/po/read', '/api/po/check',
]);

const SECRET = /pass|pin\b|^pin|secret|token|otp|signature|cookie|^code$/i;
const FILE = /^data:|^[A-Za-z0-9+/=]{400,}$/;

/** The request as it may be kept: no secrets, no files, nothing huge. */
export function redact(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (FILE.test(value)) return `[file, ${value.length} characters]`;
    return value.length > 600 ? `${value.slice(0, 600)}… [${value.length} characters]` : value;
  }
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) {
    if (value.length > 40) return `[${value.length} items]`;
    return value.map((v) => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[hidden]' : redact(v, depth + 1);
    return out;
  }
  return String(value);
}

/** What a change is about, from the fields requests name it by. */
export function subjectOf(params = {}, body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const pick = b.key ?? (Array.isArray(b.keys) ? b.keys.join(',') : null) ?? b.seq ?? b.id ?? b.link
    ?? (b.day ? `${b.day}${b.slot ? `|${b.slot}` : ''}` : null) ?? Object.values(params || {})[0] ?? null;
  return pick == null ? null : String(pick).slice(0, 300);
}

const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const viaOf = (account, permission) => (account?.bootstrap ? 'bootstrap' : account ? 'session' : permission || 'public');

/** The change is asked for: written first, so a change that cannot be recorded never happens. */
export async function asked(db, { method, path, params, body, account, permission }) {
  const id = crypto.randomUUID();
  await run(db, `INSERT INTO audit_event (request_id, at, stage, method, path, account_id, actor, via, subject, detail)
    VALUES (?1, ?2, 'asked', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  id, now(), method, path, account?.id ?? null, account?.name || account?.email || (account?.bootstrap ? 'Owner (shared password)' : null),
  viaOf(account, permission), subjectOf(params, body), JSON.stringify(redact({ params, body })).slice(0, 20000));
  return id;
}

/** How it ended: done, or refused and why. Never stops the answer going back. */
export async function ended(db, id, { ok, message = null, status = null, path, method }) {
  if (!id) return;
  await run(db, `INSERT INTO audit_event (request_id, at, stage, method, path, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    id, now(), ok ? 'done' : 'refused', method, path, ok ? null : JSON.stringify({ status, message: String(message || '').slice(0, 500) }))
    .catch((err) => console.error('Audit trail', err));
}

/** An admin's: the trail, newest first, for a subject or for everything. */
export async function trail(db, { subject = null, limit = 200 } = {}) {
  const n = Math.min(1000, Math.max(1, Number(limit) || 200));
  return subject
    ? all(db, 'SELECT * FROM audit_event WHERE request_id IN (SELECT request_id FROM audit_event WHERE subject = ?1) ORDER BY id DESC LIMIT ?2', subject, n)
    : all(db, 'SELECT * FROM audit_event ORDER BY id DESC LIMIT ?1', n);
}
