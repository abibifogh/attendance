import { all, first, run } from '../lib/db.js';
import { badRequest, forbidden, HttpError, str } from '../lib/http.js';
import { callLink } from '../lib/link.js';
import { requireArea, accessOf, tell } from './till.js';
import { logEvent } from './notes.js';

/**
 * Proof for an answer.
 *
 * An answer waiting for an admin ("Explained: the payment was declined") can
 * be followed up: whoever may ask (admins, and anybody an admin gives "Ask for
 * proof") asks the person who gave it for a MoMo screenshot, a terminal slip,
 * a statement. A supervisor's answer is asked of them in Insight (their Inbox,
 * and by email); a staff member's answer from HIVE is asked of them in HIVE
 * (My till › To sort out, and a HIVE notice). They send pictures or PDFs back,
 * or say why they cannot, and the proof shows on the answer for the admin to
 * decide. Until then they are reminded once a day, three times at most.
 */

export const KINDS = {
  momo: 'MoMo screenshot or statement',
  slip: 'Terminal slip',
  bank: 'Bank statement',
  receipt: 'Receipt or invoice',
  other: 'Something else',
};
/** A file as sent, base64: a database row holds at most about 2 MB. */
const FILE_MAX = 1_900_000;
const FILES_MAX = 6;
/** How long before a reminder (the next morning's run, then each morning after), and how many. */
export const REMIND_HOURS = 20;
export const REMIND_MAX = 3;

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const TARGET = /^(answer|link|issue):(.{1,200})$/;
/** The difference a proof request is about, for its history. */
const keyOf = (target) => String(target || '').replace(/^(answer|issue):/, '');

/** Who gave the answer a target names, and the answer in words. */
async function answererOf(env, target) {
  const [, type, id] = TARGET.exec(target) || [];
  if (type === 'answer' || type === 'link') {
    const row = type === 'answer'
      ? await first(env.DB, "SELECT answer, note, by_name FROM shift_answer WHERE key = ?1 AND status = 'pending'", id)
      : await first(env.DB, "SELECT note, by_name FROM shift_link WHERE id = ?1 AND status = 'pending'", Number(id));
    if (!row) throw new HttpError(404, 'That answer is not waiting for an admin any more.');
    const account = row.by_name ? await first(env.DB, 'SELECT id, name, email FROM accounts WHERE name = ?1 AND active = 1 ORDER BY id LIMIT 1', row.by_name) : null;
    if (!account) throw badRequest(`Insight cannot tell which account “${row.by_name || 'somebody'}” is, to ask them.`);
    const about = type === 'answer' ? `${row.answer}${row.note ? `: ${row.note}` : ''}` : `Reconciled together${row.note ? `: ${row.note}` : ''}`;
    return { account: Number(account.id), hive: null, name: account.name, email: account.email || null, about };
  }
  if (type === 'issue') {
    if (!env.ATT_DB) throw new HttpError(503, 'HIVE cannot be reached from here.');
    const row = await first(env.ATT_DB, `SELECT a.user_id, a.how, a.text, a.po, u.name FROM till_answer a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.key = ?1 ORDER BY a.id DESC LIMIT 1`, id).catch(() => null);
    if (!row) throw new HttpError(404, 'Nobody has answered that one in HIVE.');
    const about = row.how === 'po' ? `PO ${row.po}` : row.how === 'repay' ? `Will pay it back${row.text ? `: ${row.text}` : ''}` : row.text || 'Explained';
    return { account: null, hive: Number(row.user_id), name: row.name || 'Somebody', email: null, about };
  }
  throw badRequest('Which answer?');
}

const parseKinds = (text) => { try { return JSON.parse(text || '[]'); } catch { return []; } };
const kindWords = (kinds) => kinds.map((k) => KINDS[k] || k).join(', ');

