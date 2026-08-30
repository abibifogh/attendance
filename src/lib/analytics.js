import { addDays, diffDays, dow, rangeDays } from '../util/dates.js';

/**
 * The workforce, measured.
 *
 * Everything here is a reading somebody could act on, and nothing here is a
 * number for its own sake. Four questions, in the order a hotel actually asks
 * them:
 *
 *   WHAT DOES IT COST, and which part of that could be different?
 *   WHERE DOES THE TIME GO, against what was agreed?
 *   WHO IS AT RISK, and what is the liability sitting behind them?
 *   WHAT SHAPE IS THE COVER, hour by hour and department by department?
 *
 * TWO RULES RUN THROUGH ALL OF IT.
 *
 * A RATE PER SOMETHING BEATS A TOTAL. A wage bill that went up tells nobody
 * anything: it goes up when trade goes up, which is the point of trade. Cost
 * per worked hour, absence as a share of scheduled days, premium as a share of
 * the bill — those move only when something has actually changed.
 *
 * A DENOMINATOR OF NOUGHT IS NOT A HUNDRED PER CENT. A department with nobody
 * in it, a fortnight with no shifts, a person with no scheduled days: every
 * one of those is a null here rather than a figure, because a screen full of
 * confident zeroes is worse than a screen that admits it does not know.
 */

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (list, of) => list.reduce((n, item) => n + (Number(of(item)) || 0), 0);

/** A share, or null where there was nothing to be a share of. */
export function share(part, whole) {
  const total = Number(whole) || 0;
  if (Math.abs(total) < 1e-9) return null;
  return round1((Number(part) || 0) / total * 100);
}

/** One figure beside the same figure last time, as a per cent. */
export function against(now, before) {
  if (before == null || now == null) return null;
  const was = round2(before);
  if (Math.abs(was) < 0.005) return { was, now: round2(now), percent: null };
  return {
    was,
    now: round2(now),
    change: round2(now - was),
    percent: round1(((now - was) / Math.abs(was)) * 100),
  };
}

// --------------------------------------------------------------------------
// What it costs
// --------------------------------------------------------------------------

/**
 * The wage bill, read as rates rather than as a total.
 *
 * THE PREMIUM SHARE IS THE ONE TO WATCH. Overtime and holiday pay are the only
 * part of a wage bill that a rota can move this week, and they are the part
 * that hides: a hotel notices the total, not that a tenth of it is being paid
 * at time and a half because two people keep covering for a vacancy nobody has
 * filled.
 *
 * CONCENTRATION IS THE OTHER. Half the bill going to four people out of
 * twenty-five is a different property from half the bill spread over twelve,
 * and it changes what you would do about either.
 */
