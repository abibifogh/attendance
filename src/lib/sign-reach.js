import { createNotice } from './notices.js';
import { emailPersonally, isEmail } from './notify.js';
import { firstUsableNumber, sendTexts, smsSetup } from './sms.js';
import { getPepper, hashPin } from './auth.js';
import { siteOrigin } from './site.js';
import { liveTurn } from './correspondence.js';

/**
 * Getting a letter to the people who have to sign it.
 *
 * A letter's links used to leave HIVE only by being copied by hand. Now HIVE
 * emails or texts each signer their link when it is their turn, reminds them
 * until they sign, tells a member of staff inside HIVE, and tells the office
 * when somebody signs, declines, or the last signature is in.
 *
 * Links are stored only as hashes, so a link can only be sent at the moment it
 * is made. When it is somebody's turn later on, or a reminder goes out, HIVE
 * makes them a fresh one and the earlier link stops working.
 */

const hashSignToken = (token, pepper) => hashPin(`corr-sign:${token}`, pepper);

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function settingsOf(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
  return Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
}

/** What HIVE can send with today: email, texts, both or neither. */
export async function waysOut(db, env) {
  const settings = await settingsOf(db);
  const sms = smsSetup(settings, env);
  return {
    email: Boolean(env?.RESEND_API_KEY && String(settings.email_from ?? '').trim() && settings.notice_email !== '0'),
    text: Boolean(sms.on && sms.ready),
    property: settings.property_name || 'Somewhere Nice',
  };
}

/** How a person is reached: what they were set up with, or whatever is on file. */
export const reachOf = (r) => r.reach || (r.email ? 'email' : (r.phone ? 'text' : 'email'));

/** Whether HIVE can get a link to this person on its own. */
export function canReach(ways, r) {
  const how = reachOf(r);
  if (how === 'staff') return true;
  if (how === 'text') return ways.text && Boolean(firstUsableNumber(r.phone));
  return ways.email && isEmail(String(r.email ?? '').trim());
}

/** A fresh link for one recipient. The one before stops working. */
export async function reissueLink(db, recipient, origin = '') {
  const token = newToken();
  const pepper = await getPepper(db);
  await db.prepare('UPDATE corr_recipient SET token_hash = ?2 WHERE id = ?1')
    .bind(recipient.id, await hashSignToken(token, pepper)).run();
  return `${await siteOrigin(db, origin)}/s/${token}`;
}

