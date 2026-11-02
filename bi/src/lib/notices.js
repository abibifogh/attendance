import { all, first, run } from './db.js';
import { sendPush, vapidKeys } from './webpush.js';

/**
 * Telling a person something: a line in their notifications inbox in Insight,
 * and a push to every phone or computer they turned notifications on for.
 *
 * Everything Insight emails a person comes through here too (src/lib/link.js
 * calls `fromMail` after HIVE has sent it), so the inbox has all of it: the
 * 07:00 list, a to-do given, proof asked, the management report, a note they
 * were tagged in. Some things are told without an email at all, or told again
 * (a store-room request not yet issued, every 15 minutes): `tell` with a `key`
 * keeps that to one line, moved to the top and made unread again each time.
 *
 * Nothing here ever fails the thing it is telling about: a push service down,
 * or a phone gone, is noted on that phone and the rest carries on.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
/** Who a push says it is from (VAPID asks for a contact): Insight's own address. */
export const siteOf = (env) => String(env.SITE_URL || 'https://insight.niceoperation.com').replace(/\/+$/, '');

/** Where each kind of email's notification opens in Insight. */
const LINKS = {
  insight_todo: '#/inbox', insight_proof: '#/inbox', insight_note: '#/shifts', insight_management: '#/management',
  insight_prepaid: '#/prepaid', insight_receipts: '#/receipts', insight_digest: '#/assistant', insight_duty: '#/management',
  insight_store: '#/inbox',
};
/** Kinds that are urgent whatever they say: somebody is waiting on them. */
const URGENT_KINDS = new Set(['insight_store', 'insight_proof']);
const urgentWords = /\b(overdue|late|urgent|deduct\w*|short)\b/i;

/** The accounts these addresses or ids belong to (active ones), once each. */
async function whoAre(env, to) {
  const list = (Array.isArray(to) ? to : [to]).flat().filter((x) => x != null && x !== '');
  const ids = new Set(list.filter((x) => Number.isInteger(Number(x)) && !String(x).includes('@')).map(Number));
  const emails = [...new Set(list.filter((x) => String(x).includes('@')).map((x) => String(x).trim().toLowerCase()))];
  const found = [];
  if (emails.length) {
    found.push(...await all(env.DB, `SELECT id FROM accounts WHERE active = 1 AND LOWER(email) IN (${emails.map((_, i) => `?${i + 1}`).join(', ')})`, ...emails).catch(() => []));
  }
  if (ids.size) {
    const list_ = [...ids];
    found.push(...await all(env.DB, `SELECT id FROM accounts WHERE active = 1 AND id IN (${list_.map((_, i) => `?${i + 1}`).join(', ')})`, ...list_).catch(() => []));
  }
  return [...new Set(found.map((r) => Number(r.id)))];
}

/**
 * Tell people something. `to`: account ids or email addresses (an address
 * nobody in Insight has is left out). With `key`, the same thing told again
 * updates its line rather than adding one, and makes it unread. Returns how
 * many were told and how many phones were pushed to.
 */
export async function tell(env, { to, kind, title, body = '', link = null, urgent = false, key = null, push = true, tag = null }, { fetchImpl } = {}) {
  const people = await whoAre(env, to);
  let told = 0;
  let pushed = 0;
  for (const accountId of people) {
    const at = now();
    // eslint-disable-next-line no-await-in-loop
    const had = key ? await first(env.DB, 'SELECT id FROM notice WHERE account_id = ?1 AND key = ?2', accountId, key).catch(() => null) : null;
    let id;
    if (had) {
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, `UPDATE notice SET title = ?2, body = ?3, link = ?4, urgent = ?5, last_at = ?6, times = times + 1, read_at = NULL, done_at = NULL
        WHERE id = ?1`, had.id, String(title).slice(0, 200), String(body || '').slice(0, 1000), link, urgent ? 1 : 0, at);
      id = had.id;
    } else {
      // eslint-disable-next-line no-await-in-loop
      const row = await first(env.DB, `INSERT INTO notice (account_id, kind, key, title, body, link, urgent, at, last_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING id`, accountId, kind, key, String(title).slice(0, 200), String(body || '').slice(0, 1000), link, urgent ? 1 : 0, at).catch(() => null);
      id = row?.id;
    }
    if (!id) continue;
    told += 1;
    if (push) {
      // eslint-disable-next-line no-await-in-loop
      pushed += await pushTo(env, accountId, { title, body, url: `/${link || '#/notifications'}`.replace('//#', '/#'), tag: tag || key || `n${id}`, urgent, id }, { fetchImpl });
    }
  }
  return { told, pushed };
}

/** The thing a notification was about is finished: it is marked done, and read. */
export async function settle(env, key) {
  await run(env.DB, 'UPDATE notice SET done_at = ?2, read_at = COALESCE(read_at, ?2) WHERE key = ?1 AND done_at IS NULL', key, now()).catch(() => null);
}

/** Push one message to every phone or computer this person turned notifications on for. */
export async function pushTo(env, accountId, message, { fetchImpl } = {}) {
  const subs = await all(env.DB, 'SELECT * FROM push_sub WHERE account_id = ?1', accountId).catch(() => []);
  if (!subs.length) return 0;
  let keys;
  try { keys = await vapidKeys(env.DB); } catch { return 0; }
  let sent = 0;
  for (const sub of subs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await sendPush(sub, message, keys, siteOf(env), fetchImpl ? { fetchImpl } : {});
      if (out.gone) {
        // eslint-disable-next-line no-await-in-loop
        await run(env.DB, 'DELETE FROM push_sub WHERE id = ?1', sub.id);
      } else if (out.ok) {
        sent += 1;
        // eslint-disable-next-line no-await-in-loop
        await run(env.DB, 'UPDATE push_sub SET last_ok = ?2, last_error = NULL WHERE id = ?1', sub.id, now());
      } else {
        // eslint-disable-next-line no-await-in-loop
        await run(env.DB, 'UPDATE push_sub SET last_error = ?2 WHERE id = ?1', sub.id, `${out.status} ${out.detail || ''}`.slice(0, 300));
      }
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'UPDATE push_sub SET last_error = ?2 WHERE id = ?1', sub.id, String(err?.message || err).slice(0, 300)).catch(() => null);
    }
  }
  return sent;
}

/**
 * An email Insight sent through HIVE, as a notification too: to whoever it was
 * to and copied to, when they have an Insight account. The subject is the
 * title; the first lines of the text, the body.
 */
export async function fromMail(env, mail, { fetchImpl } = {}) {
  const to = [mail?.to, ...(Array.isArray(mail?.cc) ? mail.cc : [])].flat().filter(Boolean);
  if (!to.length || !mail?.subject) return { told: 0, pushed: 0 };
  const kind = String(mail.kind || 'insight_mail');
  const text = String(mail.text || '').replace(/\s+\n/g, '\n').trim();
  return tell(env, {
    to, kind,
    title: String(mail.subject),
    body: text.split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 400),
    link: mail.link || LINKS[kind] || '#/assistant',
    urgent: URGENT_KINDS.has(kind) || urgentWords.test(mail.subject),
  }, { fetchImpl });
}
