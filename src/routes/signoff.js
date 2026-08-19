import { badRequest, int, json, notFound, readJson, str } from '../lib/http.js';
import { allows, effectivePermissions } from '../lib/permissions.js';
import { createNotice } from '../lib/notices.js';
import {
  ISSUES, describePeriod, effectiveDays, findClash, issuesInPeriod, issuesOnDay,
  parseDays, unsignedDays,
} from '../lib/signoff.js';
import {
  computeRange, dayCredit, dayLedger, daysPerWeekFor, labelFor, loadDataset, overUnder, summarise,
} from '../lib/attendance.js';
import { addDays, diffDays, isDay, monthBounds, todayIn } from '../util/dates.js';

/**
 * What is still waiting to be signed off, and what to do about the awkward
 * ones.
 *
 * Two screens' worth of answers behind one idea: whoever builds the rota can
 * settle up as they go, day by day, and does not have to choose between
 * signing something they are unsure about and leaving a whole month waiting on
 * it. They sign what is clear, leave out what is not, and raise the rest.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorOf(ctx), action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null).run().catch(() => {});
}

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first().catch(() => null);
  return row?.value || 'UTC';
}

/** The window being looked at, from a month or an explicit pair of dates. */
function windowOf(url, timezone) {
  const month = url.searchParams.get('month');
  if (month && /^\d{4}-\d{2}$/.test(month)) return monthBounds(month);

  const today = todayIn(timezone);
  const to = isDay(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
  const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(to, -27);

  if (from > to) throw badRequest('The start date is after the end date.');
  if (diffDays(from, to) > 200) {
    throw badRequest('That is more than six months. Choose a shorter period.');
  }
  return { from, to };
}

/**
 * Everybody with days in this window that nothing has signed off.
 *
 * The whole screen hangs off this. It answers "what is left" for a range
 * somebody chose, says what is wrong with each of it, and carries every day so
 * that individual ones can be ticked without a second request per person.
 */
export async function outstanding(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to } = windowOf(ctx.url, timezone);
  const today = todayIn(timezone);

  // A day that has not finished is not outstanding, it is in progress. Offering
  // today's half-worked shifts for sign-off is how somebody ends up charging an
  // absence against a person who is upstairs making a bed.
  const limit = to < today ? to : addDays(today, -1);
  if (limit < from) {
    return json({
      from, to, limit, rows: [], issues: ISSUES, total: 0, withIssues: 0, queries: [],
    });
  }

  const onlyDepartment = ctx.url.searchParams.get('department') || '';
  // Three answers, not two. "Only the ones with something wrong" is what
  // somebody opens on a Monday to see what needs a conversation; "only the
  // clean ones" is what they open to clear the other twenty in one go, and
  // until now that second question had no way of being asked.
  const issuesFilter = ctx.url.searchParams.get('issues');
  const withIssuesOnly = issuesFilter === '1';
  const cleanOnly = issuesFilter === '0';

  const [ds, reviews, queries, waiting] = await Promise.all([
    loadDataset(ctx.db, { from, to: limit }),
    ctx.db.prepare(
      'SELECT * FROM att_period_review WHERE from_day <= ?2 AND to_day >= ?1',
    ).bind(from, limit).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      "SELECT * FROM att_query WHERE status IN ('open', 'answered') ORDER BY raised_at",
    ).all().catch(() => ({ results: [] })),
    // Clock-time changes still waiting on an administrator. Shown against the
    // day they concern, because a period signed off while a correction to it is
    // pending is a period signed off against a figure somebody has already said
    // is wrong.
    ctx.db.prepare(
      `SELECT id, staff_id, day, now_in, now_out, reason, actor, at_utc
         FROM att_time_edit WHERE status = 'pending'`,
    ).bind().all().catch(() => ({ results: [] })),
  ]);

  const reviewsBy = new Map();
  for (const row of reviews.results ?? []) {
    if (!reviewsBy.has(row.staff_id)) reviewsBy.set(row.staff_id, []);
    reviewsBy.get(row.staff_id).push(row);
  }

  const queriesBy = new Map();
  for (const row of queries.results ?? []) {
    if (!queriesBy.has(row.staff_id)) queriesBy.set(row.staff_id, []);
    queriesBy.get(row.staff_id).push(row);
  }

  const pendingBy = new Map();
  for (const row of waiting.results ?? []) pendingBy.set(`${row.staff_id}|${row.day}`, row);

  // Which days each question actually covers. A question names its days, so a
  // period asked about is those days and not the span they happen to sit in —
  // otherwise asking about a Thursday takes the Monday either side of it out
  // of everybody's reach as well.
  const askedAbout = new Map();
  for (const q of queries.results ?? []) {
    const shape = {
      id: q.id,
      reason: q.reason,
      status: q.status,
      raisedBy: q.raised_by,
      raisedAt: q.raised_at,
      addressedName: q.addressed_name ?? null,
    };
    for (const day of parseDays(q.days)) askedAbout.set(`${q.staff_id}|${day}`, shape);
  }

  const overMinutes = Math.max(0, Number(ds.settings.att_over_minutes) || 360);
  const rows = [];

  for (const staff of ds.staff) {
    if (onlyDepartment && (staff.department || '') !== onlyDepartment) continue;

    const mine = reviewsBy.get(staff.id) ?? [];
    const open = unsignedDays(from, limit, mine);
    if (!open.length) continue;

    const records = computeRange(ds, staff.id, from, limit);
    const byDay = new Map(records.map((r) => [r.day, r]));

    const oc = overUnder(records, {
      holidays: ds.holidayBy,
      expected: records.some((r) => r.scheduled),
      perWeek: daysPerWeekFor(staff, ds.settings),
    });
    const counted = new Map([
      ...oc.overs.map((o) => [o.day, 'over']),
      ...oc.unders.map((u) => [u.day, 'under']),
    ]);

    // Only days that are actually something. A rest day nobody worked is not
    // outstanding — there is nothing to sign off about it — and listing every
    // one of them would bury the four days that matter.
    const days = open
      .map((day) => {
        const record = byDay.get(day);
        if (!record) return null;
        if (!record.scheduled && !Number(record.worked_minutes)) return null;

        return {
          day,
          shift: record.shift_id ? ds.shiftById.get(record.shift_id)?.name ?? null : null,
          scheduled: Boolean(record.scheduled),
          in: record.first_in,
          out: record.last_out,
          corrected_in: record.corrected_in ?? null,
          corrected_out: record.corrected_out ?? null,
          pendingTimes: pendingBy.get(`${staff.id}|${day}`) ?? null,
          minutes: record.worked_minutes,
          status: record.status,
          label: labelFor(record, ds.reasonBy),
          credit: dayCredit(record, {
            shift: record.shift_id ? ds.shiftById.get(record.shift_id) ?? null : null,
            reason: record.reason_code ? ds.reasonBy.get(record.reason_code) ?? null : null,
          }),
          counts: counted.get(day) ?? null,
          issues: issuesOnDay(record, { counted: counted.get(day) ?? null }),
          // The question hanging over this particular day, if any. Per day
          // rather than per person: asking about a Thursday nobody can explain
          // does not put that person's other four days beyond reach, and
          // parking their whole week would be the surest way to stop somebody
          // ever asking.
          query: askedAbout.get(`${staff.id}|${day}`) ?? null,
          ...dayLedger(record, {
            holidays: ds.holidayBy,
            perWeek: daysPerWeekFor(staff, ds.settings),
          }),
        };
      })
      .filter(Boolean);

    if (!days.length) continue;

    const issues = issuesInPeriod(days);
    if (withIssuesOnly && !issues.total) continue;
    // A person with nothing wrong anywhere in the window. Counted across the
    // whole of their period rather than per day, because this filter answers
    // "who can I clear without thinking about it" and one absence on a Tuesday
    // is exactly the thing that makes somebody worth thinking about.
    if (cleanOnly && issues.total) continue;

    const totals = summarise(records, { shifts: ds.shiftById, reasons: ds.reasonBy });

    rows.push({
      staff: {
        id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department,
      },
      days,
      unsignedCount: days.length,
      first: days[0].day,
      last: days[days.length - 1].day,
      issues,
      scheduledDays: totals.scheduled,
      workedDays: totals.daysWorked,
      difference: oc.difference,
      summary: describePeriod({ name: staff.name, unsigned: days, issues }),
      // A question already asked about any of these days. It keeps the screen
      // from inviting somebody to raise it twice, and — more usefully — takes
      // the period out of the working list altogether: a period you have asked
      // about is not yours to do anything with until somebody answers, and
      // leaving it among the ones that are is how a list of four jobs reads as
      // a list of nine.
      query: queryOn(queriesBy.get(staff.id), days),
      signedSpans: mine.map((r) => ({
        from: r.from_day, to: r.to_day, kind: r.kind, by: r.decided_by,
        excluded: parseDays(r.excluded_days).length,
      })),
    });
  }

  rows.sort((a, b) => b.issues.total - a.issues.total || a.staff.name.localeCompare(b.staff.name));

  return json({
    from,
    to,
    limit,
    rows,
    issues: ISSUES,
    departments: [...new Set(ds.staff.map((s) => s.department).filter(Boolean))].sort(),
    total: rows.reduce((n, r) => n + r.unsignedCount, 0),
    withIssues: rows.filter((r) => r.issues.total).length,
    blocked: rows.filter((r) => r.issues.blocking).length,
    canDecide: allows('att_manage', ctx.session.permissions),
    canFixTimes: allows('att_times', ctx.session.permissions),
    // Counted here so the tiles can say it without the screen having to work
    // out what it is looking at twice.
    // Counted in days, because days are what the groups now hold.
    asked: rows.reduce((n, r) => n + r.days.filter((d) => d.query?.status === 'open').length, 0),
    answered: rows.reduce((n, r) => n + r.days.filter((d) => d.query?.status === 'answered').length, 0),
  });
}

