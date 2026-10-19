import { badRequest, forbidden, json, notFound, readJson, str } from '../lib/http.js';
import { getPepper, hashPin, throttleCheck, throttleFail } from '../lib/auth.js';
import { sendEmail, senderNameOf, senderWithName } from '../lib/notify.js';
import { asBytes, sha256Hex } from '../lib/files.js';
import { liveTurn, whoCanSign } from '../lib/correspondence.js';
import { normaliseLayout } from '../lib/paper.js';
import { renderMail } from '../lib/email-design.js';
import { firstUsableNumber, sendTexts, smsSetup } from '../lib/sms.js';
import { appendEvent, hashAccessCode, hashSignToken } from './correspondence.js';
import {
  reachOf, tellOffice, tellStopped, tellWhoseTurn,
} from '../lib/sign-reach.js';
import { afterSignature, applyRecipientSignature, packetFor } from './sign-prep.js';

/**
 * Somebody outside the property, opening a link to sign a letter.
 *
 * No session, no account. The token in the path is the whole of the caller's
 * authority and it names exactly one recipient of exactly one letter, so no
 * request from here can reach anything else.
 *
 * Three gates, in the order the better e-signing products put them:
 *
 *   The link itself, which is long, random, expiring and revocable, and stored
 *   only as a hash so a copy of the database opens nothing.
 *
 *   An access code, told to the recipient down another channel and entered
 *   before the document opens at all. A link forwarded by mistake reaches a
 *   locked door rather than a contract.
 *
 *   A one-time code emailed at the moment of signing, where an address is on
 *   file. This is the one that turns "somebody holding the link" into
 *   "somebody holding the link and reading that mailbox".
 */

const ipOf = (ctx) => ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
const agentOf = (ctx) => (ctx.request.headers.get('User-Agent') || '').slice(0, 300);

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key)
    .first().catch(() => null);
  return row?.value ?? fallback;
}

/**
 * The recipient a link refers to, and why it will not open if it will not.
 *
 * Each refusal is a different problem with a different answer, and one "this
 * link is not valid" would send somebody to the wrong one every time.
 */
async function recipientFor(ctx, token) {
  const pepper = await getPepper(ctx.db);
  const recipient = await ctx.db.prepare('SELECT * FROM corr_recipient WHERE token_hash = ?')
    .bind(await hashSignToken(String(token ?? ''), pepper)).first();

  if (!recipient) throw notFound('This link does not work. Ask whoever sent it for a new one.');
  if (recipient.status === 'revoked') throw forbidden('This link has been cancelled.');

  const gone = await ctx.db.prepare("SELECT datetime('now') > ? AS expired")
    .bind(recipient.expires_at).first();
  if (gone?.expired) throw forbidden('This link has expired. Ask for a new one.');

  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?')
    .bind(recipient.letter_id).first();
  if (!letter) throw notFound('The document behind this link is gone.');
  if (letter.status === 'void') throw forbidden('This document has been withdrawn.');

  return { recipient, letter };
}

/**
 * Whose turn it is.
 *
 * Signing is in order. Somebody further down the list is told plainly that it
 * is not their turn and who is being waited on, rather than being shown a
 * document out of sequence or a link that appears broken.
 */
async function assertTurn(ctx, recipient) {
  const [others, letter] = await Promise.all([
    ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
      .bind(recipient.letter_id).all(),
    ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(recipient.letter_id).first(),
  ]);

  // An envelope sent to everybody at once has no queue to wait in.
  const turn = liveTurn(others.results ?? [], letter?.routing ?? 'order', letter);
  const open = turn.signers;
  if ((open.length || turn.property) && !open.some((r) => r.id === recipient.id)) {
    throw forbidden(letter?.flow === 'v2'
      ? 'It is not your turn to sign yet. You will be sent a message when it is.'
      : `It is not your turn yet — this is with ${open[0]?.name ?? 'somebody else'} first. `
        + 'Your link will work once they have dealt with it.');
  }
  return open[0] ?? null;
}

async function property(db) {
  return (await setting(db, 'property_name', 'Somewhere Nice'));
}

