import { badRequest, int, json, notFound, readJson, str } from '../lib/http.js';
import { loadDataset, toMinutes } from '../lib/attendance.js';
import { countsOf, nearestShifts, parseRotaCsv, planImport } from '../lib/roster-import.js';
import { replaceDay, rowsFor } from '../lib/roster.js';
import { extractPdfText } from '../lib/pdf-text.js';
import { parseRotaPdf } from '../lib/roster-pdf.js';

/**
 * Importing a week's rota from the scheduling export.
 *
 * Two steps on purpose. The first reads the file and says what it would do; the
 * second does it. Nothing between them touches the rota, so a file with a
 * column in the wrong place or a name matched to the wrong person is a wasted
 * minute rather than a fortnight of reports that quietly disagree with reality.
 */

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action,
    entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

async function aliasMap(db) {
  const rows = await db.prepare('SELECT alias, staff_id FROM att_name_alias')
    .all().catch(() => ({ results: [] }));
  return new Map((rows.results ?? []).map((r) => [String(r.alias).toLowerCase(), r.staff_id]));
}

/**
 * Read a file and hold what it would do.
 *
 * Any draft already waiting is discarded first. Two live drafts is a state
 * nobody can reason about — "confirm" would need to ask which one — and the
 * newer upload is always the one somebody meant.
 */