// ---------------------------------------------------------------------------
// Signing part of a span
// ---------------------------------------------------------------------------

/**
 * Sign off some days and leave the rest.
 *
 * The days come from the browser as a list, and the span is whatever they
 * bracket. Anything inside that bracket which was not chosen is recorded as
 * deliberately left out — so it stays outstanding, and can be signed on its
 * own later without the span refusing it.
 */
export async function signDays(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });

  const chosen = [...new Set((Array.isArray(body.days) ? body.days : [])
    .map(String).filter(isDay))].sort();
  if (!chosen.length) throw badRequest('Tick at least one day to sign off.');
  if (chosen.length > 400) throw badRequest('That is more days than one sign-off should carry.');

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  const from = chosen[0];
  const to = chosen[chosen.length - 1];

  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  if (to >= today) {
    throw badRequest('A day that has not finished cannot be signed off. Leave today out of it.');
  }

  // No two sign-offs may cover a day either of them actually signed. Compared
  // on the effective sets rather than the raw dates, so a month that left three
  // days out does not block those three being dealt with now.
  const existing = await ctx.db.prepare(
    'SELECT * FROM att_period_review WHERE staff_id = ?1',
  ).bind(staffId).all().catch(() => ({ results: [] }));

  const clash = findClash(chosen, (existing.results ?? [])
    .filter((r) => !(r.from_day === from && r.to_day === to)));

  if (clash) {
    throw badRequest(
      `${staff.name} already has ${clash.day} signed off, inside `
      + `${clash.review.from_day} to ${clash.review.to_day}. Reopen that first — otherwise the `
      + 'same day would be charged twice.',
    );
  }

  // Recomputed here rather than trusted from the browser: the figures a
  // decision is recorded against have to be the ones this app stands behind.
  const ds = await loadDataset(ctx.db, { from, to });
  const records = computeRange(ds, staffId, from, to);
  const wanted = new Set(chosen);
  const included = records.filter((r) => wanted.has(r.day));

  const totals = summarise(included, { shifts: ds.shiftById, reasons: ds.reasonBy });
  const oc = overUnder(included, {
    holidays: ds.holidayBy,
    expected: included.some((r) => r.scheduled),
    perWeek: daysPerWeekFor(staff, ds.settings),
  });

  const counted = new Map([
    ...oc.overs.map((o) => [o.day, 'over']),
    ...oc.unders.map((u) => [u.day, 'under']),
  ]);
  const issues = issuesInPeriod(included.map((r) => ({
    issues: issuesOnDay(r, { counted: counted.get(r.day) ?? null }),
  })));

  const decision = ['approved', 'waived'].includes(body.decision) ? body.decision : 'approved';
  const daysApplied = decision === 'waived' ? 0 : Math.round(Number(body.daysApplied ?? oc.difference));
  if (!Number.isFinite(daysApplied) || Math.abs(daysApplied) > 60) {
    throw badRequest('That is not a sensible number of days.');
  }

  const excluded = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!wanted.has(day)) excluded.push(day);
  }

  const kind = kindFor(from, to, excluded.length);

  await ctx.db.prepare(
    `INSERT INTO att_period_review
       (staff_id, kind, from_day, to_day, scheduled_days, worked_days, difference,
        decision, days_applied, note, excluded_days, issues, decided_by, decided_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13, datetime('now'))
     ON CONFLICT (staff_id, from_day, to_day) DO UPDATE SET
       kind = excluded.kind, scheduled_days = excluded.scheduled_days,
       worked_days = excluded.worked_days, difference = excluded.difference,
       decision = excluded.decision, days_applied = excluded.days_applied,
       note = excluded.note, excluded_days = excluded.excluded_days,
       issues = excluded.issues, decided_by = excluded.decided_by,
       decided_at = excluded.decided_at`,
  ).bind(
    staffId, kind, from, to,
    totals.scheduled, totals.daysWorked, oc.difference,
    decision, daysApplied,
    str(body.note, 'Note', { max: 300 }),
    excluded.length ? JSON.stringify(excluded) : null,
    issues.total ? JSON.stringify(issues.counts) : null,
    actorOf(ctx),
  ).run();

  // A question already open about these days is answered by signing them.
  await closeQueriesFor(ctx, staffId, chosen, 'signed', 'Signed off.');

  await audit(ctx, 'attendance.sign_days', staffId, {
    from, to, signed: chosen.length, excluded: excluded.length, daysApplied, issues: issues.counts,
  });

  return json({
    ok: true, from, to, kind, signed: chosen.length, excluded: excluded.length, daysApplied,
  });
}

