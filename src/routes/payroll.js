import {
  badRequest, bool, csvResponse, forbidden as forbiddenHere, int, json, notFound, num, readJson, str,
} from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { emailPersonally, firstUsableEmail, isEmail } from '../lib/notify.js';
import { payslipFilename, payslipPdf } from '../lib/payslip-pdf.js';
import { companyLogoBytes } from './people.js';
import { sayMonth } from '../lib/email-design.js';
import { paidInMonth } from '../lib/leaving.js';
import { balanceOf, dueThisMonth, startsOn, tillMonthFor, whyNotDue } from '../lib/advances.js';
import { deferLateCharges } from '../lib/late-charges.js';
import {
  computeLine, partMonth, totalsOf,
} from '../lib/payroll.js';
import { ratesFrom, round2 } from '../lib/tax.js';
import {
  PAYE_COLUMNS, POSITIONS, RESIDENCIES, journalFor, payeSchedule, ssnitSchedule, tiersFrom,
} from '../lib/statutory.js';
import { ratesOn } from '../lib/tax-tables.js';
import { readSheet, tallyOf } from '../lib/pay-import.js';
import { askMaintenance, askMaintenancePenalties, cleanNo, scoresFor } from '../lib/maintenance-bonus.js';
import { inputSheet } from '../lib/pay-input-sheet.js';
import { isAdmin } from '../lib/payroll-access.js';
import {
  CODE_RULE, MAX_TRIES, OPEN_MINUTES, afterAWrongTry, codeIsObvious, codeLooksRight,
  minutesLeft, openUntil, readLock,
} from '../lib/payslip-lock.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { hasTiers, readTiers, tierAmount } from '../lib/pay-tiers.js';
import { S, colName, workbook } from '../lib/xlsx.js';
import { BANK_COLUMNS, BY_HAND_COLUMNS, bankFile } from '../lib/bank-file.js';
import { addMonths, isMonth, monthOf, todayIn } from '../util/dates.js';
import {
  MAIN, companies, companyAsked, companyById, companyOf, monthOfRun, runKey,
} from '../lib/companies.js';

/**
 * The payroll.
 *
 * Once a month everything the property already knows — what somebody is paid,
 * what they scored on their bonus schemes, what they were docked, what they
 * are paying back — is put through the tax law and comes out as a payslip.
 *
 * A FINALISED MONTH IS A SNAPSHOT. The whole computation is written down as it
 * stood, bands and all, and nothing recomputes it afterwards. A payslip is
 * handed over and argued about months later; one that quietly changed when
 * somebody's salary did would be worthless as a record.
 *
 * CLOSING THE PAYROLL IS WHAT RECORDS THE ADVANCE DEDUCTIONS. They are two
 * halves of the same act — the money comes off the payslip and off the balance
 * at the same moment — and doing it in one place is what stops the two ledgers
 * disagreeing. Reopening a month takes exactly those entries back off.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

async function settingsOf(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all()
    .catch(() => ({ results: [] }));
  const map = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return {
    timezone: map.timezone || 'UTC',
    currency: map.currency || 'GHS',
    property: map.property_name || null,
    rates: ratesFrom(map),
    tiers: tiersFrom(map),
    // Handed back whole as well, so a caller that needs the figures for one
    // particular month can work them out rather than taking today's.
    settings: map,
  };
}

/**
 * Whose payroll a request is about, worked out once and kept on the request.
 *
 * Asked for in the body or the address, and the main company where nothing
 * is said, so every link written before there were two companies still opens
 * the payroll it always did.
 */
async function useCompany(ctx, asked) {
  const { settings } = await settingsOf(ctx.db);
  const said = asked ?? ctx.url?.searchParams?.get('company') ?? null;
  ctx.company = await companyAsked(ctx.db, said, settings);
  return ctx.company;
}

const companyIdOf = (ctx) => ctx.company?.id ?? MAIN;

/** The heading a company's papers carry: its name, numbers and tax office. */
const employerOf = (ctx, data) => {
  const c = ctx.company ?? {};
  return {
    id: c.id ?? MAIN,
    name: c.legalName || data?.property || '',
    tin: c.tin ?? '',
    ssnit: c.ssnit ?? '',
    taxOffice: {
      kind: ['LTO', 'TSC'].includes(c.taxOfficeKind) ? c.taxOfficeKind : '',
      name: c.taxOffice ?? '',
    },
  };
};

const monthFrom = (url, timezone) => {
  const asked = url.searchParams.get('month');
  return isMonth(asked) ? asked : monthOf(todayIn(timezone));
};

/**
 * The run for a month, made if it is not there yet.
 *
 * `open: false` looks without touching. Reading last month to compare it with
 * this one must not open last month's payroll, which would put a draft run on
 * the books for a month nobody has been near.
 */
async function runFor(db, month, actor, { open = true, company = MAIN } = {}) {
  // Each company has its own run for the month, under its own key.
  const key = runKey(month, company);
  const found = await db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(key).first();
  if (found) return found;
  if (!open) return { id: -1, month: key, status: 'draft', company_id: company };

  await db.prepare('INSERT OR IGNORE INTO pay_run (month, opened_by, company_id) VALUES (?1, ?2, ?3)')
    .bind(key, actor, company).run();
  return db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(key).first();
}

/**
 * Everything one month needs, indexed: who is on the payroll, what they are
 * under, what they scored, what came off, and what they are repaying.
 */
async function gather(ctx, month, { open = true } = {}) {
  const { currency, property, settings } = await settingsOf(ctx.db);
  if (!ctx.company) await useCompany(ctx);
  const company = companyIdOf(ctx);

  // The figures that were in force in that month, not the ones in force today.
  // A budget moves the bands in April; March is still a March payroll, and a
  // month reopened in July to fix one allowance must not come back retaxed.
  const tables = await ctx.db.prepare('SELECT * FROM pay_rates').all()
    .catch(() => ({ results: [] }));
  const { rates, tiers, from: ratesFrom_ } = ratesOn(month, tables.results ?? [], settings);

  const run = await runFor(ctx.db, month, actorOf(ctx), { open, company });

  const [everybody, profiles, allowances, schemes, members, scores, penalties, severances,
    advances, entries, slips, credits, lates]
    = await Promise.all([
      ctx.db.prepare('SELECT id, name, department, job_title, employee_no, active, hired_on, left_on, company_id FROM att_staff ORDER BY name').all()
        // A database from before there were companies has no column to read.
        .catch(() => ctx.db.prepare('SELECT id, name, department, job_title, employee_no, active, hired_on, left_on FROM att_staff ORDER BY name').all()),
      ctx.db.prepare('SELECT * FROM pay_profile').all(),
      ctx.db.prepare('SELECT * FROM pay_allowance WHERE active = 1').all(),
      ctx.db.prepare(
        // Departments first, alphabetically, with the property-wide ones last
        // under General; the screen groups on this order rather than re-sorting.
        "SELECT * FROM pay_scheme ORDER BY COALESCE(NULLIF(department, ''), CHAR(255)), name",
      ).all(),
      ctx.db.prepare('SELECT * FROM pay_scheme_staff').all(),
      ctx.db.prepare('SELECT * FROM pay_score WHERE run_id = ?').bind(run.id).all(),
      ctx.db.prepare('SELECT * FROM pay_penalty WHERE run_id = ? ORDER BY id').bind(run.id).all(),
      ctx.db.prepare('SELECT * FROM pay_severance WHERE run_id = ? ORDER BY id').bind(run.id).all()
        .catch(() => ({ results: [] })),
      // Settled ones too, not only the ones still running. Recording the last
      // instalment settles an advance on the spot, so a one-month advance is
      // settled by its very first deduction — and leaving those out here is
      // what made that deduction vanish off the payslip. `dueThisMonth` is
      // what decides whether anything comes off; this only has to hand it
      // every advance that might have an answer against the month.
      ctx.db.prepare(
        `SELECT * FROM hr_advance
          WHERE status IN ('approved', 'settled')`,
      ).all().catch(() => ({ results: [] })),
      ctx.db.prepare('SELECT * FROM hr_advance_entry').all().catch(() => ({ results: [] })),
      ctx.db.prepare('SELECT * FROM pay_slip WHERE run_id = ?').bind(run.id).all(),
      // Till surpluses paid with this month's pay.
      ctx.db.prepare("SELECT * FROM till_credit WHERE month = ? AND status = 'due' ORDER BY id").bind(month).all()
        .catch(() => ({ results: [] })),
      // Late charges coming off this month's pay: kept, or not looked at yet.
      ctx.db.prepare("SELECT * FROM late_charge WHERE month = ? AND status IN ('open', 'kept') ORDER BY day, id").bind(month).all()
        .catch(() => ({ results: [] })),
    ]);

  // This company's people, and anybody already on one of its payslips this
  // month: a slip is a record of who was paid by whom, and somebody moved to
  // the other company since stays on the one that paid them.
  const slipped = new Set((slips.results ?? []).map((s) => s.staff_id));
  const staff = {
    results: (everybody.results ?? [])
      .filter((p) => companyOf(p) === company || slipped.has(p.id)),
  };
  const ours = new Set(staff.results.map((p) => p.id));

  // What has already gone out as bonus this year, which the 15% ceiling on the
  // five per cent rate is measured against.
  const year = month.slice(0, 4);
  const earlier = await ctx.db.prepare(
    `SELECT s.staff_id, SUM(s.bonus_gross) AS paid
       FROM pay_slip s JOIN pay_run r ON r.id = s.run_id
      WHERE r.status = 'final' AND r.month LIKE ?1 AND substr(r.month, 1, 7) < ?2
        AND r.company_id = ?3
      GROUP BY s.staff_id`,
  ).bind(`${year}-%`, month, company).all().catch(() => ({ results: [] }));

  // Plus whatever was paid before this app was keeping the ledger. Only
  // counted for the year it was written against, so it stops mattering on its
  // own when January comes round.
  const opening = new Map((profiles.results ?? [])
    .filter((p) => String(p.bonus_opening_year ?? '') === year)
    .map((p) => [p.staff_id, round2(p.bonus_opening)]));

  const entriesBy = new Map();
  for (const entry of entries.results ?? []) {
    if (!entriesBy.has(entry.advance_id)) entriesBy.set(entry.advance_id, []);
    entriesBy.get(entry.advance_id).push(entry);
  }

  return {
    run,
    rates,
    tiers,
    // Which dated table answered for this month, so a screen can say so. Null
    // means the property has never dated one and there is only ever the set of
    // figures it is using now.
    ratesFrom: ratesFrom_,
    currency,
    property,
    staff: (staff.results ?? []),
    profileBy: new Map((profiles.results ?? []).map((p) => [p.staff_id, p])),
    allowanceBy: group(allowances.results ?? [], 'staff_id'),
    schemes: schemes.results ?? [],
    memberBy: group(members.results ?? [], 'scheme_id'),
    scores: scores.results ?? [],
    penalties: penalties.results ?? [],
    severances: severances.results ?? [],
    // Only this company's people's. Another company's advance is not
    // something this payroll could take anything off.
    advances: (advances.results ?? []).filter((a) => ours.has(a.staff_id)),
    entriesBy,
    creditsBy: group((credits.results ?? []).filter((c) => ours.has(c.staff_id)), 'staff_id'),
    latesBy: group((lates.results ?? []).filter((c) => ours.has(c.staff_id)), 'staff_id'),
    slipBy: new Map((slips.results ?? []).map((s) => [s.staff_id, s])),
    paidBy: new Map((staff.results ?? []).map((person) => {
      const closed = (earlier.results ?? []).find((r) => r.staff_id === person.id);
      return [person.id, round2(round2(closed?.paid ?? 0) + (opening.get(person.id) ?? 0))];
    })),
    // What of that came from before this app, so a screen can say so rather
    // than leaving somebody to wonder where a figure came from.
    openingBy: opening,
  };
}

/**
 * The departments a scheme covers, however the row stores them.
 *
 * A row written before schemes could span more than one has the single column
 * filled in and the list empty, and it means the same thing.
 */
function readDepartments(scheme) {
  const raw = scheme?.departments;
  let list = null;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = null;
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  }

  const names = (list ?? [scheme?.department])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

const group = (rows, key) => {
  const out = new Map();
  for (const row of rows) {
    if (!out.has(row[key])) out.set(row[key], []);
    out.get(row[key]).push(row);
  }
  return out;
};

/** Everybody's line for the month, worked out fresh. */
function linesFrom(data, month) {
  const scoreBy = new Map();
  for (const row of data.scores) scoreBy.set(`${row.scheme_id}|${row.staff_id}`, row);

  const memberOf = new Map();
  for (const [schemeId, rows] of data.memberBy.entries()) {
    for (const row of rows) {
      if (!memberOf.has(row.staff_id)) memberOf.set(row.staff_id, []);
      memberOf.get(row.staff_id).push(schemeId);
    }
  }

  const penaltyBy = group(data.penalties, 'staff_id');
  const schemeById = new Map(data.schemes.map((s) => [s.id, s]));

  const lines = [];
  for (const person of data.staff) {
    const profile = data.profileBy.get(person.id);
    // Nobody is on the payroll until somebody has said what they are paid.
    // Guessing at a basic salary is the one thing a payroll must never do.
    if (!profile) continue;
    // Somebody who has left is paid for the month they left in and then no
    // more; a slip already made for them stands whatever the date says.
    if (!paidInMonth(person, month) && !data.slipBy.has(person.id)) continue;

    const schemes = (memberOf.get(person.id) ?? []).map((schemeId) => {
      const scheme = schemeById.get(schemeId);
      if (!scheme || !scheme.active) return null;
      const scored = scoreBy.get(`${schemeId}|${person.id}`);
      return {
        id: scheme.id,
        name: scheme.name,
        // The award as it was when the score was given, where one has been.
        amount: round2(scored?.amount ?? scheme.amount),
        score: round2(scored?.score ?? 0),
      };
    }).filter(Boolean);

    const loans = [];
    for (const advance of data.advances) {
      if (advance.staff_id !== person.id) continue;
      const entries = data.entriesBy.get(advance.id) ?? [];
      const due = dueThisMonth(advance, entries, month);
      if (!due) continue;
      loans.push({
        advanceId: advance.id,
        amount: due,
        left: balanceOf(advance, entries),
        what: advance.purpose ?? null,
      });
    }

    lines.push(computeLine({
      staff: {
        id: person.id,
        name: person.name,
        department: person.department ?? null,
        employeeNo: person.employee_no ?? null,
      },
      basic: profile.basic,
      allowances: (data.allowanceBy.get(person.id) ?? []).map((a) => ({
        name: a.name, amount: a.amount, taxable: a.taxable,
      })),
      // Somebody who started or left inside the month is paid for the days
      // they were here. Null for everybody else, which leaves the line alone.
      partMonth: partMonth({ month, hiredOn: person.hired_on, leftOn: person.left_on }),
      ssnit: Boolean(profile.ssnit),
      schemes,
      penalties: (penaltyBy.get(person.id) ?? []).map((p) => ({
        id: p.id, amount: p.amount, reason: p.reason, at: p.at,
      })),
      loans,
      tillCredits: (data.creditsBy?.get(person.id) ?? []).map((c) => ({
        creditId: c.id, amount: Number(c.amount), reason: c.reason ?? null, day: c.till_day ?? null, slot: c.till_slot ?? null,
      })),
      lateCharges: (data.latesBy?.get(person.id) ?? []).map((c) => ({
        chargeId: c.id, amount: Number(c.amount), day: c.day, clockIn: c.clock_in ?? null,
        minutes: Number(c.minutes_late) || 0, shift: c.shift_name ?? null, status: c.status,
      })),
      annualBasic: round2(profile.basic * 12),
      bonusPaidThisYear: data.paidBy.get(person.id) ?? 0,
      // Older profiles have nothing written here and every figure in them was
      // entered as a net promise, so the absence reads as net.
      bonusIsNet: profile.bonus_is_net == null ? true : Boolean(profile.bonus_is_net),
      // What they take home, where one has been agreed, and what that figure
      // means. 'fixed' is the part before the bonus, with the month's scored
      // bonus added on top; anything else is the whole amount, bonus included.
      takeHome: profile.take_home == null ? null : round2(profile.take_home),
      takeHomeBasis: profile.take_home_basis === 'fixed' ? 'fixed' : 'total',
      // What the GRA has issued them a certificate for. Off before the bands,
      // like the pension, and nought for almost everybody.
      relief: round2(profile.gra_relief ?? 0),
      // Which footing they are taxed on. Anything but full time and resident in
      // their main job is a flat rate on the GRA's schedule.
      residency: profile.gra_residency ?? '',
      rates: data.rates,
      tiers: data.tiers,
    }));
  }

  return lines;
}

