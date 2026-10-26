import {
  badRequest, bool, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { getPepper, hashPin, throttleCheck, throttleFail } from '../lib/auth.js';
import { allows } from '../lib/permissions.js';
import { createNotice } from '../lib/notices.js';
import {
  emailPersonally, firstUsableEmail, isEmail, sendEmail, senderNameOf, senderWithName,
} from '../lib/notify.js';
import { firstUsableNumber, sendTexts, smsSetup } from '../lib/sms.js';
import { firstName, renderMail, sayDate } from '../lib/email-design.js';
import { ASKED_PLACEHOLDERS, hashBody, placeholdersIn, renderTemplate } from '../lib/people.js';
import { siteOrigin } from '../lib/site.js';
import { seal, unseal } from '../lib/seal.js';
import {
  blockText, detailValues, readKeys, rowsFor,
} from '../lib/particulars.js';
import {
  companyNames, coverOf, employerAddress, employerName, logoResponse,
} from './people.js';
import { trail } from './recruitment.js';

/**
 * A job offer, with the contract that goes with it.
 *
 * The office fills in the job, the start date and the terms, and HIVE renders
 * the contract from a template there and then. From that moment the words are
 * fixed: the hash is kept beside them, and the candidate signs those words and
 * no others. They read it on their phone from a link of their own, and accept
 * by signing it (with a code sent to their own email or phone first, where one
 * can reach them), or decline with a reason.
 *
 * NOTHING HERE PUTS ANYBODY ON THE BOOKS. A candidate is not a member of
 * staff, and the contract they sign waits on the offer until somebody presses
 * Take them on. That press (`hire` in recruitment.js) carries it onto their new
 * record as a signed contract, with the same trail behind it, and countersigns
 * it for the property where the person pressing it says so.
 *
 * The candidate's side is reachable by anybody holding the link, so it reads
 * back only what the offer itself says: the job, the terms, the contract and
 * the property's name. Never the scores, the notes or anybody else's offer.
 */

export const LINK_PURPOSE = 'rec-offer-link';
const hashOfferToken = (token, pepper) => hashPin(`rec-offer:${token}`, pepper);

const ipOf = (ctx) => ctx.request?.headers?.get('CF-Connecting-IP') || 'unknown';
const agentOf = (ctx) => (ctx.request?.headers?.get('User-Agent') || '').slice(0, 300);
const actorOf = (ctx) => (ctx.session?.user
  ? `${ctx.session.user.name} (${ctx.session.user.role})`
  : null);
/** "Efua (admin)" as the candidate should read it: "Efua". */
const plainName = (actor) => String(actor ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim() || null;

/** What an offer is reaching for, by the person who has to answer it. */
export const DECLINE_REASONS = [
  ['other_job', 'I have taken another job'],
  ['terms', 'The pay or terms do not suit me'],
  ['start', 'The start date does not work'],
  ['other', 'Something else'],
];

/** Things a candidate has not told HIVE yet, said plainly in the contract until they do. */
const NOT_YET = {
  employee_no: 'to be given on joining',
  address: 'the address given on joining',
  id_type: 'the identity document given on joining',
};

async function settingsOf(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
  return Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
    .bind(actorOf(ctx), action, entity == null ? null : String(entity), detail ? JSON.stringify(detail) : null)
    .run().catch(() => {});
}

/** Where an offer stands, with an open one past its date said as expired. */
export function stateOf(offer, now = new Date().toISOString().replace('T', ' ').slice(0, 19)) {
  if (offer.status === 'sent' && String(offer.expires_at) < now) return 'expired';
  return offer.status;
}

const readDay = (value, label) => {
  const day = str(value, label, { max: 10 });
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest(`${label} must be a date.`);
  return day;
};

async function candidateOr404(db, id) {
  const row = await db.prepare('SELECT * FROM rec_candidate WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such candidate.');
  return row;
}

async function offerOr404(db, id) {
  const row = await db.prepare('SELECT * FROM rec_offer WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such offer.');
  return row;
}

/** The offer as the office sees it on the candidate's page. */
export function shapeOffer(offer, { now } = {}) {
  const fields = (() => { try { return JSON.parse(offer.fields || '{}'); } catch { return {}; } })();
  return {
    id: offer.id,
    state: stateOf(offer, now),
    title: offer.title,
    jobTitle: offer.job_title,
    department: offer.department,
    startDate: offer.start_date,
    employeeNo: offer.employee_no,
    salary: fields.salary || null,
    probation: fields.probation || null,
    notice: fields.notice || null,
    message: offer.message,
    sentBy: offer.sent_by,
    expiresAt: offer.expires_at,
    createdBy: offer.created_by,
    createdAt: offer.created_at,
    openedAt: offer.opened_at,
    remindedAt: offer.reminded_at,
    signedAt: offer.signed_at,
    signerName: offer.signer_name,
    signerCheck: offer.signer_check,
    declinedAt: offer.declined_at,
    declineReason: DECLINE_REASONS.find(([k]) => k === offer.decline_reason)?.[1] ?? offer.decline_reason,
    declineNote: offer.decline_note,
    withdrawnAt: offer.withdrawn_at,
    withdrawnBy: offer.withdrawn_by,
    contractId: offer.contract_id,
    companyId: Number(offer.company_id) || null,
  };
}

export async function offersFor(db, candidateId) {
  const rows = await db.prepare('SELECT * FROM rec_offer WHERE candidate_id = ? ORDER BY id DESC')
    .bind(candidateId).all().catch(() => ({ results: [] }));
  return (rows.results ?? []).map((o) => shapeOffer(o));
}

/** The accepted offer still waiting to be carried onto a staff record, if any. */
export async function acceptedOffer(db, candidateId) {
  return db.prepare(
    `SELECT * FROM rec_offer WHERE candidate_id = ? AND status = 'accepted' AND contract_id IS NULL
      ORDER BY id DESC LIMIT 1`,
  ).bind(candidateId).first().catch(() => null);
}

// ---------------------------------------------------------------------------
// Making the offer
// ---------------------------------------------------------------------------

/**
 * The contract, rendered for somebody who is not on the staff list yet.
 *
 * The same placeholders as a contract issued from a record, filled from what
 * the offer says and what the settings say. What nobody knows yet (their
 * staff number unless one is given, their address, their ID) is said in words
 * rather than left as a gap.
 */
async function renderFor(ctx, candidate, input) {
  const template = await ctx.db.prepare('SELECT * FROM hr_template WHERE id = ? AND active = 1')
    .bind(int(input.templateId, 'Contract', { required: true, min: 1 })).first();
  if (!template) throw badRequest('Choose a contract template.');

  const settings = await settingsOf(ctx.db);
  const leaveDays = Number(settings.att_leave_days ?? 15) || 15;
  const values = {
    name: candidate.name,
    first_name: firstName(candidate.name),
    employee_no: str(input.employeeNo, 'Employee number', { max: 40 }) || NOT_YET.employee_no,
    job_title: str(input.jobTitle, 'Job title', { required: true, max: 80 }),
    department: str(input.department, 'Department', { max: 80 }) || '',
    start_date: readDay(input.startDate, 'Start date'),
    address: str(input.address, 'Home address', { max: 300 }) || NOT_YET.address,
    id_type: str(input.idType, 'ID document', { max: 120 }) || NOT_YET.id_type,
    property: settings.property_name || 'Somewhere Nice',
    property_address: settings.property_address || '',
    // The company the template is for makes the offer; one for every
    // company is the main one's.
    company_legal_name: await employerName(ctx.db, { company_id: template.company_id }),
    company_address: await employerAddress(ctx.db, { company_id: template.company_id }),
    leave_days: `${Math.max(15, leaveDays)} working days`,
    today: new Date().toISOString().slice(0, 10),
  };
  if (!values.start_date) throw badRequest('Say when they start.');
  const given = input.values && typeof input.values === 'object' ? input.values : {};
  for (const asked of ASKED_PLACEHOLDERS) {
    values[asked.key] = str(given[asked.key], asked.label, { max: 300 }) || asked.fallback || '';
  }
  // The template's particulars box, with only the work details: a candidate
  // has no record yet, and a box full of "to be given" says nothing.
  const work = ['name', 'employee_no', 'job_title', 'department', 'start_date'];
  const keys = readKeys(template.particulars).filter((k) => work.includes(k));
  const rows = keys.length
    ? rowsFor(keys, await detailValues(ctx.db, null, {
      name: candidate.name,
      employee_no: str(input.employeeNo, 'Employee number', { max: 40 }) || null,
      job_title: values.job_title,
      department: values.department || null,
      start_date: values.start_date,
    }))
    : [];
  const body = blockText(rows) + renderTemplate(template.body, values);
  return { template, values, body, hash: await hashBody(body) };
}

/** What the Make an offer form needs: the templates, what each asks, and sensible starting values. */
export async function offerSetup(ctx, id) {
  const candidate = await candidateOr404(ctx.db, id);
  const role = candidate.role_id
    ? await ctx.db.prepare('SELECT * FROM rec_role WHERE id = ?').bind(candidate.role_id).first().catch(() => null)
    : null;
  const templates = await ctx.db.prepare(
    // The permanent contract first, as the one most offers go out on.
    `SELECT id, name, kind, body, company_id FROM hr_template WHERE active = 1 AND kind = 'contract'
      ORDER BY code = 'contract_permanent' DESC, code = 'contract_hotel' DESC, name`,
  ).all().catch(() => ({ results: [] }));
  const settings = await settingsOf(ctx.db);
  const email = isEmail(String(candidate.email ?? '').trim()) ? candidate.email.trim() : null;
  const phone = firstUsableNumber(candidate.phone) ? candidate.phone : null;
  return json({
    candidate: { id: candidate.id, name: candidate.name, email, phone, stage: candidate.stage },
    defaults: {
      jobTitle: role?.title ?? '',
      department: role?.department ?? '',
      days: 7,
      sendBy: email ? 'email' : phone ? 'text' : 'link',
    },
    templates: (templates.results ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      companyId: Number(t.company_id) || null,
      uses: placeholdersIn(t.body).map((p) => p.key),
    })),
    companies: await companyNames(ctx.db),
    asked: ASKED_PLACEHOLDERS.map(({ key, label, fallback }) => ({ key, label, fallback: fallback ?? null })),
    reach: {
      email: Boolean(email && ctx.env?.RESEND_API_KEY && String(settings.email_from ?? '').trim()),
      text: Boolean(phone && smsSetup(settings, ctx.env).ready),
    },
    canMake: allows('rec_manage', ctx.session.permissions),
  });
}

