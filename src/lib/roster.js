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
export function replaceDay(db, {
  rows = [], staffId, day, shiftId, actor, note = null, title = null, source = 'hand',
  detail = null,
}) {
  const [keep, ...extras] = rows;
  const out = [];

  for (const row of extras) {
    out.push(logChange(db, {
      day, staffId: row.staff_id, wasStaffId: row.staff_id, wasShiftId: row.shift_id,
      action: 'removed', source, actor, detail,
    }));
    out.push(db.prepare('DELETE FROM att_roster WHERE id = ?').bind(row.id));
  }

  // A day already saying exactly this is not a change, and a trail full of
  // entries where nothing moved is a trail nobody reads.
  const moved = !keep || Number(keep.shift_id ?? 0) !== Number(shiftId ?? 0);
  if (moved) {
    out.push(logChange(db, {
      day,
      staffId,
      shiftId,
      wasStaffId: keep ? keep.staff_id : null,
      wasShiftId: keep ? keep.shift_id : null,
      action: keep ? 'changed' : 'added',
      source,
      actor,
      detail,
    }));
  }

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

// ---------------------------------------------------------------------------
// Keeping the trail
// ---------------------------------------------------------------------------

/**
 * One entry in a cell's history.
 *
 * Written as statements alongside the change itself rather than afterwards, so
 * the two go into the same batch and a failed write leaves no trail claiming
 * something happened that did not.
 */
export function logChange(db, {
  day, staffId = null, shiftId = null, wasStaffId = null, wasShiftId = null,
  action, source = 'hand', actor, detail = null,
}) {
  return db.prepare(
    `INSERT INTO att_roster_log
       (day, staff_id, shift_id, was_staff_id, was_shift_id, action, source, actor, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(day, staffId, shiftId, wasStaffId, wasShiftId, action, source, actor, detail);
}

/**
 * An entry for every row a DELETE is about to take, read from the rows
 * themselves.
 *
 * One statement rather than one per row, because clearing a fortnight or
 * publishing a month is otherwise three hundred round trips, and because it
 * cannot go stale between the read and the write.
 */
export function logRows(db, { where, binds, action, source = 'hand', actor, detail = null }) {
  return db.prepare(
    `INSERT INTO att_roster_log
       (day, staff_id, shift_id, was_staff_id, was_shift_id, action, source, actor, detail)
     SELECT day,
            -- Whoever was on it stays the key of the entry even when the row
            -- is going: the trail belongs to their day, and keying it on the
            -- nobody who is on it afterwards loses it.
            ${action === 'removed' ? 'staff_id, NULL' : 'staff_id, shift_id'},
            staff_id, shift_id, ?${binds.length + 1}, ?${binds.length + 2},
            ?${binds.length + 3}, ?${binds.length + 4}
       FROM att_roster WHERE ${where}`,
  ).bind(...binds, action, source, actor, detail);
}
