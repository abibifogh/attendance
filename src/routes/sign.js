import { badRequest, forbidden, json, notFound, readJson, str } from '../lib/http.js';
import { getPepper, hashPin, throttleCheck, throttleFail } from '../lib/auth.js';
import { sendEmail } from '../lib/notify.js';
import { sha256Hex } from '../lib/files.js';
import { currentSigner } from '../lib/correspondence.js';
import { appendEvent, hashAccessCode, hashSignToken } from './correspondence.js';

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
  const others = await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(recipient.letter_id).all();
  const turn = currentSigner(others.results ?? []);

  if (turn && turn.id !== recipient.id) {
    throw forbidden(`It is not your turn yet — this is with ${turn.name} first. `
      + 'Your link will work once they have dealt with it.');
  }
  return turn;
}

async function property(db) {
  return (await setting(db, 'property_name', 'Somewhere Nice'));
}

/** Almost nothing, before anybody proves anything. */
export async function signHead(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
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
  const body = await readJson(ctx.request).catch(() => ({}));

  if (recipient.code_hash) {
    const ip = ipOf(ctx);
    const gate = throttleCheck(`corr:${ip}`);
    if (!gate.allowed) {
      throw forbidden(`Too many tries. Wait ${Math.ceil(gate.retryAfter / 60)} minutes.`);
    }

    const given = String(body.code ?? '').trim().toUpperCase();
    const pepper = await getPepper(ctx.db);
    if (!given || await hashAccessCode(given, pepper) !== recipient.code_hash) {
      throttleFail(`corr:${ip}`);
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

  return json({
    property: await property(ctx.db),
    you: { name: recipient.name, role: recipient.role, status: recipient.status },
    // An email address is never shown back in full: a forwarded link should
    // not tell whoever opens it where the code would be sent.
    emailHint: recipient.email ? maskEmail(recipient.email) : null,
    letter: {
      reference: letter.reference,
      subject: letter.subject,
      source: letter.source,
      body: letter.body,
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
  });
}

function maskEmail(address) {
  const [user, host] = String(address).split('@');
  if (!host) return '•••';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, user.length - 1))}@${host}`;
}

/** The letter itself, for a recipient who was sent one as a file. */
export async function signFile(ctx, token) {
  const { letter } = await recipientFor(ctx, token);
  if (!letter.file_id) throw notFound('There is no file on this letter.');

  const row = await ctx.db.prepare('SELECT * FROM corr_file WHERE id = ?').bind(letter.file_id).first();
  if (!row) throw notFound('There is no file on this letter.');

  const chunks = [row.content];
  for (let seq = 1; seq < Number(row.parts ?? 1); seq += 1) {
    const part = await ctx.db.prepare('SELECT content FROM corr_file_part WHERE file_id = ? AND seq = ?')
      .bind(row.id, seq).first();
    if (part) chunks.push(part.content);
  }

  const total = chunks.reduce((n, c) => n + (c?.length ?? 0), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { if (chunk) { out.set(chunk, at); at += chunk.length; } }

  return new Response(out, {
    headers: {
      'Content-Type': row.mime || 'application/pdf',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
    },
  });
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

  if (!recipient.email) throw badRequest('There is no email address on file for you.');

  const apiKey = ctx.env?.RESEND_API_KEY;
  const from = await setting(ctx.db, 'email_from', null);
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
  await sendEmail({
    apiKey,
    from,
    to: recipient.email,
    subject: `${code} is your code to sign ${letter.reference}`,
    html: `<p>Your one-time code to sign <strong>${escapeHtml(letter.subject)}</strong>`
      + ` (${escapeHtml(letter.reference)}) is:</p>`
      + `<p style="font-size:28px;letter-spacing:.3em;font-weight:700">${code}</p>`
      + '<p>It lasts fifteen minutes and can be used once.</p>'
      + `<p style="color:#666;font-size:13px">If you were not expecting this, ignore it and tell `
      + `${escapeHtml(name)}. Nobody can sign anything with this code alone.</p>`,
  });

  await appendEvent(ctx.db, letter.id, {
    kind: 'code_emailed', actor: recipient.name, detail: maskEmail(recipient.email),
    ip: ipOf(ctx), agent: agentOf(ctx),
  });

  return json({ ok: true, sentTo: maskEmail(recipient.email) });
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

  if (recipient.status === 'signed') throw badRequest('You have already signed this.');
  if (recipient.role === 'copy') throw badRequest('You were sent this for information, not to sign.');

  const body = await readJson(ctx.request);
  if (body.agreed !== true) throw badRequest('Tick the box to agree to sign electronically.');

  if (body.otp) await checkOtp(ctx, recipient, body.otp);

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
            signature_ink = ?3, signer_ip = ?4, signer_agent = ?5
      WHERE id = ?1 AND status <> 'signed'`,
  ).bind(recipient.id, name, ink || null, ipOf(ctx), agentOf(ctx)).run();

  await appendEvent(ctx.db, letter.id, {
    kind: 'signed',
    actor: recipient.name,
    detail: `${name} · ${ink ? 'drawn' : 'typed'}`
      + `${recipient.verified_at || body.otp ? ' · code verified' : ''}`,
    ip: ipOf(ctx),
    agent: agentOf(ctx),
  });

  await maybeComplete(ctx, letter.id);
  return json({ ok: true });
}

export async function signDecline(ctx, token) {
  const { recipient, letter } = await recipientFor(ctx, token);
  if (recipient.status === 'signed') throw badRequest('You have already signed this.');

  const body = await readJson(ctx.request);
  const note = str(body.note, 'Reason', { max: 400 });

  await ctx.db.prepare("UPDATE corr_recipient SET status = 'declined', decline_note = ?2 WHERE id = ?1")
    .bind(recipient.id, note).run();

  await appendEvent(ctx.db, letter.id, {
    kind: 'declined', actor: recipient.name, detail: note, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true });
}

/** When the last signer is done, the letter is signed and says so. */
async function maybeComplete(ctx, letterId) {
  const outstanding = await ctx.db.prepare(
    `SELECT COUNT(*) n FROM corr_recipient
      WHERE letter_id = ? AND role <> 'copy' AND status NOT IN ('signed', 'revoked')`,
  ).bind(letterId).first();

  if (Number(outstanding?.n ?? 0)) return;

  await ctx.db.prepare(
    `UPDATE corr_letter SET status = 'signed', updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_signature'`,
  ).bind(letterId).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'fully_signed', actor: 'system', detail: 'Every signer has signed',
    ip: null, agent: null,
  });
}
