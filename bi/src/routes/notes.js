import { all, first, run } from '../lib/db.js';
import { badRequest, forbidden, str } from '../lib/http.js';
import { callLink } from '../lib/link.js';
import { roleOf } from './till.js';

/**
 * Notes and history on a difference ("What does not agree on this shift").
 *
 * Admins and supervisors write notes and tag whoever should read them; the
 * people tagged are emailed. Whoever answered the difference is not told: a
 * note is between the people checking. Beside the notes, what happened to it
 * (answered, changed, taken back, approved or rejected, proof asked and sent,
 * put on a staff account and taken off, moved to another shift), each with
 * who and when, from the day this was added: before it, an answer that was
 * changed kept no trace of what it was.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const KEY = /^[\w.:|#-]{1,200}$/;

function mayNote(account) {
  if (!['admin', 'supervisor'].includes(roleOf(account))) throw forbidden('Notes are for admins and supervisors.');
}

/** Write what happened to a difference. Never throws: it must not stop what it records. */
export async function logEvent(env, key, what, by = null) {
  if (!key || !KEY.test(String(key))) return;
  await run(env.DB, "INSERT INTO shift_history (key, type, text, by_name, at) VALUES (?1, 'event', ?2, ?3, ?4)",
    String(key), String(what).slice(0, 400), by, now()).catch(() => {});
}

/** Who can be tagged: admins and supervisors, by account. */
export async function people(env, account) {
  mayNote(account);
  const rows = await all(env.DB, `SELECT DISTINCT a.id, a.name, a.email FROM accounts a
      LEFT JOIN account_access g ON g.account_id = a.id AND g.system_id = 'insight'
     WHERE a.active = 1 AND (a.is_owner = 1 OR g.role IN ('admin', 'supervisor'))
     ORDER BY a.name, a.email`).catch(() => []);
  return { people: rows.map((r) => ({ id: Number(r.id), name: r.name || r.email, ...(Number(r.id) === Number(account?.id) ? { me: true } : {}) })) };
}

/** A difference's notes and what happened to it, oldest first. */
export async function history(env, query, account) {
  mayNote(account);
  const key = String(query?.key || '');
  if (!KEY.test(key)) throw badRequest('Which difference?');
  const rows = await all(env.DB, 'SELECT * FROM shift_history WHERE key = ?1 ORDER BY id', key).catch(() => []);
  const parse = (t) => { try { return JSON.parse(t || '[]'); } catch { return []; } };
  const items = rows.map((r) => ({
    type: r.type, id: r.id, text: r.text, by: r.by_name, at: r.at, ...(r.type === 'note' ? { tags: parse(r.tags) } : {}),
  }));
  return { key, items };
}

/** How many notes and events each of these differences has. */
export async function counts(env, body, account) {
  mayNote(account);
  const keys = [...new Set((Array.isArray(body?.keys) ? body.keys : []).map(String).filter((k) => KEY.test(k)))].slice(0, 300);
  const out = {};
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(', ');
    // eslint-disable-next-line no-await-in-loop
    const rows = await all(env.DB, `SELECT key, COUNT(*) AS n FROM shift_history WHERE key IN (${marks}) GROUP BY key`, ...chunk).catch(() => []);
    for (const r of rows) out[r.key] = Number(r.n) || 0;
  }
  return { counts: out };
}

/** A note, tagging whoever should read it; they are emailed. */
export async function addNote(env, body, account, { fetchImpl, origin = '' } = {}) {
  mayNote(account);
  const key = String(body?.key || '');
  if (!KEY.test(key)) throw badRequest('Which difference?');
  const text = str(body?.text, 'Note', { required: true, max: 1000 });
  const about = str(body?.about, 'About', { max: 200 }) || 'a difference on a shift';
  const known = (await people(env, account)).people;
  const tags = [...new Set((Array.isArray(body?.tags) ? body.tags : []).map(Number))]
    .map((id) => known.find((p) => p.id === id)).filter(Boolean).slice(0, 10);
  const row = await first(env.DB, "INSERT INTO shift_history (key, type, text, tags, by_id, by_name, at) VALUES (?1, 'note', ?2, ?3, ?4, ?5, ?6) RETURNING id",
    key, text, JSON.stringify(tags), account?.id ?? null, who(account), now());
  let told = 0;
  for (const t of tags.filter((x) => x.id !== Number(account?.id))) {
    // eslint-disable-next-line no-await-in-loop
    const to = await first(env.DB, 'SELECT email FROM accounts WHERE id = ?1', t.id).catch(() => null);
    if (!to?.email) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await callLink({
        binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
        body: {
          to: to.email, subject: `${who(account)} tagged you on ${about}`, kind: 'insight_note', senderName: 'Insight',
          text: `${who(account)} wrote, about ${about}:\n\n${text}\n\nOpen it in Insight › Shifts${origin ? `: ${origin}` : ''}.`,
          html: `<p>${esc(who(account))} wrote, about ${esc(about)}:</p><blockquote>${esc(text)}</blockquote><p>Open it in Insight › Shifts.</p>`,
        },
      });
      told += 1;
    } catch { /* the note is kept; the email is a courtesy */ }
  }
  return { ok: true, id: row.id, told };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
