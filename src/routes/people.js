import {
  badRequest, bool, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { allows } from '../lib/permissions.js';
import {
  ASKED_PLACEHOLDERS, FIELDS, LISTS, LIST_MAP, PLACEHOLDERS, SECTIONS,
  cleanSubmission, diffSubmission, hashBody, maskProfile, missingFor,
  placeholdersIn, renderTemplate,
} from '../lib/people.js';
import {
  REQUIRED_DOCUMENTS, STANDARD_TEMPLATES, fileStatus,
} from '../lib/ghana-templates.js';

/**
 * Employee records, from the property's side of the desk.
 *
 * The public side — the link a person opens on their phone — is in
 * `invite.js`, and the two share nothing but the database on purpose. One of
 * them is reached with a session and a permission; the other is reached by
 * anybody holding a link, so the smaller its surface the better.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const canManage = (ctx) => allows('hr_manage', ctx.session.permissions);

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorOf(ctx), action, entity == null ? null : String(entity), detail ? JSON.stringify(detail) : null)
    .run().catch(() => {});
}

async function logEvent(ctx, { staffId, inviteId = null, contractId = null, kind, detail = null }) {
  await ctx.db.prepare(
    `INSERT INTO hr_event (staff_id, invite_id, contract_id, kind, detail, ip, agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(
    staffId ?? null, inviteId, contractId, kind, detail,
    ctx.request.headers.get('CF-Connecting-IP') || null,
    (ctx.request.headers.get('User-Agent') || '').slice(0, 300) || null,
  ).run().catch(() => {});
}

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first().catch(() => null);
  return row?.value ?? fallback;
}

/** What the forms are made of. Sent once so the browser draws what the server means. */
export async function peopleModel(ctx) {
  return json({
    sections: SECTIONS,
    lists: LISTS.map(({ key, label, columns, self }) => ({ key, label, columns, self })),
    placeholders: PLACEHOLDERS,
    asked: ASKED_PLACEHOLDERS,
    canManage: canManage(ctx),
    linkDays: Number(await setting(ctx.db, 'hr_link_days', 21)),
  });
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Everybody, with the one thing worth knowing about each: what is missing.
 *
 * Not a completeness percentage. A number counting forty fields is something
 * nobody can act on; "no emergency contact, no ID" is a list somebody can walk
 * round the building with.
 */
export async function listPeople(ctx) {
  const [staff, profiles, contacts, contracts, pending, documents, signed] = await Promise.all([
    ctx.db.prepare('SELECT * FROM att_staff ORDER BY active DESC, name').all(),
    ctx.db.prepare('SELECT * FROM hr_profile').all(),
    ctx.db.prepare('SELECT staff_id, COUNT(*) n FROM hr_contact GROUP BY staff_id').all(),
    ctx.db.prepare(
      `SELECT staff_id,
              SUM(CASE WHEN status = 'signed' THEN 1 ELSE 0 END) signed,
              SUM(CASE WHEN status IN ('sent','opened') THEN 1 ELSE 0 END) waiting
         FROM hr_contract WHERE status <> 'void' GROUP BY staff_id`,
    ).all(),
    ctx.db.prepare(
      "SELECT staff_id, COUNT(*) n FROM hr_submission WHERE status = 'pending' GROUP BY staff_id",
    ).all(),
    ctx.db.prepare('SELECT id, staff_id, kind, expires_on FROM hr_document').all(),
    ctx.db.prepare("SELECT staff_id, satisfies, status FROM hr_contract WHERE status = 'signed'").all(),
  ]);

  const byStaff = (rows) => new Map((rows.results ?? []).map((r) => [r.staff_id, r]));
  const profileBy = byStaff(profiles);
  const contactBy = byStaff(contacts);
  const contractBy = byStaff(contracts);
  const pendingBy = byStaff(pending);

  const full = canManage(ctx);

  const grouped = (rows) => {
    const map = new Map();
    for (const row of rows.results ?? []) {
      if (!map.has(row.staff_id)) map.set(row.staff_id, []);
      map.get(row.staff_id).push(row);
    }
    return map;
  };
  const documentBy = grouped(documents);
  const signedBy = grouped(signed);

  const rows = (staff.results ?? []).map((person) => {
    const profile = profileBy.get(person.id) ?? null;
    const gaps = missingFor(profile, { contacts: Array(contactBy.get(person.id)?.n ?? 0).fill(1) });
    const contract = contractBy.get(person.id);

    // A file that is short of a Ghana Card is short of it whether or not
    // anybody has typed a phone number in, so the checklist and the fields
    // report into the same list.
    const file = fileStatus(person, profile, {
      documents: documentBy.get(person.id) ?? [],
      contracts: signedBy.get(person.id) ?? [],
    });

    return {
      id: person.id,
      name: person.name,
      employeeNo: person.employee_no,
      department: person.department,
      jobTitle: person.job_title,
      hiredOn: person.hired_on,
      active: Boolean(person.active),
      phone: full ? profile?.personal_phone ?? null : null,
      missing: [
        ...gaps.map((g) => g.label),
        ...file.filter((d) => d.state === 'missing' || d.state === 'expired')
          .map((d) => (d.state === 'expired' ? `${d.label} (expired)` : d.label)),
      ],
      expiring: file.filter((d) => d.state === 'expiring')
        .map((d) => ({ label: d.label, on: d.expiresOn })),
      signedContracts: Number(contract?.signed ?? 0),
      waitingContracts: Number(contract?.waiting ?? 0),
      pendingSubmissions: Number(pendingBy.get(person.id)?.n ?? 0),
    };
  });

  return json({
    rows,
    canManage: full,
    openSubmissions: rows.reduce((n, r) => n + r.pendingSubmissions, 0),
  });
}

// ---------------------------------------------------------------------------
// One person
// ---------------------------------------------------------------------------

export async function getPerson(ctx, id) {
  const staffId = Number(id);
  const person = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const full = canManage(ctx);
  const lists = await loadLists(ctx.db, staffId);

  const [profile, documents, contracts, invites, submissions, events] = await Promise.all([
    ctx.db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').bind(staffId).first(),
    ctx.db.prepare(
      `SELECT id, kind, title, filename, mime, bytes, expires_on, uploaded_by, uploaded_at
         FROM hr_document WHERE staff_id = ? ORDER BY uploaded_at DESC`,
    ).bind(staffId).all(),
    ctx.db.prepare(
      `SELECT id, title, status, origin, document_id, satisfies, issued_at, opened_at,
              signed_at, signer_name, body_hash, employer_name, employer_at, decline_note,
              filed_by, filed_at, created_at
         FROM hr_contract WHERE staff_id = ? ORDER BY id DESC`,
    ).bind(staffId).all(),
    ctx.db.prepare(
      'SELECT * FROM hr_invite WHERE staff_id = ? ORDER BY id DESC LIMIT 10',
    ).bind(staffId).all(),
    ctx.db.prepare(
      "SELECT * FROM hr_submission WHERE staff_id = ? AND status = 'pending' ORDER BY id DESC",
    ).bind(staffId).all(),
    ctx.db.prepare(
      'SELECT kind, detail, at_utc, ip FROM hr_event WHERE staff_id = ? ORDER BY id DESC LIMIT 40',
    ).bind(staffId).all(),
  ]);

  const open = (submissions.results ?? []).map((s) => ({
    id: s.id,
    submittedAt: s.submitted_at,
    changes: diffSubmission(safeJson(s.payload), { profile, lists })
      .filter((c) => full || !c.sensitive),
  }));

  return json({
    person: {
      id: person.id, name: person.name, employeeNo: person.employee_no,
      department: person.department, jobTitle: person.job_title,
      hiredOn: person.hired_on, leftOn: person.left_on, active: Boolean(person.active),
    },
    profile: maskProfile(profile, { full }),
    lists,
    missing: missingFor(profile, lists).map((g) => g.label),
    documents: documents.results ?? [],
    contracts: contracts.results ?? [],
    // What ought to be in this particular person's file, and what is. Two of
    // the requirements depend on who they are — a food handler's certificate,
    // a work permit — so the list is worked out per person rather than shown
    // to everybody and ignored by most of them.
    fileStatus: fileStatus(person, profile, {
      documents: documents.results ?? [],
      contracts: contracts.results ?? [],
    }),
    invites: (invites.results ?? []).map((i) => ({
      id: i.id,
      wantsDetails: Boolean(i.wants_details),
      hasPin: Boolean(i.pin_hash),
      expiresAt: i.expires_at,
      createdAt: i.created_at,
      createdBy: i.created_by,
      openedAt: i.opened_at,
      finishedAt: i.finished_at,
      revokedAt: i.revoked_at,
      // The link itself is never stored, so it can never be shown again.
      // Rebuilding it is making a new one.
    })),
    submissions: open,
    events: events.results ?? [],
    canManage: full,
  });
}

async function loadLists(db, staffId) {
  const out = {};
  for (const list of LISTS) {
    const rows = await db.prepare(
      `SELECT * FROM ${list.table} WHERE staff_id = ? ORDER BY sort_order, id`,
    ).bind(staffId).all();
    out[list.key] = rows.results ?? [];
  }
  return out;
}

const safeJson = (text) => { try { return JSON.parse(text); } catch { return {}; } };

/** Save the scalar half of a record. */
export async function savePerson(ctx, id) {
  const staffId = Number(id);
  const person = await ctx.db.prepare('SELECT id FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const body = await readJson(ctx.request);
  const values = {};
  for (const field of FIELDS) {
    if (!(field.key in body)) continue;
    values[field.key] = str(body[field.key], field.label, { max: 600 });
  }
  if (!Object.keys(values).length) return json({ ok: true, changed: 0 });

  await writeProfile(ctx.db, staffId, values, actorOf(ctx));
  await audit(ctx, 'people.profile', staffId, { fields: Object.keys(values) });
  return json({ ok: true, changed: Object.keys(values).length });
}

/**
 * Write a set of profile fields, creating the row if this is the first thing
 * anybody has ever recorded about somebody.
 */
export async function writeProfile(db, staffId, values, actor) {
  const keys = Object.keys(values);
  if (!keys.length) return;

  await db.prepare('INSERT OR IGNORE INTO hr_profile (staff_id) VALUES (?)').bind(staffId).run();

  const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(', ');
  await db.prepare(
    `UPDATE hr_profile SET ${sets}, updated_at = datetime('now'), updated_by = ?${keys.length + 2}
      WHERE staff_id = ?1`,
  ).bind(staffId, ...keys.map((k) => (values[k] === '' ? null : values[k])), actor).run();
}

/** Replace one of the child lists wholesale. */
export async function saveList(ctx, id, listKey) {
  const staffId = Number(id);
  const list = LIST_MAP.get(listKey);
  if (!list) throw notFound('No such list.');

  const body = await readJson(ctx.request);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20) : [];

  await replaceList(ctx.db, staffId, list, rows);
  await audit(ctx, 'people.list', staffId, { list: listKey, rows: rows.length });
  return json({ ok: true, rows: rows.length });
}

export async function replaceList(db, staffId, list, rows) {
  const kept = rows
    .map((row) => list.columns.map((c) => (row?.[c] == null ? null : String(row[c]).trim().slice(0, 300) || null)))
    .filter((values) => values.some((v) => v));

  await db.prepare(`DELETE FROM ${list.table} WHERE staff_id = ?`).bind(staffId).run();
  if (!kept.length) return;

  const columns = ['staff_id', ...list.columns, 'sort_order'];
  const marks = columns.map((_, i) => `?${i + 1}`).join(', ');

  const statements = kept.map((values, i) => db.prepare(
    `INSERT INTO ${list.table} (${columns.join(', ')}) VALUES (${marks})`,
  ).bind(staffId, ...values, i));

  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// A file is stored in pieces, because D1 will not hold a row larger than about
// two megabytes and a scanned five-page contract is routinely more than that.
// The first piece stays in the row itself so that small files are unchanged.
const CHUNK = 700_000;
// The ceiling on the whole thing. Generous enough for a scanned contract,
// small enough that one upload cannot fill the database.
const MAX_DOCUMENT = 12_000_000;

/** Store a file, in as many pieces as it takes, and return its id. */
async function storeFile(ctx, staffId, { kind, title, filename, mime, bytes, expiresOn }) {
  const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));

  const created = await ctx.db.prepare(
    `INSERT INTO hr_document (staff_id, kind, title, filename, mime, bytes, content, parts,
                              expires_on, uploaded_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING id`,
  ).bind(
    staffId, kind, title, filename, mime, bytes.length,
    bytes.subarray(0, CHUNK), parts, expiresOn, actorOf(ctx),
  ).first();

  for (let seq = 1; seq < parts; seq += 1) {
    await ctx.db.prepare(
      'INSERT INTO hr_document_part (document_id, seq, content) VALUES (?1, ?2, ?3)',
    ).bind(created.id, seq, bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK)).run();
  }

  return created.id;
}

