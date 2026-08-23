/**
 * Writing the rota, now that a day can hold more than one row.
 *
 * A cell used to be one row, and setting it was one upsert. Since a person may
 * hold two shifts on a day, "put them on the early" has to say which of the
 * two it means, and the callers that mean "this day is now exactly this" have
 * to say that instead of relying on a primary key to enforce it.
 *
 * WHY THE ROW IS UPDATED RATHER THAN REPLACED. `ever_published` lives on it. A
 * day that has been promised once and is being changed is a different thing
 * from a day nobody has seen, the publish dialog counts the two apart, and a
 * delete-then-insert would quietly turn every change into a new day.
 */

/** Every row this person holds on this day, in the order the dataset sorted them. */
export const rowsFor = (ds, staffId, day) => ds.rosterAllBy?.get(`${staffId}|${day}`) ?? [];

/**
 * Make a day be exactly one shift, whatever was on it before.
 *
 * What copying a week, confirming an import and picking a shift in the staff
 * grid all mean. `note` and `title` are always written, so a caller that means
 * to keep what is there passes what is there.
 */
export function replaceDay(db, { rows = [], staffId, day, shiftId, actor, note = null, title = null }) {
  const [keep, ...extras] = rows;
  const out = extras.map((row) => db.prepare('DELETE FROM att_roster WHERE id = ?').bind(row.id));

  out.push(keep
    ? db.prepare(
      `UPDATE att_roster
          SET shift_id = ?2, note = ?3, title = ?4, set_by = ?5, set_at = datetime('now'),
              -- A changed day is a draft again, however published it was
              -- before. Staff plan their lives around the solid ones, so a
              -- cell cannot change under them while still claiming to be the
              -- version they saw. ever_published is deliberately left alone.
              published = 0
        WHERE id = ?1`,
    ).bind(keep.id, shiftId, note, title, actor)
    : db.prepare(
      `INSERT INTO att_roster (staff_id, day, shift_id, note, title, set_by, set_at, published)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), 0)`,
    ).bind(staffId, day, shiftId, note, title, actor));

  return out;
}