/** The contract as it would go, before anything is sent. */
export async function previewOffer(ctx, id) {
  const candidate = await candidateOr404(ctx.db, id);
  const body = await readJson(ctx.request);
  const out = await renderFor(ctx, candidate, body);
  return json({ title: out.template.name, body: out.body });
}

/**
 * Make the offer and send it.
 *
 * An offer still waiting for an answer is withdrawn by a new one, so the
 * candidate never holds two links with two sets of terms. One they have
 * already accepted cannot be replaced: that is a signed contract, and it is
 * carried on when they are taken on.
 */
export async function makeOffer(ctx, id) {
  const candidate = await candidateOr404(ctx.db, id);
  if (candidate.staff_id) throw badRequest(`${candidate.name} is already on the books.`);
  if (await acceptedOffer(ctx.db, candidate.id)) {
    throw badRequest(`${firstName(candidate.name)} has already accepted an offer. Take them on to carry the signed contract across.`);
  }
  const body = await readJson(ctx.request);
  const rendered = await renderFor(ctx, candidate, body);
  const days = int(body.days, 'Open for', { min: 1, max: 60, fallback: 7 });
  const sendBy = ['email', 'text', 'link'].includes(body.sendBy) ? body.sendBy : 'email';
  const message = str(body.message, 'A line to them', { max: 600 });

  const live = await ctx.db.prepare("SELECT id FROM rec_offer WHERE candidate_id = ? AND status = 'sent'")
    .bind(candidate.id).all().catch(() => ({ results: [] }));
  for (const old of live.results ?? []) {
    await ctx.db.prepare(
      "UPDATE rec_offer SET status = 'withdrawn', withdrawn_at = datetime('now'), withdrawn_by = ?2 WHERE id = ?1",
    ).bind(old.id, actorOf(ctx)).run();
    await trail(ctx.db, {
      candidateId: candidate.id, offerId: old.id, kind: 'offer_withdrawn', detail: 'Replaced by a new offer', actor: actorOf(ctx),
    });
  }

  const pepper = await getPepper(ctx.db);
  const token = newToken();
  const created = await ctx.db.prepare(
    `INSERT INTO rec_offer (candidate_id, template_id, title, job_title, department, start_date, employee_no,
                            fields, message, body, body_hash, token_hash, token_box, sent_by, expires_at,
                            remind, created_by, company_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,
             date('now', ?15) || ' 23:59:59', ?16, ?17, ?18) RETURNING *`,
  ).bind(
    candidate.id, rendered.template.id,
    str(body.title, 'Title', { max: 160 }) || rendered.template.name,
    rendered.values.job_title, rendered.values.department || null, rendered.values.start_date,
    str(body.employeeNo, 'Employee number', { max: 40 }),
    JSON.stringify(rendered.values), message, rendered.body, rendered.hash,
    await hashOfferToken(token, pepper),
    await seal(token, ctx.env?.SESSION_SECRET, LINK_PURPOSE).catch(() => null),
    sendBy, `+${days} days`, bool(body.remind, true) ? 1 : 0, actorOf(ctx),
    Number(rendered.template.company_id) || null,
  ).first();

  await trail(ctx.db, {
    candidateId: candidate.id, offerId: created.id, kind: 'offer_made',
    detail: `${created.title} · ${rendered.hash.slice(0, 16)}`, actor: actorOf(ctx),
  });

  // Along the pipeline to Offered, if they were not there already.
  if (['applied', 'shortlisted', 'interview'].includes(candidate.stage)) {
    await ctx.db.prepare("UPDATE rec_candidate SET stage = 'offer', updated_at = datetime('now') WHERE id = ?")
      .bind(candidate.id).run();
    await trail(ctx.db, {
      candidateId: candidate.id, kind: 'stage', fromStage: candidate.stage, toStage: 'offer',
      detail: 'Offer made', actor: actorOf(ctx),
    });
  }

  const url = `${await siteOrigin(ctx.db, ctx.url?.origin)}/o/${token}`;
  const delivered = await deliver(ctx, { offer: created, candidate, url, how: sendBy });
  // Said as it happened: one HIVE could not send went as a link the office passed on.
  if (!delivered.sent && sendBy !== 'link') {
    await ctx.db.prepare("UPDATE rec_offer SET sent_by = 'link' WHERE id = ?").bind(created.id).run();
  }
  await audit(ctx, 'recruitment.offer_made', created.id, { candidateId: candidate.id, sent: delivered.sent });
  return json({
    ok: true,
    id: created.id,
    delivered,
    // Only for passing on by hand, when HIVE did not send it itself.
    url: delivered.sent ? null : url,
    message: delivered.sent ? null : copyText(candidate, created, url, await settingsOf(ctx.db)),
  });
}

