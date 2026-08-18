import { median, halves, groupBy, sum, correlation } from '../stats.js';
import { lead, mid, dayName as dayName_, dayNamePlural, revenueSourceFor } from '../labels.js';

/**
 * Labour against what labour produced.
 *
 * These are the findings this whole application was built to make. Attendance
 * knows the hours. The POS and the laundry know the takings. Neither system
 * can divide one by the other, because neither has ever seen the other's
 * numbers, and the ratio between them is the single most controllable thing in
 * a hospitality business.
 */

const HOURS = (minutes) => minutes / 60;

export const revenuePerLabourHour = {
  id: 'revenue-per-labour-hour',
  title: 'Revenue per hour worked',
  needs: ['attendance', 'revenue'],
  run({ facts, money }) {
    const findings = [];
    const byLine = groupBy(facts.lineRows.filter((r) => r.net > 0 || r.workedMinutes > 0), (r) => r.line);

    for (const [line, rows] of byLine) {
      const withBoth = rows.filter((r) => r.workedMinutes > 60);
      if (withBoth.length < 14) continue;
      const series = withBoth.map((r) => r.net / HOURS(r.workedMinutes));
      const split = halves(series, 7);
      if (!split || split.changePct == null) continue;
      if (split.changePct > -12) continue;

      // What the earlier half's productivity would have earned on the later
      // half's hours. That difference is the finding's worth, and it is an
      // estimate of what is available, not a debt somebody owes.
      const laterRows = withBoth.slice(Math.floor(withBoth.length / 2));
      const laterHours = sum(laterRows.map((r) => HOURS(r.workedMinutes)));
      const laterNet = sum(laterRows.map((r) => r.net));
      const gap = Math.round(split.before * laterHours - laterNet);
      const perDay = gap / Math.max(1, laterRows.length);

      findings.push({
        ruleId: this.id,
        severity: split.changePct < -25 ? 'critical' : 'warning',
        line,
        headline: `${lead(line)} earns ${Math.abs(split.changePct)}% less per hour worked than it did`,
        detail: [
          `Over ${split.n} days, ${mid(line)} moved from ${money(Math.round(split.before))} of revenue per hour worked to ${money(Math.round(split.after))}.`,
          `The hours did not follow the takings down: the later half of the window used ${Math.round(laterHours)} hours to earn ${money(laterNet)}.`,
          `At the earlier rate those hours would have earned ${money(Math.round(split.before * laterHours))}.`,
        ].join(' '),
        action: `Look at the rota for ${mid(line)} against the days it is actually busy. Either the hours come down or the takings have to come up.`,
        impactMonthly: Math.round(Math.max(0, perDay) * 30),
        confidence: split.n >= 40 ? 'high' : 'medium',
        sources: ['attendance', revenueSourceFor(line)].filter(Boolean),
        evidence: {
          beforePerHour: Math.round(split.before),
          afterPerHour: Math.round(split.after),
          changePct: split.changePct,
          laterHours: Math.round(laterHours),
          laterNet,
          days: split.n,
        },
      });
    }
    return findings;
  },
};

export const labourShareOfRevenue = {
  id: 'labour-share',
  title: 'What each line spends on people',
  needs: ['attendance', 'revenue'],
  run({ facts, config, money }) {
    const findings = [];
    const target = config.labourTargetPct;
    const byLine = groupBy(facts.lineRows, (r) => r.line);

    for (const [line, rows] of byLine) {
      const net = sum(rows.map((r) => r.net));
      const labour = sum(rows.map((r) => r.labourCost));
      if (labour <= 0) continue;
      // A cost line has no revenue of its own and is not failing by not having
      // any. Housekeeping is judged on rooms cleaned, not on a till.
      if (net <= 0) continue;
      const share = Math.round((labour / net) * 1000) / 10;
      if (share <= target * 1.25) continue;

      const excess = Math.round(labour - net * (target / 100));
      const perDay = excess / Math.max(1, rows.length);
      findings.push({
        ruleId: this.id,
        severity: share > target * 2 ? 'critical' : 'warning',
        line,
        headline: `${lead(line)} spends ${share}% of its takings on wages`,
        detail: [
          `Over ${rows.length} days ${mid(line)} took ${money(net)} and the people working it cost about ${money(labour)}.`,
          `The group's own yardstick is ${target}%.`,
          share > 100
            ? 'The line does not cover the cost of staffing it, before any stock or overheads at all.'
            : `Bringing it to ${target}% would free about ${money(excess)} over the same period.`,
        ].join(' '),
        action: share > 100
          ? `Decide what ${mid(line)} is for. If it exists to serve the rooms rather than to make money, say so and stop measuring it as a profit centre.`
          : `Match the rota to the hours ${mid(line)} actually trades.`,
        impactMonthly: Math.round(Math.max(0, perDay) * 30),
        confidence: rows.length >= 30 ? 'high' : 'medium',
        sources: ['attendance', revenueSourceFor(line)].filter(Boolean),
        evidence: { net, labourCost: labour, sharePct: share, targetPct: target, days: rows.length },
      });
    }
    return findings;
  },
};

