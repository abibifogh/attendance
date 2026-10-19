import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { allows } from '../lib/permissions.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { isEmail } from '../lib/notify.js';
import { firstUsableNumber } from '../lib/sms.js';
import { liveTurn } from '../lib/correspondence.js';
import { FIELD_LABELS, normaliseLayout, starterLayout } from '../lib/paper.js';
import { siteOrigin } from '../lib/site.js';
import { sha256Hex } from '../lib/files.js';
import { renderTemplate } from '../lib/people.js';
import {
  appendEvent, allocateReference, bytesFrom, reauthenticate, storeFile,
} from './correspondence.js';
import {
  canReach, deliverLink, reachOf, reissueLink, sendSignedCopies, tellInHive, tellOffice,
  tellWhoseTurn, waysOut,
} from '../lib/sign-reach.js';

/**
 * Documents to sign, prepared in three steps and followed until they are done.
 *
 * 1. The document and who signs it, each with an order number: the same number
 *    signs at the same time, the next number when they have all signed. The
 *    property can take any place in the order.
 * 2. Boxes placed on the pages for each person: a signature, initials, the
 *    date, their name, what they sign as, a line of text, a tick, a stamp.
 * 3. How it goes out, and checks that have to pass before it can.
 *
 * Underneath it is a letter in the register like any other, so the signed
 * copy, the certificate, the verify page and the event chain all carry on
 * working as they did. Who signs is kept as draft rows until it is sent.
 */

const FLOW = 'v2';
const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const ipOf = (ctx) => ctx.request.headers.get('CF-Connecting-IP') || null;
const agentOf = (ctx) => (ctx.request.headers.get('User-Agent') || '').slice(0, 300) || null;
const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first().catch(() => null);
  return row?.value ?? fallback;
}

/** Inboxes more than one person reads. Whoever opens one could sign for the name on it. */
const SHARED = /^(info|admin|office|accounts?|hello|contact|enquiries|inquiries|mail|sales|support|reception|team|frontdesk|bookings|reservations|hr|finance)@/i;
export const looksShared = (email) => SHARED.test(String(email ?? '').trim());

/** Position on the list, copies included, which is what a box's signer number means. */
function positions(recipients) {
  const sorted = [...recipients].sort((a, b) => a.seq - b.seq || a.id - b.id);
  return new Map(sorted.map((r, i) => [r.id, i + 1]));
}
const idAt = (pos, n) => [...pos.entries()].find(([, p]) => p === n)?.[0] ?? null;

async function load(db, id) {
  const letter = await db.prepare(
    `SELECT l.*, f.filename file_name, f.bytes file_bytes, f.sha256 file_hash, f.mime file_mime
       FROM corr_letter l LEFT JOIN corr_file f ON f.id = l.file_id WHERE l.id = ?`,
  ).bind(Number(id)).first();
  if (!letter) throw notFound('No such document.');
  const recipients = (await db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letter.id).all()).results ?? [];
  return { letter, recipients, layout: normaliseLayout(letter.layout) };
}

const fieldsOf = (layout) => (layout?.blocks ?? []).filter((b) => b.role === 'field');

/**
 * What would make it go out wrong. `bad` stops it being sent; `warn` is worth
 * reading and does not. Worked out fresh every time, from what is saved.
 */
export function checksFor({ letter, recipients, layout, ways, property }) {
  const out = [];
  const ok = (text) => out.push({ tone: 'ok', text });
  const bad = (text) => out.push({ tone: 'bad', text });
  const warn = (text) => out.push({ tone: 'warn', text });

  if (letter.source === 'uploaded') {
    if (letter.file_id) ok('The PDF is attached.'); else bad('Upload the PDF, or make one from a template.');
  } else if (layout?.blocks?.some((b) => b.role !== 'field')) ok('The document has its words.');
  else bad('Upload the PDF, or make one from a template.');

  const pos = positions(recipients);
  const fields = fieldsOf(layout);
  const signers = recipients.filter((r) => r.role !== 'copy');
  const propertySigns = letter.property_step != null;
  if (!signers.length && !propertySigns) bad('Add at least one person to sign.');

  for (const r of signers) {
    const how = reachOf(r);
    if (how === 'staff' && !r.user_id) bad(`Choose which member of staff ${r.name} is.`);
    if (how === 'email' && !isEmail(String(r.email ?? '').trim())) bad(`${r.name} needs an email address.`);
    if (how === 'text' && !firstUsableNumber(r.phone)) bad(`${r.name} needs a mobile number.`);
  }

  const missing = [];
  for (const r of signers) {
    if (!fields.some((b) => b.signer === pos.get(r.id) && b.field === 'signature')) missing.push(r.name);
  }
  if (propertySigns && !fields.some((b) => b.signer === 0 && b.field === 'signature')) missing.push(property);
  for (const name of missing) bad(`${name} has no signature box yet.`);
  if ((signers.length || propertySigns) && !missing.length) ok('Everyone who signs has somewhere to sign.');

  const orphans = fields.filter((b) => b.signer > 0 && !signers.some((r) => pos.get(r.id) === b.signer));
  if (orphans.length) bad(`${orphans.length === 1 ? 'A box belongs' : `${orphans.length} boxes belong`} to nobody on the list. Give them to somebody, or remove them.`);
  if (!propertySigns && fields.some((b) => b.signer === 0)) bad(`There are boxes for ${property}, and ${property} is not on the list of who signs.`);

  const seen = new Map();
  let shared = false;
  for (const r of signers) {
    const key = reachOf(r) === 'text' ? firstUsableNumber(r.phone) : String(r.email ?? '').trim().toLowerCase();
    if (!key || reachOf(r) === 'staff') continue;
    if (seen.has(key)) {
      bad(`${seen.get(key)} and ${r.name} share ${key}. Each person needs their own, or one of them signs for both.`);
      shared = true;
    }
    seen.set(key, r.name);
  }
  if (signers.length > 1 && !shared) ok('Each person has their own email address or phone.');
  for (const r of signers) {
    if (reachOf(r) === 'email' && looksShared(r.email)) {
      warn(`${r.email} looks like a shared inbox. Anybody who reads it could sign as ${r.name}.`);
    }
  }

  if (propertySigns && signers.length && letter.routing !== 'all') {
    const last = Math.max(...signers.map((r) => Number(r.step ?? r.seq)));
    if (Number(letter.property_step) >= last) ok(`${property} signs last, once the others have.`);
    else warn(`${property} signs before some of the others. Usually the property signs last.`);
  }

  const outside = signers.filter((r) => reachOf(r) !== 'staff');
  if (outside.some((r) => reachOf(r) === 'email') && !ways.email) {
    warn('Email is not set up yet, so you will be given the links to pass on yourself.');
  }
  if (outside.some((r) => reachOf(r) === 'text') && !ways.text) {
    warn('Texts are not set up yet, so you will be given the links to pass on yourself.');
  }
  return out;
}

