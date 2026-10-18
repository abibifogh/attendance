import { badRequest } from './http.js';

/**
 * The companies people are employed by.
 *
 * Most of the property is employed by one company, whose particulars live in
 * the settings and always have. A second company has its own name, TIN, SSNIT
 * number and tax office, and its own payroll each month. Nobody is employed
 * by two at once, so a person's company decides which payroll they are on,
 * which name heads their payslip and which return they are filed on.
 */

/** The company the settings describe, which is everybody's unless said. */
export const MAIN = 1;

/** Which company somebody is employed by. */
export const companyOf = (person) => Number(person?.company_id) || MAIN;

/**
 * The key a month's run is stored under.
 *
 * pay_run.month is unique, and making it unique per company would mean
 * rebuilding a table four others cascade from. So the main company's month is
 * '2026-10', as it always was, and another company's is '2026-10@2'.
 */
export const runKey = (month, company = MAIN) => (Number(company) > MAIN
  ? `${month}@${Number(company)}`
  : month);

/** The month a run key is for. */
export const monthOfRun = (key) => String(key ?? '').slice(0, 7);

const clean = (v) => String(v ?? '').trim();

/**
 * One company, in the same shape whichever it is.
 *
 * The main one is read from the settings, so its Company form, its payslips and
 * the emails that carry its name have one place to look, as before.
 */
export function identityOf(row, settings = {}) {
  if (!row || row.main) {
    return {
      id: MAIN,
      main: true,
      legalName: clean(settings.company_legal_name) || clean(settings.property_name),
      address: clean(settings.property_address),
      phone: clean(settings.company_phone),
      email: clean(settings.company_email),
      website: clean(settings.company_website),
      tin: clean(settings.company_tin),
      ssnit: clean(settings.company_ssnit),
      taxOfficeKind: clean(settings.gra_tax_office_kind).toUpperCase(),
      taxOffice: clean(settings.gra_tax_office),
      logoAt: clean(settings.company_logo_at),
    };
  }
  return {
    id: Number(row.id),
    main: false,
    legalName: clean(row.legal_name),
    address: clean(row.address),
    phone: clean(row.phone),
    email: clean(row.email),
    website: clean(row.website),
    tin: clean(row.tin),
    ssnit: clean(row.ssnit),
    taxOfficeKind: clean(row.tax_office_kind).toUpperCase(),
    taxOffice: clean(row.tax_office),
    logoAt: clean(row.logo_at),
  };
}

/** Every company, the main one first. Just the main one before 0125 ran. */
export async function companies(db, settings = {}) {
  const rows = await db.prepare(
    `SELECT id, main, legal_name, address, phone, email, website, tin, ssnit,
            tax_office_kind, tax_office, logo_at
       FROM company ORDER BY main DESC, id`,
  ).all().catch(() => ({ results: [] }));
  const list = (rows.results ?? []).map((row) => identityOf(row, settings));
  return list.some((c) => c.main) ? list : [identityOf(null, settings), ...list];
}

/** One company by id, or the main one where it does not exist. */
export async function companyById(db, id, settings = {}) {
  const all = await companies(db, settings);
  return all.find((c) => c.id === Number(id)) ?? all.find((c) => c.main);
}

/**
 * The company a request is about, or a refusal.
 *
 * Read from the body or the address. Nothing said is the main company, so
 * every screen and link written before there were two keeps working.
 */
export async function companyAsked(db, asked, settings = {}) {
  if (asked == null || asked === '') return companyById(db, MAIN, settings);
  const id = Number(asked);
  const all = await companies(db, settings);
  const found = all.find((c) => c.id === id);
  if (!found) throw badRequest('There is no such company.');
  return found;
}
