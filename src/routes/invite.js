import { badRequest, forbidden, json, notFound, readJson, str } from '../lib/http.js';
import { getPepper, hashPin, throttleCheck, throttleFail } from '../lib/auth.js';
import { cleanSubmission, formPlan, hashBody, unanswered } from '../lib/people.js';
import { requiredDocumentsFor } from '../lib/ghana-templates.js';
import { currentPlan, storeFile } from './people.js';
import { fromBase64 } from '../lib/files.js';

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

  // Department and job title come along because they decide which paper is
  // asked for — a food handler's certificate is only ever asked of somebody
  // who handles food. Neither is shown; both are things the person knows.
  const person = await ctx.db.prepare('SELECT id, name, department, job_title FROM att_staff WHERE id = ?')
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

  const form = formPlan(await currentPlan(ctx.db), {
    documents: requiredDocumentsFor(person, await profileOf(ctx.db, invite.staff_id)),
  });
  const attached = await attachmentsOn(ctx.db, invite.id);

  return json({
    property: await property(ctx.db),
    name: person.name,
    message: invite.message,
    wantsDetails: Boolean(invite.wants_details),
    detailsSent: Number(sent?.n ?? 0) > 0,
    expiresAt: invite.expires_at,
    // The form, described by the server, so there is exactly one definition of
    // what is asked for and it is the same one the office screen uses — now
    // including whatever the property has decided it does and does not want.
    sections: form.sections,
    lists: form.lists,
    // The paper they are holding. Which of it is asked for depends on the
    // property's plan and on the person: a food handler's certificate is only
    // ever asked of somebody who handles food.
    files: form.files.map((file) => ({
      ...file,
      attached: attached.filter((d) => d.kind === file.code).map(present),
    })),
    // Anything sent in on this link that does not answer one of the questions
    // above — a certificate for a document kind since switched off, say. Shown
    // so it can still be removed rather than becoming invisible and permanent.
    otherFiles: attached
      .filter((d) => !form.files.some((f) => f.code === d.kind))
      .map(present),
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
 * Only what decides which documents to ask for.
 *
 * Not the profile. Nothing on this side of the link ever reads a record back,
 * and "nationality" is fetched here to answer one question — whether a work
 * permit belongs on the list — rather than to be shown to anybody.
 */
async function profileOf(db, staffId) {
  const row = await db.prepare('SELECT nationality FROM hr_profile WHERE staff_id = ?')
    .bind(staffId).first().catch(() => null);
  return row ?? {};
}

/**
 * What the property already holds, as three sets of keys and nothing more.
 *
 * Used only to decide whether an insisted-on answer is genuinely missing. It
 * never leaves the server and never reaches the page: the question is "is this
 * blank on file", and the answer to that is a yes or a no, not a value.
 */
async function onFileFor(db, staffId) {
  const [profile, contacts, education, employment, documents] = await Promise.all([
    db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').bind(staffId).first().catch(() => null),
    db.prepare('SELECT 1 FROM hr_contact WHERE staff_id = ? LIMIT 1').bind(staffId).all().catch(() => ({ results: [] })),
    db.prepare('SELECT 1 FROM hr_education WHERE staff_id = ? LIMIT 1').bind(staffId).all().catch(() => ({ results: [] })),
    db.prepare('SELECT 1 FROM hr_employment WHERE staff_id = ? LIMIT 1').bind(staffId).all().catch(() => ({ results: [] })),
    db.prepare("SELECT DISTINCT kind FROM hr_document WHERE staff_id = ? AND status = 'filed'").bind(staffId).all().catch(() => ({ results: [] })),
  ]);

  return {
    profile: profile ?? {},
    lists: {
      contacts: contacts.results ?? [],
      education: education.results ?? [],
      employment: employment.results ?? [],
    },
    documents: (documents.results ?? []).map((r) => r.kind),
  };
}

/** What has already been attached on this link. */
async function attachmentsOn(db, inviteId) {
  const rows = await db.prepare(
    `SELECT id, kind, title, filename, mime, bytes, status, note, uploaded_at
       FROM hr_document
      WHERE invite_id = ? AND status <> 'rejected'
      ORDER BY id`,
  ).bind(inviteId).all().catch(() => ({ results: [] }));
  return rows.results ?? [];
}

/**
 * One attached file, as the person who sent it may see it.
 *
 * Name, size and whether anybody has looked at it yet. Not the file: this page
 * is opened by whoever is holding the phone, and being able to read back a
 * photograph of somebody's Ghana Card because you have their link is exactly
 * the leak the rest of this file is written to avoid.
 */
const present = (doc) => ({
  id: doc.id,
  filename: doc.filename || doc.title,
  bytes: doc.bytes,
  status: doc.status,
  at: doc.uploaded_at,
});

/**
 * Attach a photograph or a scan.
 *
 * The paper the person is already holding — their own card, their own
 * certificate — photographed on the device that is asking for it. Before this,
 * the only way a file reached a record was somebody sending it by WhatsApp and
 * a manager saving it out and uploading it: three steps, each of which stops
 * happening.
 *
 * It arrives as a claim, exactly like the typed answers beside it. Nothing goes
 * on the record until a colleague has looked at it, because a photograph of the
 * wrong side of a card — or of somebody else's — is precisely what a review
 * catches and a direct upload would not.
 */
export async function inviteFile(ctx, token) {
  const invite = await inviteFor(ctx, token);
  if (!invite.wants_details) throw badRequest('This link is not asking for your details.');

  const body = await readJson(ctx.request);
  const kind = str(body.kind, 'Kind', { required: true, max: 40 });

  const person = await ctx.db.prepare('SELECT id, name, department, job_title FROM att_staff WHERE id = ?')
    .bind(invite.staff_id).first();
  const form = formPlan(await currentPlan(ctx.db), {
    documents: requiredDocumentsFor(person, await profileOf(ctx.db, invite.staff_id)),
  });
  const wanted = form.files.find((f) => f.code === kind);
  // A kind this property is not asking for is refused rather than filed under
  // "other". The form not offering it is a courtesy; this is the gate.
  if (!wanted) throw badRequest('That is not something this link is asking for.');

  const bytes = fromBase64(body.content);
  if (!bytes.length) throw badRequest('There was nothing in that file.');
  if (bytes.length > MAX_UPLOAD) {
    throw badRequest(
      `That file is ${Math.round(bytes.length / 1_000_000)} MB and the limit is `
      + `${Math.round(MAX_UPLOAD / 1_000_000)} MB. A photograph taken with the camera app is `
      + 'usually fine; a scan at 200 dpi certainly is.',
    );
  }

  const mime = str(body.mime, 'Type', { max: 80, fallback: 'application/octet-stream' });
  if (!ACCEPTED.some((ok) => mime.startsWith(ok))) {
    throw badRequest('Send a photograph or a PDF.');
  }

  // One waiting file per kind per link. Sending a second is somebody replacing
  // a blurred photograph, not adding a second card, and leaving both would have
  // the office deciding which of two identical-looking files is the real one.
  const previous = await ctx.db.prepare(
    "SELECT id FROM hr_document WHERE invite_id = ? AND kind = ? AND status = 'pending'",
  ).bind(invite.id, kind).all().catch(() => ({ results: [] }));
  for (const row of previous.results ?? []) {
    await ctx.db.prepare('DELETE FROM hr_document WHERE id = ?').bind(row.id).run();
  }

  const id = await storeFile({ db: ctx.db }, invite.staff_id, {
    kind,
    title: wanted.label,
    filename: str(body.filename, 'File name', { max: 200 }),
    mime,
    bytes,
    expiresOn: null,
    status: 'pending',
    source: 'self',
    inviteId: invite.id,
    note: str(body.note, 'Note', { max: 400 }),
    by: `${person?.name ?? 'They'} (from their link)`,
  });

  await logEvent(ctx, invite, 'file_sent', { detail: `${wanted.label} — ${bytes.length} bytes` });

  return json({ ok: true, id });
}

/** Take one back off, before anybody has looked at it. */
export async function inviteFileRemove(ctx, token, id) {
  const invite = await inviteFor(ctx, token);

  const row = await ctx.db.prepare(
    'SELECT id, title, status FROM hr_document WHERE id = ? AND invite_id = ?',
  ).bind(Number(id), invite.id).first();
  if (!row) throw notFound('That file is not on this link.');
  // Once it is on the record it belongs to the property, and taking it off is
  // theirs to do. Saying so is better than a button that silently fails.
  if (row.status !== 'pending') {
    throw badRequest('That has already been looked at. Ask the office to remove it.');
  }

  await ctx.db.prepare('DELETE FROM hr_document WHERE id = ?').bind(row.id).run();
  await logEvent(ctx, invite, 'file_removed', { detail: row.title });
  return json({ ok: true });
}

/** A phone photograph, a scan, or a PDF. Nothing else has any business here. */
const ACCEPTED = ['image/', 'application/pdf'];
const MAX_UPLOAD = 12_000_000;

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

  const plan = await currentPlan(ctx.db);
  const body = await readJson(ctx.request);
  const payload = cleanSubmission(body, plan);

  const anything = Object.values(payload.profile).some((v) => v !== '')
    || Object.values(payload.lists).some((rows) => rows.length);
  if (!anything) throw badRequest('Nothing was filled in, so nothing was sent.');

  // What the property insisted on and did not get. Checked here as well as on
  // the form, because the form is a courtesy and this is the gate — and checked
  // against the record too, so somebody on their second link is not made to
  // retype an address the office already has.
  const person = await ctx.db.prepare('SELECT id, name, department, job_title FROM att_staff WHERE id = ?')
    .bind(invite.staff_id).first();
  const form = formPlan(plan, {
    documents: requiredDocumentsFor(person, await profileOf(ctx.db, invite.staff_id)),
  });
  const attached = await attachmentsOn(ctx.db, invite.id);
  const gaps = unanswered(plan, {
    profile: payload.profile,
    lists: payload.lists,
    files: form.files.map((f) => ({ ...f, attached: attached.filter((d) => d.kind === f.code) })),
  }, await onFileFor(ctx.db, invite.staff_id));

  if (gaps.length) {
    throw badRequest(
      `Still needed: ${gaps.map((g) => g.label.toLowerCase()).join(', ')}.`,
      { missing: gaps },
    );
  }

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