export const overtimeWithoutTrade = {
  id: 'overtime-without-trade',
  title: 'Overtime on days that were not busy',
  needs: ['attendance', 'revenue'],
  run({ facts, money }) {
    const findings = [];
    const byLine = groupBy(facts.lineRows.filter((r) => r.overtimeMinutes > 0), (r) => r.line);

    for (const [line, rows] of byLine) {
      if (rows.length < 10) continue;
      const all = facts.forLine(line);
      const busy = median(all.map((r) => r.net));
      if (!busy) continue;

      // Overtime is worth paying on a busy day. The question is whether it
      // lands on busy days at all — a correlation near zero means the overtime
      // is a habit of the rota rather than a response to trade.
      const link = correlation(all.map((r) => r.overtimeMinutes), all.map((r) => r.net));
      const quietOvertime = rows.filter((r) => r.net < busy);
      if (quietOvertime.length < 6) continue;
      const quietMinutes = sum(quietOvertime.map((r) => r.overtimeMinutes));
      const totalMinutes = sum(rows.map((r) => r.overtimeMinutes));
      const quietShare = Math.round((quietMinutes / Math.max(1, totalMinutes)) * 100);
      if (quietShare < 45 || (link != null && link > 0.35)) continue;

      const hourCost = sum(all.map((r) => r.labourCost)) / Math.max(1, HOURS(sum(all.map((r) => r.workedMinutes))));
      const wasted = Math.round(HOURS(quietMinutes) * hourCost);
      const perDay = wasted / Math.max(1, facts.dayList.length);

      // A weekday that carries most of it is worth naming, because that is a
      // rota line somebody can change on Monday rather than a policy debate.
      const byDow = groupBy(quietOvertime.map((r) => ({ ...r, dow: facts.byDay.get(r.day)?.dow_label })), (r) => r.dow);
      let worstDow = null;
      for (const [dow, dowRows] of byDow) {
        const minutes = sum(dowRows.map((r) => r.overtimeMinutes));
        if (!worstDow || minutes > worstDow.minutes) worstDow = { dow, minutes };
      }

      findings.push({
        ruleId: this.id,
        severity: 'warning',
        line,
        headline: `${lead(line)} pays ${quietShare}% of its overtime on below-average days`,
        detail: [
          `${lead(line)} paid ${Math.round(HOURS(totalMinutes))} hours of overtime over the window, and ${Math.round(HOURS(quietMinutes))} of them were on days that took less than the median ${money(Math.round(busy))}.`,
          link == null ? '' : `Overtime and takings barely move together (correlation ${link}).`,
          worstDow ? `${dayNamePlural(worstDow.dow)} carry the most of it.` : '',
          `That is roughly ${money(wasted)} of hours bought on the quiet days.`,
        ].filter(Boolean).join(' '),
        action: worstDow
          ? `Ask what the ${mid(line)} team is finishing on a ${dayName_(worstDow.dow)}. If it is preparation, it can be moved to a paid hour that is already on the rota.`
          : `Ask what the overtime is being spent on, since it is not being spent on busy days.`,
        impactMonthly: Math.round(Math.max(0, perDay) * 30),
        confidence: 'medium',
        sources: ['attendance', revenueSourceFor(line)].filter(Boolean),
        evidence: {
          overtimeHours: Math.round(HOURS(totalMinutes)),
          quietOvertimeHours: Math.round(HOURS(quietMinutes)),
          quietSharePct: quietShare,
          correlationWithTakings: link,
          worstWeekday: worstDow?.dow ?? null,
        },
      });
    }
    return findings;
  },
};