const EVENT = {
  created: (e) => `Prepared by ${who(e)}`,
  file_replaced: (e) => e.detail,
  sent_for_signature: (e) => `Sent for signature by ${who(e)}. ${e.detail ?? ''}`.trim(),
  link_sent: (e) => `Sent to ${e.detail}`,
  opened_by_recipient: (e) => `${e.actor} opened it`,
  code_emailed: (e) => `Code sent to ${e.actor} (${e.detail})`,
  code_verified: (e) => `${e.actor} entered the code sent to ${e.detail} and agreed to sign electronically`,
  agreed: (e) => `${e.actor} agreed to sign electronically`,
  signed: (e) => `${e.actor} signed${e.detail ? ` (${e.detail})` : ''}`,
  signed_internally: (e) => `Signed for the property by ${e.detail}`,
  signed_in_hive: (e) => `${e.actor} signed in HIVE${e.detail ? ` (${e.detail})` : ''}`,
  paper_signed: (e) => `${e.detail} (recorded by ${who(e)})`,
  reminder_sent: (e) => `Reminder sent to ${e.detail}`,
  address_corrected: (e) => `${who(e)} put right ${e.detail}`,
  declined: (e) => `${e.actor} declined${e.detail ? `: ${e.detail}` : ''}`,
  withdrawn: (e) => `Withdrawn by ${who(e)}${e.detail ? `: ${e.detail}` : ''}`,
  fully_signed: () => 'Completed. Everyone has signed',
  link_revoked: (e) => `${who(e)} cancelled the link for ${e.detail}`,
  edited: (e) => `Changed by ${who(e)}`,
};
function who(e) { return String(e.actor ?? '').replace(/\s*\([^)]*\)$/, '') || 'HIVE'; }
export const describeEvent = (e) => (EVENT[e.kind]?.(e) ?? `${String(e.kind).replace(/_/g, ' ')}${e.detail ? `: ${e.detail}` : ''}`);

/** Whether the person signed in may sign this now, and as whom. */
function mayISign(ctx, letter, recipients, turn) {
  const me = Number(ctx.session.user.id);
  const mine = recipients.find((r) => reachOf(r) === 'staff' && Number(r.user_id) === me);
  if (mine && turn.signers.some((r) => r.id === mine.id)) return { as: 'staff', recipient: mine };
  if (turn.property && allows('corr_sign', ctx.session.permissions)
    && (!letter.property_user_id || Number(letter.property_user_id) === me)) return { as: 'property' };
  return null;
}

/** Everything the three steps and the follow-up page need, in one answer. */
async function shape(ctx, { letter, recipients, layout }) {
  const property = await setting(ctx.db, 'property_name', 'Somewhere Nice');
  const ways = await waysOut(ctx.db, ctx.env);
  const pos = positions(recipients);
  const turn = liveTurn(recipients, letter.routing ?? 'order', letter);
  const events = (await ctx.db.prepare('SELECT * FROM corr_event WHERE letter_id = ? ORDER BY seq')
    .bind(letter.id).all()).results ?? [];
  const canWrite = allows('corr_write', ctx.session.permissions);
  const mine = mayISign(ctx, letter, recipients, turn);

  return {
    doc: {
      id: letter.id,
      reference: letter.reference,
      title: letter.subject,
      status: letter.status,
      flow: letter.flow,
      source: letter.source,
      fileId: letter.file_id,
      fileName: letter.file_name,
      fileBytes: letter.file_bytes,
      fileHash: letter.file_hash,
      bodyHash: letter.body_hash,
      inOrder: letter.routing !== 'all',
      mailSubject: letter.mail_subject,
      mailMessage: letter.mail_message,
      remindDays: letter.remind_days,
      expireDays: letter.expire_days,
      createdBy: who({ actor: letter.created_by }),
      createdAt: letter.created_at,
      expiresAt: recipients.map((r) => r.expires_at).filter(Boolean).sort().pop() ?? null,
      finalHash: letter.final_hash,
      closedNote: letter.closed_note,
      layout: letter.source === 'composed' ? layout : null,
      letterheadId: letter.letterhead_id,
    },
    signers: [
      ...recipients.map((r) => ({
        id: r.id,
        kind: reachOf(r),
        role: r.role === 'copy' ? 'copy' : 'signer',
        step: Number(r.step ?? r.seq),
        position: pos.get(r.id),
        name: r.name,
        email: r.email,
        phone: r.phone,
        capacity: r.capacity,
        userId: r.user_id,
        status: r.status,
        openedAt: r.opened_at,
        signedAt: r.signed_at,
        signerName: r.signer_name,
        signerCheck: r.signer_check,
        toldAt: r.turn_told_at,
        remindedAt: r.reminded_at,
        reminders: Number(r.reminders ?? 0),
        declineNote: r.decline_note,
        expiresAt: r.expires_at,
        yourTurn: turn.signers.some((t) => t.id === r.id),
      })),
      ...(letter.property_step != null ? [{
        id: 'property',
        kind: 'property',
        role: 'signer',
        step: Number(letter.property_step),
        name: property,
        userId: letter.property_user_id,
        capacity: letter.property_capacity,
        status: letter.signed_at ? 'signed' : (turn.property ? 'turn' : 'waiting'),
        signedAt: letter.signed_at,
        signerName: letter.signed_by,
        toldAt: letter.property_told_at,
        yourTurn: turn.property,
      }] : []),
    ],
    fields: fieldsOf(layout).map((b) => ({
      id: b.id, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h ?? 7, field: b.field,
      required: b.required !== false, ask: b.ask ?? null,
      rid: b.signer === 0 ? 'property' : idAt(pos, b.signer),
      signer: b.signer,
    })),
    checks: letter.status === 'draft' ? checksFor({ letter, recipients, layout, ways, property }) : [],
    events: events.map((e) => ({ at: e.at_utc, kind: e.kind, text: describeEvent(e) })),
    property,
    ways: { email: ways.email, text: ways.text },
    you: {
      canWrite,
      canSign: allows('corr_sign', ctx.session.permissions),
      signAs: mine?.as ?? null,
    },
    labels: FIELD_LABELS,
    defaults: {
      mailSubject: `${property}: please sign ${letter.subject}`,
      remindDays: 3,
      expireDays: 30,
    },
  };
}

