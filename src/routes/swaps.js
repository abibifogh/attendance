import { loadDataset } from '../lib/attendance.js';
import { addDays, nowIn, todayIn } from '../util/dates.js';
import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { parseDays } from '../lib/signoff.js';
import {
  findingsForSwap, goesStraightThrough, offerable, swapRules, tooLate, whoCanCover, whyNot,
} from '../lib/swaps.js';

/**
 * Giving up a shift, and taking one.
 *
 * A supervisor's afternoon used to go: I cannot do Saturday, do you know
 * anybody, let me ask around, ring me back. It ended with the grid being
 * edited on somebody's word and no record of who had agreed to what.
 *
 * THE ROTA CHANGES ONCE, AT THE END. Offering does nothing to it. Taking does
 * nothing to it. A manager approving is the single moment a roster row changes
 * hands, and everything before that is two people talking with the app keeping
 * notes. A shift half-attached to two people is exactly the state a rota must
 * never be in, which is why none of this lives in the grid.
 *
 * And every rule is asked twice: once when somebody takes a shift, so nobody
 * is offered a night they cannot work, and again at the approval, because a
 * fortnight can change in between and the second answer is the one that writes.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

/** The property's clock, which every day here is counted in. */
async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first().catch(() => null);
  return row?.value || 'UTC';
}

/** How far ahead the board looks. Beyond this a rota is a rumour. */
const HORIZON = 28;

async function meOf(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) {
    throw forbidden(
      'This login is not linked to a staff record, so it has no shifts to give away. '
      + 'Ask whoever set it up to point it at you under Users.',
    );
  }
  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('The staff record this login points at is gone.');
  return staff;
}

/** Everything the rules and the findings need, loaded once. */
async function context(ctx, { from, to }) {
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const now = nowIn(timezone);
  // A week either side of the window, so a fortnight's worth of findings has
  // the shifts on both edges of it to measure against.
  const ds = await loadDataset(ctx.db, { from: addDays(from, -8), to: addDays(to, 8), now });
  const rules = swapRules(ds.settings ?? {});

  const away = new Set();
  const rows = await ctx.db.prepare(
    "SELECT staff_id, day FROM att_availability WHERE status = 'unavailable' AND day BETWEEN ? AND ?",
  ).bind(from, to).all().catch(() => ({ results: [] }));
  for (const row of rows.results ?? []) away.add(`${row.staff_id}|${row.day}`);

  return { ds, rules, today, now, away, timezone };
}

/** Everything about a swap the screens draw, and nothing about anybody's pay. */
function asCard(ds, swap, { mine = false, canTake = null, why = null } = {}) {
  const shift = swap.shift_id ? ds.shiftById?.get(swap.shift_id) : null;
  const back = swap.back_shift_id ? ds.shiftById?.get(swap.back_shift_id) : null;
  const person = (id) => {
    const staff = id ? ds.staffById?.get(Number(id)) : null;
    return staff ? { id: staff.id, name: staff.name, department: staff.department ?? null } : null;
  };

  return {
    id: swap.id,
    kind: swap.kind,
    status: swap.status,
    day: swap.day,
    shift: shift
      ? {
        id: shift.id,
        name: shift.name,
        starts_at: shift.starts_at,
        ends_at: shift.ends_at,
        department: shift.department ?? null,
        colour: shift.colour ?? null,
      }
      : null,
    // A trade names the shift coming back the other way.
    back: back
      ? {
        day: swap.back_day,
        name: back.name,
        starts_at: back.starts_at,
        ends_at: back.ends_at,
        colour: back.colour ?? null,
      }
      : null,
    from: person(swap.from_staff),
    takenBy: person(swap.taken_by),
    aimedAt: readAimed(swap).map(person).filter(Boolean),
    aimedOnly: swap.aimed_only === 1,
    reason: swap.reason ?? null,
    mine,
    // Why this one is not theirs to take, said rather than hidden. Somebody
    // who cannot see the shift at all asks the supervisor about it; somebody
    // told they are already on that night does not.
    canTake,
    why,
    decision: swap.decision ?? null,
    decidedBy: swap.decided_by ?? null,
    decidedAt: swap.decided_at ?? null,
    createdAt: swap.created_at ?? null,
  };
}

