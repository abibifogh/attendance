import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { addDays, isDay, nowIn } from '../util/dates.js';
import {
  askEverybody, askedPeople, confirmRound, leftFor, openRound, picksFor, placesOf, readRound,
  remindWaiting, takenBy, whatStopsIt,
} from '../lib/holiday-choice.js';

/**
 * Christmas or New Year: the office's board and set-up, and each person's
 * own choice. The rules live in lib/holiday-choice.js.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

async function today(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null);
  return nowIn(row?.value || 'UTC').slice(0, 10);
}

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
    .bind(actorOf(ctx), action, entity == null ? null : String(entity), detail ? JSON.stringify(detail) : null)
    .run().catch(() => {});
}

function dayOf(value, field) {
  const day = String(value ?? '');
  if (!isDay(day)) throw badRequest(`${field} is not a date.`);
  return day;
}

/** Departments and how many of each are asked. */
function headcounts(people) {
  const out = new Map();
  for (const p of people) out.set(p.department, (out.get(p.department) ?? 0) + 1);
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([name, people]) => ({ name, people }));
}

// ---------------------------------------------------------------------------
// The office
// ---------------------------------------------------------------------------

/** What a new round starts as: Christmas and New Year, half each. */
export async function suggestion(ctx) {
  const now = await today(ctx.db);
  const year = now.slice(5) > '12-26' ? Number(now.slice(0, 4)) + 1 : Number(now.slice(0, 4));
  const people = await askedPeople(ctx.db);
  const departments = headcounts(people);
  const half = (n) => Math.floor(n / 2);
  return json({
    title: `Christmas or New Year ${year}`,
    mode: 'first',
    dueOn: `${year}-11-20` < now ? addDays(now, 14) : `${year}-11-20`,
    unanswered: 'room',
    remind: true,
    chargeLeave: true,
    departments,
    options: [
      { label: 'Christmas', from: `${year}-12-25`, to: `${year}-12-26`, limits: Object.fromEntries(departments.map((d) => [d.name, half(d.people)])) },
      { label: 'New Year', from: `${year + 1}-01-01`, to: `${year + 1}-01-02`, limits: Object.fromEntries(departments.map((d) => [d.name, d.people - half(d.people)])) },
    ],
  });
}

/** The board: every round, and the one asked for (the newest by default). */
export async function board(ctx) {
  const rows = await ctx.db.prepare('SELECT id, title, status FROM hol_round ORDER BY id DESC').all()
    .catch(() => ({ results: [] }));
  const rounds = rows.results ?? [];
  const wanted = Number(ctx.url.searchParams.get('id')) || rounds[0]?.id;
  if (!wanted) return json({ rounds: [], round: null });
  const round = await readRound(ctx.db, wanted);
  if (!round) throw notFound('No such holiday choice.');

  const people = await askedPeople(ctx.db);
  const picks = await picksFor(ctx.db, round.id);
  const departments = headcounts(people).map((d) => ({
    ...d,
    options: round.options.map((o) => ({
      id: o.id,
      places: placesOf(o, d.name),
      taken: takenBy(picks, people, o.id, d.name),
    })),
  }));
  return json({
    rounds,
    round,
    departments,
    people: people.map((p) => {
      const pick = picks.get(p.id);
      return {
        ...p,
        optionId: pick?.option_id ?? null,
        byOffice: Boolean(pick?.by_office),
        pickedAt: pick?.picked_at ?? null,
        leaveId: pick?.leave_id ?? null,
      };
    }),
    problems: round.status === 'confirmed' ? [] : whatStopsIt(round, people, picks),
  });
}

