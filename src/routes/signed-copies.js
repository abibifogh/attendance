import { badRequest, forbidden, json, notFound, readJson } from '../lib/http.js';
import { throttleCheck, throttleFail } from '../lib/auth.js';
import { siteOrigin } from '../lib/site.js';
import { contractPdf, fingerprint, letterPdf } from '../lib/signed-pdf.js';
import { normaliseLayout } from '../lib/paper.js';
import { contractWithTrail, readFile, storeFile } from './people.js';
import { readStoredFile, storeFile as storeCorrFile } from './correspondence.js';

/**
 * Signed copies: making them, handing them out, and checking one.
 *
 * A signed copy is made once, the moment a document is complete (both sides
 * of a contract, every signer of a letter), and kept. Its fingerprint goes on
 * the list /verify checks against. Asking for one that was completed before
 * this existed makes it then.
 */

const EVENT_WORDS = {
  contract_issued: 'Issued', link_created: 'Link made', link_sent: 'Link sent', link_reminded: 'Reminder sent',
  link_opened: 'Link opened', contract_viewed: 'Opened the document', code_sent: 'Code sent', signed: 'Signed',
  countersigned: 'Countersigned', declined: 'Declined', link_revoked: 'Link withdrawn',
  offer_made: 'Offered', offer_sent: 'Offer sent', offer_reminded: 'Reminder sent', offer_opened: 'Opened the offer',
};

async function propertyOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'property_name'").first().catch(() => null);
  return row?.value || 'HIVE';
}

export const contractRef = (id) => `HR-C-${String(id).padStart(5, '0')}`;

async function remember(db, { hash, kind, id, reference, title, signers, at }) {
  await db.prepare(
    `INSERT OR IGNORE INTO verify_hash (hash, kind, ref_id, reference, title, signers, completed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(hash, kind, id, reference, title, signers, at).run();
}

/** The signed copy of a contract, made if it is complete and not yet made. Null if it is not complete. */
export async function signedContract(ctx, id) {
  const found = await contractWithTrail(ctx.db, id);
  const c = found?.contract;
  if (!c || c.status !== 'signed' || !c.employer_at || c.origin === 'paper') return null;

  if (c.final_document_id) {
    const row = await ctx.db.prepare('SELECT * FROM hr_document WHERE id = ?').bind(c.final_document_id).first();
    if (row) return { bytes: await readFile(ctx.db, row), filename: row.filename, contract: c };
  }

  const property = await propertyOf(ctx.db);
  const reference = contractRef(c.id);
  const verifyUrl = `${await siteOrigin(ctx.db, ctx.url?.origin)}/verify`;
  const bytes = await contractPdf({
    contract: c,
    property,
    reference,
    verifyUrl,
    events: (found.events ?? []).map((e) => ({
      at: e.at_utc, what: EVENT_WORDS[e.kind] ?? e.kind, detail: e.detail, ip: e.ip,
    })),
  });
  const hash = await fingerprint(bytes);
  const filename = `${reference} ${c.title}.pdf`.replace(/[^\w .-]+/g, '');
  const docId = await storeFile(ctx, c.staff_id, {
    kind: 'signed_contract',
    title: `${c.title} (signed)`,
    filename,
    mime: 'application/pdf',
    bytes,
    expiresOn: null,
    by: 'HIVE (signed copy)',
  });
  await ctx.db.prepare('UPDATE hr_contract SET final_hash = ?2, final_document_id = ?3 WHERE id = ?1')
    .bind(c.id, hash, docId).run();
  await remember(ctx.db, {
    hash, kind: 'contract', id: c.id, reference, title: c.title,
    signers: [c.signer_name, c.employer_name].filter(Boolean).join(', '), at: c.employer_at,
  });
  return { bytes, filename, contract: c };
}

/** The signed copy of a letter, made if every signer has signed. */
export async function signedLetter(ctx, id) {
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(Number(id)).first();
  if (!letter) return null;
  const recipients = (await ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
    .bind(letter.id).all()).results ?? [];
  const signers = recipients.filter((r) => r.role !== 'copy' && r.status !== 'revoked');
  const complete = signers.length
    ? signers.every((r) => r.status === 'signed')
    : Boolean(letter.signed_at);
  if (!complete) return null;

  if (letter.final_file_id) {
    const row = await ctx.db.prepare('SELECT * FROM corr_file WHERE id = ?').bind(letter.final_file_id).first();
    if (row) return { bytes: await readStoredFile(ctx.db, row), filename: row.filename, letter };
  }

  let original = null;
  let fileHash = null;
  let mime = null;
  if (letter.file_id) {
    const row = await ctx.db.prepare('SELECT * FROM corr_file WHERE id = ?').bind(letter.file_id).first();
    if (row) { original = await readStoredFile(ctx.db, row); fileHash = row.sha256; mime = row.mime; }
  }
  let letterhead = null;
  if (letter.letterhead_id) {
    const head = await ctx.db.prepare(
      'SELECT h.later_pages, f.* FROM corr_letterhead h JOIN corr_file f ON f.id = h.file_id WHERE h.id = ?',
    ).bind(letter.letterhead_id).first();
    if (head) letterhead = { bytes: await readStoredFile(ctx.db, head), mime: head.mime, laterPages: Boolean(head.later_pages) };
  }
  const stamp = letter.stamp_id
    ? await ctx.db.prepare('SELECT image FROM corr_stamp WHERE id = ?').bind(letter.stamp_id).first()
    : null;
  const events = (await ctx.db.prepare('SELECT * FROM corr_event WHERE letter_id = ? ORDER BY id')
    .bind(letter.id).all()).results ?? [];

  const property = await propertyOf(ctx.db);
  const bytes = await letterPdf({
    letter: { ...letter, file_hash: fileHash, mime },
    recipients,
    events: events.map((e) => ({ at: e.at_utc ?? e.at, what: String(e.kind).replace(/_/g, ' '), who: e.actor, detail: e.detail, ip: e.ip })),
    property,
    verifyUrl: `${await siteOrigin(ctx.db, ctx.url?.origin)}/verify`,
    layout: normaliseLayout(letter.layout),
    letterhead,
    original,
    stampInk: stamp?.image ?? null,
  });
  const hash = await fingerprint(bytes);
  const filename = `${letter.reference} ${letter.subject}.pdf`.replace(/[^\w .-]+/g, '');
  const fileId = await storeCorrFile(ctx.db, {
    title: `${letter.subject} (signed)`, filename, mime: 'application/pdf', bytes, actor: 'HIVE (signed copy)',
  });
  await ctx.db.prepare('UPDATE corr_letter SET final_hash = ?2, final_file_id = ?3 WHERE id = ?1')
    .bind(letter.id, hash, fileId).run();
  await remember(ctx.db, {
    hash, kind: 'letter', id: letter.id, reference: letter.reference, title: letter.subject,
    signers: [letter.signed_by, ...signers.map((r) => r.signer_name || r.name)].filter(Boolean).join(', '),
    at: signers.map((r) => r.signed_at).filter(Boolean).sort().pop() || letter.signed_at,
  });
  return { bytes, filename, letter };
}

const pdf = (out, download) => new Response(out.bytes, {
  headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${out.filename}"`,
    'Cache-Control': 'private, no-store',
  },
});