/** A label for the span. Only ever a label — every rule works on the dates. */
/**
 * The question hanging over a set of days, as the list needs it.
 *
 * Shaped rather than passed through: the row it comes from carries who raised
 * it, from which address, and every note id, none of which the list has any
 * business sending to a browser.
 */
function queryOn(queries, days) {
  const found = (queries ?? []).find((q) => q.from_day <= days[days.length - 1].day
    && q.to_day >= days[0].day);
  if (!found) return null;

  return {
    id: found.id,
    from: found.from_day,
    to: found.to_day,
    days: parseDays(found.days),
    reason: found.reason,
    status: found.status,
    raisedBy: found.raised_by,
    raisedAt: found.raised_at,
    addressedName: found.addressed_name ?? null,
  };
}

function kindFor(from, to, excludedCount) {
  if (excludedCount) return 'partial';
  if (from === to) return 'day';
  const { from: mFrom, to: mTo } = monthBounds(from.slice(0, 7));
  if (from === mFrom && to === mTo) return 'month';
  if (diffDays(from, to) === 6) return 'week';
  return 'period';
}

/** Reopen a sign-off, so its days go back to waiting. */
export async function reopenDays(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const from = str(body.from, 'From', { required: true, max: 10 });
  const to = str(body.to, 'To', { required: true, max: 10 });

  const result = await ctx.db.prepare(
    'DELETE FROM att_period_review WHERE staff_id = ? AND from_day = ? AND to_day = ?',
  ).bind(staffId, from, to).run();

  await audit(ctx, 'attendance.sign_days_undo', staffId, { from, to });
  return json({ ok: true, removed: Number(result?.meta?.changes ?? 0) });
}

