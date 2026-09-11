import { json } from '../lib/http.js';

/**
 * The staff directory.
 *
 * A phone number and an email address, and nothing else. Somebody needs to
 * reach the person covering their shift, or the kitchen needs the number of
 * whoever has the store key, and until now that meant asking an administrator
 * to open a personnel record — which shows a date of birth, an ID number and a
 * bank account to somebody who wanted a phone number.
 *
 * SO THE ROUTE SELECTS FOUR COLUMNS AND NOT A FIFTH. Not a whole record filtered
 * on the way out, which is the same screen one careless edit away from being a
 * personnel file. What is not in the query cannot leak, and what the query
 * takes is the entire specification of this feature.
 *
 * Everybody signed in can read it, because a directory nobody can open is a
 * list. That is a real decision about personal numbers and it is the property's
 * to make: one switch under Setup turns the whole thing off, and somebody with
 * nothing in either column simply is not on it.
 */
export async function staffDirectory(ctx) {
  const setting = await ctx.db.prepare(
    "SELECT value FROM settings WHERE key = 'hr_directory'",
  ).first().catch(() => null);

  // Off unless the property has said otherwise. A directory of everybody's
  // personal mobile is not something an upgrade should switch on for a
  // property that never asked for one.
  if ((setting?.value ?? '0') !== '1') {
    return json({ on: false, people: [] });
  }

  const rows = await ctx.db.prepare(
    `SELECT s.name, s.department, p.personal_phone AS phone, p.personal_email AS email
       FROM att_staff s
       LEFT JOIN hr_profile p ON p.staff_id = s.id
      WHERE s.active = 1
      ORDER BY s.name`,
  ).all().catch(() => ({ results: [] }));

  return json({
    on: true,
    people: (rows.results ?? [])
      // Nobody with nothing to ring. A row of blanks is a name somebody reads
      // twice before working out the directory cannot help them.
      .filter((r) => (r.phone ?? '').trim() || (r.email ?? '').trim())
      .map((r) => ({
        name: r.name,
        department: r.department ?? null,
        phone: (r.phone ?? '').trim() || null,
        email: (r.email ?? '').trim() || null,
      })),
  });
}