/** Almost nothing, before anybody proves anything. */
export async function signHead(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
  if (letter.flow === 'v2') return json(await headV2(ctx, recipient, letter));
  return json({
    property: await property(ctx.db),
    needsCode: Boolean(recipient.code_hash),
    done: recipient.status === 'signed' || recipient.status === 'declined',
    subject: recipient.status === 'signed' ? letter.subject : null,
  });
}

/** Open it. */
export async function signOpen(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
  if (letter.flow === 'v2') return openV2(ctx, token, recipient, letter);
  const body = await readJson(ctx.request).catch(() => ({}));

  if (recipient.code_hash) {
    const ip = ipOf(ctx);
    const gate = await throttleCheck(ctx.db, `corr:${ip}`, { pin: false });
    if (!gate.allowed) {
      throw forbidden(`Too many tries. Wait ${Math.ceil(gate.retryAfter / 60)} minutes.`);
    }

    const given = String(body.code ?? '').trim().toUpperCase();
    const pepper = await getPepper(ctx.db);
    if (!given || await hashAccessCode(given, pepper) !== recipient.code_hash) {
      await throttleFail(ctx.db, `corr:${ip}`, { everybody: false });
      await appendEvent(ctx.db, letter.id, {
        kind: 'access_code_failed', actor: recipient.name, detail: null,
        ip, agent: agentOf(ctx),
      });
      throw forbidden('That code is not right. It is the one you were given separately.');
    }
  }

  await assertTurn(ctx, recipient);

  if (!recipient.opened_at) {
    await ctx.db.prepare("UPDATE corr_recipient SET opened_at = datetime('now'), status = CASE WHEN status = 'pending' THEN 'opened' ELSE status END WHERE id = ?")
      .bind(recipient.id).run();
    await appendEvent(ctx.db, letter.id, {
      kind: 'opened_by_recipient', actor: recipient.name, detail: null,
      ip: ipOf(ctx), agent: agentOf(ctx),
    });
  }

  const others = await ctx.db.prepare(
    'SELECT seq, role, name, status, signed_at FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id',
  ).bind(letter.id).all();

  const stamp = letter.stamp_id
    ? await ctx.db.prepare('SELECT label, image FROM corr_stamp WHERE id = ?').bind(letter.stamp_id).first()
    : null;

  const letterhead = letter.letterhead_id
    ? await ctx.db.prepare('SELECT * FROM corr_letterhead WHERE id = ?')
      .bind(letter.letterhead_id).first().catch(() => null)
    : null;

  // Everybody on the envelope, so the page can draw each signature in the
  // place it belongs and say whose the empty ones are. Names and status only:
  // an email address on this list would be handing one supplier another's.
  const party = await ctx.db.prepare(
    `SELECT seq, role, name, organisation, status, signed_at, signer_name, signature_ink
       FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id`,
  ).bind(letter.id).all().catch(() => ({ results: [] }));

  return json({
    property: await property(ctx.db),
    you: {
      name: recipient.name,
      role: recipient.role,
      status: recipient.status,
      // Which places on the page are theirs to fill.
      seq: recipient.seq,
    },
    // In seq order, so position N in the list is the signer the page calls N.
    recipients: (party.results ?? []).map((r) => ({
      seq: r.seq,
      role: r.role,
      name: r.name,
      organisation: r.organisation,
      status: r.status,
      signedAt: r.signed_at,
      signerName: r.signer_name,
      signatureInk: r.signature_ink,
    })),
    // An email address is never shown back in full: a forwarded link should
    // not tell whoever opens it where the code would be sent.
    emailHint: recipient.email ? maskEmail(recipient.email) : null,
    letter: {
      reference: letter.reference,
      subject: letter.subject,
      source: letter.source,
      body: letter.body,
      // The letter as it was laid out, so the person signing sees the same
      // page the property printed rather than a plain-text rendering of it.
      // The words were cleaned when they were saved; nothing here trusts
      // them a second time, but nothing here has to clean them either.
      layout: normaliseLayout(letter.layout),
      letterhead: letterhead
        ? {
          image: `/api/s/${encodeURIComponent(token)}/letterhead`,
          margins: {
            top: letterhead.margin_top, right: letterhead.margin_right,
            bottom: letterhead.margin_bottom, left: letterhead.margin_left,
          },
          laterPages: Boolean(letterhead.later_pages),
        }
        : null,
      hash: letter.body_hash,
      fileId: letter.file_id,
      signedBy: letter.signed_by,
      signedTitle: letter.signed_title,
      signatureInk: letter.signature_ink,
      signedAt: letter.signed_at,
      stamp: stamp?.image ?? null,
    },
    others: (others.results ?? []).map((r) => ({
      seq: r.seq, role: r.role, name: r.name, status: r.status, signedAt: r.signed_at,
    })),
    expiresAt: recipient.expires_at,
    verified: Boolean(recipient.verified_at),
    otpRequired: await otpRequired(ctx, recipient),
  });
}

