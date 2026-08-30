import {
  badRequest, forbidden, json, notFound, readJson, str,
} from '../lib/http.js';
import { getPepper, throttleCheck, throttleFail } from '../lib/auth.js';
import { createNotice } from '../lib/notices.js';
import { fromBase64 } from '../lib/files.js';
import { endsAt, offerable } from '../lib/recruitment.js';
import { mapLink } from '../lib/places.js';
import {
  claimSlot, hashRecPin, hashRecToken, tellPanelAboutBooking, tellPanelAboutRelease, trail,
} from './recruitment.js';
import { todayIn } from '../util/dates.js';

/**
 * The candidate's side of the link: a phone, no account, and a list of times.
 *
 * There is no email anywhere in this. The office makes a link, copies the
 * message next to it and sends it however it already talks to that person —
 * which at this property is WhatsApp. An app that insists on sending its own
 * email is an app that needs an address for somebody who applied by walking in
 * with a printed CV.
 *
 * Everything here is reachable by anybody holding the link, so the surface is
 * as small as it goes. Four things can happen — see what is being asked, pick
 * a time, confirm a phone number, send a CV — and every one of them names the
 * token in the path, so no request can act on anybody but the person the link
 * was made for.
 *
 * WHAT IT NEVER DOES IS READ ANYTHING BACK. The page is opened by whoever is
 * holding the phone. It is told the property, the job, the message the office
 * wrote, and the times that are free. It is not told what the office thinks of
 * them, what anybody scored them, who else applied, or what is already on
 * their record — and the details form starts empty for the same reason the
 * employee one does.
 */

const ipOf = (ctx) => ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
const agentOf = (ctx) => (ctx.request.headers.get('User-Agent') || '').slice(0, 300);

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key).first().catch(() => null);
  return row?.value ?? fallback;
}

/**
 * Find the invitation a link refers to, and say plainly why it will not open.
 *
 * Four different problems with four different answers. One "this link is not
 * valid" would send somebody to the wrong one, and the wrong one for a
 * candidate is giving up on the job.
 */
async function inviteFor(ctx, token) {
  const pepper = await getPepper(ctx.db);
  const invite = await ctx.db.prepare('SELECT * FROM rec_invite WHERE token_hash = ?')
    .bind(await hashRecToken(String(token ?? ''), pepper)).first();

  if (!invite) {
    throw notFound('This link does not work. Ask whoever sent it for another one.');
  }
  if (invite.revoked_at) {
    throw forbidden('This link has been cancelled. Ask whoever sent it for another one.');
  }
  const expired = await ctx.db.prepare("SELECT datetime('now') > ? AS gone")
    .bind(invite.expires_at).first();
  if (expired?.gone) {
    throw forbidden('This link has expired. Ask for a new one. Nothing you sent before is lost.');
  }

  return invite;
}

const nowIn = async (db) => {
  const timezone = await setting(db, 'timezone', 'UTC');
  const today = todayIn(timezone);
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  return { today, at: `${today}T${clock}` };
};

/**
 * What is behind the link, before anybody proves anything.
 *
 * The property's name and whether a code is needed. Somebody who found this in
 * a forwarded message learns no more than that it exists — not who it is for
 * and not what job it is about.
 */
export async function head(ctx, token) {
  const invite = await inviteFor(ctx, token);
  return json({
    property: await setting(ctx.db, 'property_name', 'Somewhere Nice'),
    needsPin: Boolean(invite.pin_hash),
  });
}