// --------------------------------------------------------------------------
// The month
// --------------------------------------------------------------------------

/**
 * A month's lines, however that month stands.
 *
 * A closed month answers from what was written down, an open one from what the
 * figures say today. The same rule wherever a month is read, so a comparison
 * against March cannot disagree with the March screen.
 */
function linesOf(data, month) {
  return data.run.status === 'final'
    ? data.staff
      .map((person) => data.slipBy.get(person.id))
      .filter(Boolean)
      .map((slip) => JSON.parse(slip.detail))
    : linesFrom(data, month);
}

/**
 * What each person's net pay was in another month, and how far this one has
 * moved from it.
 *
 * Somebody's net moves for a dozen reasons — a bonus month, an advance that
 * finished, a rate change, three days of unpaid leave — and the payroll screen
 * showed a column of figures with nothing to read them against. A per cent
 * against last month is the one number that says which lines are worth
 * looking at before the month is closed.
 *
 * Nothing is opened by asking: the month being compared against is read
 * without a run being made for it.
 */
async function against(ctx, month, asked) {
  const other = isMonth(asked) ? asked : addMonths(month, -1);
  if (other === month) {
    return { month: other, netBy: new Map(), costBy: new Map(), status: null };
  }

  const data = await gather(ctx, other, { open: false });

  // A month nobody ever opened has no payroll to compare with. Working one out
  // from today's standing figures would answer "nothing has changed" about a
  // month nobody was paid in — and against a month two years back, where every
  // salary has moved since, that reading is not just useless but wrong.
  if (data.run.id === -1) {
    return { month: other, netBy: new Map(), costBy: new Map(), status: 'none' };
  }

  const then = linesOf(data, other);
  const netBy = new Map(then.map((line) => [line.staff.id, round2(line.net)]));
  // What the month cost as well as what went out in it. They move apart:
  // taking somebody off SSNIT or paying a bonus gross costs the property less
  // without changing anybody's pay, and a wage bill that reads only the net
  // never shows it.
  const costBy = new Map(then.map((line) => [line.staff.id, round2(line.employerCost)]));
  return {
    month: other,
    netBy,
    costBy,
    // Whether the figures being compared against are settled or still moving.
    status: data.run.status,
  };
}

/** This month's net beside another month's, as a per cent. */
export function movement(now, before) {
  if (before == null) return null;
  const was = round2(before);
  const net = round2(now);
  if (Math.abs(was) < 0.005) {
    // Nothing to be a per cent of. Said as new rather than as an infinite
    // rise, which is a number nobody can act on.
    return { was, change: net, percent: null, from: 'nothing' };
  }
  return {
    was,
    change: round2(net - was),
    percent: round2(((net - was) / Math.abs(was)) * 100),
    from: null,
  };
}