/**
 * Whether this signer has to enter an emailed code before signing.
 *
 * Yes by default wherever HIVE can send one: there is an address on file and
 * the property has email set up. A property can turn it off under Settings,
 * and a signer with no address is not asked for what cannot reach them.
 */
async function otpRequired(ctx, recipient) {
  if ((await setting(ctx.db, 'corr_require_otp', '1')) === '0') return false;
  if (reachOf(recipient) === 'text') {
    if (!firstUsableNumber(recipient.phone)) return false;
    const rows = await ctx.db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
    const sms = smsSetup(Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value])), ctx.env);
    return Boolean(sms.on && sms.ready);
  }
  if (!recipient.email) return false;
  return Boolean(ctx.env?.RESEND_API_KEY && await setting(ctx.db, 'email_from', null));
}

function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits ? `+${digits.slice(0, 3)} •• ••• ${digits.slice(-4)}` : '•••';
}

const hintFor = (recipient) => (reachOf(recipient) === 'text' ? maskPhone(recipient.phone) : maskEmail(recipient.email));

/**
 * A document made in three steps, before the code: who sent it, to whom, by
 * when, and where the code will go. Nothing of the document itself.
 */
async function headV2(ctx, recipient, letter) {
  const all = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letter.id).all()).results ?? [];
  const turn = liveTurn(all, letter.routing ?? 'order', letter);
  const needsCode = await otpRequired(ctx, recipient);
  return {
    flow: 'v2',
    property: await property(ctx.db),
    title: letter.subject,
    reference: letter.reference,
    sender: String(letter.created_by ?? '').replace(/\s*\([^)]*\)$/, ''),
    name: recipient.name,
    capacity: recipient.capacity,
    dueBy: recipient.expires_at,
    status: recipient.status,
    done: recipient.status === 'signed' || recipient.status === 'declined',
    copyOnly: recipient.role === 'copy',
    notYet: !['signed', 'declined'].includes(recipient.status) && !turn.signers.some((r) => r.id === recipient.id),
    complete: letter.status === 'signed',
    needsCode,
    codeTo: needsCode ? { how: reachOf(recipient) === 'text' ? 'text' : 'email', hint: hintFor(recipient) } : null,
  };
}

const hashGrant = (grant, pepper) => hashPin(`corr-grant:${grant}`, pepper);

/**
 * The pass a browser holds once its code was right. Twelve hours, then the
 * code again: long enough to read a contract, short enough that a phone left
 * on a table tomorrow does not still open it.
 */
async function assertGrant(ctx, recipient) {
  const grant = ctx.request.headers.get('X-Sign-Grant') || '';
  if (!grant || !recipient.grant_hash) throw forbidden('Enter your code first.');
  if (await hashGrant(grant, await getPepper(ctx.db)) !== recipient.grant_hash) throw forbidden('Enter your code first.');
  const fresh = await ctx.db.prepare("SELECT datetime('now') < datetime(?, '+12 hours') AS ok")
    .bind(recipient.agreed_at).first();
  if (!fresh?.ok) throw forbidden('That was a while ago. Enter a new code to carry on.');
}

/**
 * The code is right and they agreed to sign electronically: a pass for this
 * browser. Where HIVE cannot send a code, agreeing is enough and the link
 * itself is the check.
 */
