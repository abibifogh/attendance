import { siteOrigin } from '../lib/site.js';
import {
  badRequest, bool, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { allows } from '../lib/permissions.js';
import {
  ASKED_PLACEHOLDERS, ASKS, FIELDS, LISTS, LIST_MAP, PLACEHOLDERS, SECTIONS, SELF_FIELDS,
  askFor, cleanSubmission, diffSubmission, hashBody, maskProfile, missingFor,
  placeholdersIn, planFor, renderTemplate,
} from '../lib/people.js';
import {
  REQUIRED_DOCUMENTS, STANDARD_TEMPLATES, fileStatus,
} from '../lib/ghana-templates.js';
import { asBytes } from '../lib/files.js';
import { MAIN } from '../lib/companies.js';
import { emailPersonally, firstUsableEmail } from '../lib/notify.js';
import { firstUsableNumber, sendTexts } from '../lib/sms.js';
import { reauthenticate } from './correspondence.js';

/**
 * Employee records, from the property's side of the desk.
 *
 * The public side — the link a person opens on their phone — is in
 * `invite.js`, and the two share nothing but the database on purpose. One of
 * them is reached with a session and a permission; the other is reached by
 * anybody holding a link, so the smaller its surface the better.
 */

// Nobody, when the caller is somebody holding a link rather than a login. The
// public routes always pass a `by` of their own, and a crash here would be a
// signed-out caller taking the request down rather than being named.
const actorOf = (ctx) => (ctx.session?.user
  ? `${ctx.session.user.name} (${ctx.session.user.role})`
  : null);
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
    ctx.request?.headers?.get('CF-Connecting-IP') || null,
    (ctx.request?.headers?.get('User-Agent') || '').slice(0, 300) || null,
  ).run().catch(() => {});
}

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first().catch(() => null);
  return row?.value ?? fallback;
}

/** The registered name of the company that employs somebody. */
export async function employerName(db, person) {
  const company = Number(person?.company_id) || MAIN;
  if (company !== MAIN) {
    const row = await db.prepare('SELECT legal_name FROM company WHERE id = ? AND main = 0')
      .bind(company).first().catch(() => null);
    if (row?.legal_name) return row.legal_name;
  }
  return (await setting(db, 'company_legal_name', ''))
    || setting(db, 'property_name', 'Somewhere Nice');
}

/** The address of the company that employs somebody, the property's where it is the main one or has none. */
export async function employerAddress(db, person) {
  const company = Number(person?.company_id) || MAIN;
  if (company !== MAIN) {
    const row = await db.prepare('SELECT address FROM company WHERE id = ? AND main = 0')
      .bind(company).first().catch(() => null);
    if (String(row?.address ?? '').trim()) return row.address.trim();
  }
  return setting(db, 'property_address', '');
}

/** Every company, by the name it is known by, the main one first. */
export async function companyNames(db) {
  const rows = await db.prepare('SELECT id, main, legal_name FROM company ORDER BY main DESC, id')
    .all().catch(() => ({ results: [] }));
  const main = (await setting(db, 'company_legal_name', '')) || await setting(db, 'property_name', 'Somewhere Nice');
  const list = (rows.results ?? []).map((r) => ({ id: Number(r.id), name: r.main ? main : (r.legal_name || `Company ${r.id}`) }));
  return list.length ? list : [{ id: MAIN, name: main }];
}

/**
 * Whether a template may go to this person. A template for one company is
 * only for the people that company employs; one without a company is for
 * everybody. Said in words that name both, because the fix is to choose the
 * other template, and that needs knowing which company is which.
 */