/** What the office pastes into WhatsApp when HIVE cannot send it. */
function copyText(candidate, offer, url, settings) {
  const property = settings.property_name || 'Somewhere Nice';
  return `Hello ${firstName(candidate.name)}, ${property} would like to offer you the job of ${offer.job_title}. `
    + `Read the offer and the contract, and accept or decline, here: ${url}\n\n`
    + `Please reply by ${sayDate(String(offer.expires_at).slice(0, 10))}. The link is private to you.`;
}

/**
 * Send the offer, or a reminder of it, the way the office chose: by email,
 * by text, or not at all where they will pass the link on themselves.
 */
async function deliver(ctx, { offer, candidate, url, how, reminder = false }) {
  if (how === 'link') return { sent: false, how: 'link', reason: 'Send the link yourself.' };
  const settings = await settingsOf(ctx.db);
  const property = settings.property_name || 'Somewhere Nice';
  const first = firstName(candidate.name);
  const fields = (() => { try { return JSON.parse(offer.fields || '{}'); } catch { return {}; } })();
  const replyBy = sayDate(String(offer.expires_at).slice(0, 10));
  const kind = reminder ? 'offer_reminded' : 'offer_sent';
  const note = (detail) => trail(ctx.db, {
    candidateId: candidate.id, offerId: offer.id, kind, detail, actor: actorOf(ctx) ?? 'HIVE',
  });

  const email = String(candidate.email ?? '').trim();
  if (how === 'email' && isEmail(email)) {
    const subject = reminder
      ? `Your job offer from ${property} is open until ${replyBy}`
      : `A job offer from ${property}: ${offer.job_title}`;
    const out = await emailPersonally(ctx.db, ctx.env, {
      kind: 'recruitment.offer',
      level: 'info',
      title: subject,
      body: reminder ? 'A reminder of your job offer.' : `We would like to offer you the job, ${first}.`,
      link: url,
      to: email,
      wanted: true,
      mail: {
        subject,
        preheader: `${offer.job_title}, starting ${sayDate(offer.start_date)}. Please reply by ${replyBy}.`,
        status: reminder ? 'Reminder' : 'Job offer',
        tone: reminder ? 'warn' : 'good',
        eyebrow: 'Hiring',
        headline: reminder ? `Your offer is open until ${replyBy}` : `We would like to offer you the job, ${first}`,
        intro: reminder
          ? `${property} is waiting to hear from you about the job of ${offer.job_title}.`
          : null,
        panel: !reminder && offer.message
          ? { label: plainName(offer.created_by) ? `From ${plainName(offer.created_by)}` : 'A note', text: offer.message }
          : null,
        facts: [
          ['Job', offer.job_title],
          ['Starts', sayDate(offer.start_date)],
          fields.salary ? ['Pay', fields.salary] : null,
          fields.probation ? ['Probation', fields.probation] : null,
          ['Please reply by', replyBy, { strong: true }],
        ].filter(Boolean),
        button: 'Read the offer and contract',
        after: 'The contract is there to read in full before you decide. You accept by signing it on your phone; '
          + 'a six-digit code is sent to you first, so only you can sign. If it is not for you, you can say so on the same page.',
        why: `You get this because you interviewed with ${property}. This link is yours alone. There is no attachment to open.`,
        settingsLink: false,
      },
    }).catch((err) => ({ sent: 0, reason: err.message }));
    if (Number(out?.sent ?? 0) > 0) {
      await note(`by email to ${email}`);
      return { sent: true, how: 'email', to: email };
    }
    if (!firstUsableNumber(candidate.phone)) return { sent: false, how: 'email', reason: reasonFor(out?.reason, 'email') };
  }

  const phone = firstUsableNumber(candidate.phone);
  if (!phone) return { sent: false, how, reason: 'They have no email address or mobile number on file.' };
  const text = reminder
    ? `${property}: your job offer (${offer.job_title}) is open until ${replyBy}. Read it and reply here: ${url}`
    : `${property} would like to offer you the job of ${offer.job_title}, starting ${sayDate(offer.start_date)}. `
      + `Read the offer and contract, and reply by ${replyBy}: ${url}`;
  const out = await sendTexts(ctx.db, ctx.env, { kind: 'recruitment.offer', messages: [{ to: phone, text }] })
    .catch((err) => ({ sent: 0, reason: err.message }));
  if (Number(out?.sent ?? 0) > 0) {
    await note(`by text to ${candidate.phone}`);
    return { sent: true, how: 'text', to: candidate.phone };
  }
  return { sent: false, how: 'text', reason: reasonFor(out?.reason, 'text') };
}

