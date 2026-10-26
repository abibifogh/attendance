/**
 * The details of an employee a contract can show, in its "Employee
 * particulars" box.
 *
 * A template says which; the office can change that for one person when it
 * issues one. The box is written into the contract's words as plain lines,
 * so it is signed and fingerprinted with everything else:
 *
 *   EMPLOYEE PARTICULARS
 *   Full name: Ama Owusu
 *   Employee number: FO014
 *
 * and every screen and the PDF draw those lines as a box. A detail that is
 * not on their record yet reads "To be given".
 */

export const HEADING = 'EMPLOYEE PARTICULARS';
export const NOT_GIVEN = 'To be given';

export const GROUPS = [
  ['work', 'Work'],
  ['identity', 'Identity'],
  ['contact', 'Contact'],
  ['statutory', 'Statutory'],
  ['emergency', 'Emergency'],
  ['pay', 'Pay'],
];

export const DETAILS = [
  { key: 'name', label: 'Full name', group: 'work', always: true },
  { key: 'employee_no', label: 'Employee number', group: 'work' },
  { key: 'job_title', label: 'Job title', group: 'work' },
  { key: 'department', label: 'Department', group: 'work' },
  { key: 'start_date', label: 'Start date', group: 'work' },
  { key: 'id_document', label: 'ID document', group: 'identity', private: true },
  { key: 'date_of_birth', label: 'Date of birth', group: 'identity' },
  { key: 'nationality', label: 'Nationality', group: 'identity' },
  { key: 'gender', label: 'Gender', group: 'identity' },
  { key: 'home_address', label: 'Home address', group: 'contact' },
  { key: 'digital_address', label: 'GhanaPost GPS', group: 'contact' },
  { key: 'personal_phone', label: 'Mobile', group: 'contact' },
  { key: 'personal_email', label: 'Email', group: 'contact' },
  { key: 'ssnit_number', label: 'SSNIT number', group: 'statutory', private: true },
  { key: 'tin_number', label: 'TIN', group: 'statutory', private: true },
  { key: 'next_of_kin', label: 'Next of kin', group: 'emergency' },
  { key: 'paid_into', label: 'Paid into', group: 'pay', private: true },
];

const KNOWN = new Map(DETAILS.map((d) => [d.key, d]));

/** A list of keys as given, cleaned: known ones only, in the standard order, full name first whenever any are. */
export function readKeys(value) {
  let list = value;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  const wanted = new Set((Array.isArray(list) ? list : []).filter((k) => KNOWN.has(k)));
  if (!wanted.size) return [];
  wanted.add('name');
  return DETAILS.filter((d) => wanted.has(d.key)).map((d) => d.key);
}

const sayDay = (day) => (/^\d{4}-\d{2}-\d{2}/.test(String(day ?? ''))
  ? new Date(`${String(day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
  : (day || null));
const clean = (v) => (String(v ?? '').replace(/\s+/g, ' ').trim() || null);
const tail4 = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits ? `ending ${digits.slice(-4)}` : null;
};

/**
 * Every detail's value for somebody, from their staff row, their profile and
 * their next of kin. `work` overrides the work details where an offer or an
 * issue already says them (the job on the offer, the start date given).
 */
export async function detailValues(db, person, work = {}) {
  const id = Number(person?.id) || 0;
  const profile = id
    ? await db.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').bind(id).first().catch(() => null)
    : null;
  const kin = id
    ? await db.prepare(
      `SELECT name, relationship, phone FROM hr_contact WHERE staff_id = ?
        ORDER BY kind = 'next_of_kin' DESC, sort_order, id LIMIT 1`,
    ).bind(id).first().catch(() => null)
    : null;
  const p = profile ?? {};
  const pay = /mobile/i.test(p.pay_method ?? '') || (!p.account_number && p.momo_number)
    ? [p.momo_network, tail4(p.momo_number)]
    : [p.bank_name, tail4(p.account_number)];
  return {
    name: clean(work.name ?? person?.name),
    employee_no: clean(work.employee_no ?? person?.employee_no),
    job_title: clean(work.job_title ?? person?.job_title),
    department: clean(work.department ?? person?.department),
    start_date: sayDay(work.start_date ?? person?.hired_on),
    id_document: clean([p.id_type, p.id_number].filter(Boolean).join(' ')),
    date_of_birth: sayDay(p.date_of_birth),
    nationality: clean(p.nationality),
    gender: clean(p.gender),
    home_address: clean([p.address_line, p.town, p.region].filter(Boolean).join(', ')),
    digital_address: clean(p.digital_address),
    personal_phone: clean(p.personal_phone),
    personal_email: clean(p.personal_email),
    ssnit_number: clean(p.ssnit_number),
    tin_number: clean(p.tin_number),
    next_of_kin: clean([kin?.name, kin?.relationship, kin?.phone].filter(Boolean).join(', ')),
    paid_into: clean(pay.filter(Boolean).join(', ')),
  };
}

/** The rows of the box, for the keys asked, each with its value or none. */
export function rowsFor(keys, values) {
  return readKeys(keys).map((key) => ({ key, label: KNOWN.get(key).label, value: values[key] ?? null }));
}

/** The box as the lines written into the contract, ending in a blank line. */
export function blockText(rows) {
  if (!rows?.length) return '';
  return `${HEADING}\n${rows.map((r) => `${r.label}: ${String(r.value ?? NOT_GIVEN).replace(/\n/g, ' ')}`).join('\n')}\n\n`;
}

/** The box back out of a contract's words: {rows: [{label, value}], rest}, or rows empty when there is none. */
export function splitParticulars(text) {
  const body = String(text ?? '');
  if (!body.startsWith(`${HEADING}\n`)) return { rows: [], rest: body };
  const end = body.indexOf('\n\n');
  const block = end === -1 ? body : body.slice(0, end);
  const rows = block.split('\n').slice(1).map((line) => {
    const at = line.indexOf(': ');
    return at === -1 ? { label: line, value: '' } : { label: line.slice(0, at), value: line.slice(at + 2) };
  });
  return { rows, rest: end === -1 ? '' : body.slice(end + 2) };
}
