import { badRequest, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { WORDING, ageOn, birthdaysOn, greeting, monthDay, prompt, upcoming } from '../lib/birthdays.js';
import { todayIn } from '../util/dates.js';

/**
 * Whose birthday it is, who has been told, and the card.
 *
 * Read by the morning screen and written by the daily tick. Everything about
 * what a birthday *is* lives in the library beside this; what is here is who
 * gets told and what stops them being told twice.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const on = (value, fallback = true) => (value == null || value === ''
  ? fallback
  : !(value === '0' || value === 'false'));

/**
 * How this property words it, and whether it says anything at all.
 *
 * Read on every send rather than cached. It is a handful of rows once a day,
 * and a wish that goes out in wording somebody changed last week and cannot
 * see the effect of is worse than a query.
 */
export async function wording(db) {
  const rows = await db.prepare(
    `SELECT key, value FROM settings
      WHERE key IN ('att_bd_wish', 'att_bd_title', 'att_bd_line', 'att_bd_push',
                    'att_bd_prompt', 'att_bd_prompt_body', 'att_bd_ahead',
                    'property_name', 'timezone')`,
  ).all().catch(() => ({ results: [] }));
  const s = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));

  return {
    wish: on(s.att_bd_wish),
    title: s.att_bd_title || WORDING.title,
    line: s.att_bd_line || WORDING.line,
    push: on(s.att_bd_push),
    prompt: on(s.att_bd_prompt),
    promptBody: s.att_bd_prompt_body || WORDING.prompt,
    ahead: Math.min(365, Math.max(0, Number(s.att_bd_ahead ?? 30) || 0)),
    property: s.property_name || null,
    timezone: s.timezone || 'UTC',
  };
}

/** Everybody on the books with a date of birth against them. */
async function peopleWithBirthdays(db) {
  const rows = await db.prepare(
    `SELECT s.id, s.name, s.department, s.employee_no, p.date_of_birth, p.preferred_name,
            u.id AS user_id
       FROM att_staff s
       JOIN hr_profile p ON p.staff_id = s.id
       LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
      WHERE s.active = 1 AND p.date_of_birth IS NOT NULL`,
  ).all().catch(() => ({ results: [] }));
  return rows.results ?? [];
}

/**
 * Today's birthdays, and the ones coming up.
 *
 * Both, because a card is often made the day before. The month ahead is a
 * short list on this property and it is the difference between remembering a
 * birthday and remembering it on the day it has already passed.
 */
export async function birthdays(ctx) {
  const set = await wording(ctx.db);
  const today = todayIn(set.timezone);

  const people = await peopleWithBirthdays(ctx.db);
  const property = set.property;

  const sentRows = await ctx.db.prepare(
    "SELECT staff_id FROM att_nudge WHERE day = ?1 AND kind = 'birthday_card'",
  ).bind(today).all().catch(() => ({ results: [] }));
  const sent = new Set((sentRows.results ?? []).map((r) => Number(r.staff_id)));

  const shape = (person) => ({
    id: person.id,
    name: person.name,
    preferred: person.preferred_name || null,
    department: person.department || null,
    // The age is worked out and deliberately not put on a card. It is here
    // because whoever is signing one may want to know, and nowhere else.
    age: ageOn(person.date_of_birth, today),
    hasLogin: Boolean(person.user_id),
    cardSent: sent.has(Number(person.id)),
  });

  return json({
    today,
    property,
    todays: birthdaysOn(people, today).map(shape),
    soon: upcoming(people, today, set.ahead)
      .filter((p) => p.inDays > 0)
      .slice(0, 8)
      .map((p) => ({ ...shape(p), inDays: p.inDays })),
    // The card's opening line, so the screen offers what the setup screen says
    // rather than a second wording nobody knows is there.
    wording: greeting('{name}', { property, title: set.title, line: set.line }),
    // Said plainly, because a screen that shows two birthdays out of
    // twenty-four people should say why it is not showing the other
    // twenty-two rather than let somebody assume nobody else has one.
    withDates: people.length,
  });
}