function reasonFor(reason, how) {
  const r = String(reason ?? '');
  if (/not configured|not set up|switched off$/.test(r)) {
    return how === 'email' ? 'Email is not set up yet, so nothing was sent.' : 'Texts are not set up yet, so nothing was sent.';
  }
  if (/switched off for this kind/.test(r)) return 'These messages are switched off under Notifications.';
  if (/no address/.test(r)) return 'They have no email address on file.';
  return `It could not be sent (${r || 'no reason given'}).`;
}

/** Take an offer back while it is still waiting for an answer. */
export async function withdrawOffer(ctx, id) {
  const offer = await offerOr404(ctx.db, id);
  if (offer.status !== 'sent') throw badRequest('Only an offer still waiting for an answer can be withdrawn.');
  const body = await readJson(ctx.request).catch(() => ({}));
  await ctx.db.prepare(
    "UPDATE rec_offer SET status = 'withdrawn', withdrawn_at = datetime('now'), withdrawn_by = ?2 WHERE id = ?1",
  ).bind(offer.id, actorOf(ctx)).run();
  await trail(ctx.db, {
    candidateId: offer.candidate_id, offerId: offer.id, kind: 'offer_withdrawn',
    detail: str(body.note, 'Reason', { max: 300 }), actor: actorOf(ctx),
  });
  await audit(ctx, 'recruitment.offer_withdrawn', offer.id, null);
  return json({ ok: true });
}

/**
 * Send it again, by email, by text or as a link to copy. An offer past its
 * date is opened again for as many days as asked (seven unless said).
 */
