import { badRequest, csvResponse, int, json, notFound, num, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { balanceOf, dueThisMonth } from '../lib/advances.js';
import { computeLine, totalsOf } from '../lib/payroll.js';
import { ratesFrom, round2 } from '../lib/tax.js';
import { PAYE_COLUMNS, journalFor, payeSchedule, tiersFrom } from '../lib/statutory.js';
import { ratesOn } from '../lib/tax-tables.js';
import { readSheet, tallyOf } from '../lib/pay-import.js';
import { isAdmin } from '../lib/payroll-access.js';
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

/** The run for a month, made if it is not there yet. */
async function runFor(db, month, actor) {
  const found = await db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(month).first();
  if (found) return found;

  await db.prepare('INSERT OR IGNORE INTO pay_run (month, opened_by) VALUES (?1, ?2)')
    .bind(month, actor).run();
  return db.prepare('SELECT * FROM pay_run WHERE month = ?').bind(month).first();
}

/**
 * Everything one month needs, indexed: who is on the payroll, what they are
 * under, what they scored, what came off, and what they are repaying.
 */
async function gather(ctx, month) {
  const { currency, property, settings } = await settingsOf(ctx.db);

  // The figures that were in force in that month, not the ones in force today.
  // A budget moves the bands in April; March is still a March payroll, and a
  // month reopened in July to fix one allowance must not come back retaxed.
  const tables = await ctx.db.prepare('SELECT * FROM pay_rates').all()
    .catch(() => ({ results: [] }));
  const { rates, tiers, from: ratesFrom_ } = ratesOn(month, tables.results ?? [], settings);

  const run = await runFor(ctx.db, month, actorOf(ctx));

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
    paidBy: new Map((earlier.results ?? []).map((r) => [r.staff_id, round2(r.paid)])),
  };
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
      rates: data.rates,
      tiers: data.tiers,
    }));
  }

  return lines;
}

// --------------------------------------------------------------------------
// The month
// --------------------------------------------------------------------------