// ---------------------------------------------------------------------------
// Asking somebody to look
// ---------------------------------------------------------------------------

/**
 * Raise a period rather than sign it.
 *
 * The second answer, beside "sign it anyway". Somebody building the rota can
 * see that a week has three unexplained absences in it and quite reasonably not
 * want to be the person who charges them against a colleague's leave.
 *
 * What is stored is a snapshot of the figures as well as the dates, so the
 * queue can be read without recomputing a month for every row in it — and so
 * that the answer is given about what was actually seen.
 */
export async function raiseQuery(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });

  const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(String).filter(isDay))].sort();
  if (!days.length) throw badRequest('Say which days you are asking about.');

  const reason = str(body.reason, 'Reason', { required: true, max: 600 });
  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  const from = days[0];
  const to = days[days.length - 1];

  const already = await ctx.db.prepare(
    `SELECT * FROM att_query WHERE staff_id = ?1 AND status IN ('open','answered')
       AND from_day <= ?3 AND to_day >= ?2 LIMIT 1`,
  ).bind(staffId, from, to).first();

  if (already) {
    throw badRequest(
      `There is already a question open about ${staff.name}, ${already.from_day} to `
      + `${already.to_day}. Add to that one rather than starting a second.`,
    );
  }

  // Who is being asked. Optional, because "whoever gets to it first" is a
  // legitimate answer on a small property — but checked when given, so a
  // question cannot be addressed to somebody who could not answer it.
  let addressed = null;
  if (body.addressedTo != null && body.addressedTo !== '') {
    const wanted = await ctx.db.prepare(
      'SELECT id, name, role, permissions, active FROM users WHERE id = ? AND active = 1',
    ).bind(Number(body.addressedTo)).first();
    if (!wanted || !allows('att_manage', effectivePermissions(wanted))) {
      throw badRequest('That person cannot answer a question about a period.');
    }
    addressed = wanted;
  }

  const created = await ctx.db.prepare(
    `INSERT INTO att_query (staff_id, from_day, to_day, days, issues, reason, raised_by,
                            raised_by_id, addressed_to, addressed_name)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING id`,
  ).bind(
    staffId, from, to, JSON.stringify(days),
    body.issues ? JSON.stringify(body.issues) : null,
    reason, actorOf(ctx),
    ctx.session.user.id ?? null,
    addressed?.id ?? null,
    addressed?.name ?? null,
  ).first();

  await ctx.db.prepare(
    "INSERT INTO att_query_note (query_id, kind, body, author) VALUES (?1, 'comment', ?2, ?3)",
  ).bind(created.id, reason, actorOf(ctx)).run();

  // The bell. To the person named if there is one — a question addressed to
  // three people is a question none of them owns — and otherwise to whoever
  // holds the permission this week.
  await createNotice(ctx.db, {
    kind: 'attendance.query',
    level: 'warn',
    title: addressed
      ? `${staff.name}: ${actorOf(ctx)} has asked you to look`
      : `${staff.name}: a period needs your eye`,
    body: `${from} to ${to} — ${reason}`.slice(0, 400),
    link: '#/signoff?tab=queries',
    actor: actorOf(ctx),
    audience: 'att_manage',
    userId: addressed?.id ?? null,
  });

  await audit(ctx, 'attendance.query_raise', created.id, { staffId, from, to, days: days.length });
  return json({ ok: true, id: created.id });
}

