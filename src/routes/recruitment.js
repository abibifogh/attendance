import { siteOrigin } from '../lib/site.js';
import {
  badRequest, bool, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { allows } from '../lib/permissions.js';
import { createNotice } from '../lib/notices.js';
import { fromBase64 } from '../lib/files.js';
import { claimOrphans, recompute } from '../lib/attendance-ingest.js';
import { todayIn } from '../util/dates.js';
import { mapLink, mapsKey } from '../lib/places.js';
import { readCv } from '../lib/cv-read.js';
import { extractPdfText } from '../lib/pdf-text.js';
import {
  CLOSED_STAGES, EMPLOYMENT, FILE_KINDS, LIVE_STAGES, SOURCES, STAGES, cutIntoSlots,
  endsAt, fromMinutes, howItIsGoing, isFileKind, isStage, offerable, readCandidateList,
  staffDocumentKind, stageLabel, toMinutes, whyNot,
} from '../lib/recruitment.js';

/**
 * Recruitment, from the property's side of the desk.
 *
 * The candidate's side — the link they open on their phone to pick an
 * interview time — is in `hiring.js`, and the two share nothing but the
 * database. One is reached with a session and a permission; the other is
 * reached by anybody holding a link, so the smaller its surface the better.
 * That split is the same one People and the invite page already use.
 *
 * The one rule worth stating twice: **nothing in this file writes to
 * att_staff except `hire`**, which is a deliberate press with an employee
 * number typed into it and its own permission on top. A pipeline that quietly
 * put people on the books would put strangers on the payroll.
 */

const actorOf = (ctx) => (ctx.session?.user
  ? `${ctx.session.user.name} (${ctx.session.user.role})`
  : null);

const canManage = (ctx) => allows('rec_manage', ctx.session.permissions);

/** What a candidate may send in. A CV is a photograph as often as a document. */
const ACCEPTED = ['image/', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_UPLOAD = 12_000_000;

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorOf(ctx), action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null).run().catch(() => {});
}

