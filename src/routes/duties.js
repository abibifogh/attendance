import { badRequest, bool, int, json, notFound, readJson, str } from '../lib/http.js';
import { addDays, isDay } from '../util/dates.js';
import {
  dutyBoard, fillDuty, listDuties, setDuty, stepsOf,
} from '../lib/duties.js';

/**
 * Duties on a shift: the rota's duty rows, giving one to somebody, filling a
 * week fairly, ticking off what was done, and setting them up.
 */

const actorOf = (ctx) => ctx.session.user.name;
const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(`${ctx.session.user.name} (${ctx.session.user.role})`, action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

function readRange(ctx) {
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  if (!isDay(from) || !isDay(to) || to < from) throw badRequest('Choose the days.');
  if (addDays(from, 62) < to) throw badRequest('Two months at most.');
  return { from, to };
}

/** GET /api/att/duties?from&to — the duty rows for the rota. */
export async function dutyRows(ctx) {
  const { from, to } = readRange(ctx);
  return json(await dutyBoard(ctx.db, { from, to }));
}

/** PUT /api/att/duties/assign { dutyId, day, staffId, on } */
export async function assignDuty(ctx) {
  const body = await readJson(ctx.request);
  const dutyId = int(body.dutyId, 'Duty', { required: true, min: 1 });
  const staffId = int(body.staffId, 'Who', { required: true, min: 1 });
  if (!isDay(body.day)) throw badRequest('Which day?');
  const on = bool(body.on, true);
  const done = await setDuty(ctx.db, { dutyId, day: body.day, staffId, on, by: actorOf(ctx) });
  if (!done.ok) throw badRequest(done.error);
  await audit(ctx, on ? 'rota.duty_given' : 'rota.duty_taken', dutyId, { day: body.day, staffId });
  return json({ ok: true });
}

/** POST /api/att/duties/fill { dutyId, from, to } */
export async function fillDuties(ctx) {
  const body = await readJson(ctx.request);
  const dutyId = int(body.dutyId, 'Duty', { required: true, min: 1 });
  if (!isDay(body.from) || !isDay(body.to) || body.to < body.from) throw badRequest('Choose the days.');
  const out = await fillDuty(ctx.db, { dutyId, from: body.from, to: body.to, by: actorOf(ctx) });
  await audit(ctx, 'rota.duty_fill', dutyId, { from: body.from, to: body.to, filled: out.filled });
  return json({ ok: true, ...out });
}

/** PUT /api/me/duties/tick { dutyId, day, step, on } — their own, ticked off. */
export async function tickMyDuty(ctx) {
  const body = await readJson(ctx.request);
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) throw badRequest('Your login is not linked to a staff record.');
  const dutyId = int(body.dutyId, 'Duty', { required: true, min: 1 });
  const step = int(body.step, 'Step', { required: true, min: 0, max: 20 });
  if (!isDay(body.day)) throw badRequest('Which day?');
  const row = await ctx.db.prepare('SELECT id, done FROM rota_duty_day WHERE duty_id = ?1 AND day = ?2 AND staff_id = ?3')
    .bind(dutyId, body.day, staffId).first();
  if (!row) throw notFound('That duty is not yours on that day.');
  let done = [];
  try { done = JSON.parse(row.done || '[]'); } catch { done = []; }
  done = bool(body.on, true) ? [...new Set([...done, step])].sort((a, b) => a - b) : done.filter((n) => n !== step);
  await ctx.db.prepare('UPDATE rota_duty_day SET done = ? WHERE id = ?').bind(JSON.stringify(done), row.id).run();
  return json({ ok: true, done });
}

// ---------------------------------------------------------------------------
// Setting them up
// ---------------------------------------------------------------------------