/** Open it. */
export async function open(ctx, token) {
  const invite = await inviteFor(ctx, token);
  const body = await readJson(ctx.request).catch(() => ({}));

  if (invite.pin_hash) {
    const ip = ipOf(ctx);
    const gate = throttleCheck(`rec:${ip}`);
    if (!gate.allowed) {
      throw forbidden(`Too many tries. Wait ${Math.ceil(gate.retryAfter / 60)} minutes and try again.`);
    }
    const given = String(body.pin ?? '').replace(/\D/g, '');
    const pepper = await getPepper(ctx.db);
    if (!given || await hashRecPin(given, pepper) !== invite.pin_hash) {
      throttleFail(`rec:${ip}`);
      await trail(ctx.db, {
        candidateId: invite.candidate_id, inviteId: invite.id, kind: 'link_pin_failed',
        ip, agent: agentOf(ctx),
      });
      throw forbidden('That code is not right. It is the four digits you were told.');
    }
  }

  const candidate = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?')
    .bind(invite.candidate_id).first();
  if (!candidate) throw notFound('This link points at somebody who is no longer on the system.');

  if (!invite.opened_at) {
    await ctx.db.prepare("UPDATE rec_invite SET opened_at = datetime('now') WHERE id = ?")
      .bind(invite.id).run();
    await trail(ctx.db, {
      candidateId: candidate.id, inviteId: invite.id, kind: 'link_opened',
      ip: ipOf(ctx), agent: agentOf(ctx),
    });
  }

  const role = candidate.role_id
    ? await ctx.db.prepare('SELECT * FROM rec_role WHERE id = ?').bind(candidate.role_id).first()
    : null;

  return json({
    property: await setting(ctx.db, 'property_name', 'Somewhere Nice'),
    // Their own first name, which they already know, so the page reads as
    // being for them rather than as a form.
    name: candidate.name,
    job: role ? role.title : null,
    department: role?.department ?? null,
    message: invite.message,
    expiresAt: invite.expires_at,
    wantsSlot: Boolean(invite.wants_slot),
    wantsDetails: Boolean(invite.wants_details),
    wantsCv: Boolean(invite.wants_cv),
    // What they gave the office, so they are correcting rather than retyping.
    // Their own phone number is not something this page can leak to them.
    phone: candidate.phone,
    email: candidate.email,
    chosen: await chosenBy(ctx.db, candidate.id),
    slots: invite.wants_slot ? await freeFor(ctx.db, candidate) : [],
    sent: await sentOn(ctx.db, invite.id),
  });
}

/** The time they have already taken, if any. */
async function chosenBy(db, candidateId) {
  const slot = await db.prepare(
    'SELECT * FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL ORDER BY day, starts_at',
  ).bind(candidateId).first().catch(() => null);
  if (!slot) return null;

  return {
    id: slot.id,
    day: slot.day,
    at: slot.starts_at,
    ends: endsAt(slot),
    place: slot.place,
    // The reason for asking Google at all. "The office, main building" is not
    // somewhere a candidate at the other end of Accra can navigate to; this is.
    directions: mapLink({
      placeId: slot.place_id, lat: slot.place_lat, lng: slot.place_lng, label: slot.place,
    }),
    interviewer: slot.interviewer,
  };
}

/**
 * The times this person could still take.
 *
 * Free, not cancelled, still in the future, and published either for their own
 * vacancy or for none. A link opened on Friday must not offer Tuesday morning,
 * because somebody will pick it and turn up.
 */
async function freeFor(db, candidate) {
  const { today, at } = await nowIn(db);
  const rows = await db.prepare(
    `SELECT * FROM rec_slot
      WHERE cancelled_at IS NULL AND day >= ?1
        AND (candidate_id IS NULL OR candidate_id = ?3)
        AND (role_id IS NULL OR role_id = ?2)
      ORDER BY day, starts_at LIMIT 120`,
  ).bind(today, candidate.role_id ?? -1, candidate.id).all().catch(() => ({ results: [] }));

  return offerable(rows.results ?? [], { now: at, forCandidate: candidate.id })
    .map((slot) => ({
      id: slot.id,
      day: slot.day,
      at: slot.starts_at,
      ends: endsAt(slot),
      minutes: Number(slot.minutes) || 30,
      place: slot.place,
      directions: mapLink({
        placeId: slot.place_id, lat: slot.place_lat, lng: slot.place_lng, label: slot.place,
      }),
      // Not the interviewer's name. Whoever is on the panel is the property's
      // business, and a name on the page is a name somebody looks up.
      mine: slot.candidate_id === candidate.id,
    }));
}

/** What has already come in on this link, so the page does not ask twice. */
async function sentOn(db, inviteId) {
  const files = await db.prepare(
    `SELECT f.id, f.title, f.filename, f.bytes, f.uploaded_at
       FROM rec_file f JOIN rec_invite i ON i.candidate_id = f.candidate_id
      WHERE i.id = ? AND f.uploaded_by LIKE '%their link%'
      ORDER BY f.id`,
  ).bind(inviteId).all().catch(() => ({ results: [] }));

  return (files.results ?? []).map((f) => ({
    id: f.id, filename: f.filename || f.title, bytes: Number(f.bytes), at: f.uploaded_at,
  }));
}