function view(r, files = []) {
  return {
    id: r.id, target: r.target, about: r.about, askedOf: r.asked_name, toHive: r.asked_hive != null, kinds: parseKinds(r.kinds), note: r.note,
    askedBy: r.asked_by, askedAt: r.asked_at, status: r.status, reply: r.reply, repliedAt: r.replied_at,
    reminders: r.reminders, remindedAt: r.reminded_at, files: files.map((f) => ({ id: f.id, name: f.name, type: f.type })),
  };
}

/** Say it to the person asked: an email for an Insight account, a HIVE notice for a HIVE user. */
async function notify(env, r, { reminder = false, fetchImpl } = {}) {
  const what = `${kindWords(parseKinds(r.kinds))}${r.note ? `: “${r.note}”` : ''}`;
  const title = reminder ? `Reminder: proof is still asked for your answer` : `${r.asked_by} asks for proof of your answer`;
  const text = `About “${r.about || 'your answer'}”. Please send ${what}.`;
  if (r.asked_hive != null) return tell(env, [Number(r.asked_hive)], title, `${text} Send it from My till › To sort out.`, fetchImpl, 'till.proof');
  const account = await first(env.DB, 'SELECT email FROM accounts WHERE id = ?1', r.asked_account);
  if (!account?.email) return false;
  try {
    await callLink({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
      body: {
        to: account.email, subject: title, kind: 'insight_proof', senderName: 'Insight',
        text: `${text}\n\nOpen Insight › To sort out › Proof asked, and send pictures or a PDF from there.`,
        html: `<p>${esc(text)}</p><p>Open Insight › To sort out › <b>Proof asked</b>, and send pictures or a PDF from there.</p>`,
      },
    });
    return true;
  } catch { return false; }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------- asking --

/** Ask whoever gave an answer for proof. */
export async function ask(env, body, account, { fetchImpl } = {}) {
  await requireArea(env, account, 'proof', 2);
  const target = String(body?.target || '');
  if (!TARGET.test(target)) throw badRequest('Which answer?');
  const kinds = [...new Set((Array.isArray(body?.kinds) ? body.kinds : []).map(String))].filter((k) => KINDS[k]);
  if (!kinds.length) throw badRequest('Say what to send: tap one or more.');
  const note = str(body?.note, 'What exactly', { max: 300 });
  const open = await first(env.DB, "SELECT id FROM proof_request WHERE target = ?1 AND status = 'asked'", target);
  if (open) throw new HttpError(409, 'Proof is already asked for this answer. Remind them, or cancel it first.');
  const p = await answererOf(env, target);
  const at = now();
  const row = await first(env.DB, `INSERT INTO proof_request (target, about, asked_account, asked_hive, asked_name, kinds, note, asked_by, asked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING *`,
  target, p.about, p.account, p.hive, p.name, JSON.stringify(kinds), note, who(account), at);
  const told = await notify(env, row, { fetchImpl });
  await logEvent(env, keyOf(target), `Proof asked from ${p.name || 'whoever answered'}${note ? `: “${note}”` : ''}`, who(account));
  return { ok: true, request: view(row), told };
}

async function requestFor(env, id) {
  const r = await first(env.DB, 'SELECT * FROM proof_request WHERE id = ?1', Number(id));
  if (!r) throw new HttpError(404, 'No such request.');
  return r;
}

/** Remind them now, or take the request back. */
export async function remind(env, body, account, { fetchImpl } = {}) {
  await requireArea(env, account, 'proof', 2);
  const r = await requestFor(env, body?.id);
  if (r.status !== 'asked') throw badRequest('That request has been answered already.');
  const told = await notify(env, r, { reminder: true, fetchImpl });
  await run(env.DB, 'UPDATE proof_request SET reminders = reminders + 1, reminded_at = ?2 WHERE id = ?1', r.id, now());
  return { ok: true, told };
}
export async function cancel(env, body, account) {
  await requireArea(env, account, 'proof', 2);
  const r = await requestFor(env, body?.id);
  if (r.status !== 'asked') throw badRequest('That request has been answered already.');
  await run(env.DB, "UPDATE proof_request SET status = 'cancelled', replied_at = ?2 WHERE id = ?1", r.id, now());
  await logEvent(env, keyOf(r.target), 'Proof request cancelled', who(account));
  return { ok: true };
}

// ------------------------------------------------------------- reading --

async function withFiles(env, rows) {
  if (!rows.length) return [];
  const files = await all(env.DB, `SELECT id, request_id, name, type FROM proof_file WHERE request_id IN (${rows.map((_, i) => `?${i + 1}`).join(', ')}) ORDER BY id`,
    ...rows.map((r) => r.id));
  return rows.map((r) => view(r, files.filter((f) => f.request_id === r.id)));
}

/**
 * The requests on some answers, newest first per answer: for whoever may see
 * them (admins and anybody given "Ask for proof"), and for the person asked.
 */
export async function forTargets(env, query, account) {
  const targets = String(query?.targets || '').split(',').map((t) => t.trim()).filter((t) => TARGET.test(t)).slice(0, 60);
  if (!targets.length) return { requests: [], canAsk: false };
  const access = await accessOf(env, account);
  const rows = await all(env.DB, `SELECT * FROM proof_request WHERE target IN (${targets.map((_, i) => `?${i + 1}`).join(', ')}) AND status != 'cancelled' ORDER BY id DESC`, ...targets);
  const mine = (r) => r.asked_account != null && Number(r.asked_account) === Number(account?.id);
  const seen = (access.proof || 0) >= 1 ? rows : rows.filter(mine);
  // `mine`: asked of whoever is looking, so their card offers to send it right there.
  const requests = (await withFiles(env, seen)).map((r, i) => ({ ...r, mine: mine(seen[i]) }));
  return { requests, canAsk: (access.proof || 0) >= 2 };
}

/**
 * Requests on answers an admin has decided since (approved, rejected,
 * settled): closed, so nobody is asked or reminded for nothing.
 */
async function closeDecided(env) {
  await run(env.DB, `UPDATE proof_request SET status = 'cancelled', reply = 'Decided without it', replied_at = ?1
    WHERE status = 'asked' AND (
      (target LIKE 'answer:%' AND NOT EXISTS (SELECT 1 FROM shift_answer a WHERE 'answer:' || a.key = proof_request.target AND a.status = 'pending'))
      OR (target LIKE 'link:%' AND NOT EXISTS (SELECT 1 FROM shift_link l WHERE 'link:' || l.id = proof_request.target AND l.status = 'pending'))
      OR (target LIKE 'issue:%' AND EXISTS (SELECT 1 FROM till_resolution r WHERE 'issue:' || r.key = proof_request.target AND r.at >= proof_request.asked_at)))`,
  now()).catch((err) => console.error('Proof: closing decided', err));
}

/** What is asked of this account and not yet answered: their Inbox. */
export async function mine(env, account) {
  if (account?.id == null) return { requests: [] };
  await closeDecided(env);
  const rows = await all(env.DB, "SELECT * FROM proof_request WHERE asked_account = ?1 AND status = 'asked' ORDER BY id", Number(account.id)).catch(() => []);
  return { requests: rows.map((r) => view(r)) };
}

/** One file, for whoever may see the request. */
export async function file(env, id, account) {
  const f = await first(env.DB, 'SELECT f.*, r.asked_account FROM proof_file f JOIN proof_request r ON r.id = f.request_id WHERE f.id = ?1', Number(id));
  if (!f) throw new HttpError(404, 'No such file.');
  const access = await accessOf(env, account);
  if ((access.proof || 0) < 1 && Number(f.asked_account) !== Number(account?.id)) throw forbidden('That proof is not yours to see.');
  const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': f.type, 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': `inline; filename="${String(f.name || 'proof').replace(/[^\w.\- ]/g, '_')}"` } });
}