/**
 * Send the card.
 *
 * Two audiences and two messages. The person gets the warm one, addressed to
 * them; everybody else gets told it is their birthday, which is the whole
 * point of a card going round an office. Whoever presses it can add a line.
 *
 * Once per person per day. A card sent four times is not four times the
 * kindness.
 */
export async function sendBirthdayCard(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Who', { required: true, min: 1 });
  const message = str(body.message, 'Message', { max: 300 });
  const tellEverybody = body.everybody !== false;

  const set = await wording(ctx.db);
  const today = todayIn(set.timezone);

  const person = await ctx.db.prepare(
    `SELECT s.id, s.name, p.preferred_name, p.date_of_birth, u.id AS user_id
       FROM att_staff s
       LEFT JOIN hr_profile p ON p.staff_id = s.id
       LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
      WHERE s.id = ? AND s.active = 1`,
  ).bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const claimed = await ctx.db.prepare(
    "INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, 'birthday_card')",
  ).bind(staffId, today).run().catch(() => null);
  if (!Number(claimed?.meta?.changes ?? 0)) {
    throw badRequest('A card has already gone out for them today.');
  }

  const property = set.property;
  const wish = greeting(person.preferred_name || person.name,
    { property, title: set.title, line: set.line });

  // To them, if they have a way of being reached.
  if (person.user_id) {
    await createNotice(ctx.db, {
      kind: 'birthday.wish',
      level: 'info',
      title: wish.title,
      body: message || wish.line,
      link: '#/att-me',
      day: today,
      actor: property || 'HIVE',
      userId: person.user_id,
      push: set.push,
      email: false,
    }, ctx);
  }

  // And round the rest of the place, which is what a card is for.
  if (tellEverybody) {
    await createNotice(ctx.db, {
      kind: 'birthday.today',
      level: 'info',
      title: `It is ${person.preferred_name || person.name.split(' ')[0]}'s birthday`,
      body: message || 'Say something if you see them.',
      link: '#/att-today',
      day: today,
      actor: actorOf(ctx),
      // Everybody, which is the one notice on the whole system that genuinely
      // means everybody.
      audience: null,
      push: true,
      email: false,
    }, ctx);
  }

  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
  ).bind(
    actorOf(ctx), 'birthday.card', String(staffId),
    JSON.stringify({ day: today, everybody: tellEverybody, told: Boolean(person.user_id) }),
  ).run().catch(() => {});

  return json({
    ok: true,
    name: person.name,
    told: Boolean(person.user_id),
    everybody: tellEverybody,
  });
}

/**
 * The daily wish, from the cron.
 *
 * Sends the person their own message and prompts whoever runs the floor. It
 * does not send the card: a card is somebody choosing to send one, and an app
 * that sends it automatically has taken the gesture rather than prompted it.
 */
export async function wishThem(db, { timezone = 'UTC', ctx = null } = {}) {
  const set = await wording(db);
  const today = todayIn(set.timezone || timezone);
  const people = await peopleWithBirthdays(db);
  const whose = birthdaysOn(people, today);
  if (!whose.length) return { wished: 0 };

  // Turned off means turned off, for both messages. A property that would
  // rather a person said it has a right to an app that stays quiet, and one
  // that says nothing but still rings the manager's bell has not been turned
  // off, it has been half turned off.
  if (!set.wish && !set.prompt) return { wished: 0, day: today, off: true };

  let wished = 0;
  for (const person of whose) {
    const claimed = await db.prepare(
      'INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, ?3)',
    ).bind(person.id, today, 'birthday').run().catch(() => null);
    if (!Number(claimed?.meta?.changes ?? 0)) continue;

    if (set.wish && person.user_id) {
      const wish = greeting(person.preferred_name || person.name,
        { property: set.property, title: set.title, line: set.line });
      await createNotice(db, {
        kind: 'birthday.wish',
        level: 'info',
        title: wish.title,
        body: wish.line,
        link: '#/att-me',
        day: today,
        actor: set.property || 'HIVE',
        userId: person.user_id,
        push: set.push,
        email: false,
      }, ctx);
    }
    wished += 1;
  }

  if (wished && set.prompt) {
    const said = prompt(
      whose.map((p) => p.preferred_name || p.name.split(' ')[0]),
      { body: set.promptBody },
    );
    await createNotice(db, {
      kind: 'birthday.prompt',
      level: 'info',
      title: said.title,
      body: said.body,
      link: '#/att-today',
      day: today,
      actor: 'HIVE',
      audience: 'att_view',
      push: set.push,
      email: false,
    }, ctx);
  }

  return { wished, day: today };
}