export function analyseCost({ rows = [], span = 14, previous = null } = {}) {
  const totals = {
    fixed: round2(sum(rows, (r) => r.cost?.fixed)),
    variable: round2(sum(rows, (r) => r.cost?.variable)),
    premium: round2(sum(rows, (r) => r.cost?.premium)),
    total: round2(sum(rows, (r) => r.cost?.total)),
    hours: round1(sum(rows, (r) => r.hours)),
    days: sum(rows, (r) => r.days),
    overtimeHours: round1(sum(rows, (r) => r.overtimeHours)),
    holidayHours: round1(sum(rows, (r) => r.holidayHours)),
  };

  const byDepartment = [...rows.reduce((map, row) => {
    const key = row.staff?.department || 'No department';
    const at = map.get(key) ?? {
      department: key, people: 0, hours: 0, days: 0, premium: 0, total: 0, overtimeHours: 0,
    };
    at.people += 1;
    at.hours += Number(row.hours) || 0;
    at.days += Number(row.days) || 0;
    at.premium += Number(row.cost?.premium) || 0;
    at.total += Number(row.cost?.total) || 0;
    at.overtimeHours += Number(row.overtimeHours) || 0;
    map.set(key, at);
    return map;
  }, new Map()).values()]
    .map((d) => ({
      ...d,
      hours: round1(d.hours),
      premium: round2(d.premium),
      total: round2(d.total),
      overtimeHours: round1(d.overtimeHours),
      perHour: d.hours ? round2(d.total / d.hours) : null,
      perDay: d.days ? round2(d.total / d.days) : null,
      premiumShare: share(d.premium, d.total),
      shareOfBill: share(d.total, totals.total),
    }))
    .sort((a, b) => b.total - a.total);

  // Who the money goes to, biggest first, with a running share beside them.
  // The running share is what answers "how few people is half of this", and
  // the answer is usually smaller than anybody expects.
  const ranked = [...rows].sort((a, b) => (b.cost?.total ?? 0) - (a.cost?.total ?? 0));
  let running = 0;
  const drivers = ranked.slice(0, 10).map((row) => {
    running += Number(row.cost?.total) || 0;
    return {
      staff: row.staff,
      total: round2(row.cost?.total),
      hours: round1(row.hours),
      perHour: row.hours ? round2((row.cost?.total ?? 0) / row.hours) : null,
      premium: round2(row.cost?.premium),
      shareOfBill: share(row.cost?.total, totals.total),
      runningShare: share(running, totals.total),
    };
  });

  // How many people carry the first half of the bill.
  let half = 0;
  let carryHalf = 0;
  for (const row of ranked) {
    if (half >= totals.total / 2) break;
    half += Number(row.cost?.total) || 0;
    carryHalf += 1;
  }

  const perHour = totals.hours ? round2(totals.total / totals.hours) : null;
  const perDay = totals.days ? round2(totals.total / totals.days) : null;
  const perPerson = rows.length ? round2(totals.total / rows.length) : null;

  return {
    span,
    totals,
    perHour,
    perDay,
    perPerson,
    // The part a rota can change this week, as a share of the whole. The
    // figure worth a conversation, and the one a total never shows.
    premiumShare: share(totals.premium, totals.total),
    overtimeShare: share(totals.overtimeHours, totals.hours),
    fixedShare: share(totals.fixed, totals.total),
    byDepartment,
    drivers,
    concentration: rows.length
      ? { people: carryHalf, of: rows.length, share: share(carryHalf, rows.length) }
      : null,
    // The same rates last time round. Rates rather than totals on purpose: a
    // bill that rose because the hotel was busier is not news.
    versus: previous
      ? {
        from: previous.from ?? null,
        to: previous.to ?? null,
        total: against(totals.total, previous.totals?.total),
        perHour: against(perHour, previous.perHour),
        perDay: against(perDay, previous.perDay),
        premiumShare: against(share(totals.premium, totals.total), previous.premiumShare),
        hours: against(totals.hours, previous.totals?.hours),
        people: against(rows.length, previous.people),
      }
      : null,
    people: rows.length,
  };
}

// --------------------------------------------------------------------------
// Where the time goes
// --------------------------------------------------------------------------

/**
 * Scheduled against agreed, and worked against scheduled.
 *
 * TWO DIFFERENT GAPS, AND CONFUSING THEM IS THE USUAL MISTAKE. The first is a
 * planning question: did the rota ask of somebody what their contract says it
 * may. The second is an attendance question: having been asked, did they turn
 * up and stay. A single "utilisation" figure that mixes them tells a manager
 * to go and talk to the wrong person.
 *
 * `days` is one row per person per day out of computeRange, so absence and
 * lateness come from what the clock actually recorded rather than from what
 * somebody was down for.
 */