export const staffingAgainstDemand = {
  id: 'staffing-against-demand',
  title: 'The rota against the week the hotel actually has',
  needs: ['attendance', 'breakfast'],
  run({ facts, money }) {
    const findings = [];
    // Demand is guests in house plus covers plus laundry orders — three
    // systems, one index. No single one of them describes a day's work.
    const rows = facts.dayList.map((day) => {
      const d = facts.demandByDay.get(day);
      const lines = facts.forDay(day);
      return {
        day,
        dow: facts.byDay.get(day)?.dow_label,
        demand: (d?.inhouse_guests || 0) + (d?.covers || 0) * 0.6 + (d?.laundry_orders || 0) * 1.5,
        hours: HOURS(sum(lines.map((l) => l.workedMinutes))),
        cost: sum(lines.map((l) => l.labourCost)),
      };
    }).filter((r) => r.hours > 0 && r.demand > 0);

    if (rows.length < 21) return findings;

    const hoursPerDemand = rows.map((r) => r.hours / r.demand);
    const typical = median(hoursPerDemand);
    if (!typical) return findings;

    const byDow = groupBy(rows, (r) => r.dow);
    for (const [dow, dowRows] of byDow) {
      if (dowRows.length < 4) continue;
      const dowTypical = median(dowRows.map((r) => r.hours / r.demand));
      const gap = Math.round(((dowTypical - typical) / typical) * 100);
      if (Math.abs(gap) < 25) continue;

      const hourCost = sum(rows.map((r) => r.cost)) / Math.max(1, sum(rows.map((r) => r.hours)));
      const excessHours = sum(dowRows.map((r) => r.hours - r.demand * typical));
      const perWeek = (excessHours * hourCost) / Math.max(1, dowRows.length) * 1;

      findings.push({
        ruleId: this.id,
        severity: 'info',
        line: null,
        headline: gap > 0
          ? `${dayNamePlural(dow)} are staffed ${gap}% heavier than the work on them`
          : `${dayNamePlural(dow)} are staffed ${Math.abs(gap)}% lighter than the work on them`,
        detail: [
          `Across ${dowRows.length} ${dayNamePlural(dow).toLowerCase()}, the group used ${Math.round(dowTypical * 100) / 100} hours for every unit of demand, against ${Math.round(typical * 100) / 100} on an average day.`,
          'Demand here is guests in house, restaurant covers and laundry orders together — no one system sees all three.',
          gap > 0
            ? `That is about ${Math.round(excessHours / dowRows.length)} spare hours on a typical ${dayName_(dow)}, worth roughly ${money(Math.round(Math.abs(perWeek)))} a week.`
            : `That is about ${Math.round(Math.abs(excessHours / dowRows.length))} hours short on a typical ${dayName_(dow)}, which is where service slips first.`,
        ].join(' '),
        action: gap > 0
          ? `Move a shift off ${dayName_(dow)} onto whichever day the rota is thinnest.`
          : `Add cover on ${dayName_(dow)} before service or the checks start being missed.`,
        impactMonthly: Math.round(Math.abs(perWeek) * 4.3),
        confidence: dowRows.length >= 8 ? 'medium' : 'low',
        sources: ['attendance', 'breakfast', 'pos', 'laundry'],
        evidence: {
          weekday: dow,
          hoursPerDemand: Math.round(dowTypical * 1000) / 1000,
          groupHoursPerDemand: Math.round(typical * 1000) / 1000,
          gapPct: gap,
          observations: dowRows.length,
        },
      });
    }
    // Only the sharpest one; a list of seven weekdays is a table, not a finding.
    return findings.sort((a, b) => b.impactMonthly - a.impactMonthly).slice(0, 2);
  },
};

