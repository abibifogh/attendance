import { badRequest, int, json, notFound, readJson, str } from '../lib/http.js';
import { loadDataset, toMinutes } from '../lib/attendance.js';
import { parseRotaCsv, planImport } from '../lib/roster-import.js';

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
  const text = String(body.csv ?? '');
  if (!text.trim()) throw badRequest('There was nothing in that file.');
  if (text.length > 2_000_000) throw badRequest('That file is too big — a week at a time, please.');

  const parsed = parseRotaCsv(text);
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

  const usable = list.filter((r) => r.action !== 'skip');
  return json({
    draft: {
      id: draft.id,
      filename: draft.filename,
      from: draft.from_day,
      to: draft.to_day,
      createdBy: draft.created_by,
      createdAt: draft.created_at,
      counts: {
        lines: list.length,
        roster: usable.length,
        newShifts: new Set(usable.filter((r) => r.action === 'new-shift').map((r) => r.shiftName)).size,
        skipped: list.filter((r) => r.action === 'skip').length,
        people: new Set(usable.map((r) => r.staffId)).size,
      },
      rows: list,
      // Names the file used that nobody here answers to, each offered once
      // rather than once per line — it is one question about one person.
      unknownNames: [...new Set(list.filter((r) => r.action === 'skip' && r.staffId == null && r.name)
        .map((r) => r.name))],
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
      ).bind(staffId, match?.id ?? null, match ? 'roster' : 'new-shift', r.id);
    });
    if (updates.length) await ctx.db.batch(updates);
  }

  await audit(ctx, 'attendance.rota_import_alias', staffId, { alias });
  return json({ ok: true, matched: staff.name });
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
  if (!usable.length) throw badRequest('Every line in that file was skipped, so there is nothing to apply.');

  // 1. The shifts that do not exist yet.
  const wanted = new Map();
  for (const r of usable) {
    if (r.shift_id || !r.shift_name) continue;
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

  for (const r of usable) {
    const shiftId = r.shift_id ?? byName.get(r.shift_name) ?? null;
    if (!r.staff_id || !r.day || !shiftId) continue;

    statements.push(ctx.db.prepare(
      `INSERT INTO att_roster (staff_id, day, shift_id, note, set_by, set_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
       ON CONFLICT (staff_id, day) DO UPDATE SET
         shift_id = excluded.shift_id, note = excluded.note,
         set_by = excluded.set_by, set_at = excluded.set_at`,
    ).bind(r.staff_id, r.day, shiftId, r.raw_note || r.raw_title || null, actor));
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