const readAimed = (swap) => {
  try {
    const list = JSON.parse(swap.aimed_at ?? 'null');
    return Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : [];
  } catch { return []; }
};

async function liveSwaps(db, { from, to }) {
  const rows = await db.prepare(
    `SELECT * FROM att_swap
      WHERE status IN ('open','claimed') AND day BETWEEN ? AND ?
      ORDER BY day, id`,
  ).bind(from, to).all().catch(() => ({ results: [] }));
  return rows.results ?? [];
}

// ---------------------------------------------------------------------------
// What a member of staff sees
// ---------------------------------------------------------------------------

/**
 * The board.
 *
 * Four lists, and the split is the point. What anybody can take, what was put
 * to them by name, the trades waiting on their answer, and their own. Somebody
 * opening this wants one of the four and not a single pile sorted by date.
 */
export async function swapBoard(ctx) {
  const staff = await meOf(ctx);
  const today = todayIn(await timezoneOf(ctx.db));
  const to = addDays(today, HORIZON);
  const { ds, rules, now, away } = await context(ctx, { from: today, to });

  if (!rules.on) return json({ on: false, offers: [], aimed: [], trades: [], mine: [] });

  const swaps = await liveSwaps(ctx.db, { from: today, to });

  const offers = [];
  const aimed = [];
  const trades = [];
  const mine = [];

  for (const swap of swaps) {
    const shift = swap.shift_id ? ds.shiftById?.get(swap.shift_id) : null;
    if (!shift) continue;

    if (Number(swap.from_staff) === Number(staff.id)) {
      mine.push(asCard(ds, swap, { mine: true }));
      continue;
    }
    if (Number(swap.taken_by) === Number(staff.id)) {
      mine.push(asCard(ds, swap, { mine: true }));
      continue;
    }
    // Somebody else has it. Nobody needs to watch a shift that is already
    // spoken for and waiting on a manager.
    if (swap.status === 'claimed') continue;

    const named = readAimed(swap);
    const forMe = named.includes(Number(staff.id));
    if (swap.aimed_only === 1 && !forMe) continue;

    const why = whyNot(ds, staff, swap.day, shift, { rules, away })
      || (tooLate(swap.day, shift, now, rules.noticeHours)
        ? 'It starts too soon to change hands now.'
        : null);

    const card = asCard(ds, swap, { canTake: !why, why });

    if (swap.kind === 'trade' && forMe) trades.push(card);
    else if (forMe) aimed.push(card);
    else offers.push(card);
  }

  return json({
    on: true,
    me: staff.id,
    today,
    rules: {
      noticeHours: rules.noticeHours,
      approval: rules.approval,
      monthlyCap: rules.monthlyCap,
    },
    offers,
    aimed,
    trades,
    mine,
  });
}

/**
 * The shifts they could offer, and who could cover each one.
 *
 * The count matters more than the list. Six faces and nought are the same
 * screen with a very different decision on it, and somebody who finds out
 * afterwards that nobody could take it has been let down by the app.
 */
