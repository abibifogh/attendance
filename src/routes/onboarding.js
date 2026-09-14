import {
  badRequest, bool, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { parseList } from '../lib/attendance.js';
import { fileStatus } from '../lib/ghana-templates.js';
import { DEFAULT_STEPS } from '../lib/onboarding-content.js';
import {
  SOURCES, isDone, nextForThem, ownerOf, progressOf, sourceOf, stepsFor, whoFor,
} from '../lib/onboarding.js';

/**
 * The first week.
 *
 * ORCHESTRATION, NOT A SECOND COPY OF ANYTHING. A step either names where its
 * proof already lives in this app, or it is ticked by a person. Nothing about
 * a contract, the handbook or somebody's file is written down twice here, so
 * the checklist cannot come to disagree with the thing it is reporting on: a
 * contract that is signed shows as done, and one that is not cannot be ticked
 * off by hand however much anybody would like to close the list.
 *
 * AND A ROW IN ob_state IS THE WHOLE OF WHO IS ONBOARDING. No row means not
 * onboarding, which is what keeps everybody already on the payroll off this
 * screen on the morning it ships.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const can = (ctx, permission) => (ctx.session?.permissions ?? []).includes(permission)
  || ctx.session?.user?.role === 'admin';

async function isOn(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'onboarding_on'")
    .first().catch(() => null);
  return String(row?.value ?? '0') === '1';
}

const settingOf = async (db, key) => (await db.prepare('SELECT value FROM settings WHERE key = ?')
  .bind(key).first().catch(() => null))?.value ?? '';

/** The staff record behind this login, or null. An administrator may have none. */
async function meOf(ctx) {
  const staffId = Number(ctx.session?.user?.staff_id) || 0;
  if (!staffId) return null;
  return ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first()
    .catch(() => null);
}

const allSteps = async (db) => (await db.prepare(
  'SELECT * FROM ob_step ORDER BY sort_order, id',
).all().catch(() => ({ results: [] }))).results ?? [];

const stateOf = async (db, staffId) => db.prepare('SELECT * FROM ob_state WHERE staff_id = ?')
  .bind(staffId).first().catch(() => null);

const tickedBy = async (db, staffId) => new Set(
  ((await db.prepare('SELECT step_id FROM ob_done WHERE staff_id = ?')
    .bind(staffId).all().catch(() => ({ results: [] }))).results ?? [])
    .map((r) => Number(r.step_id)),
);

// ---------------------------------------------------------------------------
// What the rest of the app already knows
// ---------------------------------------------------------------------------

/**
 * The four derived answers, read from where they actually live.
 *
 * One round of queries per person rather than one per step, because a
 * checklist of sixteen steps that asked the contracts table four times would
 * be four times slower for no reason.
 */
async function settledFor(db, staff) {
  const id = staff.id;

  const [profile, submission, contracts, documents] = await Promise.all([
    db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').bind(id).first().catch(() => null),
    db.prepare("SELECT COUNT(*) n FROM hr_submission WHERE staff_id = ? AND status = 'accepted'")
      .bind(id).first().catch(() => null),
    db.prepare('SELECT status, satisfies FROM hr_contract WHERE staff_id = ?')
      .bind(id).all().catch(() => ({ results: [] })),
    db.prepare('SELECT kind, expires_on FROM hr_document WHERE staff_id = ?')
      .bind(id).all().catch(() => ({ results: [] })),
  ]);

  const contractRows = contracts.results ?? [];
  const documentRows = documents.results ?? [];

  // Their own particulars. Either they sent them in and the office accepted
  // them, or somebody in the office typed them straight onto the record, which
  // is the same thing as far as a checklist is concerned.
  const details = Number(submission?.n ?? 0) > 0
    || Boolean(profile?.address_line && profile?.phone);

  const signed = contractRows.some((c) => c.status === 'signed');

  const file = fileStatus(staff, profile, {
    documents: documentRows,
    contracts: contractRows,
  });
  const documentsHeld = file.every((d) => d.state === 'held' || d.state === 'expiring');

  // The handbook, which has its own switch. Off, or nothing published that
  // asks anything, and there is nothing outstanding to be outstanding.
  const handbookOn = String(await settingOf(db, 'handbook_on')) === '1';
  let handbook = true;
  if (handbookOn) {
    const chapters = (await db.prepare(
      "SELECT id, version, live_asks, asks, status, departments, tags FROM hb_chapter WHERE status = 'published'",
    ).all().catch(() => ({ results: [] }))).results ?? [];
    const acks = (await db.prepare('SELECT chapter_id, version FROM hb_ack WHERE staff_id = ?')
      .bind(id).all().catch(() => ({ results: [] }))).results ?? [];

    const done = new Set(acks.map((a) => `${a.chapter_id}|${a.version}`));
    handbook = chapters
      .filter((c) => (c.live_asks ?? c.asks) !== 'read')
      .filter((c) => {
        const departments = parseList(c.departments);
        const tags = parseList(c.tags);
        if (!departments.length && !tags.length) return true;
        if (departments.includes(staff.department || '')) return true;
        const theirs = new Set(parseList(staff.tags));
        return tags.some((t) => theirs.has(t));
      })
      .every((c) => done.has(`${c.id}|${c.version}`));
  }

  return { details, contract: signed, documents: documentsHeld, handbook };
}

/** The two welcomes, as the screen draws them. A blank one is not drawn at all. */
async function welcomesFrom(db) {
  const rows = await Promise.all([
    settingOf(db, 'ob_owner_name'), settingOf(db, 'ob_owner_role'), settingOf(db, 'ob_owner_words'),
    settingOf(db, 'ob_md_name'), settingOf(db, 'ob_md_role'), settingOf(db, 'ob_md_words'),
  ]);
  const [ownerName, ownerRole, ownerWords, mdName, mdRole, mdWords] = rows;
  return [
    { slot: 'owner', name: ownerName, role: ownerRole || 'Owner', words: ownerWords },
    { slot: 'md', name: mdName, role: mdRole || 'Managing Director', words: mdWords },
  ].filter((w) => w.words.trim());
}

/** One step, as somebody reads it. */
const asStep = (step, state, ticks) => ({
  id: step.id,
  code: step.code,
  title: step.title,
  detail: step.detail ?? null,
  source: sourceOf(step),
  owner: ownerOf(step),
  who: whoFor(step),
  done: isDone(step, state),
  doneAt: ticks.get(Number(step.id))?.done_at ?? null,
  doneBy: ticks.get(Number(step.id))?.done_by ?? null,
  note: ticks.get(Number(step.id))?.note ?? null,
});

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/**
 * Somebody's own first week.
 *
 * The welcome, the checklist, and how far they have got. Answers for anybody
 * signed in with a staff record, whether or not they are being onboarded: the
 * screen says so rather than erroring, because a link followed out of
 * curiosity should explain itself.
 */
export async function myOnboarding(ctx) {
  const on = await isOn(ctx.db);
  const staff = await meOf(ctx);
  if (!staff) {
    return json({
      on, onboarding: false, welcomes: [], steps: [], progress: null, next: null,
    });
  }

  const state = await stateOf(ctx.db, staff.id);
  if (!on || !state) {
    return json({
      on,
      onboarding: false,
      me: { id: staff.id, name: staff.name },
      welcomes: [],
      steps: [],
      progress: null,
      next: null,
    });
  }

  const steps = await allSteps(ctx.db);
  const ticks = new Map(
    (((await ctx.db.prepare('SELECT * FROM ob_done WHERE staff_id = ?').bind(staff.id).all()
      .catch(() => ({ results: [] }))).results) ?? []).map((r) => [Number(r.step_id), r]),
  );
  const settled = await settledFor(ctx.db, staff);
  const at = { ticked: new Set(ticks.keys()), settled };

  const progress = progressOf(steps, staff, at);
  const next = nextForThem(steps, staff, at);

  // Stamped the moment the last thing is done, so the app stops landing them
  // here and the office stops counting them as new. Written once: the guard on
  // finished_at keeps a redraw from moving the date every time they look.
  if (progress.complete && !state.finished_at) {
    await ctx.db.prepare(
      "UPDATE ob_state SET finished_at = datetime('now'), finished_by = 'Everything done'"
      + ' WHERE staff_id = ? AND finished_at IS NULL',
    ).bind(staff.id).run().catch(() => {});
  }

  return json({
    on: true,
    onboarding: true,
    me: { id: staff.id, name: staff.name, firstName: String(staff.name).trim().split(/\s+/)[0] },
    startedAt: state.started_at,
    finishedAt: state.finished_at ?? (progress.complete ? 'just now' : null),
    welcomes: await welcomesFrom(ctx.db),
    property: await settingOf(ctx.db, 'property_name'),
    steps: stepsFor(steps, staff).map((s) => asStep(s, at, ticks)),
    progress: { of: progress.of, done: progress.done, percent: progress.percent },
    next: next ? { id: next.id, title: next.title, source: sourceOf(next) } : null,
  });
}

/**
 * Every first week in progress, for whoever runs them.
 *
 * Ordered by who started longest ago, because the one that has been open for
 * five weeks is the one somebody has forgotten about.
 */
export async function onboardings(ctx) {
  if (!can(ctx, 'hr_view') && !can(ctx, 'hr_manage')) throw forbidden('Not yours to read.');

  const rows = (await ctx.db.prepare(
    `SELECT s.*, p.name, p.employee_no, p.department, p.job_title, p.hired_on, p.active, p.tags
       FROM ob_state s JOIN att_staff p ON p.id = s.staff_id
      ORDER BY s.finished_at IS NOT NULL, s.started_at`,
  ).all().catch(() => ({ results: [] }))).results ?? [];

  const steps = await allSteps(ctx.db);

  const out = [];
  for (const row of rows) {
    const staff = {
      id: row.staff_id, name: row.name, department: row.department, tags: row.tags,
    };
    const ticked = await tickedBy(ctx.db, row.staff_id);
    const settled = await settledFor(ctx.db, staff);
    const progress = progressOf(steps, staff, { ticked, settled });

    out.push({
      staffId: row.staff_id,
      name: row.name,
      employeeNo: row.employee_no,
      department: row.department,
      jobTitle: row.job_title,
      hiredOn: row.hired_on,
      active: Boolean(row.active),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      of: progress.of,
      done: progress.done,
      percent: progress.percent,
      waiting: progress.waiting.map((s) => s.title),
    });
  }

  return json({
    on: await isOn(ctx.db),
    mayManage: can(ctx, 'hr_manage'),
    people: out,
    steps: steps.map((s) => ({
      id: s.id,
      code: s.code,
      title: s.title,
      detail: s.detail ?? null,
      source: sourceOf(s),
      owner: ownerOf(s),
      who: whoFor(s),
      departments: parseList(s.departments),
      tags: parseList(s.tags),
      order: s.sort_order,
      active: Boolean(s.active),
    })),
    sources: SOURCES,
    available: DEFAULT_STEPS
      .filter((d) => !steps.some((s) => s.code === d.code))
      .map((d) => ({ code: d.code, title: d.title })),
  });
}

/** One person's checklist, from the office side. */
export async function onboardingFor(ctx, id) {
  if (!can(ctx, 'hr_view') && !can(ctx, 'hr_manage')) throw forbidden('Not yours to read.');
  const staffId = int(id, 'Staff', { min: 1 });

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first()
    .catch(() => null);
  if (!staff) throw notFound('No such member of staff.');

  const state = await stateOf(ctx.db, staffId);
  const steps = await allSteps(ctx.db);
  const ticks = new Map(
    (((await ctx.db.prepare('SELECT * FROM ob_done WHERE staff_id = ?').bind(staffId).all()
      .catch(() => ({ results: [] }))).results) ?? []).map((r) => [Number(r.step_id), r]),
  );
  const settled = await settledFor(ctx.db, staff);
  const at = { ticked: new Set(ticks.keys()), settled };
  const progress = progressOf(steps, staff, at);

  return json({
    on: await isOn(ctx.db),
    mayManage: can(ctx, 'hr_manage'),
    staff: { id: staff.id, name: staff.name, department: staff.department, jobTitle: staff.job_title },
    started: Boolean(state),
    startedAt: state?.started_at ?? null,
    finishedAt: state?.finished_at ?? null,
    steps: stepsFor(steps, staff).map((s) => asStep(s, at, ticks)),
    progress: { of: progress.of, done: progress.done, percent: progress.percent },
  });
}

// ---------------------------------------------------------------------------
// Changing it
// ---------------------------------------------------------------------------

/** Begin somebody's first week, or begin it again. */
export async function startOnboarding(ctx, id) {
  if (!can(ctx, 'hr_manage')) throw forbidden('Not yours to start.');
  const staffId = int(id, 'Staff', { min: 1 });

  const staff = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
    .bind(staffId).first().catch(() => null);
  if (!staff) throw notFound('No such member of staff.');

  await ctx.db.prepare(
    `INSERT INTO ob_state (staff_id, started_by) VALUES (?1, ?2)
       ON CONFLICT (staff_id) DO UPDATE SET
         started_at = datetime('now'), started_by = ?2,
         finished_at = NULL, finished_by = NULL`,
  ).bind(staffId, actorOf(ctx)).run();

  await audit(ctx, 'onboarding.start', staffId, { name: staff.name });
  return json({ ok: true });
}

/**
 * Settle somebody in, whatever the checklist still says.
 *
 * A first week that will not close because a health certificate is still with
 * the printer is a first week that follows somebody into their second year.
 * What is unticked stays unticked and stays visible; this only stops the app
 * treating them as new.
 */
export async function finishOnboarding(ctx, id) {
  if (!can(ctx, 'hr_manage')) throw forbidden('Not yours to close.');
  const staffId = int(id, 'Staff', { min: 1 });

  const changed = await ctx.db.prepare(
    "UPDATE ob_state SET finished_at = datetime('now'), finished_by = ?2 WHERE staff_id = ?1",
  ).bind(staffId, actorOf(ctx)).run();
  if (!changed?.meta?.changes) throw notFound('That person is not being onboarded.');

  await audit(ctx, 'onboarding.finish', staffId, null);
  return json({ ok: true });
}

/**
 * Tick a step off, or take the tick back.
 *
 * Only a manual step. A derived one is answered by the contract, the handbook
 * or the file, and letting somebody tick it here would be letting them close a
 * list by asserting something the record contradicts.
 */
export async function tickStep(ctx, id) {
  if (!can(ctx, 'hr_manage')) throw forbidden('Not yours to tick.');
  const stepId = int(id, 'Step', { min: 1 });
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { min: 1 });

  const step = await ctx.db.prepare('SELECT * FROM ob_step WHERE id = ?').bind(stepId).first()
    .catch(() => null);
  if (!step) throw notFound('No such step.');
  if (sourceOf(step) !== 'manual') {
    throw badRequest(`"${step.title}" ticks itself off when the record shows it done. `
      + 'It cannot be ticked by hand.');
  }

  const staff = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
    .bind(staffId).first().catch(() => null);
  if (!staff) throw notFound('No such member of staff.');

  if (bool(body.done, true)) {
    await ctx.db.prepare(
      `INSERT INTO ob_done (staff_id, step_id, done_by, note) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (staff_id, step_id) DO UPDATE SET
           done_at = datetime('now'), done_by = ?3, note = ?4`,
    ).bind(staffId, stepId, actorOf(ctx), str(body.note, 'Note', { max: 300, fallback: '' }) || null)
      .run();
  } else {
    await ctx.db.prepare('DELETE FROM ob_done WHERE staff_id = ? AND step_id = ?')
      .bind(staffId, stepId).run();
    // Taking a tick back reopens the first week, or somebody settled in by
    // accident stays settled in with a step nobody can see is missing.
    await ctx.db.prepare(
      'UPDATE ob_state SET finished_at = NULL, finished_by = NULL WHERE staff_id = ?',
    ).bind(staffId).run().catch(() => {});
  }

  await audit(ctx, 'onboarding.tick', staffId, { step: step.code, done: bool(body.done, true) });
  return json({ ok: true });
}

