import { siteOrigin } from '../lib/site.js';
import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import {
  getPepper, hashPin, saltForEmail, verifyPasswordKey,
} from '../lib/auth.js';
import { allows } from '../lib/permissions.js';
import {
  MAX_FILE, asBytes, fromBase64, joinChunks, partsFor, sha256Hex, splitIntoChunks,
} from '../lib/files.js';
import {
  CHAIN_ROOT, LETTER_PLACEHOLDERS, STATUSES, currentSigner, linkEvent,
  progressOf, referenceFor, salutationFor, verifyChain,
} from '../lib/correspondence.js';
import { renderTemplate } from '../lib/people.js';
import { normaliseLayout, starterLayout, textOf } from '../lib/paper.js';

/**
 * The letter register, from the office side.
 *
 * The public side — somebody outside the property opening a link to sign — is
 * in `sign.js`, and the two share nothing but the database. One is reached
 * with a session and a permission; the other by anybody holding a link, so the
 * smaller its surface the better.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const canSign = (ctx) => allows('corr_sign', ctx.session.permissions);
const ipOf = (ctx) => ctx.request.headers.get('CF-Connecting-IP') || null;
const agentOf = (ctx) => (ctx.request.headers.get('User-Agent') || '').slice(0, 300) || null;

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorOf(ctx), action, entity == null ? null : String(entity), detail ? JSON.stringify(detail) : null)
    .run().catch(() => {});
}

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key)
    .first().catch(() => null);
  return row?.value ?? fallback;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * Add one link to a letter's event chain.
 *
 * Exported because the public signing routes append to the same chain, and a
 * second implementation of the hashing would eventually disagree with this one
 * — at which point every letter it touched would report itself as altered.
 */
export async function appendEvent(db, letterId, { kind, actor, detail, ip, agent }) {
  const last = await db.prepare(
    'SELECT seq, hash FROM corr_event WHERE letter_id = ? ORDER BY seq DESC LIMIT 1',
  ).bind(letterId).first();

  const seq = Number(last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? CHAIN_ROOT;
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const hash = await linkEvent(prevHash, {
    letterId, seq, kind, actor: actor ?? '', detail: detail ?? '', ip: ip ?? '', at,
  });

  await db.prepare(
    `INSERT INTO corr_event (letter_id, seq, kind, actor, detail, ip, agent, at_utc, prev_hash, hash)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  ).bind(letterId, seq, kind, actor ?? null, detail ?? null, ip ?? null, agent ?? null,
    at, prevHash, hash).run();

  return { seq, hash };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function storeFile(db, { title, filename, mime, bytes, actor }) {
  const chunks = splitIntoChunks(bytes);
  const created = await db.prepare(
    `INSERT INTO corr_file (title, filename, mime, bytes, sha256, content, parts, uploaded_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id`,
  ).bind(title, filename, mime, bytes.length, await sha256Hex(bytes), chunks[0],
    partsFor(bytes.length), actor).first();

  for (let seq = 1; seq < chunks.length; seq += 1) {
    await db.prepare('INSERT INTO corr_file_part (file_id, seq, content) VALUES (?1,?2,?3)')
      .bind(created.id, seq, chunks[seq]).run();
  }
  return created.id;
}

async function readStoredFile(db, row) {
  const chunks = [asBytes(row.content)];
  for (let seq = 1; seq < Number(row.parts ?? 1); seq += 1) {
    const part = await db.prepare('SELECT content FROM corr_file_part WHERE file_id = ? AND seq = ?')
      .bind(row.id, seq).first();
    if (!part) break;
    chunks.push(asBytes(part.content));
  }
  return joinChunks(chunks);
}

function bytesFrom(body, what = 'file') {
  let bytes;
  try {
    bytes = fromBase64(body.content);
  } catch {
    throw badRequest(`That ${what} did not arrive in one piece. Try again.`);
  }
  if (!bytes.length) throw badRequest(`There was nothing in that ${what}.`);
  if (bytes.length > MAX_FILE) {
    throw badRequest(
      `That ${what} is ${Math.round(bytes.length / 1_000_000)} MB and the limit is `
      + `${Math.round(MAX_FILE / 1_000_000)} MB. Scan it again at 200 dpi in black and white.`,
    );
  }
  return bytes;
}

export async function getFile(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM corr_file WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such file.');

  return new Response(await readStoredFile(ctx.db, row), {
    headers: {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${String(row.filename || row.title).replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// Letterheads
// ---------------------------------------------------------------------------

/**
 * The printed paper the property already has.
 *
 * Uploaded once as a picture of the page — the crest at the top, the address
 * along the bottom — and every letter is then laid out on top of it. The safe
 * area is where words may go, and it is part of the letterhead rather than of
 * each letter: it is a fact about the paper, and nobody should have to
 * rediscover it every time they write.
 */
export async function listLetterheads(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT h.*, f.mime, f.bytes FROM corr_letterhead h
       JOIN corr_file f ON f.id = h.file_id
      WHERE h.active = 1 ORDER BY h.name`,
  ).all().catch(() => ({ results: [] }));

  const preferred = (await ctx.db.prepare(
    "SELECT value FROM settings WHERE key = 'corr_default_letterhead'",
  ).first().catch(() => null))?.value;

  return json({
    letterheads: (rows.results ?? []).map((row) => shapeLetterhead(row)),
    defaultId: Number(preferred) || null,
  });
}

const shapeLetterhead = (row) => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  bytes: row.bytes,
  margins: {
    top: row.margin_top, right: row.margin_right,
    bottom: row.margin_bottom, left: row.margin_left,
  },
  laterPages: Boolean(row.later_pages),
  image: `/api/corr/letterheads/${row.id}/image`,
});