/** Pick the reference series a document goes in: the house setting, or the first there is. */
async function seriesFor(db) {
  const chosen = await setting(db, 'corr_doc_series', null);
  if (chosen) return chosen;
  const adm = await db.prepare("SELECT code FROM corr_series WHERE code = 'ADM'").first().catch(() => null);
  if (adm) return adm.code;
  const any = await db.prepare('SELECT code FROM corr_series WHERE active = 1 ORDER BY code LIMIT 1').first();
  if (!any) throw badRequest('Set up a reference series under Letters first.');
  return any.code;
}

/** Start one: a PDF uploaded, or words from a template. */
export async function createDoc(ctx) {
  const body = await readJson(ctx.request);
  const title = str(body.title, 'Name', { required: true, max: 200 });
  const series = await seriesFor(ctx.db);
  const reference = await allocateReference(ctx.db, series);
  const property = await setting(ctx.db, 'property_name', 'Somewhere Nice');

  let fileId = null;
  let source = 'uploaded';
  let text = null;
  let layout = null;
  if (body.content) {
    fileId = await storeFile(ctx.db, {
      title,
      filename: str(body.filename, 'File name', { max: 200 }) || `${title}.pdf`,
      mime: str(body.mime, 'Type', { max: 80, fallback: 'application/pdf' }),
      bytes: bytesFrom(body, 'PDF'),
      actor: actorOf(ctx),
    });
    // Places the writer marked with [sign:1] and the like, found in the browser.
    layout = Array.isArray(body.fields) && body.fields.length
      ? normaliseLayout({ blocks: body.fields.slice(0, 150).map((f, i) => ({ ...f, id: `m${i + 1}`, role: 'field' })) })
      : null;
  } else if (body.templateId) {
    const template = await ctx.db.prepare("SELECT * FROM hr_template WHERE id = ? AND kind = 'correspondence'")
      .bind(Number(body.templateId)).first();
    if (!template) throw notFound('No such template.');
    source = 'composed';
    text = renderTemplate(template.body, {
      reference, today: new Date().toISOString().slice(0, 10), property, subject: title, body: '',
    });
    layout = starterLayout({
      reference,
      date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      subject: title,
      body: text,
    });
  } else {
    throw badRequest('Upload a PDF, or choose a template to make one from.');
  }

  const created = await ctx.db.prepare(
    `INSERT INTO corr_letter
       (reference, series, direction, subject, source, body, body_hash, template_id, file_id,
        status, created_by, layout, flow, routing)
     VALUES (?1, ?2, 'outgoing', ?3, ?4, ?5, ?6, ?7, ?8, 'draft', ?9, ?10, ?11, 'order') RETURNING id`,
  ).bind(
    reference, series, title, source,
    text, text ? await sha256Hex(text) : null, body.templateId ? Number(body.templateId) : null, fileId,
    actorOf(ctx), layout ? JSON.stringify(layout) : null, FLOW,
  ).first();

  await appendEvent(ctx.db, created.id, {
    kind: 'created', actor: actorOf(ctx),
    detail: `${reference} · ${source === 'uploaded' ? 'PDF uploaded' : 'made from a template'}`,
    ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true, id: created.id, reference });
}

export async function getDoc(ctx, id) {
  return json(await shape(ctx, await load(ctx.db, id)));
}

/** Who may sign for the property, and which members of staff can sign from their login. */
export async function docPeople(ctx) {
  const users = (await ctx.db.prepare(
    'SELECT id, name, email, role, staff_id FROM users WHERE active = 1 ORDER BY name',
  ).all()).results ?? [];
  const templates = (await ctx.db.prepare(
    "SELECT id, name FROM hr_template WHERE kind = 'correspondence' AND active = 1 ORDER BY name",
  ).all().catch(() => ({ results: [] }))).results ?? [];
  return json({
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
    templates,
    property: await setting(ctx.db, 'property_name', 'Somewhere Nice'),
  });
}

function draftOnly(letter) {
  if (letter.flow !== FLOW) throw badRequest('That letter is not a document made in three steps. Open it in Letters.');
  if (letter.status !== 'draft') {
    throw badRequest('It cannot be changed once sent; withdraw it and send a corrected one.');
  }
}

