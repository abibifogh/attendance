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
 * Four kinds go out, and each says what it is rather than leaving the server
 * to work it out:
 *
 *   a removal  An empty card standing on a day above what the shift asks for.
 *              The only line on a draft that takes something away, and it only
 *              ever takes away a card nobody is on.
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
    // Before the row-id case, which would otherwise read a removal as a change
    // setting the card to nobody, which is what it already is.
    if (e.drop) return { id: e.rowId, day: e.day, remove: true };
    if (e.rowId) return { id: e.rowId, day: e.day, staffId: e.staffId, shiftId: e.shiftId };
    if (e.empty) return { slot: true, day: e.day, shiftId: e.shiftId };
    return { staffId: e.staffId, day: e.day, shiftId: e.shiftId, add: Boolean(e.second) };
  });
}