/** Write a round: its settings and its choices, and open it if asked. */
export async function saveRound(ctx) {
  const body = await readJson(ctx.request);
  const id = body.id ? int(body.id, 'Round') : null;
  const existing = id ? await readRound(ctx.db, id) : null;
  if (id && !existing) throw notFound('No such holiday choice.');
  if (existing?.status === 'confirmed') throw badRequest('This one is confirmed and on the rota already.');

  const title = str(body.title, 'What staff see it called', { max: 120 });
  if (!title) throw badRequest('Give it a name staff will recognise.');
  const mode = body.mode === 'decide' ? 'decide' : 'first';
  const unanswered = body.unanswered === 'office' ? 'office' : 'room';
  const dueOn = dayOf(body.dueOn, 'Answers by');

  const options = Array.isArray(body.options) ? body.options : [];
  if (options.length < 2) throw badRequest('Give at least two choices.');
  if (options.length > 6) throw badRequest('Six choices at most.');
  const cleaned = options.map((o, i) => {
    const label = str(o.label, 'Choice name', { max: 60 });
    if (!label) throw badRequest(`Choice ${i + 1} needs a name.`);
    const from = dayOf(o.from, `${label}: first day`);
    const to = dayOf(o.to, `${label}: last day`);
    if (to < from) throw badRequest(`${label} ends before it starts.`);
    if (addDays(from, 13) < to) throw badRequest(`${label} is longer than a fortnight.`);
    if (dueOn > from) throw badRequest(`Answers are due after ${label} has started.`);
    const limits = {};
    for (const [dept, n] of Object.entries(o.limits ?? {})) {
      if (n === '' || n == null) continue;
      limits[String(dept).slice(0, 80)] = int(n, `${label}, ${dept}`, { min: 0, max: 500 });
    }
    return { id: o.id ? Number(o.id) : null, label, from, to, limits };
  });
  const sorted = [...cleaned].sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].from <= sorted[i - 1].to) throw badRequest(`${sorted[i - 1].label} and ${sorted[i].label} overlap.`);
  }

  let roundId = id;
  if (roundId) {
    await ctx.db.prepare(
      `UPDATE hol_round SET title = ?1, mode = ?2, due_on = ?3, unanswered = ?4, remind = ?5, charge_leave = ?6
        WHERE id = ?7`,
    ).bind(title, mode, dueOn, unanswered, body.remind === false ? 0 : 1, body.chargeLeave === false ? 0 : 1, roundId).run();
  } else {
    const live = await ctx.db.prepare("SELECT id FROM hol_round WHERE status IN ('draft', 'open')").first();
    if (live) throw badRequest('There is already a holiday choice under way. Finish or remove it first.');
    const row = await ctx.db.prepare(
      `INSERT INTO hol_round (title, mode, due_on, unanswered, remind, charge_leave, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    ).bind(title, mode, dueOn, unanswered, body.remind === false ? 0 : 1, body.chargeLeave === false ? 0 : 1, actorOf(ctx)).first();
    roundId = row.id;
  }

  // The choices. One that somebody has already picked stays, under its new
  // name and dates; one taken away has to have nobody on it.
  const keep = new Set(cleaned.filter((o) => o.id).map((o) => o.id));
  for (const old of existing?.options ?? []) {
    if (keep.has(old.id)) continue;
    const used = await ctx.db.prepare('SELECT COUNT(*) AS n FROM hol_pick WHERE option_id = ?').bind(old.id).first();
    if (Number(used?.n)) throw badRequest(`${old.label} has been chosen already, so it cannot be taken away. Move those people first.`);
    await ctx.db.prepare('DELETE FROM hol_option WHERE id = ?').bind(old.id).run();
  }
  for (const [position, o] of cleaned.entries()) {
    let optionId = o.id && existing?.options.some((x) => x.id === o.id) ? o.id : null;
    if (optionId) {
      await ctx.db.prepare('UPDATE hol_option SET label = ?1, from_day = ?2, to_day = ?3, position = ?4 WHERE id = ?5')
        .bind(o.label, o.from, o.to, position, optionId).run();
    } else {
      const row = await ctx.db.prepare(
        'INSERT INTO hol_option (round_id, label, from_day, to_day, position) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id',
      ).bind(roundId, o.label, o.from, o.to, position).first();
      optionId = row.id;
    }
    await ctx.db.prepare('DELETE FROM hol_limit WHERE option_id = ?').bind(optionId).run();
    for (const [dept, places] of Object.entries(o.limits)) {
      await ctx.db.prepare('INSERT INTO hol_limit (option_id, department, places) VALUES (?1, ?2, ?3)')
        .bind(optionId, dept, places).run();
    }
  }

  let asked = 0;
  const wasOpen = existing?.status === 'open';
  if (body.open && !wasOpen) {
    await ctx.db.prepare("UPDATE hol_round SET status = 'open', opened_at = datetime('now') WHERE id = ?").bind(roundId).run();
    asked = await askEverybody(ctx.db, await readRound(ctx.db, roundId), ctx, await today(ctx.db), ctx.session.user.name);
  }
  await audit(ctx, existing ? 'holiday.round_changed' : 'holiday.round_made', roundId, { title, opened: Boolean(body.open && !wasOpen) });
  return json({ ok: true, id: roundId, asked, open: Boolean(body.open) || wasOpen });
}

/** Take away a round that is not confirmed yet. */
export async function removeRound(ctx, idParam) {
  const round = await readRound(ctx.db, Number(idParam));
  if (!round) throw notFound('No such holiday choice.');
  if (round.status === 'confirmed') throw badRequest('This one is confirmed and on the rota already.');
  await ctx.db.prepare('DELETE FROM hol_round WHERE id = ?').bind(round.id).run();
  await audit(ctx, 'holiday.round_removed', round.id, { title: round.title });
  return json({ ok: true });
}

/** The office puts somebody on a choice: a move, or an answer for them. */
export async function officePick(ctx, idParam) {
  const round = await readRound(ctx.db, Number(idParam));
  if (!round) throw notFound('No such holiday choice.');
  if (round.status === 'confirmed') throw badRequest('This one is confirmed and on the rota already.');
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Who');
  const person = (await askedPeople(ctx.db)).find((p) => p.id === staffId);
  if (!person) throw badRequest('That person is not asked in this one.');
  const optionId = body.optionId == null ? null : int(body.optionId, 'Choice');
  if (optionId && !round.options.some((o) => o.id === optionId)) throw badRequest('That is not one of the choices.');
  await ctx.db.prepare(
    `INSERT INTO hol_pick (round_id, staff_id, option_id, picked_at, by_office, picked_by)
     VALUES (?1, ?2, ?3, datetime('now'), 1, ?4)
     ON CONFLICT (round_id, staff_id) DO UPDATE SET option_id = ?3, picked_at = datetime('now'), by_office = 1, picked_by = ?4`,
  ).bind(round.id, staffId, optionId, actorOf(ctx)).run();
  await audit(ctx, 'holiday.office_pick', round.id, { staffId, optionId });
  return json({ ok: true });
}

/** Remind everybody who has not answered, now. */
export async function remind(ctx, idParam) {
  const round = await readRound(ctx.db, Number(idParam));
  if (!round || round.status !== 'open') throw badRequest('Only an open holiday choice can be chased.');
  const reminded = await remindWaiting(ctx.db, round, ctx, { today: await today(ctx.db), actor: ctx.session.user.name });
  return json({ ok: true, reminded });
}

/** Confirm: everybody's choice onto the rota, and everybody told. */
export async function confirm(ctx, idParam) {
  const round = await readRound(ctx.db, Number(idParam));
  if (!round) throw notFound('No such holiday choice.');
  if (round.status !== 'open') throw badRequest(round.status === 'confirmed' ? 'This one is confirmed already.' : 'Ask everybody first.');
  const problems = whatStopsIt(round, await askedPeople(ctx.db), await picksFor(ctx.db, round.id));
  if (problems.length) throw badRequest(problems.join(' '));
  const out = await confirmRound(ctx.db, round, { actor: actorOf(ctx), ctx });
  await audit(ctx, 'holiday.round_confirmed', round.id, out);
  return json({ ok: true, ...out });
}

// ---------------------------------------------------------------------------
// A person's own choice
// ---------------------------------------------------------------------------

async function meIn(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) throw forbidden('This login is not linked to a staff record yet.');
  const people = await askedPeople(ctx.db);
  return { staffId, people, person: people.find((p) => p.id === staffId) ?? null };
}

/** The choice open to me now, or the one I last had confirmed. */
export async function mine(ctx) {
  const { staffId, people, person } = await meIn(ctx);
  const now = await today(ctx.db);
  let round = await openRound(ctx.db);
  if (!round) {
    // The last confirmed one, while its days are still to come.
    const row = await ctx.db.prepare(
      `SELECT r.id FROM hol_round r JOIN hol_pick p ON p.round_id = r.id
        WHERE r.status = 'confirmed' AND p.staff_id = ?1 AND p.option_id IS NOT NULL
        ORDER BY r.id DESC LIMIT 1`,
    ).bind(staffId).first().catch(() => null);
    round = row ? await readRound(ctx.db, row.id) : null;
    if (round && !round.options.some((o) => o.to >= now)) round = null;
  }
  if (!round || !person) return json({ round: null, asked: Boolean(person) });

  const picks = await picksFor(ctx.db, round.id);
  const own = picks.get(staffId);
  return json({
    asked: true,
    today: now,
    round: {
      id: round.id, title: round.title, status: round.status, mode: round.mode,
      dueOn: round.dueOn, chargeLeave: round.chargeLeave,
      open: round.status === 'open' && now <= round.dueOn,
    },
    department: person.department,
    choice: own?.option_id ?? null,
    byOffice: Boolean(own?.by_office),
    options: round.options.map((o) => {
      const left = leftFor(o, picks, people, person);
      return { id: o.id, label: o.label, from: o.from, to: o.to, left, full: left === 0 && Number(own?.option_id) !== o.id };
    }),
  });
}

/** Choose, or change my choice, while the round is open. */
export async function choose(ctx) {
  const { staffId, people, person } = await meIn(ctx);
  if (!person) throw badRequest('You are not asked to choose this time.');
  const round = await openRound(ctx.db);
  if (!round) throw badRequest('There is no holiday to choose just now.');
  const now = await today(ctx.db);
  if (now > round.dueOn) throw badRequest('The date to answer has passed. Speak to the office if you need to change it.');
  const body = await readJson(ctx.request);
  const optionId = int(body.optionId, 'Choice');
  const option = round.options.find((o) => o.id === optionId);
  if (!option) throw badRequest('That is not one of the choices.');

  if (round.mode === 'first') {
    const left = leftFor(option, await picksFor(ctx.db, round.id), people, person);
    if (left === 0) throw badRequest(`${option.label} is full in ${person.department}. Choose the other.`);
  }
  await ctx.db.prepare(
    `INSERT INTO hol_pick (round_id, staff_id, option_id, picked_at, by_office, picked_by)
     VALUES (?1, ?2, ?3, datetime('now'), 0, ?4)
     ON CONFLICT (round_id, staff_id) DO UPDATE SET option_id = ?3, picked_at = datetime('now'), by_office = 0, picked_by = ?4`,
  ).bind(round.id, staffId, optionId, actorOf(ctx)).run();
  await audit(ctx, 'holiday.chose', round.id, { optionId });
  return json({ ok: true, choice: optionId });
}