/** Write a step, or change one. */
export async function saveStep(ctx) {
  if (!can(ctx, 'hr_manage')) throw forbidden('Not yours to write.');
  const body = await readJson(ctx.request);

  const title = str(body.title, 'Title', { required: true, max: 160 });
  const detail = str(body.detail, 'What it means', { max: 1000, fallback: '' });
  const source = SOURCES.some((s) => s.key === body.source) ? body.source : 'manual';
  const owner = body.owner === 'staff' ? 'staff' : 'office';
  const order = int(body.order ?? 100, 'Where it sits', { min: 0, max: 9999 });
  const active = bool(body.active, true) ? 1 : 0;
  const departments = JSON.stringify(parseList(body.departments));
  const tags = JSON.stringify(parseList(body.tags));

  if (body.id) {
    const stepId = int(body.id, 'Step', { min: 1 });
    await ctx.db.prepare(
      `UPDATE ob_step SET title = ?2, detail = ?3, source = ?4, owner = ?5, sort_order = ?6,
              active = ?7, departments = ?8, tags = ?9,
              updated_at = datetime('now'), updated_by = ?10
         WHERE id = ?1`,
    ).bind(stepId, title, detail || null, source, owner, order, active, departments, tags,
      actorOf(ctx)).run();
    await audit(ctx, 'onboarding.step_save', stepId, { title });
    return json({ ok: true, id: stepId });
  }

  // A code of its own, so a step written here is never overwritten by a later
  // load of the standard set.
  const code = `own_${Date.now().toString(36)}`;
  const made = await ctx.db.prepare(
    `INSERT INTO ob_step (code, title, detail, source, owner, sort_order, active,
                          departments, tags, updated_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING id`,
  ).bind(code, title, detail || null, source, owner, order, active, departments, tags,
    actorOf(ctx)).first();

  await audit(ctx, 'onboarding.step_new', made.id, { title });
  return json({ ok: true, id: made.id });
}

