import { badRequest, forbidden, json, notFound, readJson, str } from '../lib/http.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { loadDataset, scheduleFor } from '../lib/attendance.js';
import { siteOrigin } from '../lib/site.js';
import { todayIn } from '../util/dates.js';
import { DAY_NAMES, daysFor, first, summarise, unanswered, weekDays, windowFor } from '../lib/lunch.js';

/**
 * The weekly lunch list.
 *
 * Two audiences and two shapes. Whoever runs the kitchen opens the app, sets
 * the week's meals and reads the count. Everybody else opens one address on
 * their phone, finds their name and ticks four boxes, and that page is
 * deliberately almost blind: first names, rostered days and meals, and
 * nothing else the register knows about anybody.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

const hashLunchToken = (token, pepper) => hashPin(`lunch:${token}`, pepper);

// "Thursday" rather than "2026-08-20". The screens format dates themselves;
// this is for the one message that goes out as plain text.
const dayName = (day) => DAY_NAMES[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7] ?? day;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function settingsOf(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
  const map = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return {
    timezone: map.timezone || 'UTC',
    property: map.property_name || 'the property',
    on: map.lunch_on === '1',
    tokenHash: map.lunch_token_hash || '',
    openDays: map.lunch_open_days || '4,5,6,7',
  };
}

const put = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2',
).bind(key, value).run();

/**
 * Who is on the rota for each day of a week.
 *
 * Published shifts and the standing pattern, which is the same rule My shifts
 * uses. A day the planner has pencilled in and not published is not a day
 * anybody has been told about, so it is not a day to cook for.
 */
async function rosteredIn(db, week) {
  const ds = await loadDataset(db, { from: week[0], to: week[6] });
  const byStaff = new Map();

  for (const person of ds.staff.filter((s) => s.active)) {
    const days = [];
    for (const day of week) {
      const schedule = scheduleFor(ds, person.id, day);
      const rostered = ds.rosterBy.get(`${person.id}|${day}`);
      const settled = schedule.source === 'pattern'
        || (schedule.source === 'roster' && Boolean(rostered?.published));
      if (settled && schedule.shift) days.push(day);
    }
    byStaff.set(Number(person.id), days);
  }

  return { ds, byStaff };
}

const menuMap = async (db, week) => {
  const rows = await db.prepare(
    `SELECT * FROM lunch_menu WHERE day BETWEEN ?1 AND ?2`,
  ).bind(week[0], week[6]).all().catch(() => ({ results: [] }));
  return new Map((rows.results ?? []).map((r) => [r.day, r]));
};

// ---------------------------------------------------------------------------
// The kitchen's screen
// ---------------------------------------------------------------------------

/**
 * The week: what is being served, who has said yes, and the count.
 *
 * Defaults to the week ordering is pointed at rather than to this one, because
 * the question this screen exists to answer is always about the week ahead.
 */
export async function lunchWeek(ctx) {
  const settings = await settingsOf(ctx.db);
  const today = todayIn(settings.timezone);
  const window = windowFor(today, { openDays: settings.openDays });

  const asked = ctx.url.searchParams.get('week');
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? '') ? asked : window.monday;
  const week = weekDays(monday);

  const [{ ds, byStaff }, menu, orders] = await Promise.all([
    rosteredIn(ctx.db, week),
    menuMap(ctx.db, week),
    ctx.db.prepare('SELECT * FROM lunch_order WHERE day BETWEEN ?1 AND ?2')
      .bind(week[0], week[6]).all().catch(() => ({ results: [] })),
  ]);

  const staff = ds.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }));
  const rows = orders.results ?? [];

  return json({
    today,
    monday,
    week,
    on: settings.on,
    hasLink: Boolean(settings.tokenHash),
    openDays: settings.openDays,
    // The window as it stands, whichever week is being looked at.
    window: { open: window.open, monday: window.monday, opensOn: window.opensOn, closesAfter: window.closesAfter },
    menu: week.map((day) => ({
      day,
      meal: menu.get(day)?.meal ?? null,
      note: menu.get(day)?.note ?? null,
    })),
    summary: summarise({ week, menu, orders: rows, staff }),
    // Who is down to work and has said nothing. The only list worth chasing.
    waiting: unanswered({ week, rosteredBy: byStaff, orders: rows, staff }),
    // How many are rostered each day, so a count of eight out of a possible
    // nine reads differently from eight out of twenty.
    rostered: week.map((day) => ({
      day,
      people: [...byStaff.values()].filter((days) => days.includes(day)).length,
    })),
    property: settings.property,
  });
}