export async function templateFits(db, template, person) {
  const owner = Number(template?.company_id) || null;
  if (!owner) return;
  const theirs = Number(person?.company_id) || MAIN;
  if (owner === theirs) return;
  const names = new Map((await companyNames(db)).map((c) => [c.id, c.name]));
  throw badRequest(`“${template.name}” is for ${names.get(owner) ?? 'another company'}, and ${person.name} `
    + `is employed by ${names.get(theirs) ?? 'another company'}. Choose a template for their company.`);
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
    // Only what is actually on the file. A photograph somebody sent in an hour
    // ago and nobody has looked at does not make a record complete — that is
    // the whole point of it waiting.
    ctx.db.prepare("SELECT id, staff_id, kind, expires_on FROM hr_document WHERE status = 'filed'").all(),
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
      companyId: Number(person.company_id) || MAIN,
      // Kept purely to be paid: no rota, no attendance, nothing chasing them.
      // Worth saying on the list, because their record looking thin is the
      // point rather than something anybody needs to go and fix.
      payrollOnly: person.on_clock === 0,
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
      `SELECT id, kind, title, filename, mime, bytes, expires_on, uploaded_by, uploaded_at,
              status, source, note, decided_by, decided_at
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
      companyId: Number(person.company_id) || MAIN,
    },
    profile: maskProfile(profile, { full }),
    lists,
    missing: missingFor(profile, lists).map((g) => g.label),
    // Split three ways, because they are three different things. What is on
    // the file; what somebody has sent in and nobody has looked at yet; and
    // what was looked at and sent back. Only the first counts as held — a
    // photograph that arrived an hour ago does not complete a file, which is
    // the entire point of it waiting.
    documents: (documents.results ?? []).filter((d) => d.status === 'filed'),
    waitingDocuments: (documents.results ?? []).filter((d) => d.status === 'pending'),
    rejectedDocuments: (documents.results ?? []).filter((d) => d.status === 'rejected'),
    contracts: contracts.results ?? [],
    // What ought to be in this particular person's file, and what is. Two of
    // the requirements depend on who they are — a food handler's certificate,
    // a work permit — so the list is worked out per person rather than shown
    // to everybody and ignored by most of them.
    fileStatus: fileStatus(person, profile, {
      documents: (documents.results ?? []).filter((d) => d.status === 'filed'),
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
export async function storeFile(ctx, staffId, {
  kind, title, filename, mime, bytes, expiresOn,
  status = 'filed', source = 'office', inviteId = null, note = null, by = null,
}) {
  const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));

  const created = await ctx.db.prepare(
    `INSERT INTO hr_document (staff_id, kind, title, filename, mime, bytes, content, parts,
                              expires_on, uploaded_by, status, source, invite_id, note)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) RETURNING id`,
  ).bind(
    staffId, kind, title, filename, mime, bytes.length,
    bytes.subarray(0, CHUNK), parts, expiresOn, by ?? actorOf(ctx),
    status, source, inviteId, note,
  ).first();

  for (let seq = 1; seq < parts; seq += 1) {
    await ctx.db.prepare(
      'INSERT INTO hr_document_part (document_id, seq, content) VALUES (?1, ?2, ?3)',
    ).bind(created.id, seq, bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK)).run();
  }

  return created.id;
}


/** Read a file back, in order. */
export async function readFile(db, row) {
  // asBytes rather than an ArrayBuffer check: D1 returns a BLOB as a plain
  // array of numbers, which this let through untouched and straight into a
  // Response, where it stringifies.
  const first = asBytes(row.content) ?? new Uint8Array(0);
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
    chunks.push(asBytes(part.content) ?? new Uint8Array(0));
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

/**
 * What this property asks its people for.
 *
 * Returns the whole catalogue alongside the plan rather than only what is
 * switched on, because this is the screen where somebody switches things on and
 * a list that hides what it is hiding is not a list anybody can use.
 */
export async function getForm(ctx) {
  const row = await ctx.db.prepare("SELECT value FROM settings WHERE key = 'hr_form'")
    .first().catch(() => null);
  const plan = planFor(row?.value);

  return json({
    plan,
    asks: ASKS,
    sections: SECTIONS.map((section) => ({
      key: section.key,
      label: section.label,
      note: section.note ?? null,
      fields: section.fields.filter((f) => f.self).map((f) => ({
        key: f.key, label: f.label, hint: f.hint ?? null, ask: askFor(plan, 'fields', f.key),
      })),
    })).filter((section) => section.fields.length),
    lists: LISTS.filter((l) => l.self).map((l) => ({
      key: l.key, label: l.label, ask: askFor(plan, 'lists', l.key),
    })),
    // Only the paper somebody can photograph. A contract is not on this list:
    // it is the property's own document, signed here, and would mean nothing
    // arriving as a snapshot from the person it binds.
    documents: REQUIRED_DOCUMENTS.filter((d) => d.self).map((d) => ({
      code: d.code,
      label: d.label,
      detail: d.detail ?? null,
      applies: d.applies,
      ask: askFor(plan, 'documents', d.code),
    })),
  });
}

/**
 * Save it, keeping only what differs from the standard set.
 *
 * The sparseness is the point and is enforced here rather than trusted from the
 * screen: a plan that wrote down every field would freeze the form at the
 * moment it was saved, and a field added to the code next year would never be
 * asked for again by a property that had once pressed Save.
 */
export async function saveForm(ctx) {
  const body = await readJson(ctx.request);
  const wanted = planFor(body.plan ?? body);

  const known = {
    fields: new Set(SELF_FIELDS.map((f) => f.key)),
    lists: new Set(LISTS.filter((l) => l.self).map((l) => l.key)),
    documents: new Set(REQUIRED_DOCUMENTS.filter((d) => d.self).map((d) => d.code)),
  };

  const plan = { fields: {}, lists: {}, documents: {} };
  for (const group of ['fields', 'lists', 'documents']) {
    for (const [key, value] of Object.entries(wanted[group])) {
      if (!known[group].has(key)) continue;
      if (value === 'ask') continue; // The default. Storing it buys nothing.
      plan[group][key] = value;
    }
  }

  const empty = Object.values(plan).every((group) => !Object.keys(group).length);
  await ctx.db.prepare(
    `INSERT INTO settings (key, value) VALUES ('hr_form', ?1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(empty ? '' : JSON.stringify(plan)).run();

  await audit(ctx, 'people.form', null, {
    required: Object.values(plan).flatMap((g) => Object.entries(g))
      .filter(([, v]) => v === 'require').map(([k]) => k),
    skipped: Object.values(plan).flatMap((g) => Object.entries(g))
      .filter(([, v]) => v === 'skip').map(([k]) => k),
  });

  return json({ ok: true, plan });
}

