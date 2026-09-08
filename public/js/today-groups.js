/**
 * The morning, arranged the way somebody actually walks the building.
 *
 * It used to be four lists by state: waiting on a decision, absent, late,
 * everybody else. That is the right order for one person clearing a queue at a
 * desk, and the wrong shape for everybody else who opens this screen. A head of
 * housekeeping does not want the property's absences, she wants her floor; and
 * "is my department all in" was a question that took reading four lists and
 * remembering which names were in which.
 *
 * So the page is one card per department with everybody in it once, and the
 * state is a colour against the name instead of a heading over a list. Red is
 * absent, amber is late or gone early, green is in, and grey is a shift that
 * has not come round yet.
 *
 * WHAT IS KEPT is the order inside each card. Days waiting on a decision come
 * first, then the absences, then the lateness, then everybody who simply turned
 * up — because within a department that is still the order to deal with them
 * in, and it is the half of the old arrangement that was doing real work.
 */

/** Where somebody with no department on their record is shown. */
export const NO_DEPARTMENT = 'No department';

/**
 * The one word for how somebody's day stands.
 *
 * Waiting on a decision outranks the colour it would otherwise have. A day
 * held because a punch is missing is not an absence and must not be counted as
 * one, and it is the only state on this screen that somebody has to answer.
 */
export function standing(row) {
  if (!row) return 'grey';
  if (row.open) return 'open';
  if (row.colour === 'red' || row.colour === 'amber' || row.colour === 'green') return row.colour;
  return 'grey';
}

const ORDER = { open: 0, red: 1, amber: 2, green: 3, grey: 4 };

/** Whether this one is somebody's job this morning. */
export const toDealWith = (row) => ['open', 'red', 'amber'].includes(standing(row));

/**
 * Everybody, by department.
 *
 * Departments in alphabetical order, and "No department" last wherever it
 * falls. Alphabetical rather than worst-first on purpose: an order that
 * rearranged itself every morning would have people hunting for their own
 * department, and the thing they are looking for is a card in the same place
 * as yesterday.
 */
export function byDepartment(rows = []) {
  const groups = new Map();

  for (const row of rows) {
    const name = String(row?.staff?.department ?? '').trim() || NO_DEPARTMENT;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }

  const named = [...groups.keys()].filter((n) => n !== NO_DEPARTMENT)
    .sort((a, b) => a.localeCompare(b));
  if (groups.has(NO_DEPARTMENT)) named.push(NO_DEPARTMENT);

  return named.map((department) => {
    const people = [...groups.get(department)].sort((a, b) => {
      const by = ORDER[standing(a)] - ORDER[standing(b)];
      if (by !== 0) return by;
      return String(a?.staff?.name ?? '').localeCompare(String(b?.staff?.name ?? ''));
    });

    const counts = { open: 0, red: 0, amber: 0, green: 0, grey: 0 };
    for (const row of people) counts[standing(row)] += 1;

    return {
      department,
      rows: people,
      counts,
      waiting: people.filter(toDealWith).length,
    };
  });
}

/**
 * What a department's card says beside its name.
 *
 * The number of people, and then only what is wrong. "12 people, nothing to
 * deal with" beside eleven quiet departments is eleven lines nobody reads, so
 * a department with nothing against it says so in two words and stops.
 */
export function sayHowItStands({ rows, counts, waiting }) {
  const people = `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`;

  if (waiting) {
    const bits = [];
    if (counts.open) bits.push(`${counts.open} to confirm`);
    if (counts.red) bits.push(`${counts.red} absent`);
    if (counts.amber) bits.push(`${counts.amber} late or early`);
    return `${people} \u00b7 ${bits.join(', ')}`;
  }

  // Nothing wrong is not the same as everybody being here. A department where
  // the whole floor is on a rest day is a department with nobody in it, and
  // "all in" over nine dashes is the screen saying something plainly untrue.
  if (!counts.green) return `${people}, none on today`;
  if (!counts.grey) return `${people}, all in`;
  return `${counts.green} in, ${counts.grey} off`;
}