/** The whole month: the people, the schemes, the figures and the totals. */
export async function payroll(ctx) {
  const { timezone } = await settingsOf(ctx.db);
  const month = monthFrom(ctx.url, timezone);
  const data = await gather(ctx, month);
  const howTheyArePaid = await howEverybodyIsPaid(ctx.db);

  // A closed month answers from what was written down, not from what the
  // figures happen to say today.
  const closed = data.run.status === 'final';
  const lines = linesOf(data, month);

  // Against another month, so a figure has something to be read beside. Last
  // month unless somebody asked for a different one.
  const compare = await against(ctx, month, ctx.url.searchParams.get('compare'));
  for (const line of lines) {
    line.against = movement(line.net, compare.netBy.get(line.staff.id));
    line.againstCost = movement(line.employerCost, compare.costBy.get(line.staff.id));
  }

  const memberOf = new Map();
  for (const [schemeId, rows] of data.memberBy.entries()) {
    for (const row of rows) {
      if (!memberOf.has(row.staff_id)) memberOf.set(row.staff_id, []);
      memberOf.get(row.staff_id).push(schemeId);
    }
  }
  const scoreBy = new Map(data.scores.map((r) => [`${r.scheme_id}|${r.staff_id}`, r.score]));
  // The award as it stood when the score was given. On a scheme that pays a
  // set figure this is the figure itself, which is what the screen edits.
  const awardBy = new Map(data.scores.map((r) => [`${r.scheme_id}|${r.staff_id}`, r.amount]));
  // Which rung of a tiered scheme somebody was put on. Null everywhere else.
  const tierBy = new Map(data.scores.map((r) => [`${r.scheme_id}|${r.staff_id}`, r.tier]));

  const { settings: all } = await settingsOf(ctx.db);
  return json({
    month,
    currency: data.currency,
    property: data.property,
    // Whose payroll this is, and the others there are to switch to. One
    // company is the ordinary case, and the screen shows no switch for it.
    company: ctx.company,
    companies: (await companies(ctx.db, all)).map((c) => ({ id: c.id, name: c.legalName || data.property || 'The main company', main: c.main })),
    status: data.run.status,
    closedBy: data.run.closed_by,
    closedAt: data.run.closed_at,
    rates: {
      label: data.rates.label,
      ssnitEmployee: data.rates.ssnitEmployee,
      ssnitEmployer: data.rates.ssnitEmployer,
      bonusFinalRate: data.rates.bonusFinalRate,
      bonusShareOfBasic: data.rates.bonusShareOfBasic,
      // Whether that share is read against the month being paid or the year,
      // because it decides whether a running total is worth asking about.
      bonusCapBasis: data.rates.bonusCapBasis,
      bands: data.rates.bands,
      // The month a dated table started. Null where the property has never
      // dated one, which means the figures it is using now are the only ones
      // it has ever used.
      from: data.ratesFrom,
    },
    // Which month the per cent beside each net is measured against, and how
    // settled those figures are.
    compare: {
      month: compare.month,
      status: compare.status,
      people: compare.netBy.size,
    },
    // Everything the table needs, and for anybody but an administrator nothing
    // the payslip would have added.
    lines: isAdmin(ctx.session) ? lines : lines.map(withoutTheSlip),
    slips: isAdmin(ctx.session),
    totals: totalsOf(lines),
    // Anybody with an advance running that nothing is coming off this month,
    // and why. Nought in the Advance column is several situations wearing the
    // same face, and "not until 2026-09" and "somebody let this one go" are
    // not the same news. Only the ones with a reason: an advance being
    // deducted normally has nothing to explain.
    //
    // Nothing at all on a closed month. The table there is the snapshot that
    // was written, and a note worked out from the books as they stand today
    // would be explaining figures the table is not showing.
    advancesNotDue: closed ? [] : (() => {
      const nameOf = new Map(data.staff.map((p) => [p.id, p.name]));
      const onPayroll = new Set(lines.map((line) => line.staff.id));
      const out = [];
      for (const advance of data.advances) {
        const entries = data.entriesBy.get(advance.id) ?? [];
        let why = whyNotDue(advance, entries, month);

        // Somebody with an advance who is not on the payroll at all. Nobody
        // has said what they are paid, so there is no line for a deduction to
        // come off, and until now nothing anywhere said so: the advance sat on
        // the Advances screen with August against it in its own schedule, and
        // the payroll simply had no row for them. Only worth saying where the
        // deduction would otherwise be due, or it is noise about an advance
        // that is not due anyway.
        if (!onPayroll.has(advance.staff_id)) {
          if (why !== null) continue;
          why = 'not_on_payroll';
        }

        if (!why || why === 'paid_off' || why === 'closed') continue;
        out.push({
          staffId: advance.staff_id,
          name: nameOf.get(advance.staff_id) ?? 'Somebody',
          why,
          // Only meaningful against 'not_yet', and the screen writes it out in
          // words rather than showing somebody "2026-09".
          from: startsOn(advance),
          monthly: round2(advance.monthly),
          left: balanceOf(advance, entries),
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    })(),

    // A closed month whose books have moved since it was closed.
    //
    // THE TABLE ON A CLOSED MONTH IS A SNAPSHOT, and correctly so: a payslip
    // handed over in September must not change because somebody edited an
    // advance in October. But somebody who has just gone to the Advances page,
    // let a month go, and come back to find the payroll still showing the
    // deduction has been told nothing at all, and the reasonable conclusion is
    // that the app ignored them. It did not: the month is closed, and closing
    // is what makes a figure stop moving. So say it, name them, and say what
    // takes the change up.
    advancesChanged: !closed ? [] : (() => {
      const out = [];
      for (const line of lines) {
        const mine = data.advances.filter((a) => a.staff_id === line.staff.id);
        if (!mine.length) continue;
        const now = round2(mine.reduce((n, advance) => n + dueThisMonth(
          advance, data.entriesBy.get(advance.id) ?? [], month,
        ), 0));
        const was = round2(line.loanTotal ?? 0);
        if (Math.abs(now - was) < 0.005) continue;
        out.push({ staffId: line.staff.id, name: line.staff.name, was, now });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    })(),

    // How the month would leave the building. Counted here rather than on the
    // screen so the note above the table and the file itself cannot disagree,
    // and so somebody set to be paid by bank with no account number is visible
    // before the file is made rather than after the bank rejects the line.
    bank: (() => {
      const file = bankFile(lines, howTheyArePaid, { month });
      return {
        toBank: file.rows.length,
        toBankTotal: file.total,
        byHand: file.byHand.length,
        byHandTotal: file.byHandTotal,
        missingAccounts: file.missingAccounts,
        // Named, because "three people" does not tell anybody whose record to
        // open, and these are the ones who will not be paid.
        missing: file.byHand.filter((r) => r.how === 'no-account').map((r) => r.name),
        reference: file.reference,
      };
    })(),
    schemes: data.schemes.map((scheme) => ({
      id: scheme.id,
      name: scheme.name,
      note: scheme.note,
      department: scheme.department || null,
      // The whole set it covers. A scheme can span two departments, and the
      // single name above is only what a row written before that says.
      departments: readDepartments(scheme),
      // 'score' is scored out of a hundred; 'amount' is a figure a person;
      // 'tier' is a score off a ladder that says what each one is worth.
      kind: ['amount', 'tier'].includes(scheme.kind) ? scheme.kind : 'score',
      amount: round2(scheme.amount),
      tiers: readTiers(scheme.tiers),
      active: Boolean(scheme.active),
      staffIds: (data.memberBy.get(scheme.id) ?? []).map((m) => m.staff_id),
      scores: (data.memberBy.get(scheme.id) ?? []).map((m) => {
        const award = awardBy.get(`${scheme.id}|${m.staff_id}`);
        const tier = tierBy.get(`${scheme.id}|${m.staff_id}`);
        return {
          staffId: m.staff_id,
          score: round2(scoreBy.get(`${scheme.id}|${m.staff_id}`) ?? 0),
          // Null where nothing has been set for them this month, so a screen
          // can tell "nought" from "not answered yet".
          award: award == null ? null : round2(award),
          tier: tier == null ? null : round2(tier),
        };
      }),
    })),
    // What the GRA form will take in its two columns that are a choice rather
    // than a figure. Sent from here so the screen and the return cannot drift.
    positions: POSITIONS,
    residencies: RESIDENCIES,
    penalties: data.penalties.map((p) => ({
      id: p.id, staffId: p.staff_id, amount: round2(p.amount), reason: p.reason, at: p.at,
    })),
    severances: (data.severances ?? []).map((v) => ({
      id: v.id, staffId: v.staff_id, amount: round2(v.amount), note: v.note, at: v.at,
    })),
    // Everybody, for the screens that set things up: who is on the payroll and
    // who is not yet.
    staff: data.staff.filter((s) => s.active).map((person) => {
      const profile = data.profileBy.get(person.id);
      return {
        id: person.id,
        name: person.name,
        department: person.department ?? null,
        onPayroll: Boolean(profile),
        basic: profile ? round2(profile.basic) : null,
        ssnit: profile ? Boolean(profile.ssnit) : true,
        // Whether their bonus figures are what they receive or what is taxed.
        bonusIsNet: profile ? profile.bonus_is_net == null || Boolean(profile.bonus_is_net) : true,
        // Null where nobody has agreed one, which is the ordinary case and
        // means their scores decide the bonus.
        takeHome: profile?.take_home == null ? null : round2(profile.take_home),
        // Whether that figure is before the bonus, with the month's bonus
        // added on top, or the whole amount with the bonus inside it.
        takeHomeFixed: profile?.take_home_basis === 'fixed',
        // What the GRA form says about them. Empty means nobody has said, and
        // the form falls back to the job title and to resident and full time.
        graPosition: profile?.gra_position ?? '',
        graResidency: profile?.gra_residency ?? '',
        graRelief: round2(profile?.gra_relief ?? 0),
        jobTitle: person.job_title ?? null,
        // What they had as bonus before this app was keeping the year's
        // running total. Nought where it was written against another year,
        // so it stops counting on its own.
        bonusOpening: round2(data.openingBy?.get(person.id) ?? 0),
        allowances: (data.allowanceBy.get(person.id) ?? []).map((a) => ({
          id: a.id, name: a.name, amount: round2(a.amount), taxable: Boolean(a.taxable),
        })),
        schemeIds: memberOf.get(person.id) ?? [],
      };
    }),
  });
}

/** One payslip, in full. */
// ---------------------------------------------------------------------------
// The month's input, out of a spreadsheet
// ---------------------------------------------------------------------------

/**
 * Everything the sheet is read against: who is here, what they are on, what
 * they are under, and what the payroll is going to take off them anyway.
 */
async function sheetContext(ctx, month) {
  const data = await gather(ctx, month);

  const memberOf = new Map();
  for (const [schemeId, rows] of data.memberBy.entries()) {
    for (const row of rows) {
      if (!memberOf.has(row.staff_id)) memberOf.set(row.staff_id, []);
      memberOf.get(row.staff_id).push(schemeId);
    }
  }

  const advanceDue = new Map();
  // Who has one at all, which is a different question from what is due this
  // month: an advance can be settled, or not due to start until August, and
  // "nothing due" for those two reasons wants two different sentences.
  const advanceHeld = new Set();
  for (const advance of data.advances) {
    advanceHeld.add(advance.staff_id);
    const due = dueThisMonth(advance, data.entriesBy.get(advance.id) ?? [], month);
    if (!due) continue;
    advanceDue.set(advance.staff_id, round2((advanceDue.get(advance.staff_id) ?? 0) + due));
  }

  // Every allowance the property actually uses, so the columns are its own
  // words rather than a format somebody has to learn.
  const names = new Map();
  for (const rows of data.allowanceBy.values()) {
    for (const row of rows) if (!names.has(row.name)) names.set(row.name, row.name);
  }

  return {
    data,
    month,
    staff: data.staff,
    allowances: [...names.values()].sort((a, b) => a.localeCompare(b)),
    // Retired ones too, so a column named after one is matched rather than
    // read as a scheme the property has not got. Setting a figure on a retired
    // scheme pays nothing, and being told that is better than being quietly
    // handed a second scheme with the same name.
    schemes: data.schemes.map((s) => ({
      id: s.id,
      name: s.name,
      kind: ['amount', 'tier'].includes(s.kind) ? s.kind : 'score',
      tiers: readTiers(s.tiers),
      active: Boolean(s.active),
    })),
    profiles: data.profileBy,
    allowanceBy: data.allowanceBy,
    scoreBy: new Map(data.scores.map((r) => [`${r.scheme_id}|${r.staff_id}`, r.score])),
    // The rung somebody is on, which is the cell a tiered scheme's column
    // holds rather than a percentage or a figure.
    tierBy: new Map(data.scores
      .filter((r) => r.tier != null)
      .map((r) => [`${r.scheme_id}|${r.staff_id}`, round2(r.tier)])),
    // What each person is down for on a scheme that pays a set figure, which
    // is the cell the sheet holds rather than a percentage.
    awardBy: new Map(data.scores
      .filter((r) => r.amount != null)
      .map((r) => [`${r.scheme_id}|${r.staff_id}`, round2(r.amount)])),
    memberOf,
    advanceDue,
    advanceHeld,
    // What each person gets at a full score on each scheme: the award as it
    // was when they were scored, else the scheme's own. A column of money is
    // turned back into a score against this.
    worthBy: new Map(data.schemes.flatMap((scheme) => (data.memberBy.get(scheme.id) ?? [])
      .map((m) => {
        const held = data.scores.find((r) => r.scheme_id === scheme.id && r.staff_id === m.staff_id);
        return [`${scheme.id}|${m.staff_id}`, round2(held?.amount ?? scheme.amount ?? 0)];
      }))),
    // What is docked off each person's bonus this month, and how much of that
    // came from a sheet rather than being entered with a reason.
    deductionBy: (data.penalties ?? []).reduce((map, p) => {
      const mine = map.get(p.staff_id) ?? { total: 0, fromSheet: 0 };
      mine.total = round2(mine.total + round2(p.amount));
      if (p.reason === FROM_THE_SHEET) mine.fromSheet = round2(mine.fromSheet + round2(p.amount));
      map.set(p.staff_id, mine);
      return map;
    }, new Map()),
  };
}

/** The reason on a deduction set from the payroll sheet, so the next sheet can replace it. */
const FROM_THE_SHEET = 'Deductions on the payroll sheet';

/**
 * This month's sheet, already filled in.
 *
 * Not a blank template. Somebody downloads the month as it stands, changes the
 * two figures that changed, and sends it back — which is both less typing and
 * a great deal less to get wrong than a form with the headings and nothing
 * under them.
 */
export async function inputTemplate(ctx) {
  const { timezone, currency, property, settings } = await settingsOf(ctx.db);
  const month = monthFrom(ctx.url, timezone);
  const c = await sheetContext(ctx, month);

  // The spreadsheet, laid out like the office's own bonus sheet, unless a
  // plain CSV is asked for by something that only reads those.
  if (ctx.url.searchParams.get('as') !== 'csv') {
    const lines = linesOf(c.data, month);
    const lineBy = new Map(lines.map((l) => [l.staff.id, l]));
    const people = [];
    for (const person of c.staff) {
      const line = lineBy.get(person.id);
      const profile = c.profiles.get(person.id);
      if (!line || !profile) continue;
      people.push({
        id: person.id,
        employeeNo: person.employee_no ?? '',
        name: person.name,
        department: person.department ?? null,
        basic: round2(profile.basic),
        takeHome: profile.take_home == null ? null : round2(profile.take_home),
        takeHomeFixed: profile.take_home_basis === 'fixed',
        schemes: line.bonus?.schemes ?? [],
      });
    }
    const deductionBy = new Map();
    for (const p of c.data.penalties ?? []) {
      deductionBy.set(p.staff_id, round2((deductionBy.get(p.staff_id) ?? 0) + round2(p.amount)));
    }
    const employer = ctx.company?.legalName || settings.company_name || property || 'Payroll';
    const sheet = inputSheet({
      title: `${employer} \u2014 payroll input for ${month}`,
      month,
      currency,
      people,
      schemes: c.data.schemes.map((s) => ({
        id: s.id, name: s.name, active: Boolean(s.active), departments: readDepartments(s),
      })),
      departmentOrder: String(settings.att_departments ?? '').split('\n').map((d) => d.trim()).filter(Boolean),
      allowances: c.allowances,
      allowanceBy: c.allowanceBy,
      deductionBy,
      advanceDue: c.advanceDue,
    });
    return new Response(workbook([sheet]), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="payroll-input-${month}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const header = [
    'Employee no', 'Name', 'Basic',
    ...c.allowances.map((name) => `Allowance: ${name}`),
    // A scheme that pays a set figure holds money, so the column says Bonus
    // rather than Score. Reading it back does not depend on the word: the
    // scheme is found by name and its own kind decides what the cell means.
    ...c.schemes.map((s) => `${s.kind === 'amount' ? 'Bonus' : 'Score'}: ${s.name}`),
    'Advance',
  ];

  const rows = [header];
  for (const person of c.staff) {
    if (!paidInMonth(person, month)) continue;
    const profile = c.profiles.get(person.id);
    if (!profile) continue;

    const mine = c.allowanceBy.get(person.id) ?? [];
    const under = c.memberOf.get(person.id) ?? [];

    rows.push([
      person.employee_no ?? '',
      person.name,
      round2(profile.basic).toFixed(2),
      ...c.allowances.map((name) => {
        const found = mine.find((a) => a.name === name);
        return found ? round2(found.amount).toFixed(2) : '';
      }),
      // Blank against a scheme somebody is not under, so nobody scores
      // somebody on something they are not on.
      ...c.schemes.map((s) => {
        if (!under.includes(s.id)) return '';
        // A tiered scheme's column is the rung, blank where nobody has picked
        // one, because a nought would read as a deliberate bottom score.
        if (s.kind === 'tier') {
          const tier = c.tierBy.get(`${s.id}|${person.id}`);
          return tier == null ? '' : String(tier);
        }
        if (s.kind !== 'amount') return round2(c.scoreBy.get(`${s.id}|${person.id}`) ?? 0).toFixed(2);
        // Blank where nobody has been set a figure yet, rather than nought,
        // which would read as a deliberate nothing.
        const award = c.awardBy.get(`${s.id}|${person.id}`);
        return award == null ? '' : round2(award).toFixed(2);
      }),
      round2(c.advanceDue.get(person.id) ?? 0).toFixed(2),
    ]);
  }

  return csvResponse(`payroll-${month}.csv`, rows);
}

/** What the file would do, said before anything is done. */
/** The file as it came: a spreadsheet's rows, or a CSV's text. */
function inputOf(body) {
  if (Array.isArray(body.rows)) {
    if (!body.rows.length) throw badRequest('There is nothing in that file.');
    if (body.rows.length > 2000) throw badRequest('That sheet is longer than a payroll can be.');
    return body.rows.map((r) => (Array.isArray(r) ? r.slice(0, 200) : []));
  }
  const text = String(body.text ?? '');
  if (!text.trim()) throw badRequest('There is nothing in that file.');
  return text;
}

export async function readInput(ctx) {
  const body = await readJson(ctx.request);
  const text = inputOf(body);

  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);
  const c = await sheetContext(ctx, month);

  const read = readSheet(text, c);
  return json({ month, ...read, tally: tallyOf(read) });
}

/**
 * And then do it.
 *
 * The file is read again here rather than trusting a list of changes posted
 * back from a screen, because the payroll may have moved between the preview
 * and the button and the second read is the one that counts.
 */
export async function applyInput(ctx) {
  const body = await readJson(ctx.request);
  const text = inputOf(body);

  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);
  const c = await sheetContext(ctx, month);
  if (c.data.run.status === 'final') {
    throw badRequest('That month is closed. Open it again before changing anything in it.');
  }

  const read = readSheet(text, c);
  const run = await runFor(ctx.db, month, actorOf(ctx), { company: companyIdOf(ctx) });
  const actor = actorOf(ctx);

  // An allowance or a bonus scheme the property has not got is made only when
  // somebody has said so. The preview names each one; this is the answer to
  // it, and without it those columns are left alone exactly as they were.
  const make = body.create === true;
  const wanted = read.willCreate ?? { allowances: [], schemes: [] };
  const made = { allowances: [], schemes: [] };

  // A scheme has to exist before a figure can be set against it, and it has to
  // know who is under it — everybody the file names a figure for.
  const schemeIdByName = new Map();
  if (make) {
    for (const scheme of wanted.schemes) {
      const under = [...new Set(read.lines
        .filter((l) => l.changes.some((ch) => ch.isNew && ch.schemeName === scheme.name))
        .map((l) => l.staffId))];

      const row = await ctx.db.prepare(
        `INSERT INTO pay_scheme (name, amount, note, kind) VALUES (?1, 0, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET name = name
         RETURNING id`,
      ).bind(scheme.name, 'Brought in from a spreadsheet', scheme.kind).first().catch(() => null);
      if (!row?.id) continue;

      schemeIdByName.set(scheme.name, row.id);
      for (const staffId of under) {
        await ctx.db.prepare(
          'INSERT OR IGNORE INTO pay_scheme_staff (scheme_id, staff_id) VALUES (?1, ?2)',
        ).bind(row.id, staffId).run().catch(() => {});
      }
      made.schemes.push({ name: scheme.name, people: under.length });
    }
  }

  let basics = 0;
  let allowances = 0;
  let scores = 0;
  let takeHomes = 0;
  let deductions = 0;
  const notMade = [];

  for (const line of read.lines) {
    for (const change of line.changes) {
      if (change.kind === 'takeHome') {
        // Taking a take-home away takes what it meant with it.
        await ctx.db.prepare(
          `UPDATE pay_profile SET take_home = ?2,
             take_home_basis = CASE WHEN ?2 IS NULL THEN NULL ELSE take_home_basis END,
             set_by = ?3, set_at = datetime('now') WHERE staff_id = ?1`,
        ).bind(line.staffId, change.to, actor).run();
        takeHomes += 1;
        continue;
      }
      if (change.kind === 'takeHomeBasis') {
        await ctx.db.prepare(
          `UPDATE pay_profile SET take_home_basis = ?2, set_by = ?3, set_at = datetime('now')
            WHERE staff_id = ?1 AND take_home IS NOT NULL`,
        ).bind(line.staffId, change.fixed ? 'fixed' : null, actor).run();
        takeHomes += 1;
        continue;
      }
      if (change.kind === 'deduction') {
        await ctx.db.prepare(
          'DELETE FROM pay_penalty WHERE run_id = ?1 AND staff_id = ?2 AND reason = ?3',
        ).bind(run.id, line.staffId, FROM_THE_SHEET).run();
        const extra = round2(change.to - change.others);
        if (extra > 0) {
          await ctx.db.prepare(
            'INSERT INTO pay_penalty (run_id, staff_id, amount, reason, actor) VALUES (?1, ?2, ?3, ?4, ?5)',
          ).bind(run.id, line.staffId, extra, FROM_THE_SHEET, actor).run();
          await tellOfDeduction(ctx, line.staffId, extra, month);
        }
        deductions += 1;
        continue;
      }
      if (change.kind === 'basic') {
        await ctx.db.prepare(
          "UPDATE pay_profile SET basic = ?2, set_by = ?3, set_at = datetime('now') WHERE staff_id = ?1",
        ).bind(line.staffId, change.to, actor).run();
        basics += 1;
        continue;
      }
      if (change.kind === 'allowance') {
        if (change.isNew && !make) {
          if (!notMade.includes(change.name)) notMade.push(change.name);
          continue;
        }
        if (change.isNew && !made.allowances.includes(change.name)) {
          made.allowances.push(change.name);
        }
        // One line per name, so a sheet run twice does not leave two
        // Transports on somebody's payslip.
        await ctx.db.prepare('DELETE FROM pay_allowance WHERE staff_id = ?1 AND name = ?2')
          .bind(line.staffId, change.name).run();
        if (change.to > 0) {
          await ctx.db.prepare(
            'INSERT INTO pay_allowance (staff_id, name, amount, taxable) VALUES (?1, ?2, ?3, ?4)',
          ).bind(line.staffId, change.name, change.to, change.taxable === false ? 0 : 1).run();
        }
        allowances += 1;
        continue;
      }
      if (change.kind === 'score') {
        const schemeId = change.schemeId ?? schemeIdByName.get(change.schemeName) ?? null;
        if (!schemeId) {
          if (!notMade.includes(change.schemeName)) notMade.push(change.schemeName);
          continue;
        }
        // A scheme that pays a set figure stores the figure as the award and a
        // hundred as the score, the same as typing it on the screen does. A
        // tiered one stores the rung and the money that rung is worth.
        // Everything downstream works the award out as the award scaled by the
        // score, so all three kinds land as one line on a payslip.
        // A figure given in money on a scored scheme arrives as the score that
        // pays it, with the award it was worked against kept beside it.
        const score = change.paysAmount || change.byTier ? 100 : (change.money ? change.score : change.to);
        const award = change.paysAmount
          ? change.to
          : (change.byTier || change.money ? change.worth : null);
        const tier = change.byTier ? change.to : null;
        await ctx.db.prepare(
          `INSERT INTO pay_score (run_id, scheme_id, staff_id, score, amount, tier)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (run_id, scheme_id, staff_id)
           DO UPDATE SET score = ?4, amount = ?5, tier = ?6`,
        ).bind(run.id, schemeId, line.staffId, score, award, tier).run();
        scores += 1;
      }
    }
  }

  await audit(ctx, 'payroll.input', month, {
    basics, allowances, scores, takeHomes, deductions, skipped: read.skipped.length, made,
  });
  return json({
    ok: true,
    month,
    basics,
    allowances,
    scores,
    takeHomes,
    deductions,
    // What the file made, and what it named and was not allowed to make.
    made,
    notMade,
    skipped: read.skipped,
    notes: read.lines,
  });
}

/**
 * A month's line with the payslip taken out of it.
 *
 * Running the payroll means seeing what the month comes to for each person,
 * and there is no way to do the job without that. Reading somebody's payslip
 * is a different thing: the allowances named one by one, which schemes they
 * scored on, which tax band each part of their pay fell in, which advance is
 * coming off. That is nobody's business but theirs and an administrator's.
 *
 * Taken out here rather than hidden on the screen, because a screen that hides
 * something it was sent is not hiding it at all.
 */
function withoutTheSlip(line) {
  return {
    ...line,
    allowances: [],
    loans: [],
    bonus: { ...line.bonus, schemes: [] },
    paye: { ...line.paye, steps: [] },
  };
}

/**
 * The two returns the month has to produce, on one screen.
 *
 * Kept off the main payroll response and behind its own request, because it
 * reads TIN and SSNIT numbers out of the personal records and there is no
 * reason for those to travel with a screen that does not show them.
 */
async function monthReturn(ctx) {
  const { timezone } = await settingsOf(ctx.db);
  const month = monthFrom(ctx.url, timezone);
  const data = await gather(ctx, month);

  const closed = data.run.status === 'final';
  const lines = closed
    ? data.staff
      .map((person) => data.slipBy.get(person.id))
      .filter(Boolean)
      .map((slip) => JSON.parse(slip.detail))
    : linesFrom(data, month);

  // Everything the return needs that the payroll itself does not hold.
  //
  // THE TABLE IS hr_profile. It was read as hr_person here, which is not a
  // table this app has ever had, so the query threw on every single month and
  // the catch below turned that into an empty list. The column asking for a
  // tax number came out blank for a property that had filled every one of them
  // in. A catch that swallows a typo is worse than no catch at all, so this
  // one now only covers the case it was for: a database old enough not to have
  // the people tables yet.
  //
  // Read from att_staff outwards rather than from the profile, so somebody
  // with a job title and no personal record still gets their grade on the
  // form.
  const records = await ctx.db.prepare(
    `SELECT s.id AS staff_id, s.job_title, s.department,
            p.tin_number, p.ssnit_number, p.id_type, p.id_number,
            w.gra_position, w.gra_residency, w.gra_relief
       FROM att_staff s
       LEFT JOIN hr_profile p ON p.staff_id = s.id
       LEFT JOIN pay_profile w ON w.staff_id = s.id`,
  ).all().catch(() => ({ results: [] }));

  const people = new Map((records.results ?? []).map((r) => [Number(r.staff_id), {
    ...r,
    // The form's column 2 asks for a TIN or a Ghana Card number. Almost
    // everybody here has the card and not the TIN, and it is kept under
    // identification rather than under tax, so the column came out empty for
    // a property that had filled the number in perfectly well.
    ghana_card: /ghana\s*card/i.test(String(r.id_type ?? '')) || /^GHA-/i.test(String(r.id_number ?? ''))
      ? r.id_number
      : '',
    // Said against the person on their pay profile where somebody has said it.
    // The job title and the department are what the form fell back to before
    // anybody could, and they still are where nobody has.
    position: r.gra_position || r.job_title || r.department || '',
    residency: r.gra_residency || '',
    relief: round2(r.gra_relief ?? 0),
  }]));

  // What was paid off in this month, against the person it went to. Column 26
  // asks for it and nothing else on the form moves because of it.
  const severanceBy = new Map();
  for (const row of data.severances ?? []) {
    severanceBy.set(Number(row.staff_id), round2((severanceBy.get(Number(row.staff_id)) ?? 0) + row.amount));
  }
  for (const [id, record] of people) record.severance = severanceBy.get(id) ?? 0;

  const totals = totalsOf(lines);
  const journal = journalFor({ lines, totals, rates: data.rates, tiers: data.tiers });
  const schedule = payeSchedule({ lines, people });
  const ssnit = ssnitSchedule({ lines, people, rates: data.rates, tiers: data.tiers });

  const missing = schedule.rows.filter((row) => !row.tin || !row.ssnitNumber)
    .map((row) => ({
      name: row.name,
      wants: [!row.tin ? 'TIN' : null, !row.ssnitNumber ? 'SSNIT number' : null].filter(Boolean),
    }));

  return { month, data, lines, totals, journal, schedule, ssnit, missing };
}

/** The month's journal and PAYE schedule, for the screen. */
export async function returns(ctx) {
  const { month, data, totals, journal, schedule, ssnit, missing } = await monthReturn(ctx);
  return json({
    month,
    // What the heading of the GRA's form asks for, so the screen can head the
    // schedule the way the paper does. The company whose return it is.
    employer: employerOf(ctx, data),
    // In full, for the heading of the paper.
    company: ctx.company,
    currency: data.currency,
    property: data.property,
    status: data.run.status,
    rates: {
      label: data.rates.label,
      ssnitEmployee: data.rates.ssnitEmployee,
      ssnitEmployer: data.rates.ssnitEmployer,
    },
    tiers: data.tiers,
    totals,
    journal,
    // The columns come from here rather than being written out again on the
    // screen: a return with two lists of headings drifts apart.
    columns: PAYE_COLUMNS,
    schedule,
    // The pension return beside the tax one: who contributed, how much, and
    // how it splits between SSNIT and the trustee.
    ssnit,
    // Named rather than counted: whoever files the return has to go and get
    // these, and a number does not tell them whose record to open.
    missing,
  });
}

/**
 * The GRA office the property files with, as the form's heading asks for it:
 * which kind of office (a tick against LTO or TSC) and its name.
 */
export function taxOfficeOf(settings = {}) {
  const kind = String(settings.gra_tax_office_kind ?? '').toUpperCase();
  return {
    kind: ['LTO', 'TSC'].includes(kind) ? kind : '',
    name: String(settings.gra_tax_office ?? '').trim(),
  };
}

/**
 * The whole month as a workbook: the payroll, the journal and the return.
 *
 * Three sheets rather than three downloads, because they are read together.
 * The schedule sheet is the GRA's own form, line for line: the same heading
 * block, the same column numbers along the top, the same twenty-seven columns
 * in the same order, and the rows starting where the form starts them. It is
 * meant to be filed as it comes out, not rearranged first.
 */
export async function exportBook(ctx) {
  const { month, data, lines, totals, journal, schedule, ssnit } = await monthReturn(ctx);
  const who = employerOf(ctx, data);
  const employer = who.name;
  const employerTin = who.tin;
  const employerSsnit = who.ssnit;
  // The form wants the month as MM/YYYY, and a form headed the wrong month is
  // the one mistake on it nobody notices until the assessment arrives.
  const [year, mm] = String(month).split('-');
  const asFiled = `${mm}/${year}`;

  const money = (n) => ({ v: round2(Number(n) || 0), s: S.money });
  const totalMoney = (n) => ({ v: round2(Number(n) || 0), s: S.moneyTotal });
  const head = (t) => ({ v: t, s: S.head });

  // ---- the month, as the payroll screen shows it ------------------------
  // The tax the property carried on a bonus promised as a net figure sits
  // inside the allowances column, as it does on the payslip. It gets a column
  // of its own here as well, so a month can be reconciled against an outside
  // sheet without anybody having to work out where the difference went.
  const payHead = ['Name', 'Department', 'Basic', 'Allowances', 'Bonus', 'Tax carried on bonus', 'Gross',
    'SSNIT', 'PAYE', 'Advance', 'Late charges', 'Net pay', 'Employer SSNIT', 'Cost'];
  const payRows = lines.map((line) => [
    line.staff?.name ?? '',
    line.staff?.department ?? '',
    money(line.basic),
    money(line.slip?.allowanceTotal ?? line.allowanceTotal),
    money(line.bonus?.net),
    money(line.slip?.carried ?? 0),
    money(line.gross),
    money(line.ssnit?.employee),
    money(line.paye?.total),
    money(round2((line.loanTotal ?? 0) - (line.tillCredit ?? 0))),
    money(line.lateCharge ?? 0),
    money(line.net),
    money(line.ssnit?.employer),
    money(line.employerCost),
  ]);
  const payTotals = [{ v: 'Everybody', s: S.total }, { v: '', s: S.total },
    totalMoney(totals.basic), totalMoney(totals.allowancesOnSlip ?? totals.allowances),
    totalMoney(totals.bonusNet), totalMoney(totals.carriedOnBonus ?? 0), totalMoney(totals.gross),
    totalMoney(totals.ssnitEmployee), totalMoney(totals.paye), totalMoney(round2((totals.loans ?? 0) - (totals.tillCredit ?? 0))),
    totalMoney(totals.lateCharge ?? 0), totalMoney(totals.net), totalMoney(totals.ssnitEmployer), totalMoney(totals.cost)];

  const payroll = {
    name: 'Payroll',
    freeze: 4,
    widths: [26, 16, 11, 12, 11, 13, 12, 10, 11, 11, 11, 12, 13, 12],
    rows: [
      [{ v: `${employer} — payroll for ${month}`, s: S.title }],
      [`${lines.length} on the payroll`, '', '', '', '', `In ${data.currency}`],
      [],
      payHead.map(head),
      ...payRows,
      payTotals,
    ],
  };

  // ---- the journal ------------------------------------------------------
  const side = (rows, label) => [
    [{ v: label, s: S.bold }],
    [head('Account'), head('Detail'), head('Amount')],
    ...rows.map((r) => [r.account, r.detail ?? '', money(r.amount)]),
    [{ v: `Total ${label.toLowerCase()}`, s: S.total }, { v: '', s: S.total },
      totalMoney(rows.reduce((n, r) => n + (Number(r.amount) || 0), 0))],
  ];
  const journalSheet = {
    name: 'Journal',
    widths: [34, 40, 14],
    rows: [
      [{ v: `${employer} — payroll journal, ${month}`, s: S.title }],
      [],
      ...side(journal.debits ?? [], 'Debits'),
      [],
      ...side(journal.credits ?? [], 'Credits'),
    ],
  };

  // ---- the GRA schedule, on the GRA's own form ---------------------------
  //
  // Copied from the GRA's own workbook (the September 2026 template, marked
  // "paye202609grra"), cell for cell: the boxed heading block, Times New Roman,
  // the column numbers, PENSIONS over columns 9 and 10, headings three rows
  // tall, the bonus and overtime columns shaded the way the form shades them,
  // and the rows starting on row 18 where the form starts them. It is meant to
  // be filed or pasted into the GRA's sheet as it comes out.
  const cols = PAYE_COLUMNS;
  const width = cols.length; // A to AC
  const office = who.taxOffice;

  const TNR = 'Times New Roman';
  const box = { l: 'thin', r: 'thin', t: 'thin', b: 'thin' };
  const ACCOUNTING = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@';
  // The form's shading: the bonus and the overtime light, their final taxes
  // darker, so the two concessionary rates stand out from the graduated tax.
  const SHADE = { bonus: 'FFF2F2F2', overtime: 'FFF2F2F2', bonusTax: 'FFD8D8D8', overtimeTax: 'FFD8D8D8' };
  const st = (extra = {}) => ({ font: TNR, sz: 11, ...extra });

  // The heading block sits in a frame: a line down the left of column A, down
  // the right of the last column, and across the top of row 1.
  const framed = (r, cells = []) => {
    const row = [];
    for (let c = 0; c < width; c += 1) {
      const given = cells[c];
      const cell = given != null && typeof given === 'object' ? { ...given } : { v: given ?? '' };
      const style = { ...st(), ...(cell.s ?? {}) };
      const border = { ...(style.border ?? {}) };
      if (c === 0) border.l = 'thin';
      if (c === width - 1) border.r = 'thin';
      if (r === 0) border.t = 'thin';
      style.border = Object.keys(border).length ? border : undefined;
      if (!style.border) delete style.border;
      row[c] = { ...cell, s: style };
    }
    return row;
  };
  const L = (letter) => {
    let n = 0;
    for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const cells = (pairs) => {
    const row = [];
    for (const [letter, cell] of pairs) row[L(letter)] = cell;
    return row;
  };
  const tick = (kind) => (office.kind === kind ? `${kind} ✓` : kind);
  const ruled = (letters, b) => letters.map((x) => [x, { v: '', s: st({ border: b }) }]);

  const heading = [
    framed(0, cells([['A', { v: 'GHANA REVENUE AUTHORITY', s: st({ b: true, sz: 22, h: 'center' }) }]])),
    framed(1, cells([['A', { v: 'DOMESTIC TAX REVENUE DIVISION', s: st({ b: true, sz: 14, h: 'center' }) }]])),
    framed(2), framed(3),
    framed(4, cells([['A', { v: "EMPLOYER'S MONTHLY TAX DEDUCTIONS SCHEDULE (P. A. Y. E.)", s: st({ b: true, sz: 16, h: 'center' }) }]])),
    framed(5),
    framed(6, cells([
      ['A', { v: 'CURRENT TAX OFFICE', s: st({ b: true, sz: 12 }) }],
      ['C', { v: '', s: st({ border: { r: 'thin' } }) }],
      ['D', { v: tick('LTO'), s: st({ h: 'center', border: box }) }],
      ['E', { v: '', s: st({ border: { r: 'thin', t: 'thin', b: 'thin' } }) }],
      ['F', { v: tick('TSC'), s: st({ h: 'center', border: box }) }],
      ['G', { v: office.name, s: st({ h: 'center', border: box }) }],
      ...ruled(['H', 'I', 'J', 'K', 'L', 'M'], { t: 'thin', b: 'thin' }),
      ['N', { v: '', s: st({ border: { r: 'thin', t: 'thin', b: 'thin' } }) }],
    ])),
    framed(7, cells([
      ['D', { v: '(tick one)', s: st({ h: 'center', border: { t: 'thin', b: 'thin' } }) }],
      ...ruled(['E', 'F'], { t: 'thin', b: 'thin' }),
      ['G', { v: 'Name of Tax Office', s: st({ h: 'center', border: { t: 'thin', b: 'thin' } }) }],
      ...ruled(['H', 'I', 'J', 'K', 'L', 'M', 'N'], { t: 'thin', b: 'thin' }),
    ])),
    framed(8, cells([
      ['A', { v: 'NAME OF EMPLOYER', s: st({ b: true, sz: 12 }) }],
      ['C', { v: '', s: st({ border: { r: 'thin' } }) }],
      ['D', { v: employer, s: st({ b: true, sz: 16, border: box }) }],
      ...ruled(['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'], { t: 'thin', b: 'thin' }),
      ['N', { v: '', s: st({ border: { r: 'thin', t: 'thin', b: 'thin' } }) }],
      ['S', { v: 'FOR THE MONTH OF', s: st({ b: true, sz: 12 }) }],
      ['U', { v: asFiled, text: true, s: st({ b: true, sz: 12, h: 'center', border: { l: 'thin', t: 'thin', b: 'thin' } }) }],
      ...ruled(['V', 'W'], { t: 'thin', b: 'thin' }),
      ['X', { v: '', s: st({ border: { l: 'thin' } }) }],
    ])),
    framed(9, cells([['V', '(MM/YYYY)']])),
    framed(10, cells([
      ['A', { v: "EMPLOYER'S TIN / GH. CARD NO.", s: st({ b: true, sz: 12 }) }],
      ['C', { v: '', s: st({ border: { r: 'thin' } }) }],
      ['D', { v: employerTin, text: true, s: st({ b: true, sz: 14, border: box }) }],
      ...ruled(['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'], { t: 'thin', b: 'thin' }),
      ['O', { v: '', s: st({ border: { r: 'thin', t: 'thin', b: 'thin' } }) }],
    ])),
    framed(11),
  ];
  // The GRA's own mark on its template, in a hidden column, where the form
  // keeps it.
  heading[11][L('BA')] = { v: 'paye202609grra', s: st({ sz: 11 }) };

  // Column numbers, as numbers, the way the template stores them; the
  // Adjustment column has none.
  const numbers = cols.map((c, i) => ({
    v: c.no === '' ? '' : Number(c.no), s: st({ h: i === 0 ? 'left' : 'center', border: { l: 'thin', r: 'thin', t: 'thin' } }),
  }));
  const pensions = cols.map((c, i) => {
    if (i === L('I')) return { v: 'PENSIONS', s: st({ h: 'center', border: box }) };
    if (i === L('J')) return { v: '', s: st({ border: { r: 'thin', t: 'thin', b: 'thin' } }) };
    return { v: '', s: st({ border: { l: 'thin', r: 'thin' } }) };
  });
  const headStyle = (c, i) => st({
    sz: 11, wrap: true, v: 'center', h: i === 0 ? 'left' : 'center', border: box,
    ...(SHADE[c.key] ? { fill: SHADE[c.key] } : {}),
  });
  const headings = cols.map((c, i) => ({ v: c.form ?? c.label, s: headStyle(c, i) }));
  const under = (bottom) => cols.map((c, i) => ({
    v: '', s: { ...headStyle(c, i), border: { l: 'thin', r: 'thin', ...(bottom ? { b: 'thin' } : {}) } },
  }));

  const centred = new Set(['position', 'residency', 'secondary', 'paidSsnit', 'remarks']);
  const lined = { l: 'thin', r: 'thin', b: 'thin' };
  const body = schedule.rows.map((row) => cols.map((c) => {
    const value = row[c.key];
    const fill = SHADE[c.key] ? { fill: SHADE[c.key] } : {};
    if (c.money) return { v: round2(Number(value) || 0), s: st({ fmt: ACCOUNTING, border: lined, ...fill }) };
    if (c.key === 'no') return { v: value, s: st({ fmt: '0', h: 'center', border: lined }) };
    return {
      v: value ?? '',
      text: Boolean(c.text),
      s: st({ fmt: '@', h: centred.has(c.key) ? 'center' : 'left', border: lined }),
    };
  }));
  const totalRow = cols.map((c, i) => {
    const s0 = st({ b: true, fill: 'FFD8D8D8', border: box });
    if (i === 0) return { v: 'TOTALS', s: s0 };
    if (!c.money) return { v: '', s: s0 };
    return { v: round2(Number(schedule.totals[c.key]) || 0), s: { ...s0, fmt: ACCOUNTING } };
  });

  // The form's own widths, column by column.
  const GRA_WIDTHS = [8.8, 9.8, 19.3, 12, 15.2, 18.5, 10.8, 10.2, 10.8, 9.8, 10.5, 11.5, 11.7, 9,
    11.2, 8.8, 9, 9, 13.8, 10.2, 9.8, 10.3, 11.5, 8.8, 9, 10.3, 11.2, 8.8, 9];
  // The template's own dropdowns, on the rows it fills.
  const firstRow = 18;
  const lastRow = firstRow + Math.max(schedule.rows.length, 1) - 1;
  const span = (a, b) => `${a}${firstRow}:${b}${lastRow}`;

  const scheduleSheet = {
    name: 'PAYE schedule',
    freeze: 17,
    freezeCols: 3,
    gridLines: false,
    landscape: true,
    hidden: [L('BA')],
    lists: [
      { ref: span('G', 'H'), options: ['Y', 'N'] },
      { ref: span('D', 'D'), options: ['EXPATRIATE', 'MANAGEMENT', 'SENIOR', 'JUNIOR', 'OTHER'] },
      {
        ref: span('E', 'E'),
        options: ['Resident-Full-Time', 'Non-Resident', 'Resident-Part-Time', 'Resident-Casual',
          'Secondary@5%', 'Secondary@10%', 'Secondary@17.5%', 'Secondary@25%', 'Secondary@30%', 'Secondary@35%'],
      },
    ],
    widths: cols.map((c, i) => GRA_WIDTHS[i] ?? c.width ?? 13),
    // The three titles centred across A to AA, as the template centres them.
    merges: [
      'A1:AA1', 'A2:AA2', 'A5:AA5',
      'D7:E7', 'G7:N7', 'D8:F8', 'G8:N8', 'D9:N9', 'U9:W9', 'D11:O11',
      'I14:J14',
      ...cols.map((c, i) => `${colName(i)}15:${colName(i)}17`),
    ],
    rows: [...heading, numbers, pensions, headings, under(false), under(true), ...body, totalRow],
  };

  // ---- the SSNIT return --------------------------------------------------
  const scols = ssnit.columns;
  const ssnitSheet = {
    name: 'SSNIT return',
    freeze: 8,
    widths: scols.map((c) => c.width ?? 13),
    merges: [`A1:${colName(scols.length - 1)}1`],
    rows: [
      [{ v: 'SOCIAL SECURITY AND NATIONAL INSURANCE TRUST', s: S.title }],
      [{ v: 'MONTHLY CONTRIBUTION REPORT', s: S.bold }],
      [],
      [{ v: 'NAME OF EMPLOYER', s: S.bold }, '', { v: employer, s: S.bold }],
      [{ v: 'EMPLOYER SSNIT NUMBER', s: S.bold }, '', { v: employerSsnit, s: S.bold, text: true },
        '', { v: 'TIN', s: S.bold }, { v: employerTin, s: S.bold, text: true }],
      [{ v: 'FOR THE MONTH OF', s: S.bold }, '', { v: asFiled, s: S.bold, text: true },
        '', { v: 'MEMBERS', s: S.bold }, ssnit.members],
      [],
      scols.map((c) => head(c.label)),
      ...ssnit.rows.map((row) => scols.map((c) => {
        const value = row[c.key];
        if (c.money) return money(value);
        if (c.text) return { v: value ?? '', text: true };
        return value ?? '';
      })),
      scols.map((c, i) => {
        if (i === 0) return { v: 'TOTALS', s: S.total };
        if (!c.money) return { v: '', s: S.total };
        return totalMoney(ssnit.totals[c.key]);
      }),
    ],
  };

  const bytes = workbook([payroll, journalSheet, scheduleSheet, ssnitSheet]);
  const name = `${(employer || 'Payroll').replace(/[^A-Za-z0-9]+/g, '-')}-payroll-${month}.xlsx`;
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * How everybody is paid, against their staff id.
 *
 * Read from hr_profile, which is where the personal record keeps it. The catch
 * covers exactly one case: a database old enough not to have the people tables
 * yet. It must not be widened to cover a mistyped column, because a swallowed
 * typo here is a bank file that quietly comes out with nobody on it.
 */
async function howEverybodyIsPaid(db) {
  const rows = await db.prepare(
    `SELECT staff_id, pay_method, bank_name, bank_branch, account_name, account_number,
            momo_network, momo_number
       FROM hr_profile`,
  ).all().catch(() => ({ results: [] }));

  return new Map((rows.results ?? []).map((row) => [Number(row.staff_id), {
    payMethod: row.pay_method,
    bankName: row.bank_name,
    bankBranch: row.bank_branch,
    accountName: row.account_name,
    accountNumber: row.account_number,
    momoNetwork: row.momo_network,
    momoNumber: row.momo_number,
  }]));
}

/** The month's net pays worked out and split, for whatever wants to show them. */
async function bankRunFor(ctx) {
  const { month, data, lines } = await monthReturn(ctx);
  const file = bankFile(lines, await howEverybodyIsPaid(ctx.db), {
    month,
    // A property that words its own narration can say so; almost nobody will.
    // Trimmed rather than refused, because a long one is a typo and not
    // something to stop somebody's pay run over.
    note: ctx.url.searchParams.get('reference') ?? '',
  });
  return { month, data, file };
}

/**
 * The net pays, and nothing else, for taking to the bank.
 *
 * TWO FILES, BECAUSE THEY ARE READ BY TWO DIFFERENT PEOPLE. The spreadsheet is
 * for whoever runs the month: it has the transfers on one sheet, the people
 * being paid by hand on another, and a total under each so it can be checked
 * against the payroll before anything leaves. The CSV is for the bank's own
 * portal, so it is the transfers alone, bare: a heading row, the rows, and not
 * one thing else. A totals line at the bottom of an upload is a line the bank
 * tries to pay somebody, and a byte order mark at the front is a first column
 * a portal cannot read.
 */
export async function bankPayments(ctx) {
  const { month, data, file } = await bankRunFor(ctx);
  const employer = employerOf(ctx, data).name;
  const stem = `${(employer || 'Payroll').replace(/[^A-Za-z0-9]+/g, '-')}-net-pay-${month}`;

  if (ctx.url.searchParams.get('as') === 'csv') {
    const rows = [
      BANK_COLUMNS.map((c) => c.label),
      ...file.rows.map((row) => BANK_COLUMNS.map((c) => (c.money
        ? round2(row[c.key]).toFixed(2)
        : String(row[c.key] ?? '')))),
    ];
    const escape = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return new Response(rows.map((r) => r.map(escape).join(',')).join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${stem}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const money = (n) => ({ v: round2(Number(n) || 0), s: S.money });
  const totalMoney = (n) => ({ v: round2(Number(n) || 0), s: S.moneyTotal });
  const head = (t) => ({ v: t, s: S.head });
  const cell = (column, row) => {
    if (column.money) return money(row[column.key]);
    if (column.text) return { v: row[column.key] ?? '', text: true };
    return row[column.key] ?? '';
  };

  const transfers = {
    name: 'Bank transfer',
    freeze: 5,
    widths: BANK_COLUMNS.map((c) => c.width ?? 16),
    rows: [
      [{ v: `${employer}, net pay for ${month}`, s: S.title }],
      [file.rows.length === 1 ? '1 into a bank account' : `${file.rows.length} into bank accounts`,
        '', '', '', { v: `In ${data.currency}`, s: S.bold }],
      [`Reference: ${file.reference}`],
      [],
      BANK_COLUMNS.map((c) => head(c.label)),
      ...file.rows.map((row) => BANK_COLUMNS.map((c) => cell(c, row))),
      BANK_COLUMNS.map((c, i) => {
        if (i === 0) return { v: 'Total', s: S.total };
        if (c.money) return totalMoney(file.total);
        return { v: '', s: S.total };
      }),
    ],
  };

  const byHand = {
    name: 'Paid another way',
    freeze: 5,
    widths: BY_HAND_COLUMNS.map((c) => c.width ?? 16),
    rows: [
      [{ v: `${employer}, not on the bank file for ${month}`, s: S.title }],
      [file.byHand.length === 1
        ? '1 to be paid by hand'
        : file.byHand.length
          ? `${file.byHand.length} to be paid by hand`
          : 'Everybody with something to be paid is on the bank file.'],
      [file.missingAccounts === 1
        ? 'One of them is down to be paid by bank and has no account number. That is the one '
          + 'to fix.'
        : file.missingAccounts
          ? `${file.missingAccounts} of them are down to be paid by bank and have no account `
            + 'number. Those are the ones to fix.'
          : ''],
      [],
      BY_HAND_COLUMNS.map((c) => head(c.label)),
      ...file.byHand.map((row) => BY_HAND_COLUMNS.map((c) => cell(c, row))),
      file.byHand.length
        ? BY_HAND_COLUMNS.map((c, i) => {
          if (i === 0) return { v: 'Total', s: S.total };
          if (c.money) return totalMoney(file.byHandTotal);
          return { v: '', s: S.total };
        })
        : [],
    ],
  };

  const bytes = workbook([transfers, byHand]);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${stem}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function payslip(ctx, staffParam) {
  const { timezone } = await settingsOf(ctx.db);
  const month = monthFrom(ctx.url, timezone);
  const staffId = int(staffParam, 'Who', { required: true, min: 1 });
  // Their own company's payroll, whichever one the screen was on.
  const person = await ctx.db.prepare('SELECT company_id FROM att_staff WHERE id = ?')
    .bind(staffId).first().catch(() => null);
  await useCompany(ctx, companyOf(person));
  const data = await gather(ctx, month);

  const slip = data.slipBy.get(staffId);
  const line = slip
    ? JSON.parse(slip.detail)
    : linesFrom(data, month).find((l) => l.staff.id === staffId);
  if (!line) throw notFound('Nothing on the payroll for them that month.');

  return json({
    month,
    currency: data.currency,
    property: data.property,
    status: data.run.status,
    closedAt: data.run.closed_at,
    // The employer the slip is headed with.
    company: ctx.company,
    line,
  });
}

/**
 * Somebody's own payslips.
 *
 * There was no way for a member of staff to see one at all. The only route to
 * a payslip is the payroll's, and that wants the payroll permission, a PIN, and
 * an administrator on top — which is right for reading a colleague's and is
 * the wrong end of the building for reading your own. So people were being
 * handed paper, or asking.
 *
 * ONLY CLOSED MONTHS. A draft moves: a score gets changed, an allowance is
 * corrected, and a figure somebody has already written down stops being true.
 * Payslips are written out in full when a month is closed, and this reads those
 * and nothing else, so what somebody sees is what they were paid.
 *
 * WHOSE IS NEVER ASKED. The person comes from the session and there is no
 * parameter to pass, so there is nothing here that could be pointed at
 * somebody else however the address is typed.
 */
export async function myPayslips(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  const { currency, property, settings } = await settingsOf(ctx.db);

  // Their own code, if they have put one on. Refused here rather than on the
  // screen, and with no figures in the answer at all: a month list carrying
  // net pay is the thing being guarded, not a detail of it.
  const lock = readLock(await lockRow(ctx), new Date());
  if (!lock.open) {
    return json({
      locked: true,
      state: lock.state,
      lockedUntil: lock.lockedUntil,
      triesLeft: lock.triesLeft,
      currency,
      property,
      months: [],
      line: null,
    });
  }

  // Reading is using, so the window slides while somebody is still on the
  // screen. It is dropped when they leave it, which the screen does itself.
  if (lock.on) await slideOpen(ctx);

  // A login that is nobody in particular: real, and with no pay to show. Said
  // rather than answered with an empty list, because the two are different and
  // only one of them is worth telling somebody about.
  if (!staffId) return json({ linked: false, currency, property, months: [], line: null });

  // The month without the company on the end of its key; which company paid
  // them that month heads the slip.
  const rows = await ctx.db.prepare(
    `SELECT substr(r.month, 1, 7) AS month, r.company_id, r.closed_at, s.detail, s.gross, s.net
       FROM pay_slip s JOIN pay_run r ON r.id = s.run_id
      WHERE s.staff_id = ?1 AND r.status = 'final'
      ORDER BY substr(r.month, 1, 7) DESC`,
  ).bind(staffId).all();

  const slips = rows.results ?? [];
  const asked = ctx.url.searchParams.get('month');
  const wanted = slips.find((r) => r.month === asked) ?? slips[0] ?? null;

  return json({
    linked: true,
    // So the screen knows to shut the window again when somebody leaves it.
    hasCode: lock.on,
    currency,
    property,
    // Always final. Nothing else is ever returned from here, and the paper
    // reads the status to decide whether to stamp itself DRAFT and warn that
    // the figures can still move. Left unsaid it defaulted to draft, and told
    // somebody their closed payslip was provisional.
    status: 'final',
    // The table the month was worked out on, so the slip reads the same as the
    // one that was issued rather than at today's percentages.
    rates: wanted
      ? (() => {
        const line = JSON.parse(wanted.detail);
        return line.rates ?? null;
      })()
      : null,
    months: slips.map((r) => ({
      month: r.month,
      closedAt: r.closed_at,
      gross: round2(r.gross),
      net: round2(r.net),
    })),
    month: wanted?.month ?? null,
    closedAt: wanted?.closed_at ?? null,
    line: wanted ? JSON.parse(wanted.detail) : null,
    company: wanted
      ? await companyById(ctx.db, wanted.company_id ?? MAIN, settings)
      : { legalName: settings.company_legal_name ?? '', tin: settings.company_tin ?? '' },
  });
}

// --------------------------------------------------------------------------
// The code somebody puts on their own payslips
// --------------------------------------------------------------------------

/** The user row this session belongs to, with the lock columns on it. */
const lockRow = (ctx) => ctx.db.prepare(
  `SELECT id, payslip_pin_hash, payslip_pin_set_at, payslip_open_until,
          payslip_tries, payslip_locked_until
     FROM users WHERE id = ?`,
).bind(Number(ctx.session.user.id)).first();

const slideOpen = (ctx) => ctx.db.prepare(
  'UPDATE users SET payslip_open_until = ? WHERE id = ?',
).bind(openUntil(new Date()), Number(ctx.session.user.id)).run();

/** Hashed in a space of its own, so the same digits as a login PIN differ. */
const hashCode = async (ctx, code) => hashPin(`payslip:${code}`, await getPepper(ctx.db));

/**
 * Whether the code is on, and nothing else about it.
 *
 * Read by My account to draw the switch and by My payslips to know whether to
 * ask. It never says what the code is, and there is nothing here an
 * administrator could read either: the hash is not in the answer.
 */
export async function myPayslipLock(ctx) {
  const lock = readLock(await lockRow(ctx), new Date());
  return json({
    on: lock.on,
    state: lock.state,
    setAt: lock.setAt,
    openUntil: lock.openUntil,
    lockedUntil: lock.lockedUntil,
    triesLeft: lock.triesLeft,
    minutes: OPEN_MINUTES,
    digits: 4,
  });
}

/**
 * Put a code on, change it, or take it off.
 *
 * Setting the first one asks for nothing but being signed in as themselves.
 * Putting a lock on your own payslips only ever takes access away, and asking
 * somebody to prove who they are before they may protect something is the kind
 * of ceremony that stops people protecting it.
 *
 * Changing or removing it needs the one they have, because at that point it is
 * the phone in somebody else's hand that the question is about.
 */
export async function setMyPayslipLock(ctx) {
  const body = await readJson(ctx.request);
  const row = await lockRow(ctx);
  const lock = readLock(row, new Date());
  const off = bool(body.off, false);

  if (lock.on) {
    if (lock.state === 'locked') {
      throw badRequest(`Too many wrong tries. Try again in ${minutesLeft(lock.lockedUntil)} minutes.`);
    }
    const current = str(body.current, 'Current code', { max: 10, fallback: '' });
    if (!current) throw badRequest('Type the code you have now.');
    if (await hashCode(ctx, current) !== row.payslip_pin_hash) {
      const cost = afterAWrongTry(row, new Date());
      await ctx.db.prepare(
        'UPDATE users SET payslip_tries = ?, payslip_locked_until = ? WHERE id = ?',
      ).bind(cost.tries, cost.lockedUntil, row.id).run();
      throw badRequest(cost.lockedUntil
        ? 'That is not the code. Too many wrong tries; try again later.'
        : `That is not the code. ${cost.triesLeft} ${cost.triesLeft === 1 ? 'try' : 'tries'} left.`);
    }
  }

  if (off) {
    await ctx.db.prepare(
      `UPDATE users SET payslip_pin_hash = NULL, payslip_pin_set_at = NULL,
                        payslip_open_until = NULL, payslip_tries = 0,
                        payslip_locked_until = NULL
         WHERE id = ?`,
    ).bind(row.id).run();
    return json({ ok: true, on: false });
  }

  const code = str(body.code, 'Code', { max: 10, fallback: '' });
  if (!codeLooksRight(code)) throw badRequest(CODE_RULE);
  if (codeIsObvious(code)) {
    throw badRequest('Pick something less easy to guess. Anybody holding your phone tries that one first.');
  }

  // Set and open in one go, so somebody who has just chosen it is not asked
  // for it on the very next screen.
  await ctx.db.prepare(
    `UPDATE users SET payslip_pin_hash = ?, payslip_pin_set_at = datetime('now'),
                      payslip_open_until = ?, payslip_tries = 0, payslip_locked_until = NULL
       WHERE id = ?`,
  ).bind(await hashCode(ctx, code), openUntil(new Date()), row.id).run();

  return json({ ok: true, on: true, changed: lock.on });
}

/**
 * Type the code and open the tab.
 *
 * Counted across sessions, because a guesser who reloads the page is exactly
 * the guesser this is for, and a count that lived in the tab would be cleared
 * by the reload that carries the next guess.
 */
export async function openMyPayslips(ctx) {
  const body = await readJson(ctx.request);
  const row = await lockRow(ctx);
  const lock = readLock(row, new Date());

  if (!lock.on) return json({ ok: true, open: true, on: false });
  if (lock.state === 'locked') {
    throw badRequest(`Too many wrong tries. Try again in ${minutesLeft(lock.lockedUntil)} minutes.`);
  }

  const code = str(body.code, 'Code', { max: 10, fallback: '' });
  if (await hashCode(ctx, code) !== row.payslip_pin_hash) {
    const cost = afterAWrongTry(row, new Date());
    await ctx.db.prepare(
      'UPDATE users SET payslip_tries = ?, payslip_locked_until = ? WHERE id = ?',
    ).bind(cost.tries, cost.lockedUntil, row.id).run();
    throw badRequest(cost.lockedUntil
      ? `Too many wrong tries. Try again in ${minutesLeft(cost.lockedUntil)} minutes.`
      : `That is not the code. ${cost.triesLeft} ${cost.triesLeft === 1 ? 'try' : 'tries'} left.`);
  }

  await ctx.db.prepare(
    `UPDATE users SET payslip_open_until = ?, payslip_tries = 0, payslip_locked_until = NULL
       WHERE id = ?`,
  ).bind(openUntil(new Date()), row.id).run();

  return json({ ok: true, open: true, on: true, minutes: OPEN_MINUTES, tries: MAX_TRIES });
}

/**
 * Shut it again on the way out.
 *
 * Called when somebody leaves the screen. Without it the window runs on for
 * its full length on a phone that has been put down on a bar.
 */
export async function shutMyPayslips(ctx) {
  await ctx.db.prepare('UPDATE users SET payslip_open_until = NULL WHERE id = ?')
    .bind(Number(ctx.session.user.id)).run();
  return json({ ok: true, open: false });
}

// --------------------------------------------------------------------------
// Setting it up
// --------------------------------------------------------------------------

/**
 * Who is on the payroll, what they are paid, and their allowances.
 *
 * One submission for everybody, the same as the medical allowances: somebody
 * setting up twenty-four people should type and press once.
 */
export async function setProfiles(ctx) {
  const body = await readJson(ctx.request);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw badRequest('Nothing to set.');

  const { timezone } = await settingsOf(ctx.db);

  let set = 0;
  let removed = 0;

  for (const line of rows) {
    const staffId = int(line.staffId, 'Who', { required: true, min: 1 });

    if (line.onPayroll === false) {
      const gone = await ctx.db.prepare('DELETE FROM pay_profile WHERE staff_id = ?')
        .bind(staffId).run();
      await ctx.db.prepare('DELETE FROM pay_allowance WHERE staff_id = ?').bind(staffId).run();
      if (Number(gone?.meta?.changes ?? 0)) removed += 1;
      continue;
    }

    const basic = round2(num(line.basic, 'Basic salary', { required: true, min: 0, max: 10_000_000 }));

    // Bonus already paid this year before this app was keeping it. Left where
    // it is when the form says nothing, so a screen that does not ask about it
    // cannot quietly wipe what somebody typed.
    const said = line.bonusOpening != null && line.bonusOpening !== '';
    const opening = said
      ? round2(num(line.bonusOpening, 'Bonus already paid this year', { min: 0, max: 10_000_000 }))
      : null;
    const openingYear = isMonth(line.bonusOpeningYear)
      ? String(line.bonusOpeningYear).slice(0, 4)
      : String(line.bonusOpeningYear ?? '').slice(0, 4) || monthOf(todayIn(timezone)).slice(0, 4);

    // Left where it is when the form says nothing, like the opening figure
    // above: a spreadsheet upload does not ask about it, and it must not
    // quietly put everybody back to net.
    const netBonus = line.bonusIsNet == null ? null : (line.bonusIsNet === false ? 0 : 1);

    // The three things the GRA form asks about somebody that the payroll does
    // not otherwise know. Left alone when the form says nothing, so a screen
    // that does not ask about them cannot wipe what was set.
    const graPosition = line.graPosition == null ? null : str(line.graPosition, 'Position', { max: 40 });
    const graResidency = line.graResidency == null
      ? null
      : str(line.graResidency, 'Residency', { max: 40 });
    // It decides the tax now, not only a column on the return, so only the
    // footings the GRA's form knows are taken. A typo would otherwise be taxed
    // on the bands as if nobody had said anything.
    if (graResidency && !RESIDENCIES.includes(graResidency)) {
      throw badRequest(`${graResidency} is not one of the GRA's residencies.`);
    }
    const graRelief = line.graRelief == null || line.graRelief === ''
      ? null
      : round2(num(line.graRelief, 'Deductible reliefs', { min: 0, max: 1_000_000 }));

    // What they take home, which the bonus is worked back from. Three states,
    // not two: absent leaves whatever is there alone, so a spreadsheet upload
    // cannot wipe it; an empty string clears it, which is how somebody goes
    // back to being paid off their scores; a figure sets it.
    const saidTakeHome = Object.prototype.hasOwnProperty.call(line, 'takeHome');
    const takeHome = !saidTakeHome || line.takeHome == null || line.takeHome === ''
      ? null
      : round2(num(line.takeHome, 'Take-home', { min: 0, max: 10_000_000 }));
    const clearTakeHome = saidTakeHome && (line.takeHome == null || line.takeHome === '');

    // What the take-home means, said outright rather than inferred. Absent
    // leaves it as it is, like every other field here, so an upload or an
    // older screen cannot change what somebody's figure means; true is the
    // part before the bonus; false is the whole amount. Cleared with the
    // figure, because a meaning with no figure to attach to is nothing.
    const saidBasis = Object.prototype.hasOwnProperty.call(line, 'takeHomeFixed')
      && line.takeHomeFixed != null;
    const basis = clearTakeHome ? 'clear'
      : saidBasis ? (line.takeHomeFixed ? 'fixed' : 'total')
        : null;

    await ctx.db.prepare(
      `INSERT INTO pay_profile (staff_id, basic, ssnit, note, set_by, bonus_opening,
                                bonus_opening_year, bonus_is_net,
                                gra_position, gra_residency, gra_relief, take_home,
                                take_home_basis)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0), ?7, COALESCE(?8, 1),
               ?9, ?10, COALESCE(?11, 0), ?12,
               CASE WHEN ?14 = 'fixed' THEN 'fixed' ELSE NULL END)
       ON CONFLICT (staff_id) DO UPDATE
         SET basic = ?2, ssnit = ?3, note = ?4, set_by = ?5, set_at = datetime('now'),
             bonus_opening = COALESCE(?6, bonus_opening),
             bonus_opening_year = COALESCE(?7, bonus_opening_year),
             bonus_is_net = COALESCE(?8, bonus_is_net),
             gra_position = COALESCE(?9, gra_position),
             gra_residency = COALESCE(?10, gra_residency),
             gra_relief = COALESCE(?11, gra_relief),
             -- Cleared where the box was emptied, left alone where the form
             -- never asked, set where a figure came.
             take_home = CASE WHEN ?13 = 1 THEN NULL ELSE COALESCE(?12, take_home) END,
             take_home_basis = CASE
               WHEN ?14 = 'clear' THEN NULL
               WHEN ?14 = 'fixed' THEN 'fixed'
               WHEN ?14 = 'total' THEN NULL
               ELSE take_home_basis END`,
    ).bind(staffId, basic, line.ssnit === false ? 0 : 1,
      str(line.note, 'Note', { max: 300 }), actorOf(ctx),
      opening, said ? openingYear : null, netBonus,
      graPosition, graResidency, graRelief, takeHome, clearTakeHome ? 1 : 0, basis).run();

    if (Array.isArray(line.allowances)) {
      await ctx.db.prepare('DELETE FROM pay_allowance WHERE staff_id = ?').bind(staffId).run();
      for (const allowance of line.allowances.slice(0, 12)) {
        const name = str(allowance.name, 'Allowance', { max: 60 });
        const amount = round2(num(allowance.amount, 'Allowance', { min: 0, max: 1_000_000 }));
        if (!name || !amount) continue;
        await ctx.db.prepare(
          `INSERT INTO pay_allowance (staff_id, name, amount, taxable)
           VALUES (?1, ?2, ?3, ?4)`,
        ).bind(staffId, name, amount, allowance.taxable === false ? 0 : 1).run();
      }
    }
    set += 1;
  }

  await audit(ctx, 'payroll.profiles', '', { set, removed });
  return json({ ok: true, set, removed });
}

/** Make a bonus scheme, or change one, and say who is under it. */
export async function saveScheme(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 80 });
  const amount = round2(num(body.amount, 'What it is worth', { required: true, min: 0, max: 1_000_000 }));
  const note = str(body.note, 'Note', { max: 300 });
  // A list, because a scheme can cover the kitchen and the bistro at once.
  // Nothing ticked means the whole property, which is a real answer.
  const departments = [...new Set((Array.isArray(body.departments)
    ? body.departments
    : [body.department])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (departments.length > 40) throw badRequest('That is more departments than a property has.');
  for (const name of departments) str(name, 'Department', { max: 60 });

  // The single column is kept in step for the one row it still answers for:
  // exactly one department reads back the same either way, and more than one
  // has no single answer to give.
  const department = departments.length === 1 ? departments[0] : null;
  const departmentList = departments.length ? JSON.stringify(departments) : null;

  // Scored, or a set figure each. A figure is just an award scored at a
  // hundred, so nothing downstream has to know the difference — what changes is
  // what somebody is asked to type.
  // Three shapes. Scored out of a hundred; a set figure each; or a ladder of
  // scores with a stated amount on every rung.
  const kind = ['amount', 'tier'].includes(body.kind) ? body.kind : 'score';
  const tiers = readTiers(body.tiers);
  if (kind === 'tier' && !tiers.length) {
    throw badRequest('A tiered scheme needs its scores and what each one is worth.');
  }
  const tierList = tiers.length ? JSON.stringify(tiers) : null;
  const staffIds = Array.isArray(body.staffIds)
    ? [...new Set(body.staffIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];

  let id = body.id ? int(body.id, 'Scheme', { min: 1 }) : null;
  if (id) {
    const found = await ctx.db.prepare('SELECT id FROM pay_scheme WHERE id = ?').bind(id).first();
    if (!found) throw notFound('No such scheme.');
    await ctx.db.prepare(
      'UPDATE pay_scheme SET name = ?2, amount = ?3, note = ?4, active = ?5, department = ?6, '
      + 'departments = ?7, kind = ?8, tiers = ?9 WHERE id = ?1',
    ).bind(
      id, name, amount, note, body.active === false ? 0 : 1, department, departmentList,
      kind, tierList,
    ).run();
  } else {
    const made = await ctx.db.prepare(
      'INSERT INTO pay_scheme (name, amount, note, department, departments, kind, tiers) '
      + 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id',
    ).bind(name, amount, note, department, departmentList, kind, tierList).first();
    id = made?.id ?? null;
  }

  await ctx.db.prepare('DELETE FROM pay_scheme_staff WHERE scheme_id = ?').bind(id).run();
  for (const staffId of staffIds) {
    await ctx.db.prepare(
      'INSERT OR IGNORE INTO pay_scheme_staff (scheme_id, staff_id) VALUES (?1, ?2)',
    ).bind(id, staffId).run();
  }

  await audit(ctx, 'payroll.scheme', id, {
    name, amount, kind, tiers, departments, people: staffIds.length,
  });
  return json({ ok: true, id, name, people: staffIds.length });
}

/** Take a scheme off the books. Past payslips keep what they paid. */
export async function removeScheme(ctx, idParam) {
  const id = int(idParam, 'Scheme', { required: true, min: 1 });
  await ctx.db.prepare('DELETE FROM pay_scheme WHERE id = ?').bind(id).run();
  await audit(ctx, 'payroll.scheme_remove', id, {});
  return json({ ok: true });
}

/**
 * Start a month from the one before it.
 *
 * What somebody is paid and what schemes they are under are standing things:
 * those carry over on their own and there is nothing to copy. What does not
 * is the month's own working, and most of that is the same as last month's
 * with two or three lines changed. Typing thirty scores again to change two
 * is how a wrong one gets typed.
 *
 * MISCONDUCT DOES NOT COPY UNLESS IT IS ASKED FOR. Money taken off the bonus
 * belongs to the month it happened in. Carrying it forward by default would
 * dock somebody twice for one thing, and they would find out on payday.
 */
export async function copyRun(ctx) {
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);
  const from = isMonth(body.from) ? body.from : addMonths(month, -1);
  if (from >= month) throw badRequest('A month can only be started from an earlier one.');

  const source = await ctx.db.prepare('SELECT * FROM pay_run WHERE month = ?')
    .bind(runKey(from, companyIdOf(ctx))).first();
  if (!source) throw notFound(`There is no payroll for ${from} to copy.`);

  const run = await runFor(ctx.db, month, actorOf(ctx), { company: companyIdOf(ctx) });
  if (run.status === 'final') {
    throw badRequest('That month is closed. Open it again before copying anything into it.');
  }

  const wantsPenalties = body.penalties === true;

  // Only scores for a scheme somebody is still under. A person taken off a
  // scheme since last month is not scored on it, and a scheme that has gone
  // has nothing to score.
  const carried = await ctx.db.prepare(
    `SELECT s.scheme_id, s.staff_id, s.score, s.amount, s.tier, sc.kind, sc.tiers
       FROM pay_score s
       JOIN pay_scheme_staff m
         ON m.scheme_id = s.scheme_id AND m.staff_id = s.staff_id
       JOIN pay_scheme sc ON sc.id = s.scheme_id
       JOIN att_staff p ON p.id = s.staff_id AND p.active = 1
      WHERE s.run_id = ?1`,
  ).bind(source.id).all();

  let scores = 0;
  for (const row of carried.results ?? []) {
    // A scored scheme carries the score and forgets the award, so a scheme
    // whose worth has changed since pays the new figure. A scheme that pays a
    // set amount carries the amount, because that amount is the whole answer
    // and it is different for each person.
    //
    // A tiered one carries the rung and looks the money up again, which is the
    // scored rule rather than the set-figure one: a table moved since last
    // month is the property having decided a 4 is worth more now, and the
    // month being started is the one that should pay it.
    let award = row.kind === 'amount' && row.amount != null ? round2(row.amount) : null;
    let tier = null;
    if (row.kind === 'tier' && row.tier != null) {
      const worth = tierAmount(row.tiers, row.tier);
      // A rung that has gone from the table since carries nothing. Guessing
      // what a score nobody offers any more is worth is not the app's to do.
      if (worth == null) continue;
      tier = round2(row.tier);
      award = worth;
    }

    await ctx.db.prepare(
      `INSERT INTO pay_score (run_id, scheme_id, staff_id, score, amount, tier)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (run_id, scheme_id, staff_id)
       DO UPDATE SET score = ?4, amount = ?5, tier = ?6`,
    ).bind(run.id, row.scheme_id, row.staff_id, round2(row.score), award, tier).run();
    scores += 1;
  }

  let penalties = 0;
  if (wantsPenalties) {
    const old = await ctx.db.prepare(
      `SELECT p.staff_id, p.amount, p.reason
         FROM pay_penalty p JOIN att_staff s ON s.id = p.staff_id AND s.active = 1
        WHERE p.run_id = ?1 ORDER BY p.id`,
    ).bind(source.id).all();
    // Wholesale, like the scores: copying onto a month that already has some
    // would double them, and the button says it replaces.
    await ctx.db.prepare('DELETE FROM pay_penalty WHERE run_id = ?').bind(run.id).run();
    for (const row of old.results ?? []) {
      await ctx.db.prepare(
        'INSERT INTO pay_penalty (run_id, staff_id, amount, reason, actor) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind(run.id, row.staff_id, round2(row.amount), row.reason, actorOf(ctx)).run();
      penalties += 1;
    }
  }

  await audit(ctx, 'payroll.copy', month, { from, scores, penalties });
  return json({ ok: true, month, from, scores, penalties });
}

/** This month's scores, scheme by scheme, in one submission. */
export async function setScores(ctx) {
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);
  const run = await runFor(ctx.db, month, actorOf(ctx), { company: companyIdOf(ctx) });
  if (run.status === 'final') throw badRequest('That month is closed. Reopen it first.');

  const rows = Array.isArray(body.rows) ? body.rows : [];
  let set = 0;

  for (const line of rows) {
    const schemeId = int(line.schemeId, 'Scheme', { required: true, min: 1 });
    const staffId = int(line.staffId, 'Who', { required: true, min: 1 });

    const scheme = await ctx.db.prepare('SELECT amount, kind, tiers FROM pay_scheme WHERE id = ?')
      .bind(schemeId).first();
    if (!scheme) continue;

    // A scheme that pays a set figure stores the figure as the award and a
    // hundred as the score, because the award is worked out downstream as the
    // award scaled by the score. Half of nothing new to learn, and one figure
    // on the payslip either way.
    //
    // A tiered one is the same trick with a lookup in front of it: the score
    // picks a rung, the rung says the money, and the money is stored as the
    // award. The rung is kept beside it rather than worked back out of the
    // figure, because two rungs worth the same are still two different things
    // to have said about somebody, and a table that moves next year must not
    // rewrite what was decided this one.
    const paysAmount = scheme.kind === 'amount';
    const byTier = scheme.kind === 'tier';

    let tier = null;
    let score;
    let award;

    if (byTier) {
      tier = round2(num(line.score ?? line.tier, 'Score', { required: true, min: 0, max: 1000 }));
      const worth = tierAmount(scheme.tiers, tier);
      if (worth == null) {
        throw badRequest(`${tier} is not one of the scores that scheme pays for.`);
      }
      score = 100;
      award = worth;
    } else {
      score = paysAmount ? 100 : round2(num(line.score, 'Score', { min: 0, max: 100 }));
      award = paysAmount
        ? round2(num(line.amount, 'How much', { min: 0, max: 1_000_000 }))
        : round2(scheme.amount);
    }

    await ctx.db.prepare(
      `INSERT INTO pay_score (run_id, scheme_id, staff_id, score, amount, tier)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (run_id, scheme_id, staff_id)
       DO UPDATE SET score = ?4, amount = ?5, tier = ?6`,
    ).bind(run.id, schemeId, staffId, score, award, tier).run();
    set += 1;
  }

  await audit(ctx, 'payroll.scores', month, { set });
  return json({ ok: true, month, set });
}

/**
 * A scored scheme's month, out of the Maintenance app: the Ahokeka bonus.
 *
 * Asks Maintenance what each artisan earned in the month and says the score
 * that pays it. Saves nothing: the screen fills the boxes, and the scores are
 * saved the usual way once somebody has looked at them. See
 * lib/maintenance-bonus.js for how a month and a score are worked out.
 */
export async function fromMaintenance(ctx) {
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  const schemeId = int(body.schemeId, 'Scheme', { required: true, min: 1 });
  const scheme = await ctx.db.prepare('SELECT id, name, amount, kind FROM pay_scheme WHERE id = ?')
    .bind(schemeId).first();
  if (!scheme) throw notFound('That scheme is not on the books.');
  if (['amount', 'tier'].includes(scheme.kind)) {
    throw badRequest('Maintenance sends a score out of a hundred, and this scheme pays a set figure or by tier.');
  }
  const [members, staff] = await Promise.all([
    ctx.db.prepare('SELECT staff_id FROM pay_scheme_staff WHERE scheme_id = ?').bind(schemeId).all(),
    ctx.db.prepare('SELECT id, name, employee_no FROM att_staff').all(),
  ]);
  const sent = await askMaintenance(ctx.env.MAINTENANCE_LINK, month, ctx.fetchMaintenance ?? fetch);
  const out = scoresFor({ ...scheme, staffIds: (members.results ?? []).map((m) => m.staff_id) },
    staff.results ?? [], sent);
  await audit(ctx, 'payroll.maintenance', month, { scheme: schemeId, lines: out.lines.length });
  return json({ ok: true, ...out });
}

/**
 * The late-report deductions, out of Maintenance, put on the payroll.
 *
 * Maintenance marks a weekly report not sent within four hours of being due:
 * GHS 50 off, "Late submission of report". This asks for this month's and
 * last month's (one marked just before midnight on the last day is still
 * found), and puts each on the person's payroll for the month it was marked
 * in, matched by employee number. If that month is already closed it goes on
 * this month instead, so it is never lost. Each is put on once, however often
 * this runs, and the person is told on the spot, as with any deduction.
 *
 * One Maintenance withdrew (an admin withdrew the report) is taken back off,
 * while the month it is on is still open.
 *
 * Runs on its own, from the scheduler, as "Maintenance (automatic)". Does
 * nothing until HIVE is linked to Maintenance.
 */
export async function takeMaintenanceDeductions(env, { fetchImpl = fetch, today = null } = {}) {
  const out = { added: 0, removed: 0, unmatched: [] };
  if (!env?.MAINTENANCE_LINK || !env.DB) return out;
  const db = env.DB;
  const ctx = { db, env, session: { user: { name: 'Maintenance', role: 'automatic' } } };
  const actor = actorOf(ctx);
  const { timezone } = await settingsOf(db);
  const thisMonth = monthOf(today ?? todayIn(timezone));
  const staff = (await db.prepare('SELECT id, name, employee_no, company_id FROM att_staff').all()
    .catch(() => db.prepare('SELECT id, name, employee_no FROM att_staff').all())).results ?? [];
  const byNo = new Map();
  for (const person of staff) {
    const no = cleanNo(person.employee_no);
    if (no) byNo.set(no, person);
  }

  for (const month of [addMonths(thisMonth, -1), thisMonth]) {
    const sent = await askMaintenancePenalties(env.MAINTENANCE_LINK, month, fetchImpl);
    const still = new Set();
    for (const p of sent.penalties) {
      // The month in the key: what is withdrawn is looked for by month.
      const source = `maintenance:${month}:${p.id}`;
      still.add(source);
      const amount = round2(Number(p.amount) || 0);
      if (amount <= 0) continue;
      if (await db.prepare('SELECT 1 FROM pay_penalty WHERE source = ?').bind(source).first()) continue;
      const person = byNo.get(cleanNo(p.employee_no));
      if (!person) {
        out.unmatched.push(`${p.name ?? 'Somebody'} (${p.employee_no ? `no one in HIVE is ${p.employee_no}` : 'no employee number in Maintenance'})`);
        continue;
      }
      let into = month;
      let run = await runFor(db, into, actor, { company: companyOf(person) });
      if (run.status === 'final' && into !== thisMonth) {
        into = thisMonth;
        run = await runFor(db, into, actor, { company: companyOf(person) });
      }
      if (run.status === 'final') {
        out.unmatched.push(`${person.name} (${into} is closed)`);
        continue;
      }
      const reason = String(p.reason || 'Late submission of report').slice(0, 300);
      const done = await db.prepare(
        'INSERT OR IGNORE INTO pay_penalty (run_id, staff_id, amount, reason, actor, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      ).bind(run.id, person.id, amount, reason, actor, source).run();
      if (!done?.meta?.changes) continue;
      out.added++;
      await audit(ctx, 'payroll.penalty', person.id, { month: into, amount, reason, from: 'Maintenance', week: p.week ?? null });
      await tellOfDeduction(ctx, person.id, amount, into, reason).catch((err) => console.error('Deduction notice failed', err));
    }

    // Withdrawn in Maintenance: taken back off, unless the month is closed.
    const ours = (await db.prepare(
      `SELECT p.id, p.source, p.staff_id, p.amount, r.status FROM pay_penalty p JOIN pay_run r ON r.id = p.run_id
        WHERE p.source LIKE ?1`,
    ).bind(`maintenance:${month}:%`).all()).results ?? [];
    for (const row of ours) {
      if (still.has(row.source) || row.status === 'final') continue;
      await db.prepare('DELETE FROM pay_penalty WHERE id = ?').bind(row.id).run();
      out.removed++;
      await audit(ctx, 'payroll.penalty_remove', row.id, { amount: round2(row.amount), why: 'Withdrawn in Maintenance' });
    }
  }
  return out;
}

/** Money off somebody's bonus, with the reason it came off. */
/**
 * What somebody was paid off with, for the month it went out in.
 *
 * Column 26 of the return asks for it. Nothing else on the form moves: what
 * severance costs in tax depends on what it was for, and that is a decision
 * above a payroll. So it is recorded, reported, and left alone.
 */
export async function addSeverance(ctx) {
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);
  const run = await runFor(ctx.db, month, actorOf(ctx), { company: companyIdOf(ctx) });
  if (run.status === 'final') throw badRequest('That month is closed. Reopen it first.');

  const staffId = int(body.staffId, 'Who', { required: true, min: 1 });
  const amount = round2(num(body.amount, 'How much', { required: true, min: 0.01, max: 10_000_000 }));
  const note = str(body.note, 'What it was for', { max: 300 });

  await ctx.db.prepare(
    'INSERT INTO pay_severance (run_id, staff_id, amount, note, actor) VALUES (?1, ?2, ?3, ?4, ?5)',
  ).bind(run.id, staffId, amount, note, actorOf(ctx)).run();

  await audit(ctx, 'payroll.severance', staffId, { month, amount, note });
  return json({ ok: true });
}

/** Taking one back off, for a month still open. */
export async function removeSeverance(ctx, idParam) {
  const id = int(idParam, 'Which one', { required: true, min: 1 });
  const row = await ctx.db.prepare(
    'SELECT v.*, r.status FROM pay_severance v JOIN pay_run r ON r.id = v.run_id WHERE v.id = ?',
  ).bind(id).first();
  if (!row) throw notFound('No such severance.');
  if (row.status === 'final') throw badRequest('That month is closed. Reopen it first.');

  await ctx.db.prepare('DELETE FROM pay_severance WHERE id = ?').bind(id).run();
  await audit(ctx, 'payroll.severance.removed', row.staff_id, { amount: row.amount });
  return json({ ok: true });
}

/**
 * The address on their personnel record, where their login has none. A login
 * needs a PIN and nothing else, so most carry no address, and somebody told
 * of a deduction would otherwise get the bell and never the email.
 */
async function recordEmailFor(db, userId) {
  const known = await db.prepare(
    `SELECT u.email AS login_email, hp.personal_email
       FROM users u LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id
      WHERE u.id = ?`,
  ).bind(Number(userId)).first().catch(() => null);
  return known && !isEmail(String(known.login_email || '').trim()) ? firstUsableEmail(known.personal_email) : null;
}

/** The email for money off somebody's bonus. */
function penaltyMail(ctx, { amount, currency, month, reason }) {
  try {
    const when = isMonth(month) ? sayMonth(month) : null;
    return {
      tone: 'warn', status: 'Off your bonus', eyebrow: 'Payroll',
      headline: `${money(amount, currency)} has come off your bonus`,
      facts: [
        ['Amount', money(amount, currency), { big: true, strong: true }],
        ['Month', when],
        ['Set by', ctx.session?.user?.name ?? null],
      ],
      quote: reason ? { by: 'The reason', text: reason } : undefined,
      note: reason
        ? 'If you think this is wrong, ask the office.'
        : 'It was set on this month\u2019s payroll sheet. Ask the office if it is not what you expected.',
      button: 'See My report',
      subject: `${money(amount, currency)} has come off your ${when ? `${when} ` : ''}bonus`,
      preheader: reason || 'Set on this month\u2019s payroll sheet.',
      why: 'You get this because it affects your pay.',
    };
  } catch {
    return undefined;
  }
}

/**
 * Tell somebody money has come off their bonus, now rather than on payday.
 * The same message whether it was entered on the screen or came in on a sheet.
 */
async function tellOfDeduction(ctx, staffId, amount, month, reason = null) {
  const { currency } = await settingsOf(ctx.db);
  const person = await ctx.db.prepare(
    'SELECT u.id AS user_id FROM users u WHERE u.staff_id = ? AND u.active = 1',
  ).bind(staffId).first().catch(() => null);
  if (!person?.user_id) return;
  await createNotice(ctx.db, {
    kind: 'payroll.penalty',
    level: 'warn',
    title: `${money(amount, currency)} has come off your bonus for ${month}`,
    body: reason ?? 'Set on this month\u2019s payroll sheet. Ask the office if it is not what you expected.',
    link: '#/att-my-report',
    actor: actorOf(ctx),
    userId: person.user_id,
    push: true,
    email: true,
    emailTo: await recordEmailFor(ctx.db, person.user_id),
    mail: penaltyMail(ctx, { amount, currency, month, reason }),
  }, ctx);
}

export async function addPenalty(ctx) {
  const body = await readJson(ctx.request);
  const { timezone, currency } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);
  const run = await runFor(ctx.db, month, actorOf(ctx), { company: companyIdOf(ctx) });
  if (run.status === 'final') throw badRequest('That month is closed. Reopen it first.');

  const staffId = int(body.staffId, 'Who', { required: true, min: 1 });
  const amount = round2(num(body.amount, 'How much', { required: true, min: 0.01, max: 1_000_000 }));
  const reason = str(body.reason, 'What happened', { required: true, max: 300 });

  await ctx.db.prepare(
    'INSERT INTO pay_penalty (run_id, staff_id, amount, reason, actor) VALUES (?1, ?2, ?3, ?4, ?5)',
  ).bind(run.id, staffId, amount, reason, actorOf(ctx)).run();

  await audit(ctx, 'payroll.penalty', staffId, { month, amount, reason });

  // Told, and told now rather than on payday. A deduction somebody first hears
  // about when they open their payslip is an argument the property has chosen
  // to have at the worst possible moment.
  const person = await ctx.db.prepare(
    `SELECT s.name, u.id AS user_id FROM att_staff s
       LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1 WHERE s.id = ?`,
  ).bind(staffId).first();
  if (person?.user_id) {
    await createNotice(ctx.db, {
      kind: 'payroll.penalty',
      level: 'warn',
      title: `${money(amount, currency)} has come off your bonus for ${month}`,
      body: reason,
      link: '#/att-my-report',
      actor: actorOf(ctx),
      userId: person.user_id,
      push: true,
      email: true,
      emailTo: await recordEmailFor(ctx.db, person.user_id),
      mail: penaltyMail(ctx, { amount, currency, month, reason }),
    }, ctx);
  }

  return json({ ok: true });
}

/**
 * Money off somebody's bonus that Insight asked for: a management report sent
 * more than four hours late, say. It goes on the first payroll from today that
 * is still open, for the company the person is paid by, with its reason, and
 * they are told now, as for any deduction. Asked twice with the same key, it is
 * taken once.
 */
export async function dockFromInsight(linkCtx, { staffId, amount, reason, key, by = 'Insight' }) {
  // Nobody is signed in: Insight, on behalf of whoever it names, is who did it.
  const ctx = { ...linkCtx, session: { user: { name: by, role: 'Insight' } } };
  const again = key ? await ctx.db.prepare('SELECT p.id, r.month FROM pay_penalty p JOIN pay_run r ON r.id = p.run_id WHERE p.link_key = ?1').bind(key).first() : null;
  if (again) return { id: again.id, month: monthOfRun(again.month), again: true };
  const { timezone } = await settingsOf(ctx.db);
  const month = await tillMonthFor(ctx.db, todayIn(timezone), staffId);
  const staff = await ctx.db.prepare('SELECT company_id FROM att_staff WHERE id = ?1').bind(staffId).first().catch(() => null);
  const run = await runFor(ctx.db, month, `${by} (Insight)`, { company: Number(staff?.company_id) || MAIN });
  if (run.status === 'final') throw badRequest(`${sayMonth(month)} payroll is closed, so nothing can come off it.`);
  const row = await ctx.db.prepare(
    'INSERT INTO pay_penalty (run_id, staff_id, amount, reason, actor, link_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id',
  ).bind(run.id, staffId, round2(amount), reason, actorOf(ctx), key || null).first();
  await audit(ctx, 'payroll.penalty', staffId, { month, amount: round2(amount), reason, from: 'Insight' }).catch(() => {});
  await tellOfDeduction(ctx, staffId, round2(amount), month, reason).catch(() => {});
  return { id: row.id, month };
}

/** Take one back off. */
export async function removePenalty(ctx, idParam) {
  const id = int(idParam, 'Deduction', { required: true, min: 1 });
  const row = await ctx.db.prepare(
    `SELECT p.*, r.status FROM pay_penalty p JOIN pay_run r ON r.id = p.run_id WHERE p.id = ?`,
  ).bind(id).first();
  if (!row) throw notFound('No such deduction.');
  if (row.status === 'final') throw badRequest('That month is closed. Reopen it first.');

  await ctx.db.prepare('DELETE FROM pay_penalty WHERE id = ?').bind(id).run();
  await audit(ctx, 'payroll.penalty_remove', id, { amount: round2(row.amount) });
  return json({ ok: true });
}

// --------------------------------------------------------------------------
// Closing it
// --------------------------------------------------------------------------

/**
 * Close the month.
 *
 * Everything is worked out one last time, written down as it stands, and the
 * advance repayments are recorded against the balances they came off. After
 * this the figures are a record rather than a calculation.
 */
export async function closeRun(ctx) {
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);

  const run = await runFor(ctx.db, month, actorOf(ctx), { company: companyIdOf(ctx) });
  if (run.status === 'final') throw badRequest('That month is already closed.');

  const data = await gather(ctx, month);
  const lines = linesFrom(data, month);
  if (!lines.length) throw badRequest('Nobody is on the payroll for that month.');

  for (const line of lines) {
    await ctx.db.prepare(
      `INSERT INTO pay_slip (run_id, staff_id, detail, gross, bonus_gross, ssf_employee,
                             ssf_employer, paye, loans, net, cost)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (run_id, staff_id) DO UPDATE
         SET detail = ?3, gross = ?4, bonus_gross = ?5, ssf_employee = ?6, ssf_employer = ?7,
             paye = ?8, loans = ?9, net = ?10, cost = ?11`,
    ).bind(
      run.id, line.staff.id, JSON.stringify(line), line.gross, line.bonus.gross,
      line.ssnit.employee, line.ssnit.employer, line.paye.total, line.loanTotal,
      line.net, line.employerCost,
    ).run();

    // Late charges that did not fit this month's take-home wait for the next.
    if (line.lateWaiting?.length) {
      await deferLateCharges(ctx.db, line.lateWaiting.map((c) => c.chargeId), month);
    }

    // And the repayments, against the advances they came off. Skipped where
    // the month has already been answered by hand, which the unique index
    // would refuse anyway.
    for (const loan of line.loans) {
      if (loan.advanceId == null) continue;
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO hr_advance_entry (advance_id, month, kind, amount, note, actor, source)
         VALUES (?1, ?2, 'repayment', ?3, ?4, ?5, 'payroll')`,
      ).bind(loan.advanceId, month, loan.amount, `From the payroll for ${month}`, actorOf(ctx))
        .run().catch(() => {});

      const entries = await ctx.db.prepare(
        'SELECT * FROM hr_advance_entry WHERE advance_id = ?',
      ).bind(loan.advanceId).all().catch(() => ({ results: [] }));
      const advance = data.advances.find((a) => a.id === loan.advanceId);
      if (advance && balanceOf(advance, entries.results ?? []) <= 0.009) {
        await ctx.db.prepare(
          "UPDATE hr_advance SET status = 'settled', settled_at = datetime('now') WHERE id = ?",
        ).bind(loan.advanceId).run();
      }
    }
  }

  // Nothing was due in the month, but the advances screen should still know
  // somebody has been through it.
  // DO NOTHING rather than DO UPDATE. A month somebody had already closed off
  // by hand is their answer, with their name and their note on it, and the
  // payroll stamping its own over the top loses that — and then reopening the
  // payroll deletes a mark the payroll never set.
  await ctx.db.prepare(
    `INSERT INTO hr_advance_month (month, closed_by, note) VALUES (?1, ?2, ?3)
     ON CONFLICT (month) DO NOTHING`,
  ).bind(month, actorOf(ctx), closedWithNote(ctx, month)).run().catch(() => {});

  await ctx.db.prepare(
    "UPDATE pay_run SET status = 'final', closed_by = ?2, closed_at = datetime('now'), note = ?3 WHERE id = ?1",
  ).bind(run.id, actorOf(ctx), str(body.note, 'Note', { max: 300 })).run();

  const totals = totalsOf(lines);
  await audit(ctx, 'payroll.close', runKey(month, companyIdOf(ctx)), totals);

  return json({ ok: true, month, company: companyIdOf(ctx), people: lines.length, totals });
}

/**
 * What closing a payroll writes against the advances month. Another company's
 * says which, so reopening one company's payroll only takes back its own.
 */
const closedWithNote = (ctx, month) => (companyIdOf(ctx) === MAIN
  ? `Closed with the payroll for ${month}`
  : `Closed with the ${ctx.company?.legalName || 'other company'} payroll for ${month}`);

/**
 * Open a closed month again.
 *
 * Takes back exactly what closing it wrote — the payslips, and the advance
 * repayments it recorded — and nothing else. A repayment somebody entered by
 * hand stays, because the payroll did not put it there.
 */
export async function reopenRun(ctx) {
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  await useCompany(ctx, body.company);

  const run = await ctx.db.prepare('SELECT * FROM pay_run WHERE month = ?')
    .bind(runKey(month, companyIdOf(ctx))).first();
  if (!run) throw notFound('No payroll for that month.');
  if (run.status !== 'final') throw badRequest('That month is not closed.');

  // The repayments this run recorded: the payroll's own, for the people on its
  // payslips. Taken back before the payslips go, because they are how the
  // people are found. Another company's payroll the same month keeps its own.
  const undone = await ctx.db.prepare(
    `DELETE FROM hr_advance_entry
      WHERE month = ?1 AND source = 'payroll'
        AND advance_id IN (SELECT a.id FROM hr_advance a
                             JOIN pay_slip s ON s.staff_id = a.staff_id
                            WHERE s.run_id = ?2)`,
  ).bind(month, run.id).run().catch(() => null);
  await ctx.db.prepare('DELETE FROM pay_slip WHERE run_id = ?').bind(run.id).run();

  // And the advances month it closed off, if it was this that closed it. Only
  // its own mark: a month somebody closed off by hand on the Advances page is
  // their answer, not the payroll's, and the same rule that leaves their
  // repayments alone leaves this alone too.
  await ctx.db.prepare(
    'DELETE FROM hr_advance_month WHERE month = ? AND note = ?',
  ).bind(month, closedWithNote(ctx, month)).run().catch(() => {});

  // An advance settled by a repayment that has just been taken back is not
  // settled any more.
  await ctx.db.prepare(
    `UPDATE hr_advance SET status = 'approved', settled_at = NULL
      WHERE status = 'settled' AND id IN (
        SELECT id FROM hr_advance WHERE amount > (
          SELECT COALESCE(SUM(amount), 0) FROM hr_advance_entry WHERE advance_id = hr_advance.id))`,
  ).run().catch(() => {});

  await ctx.db.prepare(
    "UPDATE pay_run SET status = 'draft', closed_by = NULL, closed_at = NULL WHERE id = ?",
  ).bind(run.id).run();

  await audit(ctx, 'payroll.reopen', runKey(month, companyIdOf(ctx)), { repayments: Number(undone?.meta?.changes ?? 0) });
  return json({ ok: true, month, company: companyIdOf(ctx) });
}

const money = (amount, currency = 'GHS') => {
  const n = round2(amount);
  return `${currency} ${n.toLocaleString('en-GB', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

// --------------------------------------------------------------------------
// Payslips by email
// --------------------------------------------------------------------------

/**
 * Where an emailed payslip goes: the personal email on the staff record,
 * else the address they sign in with.
 */
async function slipAddresses(db, staffIds) {
  if (!staffIds.length) return new Map();
  const rows = await db.prepare(
    `SELECT s.id AS staff_id, u.email AS login_email, hp.personal_email
       FROM att_staff s
       LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
       LEFT JOIN hr_profile hp ON hp.staff_id = s.id
      WHERE s.id IN (${staffIds.map(() => '?').join(',')})`,
  ).bind(...staffIds).all().catch(() => ({ results: [] }));
  const out = new Map();
  for (const r of rows.results ?? []) {
    const id = Number(r.staff_id);
    const found = firstUsableEmail(r.personal_email, r.login_email);
    if (found || !out.has(id)) out.set(id, found);
  }
  return out;
}

async function slipHash(detail) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(detail ?? '')));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The closed run and its slips, or a refusal that says why. */
async function closedSlips(ctx, month) {
  const run = await ctx.db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(runKey(month, companyIdOf(ctx))).first();
  if (!run || run.status !== 'final') throw badRequest('Only a closed month can be emailed: close the payroll first.');
  const slips = (await ctx.db.prepare(
    `SELECT p.staff_id, p.detail, s.name, s.department FROM pay_slip p JOIN att_staff s ON s.id = p.staff_id
      WHERE p.run_id = ? ORDER BY s.name`,
  ).bind(run.id).all()).results ?? [];
  return { run, slips };
}

/**
 * Who has been sent their payslip for the month, and who has not: the
 * latest attempt for each, and whether the slip changed since.
 */
export async function slipMailList(ctx) {
  if (!isAdmin(ctx.session)) throw forbiddenHere('Payslips are an administrator’s to send.');
  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(ctx.url.searchParams.get('month')) ? ctx.url.searchParams.get('month') : monthOf(todayIn(timezone));
  await useCompany(ctx, null);
  const run = await ctx.db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(runKey(month, companyIdOf(ctx))).first();
  if (!run || run.status !== 'final') return json({ month, closed: false, people: [] });
  const { slips } = await closedSlips(ctx, month);
  const addresses = await slipAddresses(ctx.db, slips.map((s) => s.staff_id));
  const tries = (await ctx.db.prepare('SELECT * FROM pay_slip_mail WHERE run_id = ? ORDER BY id').bind(run.id).all()
    .catch(() => ({ results: [] }))).results ?? [];
  const last = new Map();
  for (const t of tries) last.set(Number(t.staff_id), t);
  const people = [];
  for (const s of slips) {
    const t = last.get(Number(s.staff_id)) ?? null;
    // eslint-disable-next-line no-await-in-loop
    const changed = t?.status === 'sent' && t.slip_hash ? t.slip_hash !== await slipHash(s.detail) : false;
    people.push({
      staffId: s.staff_id,
      name: s.name,
      department: s.department ?? null,
      email: addresses.get(Number(s.staff_id)) ?? null,
      status: t ? t.status : (addresses.get(Number(s.staff_id)) ? 'not_sent' : 'no_email'),
      sentTo: t?.address ?? null,
      at: t?.at ?? null,
      by: t?.by_name ?? null,
      error: t?.status === 'failed' ? t.error : null,
      changed,
    });
  }
  return json({ month, closed: true, people });
}

/**
 * Email payslips: each person their own, as a PDF attached. A few at a time,
 * so the screen can show them going and a slow one does not hold up the rest.
 */
export async function sendSlipMail(ctx, { send = emailPersonally } = {}) {
  if (!isAdmin(ctx.session)) throw forbiddenHere('Payslips are an administrator’s to send.');
  const body = await readJson(ctx.request);
  const { timezone, settings, currency } = await settingsOf(ctx.db);
  if (!isMonth(body.month)) throw badRequest('Which month?');
  const month = body.month;
  await useCompany(ctx, body.company);
  const wanted = [...new Set((Array.isArray(body.staffIds) ? body.staffIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!wanted.length) throw badRequest('Choose who to send them to.');
  if (wanted.length > 10) throw badRequest('Ten at a time at most.');
  const note = str(body.note, 'A line from you', { max: 400 });
  const copyTo = bool(body.copy) && isEmail(String(ctx.session.user.email ?? '').trim()) ? [String(ctx.session.user.email).trim()] : [];

  const { run, slips } = await closedSlips(ctx, month);
  const company = ctx.company ?? {};
  const property = settings.property_name || 'HIVE';
  const employer = company.legalName || property;
  const logo = await companyLogoBytes(ctx.db, companyIdOf(ctx)).catch(() => null);
  const addresses = await slipAddresses(ctx.db, wanted);
  const nice = sayMonth(month);
  const sentAt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());

  const results = [];
  for (const staffId of wanted) {
    const slip = slips.find((s) => Number(s.staff_id) === staffId);
    if (!slip) { results.push({ staffId, status: 'failed', error: 'Not on this month’s payroll.' }); continue; }
    const to = addresses.get(staffId) ?? null;
    if (!to) { results.push({ staffId, status: 'no_email' }); continue; }
    const line = JSON.parse(slip.detail);
    let status = 'sent';
    let error = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const pdf = await payslipPdf({ line, company, property, month, currency, logo, sentAt });
      let binary = '';
      for (let i = 0; i < pdf.length; i += 0x8000) binary += String.fromCharCode(...pdf.subarray(i, i + 0x8000));
      const first = String(slip.name ?? '').trim().split(/\s+/)[0] || 'there';
      // eslint-disable-next-line no-await-in-loop
      const out = await send(ctx.db, ctx.env, {
        kind: 'payroll.payslip',
        title: `Your payslip for ${nice}`,
        body: `Attached as a PDF.${note ? ` ${note}` : ''}`,
        link: '#/att-my-payslips',
        to,
        wanted: true,
        copyTo,
        attachments: [{ filename: payslipFilename(month, slip.name), content: btoa(binary) }],
        mail: {
          subject: `Your payslip for ${nice}`,
          preheader: 'Your payslip is attached as a PDF.',
          eyebrow: 'Payslip',
          headline: `${first}, your ${nice} payslip is attached`,
          intro: 'It is a PDF, one page, and yours only. You can also see it in HIVE under Pay.',
          after: note ? `“${note}”` : null,
          button: 'See it in HIVE',
          why: `No amounts are written in this email. You get it because you are on the payroll of ${employer}.`,
          settingsLink: false,
        },
      });
      if (!Number(out?.sent)) { status = 'failed'; error = out?.reason || 'The email could not be sent.'; }
    } catch (err) {
      status = 'failed';
      error = err.message || 'The email could not be sent.';
    }
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare(
      'INSERT INTO pay_slip_mail (run_id, staff_id, address, status, error, slip_hash, by_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    ).bind(run.id, staffId, to, status, error ? String(error).slice(0, 300) : null, await slipHash(slip.detail), ctx.session.user.name).run();
    results.push({ staffId, status, to, error });
  }
  await audit(ctx, 'payroll.payslips_emailed', runKey(month, companyIdOf(ctx)), {
    sent: results.filter((r) => r.status === 'sent').length, failed: results.filter((r) => r.status === 'failed').length,
  });
  return json({ ok: true, month, results });
}