/** One line on a candidate's trail. Everything that happens to them lands here. */
export async function trail(db, {
  candidateId, inviteId = null, kind, fromStage = null, toStage = null,
  detail = null, actor = null, ip = null, agent = null,
}) {
  await db.prepare(
    `INSERT INTO rec_event (candidate_id, invite_id, kind, from_stage, to_stage, detail,
                            actor, ip, agent)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(candidateId, inviteId, kind, fromStage, toStage, detail, actor, ip, agent)
    .run().catch(() => {});
}

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key).first().catch(() => null);
  return row?.value ?? fallback;
}

const nowIn = async (db) => {
  const timezone = await setting(db, 'timezone', 'UTC');
  const today = todayIn(timezone);
  // The property's own clock, to the minute, so a slot that has just gone is
  // gone. Working it out from the date rather than trusting the server's zone.
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  return { today, at: `${today}T${clock}` };
};

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * Everything at once: the vacancies, everybody in the pipeline, the diary.
 *
 * One request rather than four, because the screen is a board and a board that
 * arrives in pieces flickers. It is a small table for a property this size —
 * a year of hiring is a few hundred rows.
 */
export async function board(ctx) {
  const { today, at } = await nowIn(ctx.db);

  const [roles, candidates, slots] = await Promise.all([
    ctx.db.prepare('SELECT * FROM rec_role ORDER BY status = \'closed\', opened_on DESC, id DESC')
      .all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      `SELECT c.*, s.day AS slot_day, s.starts_at AS slot_time, s.minutes AS slot_minutes,
              s.place AS slot_place, s.interviewer AS slot_interviewer,
              (SELECT COUNT(*) FROM rec_file f WHERE f.candidate_id = c.id) AS files,
              (SELECT COUNT(*) FROM rec_score r WHERE r.candidate_id = c.id) AS scores,
              (SELECT MAX(rating) FROM rec_score r WHERE r.candidate_id = c.id) AS best_rating,
              (SELECT COUNT(*) FROM rec_invite i
                WHERE i.candidate_id = c.id AND i.revoked_at IS NULL
                  AND i.expires_at > datetime('now')) AS live_links
         FROM rec_candidate c
         LEFT JOIN rec_slot s ON s.candidate_id = c.id AND s.cancelled_at IS NULL
        ORDER BY c.applied_on DESC, c.id DESC`,
    ).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      `SELECT s.*, c.name AS candidate_name, r.title AS role_title
         FROM rec_slot s
         LEFT JOIN rec_candidate c ON c.id = s.candidate_id
         LEFT JOIN rec_role r ON r.id = s.role_id
        WHERE s.day >= ?1 AND s.cancelled_at IS NULL
        ORDER BY s.day, s.starts_at`,
    ).bind(today).all().catch(() => ({ results: [] })),
  ]);

  const people = (candidates.results ?? []).map(shapeCandidate);
  const byRole = new Map();
  for (const person of people) {
    if (person.roleId == null) continue;
    if (!byRole.has(person.roleId)) byRole.set(person.roleId, []);
    byRole.get(person.roleId).push(person);
  }

  return json({
    today,
    now: at,
    canManage: canManage(ctx),
    // Whether this login can actually finish the job. Said by the server
    // rather than guessed by the screen, because the gate is here.
    canHire: allows('att_setup', ctx.session.permissions),
    stages: STAGES,
    sources: SOURCES,
    employment: EMPLOYMENT,
    fileKinds: FILE_KINDS,
    departments: (await setting(ctx.db, 'att_departments', '')).split('\n').filter(Boolean),
    place: await setting(ctx.db, 'rec_place', ''),
    // The default, as a place rather than a line of text, so a property that
    // picked its own front desk once never picks it again.
    placeAt: {
      id: await setting(ctx.db, 'rec_place_id', '') || null,
      lat: numberOrNull(await setting(ctx.db, 'rec_place_lat', '')),
      lng: numberOrNull(await setting(ctx.db, 'rec_place_lng', '')),
    },
    // Whether the Where box can offer suggestions. Never the key itself: this
    // answer is a yes or a no, and a key is money.
    canFindPlaces: Boolean((await mapsKey(ctx.env, ctx.db)).key),
    interviewerAt: {
      name: await setting(ctx.db, 'rec_interviewer', '') || null,
      staffId: numberOrNull(await setting(ctx.db, 'rec_interviewer_staff_id', '')),
    },
    // Who can be put on a panel, and which of them the app can actually reach.
    // Somebody on the books with no login is a perfectly good interviewer and
    // simply cannot be told, which the screen says rather than hiding them.
    panel: (await ctx.db.prepare(
      `SELECT s.id, s.name, s.department,
              (SELECT COUNT(*) FROM users u WHERE u.staff_id = s.id AND u.active = 1) AS reachable
         FROM att_staff s
        WHERE s.active = 1
        ORDER BY s.name`,
    ).all().catch(() => ({ results: [] }))).results?.map((row) => ({
      id: row.id,
      name: row.name,
      department: row.department,
      canBeTold: Number(row.reachable ?? 0) > 0,
    })) ?? [],
    slotMinutes: Number(await setting(ctx.db, 'rec_slot_minutes', 30)) || 30,
    roles: (roles.results ?? []).map((role) => {
      const mine = byRole.get(role.id) ?? [];
      return {
        ...shapeRole(role),
        counts: countBy(mine),
        going: howItIsGoing(role, mine),
      };
    }),
    candidates: people,
    diary: (slots.results ?? []).map(shapeSlot),
  });
}

const countBy = (people) => Object.fromEntries(
  STAGES.map((s) => [s.key, people.filter((p) => p.stage === s.key).length]),
);

const shapeRole = (role) => ({
  id: role.id,
  title: role.title,
  department: role.department,
  headcount: Number(role.headcount) || 1,
  status: role.status,
  hiringFor: role.hiring_for,
  employment: role.employment,
  detail: role.detail,
  openedOn: role.opened_on,
  neededBy: role.needed_by,
  closedOn: role.closed_on,
});

const shapeCandidate = (row) => ({
  id: row.id,
  roleId: row.role_id,
  name: row.name,
  phone: row.phone,
  email: row.email,
  source: row.source,
  referredBy: row.referred_by,
  stage: row.stage,
  outcome: row.outcome,
  appliedOn: row.applied_on,
  staffId: row.staff_id,
  hiredOn: row.hired_on,
  note: row.note,
  files: Number(row.files ?? 0),
  scores: Number(row.scores ?? 0),
  bestRating: row.best_rating == null ? null : Number(row.best_rating),
  liveLinks: Number(row.live_links ?? 0),
  interview: row.slot_day
    ? {
      day: row.slot_day,
      at: row.slot_time,
      ends: endsAt({ starts_at: row.slot_time, minutes: row.slot_minutes }),
      place: row.slot_place,
      interviewer: row.slot_interviewer,
    }
    : null,
});

const shapeSlot = (slot) => ({
  id: slot.id,
  placeId: slot.place_id ?? null,
  lat: slot.place_lat ?? null,
  lng: slot.place_lng ?? null,
  // Built here rather than on three screens, so a link that stops working
  // stops working in one place.
  directions: mapLink({
    placeId: slot.place_id, lat: slot.place_lat, lng: slot.place_lng, label: slot.place,
  }),
  roleId: slot.role_id,
  roleTitle: slot.role_title ?? null,
  day: slot.day,
  at: slot.starts_at,
  ends: endsAt(slot),
  minutes: Number(slot.minutes) || 30,
  place: slot.place,
  interviewer: slot.interviewer,
  interviewerStaffId: slot.interviewer_staff_id ?? null,
  candidateId: slot.candidate_id,
  candidateName: slot.candidate_name ?? null,
  takenAt: slot.taken_at,
  // 'them' where the candidate chose it. The distinction is worth showing:
  // a time somebody picked is a time somebody turns up to.
  takenBy: slot.taken_by,
});

// ---------------------------------------------------------------------------
// Vacancies
// ---------------------------------------------------------------------------

export async function createRole(ctx) {
  const body = await readJson(ctx.request);
  const row = await ctx.db.prepare(
    `INSERT INTO rec_role (title, department, headcount, hiring_for, employment, detail,
                           needed_by, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id`,
  ).bind(
    str(body.title, 'What the job is', { required: true, max: 120 }),
    str(body.department, 'Department', { max: 80 }),
    int(body.headcount, 'How many', { min: 1, max: 50, fallback: 1 }),
    str(body.hiringFor, 'Who it is for', { max: 120 }),
    readEmployment(body.employment),
    str(body.detail, 'What the job is', { max: 4000 }),
    readDayOrNull(body.neededBy, 'Needed by'),
    actorOf(ctx),
  ).first();

  await audit(ctx, 'recruitment.role_open', row.id, { title: body.title });
  return json({ ok: true, id: row.id });
}

export async function updateRole(ctx, id) {
  const roleId = Number(id);
  const role = await ctx.db.prepare('SELECT * FROM rec_role WHERE id = ?').bind(roleId).first();
  if (!role) throw notFound('No such vacancy.');

  const body = await readJson(ctx.request);
  const status = body.status == null ? role.status : readStatus(body.status);

  await ctx.db.prepare(
    `UPDATE rec_role
        SET title = ?2, department = ?3, headcount = ?4, hiring_for = ?5, employment = ?6,
            detail = ?7, needed_by = ?8, status = ?9,
            closed_on = CASE WHEN ?9 IN ('filled','closed') THEN COALESCE(closed_on, date('now'))
                             ELSE NULL END,
            updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(
    roleId,
    str(body.title, 'What the job is', { max: 120, fallback: role.title }),
    body.department === undefined ? role.department : str(body.department, 'Department', { max: 80 }),
    int(body.headcount, 'How many', { min: 1, max: 50, fallback: Number(role.headcount) || 1 }),
    body.hiringFor === undefined ? role.hiring_for : str(body.hiringFor, 'Who it is for', { max: 120 }),
    body.employment === undefined ? role.employment : readEmployment(body.employment),
    body.detail === undefined ? role.detail : str(body.detail, 'What the job is', { max: 4000 }),
    body.neededBy === undefined ? role.needed_by : readDayOrNull(body.neededBy, 'Needed by'),
    status,
  ).run();

  await audit(ctx, 'recruitment.role_update', roleId, { status });
  return json({ ok: true });
}

const readStatus = (value) => {
  const status = String(value ?? '').trim();
  if (!['open', 'on_hold', 'filled', 'closed'].includes(status)) {
    throw badRequest('A vacancy is open, on hold, filled or closed.');
  }
  return status;
};

const readEmployment = (value) => {
  if (value == null || value === '') return null;
  const key = String(value).trim();
  if (!EMPLOYMENT.some(([k]) => k === key)) throw badRequest('That is not a kind of employment.');
  return key;
};

const readSource = (value) => {
  if (value == null || value === '') return null;
  const key = String(value).trim();
  if (!SOURCES.some(([k]) => k === key)) throw badRequest('That is not one of the ways people find us.');
  return key;
};

/** A coordinate, or nothing. A blank setting is not the equator. */
function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readDayOrNull(value, label) {
  if (value == null || value === '') return null;
  const day = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest(`${label} has to be a date.`);
  return day;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export async function addCandidate(ctx) {
  const body = await readJson(ctx.request);
  const roleId = body.roleId == null || body.roleId === '' ? null : Number(body.roleId);
  if (roleId != null) await roleMustExist(ctx, roleId);

  const row = await ctx.db.prepare(
    `INSERT INTO rec_candidate (role_id, name, phone, email, source, referred_by, note,
                                applied_on, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,COALESCE(?8, date('now')),?9) RETURNING id`,
  ).bind(
    roleId,
    str(body.name, 'Their name', { required: true, max: 120 }),
    str(body.phone, 'Phone', { max: 40 }),
    str(body.email, 'Email', { max: 160 }),
    readSource(body.source),
    str(body.referredBy, 'Referred by', { max: 120 }),
    str(body.note, 'Note', { max: 2000 }),
    readDayOrNull(body.appliedOn, 'Applied on'),
    actorOf(ctx),
  ).first();

  await trail(ctx.db, {
    candidateId: row.id, kind: 'added', toStage: 'applied', actor: actorOf(ctx),
  });
  await audit(ctx, 'recruitment.candidate_add', row.id, { roleId });
  return json({ ok: true, id: row.id });
}

/**
 * A pasted list, read and shown before anything is written.
 *
 * The realistic case is a stack of applications, or a list forwarded from an
 * agency. Same shape as every other import in this app: read it, show what it
 * found, and only write when somebody presses the second button.
 *
 * It creates candidates and nothing else. Nobody reaches the books this way.
 */
export async function readCandidates(ctx) {
  const body = await readJson(ctx.request);
  const rows = readCandidateList(body.text);
  if (!rows.length) {
    throw badRequest('Nothing in that looked like a name. One person per line, '
      + 'with their number after a comma if you have it.');
  }

  // Anybody already in the pipeline under that name, so a second paste of the
  // same list does not double everybody up.
  const existing = await ctx.db.prepare(
    'SELECT id, name, stage FROM rec_candidate',
  ).all().catch(() => ({ results: [] }));
  const known = new Map((existing.results ?? [])
    .map((r) => [String(r.name).trim().toLowerCase(), r]));

  return json({
    rows: rows.map((row) => {
      const match = known.get(row.name.toLowerCase());
      return {
        ...row,
        already: match ? { id: match.id, stage: match.stage, label: stageLabel(match.stage) } : null,
      };
    }),
  });
}

export async function applyCandidates(ctx) {
  const body = await readJson(ctx.request);
  const roleId = body.roleId == null || body.roleId === '' ? null : Number(body.roleId);
  if (roleId != null) await roleMustExist(ctx, roleId);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw badRequest('Nothing was ticked, so nothing was added.');

  let added = 0;
  for (const row of rows.slice(0, 200)) {
    const name = str(row.name, 'Their name', { max: 120 });
    if (!name) continue;
    const created = await ctx.db.prepare(
      `INSERT INTO rec_candidate (role_id, name, phone, email, source, created_by)
       VALUES (?1,?2,?3,?4,?5,?6) RETURNING id`,
    ).bind(
      roleId, name,
      str(row.phone, 'Phone', { max: 40 }),
      str(row.email, 'Email', { max: 160 }),
      readSource(body.source),
      actorOf(ctx),
    ).first();
    await trail(ctx.db, {
      candidateId: created.id, kind: 'added', toStage: 'applied',
      detail: 'From a pasted list', actor: actorOf(ctx),
    });
    added += 1;
  }

  await audit(ctx, 'recruitment.candidates_paste', roleId, { added });
  return json({ ok: true, added });
}

/**
 * A stack of CVs, read and shown before anything is written.
 *
 * The way applications actually arrive here is twenty files in a folder or a
 * WhatsApp thread, and typing twenty names off them is an afternoon nobody
 * has. So the files come in together, each one is read for a name, a number
 * and an email, and what was found is shown with a tick against each.
 *
 * NOTHING IS WRITTEN BY THIS. It reads and reports. The second press creates
 * the candidates, with each CV attached to the person it came from — which is
 * the same shape as the pasted list and the rota import, and for the same
 * reason: a name entered wrongly and silently is worse than no name at all.
 *
 * WHAT IT CANNOT READ, IT SAYS SO ABOUT. Half the CVs here are a photograph
 * taken on a phone, and there is no text in a photograph. Those come back
 * marked, with whatever the file name suggests, for somebody to type. That is
 * honest and useful; guessing would be neither.
 */
export async function readCvs(ctx) {
  const body = await readJson(ctx.request);
  const files = Array.isArray(body.files) ? body.files.slice(0, 40) : [];
  if (!files.length) throw badRequest('No files were sent.');

  // Everybody already in the pipeline, so a CV for somebody who applied last
  // month is flagged rather than added twice.
  const existing = await ctx.db.prepare('SELECT id, name, stage FROM rec_candidate')
    .all().catch(() => ({ results: [] }));
  const known = new Map((existing.results ?? [])
    .map((r) => [String(r.name).trim().toLowerCase(), r]));

  const rows = [];
  for (const file of files) {
    const filename = str(file.filename, 'File name', { max: 200 }) || 'CV';
    const mime = str(file.mime, 'Type', { max: 80 }) || 'application/octet-stream';

    let bytes;
    try {
      bytes = fromBase64(file.content);
    } catch {
      rows.push({ filename, problem: 'That file did not arrive in one piece.' });
      continue;
    }
    if (!bytes.length) {
      rows.push({ filename, problem: 'There was nothing in that file.' });
      continue;
    }
    if (bytes.length > MAX_UPLOAD) {
      rows.push({
        filename,
        problem: `${Math.round(bytes.length / 1_000_000)} MB is over the `
          + `${Math.round(MAX_UPLOAD / 1_000_000)} MB limit.`,
      });
      continue;
    }
    if (!ACCEPTED.some((ok) => mime.startsWith(ok))) {
      rows.push({ filename, problem: 'Send a photograph, a PDF or a Word document.' });
      continue;
    }

    // Only a PDF has text this app can read. A photograph is attached and its
    // name is left to somebody; a Word file is attached and read as far as its
    // file name goes, which is further than nothing.
    let pages = null;
    let note = null;
    if (mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      try {
        pages = (await extractPdfText(bytes)).pages;
      } catch (err) {
        note = err.message || 'That PDF could not be read.';
      }
    } else if (mime.startsWith('image/')) {
      note = 'A photograph, so there is no text to read. Type their name.';
    } else {
      note = 'Only a PDF can be read for a name. Check what it found.';
    }

    const read = readCv({ pages, filename });
    if (pages && !read.readable) {
      note = 'That PDF is a picture of a CV rather than text. Type their name.';
    }

    const match = read.name ? known.get(read.name.toLowerCase()) : null;
    rows.push({
      filename,
      mime,
      bytes: bytes.length,
      name: read.name,
      nameFrom: read.nameFrom,
      phone: read.phone,
      email: read.email,
      note,
      already: match
        ? { id: match.id, stage: match.stage, label: stageLabel(match.stage) }
        : null,
    });
  }

  return json({
    rows,
    read: rows.filter((r) => r.name).length,
    unread: rows.filter((r) => !r.name && !r.problem).length,
  });
}

/**
 * Create the candidates, each with their own CV on their record.
 *
 * The file comes back up rather than being held between the two presses: a
 * Worker has nowhere to put twenty files while somebody reads a list, and a
 * second upload of what the browser already has is cheaper than inventing
 * somewhere.
 */
export async function importCvs(ctx) {
  const body = await readJson(ctx.request);
  const roleId = body.roleId == null || body.roleId === '' ? null : Number(body.roleId);
  if (roleId != null) await roleMustExist(ctx, roleId);

  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 40) : [];
  if (!rows.length) throw badRequest('Nothing was ticked, so nothing was added.');

  const added = [];
  const refused = [];

  for (const row of rows) {
    const name = str(row.name, 'Their name', { max: 120 });
    if (!name) {
      refused.push({ filename: row.filename, why: 'No name was given for this one.' });
      continue;
    }

    const created = await ctx.db.prepare(
      `INSERT INTO rec_candidate (role_id, name, phone, email, source, created_by)
       VALUES (?1,?2,?3,?4,?5,?6) RETURNING id`,
    ).bind(
      roleId, name,
      str(row.phone, 'Phone', { max: 40 }),
      str(row.email, 'Email', { max: 160 }),
      readSource(body.source),
      actorOf(ctx),
    ).first();

    await trail(ctx.db, {
      candidateId: created.id, kind: 'added', toStage: 'applied',
      detail: `From ${str(row.filename, 'f', { max: 200 }) || 'a CV'}`,
      actor: actorOf(ctx),
    });

    // The CV itself, on the person it came from. A stack of files imported
    // without the files attached would be the worst of both.
    if (row.content) {
      try {
        const bytes = fromBase64(row.content);
        if (bytes.length && bytes.length <= MAX_UPLOAD) {
          await ctx.db.prepare(
            `INSERT INTO rec_file (candidate_id, kind, title, filename, mime, bytes, content,
                                   uploaded_by)
             VALUES (?1,'cv',?2,?3,?4,?5,?6,?7)`,
          ).bind(
            created.id,
            str(row.filename, 'Title', { max: 160 }) || 'CV',
            str(row.filename, 'File name', { max: 200 }),
            str(row.mime, 'Type', { max: 80 }) || 'application/octet-stream',
            bytes.length, bytes, actorOf(ctx),
          ).run();
          await trail(ctx.db, {
            candidateId: created.id, kind: 'file',
            detail: `CV: ${str(row.filename, 'f', { max: 200 })}`,
            actor: actorOf(ctx),
          });
        }
      } catch {
        // The person is added either way. Losing a name because a file would
        // not decode is the worse trade, and the screen says which are missing
        // their paper.
        refused.push({ filename: row.filename, why: 'The person was added, but the file was not.' });
      }
    }

    added.push({ id: created.id, name });
  }

  await audit(ctx, 'recruitment.cv_import', roleId, { added: added.length });
  return json({ ok: true, added: added.length, people: added, refused });
}

export async function updateCandidate(ctx, id) {
  const candidate = await candidateOr404(ctx, id);
  const body = await readJson(ctx.request);
  const roleId = body.roleId === undefined
    ? candidate.role_id
    : (body.roleId == null || body.roleId === '' ? null : Number(body.roleId));
  if (roleId != null && roleId !== candidate.role_id) await roleMustExist(ctx, roleId);

  await ctx.db.prepare(
    `UPDATE rec_candidate
        SET role_id = ?2, name = ?3, phone = ?4, email = ?5, source = ?6, referred_by = ?7,
            note = ?8, updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(
    candidate.id, roleId,
    str(body.name, 'Their name', { max: 120, fallback: candidate.name }),
    body.phone === undefined ? candidate.phone : str(body.phone, 'Phone', { max: 40 }),
    body.email === undefined ? candidate.email : str(body.email, 'Email', { max: 160 }),
    body.source === undefined ? candidate.source : readSource(body.source),
    body.referredBy === undefined ? candidate.referred_by : str(body.referredBy, 'Referred by', { max: 120 }),
    body.note === undefined ? candidate.note : str(body.note, 'Note', { max: 2000 }),
  ).run();

  await audit(ctx, 'recruitment.candidate_update', candidate.id, null);
  return json({ ok: true });
}

/**
 * One candidate, everything about them.
 *
 * Their trail included, because a hiring decision questioned a year later is
 * answered off that and nothing else.
 */
export async function candidate(ctx, id) {
  const row = await candidateOr404(ctx, id);
  const { today, at } = await nowIn(ctx.db);

  const [role, scores, files, invites, events, slot, slots] = await Promise.all([
    row.role_id
      ? ctx.db.prepare('SELECT * FROM rec_role WHERE id = ?').bind(row.role_id).first()
      : Promise.resolve(null),
    ctx.db.prepare('SELECT * FROM rec_score WHERE candidate_id = ? ORDER BY id DESC')
      .bind(row.id).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      'SELECT id, kind, title, filename, mime, bytes, uploaded_by, uploaded_at FROM rec_file WHERE candidate_id = ? ORDER BY id',
    ).bind(row.id).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      `SELECT id, message, wants_slot, wants_details, wants_cv, expires_at, created_by,
              created_at, opened_at, revoked_at
         FROM rec_invite WHERE candidate_id = ? ORDER BY id DESC`,
    ).bind(row.id).all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT * FROM rec_event WHERE candidate_id = ? ORDER BY id DESC LIMIT 100')
      .bind(row.id).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      'SELECT * FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL ORDER BY day, starts_at',
    ).bind(row.id).first().catch(() => null),
    // What could still be offered them, for booking one over the phone.
    ctx.db.prepare(
      `SELECT * FROM rec_slot
        WHERE cancelled_at IS NULL AND candidate_id IS NULL AND day >= ?1
          AND (role_id IS NULL OR role_id = ?2)
        ORDER BY day, starts_at LIMIT 60`,
    ).bind(today, row.role_id ?? -1).all().catch(() => ({ results: [] })),
  ]);

  return json({
    today,
    now: at,
    canManage: canManage(ctx),
    canHire: allows('att_setup', ctx.session.permissions),
    stages: STAGES,
    sources: SOURCES,
    fileKinds: FILE_KINDS,
    candidate: {
      ...shapeCandidate(row),
      interview: slot ? shapeSlot(slot) : null,
      // Filled in here as well as on the board. The same shape carrying a
      // null rating beside a list of scores would be one payload disagreeing
      // with itself.
      files: (files.results ?? []).length,
      scores: (scores.results ?? []).length,
      bestRating: (scores.results ?? []).reduce(
        (best, s) => (s.rating != null && (best == null || s.rating > best) ? s.rating : best),
        null,
      ),
    },
    role: role ? shapeRole(role) : null,
    scores: (scores.results ?? []).map((s) => ({
      id: s.id,
      rating: s.rating == null ? null : Number(s.rating),
      recommend: s.recommend,
      note: s.note,
      by: s.scored_by,
      at: s.at,
    })),
    files: (files.results ?? []).map((f) => ({
      id: f.id,
      kind: f.kind,
      kindLabel: FILE_KINDS.find(([k]) => k === f.kind)?.[1] ?? f.kind,
      title: f.title,
      filename: f.filename,
      mime: f.mime,
      bytes: Number(f.bytes),
      by: f.uploaded_by,
      at: f.uploaded_at,
    })),
    invites: (invites.results ?? []).map((i) => ({
      id: i.id,
      message: i.message,
      asks: [i.wants_slot ? 'a time' : null, i.wants_details ? 'their details' : null,
        i.wants_cv ? 'a CV' : null].filter(Boolean),
      expiresAt: i.expires_at,
      createdBy: i.created_by,
      createdAt: i.created_at,
      openedAt: i.opened_at,
      revokedAt: i.revoked_at,
    })),
    // What is still free, so a time can be booked for somebody who rang up.
    free: offerable(slots.results ?? [], { now: at }).map(shapeSlot),
    events: (events.results ?? []).map((e) => ({
      id: e.id,
      kind: e.kind,
      from: e.from_stage,
      to: e.to_stage,
      detail: e.detail,
      actor: e.actor,
      at: e.at,
    })),
  });
}

async function candidateOr404(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?')
    .bind(Number(id)).first();
  if (!row) throw notFound('No such candidate.');
  return row;
}

async function roleMustExist(ctx, roleId) {
  const role = await ctx.db.prepare('SELECT id FROM rec_role WHERE id = ?').bind(roleId).first();
  if (!role) throw badRequest('That vacancy no longer exists.');
  return role;
}

/**
 * Move somebody along, or stop.
 *
 * The reason is asked for on an ending and kept on the record, because "why
 * was this person not taken on" is the question a recruitment record exists to
 * answer, and an empty box a year later answers nothing.
 */
export async function moveCandidate(ctx, id) {
  const row = await candidateOr404(ctx, id);
  const body = await readJson(ctx.request);
  const to = String(body.stage ?? '').trim();

  const refused = whyNot(row.stage, to, { hasStaffRecord: row.staff_id != null });
  if (refused) throw badRequest(refused);

  const outcome = str(body.outcome, 'Why', { max: 400 });
  if (CLOSED_STAGES.includes(to) && to !== 'hired' && !outcome) {
    throw badRequest('Say why in a line. It is the whole value of the record afterwards.');
  }

  await moveOne(ctx, row, to, outcome);
  await audit(ctx, 'recruitment.stage', row.id, { from: row.stage, to });

  return json({ ok: true, stage: to });
}

/**
 * Move several at once.
 *
 * Shortlisting is the one step that is genuinely done in a batch: somebody
 * reads twenty CVs in an evening and six of them are worth seeing. Six presses
 * with a dialog on each is how that turns into an afternoon, and how a
 * pipeline stops being kept up to date.
 *
 * ONE REFUSAL DOES NOT SINK THE REST. Somebody in the list may have been taken
 * on since the screen was drawn, or moved by a colleague; that person is
 * skipped with a reason and everybody else goes through. Failing all twenty
 * because of one is the behaviour that teaches people to move them one at a
 * time again.
 *
 * The rules are the single-move rules, applied per person, so a batch cannot
 * do anything a single press could not: nobody reaches the books this way, an
 * ending still needs a reason, and every one of them lands on its own trail.
 */
export async function moveCandidates(ctx) {
  const body = await readJson(ctx.request);
  const to = String(body.stage ?? '').trim();
  if (!isStage(to)) throw badRequest('That is not a stage.');

  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw badRequest('Nobody was ticked.');
  if (ids.length > 200) throw badRequest('That is more people than a pipeline holds.');

  const outcome = str(body.outcome, 'Why', { max: 400 });
  // Asked once for the batch rather than once each, and still insisted on.
  // "Why was this person not taken on" is the question the record exists to
  // answer, and a batch of six with no reason answers it six times over.
  if (CLOSED_STAGES.includes(to) && to !== 'hired' && !outcome) {
    throw badRequest('Say why in a line. It goes on every one of their records.');
  }

  const moved = [];
  const skipped = [];

  for (const id of ids) {
    const row = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?')
      .bind(id).first();
    if (!row) {
      skipped.push({ id, name: null, why: 'They are no longer in the pipeline.' });
      continue;
    }

    const refused = whyNot(row.stage, to, { hasStaffRecord: row.staff_id != null });
    if (refused) {
      skipped.push({ id, name: row.name, why: refused });
      continue;
    }

    await moveOne(ctx, row, to, outcome);
    moved.push({ id, name: row.name, from: row.stage });
  }

  await audit(ctx, 'recruitment.stage_bulk', null, {
    to, moved: moved.length, skipped: skipped.length,
  });

  return json({ ok: true, stage: to, moved, skipped });
}

/** One move, and everything that follows from it. Shared by both doors. */
async function moveOne(ctx, row, to, outcome) {
  await ctx.db.prepare(
    `UPDATE rec_candidate SET stage = ?2, outcome = ?3, updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(row.id, to, CLOSED_STAGES.includes(to) ? outcome : null).run();

  // A time held for somebody who is no longer being considered goes back into
  // the diary. Leaving it held is how a morning of interviews quietly empties.
  if (CLOSED_STAGES.includes(to)) await releaseSlots(ctx.db, row.id, actorOf(ctx));

  await trail(ctx.db, {
    candidateId: row.id, kind: 'stage', fromStage: row.stage, toStage: to,
    detail: outcome || null, actor: actorOf(ctx),
  });
}

async function releaseSlots(db, candidateId, actor) {
  const held = await db.prepare(
    'SELECT id FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL',
  ).bind(candidateId).all().catch(() => ({ results: [] }));

  for (const slot of held.results ?? []) {
    await db.prepare(
      'UPDATE rec_slot SET candidate_id = NULL, taken_at = NULL, taken_by = NULL WHERE id = ?',
    ).bind(slot.id).run();
    await trail(db, {
      candidateId, kind: 'slot_released', detail: 'Freed when they came out of the pipeline', actor,
    });
  }
}

/** What the interviewer thought, written down while it is fresh. */
export async function scoreCandidate(ctx, id) {
  const row = await candidateOr404(ctx, id);
  const body = await readJson(ctx.request);

  const rating = body.rating == null || body.rating === ''
    ? null
    : int(body.rating, 'Rating', { min: 1, max: 5 });
  const recommend = body.recommend == null || body.recommend === ''
    ? null
    : String(body.recommend);
  if (recommend && !['yes', 'maybe', 'no'].includes(recommend)) {
    throw badRequest('Recommend is yes, maybe or no.');
  }
  const note = str(body.note, 'What you thought', { max: 4000 });
  if (rating == null && !recommend && !note) {
    throw badRequest('Put something in: a mark, a recommendation or a line.');
  }

  const slot = await ctx.db.prepare(
    'SELECT id FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL',
  ).bind(row.id).first().catch(() => null);

  const created = await ctx.db.prepare(
    `INSERT INTO rec_score (candidate_id, slot_id, rating, recommend, note, scored_by)
     VALUES (?1,?2,?3,?4,?5,?6) RETURNING id`,
  ).bind(row.id, slot?.id ?? null, rating, recommend, note, actorOf(ctx)).first();

  await trail(ctx.db, {
    candidateId: row.id,
    kind: 'scored',
    detail: [rating ? `${rating} out of 5` : null, recommend].filter(Boolean).join(', ') || null,
    actor: actorOf(ctx),
  });

  return json({ ok: true, id: created.id });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function addFile(ctx, id) {
  const row = await candidateOr404(ctx, id);
  const body = await readJson(ctx.request);

  const bytes = fromBase64(body.content);
  if (!bytes.length) throw badRequest('There was nothing in that file.');
  if (bytes.length > MAX_UPLOAD) {
    throw badRequest(`That file is ${Math.round(bytes.length / 1_000_000)} MB and the limit is `
      + `${Math.round(MAX_UPLOAD / 1_000_000)} MB.`);
  }
  const mime = str(body.mime, 'Type', { max: 80, fallback: 'application/octet-stream' });
  if (!ACCEPTED.some((ok) => mime.startsWith(ok))) {
    throw badRequest('Send a photograph, a PDF or a Word document.');
  }

  // A kind from the list, not free text. What it is decides where it lands on
  // the staff record if this person is taken on, and a typo would file a
  // school certificate somewhere nobody looks.
  const kind = body.kind == null || body.kind === '' ? 'cv' : String(body.kind).trim();
  if (!isFileKind(kind)) throw badRequest('That is not a kind of document.');

  const created = await ctx.db.prepare(
    `INSERT INTO rec_file (candidate_id, kind, title, filename, mime, bytes, content, uploaded_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id`,
  ).bind(
    row.id,
    kind,
    str(body.title, 'Title', { max: 160 })
      || str(body.filename, 'File name', { max: 160 })
      || FILE_KINDS.find(([k]) => k === kind)[1],
    str(body.filename, 'File name', { max: 200 }),
    mime, bytes.length, bytes, actorOf(ctx) ?? body.by ?? null,
  ).first();

  await trail(ctx.db, {
    candidateId: row.id,
    kind: 'file',
    detail: [FILE_KINDS.find(([k]) => k === kind)[1], str(body.filename, 'f', { max: 200 })]
      .filter(Boolean).join(': '),
    actor: actorOf(ctx),
  });
  return json({ ok: true, id: created.id });
}

export async function readFile(ctx, id, fileId) {
  await candidateOr404(ctx, id);
  const file = await ctx.db.prepare(
    'SELECT * FROM rec_file WHERE id = ? AND candidate_id = ?',
  ).bind(Number(fileId), Number(id)).first();
  if (!file) throw notFound('No such file.');

  return new Response(file.content, {
    headers: {
      'Content-Type': file.mime,
      'Content-Disposition': `inline; filename="${String(file.filename || file.title).replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function removeFile(ctx, id, fileId) {
  await candidateOr404(ctx, id);
  await ctx.db.prepare('DELETE FROM rec_file WHERE id = ? AND candidate_id = ?')
    .bind(Number(fileId), Number(id)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The diary
// ---------------------------------------------------------------------------

/**
 * Who is interviewing, resolved to a person where they are one.
 *
 * The name is kept alongside the id and is what prints. A staff record renamed
 * next year, or somebody who leaves, should not change what a diary from March
 * said it was; and an interviewer who is not on the books at all — an owner, a
 * consultant sitting on the panel — is still just a name, exactly as before.
 */
async function readInterviewer(ctx, body, fallbackName = null) {
  const staffId = body.interviewerStaffId == null || body.interviewerStaffId === ''
    ? null
    : Number(body.interviewerStaffId);

  if (staffId != null) {
    const person = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
      .bind(staffId).first();
    if (!person) throw badRequest('That member of staff is no longer on the books.');
    return { staffId: person.id, name: person.name };
  }

  return {
    staffId: null,
    name: str(body.interviewer, 'Who is interviewing', { max: 120 }) || fallbackName,
  };
}

/**
 * Tell whoever is interviewing.
 *
 * The reason the interviewer is a person and not a line of text. A candidate
 * takes a time at eleven at night and nobody here is looking at the screen;
 * without this, the first anybody knows is somebody arriving at reception.
 *
 * IT NEEDS A LOGIN TO REACH. Somebody on the books with no account cannot be
 * told, and that is not an error — plenty of people who sit on a panel have no
 * reason to open this app. It says so where it matters, on the screen that
 * chose them, rather than failing quietly here.
 *
 * Never throws. A notice is a courtesy; failing to send one must not fail the
 * booking that earned it.
 */
async function tellInterviewer(ctx, slot, { kind, title, body, level = 'info' }) {
  if (!slot?.interviewer_staff_id) return false;

  const user = await ctx.db.prepare(
    'SELECT id FROM users WHERE staff_id = ? AND active = 1',
  ).bind(slot.interviewer_staff_id).first().catch(() => null);
  if (!user) return false;

  await createNotice(ctx.db, {
    kind,
    level,
    title,
    body,
    link: slot.candidate_id ? `#/rec-candidate?id=${slot.candidate_id}` : '#/rec?tab=diary',
    day: slot.day,
    actor: 'HIVE',
    userId: user.id,
    push: true,
    email: false,
  }, ctx).catch(() => {});
  return true;
}

/** The same, said the way a person reads a diary entry. */
const sayWhen = (slot) => `${slot.day} at ${slot.starts_at}`
  + `${slot.place ? `, ${slot.place}` : ''}`;

/**
 * Publish a morning of interviews.
 *
 * Somebody thinks "Tuesday, ten till one, half an hour each", not in eleven
 * separate times, so that is what the form asks for and this produces the
 * eleven. Nothing is offered to anybody until a link goes out.
 */
export async function addSlots(ctx) {
  const body = await readJson(ctx.request);
  const roleId = body.roleId == null || body.roleId === '' ? null : Number(body.roleId);
  if (roleId != null) await roleMustExist(ctx, roleId);

  const day = readDayOrNull(body.day, 'The day');
  if (!day) throw badRequest('Say which day.');
  if (toMinutes(body.from) == null || toMinutes(body.to) == null) {
    throw badRequest('Give a start and an end, like 10:00 and 13:00.');
  }

  const minutes = int(body.minutes, 'How long each', {
    min: 5, max: 240, fallback: Number(await setting(ctx.db, 'rec_slot_minutes', 30)) || 30,
  });
  const cut = cutIntoSlots({ day, from: body.from, to: body.to, minutes });
  if (!cut.length) {
    throw badRequest(`Nothing fits between ${body.from} and ${body.to} at ${minutes} minutes each.`);
  }

  const place = str(body.place, 'Where', {
    max: 160, fallback: await setting(ctx.db, 'rec_place', '') || null,
  });
  // What was picked off the map, where anything was. All three are optional
  // and travel together: half a coordinate is not a place.
  const placeId = str(body.placeId, 'Place', { max: 300 }) || null;
  const lat = numberOrNull(body.lat);
  const lng = numberOrNull(body.lng);
  const who = await readInterviewer(ctx, body, ctx.session?.user?.name ?? null);

  // A time already published for that day is not published twice. Somebody
  // adding a second block to the same morning should get the times they are
  // missing, not a duplicate diary.
  const taken = await ctx.db.prepare(
    'SELECT starts_at FROM rec_slot WHERE day = ? AND cancelled_at IS NULL',
  ).bind(day).all().catch(() => ({ results: [] }));
  const already = new Set((taken.results ?? []).map((r) => r.starts_at));

  let added = 0;
  for (const slot of cut) {
    if (already.has(slot.startsAt)) continue;
    await ctx.db.prepare(
      `INSERT INTO rec_slot (role_id, day, starts_at, minutes, place, place_id, place_lat,
                             place_lng, interviewer, interviewer_staff_id, created_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(roleId, slot.day, slot.startsAt, slot.minutes, place, placeId,
      lat, lng, who.name, who.staffId, actorOf(ctx)).run();
    added += 1;
  }

  // Remembered as the default for next time. Somebody who picks the front desk
  // off the map in September should find it already filled in come November.
  if (bool(body.remember, true)) {
    for (const [key, value] of [
      ['rec_place', place ?? ''], ['rec_place_id', placeId ?? ''],
      ['rec_place_lat', lat == null ? '' : String(lat)],
      ['rec_place_lng', lng == null ? '' : String(lng)],
      ['rec_interviewer', who.name ?? ''],
      ['rec_interviewer_staff_id', who.staffId == null ? '' : String(who.staffId)],
    ]) {
      await ctx.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
      ).bind(key, value).run().catch(() => {});
    }
  }

  await audit(ctx, 'recruitment.slots', roleId, { day, added, minutes, mapped: Boolean(placeId) });
  return json({ ok: true, added, skipped: cut.length - added });
}

/**
 * Change one interview time that is already published.
 *
 * A diary is written a week ahead and the week moves: the panel changes, the
 * room changes, an interview slides half an hour. Before this the only answer
 * was to cancel and republish, which loses the time a candidate had already
 * taken and tells them nothing.
 *
 * MOVING A BOOKED ONE IS ALLOWED, and the screen says what it costs. The
 * candidate's own page reads the slot, so the new time is what they see the
 * next time they open their link — but a link they have already closed does
 * not ring, so somebody has to tell them. Better a control that says so than a
 * control that refuses and gets worked around on paper.
 */
export async function updateSlot(ctx, id) {
  const slot = await ctx.db.prepare('SELECT * FROM rec_slot WHERE id = ?').bind(Number(id)).first();
  if (!slot) throw notFound('No such interview time.');
  if (slot.cancelled_at) throw badRequest('That time has been taken out of the diary.');

  const body = await readJson(ctx.request);
  const roleId = body.roleId === undefined
    ? slot.role_id
    : (body.roleId == null || body.roleId === '' ? null : Number(body.roleId));
  if (roleId != null && roleId !== slot.role_id) await roleMustExist(ctx, roleId);

  const day = body.day === undefined ? slot.day : (readDayOrNull(body.day, 'The day') ?? slot.day);
  const startsAt = body.at === undefined || body.at === ''
    ? slot.starts_at
    : fromMinutes(mustBeTime(body.at));
  const minutes = int(body.minutes, 'How long', {
    min: 5, max: 240, fallback: Number(slot.minutes) || 30,
  });

  // Two interviews at the same minute is a diary nobody can keep. Checked
  // against what is live rather than what was ever published, so a time freed
  // by a cancellation can be moved back into.
  if (day !== slot.day || startsAt !== slot.starts_at) {
    const clash = await ctx.db.prepare(
      'SELECT id FROM rec_slot WHERE day = ?1 AND starts_at = ?2 AND cancelled_at IS NULL AND id <> ?3',
    ).bind(day, startsAt, slot.id).first();
    if (clash) throw badRequest(`There is already an interview at ${startsAt} on ${day}.`);
  }

  // Only where the form actually said something about it. Without this, moving
  // a time by half an hour silently takes whoever was on the panel off it,
  // which is the worst kind of bug: nothing looks wrong until nobody turns up.
  const who = body.interviewer === undefined && body.interviewerStaffId === undefined
    ? { staffId: slot.interviewer_staff_id, name: slot.interviewer }
    : await readInterviewer(ctx, body, slot.interviewer);
  const place = body.place === undefined
    ? slot.place
    : str(body.place, 'Where', { max: 160 });
  const placeId = body.place === undefined
    ? slot.place_id
    : (str(body.placeId, 'Place', { max: 300 }) || null);
  const lat = body.place === undefined ? slot.place_lat : numberOrNull(body.lat);
  const lng = body.place === undefined ? slot.place_lng : numberOrNull(body.lng);

  await ctx.db.prepare(
    `UPDATE rec_slot
        SET role_id = ?2, day = ?3, starts_at = ?4, minutes = ?5, place = ?6, place_id = ?7,
            place_lat = ?8, place_lng = ?9, interviewer = ?10, interviewer_staff_id = ?11
      WHERE id = ?1`,
  ).bind(slot.id, roleId, day, startsAt, minutes, place, placeId, lat, lng,
    who.name, who.staffId).run();

  const after = await ctx.db.prepare('SELECT * FROM rec_slot WHERE id = ?').bind(slot.id).first();
  const moved = day !== slot.day || startsAt !== slot.starts_at;

  // Whoever is on it now is told, and whoever has just come off it is told
  // too. Being quietly taken off a panel is how somebody turns up to an
  // interview that is not theirs, or fails to turn up to one that is.
  if (slot.candidate_id) {
    const person = await ctx.db.prepare('SELECT name FROM rec_candidate WHERE id = ?')
      .bind(slot.candidate_id).first().catch(() => null);
    const name = person?.name ?? 'A candidate';

    if (who.staffId !== slot.interviewer_staff_id && slot.interviewer_staff_id) {
      await tellInterviewer(ctx, slot, {
        kind: 'recruitment.off_panel',
        title: `You are no longer interviewing ${name}`,
        body: `${sayWhen(slot)} has been given to ${who.name || 'somebody else'}.`,
      });
    }
    await tellInterviewer(ctx, after, {
      kind: moved ? 'recruitment.moved' : 'recruitment.changed',
      level: moved ? 'warn' : 'info',
      title: moved
        ? `${name}\u2019s interview has moved`
        : `${name}\u2019s interview has changed`,
      body: moved
        ? `Now ${sayWhen(after)}. It was ${sayWhen(slot)}.`
        : sayWhen(after),
    });
  } else if (who.staffId !== slot.interviewer_staff_id) {
    await tellInterviewer(ctx, after, {
      kind: 'recruitment.on_panel',
      title: 'You are down to interview',
      body: `${sayWhen(after)}. Nobody has taken it yet.`,
    });
  }

  if (slot.candidate_id) {
    await trail(ctx.db, {
      candidateId: slot.candidate_id,
      kind: moved ? 'slot_moved' : 'slot_edited',
      detail: moved
        ? `Moved from ${slot.day} at ${slot.starts_at} to ${day} at ${startsAt}`
        : `${who.name ? `${who.name} interviewing` : 'Changed'}${place ? `, ${place}` : ''}`,
      actor: actorOf(ctx),
    });
  }

  await audit(ctx, 'recruitment.slot_update', slot.id, { day, startsAt, moved });
  return json({ ok: true, moved, booked: slot.candidate_id != null });
}

/**
 * Change a whole day of the diary at once.
 *
 * The realistic edit is not one time, it is "Tuesday is Yaa now, not me" or
 * "we are doing them in the small office". Doing that one slot at a time
 * across a morning of eleven is how somebody gives up and republishes.
 *
 * The times themselves are not touched — moving eleven interviews together is
 * a different thing from correcting who is on the panel, and it would move
 * bookings people have already been given.
 */
export async function updateDay(ctx) {
  const body = await readJson(ctx.request);
  const day = readDayOrNull(body.day, 'The day');
  if (!day) throw badRequest('Say which day.');

  const slots = await ctx.db.prepare(
    'SELECT * FROM rec_slot WHERE day = ? AND cancelled_at IS NULL ORDER BY starts_at',
  ).bind(day).all().catch(() => ({ results: [] }));
  const live = slots.results ?? [];
  if (!live.length) throw badRequest('There is nothing published on that day.');

  // Whether the ones somebody has already taken are included. Left out by
  // default: changing a booked interview is a decision, and a bulk edit meant
  // to tidy up the free times should not quietly move somebody's appointment.
  const includeBooked = bool(body.includeBooked, false);
  const touching = live.filter((slot) => includeBooked || slot.candidate_id == null);
  if (!touching.length) {
    throw badRequest('Every time that day is booked. Tick the box to change those as well.');
  }

  const roleId = body.roleId === undefined || body.roleId === ''
    ? undefined
    : (body.roleId == null ? null : Number(body.roleId));
  if (roleId != null && roleId !== undefined) await roleMustExist(ctx, roleId);

  const who = body.interviewer === undefined && body.interviewerStaffId === undefined
    ? null
    : await readInterviewer(ctx, body);
  const place = body.place === undefined ? null : {
    place: str(body.place, 'Where', { max: 160 }),
    placeId: str(body.placeId, 'Place', { max: 300 }) || null,
    lat: numberOrNull(body.lat),
    lng: numberOrNull(body.lng),
  };

  if (roleId === undefined && !who && !place) {
    throw badRequest('Nothing was changed.');
  }

  for (const slot of touching) {
    await ctx.db.prepare(
      `UPDATE rec_slot
          SET role_id = COALESCE(?2, role_id),
              interviewer = CASE WHEN ?3 = 1 THEN ?4 ELSE interviewer END,
              interviewer_staff_id = CASE WHEN ?3 = 1 THEN ?5 ELSE interviewer_staff_id END,
              place = CASE WHEN ?6 = 1 THEN ?7 ELSE place END,
              place_id = CASE WHEN ?6 = 1 THEN ?8 ELSE place_id END,
              place_lat = CASE WHEN ?6 = 1 THEN ?9 ELSE place_lat END,
              place_lng = CASE WHEN ?6 = 1 THEN ?10 ELSE place_lng END
        WHERE id = ?1`,
    ).bind(
      slot.id,
      roleId === undefined ? null : roleId,
      who ? 1 : 0, who?.name ?? null, who?.staffId ?? null,
      place ? 1 : 0, place?.place ?? null, place?.placeId ?? null,
      place?.lat ?? null, place?.lng ?? null,
    ).run();
  }

  // One notice for the day rather than eleven. A phone that buzzes eleven
  // times for one edit is a phone whose owner turns notifications off.
  if (who?.staffId) {
    const booked = touching.filter((slot) => slot.candidate_id != null).length;
    await tellInterviewer(ctx, { ...touching[0], interviewer_staff_id: who.staffId, candidate_id: null }, {
      kind: 'recruitment.on_panel',
      title: `You are interviewing on ${day}`,
      body: `${touching.length} time${touching.length === 1 ? '' : 's'}`
        + `${booked ? `, ${booked} already taken` : ', none taken yet'}.`,
    });
  }

  await audit(ctx, 'recruitment.day_update', null, { day, changed: touching.length, includeBooked });
  return json({ ok: true, changed: touching.length, left: live.length - touching.length });
}

/** A time, or a plain refusal. Used where a blank means "leave it alone". */
function mustBeTime(value) {
  const at = toMinutes(value);
  if (at == null) throw badRequest('Give a time like 10:30.');
  return at;
}

/**
 * Take a time out of the diary.
 *
 * Cancelled rather than deleted, because a time somebody had already chosen is
 * a time they are turning up to, and the record of that should survive it
 * being withdrawn. Whoever holds it is told.
 */
export async function removeSlot(ctx, id) {
  const slot = await ctx.db.prepare('SELECT * FROM rec_slot WHERE id = ?').bind(Number(id)).first();
  if (!slot) throw notFound('No such interview time.');

  await ctx.db.prepare("UPDATE rec_slot SET cancelled_at = datetime('now') WHERE id = ?")
    .bind(slot.id).run();

  if (slot.candidate_id) {
    const person = await ctx.db.prepare('SELECT name FROM rec_candidate WHERE id = ?')
      .bind(slot.candidate_id).first().catch(() => null);

    await trail(ctx.db, {
      candidateId: slot.candidate_id,
      kind: 'slot_cancelled',
      detail: `${slot.day} at ${slot.starts_at}, cancelled by the property`,
      actor: actorOf(ctx),
    });
    await tellInterviewer(ctx, slot, {
      kind: 'recruitment.cancelled',
      level: 'warn',
      title: `${person?.name ?? 'An'} interview is off`,
      body: `${sayWhen(slot)} has been taken out of the diary. `
        + 'They have not been told, so somebody has to ring them.',
    });
  }
  await audit(ctx, 'recruitment.slot_remove', slot.id, { day: slot.day, at: slot.starts_at });
  return json({ ok: true, had: slot.candidate_id != null });
}

/**
 * Book a time on somebody's behalf.
 *
 * The candidate picking their own is the point of the whole exercise, and it
 * is not always possible: somebody rings the office, or has no smartphone. The
 * claim is the same conditional update either way, so a booking made over the
 * phone and one made on a candidate's own screen cannot both take the same
 * half hour.
 */
export async function bookSlot(ctx, id) {
  const slot = await ctx.db.prepare('SELECT * FROM rec_slot WHERE id = ?').bind(Number(id)).first();
  if (!slot) throw notFound('No such interview time.');

  const body = await readJson(ctx.request);
  const row = await candidateOr404(ctx, body.candidateId);

  const result = await claimSlot(ctx.db, {
    slotId: slot.id, candidateId: row.id, by: actorOf(ctx) ?? 'the office',
  });
  if (!result.ok) throw badRequest(result.why);

  await trail(ctx.db, {
    candidateId: row.id, kind: 'slot_taken',
    detail: `${slot.day} at ${slot.starts_at}, booked by the office`,
    actor: actorOf(ctx),
  });

  const told = await tellInterviewer(ctx, { ...slot, candidate_id: row.id }, {
    kind: 'recruitment.booked',
    title: `You are interviewing ${row.name}`,
    body: `${sayWhen(slot)}. Booked by the office.`,
  });

  // Whether the panel actually heard, so the screen can say "tell them
  // yourself" rather than letting somebody assume it was handled.
  return json({ ok: true, interviewerTold: told });
}

/**
 * Take one interview time, and only if it is still free.
 *
 * The whole of the race lives in the WHERE clause. Two candidates opening
 * their links at the same moment both send this; one update changes a row and
 * the other changes nothing, and the second is told plainly rather than shown
 * a booking that is not real.
 *
 * Shared with the candidate's own side of the link, so there is one definition
 * of what taking a slot means.
 */
export async function claimSlot(db, { slotId, candidateId, by }) {
  // One live interview each. Somebody changing their mind releases the first,
  // which is the behaviour they expect; two held slots for one person is a
  // morning quietly lost.
  const held = await db.prepare(
    'SELECT id FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL AND id <> ?',
  ).bind(candidateId, slotId).all().catch(() => ({ results: [] }));

  const claimed = await db.prepare(
    `UPDATE rec_slot
        SET candidate_id = ?2, taken_at = datetime('now'), taken_by = ?3
      WHERE id = ?1 AND candidate_id IS NULL AND cancelled_at IS NULL`,
  ).bind(slotId, candidateId, by).run().catch(() => null);

  if (!Number(claimed?.meta?.changes ?? 0)) {
    return { ok: false, why: 'That time has just been taken. Pick another one.' };
  }

  for (const old of held.results ?? []) {
    await db.prepare(
      'UPDATE rec_slot SET candidate_id = NULL, taken_at = NULL, taken_by = NULL WHERE id = ?',
    ).bind(old.id).run();
  }

  // Somebody with a time in the diary is at the interview stage, whatever the
  // board said a moment ago. Only forward: a candidate who has already been
  // offered the job and is coming back for a second interview stays offered.
  const row = await db.prepare('SELECT stage FROM rec_candidate WHERE id = ?')
    .bind(candidateId).first();
  if (row && ['applied', 'shortlisted'].includes(row.stage)) {
    await db.prepare(
      "UPDATE rec_candidate SET stage = 'interview', updated_at = datetime('now') WHERE id = ?",
    ).bind(candidateId).run();
    await trail(db, {
      candidateId, kind: 'stage', fromStage: row.stage, toStage: 'interview',
      detail: 'Took an interview time', actor: by,
    });
  }

  return { ok: true, released: (held.results ?? []).length };
}

/**
 * Tell the panel that a candidate has taken a time.
 *
 * Separate from `claimSlot` because that is shared with the candidate's own
 * side of the link, which has a database and no session. Both doors call this
 * straight after, so a time taken on a phone at eleven at night and a time
 * booked over the counter reach the same person the same way.
 */
export async function tellPanelAboutBooking(ctx, slotId, { changed = false } = {}) {
  const slot = await ctx.db.prepare(
    `SELECT s.*, c.name AS candidate_name
       FROM rec_slot s LEFT JOIN rec_candidate c ON c.id = s.candidate_id
      WHERE s.id = ?`,
  ).bind(slotId).first().catch(() => null);
  if (!slot) return false;

  return tellInterviewer(ctx, slot, {
    kind: 'recruitment.booked',
    title: changed
      ? `${slot.candidate_name ?? 'A candidate'} has moved their interview`
      : `You are interviewing ${slot.candidate_name ?? 'a candidate'}`,
    body: `${sayWhen(slot)}. They chose it themselves.`,
  });
}

/** And when they give one back, so the chair is not sat waiting. */
export async function tellPanelAboutRelease(ctx, slot, candidateName) {
  return tellInterviewer(ctx, { ...slot, candidate_id: null }, {
    kind: 'recruitment.released',
    level: 'warn',
    title: `${candidateName} has given back their interview time`,
    body: `${sayWhen(slot)} is free again. They have not picked another one yet.`,
  });
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const hashRecToken = (token, pepper) => hashPin(`rec-invite:${token}`, pepper);
export const hashRecPin = (pin, pepper) => hashPin(`rec-invite-pin:${pin}`, pepper);

/**
 * Make a link for one candidate.
 *
 * Shown once, on the screen that made it. The database keeps a hash, so a copy
 * of it opens nothing, and making another is the way to recover from a lost
 * one. The same shape as an employee's link because it is the same problem:
 * somebody with no account, holding a phone.
 */
export async function inviteCandidate(ctx, id) {
  const row = await candidateOr404(ctx, id);
  const body = await readJson(ctx.request);
  const asks = readAsks(body);

  if (asks.wantsSlot && !(await hasFreeTimes(ctx, row))) {
    throw badRequest('There are no interview times free for this vacancy. '
      + 'Publish some under Interviews first, or send a link that only asks for their details.');
  }

  const days = int(body.days, 'Days', {
    min: 1, max: 60, fallback: Number(await setting(ctx.db, 'rec_link_days', 10)) || 10,
  });
  const pin = body.pin == null || body.pin === '' ? null : String(body.pin).replace(/\D/g, '');
  if (pin && pin.length !== 4) throw badRequest('A code has to be four digits, or leave it blank.');

  const made = await makeInvite(ctx, row, {
    ...asks, days, pin, message: str(body.message, 'Message', { max: 600 }),
  });

  await audit(ctx, 'recruitment.invite', row.id, { days, wantsSlot: asks.wantsSlot, pin: Boolean(pin) });
  return json({ ok: true, ...made });
}

/**
 * A link each, for everybody ticked.
 *
 * The point of shortlisting six people in one press is inviting six people in
 * one press. Doing it one at a time, with a dialog that shows a link once and
 * then never again, is six chances to lose one.
 *
 * SO THEY COME BACK AS A FILE. Every link is shown once and stored only as a
 * hash, which is right for a link and wrong for a batch of twenty: a browser
 * closed at the wrong moment loses the lot. The screen offers them as a
 * spreadsheet the moment they exist, with the name, the number, the link and
 * the message beside each other, which is also the shape somebody wants for
 * pasting them into WhatsApp one at a time.
 *
 * NO CODE ON A BATCH. A four-digit code has to be told to each person out loud
 * on a call, which is exactly the phone call this exists to remove; and one
 * code shared by twenty is a code that is not really a code. Where one is
 * wanted, make that link on its own.
 *
 * ONE REFUSAL DOES NOT SINK THE REST, the same as moving them: somebody taken
 * on since the screen was drawn is skipped with a reason and everybody else
 * gets their link.
 */
export async function inviteCandidates(ctx) {
  const body = await readJson(ctx.request);
  const asks = readAsks(body);

  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw badRequest('Nobody was ticked.');
  if (ids.length > 100) throw badRequest('That is more links than anybody sends at once.');

  const days = int(body.days, 'Days', {
    min: 1, max: 60, fallback: Number(await setting(ctx.db, 'rec_link_days', 10)) || 10,
  });
  const message = str(body.message, 'Message', { max: 600 });

  const links = [];
  const skipped = [];

  for (const id of ids) {
    const row = await ctx.db.prepare('SELECT * FROM rec_candidate WHERE id = ?').bind(id).first();
    if (!row) {
      skipped.push({ id, name: null, why: 'They are no longer in the pipeline.' });
      continue;
    }
    if (CLOSED_STAGES.includes(row.stage)) {
      skipped.push({ id, name: row.name, why: `They are ${stageLabel(row.stage).toLowerCase()}.` });
      continue;
    }
    if (asks.wantsSlot && !(await hasFreeTimes(ctx, row))) {
      skipped.push({
        id,
        name: row.name,
        why: row.role_id
          ? 'No interview times are free for their vacancy.'
          : 'No interview times are free.',
      });
      continue;
    }

    const made = await makeInvite(ctx, row, { ...asks, days, pin: null, message });
    links.push({
      id: row.id, name: row.name, phone: row.phone, email: row.email, ...made,
    });
  }

  await audit(ctx, 'recruitment.invite_bulk', null, {
    made: links.length, skipped: skipped.length, days,
  });

  return json({ ok: true, links, skipped, expiresInDays: days });
}

/** What a link is asking for, checked once for both doors. */
function readAsks(body) {
  const wantsSlot = bool(body.wantsSlot, true);
  const wantsDetails = bool(body.wantsDetails, true);
  const wantsCv = bool(body.wantsCv, false);
  if (!wantsSlot && !wantsDetails && !wantsCv) {
    throw badRequest('A link has to ask for something: a time, their details, or a CV.');
  }
  return { wantsSlot, wantsDetails, wantsCv };
}

/**
 * Whether there is anything to offer this person.
 *
 * A link that offers times and has none is a link that opens on an apology, so
 * it is refused where it would be one. Checked per candidate rather than once
 * for the batch: times are published against a vacancy, and six people on
 * three vacancies are three different answers.
 */
async function hasFreeTimes(ctx, candidate) {
  const { today, at } = await nowIn(ctx.db);
  const free = await ctx.db.prepare(
    `SELECT * FROM rec_slot
      WHERE cancelled_at IS NULL AND candidate_id IS NULL AND day >= ?1
        AND (role_id IS NULL OR role_id = ?2)`,
  ).bind(today, candidate.role_id ?? -1).all().catch(() => ({ results: [] }));

  return offerable(free.results ?? [], { now: at }).length > 0;
}

/** One link: the row, the trail, and the words to paste. Shown once. */
async function makeInvite(ctx, row, { wantsSlot, wantsDetails, wantsCv, days, pin, message }) {
  const pepper = await getPepper(ctx.db);
  const token = newToken();

  const created = await ctx.db.prepare(
    `INSERT INTO rec_invite (candidate_id, token_hash, pin_hash, message, wants_slot,
                             wants_details, wants_cv, expires_at, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,datetime('now', ?8),?9) RETURNING id`,
  ).bind(
    row.id,
    await hashRecToken(token, pepper),
    pin ? await hashRecPin(pin, pepper) : null,
    message ?? null,
    wantsSlot ? 1 : 0, wantsDetails ? 1 : 0, wantsCv ? 1 : 0,
    `+${days} days`, actorOf(ctx),
  ).first();

  await trail(ctx.db, {
    candidateId: row.id, inviteId: created.id, kind: 'link_created',
    detail: [wantsSlot ? 'a time' : null, wantsDetails ? 'their details' : null,
      wantsCv ? 'a CV' : null].filter(Boolean).join(', '),
    actor: actorOf(ctx),
  });

  const url = `${await siteOrigin(ctx.db, ctx.url.origin)}/c/${token}`;
  const property = await setting(ctx.db, 'property_name', 'Somewhere Nice');

  return {
    id: created.id,
    url,
    pin,
    expiresInDays: days,
    message: inviteMessage(row.name, property, url, { wantsSlot, wantsDetails, wantsCv }),
  };
}

function inviteMessage(name, property, url, { wantsSlot, wantsDetails, wantsCv }) {
  const asks = [];
  if (wantsSlot) asks.push('choose an interview time that suits you');
  if (wantsDetails) asks.push('confirm your details');
  if (wantsCv) asks.push('send your CV');

  const list = asks.length > 1
    ? `${asks.slice(0, -1).join(', ')} and ${asks[asks.length - 1]}`
    : asks[0];

  return `Hello ${String(name).split(' ')[0]}, thank you for applying to ${property}. `
    + `Please open this link on your phone to ${list}. It is private to you.\n\n${url}`;
}

export async function revokeInvite(ctx, id) {
  const invite = await ctx.db.prepare('SELECT * FROM rec_invite WHERE id = ?')
    .bind(Number(id)).first();
  if (!invite) throw notFound('No such link.');

  await ctx.db.prepare(
    "UPDATE rec_invite SET revoked_at = datetime('now'), revoked_by = ?2 WHERE id = ?1",
  ).bind(invite.id, actorOf(ctx)).run();

  await trail(ctx.db, {
    candidateId: invite.candidate_id, inviteId: invite.id, kind: 'link_cancelled',
    actor: actorOf(ctx),
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Taking somebody on
// ---------------------------------------------------------------------------

/**
 * The one door between a candidate and the books.
 *
 * Everything else in this file moves rows around inside recruitment. This
 * makes a person: a staff record, a profile carrying across whatever the
 * pipeline already knows, and their CV moved onto the record so it is filed
 * where the rest of their paper will be.
 *
 * IT NEEDS THE SETUP PERMISSION AS WELL. Running the pipeline is a job a
 * manager holds; putting somebody on the property's books is what
 * `att_setup` exists to guard, and a side door into it would make that
 * permission mean less everywhere else. The screen says so rather than hiding
 * the button, because "ask the administrator" is a useful sentence and a
 * missing button is not.
 *
 * THE EMPLOYEE NUMBER IS TYPED IN. It is the join between a punch and a
 * person, and it has to match what somebody sets up on the terminal. There is
 * no version of guessing it that is safe.
 *
 * What it deliberately does NOT do is issue the contract. That is the next
 * press, on their new record, using the templates and the signing that are
 * already there — so a contract from a hire and a contract from anywhere else
 * are the same document with the same trail.
 */
export async function hire(ctx, id) {
  if (!allows('att_setup', ctx.session.permissions)) {
    throw forbidden('Taking somebody on puts them on the property’s books, which needs '
      + 'the attendance setup permission. Ask an administrator to press this one.');
  }

  const row = await candidateOr404(ctx, id);
  if (row.staff_id) throw badRequest(`${row.name} is already on the books.`);

  const body = await readJson(ctx.request);
  const employeeNo = str(body.employeeNo, 'Employee number', { required: true, max: 40 });
  const name = str(body.name, 'Name', { max: 120, fallback: row.name });
  const hiredOn = readDayOrNull(body.hiredOn, 'Start date')
    || (await nowIn(ctx.db)).today;

  const role = row.role_id
    ? await ctx.db.prepare('SELECT * FROM rec_role WHERE id = ?').bind(row.role_id).first()
    : null;

  let staff;
  try {
    staff = await ctx.db.prepare(
      `INSERT INTO att_staff (employee_no, name, department, job_title, hired_on, on_rota, on_clock)
       VALUES (?1,?2,?3,?4,?5,?6,?7) RETURNING id`,
    ).bind(
      employeeNo, name,
      str(body.department, 'Department', { max: 80, fallback: role?.department ?? null }),
      str(body.jobTitle, 'Job title', { max: 80, fallback: role?.title ?? null }),
      hiredOn,
      bool(body.onRota, true) ? 1 : 0,
      bool(body.onClock, true) ? 1 : 0,
    ).first();
  } catch (err) {
    // The one mistake that matters here, said in the words somebody needs.
    const message = String(err?.message ?? '');
    if (/UNIQUE|constraint/i.test(message)) {
      throw badRequest(`Employee number ${employeeNo} already belongs to somebody else. `
        + 'Every number on the terminal is one person, so this one has to be new.');
    }
    throw err;
  }

  // What the pipeline already knows, carried across rather than asked for
  // again. Nothing more: a candidate record is a phone number and a name, and
  // pretending it is an employee file would put half-facts on the record.
  if (row.phone || row.email) {
    await ctx.db.prepare(
      `INSERT INTO hr_profile (staff_id, personal_phone, personal_email)
       VALUES (?1,?2,?3)
       ON CONFLICT (staff_id) DO UPDATE SET
         personal_phone = COALESCE(hr_profile.personal_phone, ?2),
         personal_email = COALESCE(hr_profile.personal_email, ?3)`,
    ).bind(staff.id, row.phone, row.email).run().catch(() => {});
  }

  // Their CV and anything else they sent, moved onto the record. A file that
  // stays behind in recruitment is a file nobody will ever look at again.
  const files = await ctx.db.prepare('SELECT * FROM rec_file WHERE candidate_id = ?')
    .bind(row.id).all().catch(() => ({ results: [] }));
  let moved = 0;
  for (const file of files.results ?? []) {
    await ctx.db.prepare(
      `INSERT INTO hr_document (staff_id, kind, title, filename, mime, bytes, content,
                                uploaded_by, source, status)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'office','filed')`,
    ).bind(
      staff.id, staffDocumentKind(file.kind), file.title, file.filename,
      file.mime, file.bytes, file.content,
      `${file.uploaded_by || 'Recruitment'} (from their application)`,
    ).run().catch(() => {});
    moved += 1;
  }

  await ctx.db.prepare(
    `UPDATE rec_candidate
        SET stage = 'hired', staff_id = ?2, hired_on = ?3, updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(row.id, staff.id, hiredOn).run();

  // Punches already sitting under that number are theirs. The same rule the
  // setup screen uses: somebody enrolled on the terminal last week and started
  // this week should not lose the days in between.
  const claimed = bool(body.onClock, true)
    ? await claimOrphans(ctx.db, staff.id, employeeNo)
    : { claimed: 0 };
  if (claimed.claimed) {
    await recompute(ctx.db, { staffIds: [staff.id], from: claimed.from, to: claimed.to });
  }

  // Their time in the diary is finished with, and somebody else may want it.
  await releaseSlots(ctx.db, row.id, actorOf(ctx));

  // And whoever keeps the records is told, because the next three things that
  // have to happen — the contract, the details form, the terminal — are all
  // theirs.
  await createNotice(ctx.db, {
    kind: 'recruitment.hired',
    level: 'info',
    title: `${name} has been taken on`,
    body: `${employeeNo} · starts ${hiredOn}. Their record is open: send them a link for their `
      + 'details and their contract, and enrol the number on the terminal.',
    link: `#/person?id=${staff.id}`,
    actor: actorOf(ctx),
    audience: 'hr_manage',
    push: false,
    email: false,
  }, ctx).catch(() => {});

  await trail(ctx.db, {
    candidateId: row.id, kind: 'hired', fromStage: row.stage, toStage: 'hired',
    detail: `${employeeNo} · starts ${hiredOn}`, actor: actorOf(ctx),
  });
  await audit(ctx, 'recruitment.hire', row.id, { staffId: staff.id, employeeNo, hiredOn });

  // If that was the last one wanted, the vacancy says so rather than sitting
  // open with nobody looking at it.
  if (role) await maybeFill(ctx.db, role);

  return json({
    ok: true,
    staffId: staff.id,
    employeeNo,
    hiredOn,
    filesMoved: moved,
    claimedPunches: claimed.claimed,
  });
}

async function maybeFill(db, role) {
  const hired = await db.prepare(
    "SELECT COUNT(*) n FROM rec_candidate WHERE role_id = ? AND stage = 'hired'",
  ).bind(role.id).first().catch(() => ({ n: 0 }));

  if (Number(hired?.n ?? 0) < (Number(role.headcount) || 1)) return;
  if (['filled', 'closed'].includes(role.status)) return;

  await db.prepare(
    "UPDATE rec_role SET status = 'filled', closed_on = date('now'), updated_at = datetime('now') WHERE id = ?",
  ).bind(role.id).run();
}

export { LIVE_STAGES, isStage };