/** Take a step off the list. What is already ticked goes with it. */
export async function removeStep(ctx, id) {
  if (!can(ctx, 'hr_manage')) throw forbidden('Not yours to remove.');
  const stepId = int(id, 'Step', { min: 1 });
  await ctx.db.prepare('DELETE FROM ob_step WHERE id = ?').bind(stepId).run();
  await audit(ctx, 'onboarding.step_delete', stepId, null);
  return json({ ok: true });
}

/** Put the standard checklist in, without disturbing anything already there. */
export async function installStandard(ctx) {
  if (!can(ctx, 'hr_manage')) throw forbidden('Not yours to install.');

  const held = new Set((await allSteps(ctx.db)).map((s) => s.code));
  let added = 0;
  for (const step of DEFAULT_STEPS) {
    if (held.has(step.code)) continue;
    await ctx.db.prepare(
      `INSERT INTO ob_step (code, title, detail, source, owner, departments, tags,
                            sort_order, updated_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(
      step.code, step.title, step.detail, step.source ?? 'manual', step.owner ?? 'office',
      JSON.stringify(step.departments ?? []), JSON.stringify(step.tags ?? []),
      step.sort_order ?? 100, actorOf(ctx),
    ).run();
    added += 1;
  }

  await audit(ctx, 'onboarding.install', null, { added });
  return json({ ok: true, added, total: DEFAULT_STEPS.length });
}

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorOf(ctx), action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null).run().catch(() => {});
}

/**
 * Start a first week for somebody just added to the staff list.
 *
 * Called from wherever a staff record is created rather than left to whoever
 * remembers: the new hire who is missed is the one nobody set up. Silent when
 * onboarding is switched off, and silent on failure, because failing to add a
 * checklist must never be the reason somebody could not be added to the rota.
 */
export async function beginFor(db, staffId, by) {
  if (!staffId) return;
  if (!await isOn(db)) return;
  await db.prepare(
    'INSERT OR IGNORE INTO ob_state (staff_id, started_by) VALUES (?, ?)',
  ).bind(Number(staffId), by ?? 'Added to the staff list').run().catch(() => {});
}

/** Whether the app should land this person on their first week. One lookup. */
export async function landsOnOnboarding(db, staffId) {
  if (!staffId) return false;
  if (!await isOn(db)) return false;
  const row = await db.prepare(
    'SELECT finished_at FROM ob_state WHERE staff_id = ?',
  ).bind(Number(staffId)).first().catch(() => null);
  return Boolean(row) && !row.finished_at;
}