const dayOf = (at) => (at ? new Date(`${String(at).replace(' ', 'T')}Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);

/** Email one recipient their link. Returns whether it went. */
export async function emailSignLink(db, env, { letter, recipient, url, why = 'first', hasCode = false }) {
  if (!isEmail(String(recipient.email ?? '').trim())) return { sent: false, reason: 'no email address' };
  const action = recipient.role === 'approver' ? 'approve' : 'sign';
  const v2 = letter.flow === 'v2';
  const title = why === 'reminder'
    ? `Reminder: please ${action} “${letter.subject}”`
    : why === 'turn'
      ? `Your turn to ${action} “${letter.subject}”`
      : (v2 && letter.mail_subject) || `Please ${action} “${letter.subject}”`;
  const out = await emailPersonally(db, env, {
    kind: 'corr.sign_link',
    level: 'info',
    title,
    body: (v2 && letter.mail_message && why !== 'reminder')
      ? letter.mail_message
      : `${letter.reference ? `${letter.reference}. ` : ''}Open the link to read it and ${action}.`,
    link: url,
    to: recipient.email,
    wanted: true,
    mail: {
      status: why === 'reminder' ? 'Reminder' : why === 'turn' ? 'Your turn' : 'To sign',
      tone: 'info',
      eyebrow: 'Documents to sign',
      subject: title,
      preheader: `Open the link to read it and ${action}.`,
      headline: why === 'reminder'
        ? `“${letter.subject}” is still waiting for your signature`
        : title,
      facts: [
        ['Document', letter.subject],
        ['Reference', letter.reference || null],
        ['You', recipient.capacity ? `sign as ${recipient.capacity}` : null],
        ['Please sign by', v2 ? dayOf(recipient.expires_at) : null],
      ],
      note: (why === 'turn' ? 'Those before you have signed. ' : '')
        + (v2
          ? 'This link is yours alone. When you open it we send you a six-digit code, so only you can sign. '
            + 'There is no attachment to open.'
          : `Open the link to read the document and ${action} it on your phone or computer.`
            + (hasCode ? ' You will be asked for the access code, which comes to you separately.' : ''))
        + (why !== 'first' ? ' This link replaces any earlier one.' : ''),
      button: action === 'approve' ? 'Read and approve' : 'Review and sign',
      why: 'You get this because you were asked to sign this document.',
      settingsLink: false,
    },
  }).catch((err) => ({ sent: 0, reason: err.message }));
  return { sent: Number(out?.sent ?? 0) > 0, reason: out?.reason ?? null };
}

/** Text one recipient their link. */
export async function textSignLink(db, env, { letter, recipient, url, why = 'first' }) {
  const phone = firstUsableNumber(recipient.phone);
  if (!phone) return { sent: false, reason: 'no phone number' };
  const { property } = await waysOut(db, env);
  const lead = why === 'reminder' ? 'Reminder: ' : why === 'turn' ? 'Your turn: ' : '';
  const out = await sendTexts(db, env, {
    kind: 'corr.sign_code',
    messages: [{ to: phone, text: `${lead}${property} has sent you "${letter.subject}" to sign. Open: ${url}` }],
  }).catch((err) => ({ sent: 0, reason: err.message }));
  return { sent: Number(out?.sent ?? 0) > 0, reason: out?.reason ?? null };
}

/** The link, by whichever way this person was set up to be reached. */
export async function deliverLink(db, env, { letter, recipient, url, why = 'first' }) {
  if (reachOf(recipient) === 'text') return textSignLink(db, env, { letter, recipient, url, why });
  return emailSignLink(db, env, { letter, recipient, url, why, hasCode: Boolean(recipient.code_hash) });
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

/** Tell a member of staff, or whoever signs for the property, inside HIVE. */
export async function tellInHive(ctx, letter, { userId = null, property = false }) {
  await createNotice(ctx.db, {
    kind: 'corr.your_turn',
    level: 'info',
    title: `Your turn to sign “${letter.subject}”`,
    body: property
      ? `${letter.reference ? `${letter.reference}. ` : ''}Those before you have signed. Sign it for the property.`
      : `${letter.reference ? `${letter.reference}. ` : ''}Open it in HIVE to read and sign it.`,
    link: `#/sign-in?id=${letter.id}`,
    actor: 'HIVE',
    ...(userId ? { userId } : { audience: 'corr_sign' }),
    push: true,
    email: true,
    text: false,
  }, ctx).catch(() => {});
}

/**
 * Tell whoever's turn it now is, once. Called after every signature, so the
 * second signer hears the moment the first has signed rather than whenever
 * somebody in the office remembers to forward it. Somebody HIVE cannot reach
 * on its own is left alone, so a link the office was given to pass on by hand
 * is not quietly replaced.
 */
