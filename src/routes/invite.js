import { badRequest, forbidden, json, notFound, readJson, str } from '../lib/http.js';
import { getPepper, hashPin, throttleCheck, throttleFail } from '../lib/auth.js';
import { LISTS, SECTIONS, cleanSubmission, hashBody } from '../lib/people.js';

/**
 * The other side of the link: somebody's phone, with no account and no login.
 *
 * Everything here is reachable by anybody holding the link, so the surface is
 * kept as small as it can be. Four things can happen — read what is being
 * asked, send in your details, sign something, refuse to sign something — and
 * every one of them names the token in the path, so no request can act on
 * anybody but the person the link was made for.
 *
 * Two rules run through it.
 *
 * Nothing here ever reads the record back. A link that could show what the
 * property already holds about somebody would be a link that leaks it to
 * whoever the phone was handed to; so the form starts empty and what comes
 * back is a claim, not an edit.
 *
 * And nothing here writes to the record either. Details land as a submission
 * for somebody to accept. The single exception is a signature, which is the
 * one thing on this side that is the person's own act and nobody else's to
 * confirm.
 */

const ipOf = (ctx) => ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
const agentOf = (ctx) => (ctx.request.headers.get('User-Agent') || '').slice(0, 300);

const hashInviteToken = (token, pepper) => hashPin(`hr-invite:${token}`, pepper);
const hashInvitePin = (pin, pepper) => hashPin(`hr-invite-pin:${pin}`, pepper);