/** Set the meals for a week. One submission for all seven, like every other setup screen. */
export async function setMenu(ctx) {
  const body = await readJson(ctx.request);
  const days = Array.isArray(body.days) ? body.days.slice(0, 14) : [];
  if (!days.length) throw badRequest('Nothing to set.');

  const statements = [];
  for (const entry of days) {
    const day = str(entry.day, 'Day', { required: true, max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('That is not a date.');
    const meal = str(entry.meal, 'Meal', { max: 120, fallback: '' });
    const note = str(entry.note, 'Note', { max: 200, fallback: '' });

    statements.push(meal
      ? ctx.db.prepare(
        `INSERT INTO lunch_menu (day, meal, note, set_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (day) DO UPDATE SET meal = ?2, note = ?3, set_by = ?4, set_at = datetime('now')`,
      ).bind(day, meal, note || null, actorOf(ctx))
      // A day cleared of its meal loses its row rather than keeping an empty
      // one, so "no menu yet" and "no lunch that day" are not the same state
      // wearing the same face.
      : ctx.db.prepare('DELETE FROM lunch_menu WHERE day = ?').bind(day));
  }

  await ctx.db.batch(statements);
  await audit(ctx, 'lunch.menu', days[0]?.day ?? null, { days: days.length });
  return json({ ok: true, days: days.length });
}

/**
 * Put somebody's answer in for them.
 *
 * Whoever runs the kitchen is standing in front of somebody who says "put me
 * down for Tuesday", and telling them to go and find the link is the reason
 * paper lists survive.
 */
export async function setOrder(ctx) {
  const body = await readJson(ctx.request);
  const staffId = Number(body.staffId);
  const day = str(body.day, 'Day', { required: true, max: 10 });
  if (!Number.isInteger(staffId) || staffId < 1) throw badRequest('Who is this for?');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('That is not a date.');

  await answer(ctx.db, staffId, day, body.taking, actorOf(ctx));
  return json({ ok: true });
}

async function answer(db, staffId, day, taking, actor) {
  if (taking === null) {
    await db.prepare('DELETE FROM lunch_order WHERE staff_id = ?1 AND day = ?2')
      .bind(staffId, day).run();
    return;
  }
  await db.prepare(
    `INSERT INTO lunch_order (staff_id, day, taking, at) VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT (staff_id, day) DO UPDATE SET taking = ?3, at = datetime('now')`,
  ).bind(staffId, day, taking ? 1 : 0).run();
  void actor;
}

/**
 * The address the list lives at.
 *
 * Made once and shown once, like every other link in this app: only the
 * fingerprint is kept, so a lost one is replaced rather than recovered. Making
 * a new one retires the old, which is the whole point of being able to.
 */
export async function makeLink(ctx) {
  const token = newToken();
  const pepper = await getPepper(ctx.db);
  const origin = await siteOrigin(ctx.db, ctx.url.origin);

  await put(ctx.db, 'lunch_token_hash', await hashLunchToken(token, pepper));
  await put(ctx.db, 'lunch_on', '1');

  await audit(ctx, 'lunch.link', null, {});
  return json({ ok: true, url: `${origin}/lunch/${token}` });
}

/** Stop taking answers. The link stops opening; nothing already said is lost. */
export async function closeLink(ctx) {
  await put(ctx.db, 'lunch_on', '0');
  await audit(ctx, 'lunch.close', null, {});
  return json({ ok: true });
}

/** Which days of the week the list is open on. */
export async function setOpenDays(ctx) {
  const body = await readJson(ctx.request);
  const days = Array.isArray(body.days) ? body.days : [];
  const clean = days.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  if (!clean.length) throw badRequest('Ordering has to be open on at least one day.');

  await put(ctx.db, 'lunch_open_days', [...new Set(clean)].sort((a, b) => a - b).join(','));
  await audit(ctx, 'lunch.open_days', null, { days: clean });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The page everybody else opens
// ---------------------------------------------------------------------------

/**
 * Everything behind the link, checked before anything is said.
 *
 * The token is compared against a stored hash, so what is in the database is
 * not enough to open the page and what is in somebody's address bar cannot be
 * worked out from a backup.
 */
async function guard(ctx, token) {
  const settings = await settingsOf(ctx.db);
  if (!settings.on || !settings.tokenHash) {
    throw notFound('The lunch list is not open at the moment.');
  }

  const pepper = await getPepper(ctx.db);
  const offered = await hashLunchToken(String(token ?? ''), pepper);
  if (offered !== settings.tokenHash) throw notFound('This link does not open anything.');

  const today = todayIn(settings.timezone);
  return { settings, today, window: windowFor(today, { openDays: settings.openDays }) };
}

/** The names to choose from, and whether the list is taking answers. */
export async function lunchOpen(ctx, token) {
  const { settings, window } = await guard(ctx, token);
  const week = window.days;

  const { byStaff, ds } = await rosteredIn(ctx.db, week);

  // Only people who are actually in that week. A list of forty names to find
  // yourself in, thirty of which cannot order anything, is a list nobody
  // finishes reading.
  const people = ds.staff
    .filter((s) => s.active && (byStaff.get(Number(s.id)) ?? []).length)
    .map((s) => ({ id: s.id, name: s.name, first: first(s.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json({
    property: settings.property,
    open: window.open,
    monday: window.monday,
    week,
    opensOn: window.opensOn,
    closesAfter: window.closesAfter,
    people,
    // Shown whether it is open or not: somebody looking on a Tuesday should
    // still be able to see what is coming.
    menu: [...(await menuMap(ctx.db, week)).values()].map((m) => ({
      day: m.day, meal: m.meal, note: m.note,
    })),
  });
}

/** One person's days, once they have found their name. */
export async function lunchMine(ctx, token, staffParam) {
  const { window } = await guard(ctx, token);
  const week = window.days;
  const staffId = Number(staffParam);
  if (!Number.isInteger(staffId) || staffId < 1) throw badRequest('Who are you?');

  const [{ byStaff, ds }, menu, mine] = await Promise.all([
    rosteredIn(ctx.db, week),
    menuMap(ctx.db, week),
    ctx.db.prepare('SELECT day, taking FROM lunch_order WHERE staff_id = ?1 AND day BETWEEN ?2 AND ?3')
      .bind(staffId, week[0], week[6]).all().catch(() => ({ results: [] })),
  ]);

  const person = ds.staffById.get(staffId);
  if (!person?.active) throw notFound('That name is not on the list.');

  const answers = new Map((mine.results ?? []).map((r) => [r.day, Boolean(r.taking)]));

  return json({
    who: { id: person.id, name: person.name, first: first(person.name) },
    open: window.open,
    monday: window.monday,
    closesAfter: window.closesAfter,
    days: daysFor({ week, rostered: byStaff.get(staffId) ?? [], menu, answers }),
  });
}

/**
 * Somebody's answers for the week.
 *
 * All of them at once, because the page is a list of four boxes and a button
 * rather than four separate saves, and because a half-saved week is worse
 * than an unsaved one.
 */
export async function lunchSay(ctx, token, staffParam) {
  const { window } = await guard(ctx, token);
  if (!window.open) {
    throw forbidden(window.opensOn
      ? `The list is shut. It opens again on ${dayName(window.opensOn)}.`
      : 'The list is shut.');
  }

  const staffId = Number(staffParam);
  if (!Number.isInteger(staffId) || staffId < 1) throw badRequest('Who are you?');

  const body = await readJson(ctx.request);
  const said = Array.isArray(body.days) ? body.days.slice(0, 7) : [];

  const week = window.days;
  const { byStaff, ds } = await rosteredIn(ctx.db, week);
  const person = ds.staffById.get(staffId);
  if (!person?.active) throw notFound('That name is not on the list.');

  // Only days they are actually down to work. Anything else is somebody
  // answering for a day the kitchen would then cook for.
  const allowed = new Set(byStaff.get(staffId) ?? []);
  const statements = [];
  for (const entry of said) {
    const day = String(entry.day ?? '');
    if (!allowed.has(day)) continue;
    statements.push(ctx.db.prepare(
      `INSERT INTO lunch_order (staff_id, day, taking, at) VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT (staff_id, day) DO UPDATE SET taking = ?3, at = datetime('now')`,
    ).bind(staffId, day, entry.taking ? 1 : 0));
  }

  if (statements.length) await ctx.db.batch(statements);
  return json({ ok: true, saved: statements.length });
}