/** The whole month: the people, the schemes, the figures and the totals. */
export async function payroll(ctx) {
  const { timezone } = await settingsOf(ctx.db);
  const month = monthFrom(ctx.url, timezone);
  const data = await gather(ctx, month);

  // A closed month answers from what was written down, not from what the
  // figures happen to say today.
  const closed = data.run.status === 'final';
  const lines = closed
    ? data.staff
      .map((person) => data.slipBy.get(person.id))
      .filter(Boolean)
      .map((slip) => JSON.parse(slip.detail))
    : linesFrom(data, month);

  const memberOf = new Map();
  for (const [schemeId, rows] of data.memberBy.entries()) {
    for (const row of rows) {
      if (!memberOf.has(row.staff_id)) memberOf.set(row.staff_id, []);
      memberOf.get(row.staff_id).push(schemeId);
    }
  }
  const scoreBy = new Map(data.scores.map((r) => [`${r.scheme_id}|${r.staff_id}`, r.score]));

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
      bands: data.rates.bands,
      // The month a dated table started. Null where the property has never
      // dated one, which means the figures it is using now are the only ones
      // it has ever used.
      from: data.ratesFrom,
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
      amount: round2(scheme.amount),
      active: Boolean(scheme.active),
      staffIds: (data.memberBy.get(scheme.id) ?? []).map((m) => m.staff_id),
      scores: (data.memberBy.get(scheme.id) ?? []).map((m) => ({
        staffId: m.staff_id,
        score: round2(scoreBy.get(`${scheme.id}|${m.staff_id}`) ?? 0),
      })),
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
  for (const advance of data.advances) {
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
    schemes: data.schemes.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
    profiles: data.profileBy,
    allowanceBy: data.allowanceBy,
    scoreBy: new Map(data.scores.map((r) => [`${r.scheme_id}|${r.staff_id}`, r.score])),
    memberOf,
    advanceDue,
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
    ...c.schemes.map((s) => `Score: ${s.name}`),
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
      ...c.schemes.map((s) => (under.includes(s.id)
        ? round2(c.scoreBy.get(`${s.id}|${person.id}`) ?? 0).toFixed(2)
        : '')),
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
  let basics = 0;
  let allowances = 0;
  let scores = 0;

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
        await ctx.db.prepare(
          `INSERT INTO pay_score (run_id, scheme_id, staff_id, score) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (run_id, scheme_id, staff_id) DO UPDATE SET score = ?4, amount = NULL`,
        ).bind(run.id, change.schemeId, line.staffId, change.to).run();
        scores += 1;
      }
    }
  }

  await audit(ctx, 'payroll.input', month, {
    basics, allowances, scores, skipped: read.skipped.length,
  });
  return json({
    ok: true, month, basics, allowances, scores, skipped: read.skipped, notes: read.lines,
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
export async function returns(ctx) {
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

  const records = await ctx.db.prepare(
    'SELECT staff_id, tin_number, ssnit_number FROM hr_person',
  ).all().catch(() => ({ results: [] }));
  const people = new Map((records.results ?? []).map((r) => [Number(r.staff_id), r]));

  const totals = totalsOf(lines);
  const journal = journalFor({ lines, totals, rates: data.rates, tiers: data.tiers });
  const schedule = payeSchedule({ lines, people });

  const missing = schedule.rows.filter((row) => !row.tin || !row.ssnitNumber)
    .map((row) => ({
      name: row.name,
      wants: [!row.tin ? 'TIN' : null, !row.ssnitNumber ? 'SSNIT number' : null].filter(Boolean),
    }));

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
    await ctx.db.prepare(
      `INSERT INTO pay_profile (staff_id, basic, ssnit, note, set_by)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (staff_id) DO UPDATE
         SET basic = ?2, ssnit = ?3, note = ?4, set_by = ?5, set_at = datetime('now')`,
    ).bind(staffId, basic, line.ssnit === false ? 0 : 1,
      str(line.note, 'Note', { max: 300 }), actorOf(ctx)).run();

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
  const department = str(body.department, 'Department', { max: 60 }) || null;
  const staffIds = Array.isArray(body.staffIds)
    ? [...new Set(body.staffIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];

  let id = body.id ? int(body.id, 'Scheme', { min: 1 }) : null;
  if (id) {
    const found = await ctx.db.prepare('SELECT id FROM pay_scheme WHERE id = ?').bind(id).first();
    if (!found) throw notFound('No such scheme.');
    await ctx.db.prepare(
      'UPDATE pay_scheme SET name = ?2, amount = ?3, note = ?4, active = ?5, department = ?6 '
      + 'WHERE id = ?1',
    ).bind(id, name, amount, note, body.active === false ? 0 : 1, department).run();
  } else {
    const made = await ctx.db.prepare(
      'INSERT INTO pay_scheme (name, amount, note, department) VALUES (?1, ?2, ?3, ?4) '
      + 'RETURNING id',
    ).bind(name, amount, note, department).first();
    id = made?.id ?? null;
  }

  await ctx.db.prepare('DELETE FROM pay_scheme_staff WHERE scheme_id = ?').bind(id).run();
  for (const staffId of staffIds) {
    await ctx.db.prepare(
      'INSERT OR IGNORE INTO pay_scheme_staff (scheme_id, staff_id) VALUES (?1, ?2)',
    ).bind(id, staffId).run();
  }

  await audit(ctx, 'payroll.scheme', id, { name, amount, department, people: staffIds.length });
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
    `SELECT s.scheme_id, s.staff_id, s.score
       FROM pay_score s
       JOIN pay_scheme_staff m
         ON m.scheme_id = s.scheme_id AND m.staff_id = s.staff_id
       JOIN att_staff p ON p.id = s.staff_id AND p.active = 1
      WHERE s.run_id = ?1`,
  ).bind(source.id).all();

  let scores = 0;
  for (const row of carried.results ?? []) {
    await ctx.db.prepare(
      `INSERT INTO pay_score (run_id, scheme_id, staff_id, score) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (run_id, scheme_id, staff_id) DO UPDATE SET score = ?4, amount = NULL`,
    ).bind(run.id, row.scheme_id, row.staff_id, round2(row.score)).run();
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
    const score = round2(num(line.score, 'Score', { min: 0, max: 100 }));

    const scheme = await ctx.db.prepare('SELECT amount FROM pay_scheme WHERE id = ?')
      .bind(schemeId).first();
    if (!scheme) continue;

    await ctx.db.prepare(
      `INSERT INTO pay_score (run_id, scheme_id, staff_id, score, amount)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (run_id, scheme_id, staff_id) DO UPDATE SET score = ?4, amount = ?5`,
    ).bind(run.id, schemeId, staffId, score, round2(scheme.amount)).run();
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