/** Save any part of a draft: the name, who signs, the boxes, how it goes out. */
export async function saveDoc(ctx, id) {
  const body = await readJson(ctx.request);
  let { letter, recipients, layout } = await load(ctx.db, id);
  draftOnly(letter);

  if (body.title !== undefined) {
    await ctx.db.prepare('UPDATE corr_letter SET subject = ?2 WHERE id = ?1')
      .bind(letter.id, str(body.title, 'Name', { required: true, max: 200 })).run();
  }

  if (Array.isArray(body.signers)) {
    ({ layout } = await saveSigners(ctx, letter, recipients, layout, body));
    ({ letter, recipients } = await load(ctx.db, id));
  }

  if (Array.isArray(body.fields)) {
    const pos = positions(recipients);
    const fields = body.fields.slice(0, 150).map((f, i) => {
      const signer = f.rid === 'property' ? 0 : pos.get(Number(f.rid));
      if (signer == null) return null;
      return { ...f, id: String(f.id ?? `f${i + 1}`).slice(0, 24), role: 'field', signer };
    }).filter(Boolean);
    const words = (layout?.blocks ?? []).filter((b) => b.role !== 'field');
    layout = normaliseLayout({ blocks: [...words, ...fields] }) ?? { blocks: [], pages: 1 };
    await ctx.db.prepare('UPDATE corr_letter SET layout = ?2 WHERE id = ?1')
      .bind(letter.id, JSON.stringify(layout)).run();
  }

  if (body.mailSubject !== undefined || body.mailMessage !== undefined
    || body.remindDays !== undefined || body.expireDays !== undefined) {
    await ctx.db.prepare(
      `UPDATE corr_letter SET mail_subject = ?2, mail_message = ?3, remind_days = ?4, expire_days = ?5
        WHERE id = ?1`,
    ).bind(
      letter.id,
      body.mailSubject === undefined ? letter.mail_subject : str(body.mailSubject, 'Email subject', { max: 200 }),
      body.mailMessage === undefined ? letter.mail_message : str(body.mailMessage, 'Message', { max: 2000 }),
      body.remindDays === undefined ? letter.remind_days : int(body.remindDays, 'Reminders', { min: 0, max: 14, fallback: 3 }),
      body.expireDays === undefined ? letter.expire_days : int(body.expireDays, 'Expires after', { min: 1, max: 120, fallback: 30 }),
    ).run();
  }

  await ctx.db.prepare("UPDATE corr_letter SET updated_at = datetime('now') WHERE id = ?").bind(letter.id).run();
  return getDoc(ctx, id);
}

/**
 * Who signs, in the order they were laid out. The property, if it signs, is
 * one of them; everybody else is a draft row. A box keeps following the
 * person it was placed for when somebody above them is removed.
 */
async function saveSigners(ctx, letter, recipients, layout, body) {
  const inOrder = body.inOrder !== false;
  const list = body.signers.slice(0, 12);
  const oldPos = positions(recipients);
  const known = new Map(recipients.map((r) => [r.id, r]));
  const kept = new Set();
  let property = null;
  let seq = 0;

  for (const [i, p] of list.entries()) {
    const step = inOrder ? int(p.step, 'Order', { min: 1, max: 20, fallback: i + 1 }) : 1;
    if (p.kind === 'property') {
      property = {
        step,
        userId: Number(p.userId) || null,
        capacity: str(p.capacity, 'Signs as', { max: 120 }),
      };
      continue;
    }
    seq += 1;
    const role = p.role === 'copy' ? 'copy' : 'signer';
    const reach = ['email', 'text', 'staff'].includes(p.kind) ? p.kind : 'email';
    let name = str(p.name, 'Name', { max: 160 });
    let email = str(p.email, 'Email', { max: 200 });
    let userId = null;
    if (reach === 'staff') {
      const user = p.userId
        ? await ctx.db.prepare('SELECT id, name, email FROM users WHERE id = ? AND active = 1').bind(Number(p.userId)).first()
        : null;
      if (p.userId && !user) throw badRequest('That member of staff has no login any more.');
      userId = user?.id ?? null;
      name = name || user?.name || '';
      email = user?.email || email;
    }
    if (!name) throw badRequest(`Give person ${seq} a name.`);
    const values = [
      seq, step, role, name, str(p.organisation, 'Organisation', { max: 160 }), email,
      str(p.phone, 'Phone', { max: 40 }), reach, userId, str(p.capacity, 'Signs as', { max: 120 }),
    ];
    const rid = Number(p.id);
    if (rid && known.has(rid)) {
      await ctx.db.prepare(
        `UPDATE corr_recipient SET seq = ?2, step = ?3, role = ?4, name = ?5, organisation = ?6, email = ?7,
                phone = ?8, reach = ?9, user_id = ?10, capacity = ?11 WHERE id = ?1`,
      ).bind(rid, ...values).run();
      kept.add(rid);
    } else {
      const made = await ctx.db.prepare(
        `INSERT INTO corr_recipient (letter_id, seq, step, role, name, organisation, email, phone, reach, user_id,
                                     capacity, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'draft') RETURNING id`,
      ).bind(letter.id, ...values).first();
      kept.add(made.id);
    }
  }
  for (const r of recipients) {
    if (!kept.has(r.id)) await ctx.db.prepare('DELETE FROM corr_recipient WHERE id = ?').bind(r.id).run();
  }

  await ctx.db.prepare(
    `UPDATE corr_letter SET routing = ?2, property_step = ?3, property_user_id = ?4, property_capacity = ?5
      WHERE id = ?1`,
  ).bind(letter.id, inOrder ? 'order' : 'all', property?.step ?? null, property?.userId ?? null,
    property?.capacity ?? null).run();

  // Boxes follow their person. A number nobody held before (a marker typed in
  // the PDF before anybody was added) means whoever is at that place now.
  const fresh = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letter.id).all()).results ?? [];
  const newPos = positions(fresh);
  if (layout?.blocks?.length) {
    const blocks = layout.blocks.map((b) => {
      if (b.role !== 'field') return b;
      if (b.signer === 0) return property || letter.property_step == null ? b : null;
      const was = idAt(oldPos, b.signer);
      if (!was) return b;
      return newPos.has(was) ? { ...b, signer: newPos.get(was) } : null;
    }).filter(Boolean);
    layout = normaliseLayout({ blocks }) ?? { blocks: [], pages: 1 };
    await ctx.db.prepare('UPDATE corr_letter SET layout = ?2 WHERE id = ?1').bind(letter.id, JSON.stringify(layout)).run();
  }
  return { layout };
}

