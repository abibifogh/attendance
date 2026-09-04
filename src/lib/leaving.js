import { addDays } from '../util/dates.js';

/**
 * Somebody leaves, and everything that should follow from it does.
 *
 * Until now a leaving date was a field on the record and nothing else. The
 * login stayed open, the phone kept getting shift alerts, the rota still had
 * them down for the week after, and payroll went on paying them until
 * somebody remembered to untick "active" as well. Two flags for one fact,
 * kept in step by hand, which is how a person who left in June was still on
 * the rota in August.
 *
 * WHAT HAPPENS, AND WHEN
 *
 *   The moment the date is set, whatever it is: every rota row after that
 *   day goes, logged, so nobody plans a week around somebody who will not be
 *   there. Days up to and including it stay: they are still working them.
 *
 *   From the day after they leave: the record goes inactive, the login is
 *   switched off, the phone stops being told about shifts, and their
 *   standing pattern is dropped so it cannot put them back. Done at once if
 *   the date has already passed, and otherwise by the nightly run on the
 *   morning after, so a leaving date typed in a fortnight early needs no
 *   second visit.
 *
 * WHAT DOES NOT HAPPEN
 *
 *   Nothing is deleted. Punches, days, payslips, contracts and letters are
 *   history, and a report on the month they left must still find them.
 *
 *   Payroll pays the month they leave in, pro-rated to the day, and then
 *   stops. That is decided in payroll, which reads `left_on` for itself; all
 *   this does is stop feeding it an active flag it would otherwise trust.
 */

const who = (actor) => actor || 'HIVE';

/** Rota rows after the last day go now, whatever the date is. */
async function clearBeyond(db, staffId, leftOn, actor) {
  const after = addDays(leftOn, 1);
  await db.prepare(
    `INSERT INTO att_roster_log
       (day, staff_id, shift_id, was_staff_id, was_shift_id, action, source, actor, detail)
     SELECT day, staff_id, NULL, staff_id, shift_id, 'removed', 'left', ?3,
            'Left on ' || ?4
       FROM att_roster WHERE staff_id = ?1 AND day >= ?2`,
  ).bind(staffId, after, who(actor), leftOn).run().catch(() => {});
  const gone = await db.prepare(
    'DELETE FROM att_roster WHERE staff_id = ?1 AND day >= ?2',
  ).bind(staffId, after).run().catch(() => null);
  return Number(gone?.meta?.changes ?? 0);
}

/** The switching off, once the last day is behind us. */
async function switchOff(db, staffId) {
  await db.prepare('UPDATE att_staff SET active = 0 WHERE id = ?').bind(staffId).run();
  await db.prepare('DELETE FROM att_patterns WHERE staff_id = ?').bind(staffId).run().catch(() => {});

  // And off anybody else's login that was carrying their record. Somebody who
  // has left should not still be on the phone of whoever they lived with,
  // where their pay would go on being readable long after the property has
  // anything to do with them.
  await db.prepare('DELETE FROM user_staff WHERE staff_id = ?').bind(staffId).run().catch(() => {});

  const login = await db.prepare('SELECT id, active FROM users WHERE staff_id = ?')
    .bind(staffId).first().catch(() => null);
  let loginOff = false;
  let phonesOff = 0;
  if (login) {
    if (login.active) {
      await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(login.id).run();
      loginOff = true;
    }
    const phones = await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?')
      .bind(login.id).run().catch(() => null);
    phonesOff = Number(phones?.meta?.changes ?? 0);
  }
  return { loginOff, phonesOff };
}

/**
 * A leaving date has been set on somebody. Returns what was done, for the
 * screen to say back.
 */
export async function settleLeaving(db, { staffId, leftOn, today, actor = null }) {
  if (!leftOn) return null;
  const cleared = await clearBeyond(db, staffId, leftOn, actor);
  const gone = leftOn < today;
  const off = gone ? await switchOff(db, staffId) : { loginOff: false, phonesOff: 0 };
  return { leftOn, cleared, gone, ...off };
}

/**
 * The nightly half: anybody whose last day has passed and who is still
 * switched on. Runs every morning, so a date set in advance takes effect on
 * the right day with nobody having to come back to it.
 */
export async function sweepLeavers(db, { today }) {
  const rows = await db.prepare(
    `SELECT id, name, left_on FROM att_staff
      WHERE active = 1 AND left_on IS NOT NULL AND left_on < ?`,
  ).bind(today).all().catch(() => ({ results: [] }));
  const done = [];
  for (const person of rows.results ?? []) {
    await clearBeyond(db, person.id, person.left_on, 'HIVE');
    const off = await switchOff(db, person.id);
    done.push({ id: person.id, name: person.name, leftOn: person.left_on, ...off });
  }
  return done;
}

/**
 * Is this person still on the payroll for a month?
 *
 * Active, or left inside the month or later: the month somebody leaves in is
 * still a month they are paid for. `month` is 'YYYY-MM'.
 */
export function paidInMonth(person, month) {
  if (person.active) return true;
  return Boolean(person.left_on && String(person.left_on) >= `${month}-01`);
}