export async function previewRotaImport(ctx) {
  const body = await readJson(ctx.request);
  const parsed = await readFile(body);
  if (parsed.problem) throw badRequest(parsed.problem);
  if (!parsed.rows.length) throw badRequest('That file has a heading and no rows.');

  const days = parsed.rows.map((r) => r.day).filter(Boolean).sort();
  const [ds, aliases] = await Promise.all([
    loadDataset(ctx.db, { from: days[0] ?? null, to: days[days.length - 1] ?? null }),
    aliasMap(ctx.db),
  ]);

  const plan = planImport(parsed.rows, {
    staff: ds.staff.filter((s) => s.active),
    shifts: ds.shifts.filter((s) => s.active),
    aliases,
    rosterBy: ds.rosterBy,
  });

  await ctx.db.prepare(
    "UPDATE att_roster_import SET status = 'discarded', decided_by = ?1, decided_at = datetime('now') "
    + "WHERE status = 'draft'",
  ).bind(`${ctx.session.user.name} (${ctx.session.user.role})`).run().catch(() => {});

  const created = await ctx.db.prepare(
    `INSERT INTO att_roster_import (filename, from_day, to_day, status, created_by)
     VALUES (?1, ?2, ?3, 'draft', ?4) RETURNING id`,
  ).bind(
    str(body.filename, 'File name', { max: 200 }),
    plan.from, plan.to,
    `${ctx.session.user.name} (${ctx.session.user.role})`,
  ).first();

  const statements = plan.rows.map((r) => ctx.db.prepare(
    `INSERT INTO att_roster_import_row
       (import_id, line, raw_name, raw_position, raw_title, raw_note,
        day, starts_at, ends_at, staff_id, shift_id, shift_name, action, problem)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  ).bind(
    created.id, r.line,
    r.name || null, r.position || null, r.title || null, r.note || null,
    r.day || null, r.startsAt || null, r.endsAt || null,
    r.staffId ?? null, r.shiftId ?? null, r.shiftName ?? null,
    r.action, r.problem ?? null,
  ));

  for (let i = 0; i < statements.length; i += 100) {
    await ctx.db.batch(statements.slice(i, i + 100));
  }

  await audit(ctx, 'attendance.rota_import_draft', created.id, plan.counts);
  return json({ ok: true, id: created.id, ...describe(created.id, plan) });
}

/**
 * Whatever was uploaded, as lines of rota.
 *
 * Two shapes, one answer. The CSV the scheduling system exports is the better
 * file by a distance — it says what it means and nothing has to be inferred —
 * but the thing most people have to hand is the PDF they printed to show
 * somebody, and refusing it teaches them to keep a spreadsheet on the side.
 *
 * Both come out as the same rows, and everything after this point is shared.
 */
async function readFile(body) {
  if (typeof body.pdf === 'string' && body.pdf.trim()) {
    const bytes = fromBase64(body.pdf);
    if (!bytes.length) throw badRequest('There was nothing in that file.');
    if (bytes.length > 8_000_000) throw badRequest('That PDF is too big — a week at a time, please.');

    let text;
    try {
      text = await extractPdfText(bytes);
    } catch (err) {
      // The extractor's own message says which of the several ways this can go
      // wrong actually happened, and each has a different fix.
      throw badRequest(err.message || 'That PDF could not be read.');
    }
    return parseRotaPdf(text);
  }

  const text = String(body.csv ?? '');
  if (!text.trim()) throw badRequest('There was nothing in that file.');
  if (text.length > 2_000_000) throw badRequest('That file is too big — a week at a time, please.');
  return parseRotaCsv(text);
}

function fromBase64(value) {
  const clean = String(value).replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  let binary;
  try {
    binary = atob(clean);
  } catch {
    throw badRequest('That file did not arrive in one piece. Try uploading it again.');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function describe(id, plan) {
  return {
    id,
    from: plan.from,
    to: plan.to,
    counts: plan.counts,
    rows: plan.rows,
  };
}

/** The draft that is waiting, if there is one. */
export async function getRotaImport(ctx) {
  const draft = await ctx.db.prepare(
    "SELECT * FROM att_roster_import WHERE status = 'draft' ORDER BY id DESC LIMIT 1",
  ).first().catch(() => null);

  if (!draft) return json({ draft: null });

  const rows = await ctx.db.prepare(
    'SELECT * FROM att_roster_import_row WHERE import_id = ? ORDER BY line',
  ).bind(draft.id).all();

  const list = (rows.results ?? []).map((r) => ({
    line: r.line,
    name: r.raw_name,
    position: r.raw_position,
    title: r.raw_title,
    note: r.raw_note,
    day: r.day,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    staffId: r.staff_id,
    shiftId: r.shift_id,
    shiftName: r.shift_name,
    action: r.action,
    problem: r.problem,
  }));

  const ds = await loadDataset(ctx.db, { from: draft.from_day, to: draft.to_day });
  const shifts = ds.shifts.filter((s) => s.active);

  // Every distinct set of hours the property has no shift for, asked once
  // rather than once per line — twenty lines needing the same answer is one
  // question, and twenty copies of it is a screen nobody finishes.
  const questions = new Map();
  for (const r of list) {
    if (r.action !== 'needs-shift') continue;
    const key = `${r.startsAt}-${r.endsAt}`;
    if (!questions.has(key)) {
      questions.set(key, {
        key,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        position: r.position,
        suggestedName: r.shiftName,
        lines: 0,
        days: new Set(),
        people: new Set(),
        // What this most likely was meant to be. Almost never "a new shift":
        // 05:30–11:30 against a property running 05:00–11:30 is somebody
        // typing half past, and creating a second nearly identical shift
        // splits the reports between them for ever.
        nearest: nearestShifts(r.startsAt, r.endsAt, shifts, { position: r.position }).map((n) => ({
          id: n.shift.id,
          name: n.shift.name,
          startsAt: n.shift.starts_at,
          endsAt: n.shift.ends_at,
          minutesApart: n.minutes,
        })),
      });
    }
    const q = questions.get(key);
    q.lines += 1;
    if (r.day) q.days.add(r.day);
    if (r.name) q.people.add(r.name);
  }

  return json({
    draft: {
      id: draft.id,
      filename: draft.filename,
      from: draft.from_day,
      to: draft.to_day,
      createdBy: draft.created_by,
      createdAt: draft.created_at,
      counts: countsOf(list),
      rows: list,
      // Names the file used that nobody here answers to, each offered once.
      unknownNames: [...new Set(list.filter((r) => r.action === 'skip' && r.staffId == null && r.name)
        .map((r) => r.name))],
      shiftQuestions: [...questions.values()].map((q) => ({
        ...q,
        days: [...q.days].sort(),
        people: [...q.people].sort(),
      })),
    },
  });
}

/**
 * Say who a name means, and remember it.
 *
 * Re-plans the waiting draft immediately, because the point of answering is to
 * watch the number of skipped lines drop. Nothing is written to the rota.
 */
export async function mapImportName(ctx) {
  const body = await readJson(ctx.request);
  const alias = str(body.alias, 'Name', { required: true, max: 200 }).toLowerCase();
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  await ctx.db.prepare(
    `INSERT INTO att_name_alias (alias, staff_id, created_by) VALUES (?1, ?2, ?3)
     ON CONFLICT (alias) DO UPDATE SET staff_id = excluded.staff_id, created_by = excluded.created_by`,
  ).bind(alias, staffId, `${ctx.session.user.name} (${ctx.session.user.role})`).run();

  const draft = await ctx.db.prepare(
    "SELECT * FROM att_roster_import WHERE status = 'draft' ORDER BY id DESC LIMIT 1",
  ).first().catch(() => null);

  if (draft) {
    const rows = await ctx.db.prepare(
      'SELECT * FROM att_roster_import_row WHERE import_id = ? AND LOWER(raw_name) = ?',
    ).bind(draft.id, alias).all();

    const ds = await loadDataset(ctx.db, { from: draft.from_day, to: draft.to_day });
    const shifts = ds.shifts.filter((s) => s.active);

    const updates = (rows.results ?? []).map((r) => {
      const match = shifts.find((s) => s.starts_at === r.starts_at && s.ends_at === r.ends_at);
      return ctx.db.prepare(
        `UPDATE att_roster_import_row
            SET staff_id = ?1, shift_id = ?2, action = ?3, problem = NULL
          WHERE id = ?4`,
      ).bind(staffId, match?.id ?? null, match ? 'roster' : 'needs-shift', r.id);
    });
    if (updates.length) await ctx.db.batch(updates);
  }

  await audit(ctx, 'attendance.rota_import_alias', staffId, { alias });
  return json({ ok: true, matched: staff.name });
}

/**
 * Decide what a set of hours means, for every line in the draft that uses them.
 *
 * Three answers, and none of them is the default:
 *
 *   `existing` — these hours were meant to be a shift the property already
 *   runs. The commonest answer by far, and the one that keeps the reports from
 *   splitting across two nearly identical shifts.
 *
 *   `create` — genuinely a new shift. Recorded as an intention, not carried out:
 *   the shift appears when the draft is confirmed, so discarding leaves nothing
 *   behind.
 *
 *   `skip` — leave those lines out.
 */
export async function resolveImportShift(ctx) {
  const body = await readJson(ctx.request);
  const startsAt = str(body.startsAt, 'Start', { required: true, max: 5 });
  const endsAt = str(body.endsAt, 'End', { required: true, max: 5 });
  const choice = ['existing', 'create', 'skip'].includes(body.choice) ? body.choice : null;
  if (!choice) throw badRequest('Say whether to use an existing shift, create one, or leave those lines out.');

  const draft = await ctx.db.prepare(
    "SELECT * FROM att_roster_import WHERE status = 'draft' ORDER BY id DESC LIMIT 1",
  ).first().catch(() => null);
  if (!draft) throw notFound('There is no draft waiting.');

  if (choice === 'existing') {
    const shiftId = int(body.shiftId, 'Shift', { required: true, min: 1 });
    const shift = await ctx.db.prepare('SELECT * FROM att_shifts WHERE id = ?').bind(shiftId).first();
    if (!shift) throw notFound('No such shift.');

    await ctx.db.prepare(
      `UPDATE att_roster_import_row
          SET shift_id = ?1, shift_name = ?2, action = 'roster', problem = NULL
        WHERE import_id = ?3 AND starts_at = ?4 AND ends_at = ?5 AND action = 'needs-shift'`,
    ).bind(shiftId, shift.name, draft.id, startsAt, endsAt).run();
  } else if (choice === 'create') {
    const name = str(body.name, 'Name', { required: true, max: 60 });
    const clash = await ctx.db.prepare('SELECT 1 FROM att_shifts WHERE name = ?').bind(name).first();
    if (clash) throw badRequest(`There is already a shift called ${name}. Pick another name.`);

    await ctx.db.prepare(
      `UPDATE att_roster_import_row
          SET shift_id = NULL, shift_name = ?1, action = 'create-shift', problem = NULL
        WHERE import_id = ?2 AND starts_at = ?3 AND ends_at = ?4 AND action = 'needs-shift'`,
    ).bind(name, draft.id, startsAt, endsAt).run();
  } else {
    await ctx.db.prepare(
      `UPDATE att_roster_import_row
          SET action = 'skip', problem = 'Left out — no shift chosen for these hours.'
        WHERE import_id = ?1 AND starts_at = ?2 AND ends_at = ?3 AND action = 'needs-shift'`,
    ).bind(draft.id, startsAt, endsAt).run();
  }

  await audit(ctx, 'attendance.rota_import_shift', draft.id, { startsAt, endsAt, choice });
  return json({ ok: true });
}

/**
 * Apply the draft.
 *
 * Shifts the file needed and this property did not have are created first, so
 * that every row has something to point at. Their break, grace and day
 * thresholds are the defaults — nothing in a rota export knows a property's
 * policy, and inventing one would be a guess with somebody's wages behind it.
 */
export async function confirmRotaImport(ctx) {
  const draft = await ctx.db.prepare(
    "SELECT * FROM att_roster_import WHERE status = 'draft' ORDER BY id DESC LIMIT 1",
  ).first().catch(() => null);
  if (!draft) throw notFound('There is no draft waiting.');

  const rows = await ctx.db.prepare(
    "SELECT * FROM att_roster_import_row WHERE import_id = ? AND action != 'skip' ORDER BY line",
  ).bind(draft.id).all();

  const usable = rows.results ?? [];

  // Nothing is applied while a question is open. Half-applying a week and
  // leaving the rest to be noticed later is the failure this whole two-step
  // exists to prevent.
  const open = usable.filter((r) => r.action === 'needs-shift');
  if (open.length) {
    const hours = [...new Set(open.map((r) => `${r.starts_at}–${r.ends_at}`))];
    throw badRequest(
      `${open.length} line${open.length === 1 ? ' still needs' : 's still need'} a decision about `
      + `${hours.join(', ')}. Choose an existing shift, create one, or leave those lines out.`,
    );
  }

  if (!usable.length) throw badRequest('Every line in that file was skipped, so there is nothing to apply.');

  // 1. The shifts somebody explicitly asked for. Never anything else: an
  // import does not invent a shift, and by this point every one of these was
  // chosen by name on the draft screen.
  const wanted = new Map();
  for (const r of usable) {
    if (r.action !== 'create-shift' || !r.shift_name) continue;
    if (!wanted.has(r.shift_name)) wanted.set(r.shift_name, r);
  }

  for (const [name, r] of wanted) {
    const start = toMinutes(r.starts_at) ?? 0;
    const end = toMinutes(r.ends_at) ?? 0;
    const length = end > start ? end - start : end + 1440 - start;

    await ctx.db.prepare(
      `INSERT OR IGNORE INTO att_shifts
         (name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes,
          half_day_minutes, full_day_minutes, overtime_after, sort_order, active)
       VALUES (?1, ?2, ?3, 0, 5, 5, ?4, ?5, 0, ?6, 1)`,
    ).bind(
      name, r.starts_at, r.ends_at,
      Math.round((length / 2) / 30) * 30,
      Math.round((length * 0.9) / 30) * 30,
      start,
    ).run();
  }

  const created = await ctx.db.prepare('SELECT id, name FROM att_shifts').all();
  const byName = new Map((created.results ?? []).map((s) => [s.name, s.id]));

  // 2. The rota itself.
  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;
  const statements = [];
  let applied = 0;

  // What is on those days already. An import is the whole week as somebody
  // else drew it, so a line replaces whatever the person had that day rather
  // than landing beside it as a second shift.
  const ds = await loadDataset(ctx.db, { from: draft.from_day, to: draft.to_day });

  for (const r of usable) {
    const shiftId = r.shift_id ?? byName.get(r.shift_name) ?? null;
    if (!r.staff_id || !r.day || !shiftId) continue;

    statements.push(...replaceDay(ctx.db, {
      rows: rowsFor(ds, r.staff_id, r.day),
      staffId: r.staff_id,
      day: r.day,
      shiftId,
      actor,
      note: r.raw_note || r.raw_title || null,
      title: rowsFor(ds, r.staff_id, r.day)[0]?.title ?? null,
    }));
    applied += 1;
  }

  for (let i = 0; i < statements.length; i += 100) {
    await ctx.db.batch(statements.slice(i, i + 100));
  }

  await ctx.db.prepare(
    "UPDATE att_roster_import SET status = 'applied', decided_by = ?1, decided_at = datetime('now') "
    + 'WHERE id = ?2',
  ).bind(actor, draft.id).run();

  await audit(ctx, 'attendance.rota_import_apply', draft.id, {
    applied, newShifts: wanted.size, from: draft.from_day, to: draft.to_day,
  });

  return json({
    ok: true, applied, newShifts: wanted.size, from: draft.from_day, to: draft.to_day,
  });
}

/** Throw the draft away. Costs nothing, which is what makes trying it safe. */
export async function discardRotaImport(ctx) {
  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;
  await ctx.db.prepare(
    "UPDATE att_roster_import SET status = 'discarded', decided_by = ?1, decided_at = datetime('now') "
    + "WHERE status = 'draft'",
  ).bind(actor).run();

  await audit(ctx, 'attendance.rota_import_discard', null, null);
  return json({ ok: true });
}