/**
 * Who a question can be addressed to.
 *
 * Everybody whose login can actually answer one — the permission that settles
 * days — worked out from their role's defaults and whatever has been ticked for
 * them individually, so the list is who can help rather than who happens to be
 * called a manager.
 *
 * Names and nothing else. The person choosing holds the permission to raise a
 * question and not the one that manages logins, and does not need to be handed
 * an email address to pick a name off a list.
 */
export async function listDeciders(ctx) {
  const rows = await ctx.db.prepare(
    'SELECT id, name, role, permissions, active FROM users WHERE active = 1 ORDER BY name',
  ).all().catch(() => ({ results: [] }));

  const people = (rows.results ?? [])
    .filter((u) => allows('att_manage', effectivePermissions(u)))
    .map((u) => ({ id: u.id, name: u.name, role: u.role }));

  return json({ people });
}

/** Everything waiting on somebody, and everything recently dealt with. */
export async function listQueries(ctx) {
  const status = ctx.url.searchParams.get('status') || 'live';
  const where = status === 'all'
    ? '1 = 1'
    : (status === 'live' ? "q.status IN ('open','answered')" : 'q.status = ?1');

  const rows = await ctx.db.prepare(
    `SELECT q.*, s.name, s.department, s.employee_no
       FROM att_query q JOIN att_staff s ON s.id = q.staff_id
      WHERE ${where}
      ORDER BY CASE q.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, q.raised_at DESC
      LIMIT 200`,
  ).bind(...(where.includes('?1') ? [status] : [])).all().catch(() => ({ results: [] }));

  // A question is a sentence about a colleague, written to be read by one
  // person: "absent all week and I do not want to charge his leave without
  // somebody checking". Everybody who could raise one used to be able to read
  // every one of them, which is not a queue but a noticeboard about people who
  // never agreed to be on it.
  //
  // So: whoever can answer sees all of them — a manager on leave must not take
  // their questions away with them — and everybody else sees only their own.
  // Done here rather than on the screen, because the screen is a courtesy.
  const decides = allows('att_manage', ctx.session.permissions);
  const meId = ctx.session.user.id ?? null;
  const meName = actorOf(ctx);
  const list = (rows.results ?? []).filter((q) => decides
    || (q.raised_by_id != null ? Number(q.raised_by_id) === Number(meId) : q.raised_by === meName));
  const notes = list.length
    ? await ctx.db.prepare(
      `SELECT * FROM att_query_note WHERE query_id IN (${list.map(() => '?').join(',')}) ORDER BY id`,
    ).bind(...list.map((q) => q.id)).all().catch(() => ({ results: [] }))
    : { results: [] };

  const notesBy = new Map();
  for (const note of notes.results ?? []) {
    if (!notesBy.has(note.query_id)) notesBy.set(note.query_id, []);
    notesBy.get(note.query_id).push(note);
  }

  return json({
    rows: list.map((q) => ({
      id: q.id,
      staff: { id: q.staff_id, name: q.name, department: q.department, employee_no: q.employee_no },
      from: q.from_day,
      to: q.to_day,
      days: parseDays(q.days),
      issues: q.issues ? JSON.parse(q.issues) : null,
      reason: q.reason,
      status: q.status,
      outcome: q.outcome,
      raisedBy: q.raised_by,
      raisedAt: q.raised_at,
      addressedTo: q.addressed_to ?? null,
      addressedName: q.addressed_name ?? null,
      closedBy: q.closed_by,
      closedAt: q.closed_at,
      notes: notesBy.get(q.id) ?? [],
    })),
    canDecide: decides,
    mine: meName,
    myId: meId,
  });
}