/** Read a file back, in order. */
async function readFile(db, row) {
  const first = row.content instanceof ArrayBuffer ? new Uint8Array(row.content) : row.content;
  const parts = Number(row.parts ?? 1);
  if (parts <= 1) return first;

  const chunks = [first];
  // One query per piece rather than one for all of them: a single row holding
  // twelve megabytes of blobs is a response nobody should ask a database for.
  for (let seq = 1; seq < parts; seq += 1) {
    const part = await db.prepare(
      'SELECT content FROM hr_document_part WHERE document_id = ? AND seq = ?',
    ).bind(row.id, seq).first();
    if (!part) break;
    chunks.push(part.content instanceof ArrayBuffer ? new Uint8Array(part.content) : part.content);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

export async function addDocument(ctx, id) {
  const staffId = Number(id);
  const person = await ctx.db.prepare('SELECT id FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const body = await readJson(ctx.request);
  const bytes = fromBase64(body.content);
  if (!bytes.length) throw badRequest('There was nothing in that file.');
  if (bytes.length > MAX_DOCUMENT) {
    throw badRequest(
      `That file is ${Math.round(bytes.length / 1_000_000)} MB and the limit is `
      + `${Math.round(MAX_DOCUMENT / 1_000_000)} MB. Scan it again at a lower resolution — `
      + '200 dpi in black and white is plenty for a contract.',
    );
  }

  const documentId = await storeFile(ctx, staffId, {
    kind: str(body.kind, 'Kind', { max: 40, fallback: 'other' }),
    title: str(body.title, 'Title', { required: true, max: 120 }),
    filename: str(body.filename, 'File name', { max: 200 }),
    mime: str(body.mime, 'Type', { max: 80, fallback: 'application/octet-stream' }),
    bytes,
    expiresOn: str(body.expiresOn, 'Expiry', { max: 10 }),
  });

  await audit(ctx, 'people.document_add', staffId, { title: body.title, bytes: bytes.length });
  return json({ ok: true, id: documentId });
}

export async function getDocument(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM hr_document WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such document.');

  const content = await readFile(ctx.db, row);
  return new Response(content, {
    headers: {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${(row.filename || row.title).replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function deleteDocument(ctx, id) {
  const row = await ctx.db.prepare('SELECT staff_id, title FROM hr_document WHERE id = ?')
    .bind(Number(id)).first();
  if (!row) throw notFound('No such document.');

  await ctx.db.prepare('DELETE FROM hr_document WHERE id = ?').bind(Number(id)).run();
  await audit(ctx, 'people.document_delete', row.staff_id, { title: row.title });
  return json({ ok: true });
}

function fromBase64(value) {
  const clean = String(value ?? '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!clean) return new Uint8Array(0);
  let binary;
  try {
    binary = atob(clean);
  } catch {
    throw badRequest('That file did not arrive in one piece. Try again.');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** A link nobody can guess and nobody can recover from the database. */
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hashInviteToken = (token, pepper) => hashPin(`hr-invite:${token}`, pepper);
const hashInvitePin = (pin, pepper) => hashPin(`hr-invite-pin:${pin}`, pepper);

async function siteOrigin(ctx) {
  const row = await ctx.db.prepare("SELECT value FROM settings WHERE key = 'site_url'")
    .first().catch(() => null);
  return (row?.value || ctx.url.origin).replace(/\/+$/, '');
}

/**
 * Make a link for one person.
 *
 * Shown once, on the screen that made it, and never again — the database keeps
 * only a hash, so a copy of it opens nothing. Making another link is the way
 * to recover from having lost one, and it takes two seconds.
 */
export async function createInvite(ctx, id) {
  const staffId = Number(id);
  const person = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const body = await readJson(ctx.request);
  const wantsDetails = bool(body.wantsDetails, true);
  const contractIds = (Array.isArray(body.contractIds) ? body.contractIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);

  if (!wantsDetails && !contractIds.length) {
    throw badRequest('A link has to ask for something — their details, a contract, or both.');
  }

  const days = int(body.days, 'Days', { min: 1, max: 90, fallback: Number(await setting(ctx.db, 'hr_link_days', 21)) });
  const pin = body.pin == null || body.pin === '' ? null : String(body.pin).replace(/\D/g, '');
  if (pin && pin.length !== 4) throw badRequest('A code has to be four digits, or leave it blank.');

  const pepper = await getPepper(ctx.db);
  const token = newToken();

  const created = await ctx.db.prepare(
    `INSERT INTO hr_invite (staff_id, token_hash, pin_hash, wants_details, message, expires_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', ?6), ?7) RETURNING id`,
  ).bind(
    staffId,
    await hashInviteToken(token, pepper),
    pin ? await hashInvitePin(pin, pepper) : null,
    wantsDetails ? 1 : 0,
    str(body.message, 'Message', { max: 400 }),
    `+${days} days`,
    actorOf(ctx),
  ).first();

  // Only contracts belonging to this person, and only ones still open. A link
  // cannot be made to carry somebody else's contract by passing its number.
  for (const contractId of contractIds) {
    const contract = await ctx.db.prepare(
      "SELECT id FROM hr_contract WHERE id = ? AND staff_id = ? AND status IN ('draft','sent','opened')",
    ).bind(contractId, staffId).first();
    if (!contract) continue;

    await ctx.db.prepare(
      'INSERT OR IGNORE INTO hr_invite_contract (invite_id, contract_id) VALUES (?, ?)',
    ).bind(created.id, contractId).run();
    await ctx.db.prepare(
      "UPDATE hr_contract SET status = 'sent', issued_at = COALESCE(issued_at, datetime('now')) WHERE id = ?",
    ).bind(contractId).run();
  }

  await logEvent(ctx, {
    staffId, inviteId: created.id, kind: 'link_created',
    detail: `${wantsDetails ? 'details' : ''}${wantsDetails && contractIds.length ? ' + ' : ''}${contractIds.length ? `${contractIds.length} contract(s)` : ''}`,
  });
  await audit(ctx, 'people.invite', staffId, { days, contracts: contractIds.length, pin: Boolean(pin) });

  return json({
    ok: true,
    id: created.id,
    url: `${await siteOrigin(ctx)}/i/${token}`,
    pin,
    expiresInDays: days,
    // Written out so it can be pasted straight into a message.
    message: linkMessage(person.name, `${await siteOrigin(ctx)}/i/${token}`, wantsDetails, contractIds.length),
  });
}

function linkMessage(name, url, wantsDetails, contracts) {
  const asks = [];
  if (wantsDetails) asks.push('fill in your details');
  if (contracts) asks.push(contracts === 1 ? 'read and sign your contract' : `read and sign ${contracts} documents`);

  return `Hello ${name.split(' ')[0]}, please open this link on your phone to ${asks.join(' and ')}. `
    + `It is private to you.\n\n${url}`;
}

export async function revokeInvite(ctx, id) {
  const invite = await ctx.db.prepare('SELECT * FROM hr_invite WHERE id = ?').bind(Number(id)).first();
  if (!invite) throw notFound('No such link.');

  await ctx.db.prepare(
    "UPDATE hr_invite SET revoked_at = datetime('now'), revoked_by = ?2 WHERE id = ?1",
  ).bind(invite.id, actorOf(ctx)).run();

  await logEvent(ctx, { staffId: invite.staff_id, inviteId: invite.id, kind: 'link_revoked' });
  await audit(ctx, 'people.invite_revoke', invite.staff_id, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// What people send in
// ---------------------------------------------------------------------------

export async function listSubmissions(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT s.*, p.name FROM hr_submission s JOIN att_staff p ON p.id = s.staff_id
      WHERE s.status = 'pending' ORDER BY s.id DESC`,
  ).all();

  const full = canManage(ctx);
  const out = [];

  for (const row of rows.results ?? []) {
    const profile = await ctx.db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?')
      .bind(row.staff_id).first();
    const lists = await loadLists(ctx.db, row.staff_id);

    out.push({
      id: row.id,
      staffId: row.staff_id,
      name: row.name,
      submittedAt: row.submitted_at,
      changes: diffSubmission(safeJson(row.payload), { profile, lists })
        .filter((c) => full || !c.sensitive),
    });
  }

  return json({ rows: out });
}

/**
 * Accept some or all of what somebody sent.
 *
 * Ticked changes are applied and the rest are simply not — the submission is
 * closed either way, because leaving it open would mean the same two rejected
 * fields coming back to the top of the list every morning for ever.
 */
export async function acceptSubmission(ctx, id) {
  const submission = await ctx.db.prepare('SELECT * FROM hr_submission WHERE id = ?')
    .bind(Number(id)).first();
  if (!submission) throw notFound('No such submission.');
  if (submission.status !== 'pending') throw badRequest('That one has already been dealt with.');

  const body = await readJson(ctx.request);
  const wanted = Array.isArray(body.keys) ? new Set(body.keys.map(String)) : null;

  const profile = await ctx.db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?')
    .bind(submission.staff_id).first();
  const lists = await loadLists(ctx.db, submission.staff_id);

  const changes = diffSubmission(safeJson(submission.payload), { profile, lists })
    .filter((c) => (wanted ? wanted.has(c.key) : true));

  const values = {};
  for (const change of changes) {
    if (change.kind === 'field') values[change.key] = change.to;
  }
  if (Object.keys(values).length) {
    await writeProfile(ctx.db, submission.staff_id, values, actorOf(ctx));
  }

  for (const change of changes) {
    if (change.kind !== 'list') continue;
    await replaceList(ctx.db, submission.staff_id, LIST_MAP.get(change.key), change.rows);
  }

  await ctx.db.prepare(
    `UPDATE hr_submission SET status = 'accepted', reviewed_by = ?2, reviewed_at = datetime('now'),
            review_note = ?3 WHERE id = ?1`,
  ).bind(submission.id, actorOf(ctx), `${changes.length} of what was sent`).run();

  await logEvent(ctx, {
    staffId: submission.staff_id, kind: 'details_accepted',
    detail: `${changes.length} change${changes.length === 1 ? '' : 's'}`,
  });
  await audit(ctx, 'people.submission_accept', submission.staff_id, { applied: changes.length });

  return json({ ok: true, applied: changes.length });
}

export async function rejectSubmission(ctx, id) {
  const body = await readJson(ctx.request).catch(() => ({}));
  const submission = await ctx.db.prepare('SELECT * FROM hr_submission WHERE id = ?')
    .bind(Number(id)).first();
  if (!submission) throw notFound('No such submission.');

  await ctx.db.prepare(
    `UPDATE hr_submission SET status = 'rejected', reviewed_by = ?2, reviewed_at = datetime('now'),
            review_note = ?3 WHERE id = ?1`,
  ).bind(submission.id, actorOf(ctx), str(body.note, 'Note', { max: 300 })).run();

  await logEvent(ctx, { staffId: submission.staff_id, kind: 'details_rejected' });
  await audit(ctx, 'people.submission_reject', submission.staff_id, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(ctx) {
  const rows = await ctx.db.prepare('SELECT * FROM hr_template ORDER BY active DESC, name').all();
  return json({
    rows: (rows.results ?? []).map((t) => ({ ...t, uses: placeholdersIn(t.body) })),
    placeholders: PLACEHOLDERS,
  });
}

export async function saveTemplate(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 120 });
  const text = str(body.body, 'The words', { required: true, max: 60_000 });
  const kind = ['contract', 'letter', 'policy'].includes(body.kind) ? body.kind : 'contract';

  if (id) {
    await ctx.db.prepare(
      `UPDATE hr_template SET name = ?2, body = ?3, kind = ?4, active = ?5,
              updated_at = datetime('now') WHERE id = ?1`,
    ).bind(Number(id), name, text, kind, bool(body.active, true) ? 1 : 0).run();
    await audit(ctx, 'people.template_save', id, { name });
    return json({ ok: true, id: Number(id) });
  }

  const created = await ctx.db.prepare(
    'INSERT INTO hr_template (name, body, kind, created_by) VALUES (?1,?2,?3,?4) RETURNING id',
  ).bind(name, text, kind, actorOf(ctx)).first();

  await audit(ctx, 'people.template_new', created.id, { name });
  return json({ ok: true, id: created.id });
}

export async function deleteTemplate(ctx, id) {
  await ctx.db.prepare('DELETE FROM hr_template WHERE id = ?').bind(Number(id)).run();
  await audit(ctx, 'people.template_delete', id, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Issue a contract to somebody.
 *
 * The template is rendered here and the result is stored as the contract. From
 * this moment the words are fixed: editing the template next year cannot
 * change what this person is being asked to sign, and cannot change what they
 * signed after they have signed it.
 */
export async function issueContract(ctx, id) {
  const staffId = Number(id);
  const person = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const body = await readJson(ctx.request);
  const template = body.templateId
    ? await ctx.db.prepare('SELECT * FROM hr_template WHERE id = ?').bind(Number(body.templateId)).first()
    : null;

  const source = template?.body ?? str(body.body, 'The words', { required: true, max: 60_000 });
  const profile = await ctx.db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').bind(staffId).first();

  const leaveDays = Number(person.leave_days ?? await setting(ctx.db, 'att_leave_days', 15)) || 15;

  const values = {
    name: person.name,
    first_name: String(person.name ?? '').trim().split(/\s+/)[0],
    employee_no: person.employee_no,
    job_title: person.job_title,
    department: person.department,
    start_date: person.hired_on,
    address: [profile?.address_line, profile?.town, profile?.region].filter(Boolean).join(', '),
    id_type: profile?.id_type,
    property: await setting(ctx.db, 'property_name', 'Somewhere Nice'),
    property_address: await setting(ctx.db, 'property_address', ''),
    // Never less than the fifteen working days section 20 of Act 651 requires,
    // whatever the settings happen to say. A contract promising twelve would be
    // void as to that term and an embarrassment to have issued.
    leave_days: `${Math.max(15, leaveDays)} working days`,
    today: new Date().toISOString().slice(0, 10),
  };
  for (const asked of ASKED_PLACEHOLDERS) {
    const given = str(body.values?.[asked.key], asked.label, { max: 300 });
    values[asked.key] = given || asked.fallback || '';
  }

  const rendered = renderTemplate(source, values);
  const hash = await hashBody(rendered);

  const created = await ctx.db.prepare(
    `INSERT INTO hr_contract (staff_id, template_id, title, body, body_hash, status, fields,
                              satisfies, issued_by, issued_at)
     VALUES (?1,?2,?3,?4,?5,'draft',?6,?7,?8,datetime('now')) RETURNING id`,
  ).bind(
    staffId, template?.id ?? null,
    str(body.title, 'Title', { max: 160, fallback: template?.name || 'Contract of employment' }),
    rendered, hash, JSON.stringify(values), template?.satisfies ?? null, actorOf(ctx),
  ).first();

  await logEvent(ctx, { staffId, contractId: created.id, kind: 'contract_issued', detail: hash.slice(0, 16) });
  await audit(ctx, 'people.contract_issue', created.id, { staffId, hash });

  return json({ ok: true, id: created.id, hash });
}

export async function getContract(ctx, id) {
  const contract = await ctx.db.prepare(
    `SELECT c.*, p.name staff_name, p.employee_no
       FROM hr_contract c JOIN att_staff p ON p.id = c.staff_id WHERE c.id = ?`,
  ).bind(Number(id)).first();
  if (!contract) throw notFound('No such contract.');

  // Everything that happened to this contract, and everything that happened to
  // the link carrying it. The chain has to be unbroken to be worth anything:
  // "issued, link sent, link opened, document read, signed" is evidence, and
  // the same list with the middle two missing is an assertion with a timestamp.
  const events = await ctx.db.prepare(
    `SELECT kind, detail, at_utc, ip, agent FROM hr_event
      WHERE contract_id = ?1
         OR (contract_id IS NULL AND invite_id IN
              (SELECT invite_id FROM hr_invite_contract WHERE contract_id = ?1))
      ORDER BY id`,
  ).bind(contract.id).all();

  return json({
    contract: {
      ...contract,
      // Proof rather than assertion: the hash is recomputed from the stored
      // text every time it is read, and if it no longer matches the one
      // recorded at signing then the text has been altered since.
      intact: await hashBody(contract.body) === contract.body_hash,
    },
    events: events.results ?? [],
  });
}

/**
 * The property's side of the signature.
 *
 * A contract signed by one party is an offer. This is what makes it an
 * agreement, and it is a deliberate act by a named person rather than
 * something that happens automatically when the employee signs.
 */
export async function countersignContract(ctx, id) {
  const body = await readJson(ctx.request);
  const contract = await ctx.db.prepare('SELECT * FROM hr_contract WHERE id = ?').bind(Number(id)).first();
  if (!contract) throw notFound('No such contract.');
  if (contract.status !== 'signed') throw badRequest('Countersign it once they have signed it.');

  await ctx.db.prepare(
    `UPDATE hr_contract SET employer_name = ?2, employer_ink = ?3, employer_at = datetime('now')
      WHERE id = ?1`,
  ).bind(
    contract.id,
    str(body.name, 'Name', { required: true, max: 120 }),
    str(body.ink, 'Signature', { max: 200_000 }),
  ).run();

  await logEvent(ctx, {
    staffId: contract.staff_id, contractId: contract.id, kind: 'countersigned',
    detail: str(body.name, 'Name', { max: 120 }),
  });
  await audit(ctx, 'people.contract_countersign', contract.id, null);
  return json({ ok: true });
}

export async function voidContract(ctx, id) {
  const body = await readJson(ctx.request).catch(() => ({}));
  const contract = await ctx.db.prepare('SELECT * FROM hr_contract WHERE id = ?').bind(Number(id)).first();
  if (!contract) throw notFound('No such contract.');
  if (contract.status === 'signed') {
    throw badRequest('A signed contract cannot be withdrawn. Issue a replacement and say what it supersedes.');
  }

  await ctx.db.prepare("UPDATE hr_contract SET status = 'void', decline_note = ?2 WHERE id = ?1")
    .bind(contract.id, str(body.note, 'Reason', { max: 300 })).run();

  await logEvent(ctx, { staffId: contract.staff_id, contractId: contract.id, kind: 'contract_void' });
  await audit(ctx, 'people.contract_void', contract.id, null);
  return json({ ok: true });
}

/**
 * File a contract that was signed on paper.
 *
 * Everybody already working here signed something years ago, on paper, and
 * those are the contracts that matter most — for most of the staff they are
 * the only record of what was agreed. This puts the scan where a contract
 * belongs rather than in the general documents pile, so it appears in the same
 * list as the electronic ones and satisfies the same requirement.
 *
 * What it does not do is pretend the two are the same. There is no electronic
 * signature here and no chain of events behind it; what is recorded is who
 * says it was signed, when they say it was signed, and who filed the scan. The
 * fingerprint is of the file rather than of any text, which still answers the
 * question worth asking — has this scan been swapped since it was filed.
 */
export async function fileSignedContract(ctx, id) {
  const staffId = Number(id);
  const person = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const body = await readJson(ctx.request);
  const bytes = fromBase64(body.content);
  if (!bytes.length) throw badRequest('There was no file with that.');
  if (bytes.length > MAX_DOCUMENT) {
    throw badRequest(
      `That file is ${Math.round(bytes.length / 1_000_000)} MB and the limit is `
      + `${Math.round(MAX_DOCUMENT / 1_000_000)} MB. Scan it again at a lower resolution — `
      + '200 dpi in black and white is plenty for a contract.',
    );
  }

  const signedOn = str(body.signedOn, 'Date signed', { required: true, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) throw badRequest('Give the date it was signed.');
  if (signedOn > new Date().toISOString().slice(0, 10)) {
    throw badRequest('That date is in the future. A contract cannot have been signed yet.');
  }

  const title = str(body.title, 'Title', { max: 160, fallback: 'Contract of employment' });
  const satisfies = str(body.satisfies, 'Kind', { max: 40, fallback: 'contract' });

  const documentId = await storeFile(ctx, staffId, {
    kind: satisfies,
    title,
    filename: str(body.filename, 'File name', { max: 200 }),
    mime: str(body.mime, 'Type', { max: 80, fallback: 'application/pdf' }),
    bytes,
    expiresOn: str(body.expiresOn, 'Expiry', { max: 10 }),
  });

  const hash = await hashBytes(bytes);

  const created = await ctx.db.prepare(
    `INSERT INTO hr_contract
       (staff_id, title, body, body_hash, status, origin, document_id, satisfies,
        signed_at, signer_name, employer_name, employer_at, filed_by, filed_at, issued_by, issued_at)
     VALUES (?1, ?2, '', ?3, 'signed', 'paper', ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'), ?10, ?6)
     RETURNING id`,
  ).bind(
    staffId, title, hash, documentId, satisfies, signedOn,
    str(body.signerName, 'Signed by', { max: 120, fallback: person.name }),
    str(body.employerName, 'For the property', { max: 120 }),
    str(body.employerName, 'For the property', { max: 120 }) ? signedOn : null,
    actorOf(ctx),
  ).first();

  await logEvent(ctx, {
    staffId, contractId: created.id, kind: 'contract_filed',
    detail: `Signed on paper ${signedOn}; scan filed · ${hash.slice(0, 16)}`,
  });
  await audit(ctx, 'people.contract_filed', created.id, { staffId, signedOn, bytes: bytes.length });

  return json({ ok: true, id: created.id, documentId });
}

/** The fingerprint of a scan, so a swapped file can be told from the filed one. */
async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Put the standard set of templates in, without disturbing anything.
 *
 * Only the ones this property does not already have, matched on the code they
 * were loaded under. Somebody who has edited the permanent contract into their
 * own words keeps their version; somebody who has never loaded the data
 * protection notice gets it. Loading again after an update to the set adds
 * what is new and touches nothing else.
 */
export async function loadStandardTemplates(ctx) {
  const existing = await ctx.db.prepare('SELECT code FROM hr_template WHERE code IS NOT NULL').all();
  const have = new Set((existing.results ?? []).map((r) => r.code));

  let added = 0;
  for (const template of STANDARD_TEMPLATES) {
    if (have.has(template.code)) continue;

    // A property that wrote its own before loading these keeps the name it
    // chose; the standard one comes in under a name that says where it is from.
    const clash = await ctx.db.prepare('SELECT 1 FROM hr_template WHERE name = ?')
      .bind(template.name).first();

    await ctx.db.prepare(
      `INSERT INTO hr_template (name, kind, body, code, satisfies, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      clash ? `${template.name} (standard)` : template.name,
      template.kind, template.body, template.code, template.satisfies ?? null,
      actorOf(ctx),
    ).run();
    added += 1;
  }

  await audit(ctx, 'people.templates_standard', null, { added });
  return json({ ok: true, added, total: STANDARD_TEMPLATES.length });
}
