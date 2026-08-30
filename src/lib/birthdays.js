/**
 * Birthdays.
 *
 * The one thing in here that is not about hours, lateness or money.
 *
 * A hotel remembers birthdays badly: somebody's date of birth is on a form in
 * a drawer, and whether it is noticed depends on whether a particular manager
 * happens to remember. The app already holds the date for every person on the
 * books, so the only reason it was going unnoticed was that nothing was
 * looking. Something is looking now.
 *
 * TWO DIFFERENT MESSAGES, ON PURPOSE. What goes to the person is warm and is
 * addressed to them. What goes to whoever runs the floor is a prompt — it is
 * their birthday, here is a card, say something — because the thing a person
 * actually remembers is a colleague saying it out loud, and an app that only
 * sends an automatic message has replaced that rather than prompted it.
 *
 * NOTHING HERE READS A BIRTH YEAR OUT LOUD. The record holds a full date
 * because the payroll and the contracts need one; a card announcing that
 * somebody is fifty-three is not a kindness. The year is used to work out
 * whether a date is even plausible, and then left alone.
 */

/** Month and day, from a date somebody typed years ago. */
export function monthDay(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;

  const [, year, month, day] = match;
  const y = Number(year);
  // A date of birth in the future, or before anybody alive was born, is a
  // typing mistake rather than a birthday. Wishing somebody many happy returns
  // on the strength of one is worse than saying nothing.
  if (y < 1900 || y > new Date().getUTCFullYear()) return null;
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day) < 1 || Number(day) > 31) return null;

  return `${month}-${day}`;
}

/**
 * Whose birthday falls on a given day.
 *
 * The 29th of February is the awkward one, and the humane answer is the 28th:
 * somebody born on a leap day has a birthday every year, and an app that only
 * notices it once in four is an app that forgets three times.
 */
export function birthdaysOn(people, day) {
  const today = monthDayOf(day);
  if (!today) return [];

  const leapDayToday = today === '02-28' && !isLeapYear(Number(String(day).slice(0, 4)));

  return people.filter((person) => {
    const born = monthDay(person.date_of_birth);
    if (!born) return false;
    if (born === today) return true;
    return leapDayToday && born === '02-29';
  });
}

/** How old they are today, or null where the year makes no sense. */
export function ageOn(dateOfBirth, day) {
  const born = String(dateOfBirth ?? '').slice(0, 10);
  if (!monthDay(born)) return null;
  const [by, bm, bd] = born.split('-').map(Number);
  const [ty, tm, td] = String(day).slice(0, 10).split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

/**
 * The next birthday coming up, for the people who have one recorded.
 *
 * Ordered by how far off it is rather than by date, so December and January
 * sit next to each other in the last week of the year — which is where
 * somebody planning a card actually needs them.
 */
export function upcoming(people, day, withinDays = 30) {
  const from = String(day).slice(0, 10);
  const out = [];

  for (const person of people) {
    const born = monthDay(person.date_of_birth);
    if (!born) continue;
    const away = daysUntil(born, from);
    if (away == null || away > withinDays) continue;
    out.push({ ...person, monthDay: born, inDays: away });
  }

  return out.sort((a, b) => a.inDays - b.inDays || String(a.name).localeCompare(String(b.name)));
}

/** How many days from a date to the next time that month and day comes round. */
export function daysUntil(monthDayText, from) {
  const [fy] = String(from).split('-').map(Number);
  for (const year of [fy, fy + 1]) {
    const when = `${year}-${monthDayText}`;
    // The 29th of February in a year that has no 29th of February falls back
    // to the 28th, the same way the day itself does.
    const target = when.endsWith('-02-29') && !isLeapYear(year) ? `${year}-02-28` : when;
    const away = between(from, target);
    if (away >= 0) return away;
  }
  return null;
}

/** The wording as it ships, before anybody has edited it. */
export const WORDING = {
  title: 'Happy birthday, {name}',
  line: 'Everybody at {property} hopes you have a lovely day.',
  prompt: 'They have been told. What they will remember is somebody saying it out loud, '
    + 'and there is a card ready to send on the Today screen.',
};

/**
 * Put the names into the wording.
 *
 * Two placeholders and no more. A template language in a birthday message is
 * a thing to debug on somebody's birthday, and the two things a wish ever
 * needs to say are who it is for and where it is from.
 *
 * A property with no name set would otherwise send "Everybody at hopes you
 * have a lovely day", so the fallback is a word rather than a blank.
 */
export function fill(text, { name = '', property = '' } = {}) {
  return String(text ?? '')
    .replace(/\{name\}/g, String(name || 'you'))
    .replace(/\{property\}/g, String(property || 'work'))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the card says.
 *
 * Written here rather than in the screen so the notice, the email and the card
 * itself cannot end up wishing somebody three different things. The words
 * themselves come off the setup screen; what is here is the shape and the
 * fallback, so a property that has never opened that screen still says
 * something sensible.
 *
 * Deliberately short: a long message on a birthday card is a message about
 * whoever wrote it.
 */
export function greeting(name, { property = null, title = null, line = null } = {}) {
  const first = String(name ?? '').trim().split(/\s+/)[0] || 'you';
  const named = { name: first, property };
  return {
    title: fill(title || WORDING.title, named),
    line: fill(line || WORDING.line, named),
  };
}

/**
 * What whoever runs the floor is told, which is a prompt rather than a wish.
 *
 * The body comes off the setup screen for the same reason the wish does. The
 * title is built here: it has to agree with itself about one name or three.
 */
export function prompt(names, { body = null } = {}) {
  const list = [...names];
  if (!list.length) return null;

  const who = list.length === 1
    ? list[0]
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

  return {
    title: list.length === 1
      ? `It is ${who}'s birthday today`
      : `It is ${who}'s birthdays today`,
    body: fill(body || WORDING.prompt),
  };
}

// ---------------------------------------------------------------------------

const monthDayOf = (day) => {
  const match = /^\d{4}-(\d{2}-\d{2})$/.exec(String(day ?? '').slice(0, 10));
  return match ? match[1] : null;
};

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const between = (from, to) => Math.round(
  (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000,
);