/**
 * Take a time.
 *
 * The whole of the race is one conditional update, shared with the office's
 * own booking so a time taken on a phone and a time taken over the counter
 * cannot both be the same half hour. Two candidates pressing at the same
 * moment: one gets it, the other is told plainly and shown the list again
 * rather than a confirmation that is not real.
 *
 * Changing their mind releases the first one. Somebody who realises on
 * Thursday that Tuesday will not work should be able to say so without ringing
 * up, which is the entire point of letting them choose.
 */
export async function choose(ctx, token) {
  const invite = await inviteFor(ctx, token);
  if (!invite.wants_slot) throw badRequest('This link is not offering interview times.');

  const candidate = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?')
    .bind(invite.candidate_id).first();
  if (!candidate) throw notFound('This link points at somebody who is no longer on the system.');

  const body = await readJson(ctx.request);
  const slotId = Number(body.slotId);
  if (!Number.isInteger(slotId) || slotId < 1) throw badRequest('Pick one of the times.');

  const slot = await ctx.db.prepare('SELECT * FROM rec_slot WHERE id = ?').bind(slotId).first();
  if (!slot || slot.cancelled_at) throw badRequest('That time is no longer being offered.');

  // Only from the list this person is actually shown. A slot number typed into
  // a request is not a way to take a time set aside for a different vacancy.
  const allowed = await freeFor(ctx.db, candidate);
  if (!allowed.some((s) => s.id === slotId)) {
    throw badRequest('That time has just been taken. Pick another one.');
  }
  if (slot.candidate_id === candidate.id) {
    return json({ ok: true, already: true, chosen: await chosenBy(ctx.db, candidate.id) });
  }

  const claimed = await claimSlot(ctx.db, {
    slotId, candidateId: candidate.id, by: 'them',
  });
  if (!claimed.ok) throw badRequest(claimed.why);

  await trail(ctx.db, {
    candidateId: candidate.id,
    inviteId: invite.id,
    kind: claimed.released ? 'slot_changed' : 'slot_taken',
    detail: `${slot.day} at ${slot.starts_at}, chosen by them`,
    ip: ipOf(ctx),
    agent: agentOf(ctx),
  });

  // The person on the panel, by name, on their own phone. A candidate choosing
  // a time is the one thing in this whole pipeline that happens without
  // anybody here doing it, and at eleven at night nobody is watching a screen.
  await tellPanelAboutBooking(ctx, slotId, { changed: Boolean(claimed.released) })
    .catch(() => {});

  // And the office in general, which is who was told before there was a panel
  // to tell.
  await createNotice(ctx.db, {
    kind: 'recruitment.booked',
    level: 'info',
    title: `${candidate.name} has taken an interview time`,
    body: `${slot.day} at ${slot.starts_at}${slot.place ? `, ${slot.place}` : ''}`
      + `${claimed.released ? ' (they changed from an earlier one)' : ''}`,
    link: `#/rec-candidate?id=${candidate.id}`,
    day: slot.day,
    actor: candidate.name,
    audience: 'rec_view',
    push: true,
    email: false,
  }, ctx).catch(() => {});

  return json({
    ok: true,
    changed: Boolean(claimed.released),
    chosen: await chosenBy(ctx.db, candidate.id),
  });
}

/**
 * Give the time back.
 *
 * A candidate who cannot make it should be able to say so. Better a free slot
 * on Tuesday than an empty chair, and better an honest one than somebody who
 * simply does not turn up.
 */
export async function release(ctx, token) {
  const invite = await inviteFor(ctx, token);
  const candidate = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?')
    .bind(invite.candidate_id).first();
  if (!candidate) throw notFound('This link points at somebody who is no longer on the system.');

  const held = await ctx.db.prepare(
    'SELECT * FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL',
  ).bind(candidate.id).first().catch(() => null);
  if (!held) return json({ ok: true, chosen: null });

  await ctx.db.prepare(
    'UPDATE rec_slot SET candidate_id = NULL, taken_at = NULL, taken_by = NULL WHERE id = ?',
  ).bind(held.id).run();

  await trail(ctx.db, {
    candidateId: candidate.id, inviteId: invite.id, kind: 'slot_given_back',
    detail: `${held.day} at ${held.starts_at}`, ip: ipOf(ctx), agent: agentOf(ctx),
  });

  await tellPanelAboutRelease(ctx, held, candidate.name).catch(() => {});

  await createNotice(ctx.db, {
    kind: 'recruitment.released',
    level: 'warn',
    title: `${candidate.name} has given back their interview time`,
    body: `${held.day} at ${held.starts_at} is free again. They have not picked another one yet.`,
    link: `#/rec-candidate?id=${candidate.id}`,
    day: held.day,
    actor: candidate.name,
    audience: 'rec_view',
    push: true,
    email: false,
  }, ctx).catch(() => {});

  return json({ ok: true, chosen: null, slots: await freeFor(ctx.db, candidate) });
}

