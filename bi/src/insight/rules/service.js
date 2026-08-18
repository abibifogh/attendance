import { sum, groupBy, median, correlation } from '../stats.js';

/**
 * Work that was due, against the people who were there to do it.
 *
 * The housekeeping module records a round of bed checks every day and how many
 * beds were actually reached. Attendance records how many room attendants
 * turned up. The two live in different applications and neither has ever been
 * able to explain the other, so "the rounds keep getting missed" has never had
 * an answer more useful than "the girls are slow".
 */

export const absenceToMissedWork = {
  id: 'absence-to-missed-work',
  title: 'Missed checks against who was on',
  needs: ['breakfast', 'attendance'],
  run({ facts, money }) {
    const findings = [];
    const rounds = facts.service.filter((s) => s.line_id === 'housekeeping' && s.checks_due > 0);
    if (rounds.length < 21) return findings;

    const rows = rounds.map((s) => {
      const labour = facts.labour.filter((l) => l.day === s.day && l.line_id === 'housekeeping');
      return {
        day: s.day,
        completion: s.checks_done / s.checks_due,
        present: sum(labour.map((l) => l.present_count)),
        absent: sum(labour.map((l) => l.absent_count)),
        missed: Math.max(0, s.checks_due - s.checks_done),
      };
    }).filter((r) => r.present + r.absent > 0);

    if (rows.length < 21) return findings;

    const shortDays = rows.filter((r) => r.absent > 0);
    const fullDays = rows.filter((r) => r.absent === 0);
    if (shortDays.length < 5 || fullDays.length < 5) return findings;

    const shortCompletion = median(shortDays.map((r) => r.completion));
    const fullCompletion = median(fullDays.map((r) => r.completion));
    if (shortCompletion == null || fullCompletion == null) return findings;
    const gap = Math.round((fullCompletion - shortCompletion) * 1000) / 10;
    if (gap < 8) return findings;

    const link = correlation(rows.map((r) => r.absent), rows.map((r) => r.missed));
    const missedOnShortDays = sum(shortDays.map((r) => r.missed));

    findings.push({
      ruleId: this.id,
      severity: gap > 20 ? 'warning' : 'info',
      line: 'housekeeping',
      headline: `Bed checks fall ${gap} points short whenever housekeeping is a person down`,
      detail: [
        `On the ${fullDays.length} days with a full housekeeping team, ${Math.round(fullCompletion * 100)}% of due checks were done.`,
        `On the ${shortDays.length} days somebody was absent, it was ${Math.round(shortCompletion * 100)}%.`,
        link == null ? '' : `Absences and missed checks move together (correlation ${link}).`,
        `${missedOnShortDays} checks went undone on the short days.`,
        'The housekeeping app cannot see the rota and the rota cannot see the checks, so this connection has never been visible in either.',
      ].filter(Boolean).join(' '),
      action: 'Give the housekeeping supervisor a cover rule for a same-day absence: which rooms drop, and who picks them up. The pattern is predictable enough to plan for.',
      impactMonthly: 0,
      confidence: rows.length >= 45 ? 'high' : 'medium',
      sources: ['breakfast', 'attendance'],
      evidence: {
        fullTeamCompletionPct: Math.round(fullCompletion * 100),
        shortTeamCompletionPct: Math.round(shortCompletion * 100),
        gapPoints: gap,
        shortDays: shortDays.length,
        fullDays: fullDays.length,
        missedChecksOnShortDays: missedOnShortDays,
        correlation: link,
      },
    });
    return findings;
  },
};

export const unbilledOccupancy = {
  id: 'unbilled-occupancy',
  title: 'Beds slept in that nobody expected',
  needs: ['breakfast'],
  run({ facts, money }) {
    const findings = [];
    const rows = facts.service.filter((s) => s.line_id === 'housekeeping' && s.faults_found > 0);
    if (rows.length < 10) return findings;

    const mismatches = sum(rows.map((r) => r.faults_found));
    const checked = sum(facts.service.filter((s) => s.line_id === 'housekeeping').map((r) => r.checks_done));
    if (!checked) return findings;
    const rate = Math.round((mismatches / checked) * 1000) / 10;
    if (rate < 1.5) return findings;

    findings.push({
      ruleId: this.id,
      severity: rate > 4 ? 'warning' : 'info',
      line: 'rooms',
      headline: `${mismatches} beds were found in a state the front desk did not expect`,
      detail: [
        `Across ${checked} bed checks, ${mismatches} (${rate}%) were occupied when the desk had them free, or free when the desk had them occupied.`,
        'Each one is either a room being used and not billed, or a guest the housekeeper was not expecting.',
        'This is recorded in the housekeeping app and read by nobody, because the front desk has no screen that shows it.',
      ].join(' '),
      action: 'Reconcile the mismatches against the register for one week. The direction of the errors tells you whether this is revenue or a rooming list that is out of date.',
      impactMonthly: 0,
      confidence: 'medium',
      sources: ['breakfast'],
      evidence: { mismatches, checks: checked, ratePct: rate },
    });
    return findings;
  },
};