// ------------------------------------------------------------ answering --

/** Pictures or PDFs sent back (with a note), or why they cannot be. */
async function reply(env, r, body) {
  if (r.status !== 'asked') throw new HttpError(409, 'That request is closed: it was answered or cancelled.');
  const cannot = Boolean(body?.cannot);
  const note = str(body?.note, cannot ? 'Why not' : 'Note', { required: cannot, max: 600 });
  const files = Array.isArray(body?.files) ? body.files : [];
  if (!cannot && !files.length) throw badRequest('Add a picture or a PDF, or say why you cannot.');
  if (files.length > FILES_MAX) throw badRequest(`${FILES_MAX} files at most.`);
  const parsed = files.map((f) => {
    const m = String(f?.data || '').match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw badRequest('Only pictures and PDFs can be sent.');
    if (m[2].length > FILE_MAX) throw badRequest(`${String(f?.name || 'A file')} is too large: a PDF up to about 1.4 MB, or take a photo of it instead.`);
    return { name: str(f?.name, 'Name', { max: 120 }) || 'proof', type: m[1], data: m[2] };
  });
  const at = now();
  for (const f of parsed) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'INSERT INTO proof_file (request_id, name, type, data, at) VALUES (?1, ?2, ?3, ?4, ?5)', r.id, f.name, f.type, f.data, at);
  }
  await run(env.DB, 'UPDATE proof_request SET status = ?2, reply = ?3, replied_at = ?4 WHERE id = ?1', r.id, cannot ? 'cannot' : 'sent', note, at);
  await logEvent(env, keyOf(r.target), cannot ? `Proof cannot be sent${note ? `: “${note}”` : ''}` : `Proof sent: ${parsed.length} file${parsed.length === 1 ? '' : 's'}${note ? `, “${note}”` : ''}`, r.asked_name || null);
  return { ok: true, status: cannot ? 'cannot' : 'sent', files: parsed.length };
}