/**
 * The year, for whoever is setting the wording.
 *
 * Three things a setup screen has to answer that the morning strip cannot.
 *
 * WHOSE BIRTHDAY IS WHEN, all twelve months of it, because somebody editing
 * the message wants to see who it will reach and there is no other list of it
 * anywhere in the app.
 *
 * WHO HAS NO DATE ON FILE. This is the one that matters. A birthday the app
 * never mentions looks exactly like a birthday nobody has, and the only way to
 * tell them apart is a list of the people it knows nothing about. It is a
 * chase list, so it carries the department and links to the record.
 *
 * AND WHAT HAS ACTUALLY GONE OUT, so a wording change can be checked against
 * something real rather than trusted.
 */
export async function birthdayAdmin(ctx) {
  const set = await wording(ctx.db);
  const today = todayIn(set.timezone);
  const people = await peopleWithBirthdays(ctx.db);

  const missing = await ctx.db.prepare(
    `SELECT s.id, s.name, s.department, s.employee_no
       FROM att_staff s
       LEFT JOIN hr_profile p ON p.staff_id = s.id
      WHERE s.active = 1
        AND (p.staff_id IS NULL OR p.date_of_birth IS NULL OR p.date_of_birth = '')
      ORDER BY s.department, s.name`,
  ).all().catch(() => ({ results: [] }));

  const sent = await ctx.db.prepare(
    `SELECT id, at, kind, title, body, day, audience
       FROM app_notices
      WHERE kind IN ('birthday.wish', 'birthday.today', 'birthday.prompt')
      ORDER BY id DESC LIMIT 30`,
  ).all().catch(() => ({ results: [] }));

  // Grouped by the month it falls in rather than listed by date, because the
  // question a manager asks of a year of birthdays is "who is in March".
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    people: [],
  }));
  for (const person of people) {
    const born = monthDay(person.date_of_birth);
    if (!born) continue;
    const [month, day] = born.split('-').map(Number);
    months[month - 1].people.push({
      id: person.id,
      name: person.name,
      preferred: person.preferred_name || null,
      department: person.department || null,
      day,
      isToday: born === today.slice(5),
    });
  }
  for (const month of months) month.people.sort((a, b) => a.day - b.day || a.name.localeCompare(b.name));

  return json({
    today,
    property: set.property,
    settings: {
      wish: set.wish,
      title: set.title,
      line: set.line,
      push: set.push,
      prompt: set.prompt,
      promptBody: set.promptBody,
      ahead: set.ahead,
    },
    // What a real person would receive, worked out on the server so the
    // preview and the message cannot drift apart.
    preview: sample(people, today, set),
    withDates: people.length,
    missing: missing.results ?? [],
    months,
    sent: (sent.results ?? []).map((n) => ({
      id: n.id,
      at: n.at,
      kind: n.kind,
      title: n.title,
      body: n.body,
      day: n.day,
      // Who it went to, said in words rather than as a permission name.
      to: n.kind === 'birthday.wish' ? 'The person'
        : (n.audience ? 'Whoever runs the floor' : 'Everybody'),
    })),
  });
}

/**
 * The wording as somebody would actually receive it.
 *
 * Against a real name off the books where there is one. A preview against
 * "John Smith" reads as a preview; a preview against somebody's actual first
 * name is the thing itself, which is what makes a clumsy sentence obvious.
 */
function sample(people, today, set) {
  const soon = upcoming(people, today, 366)[0] ?? people[0] ?? null;
  const name = soon ? (soon.preferred_name || soon.name) : 'Ama Mensah';
  const wish = greeting(name, { property: set.property, title: set.title, line: set.line });
  const said = prompt([String(name).split(/\s+/)[0]], { body: set.promptBody });

  return {
    name,
    real: Boolean(soon),
    wish,
    prompt: said,
  };
}