export function analyseTime({ people = [], daysBy = new Map() } = {}) {
  const rows = people.map((person) => {
    const id = person.staff?.id;
    const f = person.figures ?? {};
    const records = daysBy.get(id) ?? [];

    // Only days somebody was actually expected. A day nobody rostered is not
    // an absence, and counting it as one is how a night porter ends up looking
    // like the worst attender in the building.
    const due = records.filter((r) => r.scheduled !== false && r.shift_id != null);
    const absent = due.filter((r) => r.status === 'absent').length;
    const late = due.filter((r) => r.status === 'late' || r.status === 'late_early').length;
    const lateMinutes = sum(due, (r) => r.late_minutes);
    const workedHours = round1(sum(records, (r) => r.worked_minutes) / 60);

    return {
      staff: person.staff,
      // What was agreed, what the rota asked, and what the clock saw.
      expectedDays: Number(f.expected) || 0,
      scheduledDays: Number(f.daysOn) || 0,
      scheduledHours: round1(Number(f.hours) || 0),
      workedHours,
      dueDays: due.length,
      absentDays: absent,
      lateDays: late,
      lateMinutes: Math.round(lateMinutes),
      leaveDays: Number(f.leaveDays) || 0,
      // Over or under what was agreed with them, in days. The sign matters:
      // one of these is a person being worked, the other is a person being
      // paid to be somewhere nobody put them.
      overAgreed: (Number(f.daysOn) || 0) - (Number(f.expected) || 0),
      absenceRate: share(absent, due.length),
      latenessRate: share(late, due.length),
      // Of the hours the rota asked for, how many the clock recorded. Under a
      // hundred is time lost; well over it is people staying past their shift,
      // which costs money and is worth knowing about either way.
      turnout: share(workedHours, Number(f.hours) || 0),
    };
  });

  const totals = {
    people: rows.length,
    expectedDays: sum(rows, (r) => r.expectedDays),
    scheduledDays: sum(rows, (r) => r.scheduledDays),
    scheduledHours: round1(sum(rows, (r) => r.scheduledHours)),
    workedHours: round1(sum(rows, (r) => r.workedHours)),
    dueDays: sum(rows, (r) => r.dueDays),
    absentDays: sum(rows, (r) => r.absentDays),
    lateDays: sum(rows, (r) => r.lateDays),
    lateMinutes: sum(rows, (r) => r.lateMinutes),
    leaveDays: sum(rows, (r) => r.leaveDays),
  };

  const byDepartment = [...rows.reduce((map, row) => {
    const key = row.staff?.department || 'No department';
    const at = map.get(key) ?? {
      department: key,
      people: 0,
      expectedDays: 0,
      scheduledDays: 0,
      scheduledHours: 0,
      workedHours: 0,
      dueDays: 0,
      absentDays: 0,
      lateDays: 0,
      lateMinutes: 0,
    };
    at.people += 1;
    for (const key2 of ['expectedDays', 'scheduledDays', 'scheduledHours', 'workedHours',
      'dueDays', 'absentDays', 'lateDays', 'lateMinutes']) {
      at[key2] += Number(row[key2]) || 0;
    }
    map.set(key, at);
    return map;
  }, new Map()).values()]
    .map((d) => ({
      ...d,
      scheduledHours: round1(d.scheduledHours),
      workedHours: round1(d.workedHours),
      absenceRate: share(d.absentDays, d.dueDays),
      latenessRate: share(d.lateDays, d.dueDays),
      scheduledAgainstAgreed: share(d.scheduledDays, d.expectedDays),
      turnout: share(d.workedHours, d.scheduledHours),
    }))
    .sort((a, b) => (b.absenceRate ?? -1) - (a.absenceRate ?? -1));

  return {
    rows: rows.sort((a, b) => (b.absenceRate ?? -1) - (a.absenceRate ?? -1)),
    totals,
    // Did the rota ask of people what was agreed with them.
    scheduledAgainstAgreed: share(totals.scheduledDays, totals.expectedDays),
    // Having been asked, did they turn up.
    absenceRate: share(totals.absentDays, totals.dueDays),
    latenessRate: share(totals.lateDays, totals.dueDays),
    turnout: share(totals.workedHours, totals.scheduledHours),
    // A day lost is a day somebody was rostered and did not work. Said in days
    // rather than as a rate as well, because a rate is a comparison and a day
    // is a shift somebody else covered.
    daysLost: totals.absentDays,
    hoursLost: round1(Math.max(0, totals.scheduledHours - totals.workedHours)),
    byDepartment,
  };
}

// --------------------------------------------------------------------------
// Who is at risk
// --------------------------------------------------------------------------

/**
 * The people closest to breaking, and the bill sitting behind the leave.
 *
 * The strain score already exists and already drives the table above this. All
 * that is added here is the ranking and the money: leave that has not been
 * taken is a real liability, it grows quietly, and almost nobody puts a figure
 * on it until somebody resigns and it has to be paid out in a lump.
 */
