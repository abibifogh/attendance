import { badRequest, forbidden, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { loadDataset, scheduleFor } from '../lib/attendance.js';
import { siteOrigin } from '../lib/site.js';
import { dow, nowIn, startOfWeek, todayIn } from '../util/dates.js';
import {
  DAY_NAMES, NOTICE_HOURS, daysFor, first, menuWeek, readTime, saidNo, scheduleFrom, showTime,
  summarise, tooLateFor, unanswered, weekDays, windowFor,
} from '../lib/lunch.js';

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

/** Which day of the week a date is, 1 for Monday through 7 for Sunday. */
const dayOfWeek = (day) => dow(day) + 1;

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
    schedule: scheduleFrom(map),
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

/**
 * The standing week, keyed by which day of the week it is.
 *
 * Not by date. The kitchen decides once that Monday is jollof, and that is
 * true of every Monday until somebody says otherwise.
 */
const menuMap = async (db) => {
  const rows = await db.prepare('SELECT * FROM lunch_menu_week').all()
    .catch(() => ({ results: [] }));
  return new Map((rows.results ?? []).map((r) => [Number(r.dow), r]));
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
  const window = windowFor(nowIn(settings.timezone), settings.schedule);

  // THE WEEK WE ARE IN, NOT THE ONE BEING ORDERED. It used to open on the week
  // ordering points at, which is the right answer to "what am I buying" and
  // the wrong one to every other question this screen gets asked. Most of what
  // anybody opens it for is today: how many are eating at noon, who is on the
  // list, whether somebody was put down. Opening on a week that has not begun
  // meant the count on the screen was never the count in the kitchen, and the
  // way back to now was a button nobody pressed because nothing said they were
  // anywhere else. The week being ordered is a press away and says so.
  const asked = ctx.url.searchParams.get('week');
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? '') ? asked : startOfWeek(today);
  const week = weekDays(monday);

  const [{ ds, byStaff }, menu, orders, asking] = await Promise.all([
    rosteredIn(ctx.db, week),
    menuMap(ctx.db),
    ctx.db.prepare('SELECT * FROM lunch_order WHERE day BETWEEN ?1 AND ?2')
      .bind(week[0], week[6]).all().catch(() => ({ results: [] })),
    // What is waiting on the kitchen. Asked for after the list shut, so the
    // count has already been read and somebody has to decide.
    ctx.db.prepare(
      `SELECT c.id, c.staff_id, c.day, c.want, c.note, c.asked_at, s.name
         FROM lunch_change c JOIN att_staff s ON s.id = c.staff_id
        WHERE c.decision = 'waiting' AND c.day BETWEEN ?1 AND ?2
        ORDER BY c.day, c.id`,
    ).bind(week[0], week[6]).all().catch(() => ({ results: [] })),
  ]);

  const staff = ds.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }));
  // Everybody the register has ever had, for reading an order back. An order
  // is a fact and a plate is a plate: somebody who ordered on the Monday and
  // was made a leaver on the Tuesday is still eating on the Wednesday, and
  // naming them off the active list alone quietly took their plates off the
  // count. Chasing is a different question and still only asks the active.
  const everybody = ds.staff.map((s) => ({ id: s.id, name: s.name }));
  const rows = orders.results ?? [];

  return json({
    today,
    monday,
    week,
    on: settings.on,
    hasLink: Boolean(settings.tokenHash),
    // The window as it stands, whichever week is being looked at. `on` is the
    // master switch and beats the clock; the schedule is what the clock runs
    // off when it is on.
    window: {
      open: settings.on && window.open,
      monday: window.monday,
      opensOn: window.opensOn,
      closesOn: window.closesOn,
      closesAfter: window.closesAfter,
    },
    schedule: {
      opensDow: settings.schedule.opensDow,
      opensAt: showTime(settings.schedule.opensAt),
      closesDow: settings.schedule.closesDow,
      closesAt: showTime(settings.schedule.closesAt),
    },
    // The standing week, and what it lands on for the week being looked at.
    menu: menuWeek([...menu.values()]),
    onTheDay: week.map((day) => ({
      day,
      meal: menu.get(dayOfWeek(day))?.meal ?? null,
      note: menu.get(dayOfWeek(day))?.note ?? null,
    })),
    summary: summarise({ week, menu, orders: rows, staff: everybody }),
    // Who is down to work and has said nothing. The only list worth chasing.
    waiting: unanswered({ week, rosteredBy: byStaff, orders: rows, staff }),
    // And who answered no. Not a list to chase, a list to check: without it
    // an answer of "no" is indistinguishable from never having answered, and
    // somebody who filled the form in appears nowhere on the page.
    declined: saidNo({ week, orders: rows, staff: everybody }),
    // Changes asked for after the list shut, waiting on somebody here. The one
    // list on this screen that is a decision rather than a reading.
    changes: (asking.results ?? []).map((c) => ({
      id: c.id,
      staffId: c.staff_id,
      name: c.name,
      day: c.day,
      want: Boolean(c.want),
      note: c.note ?? null,
      askedAt: c.asked_at,
    })),
    // Everybody, so the kitchen can put down a person the rota does not have
    // in this week at all.
    staff,
    rosteredBy: Object.fromEntries([...byStaff].map(([id, days]) => [
      String(id), days.filter((day) => week.includes(day)),
    ])),
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
  const days = Array.isArray(body.days) ? body.days.slice(0, 7) : [];
  if (!days.length) throw badRequest('Nothing to set.');

  const statements = [];
  for (const entry of days) {
    const dow = Number(entry.dow);
    if (!Number.isInteger(dow) || dow < 1 || dow > 7) throw badRequest('That is not a day.');
    const meal = str(entry.meal, 'Meal', { max: 120, fallback: '' });
    const note = str(entry.note, 'Note', { max: 200, fallback: '' });

    statements.push(meal
      ? ctx.db.prepare(
        `INSERT INTO lunch_menu_week (dow, meal, note, set_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (dow) DO UPDATE SET meal = ?2, note = ?3, set_by = ?4, set_at = datetime('now')`,
      ).bind(dow, meal, note || null, actorOf(ctx))
      // A day cleared of its meal loses its row rather than keeping an empty
      // one, so "no menu yet" and "no lunch that day" are not the same state
      // wearing the same face.
      : ctx.db.prepare('DELETE FROM lunch_menu_week WHERE dow = ?').bind(dow));
  }

  await ctx.db.batch(statements);
  await audit(ctx, 'lunch.menu', null, { days: days.length });
  return json({ ok: true, days: days.length });
}

/**
 * Put somebody's answer in for them.
 *
 * Whoever runs the kitchen is standing in front of somebody who says "put me
 * down for Tuesday", and telling them to go and find the link is the reason
 * paper lists survive.
 *
 * NOT ONLY PEOPLE ON THE ROTA. The link asks staff about the days they are
 * working, because asking anybody about a day they are at home invites an
 * answer the kitchen then cooks for. That is the right rule for a form
 * somebody fills in on their own. It is the wrong rule here: a manager coming
 * in on their day off, somebody covering at the last minute, a person on leave
 * who is in for a meeting. Whoever runs the kitchen can put anybody down for
 * any day of the week, and is trusted to know why.
 */
export async function setOrder(ctx) {
  const body = await readJson(ctx.request);
  const staffId = Number(body.staffId);
  if (!Number.isInteger(staffId) || staffId < 1) throw badRequest('Who is this for?');

  const asked = Array.isArray(body.days) && body.days.length
    ? body.days
    : [{ day: body.day, taking: body.taking }];

  const person = await ctx.db.prepare('SELECT id, name, active FROM att_staff WHERE id = ?')
    .bind(staffId).first();
  if (!person?.active) throw notFound('Nobody here by that name.');

  let saved = 0;
  for (const entry of asked.slice(0, 7)) {
    const day = str(entry.day, 'Day', { required: true, max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('That is not a date.');
    await answer(ctx.db, staffId, day, entry.taking, actorOf(ctx));
    saved += 1;
  }

  await audit(ctx, 'lunch.order', staffId, { name: person.name, days: saved });
  return json({ ok: true, saved, name: person.name });
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
 * ONE LINK, AND IT DOES NOT CHANGE. It goes on the noticeboard once and stays
 * there. Whether the list is taking answers is a different question, answered
 * by the clock and by the switch below, and neither of them touches this.
 *
 * Made once and shown once, like every other link in this app: only the
 * fingerprint is kept, so a lost one is replaced rather than recovered. Making
 * a new one retires the old, which is why it asks first.
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

/**
 * The master switch.
 *
 * Off and the list is shut whatever the clock says, and the link says so
 * rather than failing. On and the window below decides. Turning it off and on
 * again does not touch the address, which is the whole point: closing the list
 * used to mean making a new link, and a new link means a new notice on the
 * board every week.
 */
export async function setOpen(ctx) {
  const body = await readJson(ctx.request);
  const on = body.on !== false;
  await put(ctx.db, 'lunch_on', on ? '1' : '0');
  await audit(ctx, on ? 'lunch.open' : 'lunch.close', null, {});
  return json({ ok: true, on });
}

/**
 * When the list opens and shuts, week after week.
 *
 * Two moments, each a day and a time. Times because "open on Thursday" leaves
 * the kitchen and everybody else disagreeing about Thursday evening, and the
 * disagreement only shows up as a plate too few.
 */
export async function setSchedule(ctx) {
  const body = await readJson(ctx.request);

  const day = (value, what) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 7) throw badRequest(`${what} has to be a day.`);
    return n;
  };
  const time = (value, what) => {
    const t = readTime(value);
    if (t == null) throw badRequest(`${what} has to be a time, like 09:00.`);
    return t;
  };

  const opensDow = day(body.opensDow, 'The day it opens');
  const opensAt = time(body.opensAt, 'The time it opens');
  const closesDow = day(body.closesDow, 'The day it shuts');
  const closesAt = time(body.closesAt, 'The time it shuts');

  if (opensDow === closesDow && opensAt === closesAt) {
    throw badRequest('It cannot open and shut at the same moment. Give it some time in between.');
  }

  await put(ctx.db, 'lunch_opens_dow', String(opensDow));
  await put(ctx.db, 'lunch_opens_at', showTime(opensAt));
  await put(ctx.db, 'lunch_closes_dow', String(closesDow));
  await put(ctx.db, 'lunch_closes_at', showTime(closesAt));

  await audit(ctx, 'lunch.schedule', null, {
    opensDow, opensAt: showTime(opensAt), closesDow, closesAt: showTime(closesAt),
  });
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
  if (!settings.tokenHash) throw notFound('There is no lunch list at the moment.');

  const pepper = await getPepper(ctx.db);
  const offered = await hashLunchToken(String(token ?? ''), pepper);
  if (offered !== settings.tokenHash) throw notFound('This link does not open anything.');

  const today = todayIn(settings.timezone);
  const window = windowFor(nowIn(settings.timezone), settings.schedule);

  // The address always opens. Whether it is taking answers is the clock's
  // business and the switch's, and a page that says "it opens on Thursday at
  // nine" is worth a hundred that say nothing at all.
  return {
    settings,
    today,
    window: { ...window, open: settings.on && window.open },
  };
}

/** The names to choose from, and whether the list is taking answers. */
export async function lunchOpen(ctx, token) {
  const { settings, window } = await guard(ctx, token);
  const week = window.days;

  const [{ byStaff, ds }, menu] = await Promise.all([
    rosteredIn(ctx.db, week),
    menuMap(ctx.db),
  ]);

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
    // Off at the switch is a different thing from too early, and somebody
    // standing in a corridor deserves to be told which.
    off: !settings.on,
    monday: window.monday,
    week,
    opensOn: window.opensOn,
    closesOn: window.closesOn,
    closesAfter: window.closesAfter,
    people,
    // Shown whether it is open or not: somebody looking on a Tuesday should
    // still be able to see what is coming. Against the dates of the week
    // being ordered, because that is the week they are looking at.
    menu: week.map((day) => ({
      day,
      meal: menu.get(dayOfWeek(day))?.meal ?? null,
      note: menu.get(dayOfWeek(day))?.note ?? null,
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
    menuMap(ctx.db),
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
    closesOn: window.closesOn,
    closesAfter: window.closesAfter,
    opensOn: window.opensOn,
    // Days the kitchen has already put them down for, over and above the rota.
    // A manager coming in on a day off is on this page even though the roster
    // says they are at home, because somebody has already ordered for them.
    days: daysFor({
      week,
      rostered: [...new Set([...(byStaff.get(staffId) ?? []), ...answers.keys()])],
      menu,
      answers,
    }),
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
      ? `The list is shut. It opens again on ${dayName(window.opensOn.slice(0, 10))} `
        + `at ${window.opensOn.slice(11)}.`
      : 'The list is shut.');
  }

  const staffId = Number(staffParam);
  if (!Number.isInteger(staffId) || staffId < 1) throw badRequest('Who are you?');

  const body = await readJson(ctx.request);
  const said = Array.isArray(body.days) ? body.days.slice(0, 7) : [];

  const week = window.days;
  const [{ byStaff, ds }, already] = await Promise.all([
    rosteredIn(ctx.db, week),
    ctx.db.prepare('SELECT day FROM lunch_order WHERE staff_id = ?1 AND day BETWEEN ?2 AND ?3')
      .bind(staffId, week[0], week[6]).all().catch(() => ({ results: [] })),
  ]);
  const person = ds.staffById.get(staffId);
  if (!person?.active) throw notFound('That name is not on the list.');

  // Days they are down to work, and any day the kitchen has already put them
  // down for. Anything else is somebody answering for a day nobody expects
  // them, which the kitchen would then cook for.
  const allowed = new Set([
    ...(byStaff.get(staffId) ?? []),
    ...(already.results ?? []).map((r) => r.day),
  ]);
  const statements = [];
  for (const entry of said) {
    const day = String(entry.day ?? '');
    if (!allowed.has(day)) continue;
    statements.push(ctx.db.prepare(
      `INSERT INTO lunch_order (staff_id, day, taking, at) VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT (staff_id, day) DO UPDATE SET taking = ?3, at = datetime('now')`,
    ).bind(staffId, day, entry.taking ? 1 : 0));
  }

  // SAVING NOTHING IS NOT SAVING. Every day sent can be dropped by the check
  // above, and this used to answer that with ok and a count of nought, on
  // which the page thanked them and closed. Somebody who answered on a phone
  // that had the page open from before the rota changed under them went away
  // certain they had ordered, and appeared on nothing the kitchen reads: no
  // order to count, and nothing to chase, because they are no longer down to
  // work the days they answered for. Told plainly instead, while they are
  // still standing there and can do something about it.
  if (said.length && !statements.length) {
    throw badRequest(
      'None of those days could be saved: the rota for this week has changed since this page '
      + 'was opened, and you are not down to work the days it is showing. Open the link again '
      + 'to see the week as it stands, and tell whoever runs the kitchen if it still looks wrong.',
    );
  }

  if (statements.length) await ctx.db.batch(statements);
  return json({ ok: true, saved: statements.length });
}

// ---------------------------------------------------------------------------
// A member of staff's own lunch
// ---------------------------------------------------------------------------

/**
 * The person this login is, for the lunch screens.
 *
 * The same reckoning every other "my" screen uses. Kept here rather than
 * imported so this file still answers the public link without reaching into
 * the signed-in half of the app.
 */
async function meOf(ctx) {
  const staffId = Number(ctx.session?.user?.staff_id) || 0;
  if (!staffId) {
    throw forbidden(
      'This login is not linked to a staff record yet, so there is nothing of yours to show. '
      + 'Ask whoever set it up to point it at you under Users.',
    );
  }
  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff?.active) throw notFound('The staff record this login points at is gone.');
  return staff;
}

/** Their own open and answered requests for a week. */
async function changesFor(db, staffId, week) {
  const rows = await db.prepare(
    `SELECT * FROM lunch_change
      WHERE staff_id = ?1 AND day BETWEEN ?2 AND ?3 AND decision <> 'withdrawn'
      ORDER BY day, id`,
  ).bind(staffId, week[0], week[6]).all().catch(() => ({ results: [] }));
  return rows.results ?? [];
}

/**
 * What I am down for, and what I can do about it.
 *
 * THE ANSWER USED TO LIVE NOWHERE THEY COULD SEE IT. The whole lunch list
 * happened on one address outside the app: find your name, tick the boxes, and
 * that was the last anybody saw of their own answer. Once the window shut
 * there was no screen that would tell them what they had said, so "am I down
 * for Thursday?" was a question you asked a person.
 *
 * TWO STATES, AND THE SCREEN SAYS WHICH. While the list is open, changing
 * their mind is changing their mind: nothing has been ordered and a queue for
 * a number nobody has read yet would be ceremony. Once it is shut the order
 * has gone to the kitchen, so a change is asked for and waits.
 */
export async function myLunch(ctx) {
  const staff = await meOf(ctx);
  const settings = await settingsOf(ctx.db);
  const window = windowFor(nowIn(settings.timezone), settings.schedule);

  // The week they are in, for the same reason the kitchen's screen opens on it:
  // "am I down for lunch today" is the question, and an answer about a week
  // that has not started is not an answer to it.
  const asked = ctx.url.searchParams.get('week');
  const today = todayIn(settings.timezone);
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? '') ? asked : startOfWeek(today);
  const week = weekDays(monday);
  const thisIsTheWeek = monday === window.monday;

  const [{ byStaff }, menu, orders, changes] = await Promise.all([
    rosteredIn(ctx.db, week),
    menuMap(ctx.db),
    ctx.db.prepare('SELECT day, taking FROM lunch_order WHERE staff_id = ?1 AND day BETWEEN ?2 AND ?3')
      .bind(staff.id, week[0], week[6]).all().catch(() => ({ results: [] })),
    changesFor(ctx.db, staff.id, week),
  ]);

  const answers = new Map((orders.results ?? []).map((r) => [r.day, Boolean(r.taking)]));
  const waitingOn = new Map(changes.filter((c) => c.decision === 'waiting').map((c) => [c.day, c]));

  // Days they are down to work, and any day the kitchen has already put them
  // down for over and above the rota, which is the same rule the link uses.
  const mine = [...new Set([...(byStaff.get(Number(staff.id)) ?? []), ...answers.keys()])];

  return json({
    who: { id: staff.id, name: staff.name, first: first(staff.name) },
    monday,
    week,
    today,
    on: settings.on,
    // Open means they change it themselves. Shut means they ask.
    open: settings.on && window.open && thisIsTheWeek,
    // Whether it is taking answers at all, which is a different question from
    // whether it is taking them for the week on screen. Standing on this week
    // while the list is open for next week is the ordinary case now that the
    // screen opens on the week we are in, and "it opens again on Thursday" is
    // the wrong thing to say to somebody when it is open at that moment.
    windowOpen: settings.on && window.open,
    orderingFor: window.monday,
    opensOn: window.opensOn,
    closesOn: window.closesOn,
    closesAfter: window.closesAfter,
    noticeHours: NOTICE_HOURS,
    days: week.map((day) => {
      const pending = waitingOn.get(day) ?? null;
      return {
        day,
        name: DAY_NAMES[dow(day)],
        meal: menu.get(dayOfWeek(day))?.meal ?? null,
        note: menu.get(dayOfWeek(day))?.note ?? null,
        rostered: mine.includes(day),
        // Null is "you have not said", which is not the same as no.
        taking: answers.has(day) ? answers.get(day) : null,
        asking: pending
          ? { id: pending.id, want: Boolean(pending.want), note: pending.note ?? null }
          : null,
        // Whether there is still time to ask about it. Worked out here rather
        // than on the screen so the button and the route agree: a button the
        // server would refuse is worse than no button.
        tooLate: tooLateFor(day, nowIn(settings.timezone)),
      };
    }),
    // Everything answered, so the record of a refusal is theirs to read rather
    // than something they are told once in a notification and never again.
    answered: changes
      .filter((c) => c.decision !== 'waiting')
      .map((c) => ({
        id: c.id,
        day: c.day,
        want: Boolean(c.want),
        decision: c.decision,
        decidedBy: c.decided_by,
        decidedAt: c.decided_at,
        decisionNote: c.decision_note ?? null,
      })),
  });
}

/**
 * Change it, or ask for it to be changed.
 *
 * One route for both, because from where the person is standing it is one
 * action: they want Thursday changed. Which of the two it turns into is the
 * clock's business, not theirs, and the reply says which happened so the
 * screen never has to guess.
 */
export async function askLunchChange(ctx) {
  const staff = await meOf(ctx);
  const settings = await settingsOf(ctx.db);
  if (!settings.on) throw badRequest('The lunch list is switched off.');

  const window = windowFor(nowIn(settings.timezone), settings.schedule);
  const body = await readJson(ctx.request);

  const day = str(body.day, 'Day', { required: true, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('That is not a date.');
  const want = body.want === true || body.want === 1 || body.want === '1';
  const note = str(body.note, 'Note', { max: 200 });

  // THE WEEK THE DAY BELONGS TO. weekDays counts seven days forward from
  // whatever it is handed, so passing the day itself made the "week" start on
  // that day. Harmless for reading the rota, and wrong for the comparison
  // below: it asked whether the day WAS the ordering Monday rather than
  // whether it was in the ordering week, so with the list wide open a
  // Wednesday went into the approval queue and only a Monday changed outright.
  const week = weekDays(startOfWeek(day));
  const [{ byStaff }, held] = await Promise.all([
    rosteredIn(ctx.db, week),
    ctx.db.prepare('SELECT taking FROM lunch_order WHERE staff_id = ?1 AND day = ?2')
      .bind(staff.id, day).first().catch(() => null),
  ]);

  // A day they are down to work, or one the kitchen has already put them down
  // for. Anything else is asking about a day nobody expects them, which is the
  // same line the link draws and for the same reason.
  const allowed = new Set([...(byStaff.get(Number(staff.id)) ?? [])]);
  if (held) allowed.add(day);
  if (!allowed.has(day)) {
    throw badRequest(
      'You are not down to work that day, so there is no lunch on it to change. If you are '
      + 'coming in anyway, ask whoever runs the kitchen to put you down.',
    );
  }

  if (held && Boolean(held.taking) === want) {
    throw badRequest(want
      ? 'You are already down for lunch that day.'
      : 'You are already down as not eating that day.');
  }

  // WHILE THE LIST IS OPEN, CHANGING IT IS CHANGING IT. Nothing has been
  // ordered, nobody has read the number, and putting a member of staff in a
  // queue to change an answer they could change on the link a minute ago
  // would be the app inventing an approval for its own sake.
  if (window.open && week[0] === window.monday) {
    await answer(ctx.db, staff.id, day, want, `${staff.name} (staff)`);
    return json({ ok: true, changed: true, day, taking: want });
  }

  // A DAY TOO CLOSE TO ASK ABOUT. The food is bought and prepared ahead of the
  // meal, so a request landing on the morning of the day is not a request, it
  // is news. Refused rather than queued: answering "the kitchen will tell you"
  // about a Thursday already being cooked teaches people that asking works
  // when it cannot, and the first they hear otherwise is at noon.
  if (tooLateFor(day, nowIn(settings.timezone))) {
    throw badRequest(
      `${dayName(day)} is too close to change. Lunch is bought and prepared ahead of the day, `
      + `so changes are asked for at least ${NOTICE_HOURS} hours before it. Find whoever runs `
      + 'the kitchen and ask them in person.',
    );
  }

  // Shut. The order has gone to the kitchen, so it is asked for and waits.
  // Asking twice about the same day is changing your mind about the day, not a
  // second thing for the kitchen to answer.
  await ctx.db.prepare(
    `UPDATE lunch_change SET decision = 'withdrawn', decided_at = datetime('now')
      WHERE staff_id = ?1 AND day = ?2 AND decision = 'waiting'`,
  ).bind(staff.id, day).run();

  await ctx.db.prepare(
    'INSERT INTO lunch_change (staff_id, day, want, note) VALUES (?1, ?2, ?3, ?4)',
  ).bind(staff.id, day, want ? 1 : 0, note).run();

  await createNotice(ctx.db, {
    kind: 'lunch.change_asked',
    level: 'info',
    title: `${staff.name} wants ${want ? 'lunch on' : 'to come off'} ${dayName(day)}`,
    body: `${dayName(day)} ${day}. ${want ? 'Asking to be put down.' : 'Asking to be taken off.'}`
      + `${note ? ` "${note}"` : ''} The list was shut when they asked, so it is waiting for you.`,
    link: '#/att-lunch',
    actor: `${staff.name} (staff)`,
    audience: 'lunch',
  }, ctx);

  return json({ ok: true, changed: false, asked: true, day, want });
}

/** Taking it back, while nobody has answered it. */
export async function withdrawLunchChange(ctx, id) {
  const staff = await meOf(ctx);
  const row = await ctx.db.prepare(
    "SELECT * FROM lunch_change WHERE id = ? AND staff_id = ? AND decision = 'waiting'",
  ).bind(Number(id), staff.id).first();
  if (!row) throw notFound('There is nothing of yours waiting on that.');

  await ctx.db.prepare(
    "UPDATE lunch_change SET decision = 'withdrawn', decided_at = datetime('now') WHERE id = ?",
  ).bind(row.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// And the kitchen's answer
// ---------------------------------------------------------------------------

/**
 * Yes or no to a change, and yes writes the order.
 *
 * The decision and the plate are one action on purpose. An approval that left
 * somebody to remember to tick the box afterwards is an approval that gets
 * lost between the screen and the kitchen, which is the failure this whole
 * queue exists to stop.
 */
export async function decideLunchChange(ctx, id) {
  const body = await readJson(ctx.request);
  const decision = body.decision === 'approved' ? 'approved'
    : body.decision === 'declined' ? 'declined' : null;
  if (!decision) throw badRequest('Say approved or declined.');

  const row = await ctx.db.prepare(
    `SELECT c.*, s.name AS staff_name
       FROM lunch_change c JOIN att_staff s ON s.id = c.staff_id
      WHERE c.id = ? AND c.decision = 'waiting'`,
  ).bind(Number(id)).first();
  if (!row) throw notFound('There is nothing waiting on that.');

  // The login this record hangs on, which is how the answer reaches the person
  // who asked rather than the noticeboard.
  const theirLogin = await ctx.db.prepare(
    'SELECT id FROM users WHERE staff_id = ? AND active = 1 LIMIT 1',
  ).bind(row.staff_id).first().catch(() => null);

  const note = str(body.note, 'Note', { max: 300 });
  const actor = actorOf(ctx);

  await ctx.db.prepare(
    `UPDATE lunch_change
        SET decision = ?2, decided_by = ?3, decided_at = datetime('now'), decision_note = ?4
      WHERE id = ?1`,
  ).bind(row.id, decision, actor, note).run();

  if (decision === 'approved') {
    await answer(ctx.db, row.staff_id, row.day, Boolean(row.want), actor);
  }

  await audit(ctx, 'lunch.change_decide', row.id, {
    name: row.staff_name, day: row.day, want: Boolean(row.want), decision,
  });

  await createNotice(ctx.db, {
    kind: 'lunch.change_decided',
    level: decision === 'approved' ? 'good' : 'warn',
    title: decision === 'approved'
      ? `Your lunch for ${dayName(row.day)} was changed`
      : `Your lunch change for ${dayName(row.day)} was not agreed`,
    body: decision === 'approved'
      ? `You are now down as ${row.want ? 'eating' : 'not eating'} on ${dayName(row.day)}.`
        + `${note ? ` ${note}` : ''}`
      : `${note || 'No reason was given.'} Speak to whoever runs the kitchen if it matters.`,
    link: '#/att-my-lunch',
    actor,
    // Theirs alone. Nobody else has any business being told what somebody is
    // eating on Thursday.
    audience: null,
    userId: theirLogin?.id ?? null,
    email: false,
  }, ctx);

  return json({ ok: true, decision, day: row.day });
}