export async function signVerify(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
  if (letter.flow !== 'v2') throw badRequest('Open this link again.');
  if (['signed', 'declined'].includes(recipient.status)) throw badRequest('You have already dealt with this.');
  const body = await readJson(ctx.request);
  if (body.agreed !== true) throw badRequest('Tick the box to agree to sign electronically.');
  const needsCode = await otpRequired(ctx, recipient);
  if (needsCode) await checkOtp(ctx, recipient, body.code ?? '');

  const grant = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await ctx.db.prepare(
    `UPDATE corr_recipient SET grant_hash = ?2, agreed_at = datetime('now'),
            verified_at = CASE WHEN ?3 THEN datetime('now') ELSE verified_at END WHERE id = ?1`,
  ).bind(recipient.id, await hashGrant(grant, await getPepper(ctx.db)), needsCode ? 1 : 0).run();
  await appendEvent(ctx.db, letter.id, {
    kind: needsCode ? 'code_verified' : 'agreed', actor: recipient.name,
    detail: needsCode ? hintFor(recipient) : null, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true, grant });
}

/** A document made in three steps, opened once the code is in. */
async function openV2(ctx, token, recipient, letter) {
  await assertGrant(ctx, recipient);
  if (recipient.role !== 'copy') await assertTurn(ctx, recipient);
  if (!recipient.opened_at) {
    await ctx.db.prepare("UPDATE corr_recipient SET opened_at = datetime('now'), status = CASE WHEN status = 'pending' THEN 'opened' ELSE status END WHERE id = ?")
      .bind(recipient.id).run();
    await appendEvent(ctx.db, letter.id, {
      kind: 'opened_by_recipient', actor: recipient.name, detail: null, ip: ipOf(ctx), agent: agentOf(ctx),
    });
  }
  const recipients = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letter.id).all()).results ?? [];
  const sorted = [...recipients].sort((a, b) => a.seq - b.seq || a.id - b.id);
  const signer = sorted.findIndex((r) => r.id === recipient.id) + 1;
  const name = await property(ctx.db);
  const letterhead = letter.letterhead_id
    ? await ctx.db.prepare('SELECT * FROM corr_letterhead WHERE id = ?').bind(letter.letterhead_id).first().catch(() => null)
    : null;
  const packet = packetFor({ letter, recipients, layout: normaliseLayout(letter.layout), signer, property: name });
  return json({
    ...packet,
    doc: {
      ...packet.doc,
      letterhead: letterhead
        ? {
          image: `/api/s/${encodeURIComponent(token)}/letterhead`,
          margins: { top: letterhead.margin_top, right: letterhead.margin_right, bottom: letterhead.margin_bottom, left: letterhead.margin_left },
          laterPages: Boolean(letterhead.later_pages),
        }
        : null,
    },
    property: name,
    you: { as: 'link', signer, name: recipient.name, capacity: recipient.capacity || '', status: recipient.status, copyOnly: recipient.role === 'copy' },
    fileUrl: letter.source === 'uploaded' ? `/api/s/${encodeURIComponent(token)}/file` : null,
    expiresAt: recipient.expires_at,
  });
}

