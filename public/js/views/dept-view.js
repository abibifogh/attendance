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
 * anyway. Their own department and this week are the defaults, and an address
 * that spelled them out would follow everybody around for nothing.
 */
export function whatToRemember({ from = null, department = null, mine = null } = {}) {
  return {
    dept: department && department !== mine ? department : null,
    deptFrom: from || null,
  };
}
