import { badRequest, json, notFound, readJson, str } from '../lib/http.js';
import { MAIN, companies } from '../lib/companies.js';

/**
 * The companies people are employed by, as Settings lists and edits them.
 *
 * The main company's particulars are the Company form's, in the settings, and
 * are edited there; this only lists it. Every other company is edited here:
 * its registered name, its address and contacts, its TIN and SSNIT number and
 * the GRA office it files with, which head its payslips and its returns.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

async function settingsMap(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
  return Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
}

/** Every company, how many people each employs, and whether it has run a payroll. */
export async function listCompanies(ctx) {
  const settings = await settingsMap(ctx.db);
  const list = await companies(ctx.db, settings);
  const counts = await ctx.db.prepare(
    `SELECT COALESCE(company_id, ${MAIN}) AS company, COUNT(*) AS n
       FROM att_staff WHERE active = 1 GROUP BY COALESCE(company_id, ${MAIN})`,
  ).all().catch(() => ({ results: [] }));
  const runs = await ctx.db.prepare(
    'SELECT company_id AS company, COUNT(*) AS n FROM pay_run GROUP BY company_id',
  ).all().catch(() => ({ results: [] }));
  const people = new Map((counts.results ?? []).map((r) => [Number(r.company), Number(r.n)]));
  const paid = new Map((runs.results ?? []).map((r) => [Number(r.company), Number(r.n)]));
  return json({
    companies: list.map((c) => ({
      ...c,
      people: people.get(c.id) ?? 0,
      payrolls: paid.get(c.id) ?? 0,
    })),
  });
}

function readCompany(body) {
  const kind = String(body.taxOfficeKind ?? '').trim().toUpperCase();
  if (kind && !['LTO', 'TSC'].includes(kind)) throw badRequest('The tax office is either LTO or TSC.');
  return {
    legalName: str(body.legalName, 'Registered name', { required: true, max: 160 }),
    address: str(body.address, 'Address', { max: 300, fallback: '' }),
    phone: str(body.phone, 'Telephone', { max: 60, fallback: '' }),
    email: str(body.email, 'Email', { max: 120, fallback: '' }),
    website: str(body.website, 'Website', { max: 120, fallback: '' }),
    tin: str(body.tin, 'TIN', { max: 40, fallback: '' }),
    ssnit: str(body.ssnit, 'SSNIT employer number', { max: 40, fallback: '' }),
    taxOfficeKind: kind,
    taxOffice: str(body.taxOffice, 'Tax office', { max: 60, fallback: '' }),
  };
}

/** Another company. */
export async function createCompany(ctx) {
  const c = readCompany(await readJson(ctx.request));
  const row = await ctx.db.prepare(
    `INSERT INTO company (legal_name, address, phone, email, website, tin, ssnit,
                          tax_office_kind, tax_office, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`,
  ).bind(c.legalName, c.address, c.phone, c.email, c.website, c.tin, c.ssnit,
    c.taxOfficeKind, c.taxOffice, actorOf(ctx)).first();
  await audit(ctx, 'company.create', row.id, { legalName: c.legalName });
  return json({ ok: true, id: row.id });
}

/** Its particulars. The main company's are on the Company form instead. */
export async function updateCompany(ctx, idParam) {
  const id = Number(idParam);
  if (id === MAIN) throw badRequest('The main company is edited on the Company form.');
  const c = readCompany(await readJson(ctx.request));
  const done = await ctx.db.prepare(
    `UPDATE company SET legal_name = ?2, address = ?3, phone = ?4, email = ?5, website = ?6,
                        tin = ?7, ssnit = ?8, tax_office_kind = ?9, tax_office = ?10,
                        updated_by = ?11, updated_at = datetime('now')
      WHERE id = ?1 AND main = 0`,
  ).bind(id, c.legalName, c.address, c.phone, c.email, c.website, c.tin, c.ssnit,
    c.taxOfficeKind, c.taxOffice, actorOf(ctx)).run();
  if (!Number(done?.meta?.changes)) throw notFound('There is no such company.');
  await audit(ctx, 'company.update', id, { legalName: c.legalName });
  return json({ ok: true });
}

/**
 * Take one off again. Only one nobody is employed by and that has never run a
 * payroll: a company with payslips is a record of who paid whom.
 */
export async function removeCompany(ctx, idParam) {
  const id = Number(idParam);
  if (id === MAIN) throw badRequest('The main company cannot be removed.');
  const staff = await ctx.db.prepare('SELECT COUNT(*) AS n FROM att_staff WHERE company_id = ?')
    .bind(id).first();
  if (Number(staff?.n)) throw badRequest('People are still employed by it. Move them to another company first.');
  const runs = await ctx.db.prepare('SELECT COUNT(*) AS n FROM pay_run WHERE company_id = ?')
    .bind(id).first();
  if (Number(runs?.n)) throw badRequest('It has payrolls on record, so it stays.');
  const done = await ctx.db.prepare('DELETE FROM company WHERE id = ? AND main = 0').bind(id).run();
  if (!Number(done?.meta?.changes)) throw notFound('There is no such company.');
  await audit(ctx, 'company.remove', id, {});
  return json({ ok: true });
}
