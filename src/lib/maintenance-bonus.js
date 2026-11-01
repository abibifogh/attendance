import { HttpError } from './http.js';
import { round2 } from './tax.js';

/**
 * The Ahokeka bonus, out of the Maintenance app.
 *
 * Maintenance scores its artisans week by week: of the jobs on them in a week,
 * how many were finished, with nothing for a week under its threshold (80% by
 * default). It gathers the weeks into months the way a payroll needs them — a
 * week belongs to the month most of its days are in, and the person's monthly
 * bonus is split evenly over that month's weeks — and says, for each artisan,
 * how much of their bonus the month earned.
 *
 * Here that figure becomes a score on the scheme: what they earned, as a share
 * of what the scheme pays at a hundred. Somebody whose bonus in Maintenance is
 * GHS 300 and who earned GHS 264 of it scores 66 on a GHS 400 scheme, and is
 * paid the GHS 264 they earned.
 *
 * People are matched by their employee number, which Maintenance keeps on each
 * person. Nobody is matched by name: two spellings of the same man are common,
 * and a bonus paid to the wrong one is not.
 *
 * NOTHING IS SAVED HERE. What comes back fills the boxes on the screen, and the
 * scores are saved the usual way, by whoever is doing the payroll, after they
 * have looked at them.
 */

/** The link, as it is pasted in: `address|publishable key|link key`. */
export function readLink(text) {
  const parts = String(text ?? '').trim().split('|').map((p) => p.trim());
  if (parts.length !== 3 || !/^https:\/\/[^\s/]+\.supabase\.co$/.test(parts[0].replace(/\/+$/, ''))
    || !parts[1] || !/^mxh_[0-9a-f]{48}$/.test(parts[2])) {
    return null;
  }
  return { url: parts[0].replace(/\/+$/, ''), anon: parts[1], key: parts[2] };
}

const cleanNo = (value) => String(value ?? '').trim().replace(/\.0$/, '').toLowerCase();

/**
 * Ask Maintenance for a month. Throws with a sentence a person can act on.
 * `fetchImpl` stands in for fetch in tests.
 */
export async function askMaintenance(linkText, month, fetchImpl = fetch) {
  const link = readLink(linkText);
  if (!link) {
    throw new HttpError(503, 'HIVE is not linked to Maintenance yet. In Maintenance, More → Data & backups → '
      + 'Link to HIVE makes the link text; it goes in this repository\'s secrets as APP_MAINTENANCE_LINK, '
      + 'then Actions → "Set the app\'s secrets".');
  }
  let response;
  try {
    response = await fetchImpl(`${link.url}/rest/v1/rpc/mx_hive_bonus`, {
      method: 'POST',
      headers: {
        apikey: link.anon,
        Authorization: `Bearer ${link.anon}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_key: link.key, p_month: month }),
    });
  } catch {
    throw new HttpError(502, 'Maintenance could not be reached. Try again in a minute.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const said = data?.message || data?.error || `Maintenance answered ${response.status}.`;
    throw new HttpError(502, /function .*mx_hive_bonus.* does not exist|Could not find the function/i.test(said)
      ? 'Maintenance does not have the bonus link yet: its database update has not been run.'
      : said);
  }
  if (!data || !Array.isArray(data.people)) {
    throw new HttpError(502, 'Maintenance answered with something that is not a month\'s bonus.');
  }
  return data;
}

/**
 * Ask Maintenance for a month's late-report deductions: GHS 50 off for each
 * weekly report not sent within four hours of being due. Same link, same key.
 */
export async function askMaintenancePenalties(linkText, month, fetchImpl = fetch) {
  const link = readLink(linkText);
  if (!link) throw new HttpError(503, 'HIVE is not linked to Maintenance yet.');
  let response;
  try {
    response = await fetchImpl(`${link.url}/rest/v1/rpc/mx_hive_penalties`, {
      method: 'POST',
      headers: {
        apikey: link.anon,
        Authorization: `Bearer ${link.anon}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_key: link.key, p_month: month }),
    });
  } catch {
    throw new HttpError(502, 'Maintenance could not be reached.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError(502, data?.message || data?.error || `Maintenance answered ${response.status}.`);
  }
  if (!data || !Array.isArray(data.penalties)) {
    throw new HttpError(502, 'Maintenance answered with something that is not a month\'s deductions.');
  }
  return data;
}

/** Employee numbers as they are compared: no spaces, no case, no stray ".0". */
export { cleanNo };

/**
 * Maintenance's month, set against one scheme.
 *
 * Returns a line for each person on the scheme Maintenance knows about, with
 * the score that pays what they earned, and says who could not be matched and
 * why, so nobody is quietly left at nought.
 */
export function scoresFor(scheme, staff, month) {
  const onScheme = new Set(scheme.staffIds ?? []);
  const byNo = new Map();
  for (const person of staff) {
    const no = cleanNo(person.employee_no ?? person.employeeNo);
    if (no) byNo.set(no, person);
  }
  const amount = Number(scheme.amount) || 0;
  const lines = [];
  const unmatched = [];
  const seen = new Set();

  for (const p of month.people ?? []) {
    const no = cleanNo(p.employee_no);
    if (!no) {
      unmatched.push({ name: p.name, why: 'no employee number in Maintenance' });
      continue;
    }
    const person = byNo.get(no);
    if (!person) {
      unmatched.push({ name: p.name, employeeNo: p.employee_no, why: 'no one in HIVE has that employee number' });
      continue;
    }
    if (!onScheme.has(person.id)) {
      unmatched.push({ name: person.name, employeeNo: p.employee_no, why: `not on ${scheme.name}` });
      continue;
    }
    seen.add(person.id);
    const earned = round2(Number(p.earned) || 0);
    lines.push({
      staffId: person.id,
      name: person.name,
      maintenanceName: p.name,
      earned,
      budget: round2(Number(p.budget) || 0),
      // A score is what pays the figure earned. Capped at a hundred: the
      // scheme cannot pay more than its own worth.
      score: amount > 0 ? Math.min(100, round2((earned / amount) * 100)) : 0,
      capped: amount > 0 && earned > amount,
      weeks: (p.weeks ?? []).map((w) => ({
        week: w.week,
        jobs: w.jobs,
        done: w.done,
        rate: w.rate,
        earned: round2(Number(w.earned) || 0),
        limit: round2(Number(w.limit) || 0),
        why: w.why ?? null,
      })),
    });
  }
  // On the scheme, but not in what Maintenance sent: their box is left alone.
  const notSent = (scheme.staffIds ?? []).filter((id) => !seen.has(id))
    .map((id) => staff.find((s) => s.id === id)?.name ?? `Staff ${id}`);

  return {
    month: month.month,
    weeks: month.weeks ?? [],
    threshold: month.threshold ?? null,
    lines: lines.sort((a, b) => a.name.localeCompare(b.name)),
    unmatched,
    notSent,
  };
}