export async function resendOffer(ctx, id) {
  const offer = await offerOr404(ctx.db, id);
  if (offer.status !== 'sent') throw badRequest('That offer is no longer waiting for an answer.');
  const candidate = await candidateOr404(ctx.db, offer.candidate_id);
  const body = await readJson(ctx.request).catch(() => ({}));
  const token = await unseal(offer.token_box, ctx.env?.SESSION_SECRET, LINK_PURPOSE);
  if (!token) throw badRequest('This offer’s link cannot be read back. Make the offer again to send a new one.');

  let current = offer;
  if (stateOf(offer) === 'expired' || body.days) {
    const days = int(body.days, 'Open for', { min: 1, max: 60, fallback: 7 });
    current = await ctx.db.prepare(
      "UPDATE rec_offer SET expires_at = date('now', ?2) || ' 23:59:59', reminded_at = NULL WHERE id = ?1 RETURNING *",
    ).bind(offer.id, `+${days} days`).first();
  }
  const how = ['email', 'text', 'link'].includes(body.sendBy) ? body.sendBy : (offer.sent_by || 'email');
  const url = `${await siteOrigin(ctx.db, ctx.url?.origin)}/o/${token}`;
  const delivered = await deliver(ctx, { offer: current, candidate, url, how, reminder: true });
  return json({
    ok: true,
    delivered,
    url: delivered.sent ? null : url,
    message: delivered.sent ? null : copyText(candidate, current, url, await settingsOf(ctx.db)),
  });
}

/** The offer and its contract, as the office reads it back. */
export async function readOffer(ctx, id) {
  const offer = await offerOr404(ctx.db, id);
  const events = await ctx.db.prepare(
    'SELECT kind, detail, actor, ip, at FROM rec_event WHERE offer_id = ? ORDER BY id',
  ).bind(offer.id).all().catch(() => ({ results: [] }));
  return json({
    offer: {
      ...shapeOffer(offer),
      body: offer.body,
      hash: offer.body_hash,
      intact: await hashBody(offer.body) === offer.body_hash,
      ink: offer.signature_ink,
      signerIp: offer.signer_ip,
    },
    events: events.results ?? [],
  });
}

// ---------------------------------------------------------------------------
// Taking them on
// ---------------------------------------------------------------------------

const CARRIED = {
  offer_made: 'offer_made', offer_sent: 'offer_sent', offer_reminded: 'offer_reminded',
  offer_opened: 'offer_opened', offer_code: 'code_sent', offer_accepted: 'signed',
};

/**
 * The signed contract from an accepted offer, onto the new staff record.
 *
 * It arrives signed, with the words, the hash and the signature exactly as
 * they were, and the events behind it copied with their own times, so the
 * chain from "offered" to "signed" reads the same on the record as it did in
 * recruitment.
 */