export async function contractCopy(ctx, id) {
  const out = await signedContract(ctx, id);
  if (!out) throw badRequest('There is no signed copy until both sides have signed.');
  return pdf(out, ctx.url.searchParams.get('download') === '1');
}

export async function myContractCopy(ctx, id) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  const mine = await ctx.db.prepare('SELECT id FROM hr_contract WHERE id = ? AND staff_id = ?')
    .bind(Number(id), staffId).first();
  if (!mine) throw notFound('No such contract of yours.');
  const out = await signedContract(ctx, mine.id);
  if (!out) throw badRequest('There is no signed copy until the property has countersigned it.');
  return pdf(out, ctx.url.searchParams.get('download') === '1');
}

export async function letterCopy(ctx, id) {
  const out = await signedLetter(ctx, id);
  if (!out) throw badRequest('There is no signed copy until everybody has signed.');
  return pdf(out, ctx.url.searchParams.get('download') === '1');
}

/**
 * Is this copy genuine? Given the fingerprint of a file (worked out in the
 * browser, so the file itself never leaves the person's device), say whether
 * HIVE issued it, and only then what it is.
 */
export async function verify(ctx) {
  const ip = ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
  const gate = await throttleCheck(ctx.db, `verify:${ip}`, { pin: false });
  if (!gate.allowed) throw forbidden(`Too many checks. Wait ${Math.ceil(gate.retryAfter / 60)} minutes.`);
  const body = await readJson(ctx.request);
  const hash = String(body.hash ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw badRequest('That is not a file fingerprint.');

  const row = await ctx.db.prepare('SELECT * FROM verify_hash WHERE hash = ?').bind(hash).first();
  if (!row) {
    await throttleFail(ctx.db, `verify:${ip}`, { everybody: false });
    return json({
      genuine: false,
      message: 'This file is not one HIVE issued as a signed copy. It may have been changed, '
        + 'or it may be a different document.',
    });
  }
  return json({
    genuine: true,
    property: await propertyOf(ctx.db),
    kind: row.kind,
    reference: row.reference,
    title: row.title,
    signers: row.signers,
    completedAt: row.completed_at,
  });
}
