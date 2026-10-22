import { all, first, run } from '../lib/db.js';
import { badRequest, forbidden, notFound, str } from '../lib/http.js';
import { callLink } from '../lib/link.js';
import { logEvent, people } from './notes.js';
import { roleOf } from './till.js';

/**
 * To-dos made from a difference ("What does not agree on this shift").
 *
 * An admin or a supervisor makes one for an Insight user (an admin or a
 * supervisor, themselves included), with a day it is due. Whoever it is for
 * is emailed when it is made, and each morning after, with the daily summary,
 * until it is done. It is its own thing: answering the difference does not
 * close it, and Done on it does not answer the difference.
 *
 * An admin sees every to-do; a supervisor, those for them and those they
 * made. Done by whoever it is for, whoever made it, or an admin; changed or
 * removed by whoever made it, or an admin. Each step goes in the difference's
 * history.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const KEY = /^[\w.:|#-]{1,200}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLOTS = ['morning', 'afternoon', 'night'];

function mayMake(account) {
  if (!['admin', 'supervisor'].includes(roleOf(account))) throw forbidden('To-dos are for admins and supervisors.');
}
const isAdmin = (account) => roleOf(account) === 'admin';
const mine = (t, account) => Number(t.for_id) === Number(account?.id);
const made = (t, account) => t.made_by_id != null && Number(t.made_by_id) === Number(account?.id);

function view(t, account) {
  return {
    id: t.id, key: t.key, about: t.about, day: t.day, slot: t.slot, what: t.what,
    forId: t.for_id, forName: t.for_name, due: t.due, state: t.state,
    madeBy: t.made_by, madeAt: t.made_at, doneBy: t.done_by, doneAt: t.done_at,
    reminders: t.reminders, remindedAt: t.reminded_at,
    mine: mine(t, account), canDone: t.state === 'open' && (mine(t, account) || made(t, account) || isAdmin(account)),
    canChange: t.state === 'open' && (made(t, account) || isAdmin(account)),
  };
}

async function taskFor(env, id) {
  const t = await first(env.DB, 'SELECT * FROM shift_task WHERE id = ?1', Number(id));
  if (!t || t.state === 'removed') throw notFound('That to-do is not there any more.');
  return t;
}

/** Whoever it is for, from the Insight users who may be given one. */
async function forWhom(env, account, id) {
  const p = (await people(env, account)).people.find((x) => x.id === Number(id));
  if (!p) throw badRequest('Who is it for?');
  return p;
}

const fmt = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Email whoever it is for. Never throws: the to-do is kept either way. */
async function tell(env, t, { reminder = false, fetchImpl, today = now().slice(0, 10) } = {}) {
  const to = await first(env.DB, 'SELECT email FROM accounts WHERE id = ?1 AND active = 1', t.for_id).catch(() => null);
  if (!to?.email) return false;
  const late = t.due < today;
  const when = late ? `was due ${fmt(t.due)}` : t.due === today ? 'is due today' : `is due ${fmt(t.due)}`;
  const subject = reminder ? `To-do ${late ? 'overdue' : t.due === today ? 'due today' : `due ${fmt(t.due)}`}: ${t.what.slice(0, 80)}` : `${t.made_by} gave you a to-do`;
  const from = t.about ? ` (from ${t.about})` : '';
  try {
    await callLink({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
      body: {
        to: to.email, subject, kind: 'insight_todo', senderName: 'Insight',
        text: `${t.what}${from}.\n\nIt ${when}. Made by ${t.made_by}.\n\nOpen Insight › Shifts › Inbox › To-do, and press Done when it is done. You are reminded each morning until then.`,
        html: `<p><b>${esc(t.what)}</b>${esc(from)}.</p><p>It ${esc(when)}. Made by ${esc(t.made_by)}.</p><p>Open Insight › Shifts › Inbox › <b>To-do</b>, and press Done when it is done. You are reminded each morning until then.</p>`,
      },
    });
    return true;
  } catch { return false; }
}

/** Make a to-do from a difference. */
export async function make(env, body, account, { fetchImpl } = {}) {
  mayMake(account);
  const key = String(body?.key || '');
  if (!KEY.test(key)) throw badRequest('Which difference?');
  const what = str(body?.what, 'What to do', { required: true, max: 300 });
  const due = String(body?.due || '');
  if (!DAY.test(due)) throw badRequest('Say when it is due.');
  const p = await forWhom(env, account, body?.forId);
  const about = str(body?.about, 'About', { max: 200 }) || null;
  const day = DAY.test(String(body?.day || '')) ? body.day : null;
  const slot = SLOTS.includes(body?.slot) ? body.slot : null;
  const at = now();
  const t = await first(env.DB, `INSERT INTO shift_task (key, about, day, slot, what, for_id, for_name, due, made_by_id, made_by, made_at, reminded_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11) RETURNING *`,
  key, about, day, slot, what, p.id, p.name, due, account?.id ?? null, who(account), at);
  const told = mine(t, account) ? false : await tell(env, t, { fetchImpl });
  await logEvent(env, key, `To-do for ${p.name}, due ${fmt(due)}: “${what}”`, who(account));
  return { ok: true, task: view(t, account), told };
}