/** The plan, for the routes that have to apply it rather than display it. */
export async function currentPlan(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'hr_form'")
    .first().catch(() => null);
  return planFor(row?.value);
}

/**
 * Paper somebody sent in from their phone, waiting to be looked at.
 *
 * Beside the details they sent rather than on a screen of its own: they arrive
 * together, from one link, and reviewing half of what somebody sent is how the
 * other half sits for a fortnight.
 */
export async function listWaitingDocuments(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT d.id, d.staff_id, d.kind, d.title, d.filename, d.mime, d.bytes, d.note,
            d.uploaded_at, d.uploaded_by, d.source, s.name AS staff_name, s.employee_no
       FROM hr_document d JOIN att_staff s ON s.id = d.staff_id
      WHERE d.status = 'pending'
      ORDER BY d.uploaded_at, d.id`,
  ).bind().all().catch(() => ({ results: [] }));

  return json({ documents: rows.results ?? [] });
}

/**
 * Accept a file onto the record, or send it back.
 *
 * The same shape as accepting a set of details, and for the same reason: what
 * somebody sends in is a claim until a colleague has looked at it. A photograph
 * of the wrong side of a card, or of somebody else's card, is exactly the thing
 * a review catches and a direct upload would not.
 */
export async function decideDocument(ctx, id) {
  const body = await readJson(ctx.request);
  const decision = str(body.decision, 'Decision', { required: true, max: 20 });
  if (!['accept', 'reject'].includes(decision)) {
    throw badRequest('A file is either accepted onto the record or sent back.');
  }
  const note = str(body.note, 'Note', { max: 400 });
  if (decision === 'reject' && !note) {
    throw badRequest('Say why, so they know what to send instead.');
  }

  const row = await ctx.db.prepare('SELECT * FROM hr_document WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such file.');
  if (row.status !== 'pending') throw badRequest(`That was already ${row.status}.`);

  await ctx.db.prepare(
    `UPDATE hr_document
        SET status = ?2, decided_by = ?3, decided_at = datetime('now'),
            note = COALESCE(?4, note),
            expires_on = COALESCE(?5, expires_on)
      WHERE id = ?1`,
  ).bind(
    row.id,
    decision === 'accept' ? 'filed' : 'rejected',
    actorOf(ctx),
    note || null,
    str(body.expiresOn, 'Expiry', { max: 10 }) || null,
  ).run();

  await logEvent(ctx, {
    staffId: row.staff_id,
    inviteId: row.invite_id,
    kind: decision === 'accept' ? 'file_accepted' : 'file_rejected',
    detail: row.title,
  });
  await audit(ctx, `people.document_${decision}`, row.staff_id, { title: row.title, note });

  return json({ ok: true });
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
  const invite = await makeInvite(ctx, person, body);

  // Sent by HIVE where it can be: an email to their own address and a text
  // to their phone. The link is on screen either way, to pass on by hand.
  const delivered = await deliverInvite(ctx, person, invite, {
    email: bool(body.sendEmail, false),
    text: bool(body.sendText, false),
  });

  return json({
    ok: true,
    id: invite.id,
    url: invite.url,
    pin: invite.pin,
    expiresInDays: invite.days,
    // Written out so it can be pasted straight into a message.
    message: invite.message,
    delivered,
  });
}

/**
 * Make a link for one person: their details, contracts, or both. Returns the
 * address once; only its hash is kept.
 */
export async function makeInvite(ctx, person, body = {}) {
  const staffId = Number(person.id);
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
    body.pinHash ?? (pin ? await hashInvitePin(pin, pepper) : null),
    wantsDetails ? 1 : 0,
    str(body.message, 'Message', { max: 400 }),
    `+${days} days`,
    body.by ?? actorOf(ctx),
  ).first();

  // Only contracts belonging to this person, and only ones still open. A link
  // cannot be made to carry somebody else's contract by passing its number.
  let carried = 0;
  for (const contractId of contractIds) {
    const contract = await ctx.db.prepare(
      "SELECT id FROM hr_contract WHERE id = ? AND staff_id = ? AND status IN ('draft','sent','opened')",
    ).bind(contractId, staffId).first();
    if (!contract) continue;
    carried += 1;

    await ctx.db.prepare(
      'INSERT OR IGNORE INTO hr_invite_contract (invite_id, contract_id) VALUES (?, ?)',
    ).bind(created.id, contractId).run();
    await ctx.db.prepare(
      "UPDATE hr_contract SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, issued_at = COALESCE(issued_at, datetime('now')) WHERE id = ?",
    ).bind(contractId).run();
  }

  await logEvent(ctx, {
    staffId, inviteId: created.id, kind: 'link_created',
    detail: `${wantsDetails ? 'details' : ''}${wantsDetails && carried ? ' + ' : ''}${carried ? `${carried} contract(s)` : ''}`,
  });
  await audit(ctx, 'people.invite', staffId, { days, contracts: carried, pin: Boolean(pin || body.pinHash) });

  const url = `${await siteOrigin(ctx.db, ctx.url?.origin)}/i/${token}`;
  return {
    id: created.id,
    url,
    pin,
    days,
    wantsDetails,
    contracts: carried,
    hasPin: Boolean(pin || body.pinHash),
    message: linkMessage(person.name, url, wantsDetails, carried),
  };
}

/**
 * Send a link to the person by email and by text, where asked and where the
 * property can. The code, if there is one, never goes with it: it is given
 * separately, which is the whole of its point.
 */
export async function deliverInvite(ctx, person, invite, { email = false, text = false, reminder = false } = {}) {
  const out = { emailed: false, texted: false, email: null, phone: null, whyNot: [] };
  if (!email && !text) return out;

  const profile = await ctx.db.prepare('SELECT personal_email, personal_phone, alt_phone FROM hr_profile WHERE staff_id = ?')
    .bind(person.id).first().catch(() => null);
  const login = await ctx.db.prepare('SELECT email FROM users WHERE staff_id = ? AND active = 1 LIMIT 1')
    .bind(person.id).first().catch(() => null);
  const first = String(person.name ?? '').trim().split(/\s+/)[0];
  const asks = [];
  if (invite.wantsDetails) asks.push('fill in your details');
  if (invite.contracts) asks.push(invite.contracts === 1 ? 'read and sign your contract' : `read and sign ${invite.contracts} documents`);
  const what = asks.join(' and ') || 'finish what we need from you';

  if (email) {
    const to = firstUsableEmail(profile?.personal_email, login?.email);
    out.email = to;
    if (!to) out.whyNot.push('no email address on their record');
    else {
      const sent = await emailPersonally(ctx.db, ctx.env, {
        kind: 'people.link',
        level: 'info',
        title: reminder ? `Reminder: please ${what}` : `Please ${what}`,
        body: `Open the link to ${what}. It is private to you and stops working in ${invite.days} days.`,
        link: invite.url,
        to,
        wanted: true,
        mail: {
          status: reminder ? 'Reminder' : 'Welcome',
          tone: 'info',
          eyebrow: 'Your details',
          subject: reminder ? `Reminder: please ${what}` : `${first}, please ${what}`,
          preheader: `It takes a few minutes on your phone.`,
          headline: reminder ? `${first}, this is still waiting for you` : `Welcome, ${first}`,
          note: `Please open the link to ${what}. It works on your phone and is private to you.`
            + (invite.hasPin ? ' You will be asked for a four-digit code, which we give you separately.' : ''),
          button: invite.contracts ? 'Open and sign' : 'Fill in my details',
          why: 'You get this because you are joining the team.',
        },
      }).catch((err) => ({ sent: 0, reason: err.message }));
      out.emailed = Number(sent?.sent ?? 0) > 0;
      if (!out.emailed) out.whyNot.push(`email not sent: ${sent?.reason ?? 'unknown'}`);
    }
  }

  if (text) {
    const phone = firstUsableNumber(profile?.personal_phone, profile?.alt_phone);
    out.phone = phone;
    if (!phone) out.whyNot.push('no phone number on their record');
    else {
      const message = `${reminder ? 'Reminder: ' : ''}Hello ${first}, please open this link to ${what}: ${invite.url}`
        + (invite.hasPin ? ' You will need the code we give you.' : '');
      const sent = await sendTexts(ctx.db, ctx.env, { messages: [{ to: phone, text: message }], kind: 'people.link' })
        .catch((err) => ({ sent: 0, reason: err.message }));
      out.texted = Number(sent?.sent ?? 0) > 0;
      if (!out.texted) out.whyNot.push(`text not sent: ${sent?.reason ?? 'unknown'}`);
    }
  }

  if (out.emailed || out.texted) {
    await ctx.db.prepare(
      `UPDATE hr_invite SET sent_at = COALESCE(sent_at, datetime('now')), sent_to = ?2,
              by_email = ?3, by_text = ?4
        WHERE id = ?1`,
    ).bind(
      invite.id, [out.emailed ? out.email : null, out.texted ? out.phone : null].filter(Boolean).join(', '),
      out.emailed ? 1 : 0, out.texted ? 1 : 0,
    ).run().catch(() => {});
    await logEvent(ctx, {
      staffId: person.id, inviteId: invite.id, kind: reminder ? 'link_reminded' : 'link_sent',
      detail: [out.emailed ? 'email' : null, out.texted ? 'text' : null].filter(Boolean).join(' + '),
    });
  }
  return out;
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
  const held = new Set((rows.results ?? []).map((t) => t.code).filter(Boolean));

  return json({
    rows: (rows.results ?? []).map((t) => ({ ...t, company_id: Number(t.company_id) || null, uses: placeholdersIn(t.body) })),
    placeholders: PLACEHOLDERS,
    companies: await companyNames(ctx.db),
    // What the standard set would add that is not here. A property that loaded
    // the set a year ago has no way of knowing a new one has been written
    // since, and "Load the standard set" reads like something already done.
    missing: STANDARD_TEMPLATES
      .filter((t) => !held.has(t.code))
      .map((t) => ({ code: t.code, name: t.name, kind: t.kind })),
  });
}

export async function saveTemplate(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 120 });
  const text = str(body.body, 'The words', { required: true, max: 60_000 });
  const kind = ['contract', 'letter', 'policy', 'correspondence'].includes(body.kind)
    ? body.kind : 'contract';
  // Empty is every company. Anything else has to be one that exists.
  const companyId = body.companyId == null || body.companyId === '' ? null : Number(body.companyId);
  if (companyId != null && !(await companyNames(ctx.db)).some((c) => c.id === companyId)) {
    throw badRequest('That company does not exist.');
  }

  if (id) {
    await ctx.db.prepare(
      `UPDATE hr_template SET name = ?2, body = ?3, kind = ?4, active = ?5, company_id = ?6,
              updated_at = datetime('now') WHERE id = ?1`,
    ).bind(Number(id), name, text, kind, bool(body.active, true) ? 1 : 0,
      body.companyId === undefined
        ? (await ctx.db.prepare('SELECT company_id FROM hr_template WHERE id = ?').bind(Number(id)).first())?.company_id ?? null
        : companyId).run();
    await audit(ctx, 'people.template_save', id, { name, companyId });
    return json({ ok: true, id: Number(id) });
  }

  const created = await ctx.db.prepare(
    'INSERT INTO hr_template (name, body, kind, created_by, company_id) VALUES (?1,?2,?3,?4,?5) RETURNING id',
  ).bind(name, text, kind, actorOf(ctx), companyId).first();

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
  const out = await issueContractFor(ctx, person, body);
  return json({ ok: true, ...out });
}

/**
 * One document to several people at once: a revised contract, a new policy
 * to acknowledge, a confidentiality agreement for a whole department.
 *
 * Each person gets their own copy, filled in with their own particulars, on a
 * link of their own, sent by email and text where HIVE can and reminded until
 * signed. Values asked of the template, like a probation period, are the same
 * for everybody here; anything that differs per person, like a salary, is
 * issued one at a time from their record.
 */
export async function issueToMany(ctx) {
  const body = await readJson(ctx.request);
  const templateId = int(body.templateId, 'Template', { required: true, min: 1 });
  const ids = [...new Set((Array.isArray(body.staffIds) ? body.staffIds : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw badRequest('Choose who it goes to.');
  if (ids.length > 200) throw badRequest('Two hundred at most in one go.');
  const template = await ctx.db.prepare('SELECT * FROM hr_template WHERE id = ? AND active = 1').bind(templateId).first();
  if (!template) throw notFound('No such template.');

  const results = [];
  for (const id of ids) {
    const person = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ? AND active = 1').bind(id).first();
    if (!person) { results.push({ staffId: id, ok: false, error: 'Not on the staff list' }); continue; }
    try {
      const issued = await issueContractFor(ctx, person, { templateId, values: body.values ?? {} });
      const invite = await makeInvite(ctx, person, {
        wantsDetails: false, contractIds: [issued.id], days: body.days,
        message: str(body.message, 'Message', { max: 400 }),
      });
      const delivered = await deliverInvite(ctx, person, invite, {
        email: bool(body.sendEmail, true), text: bool(body.sendText, true),
      });
      results.push({
        staffId: person.id, name: person.name, ok: true, contractId: issued.id,
        sent: delivered.emailed || delivered.texted,
        // Only for the ones HIVE could not send, to pass on by hand.
        url: delivered.emailed || delivered.texted ? null : invite.url,
        message: delivered.emailed || delivered.texted ? null : invite.message,
        whyNot: delivered.whyNot,
      });
    } catch (err) {
      results.push({ staffId: person.id, name: person.name, ok: false, error: err.message });
    }
  }
  await audit(ctx, 'people.contract_issue_many', templateId, {
    people: ids.length, issued: results.filter((r) => r.ok).length, sent: results.filter((r) => r.sent).length,
  });
  return json({
    ok: true,
    issued: results.filter((r) => r.ok).length,
    sent: results.filter((r) => r.sent).length,
    results,
  });
}

/**
 * The issuing itself, for one person: the contract screen, a new starter's
 * welcome and a contract sent to many people at once all come through here.
 */
export async function issueContractFor(ctx, person, body = {}) {
  const staffId = Number(person.id);
  const template = body.templateId
    ? await ctx.db.prepare('SELECT * FROM hr_template WHERE id = ?').bind(Number(body.templateId)).first()
    : null;
  if (body.templateId && !template) throw notFound('No such template.');
  if (template) await templateFits(ctx.db, template, person);

  const source = template?.body ?? str(body.body, 'The words', { required: true, max: 60_000 });
  const values = await contractValues(ctx, person, body);

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

  return { id: created.id, hash };
}

/** What fills a template's placeholders for this person, as it would be issued. */
async function contractValues(ctx, person, body = {}) {
  const staffId = Number(person.id);
  const profile = staffId
    ? await ctx.db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').bind(staffId).first()
    : null;

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
    // The party to the contract, which is the registered company that employs
    // them and not the trading name: the main company's from the Company form,
    // another company's from its own record.
    company_legal_name: await employerName(ctx.db, person),
    company_address: await employerAddress(ctx.db, person),
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
  return values;
}

/**
 * A template as somebody would read it, before anything is issued.
 *
 * Filled in for a real member of staff where one is chosen, so the office
 * sees exactly the words that person would be sent; otherwise for a sample
 * person whose particulars are plainly made up. What is typed in when the
 * document is issued (pay, probation and the rest) shows as a marked gap
 * unless a value is given, or its lawful fallback where it has one. Nothing
 * is stored.
 */
export async function previewTemplate(ctx) {
  const body = await readJson(ctx.request);
  const template = body.templateId
    ? await ctx.db.prepare('SELECT * FROM hr_template WHERE id = ?').bind(Number(body.templateId)).first()
    : null;
  if (body.templateId && !template) throw notFound('No such template.');
  const source = body.body != null
    ? str(body.body, 'The words', { required: true, max: 60_000 })
    : template?.body;
  if (!source) throw badRequest('There are no words to preview.');

  const staffId = Number(body.staffId) || null;
  const person = staffId
    ? await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first()
    : null;
  if (staffId && !person) throw notFound('No such member of staff.');

  // A sample person is employed by the template's own company, so the
  // contract names the employer it would.
  const companyId = Number(body.companyId ?? template?.company_id) || null;
  const values = await contractValues(ctx, person ?? { ...SAMPLE_PERSON, company_id: companyId }, { values: body.values ?? {} });
  if (!person) Object.assign(values, sampleValues());
  const given = body.values && typeof body.values === 'object' ? body.values : {};
  for (const asked of ASKED_PLACEHOLDERS) {
    if (!String(given[asked.key] ?? '').trim() && !asked.fallback) values[asked.key] = `[${asked.label}: typed in when it is issued]`;
  }
  const title = str(body.name, 'Name', { max: 160 }) || template?.name || 'Untitled';
  return json({
    title,
    body: renderTemplate(source, values),
    person: person ? { id: person.id, name: person.name } : null,
    property: await setting(ctx.db, 'property_name', 'Somewhere Nice'),
    // Its cover page, for the person it is shown for.
    cover: await coverOf(ctx.db, {
      companyId: person ? person.company_id : companyId,
      title,
      kind: ['contract', 'letter', 'policy', 'correspondence'].includes(body.kind) ? body.kind : (template?.kind ?? 'contract'),
      name: values.name,
      job: values.job_title,
      department: values.department,
      start: values.start_date,
      reference: '[Given when issued]',
      issued: new Date().toISOString().slice(0, 10),
      employeeNo: values.employee_no,
    }),
  });
}

/** Somebody who does not exist, for previewing a template without a real person behind it. */
const SAMPLE_PERSON = { id: 0, name: 'Ama Sample', employee_no: 'SAMPLE-01', job_title: 'Front desk agent', department: 'Front office' };
// Worked out when asked rather than when the file loads: a Worker's clock
// reads zero until a request is being handled.
const sampleValues = () => ({
  address: '[their home address]',
  id_type: '[their ID document]',
  start_date: new Date().toISOString().slice(0, 10),
});

export async function contractWithTrail(db, id) {
  const contract = await db.prepare(
    `SELECT c.*, p.name staff_name, p.employee_no, p.company_id staff_company_id
       FROM hr_contract c JOIN att_staff p ON p.id = c.staff_id WHERE c.id = ?`,
  ).bind(Number(id)).first();
  if (!contract) return null;

  // Everything that happened to this contract, and everything that happened to
  // the link carrying it. The chain has to be unbroken to be worth anything:
  // "issued, link sent, link opened, document read, signed" is evidence, and
  // the same list with the middle two missing is an assertion with a timestamp.
  const events = await db.prepare(
    `SELECT kind, detail, at_utc, ip, agent FROM hr_event
      WHERE contract_id = ?1
         OR (contract_id IS NULL AND invite_id IN
              (SELECT invite_id FROM hr_invite_contract WHERE contract_id = ?1))
      ORDER BY id`,
  ).bind(contract.id).all();

  return {
    contract: {
      ...contract,
      // Proof rather than assertion: the hash is recomputed from the stored
      // text every time it is read, and if it no longer matches the one
      // recorded at signing then the text has been altered since.
      intact: await hashBody(contract.body) === contract.body_hash,
    },
    events: events.results ?? [],
    cover: contract.origin === 'paper' ? null : await contractCover(db, contract),
  };
}

export const contractRef = (id) => `HR-C-${String(id).padStart(5, '0')}`;

/**
 * What goes on a contract's cover page: the company that employs them (its
 * registered name, the trading name where that is different, its address and
 * whether it has a logo), the document's name, one sentence saying who it is
 * between and for what, and the reference, the date it was issued and the
 * employee number. Worked out from what is stored; nothing here changes the
 * words that were signed.
 */
export async function contractCover(db, contract) {
  const fields = (() => { try { return JSON.parse(contract.fields || '{}'); } catch { return {}; } })();
  const template = contract.template_id
    ? await db.prepare('SELECT kind FROM hr_template WHERE id = ?').bind(contract.template_id).first().catch(() => null)
    : null;
  return coverOf(db, {
    companyId: contract.staff_company_id,
    title: contract.title,
    kind: template?.kind ?? 'contract',
    name: contract.staff_name ?? fields.name ?? '',
    job: fields.job_title,
    department: fields.department,
    start: fields.start_date,
    reference: contractRef(contract.id),
    issued: contract.issued_at ?? contract.created_at,
    employeeNo: contract.employee_no ?? null,
  });
}

/**
 * The cover, from its parts, for a contract, an offer or a template being
 * previewed alike. `offered` says "who would be employed" rather than "who is
 * employed", for an offer not yet accepted.
 */
export async function coverOf(db, {
  companyId: given, title: fullTitle, kind = 'contract', name = '', job = '', department = '', start = '',
  reference = null, issued = null, employeeNo = null, offered = false,
}) {
  const companyId = Number(given) || MAIN;
  const person = { company_id: companyId };
  const companyName = await employerName(db, person);
  const tradingName = await setting(db, 'property_name', '');
  const logo = companyId === MAIN
    ? await db.prepare('SELECT 1 AS yes FROM company_logo WHERE id = 1').first().catch(() => null)
    : await db.prepare('SELECT 1 AS yes, logo_at FROM company WHERE id = ? AND logo_content IS NOT NULL').bind(companyId).first().catch(() => null);
  const stamp = companyId === MAIN ? await setting(db, 'company_logo_at', '') : (logo?.logo_at ?? '');

  // "Contract of employment — permanent" reads as a title and a kind.
  const [title, ...rest] = String(fullTitle ?? '').split(/\s+[—–-]\s+/);
  const subtitle = rest.join(' - ').trim();
  const role = String(job ?? '').trim();
  const dept = String(department ?? '').trim();
  const from = String(start ?? '').trim();
  const sayDay = (day) => (/^\d{4}-\d{2}-\d{2}/.test(day)
    ? new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : day);
  const sentence = kind === 'contract' && role
    ? `made between ${companyName} and ${name}, who ${offered ? 'would be' : 'is'} employed as ${role}`
      + `${dept ? ` in the ${dept} department` : ''}${from ? ` from ${sayDay(from)}` : ''}, `
      + 'under the Labour Act, 2003 (Act 651).'
    : `made between ${companyName} and ${name}.`;

  return {
    companyId,
    companyName,
    tradingAs: companyId === MAIN && tradingName && tradingName.trim().toLowerCase() !== String(companyName).trim().toLowerCase()
      ? tradingName : null,
    address: (await employerAddress(db, person)) || null,
    hasLogo: Boolean(logo?.yes),
    logoUrl: logo?.yes ? `/api/company/logo?company=${companyId}${stamp ? `&v=${encodeURIComponent(stamp)}` : ''}` : null,
    title: title || 'Contract',
    subtitle: subtitle ? subtitle[0].toUpperCase() + subtitle.slice(1) : null,
    sentence,
    reference,
    issued: String(issued ?? '').slice(0, 10) || null,
    employeeNo,
  };
}

/** A company's logo as a response, for a page reached by a link rather than a login. */
export async function logoResponse(db, companyId) {
  const logo = await companyLogoBytes(db, companyId);
  if (!logo) throw notFound('No logo has been uploaded.');
  return new Response(logo.bytes, {
    headers: { 'Content-Type': logo.mime || 'image/png', 'Cache-Control': 'private, max-age=3600' },
  });
}

/** The bytes of a company's logo, for a PDF, or null. */
export async function companyLogoBytes(db, companyId) {
  const row = (Number(companyId) || MAIN) === MAIN
    ? await db.prepare('SELECT mime, content FROM company_logo WHERE id = 1').first().catch(() => null)
    : await db.prepare('SELECT logo_mime AS mime, logo_content AS content FROM company WHERE id = ? AND logo_content IS NOT NULL')
      .bind(Number(companyId)).first().catch(() => null);
  if (!row?.content) return null;
  return { bytes: asBytes(row.content), mime: row.mime || '' };
}

export async function getContract(ctx, id) {
  const found = await contractWithTrail(ctx.db, id);
  if (!found) throw notFound('No such contract.');
  return json(found);
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
  if (contract.employer_at) throw badRequest('That is already countersigned.');
  // Your own PIN or password, as for signing a letter: a countersignature is
  // the property's signature, and it should not be possible to make one from a
  // screen somebody walked away from.
  await reauthenticate(ctx, body);
  await countersignNow(ctx, contract, body);
  return json({ ok: true });
}

/**
 * The countersignature itself, once whoever is signing has shown it is them.
 * Shared with taking somebody on, where the contract they signed with their
 * offer is countersigned in the same press.
 */
export async function countersignNow(ctx, contract, body) {
  const name = str(body.name, 'Name', { required: true, max: 120 });
  await ctx.db.prepare(
    `UPDATE hr_contract SET employer_name = ?2, employer_ink = ?3, employer_at = datetime('now')
      WHERE id = ?1`,
  ).bind(contract.id, name, str(body.ink, 'Signature', { max: 200_000 })).run();

  await logEvent(ctx, {
    staffId: contract.staff_id, contractId: contract.id, kind: 'countersigned', detail: name,
  });
  await audit(ctx, 'people.contract_countersign', contract.id, null);
  // Both sides have signed: the signed copy is made now and its fingerprint
  // kept, so it can be handed out and checked.
  const { signedContract } = await import('./signed-copies.js');
  return signedContract(ctx, contract.id).catch((err) => { console.error('Signed copy failed', err); return null; });
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