export async function whatICanOffer(ctx) {
  const staff = await meOf(ctx);
  const today = todayIn(await timezoneOf(ctx.db));
  const to = addDays(today, HORIZON);
  const { ds, rules, now, away } = await context(ctx, { from: today, to });

  if (!rules.on) return json({ on: false, shifts: [] });

  const live = await liveSwaps(ctx.db, { from: today, to });
  const alreadyOffered = new Set(live.map((s) => Number(s.roster_id)));

  const mine = offerable(ds, staff.id, {
    from: today, to, now, rules, alreadyOffered,
  });

  return json({
    on: true,
    rules: { noticeHours: rules.noticeHours, approval: rules.approval },
    used: await countThisMonth(ctx.db, staff.id, today),
    cap: rules.monthlyCap,
    shifts: mine.map(({ row, day, shift }) => {
      const can = whoCanCover(ds, {
        day, shift, exceptStaffId: staff.id, rules, away,
      });
      return {
        rosterId: row.id,
        day,
        title: row.title ?? null,
        shift: {
          id: shift.id,
          name: shift.name,
          starts_at: shift.starts_at,
          ends_at: shift.ends_at,
          department: shift.department ?? null,
          colour: shift.colour ?? null,
        },
        canCover: can.map((p) => ({ id: p.id, name: p.name, department: p.department ?? null })),
      };
    }),
  });
}