/** Add one, or change the safe area on one already there. */
export async function saveLetterhead(ctx, idParam = null) {
  const body = await readJson(ctx.request);
  const id = idParam ? Number(idParam) : null;
  const name = str(body.name, 'Name', { required: !id, max: 80 });

  const margins = {
    top: marginOf(body.margins?.top, 22),
    right: marginOf(body.margins?.right, 10),
    bottom: marginOf(body.margins?.bottom, 14),
    left: marginOf(body.margins?.left, 10),
  };
  // A fifth of the page, at least, or there is nowhere to write. The clamp
  // above stops any one edge running away; this stops two of them meeting in
  // the middle.
  if (margins.top + margins.bottom > 80 || margins.left + margins.right > 80) {
    throw badRequest('Those margins leave no room for a letter.');
  }

  if (id) {
    const found = await ctx.db.prepare('SELECT * FROM corr_letterhead WHERE id = ?').bind(id).first();
    if (!found) throw notFound('No such letterhead.');
    await ctx.db.prepare(
      `UPDATE corr_letterhead
          SET name = ?2, margin_top = ?3, margin_right = ?4, margin_bottom = ?5,
              margin_left = ?6, later_pages = ?7
        WHERE id = ?1`,
    ).bind(id, name || found.name, margins.top, margins.right, margins.bottom, margins.left,
      body.laterPages ? 1 : 0).run();
    await audit(ctx, 'corr.letterhead_edit', id, { name: name || found.name });
    return json({ ok: true, id });
  }

  const bytes = bytesFrom(body, 'letterhead');
  const mime = str(body.mime, 'File type', { max: 80 }) || 'image/jpeg';
  // A picture, not a PDF. The composer draws the page and needs something it
  // can put behind text; a PDF would need a reader to rasterise it, and every
  // property already has the letterhead as an image or can photograph one.
  if (!mime.startsWith('image/')) {
    throw badRequest('A letterhead has to be a picture, a PNG or a JPEG of the page. '
      + 'Export one page of the letterhead as an image and upload that.');
  }

  const fileId = await storeFile(ctx.db, {
    title: `Letterhead: ${name}`,
    filename: str(body.filename, 'File name', { max: 120 }) || 'letterhead',
    mime,
    bytes,
    actor: actorOf(ctx),
  });

  const made = await ctx.db.prepare(
    `INSERT INTO corr_letterhead (name, file_id, margin_top, margin_right, margin_bottom,
                                  margin_left, later_pages, uploaded_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id`,
  ).bind(name, fileId, margins.top, margins.right, margins.bottom, margins.left,
    body.laterPages ? 1 : 0, actorOf(ctx)).first();

  if (body.makeDefault) {
    await ctx.db.prepare(
      "INSERT INTO settings (key, value) VALUES ('corr_default_letterhead', ?1) "
      + 'ON CONFLICT (key) DO UPDATE SET value = ?1',
    ).bind(String(made.id)).run();
  }

  await audit(ctx, 'corr.letterhead_add', made.id, { name, bytes: bytes.length });
  return json({ ok: true, id: made.id, name });
}

const marginOf = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(45, Math.max(0, Math.round(n * 10) / 10));
};

/** Take one out of use. Letters already written on it keep it. */
export async function removeLetterhead(ctx, idParam) {
  const id = Number(idParam);
  await ctx.db.prepare('UPDATE corr_letterhead SET active = 0 WHERE id = ?').bind(id).run();
  await audit(ctx, 'corr.letterhead_remove', id, {});
  return json({ ok: true });
}

