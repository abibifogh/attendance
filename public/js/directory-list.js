/**
 * Which names the directory is showing.
 *
 * A pure module, because deciding who is on the page is worth a test and the
 * screen that draws them is not: the view imports the app, and the app imports
 * the browser.
 *
 * The department a person is filed under and the heading they appear under are
 * the same thing everywhere here, so somebody with no department is not
 * scattered across the page. They gather under one heading of their own,
 * which sorts with the rest.
 */
export const NO_DEPARTMENT = 'No department';

export const departmentOf = (person) => person?.department || NO_DEPARTMENT;

/** Every heading on the page, in the order they are read in. */
export function departmentsIn(people) {
  return [...new Set((people ?? []).map(departmentOf))].sort();
}

/**
 * The people a chip and a search box leave behind.
 *
 * Searching looks at the department as well as the name, because "reception"
 * is a thing somebody types when they want reception and have not noticed the
 * row of departments above the box.
 */
export function filterPeople(people, { department = null, needle = '' } = {}) {
  const want = String(needle ?? '').trim().toLowerCase();
  return (people ?? []).filter((person) => {
    if (department && departmentOf(person) !== department) return false;
    if (!want) return true;
    return `${person.name ?? ''} ${person.department ?? ''}`.toLowerCase().includes(want);
  });
}

/** How many are filed under each heading, for the count on a chip. */
export function countByDepartment(people) {
  const counts = new Map();
  for (const person of people ?? []) {
    const key = departmentOf(person);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
