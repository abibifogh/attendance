/**
 * The people a single login may open the "my" screens for.
 *
 * Almost always one: the record in users.staff_id, which is the person the
 * login belongs to. Sometimes more, because two situations produce it. Somebody
 * on the books twice, from a second employee number the terminal was given when
 * a card was reissued. And somebody with no phone of their own, whose record is
 * put on the phone of whoever they live with so that there is any way for them
 * to see their own week.
 *
 * Their own record is always first and cannot be taken off the list while it is
 * set: it is what the login is, and the extras are what it also opens. Order is
 * the whole of the default, so it is decided here rather than by whatever a
 * query happened to return.
 *
 * Nothing in here touches a database or a request. What may be opened is a rule,
 * and a rule this close to somebody's pay is worth being able to read on its own.
 */

/** More than this on one login is a shared account by another name. */
export const MOST_RECORDS = 8;

/**
 * Ids out of whatever the database handed over.
 *
 * `group_concat` gives back "4,9,11", one id, or nothing at all, and a list
 * arrives from a browser as an array. All four read the same here.
 */
export function readIds(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const out = [];
  for (const one of raw) {
    const id = Number(String(one).trim());
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Every record this login opens, their own first.
 *
 * An extra that repeats their own record is dropped rather than refused: it
 * means the same thing as not naming it, and there is nothing for anybody to
 * correct.
 */
export function recordsOn(own, extras) {
  const first = Number(own) || 0;
  const rest = readIds(extras).filter((id) => id !== first);
  return first ? [first, ...rest] : rest;
}

/**
 * Whose screens are being asked for, out of the ones this login may open.
 *
 * Nothing asked means the first, which is their own. Something asked that is
 * not on the list is refused rather than quietly answered with their own: a
 * request for somebody else's payslips has to come back as a refusal, or the
 * screen showing a name and the answer underneath it are two different people.
 */
export function whoIsMeant(records, asked) {
  const list = readIds(records);
  if (asked == null || asked === '') return { staffId: list[0] ?? null, refused: false };
  const wanted = Number(asked);
  if (!Number.isInteger(wanted) || !list.includes(wanted)) return { staffId: null, refused: true };
  return { staffId: wanted, refused: false };
}

/**
 * The extras an administrator has just chosen, as they will be stored.
 *
 * Their own record is not one of the extras however it arrives, since it is
 * already the first thing on the list, and a login with nobody's record at all
 * cannot carry somebody else's: extras are extra to something.
 */
export function tidyExtras(chosen, own) {
  if (!Number(own)) return [];
  return readIds(chosen).filter((id) => id !== Number(own)).slice(0, MOST_RECORDS - 1);
}