/** A supervisor answering in Insight. */
export async function send(env, body, account) {
  const r = await requestFor(env, body?.id);
  if (r.asked_account == null || Number(r.asked_account) !== Number(account?.id)) throw forbidden('That request is not yours to answer.');
  return reply(env, r, body);
}

/** A staff member answering from HIVE, over the signed link. */
export async function linkSend(env, body) {
  const r = await requestFor(env, body?.id);
  if (r.asked_hive == null || Number(r.asked_hive) !== Number(body?.userId)) throw forbidden('That request is not yours to answer.');
  return reply(env, r, body);
}

/** What HIVE shows on a staff member's To sort out: the requests asked of them, by the key of what they answered. */
export async function openForHive(env, userId) {
  await closeDecided(env);
  const rows = await all(env.DB, "SELECT * FROM proof_request WHERE asked_hive = ?1 AND status = 'asked' ORDER BY id", Number(userId)).catch(() => []);
  return new Map(rows.map((r) => [r.target.replace(/^issue:/, ''), { id: r.id, kinds: parseKinds(r.kinds).map((k) => KINDS[k] || k), note: r.note, by: r.asked_by, at: r.asked_at }]));
}

// ------------------------------------------------------------ reminders --

/** Once a day, a reminder for what is still asked: three at most. Never throws. */
export async function remindDue(env, { fetchImpl, at = new Date() } = {}) {
  let sent = 0;
  try {
    await closeDecided(env);
    const before = new Date(at.getTime() - REMIND_HOURS * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await all(env.DB, `SELECT * FROM proof_request WHERE status = 'asked' AND reminders < ?1 AND COALESCE(reminded_at, asked_at) <= ?2`, REMIND_MAX, before);
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await notify(env, r, { reminder: true, fetchImpl }).catch(() => false);
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'UPDATE proof_request SET reminders = reminders + 1, reminded_at = ?2 WHERE id = ?1', r.id, now());
      sent += 1;
    }
  } catch (err) { console.error('Proof reminders', err); }
  return { sent };
}

