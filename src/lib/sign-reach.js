import { createNotice } from './notices.js';
import { emailPersonally, isEmail } from './notify.js';
import { firstUsableNumber, sendTexts } from './sms.js';
import { getPepper, hashPin } from './auth.js';
import { siteOrigin } from './site.js';
import { whoCanSign } from './correspondence.js';

/**
 * Getting a letter to the people who have to sign it.
 *
 * A letter's links used to leave HIVE only by being copied by hand. Now HIVE
 * emails each signer their link when it is their turn, texts the access code
 * to their phone so the two never travel together, reminds them until they
 * sign, and tells the office when somebody signs, declines, or the last
 * signature is in.
 *
 * Links are stored only as hashes, so a link can only be sent at the moment it
 * is made. When it is somebody's turn later on, or a reminder goes out, HIVE
 * makes them a fresh one and the earlier link stops working; the access code
 * stays the same.
 */

const hashSignToken = (token, pepper) => hashPin(`corr-sign:${token}`, pepper);

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh link for one recipient. The one before stops working. */
export async function reissueLink(db, recipient, origin = '') {
  const token = newToken();
  const pepper = await getPepper(db);
  await db.prepare('UPDATE corr_recipient SET token_hash = ?2 WHERE id = ?1')
    .bind(recipient.id, await hashSignToken(token, pepper)).run();
  return `${await siteOrigin(db, origin)}/s/${token}`;
}

/** Email one recipient their link. Returns whether it went. */
export async function emailSignLink(db, env, { letter, recipient, url, why = 'first', hasCode = false }) {
  if (!isEmail(String(recipient.email ?? '').trim())) return { sent: false, reason: 'no email address' };
  const action = recipient.role === 'approver' ? 'approve' : 'sign';
  const title = why === 'reminder'
    ? `Reminder: please ${action} “${letter.subject}”`
    : why === 'turn'
      ? `Your turn to ${action} “${letter.subject}”`
      : `Please ${action} “${letter.subject}”`;
  const out = await emailPersonally(db, env, {
    kind: 'corr.sign_link',
    level: 'info',
    title,
    body: `${letter.reference ? `${letter.reference}. ` : ''}Open the link to read it and ${action}.`,
    link: url,
    to: recipient.email,
    wanted: true,
    mail: {
      status: why === 'reminder' ? 'Reminder' : why === 'turn' ? 'Your turn' : 'To sign',
      tone: 'info',
      eyebrow: 'Signing',
      subject: title,
      preheader: `Open the link to read it and ${action}.`,
      headline: title,
      facts: [
        ['Document', letter.subject],
        ['Reference', letter.reference || null],
      ],
      note: (why === 'turn' ? 'Those before you have signed. ' : '')
        + `Open the link to read the document and ${action} it on your phone or computer.`
        + (hasCode ? ' You will be asked for the access code, which comes to you separately.' : '')
        + (why !== 'first' ? ' This link replaces any earlier one.' : ''),
      button: action === 'approve' ? 'Read and approve' : 'Read and sign',
      why: 'You get this because you were asked to sign this document.',
      settingsLink: false,
    },
  }).catch((err) => ({ sent: 0, reason: err.message }));
  return { sent: Number(out?.sent ?? 0) > 0, reason: out?.reason ?? null };
}

/** Text the access code to the recipient's phone, apart from the link. */
export async function textAccessCode(db, env, { letter, recipient, code }) {
  const phone = firstUsableNumber(recipient.phone);
  if (!phone || !code) return { sent: false };
  const out = await sendTexts(db, env, {
    kind: 'corr.sign_code',
    messages: [{ to: phone, text: `Your access code to sign "${letter.subject}" is ${code}. The link comes by email.` }],
  }).catch(() => ({ sent: 0 }));
  return { sent: Number(out?.sent ?? 0) > 0 };
}

/**
 * Tell whoever's turn it now is, once. Called after every signature, so the
 * second signer hears the moment the first has signed rather than whenever
 * somebody in the office remembers to forward it.
 */
export async function tellWhoseTurn(ctx, letterId) {
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  if (!letter || letter.status !== 'awaiting_signature') return [];
  const all = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letterId).all()).results ?? [];
  const told = [];
  for (const r of whoCanSign(all, letter.routing ?? 'order')) {
    if (r.turn_told_at || !['pending', 'opened'].includes(r.status) || !r.email) continue;
    const url = await reissueLink(ctx.db, r, ctx.url?.origin);
    const sent = await emailSignLink(ctx.db, ctx.env, {
      letter, recipient: r, url, why: 'turn', hasCode: Boolean(r.code_hash),
    });
    if (!sent.sent) continue;
    await ctx.db.prepare("UPDATE corr_recipient SET turn_told_at = datetime('now') WHERE id = ?").bind(r.id).run();
    told.push(r.name);
  }
  return told;
}

/** Tell the office what happened on a letter. */
export async function tellOffice(ctx, letter, { what, who, note = null }) {
  const titles = {
    signed: `${who} signed “${letter.subject}”`,
    declined: `${who} declined to sign “${letter.subject}”`,
    complete: `“${letter.subject}” is fully signed`,
  };
  await createNotice(ctx.db, {
    kind: `corr.${what}`,
    level: what === 'declined' ? 'warn' : what === 'complete' ? 'good' : 'info',
    title: titles[what],
    body: `${letter.reference ? `${letter.reference}. ` : ''}${note ? `"${note}"` : ''}`.trim()
      || (what === 'complete' ? 'Every signer has signed.' : 'Open it in Letters.'),
    link: `#/letter?id=${letter.id}`,
    actor: who || 'HIVE',
    audience: 'corr_write',
    push: what !== 'signed',
    email: what !== 'signed',
    text: false,
  }, ctx);
}
