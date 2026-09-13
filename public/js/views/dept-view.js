/**
 * What the department card should remember about what it is showing.
 *
 * Pulled out on its own so it can be tested without a browser, and because the
 * bug it exists to prevent is not obvious from either side. The card redraws
 * itself whenever the live socket says something has changed, and on a working
 * property that is every punch on the terminal, all day. A card that held its
 * choice in a variable was rebuilt from nothing each time: somebody picked
 * Security, read two lines, and was back on their own department before they
 * had finished reading.
 *
 * So the choice goes in the address, where a redraw reads it back. The rule
 * for what is worth writing down: only a departure from what the card opens on
 * anyway. Their own department is the default, and an address that spelled it
 * out would follow everybody around for nothing.
 *
 * The week is not here. It belongs to the page, which has one week selector at
 * the top of it for both their own shifts and their colleagues': two selectors
 * a screen apart, each moving one half of the answer, is a way of asking
 * somebody to hold two dates in their head to read one week.
 */
export function whatToRemember({ department = null, mine = null } = {}) {
  return {
    dept: department && department !== mine ? department : null,
  };
}