export const maintenanceLoad = {
  id: 'maintenance-load',
  title: 'What maintenance is costing, and what it is fixing',
  needs: ['breakfast'],
  run({ facts, money }) {
    const findings = [];
    const rows = facts.forLine('maintenance');
    if (rows.length < 21) return findings;

    const spend = sum(rows.map((r) => r.cost));
    const labour = sum(rows.map((r) => r.labourCost));
    if (spend + labour <= 0) return findings;

    const issues = sum(facts.service.filter((s) => s.line_id === 'maintenance').map((s) => s.issues_opened));
    const guestNights = sum(facts.demand.map((d) => d.inhouse_guests));
    if (guestNights < 100) return findings;

    const perGuestNight = Math.round((spend + labour) / guestNights);
    const ordered = rows.slice().sort((a, b) => a.day.localeCompare(b.day));
    const cut = Math.floor(ordered.length / 2);
    const early = sum(ordered.slice(0, cut).map((r) => r.cost + r.labourCost));
    const late = sum(ordered.slice(cut).map((r) => r.cost + r.labourCost));
    const move = early > 0 ? Math.round(((late - early) / early) * 1000) / 10 : null;

    findings.push({
      ruleId: this.id,
      severity: move != null && move > 40 ? 'warning' : 'info',
      line: 'maintenance',
      headline: move != null && move > 40
        ? `Maintenance is costing ${move}% more than it was in the first half of the window`
        : `Maintenance costs ${money(perGuestNight)} per guest night`,
      detail: [
        `Parts and labour together came to ${money(spend + labour)} over ${rows.length} days, against ${guestNights} guest nights and ${issues} recorded jobs.`,
        move == null ? '' : `The later half of the window cost ${money(late)} against ${money(early)} in the earlier half.`,
        'Maintenance has never been expressed per guest night before, because the guest count and the parts book are in different halves of the same application and no screen joins them.',
      ].filter(Boolean).join(' '),
      action: move != null && move > 40
        ? 'Look at what is being issued repeatedly. A rising parts bill on flat occupancy is usually one asset failing over and over.'
        : 'Keep this figure. It is the baseline that makes the next rise visible.',
      impactMonthly: 0,
      confidence: 'medium',
      sources: ['breakfast', 'attendance'],
      evidence: { spend, labour, issues, guestNights, perGuestNight, changePct: move },
    });
    return findings;
  },
};

export const coverageGaps = {
  id: 'coverage-gaps',
  title: 'What the group cannot see at all',
  needs: [],
  run({ facts, sourceStatus, money }) {
    const findings = [];

    // Room revenue. Not a bug and not a missing connector: there is no
    // property management system among these four applications at all, so the
    // largest line in a hotel's accounts is absent from every total this tool
    // produces. Saying that plainly, on the same screen as the totals, is the
    // difference between a useful tool and a misleading one.
    const roomsRevenue = sum(facts.forLine('rooms').map((r) => r.net));
    const roomsLabour = sum(facts.forLine('rooms').map((r) => r.labourCost));
    const housekeeping = sum(facts.forLine('housekeeping').map((r) => r.labourCost + r.cost));
    if (roomsRevenue === 0 && (roomsLabour > 0 || housekeeping > 0)) {
      findings.push({
        ruleId: this.id,
        severity: 'warning',
        line: 'rooms',
        headline: 'No system in the group records what the rooms earn',
        detail: [
          `Front office and housekeeping cost ${money(roomsLabour + housekeeping)} over this window, and against that there is no room revenue anywhere in the four systems being read.`,
          'Attendance, breakfast, the POS and the laundry cover people, food, restaurant sales and laundry. None of them is a property management system.',
          'So every group-level margin on this dashboard is understated by the whole of the rooms business, and the rooms themselves cannot be judged at all.',
        ].join(' '),
        action: 'Record nightly room revenue somewhere this tool can read — even a single figure a day in the breakfast app beside the guest count would close the gap.',
        impactMonthly: 0,
        confidence: 'high',
        sources: [],
        evidence: { roomsRevenue, roomsLabour, housekeepingCost: housekeeping },
      });
    }

    for (const source of sourceStatus || []) {
      if (source.status === 'ok' || source.status === 'demo') continue;
      findings.push({
        ruleId: this.id,
        severity: source.status === 'error' ? 'warning' : 'info',
        line: null,
        headline: `${source.label} is not being read`,
        detail: `${source.detail || 'No reason given.'} Every figure on this dashboard is missing whatever ${source.label.toLowerCase()} would have contributed.`,
        action: 'Connect it in Setup, or switch it off so the totals stop pretending it is there.',
        impactMonthly: 0,
        confidence: 'high',
        sources: [source.id],
        evidence: { sourceId: source.id, status: source.status, detail: source.detail },
      });
    }

    return findings;
  },
};