/** The picture itself. */
export async function letterheadImage(ctx, idParam) {
  const row = await ctx.db.prepare(
    `SELECT f.* FROM corr_letterhead h JOIN corr_file f ON f.id = h.file_id WHERE h.id = ?`,
  ).bind(Number(idParam)).first();
  if (!row) throw notFound('No such letterhead.');

  return new Response(await readStoredFile(ctx.db, row), {
    headers: {
      'Content-Type': row.mime || 'image/jpeg',
      // Safe to hold on to: the picture behind every letter, and it never
      // changes without becoming a different letterhead.
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export async function listLetters(ctx) {
  const status = ctx.url.searchParams.get('status');
  const search = (ctx.url.searchParams.get('q') || '').trim();

  const where = [];
  const binds = [];
  if (status && STATUSES[status]) { where.push('l.status = ?'); binds.push(status); }
  if (search) {
    where.push('(l.subject LIKE ? OR l.reference LIKE ? OR l.addressed_to LIKE ? OR p.organisation LIKE ?)');
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const rows = await ctx.db.prepare(
    `SELECT l.*, p.organisation, p.kind party_kind,
            (SELECT COUNT(*) FROM corr_recipient r WHERE r.letter_id = l.id AND r.role <> 'copy') signers,
            (SELECT COUNT(*) FROM corr_recipient r WHERE r.letter_id = l.id AND r.status = 'signed') signed
       FROM corr_letter l LEFT JOIN corr_party p ON p.id = l.party_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC, l.id DESC LIMIT 400`,
  ).bind(...binds).all();

  const [series, parties] = await Promise.all([
    ctx.db.prepare('SELECT * FROM corr_series WHERE active = 1 ORDER BY code').all(),
    ctx.db.prepare('SELECT * FROM corr_party WHERE active = 1 ORDER BY name').all(),
  ]);

  return json({
    rows: rows.results ?? [],
    series: series.results ?? [],
    parties: parties.results ?? [],
    statuses: STATUSES,
    canSign: canSign(ctx),
    canWrite: allows('corr_write', ctx.session.permissions),
  });
}

/**
 * A reference, allocated once and never reused.
 *
 * Taken with a single statement so two people drafting at the same moment
 * cannot both be given 0041. The year is checked as part of it, so the first
 * letter of January restarts the sequence without anybody remembering to.
 */
async function allocateReference(db, code) {
  const year = Number(new Date().toISOString().slice(0, 4));
  const series = await db.prepare('SELECT * FROM corr_series WHERE code = ?').bind(code).first();
  if (!series) throw badRequest('That reference series does not exist.');

  if (Number(series.year) !== year) {
    await db.prepare('UPDATE corr_series SET year = ?2, next_number = 1 WHERE code = ?1')
      .bind(code, year).run();
  }

  const taken = await db.prepare(
    'UPDATE corr_series SET next_number = next_number + 1 WHERE code = ?1 RETURNING next_number',
  ).bind(code).first();

  return referenceFor({ prefix: series.prefix, year, number: Number(taken.next_number) - 1 });
}

/**
 * Start a letter.
 *
 * Composed here from a template, or uploaded whole because somebody wrote it
 * in Word. Both are ordinary entries in the register from this point; the only
 * difference is where the words live.
 */
export async function createLetter(ctx) {
  const body = await readJson(ctx.request);
  const direction = body.direction === 'incoming' ? 'incoming' : 'outgoing';
  const series = str(body.series, 'Series', { max: 12, fallback: 'ADM' });
  const reference = await allocateReference(ctx.db, series);

  const party = body.partyId
    ? await ctx.db.prepare('SELECT * FROM corr_party WHERE id = ?').bind(Number(body.partyId)).first()
    : null;

  let fileId = null;
  let source = 'composed';
  let text = null;

  if (body.content) {
    const bytes = bytesFrom(body, 'letter');
    fileId = await storeFile(ctx.db, {
      title: str(body.subject, 'Subject', { required: true, max: 200 }),
      filename: str(body.filename, 'File name', { max: 200 }),
      mime: str(body.mime, 'Type', { max: 80, fallback: 'application/pdf' }),
      bytes,
      actor: actorOf(ctx),
    });
    source = 'uploaded';
  } else {
    const template = body.templateId
      ? await ctx.db.prepare('SELECT * FROM hr_template WHERE id = ?').bind(Number(body.templateId)).first()
      : null;

    const values = {
      reference,
      today: new Date().toISOString().slice(0, 10),
      property: await setting(ctx.db, 'property_name', 'Somewhere Nice'),
      property_address: await setting(ctx.db, 'property_address', ''),
      recipient: party?.name ?? str(body.addressedTo, 'Addressed to', { max: 200, fallback: '' }),
      recipient_first: String(party?.name ?? body.addressedTo ?? '').trim().split(/\s+/)[0] ?? '',
      organisation: party?.organisation ?? '',
      recipient_address: party?.address ?? str(body.address, 'Address', { max: 400, fallback: '' }),
      subject: str(body.subject, 'Subject', { required: true, max: 200 }),
      signatory: str(body.signatory, 'Signatory', { max: 120, fallback: '' }),
      signatory_title: str(body.signatoryTitle, 'Job title', { max: 120, fallback: '' }),
      your_reference: str(body.yourReference, 'Their reference', { max: 80, fallback: '' }),
      body: str(body.body, 'The letter', { max: 40_000, fallback: '' }),
    };

    text = template ? renderTemplate(template.body, values) : String(values.body || '');
    if (!text.trim()) throw badRequest('A letter needs either some words or a file.');
  }

  // Which paper it is on, and a first layout to open in the composer. Nobody
  // should start at a blank page: everybody writing a letter here writes the
  // same six things in the same six places.
  const letterheadId = body.letterheadId !== undefined
    ? (Number(body.letterheadId) || null)
    : Number((await ctx.db.prepare(
      "SELECT value FROM settings WHERE key = 'corr_default_letterhead'",
    ).first().catch(() => null))?.value) || null;

  const layout = source === 'composed'
    ? starterLayout({
      reference,
      date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      to: party?.name ?? str(body.addressedTo, 'Addressed to', { max: 200 }) ?? '',
      address: party?.address ?? str(body.address, 'Address', { max: 400 }) ?? '',
      subject: str(body.subject, 'Subject', { max: 200 }) ?? '',
      body: text,
      signer: str(body.signatory, 'Signatory', { max: 120 }) ?? '',
      title: str(body.signatoryTitle, 'Job title', { max: 120 }) ?? '',
    })
    : null;

  const created = await ctx.db.prepare(
    `INSERT INTO corr_letter
       (reference, series, direction, subject, source, body, body_hash, template_id, file_id,
        party_id, addressed_to, address, status, response_due, replies_to, created_by,
        letterhead_id, layout)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18) RETURNING id`,
  ).bind(
    reference, series, direction,
    str(body.subject, 'Subject', { required: true, max: 200 }),
    source, text, text ? await sha256Hex(text) : null,
    body.templateId ? Number(body.templateId) : null,
    fileId,
    party?.id ?? null,
    party?.name ?? str(body.addressedTo, 'Addressed to', { max: 200 }),
    party?.address ?? str(body.address, 'Address', { max: 400 }),
    direction === 'incoming' ? 'filed' : 'draft',
    str(body.responseDue, 'Response due', { max: 10 }),
    body.repliesTo ? Number(body.repliesTo) : null,
    actorOf(ctx),
    letterheadId,
    layout ? JSON.stringify(layout) : null,
  ).first();

  await appendEvent(ctx.db, created.id, {
    kind: 'created',
    actor: actorOf(ctx),
    detail: `${reference} · ${source === 'uploaded' ? 'uploaded' : 'composed'}`,
    ip: ipOf(ctx),
    agent: agentOf(ctx),
  });
  await audit(ctx, 'corr.create', created.id, { reference, direction });

  return json({ ok: true, id: created.id, reference });
}

export async function getLetter(ctx, id) {
  const letterId = Number(id);
  const letter = await ctx.db.prepare(
    `SELECT l.*, p.organisation, p.email party_email, p.phone party_phone, p.kind party_kind,
            f.title file_title, f.mime file_mime, f.bytes file_bytes, f.sha256 file_hash,
            r.reference replies_to_reference
       FROM corr_letter l
       LEFT JOIN corr_party p ON p.id = l.party_id
       LEFT JOIN corr_file f ON f.id = l.file_id
       LEFT JOIN corr_letter r ON r.id = l.replies_to
      WHERE l.id = ?`,
  ).bind(letterId).first();
  if (!letter) throw notFound('No such letter.');

  const [recipients, events, enclosures, replies, stamp] = await Promise.all([
    ctx.db.prepare('SELECT * FROM corr_recipient WHERE letter_id = ? ORDER BY seq, id')
      .bind(letterId).all(),
    ctx.db.prepare('SELECT * FROM corr_event WHERE letter_id = ? ORDER BY seq').bind(letterId).all(),
    ctx.db.prepare(
      `SELECT f.id, f.title, f.filename, f.mime, f.bytes FROM corr_enclosure e
         JOIN corr_file f ON f.id = e.file_id WHERE e.letter_id = ?`,
    ).bind(letterId).all(),
    ctx.db.prepare('SELECT id, reference, subject, created_at FROM corr_letter WHERE replies_to = ? ORDER BY id')
      .bind(letterId).all(),
    letter.stamp_id
      ? ctx.db.prepare('SELECT id, label, image FROM corr_stamp WHERE id = ?').bind(letter.stamp_id).first()
      : null,
  ]);

  const chain = await verifyChain(events.results ?? []);

  const letterhead = letter.letterhead_id
    ? await ctx.db.prepare(
      `SELECT h.*, f.mime, f.bytes FROM corr_letterhead h JOIN corr_file f ON f.id = h.file_id
        WHERE h.id = ?`,
    ).bind(letter.letterhead_id).first().catch(() => null)
    : null;

  return json({
    letter: {
      ...letter,
      layout: normaliseLayout(letter.layout),
      letterhead: letterhead ? shapeLetterhead(letterhead) : null,
      // Recomputed on every read rather than trusted. If the stored words no
      // longer produce the hash taken when they were signed, they have been
      // changed since — which is the one thing a signature is meant to catch.
      bodyIntact: letter.body == null || await sha256Hex(letter.body) === letter.body_hash,
    },
    // Never the token, and never the hash of it. The link is shown once, when
    // it is made, and after that there is nothing here that opens anything.
    recipients: (recipients.results ?? []).map((r) => ({
      id: r.id, seq: r.seq, role: r.role, name: r.name, organisation: r.organisation,
      email: r.email, phone: r.phone, status: r.status, hasCode: Boolean(r.code_hash),
      expiresAt: r.expires_at, openedAt: r.opened_at, signedAt: r.signed_at,
      signerName: r.signer_name, signatureInk: r.signature_ink, signerIp: r.signer_ip,
      signerAgent: r.signer_agent, verifiedAt: r.verified_at, declineNote: r.decline_note,
    })),
    events: events.results ?? [],
    chain,
    enclosures: enclosures.results ?? [],
    replies: replies.results ?? [],
    stamp: stamp ?? null,
    progress: progressOf(letter, recipients.results ?? []),
    canSign: canSign(ctx),
    canWrite: allows('corr_write', ctx.session.permissions),
  });
}

/** Edit a draft. Only a draft — once it is out for signature the words are fixed. */
export async function updateLetter(ctx, id) {
  const letterId = Number(id);
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  if (!letter) throw notFound('No such letter.');

  const body = await readJson(ctx.request);

  if (body.body !== undefined && letter.status !== 'draft') {
    throw badRequest('The words are fixed once a letter has gone out for signature. '
      + 'Withdraw it and draft a replacement, saying what it supersedes.');
  }

  if (body.layout !== undefined && letter.status !== 'draft') {
    throw badRequest('The layout is fixed once a letter has gone out for signature.');
  }

  // A composed letter carries its layout, and `body` is the same words as
  // plain text. Both are stored: the layout is what is printed, and the text
  // is what is searched, emailed and hashed. Deriving the text here rather
  // than trusting the screen is what keeps them from drifting apart.
  const layout = body.layout === undefined ? null : normaliseLayout(body.layout);
  const text = layout
    ? layout.blocks.filter((b) => b.role === 'body' || b.role === 'text')
      .map((b) => textOf(b.html)).filter(Boolean).join('\n\n')
    : (body.body === undefined ? letter.body : str(body.body, 'The letter', { max: 40_000 }));

  await ctx.db.prepare(
    `UPDATE corr_letter SET subject = ?2, body = ?3, body_hash = ?4, addressed_to = ?5,
            address = ?6, response_due = ?7, layout = ?8, letterhead_id = ?9,
            updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(
    letterId,
    str(body.subject, 'Subject', { max: 200, fallback: letter.subject }),
    text, text ? await sha256Hex(text) : null,
    str(body.addressedTo, 'Addressed to', { max: 200, fallback: letter.addressed_to }),
    str(body.address, 'Address', { max: 400, fallback: letter.address }),
    body.responseDue === undefined ? letter.response_due : str(body.responseDue, 'Response due', { max: 10 }),
    layout ? JSON.stringify(layout) : letter.layout,
    body.letterheadId === undefined
      ? letter.letterhead_id
      : (Number(body.letterheadId) || null),
  ).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'edited', actor: actorOf(ctx), detail: null, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Signing for the property
// ---------------------------------------------------------------------------

/**
 * Prove, again, that you are who the session says you are.
 *
 * A stored signature is a forgery machine unless applying it costs something.
 * Every product worth copying re-authenticates at the moment of signing, and
 * so does this: the person's own PIN, or their own password, checked against
 * their own record. A borrowed phone left unlocked on a desk is the threat,
 * and it is a real one in a hotel office.
 */
async function reauthenticate(ctx, body) {
  const pepper = await getPepper(ctx.db);
  const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?')
    .bind(ctx.session.user.id).first();
  if (!user) throw forbidden('That login no longer exists.');

  if (body.passwordKey && user.password_hash) {
    if (await verifyPasswordKey(body.passwordKey, user.password_hash, pepper)) return true;
    throw forbidden('That password is not right.');
  }
  if (body.pin && user.pin_hash) {
    if (await hashPin(String(body.pin), pepper) === user.pin_hash) return true;
    throw forbidden('That PIN is not right.');
  }
  throw forbidden('Confirm it is you before signing — your own PIN or password.');
}

/** What the browser needs before it can derive a password key for the above. */
export async function signChallenge(ctx) {
  const user = await ctx.db.prepare('SELECT email, pin_hash, password_hash FROM users WHERE id = ?')
    .bind(ctx.session.user.id).first();

  const signatory = await ctx.db.prepare('SELECT * FROM corr_signatory WHERE user_id = ?')
    .bind(ctx.session.user.id).first();

  return json({
    method: user?.password_hash ? 'password' : (user?.pin_hash ? 'pin' : 'none'),
    email: user?.email ?? null,
    salt: user?.email ? await saltForEmail(ctx.db, user.email, await getPepper(ctx.db)) : null,
    signatory: signatory
      ? {
        displayName: signatory.display_name,
        jobTitle: signatory.job_title,
        hasSignature: Boolean(signatory.signature_ink),
      }
      : null,
  });
}

/**
 * Sign a letter for the property, and optionally stamp it.
 *
 * The signature comes from the signer's own stored one or is drawn on the
 * spot; either way it is theirs and nobody else's. There is no route by which
 * one person applies another's signature — not an administrator, not whoever
 * set the system up — because a stored signature anybody could stamp onto a
 * letter would be worse than having none at all.
 */
export async function signLetter(ctx, id) {
  const letterId = Number(id);
  const body = await readJson(ctx.request);

  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  if (!letter) throw notFound('No such letter.');
  if (letter.status === 'void') throw badRequest('That letter has been withdrawn.');
  if (letter.signed_at) throw badRequest('That letter has already been signed for the property.');

  await reauthenticate(ctx, body);

  const stored = await ctx.db.prepare('SELECT * FROM corr_signatory WHERE user_id = ?')
    .bind(ctx.session.user.id).first();

  // Drawn now, or the one this person has stored. Never anybody else's.
  const ink = str(body.ink, 'Signature', { max: 400_000 }) || stored?.signature_ink || null;
  if (!ink) throw badRequest('Draw a signature, or save one to your profile first.');

  const name = str(body.name, 'Name', { max: 120 })
    || stored?.display_name || ctx.session.user.name;
  const title = str(body.jobTitle, 'Job title', { max: 120 }) || stored?.job_title || null;

  let stampId = null;
  if (body.stampId) {
    const stamp = await ctx.db.prepare('SELECT id, label FROM corr_stamp WHERE id = ? AND active = 1')
      .bind(Number(body.stampId)).first();
    if (!stamp) throw notFound('No such stamp.');
    stampId = stamp.id;
  }

  await ctx.db.prepare(
    `UPDATE corr_letter
        SET signed_by = ?2, signed_title = ?3, signature_ink = ?4, signed_at = datetime('now'),
            stamp_id = ?5, stamped_at = CASE WHEN ?5 IS NULL THEN NULL ELSE datetime('now') END,
            status = CASE WHEN status = 'draft' THEN 'signed' ELSE status END
      WHERE id = ?1`,
  ).bind(letterId, name, title, ink, stampId).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'signed_internally',
    actor: actorOf(ctx),
    detail: `${name}${title ? `, ${title}` : ''}`
      + `${body.ink ? ' · drawn now' : ' · stored signature'}${stampId ? ' · stamped' : ''}`,
    ip: ipOf(ctx),
    agent: agentOf(ctx),
  });
  await audit(ctx, 'corr.sign', letterId, { stamped: Boolean(stampId) });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Asking somebody else to sign
// ---------------------------------------------------------------------------

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A short code somebody can read out over the phone without misreading it. */
function newAccessCode() {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY3479';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export const hashSignToken = (token, pepper) => hashPin(`corr-sign:${token}`, pepper);
export const hashAccessCode = (code, pepper) => hashPin(`corr-code:${String(code).toUpperCase()}`, pepper);


/**
 * Send a letter out for signature.
 *
 * Recipients sign in the order they are listed. Only the earliest one who has
 * not dealt with it has a live link — the rest are told it is not their turn
 * yet rather than being shown a document out of sequence, because a letter
 * counter-signed before it was signed is one nobody can reason about
 * afterwards.
 */
export async function sendForSignature(ctx, id) {
  const letterId = Number(id);
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  if (!letter) throw notFound('No such letter.');
  if (letter.status === 'void') throw badRequest('That letter has been withdrawn.');

  const body = await readJson(ctx.request);
  const people = Array.isArray(body.recipients) ? body.recipients.slice(0, 10) : [];
  if (!people.length) throw badRequest('Name at least one person to sign it.');

  const days = int(body.days, 'Days', {
    min: 1, max: 90, fallback: Number(await setting(ctx.db, 'corr_link_days', 14)),
  });
  const pepper = await getPepper(ctx.db);
  const origin = await siteOrigin(ctx.db, ctx.url.origin);

  const made = [];
  let seq = Number((await ctx.db.prepare(
    'SELECT MAX(seq) m FROM corr_recipient WHERE letter_id = ?',
  ).bind(letterId).first())?.m ?? 0);

  for (const person of people) {
    const name = str(person.name, 'Name', { required: true, max: 160 });
    const role = ['signer', 'approver', 'copy'].includes(person.role) ? person.role : 'signer';
    seq += 1;

    // Somebody copied in is not asked to sign, so they get no link at all.
    const token = role === 'copy' ? null : newToken();
    const code = role === 'copy' || person.code === false ? null : newAccessCode();

    const created = await ctx.db.prepare(
      `INSERT INTO corr_recipient
         (letter_id, seq, role, party_id, name, organisation, email, phone,
          token_hash, code_hash, expires_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, datetime('now', ?11)) RETURNING id`,
    ).bind(
      letterId, seq, role,
      person.partyId ? Number(person.partyId) : null,
      name,
      str(person.organisation, 'Organisation', { max: 160 }),
      str(person.email, 'Email', { max: 200 }),
      str(person.phone, 'Phone', { max: 40 }),
      token ? await hashSignToken(token, pepper) : null,
      code ? await hashAccessCode(code, pepper) : null,
      `+${days} days`,
    ).first();

    made.push({
      id: created.id, seq, role, name,
      url: token ? `${origin}/s/${token}` : null,
      code,
      email: person.email || null,
    });
  }

  await ctx.db.prepare(
    "UPDATE corr_letter SET status = 'awaiting_signature', updated_at = datetime('now') WHERE id = ?",
  ).bind(letterId).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'sent_for_signature',
    actor: actorOf(ctx),
    detail: made.map((m) => `${m.seq}. ${m.name}`).join('; '),
    ip: ipOf(ctx),
    agent: agentOf(ctx),
  });
  await audit(ctx, 'corr.send_for_signature', letterId, { recipients: made.length, days });

  return json({ ok: true, recipients: made, expiresInDays: days });
}

export async function revokeRecipient(ctx, id) {
  const recipient = await ctx.db.prepare('SELECT * FROM corr_recipient WHERE id = ?')
    .bind(Number(id)).first();
  if (!recipient) throw notFound('No such recipient.');

  // The token stays. Nulling it would make a cancelled link indistinguishable
  // from a made-up one, and the person holding it — who is usually the person
  // it was cancelled on — would be told it does not exist rather than that it
  // was withdrawn. `status` is what refuses it.
  await ctx.db.prepare("UPDATE corr_recipient SET status = 'revoked' WHERE id = ?")
    .bind(recipient.id).run();

  await appendEvent(ctx.db, recipient.letter_id, {
    kind: 'link_revoked', actor: actorOf(ctx), detail: recipient.name,
    ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Dispatch and closing
// ---------------------------------------------------------------------------

export async function dispatchLetter(ctx, id) {
  const letterId = Number(id);
  const body = await readJson(ctx.request);
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  if (!letter) throw notFound('No such letter.');

  const via = ['email', 'hand', 'post', 'courier', 'whatsapp'].includes(body.via) ? body.via : 'hand';

  await ctx.db.prepare(
    `UPDATE corr_letter SET status = 'sent', sent_at = COALESCE(?2, datetime('now')),
            sent_via = ?3, sent_note = ?4, updated_at = datetime('now') WHERE id = ?1`,
  ).bind(letterId, str(body.on, 'Date', { max: 19 }), via, str(body.note, 'Note', { max: 300 })).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'dispatched', actor: actorOf(ctx), detail: `by ${via}`, ip: ipOf(ctx), agent: agentOf(ctx),
  });
  await audit(ctx, 'corr.dispatch', letterId, { via });
  return json({ ok: true });
}

export async function closeLetter(ctx, id) {
  const letterId = Number(id);
  const body = await readJson(ctx.request);

  await ctx.db.prepare(
    `UPDATE corr_letter SET status = 'closed', closed_at = datetime('now'), closed_note = ?2,
            updated_at = datetime('now') WHERE id = ?1`,
  ).bind(letterId, str(body.note, 'Note', { max: 300 })).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'closed', actor: actorOf(ctx), detail: str(body.note, 'Note', { max: 300 }),
    ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true });
}

export async function voidLetter(ctx, id) {
  const letterId = Number(id);
  const body = await readJson(ctx.request);
  const letter = await ctx.db.prepare('SELECT * FROM corr_letter WHERE id = ?').bind(letterId).first();
  if (!letter) throw notFound('No such letter.');

  const signed = await ctx.db.prepare(
    "SELECT COUNT(*) n FROM corr_recipient WHERE letter_id = ? AND status = 'signed'",
  ).bind(letterId).first();
  if (Number(signed?.n ?? 0)) {
    throw badRequest('Somebody has already signed this. Draft a replacement and say what it supersedes.');
  }

  await ctx.db.prepare(
    "UPDATE corr_letter SET status = 'void', closed_note = ?2, updated_at = datetime('now') WHERE id = ?1",
  ).bind(letterId, str(body.note, 'Reason', { max: 300 })).run();
  await ctx.db.prepare("UPDATE corr_recipient SET status = 'revoked' WHERE letter_id = ?")
    .bind(letterId).run();

  await appendEvent(ctx.db, letterId, {
    kind: 'withdrawn', actor: actorOf(ctx), detail: str(body.note, 'Reason', { max: 300 }),
    ip: ipOf(ctx), agent: agentOf(ctx),
  });
  return json({ ok: true });
}

/** Attach anything that went with the letter. */
export async function addEnclosure(ctx, id) {
  const letterId = Number(id);
  const body = await readJson(ctx.request);
  const bytes = bytesFrom(body, 'enclosure');

  const fileId = await storeFile(ctx.db, {
    title: str(body.title, 'Title', { required: true, max: 200 }),
    filename: str(body.filename, 'File name', { max: 200 }),
    mime: str(body.mime, 'Type', { max: 80, fallback: 'application/octet-stream' }),
    bytes,
    actor: actorOf(ctx),
  });

  await ctx.db.prepare('INSERT INTO corr_enclosure (letter_id, file_id) VALUES (?1, ?2)')
    .bind(letterId, fileId).run();
  await appendEvent(ctx.db, letterId, {
    kind: 'enclosure_added', actor: actorOf(ctx), detail: body.title,
    ip: ipOf(ctx), agent: agentOf(ctx),
  });

  return json({ ok: true, fileId });
}

// ---------------------------------------------------------------------------
// The address book
// ---------------------------------------------------------------------------

export async function listParties(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM corr_letter l WHERE l.party_id = p.id) letters
       FROM corr_party p ORDER BY p.active DESC, p.name`,
  ).all();
  return json({ rows: rows.results ?? [] });
}

export async function saveParty(ctx, id) {
  const body = await readJson(ctx.request);
  const fields = [
    str(body.name, 'Name', { required: true, max: 160 }),
    ['supplier', 'authority', 'guest', 'staff', 'bank', 'other'].includes(body.kind) ? body.kind : 'other',
    str(body.organisation, 'Organisation', { max: 160 }),
    str(body.jobTitle, 'Job title', { max: 120 }),
    str(body.email, 'Email', { max: 200 }),
    str(body.phone, 'Phone', { max: 40 }),
    str(body.address, 'Address', { max: 400 }),
    body.staffId ? Number(body.staffId) : null,
    str(body.note, 'Note', { max: 300 }),
  ];

  if (id) {
    await ctx.db.prepare(
      `UPDATE corr_party SET name = ?2, kind = ?3, organisation = ?4, job_title = ?5, email = ?6,
              phone = ?7, address = ?8, staff_id = ?9, note = ?10, active = ?11 WHERE id = ?1`,
    ).bind(Number(id), ...fields, body.active === false ? 0 : 1).run();
    await audit(ctx, 'corr.party_save', id, { name: fields[0] });
    return json({ ok: true, id: Number(id) });
  }

  const created = await ctx.db.prepare(
    `INSERT INTO corr_party (name, kind, organisation, job_title, email, phone, address, staff_id, note, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING id`,
  ).bind(...fields, actorOf(ctx)).first();

  await audit(ctx, 'corr.party_new', created.id, { name: fields[0] });
  return json({ ok: true, id: created.id });
}

// ---------------------------------------------------------------------------
// Signatures and stamps
// ---------------------------------------------------------------------------

/**
 * Your own stored signature.
 *
 * Yours, and only reachable as yours. There is no route that reads or writes
 * another person's — an administrator can see that somebody has one, and
 * cannot see it or use it.
 */
export async function saveMySignature(ctx) {
  const body = await readJson(ctx.request);
  await reauthenticate(ctx, body);

  const ink = str(body.ink, 'Signature', { max: 400_000 });
  const name = str(body.displayName, 'Name', { required: true, max: 120 });
  const title = str(body.jobTitle, 'Job title', { max: 120 });

  await ctx.db.prepare(
    `INSERT INTO corr_signatory (user_id, display_name, job_title, signature_ink, updated_at)
     VALUES (?1,?2,?3,?4,datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET display_name = ?2, job_title = ?3,
       signature_ink = COALESCE(?4, signature_ink), updated_at = datetime('now')`,
  ).bind(ctx.session.user.id, name, title, ink || null).run();

  await audit(ctx, 'corr.signature_saved', ctx.session.user.id, { name });
  return json({ ok: true });
}

export async function deleteMySignature(ctx) {
  await ctx.db.prepare('UPDATE corr_signatory SET signature_ink = NULL WHERE user_id = ?')
    .bind(ctx.session.user.id).run();
  await audit(ctx, 'corr.signature_removed', ctx.session.user.id, null);
  return json({ ok: true });
}

export async function listStamps(ctx) {
  const rows = await ctx.db.prepare('SELECT * FROM corr_stamp ORDER BY active DESC, id').all();
  // Who has a signature stored, without ever showing one. Useful to know that
  // the general manager can sign; not anybody else's business what it looks like.
  const signatories = await ctx.db.prepare(
    `SELECT s.user_id, s.display_name, s.job_title, u.name login_name,
            CASE WHEN s.signature_ink IS NULL THEN 0 ELSE 1 END has_signature
       FROM corr_signatory s JOIN users u ON u.id = s.user_id ORDER BY s.display_name`,
  ).all();

  return json({ rows: rows.results ?? [], signatories: signatories.results ?? [] });
}

export async function saveStamp(ctx) {
  const body = await readJson(ctx.request);
  const image = str(body.image, 'Image', { required: true, max: 500_000 });
  if (!/^data:image\//.test(image)) throw badRequest('A stamp has to be an image.');

  const created = await ctx.db.prepare(
    'INSERT INTO corr_stamp (label, image, uploaded_by) VALUES (?1,?2,?3) RETURNING id',
  ).bind(str(body.label, 'Label', { required: true, max: 80 }), image, actorOf(ctx)).first();

  await audit(ctx, 'corr.stamp_add', created.id, { label: body.label });
  return json({ ok: true, id: created.id });
}

export async function deleteStamp(ctx, id) {
  await ctx.db.prepare('UPDATE corr_stamp SET active = 0 WHERE id = ?').bind(Number(id)).run();
  await audit(ctx, 'corr.stamp_remove', id, null);
  return json({ ok: true });
}

/** What the compose screen needs: templates, placeholders and a salutation. */
export async function letterModel(ctx) {
  // Correspondence templates only. An HR letter — a probation confirmation,
  // say — is rendered with a different bag of values, and offering it here
  // would produce a letter with unfilled placeholders down the middle.
  const templates = await ctx.db.prepare(
    "SELECT id, name, body FROM hr_template WHERE kind = 'correspondence' AND active = 1 ORDER BY name",
  ).all();

  return json({
    templates: templates.results ?? [],
    placeholders: LETTER_PLACEHOLDERS,
    statuses: STATUSES,
    salutation: salutationFor({}),
    linkDays: Number(await setting(ctx.db, 'corr_link_days', 14)),
  });
}

export { currentSigner };