/**
 * Answer one.
 *
 * Three answers, and they are genuinely different things.
 *
 *   `comment` — say something and leave it open. A question in the middle of
 *   being worked out is not the same as one that has been dealt with.
 *
 *   `direction` — tell whoever raised it what to do, and hand it back. The
 *   period stays unsigned and the query goes to `answered`, which is what puts
 *   it back on their screen rather than an administrator's.
 *
 *   `sign` — deal with it here. The days are signed off by the person
 *   answering, under their own name, and the query closes with the reason.
 */
export async function answerQuery(ctx, id) {
  const queryId = Number(id);
  const body = await readJson(ctx.request);
  const action = ['comment', 'direction', 'sign', 'close'].includes(body.action)
    ? body.action : 'comment';
  const text = str(body.body, 'What to say', { max: 800 });

  const query = await ctx.db.prepare(
    'SELECT q.*, s.name FROM att_query q JOIN att_staff s ON s.id = q.staff_id WHERE q.id = ?',
  ).bind(queryId).first();
  if (!query) throw notFound('No such question.');
  if (query.status === 'resolved') throw badRequest('That one has already been dealt with.');

  if ((action === 'direction' || action === 'comment') && !text) {
    throw badRequest('Say something — an answer with no words in it is not an answer.');
  }

  if (text) {
    await ctx.db.prepare(
      'INSERT INTO att_query_note (query_id, kind, body, author) VALUES (?1, ?2, ?3, ?4)',
    ).bind(queryId, action === 'comment' ? 'comment' : 'direction', text, actorOf(ctx)).run();
  }

  if (action === 'comment') {
    return json({ ok: true, status: query.status });
  }

  if (action === 'direction') {
    await ctx.db.prepare(
      "UPDATE att_query SET status = 'answered', outcome = 'returned' WHERE id = ?",
    ).bind(queryId).run();

    await createNotice(ctx.db, {
      kind: 'attendance.query_answered',
      level: 'info',
      title: `${query.name}: your question has been answered`,
      body: text.slice(0, 400),
      link: '#/signoff?tab=queries',
      actor: actorOf(ctx),
      audience: 'att_signoff',
    });

    await audit(ctx, 'attendance.query_direction', queryId, null);
    return json({ ok: true, status: 'answered' });
  }

  if (action === 'sign') {
    // Signing from here goes through exactly the same handler as signing from
    // the list, so the overlap rule and the recomputation cannot differ.
    const days = parseDays(query.days);
    const signed = await signDays({
      ...ctx,
      request: new Request('https://x/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffId: query.staff_id,
          days,
          daysApplied: body.daysApplied,
          decision: body.decision,
          note: text || `Signed off after a question from ${query.raised_by}`,
        }),
      }),
    });
    const outcome = await signed.json();

    await ctx.db.prepare(
      `UPDATE att_query SET status = 'resolved', outcome = 'signed',
              closed_by = ?2, closed_at = datetime('now') WHERE id = ?1`,
    ).bind(queryId, actorOf(ctx)).run();

    await ctx.db.prepare(
      "INSERT INTO att_query_note (query_id, kind, body, author) VALUES (?1, 'decision', ?2, ?3)",
    ).bind(queryId, `Signed off — ${outcome.daysApplied} day(s) applied.`, actorOf(ctx)).run();

    await createNotice(ctx.db, {
      kind: 'attendance.query_answered',
      level: 'good',
      title: `${query.name}: signed off for you`,
      body: `${query.from_day} to ${query.to_day} — ${outcome.daysApplied} day(s) applied.`,
      link: '#/signoff?tab=queries',
      actor: actorOf(ctx),
      audience: 'att_signoff',
    });

    await audit(ctx, 'attendance.query_signed', queryId, outcome);
    return json({ ok: true, status: 'resolved', ...outcome });
  }

  await ctx.db.prepare(
    `UPDATE att_query SET status = 'resolved', outcome = 'no_action',
            closed_by = ?2, closed_at = datetime('now') WHERE id = ?1`,
  ).bind(queryId, actorOf(ctx)).run();

  await audit(ctx, 'attendance.query_close', queryId, null);
  return json({ ok: true, status: 'resolved' });
}

