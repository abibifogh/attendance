import { badRequest, csvResponse, int, json, notFound, num, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { balanceOf, dueThisMonth } from '../lib/advances.js';
import { computeLine, totalsOf } from '../lib/payroll.js';
import { ratesFrom, round2 } from '../lib/tax.js';
import { PAYE_COLUMNS, journalFor, payeSchedule, tiersFrom } from '../lib/statutory.js';
import { ratesOn } from '../lib/tax-tables.js';
import { readSheet, tallyOf } from '../lib/pay-import.js';
import { isAdmin } from '../lib/payroll-access.js';
import { hasTiers, readTiers, tierAmount } from '../lib/pay-tiers.js';
import { S, colName, workbook } from '../lib/xlsx.js';
import { addMonths, isMonth, monthOf, todayIn } from '../util/dates.js';

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
async function runFor(db, month, actor, { open = true } = {}) {
  const found = await db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(month).first();
  if (found) return found;
  if (!open) return { id: -1, month, status: 'draft' };

  await db.prepare('INSERT OR IGNORE INTO pay_run (month, opened_by) VALUES (?1, ?2)')
    .bind(month, actor).run();
  return db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(month).first();
}

/**
 * Everything one month needs, indexed: who is on the payroll, what they are
 * under, what they scored, what came off, and what they are repaying.
 */
async function gather(ctx, month, { open = true } = {}) {
  const { currency, property, settings } = await settingsOf(ctx.db);

  // The figures that were in force in that month, not the ones in force today.
  // A budget moves the bands in April; March is still a March payroll, and a
  // month reopened in July to fix one allowance must not come back retaxed.
  const tables = await ctx.db.prepare('SELECT * FROM pay_rates').all()
    .catch(() => ({ results: [] }));
  const { rates, tiers, from: ratesFrom_ } = ratesOn(month, tables.results ?? [], settings);

  const run = await runFor(ctx.db, month, actorOf(ctx), { open });

  const [staff, profiles, allowances, schemes, members, scores, penalties, advances, entries, slips]
    = await Promise.all([
      ctx.db.prepare('SELECT id, name, department, employee_no, active FROM att_staff ORDER BY name').all(),
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
      ctx.db.prepare("SELECT * FROM hr_advance WHERE status = 'approved'").all()
        .catch(() => ({ results: [] })),
      ctx.db.prepare('SELECT * FROM hr_advance_entry').all().catch(() => ({ results: [] })),
      ctx.db.prepare('SELECT * FROM pay_slip WHERE run_id = ?').bind(run.id).all(),
    ]);

  // What has already gone out as bonus this year, which the 15% ceiling on the
  // five per cent rate is measured against.
  const year = month.slice(0, 4);
  const earlier = await ctx.db.prepare(
    `SELECT s.staff_id, SUM(s.bonus_gross) AS paid
       FROM pay_slip s JOIN pay_run r ON r.id = s.run_id
      WHERE r.status = 'final' AND r.month LIKE ?1 AND r.month < ?2
      GROUP BY s.staff_id`,
  ).bind(`${year}-%`, month).all().catch(() => ({ results: [] }));

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
    advances: advances.results ?? [],
    entriesBy,
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
    if (!person.active && !data.slipBy.has(person.id)) continue;

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
      ssnit: Boolean(profile.ssnit),
      schemes,
      penalties: (penaltyBy.get(person.id) ?? []).map((p) => ({
        id: p.id, amount: p.amount, reason: p.reason, at: p.at,
      })),
      loans,
      annualBasic: round2(profile.basic * 12),
      bonusPaidThisYear: data.paidBy.get(person.id) ?? 0,
      // Older profiles have nothing written here and every figure in them was
      // entered as a net promise, so the absence reads as net.
      bonusIsNet: profile.bonus_is_net == null ? true : Boolean(profile.bonus_is_net),
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
  if (other === month) return { month: other, netBy: new Map(), status: null };

  const data = await gather(ctx, other, { open: false });

  // A month nobody ever opened has no payroll to compare with. Working one out
  // from today's standing figures would answer "nothing has changed" about a
  // month nobody was paid in — and against a month two years back, where every
  // salary has moved since, that reading is not just useless but wrong.
  if (data.run.id === -1) return { month: other, netBy: new Map(), status: 'none' };

  const netBy = new Map(linesOf(data, other).map((line) => [line.staff.id, round2(line.net)]));
  return {
    month: other,
    netBy,
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

  // A closed month answers from what was written down, not from what the
  // figures happen to say today.
  const closed = data.run.status === 'final';
  const lines = linesOf(data, month);

  // Against another month, so a figure has something to be read beside. Last
  // month unless somebody asked for a different one.
  const compare = await against(ctx, month, ctx.url.searchParams.get('compare'));
  for (const line of lines) {
    line.against = movement(line.net, compare.netBy.get(line.staff.id));
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

  return json({
    month,
    currency: data.currency,
    property: data.property,
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
    penalties: data.penalties.map((p) => ({
      id: p.id, staffId: p.staff_id, amount: round2(p.amount), reason: p.reason, at: p.at,
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
  };
}

/**
 * This month's sheet, already filled in.
 *
 * Not a blank template. Somebody downloads the month as it stands, changes the
 * two figures that changed, and sends it back — which is both less typing and
 * a great deal less to get wrong than a form with the headings and nothing
 * under them.
 */
export async function inputTemplate(ctx) {
  const { timezone } = await settingsOf(ctx.db);
  const month = monthFrom(ctx.url, timezone);
  const c = await sheetContext(ctx, month);

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
    if (!person.active) continue;
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
export async function readInput(ctx) {
  const body = await readJson(ctx.request);
  const text = String(body.text ?? '');
  if (!text.trim()) throw badRequest('There is nothing in that file.');

  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
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
  const text = String(body.text ?? '');
  if (!text.trim()) throw badRequest('There is nothing in that file.');

  const { timezone } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  const c = await sheetContext(ctx, month);
  if (c.data.run.status === 'final') {
    throw badRequest('That month is closed. Open it again before changing anything in it.');
  }

  const read = readSheet(text, c);
  const run = await runFor(ctx.db, month, actorOf(ctx));
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
  const notMade = [];

  for (const line of read.lines) {
    for (const change of line.changes) {
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
        const score = change.paysAmount || change.byTier ? 100 : change.to;
        const award = change.paysAmount ? change.to : (change.byTier ? change.worth : null);
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
    basics, allowances, scores, skipped: read.skipped.length, made,
  });
  return json({
    ok: true,
    month,
    basics,
    allowances,
    scores,
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
            p.tin_number, p.ssnit_number, p.id_type, p.id_number
       FROM att_staff s
       LEFT JOIN hr_profile p ON p.staff_id = s.id`,
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
    position: r.job_title || r.department || '',
  }]));

  const totals = totalsOf(lines);
  const journal = journalFor({ lines, totals, rates: data.rates, tiers: data.tiers });
  const schedule = payeSchedule({ lines, people });

  const missing = schedule.rows.filter((row) => !row.tin || !row.ssnitNumber)
    .map((row) => ({
      name: row.name,
      wants: [!row.tin ? 'TIN' : null, !row.ssnitNumber ? 'SSNIT number' : null].filter(Boolean),
    }));

  return { month, data, lines, totals, journal, schedule, missing };
}

/** The month's journal and PAYE schedule, for the screen. */
export async function returns(ctx) {
  const { month, data, totals, journal, schedule, missing } = await monthReturn(ctx);
  return json({
    month,
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
    // Named rather than counted: whoever files the return has to go and get
    // these, and a number does not tell them whose record to open.
    missing,
  });
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
  const { month, data, lines, totals, journal, schedule } = await monthReturn(ctx);
  const map = (await settingsOf(ctx.db)).settings ?? {};
  const employer = map.company_legal_name || data.property || '';
  const employerTin = map.company_tin || '';
  // The form wants the month as MM/YYYY, and a form headed the wrong month is
  // the one mistake on it nobody notices until the assessment arrives.
  const [year, mm] = String(month).split('-');
  const asFiled = `${mm}/${year}`;

  const money = (n) => ({ v: round2(Number(n) || 0), s: S.money });
  const totalMoney = (n) => ({ v: round2(Number(n) || 0), s: S.moneyTotal });
  const head = (t) => ({ v: t, s: S.head });

  // ---- the month, as the payroll screen shows it ------------------------
  const payHead = ['Name', 'Department', 'Basic', 'Allowances', 'Bonus', 'Gross',
    'SSNIT', 'PAYE', 'Advance', 'Net pay', 'Employer SSNIT', 'Cost'];
  const payRows = lines.map((line) => [
    line.staff?.name ?? '',
    line.staff?.department ?? '',
    money(line.basic),
    money(line.slip?.allowanceTotal ?? line.allowanceTotal),
    money(line.bonus?.net),
    money(line.gross),
    money(line.ssnit?.employee),
    money(line.paye?.total),
    money(line.loanTotal),
    money(line.net),
    money(line.ssnit?.employer),
    money(line.employerCost),
  ]);
  const payTotals = [{ v: 'Everybody', s: S.total }, { v: '', s: S.total },
    totalMoney(totals.basic), totalMoney(totals.allowancesOnSlip ?? totals.allowances),
    totalMoney(totals.bonusNet), totalMoney(totals.gross),
    totalMoney(totals.ssnitEmployee), totalMoney(totals.paye), totalMoney(totals.loans),
    totalMoney(totals.net), totalMoney(totals.ssnitEmployer), totalMoney(totals.cost)];

  const payroll = {
    name: 'Payroll',
    freeze: 4,
    widths: [26, 16, 11, 12, 11, 12, 10, 11, 11, 12, 13, 12],
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
  const cols = PAYE_COLUMNS;
  const last = colName(cols.length - 1);
  const at = (letter, value) => {
    const row = [];
    row[letter.charCodeAt(0) - 65] = value;
    return row;
  };
  const put = (pairs) => {
    const row = [];
    for (const [letter, value] of pairs) row[letter.charCodeAt(0) - 65] = value;
    return row;
  };

  const rows = [
    at('A', { v: 'GHANA REVENUE AUTHORITY', s: S.title }),
    at('A', { v: 'DOMESTIC TAX REVENUE DIVISION', s: S.bold }),
    [], [],
    at('A', { v: "EMPLOYER'S MONTHLY TAX DEDUCTIONS SCHEDULE (P. A. Y. E.)", s: S.title }),
    [],
    put([['A', { v: 'CURRENT TAX OFFICE', s: S.bold }], ['D', 'LTO'], ['F', 'TSC'], ['G', 'NIMA']]),
    put([['D', '(tick one)'], ['G', 'Name of Tax Office']]),
    put([['A', { v: 'NAME OF EMPLOYER', s: S.bold }], ['D', { v: employer, s: S.bold }],
      ['S', { v: 'FOR THE MONTH OF', s: S.bold }], ['U', { v: asFiled, s: S.bold, text: true }]]),
    put([['V', '(MM/YYYY)']]),
    put([['A', { v: "EMPLOYER'S TIN / GH. CARD NO.", s: S.bold }],
      ['D', { v: employerTin, s: S.bold, text: true }]]),
    [],
    // The numbers printed above the columns. Text, not numbers, because the
    // form numbers two of its columns 26 and a spreadsheet asked for a number
    // there quietly makes it 26 twice over as a figure nobody can sort on.
    cols.map((c) => ({ v: c.no, s: S.bold, text: true })),
    at('I', { v: 'PENSIONS', s: S.head }),
    cols.map((c) => head(c.label)),
    [], [],
    ...schedule.rows.map((row) => cols.map((c) => {
      const value = row[c.key];
      if (c.money) return money(value);
      if (c.text) return { v: value ?? '', text: true };
      return value ?? '';
    })),
    cols.map((c, i) => {
      if (i === 0) return { v: 'TOTALS', s: S.total };
      if (!c.money) return { v: '', s: S.total };
      return totalMoney(schedule.totals[c.key]);
    }),
  ];

  const scheduleSheet = {
    name: 'PAYE schedule',
    freeze: 15,
    widths: cols.map((c) => c.width ?? 13),
    // The heading block spans the page the way the form does, and each column
    // heading is three rows tall so the long ones wrap instead of being cut.
    merges: [
      `A1:${last}1`, `A2:${last}2`, `A5:${last}5`,
      'D7:E7', 'G7:N7', 'D8:F8', 'G8:N8', 'D9:N9', 'U9:W9', 'D11:O11',
      'I14:J14',
      ...cols.map((c, i) => `${colName(i)}15:${colName(i)}17`),
    ],
    rows,
  };

  const bytes = workbook([payroll, journalSheet, scheduleSheet]);
  const name = `${(employer || 'Payroll').replace(/[^A-Za-z0-9]+/g, '-')}-payroll-${month}.xlsx`;
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function payslip(ctx, staffParam) {
  const { timezone } = await settingsOf(ctx.db);
  const month = monthFrom(ctx.url, timezone);
  const staffId = int(staffParam, 'Who', { required: true, min: 1 });
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
    line,
  });
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

    await ctx.db.prepare(
      `INSERT INTO pay_profile (staff_id, basic, ssnit, note, set_by, bonus_opening,
                                bonus_opening_year, bonus_is_net)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0), ?7, COALESCE(?8, 1))
       ON CONFLICT (staff_id) DO UPDATE
         SET basic = ?2, ssnit = ?3, note = ?4, set_by = ?5, set_at = datetime('now'),
             bonus_opening = COALESCE(?6, bonus_opening),
             bonus_opening_year = COALESCE(?7, bonus_opening_year),
             bonus_is_net = COALESCE(?8, bonus_is_net)`,
    ).bind(staffId, basic, line.ssnit === false ? 0 : 1,
      str(line.note, 'Note', { max: 300 }), actorOf(ctx),
      opening, said ? openingYear : null, netBonus).run();

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
  const from = isMonth(body.from) ? body.from : addMonths(month, -1);
  if (from >= month) throw badRequest('A month can only be started from an earlier one.');

  const source = await ctx.db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(from).first();
  if (!source) throw notFound(`There is no payroll for ${from} to copy.`);

  const run = await runFor(ctx.db, month, actorOf(ctx));
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
  const run = await runFor(ctx.db, month, actorOf(ctx));
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

/** Money off somebody's bonus, with the reason it came off. */
export async function addPenalty(ctx) {
  const body = await readJson(ctx.request);
  const { timezone, currency } = await settingsOf(ctx.db);
  const month = isMonth(body.month) ? body.month : monthOf(todayIn(timezone));
  const run = await runFor(ctx.db, month, actorOf(ctx));
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
      email: false,
    }, ctx);
  }

  return json({ ok: true });
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

  const run = await runFor(ctx.db, month, actorOf(ctx));
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

    // And the repayments, against the advances they came off. Skipped where
    // the month has already been answered by hand, which the unique index
    // would refuse anyway.
    for (const loan of line.loans) {
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
  await ctx.db.prepare(
    `INSERT INTO hr_advance_month (month, closed_by, note) VALUES (?1, ?2, ?3)
     ON CONFLICT (month) DO UPDATE SET closed_by = ?2, closed_at = datetime('now'), note = ?3`,
  ).bind(month, actorOf(ctx), `Closed with the payroll for ${month}`).run().catch(() => {});

  await ctx.db.prepare(
    "UPDATE pay_run SET status = 'final', closed_by = ?2, closed_at = datetime('now'), note = ?3 WHERE id = ?1",
  ).bind(run.id, actorOf(ctx), str(body.note, 'Note', { max: 300 })).run();

  const totals = totalsOf(lines);
  await audit(ctx, 'payroll.close', month, totals);

  return json({ ok: true, month, people: lines.length, totals });
}

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

  const run = await ctx.db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(month).first();
  if (!run) throw notFound('No payroll for that month.');
  if (run.status !== 'final') throw badRequest('That month is not closed.');

  await ctx.db.prepare('DELETE FROM pay_slip WHERE run_id = ?').bind(run.id).run();
  const undone = await ctx.db.prepare(
    "DELETE FROM hr_advance_entry WHERE month = ? AND source = 'payroll'",
  ).bind(month).run().catch(() => null);

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

  await audit(ctx, 'payroll.reopen', month, { repayments: Number(undone?.meta?.changes ?? 0) });
  return json({ ok: true, month });
}

const money = (amount, currency = 'GHS') => {
  const n = round2(amount);
  return `${currency} ${n.toLocaleString('en-GB', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};