async function logEvent(ctx, invite, kind, { contractId = null, detail = null } = {}) {
  await ctx.db.prepare(
    `INSERT INTO hr_event (staff_id, invite_id, contract_id, kind, detail, ip, agent)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(invite.staff_id, invite.id, contractId, kind, detail, ipOf(ctx), agentOf(ctx))
    .run().catch(() => {});
}

/**
 * Find the invite a link refers to, and say plainly why it will not open.
 *
 * The four reasons are different problems with different answers, and one
 * "this link is not valid" would send somebody to the wrong one. A link that
 * has expired needs a new link; a link that is finished needs nothing at all.
 */
async function inviteFor(ctx, token) {
  const pepper = await getPepper(ctx.db);
  const invite = await ctx.db.prepare('SELECT * FROM hr_invite WHERE token_hash = ?')
    .bind(await hashInviteToken(String(token ?? ''), pepper)).first();

  if (!invite) {
    throw notFound('This link does not work. Ask for a new one — they are quick to make.');
  }
  if (invite.revoked_at) {
    throw forbidden('This link has been cancelled. Ask for a new one.');
  }

  const expired = await ctx.db.prepare("SELECT datetime('now') > ? AS gone").bind(invite.expires_at).first();
  if (expired?.gone) {
    throw forbidden('This link has expired. Ask for a new one — nothing you sent before is lost.');
  }

  return invite;
}

async function property(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'property_name'")
    .first().catch(() => null);
  return row?.value || 'Somewhere Nice';
}

/**
 * What is behind the link, before anybody proves anything.
 *
 * Deliberately almost nothing: the property's name and whether a code is
 * needed. Somebody who found a link in a forwarded message learns no more than
 * that it exists.
 */
export async function inviteHead(ctx, token) {
  const invite = await inviteFor(ctx, token);
  return json({
    property: await property(ctx.db),
    needsPin: Boolean(invite.pin_hash),
    finished: Boolean(invite.finished_at),
  });
}

/** Open the packet. */
export async function inviteOpen(ctx, token) {
  const invite = await inviteFor(ctx, token);
  const body = await readJson(ctx.request).catch(() => ({}));

  if (invite.pin_hash) {
    const ip = ipOf(ctx);
    const gate = throttleCheck(`hr:${ip}`);
    if (!gate.allowed) {
      throw forbidden(`Too many tries. Wait ${Math.ceil(gate.retryAfter / 60)} minutes and try again.`);
    }

    const given = String(body.pin ?? '').replace(/\D/g, '');
    const pepper = await getPepper(ctx.db);
    if (!given || await hashInvitePin(given, pepper) !== invite.pin_hash) {
      throttleFail(`hr:${ip}`);
      await logEvent(ctx, invite, 'link_pin_failed');
      throw forbidden('That code is not right. It is the four digits you were told.');
    }
  }

  const person = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
    .bind(invite.staff_id).first();
  if (!person) throw notFound('This link points at somebody who is no longer on the system.');

  if (!invite.opened_at) {
    await ctx.db.prepare("UPDATE hr_invite SET opened_at = datetime('now') WHERE id = ?")
      .bind(invite.id).run();
    await logEvent(ctx, invite, 'link_opened');
  }

  const contracts = await ctx.db.prepare(
    `SELECT c.id, c.title, c.body, c.body_hash, c.status, c.signed_at, c.signer_name
       FROM hr_contract c JOIN hr_invite_contract ic ON ic.contract_id = c.id
      WHERE ic.invite_id = ? ORDER BY c.id`,
  ).bind(invite.id).all();

  // Whether they have already sent their details in on this link. Asked again
  // is fine — people remember something afterwards — but the screen should say
  // so rather than pretending nothing happened.
  const sent = await ctx.db.prepare(
    "SELECT COUNT(*) n FROM hr_submission WHERE invite_id = ? AND status <> 'rejected'",
  ).bind(invite.id).first();

  return json({
    property: await property(ctx.db),
    name: person.name,
    message: invite.message,
    wantsDetails: Boolean(invite.wants_details),
    detailsSent: Number(sent?.n ?? 0) > 0,
    expiresAt: invite.expires_at,
    // The form, described by the server, so there is exactly one definition of
    // what is asked for and it is the same one the office screen uses.
    sections: SECTIONS.map((section) => ({
      key: section.key,
      label: section.label,
      note: section.note ?? null,
      fields: section.fields.filter((f) => f.self),
    })).filter((section) => section.fields.length),
    lists: LISTS.filter((l) => l.self).map(({ key, label, columns }) => ({ key, label, columns })),
    contracts: (contracts.results ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      body: c.body,
      hash: c.body_hash,
      signed: c.status === 'signed',
      declined: c.status === 'declined',
      signedAt: c.signed_at,
      signerName: c.signer_name,
    })),
  });
}

/**
 * Send in a set of details.
 *
 * Stored exactly as it arrived and marked pending. Anything the form did not
 * offer is dropped on the way in rather than reported: a payload naming
 * `hired_on` is not somebody making a mistake, it is somebody trying it on.
 */
export async function inviteDetails(ctx, token) {
  const invite = await inviteFor(ctx, token);
  if (!invite.wants_details) throw badRequest('This link is not asking for your details.');

  const body = await readJson(ctx.request);
  const payload = cleanSubmission(body);

  const anything = Object.values(payload.profile).some((v) => v !== '')
    || Object.values(payload.lists).some((rows) => rows.length);
  if (!anything) throw badRequest('Nothing was filled in, so nothing was sent.');

  // One live submission per link. Sending again replaces the last one rather
  // than queueing a second, so the office reviews what somebody meant to send
  // and not three drafts of it.
  await ctx.db.prepare(
    "UPDATE hr_submission SET status = 'superseded' WHERE invite_id = ? AND status = 'pending'",
  ).bind(invite.id).run();

  await ctx.db.prepare(
    `INSERT INTO hr_submission (staff_id, invite_id, payload, submitted_ip)
     VALUES (?1, ?2, ?3, ?4)`,
  ).bind(invite.staff_id, invite.id, JSON.stringify(payload), ipOf(ctx)).run();

  await logEvent(ctx, invite, 'details_sent', {
    detail: `${Object.values(payload.profile).filter((v) => v !== '').length} answers`,
  });
  await maybeFinish(ctx, invite);

  return json({ ok: true });
}

/** Note that somebody has actually looked at a contract before they sign it. */
export async function inviteViewed(ctx, token) {
  const invite = await inviteFor(ctx, token);
  const body = await readJson(ctx.request).catch(() => ({}));
  const contract = await contractIn(ctx, invite, body.contractId);

  if (contract.status === 'sent') {
    await ctx.db.prepare("UPDATE hr_contract SET status = 'opened', opened_at = datetime('now') WHERE id = ?")
      .bind(contract.id).run();
    await logEvent(ctx, invite, 'contract_viewed', { contractId: contract.id });
  }
  return json({ ok: true });
}

/**
 * Sign.
 *
 * Ghana's Electronic Transactions Act 2008 gives an electronic signature the
 * same effect as a written one where it is uniquely linked to the signatory
 * and the signatory controlled it. What that means in practice is evidence,
 * and evidence is what this records: who said they were signing, that they
 * said so deliberately, when the server saw it, where it came from, and — the
 * part everything else rests on — a fingerprint of the exact words that were
 * on the screen at the time.
 *
 * The hash is checked against the stored contract before the signature is
 * accepted. If they disagree, the text has changed since it was issued and the
 * only safe thing to do is refuse.
 */
export async function inviteSign(ctx, token) {
  const invite = await inviteFor(ctx, token);
  const body = await readJson(ctx.request);
  const contract = await contractIn(ctx, invite, body.contractId);

  if (contract.status === 'signed') throw badRequest('That one is already signed.');
  if (contract.status === 'void') throw badRequest('That document has been withdrawn.');

  if (body.agreed !== true) {
    throw badRequest('Tick the box to say you agree to sign this electronically.');
  }

  const signerName = str(body.name, 'Your name', { required: true, max: 120 });
  const ink = str(body.ink, 'Signature', { max: 200_000 });
  if (!ink && signerName.trim().split(/\s+/).length < 2) {
    throw badRequest('Sign with your finger, or type your full name.');
  }

  const current = await hashBody(contract.body);
  if (current !== contract.body_hash || (body.hash && body.hash !== contract.body_hash)) {
    throw badRequest(
      'This document has changed since it was sent to you. Nothing has been signed. '
      + 'Tell the office and they will send it again.',
    );
  }

  await ctx.db.prepare(
    `UPDATE hr_contract
        SET status = 'signed', signed_at = datetime('now'), signer_name = ?2,
            signature_ink = ?3, signer_ip = ?4, signer_agent = ?5
      WHERE id = ?1 AND status <> 'signed'`,
  ).bind(contract.id, signerName, ink || null, ipOf(ctx), agentOf(ctx)).run();

  await logEvent(ctx, invite, 'signed', {
    contractId: contract.id,
    detail: `${signerName} · ${ink ? 'drawn' : 'typed'} · ${contract.body_hash.slice(0, 16)}`,
  });
  await maybeFinish(ctx, invite);

  return json({ ok: true, signedAt: new Date().toISOString() });
}

/** Refusing is a first-class answer, and it is recorded like any other. */
export async function inviteDecline(ctx, token) {
  const invite = await inviteFor(ctx, token);
  const body = await readJson(ctx.request);
  const contract = await contractIn(ctx, invite, body.contractId);

  if (contract.status === 'signed') throw badRequest('That one is already signed.');

  const note = str(body.note, 'Reason', { max: 400 });
  await ctx.db.prepare("UPDATE hr_contract SET status = 'declined', decline_note = ?2 WHERE id = ?1")
    .bind(contract.id, note).run();

  await logEvent(ctx, invite, 'declined', { contractId: contract.id, detail: note });
  return json({ ok: true });
}

async function contractIn(ctx, invite, contractId) {
  const contract = await ctx.db.prepare(
    `SELECT c.* FROM hr_contract c JOIN hr_invite_contract ic ON ic.contract_id = c.id
      WHERE ic.invite_id = ? AND c.id = ?`,
  ).bind(invite.id, Number(contractId)).first();

  if (!contract) throw notFound('That document is not part of this link.');
  return contract;
}

/** A packet with nothing outstanding is closed, which is what the office sees. */
async function maybeFinish(ctx, invite) {
  const outstanding = await ctx.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM hr_invite_contract ic JOIN hr_contract c ON c.id = ic.contract_id
         WHERE ic.invite_id = ?1 AND c.status IN ('draft','sent','opened')) contracts,
       (SELECT CASE WHEN ?2 = 0 THEN 0
                    WHEN EXISTS (SELECT 1 FROM hr_submission WHERE invite_id = ?1
                                   AND status IN ('pending','accepted')) THEN 0
                    ELSE 1 END) details`,
  ).bind(invite.id, invite.wants_details ? 1 : 0).first();

  if (Number(outstanding?.contracts ?? 0) || Number(outstanding?.details ?? 0)) return;

  await ctx.db.prepare("UPDATE hr_invite SET finished_at = datetime('now') WHERE id = ? AND finished_at IS NULL")
    .bind(invite.id).run();
}