export async function carryOffer(ctx, offer, staffId) {
  const template = offer.template_id
    ? await ctx.db.prepare('SELECT satisfies FROM hr_template WHERE id = ?').bind(offer.template_id).first().catch(() => null)
    : null;
  const contract = await ctx.db.prepare(
    `INSERT INTO hr_contract (staff_id, template_id, title, body, body_hash, status, fields, satisfies,
                              issued_by, issued_at, opened_at, signed_at, signer_name, signature_ink,
                              signer_ip, signer_agent, signer_check)
     VALUES (?1,?2,?3,?4,?5,'signed',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) RETURNING *`,
  ).bind(
    staffId, offer.template_id, offer.title, offer.body, offer.body_hash, offer.fields,
    template?.satisfies ?? 'contract', offer.created_by, offer.created_at, offer.opened_at, offer.signed_at,
    offer.signer_name, offer.signature_ink, offer.signer_ip, offer.signer_agent, offer.signer_check,
  ).first();

  const events = await ctx.db.prepare('SELECT * FROM rec_event WHERE offer_id = ? ORDER BY id')
    .bind(offer.id).all().catch(() => ({ results: [] }));
  for (const e of events.results ?? []) {
    if (!CARRIED[e.kind]) continue;
    await ctx.db.prepare(
      `INSERT INTO hr_event (staff_id, contract_id, kind, detail, ip, agent, at_utc)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(staffId, contract.id, CARRIED[e.kind], e.detail, e.ip, e.agent, e.at).run().catch(() => {});
  }
  await ctx.db.prepare('UPDATE rec_offer SET contract_id = ?2 WHERE id = ?1').bind(offer.id, contract.id).run();
  return contract;
}

/** Their copy, signed by both sides, by email, once the property has countersigned. */
export async function sendSignedCopy(ctx, { email, name, copy }) {
  if (!copy?.bytes || !isEmail(String(email ?? '').trim())) return { sent: false };
  const settings = await settingsOf(ctx.db);
  const property = settings.property_name || 'Somewhere Nice';
  let binary = '';
  for (let i = 0; i < copy.bytes.length; i += 0x8000) binary += String.fromCharCode(...copy.bytes.subarray(i, i + 0x8000));
  const out = await emailPersonally(ctx.db, ctx.env, {
    kind: 'recruitment.offer',
    title: `Your signed contract with ${property}`,
    body: 'Signed by you and by the property.',
    to: String(email).trim(),
    wanted: true,
    attachments: [{ filename: copy.filename || 'Signed contract.pdf', content: btoa(binary) }],
    mail: {
      subject: `Your signed contract with ${property}`,
      preheader: 'Signed by both sides. Keep it somewhere safe.',
      status: 'Signed',
      tone: 'good',
      eyebrow: 'Hiring',
      headline: `Welcome to ${property}, ${firstName(name)}`,
      intro: `Your contract is now signed by both you and ${property}. The signed copy is attached, with a certificate `
        + 'of signature on its last page.',
      after: 'Anybody can check a copy is genuine at /verify by dropping the PDF onto that page.',
      why: `You get this because you accepted a job offer from ${property}.`,
      settingsLink: false,
    },
  }).catch(() => ({ sent: 0 }));
  return { sent: Number(out?.sent ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/**
 * Two days before an offer runs out, the candidate is reminded once, where
 * the office ticked the reminder and HIVE sent the offer itself. Only between
 * nine and eight, local time.
 */
export async function watchOffers(db, { timezone = 'UTC', ctx = {} } = {}) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false })
    .format(new Date()));
  if (hour < 9 || hour >= 20) return { reminded: 0 };
  const due = (await db.prepare(
    `SELECT * FROM rec_offer
      WHERE status = 'sent' AND remind = 1 AND reminded_at IS NULL AND sent_by IN ('email', 'text')
        AND expires_at > datetime('now') AND expires_at <= datetime('now', '+2 days')
        AND created_at <= datetime('now', '-1 day')`,
  ).all().catch(() => ({ results: [] }))).results ?? [];
  const sys = { db, env: ctx.env ?? {}, url: null, session: null, request: null };
  let reminded = 0;
  for (const offer of due) {
    const claim = await db.prepare("UPDATE rec_offer SET reminded_at = datetime('now') WHERE id = ? AND reminded_at IS NULL")
      .bind(offer.id).run();
    if (!Number(claim?.meta?.changes ?? 0)) continue;
    const token = await unseal(offer.token_box, sys.env?.SESSION_SECRET, LINK_PURPOSE);
    const candidate = await db.prepare('SELECT * FROM rec_candidate WHERE id = ?').bind(offer.candidate_id).first();
    if (!token || !candidate) continue;
    const url = `${await siteOrigin(db, '')}/o/${token}`;
    const out = await deliver(sys, { offer, candidate, url, how: offer.sent_by, reminder: true }).catch(() => ({ sent: false }));
    if (out.sent) reminded += 1;
  }
  return { reminded };
}

// ---------------------------------------------------------------------------
// The candidate's side
// ---------------------------------------------------------------------------

async function offerFor(ctx, token) {
  const pepper = await getPepper(ctx.db);
  const offer = await ctx.db.prepare('SELECT * FROM rec_offer WHERE token_hash = ?')
    .bind(await hashOfferToken(String(token ?? ''), pepper)).first();
  if (!offer) throw notFound('This link does not work. Ask whoever sent it for another one.');
  return offer;
}

/** An offer that can still be answered, or the reason it cannot, in words for the candidate. */
async function mustBeOpen(ctx, offer) {
  const settings = await settingsOf(ctx.db);
  const property = settings.property_name || 'Somewhere Nice';
  if (offer.status === 'withdrawn') throw forbidden(`This offer is no longer open. Ask ${property} if you have questions.`);
  if (offer.status === 'accepted') throw badRequest('You have already accepted this offer.');
  if (offer.status === 'declined') throw badRequest('You have already declined this offer.');
  if (stateOf(offer) === 'expired') {
    throw forbidden(`This offer was open until ${sayDate(String(offer.expires_at).slice(0, 10))}. Ask ${property} whether it still stands.`);
  }
}

/** Where a signing code can go: their own email first, then a text to their phone. */
async function codeRouteFor(ctx, offer) {
  const settings = await settingsOf(ctx.db);
  if (settings.hr_require_otp === '0') return { required: false, settings };
  const candidate = await ctx.db.prepare('SELECT email, phone FROM rec_candidate WHERE id = ?').bind(offer.candidate_id).first();
  const email = firstUsableEmail(candidate?.email);
  if (email && ctx.env?.RESEND_API_KEY && String(settings.email_from ?? '').trim()) {
    const [user, host] = email.split('@');
    return { required: true, via: 'email', to: email, hint: `${user.slice(0, 1)}${'•'.repeat(Math.max(1, user.length - 1))}@${host}`, settings };
  }
  const phone = firstUsableNumber(candidate?.phone);
  if (phone && smsSetup(settings, ctx.env).ready) {
    return { required: true, via: 'text', to: phone, hint: `a phone ending ${String(phone).slice(-3)}`, settings };
  }
  return { required: false, settings };
}

/** Almost nothing before the page asks for it: whose offer this is and where it stands. */
export async function offerHead(ctx, token) {
  const offer = await offerFor(ctx, token);
  const settings = await settingsOf(ctx.db);
  return json({ property: settings.property_name || 'Somewhere Nice', state: stateOf(offer) });
}

/** The offer, the terms and the contract, for the person it was made to. */
export async function offerOpen(ctx, token) {
  const offer = await offerFor(ctx, token);
  const settings = await settingsOf(ctx.db);
  const property = settings.property_name || 'Somewhere Nice';
  const state = stateOf(offer);
  if (state === 'withdrawn') throw forbidden(`This offer is no longer open. Ask ${property} if you have questions.`);
  const candidate = await ctx.db.prepare('SELECT name, email FROM rec_candidate WHERE id = ?').bind(offer.candidate_id).first();

  if (!offer.opened_at && state === 'sent') {
    await ctx.db.prepare("UPDATE rec_offer SET opened_at = datetime('now') WHERE id = ? AND opened_at IS NULL").bind(offer.id).run();
    await trail(ctx.db, {
      candidateId: offer.candidate_id, offerId: offer.id, kind: 'offer_opened',
      actor: candidate?.name ?? null, ip: ipOf(ctx), agent: agentOf(ctx),
    });
  }
  const fields = (() => { try { return JSON.parse(offer.fields || '{}'); } catch { return {}; } })();
  const route = state === 'sent' ? await codeRouteFor(ctx, offer) : { required: false };
  return json({
    property,
    state,
    name: candidate?.name ?? '',
    firstName: firstName(candidate?.name),
    jobTitle: offer.job_title,
    department: offer.department,
    startDate: offer.start_date,
    replyBy: String(offer.expires_at).slice(0, 10),
    from: plainName(offer.created_by),
    message: offer.message,
    terms: [
      ['Starts', offer.start_date ? sayDate(offer.start_date) : null],
      ['Department', offer.department],
      ['Pay', fields.salary || null],
      ['Hours', fields.hours && fields.hours !== 'Hours are as set out in the published rota.' ? fields.hours : null],
      ['Probation', fields.probation || null],
      ['Notice', fields.notice || null],
      ['Ends', fields.end_date || null],
    ].filter(([, v]) => v),
    title: offer.title,
    body: offer.body,
    hash: offer.body_hash,
    signedAt: offer.signed_at,
    signerName: offer.signer_name,
    signerCheck: offer.signer_check,
    signedTo: candidate?.email && isEmail(candidate.email) ? candidate.email : null,
    declineReasons: DECLINE_REASONS.map(([key, label]) => ({ key, label })),
    signCode: route.required
      ? { required: true, hint: route.hint, verified: Boolean(offer.otp_verified_at) }
      : { required: false },
    // The contract's cover, for the company making the offer.
    cover: await coverOf(ctx.db, {
      companyId: offer.company_id,
      title: offer.title,
      name: candidate?.name ?? '',
      job: offer.job_title,
      department: offer.department,
      start: offer.start_date,
      reference: `Offer ${String(offer.id).padStart(5, '0')}`,
      issued: offer.created_at,
      employeeNo: offer.employee_no,
      offered: offer.status !== 'accepted',
    }).then((c) => ({ ...c, logoUrl: c.hasLogo ? `/api/o/${encodeURIComponent(token)}/logo` : null })).catch(() => null),
  });
}

/** The logo of the company making the offer, for the top of its contract. */
export async function offerLogo(ctx, token) {
  const offer = await offerFor(ctx, token);
  return logoResponse(ctx.db, offer.company_id);
}

/** A six-digit code to sign with, to their own email or phone. One live at a time; fifteen minutes. */
export async function offerCode(ctx, token) {
  const offer = await offerFor(ctx, token);
  await mustBeOpen(ctx, offer);
  const route = await codeRouteFor(ctx, offer);
  if (!route.required) throw badRequest('There is no email or phone to send a code to. You can sign without one.');

  const gate = await throttleCheck(ctx.db, `offercode:${offer.id}`, { pin: false });
  if (!gate.allowed) throw forbidden(`Too many codes asked for. Wait ${Math.ceil(gate.retryAfter / 60)} minutes.`);
  await throttleFail(ctx.db, `offercode:${offer.id}`, { everybody: false });

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const pepper = await getPepper(ctx.db);
  await ctx.db.prepare(
    `UPDATE rec_offer SET otp_hash = ?2, otp_sent_at = datetime('now'), otp_tries = 0, otp_sent_to = ?3 WHERE id = ?1`,
  ).bind(offer.id, await hashPin(`rec-offer-otp:${code}`, pepper), route.via).run();

  const property = route.settings.property_name || 'Somewhere Nice';
  if (route.via === 'email') {
    const subject = `${code} is your code to sign`;
    const { html } = renderMail({
      notice: {
        title: subject,
        mail: {
          subject,
          preheader: 'It lasts fifteen minutes and can be used once.',
          tone: 'info',
          status: 'Your code',
          eyebrow: 'Signing',
          headline: 'Your code to sign',
          code: `${code.slice(0, 3)} ${code.slice(3)}`,
          facts: [['Lasts', '15 minutes, used once']],
          note: `Nobody from ${property} will ever ask you for this code. If you were not expecting this, ignore it.`,
          settingsLink: false,
          why: `You get this because you asked to sign a job offer from ${property}.`,
        },
      },
      propertyName: property,
    });
    // Never copied to anybody: a copy of a signing code is somebody else's signature.
    await sendEmail({
      apiKey: ctx.env.RESEND_API_KEY,
      from: senderWithName(route.settings.email_from, senderNameOf(route.settings)),
      to: route.to,
      subject,
      html,
    });
  } else {
    const out = await sendTexts(ctx.db, ctx.env, {
      kind: 'people.sign_code',
      messages: [{ to: route.to, text: `${code} is your code to sign with ${property}. It lasts 15 minutes. Nobody will ask you for it.` }],
    });
    if (!Number(out?.sent ?? 0)) throw badRequest('The code could not be sent. Try again in a minute.');
  }
  await trail(ctx.db, {
    candidateId: offer.candidate_id, offerId: offer.id, kind: 'offer_code', detail: route.via, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true, sentTo: route.hint, via: route.via });
}

async function checkCode(ctx, offer, given) {
  if (!offer.otp_hash) throw badRequest('Ask for a code first.');
  if (Number(offer.otp_tries) >= 5) throw forbidden('Too many wrong codes. Ask for a new one.');
  const fresh = await ctx.db.prepare("SELECT datetime('now') < datetime(?, '+15 minutes') AS ok").bind(offer.otp_sent_at).first();
  if (!fresh?.ok) throw badRequest('That code has expired. Ask for another.');
  const pepper = await getPepper(ctx.db);
  if (await hashPin(`rec-offer-otp:${String(given).trim()}`, pepper) !== offer.otp_hash) {
    await ctx.db.prepare('UPDATE rec_offer SET otp_tries = otp_tries + 1 WHERE id = ?').bind(offer.id).run();
    throw forbidden('That code is not right.');
  }
  await ctx.db.prepare("UPDATE rec_offer SET otp_verified_at = datetime('now'), otp_hash = NULL WHERE id = ?").bind(offer.id).run();
}

/**
 * Accepting the offer is signing the contract.
 *
 * The words first: hashed again and compared with what was fixed when the
 * offer was made, and with what the page says it showed. If either differs,
 * nothing is signed. Then the code, where one can reach them, so a wrong code
 * changes nothing.
 */
export async function offerAccept(ctx, token) {
  const offer = await offerFor(ctx, token);
  await mustBeOpen(ctx, offer);
  const body = await readJson(ctx.request);
  if (body.agreed !== true) throw badRequest('Tick the box to say you agree to sign this electronically.');
  if (await hashBody(offer.body) !== offer.body_hash || (body.hash && body.hash !== offer.body_hash)) {
    throw badRequest('This contract has changed since it was sent to you. Nothing has been signed. Tell the office and they will send it again.');
  }

  const route = await codeRouteFor(ctx, offer);
  let check = 'offer link';
  if (route.required) {
    if (body.otp) await checkCode(ctx, offer, body.otp);
    else {
      const recent = offer.otp_verified_at
        ? await ctx.db.prepare("SELECT datetime('now') < datetime(?, '+2 hours') AS ok").bind(offer.otp_verified_at).first()
        : null;
      if (!recent?.ok) throw badRequest('Enter the six-digit code we sent you first. Press "Send me a code" to get one.');
    }
    check = `${route.via} code`;
  }

  const signerName = str(body.name, 'Your name', { required: true, max: 120 });
  const ink = str(body.ink, 'Signature', { max: 200_000 });
  if (!ink && signerName.trim().split(/\s+/).length < 2) throw badRequest('Sign with your finger, or type your full name.');

  const done = await ctx.db.prepare(
    `UPDATE rec_offer
        SET status = 'accepted', signed_at = datetime('now'), signer_name = ?2, signature_ink = ?3,
            signer_ip = ?4, signer_agent = ?5, signer_check = ?6
      WHERE id = ?1 AND status = 'sent'`,
  ).bind(offer.id, signerName, ink || null, ipOf(ctx), agentOf(ctx), check).run();
  if (!Number(done?.meta?.changes ?? 0)) throw badRequest('This offer has already been answered.');

  const candidate = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?').bind(offer.candidate_id).first();
  await trail(ctx.db, {
    candidateId: offer.candidate_id, offerId: offer.id, kind: 'offer_accepted',
    detail: `${signerName} · ${ink ? 'drawn' : 'typed'} · ${check} · ${offer.body_hash.slice(0, 16)}`,
    actor: candidate?.name ?? signerName, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  await tellOffice(ctx, offer, candidate, {
    title: `${candidate?.name ?? signerName} accepted the offer`,
    body: `They signed the contract for ${offer.job_title}. Take them on to put them on the books.`,
    level: 'info',
    status: 'Accepted',
    tone: 'good',
  });
  return json({ ok: true, signedAt: new Date().toISOString() });
}

/** Saying no is an answer too, and it is recorded like one. */
export async function offerDecline(ctx, token) {
  const offer = await offerFor(ctx, token);
  await mustBeOpen(ctx, offer);
  const body = await readJson(ctx.request).catch(() => ({}));
  const reason = DECLINE_REASONS.some(([k]) => k === body.reason) ? body.reason : null;
  const note = str(body.note, 'Anything to add', { max: 600 });

  const done = await ctx.db.prepare(
    `UPDATE rec_offer SET status = 'declined', declined_at = datetime('now'), decline_reason = ?2, decline_note = ?3
      WHERE id = ?1 AND status = 'sent'`,
  ).bind(offer.id, reason, note).run();
  if (!Number(done?.meta?.changes ?? 0)) throw badRequest('This offer has already been answered.');

  const candidate = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?').bind(offer.candidate_id).first();
  const said = [DECLINE_REASONS.find(([k]) => k === reason)?.[1], note].filter(Boolean).join(': ');
  await trail(ctx.db, {
    candidateId: offer.candidate_id, offerId: offer.id, kind: 'offer_declined', detail: said || null,
    actor: candidate?.name ?? null, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  if (candidate && !candidate.staff_id && candidate.stage !== 'declined') {
    await ctx.db.prepare(
      "UPDATE rec_candidate SET stage = 'declined', outcome = ?2, updated_at = datetime('now') WHERE id = ?1",
    ).bind(candidate.id, said || 'Declined the offer').run();
    await trail(ctx.db, {
      candidateId: candidate.id, kind: 'stage', fromStage: candidate.stage, toStage: 'declined',
      detail: 'Declined the offer', actor: candidate.name,
    });
  }
  await tellOffice(ctx, offer, candidate, {
    title: `${candidate?.name ?? 'A candidate'} declined the offer`,
    body: said ? `“${said}”` : 'No reason given.',
    level: 'warn',
    status: 'Declined',
    tone: 'warn',
  });
  return json({ ok: true });
}

async function tellOffice(ctx, offer, candidate, { title, body, level, status, tone }) {
  await createNotice(ctx.db, {
    kind: 'recruitment.offer_answer',
    level,
    title,
    body,
    link: `#/rec-candidate?id=${offer.candidate_id}`,
    actor: candidate?.name ?? 'Candidate',
    audience: 'rec_manage',
    push: true,
    email: true,
    mail: {
      status,
      tone,
      eyebrow: 'Hiring',
      headline: title,
      intro: body,
      facts: [['Job', offer.job_title], ['Starts', sayDate(offer.start_date)]],
      button: `Open ${firstName(candidate?.name)}’s page`,
      why: 'You get this because you manage recruitment.',
      subject: title,
    },
  }, ctx).catch(() => {});
}