export function analyseRisk({ rows = [], dayRateBy = new Map() } = {}) {
  const ranked = [...rows]
    .filter((r) => (r.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12)
    .map((r) => ({
      staff: r.staff,
      score: r.score,
      // What is actually driving it, so the number is answerable rather than
      // just alarming.
      why: (r.findings ?? []).filter((f) => f.level === 'high').map((f) => f.title).slice(0, 3),
      daysOn: r.figures?.daysOn ?? 0,
      hours: round1(r.figures?.hours ?? 0),
      longestRun: r.figures?.longestRun ?? 0,
      nights: r.figures?.nights ?? 0,
    }));

  // Every rule broken, counted by kind rather than by person, because four
  // people short of a turnaround is one rostering habit and not four people.
  const byKind = new Map();
  for (const row of rows) {
    for (const found of row.findings ?? []) {
      if (found.level !== 'high') continue;
      const at = byKind.get(found.kind) ?? { kind: found.kind, title: found.title, people: 0 };
      at.people += 1;
      at.title = found.title;
      byKind.set(found.kind, at);
    }
  }

  // The leave bill. Only for people whose daily rate is known: a day priced at
  // nought would quietly make the liability look smaller than it is, which is
  // the one direction a figure like this must never be wrong in.
  let liability = 0;
  let days = 0;
  let priced = 0;
  let unpriced = 0;
  for (const row of rows) {
    const owed = Number(row.leave?.remaining ?? row.leave?.available);
    if (!Number.isFinite(owed) || owed <= 0) continue;
    days += owed;
    const rate = dayRateBy.get(row.staff?.id);
    if (rate == null) { unpriced += 1; continue; }
    liability += owed * rate;
    priced += 1;
  }

  return {
    ranked,
    strained: rows.filter((r) => (r.score ?? 0) >= 60).length,
    watch: rows.filter((r) => (r.score ?? 0) >= 30 && (r.score ?? 0) < 60).length,
    settled: rows.filter((r) => (r.score ?? 0) < 30).length,
    breaches: [...byKind.values()].sort((a, b) => b.people - a.people),
    leave: {
      days: round1(days),
      // Null rather than nought where nothing could be priced, so an empty
      // figure cannot be read as "we owe nobody anything".
      liability: priced ? round2(liability) : null,
      priced,
      unpriced,
    },
  };
}

// --------------------------------------------------------------------------
// What shape the cover is
// --------------------------------------------------------------------------

/** Monday first, because a rota week does. */
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * How many people are on, by weekday and by hour.
 *
 * BY HOUR IS THE ONE THAT SURPRISES PEOPLE. A rota looks balanced as a grid of
 * shifts and is not balanced at all as a curve across the day: three shifts
 * that all start at eight leave the building empty at six, and no table of
 * shift counts ever shows that.
 *
 * Counted in whole people at each hour, averaged over the days in the window,
 * so a fortnight and a month can be read against each other.
 */
export function analyseShape({ ds = null, worked = new Map(), from, to, joiners = [], leavers = [] } = {}) {
  const days = rangeDays(from, to);
  const span = days.length || 1;

  // Cover by weekday: how many people are down on an average Monday.
  const byWeekday = DAY_NAMES.map((name, i) => ({
    day: name,
    // dow() is 0 for Monday in this app, matching the order above.
    index: i,
    dates: 0,
    people: 0,
    hours: 0,
  }));
  for (const day of days) byWeekday[dow(day)].dates += 1;

  // Cover by hour, as minutes-on divided by the days in the window.
  const byHour = [...Array(24)].map((_, hour) => ({ hour, people: 0 }));
  const onDay = new Map();

  for (const [, shifts] of worked) {
    for (const entry of shifts) {
      if (entry.leave || !entry.shift) continue;
      if (entry.day < from || entry.day > to) continue;

      const slot = byWeekday[dow(entry.day)];
      slot.people += 1;
      slot.hours += Number(entry.hours) || 0;
      onDay.set(entry.day, (onDay.get(entry.day) ?? 0) + 1);

      // Absolute minutes from the start of the shift's own day, so a night
      // shift running to 02:00 lands on hours 0 and 1 rather than falling off
      // the end of the clock.
      const start = Number(entry.start) || 0;
      const end = Number(entry.end) || 0;
      for (let minute = start; minute < end; minute += 60) {
        byHour[Math.floor((minute / 60) % 24)].people += 1;
      }
    }
  }

  const cover = byHour.map((h) => ({ hour: h.hour, people: round1(h.people / span) }));
  const busiest = cover.reduce((a, b) => (b.people > a.people ? b : a), cover[0]);
  const thinnest = cover
    .filter((h) => h.people > 0)
    .reduce((a, b) => (b.people < a.people ? b : a), { hour: null, people: Infinity });

  const staff = ds?.staff ?? [];
  const active = staff.filter((s) => s.active && !s.left_on).length;
  const started = joiners.length;
  const left = leavers.length;

  return {
    byWeekday: byWeekday.map((d) => ({
      day: d.day,
      dates: d.dates,
      // Per date rather than in total, so a fortnight with three Mondays and
      // two Tuesdays does not read as Mondays being busier.
      people: d.dates ? round1(d.people / d.dates) : null,
      hours: d.dates ? round1(d.hours / d.dates) : null,
    })),
    byHour: cover,
    busiest: busiest?.people ? busiest : null,
    thinnest: Number.isFinite(thinnest.people) ? thinnest : null,
    // The spread between the fullest and the emptiest staffed hour. A flat
    // curve is a well-shaped rota; a spiky one is a building that is crowded
    // at ten and empty at six.
    spread: busiest?.people && Number.isFinite(thinnest.people)
      ? round1(busiest.people - thinnest.people)
      : null,
    headcount: {
      active,
      joiners: started,
      leavers: left,
      // Leavers over the average headcount, which is the ordinary way of it.
      // Over a fortnight it is a small number and it is meant to be: it is
      // read against the fortnight before, not against a year.
      turnover: active ? share(left, active + left / 2) : null,
    },
    quietestDay: [...onDay.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? null,
    busiestDay: [...onDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

/** The window of the same length immediately before this one. */
export function previousWindow(from, to) {
  const span = diffDays(from, to) + 1;
  return { from: addDays(from, -span), to: addDays(from, -1) };
}