/** GET /api/att/duties/setup */
export async function dutySetup(ctx) {
  const [duties, shifts, departments] = await Promise.all([
    listDuties(ctx.db, { all: true }),
    ctx.db.prepare('SELECT id, name, department, starts_at, ends_at FROM att_shifts WHERE active = 1 ORDER BY department, sort_order, name').all()
      .catch(() => ({ results: [] })),
    ctx.db.prepare("SELECT value FROM settings WHERE key = 'att_departments'").first().catch(() => null),
  ]);
  return json({
    duties,
    shifts: shifts.results ?? [],
    departments: String(departments?.value ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
  });
}

function readDuty(body) {
  const readyBy = str(body.readyBy, 'Ready by', { max: 5 });
  if (readyBy && !/^([01]\d|2[0-3]):[0-5]\d$/.test(readyBy)) throw badRequest('Ready by is a time like 12:30.');
  const shiftIds = (Array.isArray(body.shiftIds) ? body.shiftIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return {
    name: str(body.name, 'Name', { required: true, max: 60 }),
    department: str(body.department, 'Department', { max: 80 }) || null,
    shift_ids: JSON.stringify([...new Set(shiftIds)]),
    kind: body.kind === 'lunch' ? 'lunch' : null,
    ready_by: readyBy || null,
    before_only: bool(body.beforeOnly, false) && readyBy ? 1 : 0,
    steps: stepsOf(str(body.steps, 'What they do', { max: 1200 })).join('\n') || null,
    needs_daily: bool(body.needsDaily, true) ? 1 : 0,
    tell_before: bool(body.tellBefore, true) ? 1 : 0,
    fair: bool(body.fair, true) ? 1 : 0,
    active: bool(body.active, true) ? 1 : 0,
  };
}

/** POST /api/att/duties/setup */
export async function createDuty(ctx) {
  const d = readDuty(await readJson(ctx.request));
  const made = await ctx.db.prepare(
    `INSERT INTO rota_duty (name, department, shift_ids, kind, ready_by, before_only, steps, needs_daily, tell_before, fair, active, sort)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, (SELECT COALESCE(MAX(sort), 0) + 1 FROM rota_duty)) RETURNING id`,
  ).bind(d.name, d.department, d.shift_ids, d.kind, d.ready_by, d.before_only, d.steps, d.needs_daily, d.tell_before, d.fair, d.active).first();
  await audit(ctx, 'rota.duty_create', made?.id, { name: d.name });
  return json({ ok: true, id: made?.id });
}

/** PUT /api/att/duties/setup/:id */
export async function updateDuty(ctx, idParam) {
  const id = int(idParam, 'Duty', { required: true, min: 1 });
  const d = readDuty(await readJson(ctx.request));
  const done = await ctx.db.prepare(
    `UPDATE rota_duty SET name = ?2, department = ?3, shift_ids = ?4, kind = ?5, ready_by = ?6, before_only = ?7,
            steps = ?8, needs_daily = ?9, tell_before = ?10, fair = ?11, active = ?12 WHERE id = ?1`,
  ).bind(id, d.name, d.department, d.shift_ids, d.kind, d.ready_by, d.before_only, d.steps, d.needs_daily, d.tell_before, d.fair, d.active).run();
  if (!Number(done?.meta?.changes ?? 0)) throw notFound('No such duty.');
  await audit(ctx, 'rota.duty_update', id, { name: d.name, active: d.active });
  return json({ ok: true });
}

/** DELETE /api/att/duties/setup/:id — only one never given to anybody. */
export async function deleteDuty(ctx, idParam) {
  const id = int(idParam, 'Duty', { required: true, min: 1 });
  const used = await ctx.db.prepare('SELECT COUNT(*) AS n FROM rota_duty_day WHERE duty_id = ?').bind(id).first();
  if (Number(used?.n)) throw badRequest('It has been given to people already. Switch it off instead, so the record stays.');
  await ctx.db.prepare('DELETE FROM rota_duty WHERE id = ?').bind(id).run();
  await audit(ctx, 'rota.duty_delete', id, {});
  return json({ ok: true });
}
