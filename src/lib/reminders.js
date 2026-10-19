import { createNotice } from './notices.js';
import { outstandingFor } from './handbook.js';
import { dow, nowIn } from '../util/dates.js';
import { deliverInvite, makeInvite } from '../routes/people.js';
import { emailSignLink, reissueLink } from './sign-reach.js';
import { whoCanSign } from './correspondence.js';

/**
 * Chasing what is still waiting on somebody.
 *
 * None of it used to be chased: a details link nobody opened, a contract on
 * it nobody signed, a letter sitting with the second signer, a handbook
 * chapter nobody had read. Each waited until somebody in the office noticed.
 *
 * Once a day from nine in the morning:
 *
 *   A details or contract link HIVE sent, and that is not finished, is sent
 *   again two days after it first went and every three days after that, five
 *   times at most and never past the day it runs out. Links are kept only as
 *   hashes, so a reminder carries a fresh link and the earlier one stops
 *   working. A link opened in the last day is left alone, so nobody is cut
 *   off halfway through filling it in.
 *
 *   A letter waiting on somebody's signature is emailed to them again on the
 *   same timetable, and the office is warned two days before a link runs out.
 *
 *   On Mondays, everybody with handbook sections still to read or sign is
 *   reminded once.
 */

export const FIRST_AFTER_DAYS = 2;
export const THEN_EVERY_DAYS = 3;
export const MOST_REMINDERS = 5;
const OPENS_FROM_HOUR = 9;

/** The office's hand, for a reminder nobody pressed. */
function systemCtx(db, ctx) {
  return {
    db,
    env: ctx?.env ?? {},
    executionContext: ctx?.executionContext ?? null,
    url: null,
    request: null,
    session: { user: { id: null, name: 'HIVE', role: 'reminder' }, permissions: [] },
  };
}

export async function watchReminders(db, { timezone = 'UTC', ctx = null } = {}) {
  const now = nowIn(timezone);
  const today = now.slice(0, 10);
  if (Number(now.slice(11, 13)) < OPENS_FROM_HOUR) return { links: 0, letters: 0, warned: 0, handbook: 0 };
  const sys = systemCtx(db, ctx);

  const links = await chaseLinks(sys).catch((err) => { console.error('Link reminders failed', err); return 0; });
  const { reminded: letters, warned } = await chaseLetters(sys)
    .catch((err) => { console.error('Letter reminders failed', err); return { reminded: 0, warned: 0 }; });
  const handbook = dow(today) === 0
    ? await chaseHandbook(sys, today).catch((err) => { console.error('Handbook reminders failed', err); return 0; })
    : 0;
  return { links, letters, warned, handbook };
}

/** Details and contract links HIVE sent and that are not finished. */
async function chaseLinks(sys) {
  const { db } = sys;
  const due = await db.prepare(
    `SELECT i.*, s.name, s.active
       FROM hr_invite i JOIN att_staff s ON s.id = i.staff_id
      WHERE i.sent_at IS NOT NULL AND i.finished_at IS NULL AND i.revoked_at IS NULL
        AND i.replaced_by IS NULL AND i.expires_at > datetime('now', '+1 day')
        AND (i.by_email = 1 OR i.by_text = 1)
        AND i.reminders < ?1
        AND COALESCE(i.reminded_at, i.sent_at) <= datetime('now', CASE WHEN i.reminders = 0 THEN ?2 ELSE ?3 END)
        AND (i.opened_at IS NULL OR i.opened_at <= datetime('now', '-1 day'))`,
  ).bind(MOST_REMINDERS, `-${FIRST_AFTER_DAYS} days`, `-${THEN_EVERY_DAYS} days`).all().catch(() => ({ results: [] }));

  let n = 0;
  for (const old of due.results ?? []) {
    if (!old.active) continue;
    // Claimed first: a second run in the same minute finds it already done.
    const claim = await db.prepare(
      "UPDATE hr_invite SET reminded_at = datetime('now') WHERE id = ?1 AND replaced_by IS NULL AND COALESCE(reminded_at, '') = COALESCE(?2, '')",
    ).bind(old.id, old.reminded_at).run();
    if (!Number(claim?.meta?.changes ?? 0)) continue;

    const contracts = (await db.prepare(
      `SELECT c.id FROM hr_invite_contract ic JOIN hr_contract c ON c.id = ic.contract_id
        WHERE ic.invite_id = ? AND c.status IN ('draft','sent','opened')`,
    ).bind(old.id).all()).results ?? [];
    const left = await db.prepare("SELECT CAST(julianday(?1) - julianday('now') AS INTEGER) AS d").bind(old.expires_at).first();
    const days = Math.max(1, Math.min(90, Number(left?.d ?? 7)));

    const person = { id: old.staff_id, name: old.name };
    const fresh = await makeInvite(sys, person, {
      wantsDetails: Boolean(old.wants_details),
      contractIds: contracts.map((c) => c.id),
      days,
      pinHash: old.pin_hash,
      message: old.message,
      by: 'HIVE (reminder)',
    }).catch(() => null);
    if (!fresh) continue;

    await db.prepare(
      `UPDATE hr_invite SET reminders = ?2, reminded_at = datetime('now'), sent_at = ?3 WHERE id = ?1`,
    ).bind(fresh.id, Number(old.reminders) + 1, old.sent_at).run();
    await db.prepare(
      "UPDATE hr_invite SET revoked_at = datetime('now'), revoked_by = 'HIVE (replaced by a reminder)', replaced_by = ?2 WHERE id = ?1",
    ).bind(old.id, fresh.id).run();

    const out = await deliverInvite(sys, person, fresh, {
      email: Boolean(old.by_email), text: Boolean(old.by_text), reminder: true,
    });
    if (out.emailed || out.texted) n += 1;
  }
  return n;
}