/** Whoever raised it can take it back, having worked it out themselves. */
export async function withdrawQuery(ctx, id) {
  const queryId = Number(id);
  const query = await ctx.db.prepare('SELECT * FROM att_query WHERE id = ?').bind(queryId).first();
  if (!query) throw notFound('No such question.');

  await ctx.db.prepare(
    `UPDATE att_query SET status = 'withdrawn', outcome = 'withdrawn',
            closed_by = ?2, closed_at = datetime('now') WHERE id = ?1`,
  ).bind(queryId, actorOf(ctx)).run();

  await audit(ctx, 'attendance.query_withdraw', queryId, null);
  return json({ ok: true });
}

/** Signing days that a question was about answers the question. */
async function closeQueriesFor(ctx, staffId, days, outcome, note) {
  const rows = await ctx.db.prepare(
    `SELECT * FROM att_query WHERE staff_id = ?1 AND status IN ('open','answered')
       AND from_day <= ?3 AND to_day >= ?2`,
  ).bind(staffId, days[0], days[days.length - 1]).all().catch(() => ({ results: [] }));

  for (const query of rows.results ?? []) {
    const asked = new Set(parseDays(query.days));
    // Only where every day it asked about has now been dealt with. A question
    // about five days, three of which were signed, is still a question.
    if (asked.size && [...asked].some((d) => !days.includes(d))) continue;

    await ctx.db.prepare(
      `UPDATE att_query SET status = 'resolved', outcome = ?2, closed_by = ?3,
              closed_at = datetime('now') WHERE id = ?1`,
    ).bind(query.id, outcome, actorOf(ctx)).run();

    await ctx.db.prepare(
      "INSERT INTO att_query_note (query_id, kind, body, author) VALUES (?1, 'decision', ?2, ?3)",
    ).bind(query.id, note, actorOf(ctx)).run();
  }
}

export { effectiveDays };
