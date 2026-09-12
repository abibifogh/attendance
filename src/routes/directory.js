import { json, int, notFound } from '../lib/http.js';
import { staffPhoto } from './attendance.js';

/**
 * The staff directory.
 *
 * A phone number and an email address, and nothing else. Somebody needs to
 * reach the person covering their shift, or the kitchen needs the number of
 * whoever has the store key, and until now that meant asking an administrator
 * to open a personnel record — which shows a date of birth, an ID number and a
 * bank account to somebody who wanted a phone number.
 *
 * SO THE ROUTE NAMES ITS COLUMNS AND ADDS NONE BY ACCIDENT. Not a whole record
 * filtered on the way out, which is the same screen one careless edit away from
 * being a personnel file. What is not in the query cannot leak, and what the
 * query takes is the entire specification of this feature: a name, a
 * department, the two ways of reaching somebody, and enough to put their face
 * against the name — their id, and whether there is a photograph on file.
 *
 * The face is the same one the rota has always shown, and it rides on the same
 * switch as the rest of the page. A property that has decided its people may
 * hold each other's personal mobile numbers has decided the larger thing
 * already; one that has not has the directory off and none of this exists.
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
    `SELECT s.id, s.name, s.department, p.personal_phone AS phone, p.personal_email AS email,
            EXISTS (SELECT 1 FROM hr_document d WHERE d.staff_id = s.id AND d.kind = 'photo')
              AS has_photo
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
        id: r.id,
        name: r.name,
        department: r.department ?? null,
        phone: (r.phone ?? '').trim() || null,
        email: (r.email ?? '').trim() || null,
        // Whether to ask for the picture at all. Twenty-four requests that all
        // come back Not found is a slow page and a log full of nothing.
        hasPhoto: Number(r.has_photo) === 1,
      })),
  });
}

/**
 * The face beside a name on the directory.
 *
 * The picture and nothing else, and only while the directory is on. The rota's
 * own photograph route asks for a planner's permission, which is right for a
 * screen that also carries hours and lateness and wrong here: it would mean a
 * page of names the person reading it works beside every day and not one face.
 *
 * A separate route rather than a widened one, so the permission on the rota's
 * stays where it is. Somebody who has left is not on the directory and their
 * picture does not come out of it either.
 */
export async function directoryPhoto(ctx, id) {
  const setting = await ctx.db.prepare(
    "SELECT value FROM settings WHERE key = 'hr_directory'",
  ).first().catch(() => null);
  if ((setting?.value ?? '0') !== '1') throw notFound('No photograph on file.');

  const staffId = int(id, 'Staff', { min: 1 });
  const who = await ctx.db.prepare(
    'SELECT id FROM att_staff WHERE id = ? AND active = 1',
  ).bind(staffId).first().catch(() => null);
  if (!who) throw notFound('No photograph on file.');

  return staffPhoto(ctx, staffId);
}