/** Letters waiting on somebody's signature. */
async function chaseLetters(sys) {
  const { db } = sys;
  const letters = (await db.prepare(
    "SELECT * FROM corr_letter WHERE status = 'awaiting_signature'",
  ).all().catch(() => ({ results: [] }))).results ?? [];

  let reminded = 0;
  let warned = 0;
  for (const letter of letters) {
    const all = (await db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
      .bind(letter.id).all()).results ?? [];
    for (const r of whoCanSign(all, letter.routing ?? 'order')) {
      if (!['pending', 'opened'].includes(r.status)) continue;

      const timing = (await db.prepare(
        `SELECT expires_at > datetime('now') AS live,
                expires_at <= datetime('now', '+2 days') AS soon,
                COALESCE(reminded_at, turn_told_at) <= datetime('now', CASE WHEN reminders = 0 THEN ?2 ELSE ?3 END) AS due
           FROM corr_recipient WHERE id = ?1`,
      ).bind(r.id, `-${FIRST_AFTER_DAYS} days`, `-${THEN_EVERY_DAYS} days`).first()) ?? {};
      if (!Number(timing.live)) continue;

      if (Number(timing.soon) && !r.expiry_warned_at) {
        const claim = await db.prepare(
          "UPDATE corr_recipient SET expiry_warned_at = datetime('now') WHERE id = ? AND expiry_warned_at IS NULL",
        ).bind(r.id).run();
        if (Number(claim?.meta?.changes ?? 0)) {
          await createNotice(db, {
            kind: 'corr.expiring',
            level: 'warn',
            title: `“${letter.subject}” runs out in two days unsigned`,
            body: `Still waiting on ${r.name}. Send it again from the letter if it needs longer.`,
            link: `#/letter?id=${letter.id}`,
            actor: 'HIVE',
            audience: 'corr_write',
            push: true,
            email: true,
            text: false,
          }, sys).catch(() => {});
          warned += 1;
        }
      }

      // Only those HIVE has emailed before, so it never writes to somebody
      // the office chose to deal with by hand.
      if (!r.email || !r.turn_told_at || !Number(timing.due) || Number(r.reminders) >= MOST_REMINDERS) continue;
      const claim = await db.prepare(
        `UPDATE corr_recipient SET reminded_at = datetime('now'), reminders = reminders + 1
          WHERE id = ?1 AND reminders = ?2`,
      ).bind(r.id, Number(r.reminders)).run();
      if (!Number(claim?.meta?.changes ?? 0)) continue;
      const url = await reissueLink(db, r);
      const sent = await emailSignLink(db, sys.env, {
        letter, recipient: r, url, why: 'reminder', hasCode: Boolean(r.code_hash),
      });
      if (sent.sent) reminded += 1;
    }
  }
  return { reminded, warned };
}

/** Mondays: everybody with handbook sections still to do, once. */
async function chaseHandbook(sys, today) {
  const { db } = sys;
  const on = await db.prepare("SELECT value FROM settings WHERE key = 'handbook_on'").first().catch(() => null);
  if (String(on?.value) !== '1') return 0;

  const [chapters, people, acks] = await Promise.all([
    db.prepare("SELECT * FROM hb_chapter WHERE status = 'published'").all().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT s.*, u.id AS user_id FROM att_staff s
         JOIN users u ON u.staff_id = s.id AND u.active = 1
        WHERE s.active = 1`,
    ).all().catch(() => ({ results: [] })),
    db.prepare('SELECT chapter_id, staff_id, version FROM hb_ack').all().catch(() => ({ results: [] })),
  ]);
  const acksBy = new Map();
  for (const a of acks.results ?? []) {
    if (!acksBy.has(a.staff_id)) acksBy.set(a.staff_id, []);
    acksBy.get(a.staff_id).push(a);
  }

  let n = 0;
  for (const person of people.results ?? []) {
    const left = outstandingFor(chapters.results ?? [], person, acksBy.get(person.id) ?? []);
    if (!left.length) continue;
    const claim = await db.prepare(
      "INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, 'handbook')",
    ).bind(person.id, today).run().catch(() => null);
    if (!Number(claim?.meta?.changes ?? 0)) continue;
    await createNotice(db, {
      kind: 'handbook.reminder',
      level: 'info',
      title: left.length === 1 ? 'One handbook section still to do' : `${left.length} handbook sections still to do`,
      body: left.slice(0, 3).map((c) => c.live_title || c.title).join(', ') + (left.length > 3 ? ' and more' : ''),
      link: '#/handbook',
      actor: 'HIVE',
      userId: person.user_id,
      push: true,
      email: false,
      text: false,
    }, sys).catch(() => {});
    n += 1;
  }
  return n;
}