function maskEmail(address) {
  const [user, host] = String(address).split('@');
  if (!host) return '•••';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, user.length - 1))}@${host}`;
}

/**
 * The letterhead behind the letter, for whoever holds this token.
 *
 * Reachable only through the token, like everything else on this page: the
 * paper is not secret, but a public URL for it would be one more thing to
 * think about and there is nothing to gain from having one.
 */
export async function signLetterhead(ctx, token) {
  const { letter } = await recipientFor(ctx, token);
  const missing = 'There is no letterhead on this letter.';
  if (!letter.letterhead_id) throw notFound(missing);

  const row = await ctx.db.prepare(
    'SELECT f.* FROM corr_letterhead h JOIN corr_file f ON f.id = h.file_id WHERE h.id = ?',
  ).bind(letter.letterhead_id).first();
  if (!row) throw notFound(missing);

  return new Response(await wholeFile(ctx.db, row), {
    headers: {
      'Content-Type': row.mime || 'image/jpeg',
      // The same paper on every page of every letter this recipient opens.
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

/** The letter itself, for a recipient who was sent one as a file. */
export async function signFile(ctx, token) {
  const { letter, recipient } = await recipientFor(ctx, token);
  if (letter.flow === 'v2') await assertGrant(ctx, recipient);
  const missing = 'There is no file on this letter.';
  if (!letter.file_id) throw notFound(missing);

  const row = await ctx.db.prepare('SELECT * FROM corr_file WHERE id = ?').bind(letter.file_id).first();
  if (!row) throw notFound(missing);

  return new Response(await wholeFile(ctx.db, row), {
    headers: {
      'Content-Type': row.mime || 'application/pdf',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
    },
  });
}

/** Put a stored file back together out of its 700 KB rows. */
async function wholeFile(db, row) {
  const chunks = [row.content];
  for (let seq = 1; seq < Number(row.parts ?? 1); seq += 1) {
    const part = await db.prepare('SELECT content FROM corr_file_part WHERE file_id = ? AND seq = ?')
      .bind(row.id, seq).first();
    if (!part) break;
    chunks.push(part.content);
  }

  // asBytes, because D1 returns a BLOB as a plain array of numbers and an
  // ArrayBuffer check lets that straight through.
  const bytes = chunks.map((c) => asBytes(c)).filter(Boolean);
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const part of bytes) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * Send a one-time code to the address on file.
 *
 * To the address the property recorded, never to one typed in here — a link
 * that lets whoever holds it nominate where the code goes has a second factor
 * that is not a second factor.
 */
export async function signRequestCode(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
  await assertTurn(ctx, recipient);

  if (reachOf(recipient) === 'text' && letter.flow === 'v2') return textCode(ctx, recipient, letter);
  if (!recipient.email) throw badRequest('There is no email address on file for you.');

  const apiKey = ctx.env?.RESEND_API_KEY;
  const from = await setting(ctx.db, 'email_from', null);
  const senderName = await setting(ctx.db, 'email_sender_name', null);
  if (!apiKey || !from) {
    throw badRequest('This property has not set up email, so a code cannot be sent. '
      + 'Ask them to confirm who you are another way.');
  }

  // Six digits, and only one live at a time.
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const pepper = await getPepper(ctx.db);

  await ctx.db.prepare(
    `UPDATE corr_recipient SET otp_hash = ?2, otp_sent_at = datetime('now'), otp_tries = 0
      WHERE id = ?1`,
  ).bind(recipient.id, await hashPin(`corr-otp:${code}`, pepper)).run();

  const name = await property(ctx.db);
  const subject = `${code} is your code to sign ${letter.reference}`;
  // In the same design as everything else the property sends, and never
  // copied to anybody: a copy of a signing code is somebody else's signature.
  const { html } = renderMail({
    notice: {
      title: subject,
      mail: {
        subject,
        preheader: 'It lasts fifteen minutes and can be used once.',
        tone: 'info',
        status: 'Your code',
        eyebrow: 'Signing',
        headline: `Your code to sign “${letter.subject}”`,
        code: `${code.slice(0, 3)} ${code.slice(3)}`,
        facts: [['Letter', letter.subject], ['Reference', letter.reference], ['Lasts', '15 minutes, used once']],
        note: `Nobody from ${name} will ever ask you for this code. If you were not expecting `
          + 'this, ignore it. Nobody can sign anything with this code alone.',
        settingsLink: false,
        why: `You get this because you asked to sign a letter from ${name}.`,
      },
    },
    propertyName: name,
  });
  await sendEmail({
    apiKey,
    // Named like every other message the property sends. A six-digit code from
    // a bare address is the shape of every phishing mail anybody has ever had.
    from: senderWithName(from, senderNameOf({ email_sender_name: senderName })),
    to: recipient.email,
    subject,
    html,
  });

  await appendEvent(ctx.db, letter.id, {
    kind: 'code_emailed', actor: recipient.name, detail: maskEmail(recipient.email),
    ip: ipOf(ctx), agent: agentOf(ctx),
  });

  return json({ ok: true, sentTo: maskEmail(recipient.email) });
}

/** The same six digits, by text, for somebody reached on their phone. */
async function textCode(ctx, recipient, letter) {
  const phone = firstUsableNumber(recipient.phone);
  if (!phone) throw badRequest('There is no mobile number on file for you.');
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const pepper = await getPepper(ctx.db);
  await ctx.db.prepare(
    "UPDATE corr_recipient SET otp_hash = ?2, otp_sent_at = datetime('now'), otp_tries = 0 WHERE id = ?1",
  ).bind(recipient.id, await hashPin(`corr-otp:${code}`, pepper)).run();
  const out = await sendTexts(ctx.db, ctx.env, {
    kind: 'corr.sign_code',
    messages: [{ to: phone, text: `${code} is your code to sign "${letter.subject}" from ${await property(ctx.db)}. It works for 15 minutes. Nobody will ask you for it.` }],
  }).catch((err) => ({ sent: 0, reason: err.message }));
  if (!Number(out?.sent ?? 0)) throw badRequest('The code could not be texted just now. Try again in a minute.');
  await appendEvent(ctx.db, letter.id, {
    kind: 'code_emailed', actor: recipient.name, detail: maskPhone(recipient.phone), ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true, sentTo: maskPhone(recipient.phone) });
}

async function checkOtp(ctx, recipient, given) {
  if (!recipient.otp_hash) throw badRequest('Ask for a code first.');
  if (Number(recipient.otp_tries) >= 5) {
    throw forbidden('Too many wrong codes. Ask for a new one.');
  }

  const fresh = await ctx.db.prepare(
    "SELECT datetime('now') < datetime(?, '+15 minutes') AS ok",
  ).bind(recipient.otp_sent_at).first();
  if (!fresh?.ok) throw badRequest('That code has expired. Ask for another.');

  const pepper = await getPepper(ctx.db);
  if (await hashPin(`corr-otp:${String(given).trim()}`, pepper) !== recipient.otp_hash) {
    await ctx.db.prepare('UPDATE corr_recipient SET otp_tries = otp_tries + 1 WHERE id = ?')
      .bind(recipient.id).run();
    throw forbidden('That code is not right.');
  }

  await ctx.db.prepare(
    "UPDATE corr_recipient SET verified_at = datetime('now'), otp_hash = NULL WHERE id = ?",
  ).bind(recipient.id).run();
}

/**
 * Sign.
 *
 * The hash of the words is checked against the stored letter before anything
 * is accepted. If they disagree the document has been altered since it was
 * sent, and the only safe answer is to refuse — a signature on words nobody
 * can produce again is worth less than no signature at all.
 */
export async function signDocument(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
  await assertTurn(ctx, recipient);
  if (letter.flow === 'v2') return signV2(ctx, recipient, letter);

  if (recipient.status === 'signed') throw badRequest('You have already signed this.');
  if (recipient.role === 'copy') throw badRequest('You were sent this for information, not to sign.');

  const body = await readJson(ctx.request);
  if (body.agreed !== true) throw badRequest('Tick the box to agree to sign electronically.');

  if (body.otp) await checkOtp(ctx, recipient, body.otp);
  else if (await otpRequired(ctx, recipient) && !recipient.verified_at) {
    throw badRequest('Enter the six-digit code we emailed you first. Press "Email me a code" to get one.');
  }
  const verified = Boolean(body.otp || recipient.verified_at);

  const name = str(body.name, 'Your name', { required: true, max: 160 });
  const ink = str(body.ink, 'Signature', { max: 400_000 });
  if (!ink && name.trim().split(/\s+/).length < 2) {
    throw badRequest('Sign with your finger, or type your full name.');
  }

  // The words, exactly as they were shown. An uploaded letter is checked by
  // the fingerprint of the file rather than of any text.
  if (letter.source === 'composed') {
    const current = await sha256Hex(letter.body ?? '');
    if (current !== letter.body_hash || (body.hash && body.hash !== letter.body_hash)) {
      throw badRequest('This document has changed since it was sent to you. Nothing has been '
        + 'signed. Tell the sender and ask them to send it again.');
    }
  }

  await ctx.db.prepare(
    `UPDATE corr_recipient
        SET status = 'signed', signed_at = datetime('now'), signer_name = ?2,
            signature_ink = ?3, signer_ip = ?4, signer_agent = ?5, signer_check = ?6
      WHERE id = ?1 AND status <> 'signed'`,
  ).bind(
    recipient.id, name, ink || null, ipOf(ctx), agentOf(ctx),
    verified ? 'email code' : (recipient.code_hash ? 'access code' : null),
  ).run();

  await appendEvent(ctx.db, letter.id, {
    kind: 'signed',
    actor: recipient.name,
    detail: `${name} · ${ink ? 'drawn' : 'typed'}`
      + `${recipient.verified_at || body.otp ? ' · code verified' : ''}`,
    ip: ipOf(ctx),
    agent: agentOf(ctx),
  });

  const complete = await maybeComplete(ctx, letter.id);
  if (complete) {
    const { signedLetter } = await import('./signed-copies.js');
    await signedLetter(ctx, letter.id).catch((err) => console.error('Signed copy failed', err));
  }
  // The office hears, and so does whoever is next, straight away.
  await tellOffice(ctx, letter, { what: complete ? 'complete' : 'signed', who: name }).catch(() => {});
  if (!complete) await tellWhoseTurn(ctx, letter.id).catch(() => {});
  return json({ ok: true });
}

/** Fill the boxes and sign, for a document made in three steps. */
async function signV2(ctx, recipient, letter) {
  await assertGrant(ctx, recipient);
  if (recipient.status === 'signed') throw badRequest('You have already signed this.');
  if (recipient.role === 'copy') throw badRequest('You were sent this for information, not to sign.');
  const body = await readJson(ctx.request);
  const how = reachOf(recipient) === 'text' ? 'a code texted to them' : 'a code emailed to them';
  const filled = await applyRecipientSignature(ctx, {
    letter,
    recipient,
    layout: normaliseLayout(letter.layout),
    body,
    check: recipient.verified_at ? how : 'their own link',
    ip: ipOf(ctx),
    agent: agentOf(ctx),
  });
  await appendEvent(ctx.db, letter.id, {
    kind: 'signed', actor: recipient.name,
    detail: `${filled.boxes} ${filled.boxes === 1 ? 'box' : 'boxes'}`, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  const complete = await afterSignature(ctx, letter.id, recipient.name);
  const all = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letter.id).all()).results ?? [];
  const fresh = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letter.id).first();
  const turn = liveTurn(all, fresh.routing ?? 'order', fresh);
  const next = [...turn.signers.map((r) => r.name), ...(turn.property ? [await property(ctx.db)] : [])];
  return json({ ok: true, complete, next });
}

export async function signDecline(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
  if (letter.flow === 'v2') await assertGrant(ctx, recipient);
  if (recipient.status === 'signed') throw badRequest('You have already signed this.');

  const body = await readJson(ctx.request);
  const note = str(body.note, 'Reason', { max: 400 });

  await ctx.db.prepare("UPDATE corr_recipient SET status = 'declined', decline_note = ?2 WHERE id = ?1")
    .bind(recipient.id, note).run();

  await appendEvent(ctx.db, letter.id, {
    kind: 'declined', actor: recipient.name, detail: note, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  await tellOffice(ctx, letter, { what: 'declined', who: recipient.name, note }).catch(() => {});
  if (letter.flow === 'v2') {
    await tellStopped(ctx, letter, { reason: `${recipient.name} declined to sign: ${note || 'no reason given'}`, except: recipient.id }).catch(() => {});
  }
  return json({ ok: true });
}

/** When the last signer is done, the letter is signed and says so. */
async function maybeComplete(ctx, letterId) {
  const outstanding = await ctx.db.prepare(
    `SELECT COUNT(*) n FROM corr_recipient
      WHERE letter_id = ? AND role <> 'copy' AND status NOT IN ('signed', 'revoked')`,
  ).bind(letterId).first();

  if (Number(outstanding?.n ?? 0)) return false;

  await ctx.db.prepare(
    `UPDATE corr_letter SET status = 'signed', updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_signature'`,
  ).bind(letterId).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'fully_signed', actor: 'system', detail: 'Every signer has signed',
    ip: null, agent: null,
  });
  return true;
}