/** Put a different PDF in its place. Boxes stay where they were. */
export async function replaceFile(ctx, id) {
  const body = await readJson(ctx.request);
  const { letter, layout } = await load(ctx.db, id);
  draftOnly(letter);
  const bytes = bytesFrom(body, 'PDF');
  const fileId = await storeFile(ctx.db, {
    title: letter.subject,
    filename: str(body.filename, 'File name', { max: 200 }) || `${letter.subject}.pdf`,
    mime: str(body.mime, 'Type', { max: 80, fallback: 'application/pdf' }),
    bytes,
    actor: actorOf(ctx),
  });
  let next = layout;
  if (Array.isArray(body.fields) && body.fields.length && !(layout?.blocks ?? []).some((b) => b.role === 'field')) {
    next = normaliseLayout({ blocks: body.fields.slice(0, 150).map((f, i) => ({ ...f, id: `m${i + 1}`, role: 'field' })) });
  }
  await ctx.db.prepare(
    "UPDATE corr_letter SET file_id = ?2, source = 'uploaded', layout = ?3, updated_at = datetime('now') WHERE id = ?1",
  ).bind(letter.id, fileId, next ? JSON.stringify(next) : null).run();
  await appendEvent(ctx.db, letter.id, {
    kind: 'file_replaced', actor: actorOf(ctx),
    detail: `${str(body.filename, 'File name', { max: 200 }) || 'A PDF'} uploaded${body.pages ? ` (${Number(body.pages)} pages)` : ''}`,
    ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return getDoc(ctx, id);
}

/** Throw a draft away. Only a draft: anything sent stays in the register. */
export async function deleteDoc(ctx, id) {
  const { letter } = await load(ctx.db, id);
  draftOnly(letter);
  await ctx.db.prepare('DELETE FROM corr_recipient WHERE letter_id = ?').bind(letter.id).run();
  await ctx.db.prepare('DELETE FROM corr_event WHERE letter_id = ?').bind(letter.id).run();
  await ctx.db.prepare('DELETE FROM corr_letter WHERE id = ?').bind(letter.id).run();
  return json({ ok: true });
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const hashSignToken = (token, pepper) => hashPin(`corr-sign:${token}`, pepper);
const masked = (r) => (reachOf(r) === 'text'
  ? `${r.name} (${String(r.phone ?? '').replace(/\d(?=\d{4})/g, '•')})`
  : `${r.name}${r.email ? ` (${r.email})` : ''}`);

/**
 * Send it. Every check has to pass. Each person gets a link of their own;
 * those whose turn it is are emailed or texted it now, members of staff are
 * told in HIVE, and anybody HIVE could not reach is handed back with their
 * link to pass on by hand, the one time it can be shown.
 */
export async function sendDoc(ctx, id) {
  const { letter, recipients, layout } = await load(ctx.db, id);
  draftOnly(letter);
  const ways = await waysOut(ctx.db, ctx.env);
  const property = await setting(ctx.db, 'property_name', 'Somewhere Nice');
  const stop = checksFor({ letter, recipients, layout, ways, property }).find((c) => c.tone === 'bad');
  if (stop) throw badRequest(stop.text);

  const days = Number(letter.expire_days ?? 30);
  const pepper = await getPepper(ctx.db);
  const origin = await siteOrigin(ctx.db, ctx.url?.origin);
  const links = new Map();
  for (const r of recipients) {
    const needsLink = r.role !== 'copy' && reachOf(r) !== 'staff';
    const token = needsLink ? newToken() : null;
    if (token) links.set(r.id, `${origin}/s/${token}`);
    await ctx.db.prepare(
      `UPDATE corr_recipient SET status = 'pending', token_hash = ?2, code_hash = NULL,
              expires_at = CASE WHEN ?3 = 'copy' THEN NULL ELSE datetime('now', ?4) END
        WHERE id = ?1`,
    ).bind(r.id, token ? await hashSignToken(token, pepper) : null, r.role, `+${days} days`).run();
  }
  await ctx.db.prepare(
    "UPDATE corr_letter SET status = 'awaiting_signature', updated_at = datetime('now') WHERE id = ?",
  ).bind(letter.id).run();
  await appendEvent(ctx.db, letter.id, {
    kind: 'sent_for_signature', actor: actorOf(ctx),
    detail: `Fingerprint of the document: ${letter.source === 'uploaded' ? letter.file_hash : letter.body_hash}`,
    ip: ipOf(ctx), agent: agentOf(ctx),
  });

  const fresh = await load(ctx.db, id);
  const turn = liveTurn(fresh.recipients, fresh.letter.routing ?? 'order', fresh.letter);
  const handBack = [];
  for (const r of turn.signers) {
    const url = links.get(r.id);
    if (!url) continue;
    const sent = canReach(ways, r)
      ? await deliverLink(ctx.db, ctx.env, { letter: fresh.letter, recipient: r, url, why: 'first' })
      : { sent: false };
    if (sent.sent) {
      await ctx.db.prepare("UPDATE corr_recipient SET turn_told_at = datetime('now') WHERE id = ?").bind(r.id).run();
      await appendEvent(ctx.db, letter.id, { kind: 'link_sent', actor: 'HIVE', detail: masked(r), ip: null, agent: null });
    } else {
      handBack.push({ id: r.id, name: r.name, url, how: reachOf(r) });
    }
  }
  // Members of staff and the property, told in HIVE; nobody reached twice.
  await tellWhoseTurn(ctx, letter.id);
  // Those further down the order are given their link when their turn comes,
  // or, where HIVE cannot reach them, from the follow-up page then.
  return json({ ok: true, handBack });
}

/** Send somebody whose turn it is a fresh link now, or hand it back to pass on. */
export async function remindNow(ctx, rid) {
  const r = await ctx.db.prepare('SELECT * FROM corr_recipient WHERE id = ?').bind(Number(rid)).first();
  if (!r) throw notFound('No such person on it.');
  const { letter, recipients } = await load(ctx.db, r.letter_id);
  if (letter.status !== 'awaiting_signature') throw badRequest('It is not out for signature.');
  if (!['pending', 'opened'].includes(r.status)) throw badRequest(`${r.name} has already dealt with it.`);
  const turn = liveTurn(recipients, letter.routing ?? 'order', letter);
  if (!turn.signers.some((t) => t.id === r.id)) throw badRequest(`It is not ${r.name}’s turn yet.`);

  if (reachOf(r) === 'staff') {
    await tellInHive(ctx, letter, { userId: r.user_id });
    await appendEvent(ctx.db, letter.id, { kind: 'reminder_sent', actor: actorOf(ctx), detail: r.name, ip: ipOf(ctx), agent: agentOf(ctx) });
    return json({ ok: true, sent: true });
  }
  const ways = await waysOut(ctx.db, ctx.env);
  const url = await reissueLink(ctx.db, r, ctx.url?.origin);
  const sent = canReach(ways, r)
    ? await deliverLink(ctx.db, ctx.env, { letter, recipient: r, url, why: r.turn_told_at ? 'reminder' : 'first' })
    : { sent: false };
  if (sent.sent) {
    await ctx.db.prepare(
      `UPDATE corr_recipient SET reminded_at = datetime('now'), reminders = reminders + 1,
              turn_told_at = COALESCE(turn_told_at, datetime('now')) WHERE id = ?`,
    ).bind(r.id).run();
    await appendEvent(ctx.db, letter.id, { kind: 'reminder_sent', actor: actorOf(ctx), detail: r.name, ip: ipOf(ctx), agent: agentOf(ctx) });
    return json({ ok: true, sent: true });
  }
  return json({ ok: true, sent: false, url, name: r.name });
}

/**
 * Somebody signed on paper instead. The scan is kept with the document and
 * they count as signed, so the order moves on.
 */
export async function paperSignature(ctx, rid) {
  const r = await ctx.db.prepare('SELECT * FROM corr_recipient WHERE id = ?').bind(Number(rid)).first();
  if (!r) throw notFound('No such person on it.');
  const { letter } = await load(ctx.db, r.letter_id);
  if (letter.status !== 'awaiting_signature') throw badRequest('It is not out for signature.');
  if (r.role === 'copy' || ['signed', 'declined', 'revoked'].includes(r.status)) {
    throw badRequest(`${r.name} has nothing left to sign.`);
  }
  const body = await readJson(ctx.request);
  const fileId = await storeFile(ctx.db, {
    title: `${letter.subject}: signed on paper by ${r.name}`,
    filename: str(body.filename, 'File name', { max: 200 }) || 'paper-signature.pdf',
    mime: str(body.mime, 'Type', { max: 80, fallback: 'application/pdf' }),
    bytes: bytesFrom(body, 'scan'),
    actor: actorOf(ctx),
  });
  await ctx.db.prepare('INSERT OR IGNORE INTO corr_enclosure (letter_id, file_id) VALUES (?1, ?2)').bind(letter.id, fileId).run();
  await ctx.db.prepare(
    `UPDATE corr_recipient SET status = 'signed', signed_at = datetime('now'), signer_name = ?2,
            signer_check = 'paper' WHERE id = ?1`,
  ).bind(r.id, r.name).run();
  await appendEvent(ctx.db, letter.id, {
    kind: 'paper_signed', actor: actorOf(ctx), detail: `${r.name} signed on paper`, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  await afterSignature(ctx, letter.id, r.name);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Signing: the boxes a person fills, and what happens once they have
// ---------------------------------------------------------------------------

const INK = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * What one person filled in, checked against the boxes that are theirs. Every
 * box marked as having to be filled has to be, and nothing is taken for a box
 * that is not theirs.
 */
export function readFilled(layout, signer, body, { name: fallbackName = '' } = {}) {
  const mine = fieldsOf(layout).filter((b) => b.signer === signer);
  const values = {};
  const given = body.values && typeof body.values === 'object' ? body.values : {};
  const ink = String(body.ink ?? '');
  const initials = String(body.initialsInk ?? '');
  if (ink && (!INK.test(ink) || ink.length > 400_000)) throw badRequest('That signature did not come through. Try again.');
  if (initials && (!INK.test(initials) || initials.length > 200_000)) throw badRequest('Those initials did not come through. Try again.');

  for (const b of mine) {
    const v = given[b.id];
    if (b.field === 'text') values[b.id] = String(v ?? '').trim().slice(0, 300);
    else if (b.field === 'name') values[b.id] = String(v ?? fallbackName ?? '').trim().slice(0, 160);
    else if (b.field === 'title') values[b.id] = String(v ?? '').trim().slice(0, 120);
    else if (b.field === 'checkbox') values[b.id] = v === true;
    else if (b.field === 'stamp' && v) {
      if (!INK.test(String(v)) || String(v).length > 600_000) throw badRequest('That stamp did not come through. Try another picture.');
      values[b.id] = String(v);
    }
  }
  const missing = mine.filter((b) => {
    if (!b.required) return false;
    if (b.field === 'signature') return !ink;
    if (b.field === 'initials') return !initials && !ink;
    if (b.field === 'date') return false;
    if (b.field === 'stamp') return !values[b.id] && !body.stampId;
    if (b.field === 'checkbox') return values[b.id] !== true;
    return !values[b.id];
  });
  if (missing.length) {
    throw badRequest(`${missing.length === 1 ? 'One box is' : `${missing.length} boxes are`} still to fill: `
      + `${[...new Set(missing.map((b) => b.ask || FIELD_LABELS[b.field]))].join(', ')}.`);
  }
  return { values, ink: ink || null, initials: initials || null, boxes: mine.length };
}

/** A person on the list signs: from their link, or from their own HIVE login. */
export async function applyRecipientSignature(ctx, { letter, recipient, layout, body, check, ip, agent }) {
  const pos = positions((await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ?')
    .bind(letter.id).all()).results ?? []);
  const name = str(body.name, 'Your name', { required: true, max: 160 });
  const filled = readFilled(layout, pos.get(recipient.id), body, { name });
  if (filled.boxes && !filled.ink && fieldsOf(layout).some((b) => b.signer === pos.get(recipient.id) && b.field === 'signature')) {
    throw badRequest('Adopt a signature first.');
  }
  const changed = await ctx.db.prepare(
    `UPDATE corr_recipient
        SET status = 'signed', signed_at = datetime('now'), signer_name = ?2, signature_ink = ?3,
            initials_ink = ?4, field_values = ?5, signer_ip = ?6, signer_agent = ?7, signer_check = ?8
      WHERE id = ?1 AND status NOT IN ('signed', 'declined', 'revoked')`,
  ).bind(recipient.id, name, filled.ink, filled.initials, JSON.stringify(filled.values), ip, agent, check).run();
  if (!Number(changed?.meta?.changes ?? 1)) throw badRequest('You have already dealt with this.');
  return filled;
}

/**
 * After anybody signs: finished if everybody has, the signed copy made and
 * sent round, the office told, and whoever is next told it is their turn.
 */
export async function afterSignature(ctx, letterId, who) {
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  const outstanding = await ctx.db.prepare(
    `SELECT COUNT(*) n FROM corr_recipient
      WHERE letter_id = ? AND role <> 'copy' AND status NOT IN ('signed', 'revoked')`,
  ).bind(letterId).first();
  const complete = !Number(outstanding?.n ?? 0) && (letter.property_step == null || Boolean(letter.signed_at));

  if (complete) {
    await ctx.db.prepare(
      "UPDATE corr_letter SET status = 'signed', updated_at = datetime('now') WHERE id = ? AND status = 'awaiting_signature'",
    ).bind(letterId).run();
    await appendEvent(ctx.db, letterId, {
      kind: 'fully_signed', actor: 'system', detail: 'Every signer has signed', ip: null, agent: null,
    });
    const { signedLetter } = await import('./signed-copies.js');
    const copy = await signedLetter(ctx, letterId).catch((err) => { console.error('Signed copy failed', err); return null; });
    if (copy && letter.flow === FLOW) await sendSignedCopies(ctx, letter, copy).catch(() => {});
  }
  await tellOffice(ctx, letter, { what: complete ? 'complete' : 'signed', who }).catch(() => {});
  if (!complete) await tellWhoseTurn(ctx, letterId).catch(() => {});
  return complete;
}

/** What somebody signed in to HIVE sees when it is theirs to sign. */
export async function toSign(ctx, id) {
  const { letter, recipients, layout } = await load(ctx.db, id);
  if (letter.status !== 'awaiting_signature') throw badRequest('This is not waiting for anybody to sign.');
  const turn = liveTurn(recipients, letter.routing ?? 'order', letter);
  const mine = mayISign(ctx, letter, recipients, turn);
  if (!mine) throw forbidden('Nothing here is waiting for you to sign.');
  const pos = positions(recipients);
  const signer = mine.as === 'property' ? 0 : pos.get(mine.recipient.id);
  const property = await setting(ctx.db, 'property_name', 'Somewhere Nice');
  const saved = mine.as === 'property'
    ? await ctx.db.prepare('SELECT display_name, job_title, signature_ink FROM corr_signatory WHERE user_id = ?')
      .bind(ctx.session.user.id).first()
    : null;
  const stamps = mine.as === 'property'
    ? ((await ctx.db.prepare('SELECT id, label, image FROM corr_stamp WHERE active = 1 ORDER BY id').all()
      .catch(() => ({ results: [] }))).results ?? [])
    : [];
  return json({
    ...packetFor({ letter, recipients, layout, signer, property }),
    you: {
      as: mine.as,
      signer,
      name: mine.as === 'property' ? (saved?.display_name || ctx.session.user.name) : mine.recipient.name,
      capacity: mine.as === 'property' ? (letter.property_capacity || saved?.job_title || '') : (mine.recipient.capacity || ''),
      savedSignature: saved?.signature_ink ?? null,
    },
    stamps,
    fileUrl: letter.source === 'uploaded' ? `/api/corr/docs/${letter.id}/my-file` : null,
    needsPin: mine.as === 'property',
  });
}

/** The PDF, for somebody signing it from their HIVE login. */
export async function myFile(ctx, id) {
  const { letter, recipients } = await load(ctx.db, id);
  const turn = liveTurn(recipients, letter.routing ?? 'order', letter);
  if (!allows('corr_view', ctx.session.permissions) && !mayISign(ctx, letter, recipients, turn)) {
    throw forbidden('Nothing here is waiting for you to sign.');
  }
  const row = letter.file_id ? await ctx.db.prepare('SELECT * FROM corr_file WHERE id = ?').bind(letter.file_id).first() : null;
  if (!row) throw notFound('There is no file on this.');
  const { readStoredFile } = await import('./correspondence.js');
  return new Response(await readStoredFile(ctx.db, row), {
    headers: { 'Content-Type': row.mime || 'application/pdf', 'Cache-Control': 'private, no-store' },
  });
}

/**
 * What the signing screen draws: every box on the pages, which are this
 * person's to fill, and for everybody else's, whose they are and whether they
 * have signed. Never another person's email address or phone.
 */
export function packetFor({ letter, recipients, layout, signer, property }) {
  const pos = positions(recipients);
  const byPos = new Map(recipients.map((r) => [pos.get(r.id), r]));
  const values = (n) => (n === 0 ? parse(letter.property_values, {}) : parse(byPos.get(n)?.field_values, {}));
  const someone = (n) => (n === 0
    ? { name: property, signed: Boolean(letter.signed_at), ink: letter.signature_ink, initials: letter.property_initials, signerName: letter.signed_by, at: letter.signed_at }
    : (() => {
      const r = byPos.get(n);
      return r ? { name: r.name, signed: r.status === 'signed', ink: r.signature_ink, initials: r.initials_ink, signerName: r.signer_name, at: r.signed_at } : { name: `Person ${n}` };
    })());
  return {
    doc: {
      id: letter.id,
      title: letter.subject,
      reference: letter.reference,
      source: letter.source,
      layout: letter.source === 'composed' ? { ...layout, blocks: (layout?.blocks ?? []).filter((b) => b.role !== 'field') } : null,
      hash: letter.source === 'uploaded' ? null : letter.body_hash,
    },
    fields: fieldsOf(layout).map((b) => {
      const owner = someone(b.signer);
      const filled = values(b.signer)[b.id];
      return {
        id: b.id, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h ?? 7, field: b.field,
        required: b.required !== false, ask: b.ask ?? null,
        mine: b.signer === signer,
        owner: owner.name,
        signed: Boolean(owner.signed),
        // What somebody else already put there, so the page shows it filled.
        shown: owner.signed && b.signer !== signer
          ? (b.field === 'signature' ? { ink: owner.ink, name: owner.signerName }
            : b.field === 'initials' ? { ink: owner.initials || owner.ink, name: owner.signerName }
              : b.field === 'date' ? { text: owner.at }
                : b.field === 'checkbox' ? { tick: filled === true }
                  : b.field === 'stamp' ? { ink: filled || null }
                    : { text: filled ?? '' })
          : null,
      };
    }),
  };
}

/** Sign from a HIVE login: a member of staff on the list, or for the property. */
export async function signInHive(ctx, id) {
  const { letter, recipients, layout } = await load(ctx.db, id);
  if (letter.status !== 'awaiting_signature') throw badRequest('This is not waiting for anybody to sign.');
  const turn = liveTurn(recipients, letter.routing ?? 'order', letter);
  const mine = mayISign(ctx, letter, recipients, turn);
  if (!mine) throw forbidden('Nothing here is waiting for you to sign.');
  const body = await readJson(ctx.request);
  if (body.agreed !== true) throw badRequest('Tick the box to agree to sign electronically.');

  if (mine.as === 'staff') {
    const filled = await applyRecipientSignature(ctx, {
      letter, recipient: mine.recipient, layout, body, check: 'their own HIVE login', ip: ipOf(ctx), agent: agentOf(ctx),
    });
    await appendEvent(ctx.db, letter.id, {
      kind: 'signed_in_hive', actor: mine.recipient.name,
      detail: `${filled.boxes} ${filled.boxes === 1 ? 'box' : 'boxes'}`, ip: ipOf(ctx), agent: agentOf(ctx),
    });
    await afterSignature(ctx, letter.id, mine.recipient.name);
    return json({ ok: true });
  }

  // For the property: the person proves it is them again first.
  await reauthenticate(ctx, body);
  const name = str(body.name, 'Name', { required: true, max: 120 });
  const filled = readFilled(layout, 0, body, { name });
  const saved = await ctx.db.prepare('SELECT signature_ink FROM corr_signatory WHERE user_id = ?')
    .bind(ctx.session.user.id).first();
  const ink = filled.ink || (body.useSaved ? saved?.signature_ink : null);
  if (!ink) throw badRequest('Adopt a signature first.');
  let stampId = null;
  if (body.stampId) {
    const stamp = await ctx.db.prepare('SELECT id FROM corr_stamp WHERE id = ? AND active = 1').bind(Number(body.stampId)).first();
    if (!stamp) throw notFound('No such stamp.');
    stampId = stamp.id;
  }
  await ctx.db.prepare(
    `UPDATE corr_letter
        SET signed_by = ?2, signed_title = ?3, signature_ink = ?4, signed_at = datetime('now'),
            property_initials = ?5, property_values = ?6, stamp_id = COALESCE(?7, stamp_id),
            stamped_at = CASE WHEN ?7 IS NULL THEN stamped_at ELSE datetime('now') END
      WHERE id = ?1 AND signed_at IS NULL`,
  ).bind(letter.id, name, str(body.capacity, 'Signs as', { max: 120 }) || letter.property_capacity,
    ink, filled.initials, JSON.stringify(filled.values), stampId).run();
  await appendEvent(ctx.db, letter.id, {
    kind: 'signed_internally', actor: actorOf(ctx),
    detail: `${name}${letter.property_capacity ? `, ${letter.property_capacity}` : ''} · confirmed with their PIN or password`,
    ip: ipOf(ctx), agent: agentOf(ctx),
  });
  await afterSignature(ctx, letter.id, name);
  return json({ ok: true });
}