/** The to-dos this account may see: open ones, or done ones too. */
export async function list(env, query, account) {
  mayMake(account);
  const done = query?.done === '1';
  const rows = await all(env.DB, `SELECT * FROM shift_task WHERE state = 'open'${done ? " OR (state = 'done' AND done_at >= ?1)" : ''} ORDER BY due, id`,
    ...(done ? [new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)] : [])).catch(() => []);
  const seen = isAdmin(account) ? rows : rows.filter((t) => mine(t, account) || made(t, account));
  return { tasks: seen.map((t) => view(t, account)) };
}

/** The open to-dos on some differences, for their cards. */
export async function forKeys(env, body, account) {
  mayMake(account);
  const keys = [...new Set((Array.isArray(body?.keys) ? body.keys : []).map(String).filter((k) => KEY.test(k)))].slice(0, 300);
  const out = {};
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const rows = await all(env.DB, `SELECT * FROM shift_task WHERE state = 'open' AND key IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')}) ORDER BY due, id`, ...chunk).catch(() => []);
    for (const t of rows) (out[t.key] ||= []).push(view(t, account));
  }
  return { tasks: out };
}

export async function done(env, id, account) {
  mayMake(account);
  const t = await taskFor(env, id);
  if (!view(t, account).canDone) throw forbidden(t.state === 'done' ? 'That to-do is done already.' : 'Only whoever it is for, whoever made it, or an admin can mark it done.');
  await run(env.DB, "UPDATE shift_task SET state = 'done', done_by = ?2, done_at = ?3 WHERE id = ?1", t.id, who(account), now());
  await logEvent(env, t.key, `To-do done: “${t.what}”`, who(account));
  return { ok: true };
}

/** Change what it says, whom it is for, or when it is due; or remove it. */
export async function change(env, id, body, account, { fetchImpl } = {}) {
  mayMake(account);
  const t = await taskFor(env, id);
  if (!view(t, account).canChange) throw forbidden('Only whoever made it, or an admin, can change it.');
  if (body?.remove) {
    await run(env.DB, "UPDATE shift_task SET state = 'removed', done_by = ?2, done_at = ?3 WHERE id = ?1", t.id, who(account), now());
    await logEvent(env, t.key, `To-do removed: “${t.what}”`, who(account));
    return { ok: true, removed: true };
  }
  const what = body?.what != null ? str(body.what, 'What to do', { required: true, max: 300 }) : t.what;
  const due = body?.due != null ? String(body.due) : t.due;
  if (!DAY.test(due)) throw badRequest('Say when it is due.');
  const p = body?.forId != null ? await forWhom(env, account, body.forId) : { id: t.for_id, name: t.for_name };
  const moved = Number(p.id) !== Number(t.for_id);
  await run(env.DB, 'UPDATE shift_task SET what = ?2, due = ?3, for_id = ?4, for_name = ?5 WHERE id = ?1', t.id, what, due, p.id, p.name);
  const said = [what !== t.what ? `“${what}”` : null, due !== t.due ? `due ${fmt(due)}` : null, moved ? `for ${p.name}` : null].filter(Boolean);
  if (said.length) await logEvent(env, t.key, `To-do changed: ${said.join(', ')}`, who(account));
  const after = await first(env.DB, 'SELECT * FROM shift_task WHERE id = ?1', t.id);
  // Given to somebody else: they are told now, as when it was made.
  const told = moved && Number(p.id) !== Number(account?.id) ? await tell(env, after, { fetchImpl }) : false;
  return { ok: true, task: view(after, account), told };
}

/** Each morning: a reminder for every open to-do not reminded today. Never throws. */
export async function remindDue(env, { fetchImpl, at = new Date() } = {}) {
  let sent = 0;
  try {
    const today = at.toISOString().slice(0, 10);
    const rows = await all(env.DB, "SELECT * FROM shift_task WHERE state = 'open' AND substr(COALESCE(reminded_at, made_at), 1, 10) < ?1", today);
    for (const t of rows) {
      // eslint-disable-next-line no-await-in-loop
      if (await tell(env, t, { reminder: true, fetchImpl, today })) sent += 1;
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'UPDATE shift_task SET reminders = reminders + 1, reminded_at = ?2 WHERE id = ?1', t.id, at.toISOString().slice(0, 19).replace('T', ' '));
    }
  } catch (err) { console.error('To-do reminders', err); }
  return { sent };
}
