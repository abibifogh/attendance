import { badRequest, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { ageOn, birthdaysOn, greeting, prompt, upcoming } from '../lib/birthdays.js';
import { todayIn } from '../util/dates.js';

/**
 * Whose birthday it is, who has been told, and the card.
 *
 * Read by the morning screen and written by the daily tick. Everything about
 * what a birthday *is* lives in the library beside this; what is here is who
 * gets told and what stops them being told twice.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

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
  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'UTC';
  const today = todayIn(timezone);

  const people = await peopleWithBirthdays(ctx.db);
  const property = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'property_name'")
    .first())?.value || null;

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
    soon: upcoming(people, today, 30)
      .filter((p) => p.inDays > 0)
      .slice(0, 8)
      .map((p) => ({ ...shape(p), inDays: p.inDays })),
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

  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'UTC';
  const today = todayIn(timezone);

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

  const property = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'property_name'")
    .first())?.value || null;
  const wish = greeting(person.preferred_name || person.name, { property });

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
      push: true,
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
  const today = todayIn(timezone);
  const people = await peopleWithBirthdays(db);
  const whose = birthdaysOn(people, today);
  if (!whose.length) return { wished: 0 };

  const property = (await db.prepare("SELECT value FROM settings WHERE key = 'property_name'")
    .first().catch(() => null))?.value || null;

  let wished = 0;
  for (const person of whose) {
    const claimed = await db.prepare(
      'INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, ?3)',
    ).bind(person.id, today, 'birthday').run().catch(() => null);
    if (!Number(claimed?.meta?.changes ?? 0)) continue;

    if (person.user_id) {
      const wish = greeting(person.preferred_name || person.name, { property });
      await createNotice(db, {
        kind: 'birthday.wish',
        level: 'info',
        title: wish.title,
        body: wish.line,
        link: '#/att-me',
        day: today,
        actor: property || 'HIVE',
        userId: person.user_id,
        push: true,
        email: false,
      }, ctx);
    }
    wished += 1;
  }

  if (wished) {
    const said = prompt(whose.map((p) => p.preferred_name || p.name.split(' ')[0]));
    await createNotice(db, {
      kind: 'birthday.prompt',
      level: 'info',
      title: said.title,
      body: said.body,
      link: '#/att-today',
      day: today,
      actor: 'HIVE',
      audience: 'att_view',
      push: true,
      email: false,
    }, ctx);
  }

  return { wished, day: today };
}
