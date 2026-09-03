/**
 * Turning a suggested draft into what Save understands.
 *
 * The suggestion engine hands back a list of placements, and the grid's Save
 * takes a list of changes. They are not the same shape, and the difference is
 * where this went wrong: a shift the draft could not fill is a placement with
 * nobody on it, and sent as an ordinary change it reached the server as a
 * change naming no member of staff. The whole batch was refused with "Staff is
 * required", so one hole in a fortnight lost the fortnight.
 *
 * Three kinds go out, and each says what it is rather than leaving the server
 * to work it out:
 *
 *   a row id   The suggestion landed on a slot already standing on the day, so
 *              the slot is filled rather than a second row added beside it.
 *   a slot     Nobody could be found and the shift has to be on the rota
 *              anyway. It goes on empty, for somebody to fill by hand.
 *   a change   Somebody is on it. `add` when it is their second shift of the
 *              day, because sent as a plain change it would replace the first.
 *
 * Kept on its own, with nothing imported, so the mapping can be tested without
 * a browser. It is the part that was wrong, and it was wrong precisely because
 * nothing could reach it.
 */
export function draftEntries(entries) {
  return entries.map((e) => {
    if (e.rowId) return { id: e.rowId, day: e.day, staffId: e.staffId, shiftId: e.shiftId };
    if (e.empty) return { slot: true, day: e.day, shiftId: e.shiftId };
    return { staffId: e.staffId, day: e.day, shiftId: e.shiftId, add: Boolean(e.second) };
  });
}