/**
 * Correct a phone number or an email.
 *
 * This is the one place in the app where what somebody sends goes straight
 * onto the record rather than waiting to be accepted, and it is worth saying
 * why. A candidate record is a name and a way of ringing them, typed off a
 * scrap of paper by whoever took the application. There is nothing there to
 * protect and nothing to overwrite that was ever more reliable than what the
 * person themselves says. The trail keeps what it was.
 */
export async function details(ctx, token) {
  const invite = await inviteFor(ctx, token);
  if (!invite.wants_details) throw badRequest('This link is not asking for your details.');

  const candidate = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?')
    .bind(invite.candidate_id).first();
  if (!candidate) throw notFound('This link points at somebody who is no longer on the system.');

  const body = await readJson(ctx.request);
  const phone = str(body.phone, 'Phone', { max: 40 });
  const email = str(body.email, 'Email', { max: 160 });
  if (!phone && !email) throw badRequest('Put in a phone number or an email address.');

  // Blank is never a delete, exactly as on the employee form. Somebody who
  // fills in a number and leaves the email box alone is not asking for the
  // email on file to be erased.
  await ctx.db.prepare(
    `UPDATE rec_candidate
        SET phone = COALESCE(?2, phone), email = COALESCE(?3, email),
            updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(candidate.id, phone || null, email || null).run();

  const changed = [
    phone && phone !== candidate.phone ? `phone ${candidate.phone || 'blank'} → ${phone}` : null,
    email && email !== candidate.email ? `email ${candidate.email || 'blank'} → ${email}` : null,
  ].filter(Boolean);

  await trail(ctx.db, {
    candidateId: candidate.id, inviteId: invite.id, kind: 'details_sent',
    detail: changed.join('; ') || 'Confirmed what we had',
    ip: ipOf(ctx), agent: agentOf(ctx),
  });

  return json({ ok: true, changed: changed.length });
}

const ACCEPTED = ['image/', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_UPLOAD = 12_000_000;

/**
 * Send a CV, photographed or attached.
 *
 * Most people applying here have a printed CV and a phone camera, not a PDF in
 * a folder, so a photograph counts and the wording says so.
 */
export async function file(ctx, token) {
  const invite = await inviteFor(ctx, token);
  if (!invite.wants_cv) throw badRequest('This link is not asking for a CV.');

  const candidate = await ctx.db.prepare('SELECT id, name FROM rec_candidate WHERE id = ?')
    .bind(invite.candidate_id).first();
  if (!candidate) throw notFound('This link points at somebody who is no longer on the system.');

  const body = await readJson(ctx.request);
  const bytes = fromBase64(body.content);
  if (!bytes.length) throw badRequest('There was nothing in that file.');
  if (bytes.length > MAX_UPLOAD) {
    throw badRequest(`That file is ${Math.round(bytes.length / 1_000_000)} MB and the limit is `
      + `${Math.round(MAX_UPLOAD / 1_000_000)} MB. A photograph taken with the camera app is `
      + 'usually fine.');
  }
  const mime = str(body.mime, 'Type', { max: 80, fallback: 'application/octet-stream' });
  if (!ACCEPTED.some((ok) => mime.startsWith(ok))) {
    throw badRequest('Send a photograph, a PDF or a Word document.');
  }

  const created = await ctx.db.prepare(
    `INSERT INTO rec_file (candidate_id, kind, title, filename, mime, bytes, content, uploaded_by)
     VALUES (?1,'cv',?2,?3,?4,?5,?6,?7) RETURNING id`,
  ).bind(
    candidate.id, 'CV',
    str(body.filename, 'File name', { max: 200 }) || 'CV',
    mime, bytes.length, bytes,
    `${candidate.name} (from their link)`,
  ).first();

  await trail(ctx.db, {
    candidateId: candidate.id, inviteId: invite.id, kind: 'cv_sent',
    detail: `${Math.round(bytes.length / 1000)} KB`, ip: ipOf(ctx), agent: agentOf(ctx),
  });

  return json({ ok: true, id: created.id });
}