/** How many they have given away this calendar month, for the cap. */
async function countThisMonth(db, staffId, today) {
  const month = String(today).slice(0, 7);
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM att_swap
      WHERE from_staff = ? AND status IN ('open','claimed','approved')
        AND substr(day, 1, 7) = ?`,
  ).bind(staffId, month).first().catch(() => null);
  return Number(row?.n ?? 0);
}

/**
 * Put a shift up.
 *
 * Either to anybody who can cover it, or to the people they name, or both:
 * naming somebody and leaving it on the board is one instruction, not two, and
 * it is what people actually mean by "ask Doreen, and if she cannot, anybody".
 */
export async function offerSwap(ctx) {
  const staff = await meOf(ctx);
  const body = await readJson(ctx.request);

  const rosterId = int(body.rosterId, 'Shift', { min: 1 });
  const row = await ctx.db.prepare('SELECT * FROM att_roster WHERE id = ?').bind(rosterId).first();
  if (!row) throw notFound('That shift is not on the rota any more.');
  if (Number(row.staff_id) !== Number(staff.id)) throw forbidden('That is not your shift.');
  if (!row.shift_id) throw badRequest('There is no shift on that day to give up.');
  if (!row.published) {
    throw badRequest('That week has not been published yet, so there is nothing to give away.');
  }

  const { ds, rules, today, now, away } = await context(ctx, {
    from: row.day, to: row.day,
  });
  if (!rules.on) throw forbidden('Swaps are turned off.');
  if (row.day < today) throw badRequest('That day has gone.');

  const shift = ds.shiftById?.get(row.shift_id);
  if (!shift) throw badRequest('That shift no longer exists.');
  if (tooLate(row.day, shift, now, rules.noticeHours)) {
    throw badRequest(rules.noticeHours >= 24
      ? `A shift has to be given up at least ${Math.round(rules.noticeHours / 24)} day`
        + `${rules.noticeHours >= 48 ? 's' : ''} before it starts. Speak to your supervisor.`
      : `A shift has to be given up at least ${rules.noticeHours} hours before it starts. `
        + 'Speak to your supervisor.');
  }

  const open = await ctx.db.prepare(
    "SELECT id FROM att_swap WHERE roster_id = ? AND status IN ('open','claimed')",
  ).bind(rosterId).first();
  if (open) throw badRequest('That shift is already on the board.');

  if (rules.monthlyCap) {
    const used = await countThisMonth(ctx.db, staff.id, row.day);
    if (used >= rules.monthlyCap) {
      throw badRequest(`You have given away ${used} shifts this month, which is the most the `
        + 'property allows. Speak to your supervisor.');
    }
  }

  // Who it is being put to. Anybody named has to be somebody who could
  // actually work it, or the offer is a message rather than an offer.
  const wanted = Array.isArray(body.aimedAt) ? body.aimedAt.map(Number).filter(Number.isFinite) : [];
  const aimedAt = [];
  for (const id of [...new Set(wanted)]) {
    if (id === Number(staff.id)) continue;
    const person = ds.staffById?.get(id);
    if (!person) throw badRequest('One of the people you picked is not on the staff list.');
    const why = whyNot(ds, person, row.day, shift, { rules, away });
    if (why) throw badRequest(`${person.name} cannot take it. ${why}`);
    aimedAt.push(id);
  }

  // Named people and nobody else, or named people first with the board behind
  // them. Meaningless without names, and a blank offer that showed to nobody
  // is the one mistake here that looks like the app losing something.
  const aimedOnly = aimedAt.length > 0 && body.aimedOnly !== false;

  const kind = body.backRosterId ? 'trade' : 'give';
  let back = null;
  if (kind === 'trade') {
    if (aimedAt.length !== 1) {
      throw badRequest('A swap is with one person. Pick whose shift you want in return.');
    }
    back = await ctx.db.prepare('SELECT * FROM att_roster WHERE id = ?')
      .bind(int(body.backRosterId, 'Their shift', { min: 1 })).first();
    if (!back) throw notFound('Their shift is not on the rota any more.');
    if (Number(back.staff_id) !== aimedAt[0]) throw badRequest('That shift is not theirs.');
    if (!back.published || !back.shift_id) throw badRequest('That shift is not published.');
    if (back.day < today) throw badRequest('That day has gone.');

    // Both sides have to work for both people, so the check runs both ways.
    const theirShift = ds.shiftById?.get(back.shift_id);
    const mine = whyNot(ds, staff, back.day, theirShift, {
      rules, away, exceptRosterId: rosterId,
    });
    if (mine) throw badRequest(`You cannot take their shift. ${mine}`);
  }

  const saved = await ctx.db.prepare(
    `INSERT INTO att_swap
       (kind, status, roster_id, day, shift_id, from_staff,
        back_roster_id, back_day, back_shift_id,
        aimed_at, aimed_only, reason, created_by)
     VALUES (?1, 'open', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     RETURNING id`,
  ).bind(
    kind, rosterId, row.day, row.shift_id, staff.id,
    back?.id ?? null, back?.day ?? null, back?.shift_id ?? null,
    aimedAt.length ? JSON.stringify(aimedAt) : null,
    aimedOnly ? 1 : 0,
    str(body.reason, 'Reason', { max: 300 }),
    actorOf(ctx),
  ).first();

  const who = aimedAt.length
    ? aimedAt.map((id) => ds.staffById?.get(id)?.name).filter(Boolean).join(', ')
    : null;

  await audit(ctx, 'attendance.swap_offered', saved?.id, {
    day: row.day, shiftId: row.shift_id, kind, aimedAt,
  });

  // The people who could take it hear about it once. Held to the people it is
  // actually offered to rather than the whole property, because a notice
  // everybody gets and nobody can act on is how a phone gets muted.
  const coverers = aimedAt.length
    ? aimedAt
    : whoCanCover(ds, { day: row.day, shift, exceptStaffId: staff.id, rules, away })
      .map((p) => p.id);

  await tellStaff(ctx, coverers, {
    kind: 'swap.offered',
    title: kind === 'trade'
      ? `${staff.name} wants to swap a shift with you`
      : `${staff.name} is giving up ${shift.name}`,
    body: `${when(row.day)}, ${shift.starts_at}–${shift.ends_at}.`
      + (body.reason ? ` ${str(body.reason, 'Reason', { max: 300 })}` : ''),
    link: '#/swaps',
  });

  return json({
    ok: true,
    id: saved?.id ?? null,
    told: coverers.length,
    aimedAt: who,
  });
}

/** Take one. Nothing moves on the rota; a manager still has to say yes. */
export async function takeSwap(ctx, id) {
  const staff = await meOf(ctx);
  const swap = await one(ctx, id);
  if (swap.status !== 'open') throw badRequest('Somebody has already taken that one.');
  if (Number(swap.from_staff) === Number(staff.id)) throw badRequest('That one is yours.');

  const { ds, rules, now, away } = await context(ctx, { from: swap.day, to: swap.day });
  if (!rules.on) throw forbidden('Swaps are turned off.');

  const named = readAimed(swap);
  if (swap.aimed_only === 1 && !named.includes(Number(staff.id))) {
    throw forbidden('That one was put to somebody else.');
  }
  if (swap.kind === 'trade' && !named.includes(Number(staff.id))) {
    throw forbidden('That swap was put to somebody else.');
  }

  const shift = ds.shiftById?.get(swap.shift_id);
  if (!shift) throw badRequest('That shift no longer exists.');
  if (tooLate(swap.day, shift, now, rules.noticeHours)) {
    throw badRequest('That shift starts too soon to change hands now.');
  }

  const why = whyNot(ds, staff, swap.day, shift, { rules, away });
  if (why) throw badRequest(why);

  const done = await ctx.db.prepare(
    `UPDATE att_swap SET status = 'claimed', taken_by = ?2, taken_at = datetime('now')
      WHERE id = ?1 AND status = 'open'`,
  ).bind(swap.id, staff.id).run();
  if (!done.meta?.changes) throw badRequest('Somebody got there first.');

  await audit(ctx, 'attendance.swap_taken', swap.id, { day: swap.day, by: staff.id });

  const offerer = ds.staffById?.get(Number(swap.from_staff));
  const findings = findingsForSwap(ds, {
    from: offerer ?? null,
    to: staff,
    day: swap.day,
    shift,
    backDay: swap.back_day,
    backShift: swap.back_shift_id ? ds.shiftById?.get(swap.back_shift_id) : null,
  });

  // Straight through only where the property has said so and there is
  // genuinely nothing to look at.
  if (goesStraightThrough(rules, findings)) {
    await settle(ctx, {
      swap: { ...swap, status: 'claimed', taken_by: staff.id },
      ds,
      by: 'Nothing was flagged',
    });
    return json({ ok: true, approved: true, findings });
  }

  await tellPlanners(ctx, {
    kind: 'swap.waiting',
    title: `${staff.name} wants to take ${shift.name}`,
    body: `${when(swap.day)}, from ${offerer?.name ?? 'somebody'}.`
      + (findings.length ? ` ${findings.length} thing${findings.length === 1 ? '' : 's'} to look at.` : ''),
    link: '#/att-swaps',
    level: findings.some((f) => f.level === 'high') ? 'warn' : 'info',
  });

  if (swap.from_staff) {
    await tellStaff(ctx, [swap.from_staff], {
      kind: 'swap.taken',
      title: `${staff.name} has taken your ${shift.name}`,
      body: `${when(swap.day)}. It is with a manager now.`,
      link: '#/swaps',
    });
  }

  return json({ ok: true, approved: false, findings });
}

/** Take it back, or say no to one put to you. */
export async function dropSwap(ctx, id) {
  const staff = await meOf(ctx);
  const swap = await one(ctx, id);
  if (!['open', 'claimed'].includes(swap.status)) throw badRequest('That one is already settled.');

  const mine = Number(swap.from_staff) === Number(staff.id);
  const theirs = Number(swap.taken_by) === Number(staff.id);
  const named = readAimed(swap).includes(Number(staff.id));
  if (!mine && !theirs && !named) throw forbidden('That one is not yours.');

  // The offerer withdraws it. Anybody else is saying no to it, which puts it
  // back on the board unless it was only ever for them.
  const status = mine ? 'withdrawn' : theirs ? 'open' : 'declined';

  if (theirs) {
    await ctx.db.prepare(
      "UPDATE att_swap SET status = 'open', taken_by = NULL, taken_at = NULL WHERE id = ?",
    ).bind(swap.id).run();
  } else if (mine) {
    await ctx.db.prepare(
      `UPDATE att_swap SET status = 'withdrawn', decided_by = ?2, decided_at = datetime('now')
        WHERE id = ?1`,
    ).bind(swap.id, actorOf(ctx)).run();
  } else {
    // Named and saying no. If the board was behind the names it stays up.
    const rest = readAimed(swap).filter((n) => n !== Number(staff.id));
    const gone = swap.aimed_only === 1 && rest.length === 0;
    await ctx.db.prepare(
      `UPDATE att_swap
          SET aimed_at = ?2,
              status = ?3,
              decided_by = ?4,
              decided_at = CASE WHEN ?3 = 'declined' THEN datetime('now') ELSE decided_at END
        WHERE id = ?1`,
    ).bind(
      swap.id,
      rest.length ? JSON.stringify(rest) : null,
      gone ? 'declined' : 'open',
      gone ? actorOf(ctx) : null,
    ).run();
  }

  await audit(ctx, 'attendance.swap_dropped', swap.id, { by: staff.id, status });

  if (!mine && swap.from_staff) {
    await tellStaff(ctx, [swap.from_staff], {
      kind: 'swap.decided',
      title: `${staff.name} cannot take your shift`,
      body: `${when(swap.day)}.`,
      link: '#/swaps',
    });
  }

  return json({ ok: true, status });
}

// ---------------------------------------------------------------------------
// What a planner sees
// ---------------------------------------------------------------------------

/** Waiting on a decision, still on the board, and what has been settled. */
export async function swapQueue(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const from = addDays(today, -60);
  const to = addDays(today, HORIZON);
  const { ds, rules, away } = await context(ctx, { from, to });

  const rows = await ctx.db.prepare(
    'SELECT * FROM att_swap WHERE day BETWEEN ? AND ? ORDER BY day, id',
  ).bind(from, to).all().catch(() => ({ results: [] }));

  const waiting = [];
  const board = [];
  const done = [];

  for (const swap of rows.results ?? []) {
    const shift = swap.shift_id ? ds.shiftById?.get(swap.shift_id) : null;
    const card = asCard(ds, swap);

    if (swap.status === 'claimed' && shift) {
      card.findings = findingsForSwap(ds, {
        from: ds.staffById?.get(Number(swap.from_staff)) ?? null,
        to: ds.staffById?.get(Number(swap.taken_by)) ?? null,
        day: swap.day,
        shift,
        backDay: swap.back_day,
        backShift: swap.back_shift_id ? ds.shiftById?.get(swap.back_shift_id) : null,
      });
      waiting.push(card);
    } else if (swap.status === 'open') {
      card.canCover = shift
        ? whoCanCover(ds, {
          day: swap.day, shift, exceptStaffId: swap.from_staff, rules, away,
        }).length
        : 0;
      board.push(card);
    } else {
      done.push(card);
    }
  }

  return json({
    on: rules.on,
    today,
    rules: {
      noticeHours: rules.noticeHours,
      approval: rules.approval,
      crossDepartment: rules.crossDepartment,
      monthlyCap: rules.monthlyCap,
    },
    waiting,
    board,
    done: done.slice(-40).reverse(),
  });
}

/**
 * Yes or no, and the rota changes on yes.
 *
 * The row is re-read and re-checked here rather than trusted from when it was
 * claimed. A fortnight is a long time on a rota: the week can be rebuilt, the
 * shift deleted, the person put on something else, the day signed off. Any of
 * those makes the swap stale, and a stale swap approved is a rota that says
 * something nobody agreed to.
 */
export async function decideSwap(ctx, id) {
  const swap = await one(ctx, id);
  const body = await readJson(ctx.request);
  const approve = body.approve !== false;

  if (swap.status !== 'claimed') throw badRequest('That one is not waiting on a decision.');

  const { ds, rules, away } = await context(ctx, { from: swap.day, to: swap.day });
  const shift = swap.shift_id ? ds.shiftById?.get(swap.shift_id) : null;

  if (!approve) {
    await ctx.db.prepare(
      `UPDATE att_swap
          SET status = 'declined', decided_by = ?2, decided_at = datetime('now'), decision = ?3
        WHERE id = ?1 AND status = 'claimed'`,
    ).bind(swap.id, actorOf(ctx), str(body.note, 'Note', { max: 300 })).run();

    await audit(ctx, 'attendance.swap_declined', swap.id, { day: swap.day });
    await tellBoth(ctx, ds, swap, {
      title: `Your swap was turned down`,
      body: `${when(swap.day)}, ${shift?.name ?? 'the shift'}.`
        + (body.note ? ` ${str(body.note, 'Note', { max: 300 })}` : ''),
    });
    return json({ ok: true, status: 'declined' });
  }

  const stale = await staleness(ctx, swap, { ds, rules, away });
  if (stale) throw badRequest(stale);

  await settle(ctx, { swap, ds, approve: true, by: actorOf(ctx), staff: null });
  return json({ ok: true, status: 'approved' });
}

/** Why this can no longer be approved, or null. */
async function staleness(ctx, swap, { ds, rules, away }) {
  const row = await ctx.db.prepare('SELECT * FROM att_roster WHERE id = ?')
    .bind(swap.roster_id).first();
  if (!row) return 'That shift has been taken off the rota since it was offered.';
  if (Number(row.staff_id) !== Number(swap.from_staff)) {
    return 'That shift has already changed hands on the rota.';
  }
  if (Number(row.shift_id) !== Number(swap.shift_id) || row.day !== swap.day) {
    return 'That cell has been changed on the rota since it was offered.';
  }
  if (!row.published) return 'That week is back in draft, so nothing can move on it.';

  // Signed off, which is the one state where moving a shift would move hours
  // that have already been counted, charged and agreed. Per person, because a
  // sign-off is, and minus the days it deliberately left out.
  const reviews = await ctx.db.prepare(
    `SELECT staff_id, excluded_days FROM att_period_review
      WHERE from_day <= ?1 AND to_day >= ?1 AND staff_id IN (?2, ?3)`,
  ).bind(swap.day, swap.from_staff, swap.taken_by).all().catch(() => ({ results: [] }));
  for (const review of reviews.results ?? []) {
    if (parseDays(review.excluded_days).includes(swap.day)) continue;
    return 'That day has been signed off, so the rota for it is closed.';
  }

  const taker = ds.staffById?.get(Number(swap.taken_by));
  const shift = ds.shiftById?.get(Number(swap.shift_id));
  if (!taker || !shift) return 'The people or the shift on that offer are gone.';

  const why = whyNot(ds, taker, swap.day, shift, {
    rules, away, exceptRosterId: swap.roster_id,
  });
  if (why) return `${taker.name} cannot take it any more. ${why}`;

  if (swap.back_roster_id) {
    const back = await ctx.db.prepare('SELECT * FROM att_roster WHERE id = ?')
      .bind(swap.back_roster_id).first();
    if (!back) return 'The shift coming back the other way has gone off the rota.';
    if (Number(back.staff_id) !== Number(swap.taken_by)) {
      return 'The shift coming back the other way is not theirs any more.';
    }
  }
  return null;
}

/** Move the rows, write the history, tell everybody. */
async function settle(ctx, { swap, ds, by }) {
  const shift = ds.shiftById?.get(Number(swap.shift_id));
  const giver = ds.staffById?.get(Number(swap.from_staff));
  const taker = ds.staffById?.get(Number(swap.taken_by));

  const note = `Swapped: ${giver?.name ?? 'somebody'} to ${taker?.name ?? 'somebody'}`;

  await ctx.db.prepare(
    `UPDATE att_roster
        SET staff_id = ?2, set_by = ?3, set_at = datetime('now')
      WHERE id = ?1`,
  ).bind(swap.roster_id, swap.taken_by, `${by} · ${note}`).run();

  if (swap.back_roster_id) {
    await ctx.db.prepare(
      `UPDATE att_roster
          SET staff_id = ?2, set_by = ?3, set_at = datetime('now')
        WHERE id = ?1`,
    ).bind(swap.back_roster_id, swap.from_staff, `${by} · ${note}`).run();
  }

  await ctx.db.prepare(
    `UPDATE att_swap
        SET status = 'approved', decided_by = ?2, decided_at = datetime('now')
      WHERE id = ?1`,
  ).bind(swap.id, by).run();

  await audit(ctx, 'attendance.swap_approved', swap.id, {
    day: swap.day,
    rosterId: swap.roster_id,
    from: swap.from_staff,
    to: swap.taken_by,
  });

  await tellBoth(ctx, ds, swap, {
    title: 'Your swap has gone through',
    body: `${when(swap.day)}, ${shift?.name ?? 'the shift'}. `
      + `${taker?.name ?? 'Somebody'} is on it now.`,
  });
}

// ---------------------------------------------------------------------------
// The small shared pieces
// ---------------------------------------------------------------------------

async function one(ctx, id) {
  const swap = await ctx.db.prepare('SELECT * FROM att_swap WHERE id = ?')
    .bind(int(id, 'Swap', { min: 1 })).first();
  if (!swap) throw notFound('No such offer.');
  return swap;
}

const when = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
});

async function audit(ctx, action, id, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
  ).bind(actorOf(ctx), action, String(id ?? ''), JSON.stringify(detail)).run().catch(() => {});
}

/** A notice to named members of staff, one each, by their login. */
async function tellStaff(ctx, staffIds, notice) {
  const ids = [...new Set((staffIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return;

  const rows = await ctx.db.prepare(
    `SELECT id, staff_id FROM users
      WHERE active = 1 AND staff_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all().catch(() => ({ results: [] }));

  for (const user of rows.results ?? []) {
    await createNotice(ctx.db, { ...notice, userId: user.id }, ctx);
  }
}

/** And one to whoever decides. */
async function tellPlanners(ctx, notice) {
  await createNotice(ctx.db, { audience: 'att_rota', ...notice }, ctx);
}

async function tellBoth(ctx, ds, swap, { title, body }) {
  void ds;
  await tellStaff(ctx, [swap.from_staff, swap.taken_by], {
    kind: 'swap.decided', title, body, link: '#/swaps',
  });
}

/** Who a shift could go to, for the offer dialog on somebody else's screen. */
export async function coverFor(ctx) {
  const staff = await meOf(ctx);
  const rosterId = int(ctx.url.searchParams.get('rosterId'), 'Shift', { min: 1 });
  const row = await ctx.db.prepare('SELECT * FROM att_roster WHERE id = ?').bind(rosterId).first();
  if (!row) throw notFound('That shift is not on the rota any more.');
  if (Number(row.staff_id) !== Number(staff.id)) throw forbidden('That is not your shift.');

  const { ds, rules, away } = await context(ctx, { from: row.day, to: row.day });
  const shift = row.shift_id ? ds.shiftById?.get(row.shift_id) : null;
  if (!shift) throw badRequest('There is no shift on that day.');

  const can = whoCanCover(ds, { day: row.day, shift, exceptStaffId: staff.id, rules, away });
  return json({
    day: row.day,
    shift: { name: shift.name, starts_at: shift.starts_at, ends_at: shift.ends_at },
    canCover: can.map((p) => ({ id: p.id, name: p.name, department: p.department ?? null })),
  });
}

/** Their published shifts, so a trade can name one of theirs. */
export async function theirShifts(ctx) {
  await meOf(ctx);
  const staffId = int(ctx.url.searchParams.get('staffId'), 'Person', { min: 1 });
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const to = addDays(today, HORIZON);
  const { ds, rules, now } = await context(ctx, { from: today, to });
  if (!rules.on) throw forbidden('Swaps are turned off.');

  const out = offerable(ds, staffId, { from: today, to, now, rules });
  return json({
    shifts: out.map(({ row, day, shift }) => ({
      rosterId: row.id,
      day,
      shift: {
        name: shift.name,
        starts_at: shift.starts_at,
        ends_at: shift.ends_at,
        colour: shift.colour ?? null,
      },
    })),
  });
}