export async function tellWhoseTurn(ctx, letterId) {
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  if (!letter || letter.status !== 'awaiting_signature') return [];
  const all = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letterId).all()).results ?? [];
  const ways = await waysOut(ctx.db, ctx.env);
  const turn = liveTurn(all, letter.routing ?? 'order', letter);
  const told = [];
  for (const r of turn.signers) {
    if (r.turn_told_at || !['pending', 'opened'].includes(r.status)) continue;
    if (reachOf(r) === 'staff') {
      if (r.user_id) await tellInHive(ctx, letter, { userId: r.user_id });
      await ctx.db.prepare("UPDATE corr_recipient SET turn_told_at = datetime('now') WHERE id = ?").bind(r.id).run();
      told.push(r.name);
      continue;
    }
    if (!canReach(ways, r)) continue;
    const url = await reissueLink(ctx.db, r, ctx.url?.origin);
    const sent = await deliverLink(ctx.db, ctx.env, { letter, recipient: r, url, why: 'turn' });
    if (!sent.sent) continue;
    await ctx.db.prepare("UPDATE corr_recipient SET turn_told_at = datetime('now') WHERE id = ?").bind(r.id).run();
    told.push(r.name);
  }
  if (turn.property && !letter.property_told_at) {
    await tellInHive(ctx, letter, { userId: letter.property_user_id, property: true });
    await ctx.db.prepare("UPDATE corr_letter SET property_told_at = datetime('now') WHERE id = ?").bind(letter.id).run();
    told.push(ways.property);
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
      || (what === 'complete' ? 'Every signer has signed.' : 'Open it in Signatures.'),
    link: letter.flow === 'v2' ? `#/sign-doc?id=${letter.id}` : `#/letter?id=${letter.id}`,
    actor: who || 'HIVE',
    audience: 'corr_write',
    push: what !== 'signed',
    email: what !== 'signed',
    text: false,
  }, ctx);
}

/**
 * Everybody who had it is told it no longer needs signing, with the reason.
 * Only those who were actually sent a link: somebody further down the order
 * never knew it existed.
 */
export async function tellStopped(ctx, letter, { reason, except = null }) {
  const all = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letter.id).all()).results ?? [];
  for (const r of all) {
    if (r.id === except) continue;
    if (!r.turn_told_at && r.status !== 'signed' && r.status !== 'opened') continue;
    if (!isEmail(String(r.email ?? '').trim())) continue;
    await emailPersonally(ctx.db, ctx.env, {
      kind: 'corr.stopped',
      level: 'warn',
      title: `No longer needs signing: ${letter.subject}`,
      body: reason ? `The reason given: "${reason}"` : 'It has been stopped.',
      to: r.email,
      wanted: true,
      mail: {
        status: 'Stopped', tone: 'warn', eyebrow: 'Documents to sign',
        headline: `“${letter.subject}” no longer needs signing`,
        facts: [['Document', letter.subject], ['Reference', letter.reference || null], ['Reason', reason || null]],
        note: 'Any link you were sent for it no longer works. If a corrected one is needed, it will come separately.',
        why: 'You get this because you were asked to sign this document.',
        settingsLink: false,
      },
    }).catch(() => {});
  }
}

/** The finished PDF, to everybody on it who has an email address. */
export async function sendSignedCopies(ctx, letter, { bytes, filename }) {
  const all = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ?')
    .bind(letter.id).all()).results ?? [];
  const to = [...new Set(all.map((r) => String(r.email ?? '').trim()).filter((e) => isEmail(e)))];
  if (!to.length || !bytes?.length) return 0;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  let sent = 0;
  for (const address of to) {
    const out = await emailPersonally(ctx.db, ctx.env, {
      kind: 'corr.copy',
      level: 'good',
      title: `Signed: ${letter.subject}`,
      body: 'Everyone has signed. The finished PDF is attached, with a certificate as its last page.',
      to: address,
      wanted: true,
      attachments: [{ filename, content: btoa(binary) }],
      mail: {
        status: 'Signed', tone: 'good', eyebrow: 'Documents to sign',
        headline: `“${letter.subject}” is signed by everyone`,
        facts: [['Document', letter.subject], ['Reference', letter.reference || null]],
        note: 'The finished PDF is attached, with a certificate as its last page. Anybody can check it is genuine '
          + 'at the address printed at the foot of each page.',
        why: 'You get this because you were on this document.',
        settingsLink: false,
      },
    }).catch(() => ({ sent: 0 }));
    sent += Number(out?.sent ?? 0) > 0 ? 1 : 0;
  }
  return sent;
}
